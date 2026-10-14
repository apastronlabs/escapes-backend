"use strict";

const { COLLECTIONS, SCHEMA_VERSION, LIMITS } = require("../lib/constants");
const v = require("../lib/validate");
const { requireAuth, loadMemberContext, requireActiveMembers } = require("../lib/access");
const { runIdempotent } = require("../lib/idempotency");
const { writeAudit } = require("../lib/audit");
const { invalid, denied, notFound, precondition } = require("../lib/errors");
const { toJson } = require("../lib/serialize");
const { ledgerOf } = require("../domain/ledger");
const { computeNetBalances, suggestSettlements } = require("../domain/settlement");

/** Settlement statuses: PENDING (claimed by payer) -> CONFIRMED (by receiver) | REJECTED | CANCELLED | FAILED. */
function settlementLedger(status) {
  if (status === "CONFIRMED") return "CONFIRMED";
  if (status === "PENDING") return "PROVISIONAL";
  return "EXCLUDED";
}

function summarize(expenses, settlements, members) {
  const confirmedExpenses = [];
  const provisionalExpenses = [];
  const unresolved = [];
  const byCategory = {};
  let confirmedSpendMinor = 0;
  let provisionalSpendMinor = 0;

  for (const e of expenses) {
    if (e.status !== "ACTIVE") continue;
    const ledger = ledgerOf(e.verificationStatus);
    if (ledger === "UNRESOLVED") {
      unresolved.push({ expenseId: e.expenseId, title: e.title, amountMinor: e.amountMinor, verificationStatus: e.verificationStatus });
      continue;
    }
    if (ledger === "EXCLUDED") continue;
    provisionalExpenses.push(e);
    provisionalSpendMinor += e.amountMinor;
    const cat = (byCategory[e.categoryId || "uncategorized"] ||= { confirmedMinor: 0, provisionalMinor: 0 });
    cat.provisionalMinor += e.amountMinor;
    if (ledger === "CONFIRMED") {
      confirmedExpenses.push(e);
      confirmedSpendMinor += e.amountMinor;
      cat.confirmedMinor += e.amountMinor;
    }
  }
  const confirmedSettlements = settlements.filter((s) => settlementLedger(s.status) === "CONFIRMED");
  const provisionalSettlements = settlements.filter((s) => settlementLedger(s.status) !== "EXCLUDED");

  const build = (exps, sets) => {
    const net = computeNetBalances(exps, sets);
    const paid = {};
    const share = {};
    for (const e of exps) {
      paid[e.paidByUid] = (paid[e.paidByUid] || 0) + e.amountMinor;
      for (const [uid, s] of Object.entries(e.shares || {})) share[uid] = (share[uid] || 0) + s;
    }
    const uids = new Set([...Object.keys(net), ...members.filter((m) => m.status === "ACTIVE").map((m) => m.uid)]);
    const balances = [...uids].sort().map((uid) => ({
      uid,
      paidMinor: paid[uid] || 0,
      shareMinor: share[uid] || 0,
      netMinor: net[uid] || 0,
      membershipStatus: (members.find((m) => m.uid === uid) || {}).status || "UNKNOWN",
    }));
    const outstandingMinor = Object.values(net).filter((x) => x > 0).reduce((a, b) => a + b, 0);
    return { balances, suggestions: suggestSettlements(net), outstandingMinor };
  };

  return {
    totals: { confirmedSpendMinor, provisionalSpendMinor, unverifiedSpendMinor: provisionalSpendMinor - confirmedSpendMinor, unresolvedCount: unresolved.length },
    byCategory,
    confirmed: build(confirmedExpenses, confirmedSettlements),
    provisional: build(provisionalExpenses, provisionalSettlements),
    unresolved,
  };
}

function makeSettlementService(ctx) {
  const { db, FieldValue } = ctx;
  const settlements = () => db.collection(COLLECTIONS.SETTLEMENTS);

  /**
   * Trip totals, per-member balances and settlement suggestions, computed twice:
   * `confirmed` uses only verified money movement; `provisional` adds unverified
   * claims and member-reported expenses and must be shown as unverified.
   */
  async function getTripSummary(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const { trip } = await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    const [expSnap, setSnap, memSnap] = await Promise.all([
      db.collection(COLLECTIONS.EXPENSES).where("tripId", "==", tripId)
        .select("expenseId", "title", "amountMinor", "paidByUid", "shares", "status", "verificationStatus", "categoryId", "kind")
        .limit(LIMITS.MAX_SUMMARY_DOCS + 1).get(),
      settlements().where("tripId", "==", tripId).limit(LIMITS.MAX_SUMMARY_DOCS + 1).get(),
      db.collection(COLLECTIONS.TRIP_MEMBERSHIPS).where("tripId", "==", tripId).limit(LIMITS.MAX_MEMBERS_PER_TRIP * 2).get(),
    ]);
    if (expSnap.size > LIMITS.MAX_SUMMARY_DOCS || setSnap.size > LIMITS.MAX_SUMMARY_DOCS) {
      throw precondition("This trip is too large for an on-demand summary.", "SUMMARY_TOO_LARGE");
    }
    const summary = summarize(
      expSnap.docs.map((d) => d.data()),
      setSnap.docs.map((d) => d.data()),
      memSnap.docs.map((d) => d.data()),
    );
    return { tripId, currency: trip.currency, ...summary };
  }

  /** Record a cash/other settlement between two members. Counts as provisional until the receiver confirms. */
  async function recordSettlement(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "toUid", "amountMinor", "method", "note", "idempotencyKey"]);
    const tripId = v.id(data, "tripId");
    const toUid = v.id(data, "toUid");
    const amountMinor = v.integer(data, "amountMinor", { min: 1, max: 100_000_000_000 });
    const method = v.oneOf(data, "method", ["CASH", "BANK_TRANSFER", "OTHER"]);
    const note = v.string(data, "note", { required: false, max: 300 });
    const key = v.idempotencyKey(data);
    if (toUid === uid) throw invalid("You cannot settle with yourself.", "SELF_SETTLEMENT");
    return runIdempotent(ctx, { uid, operation: "recordSettlement", key, payload: { tripId, toUid, amountMinor, method, note } }, async (tx) => {
      const { trip } = await loadMemberContext(ctx, tx, tripId, uid);
      await requireActiveMembers(ctx, tx, tripId, [toUid]);
      const ref = settlements().doc();
      // The payer is always the caller: nobody can record a payment on someone else's behalf.
      tx.set(ref, {
        settlementId: ref.id, tripId, fromUid: uid, toUid, amountMinor, currency: trip.currency, method,
        transactionId: null, status: "PENDING", createdByUid: uid, note,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
      });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "SETTLEMENT_RECORDED", entityType: "settlement", entityId: ref.id, changes: { toUid, amountMinor, method } });
      return { settlementId: ref.id, status: "PENDING" };
    });
  }

  async function respondToSettlement(request, decision) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "settlementId", "note"]);
    const tripId = v.id(data, "tripId");
    const settlementId = v.id(data, "settlementId");
    const note = v.string(data, "note", { required: false, max: 300 });
    return db.runTransaction(async (tx) => {
      await loadMemberContext(ctx, tx, tripId, uid, { allowArchivedTrip: true });
      const snap = await tx.get(settlements().doc(settlementId));
      if (!snap.exists || snap.data().tripId !== tripId) throw notFound("Settlement not found.", "SETTLEMENT_NOT_FOUND");
      const s = snap.data();
      if (s.transactionId) throw precondition("UPI settlements are confirmed through reconcileTransaction.", "USE_RECONCILE_TRANSACTION");
      if (s.status !== "PENDING") {
        if (s.status === decision) return { settlementId, status: s.status };
        throw precondition(`Settlement is already ${s.status}.`, "SETTLEMENT_NOT_PENDING");
      }
      if (decision === "CANCELLED" ? s.fromUid !== uid : s.toUid !== uid) {
        throw denied(decision === "CANCELLED" ? "Only the payer can cancel this settlement." : "Only the receiving member can respond to this settlement.", "NOT_SETTLEMENT_PARTY");
      }
      tx.update(snap.ref, {
        status: decision, respondedByUid: uid, responseNote: note,
        ...(decision === "CONFIRMED" ? { confirmedByUid: uid, confirmedAt: FieldValue.serverTimestamp() } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: `SETTLEMENT_${decision}`, entityType: "settlement", entityId: settlementId, changes: { status: { from: "PENDING", to: decision } } });
      return { settlementId, status: decision };
    });
  }

  async function listSettlements(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    const snap = await settlements().where("tripId", "==", tripId).orderBy("createdAt", "desc").limit(LIMITS.MAX_PAGE_SIZE).get();
    return { settlements: snap.docs.map((d) => toJson(d.data())) };
  }

  return {
    getTripSummary,
    recordSettlement,
    confirmSettlement: (r) => respondToSettlement(r, "CONFIRMED"),
    rejectSettlement: (r) => respondToSettlement(r, "REJECTED"),
    cancelSettlement: (r) => respondToSettlement(r, "CANCELLED"),
    listSettlements,
  };
}

module.exports = { makeSettlementService, summarize };
