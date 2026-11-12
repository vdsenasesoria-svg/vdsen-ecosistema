/**
 * T114-C — _ciAutoSaveTimer must not fire guardarCI() when CURRENT_WEEK
 *            changed between scheduling and firing.
 *
 * Bug: ciSet() / ciW5() / ciICSSet() scheduled a 2-second debounced save.
 * If the user navigated to a different week (e.g. clicked a past-week button in
 * the training tab, which resets CURRENT_WEEK via goTab(1)) between the
 * schedule and the fire, guardarCI() would call ciKey() with the NEW week and
 * write the historical check-in DOM values into the wrong week's slot in LOGS
 * and Firestore — corrupting the active week's check-in data.
 *
 * Fix: _scheduleCISave() captures CURRENT_WEEK at schedule time into
 * _ciAutoSaveWeek.  The timer callback bails out when CURRENT_WEEK !=
 * _ciAutoSaveWeek.  The visibilitychange flush applies the same guard.
 *
 * Run: node tests/t114c-ci-autosave-stale-week.test.js
 */
'use strict';
var assert = require('assert');
var fs     = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

console.log('T114-C — _ciAutoSaveTimer stale-week guard');

// ── Structural presence ────────────────────────────────────────────────────

test('_ciAutoSaveWeek variable declared alongside _ciAutoSaveTimer', function() {
  assert.ok(
    src.indexOf('var _ciAutoSaveWeek') > -1,
    '_ciAutoSaveWeek must be declared'
  );
  // Both declarations should live close together
  var timerDecl = src.indexOf('var _ciAutoSaveTimer = null;');
  var weekDecl  = src.indexOf('var _ciAutoSaveWeek');
  assert.ok(timerDecl > -1, '_ciAutoSaveTimer declaration found');
  assert.ok(weekDecl  > -1, '_ciAutoSaveWeek declaration found');
  assert.ok(Math.abs(timerDecl - weekDecl) < 200, 'declarations should be near each other');
});

test('_scheduleCISave helper is defined', function() {
  assert.ok(
    src.indexOf('function _scheduleCISave()') > -1,
    '_scheduleCISave() function must exist'
  );
});

test('_scheduleCISave captures CURRENT_WEEK', function() {
  var fnIdx = src.indexOf('function _scheduleCISave()');
  assert.ok(fnIdx > -1, '_scheduleCISave exists');
  var snippet = src.slice(fnIdx, fnIdx + 400);
  assert.ok(
    snippet.indexOf('CURRENT_WEEK') > -1,
    '_scheduleCISave must reference CURRENT_WEEK to capture the week'
  );
});

test('timer callback guards against week change', function() {
  var fnIdx = src.indexOf('function _scheduleCISave()');
  assert.ok(fnIdx > -1, '_scheduleCISave exists');
  var snippet = src.slice(fnIdx, fnIdx + 600);
  // Must compare CURRENT_WEEK to the captured value inside the setTimeout callback
  assert.ok(
    snippet.indexOf('CURRENT_WEEK !== _ciAutoSaveWeek') > -1 ||
    snippet.indexOf('_ciAutoSaveWeek !== CURRENT_WEEK') > -1,
    'timer callback must abort when CURRENT_WEEK !== _ciAutoSaveWeek'
  );
});

test('ciSet delegates to _scheduleCISave instead of inlining setTimeout', function() {
  var fnIdx = src.indexOf('\nfunction ciSet(');
  assert.ok(fnIdx > -1, 'ciSet function found');
  var snippet = src.slice(fnIdx, fnIdx + 300);
  assert.ok(
    snippet.indexOf('_scheduleCISave()') > -1,
    'ciSet must call _scheduleCISave()'
  );
  // Must NOT contain its own setTimeout for the save
  assert.ok(
    snippet.indexOf('setTimeout') === -1 || snippet.indexOf('_scheduleCISave') < snippet.indexOf('setTimeout'),
    'ciSet must not contain an independent setTimeout before _scheduleCISave'
  );
});

test('ciW5 delegates to _scheduleCISave', function() {
  var fnIdx = src.indexOf('\nfunction ciW5(');
  assert.ok(fnIdx > -1, 'ciW5 function found');
  var snippet = src.slice(fnIdx, fnIdx + 400);
  assert.ok(
    snippet.indexOf('_scheduleCISave()') > -1,
    'ciW5 must call _scheduleCISave()'
  );
});

test('ciICSSet delegates to _scheduleCISave', function() {
  var fnIdx = src.indexOf('\nfunction ciICSSet(');
  assert.ok(fnIdx > -1, 'ciICSSet function found');
  // ciICSSet is longer than 600 chars — use 800 to cover the full body
  var snippet = src.slice(fnIdx, fnIdx + 800);
  assert.ok(
    snippet.indexOf('_scheduleCISave()') > -1,
    'ciICSSet must call _scheduleCISave()'
  );
});

// ── visibilitychange flush guard ───────────────────────────────────────────

test('visibilitychange flush checks _ciAutoSaveWeek before calling guardarCI', function() {
  // Find the visibilitychange flush block
  var hiddenGuard = src.indexOf('Flush também el autosave de CI') === -1
    ? src.indexOf('Flush también el autosave de CI')
    : src.indexOf('Flush também el autosave de CI');
  // Alternative: search for the _ciAutoSaveTimer flush block
  var flushIdx = src.indexOf('_ciAutoSaveTimer && USER && FB');
  assert.ok(flushIdx > -1, 'CI flush block in visibilitychange found');
  var snippet = src.slice(flushIdx, flushIdx + 600);
  assert.ok(
    snippet.indexOf('_ciAutoSaveWeek') > -1,
    'visibilitychange CI flush must reference _ciAutoSaveWeek'
  );
  assert.ok(
    snippet.indexOf('guardarCI') > -1,
    'visibilitychange CI flush must still call guardarCI when week matches'
  );
});

test('visibilitychange flush guards week match with same-week condition', function() {
  var flushIdx = src.indexOf('_ciAutoSaveTimer && USER && FB');
  assert.ok(flushIdx > -1, 'CI flush block found');
  var snippet = src.slice(flushIdx, flushIdx + 600);
  // Must have a condition that allows guardarCI only when weeks match
  var hasGuard =
    snippet.indexOf('CURRENT_WEEK === _ciAutoSaveWeek') > -1 ||
    snippet.indexOf('_ciAutoSaveWeek === CURRENT_WEEK') > -1 ||
    snippet.indexOf('!_savedWeek || CURRENT_WEEK === _savedWeek') > -1;
  assert.ok(hasGuard, 'flush must guard with a week-match condition before calling guardarCI');
});

// ── Regression: _ciAutoSaveWeek is cleared after each save ────────────────

test('_ciAutoSaveWeek is set to null after timer fires', function() {
  var fnIdx = src.indexOf('function _scheduleCISave()');
  assert.ok(fnIdx > -1);
  var snippet = src.slice(fnIdx, fnIdx + 600);
  // Must clear _ciAutoSaveWeek = null in the callback (after the guard or inside)
  assert.ok(
    snippet.indexOf('_ciAutoSaveWeek = null') > -1,
    'timer callback must clear _ciAutoSaveWeek = null to avoid memory of stale week'
  );
});

// ── T114-C addendum: _ciSubjTemp must be cleared on setWeek() ─────────────
// Bug: if a user clicks subjective scale buttons (setCISubj) for week N,
// then navigates to week M via setWeek() without saving, then calls guardarCI()
// for week M, _ciSubjTemp values from week N bleed into week M's check-in data.
// Fix: setWeek() sets window._ciSubjTemp = null.

test('setWeek clears _ciSubjTemp', function() {
  // Find the ACTIVE setWeek definition (the one that calls _autoAdvanceDia)
  var fnIdx = src.indexOf('function setWeek(w) {\n  CURRENT_WEEK = w;\n  _autoAdvanceDia');
  // Fallback: find any setWeek that clears _ciSubjTemp
  if (fnIdx === -1) fnIdx = src.indexOf('function setWeek(');
  assert.ok(fnIdx > -1, 'setWeek function found');
  var snippet = src.slice(fnIdx, fnIdx + 600);
  assert.ok(
    snippet.indexOf('_ciSubjTemp = null') > -1 ||
    snippet.indexOf('_ciSubjTemp=null') > -1,
    'setWeek() must clear window._ciSubjTemp to prevent stale-week bleed'
  );
});

test('only one setWeek definition exists (no dead duplicate)', function() {
  // The old dead copy at line ~3514 was removed in T114-C.
  // If two copies exist, the earlier one is dead (overridden by the later declaration)
  // and the _ciSubjTemp clear in the active one might be in the wrong copy.
  var first  = src.indexOf('\nfunction setWeek(');
  var second = src.indexOf('\nfunction setWeek(', first + 1);
  assert.ok(second === -1, 'only one setWeek() declaration — duplicate dead copy must be removed');
});

test('only one goToWeek definition exists (no dead duplicate)', function() {
  var first  = src.indexOf('\nfunction goToWeek(');
  var second = src.indexOf('\nfunction goToWeek(', first + 1);
  assert.ok(second === -1, 'only one goToWeek() declaration — duplicate dead copy must be removed');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
