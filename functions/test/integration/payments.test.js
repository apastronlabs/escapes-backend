"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clearFirestore, setup, key, as, rejectsWith, tripWith, getDoc, db, QR } = require("../helpers");

test.beforeEach(clearFirestore);

async function pay(h, uid, tripId, extra = {}) {
  return h.initiateUpiPayment(as(uid, {
    tripId, qrPayload: QR("1500.00"), platform: "ANDROID", upiApp: "PHONEPE", reviewConfirmed: true,
    idempotencyKey: key("pay"), ...extra,
  }));
}

test("initiation validates QR, amount and review, and returns a server-built intent", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const r = await pay(h, "a", tripId, { expense: { title: "Beach shack lunch", participantUids: ["a", "b"] } });
  assert.equal(r.status, "INITIATED");
  assert.equal(r.amountMinor, 150000);
  assert.match(r.reference, /^SCP[A-Z2-9]{13}$/);
  assert.equal(r.intentUri, "upi://pay?pa=goa.shack%40okhdfcbank&pn=Goa%20Beach%20Shack&mc=5812&am=1500.00&cu=INR");
  const txn = await getDoc("transactions", r.transactionId);
  assert.equal(txn.amountSource, "QR_FIXED");
  assert.equal(txn.verification.status, "UNVERIFIED");
  const exp = await getDoc("expenses", r.expenseId);
  assert.equal(exp.verificationStatus, "INITIATED");
  assert.equal(exp.categoryId, `${tripId}_food`);
  assert.equal(exp.categorySource, "RULE_MCC");
  assert.equal(exp.paidByUid, "a");

  await rejectsWith(pay(h, "a", tripId, { amountMinor: 100 }), "invalid-argument", "AMOUNT_MISMATCH_WITH_QR");
  await rejectsWith(pay(h, "a", tripId, { reviewConfirmed: false }), "invalid-argument", "REVIEW_NOT_CONFIRMED");
  await rejectsWith(pay(h, "a", tripId, { qrPayload: QR(null) }), "invalid-argument", "MISSING_FIELD");
  await rejectsWith(pay(h, "a", tripId, { qrPayload: "upi://mandate?pa=x@y" }), "invalid-argument", "UNSUPPORTED_UPI_ACTION");
  await rejectsWith(pay(h, "a", tripId, { qrPayload: QR(null), amountMinor: 20_000_000 }), "invalid-argument");
  const userAmount = await pay(h, "a", tripId, { qrPayload: QR(null), amountMinor: 25000 });
  assert.equal(userAmount.amountMinor, 25000);
  const manual = await pay(h, "a", tripId, { qrPayload: undefined, payeeVpa: "Friend@okicici", amountMinor: 1000 });
  assert.match(manual.intentUri, /^upi:\/\/pay\?pa=friend%40okicici&am=10\.00&cu=INR$/);
  await rejectsWith(pay(h, "a", tripId, { qrPayload: undefined, payeeVpa: "nope", amountMinor: 1000 }), "invalid-argument", "INVALID_VPA");
});

test("an unverified UPI success response can never produce a confirmed payment", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const r = await pay(h, "a", tripId, { expense: { title: "Lunch", participantUids: ["a", "b"] } });

  const res = await h.recordUpiClientResponse(as("a", {
    transactionId: r.transactionId, platform: "ANDROID",
    rawResponse: "txnId=YBL123&responseCode=00&Status=SUCCESS&ApprovalRefNo=412345678901",
    idempotencyKey: key(),
  }));
  assert.equal(res.status, "AWAITING_VERIFICATION");
  assert.equal(res.verified, false);
  // Even more "evidence" from the client: UTR, OCR saying SUCCESS with matching amount.
  const claim = await h.submitPaymentReference(as("a", {
    transactionId: r.transactionId, utr: "412345678901",
    ocr: { utr: "412345678901", amountMinor: 150000, status: "SUCCESS", payeeVpa: "goa.shack@okhdfcbank", engine: "mlkit" },
    idempotencyKey: key(),
  }));
  assert.equal(claim.status, "AWAITING_VERIFICATION");
  assert.equal(claim.verified, false);
  // Repeated success callbacks don't move it either.
  await h.recordUpiClientResponse(as("a", { transactionId: r.transactionId, platform: "ANDROID", rawResponse: { Status: "SUCCESS", responseCode: "00" }, idempotencyKey: key() }));

  const txn = await getDoc("transactions", r.transactionId);
  assert.equal(txn.status, "AWAITING_VERIFICATION");
  assert.equal(txn.verification.status, "UNVERIFIED");
  assert.equal(txn.clientReported.outcome, "SUCCESS_CLAIMED");
  assert.equal(txn.claims.utr, "412345678901");
  const exp = await getDoc("expenses", r.expenseId);
  assert.equal(exp.verificationStatus, "AWAITING_VERIFICATION");
  const s = await h.getTripSummary(as("a", { tripId }));
  assert.equal(s.totals.confirmedSpendMinor, 0);
  assert.equal(s.totals.provisionalSpendMinor, 150000);
  assert.equal(s.totals.unverifiedSpendMinor, 150000);
  const raw = await db.collection("transactions").doc(r.transactionId).collection("clientReports").get();
  assert.equal(raw.size, 2);
  assert.ok(raw.docs.every((d) => d.data().trusted === false));
  // There is no client-reachable way to set a status directly.
  await rejectsWith(h.recordUpiClientResponse(as("a", { transactionId: r.transactionId, platform: "ANDROID", status: "CONFIRMED", idempotencyKey: key() })), "invalid-argument", "UNKNOWN_FIELD");
});

test("client outcomes map to unverified states; mismatched references are flagged", async () => {
  const { h } = setup({ attachInternalRefToIntent: true });
  const tripId = await tripWith(h, "a");
  const cases = [
    [null, "PENDING"],
    ["Status=FAILURE&responseCode=ZM", "FAILED"],
    ["Status=SUBMITTED", "PENDING"],
    ["gibberish", "PENDING"],
  ];
  for (const [raw, expected] of cases) {
    const r = await pay(h, "a", tripId);
    const out = await h.recordUpiClientResponse(as("a", { transactionId: r.transactionId, platform: "IOS", rawResponse: raw, idempotencyKey: key() }));
    assert.equal(out.status, expected, String(raw));
  }
  const r = await pay(h, "a", tripId);
  const out = await h.recordUpiClientResponse(as("a", { transactionId: r.transactionId, platform: "ANDROID", rawResponse: "Status=SUCCESS&txnRef=SOMEONEELSE", idempotencyKey: key() }));
  assert.equal(out.status, "PENDING");
  assert.deepEqual(out.anomalies, ["REFERENCE_MISMATCH"]);
});

test("only the payer can report outcomes, claims or cancellations", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const other = await tripWith(h, "x");
  const r = await pay(h, "a", tripId);
  await rejectsWith(h.recordUpiClientResponse(as("b", { transactionId: r.transactionId, platform: "ANDROID", rawResponse: "Status=SUCCESS", idempotencyKey: key() })), "permission-denied", "NOT_TRANSACTION_OWNER");
  await rejectsWith(h.submitPaymentReference(as("b", { transactionId: r.transactionId, utr: "123456789012", idempotencyKey: key() })), "permission-denied", "NOT_TRANSACTION_OWNER");
  await rejectsWith(h.cancelTransaction(as("b", { transactionId: r.transactionId })), "permission-denied", "NOT_TRANSACTION_OWNER");
  // Non-members get "not found", not a hint the payment exists.
  await rejectsWith(h.getTransaction(as("x", { transactionId: r.transactionId })), "not-found", "TRANSACTION_NOT_FOUND");
  // A payment from one trip cannot be linked to an expense in another trip.
  await rejectsWith(h.createExpense(as("x", { tripId: other, title: "steal", participantUids: ["x"], transactionId: r.transactionId, idempotencyKey: key() })), "not-found", "TRANSACTION_NOT_FOUND");
});

test("UTR format and uniqueness; a UTR cannot be attached to two payments", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const t1 = await pay(h, "a", tripId);
  const t2 = await pay(h, "b", tripId);
  await rejectsWith(h.submitPaymentReference(as("a", { transactionId: t1.transactionId, utr: "12345", idempotencyKey: key() })), "invalid-argument");
  await h.submitPaymentReference(as("a", { transactionId: t1.transactionId, utr: "500011112222", idempotencyKey: key() }));
  await rejectsWith(h.submitPaymentReference(as("b", { transactionId: t2.transactionId, utr: "500011112222", idempotencyKey: key() })), "already-exists", "REFERENCE_ALREADY_CLAIMED");
  // Re-submitting on the same payment is fine.
  await h.submitPaymentReference(as("a", { transactionId: t1.transactionId, utr: "500011112222", idempotencyKey: key() }));
  // Uniqueness proves nothing: still unverified.
  assert.equal((await getDoc("transactions", t1.transactionId)).status, "AWAITING_VERIFICATION");
});

test("OCR mismatches are flagged and OCR is never treated as proof", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a");
  const r = await pay(h, "a", tripId);
  const out = await h.submitPaymentReference(as("a", { transactionId: r.transactionId, ocr: { amountMinor: 15000, payeeVpa: "other@upi", status: "SUCCESS" }, idempotencyKey: key() }));
  assert.deepEqual(out.anomalies.sort(), ["OCR_AMOUNT_MISMATCH", "OCR_PAYEE_MISMATCH"]);
  const recs = await db.collection("reconciliationRecords").where("transactionId", "==", r.transactionId).get();
  assert.equal(recs.docs[0].data().claimType, "OCR");
  assert.equal(recs.docs[0].data().trusted, false);
  assert.equal((await getDoc("transactions", r.transactionId)).status, "AWAITING_VERIFICATION");
});

test("manual reconciliation needs a different admin and the exact amount", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "owner", ["m"], { admins: ["adm"] });
  const r = await pay(h, "adm", tripId, { expense: { title: "Kayaking", participantUids: ["owner", "m", "adm"] } });
  await h.recordUpiClientResponse(as("adm", { transactionId: r.transactionId, platform: "ANDROID", rawResponse: "Status=SUCCESS", idempotencyKey: key() }));
  let txn = await getDoc("transactions", r.transactionId);
  const base = { transactionId: r.transactionId, decision: "CONFIRM", evidenceType: "PAYER_BANK_STATEMENT", note: "Checked statement", confirmedAmountMinor: 150000, expectedVersion: txn.version };
  await rejectsWith(h.reconcileTransaction(as("adm", base)), "permission-denied", "SELF_RECONCILIATION_NOT_ALLOWED");
  await rejectsWith(h.reconcileTransaction(as("m", base)), "permission-denied", "INSUFFICIENT_ROLE");
  await rejectsWith(h.reconcileTransaction(as("owner", { ...base, confirmedAmountMinor: 149999 })), "failed-precondition", "AMOUNT_MISMATCH");
  await rejectsWith(h.reconcileTransaction(as("owner", { ...base, expectedVersion: 1 })), "failed-precondition", "VERSION_CONFLICT");
  const out = await h.reconcileTransaction(as("owner", base));
  assert.equal(out.status, "CONFIRMED");
  txn = await getDoc("transactions", r.transactionId);
  assert.equal(txn.verification.status, "VERIFIED");
  assert.equal(txn.verification.source, "MANUAL_RECONCILIATION");
  assert.equal(txn.statusSetBy, "TRUSTED");
  assert.equal((await getDoc("expenses", r.expenseId)).verificationStatus, "CONFIRMED");
  const recs = await db.collection("reconciliationRecords").where("transactionId", "==", r.transactionId).get();
  assert.ok(recs.docs.every((d) => d.data().status === "ACCEPTED"));
  // Client cannot change a trusted status afterwards.
  await rejectsWith(h.cancelTransaction(as("adm", { transactionId: r.transactionId })), "failed-precondition", "STATUS_LOCKED_BY_TRUSTED_SOURCE");
  const again = await h.recordUpiClientResponse(as("adm", { transactionId: r.transactionId, platform: "ANDROID", rawResponse: "Status=FAILURE", idempotencyKey: key() }));
  assert.equal(again.status, "CONFIRMED");
  assert.equal(again.transitioned, false);
  const s = await h.getTripSummary(as("m", { tripId }));
  assert.equal(s.totals.confirmedSpendMinor, 150000);
  // Confirmed amount is immutable.
  await rejectsWith(h.updateExpense(as("adm", { tripId, expenseId: r.expenseId, expectedVersion: (await getDoc("expenses", r.expenseId)).version, amountMinor: 1 })), "failed-precondition", "AMOUNT_IMMUTABLE");
});

test("verification adapter: none = unavailable; mismatched amount or payee never confirms", async () => {
  const { h, adapter } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const r = await pay(h, "a", tripId);
  await h.submitPaymentReference(as("a", { transactionId: r.transactionId, utr: "777766665555", idempotencyKey: key() }));
  let out = await h.verifyTransaction(as("a", { transactionId: r.transactionId }));
  assert.equal(out.verificationAvailable, false);
  assert.equal((await getDoc("transactions", r.transactionId)).status, "AWAITING_VERIFICATION");

  adapter.next = { result: "CONFIRMED", source: "PROVIDER_API:fake", amountMinor: 100, payeeVpa: "goa.shack@okhdfcbank" };
  out = await h.verifyTransaction(as("a", { transactionId: r.transactionId }));
  assert.equal(out.applied, false);
  assert.equal(out.reason, "VERIFIED_AMOUNT_MISMATCH");
  adapter.next = { result: "CONFIRMED", source: "PROVIDER_API:fake", amountMinor: 150000, payeeVpa: "attacker@upi" };
  out = await h.verifyTransaction(as("a", { transactionId: r.transactionId }));
  assert.equal(out.reason, "VERIFIED_PAYEE_MISMATCH");
  assert.equal((await getDoc("transactions", r.transactionId)).status, "AWAITING_VERIFICATION");

  adapter.next = { result: "CONFIRMED", source: "PROVIDER_API:fake", amountMinor: 150000, payeeVpa: "GOA.SHACK@okhdfcbank", providerReference: "777766665555" };
  out = await h.verifyTransaction(as("b", { transactionId: r.transactionId })).catch((e) => e);
  assert.equal(out.details.reason, "NOT_TRANSACTION_OWNER");
  out = await h.verifyTransaction(as("a", { transactionId: r.transactionId }));
  assert.equal(out.status, "CONFIRMED");
  const txn = await getDoc("transactions", r.transactionId);
  assert.equal(txn.verification.source, "PROVIDER_API:fake");
  assert.deepEqual(txn.anomalies.sort(), ["VERIFIED_AMOUNT_MISMATCH", "VERIFIED_PAYEE_MISMATCH"]);
});

test("refunds are compensating records; full refund marks the original REFUNDED", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b", "c"], { admins: [] });
  await h.updateMemberRole(as("a", { tripId, uid: "c", role: "ADMIN" }));
  const r = await pay(h, "b", tripId, { expense: { title: "Scooter rental", participantUids: ["a", "b", "c"] } });
  await h.submitPaymentReference(as("b", { transactionId: r.transactionId, utr: "100000000001", idempotencyKey: key() }));
  let txn = await getDoc("transactions", r.transactionId);
  await rejectsWith(h.recordRefund(as("b", { transactionId: r.transactionId, kind: "REFUND", amountMinor: 100, reason: "early", idempotencyKey: key() })), "failed-precondition", "NOT_CONFIRMED");
  await h.reconcileTransaction(as("a", { transactionId: r.transactionId, decision: "CONFIRM", evidenceType: "MERCHANT_CONFIRMATION", note: "Shop confirmed", confirmedAmountMinor: 150000, expectedVersion: txn.version }));

  // Partial refund of 600.00
  const ref1 = await h.recordRefund(as("b", { transactionId: r.transactionId, kind: "REFUND", amountMinor: 60000, reason: "Returned a scooter early", idempotencyKey: key() }));
  assert.equal(ref1.status, "AWAITING_VERIFICATION");
  await rejectsWith(h.recordRefund(as("b", { transactionId: r.transactionId, kind: "REFUND", amountMinor: 90001, reason: "too much", idempotencyKey: key() })), "invalid-argument", "REFUND_EXCEEDS_REMAINING");
  let s = await h.getTripSummary(as("a", { tripId }));
  assert.equal(s.totals.confirmedSpendMinor, 150000);
  assert.equal(s.totals.provisionalSpendMinor, 90000);
  const adj = await getDoc("expenses", ref1.adjustmentExpenseId);
  assert.equal(adj.amountMinor, -60000);
  assert.deepEqual(adj.shares, { a: -20000, b: -20000, c: -20000 });
  assert.equal(adj.paidByUid, "b");

  const refTxn = await getDoc("transactions", ref1.transactionId);
  // the refund's recorder (b) cannot confirm it; another admin can
  await rejectsWith(h.reconcileTransaction(as("b", { transactionId: ref1.transactionId, decision: "CONFIRM", evidenceType: "PAYER_BANK_STATEMENT", note: "self check", confirmedAmountMinor: 60000, expectedVersion: refTxn.version })), "permission-denied");
  await h.reconcileTransaction(as("c", { transactionId: ref1.transactionId, decision: "CONFIRM", evidenceType: "PAYER_BANK_STATEMENT", note: "Saw credit", confirmedAmountMinor: 60000, expectedVersion: refTxn.version }));
  txn = await getDoc("transactions", r.transactionId);
  assert.equal(txn.status, "CONFIRMED");
  assert.equal(txn.amountMinor, 150000, "original amount never changes");
  assert.equal(txn.refundedMinor, 60000);
  assert.equal(txn.pendingRefundMinor, 0);
  s = await h.getTripSummary(as("a", { tripId }));
  assert.equal(s.totals.confirmedSpendMinor, 90000);
  assert.equal(s.confirmed.balances.find((x) => x.uid === "b").netMinor, 60000);

  // Remaining 900.00 refunded -> original becomes REFUNDED, balances fully net out.
  const ref2 = await h.recordRefund(as("b", { transactionId: r.transactionId, kind: "REFUND", amountMinor: 90000, reason: "Trip cancelled", idempotencyKey: key() }));
  const ref2Txn = await getDoc("transactions", ref2.transactionId);
  await h.reconcileTransaction(as("a", { transactionId: ref2.transactionId, decision: "CONFIRM", evidenceType: "PAYER_BANK_STATEMENT", note: "credit", confirmedAmountMinor: 90000, expectedVersion: ref2Txn.version }));
  txn = await getDoc("transactions", r.transactionId);
  assert.equal(txn.status, "REFUNDED");
  assert.equal((await getDoc("expenses", r.expenseId)).verificationStatus, "REFUNDED");
  s = await h.getTripSummary(as("a", { tripId }));
  assert.equal(s.totals.confirmedSpendMinor, 0);
  assert.ok(s.confirmed.balances.every((x) => x.netMinor === 0));
  await rejectsWith(h.recordRefund(as("b", { transactionId: r.transactionId, kind: "REFUND", amountMinor: 1, reason: "more", idempotencyKey: key() })), "failed-precondition", "NOT_CONFIRMED");
});

test("rejected refund claim releases the pending amount", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const r = await pay(h, "b", tripId, { expense: { title: "Ferry", participantUids: ["a", "b"] } });
  let txn = await getDoc("transactions", r.transactionId);
  await h.reconcileTransaction(as("a", { transactionId: r.transactionId, decision: "CONFIRM", evidenceType: "MERCHANT_CONFIRMATION", note: "Ferry desk confirmed", confirmedAmountMinor: 150000, expectedVersion: txn.version }));
  const ref = await h.recordRefund(as("b", { transactionId: r.transactionId, kind: "REVERSAL", amountMinor: 150000, reason: "bank reversal", idempotencyKey: key() }));
  const refTxn = await getDoc("transactions", ref.transactionId);
  await h.reconcileTransaction(as("a", { transactionId: ref.transactionId, decision: "REJECT", evidenceType: "PAYER_BANK_STATEMENT", note: "No credit seen", expectedVersion: refTxn.version }));
  txn = await getDoc("transactions", r.transactionId);
  assert.equal(txn.status, "CONFIRMED");
  assert.equal(txn.pendingRefundMinor, 0);
  assert.equal((await getDoc("expenses", ref.adjustmentExpenseId)).verificationStatus, "FAILED");
  const s = await h.getTripSummary(as("a", { tripId }));
  assert.equal(s.totals.confirmedSpendMinor, 150000);
  assert.equal(s.totals.provisionalSpendMinor, 150000);
});

test("member-to-member UPI settlement is confirmed only by the receiver", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const r = await h.initiateUpiPayment(as("b", { tripId, purpose: "MEMBER_SETTLEMENT", payeeUid: "a", payeeVpa: "alice@oksbi", amountMinor: 50000, platform: "IOS", reviewConfirmed: true, idempotencyKey: key() }));
  assert.ok(r.settlementId);
  await h.submitPaymentReference(as("b", { transactionId: r.transactionId, utr: "999988887777", idempotencyKey: key() }));
  let s = await h.getTripSummary(as("a", { tripId }));
  assert.equal(s.provisional.balances.find((x) => x.uid === "b").netMinor, 50000);
  assert.equal(s.confirmed.balances.find((x) => x.uid === "b").netMinor, 0);
  const txn = await getDoc("transactions", r.transactionId);
  const base = { transactionId: r.transactionId, decision: "CONFIRM", evidenceType: "BENEFICIARY_STATEMENT", note: "Got it", confirmedAmountMinor: 50000, expectedVersion: txn.version };
  await rejectsWith(h.reconcileTransaction(as("b", base)), "permission-denied", "NOT_BENEFICIARY");
  await rejectsWith(h.confirmSettlement(as("a", { tripId, settlementId: r.settlementId })), "failed-precondition", "USE_RECONCILE_TRANSACTION");
  const out = await h.reconcileTransaction(as("a", base));
  assert.equal(out.verificationSource, "BENEFICIARY_CONFIRMATION");
  assert.equal((await getDoc("settlements", r.settlementId)).status, "CONFIRMED");
  s = await h.getTripSummary(as("a", { tripId }));
  assert.equal(s.confirmed.balances.find((x) => x.uid === "b").netMinor, 50000);
});

test("cancelled and failed payments are excluded; pending ones are listed as unresolved", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const p1 = await pay(h, "a", tripId, { expense: { title: "p1", participantUids: ["a", "b"] } });
  const p2 = await pay(h, "a", tripId, { expense: { title: "p2", participantUids: ["a", "b"] } });
  const p3 = await pay(h, "a", tripId, { expense: { title: "p3", participantUids: ["a", "b"] } });
  await h.cancelTransaction(as("a", { transactionId: p1.transactionId, reason: "changed mind" }));
  await h.recordUpiClientResponse(as("a", { transactionId: p2.transactionId, platform: "ANDROID", rawResponse: "Status=FAILURE", idempotencyKey: key() }));
  await h.recordUpiClientResponse(as("a", { transactionId: p3.transactionId, platform: "IOS", rawResponse: null, idempotencyKey: key() }));
  const s = await h.getTripSummary(as("b", { tripId }));
  assert.equal(s.totals.provisionalSpendMinor, 0);
  assert.deepEqual(s.unresolved.map((u) => u.title), ["p3"]);
  // Money was in fact debited after a client-reported failure: the user can claim it.
  const claim = await h.submitPaymentReference(as("a", { transactionId: p2.transactionId, utr: "123123123123", idempotencyKey: key() }));
  assert.equal(claim.status, "AWAITING_VERIFICATION");
  const list = await h.listTransactions(as("b", { tripId, status: "CANCELLED" }));
  assert.deepEqual(list.transactions.map((t) => t.transactionId), [p1.transactionId]);
});

test("receipts: path ownership, server-side metadata, signed URL only for members", async () => {
  const { h, bucket } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const other = await tripWith(h, "z");
  await rejectsWith(h.registerReceipt(as("a", { tripId, storagePath: `receipts/${tripId}/b/r.jpg`, idempotencyKey: key() })), "invalid-argument", "INVALID_STORAGE_PATH");
  await rejectsWith(h.registerReceipt(as("a", { tripId, storagePath: `receipts/${tripId}/a/missing.jpg`, idempotencyKey: key() })), "not-found", "RECEIPT_FILE_NOT_FOUND");
  bucket.put(`receipts/${tripId}/a/bad.exe`, { size: 10, contentType: "application/octet-stream" });
  await rejectsWith(h.registerReceipt(as("a", { tripId, storagePath: `receipts/${tripId}/a/bad.exe`, idempotencyKey: key() })), "invalid-argument", "UNSUPPORTED_RECEIPT_TYPE");
  bucket.put(`receipts/${tripId}/a/r1.jpg`, { size: 2048, contentType: "image/jpeg" });
  const { receiptId } = await h.registerReceipt(as("a", { tripId, storagePath: `receipts/${tripId}/a/r1.jpg`, idempotencyKey: key() }));
  const doc = await getDoc("receipts", receiptId);
  assert.equal(doc.sizeBytes, 2048);
  assert.equal(Object.values(doc).some((x) => typeof x === "string" && x.startsWith("http")), false, "no URLs stored");
  const { url } = await h.getReceiptUrl(as("b", { tripId, receiptId }));
  assert.match(url, /^https:\/\/signed\.example\//);
  await rejectsWith(h.getReceiptUrl(as("z", { tripId, receiptId })), "permission-denied", "NOT_A_MEMBER");
  await rejectsWith(h.getReceiptUrl(as("z", { tripId: other, receiptId })), "not-found", "RECEIPT_NOT_FOUND");
  // b cannot attach a's receipt to b's payment claim
  const t = await pay(h, "b", tripId);
  await rejectsWith(h.submitPaymentReference(as("b", { transactionId: t.transactionId, receiptId, idempotencyKey: key() })), "not-found", "RECEIPT_NOT_FOUND");
  const t2 = await pay(h, "a", tripId);
  const claim = await h.submitPaymentReference(as("a", { transactionId: t2.transactionId, receiptId, idempotencyKey: key() }));
  assert.equal(claim.status, "AWAITING_VERIFICATION");
});
