'use strict';
/**
 * T239 — E2E Coach intervention lifecycle. Chains the REAL, unmodified
 * production functions (T234-T238) end to end, the same way T216/T224/T231
 * chained their own engines: extract every function verbatim via
 * extractFunction, wire the SAME lazy window.* cross-script-block pattern
 * the real page uses, then exercise the full DETECTED ISSUE -> COACH
 * DECISION -> STALENESS -> DOWNSTREAM -> GENERATOR chain for CASE A-L.
 *
 * CASE J (double-click/repeated save -> one effective record) and CASE K
 * (slow save + client switch -> no cross-client write/false success) are
 * UI/persistence-level guarantees already covered directly by
 * tests/t236-monitor-action-workflow.test.js (double-click guard,
 * finally-reset, _clientIdSnap stale-context guard) -- not re-derived here
 * to avoid duplicating that coverage with a weaker proxy.
 *
 * Run: node tests/t239-e2e-intervention-lifecycle.test.js
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
const mesoSrc        = extractFunction(COACH, 'function _decideMesocycleTransition(input)');
const adaptiveSrc    = extractFunction(COACH, 'function _decideAdaptivePrescription(input)');
const contextSrc     = extractFunction(COACH, 'function _computeCoachInterventionContextForRequest(clientDoc, planDoc)');

ok([statusEnumSrc, targetEnumSrc, actionEnumSrc, genIdSrc, buildSrc, activeScopeSrc, findActiveSrc, evidenceSrc, supersededSrc, mesoSrc, adaptiveSrc, contextSrc].every(Boolean),
  'prerequisite: every T234-T238 function/enum in the chain extracts cleanly');

const eng = new Function('window',
  statusEnumSrc + ';\n' + targetEnumSrc + ';\n' + actionEnumSrc + ';\n' +
  genIdSrc + ';\n' + buildSrc + ';\n' +
  activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' +
  supersededSrc + ';\n' + mesoSrc + ';\n' + adaptiveSrc + ';\n' + contextSrc + ';\n' +
  // Mirrors the real page's own window.* export lines (verified to exist
  // verbatim in vdsen-coach.html by t234/t235/t237/t238's own assertions)
  // so the lazy cross-script-block lookups resolve exactly as at runtime.
  'window._buildCoachIntervention = _buildCoachIntervention;\n' +
  'window._isInterventionActiveForScope = _isInterventionActiveForScope;\n' +
  'window._findActiveIntervention = _findActiveIntervention;\n' +
  'window._isEvidenceNewerThanIntervention = _isEvidenceNewerThanIntervention;\n' +
  'window._isRecommendationSupersededByIntervention = _isRecommendationSupersededByIntervention;\n' +
  'return { buildIntervention: _buildCoachIntervention, isActiveForScope: _isInterventionActiveForScope, findActive: _findActiveIntervention, ' +
  'isNewer: _isEvidenceNewerThanIntervention, superseded: _isRecommendationSupersededByIntervention, decideMeso: _decideMesocycleTransition, ' +
  'decideAdaptive: _decideAdaptivePrescription, computeContext: _computeCoachInterventionContextForRequest };'
)({});

function keepIntv(targetType, targetId, decidedAt, planId, overrides) {
  return Object.assign(eng.buildIntervention({ targetType: targetType, targetId: targetId, action: 'KEEP', status: 'RESOLVED', decidedAt: decidedAt, planId: planId }), overrides || {});
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — progression suggests increase (a plateau review, in mesocycle
// terms), Coach explicitly KEEP -> invalidated -> next exposure (Generator
// AND mesocycle decision) both respect KEEP.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA() {
  const progHist = { byPrescriptionExerciseId: { 'pid-1': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } } };
  const decidedAt = '2026-02-01T00:00:00.000Z';
  const intv = eng.buildIntervention({ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', decidedAt: decidedAt, planId: 'plan-A' });
  ok(intv.status === 'OPEN', 'sanity: a bare _buildCoachIntervention call without an explicit status defaults to OPEN (Monitor stamps RESOLVED itself for MANTENER, per T236)');

  const resolvedIntv = Object.assign({}, intv, { status: 'RESOLVED' }); // what T236's MANTENER button actually persists
  const interventions = [resolvedIntv];

  const meso = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progHist, interventions: interventions, currentPlanId: 'plan-A' });
  ok(meso.preserveExercisePids.indexOf('pid-1') !== -1 && meso.reviewExercisePids.indexOf('pid-1') === -1, 'CASE A (mesocycle): the KEEP intervention preserves pid-1, the stale plateau review is not resurfaced');

  const context = eng.computeContext({ activePlanId: 'plan-A', coachInterventions: interventions }, null);
  ok(context.resolvedItems.length === 1 && context.resolvedItems[0].targetId === 'pid-1' && context.resolvedItems[0].action === 'KEEP',
    'CASE A (Generator): the SAME KEEP decision reaches coachInterventionContext.resolvedItems -- Monitor and Generator agree on the current decision');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B / I — a genuinely new PID (substitution, or same exerciseName but
// a different PID) starts completely clean: no inherited recommendation,
// no inherited intervention, by identity (targetId) alone.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB_and_I() {
  const oldPid = 'pid-OLD', newPid = 'pid-NEW-SAME-NAME';
  const interventions = [keepIntv('EXERCISE', oldPid, '2026-02-01T00:00:00.000Z', 'plan-A')];
  // The new PID has NO progressionHistory entry at all -- exactly what a
  // real substitution produces (T159-166: a new PID starts with empty history).
  const progHist = { byPrescriptionExerciseId: {} };

  ok(eng.findActive(interventions, 'EXERCISE', newPid, 'plan-A') === null, 'CASE I: a different PID (even representing the "same" exercise by name) never inherits the old PID\'s intervention');

  const meso = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progHist, interventions: interventions, currentPlanId: 'plan-A' });
  ok(meso.preserveExercisePids.indexOf(newPid) === -1 && meso.reviewExercisePids.indexOf(newPid) === -1,
    'CASE B: a substituted (new PID) exercise appears in NEITHER preserve nor review -- it starts clean, not carrying the old PID\'s verdict');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — adaptive prescription REVIEW_INCREASE, Coach keeps current
// volume -> Generator preserves current volume (both the deterministic
// engine AND the Generator context agree).
// ─────────────────────────────────────────────────────────────────────────────

const quadTarget = { volumeTarget: 14, volumeRange: { min: 10, max: 18 }, frequencyTarget: 2 };

(function testCaseC() {
  const interventions = [keepIntv('MUSCLE', 'quads', '2026-02-01T00:00:00.000Z', 'plan-A')];
  const adaptive = eng.decideAdaptive({ weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads', interventions: interventions, currentPlanId: 'plan-A' });
  ok(adaptive.volumeAction === 'KEEP', 'CASE C (adaptive): Coach KEEP overrides the automated REVIEW_INCREASE for this muscle');

  const context = eng.computeContext({ activePlanId: 'plan-A', coachInterventions: interventions }, null);
  ok(context.resolvedItems.some(function(i) { return i.targetType === 'MUSCLE' && i.targetId === 'quads' && i.action === 'KEEP'; }),
    'CASE C (Generator): the same decision is visible to the Generator as a resolved, binding item for quads');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — Coach reduces volume (ADJUST_VOLUME) -> a stale increase
// recommendation is not resurfaced afterward.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD() {
  const intv = eng.buildIntervention({ targetType: 'MUSCLE', targetId: 'quads', action: 'ADJUST_VOLUME', status: 'RESOLVED', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' });
  const adaptive = eng.decideAdaptive({ weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads', interventions: [intv], currentPlanId: 'plan-A' });
  ok(adaptive.volumeAction === 'KEEP', 'CASE D: after a Coach manual volume adjustment, the stale automated REVIEW_INCREASE for the same muscle is not resurfaced');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — Coach marks reviewed but changes nothing (NO_CHANGE/REVIEWED) ->
// the current valid engine recommendation may remain active (not suppressed).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE() {
  const progHist = { byPrescriptionExerciseId: { 'pid-1': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } } };
  const noChangeIntv = eng.buildIntervention({ targetType: 'EXERCISE', targetId: 'pid-1', action: 'NO_CHANGE', status: 'REVIEWED', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' });
  const meso = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progHist, interventions: [noChangeIntv], currentPlanId: 'plan-A' });
  ok(meso.reviewExercisePids.indexOf('pid-1') !== -1, 'CASE E: a "reviewed, no change" intervention does not suppress a genuinely current plateau review -- only KEEP does');

  const muscleNoChange = eng.buildIntervention({ targetType: 'MUSCLE', targetId: 'quads', action: 'NO_CHANGE', status: 'REVIEWED', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' });
  const adaptive = eng.decideAdaptive({ weeklyStatus: 'PROGRESSING', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads', interventions: [muscleNoChange], currentPlanId: 'plan-A' });
  ok(adaptive.volumeAction === 'REVIEW_INCREASE', 'CASE E: a "reviewed, no change" intervention does not suppress the automated volume suggestion either');

  const context = eng.computeContext({ activePlanId: 'plan-A', coachInterventions: [noChangeIntv, muscleNoChange] }, null);
  ok(context.activeDecisions.length === 2 && context.resolvedItems.length === 0, 'CASE E (Generator): a REVIEWED-but-unchanged decision lands in activeDecisions, never in resolvedItems -- never mistaken for a final directive');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — a live pain signal outranks ANY Coach intervention, including a
// resolved/binding one, in both downstream engines.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF() {
  const interventions = [keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A'), keepIntv('MUSCLE', 'quads', '2026-02-01T00:00:00.000Z', 'plan-A')];
  const meso = eng.decideMeso({ weeklyDecision: { status: 'PAIN_REVIEW' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: { byPrescriptionExerciseId: {} }, interventions: interventions, currentPlanId: 'plan-A' });
  ok(meso.action === 'STOP_FOR_SAFETY', 'CASE F (mesocycle): a live pain signal forces STOP_FOR_SAFETY regardless of any resolved Coach KEEP');
  const adaptive = eng.decideAdaptive({ weeklyStatus: 'PAIN_REVIEW', target: quadTarget, actualVolume: { fractionalTotal: 8 }, muscleId: 'quads', interventions: interventions, currentPlanId: 'plan-A' });
  ok(adaptive.volumeAction === 'FREEZE', 'CASE F (adaptive): a live pain signal forces FREEZE regardless of any resolved Coach KEEP on this muscle');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — the underlying primitive (_isRecommendationSupersededByIntervention)
// correctly refuses to let an intervention erase genuinely NEWER evidence,
// whenever a caller supplies a real per-scope evidence timestamp. The two
// current call sites conservatively pass no evidence timestamp (T237: no
// reliable per-PID/per-muscle evidence timestamp exists yet upstream), so
// this documents the mechanism at the primitive level rather than
// overclaiming it is exercised end-to-end today.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseG() {
  const intv = keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A');
  ok(eng.superseded([intv], 'EXERCISE', 'pid-1', 'plan-A', '2026-02-10T00:00:00.000Z') === null,
    'CASE G: evidence timestamped AFTER the Coach decision is never superseded by that older decision -- the primitive is ready for future per-scope evidence wiring');
  ok(eng.superseded([intv], 'EXERCISE', 'pid-1', 'plan-A', null) !== null,
    'without a real evidence timestamp (today\'s conservative call sites), the Coach decision remains authoritative -- never silently dropped for lack of data');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — a prior-mesocycle (different plan) intervention is historical
// across every layer: scope check, mesocycle, adaptive, Generator context.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseH() {
  const oldIntv = keepIntv('EXERCISE', 'pid-1', '2025-01-01T00:00:00.000Z', 'plan-OLD');
  ok(eng.isActiveForScope(oldIntv, 'EXERCISE', 'pid-1', 'plan-CURRENT') === false, 'CASE H (scope): historical for the current plan');

  const progHist = { byPrescriptionExerciseId: { 'pid-1': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } } };
  const meso = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progHist, interventions: [oldIntv], currentPlanId: 'plan-CURRENT' });
  ok(meso.reviewExercisePids.indexOf('pid-1') !== -1, 'CASE H (mesocycle): a genuine current-plan plateau is still flagged -- the old mesocycle\'s KEEP has no authority here');

  const context = eng.computeContext({ activePlanId: 'plan-CURRENT', coachInterventions: [oldIntv] }, null);
  ok(context === null, 'CASE H (Generator): a purely historical intervention set produces no active context at all');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE L — Monitor's own lookup (_findActiveIntervention, used to
// highlight the current button state) and the Generator's context
// (_computeCoachInterventionContextForRequest) agree on which decision is
// current, from the exact same append-only history.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseL() {
  const history = [
    keepIntv('EXERCISE', 'pid-1', '2026-01-01T00:00:00.000Z', 'plan-A', { action: 'PAUSE_FOR_REVIEW', status: 'REVIEWED' }),
    keepIntv('EXERCISE', 'pid-1', '2026-02-01T00:00:00.000Z', 'plan-A') // freshest -- KEEP/RESOLVED
  ];
  const monitorView = eng.findActive(history, 'EXERCISE', 'pid-1', 'plan-A');
  ok(monitorView && monitorView.action === 'KEEP' && monitorView.status === 'RESOLVED', 'CASE L (Monitor): the freshest intervention (KEEP) is what the button-highlight lookup resolves to');

  const generatorView = eng.computeContext({ activePlanId: 'plan-A', coachInterventions: history }, null);
  ok(generatorView.resolvedItems.length === 1 && generatorView.resolvedItems[0].action === 'KEEP', 'CASE L (Generator): the SAME freshest KEEP decision is the one and only resolvedItem the Generator sees');
  ok(generatorView.activeDecisions.length === 1 && generatorView.activeDecisions[0].action === 'PAUSE_FOR_REVIEW', 'the superseded older REVIEWED entry still surfaces as context (history preserved) but never as the resolved/binding decision -- Monitor and Generator agree on which one currently governs');
})();

console.log('');
console.log('T239 — E2E intervention lifecycle: ' + pass + ' assertions PASSED');
