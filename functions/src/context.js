"use strict";

const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { createVerificationAdapter } = require("./verification");

const DEFAULT_MAX_PAYMENT_MINOR = 10_000_000; // INR 1,00,000 per payment; override with UPI_MAX_AMOUNT_MINOR

/**
 * Dependencies shared by every service. Tests build their own context with a
 * fake verification adapter and a fake storage bucket; production uses
 * `createDefaultContext()`.
 */
function createContext({ db, bucket = null, verificationAdapter, now = () => Date.now(), config = {} }) {
  return {
    db,
    bucket,
    verificationAdapter,
    now,
    config: {
      maxPaymentAmountMinor: DEFAULT_MAX_PAYMENT_MINOR,
      attachInternalRefToIntent: false,
      receiptUrlTtlSeconds: 300,
      ...config,
    },
    FieldValue,
    Timestamp,
  };
}

let cached = null;
function createDefaultContext() {
  if (cached) return cached;
  const { getApps, initializeApp } = require("firebase-admin/app");
  if (!getApps().length) initializeApp();
  const { getStorage } = require("firebase-admin/storage");
  const params = require("./config");
  let bucket = null;
  try {
    bucket = getStorage().bucket();
  } catch {
    bucket = null; // no default bucket configured; receipt functions will report it
  }
  cached = createContext({
    db: getFirestore(),
    bucket,
    // Params read as ""/0 when the CLI has not injected them (e.g. some emulator runs),
    // so fall back to the documented defaults instead of silently using 0.
    verificationAdapter: createVerificationAdapter(params.VERIFICATION_PROVIDER.value() || "none"),
    config: {
      maxPaymentAmountMinor: params.UPI_MAX_AMOUNT_MINOR.value() > 0 ? params.UPI_MAX_AMOUNT_MINOR.value() : DEFAULT_MAX_PAYMENT_MINOR,
      attachInternalRefToIntent: params.UPI_ATTACH_INTERNAL_REF.value() === true,
    },
  });
  return cached;
}

module.exports = { createContext, createDefaultContext };
