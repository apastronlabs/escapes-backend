# Payment verification

## What is implemented

* A verification **adapter interface** (`functions/src/verification/index.js`):
  `verify(transaction) -> { result, source, amountMinor, payeeVpa, providerReference, raw }`.
* A trusted entry point `applyAdapterResult(transactionId, result)` that only confirms
  a payment when the adapter's `amountMinor` **and** `payeeVpa` match the record.
  Mismatches are recorded as anomalies (`VERIFIED_AMOUNT_MISMATCH`,
  `VERIFIED_PAYEE_MISMATCH`) and change nothing. It is not exported as a callable.
* The `verifyTransaction` callable, which runs the configured adapter.
* The default adapter, `none`, which always answers `UNAVAILABLE`. With it,
  `verifyTransaction` returns `verificationAvailable: false` and changes nothing.
* Manual reconciliation (see [PAYMENTS.md](PAYMENTS.md#manual-reconciliation)).

Tests exercise the adapter path with a fake adapter (confirm, amount mismatch, payee
mismatch). **No real provider is integrated or tested.**

## What cannot be done without a supported integration

* **Automatic independent confirmation of UPI Intent payments to arbitrary merchant
  VPAs.** A UPI Intent payment goes from the payer's bank to the merchant's bank. There is
  no public NPCI or bank API that lets a third party look up a UTR/RRN and learn whether
  a given VPA received a given amount. A UTR's format or uniqueness proves nothing.
* **Verifying signed QR codes** (needs the issuing PSP's key).
* **Verifying refunds automatically.**

Every such payment therefore stays `AWAITING_VERIFICATION` until manually reconciled,
and is shown in the provisional (unverified) ledger only.

## Options for real verification (future work)

All require an account with the provider and its documented API; none is assumed here.

1. **Collect through a payment gateway you control** (merchant/aggregator account with
   UPI collect or intent-with-order). Create an order server-side, launch the
   gateway's UPI flow, and verify via the gateway's documented *order status API* and/or
   its *signed webhook*. That is the only way to get provider-backed confirmation, but it
   means the money goes to your gateway account, not to the scanned merchant directly.
2. **Beneficiary-side records.** When the payee is a trip member (settlement payments),
   the receiving member confirming receipt is already implemented
   (`BENEFICIARY_CONFIRMATION`). A bank-statement/account-aggregator integration for the
   *beneficiary's* account would be a provider adapter.

### Adding an adapter

1. Create `functions/src/verification/<provider>.js` exporting `{ name, verify }`.
2. Declare credentials with `defineSecret()` (Secret Manager) and bind them to
   `verifyTransaction` with `onCall({ secrets: [...] })`. Never put them in `.env`.
3. Register it in `REGISTRY` and set `VERIFICATION_PROVIDER=<provider>`.
4. If the provider sends webhooks, add an `onRequest` function that verifies the
   provider's documented signature, stores the raw event in `webhookEvents/{providerEventId}`
   (idempotent by event id), and calls `applyAdapterResult`.
5. Add tests with recorded provider payloads.

`webhookEvents` is not created today because no provider is integrated.
