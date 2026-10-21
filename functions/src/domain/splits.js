"use strict";

/**
 * Expense split calculation.
 *
 * Rounding policy (documented in docs/SPLITTING.md):
 *  - Shares are integer minor units and always sum exactly to the expense amount.
 *  - EQUAL: every participant gets floor(amount / n); the leftover paise
 *    (fewer than n) go one each to participants in ascending uid order.
 *  - PERCENTAGE: percentages are given in basis points (1% = 100 bps) and must
 *    total exactly 10000. Each share is floor(amount * bps / 10000); leftover
 *    paise go one each by largest fractional remainder, ties by ascending uid
 *    (Hamilton / largest-remainder method).
 *  - AMOUNT: explicit amounts must be non-negative integers summing exactly to
 *    the amount. No rounding is applied.
 * Ordering by uid makes results independent of the order the client sent.
 * Negative amounts (compensating adjustments) are split on the absolute value
 * and negated, so a refund mirrors the original split.
 */

const SPLIT_TYPES = Object.freeze({ EQUAL: "EQUAL", AMOUNT: "AMOUNT", PERCENTAGE: "PERCENTAGE" });

class SplitError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

function byUid(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function equalSplit(amount, participants) {
  const sorted = [...participants].sort(byUid);
  const n = sorted.length;
  const base = Math.floor(amount / n);
  let remainder = amount - base * n;
  const shares = {};
  for (const uid of sorted) {
    shares[uid] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return shares;
}

function percentageSplit(amount, participants, basisPoints) {
  let totalBps = 0;
  for (const uid of participants) {
    const bps = basisPoints[uid];
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) {
      throw new SplitError(`Invalid percentage for ${uid}.`, "INVALID_PERCENTAGE");
    }
    totalBps += bps;
  }
  if (totalBps !== 10000) throw new SplitError("Percentages must total exactly 100%.", "PERCENTAGE_TOTAL_MISMATCH");

  const sorted = [...participants].sort(byUid);
  const shares = {};
  const remainders = [];
  let allocated = 0;
  for (const uid of sorted) {
    // amount * bps stays well inside MAX_SAFE_INTEGER for amounts below ~9e11 paise.
    const exact = amount * basisPoints[uid];
    const share = Math.floor(exact / 10000);
    shares[uid] = share;
    allocated += share;
    remainders.push({ uid, rem: exact % 10000 });
  }
  let leftover = amount - allocated;
  remainders.sort((a, b) => b.rem - a.rem || byUid(a.uid, b.uid));
  for (let i = 0; leftover > 0; i = (i + 1) % remainders.length) {
    shares[remainders[i].uid] += 1;
    leftover -= 1;
  }
  return shares;
}

function amountSplit(amount, participants, amounts) {
  let total = 0;
  const shares = {};
  for (const uid of [...participants].sort(byUid)) {
    const v = amounts[uid];
    if (!Number.isSafeInteger(v) || v < 0) throw new SplitError(`Invalid amount for ${uid}.`, "INVALID_SHARE_AMOUNT");
    shares[uid] = v;
    total += v;
  }
  if (total !== amount) {
    throw new SplitError(`Share amounts total ${total} but expense is ${amount}.`, "SHARE_TOTAL_MISMATCH");
  }
  return shares;
}

/**
 * @param {number} amountMinor  expense amount (may be negative for adjustments)
 * @param {string[]} participants  unique uids
 * @param {{type: string, values?: Object<string, number>}} split
 * @returns {Object<string, number>} uid -> share in minor units
 */
function computeShares(amountMinor, participants, split) {
  if (!Number.isSafeInteger(amountMinor)) throw new SplitError("Amount must be an integer.", "INVALID_AMOUNT");
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new SplitError("At least one participant is required.", "NO_PARTICIPANTS");
  }
  if (new Set(participants).size !== participants.length) {
    throw new SplitError("Participants must be unique.", "DUPLICATE_PARTICIPANTS");
  }
  const type = split && split.type;
  const values = (split && split.values) || {};
  if (type !== SPLIT_TYPES.EQUAL) {
    const extra = Object.keys(values).filter((uid) => !participants.includes(uid));
    if (extra.length) throw new SplitError("Split values reference non-participants.", "SPLIT_VALUE_NOT_PARTICIPANT");
  }

  const sign = amountMinor < 0 ? -1 : 1;
  const abs = Math.abs(amountMinor);
  let shares;
  switch (type) {
    case SPLIT_TYPES.EQUAL:
      shares = equalSplit(abs, participants);
      break;
    case SPLIT_TYPES.PERCENTAGE:
      shares = percentageSplit(abs, participants, values);
      break;
    case SPLIT_TYPES.AMOUNT: {
      const absValues = {};
      for (const uid of participants) absValues[uid] = typeof values[uid] === "number" ? values[uid] * sign : values[uid];
      shares = amountSplit(abs, participants, absValues);
      break;
    }
    default:
      throw new SplitError("split.type must be EQUAL, AMOUNT or PERCENTAGE.", "INVALID_SPLIT_TYPE");
  }
  if (sign < 0) for (const uid of Object.keys(shares)) shares[uid] = shares[uid] === 0 ? 0 : -shares[uid];
  return shares;
}

/** Split a compensating amount in proportion to existing shares (used for refunds). */
function proportionalShares(amountMinor, baseShares) {
  const participants = Object.keys(baseShares).filter((uid) => baseShares[uid] !== 0);
  const baseTotal = participants.reduce((s, uid) => s + Math.abs(baseShares[uid]), 0);
  if (baseTotal === 0) throw new SplitError("Original split has no non-zero shares.", "EMPTY_BASE_SPLIT");
  // Express each share as basis points of the original, then reuse the percentage path
  // with its remainder handling. Exact bps keep the result deterministic.
  const sign = amountMinor < 0 ? -1 : 1;
  const abs = Math.abs(amountMinor);
  const sorted = [...participants].sort(byUid);
  const shares = {};
  const remainders = [];
  let allocated = 0;
  for (const uid of sorted) {
    const exact = abs * Math.abs(baseShares[uid]);
    const share = Math.floor(exact / baseTotal);
    shares[uid] = share;
    allocated += share;
    remainders.push({ uid, rem: exact % baseTotal });
  }
  let leftover = abs - allocated;
  remainders.sort((a, b) => b.rem - a.rem || byUid(a.uid, b.uid));
  for (let i = 0; leftover > 0; i = (i + 1) % remainders.length) {
    shares[remainders[i].uid] += 1;
    leftover -= 1;
  }
  if (sign < 0) for (const uid of Object.keys(shares)) shares[uid] = shares[uid] === 0 ? 0 : -shares[uid];
  return shares;
}

function sumShares(shares) {
  return Object.values(shares).reduce((s, v) => s + v, 0);
}

module.exports = { SPLIT_TYPES, SplitError, computeShares, proportionalShares, sumShares };
