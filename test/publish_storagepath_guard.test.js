'use strict';

// Guardrail: bundle/photo publish must reject an EMPTY storagePath.
//
// The 2026-07-04 "Couldn't post" bug was the camera/video path sending an empty
// storagePath; sanitizeStoragePath() rejecting it (invalid-argument -> HTTP 400)
// is the server-side backstop, and the client now falls back to a real uploaded
// path. This test asserts the server guard stays in place so an empty path can
// never silently sail through. Source-assertion (non-invasive) so it does not
// load the functions runtime; runs via the predeploy `node --test` gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('sanitizeStoragePath rejects empty / non-string storagePath', () => {
  assert.ok(/function sanitizeStoragePath/.test(src),
    'sanitizeStoragePath must exist');
  assert.ok(/typeof p !== 'string' \|\| p\.length === 0/.test(src),
    'empty-string / non-string guard must be present');
  assert.ok(/throw new HttpsError\('invalid-argument'/.test(src),
    'a bad path must throw invalid-argument (surfaces as HTTP 400)');
});

test('publishListingsFromDetection sanitizes storagePath before download', () => {
  assert.ok(/sanitizeStoragePath\(data\.storagePath\)/.test(src),
    'publish must run storagePath through sanitizeStoragePath');
});
