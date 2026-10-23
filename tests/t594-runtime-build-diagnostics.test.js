'use strict';
// Issue #115: static source guard for the runtime evidence needed to tell a
// stale PWA shell apart from an actual mobile layout regression.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

const id = /<meta name="vdsen-client-build" content="([^"]+)">/.exec(client);

test('T594-1 the delivered shell exposes one non-empty build identity and registers that exact worker URL', () => {
  assert.ok(id && id[1], 'build meta is present');
  assert.ok(client.includes("window.VDSEN_CLIENT_BUILD = '" + id[1] + "'"));
  assert.match(client, /navigator\.serviceWorker\.register\('\/sw\.js\?build='\+encodeURIComponent\(window\.VDSEN_CLIENT_BUILD\), \{ updateViaCache: 'none' \}\)/);
});

test('T594-2 a worker cache is keyed by that URL identity; legacy v13 cannot be mistaken for this build', () => {
  assert.match(sw, /const BUILD = new URL\(self\.location\.href\)\.searchParams\.get\('build'\) \|\| 'legacy-v13';/);
  assert.match(sw, /const CACHE = 'vdsen-' \+ BUILD;/);
  assert.doesNotMatch(sw, /const CACHE = 'vdsen-v13';/, 'negative control: a fixed old cache name would preserve the ambiguity');
});

test('T594-3 diagnostic probe is read-only and contains the live CSS/SW/viewport facts requested for Brave triage', () => {
  const start = client.indexOf('window.getVdsenRuntimeDiagnostics = async function()');
  const end = client.indexOf('// T155-H:', start);
  assert.ok(start >= 0 && end > start, 'read-only probe exists before app boot');
  const probe = client.slice(start, end);
  for (const required of ['getComputedStyle(el)', 'getBoundingClientRect()', 'navigator.serviceWorker.getRegistrations()', 'navigator.serviceWorker.controller', 'caches.keys()', 'visualViewport', "performance.getEntriesByType('resource')", 'scrollTop', 'scrollWidth']) assert.ok(probe.includes(required), required);
  assert.doesNotMatch(probe, /(?:setItem|removeItem|setDoc|updateDoc|deleteDoc|fetch\s*\(|postMessage|caches\.delete)/, 'probe must not mutate storage, Firestore, network, worker, or CacheStorage');
});
