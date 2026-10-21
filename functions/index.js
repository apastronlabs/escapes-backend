"use strict";

/**
 * Escapes backend: Cloud Functions v2 entry point.
 *
 * Every exported function is an authenticated callable (onCall), plus one Firestore
 * trigger that applies expense changes the app queued while offline (docs/OFFLINE.md).
 * There are no HTTP endpoints: no payment provider webhook is integrated (see docs/VERIFICATION.md).
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall } = require("firebase-functions/v2/https");
const { onDocumentCreatedWithAuthContext } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { REGION } = require("./src/lib/constants");
const { HttpsError } = require("./src/lib/errors");

setGlobalOptions({ region: REGION, maxInstances: 10 });

// Built lazily so deploy-time analysis doesn't touch Firestore or params.
let services = null;
function handlers() {
  if (!services) {
    const { createDefaultContext } = require("./src/context");
    const { makeServices } = require("./src/services");
    services = makeServices(createDefaultContext());
  }
  return services.handlers;
}
function trusted() {
  handlers();
  return services.trusted;
}

const { CALLABLES } = require("./src/callables");

for (const name of CALLABLES) {
  exports[name] = onCall({ cors: true }, async (request) => {
    try {
      return await handlers()[name](request);
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error(`${name} failed`, { error: err && err.stack, uid: request.auth && request.auth.uid });
      throw new HttpsError("internal", "Something went wrong. Please try again.");
    }
  });
}

// Applies an expense change the app wrote to expenseOps (offline queue). Retries cover
// transient errors only; validation and permission failures are recorded on the op.
exports.processExpenseOp = onDocumentCreatedWithAuthContext({ document: "expenseOps/{opId}", retry: true }, async (event) => {
  const { RetryableError } = require("./src/services/sync");
  try {
    await trusted().processExpenseOp(event.params.opId, {
      claimId: event.id,
      auth: { type: event.authType, id: event.authId || null },
      eventTime: Date.parse(event.time) || Date.now(),
    });
  } catch (err) {
    if (err instanceof RetryableError) throw err;
    logger.error("processExpenseOp failed", { opId: event.params.opId, error: err && err.stack });
  }
});
