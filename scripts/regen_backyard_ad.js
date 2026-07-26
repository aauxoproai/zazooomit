'use strict';

// Regenerate the reference ad copy for the backyard loungers scene.
//   ANTHROPIC_API_KEY=<key> node scripts/regen_backyard_ad.js
// Optional: ANTHROPIC_MODEL=<id> (defaults to the scanItems model).
//
// Stage 3 is TEXT-ONLY — it takes the priced item JSON, not the photo — so this
// reproduces the exact ad copy the live callable would return, without a photo.
// Prints the SINGLE ad per item and the BUNDLE ad. Use it to confirm the copy
// LEADS WITH BENEFIT and frames wear as value (never "fading/dirt/sold as-is").

const scan = require('../scan_pipeline');

// Stage 1+2 output for the reference backyard scene (matches the regression
// fixture in test/scan_pipeline.test.js): a matched PAIR of wicker chaise
// loungers, a wicker side table, and a wrought-iron bistro set — each priced.
const ITEMS = [
  scan.mergeItemWithPrice(
    { id: '1', name: 'Wicker Chaise Loungers', category: 'Home', quantity: 2, is_set: true,
      condition: 'good', material: 'wicker/rattan', notes: 'matched pair, light sun-fading', confidence: 0.92 },
    { low: 90, high: 200, suggested: 110, reason: 'Good wicker pair; local resale 90-200, priced low for a fast sale.' },
  ),
  scan.mergeItemWithPrice(
    { id: '2', name: 'Wicker Side Table', category: 'Home', quantity: 1, is_set: false,
      condition: 'good', material: 'wicker', notes: 'round top', confidence: 0.85 },
    { low: 25, high: 60, suggested: 35, reason: 'Sturdy wicker accent table; typical local resale 25-60.' },
  ),
  scan.mergeItemWithPrice(
    { id: '3', name: 'Wrought-Iron Bistro Set', category: 'Home', quantity: 1, is_set: true,
      condition: 'fair', material: 'wrought iron', notes: 'cafe table + 2 chairs, some surface rust', confidence: 0.88 },
    { low: 60, high: 140, suggested: 85, reason: 'Solid iron set with surface rust; resale 60-140, priced to move.' },
  ),
];

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY to run. Showing the prompts only:\n');
    console.log('--- SINGLE prompt (item 1) ---\n' + scan.buildSingleAdPrompt(ITEMS[0]) + '\n');
    console.log('--- BUNDLE prompt ---\n' + scan.buildBundleAdPrompt(ITEMS) + '\n');
    process.exit(2);
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  const ask = async (content, maxTokens) => {
    const msg = await client.messages.create({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] });
    const raw = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return scan.normalizeAd(raw, {});
  };

  console.log(`model: ${model}\n`);
  console.log('================ SINGLE ADS ================');
  for (const it of ITEMS) {
    const ad = await ask(scan.buildSingleAdPrompt(it), 700);
    console.log(`\n## ${it.name}  (suggested $${it.suggested})`);
    console.log(JSON.stringify(ad, null, 2));
  }

  console.log('\n================ BUNDLE AD ================');
  const { subtotal, price } = scan.computeBundlePrice(ITEMS, false);
  const bundle = await ask(scan.buildBundleAdPrompt(ITEMS), 1200);
  bundle.price = price; // computed combined price is authoritative
  console.log(`(subtotal $${subtotal} → bundle price $${price})`);
  console.log(JSON.stringify(bundle, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
