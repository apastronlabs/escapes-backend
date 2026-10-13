"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

/**
 * Thin helpers so services throw callable-compatible errors with a stable
 * machine-readable `details.reason` the client can switch on.
 */
function fail(code, message, reason, extra) {
  return new HttpsError(code, message, { reason: reason || code, ...(extra || {}) });
}

const invalid = (message, reason, extra) => fail("invalid-argument", message, reason || "INVALID_ARGUMENT", extra);
const notFound = (message, reason) => fail("not-found", message, reason || "NOT_FOUND");
const denied = (message, reason) => fail("permission-denied", message, reason || "PERMISSION_DENIED");
const precondition = (message, reason, extra) => fail("failed-precondition", message, reason || "FAILED_PRECONDITION", extra);
const conflict = (message, reason, extra) => fail("already-exists", message, reason || "ALREADY_EXISTS", extra);
const aborted = (message, reason) => fail("aborted", message, reason || "ABORTED");
const unauthenticated = () => fail("unauthenticated", "Sign in required.", "UNAUTHENTICATED");

module.exports = { HttpsError, fail, invalid, notFound, denied, precondition, conflict, aborted, unauthenticated };
