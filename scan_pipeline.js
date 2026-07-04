// Home Scan pipeline — pure helpers (Stages 1-3)
// ===============================================
//
// Side-effect-free transforms + the verbatim product prompts for the Home Scan
// feature (scanItems / generateScanAds in index.js). Kept in its own module so
// the logic can be unit-tested with `node --test` WITHOUT booting the Firebase
// Admin SDK / Functions runtime (index.js calls initializeApp() at load).
//
// index.js owns the actual model calls (Anthropic vision/text) and Storage I/O;
// this module owns frame selection, JSON parsing, normalization, dedupe/merge,
// pricing math, and ad shaping. Anthropic model id is NEVER hardcoded here — the
// caller passes ANTHROPIC_MODEL; these helpers only shape inputs/outputs.

'use strict';

const CATEGORIES = [
  'Electronics', 'Clothing', 'Shoes', 'Home', 'Toys',
  'Sports', 'Books', 'Tools', 'Beauty', 'Other',
];
// Stage-1 conditions use the lowercase resale grades from the ITEMIZE prompt.
const CONDITIONS = ['new', 'like-new', 'good', 'fair'];

// ---------------------------------------------------------------------------
// PROMPTS (verbatim per product spec — do not paraphrase)
// ---------------------------------------------------------------------------

// STAGE 1 — ITEMIZE (sent once, with all frames, as the vision instruction).
const STAGE1_ITEMIZE_PROMPT = `You are a resale cataloguer. Look at ALL frames as ONE scene. List EVERY distinct sellable
item. Count duplicates and treat identical items as a set (e.g. two matching chairs = a pair).
EXCLUDE anything NOT physically movable by the seller — fences, decks, patios, pergolas,
in-ground or built-in pools, sheds, gates, railings, retaining walls, built-in or attached
cabinets, counters and grills, the ground, sky, lawn, and plants rooted in the ground. Do NOT
list these at all; if you are unsure whether something can be carried away and sold, leave it
out. For each item give: a short name, category, quantity, condition (new/like-new/good/fair),
and any brand/material clues visible. For material, do NOT default to "plastic" or "resin"
when an item could be metal or aluminium (patio furniture is frequently powder-coated metal):
if you are not certain, say "metal" and record the uncertainty in notes rather than guessing
plastic. Do not merge different items. Do not skip background items. Respond with ONLY
valid JSON, no prose, no markdown:
{
  "items": [
    {"id":"1","name":"","category":"","quantity":1,"is_set":false,
     "condition":"","material":"","notes":"","confidence":0.0}
  ]
}`;

// STAGE 2 — PRICE EACH ITEM (one call per item, grounded in live sold comps via
// the web_search tool). {item JSON} is substituted.
function buildStage2PricePrompt(item) {
  const itemJson = JSON.stringify(item);
  return `Given this item: ${itemJson}, and that the seller is in South Florida (used resale market):
Price a SINGLE UNIT (one piece) of this item — if quantity > 1, still price just ONE unit; the app multiplies by quantity. Search recent SOLD/completed resale listings for this exact item (prefer eBay sold listings, then Facebook Marketplace and OfferUp). Base the PER-UNIT price on what comparable items in similar condition ACTUALLY SOLD for in the US, adjusted for South Florida and the item's condition. Return ONLY JSON (all values PER UNIT): {"id":"","low":0,"high":0,"suggested":0,"confidence":"low|medium|high","reason":"one or two short sentences citing condition and typical local resale range","comp_basis":"one-line note of what comps you found (e.g. 'eBay sold $90-140 for similar aluminium bistro sets')"}. confidence is your certainty in this price: 'high' = several close, recent sold comps; 'medium' = few or loosely-matching comps; 'low' = little or no comp data (estimate). If no comps are found, set confidence to 'low' and comp_basis to 'no comps found — model estimate' so the UI can flag it. Price realistically for a fast local sale, not retail.`;
}

// Ad copy is TEXT-ONLY: serialize ONLY the text essentials, never the whole item
// (guards against any oversized/image field bloating the context window).
function adItemText(it) {
  return {
    title: it.name || it.title || '',
    category: it.category,
    condition: it.conditionLabel || it.condition,
    quantity: it.quantity,
    price: it.suggested != null ? it.suggested : it.price,
    notes: String(it.notes || '').slice(0, 400),
  };
}

// STAGE 3 — BUNDLE ad (one call). {items+prices} is substituted.
// Same rules as the SINGLE prompt, plus: sell the value of taking the whole set
// together at one price, and give the bundle a catchy name.
function buildBundleAdPrompt(itemsWithPrices) {
  const payload = JSON.stringify((itemsWithPrices || []).map(adItemText));
  return `Write a high-converting marketplace listing for a BUNDLE of items sold together: ${payload}. You are a great salesperson making a buyer WANT the whole set. (1) punchy benefit-led title — give the bundle a catchy name; (2) warm 3-5 sentence description: open with the best thing, paint how they'll enjoy it, sell the value of taking the whole set together at one price, convey it's great value in words (without stating any dollar amount); (3) 3-5 short feature/benefit bullets. State condition honestly but briefly and POSITIVELY; never lead with flaws; mention wear once, factually. Never invent features or falsely claim like-new. CRITICAL: do NOT write any dollar amount in the title, description, or bullets — no retail or "replicate at retail" price, no bundle total, no savings/discount figure. The listing displays its own price separately, so any number you state risks conflicting with it; sell the value in words only. Tone: confident, friendly, exciting. Return ONLY JSON {"title":"","description":"","bullets":[],"price":0}.`;
}

// STAGE 3 — SINGLE ad (one call per item). {item+price} is substituted.
function buildSingleAdPrompt(item) {
  const payload = JSON.stringify(adItemText(item));
  return `Write a high-converting marketplace listing for ONE item: ${payload}. You are a great salesperson making a buyer WANT it. (1) punchy benefit-led title; (2) warm 3-5 sentence description: open with the best thing, paint how they'll enjoy it, convey it's great value in words (without stating any dollar amount); (3) 3-5 short feature/benefit bullets. State condition honestly but briefly and POSITIVELY; never lead with flaws; mention wear once, factually. Never invent features or falsely claim like-new. CRITICAL: do NOT write any dollar amount in the title, description, or bullets — no retail or "replicate at retail" price, no bundle total, no savings/discount figure. The listing displays its own price separately, so any number you state risks conflicting with it; sell the value in words only. Tone: confident, friendly, exciting. Return ONLY JSON {"title":"","description":"","bullets":[],"price":0}.`;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Coerce anything to a finite, non-negative number, else fallback. */
function safeNum(v, fallback = 0) {
  const n = typeof v === 'number'
    ? v
    : parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// PART 3: list ~15-20% above the condition-adjusted comp value for nego room.
// Negotiation margin added on top of the comp value. Kept modest so listed
// prices stay realistic for a FAST local sale (was 1.18 = +18%, felt too high).
const NEGO_BUMP = 1.08;

/**
 * PART 1: where within [low, high] the suggested price sits, by condition.
 * Excellent/Like-New -> near high; Good -> upper-middle; Fair -> lower-middle;
 * Poor/For-Parts -> near low. Returns a fraction 0..1.
 */
function conditionPosition(condition) {
  // Tuned DOWN for fast local resale: price toward the MIDDLE of the comp
  // range, not the top (prior 0.95/0.7 read too high). Good ~ mid.
  const v = String(condition || '').toLowerCase().replace(/[\s_-]/g, '');
  if (['new', 'likenew', 'excellent', 'mint'].includes(v)) return 0.72;
  if (['good', 'great', 'verygood'].includes(v)) return 0.5;
  if (['fair', 'used', 'acceptable'].includes(v)) return 0.3;
  if (['poor', 'forparts', 'asis', 'salvage', 'broken'].includes(v)) return 0.1;
  return 0.42; // unknown: lower-middle
}

/** Human label for where in the range the price landed (for the reason line). */
function positionDesc(pos) {
  if (pos >= 0.85) return 'top';
  if (pos >= 0.6) return 'upper part';
  if (pos >= 0.4) return 'middle';
  if (pos >= 0.2) return 'lower part';
  return 'bottom';
}

/**
 * Pick `n` items spread evenly across `arr` (first and last always included).
 * Returns a copy of the whole array if it already has <= n items.
 */
function pickEvenly(arr, n) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  if (n <= 1) return [arr[0]];
  if (arr.length <= n) return arr.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (n - 1));
    out.push(arr[idx]);
  }
  return out;
}

/** Strip code fences / prose around a JSON object and parse it. Throws on junk. */
function extractJson(raw) {
  let cleaned = String(raw == null ? '' : raw).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// STAGE 1 normalization + dedupe/merge
// ---------------------------------------------------------------------------

function normalizeCategory(c) {
  if (typeof c !== 'string') return 'Other';
  const hit = CATEGORIES.find((x) => x.toLowerCase() === c.trim().toLowerCase());
  return hit || 'Other';
}

function normalizeCondition(c) {
  if (typeof c !== 'string') return 'good';
  const v = c.trim().toLowerCase().replace(/\s+/g, '-');
  if (CONDITIONS.includes(v)) return v;
  const map = {
    likenew: 'like-new', 'like-new': 'like-new', mint: 'like-new',
    excellent: 'like-new', new: 'new', good: 'good', great: 'good',
    used: 'good', fair: 'fair', poor: 'fair', worn: 'fair',
  };
  return map[v] || 'good';
}

/** Title-case grade for the app/postListing condition field (which is Title Case). */
function conditionLabel(lower) {
  return ({ new: 'New', 'like-new': 'Like New', good: 'Good', fair: 'Fair' })[lower] || 'Good';
}

/** Normalize one raw Stage-1 item to the strict spec shape. */
function normalizeStage1Item(it, idx) {
  it = it && typeof it === 'object' ? it : {};
  const name = (it.name != null ? String(it.name) : '').trim() || 'Untitled item';
  const quantity = Math.max(1, Math.round(safeNum(it.quantity, 1)) || 1);
  let confidence = safeNum(it.confidence, 0);
  if (confidence > 1) confidence = confidence > 100 ? 1 : confidence / 100; // tolerate 0-100 scale
  if (confidence > 1) confidence = 1;
  return {
    id: it.id != null && String(it.id).trim() ? String(it.id).trim() : String(idx + 1),
    name,
    category: normalizeCategory(it.category),
    quantity,
    is_set: it.is_set === true || quantity > 1,
    condition: normalizeCondition(it.condition),
    material: (it.material != null ? String(it.material) : '').trim(),
    notes: (it.notes != null ? String(it.notes) : '').trim(),
    confidence,
  };
}

function mergeKey(it) {
  return `${it.name.toLowerCase().replace(/\s+/g, ' ').trim()}|${it.category}`;
}

/**
 * Safety-net dedupe/merge: the SAME real-world item reported in multiple frames
 * collapses to ONE entry. We keep the LARGER quantity (one chair seen in 4
 * frames is still one chair — never sum frame counts), OR the is_set flag, and
 * the higher-confidence material/notes. IDs are re-sequenced for a clean list.
 */
function mergeStage1Items(items) {
  const byKey = new Map();
  for (const it of items) {
    const key = mergeKey(it);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...it }); continue; }
    prev.quantity = Math.max(prev.quantity, it.quantity);
    prev.is_set = prev.is_set || it.is_set || prev.quantity > 1;
    if (it.confidence > prev.confidence) {
      prev.confidence = it.confidence;
      if (it.material) prev.material = it.material;
      if (it.notes) prev.notes = it.notes;
    } else {
      if (!prev.material && it.material) prev.material = it.material;
      if (!prev.notes && it.notes) prev.notes = it.notes;
    }
  }
  return Array.from(byKey.values()).map((it, i) => ({ ...it, id: String(i + 1) }));
}

// ---------------------------------------------------------------------------
// STAGE 2 pricing
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Stage-2 price response. low/high are the PER-UNIT comp range.
 *  - PART 1: comp_value = condition-weighted position within [low, high]
 *            (NOT a blind midpoint).
 *  - PART 3: per_item_price = comp_value bumped ~18% for negotiation room.
 *  - PART 2: suggested = per_item_price x quantity (the displayed TOTAL).
 * Returns {low, high, comp_value, per_item_price, suggested, comp_value_total,
 *          reason, comp_basis} (all per-unit except suggested/comp_value_total).
 */
function normalizeStage2Price(raw, item) {
  let p = {};
  try { p = typeof raw === 'string' ? extractJson(raw) : (raw || {}); } catch (_) { p = {}; }
  let low = safeNum(p.low, 0);
  let high = safeNum(p.high, low);
  if (high < low) { const t = low; low = high; high = t; }

  const pos = conditionPosition(item && item.condition);
  const comp_value = Math.round(low + pos * (high - low));      // per-unit
  const per_item_price = Math.round(comp_value * NEGO_BUMP);    // per-unit, +nego
  const quantity = Math.max(1, Math.round(safeNum(item && item.quantity, 1)) || 1);
  const suggested = per_item_price * quantity;                 // TOTAL
  const comp_value_total = comp_value * quantity;

  const pct = Math.round((NEGO_BUMP - 1) * 100);
  const modelReason = (p.reason != null ? String(p.reason) : '').trim();
  const reason = `${conditionLabel(item && item.condition)} condition → priced in the `
    + `${positionDesc(pos)} of the comp range; listed +~${pct}% for negotiation room.`
    + (modelReason ? ` ${modelReason}` : '');
  const comp_basis = (p.comp_basis != null ? String(p.comp_basis) : '').trim();
  // Price-confidence for the card. Trust the model's 'low'|'medium'|'high';
  // if missing/garbage default to 'medium' (never 'high' unprompted), or 'low'
  // when comp_basis says there were no comps. A missing field can't crash.
  const rawConf = String(p.confidence || '').trim().toLowerCase();
  const confidence = ['low', 'medium', 'high'].includes(rawConf)
    ? rawConf
    : (/no comps found/.test(comp_basis.toLowerCase()) ? 'low' : 'medium');
  return { low, high, comp_value, per_item_price, suggested, comp_value_total, reason, comp_basis, confidence };
}

/**
 * Merge a priced result onto a Stage-1 item. Adds compatibility aliases
 * (title/price/priceLow/priceHigh/conditionLabel) so the existing ListingPreview
 * UI, postListing, and publishListingsFromDetection keep working unchanged.
 */
function mergeItemWithPrice(item, price) {
  return {
    ...item,
    low: price.low,                          // per-unit comp floor
    high: price.high,                        // per-unit comp ceiling
    comp_value: price.comp_value,            // per-unit condition-adjusted comp
    per_item_price: price.per_item_price,    // per-unit listed (+nego)
    suggested: price.suggested,              // TOTAL = per_item_price x quantity
    comp_value_total: price.comp_value_total,
    reason: price.reason,
    comp_basis: price.comp_basis || '',
    // ---- aliases for the existing app schema ----
    title: item.name,
    price: price.suggested,                  // TOTAL
    priceLow: price.low,
    priceHigh: price.high,
    conditionLabel: conditionLabel(item.condition),
  };
}

function computeTotal(items) {
  return Math.round(items.reduce(
    (acc, it) => acc + safeNum(it.suggested != null ? it.suggested : it.price), 0));
}

// ---------------------------------------------------------------------------
// STAGE 3 ads
// ---------------------------------------------------------------------------

/** Bundle pricing: sum of suggested prices, optional 10% bundle discount. */
function computeBundlePrice(items, applyDiscount) {
  const sum = items.reduce(
    (acc, it) => acc + safeNum(it.suggested != null ? it.suggested : it.price), 0);
  const subtotal = Math.round(sum);
  const price = applyDiscount ? Math.round(sum * 0.9) : subtotal;
  return { subtotal, price, discount_applied: !!applyDiscount };
}

/** A readable fallback bullet line for an item (used if the model omits bullets). */
function bulletFor(it) {
  const name = it.name || it.title || 'Item';
  const cond = it.conditionLabel || conditionLabel(it.condition) || '';
  const qty = it.quantity > 1 ? ` (set of ${it.quantity})` : '';
  return `${name}${qty}${cond ? ` — ${cond}` : ''}`;
}

/** Normalize a raw ad response into {title,description,bullets,price}. */
function normalizeAd(raw, fallback) {
  fallback = fallback || {};
  let a = {};
  try { a = typeof raw === 'string' ? extractJson(raw) : (raw || {}); } catch (_) { a = {}; }
  const title = (a.title != null ? String(a.title) : '').trim()
    || fallback.title || 'Untitled listing';
  const description = (a.description != null ? String(a.description) : '').trim();
  const bullets = Array.isArray(a.bullets)
    ? a.bullets.map((b) => String(b).trim()).filter(Boolean)
    : [];
  let price = safeNum(a.price, 0);
  if (!price) price = safeNum(fallback.price, 0);
  return { title, description, bullets, price };
}

/**
 * Salvage every COMPLETE {...} item object from a truncated/malformed items
 * JSON array (e.g. the model hit max_tokens mid-array, producing
 * "SyntaxError: Expected ',' or ']' after array element"). Walks brace depth,
 * ignoring braces inside strings, and JSON.parses each closed object; a
 * truncated final object is simply skipped. Returns [] if nothing usable.
 */
function salvageItems(text) {
  const s = String(text == null ? '' : text);
  const itemsAt = s.indexOf('"items"');
  const arrStart = s.indexOf('[', itemsAt < 0 ? 0 : itemsAt);
  if (arrStart < 0) return [];
  const out = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = arrStart + 1; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { out.push(JSON.parse(s.slice(objStart, i + 1))); } catch (_) { /* skip truncated */ }
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) {
      break;
    }
  }
  return out;
}

module.exports = {
  CATEGORIES,
  CONDITIONS,
  STAGE1_ITEMIZE_PROMPT,
  buildStage2PricePrompt,
  buildBundleAdPrompt,
  buildSingleAdPrompt,
  safeNum,
  pickEvenly,
  extractJson,
  salvageItems,
  normalizeCategory,
  normalizeCondition,
  conditionLabel,
  normalizeStage1Item,
  mergeStage1Items,
  normalizeStage2Price,
  mergeItemWithPrice,
  computeTotal,
  computeBundlePrice,
  bulletFor,
  normalizeAd,
};
