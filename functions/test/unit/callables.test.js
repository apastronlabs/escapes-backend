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

test("index exports authenticated v2 callables in us-central1 and no HTTP endpoints", () => {
  const exported = require("../../index.js");
  for (const name of CALLABLES) {
    const fn = exported[name];
    assert.equal(typeof fn, "function", name);
    assert.ok(fn.__endpoint.callableTrigger, `${name} is a callable`);
    assert.deepEqual(fn.__endpoint.region, ["us-central1"]);
    assert.equal(fn.__endpoint.platform, "gcfv2");
  }
  assert.equal(Object.keys(exported).length, CALLABLES.length);
});

test("the trusted adapter entry point is not exported as a callable", () => {
  const exported = require("../../index.js");
  assert.equal(exported.applyAdapterResult, undefined);
});
