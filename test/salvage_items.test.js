'use strict';

// Regression test for the scanItems Stage-1 truncated-JSON failure
// (2026-07-04 16:57Z: "SyntaxError: Expected ',' or ']' after array element in
// JSON at position 6032"). A busy room-scan (16-19 items) overflowed the itemize
// token budget and the vision JSON was truncated mid-array; the strict parse
// threw and the WHOLE scan was lost.
//
// The raw model output was NOT logged at the time (Stage-1's catch logged only
// String(e), not the payload), so this fixture is a FAITHFUL REPRODUCTION of the
// failure MODE — a valid {"items":[...]} array truncated mid-object — not the
// exact original bytes. The salvage parser (scan.salvageItems) must still recover
// every COMPLETE item so the scan degrades instead of dying.
//
//   node --test    (runs via `npm test` and the pre-deploy gate)

const test = require('node:test');
const assert = require('node:assert/strict');
const scan = require('../scan_pipeline');

// One realistic Stage-1 item (mirrors the STAGE1_ITEMIZE_PROMPT field shape).
function itemObj(i) {
  return {
    id: String(i),
    name: `Sellable Item ${i} With A Reasonably Long Descriptive Name`,
    category: 'Home',
    quantity: 1,
    is_set: false,
    condition: 'good',
    material: 'mixed materials, wood and metal',
    notes: 'visible in multiple frames; typical used condition, minor wear noted',
    confidence: 0.8,
  };
}

// Build a model-style payload with N items, wrapped in ```json fences like the
// real Claude output. The truncated variant cuts the LAST item mid-string so the
// array is left open (max_tokens-mid-array cutoff). Returns complete-item count.
function buildPayloads(n) {
  const items = Array.from({ length: n }, (_, k) => itemObj(k + 1));
  const clean = '```json\n' + JSON.stringify({ items }, null, 2) + '\n```';
  const full = JSON.stringify({ items });
  const cut = full.indexOf('"notes"', full.lastIndexOf('{')); // inside the last object
  const truncated = '```json\n' + full.slice(0, cut + 20);
  return { clean, truncated, completeCount: n - 1, truncatedLen: truncated.length };
}

test('clean Stage-1 payload parses to the full item list', () => {
  const { clean } = buildPayloads(8);
  const viaExtract = scan.extractJson(clean);
  assert.ok(Array.isArray(viaExtract.items), 'extractJson returns items array');
  assert.equal(viaExtract.items.length, 8);
  const viaSalvage = scan.salvageItems(clean);
  assert.equal(viaSalvage.length, 8, 'salvage returns all items on a clean payload');
});

test('truncated Stage-1 payload: strict parse throws, salvage recovers complete items', () => {
  const { truncated, completeCount, truncatedLen } = buildPayloads(20); // 16-19+ item scene
  // 1) Confirm the fixture reproduces the real failure: strict parse must throw.
  const stripped = truncated.replace(/^```(?:json)?\s*/i, '');
  assert.throws(() => JSON.parse(stripped), SyntaxError, 'fixture must be genuinely truncated');
  assert.throws(() => scan.extractJson(truncated), 'extractJson (strict) also fails');
  // (sanity: payload is substantial, like the ~6KB real failure)
  assert.ok(truncatedLen > 3000, `truncated payload len ${truncatedLen}`);
  // 2) salvage recovers every COMPLETE item (all but the truncated last one).
  const salvaged = scan.salvageItems(truncated);
  assert.ok(salvaged.length >= completeCount,
    `expected >= ${completeCount} salvaged, got ${salvaged.length}`);
  assert.equal(salvaged[0].id, '1', 'first item recovered intact');
  assert.equal(typeof salvaged[salvaged.length - 1].name, 'string', 'last recovered item well-formed');
});

test('salvage returns [] when there is no items array', () => {
  assert.deepEqual(scan.salvageItems('no json here'), []);
  assert.deepEqual(scan.salvageItems(''), []);
  assert.deepEqual(scan.salvageItems(null), []);
});
