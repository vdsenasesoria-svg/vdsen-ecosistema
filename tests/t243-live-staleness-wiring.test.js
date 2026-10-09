'use strict';
/**
 * T243 — Live staleness wiring. Connects T242's canonical evidence
 * timestamp to the real call sites that previously always passed `null`
 * as recTimestampIso (_decideMesocycleTransition's per-PID loop,
 * _decideAdaptivePrescription's per-muscle override) -- so a Coach
 * intervention can now genuinely be superseded by REAL, later evidence
 * for that exact scope, never a fabricated one, never by name, and never
 * ahead of the existing PAIN/SAFETY gates.
 *
 * CASE A-F required by the ticket, all exercised through the REAL
 * production functions (not a re-implementation):
 *   A. intervention decided AFTER the evidence -> still active/superseding
 *   B. evidence AFTER the intervention -> intervention stale (not applied)
 *   C. evidence for a DIFFERENT target -> never invalidates
 *   D. same exercise NAME, different PID -> never invalidates
 *   E. CLIENT scope -> explicit, tested behavior
 *   F. no evidence timestamp available -> today's conservative behavior
 *      (intervention still supersedes) is UNCHANGED
 *
 * Run: node tests/t243-live-staleness-wiring.test.js
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

ok([statusEnumSrc, targetEnumSrc, actionEnumSrc, genIdSrc, buildSrc, activeScopeSrc, findActiveSrc, evidenceSrc, supersededSrc, timestampSrc, mesoSrc, adaptiveSrc].every(Boolean),
  'prerequisite: every T234-T243 function/enum extracts cleanly');

// Real production wiring checks -- the point of T243 is that the LIVE call
// sites, not just the standalone functions, now compute a real timestamp.
ok(COACH.includes("window._getLatestEvidenceTimestampForScope('EXERCISE', pid, input.entries, input.planDoc, input.clientDoc)"),
  '_decideMesocycleTransition\'s per-PID loop now computes a REAL evidence timestamp before checking supersession, not a hardcoded null');
ok(COACH.includes("_getLatestEvidenceTimestampForScope('MUSCLE', input.muscleId, input.entries, input.planDoc, input.clientDoc)"),
  '_decideAdaptivePrescription\'s per-muscle override now computes a REAL evidence timestamp, not a hardcoded null');
ok(COACH.includes('entries: entries || null,\n      planDoc: planDoc,\n      clientDoc: clientDoc || null'),
  '_computeMesocycleDecisionForRequest (Generator path) now threads entries/planDoc/clientDoc through to the mesocycle engine');
ok(COACH.includes('entries: entries || null,\n      clientDoc: clientDoc || null'),
  '_computeAdaptivePrescriptionForRequest (Generator path) now threads entries/clientDoc through');
ok(/entries: entries,\s*\n\s*planDoc: p,\s*\n\s*clientDoc: _detailClientData \|\| null/.test(COACH),
  'the Coach Monitor\'s own mesocycle display call now threads the same real entries/planDoc/clientDoc (CASE L stays true under T243)');

const eng = new Function('window',
  statusEnumSrc + ';\n' + targetEnumSrc + ';\n' + actionEnumSrc + ';\n' +
  genIdSrc + ';\n' + buildSrc + ';\n' +
  activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' +
  supersededSrc + ';\n' + timestampSrc + ';\n' + mesoSrc + ';\n' + adaptiveSrc + ';\n' +
  'window._buildCoachIntervention = _buildCoachIntervention;\n' +
  'window._isInterventionActiveForScope = _isInterventionActiveForScope;\n' +
  'window._findActiveIntervention = _findActiveIntervention;\n' +
  'window._isEvidenceNewerThanIntervention = _isEvidenceNewerThanIntervention;\n' +
  'window._isRecommendationSupersededByIntervention = _isRecommendationSupersededByIntervention;\n' +
  'window._getLatestEvidenceTimestampForScope = _getLatestEvidenceTimestampForScope;\n' +
  'return { buildIntervention: _buildCoachIntervention, getEvidenceTs: _getLatestEvidenceTimestampForScope, decideMeso: _decideMesocycleTransition, decideAdaptive: _decideAdaptivePrescription };'
)({});

function keepIntv(targetType, targetId, decidedAt, planId) {
  return eng.buildIntervention({ targetType: targetType, targetId: targetId, action: 'KEEP', status: 'RESOLVED', decidedAt: decidedAt, planId: planId });
}

const plateauedProgHist = { byPrescriptionExerciseId: { 'pid-1': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } } };
const quadTarget = { volumeTarget: 14, volumeRange: { min: 10, max: 18 }, frequencyTarget: 2 };

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — intervention decided AFTER the evidence -> still active,
// preserves the PID / overrides the muscle suggestion.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA() {
  const entries = { 'progrec_1_0': { calculatedAt: '2026-01-10T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1' }] } };
  const intv = keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A'); // decided AFTER the 2026-01-10 evidence
  const result = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist, interventions: [intv], currentPlanId: 'plan-A', entries: entries, planDoc: null });
  ok(result.preserveExercisePids.indexOf('pid-1') !== -1, 'CASE A: the intervention postdates the only real evidence for this PID -> still supersedes, plateau review stays suppressed');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — evidence AFTER the intervention -> the intervention is stale,
// the automated recommendation is no longer suppressed.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB() {
  const entries = { 'progrec_5_0': { calculatedAt: '2026-03-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1' }] } }; // AFTER the intervention
  const intv = keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A');
  const result = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist, interventions: [intv], currentPlanId: 'plan-A', entries: entries, planDoc: null });
  ok(result.reviewExercisePids.indexOf('pid-1') !== -1 && result.preserveExercisePids.indexOf('pid-1') === -1,
    'CASE B: real evidence for this exact PID postdates the Coach\'s KEEP -> the intervention is stale, the current plateau review is NOT suppressed');

  const muscleIntv = keepIntv('MUSCLE', 'quads', '2026-02-01T00:00:00.000Z', 'plan-A');
  const planDoc = { days: [{ exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-squat' }] }] };
  const muscleEntries = { 'progrec_5_0': { calculatedAt: '2026-03-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-squat' }] } };
  const canonicalStub = "var _EXERCISE_CANONICAL_METADATA = { 'sentadilla': { primaryMuscles: ['quads'] } };";
  const adaptiveEng = new Function(targetEnumSrc + ';\n' + canonicalStub + ';\n' + activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' + supersededSrc + ';\n' + timestampSrc + ';\n' + adaptiveSrc + ';\nreturn _decideAdaptivePrescription;')();
  const adaptiveResult = adaptiveEng({ weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads', interventions: [muscleIntv], currentPlanId: 'plan-A', entries: muscleEntries, planDoc: planDoc });
  ok(adaptiveResult.volumeAction === 'REVIEW_INCREASE', 'CASE B (adaptive): real newer evidence for this exact muscle also makes the Coach KEEP stale -- the automated REVIEW_INCREASE is not suppressed');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — evidence for a DIFFERENT target never invalidates this one.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC() {
  const entries = { 'progrec_5_0': { calculatedAt: '2026-03-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-OTHER' }] } }; // different PID
  const intv = keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A');
  const result = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist, interventions: [intv], currentPlanId: 'plan-A', entries: entries, planDoc: null });
  ok(result.preserveExercisePids.indexOf('pid-1') !== -1, 'CASE C: newer evidence exists, but for a DIFFERENT PID -- pid-1\'s Coach KEEP is untouched by it');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — same exercise NAME, different PID -> never invalidates. Evidence
// is matched by prescriptionExerciseId only; name is never consulted.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD() {
  // Two different PIDs, both named "Sentadilla" (e.g. re-prescribed after a
  // substitution/re-add) -- newer evidence for the NEW pid must not affect
  // the OLD pid's still-active intervention, and vice versa.
  const entries = {
    'progrec_1_0': { calculatedAt: '2026-01-10T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-OLD', exerciseName: 'Sentadilla' }] },
    'progrec_5_0': { calculatedAt: '2026-03-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-NEW', exerciseName: 'Sentadilla' }] }
  };
  const intv = keepIntv('EXERCISE', 'pid-OLD', '2026-02-01T00:00:00.000Z', 'plan-A');
  ok(eng.getEvidenceTs('EXERCISE', 'pid-OLD', entries, null, null) === '2026-01-10T00:00:00.000Z', 'CASE D: pid-OLD\'s own evidence timestamp ignores pid-NEW\'s entry despite the identical exerciseName');
  const progHistOld = { byPrescriptionExerciseId: { 'pid-OLD': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } } };
  const result = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progHistOld, interventions: [intv], currentPlanId: 'plan-A', entries: entries, planDoc: null });
  ok(result.preserveExercisePids.indexOf('pid-OLD') !== -1, 'CASE D: pid-NEW\'s newer evidence (same exercise name) never invalidates pid-OLD\'s Coach KEEP -- ID-exact only');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — CLIENT scope: explicit, tested behavior. CLIENT-level evidence
// comes from postsession/ci_sem/inbody, never from a specific PID/muscle.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE() {
  const entriesBefore = { 'postsession_1_0': { ts: Date.parse('2026-01-05T00:00:00.000Z') } };
  const entriesAfter  = { 'postsession_5_0': { ts: Date.parse('2026-03-01T00:00:00.000Z') } };
  const intv = keepIntv('CLIENT', 'client-1', '2026-02-01T00:00:00.000Z', 'plan-A');

  ok(eng.getEvidenceTs('CLIENT', 'client-1', entriesBefore, null, null) !== null, 'CLIENT scope resolves a real timestamp when client-level evidence exists');
  const supersededSrcEng = new Function(targetEnumSrc + ';\n' + activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' + supersededSrc + ';\nreturn _isRecommendationSupersededByIntervention;')();
  const beforeTs = eng.getEvidenceTs('CLIENT', 'client-1', entriesBefore, null, null);
  const afterTs  = eng.getEvidenceTs('CLIENT', 'client-1', entriesAfter, null, null);
  ok(supersededSrcEng([intv], 'CLIENT', 'client-1', 'plan-A', beforeTs) !== null, 'CASE E: CLIENT-scope evidence BEFORE the intervention -> the Coach decision still supersedes');
  ok(supersededSrcEng([intv], 'CLIENT', 'client-1', 'plan-A', afterTs) === null, 'CASE E: CLIENT-scope evidence AFTER the intervention -> the Coach decision is stale, explicitly and identically to EXERCISE/MUSCLE scope');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — no evidence timestamp available anywhere -> today's
// conservative behavior (intervention still supersedes) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF() {
  const result = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist, interventions: [keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A')], currentPlanId: 'plan-A', entries: {}, planDoc: null });
  ok(result.preserveExercisePids.indexOf('pid-1') !== -1, 'CASE F: no progrec evidence exists anywhere for this PID -> conservative default (Coach KEEP still supersedes), exactly as before T243');

  const noEntriesResult = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist, interventions: [keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A')], currentPlanId: 'plan-A' });
  ok(noEntriesResult.preserveExercisePids.indexOf('pid-1') !== -1, 'CASE F: entries/planDoc entirely omitted (backward compatible with every pre-T243 caller) -> same conservative behavior, no throw');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Safety still outranks everything, including a Coach decision superseded
// by new evidence -- PAIN_REVIEW is checked before any of this.
// ─────────────────────────────────────────────────────────────────────────────

(function testSafetyStillFirst() {
  const entries = { 'progrec_5_0': { calculatedAt: '2026-03-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1' }] } };
  const result = eng.decideMeso({ weeklyDecision: { status: 'PAIN_REVIEW' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: plateauedProgHist, interventions: [keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A')], currentPlanId: 'plan-A', entries: entries, planDoc: null });
  ok(result.action === 'STOP_FOR_SAFETY', 'a live pain signal still outranks everything -- checked before the (now live) staleness logic even runs');
})();

console.log('');
console.log('T243 — Live staleness wiring: ' + pass + ' assertions PASSED');
