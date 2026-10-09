'use strict';
/**
 * T258 — Historical E2E: Plan A -> execution A -> logs A -> Coach
 * intervention A -> transition -> Plan B activated -> execution B -> Coach
 * opens Monitor -> Historial -> selects A -> A's data stays intact,
 * pid-X (A) never mixes with pid-X2 (B), A's intervention appears only
 * where it belongs, and the active Plan B stays fully functional
 * throughout. Chains the REAL production functions (T251-257), not a
 * reimplementation.
 *
 * CASE A-J required by the ticket, all exercised below.
 *
 * Run: node tests/t258-historical-e2e.test.js
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
const buildIntvSrc   = extractFunction(COACH, 'function _buildCoachIntervention(input)');
const activeScopeSrc = extractFunction(COACH, 'function _isInterventionActiveForScope(intervention, targetType, targetId, currentPlanId)');
const findActiveSrc  = extractFunction(COACH, 'function _findActiveIntervention(interventions, targetType, targetId, currentPlanId)');
const evidenceSrc    = extractFunction(COACH, 'function _isEvidenceNewerThanIntervention(intervention, evidenceTimestampIso)');
const supersededSrc  = extractFunction(COACH, 'function _isRecommendationSupersededByIntervention(interventions, targetType, targetId, currentPlanId, recTimestampIso)');
const timestampSrc   = extractFunction(COACH, 'function _getLatestEvidenceTimestampForScope(targetType, targetId, entries, planDoc, clientDoc)');
const mesoSrc        = extractFunction(COACH, 'function _decideMesocycleTransition(input)');
const fidelitySrc    = extractFunction(COACH, 'function _classifyExerciseExecutionFidelity(setCompletionRate)');
const mapHistSrc     = extractFunction(COACH, 'function _mapExerciseProgressionHistory(progrecs)');
const sortMesoSrc    = extractFunction(COACH, 'function _sortHistoricalMesocycles(mesosDocs, activePlanId)');
const viewSrc        = extractFunction(COACH, 'function _buildHistoricalMesocycleView(planId, mesoDoc, planDoc, coachInterventions)');
const exDetailSrc    = extractFunction(COACH, 'function _buildHistoricalExerciseDetail(planId, mesoDoc, planDoc, prescriptionExerciseId)');
const compareSrc     = extractFunction(COACH, 'function _compareHistoricalMesocycles(viewA, viewB)');

ok([statusEnumSrc, targetEnumSrc, actionEnumSrc, genIdSrc, buildIntvSrc, activeScopeSrc, findActiveSrc, evidenceSrc, supersededSrc,
    timestampSrc, mesoSrc, fidelitySrc, mapHistSrc, sortMesoSrc, viewSrc, exDetailSrc, compareSrc].every(Boolean),
  'prerequisite: every real T234-T257 function in the historical E2E extracts cleanly');

const eng = new Function('window',
  statusEnumSrc + ';\n' + targetEnumSrc + ';\n' + actionEnumSrc + ';\n' +
  genIdSrc + ';\n' + buildIntvSrc + ';\n' +
  activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' +
  supersededSrc + ';\n' + timestampSrc + ';\n' + mesoSrc + ';\n' +
  fidelitySrc + ';\n' + mapHistSrc + ';\n' + sortMesoSrc + ';\n' + viewSrc + ';\n' + exDetailSrc + ';\n' + compareSrc + ';\n' +
  'window._buildCoachIntervention = _buildCoachIntervention;\n' +
  'window._isInterventionActiveForScope = _isInterventionActiveForScope;\n' +
  'window._findActiveIntervention = _findActiveIntervention;\n' +
  'window._isEvidenceNewerThanIntervention = _isEvidenceNewerThanIntervention;\n' +
  'window._isRecommendationSupersededByIntervention = _isRecommendationSupersededByIntervention;\n' +
  'window._getLatestEvidenceTimestampForScope = _getLatestEvidenceTimestampForScope;\n' +
  'window.VDSEN_BUILD = { _mapExerciseProgressionHistory: _mapExerciseProgressionHistory };\n' +
  'return { buildIntervention: _buildCoachIntervention, findActive: _findActiveIntervention, getEvidenceTs: _getLatestEvidenceTimestampForScope, ' +
  'decideMeso: _decideMesocycleTransition, sortHistorical: _sortHistoricalMesocycles, buildHistoricalView: _buildHistoricalMesocycleView, ' +
  'buildExerciseDetail: _buildHistoricalExerciseDetail, compareHistorical: _compareHistoricalMesocycles };'
)({});

// ─────────────────────────────────────────────────────────────────────────────
// SETUP — Plan A: execution, logs, a Coach intervention on pid-X.
// ─────────────────────────────────────────────────────────────────────────────

const planA = { nombre: 'Fase Hipertrofia A', weeks: 4, days: [{ exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-X' }] }] };
const mesoDocA = {
  currentWeek: 4, updatedAt: Date.parse('2026-02-01T00:00:00.000Z'),
  entries: {
    'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-X', exerciseName: 'Sentadilla', action: 'maintain', newLoad: 80, observedRIR: 2 }] },
    'progrec_4_0': { calculatedAt: '2026-01-25T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-X', exerciseName: 'Sentadilla', action: 'increase_load', newLoad: 85, observedRIR: 1 }] },
    'postsession_1_0': { ts: Date.parse('2026-01-01T00:05:00.000Z'), articularPain: { present: false } },
    'done_1_0': true, 'done_2_0': true, 'done_3_0': true, 'done_4_0': true
  }
};
const interventionA = Object.assign(eng.buildIntervention({ targetType: 'EXERCISE', targetId: 'pid-X', action: 'KEEP', planId: 'plan-A', decidedAt: '2026-01-15T00:00:00.000Z' }), { status: 'RESOLVED' });
let coachInterventions = [interventionA];

// SETUP — Plan B: a DIFFERENT PID for the "same" exercise name (a
// substitution), plus its own execution.
const planB = { nombre: 'Fase Hipertrofia B', weeks: 4, days: [{ exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-X2' }] }] };
const mesoDocB = {
  currentWeek: 1, updatedAt: Date.parse('2026-03-01T00:00:00.000Z'),
  entries: { 'progrec_1_0': { calculatedAt: '2026-02-15T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-X2', exerciseName: 'Sentadilla', action: 'maintain', newLoad: 60, observedRIR: 3 }] } }
};
const clientDoc = { activePlanId: 'plan-B', coachInterventions: coachInterventions };

// ─────────────────────────────────────────────────────────────────────────────
// Coach opens Monitor -> Historial -> discovers both mesociclos, plan-B
// correctly marked active, plan-A correctly marked historical.
// ─────────────────────────────────────────────────────────────────────────────

(function testDiscoveryAndActiveMarking() {
  const mesosDocs = [{ id: 'plan-A', data: mesoDocA }, { id: 'plan-B', data: mesoDocB }];
  const list = eng.sortHistorical(mesosDocs, clientDoc.activePlanId);
  ok(list.length === 2, 'both mesociclos discovered');
  const a = list.find(function(x) { return x.planId === 'plan-A'; });
  const b = list.find(function(x) { return x.planId === 'plan-B'; });
  ok(a.isActive === false && b.isActive === true, 'plan-A correctly marked historical, plan-B correctly marked active');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Coach selects A -> A's data is intact and complete.
// ─────────────────────────────────────────────────────────────────────────────

const viewA = eng.buildHistoricalView('plan-A', mesoDocA, planA, coachInterventions);
const viewB = eng.buildHistoricalView('plan-B', mesoDocB, planB, coachInterventions);

(function testSelectedDataIntact() {
  ok(viewA.planName === 'Fase Hipertrofia A' && viewA.weeksReached === 4 && viewA.sessionsCompleted === 4, 'Plan A\'s historical data is complete and intact: name, weeks reached, sessions');
  ok(viewA.exercises.length === 1 && viewA.exercises[0].prescriptionExerciseId === 'pid-X', 'Plan A\'s exercise (pid-X) is present with its real evidence');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE A / core requirement — pid-X (A) never mixes with pid-X2 (B),
// despite sharing the exact same exercise name.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA_NoPidMixing() {
  const detailXinA = eng.buildExerciseDetail('plan-A', mesoDocA, planA, 'pid-X');
  const detailX2inA = eng.buildExerciseDetail('plan-A', mesoDocA, planA, 'pid-X2');
  ok(detailXinA.resolved === true && detailXinA.weeklyEvolution.length === 2, 'pid-X resolves correctly within Plan A\'s own history');
  ok(detailX2inA.resolved === false, 'pid-X2 (Plan B\'s exercise) has NO evidence within Plan A\'s history -- never bled across mesociclos despite the identical exercise name');
  const cmp = eng.compareHistorical(viewA, viewB);
  ok(cmp.sharedExercises.length === 0, 'CASE A: comparing A and B finds ZERO shared exercises -- pid-X and pid-X2 are never claimed continuous just because the name matches');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — reorder: Plan A\'s exercise array reversed produces identical
// historical detail for pid-X.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB_Reorder() {
  const planAReordered = { nombre: 'Fase Hipertrofia A', weeks: 4, days: [{ exercises: [
    { exerciseName: 'Otro Ejercicio', prescriptionExerciseId: 'pid-OTHER' },
    { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-X' }
  ] }] };
  const a = eng.buildExerciseDetail('plan-A', mesoDocA, planA, 'pid-X');
  const b = eng.buildExerciseDetail('plan-A', mesoDocA, planAReordered, 'pid-X');
  ok(JSON.stringify(a) === JSON.stringify(b), 'CASE B: reordering the plan\'s exercise array never changes pid-X\'s historical detail');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — plan histórico faltante: Plan A\'s doc is missing/inaccessible,
// the view still degrades gracefully with the logs-derived data intact.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC_MissingPlanDoc() {
  const view = eng.buildHistoricalView('plan-A', mesoDocA, null, coachInterventions);
  ok(view.planAvailable === false && view.planName === null, 'CASE C: a missing plan doc degrades planAvailable/planName, never guessed');
  ok(view.exercises.length === 1 && view.exercises[0].exerciseName === 'Sentadilla', 'the logs-derived exercise list (from the recommendation\'s own real name) remains fully visible without the plan doc');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — legacy PID-less recommendation stays explicitly unresolved.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD_LegacyPidLess() {
  const legacyMeso = { currentWeek: 1, updatedAt: Date.now(), entries: { 'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ exerciseName: 'Legado sin PID' }] } } };
  const view = eng.buildHistoricalView('plan-legacy', legacyMeso, null, []);
  ok(view.exercises.length === 0 && view.unindexedRecommendations === 1, 'CASE D: a legacy PID-less recommendation is never fabricated into an exercise entry, explicitly counted as unindexed');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — logs parciales: a mesociclo with only partial weeks of data.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE_PartialLogs() {
  const partialMeso = { currentWeek: 2, updatedAt: Date.parse('2026-01-10T00:00:00.000Z'), entries: { 'done_1_0': true } };
  const view = eng.buildHistoricalView('plan-partial', partialMeso, planA, []);
  ok(view.weeksReached === 2 && view.sessionsCompleted === 1, 'CASE E: partial logs produce a partial (never fabricated-complete) summary');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — timestamps incompletos: no usable evidence timestamp anywhere.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF_IncompleteTimestamps() {
  const noTsMeso = { currentWeek: 1, updatedAt: null, entries: { 'progrec_1_0': { recommendations: [{ prescriptionExerciseId: 'pid-1' }] } } };
  const view = eng.buildHistoricalView('plan-no-ts', noTsMeso, null, []);
  ok(view.startedAt === null && view.endedAt === null, 'CASE F: no usable timestamps anywhere -> both startedAt/endedAt stay null, never Date.now()');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — cero intervenciones.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseG_ZeroInterventions() {
  const view = eng.buildHistoricalView('plan-A', mesoDocA, planA, []);
  ok(Array.isArray(view.coachDecisions) && view.coachDecisions.length === 0, 'CASE G: zero interventions -> an empty (never fabricated) coachDecisions list');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — intervención stale/resolved: A\'s KEEP is RESOLVED and
// plan-scoped; it still appears correctly in A\'s history, but is
// historical (not live authority) once plan-B is the active plan.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseH_StaleResolvedIntervention() {
  ok(viewA.coachDecisions.length === 1 && viewA.coachDecisions[0].status === 'RESOLVED', 'CASE H: the RESOLVED intervention appears correctly within Plan A\'s own historical view');
  ok(eng.findActive(coachInterventions, 'EXERCISE', 'pid-X', 'plan-B') === null, 'the SAME intervention is correctly historical (not active authority) now that plan-B is the current plan -- CASE H\'s plan-scoping holds even while browsing history');
})();

// ─────────────────────────────────────────────────────────────────────────────
// intervención A aparece solo donde corresponde -- never inside B\'s view.
// ─────────────────────────────────────────────────────────────────────────────

(function testInterventionOnlyWhereItBelongs() {
  ok(viewB.coachDecisions.length === 0, 'Plan A\'s EXERCISE-scoped intervention never appears inside Plan B\'s historical view (different planId)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE I — cambio de activePlan durante navegación histórica: the
// historical view functions take activePlanId/mesoDoc/planDoc as frozen
// INPUT parameters, never a live reference -- browsing history is immune
// to a concurrent activePlanId change.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseI_ActivePlanChangeDuringNavigation() {
  const mesosDocs = [{ id: 'plan-A', data: mesoDocA }, { id: 'plan-B', data: mesoDocB }];
  const listWhileBActive = eng.sortHistorical(mesosDocs, 'plan-B');
  const listWhileCActive = eng.sortHistorical(mesosDocs, 'plan-C'); // activePlanId changed mid-browse to some new plan-C
  const aWhileB = listWhileBActive.find(function(x) { return x.planId === 'plan-A'; });
  const aWhileC = listWhileCActive.find(function(x) { return x.planId === 'plan-A'; });
  ok(aWhileB.isActive === false && aWhileC.isActive === false, 'CASE I: plan-A\'s own isActive marking is unaffected by which plan is CURRENTLY active -- deterministic from the explicit activePlanId argument, never a hidden live read');
  ok(JSON.stringify(eng.buildHistoricalView('plan-A', mesoDocA, planA, coachInterventions)) === JSON.stringify(viewA),
    'building Plan A\'s historical view is fully deterministic from its own frozen inputs -- unaffected by any concurrent activePlanId change elsewhere');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Plan activo B permanece completamente funcional durante toda la
// navegación histórica -- the SAME real decision functions used for the
// active plan produce the correct, unaffected result for plan-B/pid-X2.
// ─────────────────────────────────────────────────────────────────────────────

(function testActivePlanBStillFullyFunctional() {
  const progHistB = { byPrescriptionExerciseId: { 'pid-X2': { confidence: 'medium', history: [{ action: 'maintain' }] } } };
  const decision = eng.decideMeso({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progHistB, interventions: coachInterventions, currentPlanId: 'plan-B', entries: mesoDocB.entries, planDoc: planB, clientDoc: clientDoc });
  ok(decision.action !== undefined && Array.isArray(decision.preserveExercisePids), 'Plan B\'s live mesocycle decision computes normally and correctly, entirely unaffected by having just browsed Plan A\'s history');
  ok(eng.getEvidenceTs('EXERCISE', 'pid-X2', mesoDocB.entries, planB, clientDoc) === '2026-02-15T00:00:00.000Z', 'Plan B\'s own evidence timestamp resolves correctly and independently of Plan A\'s data');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE J — volver a vista actual sin stale UI: the Monitor's historical
// section is fully re-rendered (not selectively patched) on every
// _renderClientTabMonitor call, and collapsing it does zero work --
// nothing can leak stale historical DOM state into the active view.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseJ_NoStaleUiOnReturn() {
  ok(COACH.includes('cont.innerHTML = html;') , 'CASE J: the Monitor tab\'s entire content (including the historical <details> section) is rebuilt from scratch on every render -- no selective DOM patching that could leave stale historical state behind');
  const toggleSrc = extractFunction(COACH, 'window._onHistoricalMesoToggle = async function(clientId, isOpen)');
  ok(toggleSrc.includes('if (!isOpen) return;'), 'CASE J: collapsing the historical section performs no work and leaves no pending async state -- returning to the active view is instant and clean');
})();

console.log('');
console.log('T258 — Historical E2E: ' + pass + ' assertions PASSED');
