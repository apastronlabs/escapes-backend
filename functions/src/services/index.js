"use strict";

const { makeTripService } = require("./trips");
const { makeMemberService } = require("./members");
const { makeCategoryService } = require("./categories");
const { makeExpenseService } = require("./expenses");
const { makeTransactionService } = require("./transactions");
const { makeSettlementService } = require("./settlements");
const { makeReceiptService } = require("./receipts");
const { makeAuditService } = require("./audit");
const { makeSyncService } = require("./sync");

/** Builds every handler against one context. Handlers take a callable `request` ({auth, data}). */
function makeServices(ctx, opts = {}) {
  const transactions = makeTransactionService(ctx, opts);
  const { applyAdapterResult, ...transactionHandlers } = transactions;
  const handlers = {
    ...makeTripService(ctx),
    ...makeMemberService(ctx),
    ...makeCategoryService(ctx, opts),
    ...makeExpenseService(ctx, opts),
    ...transactionHandlers,
    ...makeSettlementService(ctx),
    ...makeReceiptService(ctx),
    ...makeAuditService(ctx),
  };
  const { processOp, listSyncLog } = makeSyncService(ctx, handlers);
  handlers.listSyncLog = listSyncLog;
  return { handlers, trusted: { applyAdapterResult, processExpenseOp: processOp } };
}

module.exports = { makeServices };
