/**
 * T139-H — _autoGenerateForModal must not read from or mutate the globally-
 * shared _detailClientData for a client other than the one it was invoked for.
 *
 * Bug: _autoGenerateForModal(clientId) is a long async flow (ficha read,
 * buildPrescriptionContext, an AI HTTP call, several validation gates —
 * easily 10-40+ seconds). It used the global _detailClientData (which always
 * reflects whichever client is CURRENTLY open in the main detail modal) in
 * three places instead of the clientId-scoped data already fetched via
 * buildPrescriptionContext(clientId):
 *   1. Learned-state activation read _detailClientData before even fetching
 *      prescCtx, so a stale/wrong client's historical topology/exercise
 *      feedback could leak into the plan being generated for `clientId`.
 *   2. The longitudinal validation report read _detailClientData the same way.
 *   3. After saving, the code unconditionally wrote
 *      `_detailClientData.activePlanId = newPlanId` and
 *      `Object.assign(_detailClientData, clientUpdates)` — if the coach had
 *      navigated to a DIFFERENT client while generation was running,
 *      _detailClientData belonged to that other client, so this corrupted
 *      the other client's in-memory/rendered state with `clientId`'s new
 *      plan id, nutrition and supplement data (the Firestore write itself
 *      was correctly scoped to `clientId` — only the shared UI-state object
 *      was corrupted).
 *
 * Fix: T139-H reads _clientData from prescCtx (already fetched fresh for
 * `clientId`) instead of the global for cases 1-2, and guards cases 3 with
 * `_detailClientId === clientId` before touching _detailClientData — the
 * same stale-context pattern used by T123-H/T127-H elsewhere.
 *
 * Run: node tests/t139h-autogenerateformodal-stale-clientdata.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-coach.html', 'utf8');

function extractFnBody(src, fnDecl) {
  var idx = src.indexOf(fnDecl);
  if (idx === -1) return null;
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

console.log('T139-H — _autoGenerateForModal stale _detailClientData guards');

var body = extractFnBody(src, 'async function _autoGenerateForModal(');

test('_autoGenerateForModal function is present', function () {
  assert.ok(body, 'function found in HTML source');
});

test('learned-state activation reads from prescCtx._clientData, not the global', function () {
  assert.ok(body, 'function body present');
  assert.ok(
    body.indexOf('_getActivePersistedLearnedState((prescCtx && prescCtx._clientData) || {})') > -1,
    'learned state must be derived from prescCtx._clientData (clientId-scoped), not _detailClientData'
  );
});

test('learned-state activation happens after prescCtx is built (not before)', function () {
  assert.ok(body, 'function body present');
  var prescIdx = body.indexOf('const prescCtx = await buildPrescriptionContext(clientId);');
  var learnedIdx = body.indexOf('_getActivePersistedLearnedState((prescCtx && prescCtx._clientData) || {})');
  assert.ok(prescIdx > -1, 'buildPrescriptionContext(clientId) call present');
  assert.ok(learnedIdx > -1, 'learned-state line present');
  assert.ok(prescIdx < learnedIdx, 'prescCtx must be fetched before it is used for learned state');
});

test('longitudinal validation report reads from prescCtx._clientData, not the global', function () {
  assert.ok(body, 'function body present');
  assert.ok(
    body.indexOf('_clientData: (prescCtx && prescCtx._clientData) || {}') > -1,
    '_buildLongitudinalValidationReport input must use prescCtx._clientData, not _detailClientData'
  );
});

test('activePlanId mirror onto _detailClientData is guarded by _detailClientId === clientId', function () {
  assert.ok(body, 'function body present');
  var guardRe = /if\s*\(\s*ps\.exists\(\)\s*&&\s*_detailClientId\s*===\s*clientId\s*\)\s*\{[^}]*_detailClientData\.activePlanId\s*=\s*newPlanId/;
  assert.ok(guardRe.test(body), 'writing _detailClientData.activePlanId must be guarded by _detailClientId === clientId');
});

test('Object.assign(_detailClientData, clientUpdates) is guarded by _detailClientId === clientId', function () {
  assert.ok(body, 'function body present');
  var idx = body.indexOf('Object.assign(_detailClientData, clientUpdates)');
  assert.ok(idx > -1, 'Object.assign(_detailClientData, clientUpdates) present');
  var before = body.slice(Math.max(0, idx - 120), idx);
  assert.ok(
    /if\s*\(\s*_detailClientId\s*===\s*clientId\s*\)/.test(before),
    'Object.assign(_detailClientData, clientUpdates) must be guarded by an immediately-preceding if (_detailClientId === clientId)'
  );
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
