"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CALLABLES } = require("../../src/callables");
const { makeServices } = require("../../src/services");
const { createContext } = require("../../src/context");

test("every exported callable maps to a handler and vice versa", () => {
  const { handlers } = makeServices(createContext({ db: {}, verificationAdapter: { verify: async () => ({}) } }));
  assert.deepEqual([...CALLABLES].sort(), Object.keys(handlers).sort());
});

test("index exports authenticated v2 callables in asia-south1 and no HTTP endpoints", () => {
  const exported = require("../../index.js");
  for (const name of CALLABLES) {
    const fn = exported[name];
    assert.equal(typeof fn, "function", name);
    assert.ok(fn.__endpoint.callableTrigger, `${name} is a callable`);
    assert.deepEqual(fn.__endpoint.region, ["asia-south1"]);
    assert.equal(fn.__endpoint.platform, "gcfv2");
  }
  assert.equal(Object.keys(exported).length, CALLABLES.length);
});

test("the trusted adapter entry point is not exported as a callable", () => {
  const exported = require("../../index.js");
  assert.equal(exported.applyAdapterResult, undefined);
});

test("the default context initializes the default app even when firebase-functions created its own app first", () => {
  // Runs in a fresh process: on Cloud Functions, firebase-functions initializes a named app to
  // verify callable auth tokens before any handler runs.
  const { execFileSync } = require("node:child_process");
  const script = `
    const { initializeApp } = require("firebase-admin/app");
    initializeApp({ projectId: "demo-test" }, "__FIREBASE_FUNCTIONS_SDK__");
    const ctx = require("./src/context").createDefaultContext();
    if (!ctx.db) throw new Error("no db");
  `;
  execFileSync(process.execPath, ["-e", script], {
    cwd: require("node:path").join(__dirname, "../.."),
    env: { ...process.env, GCLOUD_PROJECT: "demo-test" },
    stdio: "pipe",
  });
});
