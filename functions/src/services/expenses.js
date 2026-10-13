"use strict";

const { COLLECTIONS, SCHEMA_VERSION, LIMITS, MANAGER_ROLES } = require("../lib/constants");
const v = require("../lib/validate");
const { requireAuth, loadMemberContext, requireActiveMembers, isManager } = require("../lib/access");
const { runIdempotent } = require("../lib/idempotency");
const { writeAudit, diff } = require("../lib/audit");
const { invalid, denied, notFound, precondition } = require("../lib/errors");
const { toJson, encodeCursor, decodeCursor } = require("../lib/serialize");
const { computeShares, SPLIT_TYPES, SplitError, sumShares } = require("../domain/splits");
const { EXPENSE_VERIFICATION, EXPENSE_KINDS } = require("../domain/ledger");
const { STATES, VERIFIED_STATES } = require("../domain/paymentStates");
const { loadTripCategories } = require("./categories");
const { createDeterministicCategorizer } = require("./categorizationService");

const MAX_EXPENSE_AMOUNT_MINOR = 100_000_000_000; // INR 1,000,000,000 sanity cap

function parseSplit(raw) {
  if (!v.isPlainObject(raw)) throw invalid("split must be an object.", "INVALID_FIELD", { field: "split" });
  const type = raw.type;
  if (!Object.values(SPLIT_TYPES).includes(type)) {
    throw invalid("split.type must be EQUAL, AMOUNT or PERCENTAGE.", "INVALID_SPLIT_TYPE");
  }
  if (type === SPLIT_TYPES.EQUAL) return { type, values: null };
  if (!v.isPlainObject(raw.values)) throw invalid("split.values is required for AMOUNT and PERCENTAGE splits.", "MISSING_FIELD", { field: "split.values" });
  const values = {};
  for (const [uid, val] of Object.entries(raw.values)) {
    if (!v.ID_RE.test(uid) || !Number.isSafeInteger(val)) {
      throw invalid("split.values must map member ids to integers (paise or basis points).", "INVALID_FIELD", { field: "split.values" });
    }
    values[uid] = val;
  }
  return { type, values };
}

function sharesOrThrow(amountMinor, participants, split) {
  try {
    return computeShares(amountMinor, participants, split);
  } catch (e) {
    if (e instanceof SplitError) throw invalid(e.message, e.reason);
    throw e;
  }
}

function splitRef(ctx, expenseId, uid) {
  return ctx.db.collection(COLLECTIONS.EXPENSE_SPLITS).doc(`${expenseId}_${uid}`);
}

/** Writes one expenseSplits doc per participant; marks dropped participants as REMOVED (never deletes). */
function writeSplitDocs(ctx, tx, expense, previousParticipants = []) {
  const { FieldValue } = ctx;
  for (const uid of expense.participantUids) {
    tx.set(splitRef(ctx, expense.expenseId, uid), {
      splitId: `${expense.expenseId}_${uid}`,
      tripId: expense.tripId,
      expenseId: expense.expenseId,
      uid,
      shareMinor: expense.shares[uid],
      paidByUid: expense.paidByUid,
      verificationStatus: expense.verificationStatus,
      status: expense.status === "VOIDED" ? "VOIDED" : "ACTIVE",
      updatedAt: FieldValue.serverTimestamp(),
      schemaVersion: SCHEMA_VERSION,
    });
  }
  for (const uid of previousParticipants) {
    if (expense.participantUids.includes(uid)) continue;
    tx.set(splitRef(ctx, expense.expenseId, uid), {
      splitId: `${expense.expenseId}_${uid}`,
      tripId: expense.tripId,
      expenseId: expense.expenseId,
      uid,
      shareMinor: 0,
      paidByUid: expense.paidByUid,
      verificationStatus: expense.verificationStatus,
      status: "REMOVED",
      updatedAt: FieldValue.serverTimestamp(),
      schemaVersion: SCHEMA_VERSION,
    });
  }
}

/**
 * Validates the expense fields common to create paths. Pure input parsing, no reads.
 */
function parseExpenseInput(data, { requireAmount }) {
  const title = v.string(data, "title", { max: LIMITS.MAX_TITLE_LENGTH });
  const merchantName = v.string(data, "merchantName", { required: false, max: 100 });
  const amountMinor = v.integer(data, "amountMinor", { required: requireAmount, min: 1, max: MAX_EXPENSE_AMOUNT_MINOR });
  const currency = v.string(data, "currency", { required: false, min: 3, max: 3 });
  const categoryId = v.id(data, "categoryId", { required: false });
  const paidByUid = v.id(data, "paidByUid", { required: false });
  const participantUids = v.idArray(data, "participantUids", { max: LIMITS.MAX_PARTICIPANTS_PER_EXPENSE });
  const split = data.split === undefined ? { type: SPLIT_TYPES.EQUAL, values: null } : parseSplit(data.split);
  const notes = v.string(data, "notes", { required: false, max: LIMITS.MAX_NOTE_LENGTH });
  const expenseDate = v.isoDate(data, "expenseDate");
  const receiptIds = data.receiptIds === undefined ? [] : v.idArray(data, "receiptIds", { min: 0, max: 10 });
  return { title, merchantName, amountMinor, currency, categoryId, paidByUid, participantUids, split, notes, expenseDate, receiptIds };
}

/**
 * Read phase for creating an expense (all tx reads). Returns a plan that
 * `commitExpenseCreate` writes. Used by createExpense and by
 * initiateUpiPayment when an expense is attached to a new payment.
 */
async function prepareExpenseCreate(ctx, tx, { uid, membership, trip, tripId, input, transaction, categoryInput, categorizer }) {
  const paidByUid = input.paidByUid || uid;
  if (paidByUid !== uid && !isManager(membership)) {
    throw denied("Only trip admins can record an expense paid by someone else.", "CANNOT_ASSIGN_PAYER");
  }
  const currency = input.currency || trip.currency;
  if (currency !== trip.currency) throw invalid(`Expenses in this trip must be in ${trip.currency}.`, "CURRENCY_MISMATCH");

  let amountMinor = input.amountMinor;
  let verificationStatus = EXPENSE_VERIFICATION.MEMBER_REPORTED;
  if (transaction) {
    if (transaction.initiatedByUid !== paidByUid) {
      throw denied("The payer of a UPI expense must be the person who made the payment.", "PAYER_TRANSACTION_MISMATCH");
    }
    if (amountMinor !== null && amountMinor !== undefined && amountMinor !== transaction.amountMinor) {
      throw invalid("Expense amount must equal the payment amount.", "AMOUNT_TRANSACTION_MISMATCH");
    }
    amountMinor = transaction.amountMinor;
    verificationStatus = transaction.status;
  }
  if (!amountMinor) throw invalid("amountMinor is required.", "MISSING_FIELD", { field: "amountMinor" });

  const memberUids = [...new Set([paidByUid, ...input.participantUids])];
  const [members, categories] = await Promise.all([
    requireActiveMembers(ctx, tx, tripId, memberUids),
    loadTripCategories(ctx, tx, tripId),
  ]);
  void members;

  let categoryId = input.categoryId;
  let categorySource = "MANUAL";
  if (categoryId) {
    const cat = categories.find((c) => c.id === categoryId);
    if (!cat || cat.archived) throw invalid("Unknown or archived category.", "INVALID_CATEGORY");
  } else {
    const suggestion = await categorizer.suggest(
      { merchantName: input.merchantName, description: input.title, merchantCategoryCode: categoryInput && categoryInput.merchantCategoryCode },
      categories,
    );
    categoryId = suggestion.categoryId;
    categorySource = suggestion.source;
  }

  const shares = sharesOrThrow(amountMinor, input.participantUids, input.split);
  return { tripId, uid, paidByUid, amountMinor, currency, verificationStatus, categoryId, categorySource, shares, input, transaction };
}

function commitExpenseCreate(ctx, tx, plan, { expenseRef, kind = EXPENSE_KINDS.STANDARD, adjustsExpenseId = null, transactionId = null } = {}) {
  const { FieldValue } = ctx;
  const ref = expenseRef || ctx.db.collection(COLLECTIONS.EXPENSES).doc();
  const expense = {
    expenseId: ref.id,
    tripId: plan.tripId,
    kind,
    title: plan.input.title,
    merchantName: plan.input.merchantName || null,
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    categoryId: plan.categoryId,
    categorySource: plan.categorySource,
    paidByUid: plan.paidByUid,
    createdByUid: plan.uid,
    participantUids: [...plan.input.participantUids].sort(),
    split: plan.input.split,
    shares: plan.shares,
    notes: plan.input.notes || null,
    receiptIds: plan.input.receiptIds || [],
    expenseDate: plan.input.expenseDate || null,
    transactionId,
    adjustsExpenseId,
    verificationStatus: plan.verificationStatus,
    verificationSource: plan.transaction ? "TRANSACTION" : "MEMBER_REPORTED",
    status: "ACTIVE",
    version: 1,
    schemaVersion: SCHEMA_VERSION,
  };
  tx.set(ref, { ...expense, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  writeSplitDocs(ctx, tx, expense);
  writeAudit(ctx, tx, {
    tripId: plan.tripId,
    actorUid: plan.uid,
    action: kind === EXPENSE_KINDS.STANDARD ? "EXPENSE_CREATED" : "EXPENSE_ADJUSTMENT_CREATED",
    entityType: "expense",
    entityId: ref.id,
    changes: { amountMinor: expense.amountMinor, paidByUid: expense.paidByUid, participantUids: expense.participantUids, split: expense.split, transactionId },
  });
  return expense;
}

/**
 * Mirror a linked transaction's status onto its expense (and split docs).
 * Caller must have read `expense` inside the same transaction.
 */
function syncExpenseVerification(ctx, tx, expense, status, { actorUid = null, actorType = "SYSTEM", source = "TRANSACTION", extra = {} } = {}) {
  if (!expense || expense.verificationStatus === status) return;
  const { FieldValue } = ctx;
  tx.update(ctx.db.collection(COLLECTIONS.EXPENSES).doc(expense.expenseId), {
    ...extra,
    verificationStatus: status,
    verificationSource: source,
    version: expense.version + 1,
    updatedAt: FieldValue.serverTimestamp(),
  });
  for (const uid of expense.participantUids) {
    tx.set(splitRef(ctx, expense.expenseId, uid), { verificationStatus: status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  writeAudit(ctx, tx, {
    tripId: expense.tripId,
    actorUid,
    actorType,
    action: "EXPENSE_VERIFICATION_CHANGED",
    entityType: "expense",
    entityId: expense.expenseId,
    changes: { verificationStatus: { from: expense.verificationStatus, to: status } },
  });
}

function makeExpenseService(ctx, { categorizer = createDeterministicCategorizer() } = {}) {
  const { db, FieldValue } = ctx;
  const expenses = () => db.collection(COLLECTIONS.EXPENSES);

  async function createExpense(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "title", "merchantName", "amountMinor", "currency", "categoryId", "paidByUid", "participantUids", "split", "notes", "expenseDate", "receiptIds", "transactionId", "idempotencyKey"]);
    const tripId = v.id(data, "tripId");
    const transactionId = v.id(data, "transactionId", { required: false });
    const input = parseExpenseInput(data, { requireAmount: !transactionId });
    const key = v.idempotencyKey(data);
    const payload = { ...input, tripId, transactionId };

    return runIdempotent(ctx, { uid, operation: "createExpense", key, payload }, async (tx) => {
      const { trip, membership } = await loadMemberContext(ctx, tx, tripId, uid);
      let transaction = null;
      let txnRef = null;
      if (transactionId) {
        txnRef = db.collection(COLLECTIONS.TRANSACTIONS).doc(transactionId);
        const snap = await tx.get(txnRef);
        if (!snap.exists || snap.data().tripId !== tripId) throw notFound("Payment not found in this trip.", "TRANSACTION_NOT_FOUND");
        transaction = snap.data();
        if (transaction.kind !== "PAYMENT" || transaction.purpose !== "MERCHANT") {
          throw precondition("Only merchant payments can be linked to an expense.", "TRANSACTION_NOT_LINKABLE");
        }
        if (transaction.expenseId) throw precondition("This payment is already linked to an expense.", "TRANSACTION_ALREADY_LINKED");
        if (transaction.initiatedByUid !== uid && !isManager(membership)) {
          throw denied("Only the payer or a trip admin can link this payment.", "NOT_TRANSACTION_OWNER");
        }
      }
      const plan = await prepareExpenseCreate(ctx, tx, {
        uid, membership, trip, tripId, input, transaction, categorizer,
        categoryInput: transaction ? { merchantCategoryCode: transaction.payee && transaction.payee.merchantCategoryCode } : null,
      });
      const expense = commitExpenseCreate(ctx, tx, plan, { transactionId });
      if (txnRef) tx.update(txnRef, { expenseId: expense.expenseId, categoryId: expense.categoryId, updatedAt: FieldValue.serverTimestamp() });
      return { expenseId: expense.expenseId, verificationStatus: expense.verificationStatus, shares: expense.shares, categoryId: expense.categoryId };
    });
  }

  async function loadExpenseForEdit(tx, tripId, expenseId, uid, expectedVersion) {
    const ctxMember = await loadMemberContext(ctx, tx, tripId, uid);
    const snap = await tx.get(expenses().doc(expenseId));
    if (!snap.exists || snap.data().tripId !== tripId) throw notFound("Expense not found.", "EXPENSE_NOT_FOUND");
    const expense = snap.data();
    if (expense.status === "VOIDED") throw precondition("This expense has been voided.", "EXPENSE_VOIDED");
    const canEdit = expense.createdByUid === uid || expense.paidByUid === uid || isManager(ctxMember.membership);
    if (!canEdit) throw denied("Only the creator, the payer or a trip admin can edit this expense.", "CANNOT_EDIT_EXPENSE");
    if (expectedVersion !== expense.version) {
      throw precondition("This expense was changed by someone else. Reload and try again.", "VERSION_CONFLICT", { currentVersion: expense.version });
    }
    return { ...ctxMember, expense, ref: snap.ref };
  }

  /**
   * Edit title, merchant, category, notes, date, receipts, participants and split.
   * The amount and payer can only change on member-reported (non-UPI) expenses that
   * are not confirmed; anything else needs a compensating adjustment.
   */
  async function updateExpense(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "expenseId", "expectedVersion", "title", "merchantName", "categoryId", "notes", "expenseDate", "receiptIds", "participantUids", "split", "amountMinor", "paidByUid"]);
    const tripId = v.id(data, "tripId");
    const expenseId = v.id(data, "expenseId");
    const expectedVersion = v.integer(data, "expectedVersion", { min: 1 });

    const updates = {};
    if (data.title !== undefined) updates.title = v.string(data, "title", { max: LIMITS.MAX_TITLE_LENGTH });
    if (data.merchantName !== undefined) updates.merchantName = v.string(data, "merchantName", { required: false, max: 100 });
    if (data.categoryId !== undefined) updates.categoryId = v.id(data, "categoryId");
    if (data.notes !== undefined) updates.notes = v.string(data, "notes", { required: false, max: LIMITS.MAX_NOTE_LENGTH });
    if (data.expenseDate !== undefined) updates.expenseDate = v.isoDate(data, "expenseDate");
    if (data.receiptIds !== undefined) updates.receiptIds = v.idArray(data, "receiptIds", { min: 0, max: 10 });
    const newParticipants = data.participantUids !== undefined ? v.idArray(data, "participantUids", { max: LIMITS.MAX_PARTICIPANTS_PER_EXPENSE }) : null;
    const newSplit = data.split !== undefined ? parseSplit(data.split) : null;
    const newAmount = data.amountMinor !== undefined ? v.integer(data, "amountMinor", { min: 1, max: MAX_EXPENSE_AMOUNT_MINOR }) : null;
    const newPayer = data.paidByUid !== undefined ? v.id(data, "paidByUid") : null;
    if (!Object.keys(updates).length && !newParticipants && !newSplit && newAmount === null && !newPayer) {
      throw invalid("Nothing to update.", "NO_CHANGES");
    }

    return db.runTransaction(async (tx) => {
      const { expense, ref, membership } = await loadExpenseForEdit(tx, tripId, expenseId, uid, expectedVersion);
      const moneyChange = (newAmount !== null && newAmount !== expense.amountMinor) || (newPayer && newPayer !== expense.paidByUid);
      if (moneyChange) {
        if (expense.transactionId || expense.verificationStatus !== EXPENSE_VERIFICATION.MEMBER_REPORTED) {
          throw precondition("The amount and payer of a UPI or confirmed expense cannot be changed. Record an adjustment instead.", "AMOUNT_IMMUTABLE");
        }
        if (newPayer && newPayer !== expense.paidByUid && !isManager(membership)) {
          throw denied("Only trip admins can change who paid.", "CANNOT_ASSIGN_PAYER");
        }
      }
      const shareChange = newParticipants || newSplit || (newAmount !== null && newAmount !== expense.amountMinor);
      if (shareChange && expense.kind !== EXPENSE_KINDS.STANDARD) {
        throw precondition("Adjustment entries mirror the original split and cannot be re-split.", "ADJUSTMENT_IMMUTABLE");
      }

      const toCheck = [...new Set([...(newParticipants || []), ...(newPayer ? [newPayer] : [])])];
      const reads = [requireActiveMembers(ctx, tx, tripId, toCheck)];
      if (updates.categoryId) reads.push(loadTripCategories(ctx, tx, tripId));
      const [, categories] = await Promise.all(reads);
      if (updates.categoryId) {
        const cat = categories.find((c) => c.id === updates.categoryId);
        if (!cat || cat.archived) throw invalid("Unknown or archived category.", "INVALID_CATEGORY");
        updates.categorySource = "MANUAL";
      }

      const next = { ...expense, ...updates };
      if (newAmount !== null) next.amountMinor = newAmount;
      if (newPayer) next.paidByUid = newPayer;
      if (shareChange) {
        const participants = newParticipants || expense.participantUids;
        let split = newSplit || expense.split;
        if (!newSplit && split.type !== SPLIT_TYPES.EQUAL && newParticipants) {
          throw invalid("Changing participants of a custom split requires a new split.", "SPLIT_REQUIRED");
        }
        if (!newSplit && split.type === SPLIT_TYPES.AMOUNT && newAmount !== null) {
          throw invalid("Changing the amount of a custom-amount split requires a new split.", "SPLIT_REQUIRED");
        }
        next.participantUids = [...participants].sort();
        next.split = split;
        next.shares = sharesOrThrow(next.amountMinor, participants, split);
        if (sumShares(next.shares) !== next.amountMinor) throw new Error("Invariant violated: shares do not sum to amount.");
      }
      next.version = expense.version + 1;

      const fields = ["title", "merchantName", "categoryId", "categorySource", "notes", "expenseDate", "receiptIds", "participantUids", "split", "shares", "amountMinor", "paidByUid"];
      const changes = diff(expense, next, fields);
      const write = { version: next.version, updatedAt: FieldValue.serverTimestamp() };
      for (const f of Object.keys(changes)) write[f] = next[f];
      tx.update(ref, write);
      if (shareChange || newPayer) writeSplitDocs(ctx, tx, next, expense.participantUids);
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "EXPENSE_UPDATED", entityType: "expense", entityId: expenseId, changes });
      return { expenseId, version: next.version, shares: next.shares };
    });
  }

  /** Voids an unconfirmed expense. Confirmed history is never voided or deleted. */
  async function voidExpense(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "expenseId", "expectedVersion", "reason"]);
    const tripId = v.id(data, "tripId");
    const expenseId = v.id(data, "expenseId");
    const expectedVersion = v.integer(data, "expectedVersion", { min: 1 });
    const reason = v.string(data, "reason", { max: 300 });
    return db.runTransaction(async (tx) => {
      const { expense, ref } = await loadExpenseForEdit(tx, tripId, expenseId, uid, expectedVersion);
      if (VERIFIED_STATES.includes(expense.verificationStatus)) {
        throw precondition("Confirmed expenses cannot be voided. Record a refund or adjustment instead.", "CONFIRMED_IMMUTABLE");
      }
      if (expense.kind !== EXPENSE_KINDS.STANDARD) throw precondition("Adjustment entries cannot be voided directly.", "ADJUSTMENT_IMMUTABLE");
      let txnRef = null;
      if (expense.transactionId) {
        txnRef = db.collection(COLLECTIONS.TRANSACTIONS).doc(expense.transactionId);
        await tx.get(txnRef);
      }
      const next = { ...expense, status: "VOIDED", version: expense.version + 1 };
      tx.update(ref, { status: "VOIDED", voidReason: reason, voidedByUid: uid, version: next.version, updatedAt: FieldValue.serverTimestamp() });
      writeSplitDocs(ctx, tx, next);
      // Unlink so the payment can be attached to a corrected expense.
      if (txnRef) tx.update(txnRef, { expenseId: null, updatedAt: FieldValue.serverTimestamp() });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "EXPENSE_VOIDED", entityType: "expense", entityId: expenseId, changes: { status: { from: "ACTIVE", to: "VOIDED" } }, metadata: { reason } });
      return { expenseId, status: "VOIDED", version: next.version };
    });
  }

  /**
   * Manual review of a member-reported (non-UPI) expense by a trip admin who is
   * not the payer. Recorded with verificationSource MANUAL_REVIEW.
   */
  async function reviewExpense(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "expenseId", "expectedVersion", "note"]);
    const tripId = v.id(data, "tripId");
    const expenseId = v.id(data, "expenseId");
    const expectedVersion = v.integer(data, "expectedVersion", { min: 1 });
    const note = v.string(data, "note", { max: 500 });
    return db.runTransaction(async (tx) => {
      await loadMemberContext(ctx, tx, tripId, uid, { roles: MANAGER_ROLES });
      const snap = await tx.get(expenses().doc(expenseId));
      if (!snap.exists || snap.data().tripId !== tripId) throw notFound("Expense not found.", "EXPENSE_NOT_FOUND");
      const expense = snap.data();
      if (expense.version !== expectedVersion) throw precondition("This expense was changed by someone else.", "VERSION_CONFLICT");
      if (expense.status !== "ACTIVE" || expense.verificationStatus !== EXPENSE_VERIFICATION.MEMBER_REPORTED || expense.transactionId) {
        throw precondition("Only active member-reported expenses can be reviewed here. UPI payments are reconciled on the transaction.", "NOT_REVIEWABLE");
      }
      if (expense.paidByUid === uid || expense.createdByUid === uid) {
        throw denied("Someone other than the payer and creator must review this expense.", "SELF_REVIEW_NOT_ALLOWED");
      }
      syncExpenseVerification(ctx, tx, expense, STATES.CONFIRMED, {
        actorUid: uid, actorType: "USER", source: "MANUAL_REVIEW", extra: { reviewedByUid: uid, reviewNote: note },
      });
      return { expenseId, verificationStatus: STATES.CONFIRMED };
    });
  }

  async function getExpense(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const expenseId = v.id(data, "expenseId");
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    const snap = await expenses().doc(expenseId).get();
    if (!snap.exists || snap.data().tripId !== tripId) throw notFound("Expense not found.", "EXPENSE_NOT_FOUND");
    return { expense: toJson(snap.data()) };
  }

  async function listExpenses(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const size = v.pageSize(data, LIMITS.DEFAULT_PAGE_SIZE, LIMITS.MAX_PAGE_SIZE);
    const categoryId = v.id(data, "categoryId", { required: false });
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    let q = expenses().where("tripId", "==", tripId);
    if (categoryId) q = q.where("categoryId", "==", categoryId);
    q = q.orderBy("createdAt", "desc").orderBy("__name__", "desc");
    const cursor = decodeCursor(data.cursor);
    if (cursor) q = q.startAfter(cursor.ts, cursor.id);
    const snap = await q.limit(size).get();
    const last = snap.docs[snap.docs.length - 1];
    return {
      expenses: snap.docs.map((d) => toJson(d.data())),
      nextCursor: snap.docs.length === size ? encodeCursor(last, "createdAt") : null,
    };
  }

  return { createExpense, updateExpense, voidExpense, reviewExpense, getExpense, listExpenses };
}

module.exports = {
  makeExpenseService,
  prepareExpenseCreate,
  commitExpenseCreate,
  syncExpenseVerification,
  parseExpenseInput,
  writeSplitDocs,
  splitRef,
};
