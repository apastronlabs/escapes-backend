"use strict";

const { defineString, defineInt, defineBoolean } = require("firebase-functions/params");

/**
 * Deploy-time parameters. Set them in functions/.env.<projectId> (see .env.example)
 * or let the Firebase CLI prompt on first deploy. None of these are secrets.
 *
 * Provider credentials, when a verification provider is integrated, must be
 * declared with defineSecret() (Secret Manager) inside that provider's adapter
 * and bound to the functions that use it. Never put them in .env files.
 */
const VERIFICATION_PROVIDER = defineString("VERIFICATION_PROVIDER", {
  default: "none",
  description: "Payment verification adapter. Only 'none' is implemented; see docs/VERIFICATION.md.",
});

const UPI_MAX_AMOUNT_MINOR = defineInt("UPI_MAX_AMOUNT_MINOR", {
  default: 10000000,
  description: "Maximum single UPI payment in paise (default 10000000 = INR 1,00,000).",
});

const UPI_ATTACH_INTERNAL_REF = defineBoolean("UPI_ATTACH_INTERNAL_REF", {
  default: false,
  description: "Put the internal payment reference in the intent's tr parameter when the QR has none.",
});

module.exports = { VERIFICATION_PROVIDER, UPI_MAX_AMOUNT_MINOR, UPI_ATTACH_INTERNAL_REF };
