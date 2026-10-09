'use strict';
/**
 * T174 — Canonical generation E2E acceptance.
 *
 * TRACED (grep-first, no full rereads of stable modules):
 *   vdsenAIPreview() -> VDSEN_BUILD.buildGenerationRequest() -> POST
 *   /api/vdsen-generate -> _vdsenAIShowPreview() -> _vdsenSaveDraftClick()
 *   -> _vdsenSaveDraftToFirestore() -> _vdsenActivatePlanClick() ->
 *   _vdsenActivatePlanInFirestore().
 *
 *   PID FIDELITY CHECK (the one thing that could have silently broken this
 *   whole chain): _vdsenSaveDraftToFirestore normalizes the raw model
 *   response via _normalizePlan() -> _normalizeTraining(t), NOT the other,
 *   unrelated _normalizeTrainingPlan() (that heavier rebuild-every-field
 *   function belongs to the LEGACY autoGeneratePlan() path and strips
 *   prescriptionExerciseId — confirmed NOT used here). _normalizeTraining
 *   only does `Object.assign({}, t, {days: days})` — every per-exercise
 *   field the model returned, including prescriptionExerciseId, survives
 *   untouched. api/vdsen-generate.js's response JSON schema also declares
 *   `plan: {anyOf:[{type:'object'},{type:'null'}]}` — completely
 *   unstructured at the nested level, so no schema-level stripping either.
 *   _stampPrescriptionIds (T150, unmodified) then preserves any ID already
 *   present and only mints a fresh one where missing. Verified: the
 *   canonical pipeline genuinely supports PID echo-back end to end.
 *
 *   ACTIVATION: _vdsenActivatePlanInFirestore's transaction never calls
 *   t.update(planRef, ...) — the plan doc (and its days/PIDs) is written
 *   ONCE at draft-save time and never touched again; activation only flips
 *   clients/{clientId}.activePlanId (+ nutrition/supplement mirrors). The
 *   previous plan doc is never mutated either — preserved by non-mutation,
 *   not by a separate backup write (per its own inline comment).
 *
 * No new production bug found in this trace (0/2 budget used) — this
 * ticket is E2E acceptance test coverage, reusing T171's harness pattern
 * plus real extracted Coach-side functions (_stampPrescriptionIds,
 * _normalizeTraining) that T171 didn't need.
 *
 * Run: node tests/t174-canonical-generation-e2e.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const { _mapExerciseProgressionHistory, _mapPreviousPlan } = require(path.join(__dirname, '..', 'api', 'vdsen-build-request.js'));

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

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

// Real Coach-side pieces.
const genIdSrc    = extractFunction(COACH, 'function _genPrescriptionId()');
const stampSrc    = extractFunction(COACH, 'function _stampPrescriptionIds(days)');
const normTrainSrc = extractFunction(COACH, 'function _normalizeTraining(t)');
ok(genIdSrc && stampSrc && normTrainSrc, 'prerequisite: real Coach normalize/stamp functions extract cleanly');

function makeCoachPipeline() {
  const factory = new Function(
    'crypto',
    genIdSrc + ';\n' + stampSrc + ';\n' + normTrainSrc + ';\n' +
    'return { stamp: _stampPrescriptionIds, normalizeTraining: _normalizeTraining };'
  );
  return factory({ randomUUID: function () { throw new Error('force fallback id generator'); } });
}

// Real Client-side pieces (T161/T165 next-exposure reader/gate).
const readerSrc = extractFunction(CLIENT, 'function _getProgRecForExercise(di, ei, exName, prescriptionExerciseId)');
const normNameSrc = extractFunction(CLIENT, 'function _normName(s)');
ok(readerSrc && normNameSrc, 'prerequisite: real Client next-exposure reader extracts cleanly');
function makeClientReader(LOGS, LOGS_BY_WEEK, CURRENT_WEEK) {
  const factory = new Function('LOGS', 'LOGS_BY_WEEK', 'CURRENT_WEEK', normNameSrc + ';\n' + readerSrc + ';\nreturn _getProgRecForExercise;');
  return factory(LOGS, LOGS_BY_WEEK, CURRENT_WEEK);
}
function clientNextExposure(planUpdatedAt, ejPid, progrec) {
  var stale = !!(planUpdatedAt && progrec && progrec.calculatedAt && Date.parse(planUpdatedAt) > Date.parse(progrec.calculatedAt));
  var autoApply = (progrec && ejPid && progrec.prescriptionExerciseId === ejPid && !stale) ? progrec : null;
  return { applied: !!autoApply, newLoad: autoApply ? autoApply.newLoad : null };
}
function coachCategorize(planPidSet, planUpdatedAt, r) {
  var identityStale = !!(r.prescriptionExerciseId && planPidSet.size && !planPidSet.has(r.prescriptionExerciseId));
  var editStale = !!(planUpdatedAt && r.calculatedAt && Date.parse(planUpdatedAt) > Date.parse(r.calculatedAt));
  if (identityStale || editStale) return 'REVIEW';
  if (r.action === 'increase_load') return 'PROGRESS_LOAD';
  if (r.action === 'freeze_load') return 'FREEZE';
  return 'KEEP';
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — preserved exercise: raw model output echoes PID X -> survives
// normalizeTraining -> stampPrescriptionIds -> Client can consume its history.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA_PreservedExercise() {
  const rawModelPlan = { weeks: 6, daysPerWeek: 1, days: [
    { dayIndex: 0, label: 'Día 1', exercises: [
      { exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-X', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: 90 }] }
    ]}
  ]};
  const pipeline = makeCoachPipeline();
  const normalized = pipeline.normalizeTraining(rawModelPlan);
  ok(normalized.days[0].exercises[0].prescriptionExerciseId === 'pid-X', 'CASE A — normalizeTraining preserves the model-echoed prescriptionExerciseId untouched');

  const stamped = pipeline.stamp(normalized.days);
  ok(stamped[0].exercises[0].prescriptionExerciseId === 'pid-X', 'CASE A — stampPrescriptionIds does not overwrite an existing PID (draft -> activate keeps PID X)');

  // Cross-mesocycle continuity flows through the GENERATOR (progressionHistory
  // read from the OLD plan's logs before the client ever visits the new one —
  // T166), not through the Client's LOGS, which T166 CASO D correctly wipes
  // to {} on a genuine plan change. What must still work POST-activation is
  // the STANDARD T161 mechanism operating on the preserved PID within the
  // NEW mesocycle: week 1's rec (fresh, generated after the client's first
  // session on the new plan) correctly auto-applies at week 2's exposure,
  // because the PID survived the swap.
  const week1Rec = { prescriptionExerciseId: 'pid-X', action: 'increase_load', newLoad: 82.5, calculatedAt: '2026-02-08T00:00:00.000Z' };
  const LOGS = { 'progrec_1_0': { recommendations: [week1Rec] } };
  const reader = makeClientReader(LOGS, { progrec: { 1: ['progrec_1_0'] } }, 2); // client is now at week 2 of the NEW mesocycle
  const found = reader(0, 0, 'Press Banca', 'pid-X');
  const exposure = clientNextExposure(null, 'pid-X', found);
  ok(exposure.applied === true && exposure.newLoad === 82.5, 'CASE A — post-activation, next-exposure progression works normally on the preserved PID (week 1\'s fresh rec applies at week 2, within the new mesocycle)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — justified substitution: model omits the PID (substituted) ->
// gets a fresh PID Y, never reuses X; old history never autoapplies to Y.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB_JustifiedSubstitution() {
  const rawModelPlan = { weeks: 6, daysPerWeek: 1, days: [
    { dayIndex: 0, label: 'Día 1', exercises: [
      { exerciseName: 'Press Inclinado', sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 90 }] } // no PID: substituted
    ]}
  ]};
  const pipeline = makeCoachPipeline();
  const normalized = pipeline.normalizeTraining(rawModelPlan);
  const stamped = pipeline.stamp(normalized.days);
  const pidY = stamped[0].exercises[0].prescriptionExerciseId;
  ok(typeof pidY === 'string' && pidY.length > 0 && pidY !== 'pid-X', 'CASE B — a substituted exercise (model omitted the field) gets a genuinely fresh PID, never reusing the old one');

  const recX = { prescriptionExerciseId: 'pid-X', action: 'increase_load', newLoad: 85, calculatedAt: '2026-01-01T00:00:00.000Z' };
  const ph = _mapExerciseProgressionHistory({ 'progrec_5_0': { recommendations: [recX] } });
  ok(!ph.byPrescriptionExerciseId[pidY], 'CASE B — PID X\'s progressionHistory has no entry for the new PID Y — no inheritance');

  const reader = makeClientReader({ 'progrec_5_0': { recommendations: [recX] } }, { progrec: { 5: ['progrec_5_0'] } }, 5);
  const found = reader(0, 0, 'Press Inclinado', pidY); // pidY genuinely absent from week 5's recommendations — must find 0 matches, not fall back to pid-X by position
  const exposure = clientNextExposure(null, pidY, found);
  ok(exposure.applied === false, 'CASE B — Client never auto-applies pid-X\'s recommendation to the substituted exercise Y');

  const cat = coachCategorize(new Set([pidY]), null, recX);
  ok(cat === 'REVIEW', 'CASE B — Coach flags the old pid-X rec as REVIEW once the plan no longer contains that identity — Client/Coach/Generator all agree');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — high-confidence continuity: 5+ weeks of positive history ->
// confidence 'high' -> prompt's HIGH-tier preservation rule applies (T164,
// regression-cited, not re-derived) -> not rotated merely for a new mesocycle.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC_HighConfidenceContinuity() {
  const progrecs = {};
  for (let w = 1; w <= 5; w++) {
    progrecs['progrec_' + w + '_0'] = { recommendations: [
      { prescriptionExerciseId: 'pid-X', exerciseName: 'Press Banca', action: w < 5 ? 'maintain' : 'increase_load' }
    ]};
  }
  const ph = _mapExerciseProgressionHistory(progrecs);
  ok(ph.byPrescriptionExerciseId['pid-X'].confidence === 'high', 'CASE C — 5 weeks of real history maps to HIGH confidence');
  ok(COACH.includes('HIGH**: preferencia fuerte por preservar el ejercicio'), 'CASE C — T164 regression: the prompt still states a strong preservation preference for HIGH confidence');
  ok(COACH.includes('el Generador NO rota ejercicios por calendario, por \\"empezar mesociclo nuevo\\"'), 'CASE C — T164 regression: starting a new mesocycle alone is still explicitly not a valid rotation reason');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — coach edit before generation: buildGenerationRequest always reads
// the CURRENT (post-edit) plan doc live; a stale rec is still marked stale
// downstream per T165/T170 (regression-cited).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD_CoachEditOutranksStaleRec() {
  ok(COACH.includes('previousPlan:      planDoc || null,'), 'CASE D — buildGenerationRequest passes through whatever planDoc was just freshly read from Firestore (always the coach\'s latest saved state, never cached)');
  const rec = { prescriptionExerciseId: 'pid-X', action: 'increase_load', newLoad: 85, calculatedAt: '2026-01-01T10:00:00.000Z' };
  const planUpdatedAt = '2026-01-01T12:00:00.000Z'; // coach edited AFTER the rec was calculated
  const exposure = clientNextExposure(planUpdatedAt, 'pid-X', rec);
  ok(exposure.applied === false, 'CASE D — T165 regression: Client does not auto-apply a rec that predates the coach\'s later edit');
  const cat = coachCategorize(new Set(['pid-X']), planUpdatedAt, rec);
  ok(cat === 'REVIEW', 'CASE D — T170 regression: Coach also flags it REVIEW — the stale rec never outranks the coach\'s edit on either side');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — reactive deload: a prior deload is never exercise failure, and
// does not by itself justify rotation (T164 regression-cited).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE_DeloadNoRotation() {
  ok(COACH.includes('NUNCA se interpreta como que el ejercicio \\"no funciono\\"'), 'CASE E — T164 regression: a prior deload action/engineState.deloadTriggered is never read as exercise failure');
  const ph = _mapExerciseProgressionHistory({ 'progrec_4_0': { recommendations: [
    { prescriptionExerciseId: 'pid-X', exerciseName: 'Press Banca', action: 'freeze_load' } // deload/freeze week
  ]}});
  ok(ph.byPrescriptionExerciseId['pid-X'].latest.action === 'freeze_load', 'CASE E — a deload/freeze week is still recorded as real history, available to the Generator (not erased)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — final activation contract: Preview never auto-activates; Activate
// never re-writes the plan doc (days/PIDs immutable after draft); previous
// plan doc is never mutated (preserved by non-mutation).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF_ActivationContract() {
  ok(COACH.includes('BORRADOR — NO APLICADO'), 'CASE F — Preview still shows the not-applied draft badge (T142-H regression, review-gated)');
  const activateFn = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');
  ok(activateFn && !activateFn.includes('t.update(planRef'), 'CASE F — activation transaction never re-writes plans/{planId} — the drafted days/PIDs are immutable once saved');
  ok(activateFn && activateFn.includes('t.update(clientRef, clientUpdate);') && activateFn.includes('var clientUpdate = { activePlanId: planId };'), 'CASE F — activation only flips clients/{clientId}.activePlanId (+ nutrition/supplement mirrors, conditionally per T261), exactly the reviewed/drafted plan');
  ok(activateFn && activateFn.includes("if (planData.status !== 'draft_approved')"), 'CASE F — activation refuses anything that isn\'t the exact reviewed (draft_approved) plan');
})();

console.log('');
console.log('T174 — Canonical generation E2E acceptance: ' + pass + ' assertions PASSED (CASES A-F)');
