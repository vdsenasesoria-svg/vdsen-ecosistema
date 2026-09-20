'use strict';
/**
 * T290 — Evidence quality E2E (CASE A-P) + residual audit. Chains the REAL
 * production functions end to end: the whole _mapLogs..
 * _buildClientDecisionSnapshot/buildGenerationRequest closure (T276-289),
 * the real T284 evidence classifier + T285 gates, the real T220-221
 * outcome module, the real T268-270 nutrition module, and the real T226/
 * 227 priority functions.
 *
 * EXPLICIT BUG SEARCH (per the ticket's list) -- results:
 *   - old week data treated as current: NOT FOUND -- ci_sem_{W} is keyed
 *     by week number (scope-exact by construction, T283); the ONE real
 *     divergence found (engine_state.weekNum vs logsDoc.currentWeek) is
 *     now surfaced as STALE via _classifyWeeklyCheckinQuality (T285),
 *     never silently treated as current.
 *   - updatedAt from one entity validating another: NOT FOUND -- isLive
 *     compares planId to activePlanId only (T277); provenance timestamps
 *     are each read from their OWN entity (clientUpdatedAt from clientDoc,
 *     planUpdatedAt from planDoc), never cross-validated.
 *   - fallback values masquerading as measured data: NOT FOUND -- every
 *     T284/285 gate returns UNRESOLVED on a missing value rather than a
 *     fabricated default (CASE I below).
 *   - missing field interpreted as normal/zero: NOT FOUND -- T284's
 *     explicit 0/false-is-not-missing test (T284) plus every gate's
 *     null/undefined check specifically.
 *   - legacy PID-less evidence receiving current authority: NOT FOUND --
 *     structurally excluded from byPrescriptionExerciseId (T283/285).
 *   - stale intervention surviving plan replacement: NOT FOUND --
 *     _isInterventionActiveForScope already filters by plan/scope (T235).
 *   - body-composition comparison without measurement compatibility: NOT
 *     FOUND -- T220's own method-mixing degrade-to-low-confidence and
 *     implausible-swing MEASUREMENT_CONFLICT gate.
 *   - nutrition adherence using logs outside current window: NOT FOUND --
 *     T268's own 7-day window filter.
 *   - currentWeek inferred differently across consumers: the ONE
 *     divergence found (T283 FINDING 2) does not cause Generator/Monitor
 *     to disagree (both call the identical function with identical
 *     entries, T281 CASE A/K) -- now also surfaced as an explicit STALE
 *     signal via evidenceQuality.recovery.
 *   - truthy checks hiding explicit zero/false: NOT FOUND -- T284's own
 *     test suite covers this directly.
 *   - Date/string/Timestamp inconsistencies: NOT FOUND within this
 *     ticket's scope -- all timestamps handled here are ISO strings via
 *     Date.parse, consistent with the pre-existing T242 pattern reused
 *     verbatim.
 *
 * Run: node tests/t290-evidence-quality-e2e-residual-audit.test.js
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
function extractLiteral(src, decl) {
  const raw = extractFunction(src, decl);
  if (!raw) return null;
  return raw.slice(raw.indexOf('= ') + 2);
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ── The whole buildGenerationRequest/_buildClientDecisionSnapshot closure ──
const scriptOpenIdx  = COACH.lastIndexOf('\n<script>\n', COACH.indexOf('  function _mapLogs(logsDoc) {'));
const scriptCloseIdx = COACH.indexOf('\n</script>', COACH.indexOf('  function buildGenerationRequest(params) {'));
const outerBlock = COACH.slice(scriptOpenIdx + '\n<script>\n'.length, scriptCloseIdx);
ok(outerBlock.includes('evidenceQuality:                evidenceQuality,') || outerBlock.includes('evidenceQuality:           evidenceQuality,'),
  'prerequisite: the real closure carries evidenceQuality in the snapshot return');

// ── Real T220-221 outcome module ────────────────────────────────────────────
const evidenceSrc    = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const outcomeConfSrc = extractFunction(COACH, 'function _computeOutcomeConfidence(measurements, options)');
const perfRespSrc    = extractFunction(COACH, 'function _classifyPerformanceResponse(planDoc, progressionHistory)');
const bodyCompSrc    = extractFunction(COACH, 'function _classifyBodyCompositionResponse(inbodyResults, objetivoCalorico)');
const confRankSrc    = 'var _CONF_RANK = ' + extractLiteral(COACH, 'var _CONF_RANK = {') + ';';
const synthesisSrc   = extractFunction(COACH, 'function _computePrescriptionEffectivenessSynthesis(input)');

// ── Real T284 evidence-quality classifier ───────────────────────────────────
const eqEnumSrc   = 'var EVIDENCE_QUALITY = ' + extractLiteral(COACH, 'var EVIDENCE_QUALITY = {') + ';';
const classifyEqSrc = extractFunction(COACH, 'function _classifyEvidenceQuality(input)');

// ── Real T177 weekly-status classifier ──────────────────────────────────────
const weeklyStatusEnumSrc = 'var WEEKLY_STATUS = ' + extractLiteral(COACH, 'var WEEKLY_STATUS = {') + ';';
const classifyWeeklySrc   = extractFunction(COACH, 'function _classifyWeeklyStatus(input)');
const decideVolumeSrc     = extractFunction(COACH, 'function _decideVolumeAction(status, ciSem)');

// ── Real T202 session-adherence summary ─────────────────────────────────────
const sessionStateSrc = extractFunction(COACH, 'function _getSessionCompletionState(doneEntry)');
const sessionRatioSrc = extractFunction(COACH, 'function _sessionExecutionRatio(doneEntry, progrecEntry)');
const classifySessSrc = extractFunction(COACH, 'function _classifySessionAdherence(doneEntry, progrecEntry)');
const sessionSummarySrc = extractFunction(COACH, 'function _computeSessionAdherenceSummary(entries, week)');

// ── Real T226/227 priority/reason-action ────────────────────────────────────
const attnSrc = extractFunction(COACH, 'function _computeClientAttentionState(entries, planData, currentWeek)');
const priorityEnumSrc = 'var CLIENT_PRIORITY = ' + extractLiteral(COACH, 'var CLIENT_PRIORITY = {') + ';';
const rankSrc = extractFunction(COACH, 'function _rankClientPriority(attnState, weeklyStatus, effectivenessOverall)');
const actionEnum229Src = 'var INTERVENTION_ACTION = ' + extractLiteral(COACH, 'var INTERVENTION_ACTION = {') + ';';
const reasonActionSrc = extractFunction(COACH, 'function _computeInterventionReasonAction(priority, input)');

// ── Real T268-270 nutrition module ──────────────────────────────────────────
const nutrAdherenceSrc = extractFunction(COACH, 'function _classifyNutritionAdherence(nutrilogEntries, targets, options)');
const nutrResponseSrc  = extractFunction(COACH, 'function _classifyNutritionResponse(inbodyResults, objetivoCalorico)');
const nutrActionEnumSrc = 'var NUTRITION_ACTION = ' + extractLiteral(COACH, 'var NUTRITION_ACTION = {') + ';';
const nutrDecideSrc = extractFunction(COACH, 'function _decideNutritionAction(input)');

const evidenceTsSrc = extractFunction(COACH, 'function _getLatestEvidenceTimestampForScope(targetType, targetId, entries, planDoc, clientDoc)');
const targetTypeSrc = 'var INTERVENTION_TARGET_TYPE = ' + extractLiteral(COACH, 'var INTERVENTION_TARGET_TYPE = {') + ';';

[evidenceSrc, outcomeConfSrc, perfRespSrc, bodyCompSrc, synthesisSrc, classifyEqSrc, classifyWeeklySrc, decideVolumeSrc,
  sessionStateSrc, sessionRatioSrc, classifySessSrc, sessionSummarySrc, attnSrc, rankSrc, reasonActionSrc,
  nutrAdherenceSrc, nutrResponseSrc, nutrDecideSrc, evidenceTsSrc].forEach(function(s) {
  ok(!!s, 'prerequisite: all real dependent functions extract cleanly');
});

function buildWindowStub() {
  const w = {};

  w.VDSEN_EVIDENCE = new Function(eqEnumSrc + ';\n' + classifyEqSrc + ';\nreturn { classify: _classifyEvidenceQuality, STATUS: EVIDENCE_QUALITY };')();

  w.VDSEN_OUTCOME = new Function(
    evidenceSrc + ';\n' + outcomeConfSrc + ';\n' + perfRespSrc + ';\n' + bodyCompSrc + ';\n' + confRankSrc + ';\n' + synthesisSrc + ';\n' +
    'return { computeConfidence: _computeOutcomeConfidence, computePerformanceResponse: _classifyPerformanceResponse, computeBodyCompositionResponse: _classifyBodyCompositionResponse, computeEffectiveness: _computePrescriptionEffectivenessSynthesis };'
  )();

  w.VDSEN_WEEKLY = new Function(
    weeklyStatusEnumSrc + ';\n' + classifyWeeklySrc + ';\n' + decideVolumeSrc + ';\n' +
    'return { classify: _classifyWeeklyStatus, decideVolume: _decideVolumeAction, STATUS: WEEKLY_STATUS };'
  )();

  w.VDSEN_ADHERENCE = new Function(
    sessionStateSrc + ';\n' + sessionRatioSrc + ';\n' + classifySessSrc + ';\n' + sessionSummarySrc + ';\n' +
    'return { computeSessionSummary: _computeSessionAdherenceSummary };'
  )();

  w.VDSEN_NUTRITION = new Function(
    evidenceSrc + ';\n' + outcomeConfSrc + ';\n' + bodyCompSrc + ';\n' + nutrAdherenceSrc + ';\n' + nutrResponseSrc + ';\n' +
    nutrActionEnumSrc + ';\n' + nutrDecideSrc + ';\n' +
    'return { classifyAdherence: _classifyNutritionAdherence, classifyResponse: _classifyNutritionResponse, decide: _decideNutritionAction };'
  )();

  w.VDSEN_ADAPTIVE = { computeMap: function(input) { return { muscleDecisions: {}, _echoKeys: Object.keys(input).sort().join(',') }; } };
  w.VDSEN_LEARNED = {
    computeVolumeTolerance: function() { return {}; },
    computeExerciseTolerance: function() { return {}; },
    computePatternTolerance: function() { return {}; },
    computeRecoverySensitivity: function() { return { pattern: 'STABLE_AT_CURRENT_STRESS', confidence: 'medium' }; }
  };

  w._computeClientAttentionState = new Function('return ' + attnSrc)();
  w._rankClientPriority = new Function(priorityEnumSrc + ';\nreturn ' + rankSrc + ';')();
  w._computeInterventionReasonAction = new Function(priorityEnumSrc + ';\n' + actionEnum229Src + ';\nreturn ' + reasonActionSrc + ';')();
  w._getLatestEvidenceTimestampForScope = new Function(targetTypeSrc + ';\nreturn ' + evidenceTsSrc + ';')();

  new Function('window', outerBlock)(w);
  return w;
}

function buildSnapshot(w, opts) { return w.VDSEN_SNAPSHOT.build(opts); }
function buildRequest(w, opts) { return w.VDSEN_BUILD.buildGenerationRequest(opts).rawRequest; }

const NOW = Date.now();
function inb(weeksAgo, peso, extra) { return Object.assign({ ts: NOW - weeksAgo * 7 * 86400000, peso: peso }, extra || {}); }
const BASELINE_PLAN = { days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Sentadilla' }] }], weeks: 6 };

async function main() {
  // ── CASE A — current plan, current PID, fresh execution -> VALID -> normal decisions. ──
  {
    const w = buildWindowStub();
    const entries = {
      engine_state: { weekNum: 1 },
      'ci_sem_1': { peso: 80 },
      'postsession_1_0': { ts: NOW },
      'progrec_1_0': { calculatedAt: new Date(NOW).toISOString(), recommendations: [{ prescriptionExerciseId: 'pid-1', action: 'increase_load', setMetrics: { setCompletionRate: 1 } }] },
      'done_1_0': true
    };
    [0, 1, 2, 3, 4].forEach(function(i) { entries['nutrilog_d' + i] = { kcal: 2200, prot: 185, ts: NOW - i * 86400000 }; });
    const clientDoc = { activePlanId: 'plan-A', nutritionRaw: { calorias: 2200, proteina: 180 } };
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: entries, currentWeek: 1 }, fd: {} });
    ok(s.evidenceQuality.recovery.status === 'VALID', 'CASE A: current week check-in + matching engine week -> recovery VALID');
    ok(s.evidenceQuality.nutrition.status === 'HIGH' || s.evidenceQuality.nutrition.status === 'VALID', 'CASE A: 5 days of tight nutrilog -> nutrition evidence VALID');
    ok(s.identity.isLive === true, 'CASE A: current plan is live');
  }

  // ── CASE B — progrec predates Coach edit -> STALE -> no automatic application. ──
  {
    const w = buildWindowStub();
    const entries = {
      engine_state: { weekNum: 1 },
      'progrec_1_0': { calculatedAt: '2024-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', action: 'increase_load', exerciseName: 'Sentadilla' }] }
    };
    const planEditedLater = Object.assign({}, BASELINE_PLAN, { updatedAt: '2024-06-01T00:00:00.000Z' });
    const req = buildRequest(w, { clientId: 'c1', coachId: 'coach-1', clientDoc: { activePlanId: 'plan-A' }, planDoc: planEditedLater, logsDoc: { entries: entries, currentWeek: 1 }, fichaDoc: null });
    ok(req.weeklyDecision.status === 'COACH_REVIEW', 'CASE B: a progrec predating the Coach\'s plan edit routes to COACH_REVIEW, never automatically applied as current');
  }

  // ── CASE C — check-in from previous week -> STALE for current weekly decision. ──
  {
    const w = buildWindowStub();
    const entries = { engine_state: { weekNum: 3 }, 'ci_sem_4': { peso: 80 } }; // week 4 is canonical, but engine lags at week 3
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: { activePlanId: 'plan-A' }, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: entries, currentWeek: 4 }, fd: {} });
    ok(s.evidenceQuality.recovery.status === 'STALE', 'CASE C: a real check-in exists for week 4, but the engine\'s own last-computed week (3) lags it -> STALE');
  }

  // ── CASE D — body composition has two method-incompatible observations
  // -> CONFLICTING -> no confident nutrition adjustment. ──
  {
    const w = buildWindowStub();
    const clientDoc = { activePlanId: 'plan-A', nutritionRaw: { calorias: 2200 }, inbodyResults: [inb(1, 80), inb(0, 90)] }; // implausible swing
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: {}, currentWeek: 1 }, fd: { objetivo_calorico: 'déficit' } });
    ok(s.evidenceQuality.bodyComposition.status === 'CONFLICTING', 'CASE D: an implausible/method-incompatible weight swing -> bodyComposition CONFLICTING');
    ok(s.nutritionDecision.response.classification === 'MEASUREMENT_CONFLICT' && s.nutritionDecision.action === 'FREEZE',
      'CASE D: the nutrition decision itself never produces a confident adjustment from conflicting body composition -> FREEZE');
  }

  // ── CASE E — one nutrilog day in a 7-day decision window -> PARTIAL ->
  // no calorie adjustment. ──
  {
    const w = buildWindowStub();
    const entries = { 'nutrilog_only': { kcal: 2200, prot: 185, ts: NOW } };
    const clientDoc = { activePlanId: 'plan-A', nutritionRaw: { calorias: 2200, proteina: 180 } };
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: entries, currentWeek: 1 }, fd: {} });
    ok(s.evidenceQuality.nutrition.status === 'PARTIAL', 'CASE E: a single logged day -> nutrition evidence PARTIAL');
    ok(s.nutritionDecision.action === 'FREEZE', 'CASE E: PARTIAL nutrition evidence never produces a calorie adjustment -> FREEZE');
  }

  // ── CASE F — legacy PID-less progression + valid current PID data ->
  // legacy cannot override. ──
  {
    const w = buildWindowStub();
    const entries = {
      engine_state: { weekNum: 1 },
      'progrec_1_0': { calculatedAt: new Date(NOW).toISOString(), recommendations: [
        { prescriptionExerciseId: 'pid-1', action: 'increase_load', setMetrics: { setCompletionRate: 1 } },
        { action: 'increase_load' } // legacy, no PID
      ]}
    };
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: { activePlanId: 'plan-A' }, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: entries, currentWeek: 1 }, fd: {} });
    ok(s.evidenceQuality.progression.status === 'LEGACY', 'CASE F: legacy PID-less evidence mixed in -> flagged LEGACY, surfaced rather than silently dropped');
    ok(Object.keys(s.progression.byPrescriptionExerciseId).length === 1 && s.progression.byPrescriptionExerciseId['pid-1'],
      'CASE F: the legacy recommendation never enters byPrescriptionExerciseId -- the valid PID-exact evidence is untouched by it');
  }

  // ── CASE G — historical mesocycle intervention, activePlanId changed ->
  // historical/stale for live state. ──
  {
    const w = buildWindowStub();
    const clientDoc = { activePlanId: 'plan-NEW' }; // client has moved on
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, planId: 'plan-OLD', logsDoc: { entries: {}, currentWeek: 1 }, fd: {} });
    ok(s.identity.isLive === false, 'CASE G: a historical plan (planId != current activePlanId) is explicitly isLive:false');
  }

  // ── CASE H — new valid pain evidence after an older Coach KEEP -> safety wins. ──
  {
    const w = buildWindowStub();
    const entries = { engine_state: { weekNum: 1 }, 'postsession_1_0': { articularPain: { present: true } } };
    const clientDoc = { activePlanId: 'plan-A', coachInterventions: [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', status: 'ACTIVE', decidedAt: '2024-01-01T00:00:00.000Z', planId: 'plan-A' }] };
    const req = buildRequest(w, { clientId: 'c1', coachId: 'coach-1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, logsDoc: { entries: entries, currentWeek: 1 }, fichaDoc: null });
    ok(req.weeklyDecision.status === 'PAIN_REVIEW', 'CASE H: a new real pain signal -> PAIN_REVIEW, safety wins regardless of an older Coach KEEP');
  }

  // ── CASE I — missing recovery values -> UNRESOLVED, not "recovery good". ──
  {
    const w = buildWindowStub();
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: { activePlanId: 'plan-A' }, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: {}, currentWeek: 1 }, fd: {} });
    ok(s.evidenceQuality.recovery.status === 'UNRESOLVED', 'CASE I: no check-in at all -> UNRESOLVED, never a default "good" recovery read');
  }

  // ── CASE J — valid progression + stale body composition -> training
  // decision remains valid, body-composition conclusion withheld. ──
  {
    const w = buildWindowStub();
    const entries = {
      engine_state: { weekNum: 1 },
      'progrec_1_0': { calculatedAt: new Date(NOW).toISOString(), recommendations: [{ prescriptionExerciseId: 'pid-1', action: 'increase_load', setMetrics: { setCompletionRate: 1 } }] }
    };
    const clientDoc = { activePlanId: 'plan-A', inbodyResults: [inb(1, 80), inb(0, 90)] }; // conflicting
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: entries, currentWeek: 1 }, fd: { objetivo_calorico: 'déficit' } });
    ok(s.evidenceQuality.progression.status === 'VALID', 'CASE J: valid PID-exact progression evidence stays VALID');
    ok(s.evidenceQuality.bodyComposition.status === 'CONFLICTING', 'CASE J: the body-composition conclusion is separately withheld (CONFLICTING) -- one domain\'s quality never contaminates another\'s');
  }

  // ── CASE K — all sources valid -> no evidence-warning UI. ──
  {
    const w = buildWindowStub();
    const entries = {
      engine_state: { weekNum: 1 }, 'ci_sem_1': { peso: 80 },
      'progrec_1_0': { calculatedAt: new Date(NOW).toISOString(), recommendations: [{ prescriptionExerciseId: 'pid-1', action: 'increase_load', setMetrics: { setCompletionRate: 1 } }] },
      'done_1_0': true
    };
    [0, 1, 2, 3, 4].forEach(function(i) { entries['nutrilog_d' + i] = { kcal: 2200, prot: 185, ts: NOW - i * 86400000 }; });
    const clientDoc = { activePlanId: 'plan-A', nutritionRaw: { calorias: 2200, proteina: 180 }, inbodyResults: [inb(6, 80), inb(3, 78.5), inb(0, 77)] };
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: entries, currentWeek: 1 }, fd: { objetivo_calorico: 'déficit' } });
    ok(s.evidenceQuality.overall === 'VALID', 'CASE K: with real, consistent check-in/progression/nutrition/body-composition evidence and no Coach intervention (VALID by construction when absent) -> overall VALID');
  }

  // ── CASE L — Generator and Monitor receive same evidenceQuality. ──
  {
    const w = buildWindowStub();
    const clientDoc = { activePlanId: 'plan-A' };
    const logsDoc = { entries: { engine_state: { weekNum: 1 } }, currentWeek: 1 };
    const req = buildRequest(w, { clientId: 'c1', coachId: 'coach-1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, logsDoc: logsDoc, fichaDoc: null });
    const snap = buildSnapshot(w, { clientId: 'c1', clientDoc: clientDoc, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: logsDoc, fd: {} });
    ok(JSON.stringify(req.evidenceQuality) === JSON.stringify(snap.evidenceQuality), 'CASE L: Generator and Monitor evidenceQuality are byte-equivalent given the same evidence');
  }

  // ── CASE M — client switch -> no quality-state leakage. ──
  {
    const w = buildWindowStub();
    const s1 = buildSnapshot(w, { clientId: 'client-1', clientDoc: { activePlanId: 'p1', inbodyResults: [inb(1, 80), inb(0, 90)] }, planDoc: BASELINE_PLAN, planId: 'p1', logsDoc: { entries: {}, currentWeek: 1 }, fd: { objetivo_calorico: 'déficit' } });
    const s2 = buildSnapshot(w, { clientId: 'client-2', clientDoc: { activePlanId: 'p2' }, planDoc: BASELINE_PLAN, planId: 'p2', logsDoc: { entries: {}, currentWeek: 1 }, fd: {} });
    ok(s1.evidenceQuality.bodyComposition.status === 'CONFLICTING' && s2.evidenceQuality.bodyComposition.status === 'UNRESOLVED',
      'CASE M: client-1\'s CONFLICTING body-composition state never leaks into client-2\'s independently-built snapshot');
  }

  // ── CASE N — activePlanId changes -> old quality snapshot not reused. ──
  {
    const w = buildWindowStub();
    const clientBefore = { activePlanId: 'plan-A' };
    const before = buildSnapshot(w, { clientId: 'c1', clientDoc: clientBefore, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: {}, currentWeek: 1 }, fd: {} });
    const beforeJson = JSON.stringify(before);
    const clientAfter = { activePlanId: 'plan-B', inbodyResults: [inb(1, 80), inb(0, 90)] };
    const after = buildSnapshot(w, { clientId: 'c1', clientDoc: clientAfter, planDoc: BASELINE_PLAN, planId: 'plan-B', logsDoc: { entries: {}, currentWeek: 1 }, fd: { objetivo_calorico: 'déficit' } });
    ok(after.evidenceQuality.bodyComposition.status === 'CONFLICTING' && after.identity.planId === 'plan-B',
      'CASE N: a new snapshot after activePlanId changes reflects the NEW evidence fully');
    ok(JSON.stringify(before) === beforeJson, 'CASE N: the OLD snapshot (pre-change) remains exactly as built -- never mutated/reused');
  }

  // ── CASE O — historical view remains historical, never upgrades to live
  // VALID. ──
  {
    const w = buildWindowStub();
    const clientDoc = { activePlanId: 'plan-CURRENT' };
    const s = buildSnapshot(w, { clientId: 'c1', clientDoc: clientDoc, planDoc: { days: [], status: 'completed' }, planId: 'plan-HISTORICAL', logsDoc: { entries: {}, currentWeek: 6 }, fd: {} });
    ok(s.identity.isLive === false, 'CASE O: a historical plan snapshot is explicitly isLive:false');
    ok(s.identity.activePlanId === 'plan-CURRENT', 'CASE O: the client\'s real current plan is still correctly named, distinct from the historical one being viewed -- the historical view never upgrades its own evidence to "live"');
  }

  // ── CASE P — same raw evidence, same scope -> deterministic byte-
  // equivalent evidenceQuality. ──
  {
    const w = buildWindowStub();
    const params = { clientId: 'c1', clientDoc: { activePlanId: 'plan-A', inbodyResults: [inb(1, 80), inb(0, 78)] }, planDoc: BASELINE_PLAN, planId: 'plan-A', logsDoc: { entries: {}, currentWeek: 1 }, fd: { objetivo_calorico: 'déficit' } };
    const s1 = buildSnapshot(w, Object.assign({}, params));
    const s2 = buildSnapshot(w, Object.assign({}, params));
    ok(JSON.stringify(s1.evidenceQuality) === JSON.stringify(s2.evidenceQuality), 'CASE P: the exact same evidence -> byte-equivalent evidenceQuality across two separate calls');
  }

  console.log('');
  console.log('T290 — Evidence quality E2E (CASE A-P) + residual audit: ' + pass + ' assertions PASSED');
}

main().catch(function(e) { console.error(e); process.exit(1); });
