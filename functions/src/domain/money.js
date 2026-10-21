"use strict";

/**
 * All money is stored as integer minor units (paise for INR). Never floats.
 */

const SUPPORTED_CURRENCIES = Object.freeze({ INR: { minorDigits: 2 } });

/** Parse a decimal string such as "120", "120.5" or "120.50" into minor units. Returns null if invalid. */
function parseDecimalToMinor(value, currency = "INR") {
  const cfg = SUPPORTED_CURRENCIES[currency];
  if (!cfg || typeof value !== "string") return null;
  const s = value.trim();
  const re = new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${cfg.minorDigits}}))?$`);
  const m = re.exec(s);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number((m[2] || "").padEnd(cfg.minorDigits, "0") || "0");
  const total = major * 10 ** cfg.minorDigits + minor;
  return Number.isSafeInteger(total) ? total : null;
}

/** Format minor units as a UPI `am` value, e.g. 12050 -> "120.50". */
function formatMinor(minor, currency = "INR") {
  const digits = SUPPORTED_CURRENCIES[currency].minorDigits;
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 10 ** digits);
  const frac = String(abs % 10 ** digits).padStart(digits, "0");
  return `${sign}${major}.${frac}`;
}

module.exports = { SUPPORTED_CURRENCIES, parseDecimalToMinor, formatMinor };
