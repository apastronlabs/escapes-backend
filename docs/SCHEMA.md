# Firestore schema

All collections are top-level (no unbounded arrays or subcollections on the trip
document). Every trip-scoped document has a `tripId` field, and every read path checks
the caller's ACTIVE membership of that trip first. Every document has
`schemaVersion` (currently `1`) and server timestamps (`createdAt`, `updatedAt`).

Clients should treat these collections as **read-only**; all writes go through the
callables. (Security Rules are managed separately in FlutterFlow and are not part of this
repo. Recommended: deny client writes to every collection below, and deny client reads
of `idempotencyKeys`, `paymentReferenceClaims` and `auditLogs`.)

Money: integer paise in `*Minor` fields. Currency: `INR` (trip-level).

| Collection | Doc id | Purpose |
|---|---|---|
| `users` | uid | **Owned by FlutterFlow.** Read only (display name). Never written by this backend. |
| `trips` | auto | Trip header |
| `tripMemberships` | `{tripId}_{uid}` | One per (trip, user); role + status |
| `invitations` | sha256(token) | Invitation; raw token never stored |
| `categories` | `{tripId}_{key}` (defaults) / auto | Trip-specific categories |
| `transactions` | auto | UPI payment attempts, refunds, reversals |
| `transactions/{id}/clientReports` | auto | Raw client-reported UPI responses, verbatim (≤ 20 per payment) |
| `expenses` | auto | Expenses and compensating adjustments |
| `expenseSplits` | `{expenseId}_{uid}` | One per participant share (for "what do I owe" queries) |
| `settlements` | auto | Member-to-member settlement payments |
| `reconciliationRecords` | auto | Unverified claims (client response, UTR, OCR, receipt, refund) awaiting review |
| `receipts` | auto | Registered receipt files (storage path only) |
| `paymentReferenceClaims` | sha256(`UTR:` + utr) | Global uniqueness guard for UTR / provider refs |
| `idempotencyKeys` | sha256(uid:operation:key) | Stored results of idempotent calls |
| `auditLogs` | auto | Append-only audit trail |

`webhookEvents` is intentionally absent: no provider webhook is integrated
(see [VERIFICATION.md](VERIFICATION.md)).

## Documents

**trips**: `tripId, name, description, currency, startDate, endDate (Timestamp | null), ownerUid, createdByUid, status (ACTIVE|ARCHIVED), memberCount, version`

**tripMemberships**: `membershipId, tripId, uid, role (OWNER|ADMIN|MEMBER), status (ACTIVE|REMOVED|LEFT), displayName, joinedVia (CREATOR|INVITATION), invitationId?, joinedAt, removedByUid?, removedAt?, previousStatus?`

**invitations**: `invitationId, tripId, role (MEMBER|ADMIN), email? (lowercase, requires verified matching email), maxUses, useCount, acceptedByUids[], status (ACTIVE|EXHAUSTED|REVOKED), createdByUid, expiresAt, revokedByUid?`

**categories**: `categoryId, tripId, key (default key or null), name, keywords[], isDefault, archived, sortOrder, createdByUid`

**transactions**
```
transactionId, tripId, kind (PAYMENT|REFUND|REVERSAL), purpose (MERCHANT|MEMBER_SETTLEMENT),
initiatedByUid,
payee { vpa, name, merchantCategoryCode, merchantRef, terminalId, url, qrSigned, source (QR|MANUAL_ENTRY|REFUND|REVERSAL), memberUid },
qrParams { ...raw QR params },
amountMinor, amountSource (QR_FIXED|USER_ENTERED), currency, upiApp, platform (ANDROID|IOS),
reference (internal, unique), intentRef, intentUri,
status, statusSetBy (CLIENT|TRUSTED), statusSource, statusHistory [{from,to,actor,source,actorUid,reason,at}],
clientReported { outcome, fields, platform, upiApp, anomalies, reportId, reportedAt } | null,   // untrusted
clientReportCount,
claims { utr, providerReference, receiptIds[], ocr }                                          // untrusted
anomalies [],
verification { status (UNVERIFIED|VERIFIED|REJECTED), source, verifiedByUid, verifiedAt, evidenceType?, note?, providerReference?, lastCheck? },
categoryId, expenseId, settlementId,
refundOfTransactionId, refundTransactionIds[], refundedMinor, pendingRefundMinor, reason?,
version, initiatedAt
```
`clientReported` / `claims` (what the client said) are kept separate from `status` /
`verification` (what the backend established).

**transactions/{id}/clientReports**: `reportId, transactionId, tripId, reportedByUid, platform, upiApp, rawResponse (verbatim, ≤ 4000 chars), normalizedOutcome, fields, anomalies, trusted: false`

**expenses**
```
expenseId, tripId, kind (STANDARD|REFUND_ADJUSTMENT|REVERSAL_ADJUSTMENT), title, merchantName,
amountMinor (negative for adjustments), currency, categoryId, categorySource (MANUAL|RULE_MCC|RULE_KEYWORD|DEFAULT),
paidByUid, createdByUid, participantUids[] (sorted), split { type, values }, shares { uid: paise },
notes, receiptIds[], expenseDate (Timestamp; defaults to creation time), transactionId, adjustsExpenseId,
verificationStatus (transaction states | MEMBER_REPORTED), verificationSource, reviewedByUid?, reviewNote?,
status (ACTIVE|VOIDED), voidReason?, voidedByUid?, version
```

**expenseSplits**: `splitId, tripId, expenseId, uid, shareMinor, paidByUid, verificationStatus, status (ACTIVE|REMOVED|VOIDED)`

**settlements**: `settlementId, tripId, fromUid, toUid, amountMinor, currency, method (UPI|CASH|BANK_TRANSFER|OTHER), transactionId?, status (PENDING|CONFIRMED|REJECTED|CANCELLED|FAILED), createdByUid, confirmedByUid?, note`

**reconciliationRecords**: `recordId, tripId, transactionId, claimType (CLIENT_RESPONSE|UTR|PROVIDER_REFERENCE|OCR|RECEIPT|REFUND|REVERSAL), submittedByUid, data, anomalies, status (OPEN|ACCEPTED|REJECTED), trusted: false, reviewedByUid?, reviewNote?`

**receipts**: `receiptId, tripId, uploadedByUid, storagePath (receipts/{tripId}/{uid}/{file}), contentType, sizeBytes, md5Hash`. No URL is stored.

**paymentReferenceClaims**: `type (UTR|PROVIDER_REF), transactionId, tripId, claimedByUid`

**idempotencyKeys**: `uid, operation, requestHash, result, expireAt`. Configure a TTL policy on `expireAt` (30 days):
`gcloud firestore fields ttls update expireAt --collection-group=idempotencyKeys --enable-ttl`

**auditLogs**: `auditId, tripId, actorUid, actorType (USER|SYSTEM), action, entityType, entityId, changes, metadata`

## Indexes

Composite indexes are in [`firestore.indexes.json`](../firestore.indexes.json):

| Collection | Fields | Used by |
|---|---|---|
| tripMemberships | uid ↑, status ↑ | listMyTrips |
| tripMemberships | tripId ↑, status ↑ | listMembers |
| invitations | tripId ↑, createdAt ↓ | listInvitations |
| expenses | tripId ↑, createdAt ↓ | listExpenses |
| expenses | tripId ↑, categoryId ↑, createdAt ↓ | listExpenses (by category) |
| expenseSplits | tripId ↑, uid ↑, status ↑ | client "my shares" queries |
| transactions | tripId ↑, createdAt ↓ (+ status, + initiatedByUid, + both) | listTransactions filters |
| reconciliationRecords | transactionId ↑, status ↑ | reconcileTransaction |
| reconciliationRecords | tripId ↑, status ↑, createdAt ↑ (+ submittedByUid) | listReconciliationQueue |
| settlements | tripId ↑, createdAt ↓ | listSettlements |
| auditLogs | tripId ↑, createdAt ↓ (+ entityId) | listAuditLogs |

Deploy with `firebase deploy --only firestore:indexes`. If FlutterFlow also manages
indexes for this project, merge rather than overwrite: run
`firebase firestore:indexes > current.json` first and combine.

## Scale notes

* Trip-level counters are limited to `memberCount` to avoid hot documents.
* `getTripSummary` reads a trip's expenses/settlements on demand (projection only) and
  refuses above 5,000 of either (`SUMMARY_TOO_LARGE`). Beyond that, maintain per-member
  aggregates incrementally in the same transactions.
* Lists are paginated with opaque cursors (`createdAt` + doc id).
