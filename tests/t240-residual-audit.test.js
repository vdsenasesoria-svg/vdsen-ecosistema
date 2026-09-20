'use strict';
/**
 * T240 — Residual audit (final closure for T233-240). Full-chain review:
 * SUPERVISION SIGNAL -> COACH ACTION -> PERSISTENCE -> STALENESS -> CLIENT
 * -> GENERATOR -> NEXT DECISION. Checked explicitly against the 10 named
 * risk patterns; max 5 findings, fix only P0/P1/P2.
 *
 * FINDING #1 (P0, FIXED) — stale automated rec overriding Coach / stale
 * Generator context, at the wrapper-plumbing level (NOT the decision
 * functions themselves, which T237/T239 already proved correct in
 * isolation): _computeAdaptivePrescriptionMap (the ONE shared assembler
 * used by BOTH the real Generator request path and the Coach Monitor's own
 * display) never threaded interventions/currentPlanId/muscleId down into
 * its per-muscle _decideAdaptivePrescription calls, and
 * _computeMesocycleDecisionForRequest never received clientDoc at all --
 * so T237's Coach-KEEP override was dead code from both real production
 * entry points (Generator AND Monitor), even though the underlying
 * functions and every T237/T239 unit/E2E test (which called them directly
 * with the right inputs) passed. CASE A/C/D/L would have silently NOT
 * worked in the actual app. Fixed by threading
 * interventions/currentPlanId(/muscleId) through all 4 real call sites:
 *   1. _computeAdaptivePrescriptionMap (shared assembler)
 *   2. _computeAdaptivePrescriptionForRequest (Generator path)
 *   3. the Coach Monitor's own _computeAdaptivePrescriptionMap call
 *   4. _computeMesocycleDecisionForRequest (+ its buildGenerationRequest
 *      call site) and the Coach Monitor's own window.VDSEN_MESOCYCLE.decide call
 *
 * FINDINGS #2-5 — none found. Checked and clean (evidence: existing test
 * coverage, cited per item, was re-read against the real current source
 * during this audit, not just re-run):
 *   - Coach change invalidating too much: _isInterventionActiveForScope
 *     matches by exact targetType+targetId only (t235, t239 CASE H/I).
 *   - Same-name intervention bleed: PID/targetId-exact, never by
 *     exerciseName (t235 testScopeMatchExact, t239 CASE B/I).
 *   - Previous-client context leak: _clientIdSnap guard in
 *     _vdsenCoachIntervene, same pattern as saveTrainingPlan/coachNote
 *     (t236).
 *   - False-success save / double-submit: toast strictly after updateDoc,
 *     _savingCoachIntervention guard with finally-reset (t236).
 *   - Reviewed vs resolved confusion: _computeCoachInterventionContextForRequest
 *     buckets status==='RESOLVED' separately from anything else, and the
 *     prompt explicitly forbids treating REVIEWED as final (t238, t239
 *     CASE E).
 *   - Historical intervention treated as active: planId scoping in
 *     _isInterventionActiveForScope, CLIENT-scope exemption is intentional
 *     and narrow (t235, t239 CASE H).
 *   - Intervention surviving an incompatible new plan: same planId-scoping
 *     mechanism -- a new plan gets a new planId, so EXERCISE/MUSCLE/
 *     MESOCYCLE-scoped interventions tied to the old planId stop matching
 *     automatically; only CLIENT-scoped ones intentionally persist (a
 *     Coach's client-level pause/keep is not plan-specific by design).
 *
 * Run: node tests/t240-residual-audit.test.js
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

// ─────────────────────────────────────────────────────────────────────────────
// FINDING #1 fix, part A — the shared assembler now threads interventions/
// currentPlanId/muscleId into every per-muscle decision.
// ─────────────────────────────────────────────────────────────────────────────

const apMapSrc = extractFunction(COACH, 'function _computeAdaptivePrescriptionMap(opts)');
ok(apMapSrc && apMapSrc.includes('muscleId: muscle,') && apMapSrc.includes('interventions: opts.interventions || null,') && apMapSrc.includes('currentPlanId: opts.currentPlanId || null'),
  'FIX #1a: _computeAdaptivePrescriptionMap now threads muscleId/interventions/currentPlanId into every per-muscle _decideAdaptivePrescription call -- T237\'s override is reachable from the shared assembler');

// ─────────────────────────────────────────────────────────────────────────────
// FINDING #1 fix, part B — both REAL call sites of that assembler now
// supply real Coach intervention data instead of nothing.
// ─────────────────────────────────────────────────────────────────────────────

const forRequestSrc = extractFunction(COACH, 'function _computeAdaptivePrescriptionForRequest(planDoc, fd, clientDoc, engineState, weeklyDecision)');
ok(forRequestSrc && forRequestSrc.includes("interventions: (clientDoc && clientDoc.coachInterventions) || null,") && forRequestSrc.includes("currentPlanId: (clientDoc && clientDoc.activePlanId) || null"),
  'FIX #1b: _computeAdaptivePrescriptionForRequest (the REAL Generator path) now passes the client\'s real coachInterventions/activePlanId through');

ok(COACH.includes('const _apMap = _computeAdaptivePrescriptionMap({') &&
   /const _apMap = _computeAdaptivePrescriptionMap\(\{[\s\S]{0,700}interventions: \(_detailClientData && _detailClientData\.coachInterventions\) \|\| null,[\s\S]{0,100}currentPlanId: \(_detailClientData && _detailClientData\.activePlanId\) \|\| null/.test(COACH),
  'FIX #1c: the Coach Monitor\'s OWN adaptive-prescription display call now passes the same real intervention data -- Monitor and Generator can no longer disagree');

// ─────────────────────────────────────────────────────────────────────────────
// FINDING #1 fix, part C — the mesocycle wrapper now receives clientDoc at
// all (it did not before), both at its own signature and its 2 real call
// sites (Generator + Coach Monitor).
// ─────────────────────────────────────────────────────────────────────────────

const mesoForRequestSrc = extractFunction(COACH, 'function _computeMesocycleDecisionForRequest(logsResult, planDoc, weeklyDecision, adaptivePrescription, clientDoc)');
ok(mesoForRequestSrc, 'FIX #1d: _computeMesocycleDecisionForRequest\'s signature now accepts clientDoc at all (previously absent -- clientDoc could not reach it)');
ok(mesoForRequestSrc.includes("interventions: (clientDoc && clientDoc.coachInterventions) || null,") && mesoForRequestSrc.includes("currentPlanId: (clientDoc && clientDoc.activePlanId) || null"),
  'FIX #1d: ...and threads it into _decideMesocycleTransition\'s input');
ok(COACH.includes('var mesocycleDecision = _computeMesocycleDecisionForRequest(logsResult, planDoc, weeklyDecision, adaptivePrescription, clientDoc);'),
  'FIX #1e: buildGenerationRequest\'s call site now passes clientDoc (the REAL Generator path)');

ok(COACH.includes('const _mesoDecision = window.VDSEN_MESOCYCLE.decide({') &&
   /const _mesoDecision = window\.VDSEN_MESOCYCLE\.decide\(\{[\s\S]{0,700}interventions: \(_detailClientData && _detailClientData\.coachInterventions\) \|\| null,[\s\S]{0,100}currentPlanId: \(_detailClientData && _detailClientData\.activePlanId\) \|\| null/.test(COACH),
  'FIX #1f: the Coach Monitor\'s OWN mesocycle-decision display call now passes the same real intervention data (CASE L: Monitor and Generator agree)');

// ─────────────────────────────────────────────────────────────────────────────
// FINDING #1, functional proof (the lighter-dependency wrapper): before
// this fix, calling the wrapper exactly as buildGenerationRequest does
// (passing clientDoc separately) could never have preserved a KEEP'd PID,
// because clientDoc's interventions never reached _decideMesocycleTransition.
// Prove the FIXED wrapper now does, end to end from a raw clientDoc object
// (the same shape read from Firestore) rather than pre-shaped input.
// ─────────────────────────────────────────────────────────────────────────────

const targetEnumSrc  = COACH.slice(COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'), COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'));
const activeScopeSrc = extractFunction(COACH, 'function _isInterventionActiveForScope(intervention, targetType, targetId, currentPlanId)');
const findActiveSrc  = extractFunction(COACH, 'function _findActiveIntervention(interventions, targetType, targetId, currentPlanId)');
const evidenceSrc    = extractFunction(COACH, 'function _isEvidenceNewerThanIntervention(intervention, evidenceTimestampIso)');
const supersededSrc  = extractFunction(COACH, 'function _isRecommendationSupersededByIntervention(interventions, targetType, targetId, currentPlanId, recTimestampIso)');
const mesoSrc        = extractFunction(COACH, 'function _decideMesocycleTransition(input)');

const wrapperEng = new Function('window',
  targetEnumSrc + ';\n' + activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' + supersededSrc + ';\n' + mesoSrc + ';\n' +
  mesoForRequestSrc + ';\n' +
  'window._isRecommendationSupersededByIntervention = _isRecommendationSupersededByIntervention;\n' +
  'return _computeMesocycleDecisionForRequest;'
)({});

(function testWrapperNowHonorsRealClientDoc() {
  const clientDoc = {
    activePlanId: 'plan-A',
    coachInterventions: [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', status: 'RESOLVED', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' }]
  };
  const planDoc = { weeks: 6 };
  const logsResult = { trainingLogs: { currentWeek: 3 }, progressionHistory: { byPrescriptionExerciseId: { 'pid-1': { confidence: 'high', history: [{ action: 'maintain' }, { action: 'freeze_load' }] } } } };
  const result = wrapperEng(logsResult, planDoc, { status: 'PROGRESSING' }, { muscleDecisions: {} }, clientDoc);
  ok(result.preserveExercisePids.indexOf('pid-1') !== -1 && result.reviewExercisePids.indexOf('pid-1') === -1,
    'POST-FIX: calling the REAL wrapper exactly as buildGenerationRequest does (raw clientDoc in, nothing pre-shaped) now correctly preserves the Coach-KEEP\'d PID -- CASE A/L genuinely close end to end, not just at the raw decide-function level');
})();

console.log('');
console.log('T240 — Residual audit: ' + pass + ' assertions PASSED (1 P0 finding, fixed)');
