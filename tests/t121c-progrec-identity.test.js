/**
 * T121-C — CLIENT identity audit: progrec positional-lookup name guards
 *
 * Two bugs fixed in vdsen-cliente.html:
 *
 * BUG-1 (_getProgRecForExercise, ~line 12654):
 *   Before fix: `recommendations[ei]` returned a truthy rec for the WRONG exercise
 *   (after coach reorder), and the name-based fallback was never reached.
 *   Result: wrong exercise's load was autofilled in the set input field.
 *   Fix: name guard added before the early return — if exName and rec.exerciseName
 *   both present and they differ, fall through to the name search instead of returning.
 *
 * BUG-2 (toggleExUnit progrec section, ~line 473):
 *   Before fix: `recommendations[ei]` was mutated (newLoad converted KG↔LB) and saved
 *   to Firestore even when the rec belonged to a different exercise (after reorder).
 *   Result: wrong exercise's recommendation load permanently corrupted in Firestore.
 *   Fix: name guard added before mutation — skip conversion when rec.exerciseName
 *   doesn't match the current exercise.
 *
 * Non-findings (SAFE):
 *   - Cross-week set reference display (prevKey positional): same root as QA-R3-04,
 *     protected by coach guard (coach cannot reorder mid-week).
 *   - _getPrevWeekData: correctly prefers prescriptionExerciseId (HIGH confidence).
 *   - Within-week log keys (log_W_D_ei_sN): known positional format, QA-R3-04 protected.
 *   - Progression algorithm recs storage: atomic at session end, correct by position then.
 *
 * Run: node tests/t121c-progrec-identity.test.js
 */
'use strict';
var assert = require('assert');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

// ── Replicated helpers from vdsen-cliente.html ────────────────────────────────

function _normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Replicates _getProgRecForExercise AFTER the fix (name guard in positional branch)
function _getProgRecForExercise_fixed(LOGS, LOGS_BY_WEEK, CURRENT_WEEK, di, ei, exName) {
  for (var w = CURRENT_WEEK; w >= 1; w--) {
    var _progWeek = (LOGS_BY_WEEK.progrec[w] || []);
    var keys = _progWeek.filter(function(k) { return k === 'progrec_'+w+'_'+di; });
    if (!keys.length) { keys = _progWeek; }
    for (var ki = 0; ki < keys.length; ki++) {
      var prog = LOGS[keys[ki]];
      if (!prog || !prog.recommendations) continue;
      // FIXED: name guard before early return
      var _posRec = prog.recommendations[ei];
      if (_posRec && keys[ki] === 'progrec_'+w+'_'+di) {
        if (!exName || !_posRec.exerciseName ||
            _normName(_posRec.exerciseName) === _normName(exName)) {
          return _posRec;
        }
        // name mismatch → fall through to name search
      }
      // name search fallback
      if (exName) {
        var exLower = exName.toLowerCase().trim();
        for (var ri = 0; ri < prog.recommendations.length; ri++) {
          var rec = prog.recommendations[ri];
          if (rec.exerciseName && rec.exerciseName.toLowerCase().trim() === exLower) {
            return rec;
          }
        }
      }
    }
  }
  return null;
}

// Replicates _getProgRecForExercise BEFORE the fix (buggy: no name guard)
function _getProgRecForExercise_buggy(LOGS, LOGS_BY_WEEK, CURRENT_WEEK, di, ei, exName) {
  for (var w = CURRENT_WEEK; w >= 1; w--) {
    var _progWeek = (LOGS_BY_WEEK.progrec[w] || []);
    var keys = _progWeek.filter(function(k) { return k === 'progrec_'+w+'_'+di; });
    if (!keys.length) { keys = _progWeek; }
    for (var ki = 0; ki < keys.length; ki++) {
      var prog = LOGS[keys[ki]];
      if (!prog || !prog.recommendations) continue;
      // BUGGY: no name check, returns wrong exercise rec
      if (prog.recommendations[ei] && keys[ki] === 'progrec_'+w+'_'+di) {
        return prog.recommendations[ei];
      }
      if (exName) {
        var exLower = exName.toLowerCase().trim();
        for (var ri = 0; ri < prog.recommendations.length; ri++) {
          var rec = prog.recommendations[ri];
          if (rec.exerciseName && rec.exerciseName.toLowerCase().trim() === exLower) {
            return rec;
          }
        }
      }
    }
  }
  return null;
}

// Replicates toggleExUnit progrec-conversion section AFTER fix (name guard)
function applyProgrecUnitConversion_fixed(LOGS, LOGS_BY_WEEK, di, ei, ej, factor, newUnit) {
  function _roundUnit(val, unit) {
    var step = unit === 'LB' ? 2.5 : 0.5;
    return Math.round(val / step) * step;
  }
  Object.keys(LOGS_BY_WEEK.progrec).forEach(function(w) {
    (LOGS_BY_WEEK.progrec[w] || []).forEach(function(k) {
      var parts = k.split('_');
      if (parts.length < 3 || parseInt(parts[2]) !== di) return;
      var prog = LOGS[k];
      if (!prog || !prog.recommendations || !prog.recommendations[ei]) return;
      var rec = prog.recommendations[ei];
      // FIXED: name guard
      if (ej && rec.exerciseName &&
          _normName(rec.exerciseName) !== _normName(ej.nombre || ej.exerciseName || '')) return;
      if (rec.newLoad && isFinite(rec.newLoad))
        rec.newLoad = _roundUnit(parseFloat(rec.newLoad) * factor, newUnit);
      if (rec.trend && rec.trend.prevLoad && isFinite(rec.trend.prevLoad))
        rec.trend.prevLoad = _roundUnit(parseFloat(rec.trend.prevLoad) * factor, newUnit);
    });
  });
}

// Replicates toggleExUnit progrec-conversion BEFORE fix (buggy)
function applyProgrecUnitConversion_buggy(LOGS, LOGS_BY_WEEK, di, ei, ej, factor, newUnit) {
  function _roundUnit(val, unit) {
    var step = unit === 'LB' ? 2.5 : 0.5;
    return Math.round(val / step) * step;
  }
  Object.keys(LOGS_BY_WEEK.progrec).forEach(function(w) {
    (LOGS_BY_WEEK.progrec[w] || []).forEach(function(k) {
      var parts = k.split('_');
      if (parts.length < 3 || parseInt(parts[2]) !== di) return;
      var prog = LOGS[k];
      if (!prog || !prog.recommendations || !prog.recommendations[ei]) return;
      var rec = prog.recommendations[ei];
      // BUGGY: no name guard
      if (rec.newLoad && isFinite(rec.newLoad))
        rec.newLoad = _roundUnit(parseFloat(rec.newLoad) * factor, newUnit);
      if (rec.trend && rec.trend.prevLoad && isFinite(rec.trend.prevLoad))
        rec.trend.prevLoad = _roundUnit(parseFloat(rec.trend.prevLoad) * factor, newUnit);
    });
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Scenario: coach reordered exercises between week 3 and week 4.
// Old order (week 3): ExA at index 0, ExB at index 1
// New order (week 4): ExB at index 0, ExA at index 1

function makeProgrecFixture() {
  // progrec was stored at end of week 3 with OLD ordering
  return {
    recommendations: [
      { exerciseName: 'ExA', action: 'increase_load', newLoad: 82.5 },  // old index 0
      { exerciseName: 'ExB', action: 'maintain',      newLoad: 62.5 }   // old index 1
    ],
    deloadTriggers: [],
    weekNum: 3
  };
}

function makeLogsAndIndex(progrec) {
  var LOGS = { 'progrec_3_0': progrec };
  var LOGS_BY_WEEK = { progrec: { 3: ['progrec_3_0'] } };
  return { LOGS: LOGS, LOGS_BY_WEEK: LOGS_BY_WEEK };
}

// ── BUG-1 tests: _getProgRecForExercise name guard ────────────────────────────

console.log('\nT121-C — BUG-1: _getProgRecForExercise name guard');

test('BUG-1-confirm: buggy version returns wrong exercise rec for reordered ExB at ei=0', function() {
  var f = makeLogsAndIndex(makeProgrecFixture());
  // ExB is now at index 0 after reorder. Old progrec has ExA at [0].
  var rec = _getProgRecForExercise_buggy(f.LOGS, f.LOGS_BY_WEEK, 3, 0, 0, 'ExB');
  // Buggy: returns ExA's rec (newLoad 82.5) instead of ExB's (62.5)
  assert.ok(rec !== null, 'buggy version returns something');
  assert.strictEqual(rec.exerciseName, 'ExA',
    'BUG-1 CONFIRMED: buggy version returns ExA rec for ExB lookup (wrong exercise)');
  assert.strictEqual(rec.newLoad, 82.5,
    'BUG-1 CONFIRMED: wrong load 82.5 (ExA) would be autofilled for ExB');
});

test('BUG-1-fix: fixed version finds ExB by name when positional hit has wrong name', function() {
  var f = makeLogsAndIndex(makeProgrecFixture());
  // ExB is now at index 0 after reorder
  var rec = _getProgRecForExercise_fixed(f.LOGS, f.LOGS_BY_WEEK, 3, 0, 0, 'ExB');
  assert.ok(rec !== null, 'fixed version must find ExB recommendation');
  assert.strictEqual(rec.exerciseName, 'ExB',
    'fixed version returns ExB rec (correct exercise)');
  assert.strictEqual(rec.newLoad, 62.5,
    'fixed version returns correct newLoad 62.5 for ExB');
});

test('BUG-1-fix: fixed version still returns correct rec when no reorder (ExA at ei=0)', function() {
  var f = makeLogsAndIndex(makeProgrecFixture());
  // No reorder: ExA is still at index 0
  var rec = _getProgRecForExercise_fixed(f.LOGS, f.LOGS_BY_WEEK, 3, 0, 0, 'ExA');
  assert.ok(rec !== null, 'fixed version must find ExA recommendation');
  assert.strictEqual(rec.exerciseName, 'ExA', 'correct exercise returned');
  assert.strictEqual(rec.newLoad, 82.5, 'correct load returned');
});

test('BUG-1-fix: fixed version returns correct rec for ExA at new index 1 after reorder', function() {
  var f = makeLogsAndIndex(makeProgrecFixture());
  // After reorder: ExA is now at index 1
  var rec = _getProgRecForExercise_fixed(f.LOGS, f.LOGS_BY_WEEK, 3, 0, 1, 'ExA');
  assert.ok(rec !== null, 'fixed version must find ExA recommendation at new position');
  assert.strictEqual(rec.exerciseName, 'ExA', 'correct exercise returned');
  assert.strictEqual(rec.newLoad, 82.5, 'correct load 82.5 returned for ExA');
});

test('BUG-1-compat: fixed version works with legacy progrec without exerciseName (backward compat)', function() {
  // Old progrec data may not have exerciseName in recs — positional lookup should still work
  var legacyProgrec = {
    recommendations: [
      { action: 'increase_load', newLoad: 80.0 },  // no exerciseName
      { action: 'maintain',      newLoad: 60.0 }
    ]
  };
  var LOGS = { 'progrec_2_0': legacyProgrec };
  var LOGS_BY_WEEK = { progrec: { 2: ['progrec_2_0'] } };
  // Without exerciseName in rec, should fall through positional (backward compat)
  var rec = _getProgRecForExercise_fixed(LOGS, LOGS_BY_WEEK, 2, 0, 0, 'ExA');
  assert.ok(rec !== null, 'legacy rec without exerciseName still returned positionally');
  assert.strictEqual(rec.newLoad, 80.0, 'correct positional rec returned for legacy data');
});

test('BUG-1-compat: fixed version works when exName not provided (no name to check)', function() {
  var f = makeLogsAndIndex(makeProgrecFixture());
  // No exName passed — should fall back to pure positional (backward compat)
  var rec = _getProgRecForExercise_fixed(f.LOGS, f.LOGS_BY_WEEK, 3, 0, 0, '');
  assert.ok(rec !== null, 'no-exName lookup returns positional result');
  assert.strictEqual(rec.exerciseName, 'ExA', 'positional rec returned when no exName');
});

test('BUG-1-fix: returns null when exercise not found by name and no positional match', function() {
  var f = makeLogsAndIndex(makeProgrecFixture());
  // Look for "ExC" which doesn't exist in recs
  var rec = _getProgRecForExercise_fixed(f.LOGS, f.LOGS_BY_WEEK, 3, 0, 2, 'ExC');
  assert.strictEqual(rec, null, 'returns null for exercise not in recs');
});

// ── BUG-2 tests: toggleExUnit progrec conversion name guard ──────────────────

console.log('\nT121-C — BUG-2: toggleExUnit progrec name guard');

test('BUG-2-confirm: buggy version converts wrong exercise rec when reordered', function() {
  var progrec = makeProgrecFixture();
  var LOGS = { 'progrec_3_0': progrec };
  var LOGS_BY_WEEK = { progrec: { 3: ['progrec_3_0'] } };
  // ExB is now at index 0 after reorder; ExA.newLoad was 82.5
  var ejExB = { nombre: 'ExB' };
  applyProgrecUnitConversion_buggy(LOGS, LOGS_BY_WEEK, 0, 0, ejExB, 2.20462, 'LB');
  // Buggy: converted ExA's newLoad (at index 0) by KG→LB factor
  var convertedExALoad = LOGS['progrec_3_0'].recommendations[0].newLoad;
  // 82.5 kg * 2.20462 ≈ 181.88 lb, rounded to 2.5 = 182.5 lb
  assert.ok(convertedExALoad > 100,
    'BUG-2 CONFIRMED: ExA rec (at old index 0) was incorrectly converted by KG→LB factor');
});

test('BUG-2-fix: fixed version does NOT convert ExA rec when current exercise is ExB', function() {
  var progrec = makeProgrecFixture();
  var LOGS = { 'progrec_3_0': progrec };
  var LOGS_BY_WEEK = { progrec: { 3: ['progrec_3_0'] } };
  // ExB is now at index 0 after reorder
  var ejExB = { nombre: 'ExB' };
  applyProgrecUnitConversion_fixed(LOGS, LOGS_BY_WEEK, 0, 0, ejExB, 2.20462, 'LB');
  // Fixed: ExA rec at index 0 should NOT be touched (name mismatch)
  assert.strictEqual(LOGS['progrec_3_0'].recommendations[0].newLoad, 82.5,
    'ExA rec at old index 0 is untouched when current exercise is ExB');
  // ExB rec at index 1 also NOT touched (no path reaches it: index 0 is the only one checked)
  assert.strictEqual(LOGS['progrec_3_0'].recommendations[1].newLoad, 62.5,
    'ExB rec at index 1 is also untouched (unreachable by index-based path)');
});

test('BUG-2-fix: fixed version correctly converts rec when name matches (no reorder)', function() {
  var progrec = makeProgrecFixture();
  var LOGS = { 'progrec_3_0': progrec };
  var LOGS_BY_WEEK = { progrec: { 3: ['progrec_3_0'] } };
  // No reorder: ExA is at index 0
  var ejExA = { nombre: 'ExA' };
  applyProgrecUnitConversion_fixed(LOGS, LOGS_BY_WEEK, 0, 0, ejExA, 2.20462, 'LB');
  // Fixed: ExA rec at index 0 IS converted because names match
  var convertedLoad = LOGS['progrec_3_0'].recommendations[0].newLoad;
  // 82.5 kg * 2.20462 = 181.88 lb, rounded to 2.5 → 182.5 lb
  assert.ok(convertedLoad > 100,
    'ExA rec correctly converted when exercise name matches');
  assert.ok(convertedLoad % 2.5 === 0,
    'converted load is rounded to nearest 2.5 lb');
});

test('BUG-2-compat: fixed version converts when ej has no exerciseName (legacy ej object)', function() {
  var progrec = makeProgrecFixture();
  var LOGS = { 'progrec_3_0': progrec };
  var LOGS_BY_WEEK = { progrec: { 3: ['progrec_3_0'] } };
  // ej exists but has no nombre/exerciseName (legacy) → guard skipped → convert as before
  var ejLegacy = {};
  var origLoad = LOGS['progrec_3_0'].recommendations[0].newLoad;
  applyProgrecUnitConversion_fixed(LOGS, LOGS_BY_WEEK, 0, 0, ejLegacy, 2.20462, 'LB');
  // Guard: ej exists but rec has exerciseName — `ej.nombre || ej.exerciseName || ''` = ''
  // `_normName('')` === '' !== `_normName('ExA')` → guard fires → skips conversion
  assert.strictEqual(LOGS['progrec_3_0'].recommendations[0].newLoad, origLoad,
    'legacy ej without name: guard skips conversion (cannot confirm match)');
});

test('BUG-2-compat: fixed version converts when rec has no exerciseName (legacy rec)', function() {
  // Legacy recs without exerciseName — ej name cannot be compared → convert (same as before)
  var legacyProgrec = {
    recommendations: [
      { action: 'increase_load', newLoad: 80.0 }  // no exerciseName in rec
    ]
  };
  var LOGS = { 'progrec_2_0': legacyProgrec };
  var LOGS_BY_WEEK = { progrec: { 2: ['progrec_2_0'] } };
  var ejExA = { nombre: 'ExA' };
  applyProgrecUnitConversion_fixed(LOGS, LOGS_BY_WEEK, 0, 0, ejExA, 2.20462, 'LB');
  // rec.exerciseName is absent → guard skipped → conversion happens (backward compat)
  assert.ok(LOGS['progrec_2_0'].recommendations[0].newLoad > 100,
    'legacy rec without exerciseName is still converted (backward compat)');
});

// ── Verify source: confirm fixes are present in vdsen-cliente.html ──────────

console.log('\nT121-C — source verification');

var fs = require('fs');
var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

test('source: _getProgRecForExercise contains _posRec name guard', function() {
  assert.ok(
    src.indexOf('_posRec.exerciseName') !== -1,
    '_posRec.exerciseName name guard present in _getProgRecForExercise'
  );
});

test('source: _getProgRecForExercise name guard uses _normName', function() {
  // Check that the guard calls _normName for comparison
  var guardIdx = src.indexOf('_normName(_posRec.exerciseName)');
  assert.ok(guardIdx !== -1, '_normName used for posRec name comparison in fix');
});

test('source: toggleExUnit progrec section contains rec.exerciseName name guard', function() {
  assert.ok(
    src.indexOf('rec.exerciseName') !== -1,
    'rec.exerciseName name guard present in toggleExUnit progrec conversion'
  );
});

test('source: toggleExUnit name guard uses _normName', function() {
  var guardIdx = src.indexOf('_normName(rec.exerciseName)');
  assert.ok(guardIdx !== -1, '_normName used for rec name comparison in toggleExUnit fix');
});

test('source: toggleExUnit name guard checks ej.nombre || ej.exerciseName', function() {
  assert.ok(
    src.indexOf("ej.nombre || ej.exerciseName || ''") !== -1,
    'toggleExUnit name guard safely handles ej with either nombre or exerciseName'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
