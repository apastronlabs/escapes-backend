"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { categorize } = require("../../src/domain/categorizer");
const { DEFAULT_CATEGORIES } = require("../../src/domain/categories");
const { computeNetBalances, suggestSettlements } = require("../../src/domain/settlement");

const cats = DEFAULT_CATEGORIES.map((c) => ({ id: `t1_${c.key}`, key: c.key, name: c.name, keywords: c.keywords }));

test("categorizes by merchant category code first", () => {
  assert.deepEqual(categorize({ merchantName: "Random Name", merchantCategoryCode: "4121" }, cats), { categoryId: "t1_transport", source: "RULE_MCC", matched: "4121" });
});

test("categorizes by whole-word keyword, longest match wins", () => {
  assert.equal(categorize({ merchantName: "Hotel Restaurant Saravana" }, cats).categoryId, "t1_food");
  assert.equal(categorize({ merchantName: "Taj Hotel" }, cats).categoryId, "t1_accommodation");
  assert.equal(categorize({ merchantName: "Barber Shop" }, cats).categoryId, "t1_other");
  assert.equal(categorize({ description: "Uber to airport" }, cats).categoryId, "t1_transport");
});

test("archived categories are skipped and fallback is used", () => {
  const withArchived = cats.map((c) => (c.key === "food" ? { ...c, archived: true } : c));
  assert.deepEqual(categorize({ merchantName: "Pizza Corner" }, withArchived), { categoryId: "t1_other", source: "DEFAULT", matched: null });
});

test("trip-specific custom keywords are respected", () => {
  const custom = [...cats, { id: "t1_custom", key: null, name: "Scuba", keywords: ["dive center"] }];
  assert.equal(categorize({ merchantName: "Lacadives Dive Center" }, custom).categoryId, "t1_custom");
});

test("net balances sum to zero and settlements clear them", () => {
  const expenses = [
    { paidByUid: "a", amountMinor: 9000, shares: { a: 3000, b: 3000, c: 3000 } },
    { paidByUid: "b", amountMinor: 3000, shares: { a: 1000, b: 1000, c: 1000 } },
  ];
  const net = computeNetBalances(expenses, []);
  assert.deepEqual(net, { a: 5000, b: -1000, c: -4000 });
  assert.equal(Object.values(net).reduce((s, x) => s + x, 0), 0);
  const suggestions = suggestSettlements(net);
  assert.deepEqual(suggestions, [
    { fromUid: "c", toUid: "a", amountMinor: 4000 },
    { fromUid: "b", toUid: "a", amountMinor: 1000 },
  ]);
  const after = computeNetBalances(expenses, suggestions);
  assert.ok(Object.values(after).every((x) => x === 0));
});

test("refund adjustment nets out the original payment", () => {
  const net = computeNetBalances([
    { paidByUid: "a", amountMinor: 3000, shares: { a: 1000, b: 1000, c: 1000 } },
    { paidByUid: "a", amountMinor: -3000, shares: { a: -1000, b: -1000, c: -1000 } },
  ], []);
  assert.ok(Object.values(net).every((x) => x === 0));
});
