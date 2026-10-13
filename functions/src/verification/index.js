"use strict";

/**
 * Payment verification adapter interface.
 *
 * An adapter answers one question for a transaction, from a source that is
 * independent of the payer's phone: did the payee receive this amount?
 *
 *   async verify(transaction) -> {
 *     result: "CONFIRMED" | "FAILED" | "PENDING" | "NOT_FOUND" | "UNAVAILABLE",
 *     source: string,              // e.g. "PROVIDER_API:<name>", "PROVIDER_WEBHOOK:<name>"
 *     amountMinor?: number,        // amount the source says was received
 *     payeeVpa?: string,           // beneficiary the source says received it
 *     providerReference?: string,  // provider's id / RRN for the payment
 *     raw?: object                 // trimmed provider payload, stored for audit
 *   }
 *
 * The transaction service never trusts `result` alone: CONFIRMED is applied
 * only when amountMinor and payeeVpa match the transaction record.
 *
 * No real provider is implemented. Collecting UPI payments into a merchant
 * account through a payment gateway (and verifying them via that gateway's
 * documented API or signed webhooks) requires a merchant account and is out
 * of scope for this personal app. Plain UPI Intent payments to arbitrary
 * merchant VPAs have no public verification API, so a UTR cannot be checked
 * by calling some endpoint. See docs/VERIFICATION.md.
 */

const NONE = Object.freeze({
  name: "none",
  async verify() {
    return { result: "UNAVAILABLE", source: "NONE" };
  },
});

const REGISTRY = { none: () => NONE };

function createVerificationAdapter(name) {
  const factory = REGISTRY[(name || "none").toLowerCase()];
  if (!factory) throw new Error(`Unknown VERIFICATION_PROVIDER "${name}". Implemented: ${Object.keys(REGISTRY).join(", ")}.`);
  return factory();
}

module.exports = { createVerificationAdapter, NONE_ADAPTER: NONE };
