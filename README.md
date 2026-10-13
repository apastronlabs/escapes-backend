# Scaper backend

Firebase backend for Scaper, a multi-trip group expense app (FlutterFlow, Android + iOS)
with UPI Intent payments. Cloud Functions v2 · Node.js 22 · JavaScript · Firestore ·
Firebase Auth · `us-central1`.

* Users create any number of independent trips, each with its own members, categories,
  expenses, payments, settlements and audit trail. Every record carries `tripId`, and every
  function checks the caller's membership server-side.
* UPI payments are executed by the user's UPI app. The backend records initiation, the
  raw client-reported outcome and user claims (UTR / receipt / OCR) as **unverified**, and
  only a trusted path can mark a payment `CONFIRMED`.

## Repository inspection

There was no existing Firebase/FlutterFlow code to build on: the only accessible
GitHub repository (`apastronlabs/photonstudio`) contains only a README, and no Firebase
project was found in the connected device's home folder. This is therefore a
standalone `functions/` codebase meant to be added to your **existing** Firebase project
(no project was initialized and no Firebase config was replaced).

```
firebase.json              functions codebase "scaper" + emulator ports (no rules section)
firestore.indexes.json     composite indexes
.firebaserc.example        put your existing project id here (copy to .firebaserc)
functions/
  index.js                 exports 42 callables (onCall v2, us-central1)
  src/callables.js         list of exported function names
  src/config.js            deploy params (VERIFICATION_PROVIDER, UPI_MAX_AMOUNT_MINOR, ...)
  src/context.js           dependency wiring (Firestore, Storage, verification adapter)
  src/lib/                 validation, auth/membership, idempotency, audit, errors, hashing
  src/domain/              pure logic: money, splits, payment states, UPI QR/response, ledger, settlement, categorizer
  src/services/            trips, members, categories, expenses, transactions, settlements, receipts, audit
  src/verification/        verification adapter interface (only "none" implemented)
  test/unit/               pure-logic tests (no emulator)
  test/integration/        service tests against the Firestore emulator
  .env.example
scripts/smoke-emulator.sh  end-to-end call through the Functions + Auth emulators
docs/                      SCHEMA, FUNCTIONS, PAYMENTS, VERIFICATION, SPLITTING
```

## Run locally

Requirements: Node 22, Java 11+ (Firestore emulator).

```bash
cd functions
npm install
npm test                 # starts the Firestore emulator and runs all tests
npm run test:unit        # pure-logic tests only, no emulator
npm run serve            # Functions + Firestore + Auth + Storage emulators with UI
```

From the repo root, an end-to-end check through real callable HTTP requests with Auth emulator tokens:

```bash
npx --prefix functions firebase emulators:exec --project demo-scaper \
  --only functions,firestore,auth "bash scripts/smoke-emulator.sh"
```

In FlutterFlow / Flutter, point the app at the emulators with
`FirebaseFunctions.instance.useFunctionsEmulator('localhost', 5001)` (and the matching
Auth/Firestore/Storage calls).

## Deploy into your existing Firebase project

1. Copy this repo's `functions/`, `firebase.json` (or merge its `functions` entry into yours)
   and `firestore.indexes.json` next to your existing Firebase config.
   The functions use their own codebase, `scaper`, so deploying them **does not touch or
   delete** functions deployed by FlutterFlow or other codebases.
2. `cp .firebaserc.example .firebaserc` and set your project id (or `firebase use <id>`).
3. Parameters: `cp functions/.env.example functions/.env.<projectId>` and adjust.
   Nothing secret goes there. Future provider credentials go in Secret Manager
   (`firebase functions:secrets:set NAME`) and are declared with `defineSecret()`.
4. Deploy:
   ```bash
   firebase deploy --only functions:scaper
   firebase deploy --only firestore:indexes   # merge with FlutterFlow-managed indexes first, see docs/SCHEMA.md
   ```
5. One-time, optional: TTL policy on `idempotencyKeys.expireAt` (command in docs/SCHEMA.md).
6. Receipts: the app uploads to `receipts/{tripId}/{uid}/{file}` in the default bucket.
   `getReceiptUrl` signs URLs, which needs the functions' service account to have
   `iam.serviceAccounts.signBlob` (Service Account Token Creator on itself).

**Not included, by design:** Firestore/Storage Security Rules (managed in FlutterFlow;
recommendations in docs/SCHEMA.md), FlutterFlow screens, any AI integration, any payment
provider integration.

## Test results

Run on 2026-10-13 with Node 22.22.0, firebase-tools 15.33.0, Firestore emulator 1.22.0:

```
npm test   ->  # tests 72  # pass 72  # fail 0   (run 3 times, same result)
```

Coverage by requirement:

| Requirement | Tests |
|---|---|
| Authorization, trip isolation | `trips-membership`: unauthenticated, cross-trip reads, role checks; `payments`: payer-only reporting, cross-trip payment linking; `expenses`: payer attribution |
| Duplicate submissions | `concurrency`: same-key replay, 8 parallel createExpense, 6 parallel initiateUpiPayment, duplicate client responses, single-use invite raced by 5 users, same UTR raced on two payments |
| Splitting and rounding | `unit/splits` (equal/percentage/amount, remainders, negatives, proportional refunds); `expenses` |
| Membership changes | `trips-membership`; `expenses` (removed member keeps balance, can't be added) |
| Status transitions | `unit/paymentStates` (exhaustive "client can never confirm"); `payments` |
| Concurrent updates | `expenses` (stale edits), `concurrency` (cancel vs reconcile race) |
| Unverified UPI response can't confirm | `payments`: "an unverified UPI success response can never produce a confirmed payment" |

The smoke script was also run end to end through the Functions + Auth emulators
(createTrip → initiateUpiPayment → recordUpiClientResponse(SUCCESS) → summary shows ₹120
unverified, ₹0 confirmed).

## What is not verified / needs an integration

* **Independent payment verification.** No provider is integrated; the default adapter
  reports `UNAVAILABLE`. Payments stay `AWAITING_VERIFICATION` until manually reconciled by
  someone other than the payer. See [docs/VERIFICATION.md](docs/VERIFICATION.md).
* **Signed QR verification** (needs PSP keys) and **automatic refund verification**.
* **Real UPI app behaviour.** Response parsing is tested against representative
  payloads, not against live PhonePe / Google Pay / Paytm builds. Confirm your FlutterFlow
  plugin's behaviour on each platform (see [docs/PAYMENTS.md](docs/PAYMENTS.md#platform-specific-callback-handling-client-dependencies)).
* **`getReceiptUrl` against real Cloud Storage.** Tested with a fake bucket; signed URLs need the IAM permission above.
* **Production deploy.** Functions load and serve in the emulator; nothing was deployed.

## Docs

* [docs/FUNCTIONS.md](docs/FUNCTIONS.md): every function's purpose, inputs, outputs, authorization
* [docs/SCHEMA.md](docs/SCHEMA.md): collections, fields, indexes
* [docs/PAYMENTS.md](docs/PAYMENTS.md): UPI flow, state machine, Android/iOS callback handling, reconciliation
* [docs/VERIFICATION.md](docs/VERIFICATION.md): what can and cannot be verified, how to add a provider
* [docs/SPLITTING.md](docs/SPLITTING.md): rounding policy, ledgers, settlements, refunds
