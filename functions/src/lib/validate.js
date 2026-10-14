"use strict";

const { invalid } = require("./errors");

/**
 * Minimal, dependency-free input validation. Each helper returns the
 * normalized value or throws `invalid-argument` naming the field.
 */

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function requireObject(data, field = "data") {
  if (!isPlainObject(data)) throw invalid(`${field} must be an object.`, "INVALID_PAYLOAD");
  return data;
}

function string(data, field, { required = true, min = 1, max = 200, pattern, trim = true } = {}) {
  let v = data[field];
  if (v === undefined || v === null || v === "") {
    if (required) throw invalid(`${field} is required.`, "MISSING_FIELD", { field });
    return null;
  }
  if (typeof v !== "string") throw invalid(`${field} must be a string.`, "INVALID_FIELD", { field });
  if (trim) v = v.trim();
  if (v.length < min || v.length > max) {
    throw invalid(`${field} must be ${min}-${max} characters.`, "INVALID_FIELD", { field });
  }
  if (pattern && !pattern.test(v)) throw invalid(`${field} has an invalid format.`, "INVALID_FIELD", { field });
  return v;
}

function id(data, field, opts = {}) {
  return string(data, field, { ...opts, max: 128, pattern: ID_RE });
}

function integer(data, field, { required = true, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = data[field];
  if (v === undefined || v === null) {
    if (required) throw invalid(`${field} is required.`, "MISSING_FIELD", { field });
    return null;
  }
  if (!Number.isSafeInteger(v)) throw invalid(`${field} must be an integer.`, "INVALID_FIELD", { field });
  if (v < min || v > max) throw invalid(`${field} must be between ${min} and ${max}.`, "INVALID_FIELD", { field });
  return v;
}

function boolean(data, field, { required = false, defaultValue = null } = {}) {
  const v = data[field];
  if (v === undefined || v === null) {
    if (required) throw invalid(`${field} is required.`, "MISSING_FIELD", { field });
    return defaultValue;
  }
  if (typeof v !== "boolean") throw invalid(`${field} must be a boolean.`, "INVALID_FIELD", { field });
  return v;
}

function oneOf(data, field, allowed, { required = true, defaultValue = null } = {}) {
  const v = data[field];
  if (v === undefined || v === null) {
    if (required) throw invalid(`${field} is required.`, "MISSING_FIELD", { field });
    return defaultValue;
  }
  if (!allowed.includes(v)) {
    throw invalid(`${field} must be one of: ${allowed.join(", ")}.`, "INVALID_FIELD", { field });
  }
  return v;
}

function idArray(data, field, { required = true, min = 1, max = 100 } = {}) {
  const v = data[field];
  if (v === undefined || v === null) {
    if (required) throw invalid(`${field} is required.`, "MISSING_FIELD", { field });
    return null;
  }
  if (!Array.isArray(v)) throw invalid(`${field} must be an array.`, "INVALID_FIELD", { field });
  if (v.length < min || v.length > max) {
    throw invalid(`${field} must contain ${min}-${max} items.`, "INVALID_FIELD", { field });
  }
  for (const item of v) {
    if (typeof item !== "string" || !ID_RE.test(item)) {
      throw invalid(`${field} contains an invalid id.`, "INVALID_FIELD", { field });
    }
  }
  if (new Set(v).size !== v.length) throw invalid(`${field} contains duplicates.`, "DUPLICATE_IDS", { field });
  return v;
}

/** ISO date string YYYY-MM-DD. Stored as a string to avoid timezone drift. */
function isoDate(data, field, { required = false } = {}) {
  const v = string(data, field, { required, min: 10, max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  if (v && Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw invalid(`${field} is not a valid date.`, "INVALID_FIELD", { field });
  }
  return v;
}

// Accepted timestamp range: 2000-01-01 to 2100-01-01 (catches seconds-vs-milliseconds mix-ups).
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A point in time, returned as epoch milliseconds. Accepts epoch milliseconds, an ISO-8601
 * string ("2026-10-14T19:15:31.000Z"; no offset = UTC; a date alone = midnight UTC), or a
 * Firestore-style map ({seconds, nanoseconds} or {_seconds, _nanoseconds}).
 */
function timestampMillis(data, field, { required = false } = {}) {
  const raw = data[field];
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw invalid(`${field} is required.`, "MISSING_FIELD", { field });
    return null;
  }
  let ms = NaN;
  if (typeof raw === "number") {
    ms = Number.isSafeInteger(raw) ? raw : NaN;
  } else if (typeof raw === "string" && ISO_DATETIME_RE.test(raw.trim())) {
    let s = raw.trim().replace(" ", "T");
    if (s.length === 10) s += "T00:00:00Z";
    else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
    ms = Date.parse(s);
  } else if (isPlainObject(raw)) {
    const sec = raw.seconds ?? raw._seconds;
    const nanos = raw.nanoseconds ?? raw._nanoseconds ?? 0;
    if (Number.isSafeInteger(sec) && Number.isSafeInteger(nanos)) ms = sec * 1000 + Math.floor(nanos / 1e6);
  }
  if (!Number.isFinite(ms) || ms < MIN_TIMESTAMP_MS || ms > MAX_TIMESTAMP_MS) {
    throw invalid(`${field} must be a timestamp (epoch milliseconds or ISO-8601 string).`, "INVALID_FIELD", { field });
  }
  return ms;
}

/** Client-generated idempotency key (UUID or similar). */
function idempotencyKey(data) {
  return string(data, "idempotencyKey", { min: 8, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
}

function pageSize(data, defaultSize, maxSize) {
  const v = integer(data, "pageSize", { required: false, min: 1, max: maxSize });
  return v || defaultSize;
}

/** Reject unknown keys so typos don't silently become no-ops. */
function onlyKeys(data, allowed) {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) throw invalid(`Unknown field: ${key}.`, "UNKNOWN_FIELD", { field: key });
  }
}

module.exports = {
  ID_RE,
  isPlainObject,
  requireObject,
  string,
  id,
  integer,
  boolean,
  oneOf,
  idArray,
  isoDate,
  timestampMillis,
  idempotencyKey,
  pageSize,
  onlyKeys,
};
