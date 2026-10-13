"use strict";

const { COLLECTIONS, SCHEMA_VERSION, ROLES, MEMBERSHIP_STATUS, MANAGER_ROLES, LIMITS } = require("../lib/constants");
const v = require("../lib/validate");
const { requireAuth, loadMemberContext, membershipRef, membershipId } = require("../lib/access");
const { runIdempotent } = require("../lib/idempotency");
const { writeAudit } = require("../lib/audit");
const { invalid, denied, notFound, precondition } = require("../lib/errors");
const { sha256Hex, randomToken } = require("../lib/hash");
const { toJson } = require("../lib/serialize");

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function makeMemberService(ctx) {
  const { db, FieldValue, Timestamp } = ctx;
  const invitations = () => db.collection(COLLECTIONS.INVITATIONS);

  // ---------- invitations ----------

  async function createInvitation(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "role", "email", "ttlHours", "maxUses", "idempotencyKey"]);
    const tripId = v.id(data, "tripId");
    const role = v.oneOf(data, "role", [ROLES.MEMBER, ROLES.ADMIN], { required: false, defaultValue: ROLES.MEMBER });
    const emailRaw = v.string(data, "email", { required: false, max: 254, pattern: EMAIL_RE });
    const email = emailRaw ? emailRaw.toLowerCase() : null;
    const ttlHours = v.integer(data, "ttlHours", { required: false, min: 1, max: LIMITS.INVITATION_MAX_TTL_HOURS }) || LIMITS.INVITATION_DEFAULT_TTL_HOURS;
    const maxUses = v.integer(data, "maxUses", { required: false, min: 1, max: 50 }) || 1;
    if (email && maxUses !== 1) throw invalid("An email-restricted invitation can only be used once.", "INVALID_MAX_USES");
    const key = v.idempotencyKey(data);

    // Only the SHA-256 of the token is stored. The raw token is returned once, on the
    // first successful call; an idempotent replay returns the invitation without it
    // (the client should revoke it and create a new one if the token was lost).
    const token = randomToken(24);
    const result = await runIdempotent(ctx, { uid, operation: "createInvitation", key, payload: { tripId, role, email, ttlHours, maxUses } }, async (tx) => {
      const { membership } = await loadMemberContext(ctx, tx, tripId, uid, { roles: MANAGER_ROLES });
      if (role === ROLES.ADMIN && membership.role !== ROLES.OWNER) {
        throw denied("Only the trip owner can invite admins.", "INSUFFICIENT_ROLE");
      }
      const invitationId = sha256Hex(token);
      const expiresAt = Timestamp.fromMillis(ctx.now() + ttlHours * 3600 * 1000);
      tx.set(invitations().doc(invitationId), {
        invitationId,
        tripId,
        role,
        email,
        maxUses,
        useCount: 0,
        acceptedByUids: [],
        status: "ACTIVE",
        createdByUid: uid,
        expiresAt,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        schemaVersion: SCHEMA_VERSION,
      });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "INVITATION_CREATED", entityType: "invitation", entityId: invitationId, changes: { role, email, maxUses, ttlHours } });
      return { invitationId, expiresAt: expiresAt.toDate().toISOString() };
    });
    return result.idempotentReplay ? { ...result, token: null } : { ...result, token };
  }

  async function acceptInvitation(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["token"]);
    const token = v.string(data, "token", { min: 16, max: 128, pattern: /^[A-Za-z0-9_-]+$/ });
    const invitationId = sha256Hex(token);

    return db.runTransaction(async (tx) => {
      const invSnap = await tx.get(invitations().doc(invitationId));
      if (!invSnap.exists) throw notFound("Invitation not found.", "INVITATION_NOT_FOUND");
      const inv = invSnap.data();
      const tripRef = db.collection(COLLECTIONS.TRIPS).doc(inv.tripId);
      const memRef = membershipRef(ctx, inv.tripId, uid);
      const [tripSnap, memSnap, userSnap] = await Promise.all([
        tx.get(tripRef),
        tx.get(memRef),
        tx.get(db.collection(COLLECTIONS.USERS).doc(uid)),
      ]);

      // Already an active member: accepting again is a no-op and consumes nothing.
      if (memSnap.exists && memSnap.data().status === MEMBERSHIP_STATUS.ACTIVE) {
        return { tripId: inv.tripId, role: memSnap.data().role, alreadyMember: true };
      }
      if (inv.status !== "ACTIVE") throw precondition("This invitation is no longer valid.", `INVITATION_${inv.status}`);
      if (inv.expiresAt.toMillis() <= ctx.now()) throw precondition("This invitation has expired.", "INVITATION_EXPIRED");
      if (inv.useCount >= inv.maxUses) throw precondition("This invitation has already been used.", "INVITATION_EXHAUSTED");
      if (inv.email) {
        const tokenEmail = (request.auth.token && request.auth.token.email || "").toLowerCase();
        if (tokenEmail !== inv.email || request.auth.token.email_verified !== true) {
          throw denied("This invitation was sent to a different email address.", "INVITATION_EMAIL_MISMATCH");
        }
      }
      if (!tripSnap.exists || tripSnap.data().status !== "ACTIVE") {
        throw precondition("This trip is not accepting new members.", "TRIP_NOT_ACTIVE");
      }
      const trip = tripSnap.data();
      if (trip.memberCount >= LIMITS.MAX_MEMBERS_PER_TRIP) throw precondition("This trip is full.", "TRIP_FULL");

      const user = userSnap.exists ? userSnap.data() : {};
      const displayName = (user.display_name || user.displayName || (request.auth.token && request.auth.token.name) || "").slice(0, 100) || null;
      const previous = memSnap.exists ? memSnap.data() : null;
      tx.set(memRef, {
        membershipId: membershipId(inv.tripId, uid),
        tripId: inv.tripId,
        uid,
        role: inv.role,
        status: MEMBERSHIP_STATUS.ACTIVE,
        displayName,
        joinedVia: "INVITATION",
        invitationId,
        joinedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        previousStatus: previous ? previous.status : null,
        schemaVersion: SCHEMA_VERSION,
      });
      tx.update(tripRef, { memberCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      const useCount = inv.useCount + 1;
      tx.update(invSnap.ref, {
        useCount,
        acceptedByUids: FieldValue.arrayUnion(uid),
        status: useCount >= inv.maxUses ? "EXHAUSTED" : "ACTIVE",
        updatedAt: FieldValue.serverTimestamp(),
      });
      writeAudit(ctx, tx, { tripId: inv.tripId, actorUid: uid, action: previous ? "MEMBER_REJOINED" : "MEMBER_JOINED", entityType: "membership", entityId: memRef.id, changes: { role: inv.role }, metadata: { invitationId } });
      return { tripId: inv.tripId, role: inv.role, alreadyMember: false };
    });
  }

  async function revokeInvitation(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "invitationId"]);
    const tripId = v.id(data, "tripId");
    const invitationId = v.string(data, "invitationId", { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    return db.runTransaction(async (tx) => {
      await loadMemberContext(ctx, tx, tripId, uid, { roles: MANAGER_ROLES, allowArchivedTrip: true });
      const snap = await tx.get(invitations().doc(invitationId));
      if (!snap.exists || snap.data().tripId !== tripId) throw notFound("Invitation not found.", "INVITATION_NOT_FOUND");
      if (snap.data().status === "REVOKED") return { invitationId, status: "REVOKED" };
      tx.update(snap.ref, { status: "REVOKED", revokedByUid: uid, revokedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "INVITATION_REVOKED", entityType: "invitation", entityId: invitationId });
      return { invitationId, status: "REVOKED" };
    });
  }

  async function listInvitations(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    await loadMemberContext(ctx, null, tripId, uid, { roles: MANAGER_ROLES, allowArchivedTrip: true });
    const snap = await invitations().where("tripId", "==", tripId).orderBy("createdAt", "desc").limit(100).get();
    return { invitations: snap.docs.map((d) => toJson(d.data())) };
  }

  // ---------- membership ----------

  async function listMembers(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const includeFormer = v.boolean(data, "includeFormer", { defaultValue: false });
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    let q = db.collection(COLLECTIONS.TRIP_MEMBERSHIPS).where("tripId", "==", tripId);
    if (!includeFormer) q = q.where("status", "==", MEMBERSHIP_STATUS.ACTIVE);
    const snap = await q.limit(LIMITS.MAX_MEMBERS_PER_TRIP * 2).get();
    return { members: snap.docs.map((d) => toJson(d.data())) };
  }

  async function loadTarget(tx, tripId, targetUid) {
    const snap = await tx.get(membershipRef(ctx, tripId, targetUid));
    if (!snap.exists || snap.data().status !== MEMBERSHIP_STATUS.ACTIVE) {
      throw notFound("That person is not an active member of this trip.", "MEMBER_NOT_FOUND");
    }
    return snap;
  }

  async function updateMemberRole(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "uid", "role"]);
    const tripId = v.id(data, "tripId");
    const targetUid = v.id(data, "uid");
    const role = v.oneOf(data, "role", [ROLES.ADMIN, ROLES.MEMBER]);
    return db.runTransaction(async (tx) => {
      await loadMemberContext(ctx, tx, tripId, uid, { roles: [ROLES.OWNER] });
      const target = await loadTarget(tx, tripId, targetUid);
      const before = target.data().role;
      if (before === ROLES.OWNER) throw precondition("Use transferOwnership to change the owner's role.", "CANNOT_CHANGE_OWNER_ROLE");
      if (before === role) return { uid: targetUid, role };
      tx.update(target.ref, { role, updatedAt: FieldValue.serverTimestamp() });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "MEMBER_ROLE_CHANGED", entityType: "membership", entityId: target.id, changes: { role: { from: before, to: role } } });
      return { uid: targetUid, role };
    });
  }

  async function transferOwnership(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "uid"]);
    const tripId = v.id(data, "tripId");
    const targetUid = v.id(data, "uid");
    if (targetUid === uid) throw invalid("You already own this trip.", "ALREADY_OWNER");
    return db.runTransaction(async (tx) => {
      const { membershipRef: myRef, tripRef } = await loadMemberContext(ctx, tx, tripId, uid, { roles: [ROLES.OWNER] });
      const target = await loadTarget(tx, tripId, targetUid);
      tx.update(target.ref, { role: ROLES.OWNER, updatedAt: FieldValue.serverTimestamp() });
      tx.update(myRef, { role: ROLES.ADMIN, updatedAt: FieldValue.serverTimestamp() });
      tx.update(tripRef, { ownerUid: targetUid, updatedAt: FieldValue.serverTimestamp() });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "OWNERSHIP_TRANSFERRED", entityType: "trip", entityId: tripId, changes: { ownerUid: { from: uid, to: targetUid } } });
      return { tripId, ownerUid: targetUid };
    });
  }

  async function deactivate(tx, { tripId, actorUid, target, status, action }) {
    tx.update(target.ref, { status, removedByUid: actorUid, removedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.update(db.collection(COLLECTIONS.TRIPS).doc(tripId), { memberCount: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() });
    writeAudit(ctx, tx, { tripId, actorUid, action, entityType: "membership", entityId: target.id, changes: { status: { from: MEMBERSHIP_STATUS.ACTIVE, to: status } } });
  }

  /**
   * Removing a member never deletes or rewrites their expenses, shares or
   * settlements: their balance stays in the trip summary until settled.
   */
  async function removeMember(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "uid"]);
    const tripId = v.id(data, "tripId");
    const targetUid = v.id(data, "uid");
    if (targetUid === uid) throw invalid("Use leaveTrip to leave a trip.", "USE_LEAVE_TRIP");
    return db.runTransaction(async (tx) => {
      const { membership } = await loadMemberContext(ctx, tx, tripId, uid, { roles: MANAGER_ROLES, allowArchivedTrip: true });
      const target = await loadTarget(tx, tripId, targetUid);
      const targetRole = target.data().role;
      if (targetRole === ROLES.OWNER) throw denied("The owner cannot be removed.", "CANNOT_REMOVE_OWNER");
      if (targetRole === ROLES.ADMIN && membership.role !== ROLES.OWNER) throw denied("Only the owner can remove an admin.", "INSUFFICIENT_ROLE");
      await deactivate(tx, { tripId, actorUid: uid, target, status: MEMBERSHIP_STATUS.REMOVED, action: "MEMBER_REMOVED" });
      return { uid: targetUid, status: MEMBERSHIP_STATUS.REMOVED };
    });
  }

  async function leaveTrip(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId"]);
    const tripId = v.id(data, "tripId");
    return db.runTransaction(async (tx) => {
      const { membership } = await loadMemberContext(ctx, tx, tripId, uid, { allowArchivedTrip: true });
      if (membership.role === ROLES.OWNER) throw precondition("Transfer ownership before leaving the trip.", "OWNER_CANNOT_LEAVE");
      const target = await tx.get(membershipRef(ctx, tripId, uid));
      await deactivate(tx, { tripId, actorUid: uid, target, status: MEMBERSHIP_STATUS.LEFT, action: "MEMBER_LEFT" });
      return { tripId, status: MEMBERSHIP_STATUS.LEFT };
    });
  }

  return { createInvitation, acceptInvitation, revokeInvitation, listInvitations, listMembers, updateMemberRole, transferOwnership, removeMember, leaveTrip };
}

module.exports = { makeMemberService };
