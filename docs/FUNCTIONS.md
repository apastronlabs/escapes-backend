# Cloud Functions reference

All 42 functions are **Firebase callable functions (v2)** in `asia-south1` (Mumbai). Call them
from FlutterFlow with a Cloud Function action, or in Flutter with
`FirebaseFunctions.instanceFor(region: 'asia-south1').httpsCallable(name)`.
The region must be set on the client; the default instance calls us-central1.

Common to every function:

* **Auth**: Firebase Authentication required (`unauthenticated` otherwise).
* **Trip access**: the caller must be an ACTIVE member of the trip; otherwise
  `permission-denied / NOT_A_MEMBER` (the same error for trips that don't exist).
  Payment ids from trips you're not in return `not-found`.
* **Validation**: unknown fields are rejected (`UNKNOWN_FIELD`); ids match `[A-Za-z0-9_-]{1,128}`.
* **Idempotency**: functions marked 🔁 require `idempotencyKey` (8-128 chars, e.g. a UUID
  generated once per user action and reused on retries). A retry returns the original
  result with `idempotentReplay: true`; reusing a key with a different payload gives
  `already-exists / IDEMPOTENCY_KEY_REUSED`.
* **Errors**: `HttpsError` with `details.reason` (stable machine-readable code).
* **Archived trips** are read-only (`TRIP_ARCHIVED`) except for reads, restoring, and member exits.
* Amounts are integer paise (`*Minor`). Timestamps in responses are ISO-8601 strings.

Roles: **O** = OWNER, **A** = ADMIN, **M** = MEMBER.

## Trips

| Function | Who | Input | Output |
|---|---|---|---|
| `createTrip` 🔁 | any signed-in user | `name`, `description?`, `currency?` (INR), `startDate?`, `endDate?` | `{ tripId }`. Caller becomes OWNER; default categories are seeded for this trip. |
| `updateTrip` | O, A | `tripId`, `name?`, `description?`, `startDate?`, `endDate?`, `status?` (ACTIVE/ARCHIVED), `expectedVersion?` | `{ tripId, version }` |
| `getTrip` | member | `tripId` | `{ trip, myRole }` |
| `listMyTrips` | any | none | `{ trips: [...trip, myRole] }` (active memberships only) |

## Invitations and membership

| Function | Who | Input | Output |
|---|---|---|---|
| `createInvitation` 🔁 | O, A (only O can invite ADMIN) | `tripId`, `role?` (MEMBER/ADMIN), `email?`, `ttlHours?` (default 168, max 720), `maxUses?` (1-50; 1 if `email`) | `{ invitationId, token, expiresAt }`. `token` is returned once; only its hash is stored. |
| `acceptInvitation` | any signed-in user | `token` | `{ tripId, role, alreadyMember }`. Email-bound invites need the same **verified** email. |
| `revokeInvitation` | O, A | `tripId`, `invitationId` | `{ invitationId, status: "REVOKED" }` |
| `listInvitations` | O, A | `tripId` | `{ invitations }` (no tokens) |
| `listMembers` | member | `tripId`, `includeFormer?` | `{ members }` |
| `updateMemberRole` | O | `tripId`, `uid`, `role` (ADMIN/MEMBER) | `{ uid, role }` |
| `transferOwnership` | O | `tripId`, `uid` | `{ tripId, ownerUid }` (old owner becomes ADMIN) |
| `removeMember` | O, A (only O removes admins; nobody removes O) | `tripId`, `uid` | `{ uid, status: "REMOVED" }`. History and balances are kept. |
| `leaveTrip` | member (not O) | `tripId` | `{ tripId, status: "LEFT" }` |

## Categories

| Function | Who | Input | Output |
|---|---|---|---|
| `listCategories` | member | `tripId`, `includeArchived?` | `{ categories }` |
| `createCategory` 🔁 | member | `tripId`, `name`, `keywords?` (≤ 50) | `{ categoryId }` |
| `updateCategory` | member (archive/restore: O, A) | `tripId`, `categoryId`, `name?`, `keywords?`, `archived?` | `{ categoryId }`. "Other" can't be archived. |
| `suggestCategory` | member | `tripId`, `merchantName?`, `description?`, `merchantCategoryCode?` | `{ categoryId, source (RULE_MCC/RULE_KEYWORD/DEFAULT), matched }` (deterministic) |

## Expenses

| Function | Who | Input | Output |
|---|---|---|---|
| `createExpense` 🔁 | member; `paidByUid` ≠ caller needs O/A | `tripId`, `title`, `amountMinor` (unless `transactionId`), `participantUids[]`, `split?` (`{type: EQUAL}` default, `{type: AMOUNT, values}`, `{type: PERCENTAGE, values (bps)}`), `paidByUid?`, `merchantName?`, `categoryId?` (auto if omitted), `notes?`, `expenseDate?`, `receiptIds?`, `currency?`, `transactionId?` | `{ expenseId, verificationStatus, shares, categoryId }`. Linking a payment: same trip, merchant payment, not linked yet, payer = initiator, amount = payment amount. |
| `updateExpense` | creator, payer, O, A | `tripId`, `expenseId`, `expectedVersion`, any of `title, merchantName, categoryId, notes, expenseDate, receiptIds, participantUids, split`; `amountMinor`/`paidByUid` only for unconfirmed member-reported expenses (payer change needs O/A) | `{ expenseId, version, shares }` |
| `voidExpense` | creator, payer, O, A | `tripId`, `expenseId`, `expectedVersion`, `reason` | `{ expenseId, status: "VOIDED", version }`. Not for confirmed expenses. |
| `reviewExpense` | O, A who is neither payer nor creator | `tripId`, `expenseId`, `expectedVersion`, `note` | `{ expenseId, verificationStatus: "CONFIRMED" }` (member-reported expenses only) |
| `getExpense` | member | `tripId`, `expenseId` | `{ expense }` |
| `listExpenses` | member | `tripId`, `categoryId?`, `pageSize?` (≤ 100), `cursor?` | `{ expenses, nextCursor }` |

## UPI transactions

| Function | Who | Input | Output |
|---|---|---|---|
| `initiateUpiPayment` 🔁 | member | `tripId`, `platform` (ANDROID/IOS), `reviewConfirmed: true`, **either** `qrPayload` **or** `payeeVpa` (+`payeeName?`), `amountMinor?` (required unless the QR fixes it), `purpose?` (MERCHANT default / MEMBER_SETTLEMENT + `payeeUid`), `upiApp?`, `note?`, `categoryId?`, `expense?` (`{title, participantUids, split?, notes?, categoryId?, ...}`) | `{ transactionId, reference, intentUri, amountMinor, currency, payee, status: "INITIATED", expenseId, settlementId }` |
| `recordUpiClientResponse` 🔁 | payer only | `transactionId`, `platform`, `rawResponse` (string / map / null), `upiApp?`, `userCancelled?` | `{ transactionId, status, transitioned, clientOutcome, anomalies, verified: false }`. Never confirms. |
| `submitPaymentReference` 🔁 | payer only | `transactionId`, at least one of `utr` (12 digits), `providerReference`, `receiptId`, `ocr` (`{utr?, amountMinor?, payeeVpa?, payeeName?, paidAtText?, status?, rawText?, engine?}`) | `{ transactionId, status, reconciliationRecordIds, anomalies, verified: false }`. A UTR already attached to another payment → `REFERENCE_ALREADY_CLAIMED`. |
| `cancelTransaction` | payer only | `transactionId`, `reason?` | `{ transactionId, status: "CANCELLED" }` (from INITIATED/PENDING) |
| `verifyTransaction` | payer, O, A | `transactionId` | With the default adapter: `{ verificationAvailable: false, status, message }`. With a provider: `{ applied, status, reason? }` |
| `reconcileTransaction` | merchant payments/refunds: O/A other than the payer; settlement payments: the receiving member | `transactionId`, `decision` (CONFIRM/REJECT), `evidenceType` (BENEFICIARY_STATEMENT/MERCHANT_CONFIRMATION/PAYER_BANK_STATEMENT/PROVIDER_DASHBOARD/OTHER), `note`, `confirmedAmountMinor` (CONFIRM; must equal), `expectedVersion` | `{ transactionId, status, verificationSource }` |
| `recordRefund` 🔁 | payer, O, A | `transactionId` (CONFIRMED merchant payment), `kind` (REFUND/REVERSAL), `amountMinor`, `reason`, `reference?` | `{ transactionId (the refund record), kind, status: "AWAITING_VERIFICATION", adjustmentExpenseId }` |
| `getTransaction` | member | `transactionId`, `includeReports?` | `{ transaction, clientReports? }` |
| `listTransactions` | member | `tripId`, `status?`, `mine?`, `pageSize?`, `cursor?` | `{ transactions, nextCursor }` |
| `listReconciliationQueue` | member (O/A see all; others see their own) | `tripId` | `{ records }` (OPEN) |

## Receipts

| Function | Who | Input | Output |
|---|---|---|---|
| `registerReceipt` 🔁 | member | `tripId`, `storagePath` = `receipts/{tripId}/{callerUid}/{fileName}` (upload it first with the Storage SDK) | `{ receiptId }`. Size/type read from Storage metadata server-side (jpeg/png/webp/heic/pdf, ≤ 10 MB). |
| `getReceiptUrl` | member | `tripId`, `receiptId` | `{ url, expiresAt }`. V4 signed URL valid 5 minutes. |

## Settlements and summaries

| Function | Who | Input | Output |
|---|---|---|---|
| `getTripSummary` | member | `tripId` | `{ totals {confirmedSpendMinor, provisionalSpendMinor, unverifiedSpendMinor, unresolvedCount}, byCategory, confirmed {balances, suggestions, outstandingMinor}, provisional {...}, unresolved }` |
| `recordSettlement` 🔁 | member (payer = caller) | `tripId`, `toUid`, `amountMinor`, `method` (CASH/BANK_TRANSFER/OTHER), `note?` | `{ settlementId, status: "PENDING" }` |
| `confirmSettlement` / `rejectSettlement` | receiving member | `tripId`, `settlementId`, `note?` | `{ settlementId, status }` |
| `cancelSettlement` | paying member | `tripId`, `settlementId`, `note?` | `{ settlementId, status: "CANCELLED" }` |
| `listSettlements` | member | `tripId` | `{ settlements }` |

## Audit

| Function | Who | Input | Output |
|---|---|---|---|
| `listAuditLogs` | member | `tripId`, `entityId?`, `pageSize?`, `cursor?` | `{ entries, nextCursor }` |

Every write path appends an `auditLogs` entry in the same Firestore transaction as the change.

## Not exposed

* `applyAdapterResult` (trusted verification entry point) is server-only.
* No HTTP (`onRequest`) endpoints exist, because no provider webhook is integrated.
