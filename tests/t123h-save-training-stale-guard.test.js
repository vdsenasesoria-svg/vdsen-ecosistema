/**
 * T123-H — saveTrainingPlan must capture _detailClientId before any await
 * and guard the post-write UI refresh against stale client context.
 *
 * Bug: saveTrainingPlan performs several async writes (backup getDoc + addDoc,
 * then main plan updateDoc). Between those awaits the coach could navigate to a
 * different client (changing _detailClientId). Without a guard, the final call
 * showClientDetail(_detailClientId, { tab: 'plan' }) would open the NEW client's
 * detail panel — making it appear that the training plan save had worked on the
 * wrong client.
 *
 * Fix: T123-H adds:
 *   1. const _clientIdSnap = _detailClientId  — before any await
 *   2. if (_detailClientId !== _clientIdSnap) return  — after updateDoc, before showClientDetail
 *
 * Run: node tests/t123h-save-training-stale-guard.test.js
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

console.log('T123-H — saveTrainingPlan stale-client guard');

var body = extractFnBody(src, 'async function saveTrainingPlan(');

test('saveTrainingPlan function is present', function() {
  assert.ok(body, 'saveTrainingPlan function found in HTML source');
});

test('saveTrainingPlan captures _clientIdSnap before any await expression', function() {
  assert.ok(body, 'function body present');
  var snapIdx  = body.indexOf('_clientIdSnap = _detailClientId');
  // Use 'await getDoc' as the first real async expression (not the word in a comment)
  var awaitIdx = body.indexOf('await getDoc(');
  assert.ok(snapIdx > -1,  '_clientIdSnap = _detailClientId assignment present');
  assert.ok(awaitIdx > -1, 'await getDoc( present (backup read)');
  assert.ok(snapIdx < awaitIdx, '_clientIdSnap captured before first await getDoc');
});

test('saveTrainingPlan stale guard present after updateDoc', function() {
  assert.ok(body, 'function body present');
  var updateDocIdx = body.indexOf('await updateDoc(doc(db, "plans", _editingPlanId)');
  var guardIdx     = body.indexOf('_detailClientId !== _clientIdSnap');
  assert.ok(updateDocIdx > -1, 'await updateDoc call present');
  assert.ok(guardIdx > -1,     'stale guard _detailClientId !== _clientIdSnap present');
  assert.ok(guardIdx > updateDocIdx, 'stale guard appears AFTER the updateDoc call');
});

test('saveTrainingPlan stale guard appears before showClientDetail', function() {
  assert.ok(body, 'function body present');
  var guardIdx          = body.indexOf('_detailClientId !== _clientIdSnap');
  var showClientIdx     = body.indexOf('showClientDetail(_detailClientId');
  assert.ok(guardIdx > -1,      'stale guard present');
  assert.ok(showClientIdx > -1, 'showClientDetail call present');
  assert.ok(guardIdx < showClientIdx, 'stale guard appears before showClientDetail');
});

test('saveTrainingPlan updatedAt present in updateDoc write', function() {
  assert.ok(body, 'function body present');
  assert.ok(
    body.indexOf("updatedAt: new Date().toISOString()") > -1,
    'updatedAt timestamp written in plan updateDoc'
  );
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
