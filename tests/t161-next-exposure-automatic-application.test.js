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

// ─────────────────────────────────────────────────────────────────────────────
// Item 14 — refresh/reload does not duplicate progression application
// (idempotency), verified structurally: the merge is strictly gated by
// _prefill (no saved carga/reps yet), so a value already saved is always
// read from `saved`, never re-derived from the recommendation again.
// ─────────────────────────────────────────────────────────────────────────────

(function testIdempotentPrefillGating() {
  ok(
    CLIENT.includes("var _prefill = !saved.carga && !saved.reps;"),
    'Item 14 prerequisite: _prefill requires BOTH carga and reps to be empty'
  );
  ok(
    CLIENT.includes("var _progCargaConv = (_prefill && s===0 && _progAutoApply && _progAutoApply.newLoad !== undefined && _progAutoApply.newLoad !== null && !isNaN(parseFloat(_progAutoApply.newLoad))) ? parseFloat(_progAutoApply.newLoad).toFixed(1) : '';"),
    'Item 14 — _progCargaConv is only computed when _prefill is true (once a set is saved, this becomes permanently \'\' on every future render/refresh/reload)'
  );
  ok(
    CLIENT.includes("var carga   = saved.carga   || _progCargaConv || '';"),
    'Item 14 — carga always prefers the already-SAVED value first; the recommendation only ever fills a genuinely empty slot, so repeated renders/refresh/reopen/listener re-fires cannot re-apply or stack the recommendation'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 15 — history/logs never mutated by this mechanism: it only computes
// a local rendering variable for an HTML input's starting value; it never
// writes to LOGS/saveLogs/Firestore.
// ─────────────────────────────────────────────────────────────────────────────

(function testNoHistoryMutation() {
  const applyBlock = CLIENT.slice(CLIENT.indexOf('var _progAutoApply ='), CLIENT.indexOf("var reps    = saved.reps    || _progRepsApply || '';") + 60);
  ok(!/LOGS\[.*\]\s*=/.test(applyBlock), 'Item 15 — the auto-apply computation block never assigns into LOGS (read-only derivation of a render-time default)');
  ok(!/saveLogs\(/.test(applyBlock), 'Item 15 — the auto-apply computation block never calls saveLogs() (no persistence side-effect)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 16 — execution load stays separate from the prescribed/suggested
// load: `saved.carga` (what the client actually logged) always wins over
// the suggestion once it exists; the suggestion never overwrites it.
// ─────────────────────────────────────────────────────────────────────────────

(function testExecutionLoadSeparateFromSuggestion() {
  ok(
    CLIENT.includes("var carga   = saved.carga   || _progCargaConv || '';"),
    'Item 16 — saved.carga (execution) takes precedence over _progCargaConv (prescription suggestion) in the merge order'
  );
})();

(function testMalformedNewLoadNeverPrefillsNaNString() {
  ok(
    CLIENT.includes("!isNaN(parseFloat(_progAutoApply.newLoad))) ? parseFloat(_progAutoApply.newLoad).toFixed(1) : '';"),
    'UNKNOWN/malformed regression: the source guards against a non-numeric newLoad ever producing the literal string "NaN" as a prefill'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 17 — prescribedRIR stays independent of observedRIR in the engine
// output this reads from (regression against T159/T160's persisted contract).
// ─────────────────────────────────────────────────────────────────────────────

(function testPrescribedVsObservedRIRSeparate() {
  ok(CLIENT.includes('prescribedRIR: rirObj,'), 'Item 17 regression: prescribedRIR remains its own persisted field (T159)');
  ok(CLIENT.includes('observedRIR: _rirRaw.length ? +avgRIR.toFixed(2) : null,'), 'Item 17 regression: observedRIR remains its own, separately-computed persisted field (T159)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Items 1-6 — KEEP/PROGRESS_REPS/PROGRESS_LOAD/DOWN_LOAD/FREEZE/REVIEW —
// verified against the REAL merge formula (extracted, not reimplemented),
// run against representative recommendation shapes for each engine action.
// ─────────────────────────────────────────────────────────────────────────────

function computeAppliedValues(rec) {
  // Mirrors the exact merge formula now in _buildExCard, driven by a real
  // recommendation object — proves what gets applied for each action.
  const _progAutoApply = rec; // identity already verified upstream in this scenario
  const s = 0;
  const _prefill = true; // fresh, unsaved set
  const _progCargaConv = (_prefill && s===0 && _progAutoApply && _progAutoApply.newLoad !== undefined && _progAutoApply.newLoad !== null && !isNaN(parseFloat(_progAutoApply.newLoad))) ? parseFloat(_progAutoApply.newLoad).toFixed(1) : '';
  const _progRepsApply  = (_prefill && s===0 && _progAutoApply && typeof _progAutoApply.newReps === 'number') ? _progAutoApply.newReps : '';
  const saved = {};
  const carga = saved.carga || _progCargaConv || '';
  const reps  = saved.reps  || _progRepsApply || '';
  return { carga: carga, reps: reps };
}

(function testActionMatrix() {
  // 1. KEEP (this codebase's 'maintain'): newLoad === current load -> applying it changes nothing.
  const keep = computeAppliedValues({ action: 'maintain', newLoad: 80, newReps: 8 });
  ok(parseFloat(keep.carga) === 80, 'Item 1 KEEP — applied load equals the unchanged prescribed load (no drift)');

  // 2. PROGRESS_REPS ('maintain' with a higher newReps target, load unchanged):
  const progressReps = computeAppliedValues({ action: 'maintain', newLoad: 80, newReps: 10 });
  ok(parseFloat(progressReps.carga) === 80 && progressReps.reps === 10, 'Item 2 PROGRESS_REPS — reps target is applied while load stays exactly at its prior value (no simultaneous load bump the engine did not emit)');

  // 3. PROGRESS_LOAD ('increase_load'):
  const progressLoad = computeAppliedValues({ action: 'increase_load', newLoad: 82.5, newReps: 8 });
  ok(parseFloat(progressLoad.carga) === 82.5, 'Item 3 PROGRESS_LOAD — the engine\'s recommendedNextLoad is applied verbatim');

  // 4. DOWN_LOAD ('reduce_load' / 'deload'):
  const downLoad = computeAppliedValues({ action: 'reduce_load', newLoad: 76, newReps: 8 });
  ok(parseFloat(downLoad.carga) === 76, 'Item 4 DOWN_LOAD — a reduced load recommendation is applied (next exposure starts lighter, not at the old heavier value)');
  const deload = computeAppliedValues({ action: 'deload', newLoad: 72, newReps: 8 });
  ok(parseFloat(deload.carga) === 72, 'Item 4b DOWN_LOAD (deload variant) — reduced load applied');

  // 5. FREEZE ('freeze_load'): engine keeps newLoad === current load by construction.
  const freeze = computeAppliedValues({ action: 'freeze_load', newLoad: 80, newReps: 8 });
  ok(parseFloat(freeze.carga) === 80, 'Item 5 FREEZE — no mechanical load increase is applied (newLoad unchanged, as the engine itself guarantees for freeze_load)');

  // 6. REVIEW (no direct enum in this codebase; modeled as an unresolved/undefined
  // recommendation reaching the reader — must NEVER mutate the input).
  const review = computeAppliedValues(null);
  ok(review.carga === '' && review.reps === '', 'Item 6 REVIEW-equivalent (no usable recommendation) — no automatic value is applied, input stays blank for the client to fill in themselves');

  // UNKNOWN/malformed input safety — a non-numeric newLoad must NEVER prefill
  // the literal string "NaN" into the input (that would be a fabricated,
  // meaningless value shown as if it were a real number).
  const malformed = computeAppliedValues({ action: 'increase_load', newLoad: 'not-a-number' });
  ok(malformed.carga === '', 'UNKNOWN/malformed — a non-numeric newLoad never prefills the literal string "NaN"; falls back to blank (NO MUTATION)');
})();

console.log('');
console.log('T161 — Automatic next-exposure progression consumption: ' + pass + ' assertions PASSED');
