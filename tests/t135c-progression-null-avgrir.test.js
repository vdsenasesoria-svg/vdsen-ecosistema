/**
 * T135-C — CLIENT: calculateProgression's performedWell gate must not treat a
 * missing previous-week avgRIR as 0 via implicit `null + 0.5` coercion.
 *
 * Bug: _getPrevWeekData() can legitimately return `avgRIR: null` for a week
 * where the client logged carga/reps for every set but left "RIR real" empty
 * (an OPTIONAL field in completeSet() — only carga and reps are required to
 * mark a set done). This is a common, everyday partial-data scenario, not a
 * corrupted plan.
 *
 * calculateProgression() then computed:
 *     var rirHeld = avgRIR <= prevWeek.avgRIR + 0.5;
 * In JS, `null + 0.5` coerces to `0 + 0.5 = 0.5`, so this silently became
 * `avgRIR <= 0.5` — a threshold that is almost never true for a normal
 * working RIR (1-4). That made `performedWell` false for nearly every client
 * whose previous week is missing RIR data, even when they held/increased
 * reps and load — which then blocks 'add_sets' and pushes the "Rendimiento
 * por debajo del objetivo" (underperforming) message instead of progressing
 * the client who actually performed well. A P1 wrong-progression-decision bug
 * driven purely by an optional field being empty.
 *
 * Fix: when prevWeek.avgRIR is null/undefined (no RIR signal to compare
 * against), rirHeld defaults to true — missing data is not treated as
 * evidence of regression.
 *
 * Run: node tests/t135c-progression-null-avgrir.test.js
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

// ── Replicates the performedWell gate BEFORE the fix ──
function performedWell_buggy(avgReps, avgRIR, load, prevWeek, repsTarget, rirObj) {
  if (prevWeek && prevWeek.avgReps > 0) {
    var repsHeld = avgReps >= prevWeek.avgReps - 0.5;
    var rirHeld  = avgRIR  <= prevWeek.avgRIR  + 0.5; // BUGGY: null + 0.5 === 0.5
    var loadHeld = load    >= prevWeek.avgLoad * 0.98;
    return repsHeld && rirHeld && loadHeld;
  }
  return (avgReps >= repsTarget) && (avgRIR <= rirObj + 0.5);
}

// ── Replicates the performedWell gate AFTER the fix ──
function performedWell_fixed(avgReps, avgRIR, load, prevWeek, repsTarget, rirObj) {
  if (prevWeek && prevWeek.avgReps > 0) {
    var repsHeld = avgReps >= prevWeek.avgReps - 0.5;
    var rirHeld  = (prevWeek.avgRIR === null || prevWeek.avgRIR === undefined)
                 ? true
                 : (avgRIR <= prevWeek.avgRIR + 0.5);
    var loadHeld = load    >= prevWeek.avgLoad * 0.98;
    return repsHeld && rirHeld && loadHeld;
  }
  return (avgReps >= repsTarget) && (avgRIR <= rirObj + 0.5);
}

console.log('\nT135-C — calculateProgression performedWell null-avgRIR guard');

test('BUG-confirm: buggy version denies performedWell when prevWeek.avgRIR is null, despite held reps/load', function() {
  // Client held reps (8 -> 8), RIR at target (2), and matched load exactly —
  // a textbook "performed well" week. Previous week has no RIR data logged.
  var prevWeek = { avgReps: 8, avgRIR: null, avgLoad: 60 };
  var result = performedWell_buggy(8, 2, 60, prevWeek, 8, 2);
  assert.strictEqual(result, false,
    'BUG CONFIRMED: performedWell is false purely because prevWeek.avgRIR was null (null+0.5=0.5, 2<=0.5 is false)');
});

test('FIX: fixed version grants performedWell when prevWeek.avgRIR is null but reps/load held', function() {
  var prevWeek = { avgReps: 8, avgRIR: null, avgLoad: 60 };
  var result = performedWell_fixed(8, 2, 60, prevWeek, 8, 2);
  assert.strictEqual(result, true,
    'fixed version treats missing prevWeek RIR data as no regression signal');
});

test('FIX: fixed version still requires repsHeld when prevWeek.avgRIR is null', function() {
  var prevWeek = { avgReps: 10, avgRIR: null, avgLoad: 60 };
  // avgReps dropped well below prevWeek.avgReps - 0.5 (10 - 0.5 = 9.5)
  var result = performedWell_fixed(6, 2, 60, prevWeek, 8, 2);
  assert.strictEqual(result, false, 'reps regression still blocks performedWell even with null avgRIR');
});

test('FIX: fixed version still requires loadHeld when prevWeek.avgRIR is null', function() {
  var prevWeek = { avgReps: 8, avgRIR: null, avgLoad: 100 };
  // load 80 < 100*0.98 = 98 -> loadHeld false
  var result = performedWell_fixed(8, 2, 80, prevWeek, 8, 2);
  assert.strictEqual(result, false, 'load regression still blocks performedWell even with null avgRIR');
});

test('FIX: unaffected behavior when prevWeek.avgRIR is a real number (no regression)', function() {
  var result = performedWell_fixed(8, 2, 60, false, 8, 2); // no prevWeek at all — sem 1 path
  assert.strictEqual(result, true, 'week-1 path (no prevWeek) unaffected by the fix');
});

test('FIX: real numeric prevWeek.avgRIR still gates correctly (regression case)', function() {
  // Previous week avgRIR was 1 (close to failure). Current week avgRIR jumped to 3
  // (well above prevWeek + 0.5 = 1.5) -> too easy relative to history -> rirHeld false.
  var prevWeek = { avgReps: 8, avgRIR: 1, avgLoad: 60 };
  var result = performedWell_fixed(8, 3, 60, prevWeek, 8, 2);
  assert.strictEqual(result, false, 'a real (non-null) prevWeek.avgRIR still gates rirHeld normally');
});

// ── Verify source: confirm the fix is present in vdsen-cliente.html ──────────

console.log('\nT135-C — source verification');

var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

test('source: calculateProgression contains the null-avgRIR guard', function() {
  var fnStart = src.indexOf('function calculateProgression(di, postData)');
  assert.ok(fnStart !== -1, 'calculateProgression function found');
  var fnSlice = src.slice(fnStart, fnStart + 9000);
  assert.ok(fnSlice.indexOf('prevWeek.avgRIR === null || prevWeek.avgRIR === undefined') !== -1,
    'calculateProgression guards prevWeek.avgRIR null/undefined before comparing rirHeld');
});

test('source: the old unguarded "avgRIR <= prevWeek.avgRIR  + 0.5" direct assignment is gone', function() {
  var fnStart = src.indexOf('function calculateProgression(di, postData)');
  var fnSlice = src.slice(fnStart, fnStart + 9000);
  assert.ok(!/var rirHeld\s*=\s*avgRIR\s*<=\s*prevWeek\.avgRIR\s*\+\s*0\.5;/.test(fnSlice),
    'the direct unguarded assignment must be replaced by the conditional guard');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
