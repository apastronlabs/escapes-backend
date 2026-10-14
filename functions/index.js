"use strict";

/**
 * Escapes backend: Cloud Functions v2 entry point.
 *
 * Every exported function is an authenticated callable (onCall). There are no
 * HTTP endpoints: no payment provider webhook is integrated (see docs/VERIFICATION.md).
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall } = require("firebase-functions/v2/https");
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
