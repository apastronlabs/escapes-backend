"use strict";

/**
 * Net balances and settlement suggestions.
 *
 * net[uid] = (amount uid paid for expenses) - (uid's shares)
 *          + (settlement payments uid sent) - (settlement payments uid received)
 * Positive net: the group owes uid. Negative: uid owes the group.
 * Sum of all nets is always 0 because every expense's shares sum to its amount.
 */

function byUid(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {Array<{paidByUid: string, amountMinor: number, shares: Object<string, number>}>} expenses
 * @param {Array<{fromUid: string, toUid: string, amountMinor: number}>} settlements
 */
function computeNetBalances(expenses, settlements) {
  const net = {};
  const add = (uid, v) => {
    net[uid] = (net[uid] || 0) + v;
  };
  for (const e of expenses) {
    add(e.paidByUid, e.amountMinor);
    for (const [uid, share] of Object.entries(e.shares || {})) add(uid, -share);
  }
  for (const s of settlements) {
    add(s.fromUid, s.amountMinor);
    add(s.toUid, -s.amountMinor);
  }
  return net;
}

/**
 * Greedy minimum-cash-flow suggestions: repeatedly match the largest debtor
 * with the largest creditor. Produces at most (n - 1) transfers. Ties are
 * broken by uid so results are stable.
 */
function suggestSettlements(net) {
  const debtors = [];
  const creditors = [];
  for (const [uid, v] of Object.entries(net)) {
    if (v < 0) debtors.push({ uid, amount: -v });
    else if (v > 0) creditors.push({ uid, amount: v });
  }
  const order = (a, b) => b.amount - a.amount || byUid(a.uid, b.uid);
  const transfers = [];
  while (debtors.length && creditors.length) {
    debtors.sort(order);
    creditors.sort(order);
    const d = debtors[0];
    const c = creditors[0];
    const amount = Math.min(d.amount, c.amount);
    transfers.push({ fromUid: d.uid, toUid: c.uid, amountMinor: amount });
    d.amount -= amount;
    c.amount -= amount;
    if (d.amount === 0) debtors.shift();
    if (c.amount === 0) creditors.shift();
  }
  return transfers;
}

module.exports = { computeNetBalances, suggestSettlements };
