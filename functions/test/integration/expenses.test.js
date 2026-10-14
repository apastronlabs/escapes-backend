"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clearFirestore, setup, key, as, rejectsWith, tripWith, getDoc, db } = require("../helpers");

test.beforeEach(clearFirestore);

test("equal split with paise remainder; split docs written per participant", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b", "c"]);
  const r = await h.createExpense(as("a", { tripId, title: "Dinner at Thalassa", merchantName: "Thalassa Restaurant", amountMinor: 100000, participantUids: ["c", "b", "a"], idempotencyKey: key() }));
  assert.deepEqual(r.shares, { a: 33334, b: 33333, c: 33333 });
  assert.equal(r.verificationStatus, "MEMBER_REPORTED");
  assert.equal(r.categoryId, `${tripId}_food`);
  const splits = await db.collection("expenseSplits").where("expenseId", "==", r.expenseId).get();
  assert.equal(splits.size, 3);
  assert.equal(splits.docs.reduce((s, d) => s + d.data().shareMinor, 0), 100000);
});

test("percentage and custom amount splits", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b", "c"]);
  const p = await h.createExpense(as("a", { tripId, title: "Villa", amountMinor: 1000001, participantUids: ["a", "b", "c"], split: { type: "PERCENTAGE", values: { a: 5000, b: 2500, c: 2500 } }, idempotencyKey: key() }));
  assert.equal(Object.values(p.shares).reduce((s, x) => s + x, 0), 1000001);
  assert.equal(p.categoryId, `${tripId}_accommodation`);
  const amt = await h.createExpense(as("b", { tripId, title: "Snacks", amountMinor: 900, participantUids: ["a", "b"], split: { type: "AMOUNT", values: { a: 600, b: 300 } }, idempotencyKey: key() }));
  assert.deepEqual(amt.shares, { a: 600, b: 300 });
  await rejectsWith(h.createExpense(as("b", { tripId, title: "Bad", amountMinor: 900, participantUids: ["a", "b"], split: { type: "AMOUNT", values: { a: 600, b: 200 } }, idempotencyKey: key() })), "invalid-argument", "SHARE_TOTAL_MISMATCH");
  await rejectsWith(h.createExpense(as("b", { tripId, title: "Bad", amountMinor: 900, participantUids: ["a", "b"], split: { type: "PERCENTAGE", values: { a: 6000, b: 3000 } }, idempotencyKey: key() })), "invalid-argument", "PERCENTAGE_TOTAL_MISMATCH");
  await rejectsWith(h.createExpense(as("b", { tripId, title: "Bad", amountMinor: 12.5, participantUids: ["a"], idempotencyKey: key() })), "invalid-argument");
});

test("payer attribution: members cannot assign a payment to someone else", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "owner", ["m1", "m2"]);
  await rejectsWith(h.createExpense(as("m1", { tripId, title: "Taxi", amountMinor: 50000, paidByUid: "m2", participantUids: ["m1", "m2"], idempotencyKey: key() })), "permission-denied", "CANNOT_ASSIGN_PAYER");
  const ok = await h.createExpense(as("owner", { tripId, title: "Taxi", amountMinor: 50000, paidByUid: "m2", participantUids: ["m1", "m2"], idempotencyKey: key() }));
  assert.ok(ok.expenseId);
  const e = await h.createExpense(as("m1", { tripId, title: "Tea", amountMinor: 4000, participantUids: ["m1", "m2"], idempotencyKey: key() }));
  await rejectsWith(h.updateExpense(as("m1", { tripId, expenseId: e.expenseId, expectedVersion: 1, paidByUid: "m2" })), "permission-denied", "CANNOT_ASSIGN_PAYER");
  // m2 is a participant but neither creator, payer nor admin.
  await rejectsWith(h.updateExpense(as("m2", { tripId, expenseId: e.expenseId, expectedVersion: 1, title: "x" })), "permission-denied", "CANNOT_EDIT_EXPENSE");
});

test("participants must be active members of the same trip", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  await tripWith(h, "z", ["y"]);
  await rejectsWith(h.createExpense(as("a", { tripId, title: "x", amountMinor: 100, participantUids: ["a", "y"], idempotencyKey: key() })), "permission-denied", "NOT_A_TRIP_MEMBER");
  await h.removeMember(as("a", { tripId, uid: "b" }));
  await rejectsWith(h.createExpense(as("a", { tripId, title: "x", amountMinor: 100, participantUids: ["a", "b"], idempotencyKey: key() })), "permission-denied", "NOT_A_TRIP_MEMBER");
});

test("rename, recategorize and change participants without changing the amount paid", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b", "c"]);
  const e = await h.createExpense(as("a", { tripId, title: "Lunch", amountMinor: 90000, participantUids: ["a", "b", "c"], idempotencyKey: key() }));
  const u1 = await h.updateExpense(as("a", { tripId, expenseId: e.expenseId, expectedVersion: 1, title: "Lunch at Britto's", categoryId: `${tripId}_drinks` }));
  assert.equal(u1.version, 2);
  const u2 = await h.updateExpense(as("a", { tripId, expenseId: e.expenseId, expectedVersion: 2, participantUids: ["a", "b"] }));
  assert.deepEqual(u2.shares, { a: 45000, b: 45000 });
  const doc = await getDoc("expenses", e.expenseId);
  assert.equal(doc.amountMinor, 90000);
  assert.equal(doc.paidByUid, "a");
  assert.equal(doc.title, "Lunch at Britto's");
  assert.equal(doc.categorySource, "MANUAL");
  const removed = await getDoc("expenseSplits", `${e.expenseId}_c`);
  assert.equal(removed.status, "REMOVED");
  assert.equal(removed.shareMinor, 0);
  const u3 = await h.updateExpense(as("a", { tripId, expenseId: e.expenseId, expectedVersion: 3, participantUids: ["a", "b", "c"], split: { type: "AMOUNT", values: { a: 10000, b: 30000, c: 50000 } } }));
  assert.deepEqual(u3.shares, { a: 10000, b: 30000, c: 50000 });
  await rejectsWith(h.updateExpense(as("a", { tripId, expenseId: e.expenseId, expectedVersion: 4, participantUids: ["a", "b"] })), "invalid-argument", "SPLIT_REQUIRED");
  const { entries } = await h.listAuditLogs(as("b", { tripId, entityId: e.expenseId }));
  assert.equal(entries.filter((x) => x.action === "EXPENSE_UPDATED").length, 3);
});

test("stale edits are rejected (optimistic concurrency)", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const e = await h.createExpense(as("a", { tripId, title: "Fuel", amountMinor: 300000, participantUids: ["a", "b"], idempotencyKey: key() }));
  const results = await Promise.allSettled([
    h.updateExpense(as("a", { tripId, expenseId: e.expenseId, expectedVersion: 1, title: "Fuel - day 1" })),
    h.updateExpense(as("a", { tripId, expenseId: e.expenseId, expectedVersion: 1, participantUids: ["a"] })),
    h.updateExpense(as("a", { tripId, expenseId: e.expenseId, expectedVersion: 1, notes: "full tank" })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((x) => x.status === "rejected")) assert.equal(r.reason.details.reason, "VERSION_CONFLICT");
  assert.equal((await getDoc("expenses", e.expenseId)).version, 2);
});

test("void unconfirmed expense; manual review confirms cash expense; confirmed cannot be voided", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "owner", ["m"], { admins: ["adm"] });
  const e1 = await h.createExpense(as("m", { tripId, title: "Auto", amountMinor: 15000, participantUids: ["m", "owner"], idempotencyKey: key() }));
  await h.voidExpense(as("m", { tripId, expenseId: e1.expenseId, expectedVersion: 1, reason: "duplicate" }));
  assert.equal((await getDoc("expenses", e1.expenseId)).status, "VOIDED");
  assert.equal((await getDoc("expenseSplits", `${e1.expenseId}_m`)).status, "VOIDED");

  const e2 = await h.createExpense(as("adm", { tripId, title: "Cash dinner", amountMinor: 60000, participantUids: ["m", "owner", "adm"], idempotencyKey: key() }));
  await rejectsWith(h.reviewExpense(as("adm", { tripId, expenseId: e2.expenseId, expectedVersion: 1, note: "self" })), "permission-denied", "SELF_REVIEW_NOT_ALLOWED");
  await rejectsWith(h.reviewExpense(as("m", { tripId, expenseId: e2.expenseId, expectedVersion: 1, note: "not admin" })), "permission-denied", "INSUFFICIENT_ROLE");
  await h.reviewExpense(as("owner", { tripId, expenseId: e2.expenseId, expectedVersion: 1, note: "Saw the bill" }));
  const reviewed = await getDoc("expenses", e2.expenseId);
  assert.equal(reviewed.verificationStatus, "CONFIRMED");
  assert.equal(reviewed.verificationSource, "MANUAL_REVIEW");
  await rejectsWith(h.voidExpense(as("adm", { tripId, expenseId: e2.expenseId, expectedVersion: 2, reason: "oops" })), "failed-precondition", "CONFIRMED_IMMUTABLE");
  await rejectsWith(h.updateExpense(as("adm", { tripId, expenseId: e2.expenseId, expectedVersion: 2, amountMinor: 1 })), "failed-precondition", "AMOUNT_IMMUTABLE");
});

test("summary separates confirmed and provisional balances; removed members keep their balance", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b", "c"]);
  const e = await h.createExpense(as("a", { tripId, title: "Houseboat", amountMinor: 900000, participantUids: ["a", "b", "c"], idempotencyKey: key() }));
  await h.removeMember(as("a", { tripId, uid: "c" }));
  let s = await h.getTripSummary(as("b", { tripId }));
  assert.equal(s.totals.confirmedSpendMinor, 0);
  assert.equal(s.totals.provisionalSpendMinor, 900000);
  const cBal = s.provisional.balances.find((x) => x.uid === "c");
  assert.equal(cBal.netMinor, -300000);
  assert.equal(cBal.membershipStatus, "REMOVED");
  assert.deepEqual(s.provisional.suggestions, [
    { fromUid: "b", toUid: "a", amountMinor: 300000 },
    { fromUid: "c", toUid: "a", amountMinor: 300000 },
  ]);
  assert.equal(s.provisional.outstandingMinor, 600000);
  assert.deepEqual(s.confirmed.suggestions, []);

  // 'a' is the payer, so the review must come from another admin.
  await rejectsWith(h.reviewExpense(as("a", { tripId, expenseId: e.expenseId, expectedVersion: 1, note: "x" })), "permission-denied", "SELF_REVIEW_NOT_ALLOWED");
  await h.updateMemberRole(as("a", { tripId, uid: "b", role: "ADMIN" }));
  await h.reviewExpense(as("b", { tripId, expenseId: e.expenseId, expectedVersion: 1, note: "seen" }));
  s = await h.getTripSummary(as("b", { tripId }));
  assert.equal(s.totals.confirmedSpendMinor, 900000);

  // cash settlement: provisional until the receiver confirms
  const st = await h.recordSettlement(as("b", { tripId, toUid: "a", amountMinor: 300000, method: "CASH", idempotencyKey: key() }));
  s = await h.getTripSummary(as("b", { tripId }));
  assert.equal(s.provisional.balances.find((x) => x.uid === "b").netMinor, 0);
  assert.equal(s.confirmed.balances.find((x) => x.uid === "b").netMinor, -300000);
  await rejectsWith(h.confirmSettlement(as("b", { tripId, settlementId: st.settlementId })), "permission-denied", "NOT_SETTLEMENT_PARTY");
  await h.confirmSettlement(as("a", { tripId, settlementId: st.settlementId }));
  s = await h.getTripSummary(as("b", { tripId }));
  assert.equal(s.confirmed.balances.find((x) => x.uid === "b").netMinor, 0);
  assert.deepEqual(s.confirmed.suggestions, [{ fromUid: "c", toUid: "a", amountMinor: 300000 }]);
});

test("expenseDate is a timestamp: epoch ms or ISO string, defaulting to when it was recorded", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const when = Date.UTC(2026, 9, 14, 19, 15, 31);
  const r1 = await h.createExpense(as("a", { tripId, title: "Lunch", amountMinor: 1000, participantUids: ["a", "b"], expenseDate: when, idempotencyKey: key() }));
  assert.equal((await getDoc("expenses", r1.expenseId)).expenseDate.toMillis(), when);
  const r2 = await h.createExpense(as("a", { tripId, title: "Dinner", amountMinor: 1000, participantUids: ["a", "b"], expenseDate: "2026-10-14T19:15:31+05:30", idempotencyKey: key() }));
  assert.equal((await h.getExpense(as("a", { tripId, expenseId: r2.expenseId }))).expense.expenseDate, "2026-10-14T13:45:31.000Z");
  const before = Date.now();
  const r3 = await h.createExpense(as("a", { tripId, title: "Tea", amountMinor: 1000, participantUids: ["a", "b"], idempotencyKey: key() }));
  assert.ok((await getDoc("expenses", r3.expenseId)).expenseDate.toMillis() >= before - 1000);
  await h.updateExpense(as("a", { tripId, expenseId: r3.expenseId, expectedVersion: 1, expenseDate: when }));
  assert.equal((await getDoc("expenses", r3.expenseId)).expenseDate.toMillis(), when);
  await rejectsWith(h.createExpense(as("a", { tripId, title: "Bad", amountMinor: 1000, participantUids: ["a"], expenseDate: 1791978951, idempotencyKey: key() })), "invalid-argument", "INVALID_FIELD");
  await rejectsWith(h.createExpense(as("a", { tripId, title: "Bad", amountMinor: 1000, participantUids: ["a"], expenseDate: "14/10/2026", idempotencyKey: key() })), "invalid-argument", "INVALID_FIELD");
});
