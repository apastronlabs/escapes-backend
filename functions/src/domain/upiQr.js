"use strict";

const { parseDecimalToMinor } = require("./money");

/**
 * Parser for UPI "pay" deep links as encoded in merchant/P2P UPI QR codes:
 *   upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>&tr=<ref>&mc=<mcc>...
 *
 * Only the `upi://pay` scheme is accepted. Mandates (upi://mandate), collect
 * requests, EMVCo/Bharat QR payloads and anything else are rejected as
 * unsupported rather than guessed at.
 *
 * Signed QR (`sign` parameter) is preserved but NOT verified: verification
 * needs the PSP's public key, which this backend does not have.
 */

const VPA_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/;
const MCC_RE = /^\d{4}$/;
const MAX_QR_LENGTH = 2048;

class QrError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

function decodeParam(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    throw new QrError("QR contains malformed encoding.", "MALFORMED_QR");
  }
}

function clean(value, max) {
  if (value == null) return null;
  // Strip control characters; QR text is untrusted and is shown back to users.
  const v = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!v) return null;
  return v.slice(0, max);
}

/**
 * @param {string} payload raw QR text
 * @returns {{
 *   scheme: "upi", payeeVpa: string, payeeName: string|null, amountMinor: number|null,
 *   minimumAmountMinor: number|null, currency: "INR", note: string|null, merchantRef: string|null,
 *   merchantCategoryCode: string|null, merchantTerminalId: string|null, url: string|null,
 *   signed: boolean, amountFixed: boolean, rawParams: Object<string,string>
 * }}
 */
function parseUpiQr(payload) {
  if (typeof payload !== "string" || !payload.trim()) throw new QrError("QR payload is empty.", "EMPTY_QR");
  const text = payload.trim();
  if (text.length > MAX_QR_LENGTH) throw new QrError("QR payload is too long.", "QR_TOO_LONG");

  const m = /^upi:\/\/([a-z]+)\?(.*)$/i.exec(text);
  if (!m) {
    if (/^000201/.test(text)) throw new QrError("EMVCo / Bharat QR codes are not supported.", "UNSUPPORTED_QR_FORMAT");
    throw new QrError("Not a UPI payment QR code.", "UNSUPPORTED_QR_FORMAT");
  }
  if (m[1].toLowerCase() !== "pay") throw new QrError(`upi://${m[1]} is not supported.`, "UNSUPPORTED_UPI_ACTION");

  const params = {};
  for (const part of m[2].split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? "" : decodeParam(part.slice(eq + 1));
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      throw new QrError(`QR repeats parameter "${key}".`, "DUPLICATE_QR_PARAM");
    }
    params[key] = value;
  }

  const payeeVpa = clean(params.pa, 320);
  if (!payeeVpa || !VPA_RE.test(payeeVpa)) throw new QrError("QR has no valid payee VPA (pa).", "INVALID_VPA");

  const currency = params.cu ? params.cu.trim().toUpperCase() : "INR";
  if (currency !== "INR") throw new QrError("Only INR UPI payments are supported.", "UNSUPPORTED_CURRENCY");

  let amountMinor = null;
  if (params.am !== undefined && params.am !== "") {
    amountMinor = parseDecimalToMinor(params.am, "INR");
    if (amountMinor === null || amountMinor <= 0) throw new QrError("QR amount is invalid.", "INVALID_QR_AMOUNT");
  }
  let minimumAmountMinor = null;
  if (params.mam !== undefined && params.mam !== "") {
    minimumAmountMinor = parseDecimalToMinor(params.mam, "INR");
    if (minimumAmountMinor === null || minimumAmountMinor <= 0) {
      throw new QrError("QR minimum amount is invalid.", "INVALID_QR_AMOUNT");
    }
  }

  const mcc = clean(params.mc, 4);
  return {
    scheme: "upi",
    payeeVpa: payeeVpa.toLowerCase(),
    payeeName: clean(params.pn, 100),
    amountMinor,
    minimumAmountMinor,
    currency,
    note: clean(params.tn, 80),
    merchantRef: clean(params.tr, 35),
    merchantCategoryCode: mcc && MCC_RE.test(mcc) ? mcc : null,
    merchantTerminalId: clean(params.tid, 35),
    url: clean(params.url, 300),
    signed: typeof params.sign === "string" && params.sign.length > 0,
    // A QR-specified amount is fixed unless a minimum amount explicitly makes it editable.
    amountFixed: amountMinor !== null && minimumAmountMinor === null,
    rawParams: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v).slice(0, 300)])),
  };
}

/**
 * Build the canonical upi://pay URI the client hands to the UPI app.
 * Parameters come only from validated server-side data.
 */
function buildUpiIntentUri({ payeeVpa, payeeName, amountMinor, note, merchantRef, merchantCategoryCode, merchantTerminalId, url }) {
  const { formatMinor } = require("./money");
  const params = [["pa", payeeVpa]];
  if (payeeName) params.push(["pn", payeeName]);
  if (merchantCategoryCode) params.push(["mc", merchantCategoryCode]);
  if (merchantTerminalId) params.push(["tid", merchantTerminalId]);
  if (merchantRef) params.push(["tr", merchantRef]);
  if (note) params.push(["tn", note]);
  params.push(["am", formatMinor(amountMinor, "INR")]);
  params.push(["cu", "INR"]);
  if (url) params.push(["url", url]);
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `upi://pay?${query}`;
}

module.exports = { QrError, VPA_RE, parseUpiQr, buildUpiIntentUri };
