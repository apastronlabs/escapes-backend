"use strict";

const { COLLECTIONS } = require("../lib/constants");
const { HttpsError } = require("../lib/errors");
const v = require("../lib/validate");
const { toJson } = require("../lib/serialize");

/**
 * Offline sync queue for expenses.
 *
 * While offline, the app can't call functions, but the Firestore SDK queues writes and
 * sends them when the device reconnects. So the app records each change as a document in
 * `expenseOps/{opId}` (status PENDING), and the `processExpenseOp` trigger applies it
 * through the same handlers the callables use, with the same validation and permissions.
 * The op document doubles as the user's sync log: it keeps the trip, what was changed,
 * when it was made on the device, and whether it was applied or rejected (and why).
 *
 * Statuses:
 *   PENDING   written by the app; not processed yet (also how it looks offline)
 *   DEFERRED  an edit of an expense whose offline create hasn't been applied yet; it is
 *             applied right after that create
 *   APPLIED   done; `result` holds the handler's response
 *   REJECTED  the change was refused; `error.reason` says why (e.g. VERSION_CONFLICT)
 *   FAILED    an unexpected error persisted past the retry window; safe to recreate
 */

const OP_TYPES = Object.freeze({
  CREATE_EXPENSE: "CREATE_EXPENSE",
  UPDATE_EXPENSE: "UPDATE_EXPENSE",
  VOID_EXPENSE: "VOID_EXPENSE",
});
const OP_STATUS = Object.freeze({
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  DEFERRED: "DEFERRED",
  APPLIED: "APPLIED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
});
// Fields the app writes when it creates an op, and fields this service adds while processing.
const OP_FIELDS = ["opId", "uid", "tripId", "type", "expenseId", "payload", "clientCreatedAt", "status", "createdAt", "schemaVersion"];
const SERVER_FIELDS = ["claimId", "attempts", "result", "error", "tripName", "processedAt", "updatedAt"];
// Unexpected errors (contention, timeouts) are retried by the trigger for this long.
const RETRY_WINDOW_MS = 30 * 60 * 1000;

class RetryableError extends Error {}

function makeSyncService(ctx, handlers) {
  const { db, FieldValue } = ctx;
  const ops = () => db.collection(COLLECTIONS.EXPENSE_OPS);

  /** Checks the op document's shape. Throws HttpsError (→ REJECTED) on anything malformed. */
  function parseOp(opId, doc) {
    v.onlyKeys(doc, [...OP_FIELDS, ...SERVER_FIELDS]);
    if (doc.opId !== opId) throw new HttpsError("invalid-argument", "opId must equal the document id.", { reason: "INVALID_OP" });
    const op = {
      opId,
      uid: v.id(doc, "uid"),
      tripId: v.id(doc, "tripId"),
      type: v.oneOf(doc, "type", Object.values(OP_TYPES)),
      expenseId: v.id(doc, "expenseId"),
      clientAt: v.timestampMillis(doc, "clientCreatedAt", { required: true }),
      payload: v.requireObject(doc.payload, "payload"),
    };
    for (const key of ["tripId", "expenseId", "idempotencyKey"]) {
      if (op.payload[key] !== undefined) throw new HttpsError("invalid-argument", `payload.${key} is set by the op itself.`, { reason: "INVALID_OP", field: `payload.${key}` });
    }
    return op;
  }

  /** Builds the callable-shaped request for the op; the server sets tripId, expenseId and keys. */
  function requestFor(op) {
    const data = { ...op.payload, tripId: op.tripId, expenseId: op.expenseId };
    if (op.type === OP_TYPES.CREATE_EXPENSE) data.idempotencyKey = op.opId;
    return { auth: { uid: op.uid, token: {} }, data, sync: { opId: op.opId, clientAt: op.clientAt } };
  }

  async function apply(op) {
    const request = requestFor(op);
    if (op.type === OP_TYPES.CREATE_EXPENSE) return handlers.createExpense(request);
    if (op.type === OP_TYPES.UPDATE_EXPENSE) return handlers.updateExpense(request);
    return handlers.voidExpense(request);
  }

  /** An edit whose expense doesn't exist yet waits if this user's create for it is still queued. */
  async function hasQueuedCreate(op) {
    const snap = await ops()
      .where("uid", "==", op.uid)
      .where("expenseId", "==", op.expenseId)
      .where("type", "==", OP_TYPES.CREATE_EXPENSE)
      .where("status", "in", [OP_STATUS.PENDING, OP_STATUS.PROCESSING])
      .limit(1)
      .get();
    return !snap.empty;
  }

  async function tripName(tripId) {
    const snap = await db.collection(COLLECTIONS.TRIPS).doc(tripId).get();
    return snap.exists ? snap.data().name || null : null;
  }

  /**
   * Claims the op so concurrent or duplicate trigger deliveries don't both run it.
   * `claimId` is the trigger's event id (stable across retries of the same event).
   */
  async function claim(opId, claimId, allowStatuses) {
    return db.runTransaction(async (tx) => {
      const ref = ops().doc(opId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const doc = snap.data();
      const reclaim = doc.status === OP_STATUS.PROCESSING && doc.claimId === claimId;
      if (!allowStatuses.includes(doc.status) && !reclaim) return null;
      tx.update(ref, { status: OP_STATUS.PROCESSING, claimId, attempts: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      return doc;
    });
  }

  async function finish(opId, fields) {
    await ops().doc(opId).update({ ...fields, processedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  }

  /**
   * Processes one op. `auth` is who Firestore says wrote the document ({type, id}); app users
   * show up as type "unknown" with their uid as id. The Security Rules are the primary
   * control (they must require `uid == request.auth.uid` on create); this is a second check.
   */
  async function processOp(opId, { claimId, auth = null, eventTime = Date.now(), allowStatuses = [OP_STATUS.PENDING] } = {}) {
    const raw = await claim(opId, claimId, allowStatuses);
    if (!raw) return { skipped: true };

    let op;
    try {
      op = parseOp(opId, raw);
      if (auth && auth.type === "unauthenticated") {
        throw new HttpsError("unauthenticated", "The op was written without signing in.", { reason: "UNAUTHENTICATED" });
      }
      if (auth && auth.type === "unknown" && auth.id && auth.id !== op.uid) {
        throw new HttpsError("permission-denied", "The op was written by a different user.", { reason: "UID_MISMATCH" });
      }
    } catch (err) {
      await finish(opId, rejection(err));
      return { status: OP_STATUS.REJECTED };
    }

    const name = await tripName(op.tripId).catch(() => null);
    try {
      const result = await apply(op);
      await finish(opId, { status: OP_STATUS.APPLIED, result: JSON.parse(JSON.stringify(result)), error: null, tripName: name });
      if (op.type === OP_TYPES.CREATE_EXPENSE) await processDeferred(op);
      return { status: OP_STATUS.APPLIED };
    } catch (err) {
      const reason = err instanceof HttpsError && err.details && err.details.reason;
      if (reason === "EXPENSE_NOT_FOUND" && op.type !== OP_TYPES.CREATE_EXPENSE && (await hasQueuedCreate(op))) {
        await finish(opId, { status: OP_STATUS.DEFERRED, tripName: name });
        // The create may have finished (and drained its waiting edits) in the meantime.
        const exists = (await db.collection(COLLECTIONS.EXPENSES).doc(op.expenseId).get()).exists;
        if (exists) return processOp(opId, { claimId: `${claimId}:recheck`, allowStatuses: [OP_STATUS.DEFERRED] });
        return { status: OP_STATUS.DEFERRED };
      }
      if (err instanceof HttpsError) {
        await finish(opId, { ...rejection(err), tripName: name });
        if (op.type === OP_TYPES.CREATE_EXPENSE) await rejectDeferred(op);
        return { status: OP_STATUS.REJECTED };
      }
      if (Date.now() - eventTime < RETRY_WINDOW_MS) {
        // Leave it PROCESSING under this claim so the trigger's retry can pick it up again.
        throw new RetryableError(`processing ${opId} failed: ${err && err.message}`);
      }
      await finish(opId, { status: OP_STATUS.FAILED, error: { code: "internal", reason: "UNEXPECTED_ERROR", message: "Could not apply this change. Please try again." }, tripName: name });
      return { status: OP_STATUS.FAILED };
    }
  }

  /** After an offline create is applied, apply this user's edits of it that were waiting, in order. */
  async function processDeferred(createOp) {
    for (const doc of (await deferredOps(createOp)).docs) {
      await processOp(doc.id, { claimId: `deferred:${createOp.opId}`, allowStatuses: [OP_STATUS.DEFERRED] });
    }
  }

  /** If an offline create is rejected, the edits waiting on it can never apply. */
  async function rejectDeferred(createOp) {
    for (const doc of (await deferredOps(createOp)).docs) {
      await finish(doc.id, {
        status: OP_STATUS.REJECTED,
        error: { code: "failed-precondition", reason: "CREATE_REJECTED", message: "The expense this change edits was not saved." },
      });
    }
  }

  function deferredOps(createOp) {
    return ops()
      .where("uid", "==", createOp.uid)
      .where("expenseId", "==", createOp.expenseId)
      .where("status", "==", OP_STATUS.DEFERRED)
      .orderBy("clientCreatedAt", "asc")
      .get();
  }

  /** Callable: the signed-in user's sync log, newest first (optionally for one trip). */
  async function listSyncLog(request) {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const data = v.requireObject(request.data || {});
    v.onlyKeys(data, ["tripId", "pageSize"]);
    const tripId = v.id(data, "tripId", { required: false });
    const pageSize = v.pageSize(data, 50, 100);
    let q = ops().where("uid", "==", uid);
    if (tripId) q = q.where("tripId", "==", tripId);
    const snap = await q.orderBy("clientCreatedAt", "desc").limit(pageSize).get();
    return {
      entries: snap.docs.map((d) => {
        const { payload, claimId, ...rest } = d.data();
        return toJson({ ...rest, title: payload && payload.title ? payload.title : null });
      }),
    };
  }

  return { processOp, listSyncLog };
}

function rejection(err) {
  const isHttps = err instanceof HttpsError;
  return {
    status: OP_STATUS.REJECTED,
    error: {
      code: isHttps ? err.code : "internal",
      reason: (isHttps && err.details && err.details.reason) || "INVALID_OP",
      message: isHttps ? err.message : "Invalid change.",
    },
  };
}

module.exports = { makeSyncService, OP_TYPES, OP_STATUS, RetryableError };
