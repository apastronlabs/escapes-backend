"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clearFirestore, setup, key, as, rejectsWith, tripWith, getDoc } = require("../helpers");

test.beforeEach(clearFirestore);

test("unauthenticated calls are rejected", async () => {
  const { h } = setup();
  await rejectsWith(h.createTrip({ data: { name: "x", idempotencyKey: key() } }), "unauthenticated");
  await rejectsWith(h.listMyTrips({ auth: null, data: {} }), "unauthenticated");
});

test("createTrip seeds owner membership and trip-scoped default categories", async () => {
  const { h } = setup();
  const { tripId } = await h.createTrip(as("alice", { name: "Goa 2026", startDate: "2026-12-20", endDate: "2026-12-27", idempotencyKey: key() }));
  const trip = await getDoc("trips", tripId);
  assert.equal(trip.ownerUid, "alice");
  assert.equal(trip.currency, "INR");
  assert.equal((await getDoc("tripMemberships", `${tripId}_alice`)).role, "OWNER");
  const { categories } = await h.listCategories(as("alice", { tripId }));
  assert.deepEqual(categories.map((c) => c.name), ["Food", "Drinks", "Transport", "Accommodation", "Activities", "Shopping", "Groceries", "Other"]);
  assert.ok(categories.every((c) => c.tripId === tripId));
});

test("input validation rejects bad payloads", async () => {
  const { h } = setup();
  await rejectsWith(h.createTrip(as("a", { name: "", idempotencyKey: key() })), "invalid-argument", "MISSING_FIELD");
  await rejectsWith(h.createTrip(as("a", { name: "x", idempotencyKey: key(), evil: true })), "invalid-argument", "UNKNOWN_FIELD");
  await rejectsWith(h.createTrip(as("a", { name: "x", startDate: "2026-02-10", endDate: "2026-02-01", idempotencyKey: key() })), "invalid-argument", "INVALID_DATE_RANGE");
  await rejectsWith(h.createTrip(as("a", { name: "x", currency: "USD", idempotencyKey: key() })), "invalid-argument");
});

test("users in different trips cannot see each other's data", async () => {
  const { h } = setup();
  const tripA = await tripWith(h, "alice", ["bob"]);
  const tripB = await tripWith(h, "carol", ["dave"]);
  await rejectsWith(h.getTrip(as("carol", { tripId: tripA })), "permission-denied", "NOT_A_MEMBER");
  await rejectsWith(h.listExpenses(as("dave", { tripId: tripA })), "permission-denied", "NOT_A_MEMBER");
  await rejectsWith(h.getTripSummary(as("bob", { tripId: tripB })), "permission-denied", "NOT_A_MEMBER");
  // Same error for a trip that does not exist: no existence probing.
  await rejectsWith(h.getTrip(as("carol", { tripId: "doesNotExist" })), "permission-denied", "NOT_A_MEMBER");
  const { trips } = await h.listMyTrips(as("bob", {}));
  assert.deepEqual(trips.map((t) => t.tripId), [tripA]);
});

test("a user can belong to several trips with different members", async () => {
  const { h } = setup();
  const t1 = await tripWith(h, "alice", ["bob"]);
  const t2 = await tripWith(h, "carol", ["alice"]);
  const { trips } = await h.listMyTrips(as("alice", {}));
  assert.deepEqual(trips.map((t) => t.tripId).sort(), [t1, t2].sort());
  const roles = Object.fromEntries(trips.map((t) => [t.tripId, t.myRole]));
  assert.equal(roles[t1], "OWNER");
  assert.equal(roles[t2], "MEMBER");
  const m2 = await h.listMembers(as("alice", { tripId: t2 }));
  assert.deepEqual(m2.members.map((m) => m.uid).sort(), ["alice", "carol"]);
});

test("invitation rules: roles, single use, expiry, email binding, revoke", async () => {
  const { h, ctx } = setup();
  const tripId = await tripWith(h, "owner", ["member"], { admins: ["admin"] });
  await rejectsWith(h.createInvitation(as("member", { tripId, idempotencyKey: key() })), "permission-denied", "INSUFFICIENT_ROLE");
  await rejectsWith(h.createInvitation(as("admin", { tripId, role: "ADMIN", idempotencyKey: key() })), "permission-denied", "INSUFFICIENT_ROLE");

  const inv = await h.createInvitation(as("admin", { tripId, idempotencyKey: key() }));
  assert.ok(inv.token.length >= 30);
  const stored = await getDoc("invitations", inv.invitationId);
  assert.equal(JSON.stringify(stored).includes(inv.token), false, "raw token must not be stored");
  await h.acceptInvitation(as("x1", { token: inv.token }));
  await rejectsWith(h.acceptInvitation(as("x2", { token: inv.token })), "failed-precondition", "INVITATION_EXHAUSTED");
  // Accepting again as an existing member is a no-op.
  assert.equal((await h.acceptInvitation(as("x1", { token: inv.token }))).alreadyMember, true);

  const emailInv = await h.createInvitation(as("owner", { tripId, email: "Friend@Example.com", idempotencyKey: key() }));
  await rejectsWith(h.acceptInvitation(as("stranger", { token: emailInv.token })), "permission-denied", "INVITATION_EMAIL_MISMATCH");
  await rejectsWith(h.acceptInvitation(as("friend", { token: emailInv.token }, { email: "friend@example.com", email_verified: false })), "permission-denied", "INVITATION_EMAIL_MISMATCH");
  await h.acceptInvitation(as("friend", { token: emailInv.token }, { email: "friend@example.com" }));

  const revoked = await h.createInvitation(as("owner", { tripId, idempotencyKey: key() }));
  await h.revokeInvitation(as("owner", { tripId, invitationId: revoked.invitationId }));
  await rejectsWith(h.acceptInvitation(as("late", { token: revoked.token })), "failed-precondition", "INVITATION_REVOKED");

  const expiring = await h.createInvitation(as("owner", { tripId, ttlHours: 1, idempotencyKey: key() }));
  ctx.now = () => Date.now() + 2 * 3600 * 1000;
  await rejectsWith(h.acceptInvitation(as("late2", { token: expiring.token })), "failed-precondition", "INVITATION_EXPIRED");
});

test("membership changes: roles, removal, leaving, rejoining", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "owner", ["m1", "m2"], { admins: ["adm"] });
  await rejectsWith(h.updateMemberRole(as("adm", { tripId, uid: "m1", role: "ADMIN" })), "permission-denied", "INSUFFICIENT_ROLE");
  await h.updateMemberRole(as("owner", { tripId, uid: "m1", role: "ADMIN" }));
  await rejectsWith(h.removeMember(as("adm", { tripId, uid: "m1" })), "permission-denied", "INSUFFICIENT_ROLE");
  await rejectsWith(h.removeMember(as("adm", { tripId, uid: "owner" })), "permission-denied", "CANNOT_REMOVE_OWNER");
  await h.removeMember(as("adm", { tripId, uid: "m2" }));
  await rejectsWith(h.getTrip(as("m2", { tripId })), "permission-denied", "NOT_A_MEMBER");
  await rejectsWith(h.leaveTrip(as("owner", { tripId })), "failed-precondition", "OWNER_CANNOT_LEAVE");
  await h.transferOwnership(as("owner", { tripId, uid: "m1" }));
  assert.equal((await getDoc("trips", tripId)).ownerUid, "m1");
  await h.leaveTrip(as("owner", { tripId }));
  assert.equal((await getDoc("tripMemberships", `${tripId}_owner`)).status, "LEFT");
  const inv = await h.createInvitation(as("m1", { tripId, idempotencyKey: key() }));
  await h.acceptInvitation(as("m2", { token: inv.token }));
  assert.equal((await getDoc("tripMemberships", `${tripId}_m2`)).status, "ACTIVE");
  assert.equal((await getDoc("trips", tripId)).memberCount, 3); // m1 (new owner), adm, m2 (rejoined)
});

test("archived trips are read-only until restored", async () => {
  const { h } = setup();
  const tripId = await tripWith(h, "owner", ["m"]);
  await h.updateTrip(as("owner", { tripId, status: "ARCHIVED" }));
  await rejectsWith(h.createExpense(as("m", { tripId, title: "x", amountMinor: 100, participantUids: ["m"], idempotencyKey: key() })), "permission-denied", "TRIP_ARCHIVED");
  assert.ok((await h.getTripSummary(as("m", { tripId }))).tripId);
  await h.updateTrip(as("owner", { tripId, status: "ACTIVE" }));
  await h.createExpense(as("m", { tripId, title: "x", amountMinor: 100, participantUids: ["m"], idempotencyKey: key() }));
});

test("categories are trip-specific: rename/archive/restore", async () => {
  const { h } = setup();
  const t1 = await tripWith(h, "alice", ["bob"]);
  const t2 = await tripWith(h, "alice");
  await h.updateCategory(as("bob", { tripId: t1, categoryId: `${t1}_food`, name: "Meals" }));
  const c2 = await h.listCategories(as("alice", { tripId: t2 }));
  assert.ok(c2.categories.some((c) => c.name === "Food"));
  await rejectsWith(h.updateCategory(as("bob", { tripId: t1, categoryId: `${t1}_drinks`, archived: true })), "failed-precondition", "INSUFFICIENT_ROLE");
  await h.updateCategory(as("alice", { tripId: t1, categoryId: `${t1}_drinks`, archived: true }));
  assert.equal((await h.listCategories(as("bob", { tripId: t1 }))).categories.some((c) => c.key === "drinks"), false);
  await rejectsWith(h.createExpense(as("bob", { tripId: t1, title: "Beer", amountMinor: 500, categoryId: `${t1}_drinks`, participantUids: ["bob"], idempotencyKey: key() })), "invalid-argument", "INVALID_CATEGORY");
  await h.updateCategory(as("alice", { tripId: t1, categoryId: `${t1}_drinks`, archived: false }));
  await rejectsWith(h.updateCategory(as("alice", { tripId: t1, categoryId: `${t1}_other`, archived: true })), "failed-precondition", "CANNOT_ARCHIVE_FALLBACK");
  const { categoryId } = await h.createCategory(as("bob", { tripId: t1, name: "Scuba", keywords: ["dive center"], idempotencyKey: key() }));
  await rejectsWith(h.createCategory(as("bob", { tripId: t1, name: "scuba", idempotencyKey: key() })), "failed-precondition", "DUPLICATE_CATEGORY_NAME");
  const s = await h.suggestCategory(as("bob", { tripId: t1, merchantName: "Lacadives Dive Center" }));
  assert.equal(s.categoryId, categoryId);
  // Other trip's category ids are not usable here.
  await rejectsWith(h.createExpense(as("alice", { tripId: t2, title: "x", amountMinor: 100, categoryId, participantUids: ["alice"], idempotencyKey: key() })), "invalid-argument", "INVALID_CATEGORY");
});
