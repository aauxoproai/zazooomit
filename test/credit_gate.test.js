'use strict';

// Guardrails for the server-side publish credit gate (credit_gate.js).
// Regression: on 2026-09-29 two accounts holding 1 signup credit posted 2 and 3
// listings because the app charged AFTER publishing and ignored failures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gate = require('../credit_gate');

const makeError = (code, msg) => Object.assign(new Error(msg), { code });
const base = { supabaseUrl: 'https://x.supabase.co', serviceKey: 'svc', makeError };
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('requireCredits: blocks when balance is below the number of listings', async () => {
  const fetchImpl = async () => res(200, [{ balance: 1 }]);
  await assert.rejects(gate.requireCredits({ ...base, fetchImpl, uid: 'u', count: 3 }), (e) => e.code === 'resource-exhausted');
  assert.equal(await gate.requireCredits({ ...base, fetchImpl, uid: 'u', count: 1 }), 1);
});

test('requireCredits: no ledger rows means 0 credits, not unlimited', async () => {
  const fetchImpl = async () => res(200, []);
  await assert.rejects(gate.requireCredits({ ...base, fetchImpl, uid: 'u', count: 1 }), (e) => e.code === 'resource-exhausted');
});

test('requireCredits: fails CLOSED when the database is unreachable', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(gate.requireCredits({ ...base, fetchImpl, uid: 'u', count: 1 }), (e) => e.code === 'unavailable');
});

test('chargeListing: charges as the caller, keyed on the listing id', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return res(200, 0); };
  await gate.chargeListing({ ...base, fetchImpl, authorization: 'Bearer user-token', listingId: 'L1' });
  assert.match(seen.url, /\/rest\/v1\/rpc\/spend_credit$/);
  assert.equal(seen.init.headers.Authorization, 'Bearer user-token');
  assert.deepEqual(JSON.parse(seen.init.body), { p_amount: 1, p_idempotency_key: 'L1', p_reason: 'listing' });
});

test('chargeListing: insufficient_credits is refused, never swallowed', async () => {
  const fetchImpl = async () => res(400, '{"code":"P0001","message":"insufficient_credits"}');
  await assert.rejects(gate.chargeListing({ ...base, fetchImpl, authorization: 'Bearer t', listingId: 'L' }), (e) => e.code === 'resource-exhausted');
});

test('chargeListing: network errors and missing tokens fail CLOSED', async () => {
  const boom = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(gate.chargeListing({ ...base, fetchImpl: boom, authorization: 'Bearer t', listingId: 'L' }), (e) => e.code === 'unavailable');
  await assert.rejects(gate.chargeListing({ ...base, fetchImpl: boom, authorization: undefined, listingId: 'L' }), (e) => e.code === 'unavailable');
});

test('publishListingsFromDetection charges before it writes anything', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = src.indexOf('exports.publishListingsFromDetection');
  const end = src.indexOf('\nexports.', start + 10);
  const fn = src.slice(start, end === -1 ? undefined : end);
  const gateAt = fn.indexOf('creditGate.requireCredits(');
  assert.ok(gateAt > 0, 'requireCredits must be called');
  assert.ok(gateAt < fn.indexOf('downloadImage('), 'balance must be checked before any work');
  const charges = [...fn.matchAll(/creditGate\.chargeListing\(/g)].map((m) => m.index);
  assert.equal(charges.length, 2, 'both bundle and separate branches must charge');
  const bundleAt = fn.indexOf("if (mode === 'bundle') {");
  const separateAt = fn.indexOf('----- SEPARATE');
  for (const [from, to] of [[bundleAt, separateAt], [separateAt, fn.length]]) {
    const branch = fn.slice(from, to);
    const c = branch.indexOf('creditGate.chargeListing(');
    for (const write of ['savePublic(', 'postToMarketplace(', 'ref.set(']) {
      assert.ok(c > 0 && c < branch.indexOf(write), `charge must precede ${write}`);
    }
  }
});
