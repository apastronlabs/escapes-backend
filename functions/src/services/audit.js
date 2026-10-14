"use strict";

const { COLLECTIONS, LIMITS } = require("../lib/constants");
const v = require("../lib/validate");
const { requireAuth, loadMemberContext } = require("../lib/access");
const { toJson, encodeCursor, decodeCursor } = require("../lib/serialize");

function makeAuditService(ctx) {
  async function listAuditLogs(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const entityId = v.id(data, "entityId", { required: false });
    const size = v.pageSize(data, LIMITS.DEFAULT_PAGE_SIZE, LIMITS.MAX_PAGE_SIZE);
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    let q = ctx.db.collection(COLLECTIONS.AUDIT_LOGS).where("tripId", "==", tripId);
    if (entityId) q = q.where("entityId", "==", entityId);
    q = q.orderBy("createdAt", "desc").orderBy("__name__", "desc");
    const cursor = decodeCursor(data.cursor);
    if (cursor) q = q.startAfter(cursor.ts, cursor.id);
    const snap = await q.limit(size).get();
    return {
      entries: snap.docs.map((d) => toJson(d.data())),
      nextCursor: snap.docs.length === size ? encodeCursor(snap.docs[snap.docs.length - 1], "createdAt") : null,
    };
  }
  return { listAuditLogs };
}

module.exports = { makeAuditService };
