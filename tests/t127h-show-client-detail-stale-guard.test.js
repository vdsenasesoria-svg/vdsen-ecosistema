'use strict';
/**
 * T127-H — showClientDetail must guard every await against stale _detailClientId.
 *
 * Bug (P0): showClientDetail had 5 sequential await getDoc() calls with no
 * stale-context check between them. If the coach navigated to client B while
 * client A's fetches were still in flight, both coroutines would write to the
 * shared globals (_detailClientData, _detailPlanData, _detailFichaData, …) and
 * both would call _switchClientTab(). The last coroutine to finish determined
 * the final UI state, but intermediate writes could leave globals from A while
 * the UI renders B — or render A's tab content over B's detail panel.
 *
 * Fix: after each await in showClientDetail, add
 *   if (_detailClientId !== clientId) return;
 * matching the pattern established by T118-H (saveNutritionPlan) and T123-H
 * (saveTrainingPlan). The guard aborts the stale coroutine before it writes
 * any global state or DOM content.
 *
 * Run: node tests/t127h-show-client-detail-stale-guard.test.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var PASS = 0, FAIL = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

// Extract showClientDetail body
function extractFnBody(source, fnDecl) {
  var idx = source.indexOf(fnDecl);
  if (idx === -1) return null;
  var start = source.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < source.length) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return source.slice(start, i + 1);
}

console.log('T127-H — showClientDetail stale-context guard after every await');

var body = extractFnBody(src, 'async function showClientDetail(clientId');
test('showClientDetail function found in source', function() {
  assert.ok(body, 'showClientDetail must exist in vdsen-coach.html');
});

// Count occurrences of the guard pattern
test('at least one stale guard after first await (clients getDoc)', function() {
  assert.ok(body, 'body must be found');
  // The guard must appear somewhere before _detailClientData is assigned
  var firstAwaitIdx = body.indexOf('await getDoc(doc(db, "clients", clientId))');
  assert.ok(firstAwaitIdx > -1, 'first await getDoc(clients) must be present');
  var guardAfterFirst = body.indexOf('_detailClientId !== clientId', firstAwaitIdx);
  assert.ok(guardAfterFirst > -1, 'guard must appear after first await');
  // Guard must come before _detailClientData assignment
  var dataAssignIdx = body.indexOf('_detailClientData = clientSnap.data()');
  assert.ok(dataAssignIdx > -1, '_detailClientData assignment must exist');
  assert.ok(guardAfterFirst < dataAssignIdx, 'guard must precede _detailClientData assignment');
});

test('stale guard present after plan getDoc', function() {
  assert.ok(body, 'body must be found');
  var planAwaitIdx = body.indexOf('await getDoc(doc(db, "plans",');
  assert.ok(planAwaitIdx > -1, 'plan getDoc await must be present');
  var guardAfterPlan = body.indexOf('_detailClientId !== clientId', planAwaitIdx);
  assert.ok(guardAfterPlan > -1, 'guard must appear after plan await');
  // Must be before _detailPlanData assignment
  var planAssignIdx = body.indexOf('_detailPlanData = planSnap.data()');
  assert.ok(planAssignIdx > -1, '_detailPlanData assignment must exist');
  assert.ok(guardAfterPlan < planAssignIdx, 'guard must precede _detailPlanData assignment');
});

test('stale guard present after fichas_onboarding getDoc', function() {
  assert.ok(body, 'body must be found');
  var fichaAwaitIdx = body.indexOf("await getDoc(doc(db, 'fichas_onboarding'");
  assert.ok(fichaAwaitIdx > -1, 'fichas_onboarding getDoc await must be present');
  var guardAfterFicha = body.indexOf('_detailClientId !== clientId', fichaAwaitIdx);
  assert.ok(guardAfterFicha > -1, 'guard must appear after fichas_onboarding await');
});

test('stale guard present after fichas_renovacion getDoc', function() {
  assert.ok(body, 'body must be found');
  var renovAwaitIdx = body.indexOf("await getDoc(doc(db, 'fichas_renovacion'");
  assert.ok(renovAwaitIdx > -1, 'fichas_renovacion getDoc await must be present');
  var guardAfterRenov = body.indexOf('_detailClientId !== clientId', renovAwaitIdx);
  assert.ok(guardAfterRenov > -1, 'guard must appear after fichas_renovacion await');
});

test('stale guard present after logs getDoc', function() {
  assert.ok(body, 'body must be found');
  var logsAwaitIdx = body.indexOf("await getDoc(doc(db, 'logs', clientId))");
  assert.ok(logsAwaitIdx > -1, 'logs getDoc await must be present');
  var guardAfterLogs = body.indexOf('_detailClientId !== clientId', logsAwaitIdx);
  assert.ok(guardAfterLogs > -1, 'guard must appear after logs await');
});

test('final guard present before body.innerHTML write', function() {
  assert.ok(body, 'body must be found');
  // The body.innerHTML write with the modal content
  var bodyWriteIdx = body.search(/body\.innerHTML = `\r?\n\s*<div class="flex items-center justify-between/);
  assert.ok(bodyWriteIdx > -1, 'body.innerHTML modal write must be present');
  // Find the last guard before that write
  var guardBeforeBody = body.lastIndexOf('_detailClientId !== clientId', bodyWriteIdx);
  assert.ok(guardBeforeBody > -1, 'stale guard must appear before body.innerHTML write');
  assert.ok(guardBeforeBody < bodyWriteIdx, 'guard must precede body.innerHTML write');
});

test('total guards count is at least 6 (one per await + final)', function() {
  assert.ok(body, 'body must be found');
  var count = 0;
  var search = '_detailClientId !== clientId';
  var idx = 0;
  while ((idx = body.indexOf(search, idx)) !== -1) { count++; idx += search.length; }
  assert.ok(count >= 6, 'expected at least 6 guards, found ' + count);
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
