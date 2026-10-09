'use strict';
/**
 * T237 — Downstream decision integration: a recent, in-scope Coach
 * intervention outranks a conflicting stale automated recommendation in
 * BOTH _decideMesocycleTransition (CASE A: EXERCISE-scoped KEEP overrides
 * the plateau/confidence "needs review" read) and _decideAdaptivePrescription
 * (CASE C/D: MUSCLE-scoped KEEP/ADJUST_VOLUME/REDISTRIBUTE_VOLUME overrides
 * REVIEW_INCREASE/REVIEW_DECREASE/REDISTRIBUTE). Safety (PAIN_REVIEW) still
 * outranks the Coach in both functions -- that gate runs BEFORE any
 * intervention check, so CASE F/G's "new pain overrides Coach KEEP" already
 * holds without needing per-scope evidence timestamps.
 *
 * Run: node tests/t237-downstream-decision-integration.test.js
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

const targetEnumSrc  = COACH.slice(COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'), COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'));
const activeScopeSrc = extractFunction(COACH, 'function _isInterventionActiveForScope(intervention, targetType, targetId, currentPlanId)');
const findActiveSrc  = extractFunction(COACH, 'function _findActiveIntervention(interventions, targetType, targetId, currentPlanId)');
const evidenceSrc    = extractFunction(COACH, 'function _isEvidenceNewerThanIntervention(intervention, evidenceTimestampIso)');
const supersededSrc  = extractFunction(COACH, 'function _isRecommendationSupersededByIntervention(interventions, targetType, targetId, currentPlanId, recTimestampIso)');
const mesoSrc        = extractFunction(COACH, 'function _decideMesocycleTransition(input)');
const adaptiveSrc    = extractFunction(COACH, 'function _decideAdaptivePrescription(input)');

ok([targetEnumSrc, activeScopeSrc, findActiveSrc, evidenceSrc, supersededSrc, mesoSrc, adaptiveSrc].every(Boolean),
  'prerequisite: every T235/T237 function plus both integration targets extract cleanly');

ok(COACH.includes('window._isRecommendationSupersededByIntervention = _isRecommendationSupersededByIntervention;'),
  'exposed for reuse (mesocycle transition reaches it via the lazy window.* pattern)');

// ─────────────────────────────────────────────────────────────────────────────
// _isRecommendationSupersededByIntervention: composes T235's own functions,
// no second engine.
// ─────────────────────────────────────────────────────────────────────────────

const supersededEng = new Function(
  targetEnumSrc + ';\n' + activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' + supersededSrc + ';\n' +
  'return _isRecommendationSupersededByIntervention;'
)();

ok(!supersededSrc.includes('updateDoc') && !supersededSrc.includes('setDoc'), '_isRecommendationSupersededByIntervention never writes to Firestore -- pure composition');

(function testSupersededBasics() {
  const intv = { targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' };
  const result = supersededEng([intv], 'EXERCISE', 'pid-1', 'plan-A', null);
  ok(result && result.action === 'KEEP', 'an active in-scope intervention with no newer evidence supersedes the automated recommendation');
  ok(supersededEng([intv], 'EXERCISE', 'pid-1', 'plan-A', '2026-02-05T00:00:00.000Z') === null, 'CASE F/G: evidence timestamped AFTER the intervention is NOT superseded -- the older decision does not erase it');
  ok(supersededEng([intv], 'EXERCISE', 'pid-OTHER', 'plan-A', null) === null, 'a different PID -- no scope match, nothing superseded');
  ok(supersededEng([intv], 'EXERCISE', 'pid-1', 'plan-OLD', null) === null, 'CASE H: an intervention tied to a different (old) plan is historical, not active for the current plan');
  ok(supersededEng(null, 'EXERCISE', 'pid-1', 'plan-A', null) === null, 'no interventions at all -> null, no throw');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — mesocycle transition: an active EXERCISE KEEP intervention
// forces preserve, bypassing the plateau/confidence review.
// ─────────────────────────────────────────────────────────────────────────────

function buildMesoHarness() {
  const genIdSrc = extractFunction(COACH, 'function _genPrescriptionId()');
  const fakeWindow = { _isRecommendationSupersededByIntervention: supersededEng };
  const fn = new Function('window', genIdSrc + ';\n' + mesoSrc + ';\nreturn _decideMesocycleTransition;')(fakeWindow);
  return fn;
}
const decideMeso = buildMesoHarness();

(function testCaseA_KeepOverridesPlateau() {
  const progressionHistory = {
    byPrescriptionExerciseId: {
      'pid-1': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } // would plateau-review without the intervention
    }
  };
  const withoutIntervention = decideMeso({
    weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: progressionHistory
  });
  ok(withoutIntervention.reviewExercisePids.indexOf('pid-1') !== -1, 'baseline: a genuine 2-week plateau with reliable evidence is flagged for review without any intervention');

  const withIntervention = decideMeso({
    weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: progressionHistory,
    interventions: [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' }],
    currentPlanId: 'plan-A'
  });
  ok(withIntervention.preserveExercisePids.indexOf('pid-1') !== -1, 'CASE A: an active Coach KEEP intervention forces the PID into preserve, overriding the automated plateau review');
  ok(withIntervention.reviewExercisePids.indexOf('pid-1') === -1, 'the stale "needs review" verdict is not resurfaced once the Coach explicitly decided to keep it');
})();

(function testCaseH_HistoricalMesocycleNotHonored() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } } };
  const result = decideMeso({
    weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: progressionHistory,
    interventions: [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', decidedAt: '2025-01-01T00:00:00.000Z', planId: 'plan-OLD' }],
    currentPlanId: 'plan-CURRENT'
  });
  ok(result.reviewExercisePids.indexOf('pid-1') !== -1, 'CASE H: a KEEP intervention tied to a PREVIOUS mesocycle/plan is historical -- it does not suppress a genuine current-plan plateau review');
})();

(function testSafetyStillOutranksCoach() {
  const result = decideMeso({
    weeklyDecision: { status: 'PAIN_REVIEW' }, adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: { byPrescriptionExerciseId: { 'pid-1': { confidence: 'high', history: [] } } },
    interventions: [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' }],
    currentPlanId: 'plan-A'
  });
  ok(result.action === 'STOP_FOR_SAFETY', 'CASE F: a live pain signal outranks any Coach KEEP intervention -- safety gate runs BEFORE the intervention check');
})();

(function testNoInterventionsIsANoop() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-2': { confidence: 'medium', history: [{ action: 'progress' }] } } };
  const result = decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progressionHistory });
  ok(result.preserveExercisePids.indexOf('pid-2') !== -1, 'no interventions array at all -> existing plateau logic runs completely unchanged (backward compatible)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C/D — adaptive prescription: an active MUSCLE intervention
// (KEEP/ADJUST_VOLUME/REDISTRIBUTE_VOLUME) overrides a conflicting
// REVIEW_INCREASE/REVIEW_DECREASE/REDISTRIBUTE suggestion.
// ─────────────────────────────────────────────────────────────────────────────

function buildAdaptiveHarness() {
  const fn = new Function(
    targetEnumSrc + ';\n' + activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' + supersededSrc + ';\n' + adaptiveSrc + ';\n' +
    'return _decideAdaptivePrescription;'
  )();
  return fn;
}
const decideAdaptive = buildAdaptiveHarness();

const quadTarget = { volumeTarget: 14, volumeRange: { min: 10, max: 18 }, frequencyTarget: 2 };

(function testCaseC_KeepOverridesReviewIncrease() {
  const baseline = decideAdaptive({ weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads' });
  ok(baseline.volumeAction === 'REVIEW_INCREASE', 'baseline: below target range while progressing -> automated REVIEW_INCREASE (no intervention yet)');

  const withKeep = decideAdaptive({
    weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads',
    interventions: [{ targetType: 'MUSCLE', targetId: 'quads', action: 'KEEP', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' }],
    currentPlanId: 'plan-A'
  });
  ok(withKeep.volumeAction === 'KEEP', 'CASE C: an active Coach KEEP on this muscle overrides the automated REVIEW_INCREASE');
  ok(withKeep.reasons.indexOf('coach_decision_supersedes_automated_volume_suggestion') !== -1, 'the override reason is traceable, not silent');
})();

(function testCaseD_AdjustVolumeSuppressesStaleIncrease() {
  const result = decideAdaptive({
    weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads',
    interventions: [{ targetType: 'MUSCLE', targetId: 'quads', action: 'ADJUST_VOLUME', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' }],
    currentPlanId: 'plan-A'
  });
  ok(result.volumeAction === 'KEEP', 'CASE D: a Coach who already manually adjusted this muscle\'s volume does not get a stale increase suggestion resurfaced');
})();

(function testDifferentMuscleNotAffected() {
  const result = decideAdaptive({
    weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads',
    interventions: [{ targetType: 'MUSCLE', targetId: 'hamstrings', action: 'KEEP', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' }],
    currentPlanId: 'plan-A'
  });
  ok(result.volumeAction === 'REVIEW_INCREASE', 'a KEEP intervention on a DIFFERENT muscle never bleeds into this muscle\'s automated read -- scope matters');
})();

(function testPainStillOutranksCoachInAdaptive() {
  const result = decideAdaptive({
    weeklyStatus: 'PAIN_REVIEW', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads',
    interventions: [{ targetType: 'MUSCLE', targetId: 'quads', action: 'KEEP', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' }],
    currentPlanId: 'plan-A'
  });
  ok(result.volumeAction === 'FREEZE', 'CASE F: a live pain signal outranks any Coach volume intervention -- the safety gate returns before the intervention check ever runs');
})();

(function testNoInterventionsIsANoopAdaptive() {
  const result = decideAdaptive({ weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads' });
  ok(result.volumeAction === 'REVIEW_INCREASE', 'no interventions array at all -> existing volume logic runs completely unchanged (backward compatible)');
})();

console.log('');
console.log('T237 — Downstream decision integration: ' + pass + ' assertions PASSED');
