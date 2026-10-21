"use strict";

const { COLLECTIONS, CLIENT_REPORTS_SUBCOLLECTION, SCHEMA_VERSION, LIMITS, MANAGER_ROLES } = require("../lib/constants");
const v = require("../lib/validate");
const { requireAuth, loadMemberContext, requireActiveMembers, isManager } = require("../lib/access");
const { runIdempotent } = require("../lib/idempotency");
const { writeAudit } = require("../lib/audit");
const { invalid, denied, notFound, precondition, conflict } = require("../lib/errors");
const { sha256Hex, paymentReference } = require("../lib/hash");
const { toJson, encodeCursor, decodeCursor } = require("../lib/serialize");
const { parseUpiQr, buildUpiIntentUri, QrError, VPA_RE } = require("../domain/upiQr");
const { normalizeClientResponse, CLIENT_OUTCOMES } = require("../domain/upiResponse");
const { STATES, ACTORS, canTransition } = require("../domain/paymentStates");
const { EXPENSE_KINDS } = require("../domain/ledger");
const { proportionalShares } = require("../domain/splits");
const { prepareExpenseCreate, commitExpenseCreate, parseExpenseInput, syncExpenseVerification } = require("./expenses");
const { createDeterministicCategorizer } = require("./categorizationService");
const { loadLinked, applyStatus } = require("./transactionCore");

const UPI_APPS = ["PHONEPE", "GOOGLE_PAY", "PAYTM", "BHIM", "AMAZON_PAY", "CRED", "OTHER", "UNKNOWN"];
const PLATFORMS = ["ANDROID", "IOS"];
const UTR_RE = /^\d{12}$/; // UPI RRN / UTR is a 12-digit number
const PROVIDER_REF_RE = /^[A-Za-z0-9_-]{6,35}$/;
const EVIDENCE_TYPES = ["BENEFICIARY_STATEMENT", "MERCHANT_CONFIRMATION", "PAYER_BANK_STATEMENT", "PROVIDER_DASHBOARD", "OTHER"];

/** What a client-reported outcome is allowed to do to the status. Never CONFIRMED. */
const CLIENT_OUTCOME_TARGET = Object.freeze({
  [CLIENT_OUTCOMES.SUCCESS_CLAIMED]: STATES.AWAITING_VERIFICATION,
  [CLIENT_OUTCOMES.SUBMITTED]: STATES.PENDING,
  [CLIENT_OUTCOMES.FAILURE]: STATES.FAILED,
  [CLIENT_OUTCOMES.USER_CANCELLED]: STATES.PENDING, // backing out of the UPI app does not prove nothing was debited
  [CLIENT_OUTCOMES.NO_RESPONSE]: STATES.PENDING,
  [CLIENT_OUTCOMES.UNRECOGNIZED]: STATES.PENDING,
});

function makeTransactionService(ctx, { categorizer = createDeterministicCategorizer() } = {}) {
  const { db, FieldValue, Timestamp } = ctx;
  const txns = () => db.collection(COLLECTIONS.TRANSACTIONS);

  async function loadTxn(tx, transactionId) {
    const snap = await tx.get(txns().doc(transactionId));
    if (!snap.exists) throw notFound("Payment not found.", "TRANSACTION_NOT_FOUND");
    return snap.data();
  }

  /** Loads a transaction and checks the caller is an active member of its trip (same error if not). */
  async function loadTxnForMember(tx, transactionId, uid, opts = {}) {
    const snap = await (tx ? tx.get(txns().doc(transactionId)) : txns().doc(transactionId).get());
    if (!snap.exists) throw notFound("Payment not found.", "TRANSACTION_NOT_FOUND");
    const txn = snap.data();
    let member;
    try {
      member = await loadMemberContext(ctx, tx, txn.tripId, uid, opts);
    } catch (e) {
      if (e.details && e.details.reason === "NOT_A_MEMBER") throw notFound("Payment not found.", "TRANSACTION_NOT_FOUND");
      throw e;
    }
    return { txn, ...member };
  }

  function requireInitiator(txn, uid) {
    if (txn.initiatedByUid !== uid) {
      throw denied("Only the person who made this payment can report its outcome.", "NOT_TRANSACTION_OWNER");
    }
  }

  // ---------------------------------------------------------------- initiate

  /**
   * Creates the INITIATED record and returns the validated upi://pay URI for
   * the client to launch. Firebase does not execute the payment: the user's
   * UPI app does, after the user authorizes it with their own PIN.
   */
  async function initiateUpiPayment(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "qrPayload", "payeeVpa", "payeeName", "amountMinor", "purpose", "payeeUid", "upiApp", "platform", "note", "categoryId", "reviewConfirmed", "expense", "idempotencyKey"]);
    const tripId = v.id(data, "tripId");
    const purpose = v.oneOf(data, "purpose", ["MERCHANT", "MEMBER_SETTLEMENT"], { required: false, defaultValue: "MERCHANT" });
    const upiApp = v.oneOf(data, "upiApp", UPI_APPS, { required: false, defaultValue: "UNKNOWN" });
    const platform = v.oneOf(data, "platform", PLATFORMS);
    const note = v.string(data, "note", { required: false, max: 50, pattern: /^[A-Za-z0-9 .,_\-/]+$/ });
    const clientAmount = v.integer(data, "amountMinor", { required: false, min: 1, max: ctx.config.maxPaymentAmountMinor });
    const key = v.idempotencyKey(data);
    if (v.boolean(data, "reviewConfirmed") !== true) {
      throw invalid("The user must review the payee and amount before paying.", "REVIEW_NOT_CONFIRMED");
    }

    // Payee comes either from a scanned QR or from validated manual entry.
    let qr = null;
    let payee;
    if (data.qrPayload !== undefined && data.qrPayload !== null) {
      if (data.payeeVpa !== undefined) throw invalid("Send either qrPayload or payeeVpa, not both.", "AMBIGUOUS_PAYEE");
      try {
        qr = parseUpiQr(data.qrPayload);
      } catch (e) {
        if (e instanceof QrError) throw invalid(e.message, e.reason);
        throw e;
      }
      payee = {
        vpa: qr.payeeVpa, name: qr.payeeName, merchantCategoryCode: qr.merchantCategoryCode,
        merchantRef: qr.merchantRef, terminalId: qr.merchantTerminalId, url: qr.url, qrSigned: qr.signed, source: "QR",
      };
    } else {
      const vpa = v.string(data, "payeeVpa", { max: 320 });
      if (!VPA_RE.test(vpa)) throw invalid("payeeVpa is not a valid UPI ID.", "INVALID_VPA");
      payee = {
        vpa: vpa.toLowerCase(), name: v.string(data, "payeeName", { required: false, max: 100 }),
        merchantCategoryCode: null, merchantRef: null, terminalId: null, url: null, qrSigned: false, source: "MANUAL_ENTRY",
      };
    }

    // Amount rules: a fixed QR amount wins and must match any client value;
    // otherwise the user-entered amount is required (and must meet any QR minimum).
    let amountMinor;
    let amountSource;
    if (qr && qr.amountFixed) {
      if (clientAmount !== null && clientAmount !== qr.amountMinor) {
        throw invalid("Amount does not match the amount in the QR code.", "AMOUNT_MISMATCH_WITH_QR");
      }
      amountMinor = qr.amountMinor;
      amountSource = "QR_FIXED";
    } else {
      if (clientAmount === null) throw invalid("Enter the amount to pay.", "MISSING_FIELD", { field: "amountMinor" });
      if (qr && qr.minimumAmountMinor !== null && clientAmount < qr.minimumAmountMinor) {
        throw invalid("Amount is below the minimum in the QR code.", "AMOUNT_BELOW_QR_MINIMUM");
      }
      amountMinor = clientAmount;
      amountSource = "USER_ENTERED";
    }
    if (amountMinor > ctx.config.maxPaymentAmountMinor) throw invalid("Amount exceeds the per-payment limit.", "AMOUNT_TOO_LARGE");

    let payeeUid = null;
    if (purpose === "MEMBER_SETTLEMENT") {
      payeeUid = v.id(data, "payeeUid");
      if (payeeUid === uid) throw invalid("You cannot pay yourself.", "SELF_PAYMENT");
      if (data.expense !== undefined) throw invalid("Settlement payments cannot carry an expense.", "UNEXPECTED_EXPENSE");
    }
    const expenseInput = data.expense !== undefined && data.expense !== null
      ? parseExpenseInput(v.requireObject(data.expense, "expense"), { requireAmount: false })
      : null;
    if (expenseInput && expenseInput.amountMinor !== null && expenseInput.amountMinor !== amountMinor) {
      throw invalid("Expense amount must equal the payment amount.", "AMOUNT_TRANSACTION_MISMATCH");
    }

    const payload = { tripId, purpose, upiApp, platform, note, amountMinor, payee, payeeUid, expenseInput, categoryId: data.categoryId || null };
    return runIdempotent(ctx, { uid, operation: "initiateUpiPayment", key, payload }, async (tx) => {
      const { trip, membership } = await loadMemberContext(ctx, tx, tripId, uid);
      if (trip.currency !== "INR") throw precondition("UPI payments require an INR trip.", "CURRENCY_MISMATCH");
      if (payeeUid) await requireActiveMembers(ctx, tx, tripId, [payeeUid]);

      const ref = txns().doc();
      const reference = paymentReference();
      const intentRef = payee.merchantRef || (ctx.config.attachInternalRefToIntent ? reference : null);
      const intentUri = buildUpiIntentUri({
        payeeVpa: payee.vpa, payeeName: payee.name, amountMinor, note: note || (qr && qr.note) || null,
        merchantRef: intentRef, merchantCategoryCode: payee.merchantCategoryCode, merchantTerminalId: payee.terminalId, url: payee.url,
      });

      let expensePlan = null;
      let categoryId = v.id(data, "categoryId", { required: false });
      if (expenseInput) {
        const pseudoTxn = { initiatedByUid: uid, amountMinor, status: STATES.INITIATED, payee };
        expensePlan = await prepareExpenseCreate(ctx, tx, {
          uid, membership, trip, tripId, input: { ...expenseInput, paidByUid: uid, categoryId: expenseInput.categoryId || categoryId },
          transaction: pseudoTxn, categorizer, categoryInput: { merchantCategoryCode: payee.merchantCategoryCode },
        });
        categoryId = expensePlan.categoryId;
      }

      let settlementId = null;
      if (purpose === "MEMBER_SETTLEMENT") {
        const sRef = db.collection(COLLECTIONS.SETTLEMENTS).doc();
        settlementId = sRef.id;
        tx.set(sRef, {
          settlementId, tripId, fromUid: uid, toUid: payeeUid, amountMinor, currency: "INR", method: "UPI",
          transactionId: ref.id, status: "PENDING", createdByUid: uid, note: note || null,
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
        });
      }

      let expenseId = null;
      if (expensePlan) {
        expenseId = commitExpenseCreate(ctx, tx, expensePlan, { transactionId: ref.id }).expenseId;
      }

      tx.set(ref, {
        transactionId: ref.id,
        tripId,
        kind: "PAYMENT",
        purpose,
        initiatedByUid: uid,
        payee: { ...payee, memberUid: payeeUid },
        qrParams: qr ? qr.rawParams : null,
        amountMinor,
        amountSource,
        currency: "INR",
        upiApp,
        platform,
        reference,
        intentRef,
        intentUri,
        status: STATES.INITIATED,
        statusSetBy: ACTORS.CLIENT,
        statusSource: "INITIATION",
        statusHistory: [],
        clientReported: null,
        clientReportCount: 0,
        claims: { utr: null, providerReference: null, receiptIds: [], ocr: null },
        anomalies: [],
        verification: { status: "UNVERIFIED", source: null, verifiedByUid: null, verifiedAt: null },
        categoryId: categoryId || null,
        expenseId,
        settlementId,
        refundOfTransactionId: null,
        refundTransactionIds: [],
        refundedMinor: 0,
        pendingRefundMinor: 0,
        version: 1,
        initiatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        schemaVersion: SCHEMA_VERSION,
      });
      writeAudit(ctx, tx, {
        tripId, actorUid: uid, action: "TRANSACTION_INITIATED", entityType: "transaction", entityId: ref.id,
        changes: { amountMinor, payeeVpa: payee.vpa, purpose, amountSource },
      });
      return {
        transactionId: ref.id, reference, intentUri, amountMinor, currency: "INR",
        payee: { vpa: payee.vpa, name: payee.name }, status: STATES.INITIATED, expenseId, settlementId,
      };
    });
  }

  // ---------------------------------------------------------------- client outcome

  /**
   * Stores what the UPI app / plugin returned, verbatim, and moves the payment
   * to an UNVERIFIED state. Never confirms a payment.
   */
  async function recordUpiClientResponse(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["transactionId", "platform", "upiApp", "rawResponse", "userCancelled", "idempotencyKey"]);
    const transactionId = v.id(data, "transactionId");
    const platform = v.oneOf(data, "platform", PLATFORMS);
    const upiApp = v.oneOf(data, "upiApp", UPI_APPS, { required: false, defaultValue: null });
    const userCancelled = v.boolean(data, "userCancelled", { defaultValue: false });
    const raw = data.rawResponse === undefined ? null : data.rawResponse;
    if (raw !== null && typeof raw !== "string" && !v.isPlainObject(raw)) {
      throw invalid("rawResponse must be a string, an object or null.", "INVALID_FIELD", { field: "rawResponse" });
    }
    const rawText = raw === null ? null : typeof raw === "string" ? raw : JSON.stringify(raw);
    if (rawText && rawText.length > 4000) throw invalid("rawResponse is too large.", "INVALID_FIELD", { field: "rawResponse" });
    const key = v.idempotencyKey(data);
    const normalized = normalizeClientResponse(raw, { userCancelled });

    return runIdempotent(ctx, { uid, operation: "recordUpiClientResponse", key, payload: { transactionId, platform, upiApp, rawText, userCancelled } }, async (tx) => {
      const { txn } = await loadTxnForMember(tx, transactionId, uid);
      requireInitiator(txn, uid);
      if (txn.kind !== "PAYMENT") throw precondition("Only payments have UPI app responses.", "NOT_A_PAYMENT");
      if (txn.clientReportCount >= LIMITS.MAX_CLIENT_REPORTS_PER_TRANSACTION) {
        throw precondition("Too many responses recorded for this payment.", "TOO_MANY_REPORTS");
      }
      const linked = await loadLinked(ctx, tx, txn);

      const anomalies = [...normalized.anomalies];
      const returnedRef = normalized.fields.txnRef;
      if (returnedRef && txn.intentRef && returnedRef !== txn.intentRef) anomalies.push("REFERENCE_MISMATCH");
      let target = CLIENT_OUTCOME_TARGET[normalized.outcome];
      if (anomalies.length && target === STATES.AWAITING_VERIFICATION) target = STATES.PENDING;

      const reportRef = txns().doc(transactionId).collection(CLIENT_REPORTS_SUBCOLLECTION).doc();
      tx.set(reportRef, {
        reportId: reportRef.id, transactionId, tripId: txn.tripId, reportedByUid: uid, platform, upiApp,
        rawResponse: rawText, normalizedOutcome: normalized.outcome, fields: normalized.fields, anomalies,
        trusted: false, createdAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
      });

      const clientReported = {
        outcome: normalized.outcome, fields: normalized.fields, platform, upiApp, anomalies,
        reportId: reportRef.id, reportedAt: Timestamp.fromMillis(ctx.now()),
      };
      const extra = {
        clientReported,
        clientReportCount: FieldValue.increment(1),
        ...(anomalies.length ? { anomalies: FieldValue.arrayUnion(...anomalies) } : {}),
        ...(upiApp ? { upiApp } : {}),
      };

      let status = txn.status;
      let transitioned = false;
      if (target !== txn.status && canTransition(txn, target, ACTORS.CLIENT).ok) {
        applyStatus(ctx, tx, txn, linked, target, { actor: ACTORS.CLIENT, source: `CLIENT_RESPONSE:${normalized.outcome}`, actorUid: uid, extra });
        status = target;
        transitioned = true;
      } else {
        tx.update(txns().doc(transactionId), { ...extra, updatedAt: FieldValue.serverTimestamp() });
        writeAudit(ctx, tx, {
          tripId: txn.tripId, actorUid: uid, action: "CLIENT_RESPONSE_RECORDED", entityType: "transaction", entityId: transactionId,
          metadata: { outcome: normalized.outcome, statusUnchanged: txn.status, requestedTarget: target },
        });
      }

      if (normalized.outcome === CLIENT_OUTCOMES.SUCCESS_CLAIMED) {
        const recRef = db.collection(COLLECTIONS.RECONCILIATION_RECORDS).doc();
        tx.set(recRef, {
          recordId: recRef.id, tripId: txn.tripId, transactionId, claimType: "CLIENT_RESPONSE", submittedByUid: uid,
          data: { fields: normalized.fields, reportId: reportRef.id }, anomalies, status: "OPEN",
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
        });
      }
      return { transactionId, status, transitioned, clientOutcome: normalized.outcome, anomalies, verified: false };
    });
  }

  // ---------------------------------------------------------------- UTR / OCR / receipt claims

  /**
   * "Did your payment go through?" flow (primarily iOS, also Android without a
   * usable result): the user submits a UTR/reference, optional client-side OCR
   * output and/or a registered receipt. Stored as unverified claims.
   */
  async function submitPaymentReference(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["transactionId", "utr", "providerReference", "receiptId", "ocr", "idempotencyKey"]);
    const transactionId = v.id(data, "transactionId");
    const utr = v.string(data, "utr", { required: false, min: 12, max: 12, pattern: UTR_RE });
    const providerReference = v.string(data, "providerReference", { required: false, min: 6, max: 35, pattern: PROVIDER_REF_RE });
    const receiptId = v.id(data, "receiptId", { required: false });
    let ocr = null;
    if (data.ocr !== undefined && data.ocr !== null) {
      const o = v.requireObject(data.ocr, "ocr");
      v.onlyKeys(o, ["utr", "amountMinor", "payeeVpa", "payeeName", "paidAtText", "status", "rawText", "engine"]);
      ocr = {
        utr: v.string(o, "utr", { required: false, max: 35 }),
        amountMinor: v.integer(o, "amountMinor", { required: false, min: 0, max: Number.MAX_SAFE_INTEGER }),
        payeeVpa: v.string(o, "payeeVpa", { required: false, max: 320 }),
        payeeName: v.string(o, "payeeName", { required: false, max: 100 }),
        paidAtText: v.string(o, "paidAtText", { required: false, max: 60 }),
        status: v.string(o, "status", { required: false, max: 30 }),
        rawText: v.string(o, "rawText", { required: false, max: 4000 }),
        engine: v.string(o, "engine", { required: false, max: 40 }),
      };
    }
    if (!utr && !providerReference && !receiptId && !ocr) {
      throw invalid("Provide a UTR, provider reference, receipt or OCR result.", "NO_CLAIM_DATA");
    }
    const key = v.idempotencyKey(data);

    return runIdempotent(ctx, { uid, operation: "submitPaymentReference", key, payload: { transactionId, utr, providerReference, receiptId, ocr } }, async (tx) => {
      const { txn } = await loadTxnForMember(tx, transactionId, uid);
      requireInitiator(txn, uid);

      // Reads: reference claims (global uniqueness) and the receipt.
      const claimRefs = [];
      if (utr) claimRefs.push({ type: "UTR", value: utr, ref: db.collection(COLLECTIONS.PAYMENT_REFERENCE_CLAIMS).doc(sha256Hex(`UTR:${utr}`)) });
      if (providerReference) claimRefs.push({ type: "PROVIDER_REF", value: providerReference, ref: db.collection(COLLECTIONS.PAYMENT_REFERENCE_CLAIMS).doc(sha256Hex(`PROVIDER_REF:${providerReference.toUpperCase()}`)) });
      const claimSnaps = await Promise.all(claimRefs.map((c) => tx.get(c.ref)));
      for (let i = 0; i < claimSnaps.length; i++) {
        if (claimSnaps[i].exists && claimSnaps[i].data().transactionId !== transactionId) {
          // Deliberately does not say which trip/payment holds it.
          throw conflict("This reference is already attached to another payment.", "REFERENCE_ALREADY_CLAIMED");
        }
      }
      if (receiptId) {
        const r = await tx.get(db.collection(COLLECTIONS.RECEIPTS).doc(receiptId));
        if (!r.exists || r.data().tripId !== txn.tripId || r.data().uploadedByUid !== uid) {
          throw notFound("Receipt not found.", "RECEIPT_NOT_FOUND");
        }
      }
      const linked = await loadLinked(ctx, tx, txn);

      const anomalies = [];
      if (ocr && ocr.amountMinor !== null && ocr.amountMinor !== txn.amountMinor) anomalies.push("OCR_AMOUNT_MISMATCH");
      if (ocr && ocr.payeeVpa && ocr.payeeVpa.toLowerCase() !== txn.payee.vpa) anomalies.push("OCR_PAYEE_MISMATCH");
      if (ocr && ocr.utr && utr && ocr.utr !== utr) anomalies.push("OCR_UTR_MISMATCH");

      for (const c of claimRefs) {
        tx.set(c.ref, {
          type: c.type, transactionId, tripId: txn.tripId, claimedByUid: uid,
          createdAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
        });
      }
      const recordIds = [];
      const addRecord = (claimType, payload) => {
        const recRef = db.collection(COLLECTIONS.RECONCILIATION_RECORDS).doc();
        recordIds.push(recRef.id);
        tx.set(recRef, {
          recordId: recRef.id, tripId: txn.tripId, transactionId, claimType, submittedByUid: uid, data: payload,
          anomalies, status: "OPEN", trusted: false,
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
        });
      };
      if (utr) addRecord("UTR", { utr });
      if (providerReference) addRecord("PROVIDER_REFERENCE", { providerReference });
      if (ocr) addRecord("OCR", { ...ocr, note: "Client-side OCR output. Not proof of payment." });
      if (receiptId) addRecord("RECEIPT", { receiptId });

      const extra = {
        ...(utr ? { "claims.utr": utr } : {}),
        ...(providerReference ? { "claims.providerReference": providerReference } : {}),
        ...(ocr ? { "claims.ocr": ocr } : {}),
        ...(receiptId ? { "claims.receiptIds": FieldValue.arrayUnion(receiptId) } : {}),
        ...(anomalies.length ? { anomalies: FieldValue.arrayUnion(...anomalies) } : {}),
      };
      let status = txn.status;
      if (txn.status !== STATES.AWAITING_VERIFICATION && canTransition(txn, STATES.AWAITING_VERIFICATION, ACTORS.CLIENT).ok) {
        applyStatus(ctx, tx, txn, linked, STATES.AWAITING_VERIFICATION, { actor: ACTORS.CLIENT, source: "CLIENT_CLAIM", actorUid: uid, extra });
        status = STATES.AWAITING_VERIFICATION;
      } else {
        tx.update(txns().doc(transactionId), { ...extra, updatedAt: FieldValue.serverTimestamp() });
        writeAudit(ctx, tx, { tripId: txn.tripId, actorUid: uid, action: "PAYMENT_CLAIM_SUBMITTED", entityType: "transaction", entityId: transactionId, metadata: { recordIds } });
      }
      return { transactionId, status, reconciliationRecordIds: recordIds, anomalies, verified: false };
    });
  }

  async function cancelTransaction(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["transactionId", "reason"]);
    const transactionId = v.id(data, "transactionId");
    const reason = v.string(data, "reason", { required: false, max: 300 });
    return db.runTransaction(async (tx) => {
      const { txn } = await loadTxnForMember(tx, transactionId, uid);
      requireInitiator(txn, uid);
      if (txn.status === STATES.CANCELLED) return { transactionId, status: STATES.CANCELLED };
      const linked = await loadLinked(ctx, tx, txn);
      applyStatus(ctx, tx, txn, linked, STATES.CANCELLED, { actor: ACTORS.CLIENT, source: "USER_CANCELLED", actorUid: uid, reason });
      return { transactionId, status: STATES.CANCELLED };
    });
  }

  // ---------------------------------------------------------------- trusted verification

  /**
   * Applies a result from the configured verification adapter. CONFIRMED is
   * accepted only when the adapter's amount and payee match the record.
   * Exported for adapters' webhook handlers; never callable with client data.
   */
  async function applyAdapterResult(transactionId, result) {
    return db.runTransaction(async (tx) => {
      const txn = await loadTxn(tx, transactionId);
      const linked = await loadLinked(ctx, tx, txn);
      const refundCtx = await readRefundContext(tx, txn);
      const evidence = {
        source: result.source || "UNKNOWN", result: result.result, amountMinor: result.amountMinor ?? null,
        payeeVpa: result.payeeVpa ?? null, providerReference: result.providerReference ?? null,
        checkedAt: Timestamp.fromMillis(ctx.now()),
      };
      const base = { "verification.lastCheck": evidence, updatedAt: FieldValue.serverTimestamp() };

      if (result.result === "CONFIRMED") {
        const expectedVpa = txn.kind === "PAYMENT" ? txn.payee.vpa : null;
        const amountOk = result.amountMinor === txn.amountMinor;
        const payeeOk = expectedVpa === null || (result.payeeVpa || "").toLowerCase() === expectedVpa;
        if (!amountOk || !payeeOk) {
          const anomaly = !amountOk ? "VERIFIED_AMOUNT_MISMATCH" : "VERIFIED_PAYEE_MISMATCH";
          tx.update(txns().doc(transactionId), { ...base, anomalies: FieldValue.arrayUnion(anomaly) });
          writeAudit(ctx, tx, { tripId: txn.tripId, actorType: "SYSTEM", action: "VERIFICATION_MISMATCH", entityType: "transaction", entityId: transactionId, metadata: { anomaly, source: evidence.source } });
          return { transactionId, status: txn.status, applied: false, reason: anomaly };
        }
        if (txn.status === STATES.CONFIRMED) return { transactionId, status: txn.status, applied: false, reason: "ALREADY_CONFIRMED" };
        applyStatus(ctx, tx, txn, linked, STATES.CONFIRMED, { actor: ACTORS.TRUSTED, source: evidence.source, extra: { ...base, "verification.providerReference": evidence.providerReference } });
        onTrustedRefundOutcome(tx, txn, STATES.CONFIRMED, null, refundCtx);
        return { transactionId, status: STATES.CONFIRMED, applied: true };
      }
      if (result.result === "FAILED" && canTransition(txn, STATES.FAILED, ACTORS.TRUSTED).ok) {
        applyStatus(ctx, tx, txn, linked, STATES.FAILED, { actor: ACTORS.TRUSTED, source: evidence.source, extra: base });
        onTrustedRefundOutcome(tx, txn, STATES.FAILED, null, refundCtx);
        return { transactionId, status: STATES.FAILED, applied: true };
      }
      if (result.result === "PENDING" && txn.status === STATES.INITIATED) {
        applyStatus(ctx, tx, txn, linked, STATES.PENDING, { actor: ACTORS.TRUSTED, source: evidence.source, extra: base });
        return { transactionId, status: STATES.PENDING, applied: true };
      }
      tx.update(txns().doc(transactionId), base);
      return { transactionId, status: txn.status, applied: false, reason: result.result };
    });
  }

  /**
   * Asks the configured verification adapter about a payment. With the
   * default adapter ("none") this always reports UNAVAILABLE and changes nothing.
   */
  async function verifyTransaction(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["transactionId"]);
    const transactionId = v.id(data, "transactionId");
    const { txn, membership } = await loadTxnForMember(null, transactionId, uid, { allowArchivedTrip: true });
    if (txn.initiatedByUid !== uid && !isManager(membership)) throw denied("Only the payer or a trip admin can request verification.", "NOT_TRANSACTION_OWNER");
    const result = await ctx.verificationAdapter.verify(toJson(txn));
    if (!result || result.result === "UNAVAILABLE") {
      return { transactionId, status: txn.status, verificationAvailable: false, message: "No independent verification source is configured. Use manual reconciliation." };
    }
    const applied = await applyAdapterResult(transactionId, result);
    return { ...applied, verificationAvailable: true };
  }

  /**
   * Manual reconciliation. CONFIRM requires a reviewer other than the payer:
   *  - merchant payments and refunds: a trip OWNER/ADMIN who did not initiate it;
   *  - member settlement payments: the receiving member (beneficiary-side confirmation).
   * The reviewer must enter the amount they saw on the evidence; it must match.
   */
  async function reconcileTransaction(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["transactionId", "decision", "evidenceType", "confirmedAmountMinor", "note", "expectedVersion"]);
    const transactionId = v.id(data, "transactionId");
    const decision = v.oneOf(data, "decision", ["CONFIRM", "REJECT"]);
    const evidenceType = v.oneOf(data, "evidenceType", EVIDENCE_TYPES);
    const note = v.string(data, "note", { min: 3, max: 500 });
    const confirmedAmountMinor = decision === "CONFIRM" ? v.integer(data, "confirmedAmountMinor", { min: 1 }) : null;
    const expectedVersion = v.integer(data, "expectedVersion", { min: 1 });

    return db.runTransaction(async (tx) => {
      const { txn, membership } = await loadTxnForMember(tx, transactionId, uid, { allowArchivedTrip: true });
      if (txn.version !== expectedVersion) throw precondition("This payment changed. Reload and try again.", "VERSION_CONFLICT", { currentVersion: txn.version });
      let source;
      if (txn.purpose === "MEMBER_SETTLEMENT" && txn.kind === "PAYMENT") {
        if (txn.payee.memberUid !== uid) throw denied("Only the member who received this payment can confirm it.", "NOT_BENEFICIARY");
        source = "BENEFICIARY_CONFIRMATION";
      } else {
        if (!MANAGER_ROLES.includes(membership.role)) throw denied("Only trip admins can reconcile payments.", "INSUFFICIENT_ROLE");
        if (txn.initiatedByUid === uid) throw denied("Someone other than the payer must reconcile this payment.", "SELF_RECONCILIATION_NOT_ALLOWED");
        source = "MANUAL_RECONCILIATION";
      }
      if (decision === "CONFIRM" && confirmedAmountMinor !== txn.amountMinor) {
        throw precondition("The confirmed amount does not match the payment amount. Record the discrepancy instead.", "AMOUNT_MISMATCH");
      }
      const openQ = db.collection(COLLECTIONS.RECONCILIATION_RECORDS)
        .where("transactionId", "==", transactionId).where("status", "==", "OPEN").limit(50);
      const [openRecs, linked] = await Promise.all([tx.get(openQ), loadLinked(ctx, tx, txn)]);
      const refundCtx = await readRefundContext(tx, txn);

      const to = decision === "CONFIRM" ? STATES.CONFIRMED : STATES.FAILED;
      const extra = { "verification.evidenceType": evidenceType, "verification.note": note };
      applyStatus(ctx, tx, txn, linked, to, { actor: ACTORS.TRUSTED, source, actorUid: uid, reason: note, extra });
      for (const r of openRecs.docs) {
        tx.update(r.ref, {
          status: decision === "CONFIRM" ? "ACCEPTED" : "REJECTED", reviewedByUid: uid, reviewNote: note,
          reviewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
      }
      onTrustedRefundOutcome(tx, txn, to, uid, refundCtx);
      return { transactionId, status: to, verificationSource: source };
    });
  }

  // ---------------------------------------------------------------- refunds & reversals

  async function readRefundContext(tx, txn) {
    if (!txn.refundOfTransactionId) return null;
    const origSnap = await tx.get(txns().doc(txn.refundOfTransactionId));
    const original = origSnap.data();
    const origLinked = await loadLinked(ctx, tx, original);
    return { original, origLinked };
  }

  /**
   * When a refund/reversal record is confirmed or rejected by a trusted path,
   * update the original payment's refunded totals and, once fully refunded,
   * move it to REFUNDED/REVERSED. The original amount is never changed.
   */
  function onTrustedRefundOutcome(tx, txn, to, actorUid, refundCtx) {
    if (!txn.refundOfTransactionId || !refundCtx) return;
    const { original, origLinked } = refundCtx;
    const pendingRefundMinor = Math.max(0, original.pendingRefundMinor - txn.amountMinor);
    if (to === STATES.CONFIRMED) {
      const refundedMinor = original.refundedMinor + txn.amountMinor;
      if (refundedMinor >= original.amountMinor && original.status === STATES.CONFIRMED) {
        const finalState = txn.kind === "REVERSAL" ? STATES.REVERSED : STATES.REFUNDED;
        applyStatus(ctx, tx, original, origLinked, finalState, {
          actor: ACTORS.TRUSTED, source: `${txn.kind}_CONFIRMED:${txn.transactionId}`, actorUid,
          extra: { refundedMinor, pendingRefundMinor },
        });
      } else {
        tx.update(txns().doc(original.transactionId), { refundedMinor, pendingRefundMinor, updatedAt: FieldValue.serverTimestamp() });
      }
    } else if (to === STATES.FAILED) {
      tx.update(txns().doc(original.transactionId), { pendingRefundMinor, updatedAt: FieldValue.serverTimestamp() });
    }
  }

  /**
   * Records a refund or reversal the user says they received for a CONFIRMED
   * payment, as a separate compensating record (status AWAITING_VERIFICATION).
   * If the payment has an expense, a negative adjustment expense mirrors the
   * original split so balances net out once the refund is confirmed.
   */
  async function recordRefund(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["transactionId", "kind", "amountMinor", "reference", "reason", "idempotencyKey"]);
    const transactionId = v.id(data, "transactionId");
    const kind = v.oneOf(data, "kind", ["REFUND", "REVERSAL"]);
    const amountMinor = v.integer(data, "amountMinor", { min: 1 });
    const reference = v.string(data, "reference", { required: false, max: 35, pattern: PROVIDER_REF_RE });
    const reason = v.string(data, "reason", { max: 300 });
    const key = v.idempotencyKey(data);

    return runIdempotent(ctx, { uid, operation: "recordRefund", key, payload: { transactionId, kind, amountMinor, reference, reason } }, async (tx) => {
      const { txn: original, membership, trip } = await loadTxnForMember(tx, transactionId, uid);
      if (original.initiatedByUid !== uid && !isManager(membership)) throw denied("Only the payer or a trip admin can record a refund.", "NOT_TRANSACTION_OWNER");
      if (original.kind !== "PAYMENT" || original.purpose !== "MERCHANT") throw precondition("Refunds can only be recorded against merchant payments.", "NOT_REFUNDABLE");
      if (original.status !== STATES.CONFIRMED) {
        throw precondition("Only confirmed payments can be refunded. Unconfirmed payments are rejected or cancelled instead.", "NOT_CONFIRMED");
      }
      const remaining = original.amountMinor - original.refundedMinor - original.pendingRefundMinor;
      if (amountMinor > remaining) throw invalid(`At most ${remaining} paise can still be refunded.`, "REFUND_EXCEEDS_REMAINING", { remaining });

      let origExpense = null;
      if (original.expenseId) {
        const es = await tx.get(db.collection(COLLECTIONS.EXPENSES).doc(original.expenseId));
        origExpense = es.exists && es.data().status === "ACTIVE" ? es.data() : null;
      }

      const ref = txns().doc();
      let adjustmentExpenseId = null;
      if (origExpense) {
        const shares = proportionalShares(-amountMinor, origExpense.shares);
        const participants = Object.keys(shares).filter((u) => shares[u] !== 0);
        const plan = {
          tripId: original.tripId, uid, paidByUid: origExpense.paidByUid, amountMinor: -amountMinor, currency: trip.currency,
          verificationStatus: STATES.AWAITING_VERIFICATION, categoryId: origExpense.categoryId, categorySource: origExpense.categorySource,
          shares: Object.fromEntries(participants.map((u) => [u, shares[u]])),
          input: { title: `${kind === "REFUND" ? "Refund" : "Reversal"}: ${origExpense.title}`.slice(0, LIMITS.MAX_TITLE_LENGTH), merchantName: origExpense.merchantName, participantUids: participants, split: { type: "AMOUNT", values: Object.fromEntries(participants.map((u) => [u, shares[u]])) }, notes: reason, receiptIds: [], expenseDate: null },
          transaction: { status: STATES.AWAITING_VERIFICATION },
        };
        adjustmentExpenseId = commitExpenseCreate(ctx, tx, plan, {
          kind: kind === "REFUND" ? EXPENSE_KINDS.REFUND_ADJUSTMENT : EXPENSE_KINDS.REVERSAL_ADJUSTMENT,
          adjustsExpenseId: origExpense.expenseId, transactionId: ref.id,
        }).expenseId;
      }

      tx.set(ref, {
        transactionId: ref.id, tripId: original.tripId, kind, purpose: "MERCHANT", initiatedByUid: uid,
        payee: { vpa: null, name: null, memberUid: original.initiatedByUid, source: kind },
        amountMinor, amountSource: "USER_ENTERED", currency: original.currency, upiApp: null, platform: null,
        reference: paymentReference(), intentRef: null, intentUri: null,
        status: STATES.AWAITING_VERIFICATION, statusSetBy: ACTORS.CLIENT, statusSource: "REFUND_CLAIM", statusHistory: [],
        clientReported: null, clientReportCount: 0,
        claims: { utr: null, providerReference: reference || null, receiptIds: [], ocr: null }, anomalies: [],
        verification: { status: "UNVERIFIED", source: null, verifiedByUid: null, verifiedAt: null },
        categoryId: original.categoryId || null, expenseId: adjustmentExpenseId, settlementId: null,
        refundOfTransactionId: original.transactionId, refundTransactionIds: [], refundedMinor: 0, pendingRefundMinor: 0,
        reason, version: 1, initiatedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
      });
      tx.update(txns().doc(original.transactionId), {
        pendingRefundMinor: original.pendingRefundMinor + amountMinor,
        refundTransactionIds: FieldValue.arrayUnion(ref.id),
        updatedAt: FieldValue.serverTimestamp(),
      });
      const recRef = db.collection(COLLECTIONS.RECONCILIATION_RECORDS).doc();
      tx.set(recRef, {
        recordId: recRef.id, tripId: original.tripId, transactionId: ref.id, claimType: kind, submittedByUid: uid,
        data: { originalTransactionId: original.transactionId, amountMinor, reference: reference || null, reason },
        anomalies: [], status: "OPEN", trusted: false,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
      });
      writeAudit(ctx, tx, {
        tripId: original.tripId, actorUid: uid, action: `${kind}_RECORDED`, entityType: "transaction", entityId: ref.id,
        changes: { amountMinor, refundOfTransactionId: original.transactionId }, metadata: { reason },
      });
      return { transactionId: ref.id, kind, status: STATES.AWAITING_VERIFICATION, adjustmentExpenseId };
    });
  }

  // ---------------------------------------------------------------- reads

  async function getTransaction(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const transactionId = v.id(data, "transactionId");
    const includeReports = v.boolean(data, "includeReports", { defaultValue: false });
    const { txn } = await loadTxnForMember(null, transactionId, uid, { allowArchivedTrip: true });
    const out = { transaction: toJson(txn) };
    if (includeReports) {
      const snap = await txns().doc(transactionId).collection(CLIENT_REPORTS_SUBCOLLECTION).orderBy("createdAt", "desc").limit(LIMITS.MAX_CLIENT_REPORTS_PER_TRANSACTION).get();
      out.clientReports = snap.docs.map((d) => toJson(d.data()));
    }
    return out;
  }

  async function listTransactions(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const status = v.oneOf(data, "status", Object.values(STATES), { required: false });
    const mine = v.boolean(data, "mine", { defaultValue: false });
    const size = v.pageSize(data, LIMITS.DEFAULT_PAGE_SIZE, LIMITS.MAX_PAGE_SIZE);
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    let q = txns().where("tripId", "==", tripId);
    if (status) q = q.where("status", "==", status);
    if (mine) q = q.where("initiatedByUid", "==", uid);
    q = q.orderBy("createdAt", "desc").orderBy("__name__", "desc");
    const cursor = decodeCursor(data.cursor);
    if (cursor) q = q.startAfter(cursor.ts, cursor.id);
    const snap = await q.limit(size).get();
    return {
      transactions: snap.docs.map((d) => {
        const t = toJson(d.data());
        delete t.qrParams;
        return t;
      }),
      nextCursor: snap.docs.length === size ? encodeCursor(snap.docs[snap.docs.length - 1], "createdAt") : null,
    };
  }

  async function listReconciliationQueue(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const { membership } = await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    let q = db.collection(COLLECTIONS.RECONCILIATION_RECORDS).where("tripId", "==", tripId).where("status", "==", "OPEN");
    if (!isManager(membership)) q = q.where("submittedByUid", "==", uid);
    const snap = await q.orderBy("createdAt", "asc").limit(LIMITS.MAX_PAGE_SIZE).get();
    return { records: snap.docs.map((d) => toJson(d.data())) };
  }

  return {
    initiateUpiPayment,
    recordUpiClientResponse,
    submitPaymentReference,
    cancelTransaction,
    verifyTransaction,
    reconcileTransaction,
    recordRefund,
    getTransaction,
    listTransactions,
    listReconciliationQueue,
    // Trusted, server-only entry point for verification adapters / webhook handlers.
    applyAdapterResult,
  };
}

module.exports = { makeTransactionService, UTR_RE, CLIENT_OUTCOME_TARGET };
