"use strict";

/** Names of every exported callable; each maps 1:1 to a service handler. */
const CALLABLES = [
  // trips
  "createTrip", "updateTrip", "getTrip", "listMyTrips",
  // invitations & membership
  "createInvitation", "acceptInvitation", "revokeInvitation", "listInvitations",
  "listMembers", "updateMemberRole", "transferOwnership", "removeMember", "leaveTrip",
  // categories
  "listCategories", "createCategory", "updateCategory", "suggestCategory",
  // expenses
  "createExpense", "updateExpense", "voidExpense", "reviewExpense", "getExpense", "listExpenses",
  // UPI transactions
  "initiateUpiPayment", "recordUpiClientResponse", "submitPaymentReference", "cancelTransaction",
  "verifyTransaction", "reconcileTransaction", "recordRefund", "getTransaction", "listTransactions",
  "listReconciliationQueue",
  // receipts
  "registerReceipt", "getReceiptUrl",
  // settlements & summaries
  "getTripSummary", "recordSettlement", "confirmSettlement", "rejectSettlement", "cancelSettlement", "listSettlements",
  // audit
  "listAuditLogs",
  // offline sync
  "listSyncLog",
];

module.exports = { CALLABLES };
