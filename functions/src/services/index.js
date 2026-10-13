"use strict";

const { makeTripService } = require("./trips");
const { makeMemberService } = require("./members");
const { makeCategoryService } = require("./categories");
const { makeExpenseService } = require("./expenses");
const { makeTransactionService } = require("./transactions");
const { makeSettlementService } = require("./settlements");
const { makeReceiptService } = require("./receipts");
const { makeAuditService } = require("./audit");

/** Builds every handler against one context. Handlers take a callable `request` ({auth, data}). */
function makeServices(ctx, opts = {}) {
  const transactions = makeTransactionService(ctx, opts);
  const { applyAdapterResult, ...transactionHandlers } = transactions;
  return {
    handlers: {
      ...makeTripService(ctx),
      ...makeMemberService(ctx),
      ...makeCategoryService(ctx, opts),
      ...makeExpenseService(ctx, opts),
      ...transactionHandlers,
      ...makeSettlementService(ctx),
      ...makeReceiptService(ctx),
      ...makeAuditService(ctx),
    },
    trusted: { applyAdapterResult },
  };
}

module.exports = { makeServices };
