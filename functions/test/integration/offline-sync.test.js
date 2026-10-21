"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin/firestore");
const { clearFirestore, setup, key, as, rejectsWith, tripWith, getDoc, db } = require("../helpers");

test.beforeEach(clearFirestore);

/** What the app writes to expenseOps (offline it sits in the Firestore SDK's queue). */
async function writeOp({ uid, tripId, type, expenseId, payload, clientAt = Date.now(), opId = key("op") }) {
  await db.collection("expenseOps").doc(opId).set({
    opId, uid, tripId, type, expenseId, payload,
    clientCreatedAt: Timestamp.fromMillis(clientAt),
    status: "PENDING",
    schemaVersion: 1,
  });
  return opId;
}

const run = (trusted, opId, opts = {}) => trusted.processExpenseOp(opId, { claimId: `evt-${opId}`, ...opts });

test("an offline create is applied with the app's id, the device time and an OFFLINE_SYNC audit entry", async () => {
  const { h, trusted } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const madeAt = Date.UTC(2026, 9, 20, 9, 30);
  const opId = await writeOp({ uid: "a", tripId, type: "CREATE_EXPENSE", expenseId: "exp-offline-1", clientAt: madeAt,
    payload: { title: "Chai at Spiti", amountMinor: 6000, participantUids: ["a", "b"] } });

  assert.equal((await run(trusted, opId)).status, "APPLIED");
  const op = await getDoc("expenseOps", opId);
  assert.equal(op.status, "APPLIED");
  assert.equal(op.tripName, "Trip of a");
  assert.equal(op.result.expenseId, "exp-offline-1");
  const expense = await getDoc("expenses", "exp-offline-1");
  assert.equal(expense.expenseDate.toMillis(), madeAt);
  assert.deepEqual(expense.shares, { a: 3000, b: 3000 });
  const audit = await db.collection("auditLogs").where("entityId", "==", "exp-offline-1").get();
  assert.equal(audit.docs[0].data().metadata.source, "OFFLINE_SYNC");
  assert.equal(audit.docs[0].data().metadata.clientAt, new Date(madeAt).toISOString());

  // A duplicate delivery of the same event, or a new event for the same op, changes nothing.
  assert.equal((await run(trusted, opId)).skipped, true);
  assert.equal((await db.collection("expenses").where("tripId", "==", tripId).get()).size, 1);
});

test("edits that sync before their create wait for it, then apply in order", async () => {
  const { h, trusted } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const t0 = Date.UTC(2026, 9, 20, 9, 0);
  const createId = await writeOp({ uid: "a", tripId, type: "CREATE_EXPENSE", expenseId: "exp-2", clientAt: t0,
    payload: { title: "Taxi", amountMinor: 50000, participantUids: ["a", "b"] } });
  const edit1 = await writeOp({ uid: "a", tripId, type: "UPDATE_EXPENSE", expenseId: "exp-2", clientAt: t0 + 1000,
    payload: { expectedVersion: 1, title: "Taxi to Manali" } });
  // The app only ever saw version 1, so the second offline edit also says expectedVersion 1.
  const edit2 = await writeOp({ uid: "a", tripId, type: "UPDATE_EXPENSE", expenseId: "exp-2", clientAt: t0 + 2000,
    payload: { expectedVersion: 1, amountMinor: 60000 } });

  assert.equal((await run(trusted, edit2)).status, "DEFERRED");
  assert.equal((await run(trusted, edit1)).status, "DEFERRED");
  assert.equal((await run(trusted, createId)).status, "APPLIED");

  assert.equal((await getDoc("expenseOps", edit1)).status, "APPLIED");
  assert.equal((await getDoc("expenseOps", edit2)).status, "APPLIED");
  const expense = await getDoc("expenses", "exp-2");
  assert.equal(expense.title, "Taxi to Manali");
  assert.equal(expense.amountMinor, 60000);
  assert.equal(expense.version, 3);
});

test("an offline edit that crosses someone else's change is rejected as a conflict, not overwritten", async () => {
  const { h, trusted } = setup();
  const tripId = await tripWith(h, "owner", ["m1"]);
  const { expenseId } = await h.createExpense(as("m1", { tripId, title: "Dinner", amountMinor: 80000, participantUids: ["owner", "m1"], idempotencyKey: key() }));
  await h.updateExpense(as("owner", { tripId, expenseId, expectedVersion: 1, title: "Dinner (owner's fix)" }));

  const opId = await writeOp({ uid: "m1", tripId, type: "UPDATE_EXPENSE", expenseId, payload: { expectedVersion: 1, title: "Dinner at Tibet Kitchen" } });
  assert.equal((await run(trusted, opId)).status, "REJECTED");
  const op = await getDoc("expenseOps", opId);
  assert.equal(op.error.reason, "VERSION_CONFLICT");
  assert.equal((await getDoc("expenses", expenseId)).title, "Dinner (owner's fix)");
});

test("offline voids go through the same rules as the callable", async () => {
  const { h, trusted } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const { expenseId } = await h.createExpense(as("a", { tripId, title: "Snacks", amountMinor: 3000, participantUids: ["a", "b"], idempotencyKey: key() }));
  const byOther = await writeOp({ uid: "b", tripId, type: "VOID_EXPENSE", expenseId, payload: { expectedVersion: 1, reason: "duplicate" } });
  assert.equal((await run(trusted, byOther)).status, "REJECTED");
  assert.equal((await getDoc("expenseOps", byOther)).error.reason, "CANNOT_EDIT_EXPENSE");
  const byCreator = await writeOp({ uid: "a", tripId, type: "VOID_EXPENSE", expenseId, payload: { expectedVersion: 1, reason: "duplicate" } });
  assert.equal((await run(trusted, byCreator)).status, "APPLIED");
  assert.equal((await getDoc("expenses", expenseId)).status, "VOIDED");
});

test("malformed, foreign and non-member ops are rejected and recorded", async () => {
  const { h, trusted } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const base = { tripId, type: "CREATE_EXPENSE", payload: { title: "x", amountMinor: 100, participantUids: ["a"] } };

  const outsider = await writeOp({ ...base, uid: "mallory", expenseId: "e-1" });
  await run(trusted, outsider);
  assert.equal((await getDoc("expenseOps", outsider)).error.reason, "NOT_A_MEMBER");

  const spoofed = await writeOp({ ...base, uid: "a", expenseId: "e-2" });
  await run(trusted, spoofed, { auth: { type: "unknown", id: "b" } });
  assert.equal((await getDoc("expenseOps", spoofed)).error.reason, "UID_MISMATCH");
  assert.equal(await getDoc("expenses", "e-2"), null);

  const sneaky = await writeOp({ ...base, uid: "a", expenseId: "e-3", payload: { ...base.payload, tripId: "other" } });
  await run(trusted, sneaky);
  assert.equal((await getDoc("expenseOps", sneaky)).error.reason, "INVALID_OP");

  const badType = await writeOp({ ...base, uid: "a", expenseId: "e-4", type: "DELETE_EVERYTHING" });
  await run(trusted, badType);
  assert.equal((await getDoc("expenseOps", badType)).status, "REJECTED");
});

test("a rejected create also rejects the edits waiting on it", async () => {
  const { h, trusted } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const createId = await writeOp({ uid: "a", tripId, type: "CREATE_EXPENSE", expenseId: "exp-x", payload: { title: "Bad", amountMinor: 100, participantUids: ["a", "stranger"] } });
  const editId = await writeOp({ uid: "a", tripId, type: "UPDATE_EXPENSE", expenseId: "exp-x", payload: { expectedVersion: 1, title: "Still bad" } });
  assert.equal((await run(trusted, editId)).status, "DEFERRED");
  assert.equal((await run(trusted, createId)).status, "REJECTED");
  assert.equal((await getDoc("expenseOps", editId)).error.reason, "CREATE_REJECTED");
});

test("listSyncLog shows the user's offline changes with their trip, newest first", async () => {
  const { h, trusted } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  const first = await writeOp({ uid: "a", tripId, type: "CREATE_EXPENSE", expenseId: "l-1", clientAt: Date.UTC(2026, 9, 1), payload: { title: "Fuel", amountMinor: 200000, participantUids: ["a", "b"] } });
  const second = await writeOp({ uid: "a", tripId, type: "CREATE_EXPENSE", expenseId: "l-2", clientAt: Date.UTC(2026, 9, 2), payload: { title: "Momos", amountMinor: 24000, participantUids: ["a", "b"] } });
  await run(trusted, first);
  await run(trusted, second);
  await writeOp({ uid: "b", tripId, type: "CREATE_EXPENSE", expenseId: "l-3", payload: { title: "Not mine", amountMinor: 100, participantUids: ["b"] } });

  const { entries } = await h.listSyncLog(as("a", { tripId }));
  assert.deepEqual(entries.map((e) => e.title), ["Momos", "Fuel"]);
  assert.ok(entries.every((e) => e.tripName === "Trip of a" && e.status === "APPLIED" && e.payload === undefined));
  assert.equal(entries[0].clientCreatedAt, "2026-10-02T00:00:00.000Z");
  await rejectsWith(h.listSyncLog({ auth: null, data: {} }), "unauthenticated");
});

test("createExpense accepts a client-generated expenseId and refuses one that is taken", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "a", ["b"]);
  await h.createExpense(as("a", { tripId, expenseId: "mine-1", title: "Bus", amountMinor: 1000, participantUids: ["a"], idempotencyKey: key() }));
  assert.ok(await getDoc("expenses", "mine-1"));
  await rejectsWith(h.createExpense(as("b", { tripId, expenseId: "mine-1", title: "Bus", amountMinor: 1000, participantUids: ["b"], idempotencyKey: key() })), "failed-precondition", "EXPENSE_ID_TAKEN");
});
