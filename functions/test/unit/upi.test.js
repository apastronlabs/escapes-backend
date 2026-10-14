"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseUpiQr, buildUpiIntentUri } = require("../../src/domain/upiQr");
const { normalizeClientResponse } = require("../../src/domain/upiResponse");
const { parseDecimalToMinor, formatMinor } = require("../../src/domain/money");

test("parses a merchant QR with fixed amount", () => {
  const qr = parseUpiQr("upi://pay?pa=Cafe.Store@okaxis&pn=Blue%20Tokai%20Cafe&am=245.50&cu=INR&mc=5812&tr=ORD123&tn=Coffee");
  assert.equal(qr.payeeVpa, "cafe.store@okaxis");
  assert.equal(qr.payeeName, "Blue Tokai Cafe");
  assert.equal(qr.amountMinor, 24550);
  assert.equal(qr.amountFixed, true);
  assert.equal(qr.merchantCategoryCode, "5812");
  assert.equal(qr.merchantRef, "ORD123");
});

test("QR without amount lets the user enter one; minimum amount makes it editable", () => {
  assert.equal(parseUpiQr("upi://pay?pa=shop@ybl&pn=Shop").amountFixed, false);
  const q = parseUpiQr("upi://pay?pa=shop@ybl&am=100&mam=50");
  assert.equal(q.amountFixed, false);
  assert.equal(q.minimumAmountMinor, 5000);
});

test("rejects unsupported and malformed QR codes", () => {
  const cases = [
    ["", "EMPTY_QR"],
    ["https://example.com", "UNSUPPORTED_QR_FORMAT"],
    ["000201010211...", "UNSUPPORTED_QR_FORMAT"],
    ["upi://mandate?pa=a@b", "UNSUPPORTED_UPI_ACTION"],
    ["upi://pay?pn=NoVpa", "INVALID_VPA"],
    ["upi://pay?pa=not-a-vpa", "INVALID_VPA"],
    ["upi://pay?pa=a1@bank&cu=USD", "UNSUPPORTED_CURRENCY"],
    ["upi://pay?pa=a1@bank&am=-5", "INVALID_QR_AMOUNT"],
    ["upi://pay?pa=a1@bank&am=1.234", "INVALID_QR_AMOUNT"],
    ["upi://pay?pa=a1@bank&am=0", "INVALID_QR_AMOUNT"],
    ["upi://pay?pa=a1@bank&pa=evil@bank", "DUPLICATE_QR_PARAM"],
    ["upi://pay?pa=a1@bank&pn=%E0%A4", "MALFORMED_QR"],
  ];
  for (const [payload, reason] of cases) assert.throws(() => parseUpiQr(payload), { reason }, payload);
});

test("intent URI is built only from validated fields", () => {
  const uri = buildUpiIntentUri({ payeeVpa: "shop@ybl", payeeName: "A & B", amountMinor: 1005, note: null, merchantRef: null });
  assert.equal(uri, "upi://pay?pa=shop%40ybl&pn=A%20%26%20B&am=10.05&cu=INR");
  const reparsed = parseUpiQr(uri);
  assert.equal(reparsed.amountMinor, 1005);
  assert.equal(reparsed.payeeName, "A & B");
});

test("money parsing and formatting", () => {
  assert.equal(parseDecimalToMinor("1"), 100);
  assert.equal(parseDecimalToMinor("1.5"), 150);
  assert.equal(parseDecimalToMinor("0.01"), 1);
  assert.equal(parseDecimalToMinor("1.001"), null);
  assert.equal(parseDecimalToMinor("1e3"), null);
  assert.equal(formatMinor(5), "0.05");
  assert.equal(formatMinor(123456), "1234.56");
});

test("normalizes Android response strings with varying key names", () => {
  const a = normalizeClientResponse("txnId=AXI123&responseCode=00&Status=SUCCESS&txnRef=SCPABC&ApprovalRefNo=412345678901");
  assert.equal(a.outcome, "SUCCESS_CLAIMED");
  assert.equal(a.fields.approvalRefNo, "412345678901");
  assert.equal(a.fields.txnRef, "SCPABC");
  const b = normalizeClientResponse({ status: "Failure", responseCode: "ZD" });
  assert.equal(b.outcome, "FAILURE");
  const c = normalizeClientResponse({ response: "Status=SUBMITTED&txnRef=X" });
  assert.equal(c.outcome, "SUBMITTED");
  assert.equal(normalizeClientResponse("responseCode=00").outcome, "SUCCESS_CLAIMED");
});

test("missing or conflicting responses are never treated as success", () => {
  assert.equal(normalizeClientResponse(null).outcome, "NO_RESPONSE");
  assert.equal(normalizeClientResponse(null, { userCancelled: true }).outcome, "USER_CANCELLED");
  assert.equal(normalizeClientResponse("garbage").outcome, "UNRECOGNIZED");
  const conflict = normalizeClientResponse("Status=SUCCESS&responseCode=U30");
  assert.equal(conflict.outcome, "UNRECOGNIZED");
  assert.deepEqual(conflict.anomalies, ["STATUS_CODE_CONFLICT"]);
});
