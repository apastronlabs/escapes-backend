"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeShares, proportionalShares, sumShares } = require("../../src/domain/splits");

test("equal split distributes paise remainder by ascending uid", () => {
  const shares = computeShares(10000, ["c", "a", "b"], { type: "EQUAL" });
  assert.deepEqual(shares, { a: 3334, b: 3333, c: 3333 });
  assert.equal(sumShares(shares), 10000);
});

test("equal split result does not depend on participant order", () => {
  const one = computeShares(1001, ["u3", "u1", "u2"], { type: "EQUAL" });
  const two = computeShares(1001, ["u2", "u3", "u1"], { type: "EQUAL" });
  assert.deepEqual(one, two);
});

test("equal split of 1 paisa among 3", () => {
  assert.deepEqual(computeShares(1, ["a", "b", "c"], { type: "EQUAL" }), { a: 1, b: 0, c: 0 });
});

test("percentage split uses largest remainder and sums exactly", () => {
  // 33.33% / 33.33% / 33.34% of 1000 paise
  const shares = computeShares(1000, ["a", "b", "c"], { type: "PERCENTAGE", values: { a: 3333, b: 3333, c: 3334 } });
  assert.equal(sumShares(shares), 1000);
  assert.deepEqual(shares, { a: 333, b: 333, c: 334 });
});

test("percentage split with awkward amount sums exactly", () => {
  for (const amount of [1, 7, 99, 101, 12345, 99999999]) {
    const shares = computeShares(amount, ["x", "y", "z"], { type: "PERCENTAGE", values: { x: 5000, y: 2500, z: 2500 } });
    assert.equal(sumShares(shares), amount, `amount ${amount}`);
  }
});

test("percentages must total 100%", () => {
  assert.throws(() => computeShares(100, ["a", "b"], { type: "PERCENTAGE", values: { a: 5000, b: 4000 } }), { reason: "PERCENTAGE_TOTAL_MISMATCH" });
});

test("custom amounts must sum to the expense amount", () => {
  assert.deepEqual(computeShares(500, ["a", "b"], { type: "AMOUNT", values: { a: 200, b: 300 } }), { a: 200, b: 300 });
  assert.throws(() => computeShares(500, ["a", "b"], { type: "AMOUNT", values: { a: 200, b: 299 } }), { reason: "SHARE_TOTAL_MISMATCH" });
  assert.throws(() => computeShares(500, ["a", "b"], { type: "AMOUNT", values: { a: -1, b: 501 } }), { reason: "INVALID_SHARE_AMOUNT" });
});

test("split values for non-participants are rejected", () => {
  assert.throws(() => computeShares(500, ["a"], { type: "AMOUNT", values: { a: 250, z: 250 } }), { reason: "SPLIT_VALUE_NOT_PARTICIPANT" });
});

test("duplicate participants and empty lists are rejected", () => {
  assert.throws(() => computeShares(500, ["a", "a"], { type: "EQUAL" }), { reason: "DUPLICATE_PARTICIPANTS" });
  assert.throws(() => computeShares(500, [], { type: "EQUAL" }), { reason: "NO_PARTICIPANTS" });
});

test("negative adjustment amounts mirror the positive split", () => {
  const shares = computeShares(-1000, ["a", "b", "c"], { type: "EQUAL" });
  assert.deepEqual(shares, { a: -334, b: -333, c: -333 });
  assert.equal(sumShares(shares), -1000);
});

test("proportional refund shares follow the original split and sum exactly", () => {
  const base = { a: 3334, b: 3333, c: 3333 };
  const refund = proportionalShares(-2500, base);
  assert.equal(sumShares(refund), -2500);
  assert.deepEqual(refund, { a: -834, b: -833, c: -833 });
  const uneven = proportionalShares(-999, { a: 7000, b: 3000 });
  assert.equal(sumShares(uneven), -999);
  assert.deepEqual(uneven, { a: -699, b: -300 });
});

test("recalculation after participant change keeps the amount", () => {
  const before = computeShares(9000, ["a", "b", "c"], { type: "EQUAL" });
  const after = computeShares(9000, ["a", "b"], { type: "EQUAL" });
  assert.equal(sumShares(before), 9000);
  assert.equal(sumShares(after), 9000);
  assert.deepEqual(after, { a: 4500, b: 4500 });
});
