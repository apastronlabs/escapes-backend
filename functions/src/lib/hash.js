"use strict";

const crypto = require("node:crypto");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** JSON with sorted keys so equal payloads hash equally regardless of key order. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Human-friendly internal payment reference, e.g. SCP7K2M9QX4T8B1Z (16 chars, no ambiguous letters). */
function paymentReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = crypto.randomBytes(13);
  let out = "SCP";
  for (const b of buf) out += alphabet[b % alphabet.length];
  return out;
}

module.exports = { sha256Hex, stableStringify, randomToken, paymentReference };
