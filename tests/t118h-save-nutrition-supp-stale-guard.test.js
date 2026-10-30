/**
 * T118-H — saveNutritionPlan / saveSupplementPlan must capture _detailClientId
 * before the first await and guard DOM writes against stale client context.
 *
 * Bug: both functions read _detailClientId to build the Firestore doc ref, but
 * then continued to write DOM elements (nutrition-view, supplement-view) and
 * call togglePlanEditor() AFTER the await. If the coach navigated to client B
 * while the Firestore write for client A was in flight, the DOM updates would
 * corrupt client B's nutrition/supplement view with client A's data.
 *
 * Fix: each function now:
 *   1. Captures const _clientIdSnap = _detailClientId before any await.
 *   2. Passes _clientIdSnap to doc(...) so the write always targets the right client.
 *   3. Checks `if (_detailClientId !== _clientIdSnap) return;` before DOM writes.
 *
 * Run: node tests/t118h-save-nutrition-supp-stale-guard.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
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

console.log('T118-H — saveNutritionPlan / saveSupplementPlan stale-client DOM guard');

// ── saveNutritionPlan ──

test('saveNutritionPlan captures _clientIdSnap before await', function() {
  var body = extractFnBody(src, 'async function saveNutritionPlan(');
  assert.ok(body, 'saveNutritionPlan found');
  // _clientIdSnap must be assigned BEFORE the const data block and the await
  var snapIdx = body.indexOf('_clientIdSnap = _detailClientId');
  var awaitIdx = body.indexOf('await updateDoc');
  assert.ok(snapIdx > -1, '_clientIdSnap assigned');
  assert.ok(awaitIdx > -1, 'await updateDoc present');
  assert.ok(snapIdx < awaitIdx, '_clientIdSnap captured before await updateDoc');
});

test('saveNutritionPlan passes _clientIdSnap to doc()', function() {
  var body = extractFnBody(src, 'async function saveNutritionPlan(');
  assert.ok(body, 'saveNutritionPlan found');
  assert.ok(
    body.indexOf('doc(db, "clients", _clientIdSnap)') > -1,
    'doc() call uses _clientIdSnap not _detailClientId'
  );
});

test('saveNutritionPlan guards DOM write with stale check', function() {
  var body = extractFnBody(src, 'async function saveNutritionPlan(');
  assert.ok(body, 'saveNutritionPlan found');
  // Guard must appear after the await and before the DOM write
  var guardIdx = body.indexOf('_detailClientId !== _clientIdSnap');
  var domIdx   = body.indexOf('nutrition-view');
  assert.ok(guardIdx > -1, 'stale guard present');
  assert.ok(domIdx > -1, 'DOM write present');
  assert.ok(guardIdx < domIdx, 'stale guard appears before DOM write');
});

// ── saveSupplementPlan ──

test('saveSupplementPlan captures _clientIdSnap before await', function() {
  var body = extractFnBody(src, 'async function saveSupplementPlan(');
  assert.ok(body, 'saveSupplementPlan found');
  var snapIdx  = body.indexOf('_clientIdSnap = _detailClientId');
  var awaitIdx = body.indexOf('await updateDoc');
  assert.ok(snapIdx > -1, '_clientIdSnap assigned');
  assert.ok(awaitIdx > -1, 'await updateDoc present');
  assert.ok(snapIdx < awaitIdx, '_clientIdSnap captured before await updateDoc');
});

test('saveSupplementPlan passes _clientIdSnap to doc()', function() {
  var body = extractFnBody(src, 'async function saveSupplementPlan(');
  assert.ok(body, 'saveSupplementPlan found');
  assert.ok(
    body.indexOf('doc(db, "clients", _clientIdSnap)') > -1,
    'doc() call uses _clientIdSnap'
  );
});

test('saveSupplementPlan guards DOM write with stale check', function() {
  var body = extractFnBody(src, 'async function saveSupplementPlan(');
  assert.ok(body, 'saveSupplementPlan found');
  var guardIdx = body.indexOf('_detailClientId !== _clientIdSnap');
  var domIdx   = body.indexOf('supplement-view');
  assert.ok(guardIdx > -1, 'stale guard present');
  assert.ok(domIdx > -1, 'DOM write present');
  assert.ok(guardIdx < domIdx, 'stale guard appears before DOM write');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
