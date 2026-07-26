'use strict';

// Home Scan regression tests (node:test — no extra runner needed).
//   node --test            # deterministic pipeline contract (default)
//   SCAN_TEST_PHOTO=<path> ANTHROPIC_API_KEY=<key> node --test   # + live vision
//
// The deterministic suite feeds a recorded Stage-1 model response for the
// reference BACKYARD photo through the real pipeline and asserts the contract:
//   pair of wicker chaise loungers + wicker side table + wrought-iron bistro set.
// The live suite (opt-in) runs the actual frame -> Claude vision call against a
// real photo and asserts the same item names surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const scan = require('../scan_pipeline');

// --- Recorded Stage-1 vision output for the reference backyard photo. ---------
// Models the spec'd scene: a matched PAIR of wicker chaise loungers (one entry,
// quantity 2, is_set), a wicker side table, and a wrought-iron bistro set. The
// side table is intentionally reported TWICE (different casing/spacing, as if
// seen in two frames) to exercise the dedupe/merge safety net.
const BACKYARD_STAGE1_RAW = JSON.stringify({
  items: [
    { id: '1', name: 'Wicker Chaise Loungers', category: 'Home', quantity: 2, is_set: true,
      condition: 'good', material: 'wicker/rattan', notes: 'matching pair, cushions included', confidence: 0.92 },
    { id: '2', name: 'Wicker Side Table', category: 'Home', quantity: 1, is_set: false,
      condition: 'good', material: 'wicker', notes: 'round top', confidence: 0.85 },
    { id: '3', name: 'wicker side  table', category: 'Home', quantity: 1, is_set: false,
      condition: 'good', material: '', notes: '', confidence: 0.6 },
    { id: '4', name: 'Wrought-Iron Bistro Set', category: 'Home', quantity: 1, is_set: true,
      condition: 'fair', material: 'wrought iron', notes: 'cafe table + 2 chairs, some rust', confidence: 0.88 },
  ],
});

function runStage1(raw) {
  const parsed = scan.extractJson(raw);
  const norm = parsed.items.map((it, i) => scan.normalizeStage1Item(it, i));
  return scan.mergeStage1Items(norm);
}

test('STAGE 1: backyard photo -> pair of loungers + side table + bistro set', () => {
  const items = runStage1(BACKYARD_STAGE1_RAW);

  // 4 raw rows (side table doubled) collapse to 3 distinct items.
  assert.equal(items.length, 3, 'should dedupe to 3 distinct items');

  const byName = Object.fromEntries(items.map((it) => [it.name.toLowerCase(), it]));
  assert.ok(byName['wicker chaise loungers'], 'has the chaise loungers');
  assert.ok(byName['wicker side table'], 'has the side table');
  assert.ok(byName['wrought-iron bistro set'], 'has the bistro set');

  // The matched pair is ONE entry, quantity 2, flagged as a set.
  const loungers = byName['wicker chaise loungers'];
  assert.equal(loungers.quantity, 2);
  assert.equal(loungers.is_set, true);

  // The duplicated side table merged to a single quantity-1 entry, keeping the
  // higher-confidence material/notes.
  const table = byName['wicker side table'];
  assert.equal(table.quantity, 1);
  assert.equal(table.is_set, false);
  assert.equal(table.material, 'wicker');
  assert.equal(table.notes, 'round top');

  // All three are Home; conditions normalized to the resale vocabulary.
  for (const it of items) assert.equal(it.category, 'Home');
  assert.equal(byName['wrought-iron bistro set'].condition, 'fair');
  // IDs re-sequenced 1..n after merge.
  assert.deepEqual(items.map((it) => it.id), ['1', '2', '3']);
});

test('frame sampling: pickEvenly spans the whole clip', () => {
  const frames = Array.from({ length: 30 }, (_, i) => i);
  const six = scan.pickEvenly(frames, 6);
  assert.equal(six.length, 6);
  assert.equal(six[0], 0, 'includes first frame');
  assert.equal(six[5], 29, 'includes last frame');
  // short clips: fewer frames than target -> use them all (single photo -> 1).
  assert.deepEqual(scan.pickEvenly([7, 8], 6), [7, 8]);
  assert.deepEqual(scan.pickEvenly([42], 6), [42]);
});

test('STAGE 2: condition-weighted comp value + nego bump + qty total', () => {
  const item = runStage1(BACKYARD_STAGE1_RAW)[0]; // loungers: Good, qty 2
  // per-unit comp range 120-200; the model's own `suggested` is ignored.
  const price = scan.normalizeStage2Price(
    '```json\n{"id":"1","low":120,"high":200,"suggested":500,"reason":"good wicker pair"}\n```',
    item,
  );
  assert.equal(price.low, 120);
  assert.equal(price.high, 200);
  // PART 1: Good -> 0.5 (mid) of [120,200] = 160.
  assert.equal(price.comp_value, 160);
  // PART 3: +8% nego bump -> 173 per unit.
  assert.equal(price.per_item_price, 173);
  // PART 2: per-unit x quantity(2) = 346 total displayed.
  assert.equal(price.suggested, 346);
  assert.equal(price.comp_value_total, 320);
  assert.match(price.reason, /Good condition → priced in the middle of the comp range/);
  assert.match(price.reason, /negotiation room/);

  const merged = scan.mergeItemWithPrice(item, price);
  assert.equal(merged.title, item.name);
  assert.equal(merged.price, 346);          // TOTAL
  assert.equal(merged.per_item_price, 173);
  assert.equal(merged.comp_value, 160);
  assert.equal(merged.priceLow, 120);
  assert.equal(merged.priceHigh, 200);
  assert.equal(merged.conditionLabel, 'Good');
});

test('STAGE 2: swapped low/high; unknown condition; single qty', () => {
  const p = scan.normalizeStage2Price({ low: 90, high: 40, suggested: 0 }, {});
  assert.equal(p.low, 40);
  assert.equal(p.high, 90);
  // unknown condition -> 0.42 of [40,90] = 61; +8% -> 66; qty 1.
  assert.equal(p.comp_value, 61);
  assert.equal(p.per_item_price, 66);
  assert.equal(p.suggested, 66);
});

test('STAGE 3 BUNDLE: combined price + optional 10% discount', () => {
  const priced = [
    { suggested: 160 }, { suggested: 45 }, { suggested: 120 },
  ];
  const full = scan.computeBundlePrice(priced, false);
  assert.equal(full.subtotal, 325);
  assert.equal(full.price, 325);
  assert.equal(full.discount_applied, false);

  const discounted = scan.computeBundlePrice(priced, true);
  assert.equal(discounted.subtotal, 325);
  assert.equal(discounted.price, 293, '10% off 325 = 292.5 -> 293');
  assert.equal(discounted.discount_applied, true);

  // bundle ad shaping: model bullets honored; price overridden by caller.
  const ad = scan.normalizeAd(
    '{"title":"Backyard Oasis Set","description":"Relax in style.","bullets":["Two loungers","Side table"],"price":0}',
    { title: 'Bundle', price: 325 },
  );
  assert.equal(ad.title, 'Backyard Oasis Set');
  assert.deepEqual(ad.bullets, ['Two loungers', 'Side table']);
  assert.equal(ad.price, 325, 'empty model price falls back to computed');
});

test('STAGE 3 SINGLE: one ad per item, price falls back to suggested', () => {
  const item = scan.mergeItemWithPrice(
    runStage1(BACKYARD_STAGE1_RAW)[0],
    { low: 120, high: 200, suggested: 160, reason: 'x' },
  );
  const ad = scan.normalizeAd('{"title":"Wicker Lounger Pair","description":"d","bullets":[],"price":0}', {
    title: item.name, price: scan.safeNum(item.suggested),
  });
  assert.equal(ad.title, 'Wicker Lounger Pair');
  assert.equal(ad.price, 160);
});

test('totals: scan total = sum of suggested', () => {
  const items = [{ suggested: 160 }, { suggested: 45 }, { suggested: 120 }];
  assert.equal(scan.computeTotal(items), 325);
});

test('robustness: junk vision output does not throw the parser contract', () => {
  assert.throws(() => scan.extractJson('totally not json'));
  // normalizers tolerate garbage rather than crash.
  const it = scan.normalizeStage1Item({}, 0);
  assert.equal(it.name, 'Untitled item');
  assert.equal(it.quantity, 1);
  assert.equal(it.category, 'Other');
});

// --- OPT-IN live integration test --------------------------------------------
// Skipped unless SCAN_TEST_PHOTO points to a real backyard photo AND
// ANTHROPIC_API_KEY is set. Uses ANTHROPIC_MODEL if provided (never hardcoded).
const LIVE = !!(process.env.SCAN_TEST_PHOTO && process.env.ANTHROPIC_API_KEY);

test('LIVE: real backyard photo Stage-1 detects the expected items', { skip: !LIVE }, async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  let sharp;
  try { sharp = require('sharp'); } catch (_) { sharp = null; }

  const raw = fs.readFileSync(process.env.SCAN_TEST_PHOTO);
  let jpeg = raw;
  if (sharp) {
    jpeg = await sharp(raw).rotate().resize({ width: 1024, withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer();
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: scan.STAGE1_ITEMIZE_PROMPT },
      ],
    }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const items = scan.mergeStage1Items(
    (scan.extractJson(text).items || []).map((it, i) => scan.normalizeStage1Item(it, i)));

  const blob = items.map((it) => it.name.toLowerCase()).join(' | ');
  console.log('LIVE Stage-1 items:', JSON.stringify(items, null, 2));
  assert.match(blob, /lounger|chaise/, 'expected wicker chaise loungers');
  assert.match(blob, /side table|table/, 'expected wicker side table');
  assert.match(blob, /bistro/, 'expected wrought-iron bistro set');
});
