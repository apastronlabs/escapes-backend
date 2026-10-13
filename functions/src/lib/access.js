"use strict";

const { COLLECTIONS, MEMBERSHIP_STATUS, MANAGER_ROLES } = require("./constants");
const { denied, unauthenticated } = require("./errors");

function requireAuth(request) {
  const uid = request && request.auth && request.auth.uid;
  if (!uid) throw unauthenticated();
  return uid;
}

function membershipId(tripId, uid) {
  return `${tripId}_${uid}`;
}

function tripRef(ctx, tripId) {
  return ctx.db.collection(COLLECTIONS.TRIPS).doc(tripId);
}

function membershipRef(ctx, tripId, uid) {
  return ctx.db.collection(COLLECTIONS.TRIP_MEMBERSHIPS).doc(membershipId(tripId, uid));
}

/**
 * Loads the trip and the caller's ACTIVE membership (inside `tx` when given).
 * A missing trip and a missing membership produce the same error, so
 * non-members cannot probe which trip ids exist.
 */
async function loadMemberContext(ctx, tx, tripId, uid, { roles = null, allowArchivedTrip = false } = {}) {
  const get = (ref) => (tx ? tx.get(ref) : ref.get());
  const [tripSnap, memberSnap] = await Promise.all([get(tripRef(ctx, tripId)), get(membershipRef(ctx, tripId, uid))]);
  if (!tripSnap.exists || !memberSnap.exists || memberSnap.data().status !== MEMBERSHIP_STATUS.ACTIVE) {
    throw denied("You are not a member of this trip.", "NOT_A_MEMBER");
  }
  const trip = tripSnap.data();
  const membership = memberSnap.data();
  if (roles && !roles.includes(membership.role)) {
    throw denied("Your role in this trip does not allow this action.", "INSUFFICIENT_ROLE");
  }
  if (trip.status === "ARCHIVED" && !allowArchivedTrip) {
    throw denied("This trip is archived. Restore it before making changes.", "TRIP_ARCHIVED");
  }
  return { trip, membership, tripRef: tripSnap.ref, membershipRef: memberSnap.ref };
}

function isManager(membership) {
  return MANAGER_ROLES.includes(membership.role);
}

/** Reads memberships for the given uids and asserts all are ACTIVE members of the trip. */
async function requireActiveMembers(ctx, tx, tripId, uids, { reason = "NOT_A_TRIP_MEMBER" } = {}) {
  const refs = uids.map((u) => membershipRef(ctx, tripId, u));
  const snaps = refs.length ? await tx.getAll(...refs) : [];
  const out = {};
  snaps.forEach((s, i) => {
    if (!s.exists || s.data().status !== MEMBERSHIP_STATUS.ACTIVE) {
      throw denied(`User ${uids[i]} is not an active member of this trip.`, reason);
    }
    out[uids[i]] = s.data();
  });
  return out;
}

module.exports = {
  requireAuth,
  membershipId,
  tripRef,
  membershipRef,
  loadMemberContext,
  isManager,
  requireActiveMembers,
};
