"use strict";

const { COLLECTIONS, SCHEMA_VERSION, ROLES, MEMBERSHIP_STATUS, MANAGER_ROLES, LIMITS } = require("../lib/constants");
const v = require("../lib/validate");
const { requireAuth, loadMemberContext, membershipRef, membershipId } = require("../lib/access");
const { runIdempotent } = require("../lib/idempotency");
const { writeAudit, diff } = require("../lib/audit");
const { invalid, precondition } = require("../lib/errors");
const { toJson } = require("../lib/serialize");
const { DEFAULT_CATEGORIES } = require("../domain/categories");
const { SUPPORTED_CURRENCIES } = require("../domain/money");

async function displayNameFor(ctx, tx, uid, authToken) {
  // `users/{uid}` is owned by the FlutterFlow app; read it, never write it.
  const snap = await tx.get(ctx.db.collection(COLLECTIONS.USERS).doc(uid));
  const data = snap.exists ? snap.data() : {};
  return (data.display_name || data.displayName || (authToken && authToken.name) || "").slice(0, 100) || null;
}

function categoryDocsForTrip(ctx, tripId, uid) {
  return DEFAULT_CATEGORIES.map((c, index) => ({
    ref: ctx.db.collection(COLLECTIONS.CATEGORIES).doc(`${tripId}_${c.key}`),
    data: {
      categoryId: `${tripId}_${c.key}`,
      tripId,
      key: c.key,
      name: c.name,
      keywords: [...c.keywords],
      isDefault: true,
      archived: false,
      sortOrder: index,
      createdByUid: uid,
      schemaVersion: SCHEMA_VERSION,
    },
  }));
}

function makeTripService(ctx) {
  const { db, FieldValue } = ctx;

  async function createTrip(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["name", "description", "currency", "startDate", "endDate", "idempotencyKey"]);
    const name = v.string(data, "name", { max: LIMITS.MAX_TITLE_LENGTH });
    const description = v.string(data, "description", { required: false, max: LIMITS.MAX_NOTE_LENGTH });
    const currency = v.oneOf(data, "currency", Object.keys(SUPPORTED_CURRENCIES), { required: false, defaultValue: "INR" });
    const startMs = v.timestampMillis(data, "startDate");
    const endMs = v.timestampMillis(data, "endDate");
    if (startMs !== null && endMs !== null && endMs < startMs) throw invalid("endDate is before startDate.", "INVALID_DATE_RANGE");
    const key = v.idempotencyKey(data);

    return runIdempotent(ctx, { uid, operation: "createTrip", key, payload: { name, description, currency, startMs, endMs } }, async (tx) => {
      const displayName = await displayNameFor(ctx, tx, uid, request.auth.token);
      const tripRef = db.collection(COLLECTIONS.TRIPS).doc();
      const tripId = tripRef.id;
      tx.set(tripRef, {
        tripId,
        name,
        description,
        currency,
        startDate: startMs === null ? null : ctx.Timestamp.fromMillis(startMs),
        endDate: endMs === null ? null : ctx.Timestamp.fromMillis(endMs),
        ownerUid: uid,
        createdByUid: uid,
        status: "ACTIVE",
        memberCount: 1,
        version: 1,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        schemaVersion: SCHEMA_VERSION,
      });
      tx.set(membershipRef(ctx, tripId, uid), {
        membershipId: membershipId(tripId, uid),
        tripId,
        uid,
        role: ROLES.OWNER,
        status: MEMBERSHIP_STATUS.ACTIVE,
        displayName,
        joinedVia: "CREATOR",
        joinedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        schemaVersion: SCHEMA_VERSION,
      });
      for (const c of categoryDocsForTrip(ctx, tripId, uid)) {
        tx.set(c.ref, { ...c.data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      }
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "TRIP_CREATED", entityType: "trip", entityId: tripId, changes: { name, currency } });
      return { tripId };
    });
  }

  async function updateTrip(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "name", "description", "startDate", "endDate", "status", "expectedVersion"]);
    const tripId = v.id(data, "tripId");
    const updates = {};
    if (data.name !== undefined) updates.name = v.string(data, "name", { max: LIMITS.MAX_TITLE_LENGTH });
    if (data.description !== undefined) updates.description = v.string(data, "description", { required: false, max: LIMITS.MAX_NOTE_LENGTH });
    for (const field of ["startDate", "endDate"]) {
      if (data[field] === undefined) continue;
      const ms = v.timestampMillis(data, field);
      updates[field] = ms === null ? null : ctx.Timestamp.fromMillis(ms);
    }
    if (data.status !== undefined) updates.status = v.oneOf(data, "status", ["ACTIVE", "ARCHIVED"]);
    const expectedVersion = v.integer(data, "expectedVersion", { required: false, min: 1 });
    if (!Object.keys(updates).length) throw invalid("Nothing to update.", "NO_CHANGES");

    return db.runTransaction(async (tx) => {
      const { trip, tripRef } = await loadMemberContext(ctx, tx, tripId, uid, { roles: MANAGER_ROLES, allowArchivedTrip: true });
      if (trip.status === "ARCHIVED" && updates.status !== "ACTIVE") {
        throw invalid("Restore the trip (status ACTIVE) before editing it.", "TRIP_ARCHIVED");
      }
      if (expectedVersion && trip.version !== expectedVersion) {
        throw precondition("The trip was changed by someone else. Reload and try again.", "VERSION_CONFLICT");
      }
      const next = { ...trip, ...updates };
      const toMs = (d) => (d && typeof d.toMillis === "function" ? d.toMillis() : Date.parse(d)); // older docs stored "YYYY-MM-DD"
      if (next.startDate && next.endDate && toMs(next.endDate) < toMs(next.startDate)) {
        throw invalid("endDate is before startDate.", "INVALID_DATE_RANGE");
      }
      const changes = diff(trip, next, Object.keys(updates));
      tx.update(tripRef, { ...updates, version: trip.version + 1, updatedAt: FieldValue.serverTimestamp() });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "TRIP_UPDATED", entityType: "trip", entityId: tripId, changes });
      return { tripId, version: trip.version + 1 };
    });
  }

  async function getTrip(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const { trip, membership } = await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    return { trip: toJson(trip), myRole: membership.role };
  }

  async function listMyTrips(request) {
    const uid = requireAuth(request);
    const snap = await db
      .collection(COLLECTIONS.TRIP_MEMBERSHIPS)
      .where("uid", "==", uid)
      .where("status", "==", MEMBERSHIP_STATUS.ACTIVE)
      .limit(200)
      .get();
    const memberships = snap.docs.map((d) => d.data());
    const tripRefs = memberships.map((m) => db.collection(COLLECTIONS.TRIPS).doc(m.tripId));
    const trips = tripRefs.length ? await db.getAll(...tripRefs) : [];
    return {
      trips: trips
        .map((t, i) => (t.exists ? { ...toJson(t.data()), myRole: memberships[i].role } : null))
        .filter(Boolean),
    };
  }

  return { createTrip, updateTrip, getTrip, listMyTrips };
}

module.exports = { makeTripService };
