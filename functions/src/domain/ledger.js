"use strict";

const { STATES } = require("./paymentStates");

/**
 * Expense verification statuses: every transaction state (mirrored from the
 * linked transaction) plus MEMBER_REPORTED for expenses with no UPI
 * transaction (cash, card, paid elsewhere).
 */
const EXPENSE_VERIFICATION = Object.freeze({ ...STATES, MEMBER_REPORTED: "MEMBER_REPORTED" });

const EXPENSE_KINDS = Object.freeze({
  STANDARD: "STANDARD",
  REFUND_ADJUSTMENT: "REFUND_ADJUSTMENT",
  REVERSAL_ADJUSTMENT: "REVERSAL_ADJUSTMENT",
});

/**
 * Which ledger an expense/settlement counts toward.
 *  - CONFIRMED ledger: only independently verified (or manually reconciled) money movement.
 *    REFUNDED/REVERSED originals stay counted because their compensating
 *    adjustment entries are counted too, so they net out.
 *  - PROVISIONAL ledger: the confirmed ledger plus claims that are awaiting
 *    verification and member-reported (cash) expenses. Shown with a visible
 *    "unverified" status in the app.
 *  - Excluded: INITIATED (not paid yet), PENDING (outcome unknown), FAILED,
 *    CANCELLED, and voided expenses. PENDING items are listed as unresolved.
 */
const CONFIRMED_LEDGER = Object.freeze([STATES.CONFIRMED, STATES.REFUNDED, STATES.REVERSED]);
const PROVISIONAL_ONLY = Object.freeze([STATES.AWAITING_VERIFICATION, EXPENSE_VERIFICATION.MEMBER_REPORTED]);
const UNRESOLVED = Object.freeze([STATES.INITIATED, STATES.PENDING]);

function ledgerOf(verificationStatus) {
  if (CONFIRMED_LEDGER.includes(verificationStatus)) return "CONFIRMED";
  if (PROVISIONAL_ONLY.includes(verificationStatus)) return "PROVISIONAL";
  if (UNRESOLVED.includes(verificationStatus)) return "UNRESOLVED";
  return "EXCLUDED";
}

module.exports = { EXPENSE_VERIFICATION, EXPENSE_KINDS, CONFIRMED_LEDGER, PROVISIONAL_ONLY, UNRESOLVED, ledgerOf };
