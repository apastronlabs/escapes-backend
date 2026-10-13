"use strict";

/**
 * Default categories seeded into every new trip. Each trip gets its own copy,
 * so renaming or archiving in one trip never affects another.
 * Keywords drive deterministic categorization and are editable per trip.
 */
const DEFAULT_CATEGORIES = Object.freeze([
  { key: "food", name: "Food", keywords: ["restaurant", "cafe", "dhaba", "biryani", "pizza", "kitchen", "food", "swiggy", "zomato", "bakery", "hotel restaurant", "mess", "canteen", "eatery"] },
  { key: "drinks", name: "Drinks", keywords: ["bar", "pub", "brewery", "wine", "beer", "liquor", "juice", "tea", "chai", "coffee", "lounge"] },
  { key: "transport", name: "Transport", keywords: ["uber", "ola", "rapido", "taxi", "cab", "metro", "railway", "irctc", "bus", "fuel", "petrol", "diesel", "parking", "toll", "fastag", "airline", "airways", "indigo", "auto"] },
  { key: "accommodation", name: "Accommodation", keywords: ["hotel", "resort", "hostel", "inn", "stay", "homestay", "lodge", "airbnb", "oyo", "villa", "guest house"] },
  { key: "activities", name: "Activities", keywords: ["ticket", "museum", "park", "tour", "adventure", "trek", "rafting", "safari", "entry", "show", "cinema", "pvr", "inox"] },
  { key: "shopping", name: "Shopping", keywords: ["store", "mall", "fashion", "boutique", "emporium", "handicraft", "souvenir", "mart", "retail"] },
  { key: "groceries", name: "Groceries", keywords: ["grocery", "supermarket", "kirana", "bigbasket", "blinkit", "zepto", "dmart", "fresh", "vegetable", "fruits", "provision"] },
  { key: "other", name: "Other", keywords: [] },
]);

const FALLBACK_CATEGORY_KEY = "other";

/**
 * ISO 18245 merchant category codes (the `mc` parameter of a merchant UPI QR)
 * mapped to default category keys. Only well-known codes are listed.
 */
const MCC_TO_CATEGORY_KEY = Object.freeze({
  5811: "food", // caterers
  5812: "food", // eating places, restaurants
  5814: "food", // fast food
  5813: "drinks", // bars, taverns
  5921: "drinks", // package stores - beer, wine, liquor
  4111: "transport", // local/suburban commuter transport
  4112: "transport", // passenger railways
  4121: "transport", // taxicabs
  4131: "transport", // bus lines
  4511: "transport", // airlines
  4784: "transport", // tolls
  5541: "transport", // service stations
  5542: "transport", // automated fuel dispensers
  7523: "transport", // parking
  7011: "accommodation", // hotels, motels, resorts
  7032: "accommodation", // sporting and recreational camps
  7033: "accommodation", // trailer parks, campgrounds
  7991: "activities", // tourist attractions and exhibits
  7996: "activities", // amusement parks
  7832: "activities", // motion picture theaters
  7999: "activities", // recreation services
  5311: "shopping", // department stores
  5651: "shopping", // family clothing
  5947: "shopping", // gift, card, novelty and souvenir shops
  5411: "groceries", // grocery stores, supermarkets
  5499: "groceries", // misc food stores
});

module.exports = { DEFAULT_CATEGORIES, FALLBACK_CATEGORY_KEY, MCC_TO_CATEGORY_KEY };
