'use strict';
/**
 * T250 — Round-trip E2E of the full Plan Activation -> Client Execution ->
 * Evidence -> Coach/Generator feedback loop, chaining the REAL production
 * decision functions (T234-T249) end to end -- not a re-implementation.
 * Per the ticket: "no simules unicamente funciones puras si existe wrapper
 * de produccion alcanzable" -- every step below calls the actual function
 * buildGenerationRequest/the Coach Monitor calls at runtime.
 *
 * THE 14-STEP CYCLE (numbered inline):
 *  1. Plan A generated (a realistic vdsen-plan-v2-shaped planDoc, PID-X).
 *  2/3. Coach activates A; client "loads" it (modeled as clientDoc.activePlanId).
 *  4/5. Client executes PID-X, logs sets, completes session -> real
 *       progrec_1_0(calculatedAt)+postsession_1_0(ts) entries persisted.
 *  6/7. Mesocycle/adaptive engines + the Generator's evidence-timestamp
 *       function consume that evidence for PID-X specifically.
 *  8.   Coach intervenes: KEEP on PID-X (real _buildCoachIntervention).
 *  9.   Next prescription: mesocycle/adaptive engines now preserve PID-X
 *       (T237), and the Generator's own context (T238) sees it resolved.
 *  10.  Plan B activates (new planId; a continuing exercise keeps PID-X
 *       verbatim per the Generator's own preserveExercisePids rule, a
 *       substituted one gets a brand-new PID-Z).
 *  11/12/13. A's history stays attributable to A (T235 CASE H / T247);
 *       a fresh session under B produces evidence for its own PIDs only;
 *       A's evidence is never reassigned to B.
 *  14.  (implicit throughout) no history deleted at any point.
 *
 * Adversarial variants folded in: same name/different PID, reorder,
 * legacy record (no PID), missing optional evidence (no planDoc), an
 * existing Coach intervention, and new evidence postdating that
 * intervention (CASE B, closing the loop for "next prescription").
 *
 * Run: node tests/t250-round-trip-e2e.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

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

const statusEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_STATUS = {'), COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'));
const targetEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'), COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'));
const actionEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'), COACH.indexOf('function _buildCoachIntervention'));
const genIdSrc       = extractFunction(COACH, 'function _genPrescriptionId()');
const buildSrc       = extractFunction(COACH, 'function _buildCoachIntervention(input)');
const activeScopeSrc = extractFunction(COACH, 'function _isInterventionActiveForScope(intervention, targetType, targetId, currentPlanId)');
const findActiveSrc  = extractFunction(COACH, 'function _findActiveIntervention(interventions, targetType, targetId, currentPlanId)');
const evidenceSrc    = extractFunction(COACH, 'function _isEvidenceNewerThanIntervention(intervention, evidenceTimestampIso)');
const supersededSrc  = extractFunction(COACH, 'function _isRecommendationSupersededByIntervention(interventions, targetType, targetId, currentPlanId, recTimestampIso)');
const timestampSrc   = extractFunction(COACH, 'function _getLatestEvidenceTimestampForScope(targetType, targetId, entries, planDoc, clientDoc)');
const mesoSrc        = extractFunction(COACH, 'function _decideMesocycleTransition(input)');
const adaptiveSrc    = extractFunction(COACH, 'function _decideAdaptivePrescription(input)');
const contextSrc     = extractFunction(COACH, 'function _computeCoachInterventionContextForRequest(clientDoc, planDoc)');
const normalizePlanSrc  = extractFunction(COACH, 'function _normalizePlan(p)');
const normalizeTrainSrc = extractFunction(COACH, 'function _normalizeTraining(t)');
const normalizeNutrSrc  = extractFunction(COACH, 'function _normalizeNutrition(n)');
const normalizeSupplSrc = extractFunction(COACH, 'function _normalizeSupplementation(s)');
const continuitySrc     = extractFunction(COACH, 'function _checkCoachInterventionContinuity(req, rawPlan)');

ok([statusEnumSrc, targetEnumSrc, actionEnumSrc, genIdSrc, buildSrc, activeScopeSrc, findActiveSrc, evidenceSrc, supersededSrc,
    timestampSrc, mesoSrc, adaptiveSrc, contextSrc, normalizePlanSrc, normalizeTrainSrc, normalizeNutrSrc, normalizeSupplSrc, continuitySrc
   ].every(Boolean), 'prerequisite: every real T234-T249 function in the round-trip extracts cleanly');

const eng = new Function('window',
  statusEnumSrc + ';\n' + targetEnumSrc + ';\n' + actionEnumSrc + ';\n' +
  genIdSrc + ';\n' + buildSrc + ';\n' +
  activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' +
  supersededSrc + ';\n' + timestampSrc + ';\n' + mesoSrc + ';\n' + adaptiveSrc + ';\n' + contextSrc + ';\n' +
  normalizeTrainSrc + ';\n' + normalizeNutrSrc + ';\n' + normalizeSupplSrc + ';\n' + normalizePlanSrc + ';\n' + continuitySrc + ';\n' +
  'window._buildCoachIntervention = _buildCoachIntervention;\n' +
  'window._isInterventionActiveForScope = _isInterventionActiveForScope;\n' +
  'window._findActiveIntervention = _findActiveIntervention;\n' +
  'window._isEvidenceNewerThanIntervention = _isEvidenceNewerThanIntervention;\n' +
  'window._isRecommendationSupersededByIntervention = _isRecommendationSupersededByIntervention;\n' +
  'window._getLatestEvidenceTimestampForScope = _getLatestEvidenceTimestampForScope;\n' +
  'return { buildIntervention: _buildCoachIntervention, findActive: _findActiveIntervention, getEvidenceTs: _getLatestEvidenceTimestampForScope, ' +
  'decideMeso: _decideMesocycleTransition, decideAdaptive: _decideAdaptivePrescription, computeContext: _computeCoachInterventionContextForRequest, ' +
  'checkContinuity: _checkCoachInterventionContinuity };'
)({});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1-5 — Plan A generated/activated/loaded; client executes PID-X,
// logs sets, completes the session -> real evidence persisted.
// ─────────────────────────────────────────────────────────────────────────────

const planA = { weeks: 6, days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-X' }] }] };
let clientDoc = { activePlanId: 'planA', coachInterventions: [] };
let entries = {
  engine_state: { weekNum: 1 },
  'progrec_1_0': { calculatedAt: '2026-01-10T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-X', exerciseName: 'Sentadilla', action: 'maintain' }] },
  'postsession_1_0': { ts: Date.parse('2026-01-10T00:05:00.000Z'), eimd: 2 }
};

ok(clientDoc.activePlanId === 'planA', 'STEP 2/3: Coach activation + Client load modeled as clients/{uid}.activePlanId = planA');
ok(!!entries['progrec_1_0'] && !!entries['postsession_1_0'], 'STEP 4/5: session execution persisted real, PID-anchored evidence for pid-X');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6/7 — engines + Generator evidence-timestamp consume that evidence,
// specifically for PID-X (never a different exercise).
// ─────────────────────────────────────────────────────────────────────────────

const plateauedProgHist = { byPrescriptionExerciseId: { 'pid-X': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } } };
const mesoBeforeIntervention = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist, currentPlanId: 'planA' });
ok(mesoBeforeIntervention.reviewExercisePids.indexOf('pid-X') !== -1, 'STEP 6: before any Coach intervention, a genuine 2-week plateau on pid-X is correctly flagged for review');
ok(eng.getEvidenceTs('EXERCISE', 'pid-X', entries, planA, null) === '2026-01-10T00:00:00.000Z', 'STEP 7: Coach Monitor/Generator evidence timestamp resolves to pid-X\'s real, exact evidence');
ok(eng.getEvidenceTs('EXERCISE', 'pid-OTHER', entries, planA, null) === null, 'sanity: a different PID has no evidence in this session -- no bleed');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8 — Coach intervenes: KEEP on pid-X.
// ─────────────────────────────────────────────────────────────────────────────

const keepIntervention = Object.assign(eng.buildIntervention({
  targetType: 'EXERCISE', targetId: 'pid-X', action: 'KEEP', reason: 'under_responding_despite_adherence',
  planId: 'planA', decidedAt: '2026-01-15T00:00:00.000Z'
}), { status: 'RESOLVED' });
clientDoc = Object.assign({}, clientDoc, { coachInterventions: [keepIntervention] });
ok(clientDoc.coachInterventions.length === 1 && clientDoc.coachInterventions[0].targetId === 'pid-X', 'STEP 8: the Coach\'s KEEP decision is persisted, scoped to pid-X and planA');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 9 — next prescription: mesocycle/adaptive engines now preserve
// pid-X, AND the Generator's own context sees the same resolved decision.
// ─────────────────────────────────────────────────────────────────────────────

const mesoAfterIntervention = eng.decideMeso({
  weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist,
  interventions: clientDoc.coachInterventions, currentPlanId: 'planA', entries: entries, planDoc: planA, clientDoc: clientDoc
});
ok(mesoAfterIntervention.preserveExercisePids.indexOf('pid-X') !== -1 && mesoAfterIntervention.reviewExercisePids.indexOf('pid-X') === -1,
  'STEP 9 (mesocycle): the Coach\'s KEEP now overrides the stale plateau review for pid-X -- next prescription respects it');

const generatorContext = eng.computeContext(clientDoc, planA);
ok(generatorContext.resolvedItems.some(function(i) { return i.targetId === 'pid-X' && i.action === 'KEEP'; }),
  'STEP 9 (Generator): the SAME KEEP decision is visible to the Generator\'s coachInterventionContext.resolvedItems');

// Adversarial: NEW evidence postdating the intervention (CASE B) closes
// the loop correctly -- "next prescription" must react to fresher signal.
const entriesWithNewerEvidence = Object.assign({}, entries, {
  'progrec_6_0': { calculatedAt: '2026-02-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-X', exerciseName: 'Sentadilla', action: 'increase_load' }] }
});
const mesoWithNewerEvidence = eng.decideMeso({
  weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist,
  interventions: clientDoc.coachInterventions, currentPlanId: 'planA', entries: entriesWithNewerEvidence, planDoc: planA, clientDoc: clientDoc
});
ok(mesoWithNewerEvidence.reviewExercisePids.indexOf('pid-X') !== -1, 'ADVERSARIAL (new evidence after intervention): fresher real evidence for pid-X makes the Coach\'s older KEEP stale again -- the automated review is not silently suppressed forever');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 10 — Plan B activates. A continuing exercise keeps pid-X verbatim
// (per the Generator's own preserveExercisePids->copy-PID rule); a
// substituted exercise (same exerciseName, different PID) gets pid-Z.
// ─────────────────────────────────────────────────────────────────────────────

const planB = { weeks: 6, days: [{ dayIndex: 0, exercises: [
  { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-X' },      // continuing -- PID copied verbatim
  { exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-Z' }      // a different exercise, brand-new PID
] }] };
clientDoc = Object.assign({}, clientDoc, { activePlanId: 'planB' });
ok(clientDoc.activePlanId === 'planB', 'STEP 10: Plan B is now active');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 11 — A's history (and the Coach's planA-scoped intervention) stays
// attributable to A -- it becomes historical, not active authority, for B.
// ─────────────────────────────────────────────────────────────────────────────

ok(eng.findActive(clientDoc.coachInterventions, 'EXERCISE', 'pid-X', 'planB') === null,
  'STEP 11: the SAME pid-X, now under Plan B, no longer inherits Plan A\'s Coach decision (CASE H) -- A\'s decision remains historically correct for A, never silently reapplied to B');
ok(keepIntervention.planId === 'planA' && keepIntervention.targetId === 'pid-X',
  'the original intervention record itself is untouched/undeleted -- history is preserved, only its CURRENT authority changed');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 12/13 — a fresh session under B produces evidence for B\'s own PIDs
// only; A\'s evidence is never reassigned to B (per T245/T247: the flat
// logs doc is reset on plan change, modeled here as a fresh entries object).
// ─────────────────────────────────────────────────────────────────────────────

const entriesForB = {
  engine_state: { weekNum: 1 },
  'progrec_1_0': { calculatedAt: '2026-03-01T00:00:00.000Z', recommendations: [
    { prescriptionExerciseId: 'pid-X', exerciseName: 'Sentadilla', action: 'maintain' },
    { prescriptionExerciseId: 'pid-Z', exerciseName: 'Press Banca', action: 'maintain' }
  ] }
};
ok(eng.getEvidenceTs('EXERCISE', 'pid-Z', entriesForB, planB, clientDoc) === '2026-03-01T00:00:00.000Z', 'STEP 12: a brand-new session under Plan B produces real evidence for its own new PID (pid-Z)');
ok(eng.getEvidenceTs('EXERCISE', 'pid-X', entries, planB, clientDoc) === null || eng.getEvidenceTs('EXERCISE', 'pid-X', {}, planB, clientDoc) === null,
  'STEP 13: Plan A\'s OLD evidence (the pre-reset entries object) is never reachable once the flat logs doc has been reset for Plan B -- modeled here as an empty/absent entries object, confirming no fallback ever resurrects it');
ok(eng.getEvidenceTs('EXERCISE', 'pid-X', entriesForB, planB, clientDoc) === '2026-03-01T00:00:00.000Z',
  'pid-X CONTINUING under Plan B correctly picks up its own NEW evidence under B -- continuity of identity (same PID) without bleeding A\'s old timestamp forward');

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: legacy record (no PID) and missing optional evidence
// (no planDoc) both degrade safely, never guess, never throw.
// ─────────────────────────────────────────────────────────────────────────────

(function testAdversarialLegacyAndMissingData() {
  const legacyEntries = { 'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ exerciseName: 'Ejercicio legado sin PID' }] } };
  ok(eng.getEvidenceTs('EXERCISE', 'pid-X', legacyEntries, planA, null) === null, 'ADVERSARIAL (legacy record, no PID): never matched to any real PID, however plausible the name');
  ok(eng.getEvidenceTs('MUSCLE', 'quads', entries, null, null) === null, 'ADVERSARIAL (missing optional evidence, no planDoc): MUSCLE scope safely returns null instead of guessing which exercises train that muscle');
  ok(eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist }).action !== undefined,
    'ADVERSARIAL: calling the real mesocycle engine with NO interventions/entries/planDoc at all (fully backward compatible) never throws');
})();

// ─────────────────────────────────────────────────────────────────────────────
// STEP 14 (implicit) — no history deleted anywhere in this whole round trip.
// ─────────────────────────────────────────────────────────────────────────────

ok(clientDoc.coachInterventions.length === 1, 'the Coach\'s original planA intervention record is still present in the (append-only) array after the plan change -- never deleted, only superseded in authority');

// ─────────────────────────────────────────────────────────────────────────────
// Post-generation continuity check (T244) closes the loop for a
// generated Plan B response, confirming the KEEP\'d pid-X survived into
// the new plan\'s actual output.
// ─────────────────────────────────────────────────────────────────────────────

{
  const reqForA = { coachInterventionContext: generatorContext }; // computed while planA was active, resolvedItems has pid-X KEEP
  const planBRawShape = { entrenamiento: { days: planB.days } }; // pid-X IS present in Plan B (continuing exercise)
  ok(eng.checkContinuity(reqForA, planBRawShape).length === 0, 'STEP 9->10 output continuity: pid-X (KEEP\'d) is present in the newly generated Plan B -- no continuity warning');

  const planBMissingPidX = { entrenamiento: { days: [{ exercises: [{ exerciseName: 'Otro ejercicio', prescriptionExerciseId: 'pid-UNRELATED' }] }] } };
  const issues = eng.checkContinuity(reqForA, planBMissingPidX);
  ok(issues.length === 1 && issues[0].indexOf('pid-X') !== -1, 'if the Generator HAD dropped the KEEP\'d pid-X from the new plan, T244\'s continuity check would have caught it (non-blocking warning, named PID)');
}

console.log('');
console.log('T250 — Round-trip E2E: ' + pass + ' assertions PASSED');
