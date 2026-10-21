"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clearFirestore, setup, key, as, rejectsWith, tripWith, getDoc, db, QR } = require("../helpers");

test.beforeEach(clearFirestore);

test("duplicate createTrip with the same key returns the same trip", async () => {
  const { h } = setup();
  const k = key();
  const first = await h.createTrip(as("a", { name: "Spiti", idempotencyKey: k }));
  const replay = await h.createTrip(as("a", { name: "Spiti", idempotencyKey: k }));
  assert.equal(replay.tripId, first.tripId);
  assert.equal(replay.idempotentReplay, true);
  assert.equal((await db.collection("trips").get()).size, 1);
  await rejectsWith(h.createTrip(as("a", { name: "Different", idempotencyKey: k })), "already-exists", "IDEMPOTENCY_KEY_REUSED");
  // Keys are per user: another user's identical key is independent.
  const other = await h.createTrip(as("b", { name: "Spiti", idempotencyKey: k }));
  assert.notEqual(other.tripId, first.tripId);
});

test("parallel duplicate submissions create exactly one expense", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const k = key();
  const req = () => h.createExpense(as("a", { tripId, title: "Paragliding", amountMinor: 450000, participantUids: ["a", "b"], idempotencyKey: k }));
  const results = await Promise.all(Array.from({ length: 8 }, req));
  assert.equal(new Set(results.map((r) => r.expenseId)).size, 1);
  const snap = await db.collection("expenses").where("tripId", "==", tripId).get();
  assert.equal(snap.size, 1);
  const audits = await db.collection("auditLogs").where("entityId", "==", results[0].expenseId).get();
  assert.equal(audits.size, 1);
});

test("parallel duplicate payment initiations create exactly one transaction", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const k = key();
  const req = () => h.initiateUpiPayment(as("a", { tripId, qrPayload: QR("999.00"), platform: "ANDROID", reviewConfirmed: true, expense: { title: "Dinner", participantUids: ["a", "b"] }, idempotencyKey: k }));
  const results = await Promise.all(Array.from({ length: 6 }, req));
  assert.equal(new Set(results.map((r) => r.transactionId)).size, 1);
  assert.equal(new Set(results.map((r) => r.reference)).size, 1);
  assert.equal((await db.collection("transactions").where("tripId", "==", tripId).get()).size, 1);
  assert.equal((await db.collection("expenses").where("tripId", "==", tripId).get()).size, 1);
});

test("duplicate client responses are recorded once", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a");
  const p = await h.initiateUpiPayment(as("a", { tripId, qrPayload: QR("10.00"), platform: "ANDROID", reviewConfirmed: true, idempotencyKey: key() }));
  const k = key();
  const send = () => h.recordUpiClientResponse(as("a", { transactionId: p.transactionId, platform: "ANDROID", rawResponse: "Status=SUCCESS", idempotencyKey: k }));
  await Promise.all([send(), send(), send()]);
  const reports = await db.collection("transactions").doc(p.transactionId).collection("clientReports").get();
  assert.equal(reports.size, 1);
  assert.equal((await getDoc("transactions", p.transactionId)).clientReportCount, 1);
});

test("a single-use invitation accepted concurrently admits exactly one person", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "owner");
  const inv = await h.createInvitation(as("owner", { tripId, idempotencyKey: key() }));
  const results = await Promise.allSettled(["u1", "u2", "u3", "u4", "u5"].map((u) => h.acceptInvitation(as(u, { token: inv.token }))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await getDoc("trips", tripId)).memberCount, 2);
  const members = await h.listMembers(as("owner", { tripId }));
  assert.equal(members.members.length, 2);
});

test("the same UTR submitted concurrently on two payments is attached to only one", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const p1 = await h.initiateUpiPayment(as("a", { tripId, qrPayload: QR("10.00"), platform: "ANDROID", reviewConfirmed: true, idempotencyKey: key() }));
  const p2 = await h.initiateUpiPayment(as("b", { tripId, qrPayload: QR("10.00"), platform: "IOS", reviewConfirmed: true, idempotencyKey: key() }));
  const results = await Promise.allSettled([
    h.submitPaymentReference(as("a", { transactionId: p1.transactionId, utr: "314159265358", idempotencyKey: key() })),
    h.submitPaymentReference(as("b", { transactionId: p2.transactionId, utr: "314159265358", idempotencyKey: key() })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.details.reason, "REFERENCE_ALREADY_CLAIMED");
});

test("concurrent reconcile and cancel cannot both win", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  await h.updateMemberRole(as("a", { tripId, uid: "b", role: "ADMIN" }));
  const p = await h.initiateUpiPayment(as("a", { tripId, qrPayload: QR("50.00"), platform: "ANDROID", reviewConfirmed: true, idempotencyKey: key() }));
  await h.recordUpiClientResponse(as("a", { transactionId: p.transactionId, platform: "ANDROID", rawResponse: "Status=SUBMITTED", idempotencyKey: key() }));
  const version = (await getDoc("transactions", p.transactionId)).version;
  const results = await Promise.allSettled([
    h.cancelTransaction(as("a", { transactionId: p.transactionId })),
    h.reconcileTransaction(as("b", { transactionId: p.transactionId, decision: "CONFIRM", evidenceType: "MERCHANT_CONFIRMATION", note: "vendor confirmed", confirmedAmountMinor: 5000, expectedVersion: version })),
  ]);
  const txn = await getDoc("transactions", p.transactionId);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  if (txn.status === "CANCELLED") {
    assert.equal(results[1].reason.details.reason, "VERSION_CONFLICT");
  } else {
    assert.equal(txn.status, "CONFIRMED");
    assert.equal(results[0].reason.details.reason, "STATUS_LOCKED_BY_TRUSTED_SOURCE");
  }
  assert.equal(txn.statusHistory[txn.statusHistory.length - 1].to, txn.status);
});
