/**
 * T115-C — window._ssStep must be cleared on setWeek() to prevent
 *           stale superset round state bleeding into a new week.
 *
 * Bug: _buildExpressSupersetPanel() caches which superset round/member is
 * current in window._ssStep keyed by di+'_'+grp (NO week in the key).
 * When the week advances (via _autoAdvanceWeekIfDone) while a superset was
 * mid-round (e.g., session marked done before all superset rounds finished),
 * _ssStep still holds the old partial state. The new week's superset UI skips
 * reconstruction (the cache-present guard fires) and shows the wrong round
 * counter — e.g., "RONDA 2 DE 3" instead of "RONDA 1 DE 3" — and the step
 * buttons call ssMoveNextMember/ssCompleteRound with the wrong round index,
 * writing ss_step_ entries to out-of-range rounds.
 *
 * Fix: setWeek() sets window._ssStep = {} so each week gets a clean slate and
 * _buildExpressSupersetPanel reconstructs from the new week's LOGS (zeros).
 *
 * Run: node tests/t115c-ssstep-week-stale.test.js
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

console.log('T115-C — _ssStep stale week state cleared on setWeek()');

// ── setWeek clears _ssStep ─────────────────────────────────────────────────

test('setWeek function exists (active definition with _autoAdvanceDia)', function() {
  var idx = src.indexOf('function setWeek(w)');
  assert.ok(idx > -1, 'setWeek function found');
  // Use 1200 chars — the comment block in setWeek is long
  var snippet = src.slice(idx, idx + 1200);
  assert.ok(
    snippet.indexOf('_autoAdvanceDia') > -1,
    'active setWeek definition must call _autoAdvanceDia'
  );
});

test('setWeek resets _ssStep to empty object', function() {
  var idx = src.indexOf('function setWeek(w)');
  assert.ok(idx > -1, 'setWeek function found');
  // Use 1200 chars — the comment block in setWeek is long
  var snippet = src.slice(idx, idx + 1200);
  var hasReset =
    snippet.indexOf('_ssStep = {}') > -1 ||
    snippet.indexOf("_ssStep={}") > -1;
  assert.ok(hasReset, 'setWeek() must reset window._ssStep to {} to clear stale round state');
});

test('_ssStep reset appears before renderEntrenamiento in setWeek', function() {
  var idx = src.indexOf('function setWeek(w)');
  assert.ok(idx > -1, 'setWeek found');
  // Use 1200 chars — the comment block in setWeek is long
  var snippet = src.slice(idx, idx + 1200);
  var resetPos  = snippet.indexOf('_ssStep = {}');
  var renderPos = snippet.indexOf('renderEntrenamiento');
  assert.ok(resetPos > -1, '_ssStep reset found in setWeek');
  assert.ok(renderPos > -1, 'renderEntrenamiento found in setWeek');
  assert.ok(resetPos < renderPos, '_ssStep must be reset BEFORE renderEntrenamiento to ensure clean reconstruction');
});

// ── _buildExpressSupersetPanel uses guard to reconstruct ───────────────────

test('_buildExpressSupersetPanel reconstruction guard exists', function() {
  var idx = src.indexOf('function _buildExpressSupersetPanel(');
  assert.ok(idx > -1, '_buildExpressSupersetPanel found');
  var body = src.slice(idx, idx + 1000);
  assert.ok(
    body.indexOf('if (!window._ssStep[stateKey])') > -1 ||
    body.indexOf("if(!window._ssStep[stateKey])") > -1,
    'panel must guard reconstruction with if (!_ssStep[stateKey])'
  );
});

test('_ssStep stateKey does NOT include week number', function() {
  // Key is di+'_'+grp, intentionally. The fix is to clear the cache on week change,
  // NOT to add week to the key (that would leave orphan entries).
  var idx = src.indexOf('var stateKey = di + \'_\' + grp.toLowerCase()');
  assert.ok(idx > -1, 'stateKey pattern di+_+grp found — week-agnostic, requires clear on week change');
});

// ── _ssStep is deleted on superset completion ──────────────────────────────

test('ssCompleteLastRound deletes _ssStep[stateKey] on completion', function() {
  var idx = src.indexOf('function ssCompleteLastRound(');
  assert.ok(idx > -1, 'ssCompleteLastRound found');
  // Function body is ~3200 chars; use 3500 to be safe
  var body = src.slice(idx, idx + 3500);
  assert.ok(
    body.indexOf('delete window._ssStep[stateKey]') > -1,
    'ssCompleteLastRound must delete _ssStep[stateKey] when superset finishes'
  );
});

test('clearExpressSSDone deletes _ssStep[stateKey] on edit/reset', function() {
  var idx = src.indexOf('function clearExpressSSDone(');
  assert.ok(idx > -1, 'clearExpressSSDone found');
  var body = src.slice(idx, idx + 1500);
  assert.ok(
    body.indexOf('delete window._ssStep[') > -1,
    'clearExpressSSDone must delete _ssStep entry when superset is reset'
  );
});

// ── _ssStep reconstruction reads correct CURRENT_WEEK logs ────────────────

test('_ssStep reconstruction reads exseries_ with CURRENT_WEEK', function() {
  var idx = src.indexOf('function _buildExpressSupersetPanel(');
  assert.ok(idx > -1);
  // reconstruction block is inside the if (!_ssStep[stateKey]) guard, around offset 850
  var body = src.slice(idx, idx + 1200);
  assert.ok(
    body.indexOf("'exseries_'+CURRENT_WEEK") > -1 ||
    body.indexOf('"exseries_"+CURRENT_WEEK') > -1,
    'reconstruction must read exseries_ keyed by CURRENT_WEEK'
  );
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
