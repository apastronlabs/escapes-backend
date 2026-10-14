# Escapes backend: FlutterFlow wiring guide

This guide is for whoever (person or agent) wires the Escapes FlutterFlow app to its backend.
Part 1 covers the rules that apply to every call, Part 2 maps screens to function calls, and
Part 3 is the full reference of all 42 functions.

---

## Part 1. Rules for every call

### Setup

* Firebase project: `scaper-app-a2a49` (the Escapes app; the project ID can't change).
* All functions are **callable functions (v2)** in region **`asia-south1`**.
  In FlutterFlow, set the Cloud Functions region to `asia-south1`, or the call hits
  `us-central1` and fails with `not-found`.
  In custom code, use `FirebaseFunctions.instanceFor(region: 'asia-south1').httpsCallable('<name>')`.
* Every function requires a signed-in Firebase Auth user. Call them only after login.
* Function names are case-sensitive and exactly as listed in Part 3 (for example `createTrip`).

### The app reads Firestore directly, and writes only through functions

* **Reads:** for lists that should update live (trips, expenses, transactions, members),
  you may use Firestore queries filtered by `tripId`. The `list*` and `get*` functions
  return the same data and check membership for you.
* **Writes:** never create, update or delete documents in these collections from the app:
  `trips`, `tripMemberships`, `invitations`, `categories`, `transactions`, `expenses`,
  `expenseSplits`, `settlements`, `reconciliationRecords`, `receipts`,
  `paymentReferenceClaims`, `idempotencyKeys`, `auditLogs`. Every change goes through
  a function, which also writes the audit log.
* The `users` collection stays FlutterFlow's. The backend only reads `display_name` from it.

### Money

* All amounts are **integers in paise**, in fields ending in `Minor` (`amountMinor`).
  ₹250.50 is `25050`. Convert with `(rupees * 100).round()` before sending, and divide by
  100 for display. Never send decimals.
* Percentages in splits are **basis points**: 1% = `100`, and the total must be `10000`.

### Idempotency keys (functions marked 🔁)

* These functions need an `idempotencyKey` string of 8-128 characters.
* Generate **one UUID per user action** (for example when the "Save expense" screen opens
  or the button is first pressed) and store it in page state.
  **Reuse the same key if the call is retried** (network error, double tap).
  Make a new key only for a genuinely new action.
* A retry with the same key returns the original result with `idempotentReplay: true`
  and does not create a duplicate.

### Versions (optimistic concurrency)

* Documents that can be edited carry a `version` number. `updateTrip`, `updateExpense`,
  `voidExpense`, `reviewExpense` and `reconcileTransaction` take `expectedVersion`:
  send the `version` you displayed.
* `VERSION_CONFLICT` means someone else changed it first. Reload, show the new data, and
  let the user retry.

### Errors

* Failures arrive as `FirebaseFunctionsException` with `code` (for example
  `permission-denied`, `invalid-argument`, `failed-precondition`, `not-found`) and
  `details.reason`, a stable code. Show messages based on `details.reason`.
  The most useful ones:

| `details.reason` | Show the user |
|---|---|
| `NOT_A_MEMBER` | "You're not a member of this trip." Go back to the trip list. |
| `INSUFFICIENT_ROLE` | "Only the trip owner or an admin can do this." |
| `TRIP_ARCHIVED` | "This trip is archived. Restore it to make changes." |
| `VERSION_CONFLICT` | "This was changed by someone else. Refresh and try again." |
| `MISSING_FIELD`, `INVALID_FIELD`, `UNKNOWN_FIELD` | A bug in the call. `details.field` names the field. |
| `INVITATION_EXPIRED`, `INVITATION_REVOKED`, `INVITATION_EXHAUSTED` | "This invite link is no longer valid. Ask for a new one." |
| `INVITATION_EMAIL_MISMATCH` | "This invite is for a different email address." |
| `AMOUNT_TOO_LARGE` | "UPI payments are limited to ₹1,00,000." |
| `AMOUNT_MISMATCH_WITH_QR` | "This QR code has a fixed amount." Use the QR's amount. |
| `REFERENCE_ALREADY_CLAIMED` | "This UTR is already attached to another payment." |
| `SELF_RECONCILIATION_NOT_ALLOWED`, `SELF_REVIEW_NOT_ALLOWED` | "Someone else in the trip has to confirm this." |
| `OWNER_CANNOT_LEAVE` | "Transfer ownership before leaving the trip." |

* Don't send fields that aren't listed for a function: any extra field is rejected with
  `UNKNOWN_FIELD`. Omit optional fields rather than sending `null`, unless the reference says `null` is allowed.

### Payment status: what to show

| `status` | Label | Notes |
|---|---|---|
| `INITIATED` | "Started" | The UPI app may not have opened yet. |
| `PENDING` | "Not confirmed yet" | Outcome unknown. Offer "Did your payment go through?". |
| `AWAITING_VERIFICATION` | "Waiting for confirmation" | **Never show this as "Paid" or "Verified".** |
| `CONFIRMED` | "Confirmed" | The only status that means verified. |
| `FAILED` | "Failed" | |
| `CANCELLED` | "Cancelled" | |
| `REFUNDED` / `REVERSED` | "Refunded" / "Reversed" | |

Expenses without a UPI payment (cash or card) show `verificationStatus: MEMBER_REPORTED`
("Added by member") until an admin reviews them.

---

## Part 2. Screens and when to call each function

### App start and trip list

* **Trip list screen (on load):** `listMyTrips`. It returns each trip with `myRole`.
  Use `myRole` (OWNER / ADMIN / MEMBER) to show or hide admin-only buttons everywhere.
* **"New trip" form (on Save):** `createTrip` 🔁, then navigate to the trip with the returned `tripId`.
  Default categories are created automatically.

### Trip home

* **On load:** `getTrip` (trip details plus `myRole`) and `getTripSummary` (totals, balances
  and who-owes-whom suggestions).
* `getTripSummary` returns two ledgers. Show **`confirmed`** balances as the real ones.
  You may show **`provisional`** as "including payments waiting for confirmation".
  `unresolved` lists payments still `INITIATED`/`PENDING`. Show them as a to-do list.
* **Edit trip (O/A):** `updateTrip` with `expectedVersion`. Archive with `status: "ARCHIVED"`,
  restore with `status: "ACTIVE"`.

### Members and invitations

* **Members screen (on load):** `listMembers`.
* **Invite button (O/A):** `createInvitation` 🔁. The response's `token` is shown **only once**.
  Build your invite link from it (for example a deep link `https://<your-domain>/join?token=<token>`)
  and open the share sheet straight away. If the token is lost, revoke it and create a new one.
* **Join screen (deep link opened, user signed in):** `acceptInvitation` with the `token`
  from the link. Navigate to the returned `tripId`. `alreadyMember: true` is fine; just open the trip.
* **Pending invites (O/A):** `listInvitations`; a revoke button calls `revokeInvitation`.
* **Member actions:** change role (owner only) `updateMemberRole`; make owner `transferOwnership`;
  remove `removeMember`; "Leave trip" (not the owner) `leaveTrip`.

### Categories

* **Category picker (on open):** `listCategories`.
* **"Add category":** `createCategory` 🔁. Edit, archive or restore: `updateCategory`.
* **Auto-suggest:** when the user has typed a merchant name or description on the expense
  form, call `suggestCategory` and preselect the returned `categoryId`. The user can still change it.
  If you omit `categoryId` on `createExpense`, the backend picks one the same way.

### Expenses (cash, card, or anything not paid through UPI in the app)

* **Expense list (on load / scroll):** `listExpenses`, passing `nextCursor` back as `cursor`
  for the next page. Optional `categoryId` filter.
* **Expense detail:** `getExpense`.
* **Add expense (on Save):** `createExpense` 🔁 with `title`, `amountMinor`, `participantUids`, and optionally
  `split`, `paidByUid` (admins only, for someone else), `categoryId`, `notes`, `expenseDate`, `receiptIds`.
  * Equal split: omit `split`.
  * Exact amounts: `split: {type: "AMOUNT", values: {uid1: 30000, uid2: 20000}}`. The values must add up to `amountMinor`.
  * Percentages: `split: {type: "PERCENTAGE", values: {uid1: 6000, uid2: 4000}}`. The values must add up to 10000.
* **Edit expense:** `updateExpense` with `expectedVersion`. Amount and payer can only change on
  unconfirmed cash/card expenses.
* **Delete expense:** `voidExpense` with a `reason`. It is kept and marked VOIDED; confirmed expenses can't be voided.
* **Admin review of a cash/card expense:** `reviewExpense`. The reviewer must be an admin who
  didn't pay or create the expense.

### Receipts (photos or PDFs)

1. Upload the file with the Firebase Storage upload action to
   **`receipts/{tripId}/{currentUserUid}/{fileName}`** (jpeg, png, webp, heic or pdf, up to 10 MB).
2. Call `registerReceipt` 🔁 with that `storagePath`. Keep the returned `receiptId`.
3. Pass `receiptIds` to `createExpense` / `updateExpense`, or `receiptId` to `submitPaymentReference`.
4. To display a receipt, call `getReceiptUrl`. The URL expires after 5 minutes, so fetch it when the image opens.

### Paying with UPI (the main flow)

Firebase does **not** make the payment. The user's UPI app does. The backend records the attempt
and decides when it counts as confirmed.

1. **Get the payee.** Scan a UPI QR code and send its full text as `qrPayload`, or let the user
   type a UPI ID as `payeeVpa` (plus `payeeName`).
   For paying a trip member back, use `purpose: "MEMBER_SETTLEMENT"` and `payeeUid`.
2. **Review screen (required).** Show the payee name, UPI ID and amount, and get the user to
   tap "Confirm". Only then call `initiateUpiPayment` 🔁 with `reviewConfirmed: true`, `platform`
   (`ANDROID` or `IOS`), `amountMinor` (unless the QR fixes the amount), and optionally an
   `expense: {title, participantUids, split?}` so the expense is created together with the payment.
3. **Open the UPI app** with the returned `intentUri` (needs a custom action or package that
   launches `upi://pay` links). Save `transactionId` in page or app state before leaving the app.
4. **When the user comes back:**
   * **Android:** if the UPI app returned a response, send it unchanged as `rawResponse`
     (string or map) to `recordUpiClientResponse` 🔁. If nothing came back, send `rawResponse: null`.
   * **iOS:** UPI apps don't send anything back. Call `recordUpiClientResponse` 🔁 with `rawResponse: null`.
   * Never decide on the phone that the payment succeeded. Show the `status` the function returns.
5. **"Did your payment go through?" screen.** Show it on iOS every time, and on Android whenever the
   returned status is `PENDING`.
   * **Yes:** ask for the 12-digit UTR (UPI reference number) and/or a screenshot. Call
     `submitPaymentReference` 🔁 with `utr`, and/or `receiptId` (upload and register the screenshot first).
     If the app reads the screenshot with on-device OCR, send what it found in `ocr`.
     The status becomes "Waiting for confirmation".
   * **No:** `cancelTransaction`.
   * **Not sure:** do nothing. It stays "Not confirmed yet" and shows under `unresolved`.
6. **Confirming.** A trip owner or admin who is **not** the payer opens the confirmation queue
   (`listReconciliationQueue`), checks the evidence (bank statement, merchant receipt), and calls
   `reconcileTransaction` with `decision: "CONFIRM"` or `"REJECT"`, `evidenceType`, a `note`,
   `confirmedAmountMinor` (must equal the payment amount) and `expectedVersion`.
   For a payment to a trip member, only **the member who received it** can confirm it.
   (`verifyTransaction` exists for a future payment provider. Today it always replies that
   automatic verification isn't available, so you don't need a button for it.)
7. **Payment history:** `listTransactions` (filters `status`, `mine`); detail `getTransaction`.

### Refunds

* On a **confirmed** merchant payment, a "Record refund" button (payer, owner or admin) calls
  `recordRefund` 🔁 with `kind: "REFUND"` (or `"REVERSAL"`), `amountMinor` and a `reason`.
  The refund then needs confirming like any payment (`reconcileTransaction` on the refund's `transactionId`).

### Settling up

* **Settle-up screen:** show `getTripSummary().confirmed.suggestions` (who should pay whom, and how much).
* **Paid by UPI:** use the UPI flow above with `purpose: "MEMBER_SETTLEMENT"` and `payeeUid`.
* **Paid in cash or bank transfer:** the payer calls `recordSettlement` 🔁 (`toUid`, `amountMinor`, `method`).
  The receiver then calls `confirmSettlement` (or `rejectSettlement`). The payer can `cancelSettlement` while it is pending.
* **History:** `listSettlements`.

### Activity log

* **Trip activity screen:** `listAuditLogs` (optionally `entityId` to show the history of one expense or payment).

### Things the app must never do

* Ask for, read or store a UPI PIN, OTP or card details. No function accepts them.
* Show a payment as "Paid" or "Verified" unless its `status` is `CONFIRMED`.
* Write to the backend's Firestore collections directly.
* Retry a 🔁 call with a new idempotency key (that can create duplicates).

---

## Part 3. Function reference


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

### Trips

| Function | Who | Input | Output |
|---|---|---|---|
| `createTrip` 🔁 | any signed-in user | `name`, `description?`, `currency?` (INR), `startDate?`, `endDate?` | `{ tripId }`. Caller becomes OWNER; default categories are seeded for this trip. |
| `updateTrip` | O, A | `tripId`, `name?`, `description?`, `startDate?`, `endDate?`, `status?` (ACTIVE/ARCHIVED), `expectedVersion?` | `{ tripId, version }` |
| `getTrip` | member | `tripId` | `{ trip, myRole }` |
| `listMyTrips` | any | none | `{ trips: [...trip, myRole] }` (active memberships only) |

### Invitations and membership

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

### Categories

| Function | Who | Input | Output |
|---|---|---|---|
| `listCategories` | member | `tripId`, `includeArchived?` | `{ categories }` |
| `createCategory` 🔁 | member | `tripId`, `name`, `keywords?` (≤ 50) | `{ categoryId }` |
| `updateCategory` | member (archive/restore: O, A) | `tripId`, `categoryId`, `name?`, `keywords?`, `archived?` | `{ categoryId }`. "Other" can't be archived. |
| `suggestCategory` | member | `tripId`, `merchantName?`, `description?`, `merchantCategoryCode?` | `{ categoryId, source (RULE_MCC/RULE_KEYWORD/DEFAULT), matched }` (deterministic) |

### Expenses

| Function | Who | Input | Output |
|---|---|---|---|
| `createExpense` 🔁 | member; `paidByUid` ≠ caller needs O/A | `tripId`, `title`, `amountMinor` (unless `transactionId`), `participantUids[]`, `split?` (`{type: EQUAL}` default, `{type: AMOUNT, values}`, `{type: PERCENTAGE, values (bps)}`), `paidByUid?`, `merchantName?`, `categoryId?` (auto if omitted), `notes?`, `expenseDate?`, `receiptIds?`, `currency?`, `transactionId?` | `{ expenseId, verificationStatus, shares, categoryId }`. Linking a payment: same trip, merchant payment, not linked yet, payer = initiator, amount = payment amount. |
| `updateExpense` | creator, payer, O, A | `tripId`, `expenseId`, `expectedVersion`, any of `title, merchantName, categoryId, notes, expenseDate, receiptIds, participantUids, split`; `amountMinor`/`paidByUid` only for unconfirmed member-reported expenses (payer change needs O/A) | `{ expenseId, version, shares }` |
| `voidExpense` | creator, payer, O, A | `tripId`, `expenseId`, `expectedVersion`, `reason` | `{ expenseId, status: "VOIDED", version }`. Not for confirmed expenses. |
| `reviewExpense` | O, A who is neither payer nor creator | `tripId`, `expenseId`, `expectedVersion`, `note` | `{ expenseId, verificationStatus: "CONFIRMED" }` (member-reported expenses only) |
| `getExpense` | member | `tripId`, `expenseId` | `{ expense }` |
| `listExpenses` | member | `tripId`, `categoryId?`, `pageSize?` (≤ 100), `cursor?` | `{ expenses, nextCursor }` |

### UPI transactions

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

### Receipts

| Function | Who | Input | Output |
|---|---|---|---|
| `registerReceipt` 🔁 | member | `tripId`, `storagePath` = `receipts/{tripId}/{callerUid}/{fileName}` (upload it first with the Storage SDK) | `{ receiptId }`. Size/type read from Storage metadata server-side (jpeg/png/webp/heic/pdf, ≤ 10 MB). |
| `getReceiptUrl` | member | `tripId`, `receiptId` | `{ url, expiresAt }`. V4 signed URL valid 5 minutes. |

### Settlements and summaries

| Function | Who | Input | Output |
|---|---|---|---|
| `getTripSummary` | member | `tripId` | `{ totals {confirmedSpendMinor, provisionalSpendMinor, unverifiedSpendMinor, unresolvedCount}, byCategory, confirmed {balances, suggestions, outstandingMinor}, provisional {...}, unresolved }` |
| `recordSettlement` 🔁 | member (payer = caller) | `tripId`, `toUid`, `amountMinor`, `method` (CASH/BANK_TRANSFER/OTHER), `note?` | `{ settlementId, status: "PENDING" }` |
| `confirmSettlement` / `rejectSettlement` | receiving member | `tripId`, `settlementId`, `note?` | `{ settlementId, status }` |
| `cancelSettlement` | paying member | `tripId`, `settlementId`, `note?` | `{ settlementId, status: "CANCELLED" }` |
| `listSettlements` | member | `tripId` | `{ settlements }` |

### Audit

| Function | Who | Input | Output |
|---|---|---|---|
| `listAuditLogs` | member | `tripId`, `entityId?`, `pageSize?`, `cursor?` | `{ entries, nextCursor }` |

Every write path appends an `auditLogs` entry in the same Firestore transaction as the change.

### Not exposed

* `applyAdapterResult` (trusted verification entry point) is server-only.
* No HTTP (`onRequest`) endpoints exist, because no provider webhook is integrated.
