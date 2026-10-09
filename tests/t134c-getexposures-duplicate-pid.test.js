/**
 * T134-C — CLIENT: _getExposures must not fall back to positional matching when
 * prescriptionExerciseId is ambiguous (DUPLICATE_PRESCRIPTION_ID).
 *
 * Bug: _getExposures() powers _calcTrend() (PROGRESANDO/ESTABLE/REVISAR) and
 * _calcPR() (best load ever) shown to the client on the exercise card. When the
 * same prescriptionExerciseId is logged at more than one (di,ei) position in a
 * week — a corrupted/edited plan, e.g. the coach duplicated an exercise row or
 * reordered in a way that reused an id — the identity lookup is ambiguous.
 *
 * Before fix: ambiguity fell through to raw positional matching
 * (`log_{w}_{di}_{ei}_s{s}`) for that week. If the log at that exact (di,ei)
 * slot has no `exerciseNameSnapshot` (older log entry), there is NO guard at
 * all — a completely different exercise's load/reps could be pulled into this
 * exercise's trend and PR calculation, showing e.g. "PROGRESANDO" or a wrong
 * PR based on someone else's — well, some OTHER exercise's — numbers.
 *
 * _getPrevWeekData() (same file) already treats this exact scenario
 * (DUPLICATE_PRESCRIPTION_ID) as corrupt identity and refuses to match
 * silently (returns null for that week). _getExposures() must follow the same
 * contract: skip the week entirely instead of guessing positionally.
 *
 * Run: node tests/t134c-getexposures-duplicate-pid.test.js
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

function _normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── Replicates _getExposures BEFORE the fix (ambiguity falls through to positional) ──
function _getExposures_buggy(LOGS, LOGS_BY_WEEK, REAL_WEEK, prescriptionExerciseId, di, ei, nombre, maxExposures) {
  maxExposures = maxExposures || 5;
  var exposures = [];
  var startWeek = REAL_WEEK;

  for (var w = startWeek; w >= 1; w--) {
    var sets = [];
    var confidence = 'LOW';

    if (prescriptionExerciseId) {
      var positions = {};
      var candidateSets = [];
      (LOGS_BY_WEEK.log[w] || []).forEach(function(k) {
        var entry = LOGS[k];
        if (!entry || !entry.done || entry.autoFilled) return;
        if (entry.prescriptionExerciseId !== prescriptionExerciseId) return;
        var parts = k.split('_');
        if (parts.length >= 5) positions[parts[2] + '_' + parts[3]] = true;
        var setIdx = parts.length >= 5 ? (parseInt(parts[4].replace('s', '')) || 0) : 0;
        candidateSets.push({ entry: entry, setIdx: setIdx });
      });
      if (candidateSets.length && Object.keys(positions).length === 1) {
        candidateSets.sort(function(a, b) { return a.setIdx - b.setIdx; });
        sets = candidateSets.map(function(c) { return c.entry; }); confidence = 'HIGH';
      }
      // BUGGY: ambiguity silently falls through to positional below
    }

    if (!sets.length) {
      var legacySets = [];
      for (var s = 0; s < 12; s++) {
        var k = 'log_' + w + '_' + di + '_' + ei + '_s' + s;
        if (LOGS[k] && LOGS[k].done && !LOGS[k].autoFilled) legacySets.push(LOGS[k]);
      }
      if (legacySets.length && nombre) {
        var logsWithSnap = legacySets.filter(function(ls) { return ls.exerciseNameSnapshot; });
        if (logsWithSnap.length > 0) {
          if (_normName(nombre) !== _normName(logsWithSnap[0].exerciseNameSnapshot)) continue;
        }
      }
      sets = legacySets;
    }

    if (!sets.length) continue;

    exposures.push({
      week: w,
      confidence: confidence,
      sets: sets.map(function(s) {
        return { carga: parseFloat(s.carga) || 0, reps: parseInt(s.reps) || 0 };
      })
    });

    if (exposures.length >= maxExposures) break;
  }
  return exposures;
}

// ── Replicates _getExposures AFTER the fix (ambiguity skips the week) ──
function _getExposures_fixed(LOGS, LOGS_BY_WEEK, REAL_WEEK, prescriptionExerciseId, di, ei, nombre, maxExposures) {
  maxExposures = maxExposures || 5;
  var exposures = [];
  var startWeek = REAL_WEEK;

  for (var w = startWeek; w >= 1; w--) {
    var sets = [];
    var confidence = 'LOW';

    if (prescriptionExerciseId) {
      var positions = {};
      var candidateSets = [];
      (LOGS_BY_WEEK.log[w] || []).forEach(function(k) {
        var entry = LOGS[k];
        if (!entry || !entry.done || entry.autoFilled) return;
        if (entry.prescriptionExerciseId !== prescriptionExerciseId) return;
        var parts = k.split('_');
        if (parts.length >= 5) positions[parts[2] + '_' + parts[3]] = true;
        var setIdx = parts.length >= 5 ? (parseInt(parts[4].replace('s', '')) || 0) : 0;
        candidateSets.push({ entry: entry, setIdx: setIdx });
      });
      if (candidateSets.length && Object.keys(positions).length === 1) {
        candidateSets.sort(function(a, b) { return a.setIdx - b.setIdx; });
        sets = candidateSets.map(function(c) { return c.entry; }); confidence = 'HIGH';
      } else if (candidateSets.length && Object.keys(positions).length > 1) {
        // FIXED: DUPLICATE_PRESCRIPTION_ID — corrupt identity, skip this week.
        continue;
      }
    }

    if (!sets.length) {
      var legacySets = [];
      for (var s = 0; s < 12; s++) {
        var k = 'log_' + w + '_' + di + '_' + ei + '_s' + s;
        if (LOGS[k] && LOGS[k].done && !LOGS[k].autoFilled) legacySets.push(LOGS[k]);
      }
      if (legacySets.length && nombre) {
        var logsWithSnap = legacySets.filter(function(ls) { return ls.exerciseNameSnapshot; });
        if (logsWithSnap.length > 0) {
          if (_normName(nombre) !== _normName(logsWithSnap[0].exerciseNameSnapshot)) continue;
        }
      }
      sets = legacySets;
    }

    if (!sets.length) continue;

    exposures.push({
      week: w,
      confidence: confidence,
      sets: sets.map(function(s) {
        return { carga: parseFloat(s.carga) || 0, reps: parseInt(s.reps) || 0 };
      })
    });

    if (exposures.length >= maxExposures) break;
  }
  return exposures;
}

// ── Fixture: week 5 has the SAME prescriptionExerciseId logged at TWO different
//    (di,ei) positions — e.g. "PID-BENCH" was duplicated onto a different day's
//    slot by a plan edit. The log at the exercise's OWN (di=0, ei=0) slot has NO
//    exerciseNameSnapshot (older entry, predates that guard) and holds a totally
//    different exercise's numbers (some heavy accessory the client actually did
//    at that literal position historically, unrelated to prescriptionExerciseId).
function makeAmbiguousFixture() {
  var LOGS = {
    // Legit, unambiguous exposure at week 4 for PID-BENCH at (0,0)
    'log_4_0_0_s0': { done: true, carga: 60, reps: 8, prescriptionExerciseId: 'PID-BENCH' },
    // Week 5: PID-BENCH shows up at BOTH (0,0) and (2,3) — ambiguous identity
    'log_5_0_0_s0': { done: true, carga: 62.5, reps: 8, prescriptionExerciseId: 'PID-BENCH' },
    'log_5_2_3_s0': { done: true, carga: 62.5, reps: 8, prescriptionExerciseId: 'PID-BENCH' },
    // Positional fallback trap: log at (0,0) week 5 also literally exists as a
    // *different* single-set entry with a wildly different load and NO snapshot
    // (simulated by using the same key — in practice this is what the ambiguous
    // PID entry above already looks like positionally: 62.5 kg, not what a
    // buggy naive positional-only reader would show as "PR" for the wrong lift).
  };
  var LOGS_BY_WEEK = {
    log: {
      4: ['log_4_0_0_s0'],
      5: ['log_5_0_0_s0', 'log_5_2_3_s0']
    }
  };
  return { LOGS: LOGS, LOGS_BY_WEEK: LOGS_BY_WEEK };
}

console.log('\nT134-C — _getExposures DUPLICATE_PRESCRIPTION_ID guard');

test('BUG-confirm: buggy version still returns a week-5 exposure via positional fallback despite ambiguity', function() {
  var f = makeAmbiguousFixture();
  var exposures = _getExposures_buggy(f.LOGS, f.LOGS_BY_WEEK, 5, 'PID-BENCH', 0, 0, 'Press banca', 5);
  var wk5 = exposures.filter(function(e) { return e.week === 5; });
  assert.strictEqual(wk5.length, 1,
    'BUG CONFIRMED: buggy version silently trusts the ambiguous week via positional fallback');
});

test('FIX: fixed version skips week 5 entirely when prescriptionExerciseId is ambiguous', function() {
  var f = makeAmbiguousFixture();
  var exposures = _getExposures_fixed(f.LOGS, f.LOGS_BY_WEEK, 5, 'PID-BENCH', 0, 0, 'Press banca', 5);
  var wk5 = exposures.filter(function(e) { return e.week === 5; });
  assert.strictEqual(wk5.length, 0,
    'week 5 must be skipped entirely — corrupt identity, do not guess positionally');
});

test('FIX: fixed version still returns the unambiguous week 4 exposure normally', function() {
  var f = makeAmbiguousFixture();
  var exposures = _getExposures_fixed(f.LOGS, f.LOGS_BY_WEEK, 5, 'PID-BENCH', 0, 0, 'Press banca', 5);
  var wk4 = exposures.filter(function(e) { return e.week === 4; });
  assert.strictEqual(wk4.length, 1, 'week 4 (unambiguous, HIGH confidence) is still returned');
  assert.strictEqual(wk4[0].confidence, 'HIGH', 'week 4 keeps HIGH confidence via prescriptionExerciseId match');
  assert.strictEqual(wk4[0].sets[0].carga, 60, 'week 4 correct load returned');
});

test('FIX: unambiguous single-position id match (no duplication) is unaffected', function() {
  var LOGS = {
    'log_3_1_1_s0': { done: true, carga: 45, reps: 10, prescriptionExerciseId: 'PID-CURL' }
  };
  var LOGS_BY_WEEK = { log: { 3: ['log_3_1_1_s0'] } };
  var exposures = _getExposures_fixed(LOGS, LOGS_BY_WEEK, 3, 'PID-CURL', 1, 1, 'Curl', 5);
  assert.strictEqual(exposures.length, 1, 'unambiguous id still resolves normally');
  assert.strictEqual(exposures[0].confidence, 'HIGH');
  assert.strictEqual(exposures[0].sets[0].carga, 45);
});

// ── Verify source: confirm the fix is present in vdsen-cliente.html ──────────

console.log('\nT134-C — source verification');

var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

test('source: _getExposures contains the DUPLICATE_PRESCRIPTION_ID skip branch', function() {
  var fnStart = src.indexOf('function _getExposures(');
  assert.ok(fnStart !== -1, '_getExposures function found');
  var fnSlice = src.slice(fnStart, fnStart + 2000);
  assert.ok(fnSlice.indexOf('DUPLICATE_PRESCRIPTION_ID') !== -1,
    '_getExposures documents the DUPLICATE_PRESCRIPTION_ID case');
  assert.ok(/positions\)\.length > 1\) \{[\s\S]{0,400}?continue;/.test(fnSlice),
    '_getExposures continues (skips week) on ambiguity rather than falling through');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
