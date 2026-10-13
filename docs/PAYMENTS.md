# UPI Intent payments

Firebase never executes a UPI payment. The user's UPI app (PhonePe, Google Pay,
Paytm, BHIM, ...) does, after the user authorizes it with their own UPI PIN.
The backend only:

1. validates the payee and amount and creates an `INITIATED` record,
2. hands the client a server-built `upi://pay` URI,
3. stores whatever the client later reports, as an **untrusted claim**,
4. changes the payment to `CONFIRMED` only through a trusted path
   (a verification adapter, or manual reconciliation by someone other than the payer).

UPI PINs, OTPs, card data and any payment authentication secret are never accepted
or stored. No callable has a field for them, and `onlyKeys` rejects unknown fields.

## Flow

```
App                                   Backend (callables)                       Firestore
---                                   -------------------                       ---------
scan QR / pick member
review payee + amount  ── initiateUpiPayment(reviewConfirmed:true) ──►  validate QR/VPA/amount
                                                                          transactions/{id} INITIATED
                       ◄── { transactionId, reference, intentUri } ──   (+ expense, + settlement)
launch UPI app with intentUri
  Android: activity result (maybe)
  iOS: usually nothing comes back
report outcome         ── recordUpiClientResponse(rawResponse) ──────►  clientReports/{id} (raw, verbatim)
                                                                          status -> AWAITING_VERIFICATION | PENDING | FAILED
"Did your payment go through?"
  UTR / receipt / OCR  ── submitPaymentReference ────────────────────►  reconciliationRecords (OPEN)
                                                                          status -> AWAITING_VERIFICATION
                                                                       ┌─ verifyTransaction (adapter; "none" = unavailable)
trusted paths only ────────────────────────────────────────────────────┤
                                                                       └─ reconcileTransaction (admin ≠ payer, or receiving member)
                                                                          status -> CONFIRMED | FAILED
```

## States

| State | Meaning | Who can set it |
|---|---|---|
| `INITIATED` | Record created, UPI app may not have been opened yet | initiateUpiPayment |
| `PENDING` | Outcome unknown (no response, `SUBMITTED`, unrecognized, or conflicting response) | client report, trusted |
| `AWAITING_VERIFICATION` | User/app *claims* success or submitted a UTR/receipt; not verified | client report or claim |
| `CONFIRMED` | Independently verified, or manually reconciled by someone other than the payer | **trusted only** |
| `FAILED` | Client-reported failure, or rejected by a trusted path | client, trusted |
| `CANCELLED` | Payer cancelled before paying | client (payer) |
| `REFUNDED` | Confirmed payment fully refunded (via confirmed refund records) | trusted only |
| `REVERSED` | Confirmed payment fully reversed (via confirmed reversal records) | trusted only |

Transitions are defined in `functions/src/domain/paymentStates.js` and enforced in one
place (`applyStatus` in `functions/src/services/transactionCore.js`):

| From | Client may move to | Trusted may move to |
|---|---|---|
| INITIATED | AWAITING_VERIFICATION, PENDING, FAILED, CANCELLED | CONFIRMED, FAILED, PENDING |
| PENDING | AWAITING_VERIFICATION, FAILED, CANCELLED | CONFIRMED, FAILED |
| AWAITING_VERIFICATION | (none) | CONFIRMED, FAILED, PENDING |
| FAILED | AWAITING_VERIFICATION (late UTR claim) | CONFIRMED (late success) |
| CANCELLED | AWAITING_VERIFICATION (late UTR claim) | CONFIRMED (late success) |
| CONFIRMED | (none) | REFUNDED, REVERSED |
| REFUNDED, REVERSED | (none) | (none) |

A status set by a trusted source can never be changed by the client
(`STATUS_LOCKED_BY_TRUSTED_SOURCE`). No callable accepts a target status from the client.

How client outcomes map (`CLIENT_OUTCOME_TARGET` in `services/transactions.js`):

| Normalized outcome | Example payload | Target |
|---|---|---|
| SUCCESS_CLAIMED | `Status=SUCCESS`, or only `responseCode=00` | AWAITING_VERIFICATION |
| SUBMITTED | `Status=SUBMITTED` / `PENDING` | PENDING |
| FAILURE | `Status=FAILURE` / `FAILED` | FAILED |
| NO_RESPONSE / USER_CANCELLED | `null` result (back pressed, iOS) | PENDING |
| UNRECOGNIZED | anything else, or status and code disagree | PENDING |

If the response's `txnRef` doesn't match the `tr` the app was launched with, the
anomaly `REFERENCE_MISMATCH` is recorded and a success claim is downgraded to PENDING.

## QR and amount validation (`functions/src/domain/upiQr.js`)

* Only `upi://pay?...` is accepted. `upi://mandate`, other UPI actions, EMVCo/Bharat QR
  (`000201...`) and URLs are rejected with a specific `reason`.
* `pa` (VPA) is required and pattern-checked; `cu` must be absent or `INR`;
  `am`/`mam` must be positive with at most 2 decimals; repeated parameters are rejected.
* A QR amount (`am`) is **fixed**: a client amount that differs is rejected
  (`AMOUNT_MISMATCH_WITH_QR`). With `mam` (minimum amount) the user may enter an amount ≥ minimum.
  Without `am`, a user-entered amount is required.
* Per-payment cap: `UPI_MAX_AMOUNT_MINOR` (default ₹1,00,000).
* `reviewConfirmed: true` is required: the app must show payee name, VPA and amount
  and get an explicit confirmation before calling `initiateUpiPayment`.
* Signed QR (`sign=`) is stored as `qrSigned: true` but **not verified**: that needs
  the PSP's public key, which this backend doesn't have.
* The returned `intentUri` is rebuilt from validated fields only. A merchant's own `tr`
  is preserved. The internal reference is added as `tr` only if
  `UPI_ATTACH_INTERNAL_REF=true` (off by default: some apps treat `tr` as a merchant
  order id and may reject it for non-merchant VPAs; confirm with your target apps first).

Each attempt gets a unique Firestore `transactionId` and a 16-char internal
`reference` (`SCP` + 13 chars).

## Platform-specific callback handling (client dependencies)

These depend on the FlutterFlow custom action / plugin you choose. **Confirm the
behaviour of that plugin with each target UPI app before relying on it.** The backend
deliberately accepts any shape (`rawResponse`: string, map or `null`) and stores it verbatim.

**Android.** The usual pattern is launching an `ACTION_VIEW` intent for the
`upi://pay` URI with `startActivityForResult` (or a plugin that does so) and reading the
`response` extra (a `key=value&...` string) from the result. In practice:
key names and casing differ (`Status`/`status`, `txnRef`/`tr`, `ApprovalRefNo`), some apps
return nothing, and nothing in the payload is signed. Send the raw string or map to
`recordUpiClientResponse`; never interpret it on the client as proof.

**iOS.** There is no Android-style activity result. UPI apps are opened through their
own URL schemes / universal links (plugin-specific), and the app usually gets no
transaction result when the user returns. On return:

1. call `recordUpiClientResponse` with `rawResponse: null` (→ `PENDING`), then
2. show **"Did your payment go through?"** with:
   * **Yes**: paste/enter the 12-digit UTR (`submitPaymentReference.utr`) and/or upload
     a screenshot (`registerReceipt` then `submitPaymentReference.receiptId`). If the app
     runs on-device OCR (e.g. ML Kit), send the extracted fields in
     `submitPaymentReference.ocr`; they are stored as an unverified claim and compared
     against the record only to flag `OCR_AMOUNT_MISMATCH` / `OCR_PAYEE_MISMATCH`.
   * **No**: `cancelTransaction`.
   * **Not sure**: leave it `PENDING`; it shows as unresolved in the summary.

The same "Did your payment go through?" screen should be used on Android whenever
the result is `null` or unrecognized.

## Manual reconciliation

`reconcileTransaction` (CONFIRM / REJECT) is the fallback when no verification
provider exists. Rules:

* Merchant payments and refunds: caller must be OWNER/ADMIN **and not the payer**.
* Member-to-member settlement payments: only the **receiving member** can confirm
  (beneficiary-side confirmation, `BENEFICIARY_CONFIRMATION`).
* The reviewer must type the amount they saw on the evidence (`confirmedAmountMinor`);
  it must equal the record, otherwise nothing changes.
* `expectedVersion` is required so concurrent changes are not overwritten.
* All OPEN reconciliation records for the payment are closed as ACCEPTED/REJECTED.

`listReconciliationQueue` gives admins the OPEN items (members see their own).

Manual reconciliation is a human attestation, labelled as such
(`verification.source = MANUAL_RECONCILIATION`, with `evidenceType` and `note`).
It is not cryptographic proof. In a one-person trip there is nobody else to reconcile,
so payments stay `AWAITING_VERIFICATION` (shown in the provisional ledger) by design.

## Refunds and reversals

See [SPLITTING.md](SPLITTING.md#refunds-and-reversals).
