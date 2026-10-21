"use strict";

/**
 * Integration-test harness. Runs the real services against the Firestore
 * emulator (FIRESTORE_EMULATOR_HOST is set by `firebase emulators:exec`).
 * Callable handlers are invoked directly with a fake callable request,
 * which is exactly what onCall passes after verifying the ID token.
 */

const assert = require("node:assert/strict");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { createContext } = require("../src/context");
const { makeServices } = require("../src/services");

const PROJECT_ID = "demo-escapes";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Integration tests need the Firestore emulator. Run `npm test` (firebase emulators:exec).");
}
if (!getApps().length) initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

async function clearFirestore() {
  const res = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(res.status, 200, "failed to clear emulator");
}

function fakeBucket() {
  const files = new Map();
  return {
    files,
    put(path, meta) {
      files.set(path, { size: String(meta.size), contentType: meta.contentType, md5Hash: "abc==" });
    },
    file(path) {
      return {
        async getMetadata() {
          if (!files.has(path)) {
            const e = new Error("No such object");
            e.code = 404;
            throw e;
          }
          return [files.get(path)];
        },
        async getSignedUrl({ expires }) {
          return [`https://signed.example/${encodeURIComponent(path)}?exp=${expires}`];
        },
      };
    },
  };
}

function fakeAdapter() {
  const adapter = {
    name: "fake",
    next: { result: "UNAVAILABLE", source: "NONE" },
    calls: 0,
    async verify() {
      adapter.calls += 1;
      return adapter.next;
    },
  };
  return adapter;
}

function setup(config = {}) {
  const bucket = fakeBucket();
  const adapter = fakeAdapter();
  const ctx = createContext({ db, bucket, verificationAdapter: adapter, config });
  const { handlers, trusted } = makeServices(ctx);
  return { ctx, db, bucket, adapter, h: handlers, trusted };
}

let keySeq = 0;
function key(prefix = "k") {
  keySeq += 1;
  return `${prefix}-${Date.now()}-${keySeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function as(uid, data, token = {}) {
  return { auth: { uid, token: { email: `${uid}@example.com`, email_verified: true, name: uid, ...token } }, data };
}

/** assert.rejects matching the HttpsError code and details.reason. */
async function rejectsWith(promise, code, reason) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    if (reason) assert.equal(err.details && err.details.reason, reason, `expected reason ${reason}, got ${err.details && err.details.reason}`);
    return true;
  });
}

/** Creates a trip owned by `owner` and joins every uid in `members` via invitations. */
async function tripWith(h, owner, members = [], { admins = [] } = {}) {
  const { tripId } = await h.createTrip(as(owner, { name: `Trip of ${owner}`, idempotencyKey: key("trip") }));
  for (const uid of [...admins, ...members]) {
    const role = admins.includes(uid) ? "ADMIN" : "MEMBER";
    const inv = await h.createInvitation(as(owner, { tripId, role, idempotencyKey: key("inv") }));
    await h.acceptInvitation(as(uid, { token: inv.token }));
  }
  return tripId;
}

async function getDoc(collection, id) {
  const s = await db.collection(collection).doc(id).get();
  return s.exists ? s.data() : null;
}

const QR = (am) => `upi://pay?pa=goa.shack@okhdfcbank&pn=Goa%20Beach%20Shack&mc=5812${am ? `&am=${am}` : ""}&cu=INR`;

module.exports = { db, clearFirestore, setup, key, as, rejectsWith, tripWith, getDoc, QR };
