"use strict";

const { categorize } = require("../domain/categorizer");

/**
 * Categorization service interface: `suggest(input, categories) -> {categoryId, source, matched}`.
 *
 * The default implementation is purely deterministic (MCC + keyword rules).
 * An AI-backed implementation can be added later behind this same interface;
 * it must fall back to the deterministic result and must never be required
 * for any write path. None is wired up here on purpose.
 */
function createDeterministicCategorizer() {
  return {
    name: "deterministic",
    async suggest(input, categories) {
      return categorize(input, categories);
    },
  };
}

module.exports = { createDeterministicCategorizer };
