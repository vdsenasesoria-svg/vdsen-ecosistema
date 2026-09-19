'use strict';
/**
 * T165 — Coach progression override authority.
 *
 * AUDIT (before writing code): searched for an existing override contract
 * (coachEdited/manualLoad/locked/source/origin/updatedByCoach/manualOverride)
 * across vdsen-cliente.html/vdsen-coach.html — none exists as a real
 * "this value was explicitly set by the coach, don't auto-touch it" contract.
 * `exmod_` is a CLIENT-side in-session adjustment (not written by the coach
 * app anywhere), and the training-plan editor never lets the coach set load
 * at all (sets are always saved with load:0) — so the only real conflict
 * surface is: coach edits an exercise's prescribed reps/RIR/sets (SAME
 * prescriptionExerciseId retained) via saveTrainingPlan(), and the next
 * client exposure still auto-applies a progression recommendation that was
 * calculated BEFORE that edit — i.e. a stale automated suggestion overriding
 * a newer, explicit coach decision. Confirmed as a REAL bug (not already
 * covered by T161's PID check, since PID is unchanged in this scenario).
 *
 * FIX: PLAN now carries `updatedAt` (plan doc's own field, already written
 * by every coach save path — no new contract). `_progAutoApply` in
 * _buildExCard additionally requires the recommendation's `calculatedAt` to
 * be at or after `PLAN.updatedAt` — otherwise the rec predates the coach's
 * edit and must not auto-apply. PID-change case (substitution) was already
 * correctly handled by T161 and is demonstrated here, not re-fixed.
 *
 * Run: node tests/t165-coach-override-authority.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: PLAN.updatedAt is wired from planData.updatedAt in loadPlan.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("updatedAt: planData.updatedAt || null"), 'PLAN now exposes the plan doc\'s updatedAt (the coach\'s last edit timestamp)');
ok(CLIENT.includes('var _progRecStale = !!(PLAN.updatedAt && progrec && progrec.calculatedAt && Date.parse(PLAN.updatedAt) > Date.parse(progrec.calculatedAt));'), '_progRecStale computes whether the plan was edited after the recommendation was calculated');
ok(CLIENT.includes('var _progAutoApply = (progrec && ej.prescriptionExerciseId && progrec.prescriptionExerciseId === ej.prescriptionExerciseId && !_progRecStale) ? progrec : null;'), '_progAutoApply now also requires the recommendation to NOT be stale relative to the coach\'s last plan edit');

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral: reimplements the exact staleness expression against synthetic
// PLAN.updatedAt / progrec.calculatedAt pairs (real logic, not reinvented).
// ─────────────────────────────────────────────────────────────────────────────

function isStale(planUpdatedAt, calculatedAt) {
  return !!(planUpdatedAt && calculatedAt && Date.parse(planUpdatedAt) > Date.parse(calculatedAt));
}

(function testCoachEditAfterRecommendation() {
  // Engine calculated PROGRESS_LOAD at T1; coach edits the plan (same PID,
  // e.g. lowers target reps) at T2 > T1 → the old rec must not auto-apply.
  const calculatedAt = '2026-01-10T10:00:00.000Z';
  const planUpdatedAt = '2026-01-10T12:00:00.000Z'; // coach edited 2h later
  ok(isStale(planUpdatedAt, calculatedAt) === true, 'a recommendation calculated BEFORE the coach\'s later plan edit is correctly flagged stale (coach decision wins)');
})();

(function testRecommendationAfterCoachEdit() {
  // Normal case: coach edited the plan, THEN the client trained and the
  // engine calculated a fresh recommendation afterward → must auto-apply.
  const planUpdatedAt = '2026-01-10T09:00:00.000Z';
  const calculatedAt = '2026-01-12T20:00:00.000Z';
  ok(isStale(planUpdatedAt, calculatedAt) === false, 'a recommendation calculated AFTER the coach\'s edit is fresh — auto-apply proceeds normally');
})();

(function testNoPlanUpdatedAt() {
  // Legacy plan with no updatedAt field at all — safe default, never stale.
  ok(isStale(null, '2026-01-10T10:00:00.000Z') === false, 'a legacy plan with no updatedAt never blocks auto-apply (safe default)');
  ok(isStale(undefined, undefined) === false, 'missing both timestamps never blocks auto-apply (safe default)');
})();

(function testMalformedTimestamps() {
  ok(isStale('not-a-date', '2026-01-10T10:00:00.000Z') === false, 'a malformed PLAN.updatedAt (Date.parse -> NaN) never blocks auto-apply — NaN comparisons are always false');
  ok(isStale('2026-01-10T10:00:00.000Z', 'not-a-date') === false, 'a malformed progrec.calculatedAt never blocks auto-apply either');
})();

(function testExactSameTimestamp() {
  const t = '2026-01-10T10:00:00.000Z';
  ok(isStale(t, t) === false, 'an equal timestamp (edit and calc at the exact same instant) is NOT stale — only a STRICTLY later plan edit invalidates the rec');
})();

// ─────────────────────────────────────────────────────────────────────────────
// PID-change case (substitution) — already correctly handled since T161;
// demonstrated here rather than re-fixed, per the ticket's own instruction
// not to invent a new contract when the existing one already proves it.
// ─────────────────────────────────────────────────────────────────────────────

(function testPidChangeAlreadyInvalidatesRecommendation() {
  // _progAutoApply's existing PID-equality check (T161) already means: if the
  // coach substitutes an exercise (new prescriptionExerciseId), the OLD
  // recommendation (tied to the old PID) can never match the new ej.prescriptionExerciseId,
  // so it is never auto-applied to the new exercise — no code change needed here.
  const oldRec = { prescriptionExerciseId: 'pid-old', newLoad: 82.5, newReps: 12 };
  const newEjPid = 'pid-new'; // coach substituted the exercise → fresh PID
  const wouldAutoApply = !!(oldRec && newEjPid && oldRec.prescriptionExerciseId === newEjPid);
  ok(wouldAutoApply === false, 'T161 regression/demonstration: substituting an exercise (new PID) already prevents the old recommendation from auto-applying to it — no new contract needed');
})();

console.log('');
console.log('T165 — Coach progression override authority: ' + pass + ' assertions PASSED');
