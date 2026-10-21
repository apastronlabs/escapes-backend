"use strict";

const { COLLECTIONS, SCHEMA_VERSION, LIMITS } = require("../lib/constants");
const v = require("../lib/validate");
const { requireAuth, loadMemberContext } = require("../lib/access");
const { runIdempotent } = require("../lib/idempotency");
const { writeAudit } = require("../lib/audit");
const { invalid, notFound, precondition } = require("../lib/errors");

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

/**
 * Receipts are uploaded by the app to Cloud Storage at
 *   receipts/{tripId}/{uid}/{fileName}
 * and then registered here. Only the storage path is stored, never a
 * download URL; members get a short-lived signed URL on request.
 */
function makeReceiptService(ctx) {
  const { db, FieldValue } = ctx;

  function requireBucket() {
    if (!ctx.bucket) throw precondition("Cloud Storage is not configured for this project.", "STORAGE_NOT_CONFIGURED");
    return ctx.bucket;
  }

  async function registerReceipt(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "storagePath", "idempotencyKey"]);
    const tripId = v.id(data, "tripId");
    const storagePath = v.string(data, "storagePath", { max: 300 });
    const key = v.idempotencyKey(data);
    const m = /^receipts\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9._-]{1,100})$/.exec(storagePath);
    if (!m || m[1] !== tripId || m[2] !== uid || storagePath.includes("..")) {
      throw invalid("storagePath must be receipts/{tripId}/{yourUid}/{fileName}.", "INVALID_STORAGE_PATH");
    }
    // Server-side metadata check (outside the Firestore transaction; it's a network call).
    await loadMemberContext(ctx, null, tripId, uid);
    let meta;
    try {
      [meta] = await requireBucket().file(storagePath).getMetadata();
    } catch (e) {
      if (e.details && e.details.reason) throw e;
      throw notFound("Uploaded file not found.", "RECEIPT_FILE_NOT_FOUND");
    }
    const size = Number(meta.size);
    if (!ALLOWED_TYPES.includes(meta.contentType)) throw invalid("Unsupported receipt file type.", "UNSUPPORTED_RECEIPT_TYPE");
    if (!Number.isFinite(size) || size <= 0 || size > LIMITS.MAX_RECEIPT_BYTES) throw invalid("Receipt file is empty or too large.", "RECEIPT_TOO_LARGE");

    return runIdempotent(ctx, { uid, operation: "registerReceipt", key, payload: { tripId, storagePath } }, async (tx) => {
      await loadMemberContext(ctx, tx, tripId, uid);
      const ref = db.collection(COLLECTIONS.RECEIPTS).doc();
      tx.set(ref, {
        receiptId: ref.id, tripId, uploadedByUid: uid, storagePath, contentType: meta.contentType, sizeBytes: size,
        md5Hash: meta.md5Hash || null, createdAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
      });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "RECEIPT_REGISTERED", entityType: "receipt", entityId: ref.id });
      return { receiptId: ref.id };
    });
  }

  async function getReceiptUrl(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const receiptId = v.id(data, "receiptId");
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    const snap = await db.collection(COLLECTIONS.RECEIPTS).doc(receiptId).get();
    if (!snap.exists || snap.data().tripId !== tripId) throw notFound("Receipt not found.", "RECEIPT_NOT_FOUND");
    const expires = ctx.now() + ctx.config.receiptUrlTtlSeconds * 1000;
    // Requires the runtime service account to have iam.serviceAccounts.signBlob.
    const [url] = await requireBucket().file(snap.data().storagePath).getSignedUrl({ version: "v4", action: "read", expires });
    return { url, expiresAt: new Date(expires).toISOString() };
  }

  return { registerReceipt, getReceiptUrl };
}

module.exports = { makeReceiptService };
