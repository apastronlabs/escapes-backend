"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canTransition, STATES, TRANSITIONS } = require("../../src/domain/paymentStates");

test("a client can never move a payment to CONFIRMED, from any state", () => {
  for (const from of Object.values(STATES)) {
    for (const setBy of ["CLIENT", "TRUSTED"]) {
      const r = canTransition({ status: from, statusSetBy: setBy }, STATES.CONFIRMED, "CLIENT");
      assert.equal(r.ok, false, `${from} (${setBy}) -> CONFIRMED by CLIENT`);
    }
  }
});

test("a client cannot set REFUNDED or REVERSED", () => {
  for (const from of Object.values(STATES)) {
    assert.equal(canTransition({ status: from }, STATES.REFUNDED, "CLIENT").ok, false);
    assert.equal(canTransition({ status: from }, STATES.REVERSED, "CLIENT").ok, false);
  }
});

test("valid client transitions", () => {
  assert.ok(canTransition({ status: "INITIATED" }, "AWAITING_VERIFICATION", "CLIENT").ok);
  assert.ok(canTransition({ status: "INITIATED" }, "PENDING", "CLIENT").ok);
  assert.ok(canTransition({ status: "INITIATED" }, "CANCELLED", "CLIENT").ok);
  assert.ok(canTransition({ status: "PENDING" }, "AWAITING_VERIFICATION", "CLIENT").ok);
  assert.ok(canTransition({ status: "FAILED", statusSetBy: "CLIENT" }, "AWAITING_VERIFICATION", "CLIENT").ok);
});

test("a status set by a trusted source is locked against client changes", () => {
  const r = canTransition({ status: "FAILED", statusSetBy: "TRUSTED" }, "AWAITING_VERIFICATION", "CLIENT");
  assert.deepEqual(r, { ok: false, reason: "STATUS_LOCKED_BY_TRUSTED_SOURCE" });
});

test("trusted transitions", () => {
  assert.ok(canTransition({ status: "AWAITING_VERIFICATION" }, "CONFIRMED", "TRUSTED").ok);
  assert.ok(canTransition({ status: "CONFIRMED" }, "REFUNDED", "TRUSTED").ok);
  assert.ok(canTransition({ status: "CONFIRMED" }, "REVERSED", "TRUSTED").ok);
  assert.equal(canTransition({ status: "CONFIRMED" }, "FAILED", "TRUSTED").ok, false);
  assert.equal(canTransition({ status: "REFUNDED" }, "CONFIRMED", "TRUSTED").ok, false);
});

test("terminal states have no exits and the table covers every state", () => {
  for (const s of Object.values(STATES)) assert.ok(TRANSITIONS[s], s);
  assert.deepEqual(TRANSITIONS.REFUNDED, { CLIENT: [], TRUSTED: [] });
  assert.deepEqual(TRANSITIONS.REVERSED, { CLIENT: [], TRUSTED: [] });
});

test("unknown states and actors are rejected", () => {
  assert.equal(canTransition({ status: "INITIATED" }, "PAID", "CLIENT").ok, false);
  assert.equal(canTransition({ status: "INITIATED" }, "PENDING", "ADMIN").ok, false);
});
