"use strict";

const { COLLECTIONS, SCHEMA_VERSION, MANAGER_ROLES, LIMITS } = require("../lib/constants");
const v = require("../lib/validate");
const { requireAuth, loadMemberContext } = require("../lib/access");
const { runIdempotent } = require("../lib/idempotency");
const { writeAudit, diff } = require("../lib/audit");
const { invalid, notFound, precondition } = require("../lib/errors");
const { toJson } = require("../lib/serialize");
const { createDeterministicCategorizer } = require("./categorizationService");

function keywordsArg(data) {
  const kws = data.keywords;
  if (kws === undefined || kws === null) return null;
  if (!Array.isArray(kws) || kws.length > 50) throw invalid("keywords must be an array of at most 50 strings.", "INVALID_FIELD", { field: "keywords" });
  const out = [];
  for (const k of kws) {
    if (typeof k !== "string" || !k.trim() || k.length > 40) throw invalid("Each keyword must be 1-40 characters.", "INVALID_FIELD", { field: "keywords" });
    out.push(k.trim().toLowerCase());
  }
  return [...new Set(out)];
}

async function loadTripCategories(ctx, tx, tripId) {
  const q = ctx.db.collection(COLLECTIONS.CATEGORIES).where("tripId", "==", tripId).limit(LIMITS.MAX_CATEGORIES_PER_TRIP + 1);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function makeCategoryService(ctx, { categorizer = createDeterministicCategorizer() } = {}) {
  const { db, FieldValue } = ctx;

  async function listCategories(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    const tripId = v.id(data, "tripId");
    const includeArchived = v.boolean(data, "includeArchived", { defaultValue: false });
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    const cats = await loadTripCategories(ctx, null, tripId);
    return {
      categories: cats
        .filter((c) => includeArchived || !c.archived)
        .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name))
        .map(toJson),
    };
  }

  async function createCategory(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "name", "keywords", "idempotencyKey"]);
    const tripId = v.id(data, "tripId");
    const name = v.string(data, "name", { max: 40 });
    const keywords = keywordsArg(data) || [];
    const key = v.idempotencyKey(data);
    return runIdempotent(ctx, { uid, operation: "createCategory", key, payload: { tripId, name, keywords } }, async (tx) => {
      await loadMemberContext(ctx, tx, tripId, uid);
      const existing = await loadTripCategories(ctx, tx, tripId);
      if (existing.length >= LIMITS.MAX_CATEGORIES_PER_TRIP) throw precondition("This trip has too many categories.", "CATEGORY_LIMIT");
      if (existing.some((c) => !c.archived && c.name.toLowerCase() === name.toLowerCase())) {
        throw precondition("A category with this name already exists.", "DUPLICATE_CATEGORY_NAME");
      }
      const ref = db.collection(COLLECTIONS.CATEGORIES).doc();
      tx.set(ref, {
        categoryId: ref.id,
        tripId,
        key: null,
        name,
        keywords,
        isDefault: false,
        archived: false,
        sortOrder: existing.length,
        createdByUid: uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        schemaVersion: SCHEMA_VERSION,
      });
      writeAudit(ctx, tx, { tripId, actorUid: uid, action: "CATEGORY_CREATED", entityType: "category", entityId: ref.id, changes: { name } });
      return { categoryId: ref.id };
    });
  }

  /** Rename, edit keywords, archive or restore. Members may rename/edit; archiving needs a manager. */
  async function updateCategory(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "categoryId", "name", "keywords", "archived"]);
    const tripId = v.id(data, "tripId");
    const categoryId = v.id(data, "categoryId");
    const updates = {};
    if (data.name !== undefined) updates.name = v.string(data, "name", { max: 40 });
    const keywords = keywordsArg(data);
    if (keywords) updates.keywords = keywords;
    if (data.archived !== undefined) updates.archived = v.boolean(data, "archived", { required: true });
    if (!Object.keys(updates).length) throw invalid("Nothing to update.", "NO_CHANGES");

    return db.runTransaction(async (tx) => {
      const { membership } = await loadMemberContext(ctx, tx, tripId, uid);
      if (updates.archived !== undefined && !MANAGER_ROLES.includes(membership.role)) {
        throw precondition("Only trip admins can archive or restore categories.", "INSUFFICIENT_ROLE");
      }
      const all = await loadTripCategories(ctx, tx, tripId);
      const cat = all.find((c) => c.id === categoryId);
      if (!cat) throw notFound("Category not found.", "CATEGORY_NOT_FOUND");
      if (updates.archived === true && cat.key === "other") {
        throw precondition("The fallback category cannot be archived.", "CANNOT_ARCHIVE_FALLBACK");
      }
      const finalName = updates.name || cat.name;
      const finalArchived = updates.archived ?? cat.archived;
      if (!finalArchived && all.some((c) => c.id !== categoryId && !c.archived && c.name.toLowerCase() === finalName.toLowerCase())) {
        throw precondition("A category with this name already exists.", "DUPLICATE_CATEGORY_NAME");
      }
      const changes = diff(cat, { ...cat, ...updates }, Object.keys(updates));
      tx.update(db.collection(COLLECTIONS.CATEGORIES).doc(categoryId), { ...updates, updatedAt: FieldValue.serverTimestamp() });
      const action = updates.archived === true ? "CATEGORY_ARCHIVED" : updates.archived === false ? "CATEGORY_RESTORED" : "CATEGORY_UPDATED";
      writeAudit(ctx, tx, { tripId, actorUid: uid, action, entityType: "category", entityId: categoryId, changes });
      return { categoryId };
    });
  }

  async function suggestCategory(request) {
    const uid = requireAuth(request);
    const data = v.requireObject(request.data);
    v.onlyKeys(data, ["tripId", "merchantName", "description", "merchantCategoryCode"]);
    const tripId = v.id(data, "tripId");
    const input = {
      merchantName: v.string(data, "merchantName", { required: false, max: 100 }),
      description: v.string(data, "description", { required: false, max: 200 }),
      merchantCategoryCode: v.string(data, "merchantCategoryCode", { required: false, min: 4, max: 4, pattern: /^\d{4}$/ }),
    };
    await loadMemberContext(ctx, null, tripId, uid, { allowArchivedTrip: true });
    const cats = await loadTripCategories(ctx, null, tripId);
    return categorizer.suggest(input, cats);
  }

  return { listCategories, createCategory, updateCategory, suggestCategory };
}

module.exports = { makeCategoryService, loadTripCategories };
