"use strict";

/**
 * Canonical UPI transaction states and the only transitions allowed between them.
 *
 * Every transition is attributed to an ACTOR:
 *  - CLIENT:  the initiating user's app (client-reported outcome, UTR claim, cancel).
 *             Client reports are untrusted; they can never produce CONFIRMED.
 *  - TRUSTED: a backend verification path (verification adapter, or a manual
 *             reconciliation by someone other than the initiator).
 *
 * A status that was set by TRUSTED can never be changed by CLIENT.
 */

const STATES = Object.freeze({
  INITIATED: "INITIATED",
  AWAITING_VERIFICATION: "AWAITING_VERIFICATION",
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  REFUNDED: "REFUNDED",
  REVERSED: "REVERSED",
});

const ACTORS = Object.freeze({ CLIENT: "CLIENT", TRUSTED: "TRUSTED" });

const S = STATES;

/** from -> { CLIENT: [...], TRUSTED: [...] } */
const TRANSITIONS = Object.freeze({
  [S.INITIATED]: {
    CLIENT: [S.AWAITING_VERIFICATION, S.PENDING, S.FAILED, S.CANCELLED],
    TRUSTED: [S.CONFIRMED, S.FAILED, S.PENDING],
  },
  [S.PENDING]: {
    CLIENT: [S.AWAITING_VERIFICATION, S.FAILED, S.CANCELLED],
    TRUSTED: [S.CONFIRMED, S.FAILED],
  },
  [S.AWAITING_VERIFICATION]: {
    CLIENT: [],
    TRUSTED: [S.CONFIRMED, S.FAILED, S.PENDING],
  },
  // A client-reported failure/cancel may be followed by a UTR claim if money was in fact debited,
  // and a trusted source may later find the payment did succeed.
  [S.FAILED]: {
    CLIENT: [S.AWAITING_VERIFICATION],
    TRUSTED: [S.CONFIRMED],
  },
  [S.CANCELLED]: {
    CLIENT: [S.AWAITING_VERIFICATION],
    TRUSTED: [S.CONFIRMED],
  },
  // Confirmed history is never rewritten; refunds/reversals are recorded as separate
  // compensating events and only then move the original to REFUNDED/REVERSED.
  [S.CONFIRMED]: {
    CLIENT: [],
    TRUSTED: [S.REFUNDED, S.REVERSED],
  },
  [S.REFUNDED]: { CLIENT: [], TRUSTED: [] },
  [S.REVERSED]: { CLIENT: [], TRUSTED: [] },
});

/** States whose money movement has been independently established. */
const VERIFIED_STATES = Object.freeze([S.CONFIRMED, S.REFUNDED, S.REVERSED]);
const TERMINAL_STATES = Object.freeze([S.REFUNDED, S.REVERSED]);

/**
 * @param {{status: string, statusSetBy?: string}} txn current transaction
 * @param {string} to target status
 * @param {"CLIENT"|"TRUSTED"} actor
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function canTransition(txn, to, actor) {
  if (!STATES[to]) return { ok: false, reason: "UNKNOWN_STATE" };
  if (!ACTORS[actor]) return { ok: false, reason: "UNKNOWN_ACTOR" };
  const from = txn.status;
  const rule = TRANSITIONS[from];
  if (!rule) return { ok: false, reason: "UNKNOWN_STATE" };
  if (actor === ACTORS.CLIENT && txn.statusSetBy === ACTORS.TRUSTED) {
    return { ok: false, reason: "STATUS_LOCKED_BY_TRUSTED_SOURCE" };
  }
  if (!rule[actor].includes(to)) return { ok: false, reason: "INVALID_TRANSITION" };
  return { ok: true };
}

module.exports = { STATES, ACTORS, TRANSITIONS, VERIFIED_STATES, TERMINAL_STATES, canTransition };
