# Splitting, balances and settlements

All amounts are **integer minor units** (paise). No floats anywhere.

## Split types (`functions/src/domain/splits.js`)

| Type | Input | Rule |
|---|---|---|
| `EQUAL` | participants | `floor(amount / n)` each; the leftover paise (< n) go one each to participants in ascending uid order |
| `PERCENTAGE` | `values: { uid: basisPoints }` (1% = 100) | must total exactly 10000; `floor(amount × bps / 10000)` each; leftover paise by largest fractional remainder, ties by ascending uid |
| `AMOUNT` | `values: { uid: paise }` | non-negative integers that must sum exactly to the amount; no rounding |

Invariant, checked on every write: **sum of shares == expense amount**.
Ordering by uid makes results independent of the order the client sent.
Examples: ₹100.00 / 3 → 3334, 3333, 3333. 33.33/33.33/33.34% of 1000 → 333, 333, 334.

## Editing expenses

* `updateExpense` requires `expectedVersion` (optimistic concurrency; stale edits get
  `VERSION_CONFLICT`).
* Title, merchant, category, notes, date, receipts, participants and split can be changed
  by the creator, the payer or a trip admin. Shares are recalculated from the unchanged amount.
* Removing a participant writes their `expenseSplits` doc as `REMOVED` with share 0
  (nothing is deleted). Changing participants of a non-equal split requires a new split.
* Amount and payer can only change on member-reported (non-UPI) expenses that are not
  confirmed. For a UPI-linked or confirmed expense they are immutable (`AMOUNT_IMMUTABLE`).
* Only an admin can attribute a payment to someone other than themselves
  (`CANNOT_ASSIGN_PAYER`). The payer of a UPI expense must be the payment's initiator.
* Unconfirmed expenses can be voided (kept, marked `VOIDED`). Confirmed ones cannot.

## Verification status of an expense

* Linked to a UPI transaction: mirrors the transaction's state.
* No transaction (cash/card/other): `MEMBER_REPORTED`. A trip admin who is neither the
  payer nor the creator can mark it `CONFIRMED` with `reviewExpense` (`MANUAL_REVIEW`).

## Ledgers (`functions/src/domain/ledger.js`)

`getTripSummary` computes everything twice:

| Ledger | Includes |
|---|---|
| **confirmed** | expenses `CONFIRMED`, `REFUNDED`, `REVERSED` (+ their confirmed adjustments); settlements `CONFIRMED` |
| **provisional** | confirmed + `AWAITING_VERIFICATION` + `MEMBER_REPORTED`; settlements `PENDING` |
| unresolved (listed only) | `INITIATED`, `PENDING` |
| excluded | `FAILED`, `CANCELLED`, voided |

The app should show the provisional figures with a clear "includes unverified
payments" label. Unverified payments never appear in the confirmed ledger.

## Balances and settlement suggestions (`functions/src/domain/settlement.js`)

`net[uid] = paid − share + settlementsSent − settlementsReceived`. Positive: the
group owes them. Nets always sum to zero. Suggestions use a greedy largest-debtor →
largest-creditor match (at most n−1 transfers, deterministic by uid).
`outstandingMinor` is the trip's remaining amount to settle (sum of positive nets).
Removed/left members keep their balance and appear with their membership status.

Settlements between members:
* Cash/bank/other: `recordSettlement` (payer is always the caller) → `PENDING` →
  receiver `confirmSettlement` / `rejectSettlement`; payer may `cancelSettlement`.
* UPI: `initiateUpiPayment` with `purpose: MEMBER_SETTLEMENT, payeeUid` → confirmed by the
  receiver through `reconcileTransaction`.

No balance, wallet or escrow is held anywhere; balances are derived from records.

## Refunds and reversals

Confirmed history is never rewritten. `recordRefund` (kind `REFUND` or `REVERSAL`):

1. requires the original payment to be `CONFIRMED`, and the amount ≤ amount − refunded − pending refunds;
2. creates a **separate** transaction (`kind: REFUND|REVERSAL`, `refundOfTransactionId`) in
   `AWAITING_VERIFICATION`, plus an OPEN reconciliation record;
3. if the payment has an expense, creates a **negative adjustment expense** with the same
   payer and shares proportional to the original split (largest-remainder rounding).

When the refund is confirmed (adapter or reconciliation by someone other than its
recorder), the original's `refundedMinor` increases; once fully refunded the original moves
to `REFUNDED`/`REVERSED`. Its `amountMinor` never changes. If the refund claim is
rejected, its pending amount is released and the adjustment is excluded.
