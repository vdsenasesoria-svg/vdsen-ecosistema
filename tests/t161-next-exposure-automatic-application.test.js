'use strict';
/**
 * T161 — Automatic next-exposure progression consumption.
 *
 * PASO 1 — CONTRACT MAP (see also the chat report):
 *   ENGINE OUTPUT:       calculateProgression() returns {recommendations:[
 *                         {prescriptionExerciseId, exerciseId, exerciseName,
 *                         action, newLoad, newSets, newReps, rirTarget,
 *                         prescribedRIR, observedRIR, repRangeTarget, trend,
 *                         reason, ...}], ...} (vdsen-cliente.html).
 *   PERSISTENCE:         LOGS['progrec_'+week+'_'+dayIndex] = recSafe (a
 *                         sanitized clone of the engine output), saved to
 *                         Firestore logs/{uid}.entries via saveLogs().
 *   NEXT-EXPOSURE READER: _getProgRecForExercise(di, ei, exName,
 *                         prescriptionExerciseId), called from _buildExCard
 *                         (the live per-set-row renderer) once per exercise
 *                         panel render.
 *   BUG FOUND (pre-T161): the reader existed and even had a variable
 *   (_progCargaConv) computed specifically to carry newLoad into the next
 *   exposure's starting value — but it was NEVER merged into the actual
 *   `carga`/`reps` input values. The recommendation was persisted and could
 *   be read, but only ever surfaced as a passive "OBJETIVO" text hint above
 *   the input; the input itself always started blank when unset. The
 *   engine's decision never actually reached the next exposure's
 *   prescription — automation stopped at "shown", never "applied". Also,
 *   the reader resolved by (dayIndex, exerciseIndex) position + a
 *   name-guard fallback — never by prescriptionExerciseId — so even the
 *   passive hint wasn't PID-first.
 *
 * FIX (T161):
 *   1. _getProgRecForExercise now takes prescriptionExerciseId and tries an
 *      EXACT PID match first, across all of that week's recommendations
 *      (not just the same day index) — ambiguity (same PID appearing twice
 *      in one week, corrupt data) makes it return null immediately rather
 *      than falling back to a guess. Absence of any PID match (new
 *      exercise, legacy plan) falls through to the pre-existing
 *      position+name-guard search — used for display only from here on.
 *   2. _buildExCard now computes _progAutoApply: the SAME `progrec` lookup
 *      result, but only kept when its own `prescriptionExerciseId` field
 *      matches the current exposure's `ej.prescriptionExerciseId` exactly
 *      — a second, explicit identity check independent of how the reader
 *      internally resolved it. Only _progAutoApply (never the loose
 *      position/name-matched `progrec`) feeds `_progCargaConv`/
 *      `_progRepsApply`, which are now actually merged into `carga`/`reps`
 *      — but ONLY when `_prefill` is true (the set has no saved carga/reps
 *      yet) and only for the first set (s===0) of that exposure.
 *
 * Why this is idempotent / never mutates history / never double-applies:
 *   `_prefill = !saved.carga && !saved.reps` gates the whole mechanism.
 *   The moment the client saves a set (completeSet), `saved.carga`/
 *   `saved.reps` become non-empty, so every subsequent render (refresh,
 *   reopen, repeated render, Firestore listener re-fire, loadPlan() again)
 *   reads `carga = saved.carga || ...` and takes the ALREADY-SAVED value —
 *   `_progCargaConv` is never even computed once `_prefill` is false. The
 *   recommendation is never written back into LOGS by this mechanism at
 *   all — it only ever influences what an UNSAVED input starts showing.
 *   Execution load stays whatever the client actually typed and submitted;
 *   the suggestion is just a starting point they can freely overwrite
 *   before pressing "GUARDAR SERIE".
 *
 * COACH OVERRIDE AUDIT: no dedicated "override this specific PID's next
 * recommendation" contract exists in the repo today, beyond the Coach's
 * existing plan-edit tool (plans/{id}) itself. Editing the plan already
 * changes ej.prescriptionExerciseId on a real substitution (which
 * naturally invalidates any stale recommendation via the PID-match check
 * above) or leaves it stable for a same-exercise tweak (sets/reps/rir),
 * which are separate fields from the persisted recommendation entirely.
 * No new override schema was invented here, per instructions — reported,
 * not built.
 *
 * Run: node tests/t161-next-exposure-automatic-application.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

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

// ─────────────────────────────────────────────────────────────────────────────
// Build a real, running _getProgRecForExercise from the actual source, with
// minimal stub globals — behavioral tests, not string matching.
// ─────────────────────────────────────────────────────────────────────────────

const normNameSrc = extractFunction(CLIENT, 'function _normName(s)');
const readerSrc    = extractFunction(CLIENT, 'function _getProgRecForExercise(di, ei, exName, prescriptionExerciseId)');
ok(normNameSrc && readerSrc, 'both _normName and _getProgRecForExercise must be extractable from source');

function makeReader(LOGS, LOGS_BY_WEEK, CURRENT_WEEK) {
  const factory = new Function('LOGS', 'LOGS_BY_WEEK', 'CURRENT_WEEK', normNameSrc + ';\n' + readerSrc + ';\nreturn _getProgRecForExercise;');
  return factory(LOGS, LOGS_BY_WEEK, CURRENT_WEEK);
}

function rebuildIndex(LOGS) {
  const idx = { progrec: {} };
  Object.keys(LOGS).forEach(function(k) {
    if (k.indexOf('progrec_') === 0) {
      const w = parseInt(k.split('_')[1], 10);
      if (!idx.progrec[w]) idx.progrec[w] = [];
      idx.progrec[w].push(k);
    }
  });
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Items 7-9 — PID correct / incorrect / absent-legacy-ambiguous.
// ─────────────────────────────────────────────────────────────────────────────

(function testPidCorrect() {
  const LOGS = {
    'progrec_2_0': { recommendations: [
      { prescriptionExerciseId: 'pid-bench', exerciseName: 'Press Banca', action: 'increase_load', newLoad: 82.5, newReps: 8 }
    ]}
  };
  const reader = makeReader(LOGS, rebuildIndex(LOGS), 3);
  const rec = reader(0, 0, 'Press Banca', 'pid-bench');
  ok(rec && rec.newLoad === 82.5, 'Item 7 — correct PID resolves to the exact recommendation, even scanning back from week 3');
})();

(function testPidIncorrect() {
  const LOGS = {
    'progrec_2_0': { recommendations: [
      { prescriptionExerciseId: 'pid-bench', exerciseName: 'Press Banca', action: 'increase_load', newLoad: 82.5 }
    ]}
  };
  const reader = makeReader(LOGS, rebuildIndex(LOGS), 3);
  const rec = reader(0, 0, 'Press Banca', 'pid-OTHER');
  // No match for pid-OTHER by identity; legacy fallback may still find something
  // by position/name (di=0,ei=0 -> recommendations[0] with matching name) — that
  // is fine for a DISPLAY hint, but the caller (_buildExCard) only trusts it for
  // automatic application when rec.prescriptionExerciseId === the caller's own PID.
  ok(!rec || rec.prescriptionExerciseId !== 'pid-OTHER', 'Item 8 — an incorrect PID never resolves to a recommendation claiming to be that PID');
})();

(function testPidAbsentLegacyAmbiguous() {
  // Two recommendations share the SAME prescriptionExerciseId in one week — corrupt/ambiguous.
  const LOGS = {
    'progrec_1_0': { recommendations: [
      { prescriptionExerciseId: 'pid-dup', exerciseName: 'A', newLoad: 10 },
      { prescriptionExerciseId: 'pid-dup', exerciseName: 'B', newLoad: 20 }
    ]}
  };
  const reader = makeReader(LOGS, rebuildIndex(LOGS), 1);
  const rec = reader(0, 0, 'A', 'pid-dup');
  ok(rec === null, 'Item 9 — ambiguous PID (duplicate identity within one week) resolves to null, never guesses');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 10 — stale recommendation (several weeks old) is still found (not
// treated as unusable), matching longitudinal/learned_state philosophy —
// but only ever used as a starting suggestion, never forced.
// ─────────────────────────────────────────────────────────────────────────────

(function testStaleRecommendationStillFound() {
  const LOGS = {
    'progrec_1_0': { recommendations: [
      { prescriptionExerciseId: 'pid-old', exerciseName: 'Sentadilla', action: 'increase_load', newLoad: 100 }
    ]}
  };
  const reader = makeReader(LOGS, rebuildIndex(LOGS), 5); // 4 weeks later, no newer progrec exists
  const rec = reader(0, 0, 'Sentadilla', 'pid-old');
  ok(rec && rec.newLoad === 100, 'Item 10 — an old (stale) recommendation is still the best available evidence and is returned, not discarded');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Items 11-12 — cross-plan / cross-week isolation.
// ─────────────────────────────────────────────────────────────────────────────

(function testCrossPlanIsolation() {
  // "Another plan" is structurally impossible to leak in because LOGS is
  // entirely reset (LOGS = {}) by loadPlan() whenever activePlanId changes
  // (see the planChanged branch) — there is no plan identifier inside
  // progrec_ entries to cross-check because the whole LOGS object IS
  // already scoped to the single active plan. Verify that reset exists.
  ok(CLIENT.includes('LOGS           = {};') , 'Item 11 — loadPlan() resets LOGS entirely on plan change, structurally preventing any cross-plan progrec_ leak into a new plan\'s exposures');
})();

(function testCrossWeekIsolation() {
  const LOGS = {
    'progrec_1_0': { recommendations: [{ prescriptionExerciseId: 'pid-x', exerciseName: 'X', newLoad: 50 }] },
    'progrec_3_0': { recommendations: [{ prescriptionExerciseId: 'pid-x', exerciseName: 'X', newLoad: 60 }] }
  };
  const reader = makeReader(LOGS, rebuildIndex(LOGS), 4);
  const rec = reader(0, 0, 'X', 'pid-x');
  ok(rec.newLoad === 60, 'Item 12 — the MOST RECENT week\'s recommendation for a PID wins over an older one (week 3 over week 1)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 13 — coach override: audited, no dedicated schema exists; a real
// exercise substitution (new PID) naturally invalidates the old
// recommendation via the identity check, which IS the existing mechanism.
// ─────────────────────────────────────────────────────────────────────────────

(function testCoachOverrideViaSubstitution() {
  const LOGS = {
    'progrec_2_0': { recommendations: [
      { prescriptionExerciseId: 'pid-old-exercise', exerciseName: 'Sentadilla', action: 'increase_load', newLoad: 120 }
    ]}
  };
  // Coach substituted the exercise -> new prescriptionExerciseId (per
  // _restampPrescriptionIds elsewhere in the codebase for real substitutions).
  const newExercisePID = 'pid-new-exercise-after-coach-substitution';
  const reader = makeReader(LOGS, rebuildIndex(LOGS), 3);
  const rec = reader(0, 0, 'Hack Squat', newExercisePID);
  ok(!rec || rec.prescriptionExerciseId !== newExercisePID, 'Item 13 — after a coach substitution (new PID), the old exercise\'s stale recommendation never resolves as belonging to the new one');
})();

// ───────────────────────────────────────
// Items 14-16 + malformed — SUPERSEDED BY T483.
// The T161 mechanism that carried progrec.newLoad/newReps into the next exposure's input
// defaults (_progCargaConv/_progRepsApply merged into carga/reps) is neutralized while
// NUMERIC_APPLY_ENABLED=false. What T161 protected still holds and is asserted here: the
// input value is the athlete's own saved execution, LOGS is never written by the render, and
// a malformed newLoad can never reach an input.
// ───────────────────────────────────────

(function testPrefillMechanismNeutralized() {
  ok(CLIENT.includes("var _prefill = !saved.carga && !saved.reps;"), 'Item 14 prerequisite: _prefill semantics unchanged');
  ok(CLIENT.includes("var carga   = saved.carga   || '';") && CLIENT.includes("var reps    = saved.reps    || '';"),
    'Item 14/16 — the input value is the saved execution only; a recommendation never fills an empty slot (T483)');
  ok(!CLIENT.includes('_progCargaConv') && !CLIENT.includes('_progRepsApply'), 'Item 14 — the legacy prefill variables are gone (T483)');
  const region = CLIENT.slice(CLIENT.indexOf('var _prefill = !saved.carga && !saved.reps;'), CLIENT.indexOf("var reps    = saved.reps    || '';") + 60);
  ok(!/LOGS\[.*\]\s*=/.test(region) && !/saveLogs\(/.test(region), 'Item 15 — the render-time region never assigns LOGS or persists');
  ok(!/_progAutoApply\.(newLoad|newReps)/.test(CLIENT), 'malformed/any newLoad or newReps can never reach an input through _progAutoApply (T483)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 17 — prescribedRIR stays independent of observedRIR in the engine
// output this reads from (regression against T159/T160's persisted contract).
// ─────────────────────────────────────────────────────────────────────────────

(function testPrescribedVsObservedRIRSeparate() {
  ok(CLIENT.includes('prescribedRIR: rirObj,'), 'Item 17 regression: prescribedRIR remains its own persisted field (T159)');
  ok(CLIENT.includes('observedRIR: _rirRaw.length ? +avgRIR.toFixed(2) : null,'), 'Item 17 regression: observedRIR remains its own, separately-computed persisted field (T159)');
})();

// ─────────────────────────────────────────────────────────────────
// Items 1-6 — SUPERSEDED BY T483: for every engine action (KEEP, PROGRESS_REPS, PROGRESS_LOAD,
// DOWN_LOAD, FREEZE, REVIEW) no operational value is applied any more; the recommendation is
// informational only. Verified against the real source.
// ─────────────────────────────────────────────────────────────────

(function testActionMatrixNeutralized() {
  ok(!/_progM\b/.test(CLIENT), 'Items 1-5 — superset-member prefill no longer consumes a name/position-matched progrec (T483)');
  ok(!/_pfCM = parseFloat\(_prog/.test(CLIENT), 'Item 4 — neither load increases nor reductions from progrec reach an input');
  ok(!CLIENT.includes('_progAutoApply') && !CLIENT.includes('_progRecStale'),
    'Item 6 — the PID+fresh auto-apply gate itself was removed (T487): no operational consumer of a recommendation remains');
})();


console.log('');
console.log('T161 — Automatic next-exposure progression consumption: ' + pass + ' assertions PASSED');
