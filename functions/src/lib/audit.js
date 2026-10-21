"use strict";

const { COLLECTIONS, SCHEMA_VERSION } = require("./constants");

/**
 * Append-only audit entry written inside the caller's Firestore transaction,
 * so the audit record commits if and only if the change commits.
 */
function writeAudit(ctx, tx, { tripId, actorUid, actorType = "USER", action, entityType, entityId, changes, metadata }) {
  const ref = ctx.db.collection(COLLECTIONS.AUDIT_LOGS).doc();
  tx.set(ref, {
    auditId: ref.id,
    tripId: tripId || null,
    actorUid: actorUid || null,
    actorType,
    action,
    entityType,
    entityId,
    changes: changes || null,
    metadata: metadata || null,
    createdAt: ctx.FieldValue.serverTimestamp(),
    schemaVersion: SCHEMA_VERSION,
  });
  return ref.id;
}

/** Shallow diff of the listed fields, for audit `changes`. */
function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before ? before[f] : undefined;
    const b = after ? after[f] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { from: a === undefined ? null : a, to: b === undefined ? null : b };
  }
  return out;
}

module.exports = { writeAudit, diff };
