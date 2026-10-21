"use strict";

const { Timestamp } = require("firebase-admin/firestore");

/** Convert Firestore values into plain JSON for callable responses (Timestamps -> ISO strings). */
function toJson(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    if (typeof value.toDate === "function" && typeof value.seconds === "number") return value.toDate().toISOString();
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJson(v);
    return out;
  }
  return value;
}

/** Opaque pagination cursor: base64url of [sortValueMillis, docId]. */
function encodeCursor(snap, field) {
  if (!snap) return null;
  const v = snap.get(field);
  const millis = v && typeof v.toMillis === "function" ? v.toMillis() : null;
  if (millis === null) return null;
  return Buffer.from(JSON.stringify([millis, snap.id])).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [millis, id] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!Number.isSafeInteger(millis) || typeof id !== "string") return null;
    return { ts: Timestamp.fromMillis(millis), id };
  } catch {
    return null;
  }
}

module.exports = { toJson, encodeCursor, decodeCursor };
