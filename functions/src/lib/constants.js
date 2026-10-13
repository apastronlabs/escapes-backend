"use strict";

/** Bump when a document shape changes incompatibly. Stored on every document. */
const SCHEMA_VERSION = 1;

const REGION = "us-central1";

const COLLECTIONS = Object.freeze({
  USERS: "users",
  TRIPS: "trips",
  TRIP_MEMBERSHIPS: "tripMemberships",
  INVITATIONS: "invitations",
  TRANSACTIONS: "transactions",
  EXPENSES: "expenses",
  EXPENSE_SPLITS: "expenseSplits",
  CATEGORIES: "categories",
  SETTLEMENTS: "settlements",
  AUDIT_LOGS: "auditLogs",
  RECONCILIATION_RECORDS: "reconciliationRecords",
  IDEMPOTENCY_KEYS: "idempotencyKeys",
  PAYMENT_REFERENCE_CLAIMS: "paymentReferenceClaims",
  RECEIPTS: "receipts",
});

/** Subcollection under transactions/{id} holding every raw client report. */
const CLIENT_REPORTS_SUBCOLLECTION = "clientReports";

const ROLES = Object.freeze({ OWNER: "OWNER", ADMIN: "ADMIN", MEMBER: "MEMBER" });
const MANAGER_ROLES = Object.freeze([ROLES.OWNER, ROLES.ADMIN]);
const MEMBERSHIP_STATUS = Object.freeze({ ACTIVE: "ACTIVE", REMOVED: "REMOVED", LEFT: "LEFT" });

const LIMITS = Object.freeze({
  MAX_MEMBERS_PER_TRIP: 100,
  MAX_PARTICIPANTS_PER_EXPENSE: 100,
  MAX_CATEGORIES_PER_TRIP: 100,
  MAX_TITLE_LENGTH: 120,
  MAX_NOTE_LENGTH: 1000,
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE_SIZE: 25,
  MAX_CLIENT_REPORTS_PER_TRANSACTION: 20,
  MAX_RECEIPT_BYTES: 10 * 1024 * 1024,
  INVITATION_DEFAULT_TTL_HOURS: 24 * 7,
  INVITATION_MAX_TTL_HOURS: 24 * 30,
  /** Read cap for on-demand summaries. Above this, move to incremental aggregates. */
  MAX_SUMMARY_DOCS: 5000,
});

module.exports = {
  SCHEMA_VERSION,
  REGION,
  COLLECTIONS,
  CLIENT_REPORTS_SUBCOLLECTION,
  ROLES,
  MANAGER_ROLES,
  MEMBERSHIP_STATUS,
  LIMITS,
};
