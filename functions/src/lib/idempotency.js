"use strict";

const { COLLECTIONS, SCHEMA_VERSION } = require("./constants");
const { sha256Hex, stableStringify } = require("./hash");
const { conflict } = require("./errors");

/**
 * Runs `fn(tx)` inside a Firestore transaction guarded by an idempotency key.
 *
 *  - First call: fn runs, its (JSON-serializable) result is stored with the key.
 *  - Retry with the same key and same payload: the stored result is returned,
 *    nothing is written again. Concurrent duplicates serialize on the key
 *    document, so only one of them ever commits.
 *  - Same key with a different payload: rejected with already-exists.
 *
 * Keys are scoped per user and per operation. `fn` must do all of its reads
 * before any write (a Firestore transaction rule); the key document is written last.
 */
async function runIdempotent(ctx, { uid, operation, key, payload }, fn) {
  const docId = sha256Hex(`${uid}:${operation}:${key}`);
  const requestHash = sha256Hex(stableStringify(payload));
  const ref = ctx.db.collection(COLLECTIONS.IDEMPOTENCY_KEYS).doc(docId);

  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const stored = snap.data();
      if (stored.requestHash !== requestHash) {
        throw conflict("This idempotency key was already used for a different request.", "IDEMPOTENCY_KEY_REUSED");
      }
      return { ...stored.result, idempotentReplay: true };
    }
    const result = await fn(tx);
    tx.set(ref, {
      uid,
      operation,
      requestHash,
      result,
      createdAt: ctx.FieldValue.serverTimestamp(),
      // Optional: configure a Firestore TTL policy on this field to purge old keys.
      expireAt: ctx.Timestamp.fromMillis(ctx.now() + 30 * 24 * 3600 * 1000),
      schemaVersion: SCHEMA_VERSION,
    });
    return result;
  });
}

module.exports = { runIdempotent };
