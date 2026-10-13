"use strict";

/**
 * Normalizes what a UPI app handed back to the client.
 *
 * On Android, apps launched with an ACTION_VIEW upi://pay intent *may* return an
 * activity result whose extras contain a `response` string such as
 *   "txnId=...&responseCode=00&Status=SUCCESS&txnRef=...&ApprovalRefNo=..."
 * Key names and casing differ between apps and integrations, some fields are
 * often missing, and nothing in the payload is signed. On iOS there is
 * generally no result at all.
 *
 * Everything here is an UNTRUSTED CLAIM. The normalized outcome only decides
 * which *unverified* state the transaction moves to; it can never confirm it.
 */

const CLIENT_OUTCOMES = Object.freeze({
  SUCCESS_CLAIMED: "SUCCESS_CLAIMED",
  SUBMITTED: "SUBMITTED",
  FAILURE: "FAILURE",
  USER_CANCELLED: "USER_CANCELLED",
  NO_RESPONSE: "NO_RESPONSE",
  UNRECOGNIZED: "UNRECOGNIZED",
});

const MAX_RAW_LENGTH = 4000;

/** Lower-cased alias -> canonical field name. */
const FIELD_ALIASES = {
  status: "status",
  txnstatus: "status",
  responsecode: "responseCode",
  txnid: "txnId",
  transactionid: "txnId",
  txnref: "txnRef",
  tr: "txnRef",
  approvalrefno: "approvalRefNo",
  approvalref: "approvalRefNo",
  approvalrefnumber: "approvalRefNo",
  response: "response",
};

function parseKeyValueString(s) {
  const out = {};
  for (const part of s.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    let value = part.slice(eq + 1);
    try {
      value = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      // keep raw text
    }
    out[part.slice(0, eq)] = value;
  }
  return out;
}

function sanitize(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return v ? v.slice(0, 100) : null;
}

/**
 * @param {string|Object|null} raw  response string, a map of extras, or null when nothing came back
 * @param {{userCancelled?: boolean}} [hints]
 */
function normalizeClientResponse(raw, hints = {}) {
  let fields = {};
  if (raw === null || raw === undefined || raw === "") {
    return {
      outcome: hints.userCancelled ? CLIENT_OUTCOMES.USER_CANCELLED : CLIENT_OUTCOMES.NO_RESPONSE,
      fields: {},
      anomalies: [],
    };
  }
  if (typeof raw === "string") {
    fields = parseKeyValueString(raw.slice(0, MAX_RAW_LENGTH));
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    fields = { ...raw };
    // Some plugins nest the original string under `response`.
    if (typeof fields.response === "string" && fields.response.includes("=")) {
      fields = { ...parseKeyValueString(fields.response.slice(0, MAX_RAW_LENGTH)), ...fields };
    }
  }

  const canonical = {};
  for (const [key, value] of Object.entries(fields)) {
    const alias = FIELD_ALIASES[String(key).toLowerCase()];
    if (alias && alias !== "response" && canonical[alias] === undefined) canonical[alias] = sanitize(value);
  }

  const status = (canonical.status || "").toUpperCase();
  const code = canonical.responseCode || null;
  let outcome;
  const anomalies = [];
  if (["SUCCESS", "SUCCESSFUL", "SUCCESSFULL"].includes(status)) outcome = CLIENT_OUTCOMES.SUCCESS_CLAIMED;
  else if (["SUBMITTED", "PENDING"].includes(status)) outcome = CLIENT_OUTCOMES.SUBMITTED;
  else if (["FAILURE", "FAILED", "FAIL"].includes(status)) outcome = CLIENT_OUTCOMES.FAILURE;
  else if (!status && code === "00") outcome = CLIENT_OUTCOMES.SUCCESS_CLAIMED;
  else outcome = CLIENT_OUTCOMES.UNRECOGNIZED;

  if (outcome === CLIENT_OUTCOMES.FAILURE && code === "00") {
    anomalies.push("STATUS_CODE_CONFLICT");
    outcome = CLIENT_OUTCOMES.UNRECOGNIZED;
  }
  if (outcome === CLIENT_OUTCOMES.SUCCESS_CLAIMED && code && code !== "00") {
    anomalies.push("STATUS_CODE_CONFLICT");
    outcome = CLIENT_OUTCOMES.UNRECOGNIZED;
  }
  return { outcome, fields: canonical, anomalies };
}

module.exports = { CLIENT_OUTCOMES, normalizeClientResponse, MAX_RAW_LENGTH };
