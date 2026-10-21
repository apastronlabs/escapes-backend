"use strict";

const { MCC_TO_CATEGORY_KEY, FALLBACK_CATEGORY_KEY } = require("./categories");

/**
 * Deterministic categorization: merchant category code first, then keyword
 * matches on merchant name / description, then the trip's "other" category.
 *
 * Optional AI categorization is a separate service with the same signature
 * (see src/services/categorizationService.js). It is not wired to any model.
 */

function normalizeText(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function keywordMatches(text, keyword) {
  const k = normalizeText(keyword);
  if (!k) return false;
  // Whole-word / whole-phrase match to avoid "bar" matching "barber".
  return (` ${text} `).includes(` ${k} `);
}

/**
 * @param {{merchantName?: string, description?: string, merchantCategoryCode?: string}} input
 * @param {Array<{id: string, key?: string, keywords?: string[], archived?: boolean}>} categories trip categories
 * @returns {{categoryId: string|null, source: "RULE_MCC"|"RULE_KEYWORD"|"DEFAULT", matched: string|null}}
 */
function categorize(input, categories) {
  const active = categories.filter((c) => !c.archived);
  const byKey = new Map(active.filter((c) => c.key).map((c) => [c.key, c]));

  const mccKey = input.merchantCategoryCode && MCC_TO_CATEGORY_KEY[input.merchantCategoryCode];
  if (mccKey && byKey.has(mccKey)) {
    return { categoryId: byKey.get(mccKey).id, source: "RULE_MCC", matched: input.merchantCategoryCode };
  }

  const text = normalizeText(`${input.merchantName || ""} ${input.description || ""}`);
  if (text) {
    // Longest keyword wins so "hotel restaurant" beats "hotel"; ties broken by category id for determinism.
    let best = null;
    for (const c of active) {
      for (const kw of c.keywords || []) {
        if (!keywordMatches(text, kw)) continue;
        const len = normalizeText(kw).length;
        if (!best || len > best.len || (len === best.len && c.id < best.category.id)) {
          best = { category: c, keyword: kw, len };
        }
      }
    }
    if (best) return { categoryId: best.category.id, source: "RULE_KEYWORD", matched: best.keyword };
  }

  const fallback = byKey.get(FALLBACK_CATEGORY_KEY);
  return { categoryId: fallback ? fallback.id : null, source: "DEFAULT", matched: null };
}

module.exports = { categorize, normalizeText };
