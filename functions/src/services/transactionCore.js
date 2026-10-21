"use strict";

const { COLLECTIONS } = require("../lib/constants");
const { writeAudit } = require("../lib/audit");
const { precondition } = require("../lib/errors");
const { canTransition, STATES, ACTORS } = require("../domain/paymentStates");
const { syncExpenseVerification } = require("./expenses");

const SETTLEMENT_STATUS_FOR_TXN = Object.freeze({
  [STATES.INITIATED]: "PENDING",
  [STATES.PENDING]: "PENDING",
  [STATES.AWAITING_VERIFICATION]: "PENDING",
  [STATES.CONFIRMED]: "CONFIRMED",
  [STATES.FAILED]: "FAILED",
  [STATES.CANCELLED]: "CANCELLED",
});

/**
 * Reads everything a status change may need to touch: the linked expense and,
 * for settlement payments, the settlement. Call before any write in the tx.
 */
async function loadLinked(ctx, tx, txn) {
  const { db } = ctx;
  const reads = [];
  reads.push(txn.expenseId ? tx.get(db.collection(COLLECTIONS.EXPENSES).doc(txn.expenseId)) : null);
  reads.push(txn.settlementId ? tx.get(db.collection(COLLECTIONS.SETTLEMENTS).doc(txn.settlementId)) : null);
  const [expenseSnap, settlementSnap] = await Promise.all(reads);
  return {
    expense: expenseSnap && expenseSnap.exists ? expenseSnap.data() : null,
    settlement: settlementSnap && settlementSnap.exists ? settlementSnap.data() : null,
  };
}

/**
 * The ONLY code path that changes a transaction's status. Enforces the state
 * machine, records who/what caused the change, mirrors the status onto the
 * linked expense/settlement, and writes an audit entry.
 */
function applyStatus(ctx, tx, txn, linked, to, { actor, source, actorUid = null, reason = null, extra = {} }) {
  const check = canTransition(txn, to, actor);
  if (!check.ok) {
    throw precondition(`Payment cannot move from ${txn.status} to ${to}.`, check.reason, { from: txn.status, to });
  }
  const { FieldValue, Timestamp, db } = ctx;
  const entry = { from: txn.status, to, actor, source, actorUid, reason, at: Timestamp.fromMillis(ctx.now()) };
  const update = {
    ...extra,
    status: to,
    statusSetBy: actor,
    statusSource: source,
    statusHistory: FieldValue.arrayUnion(entry),
    version: (txn.version || 1) + 1,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (actor === ACTORS.TRUSTED && (to === STATES.CONFIRMED || to === STATES.FAILED)) {
    update["verification.status"] = to === STATES.CONFIRMED ? "VERIFIED" : "REJECTED";
    update["verification.source"] = source;
    update["verification.verifiedByUid"] = actorUid;
    update["verification.verifiedAt"] = FieldValue.serverTimestamp();
  }
  tx.update(db.collection(COLLECTIONS.TRANSACTIONS).doc(txn.transactionId), update);
  writeAudit(ctx, tx, {
    tripId: txn.tripId,
    actorUid,
    actorType: actor === ACTORS.TRUSTED && !actorUid ? "SYSTEM" : "USER",
    action: "TRANSACTION_STATUS_CHANGED",
    entityType: "transaction",
    entityId: txn.transactionId,
    changes: { status: { from: txn.status, to } },
    metadata: { actor, source, reason },
  });

  if (linked.expense && linked.expense.status === "ACTIVE") {
    syncExpenseVerification(ctx, tx, linked.expense, to, { actorUid, actorType: actorUid ? "USER" : "SYSTEM" });
  }
  if (linked.settlement) {
    const sStatus = SETTLEMENT_STATUS_FOR_TXN[to];
    if (sStatus && sStatus !== linked.settlement.status) {
      const sUpdate = { status: sStatus, updatedAt: FieldValue.serverTimestamp() };
      if (sStatus === "CONFIRMED") {
        sUpdate.confirmedByUid = actorUid;
        sUpdate.confirmedAt = FieldValue.serverTimestamp();
      }
      tx.update(db.collection(COLLECTIONS.SETTLEMENTS).doc(linked.settlement.settlementId), sUpdate);
      writeAudit(ctx, tx, {
        tripId: txn.tripId, actorUid, action: "SETTLEMENT_STATUS_CHANGED", entityType: "settlement",
        entityId: linked.settlement.settlementId, changes: { status: { from: linked.settlement.status, to: sStatus } },
      });
    }
  }
  return { ...txn, status: to, statusSetBy: actor };
}

module.exports = { loadLinked, applyStatus, SETTLEMENT_STATUS_FOR_TXN };
