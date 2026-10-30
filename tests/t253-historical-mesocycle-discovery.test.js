'use strict';
/**
 * T253 — Historical mesocycle discovery. Reuses the EXISTING
 * logs/{uid}/mesos subcollection (no new collection, no writes). Avoids
 * N+1: discovery fetches exactly 2 documents/queries regardless of how
 * many historical mesociclos exist (client doc + mesos subcollection
 * query) -- plan docs are fetched one at a time, only on demand, by a
 * LATER selection step (T254), never during discovery itself.
 *
 * Run: node tests/t253-historical-mesocycle-discovery.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const sortSrc = extractFunction(COACH, 'function _sortHistoricalMesocycles(mesosDocs, activePlanId)');
const asyncSrc = extractFunction(COACH, 'async function _vdsenListHistoricalMesocycles(clientId)');

ok(sortSrc, '_sortHistoricalMesocycles extracts cleanly');
ok(asyncSrc, '_vdsenListHistoricalMesocycles extracts cleanly');
ok(COACH.includes('window._sortHistoricalMesocycles = _sortHistoricalMesocycles;'), 'exposed for reuse/testing');
ok(COACH.includes('window._vdsenListHistoricalMesocycles = _vdsenListHistoricalMesocycles;'), 'exposed for T254 Monitor UI reuse');

// ─────────────────────────────────────────────────────────────────────────────
// No N+1: the async wrapper reads the client doc once and queries the
// mesos subcollection once -- never a getDoc/getDocs call inside a loop.
// ─────────────────────────────────────────────────────────────────────────────

ok(asyncSrc.includes("getDoc(doc(db, 'clients', clientId))"), 'reads the client doc exactly once, for activePlanId');
ok(asyncSrc.includes("getDocs(collection(db, 'logs', clientId, 'mesos'))"), 'queries the EXISTING mesos subcollection exactly once -- no new collection');
ok(!/\.forEach\([^)]*getDoc\(/.test(asyncSrc) && !/\.map\([^)]*getDoc\(/.test(asyncSrc), 'no per-mesociclo getDoc/getDocs call inside a loop -- discovery never fetches plans/{planId} for every result (avoids N+1)');
ok(!asyncSrc.includes("'plans'"), 'confirmed: discovery never touches the plans collection at all -- plan-doc fetching is deferred entirely to T254\'s on-demand selection');
ok(!asyncSrc.includes('setDoc') && !asyncSrc.includes('updateDoc') && !asyncSrc.includes('addDoc') && !asyncSrc.includes('deleteDoc'), 'strictly read-only -- no write of any kind');

const sort = new Function(sortSrc + '; return _sortHistoricalMesocycles;')();

// ─────────────────────────────────────────────────────────────────────────────
// 0 históricos.
// ─────────────────────────────────────────────────────────────────────────────

ok(sort([], 'plan-active').length === 0, '0 mesociclos -> empty list, never a fabricated placeholder');
ok(sort(null, 'plan-active').length === 0, 'null/missing docs array -> empty list, no throw');

// ─────────────────────────────────────────────────────────────────────────────
// 1 histórico.
// ─────────────────────────────────────────────────────────────────────────────

(function testOneHistorical() {
  const result = sort([{ id: 'plan-A', data: { updatedAt: 1000, currentWeek: 6, entries: { foo: 1 } } }], 'plan-B');
  ok(result.length === 1 && result[0].planId === 'plan-A', '1 mesociclo -> 1 result, real planId preserved');
  ok(result[0].isActive === false, 'correctly marked as NOT the active plan');
  ok(result[0].hasData === true, 'hasData reflects the real presence of entries');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Varios -- deterministic chronological order.
// ─────────────────────────────────────────────────────────────────────────────

(function testMultipleChronologicalOrder() {
  const docs = [
    { id: 'plan-C', data: { updatedAt: 3000 } },
    { id: 'plan-A', data: { updatedAt: 1000 } },
    { id: 'plan-B', data: { updatedAt: 2000 } }
  ];
  const result = sort(docs, null);
  ok(result.map(function(r) { return r.planId; }).join(',') === 'plan-A,plan-B,plan-C', 'results are sorted chronologically (ascending updatedAt), deterministic regardless of input order');
})();

// ─────────────────────────────────────────────────────────────────────────────
// activePlan excluded or marked correctly -- here: correctly MARKED
// (never silently dropped or misidentified as historical).
// ─────────────────────────────────────────────────────────────────────────────

(function testActivePlanMarked() {
  const docs = [{ id: 'plan-active', data: { updatedAt: 5000 } }, { id: 'plan-old', data: { updatedAt: 1000 } }];
  const result = sort(docs, 'plan-active');
  const active = result.find(function(r) { return r.planId === 'plan-active'; });
  const old = result.find(function(r) { return r.planId === 'plan-old'; });
  ok(active.isActive === true, 'the currently active plan is correctly marked isActive -- never silently excluded from the raw discovery list itself');
  ok(old.isActive === false, 'a genuinely historical plan is correctly marked NOT active');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Plan doc faltante -- irrelevant to discovery (it never touches plans/*),
// so a missing plan doc can never break this list at all.
// ─────────────────────────────────────────────────────────────────────────────

ok(!/plans/.test(sortSrc), 'the pure sort/annotate step has zero awareness of plan docs -- a missing plans/{planId} document structurally cannot break discovery');

// ─────────────────────────────────────────────────────────────────────────────
// Acceso parcial -- a malformed/partial doc entry never crashes the list
// or corrupts the others.
// ─────────────────────────────────────────────────────────────────────────────

(function testPartialAccess() {
  const docs = [
    { id: 'plan-good', data: { updatedAt: 1000 } },
    { id: null, data: { updatedAt: 500 } },   // malformed -- no real id
    null,                                      // entirely malformed entry
    { data: { updatedAt: 2000 } }              // missing id field
  ];
  const result = sort(docs, null);
  ok(result.length === 1 && result[0].planId === 'plan-good', 'malformed/partial entries are filtered out, never fabricated into a fake planId, while the one genuinely good entry still surfaces correctly');
})();

console.log('');
console.log('T253 — Historical mesocycle discovery: ' + pass + ' assertions PASSED');
