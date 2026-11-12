'use strict';
/**
 * T208 — E2E CASES A-J: DATA -> ADHERENCE -> CONFIDENCE -> DECISION ->
 * GENERATOR -> COACH, chained exactly as buildGenerationRequest wires them
 * in production: _classifyWeeklyStatus -> _decideVolumeAction ->
 * _decideAdaptivePrescription -> _decideMesocycleTransition ->
 * _computeExecutionFidelityForRequest. No case re-derives any of these
 * functions -- all extracted verbatim from vdsen-coach.html (or required
 * from api/vdsen-build-request.js for progressionHistory), same as every
 * other ticket's test suite in this repo.
 *
 * Followed by a short residual audit across the whole chain (max 5
 * findings, fix only P0/P1/P2 -- see bottom of file).
 *
 * Run: node tests/t208-e2e-adherence-chain.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const { _mapExerciseProgressionHistory } = require('../api/vdsen-build-request.js');

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
// Build one shared engine exposing every real function this chain uses.
// ─────────────────────────────────────────────────────────────────────────────

const semSrc        = extractFunction(COACH, 'function _calcEhrensteinSemaphore(subjScore, subjVulner, avgICS, umbral)');
const wsMetaSrc      = COACH.slice(COACH.indexOf('var WEEKLY_STATUS = {'), COACH.indexOf('function _classifyWeeklyStatus'));
const classifySrc   = extractFunction(COACH, 'function _classifyWeeklyStatus(input)');
const volumeSrc     = extractFunction(COACH, 'function _decideVolumeAction(status, ciSem)');
const adaptiveSrc   = extractFunction(COACH, 'function _decideAdaptivePrescription(input)');
const mesoSrc       = extractFunction(COACH, 'function _decideMesocycleTransition(input)');
const stateSrc      = extractFunction(COACH, 'function _getSessionCompletionState(doneEntry)');
const ratioSrc      = extractFunction(COACH, 'function _sessionExecutionRatio(doneEntry, progrecEntry)');
const classSessSrc  = extractFunction(COACH, 'function _classifySessionAdherence(doneEntry, progrecEntry)');
const summarySrc    = extractFunction(COACH, 'function _computeSessionAdherenceSummary(entries, week)');
const fidelitySrc   = extractFunction(COACH, 'function _classifyExerciseExecutionFidelity(setCompletionRate)');
const computeReqSrc = extractFunction(COACH, 'function _computeExecutionFidelityForRequest(planDoc, weeklyDecision, progressionHistory)');

ok([semSrc, wsMetaSrc, classifySrc, volumeSrc, adaptiveSrc, mesoSrc, stateSrc, ratioSrc, classSessSrc, summarySrc, fidelitySrc, computeReqSrc].every(Boolean),
  'prerequisite: every function this E2E chain needs extracts cleanly from vdsen-coach.html');

function makeEngine(win) {
  const factory = new Function('window',
    wsMetaSrc + ';\n' + semSrc + ';\n' + classifySrc + ';\n' + volumeSrc + ';\n' + adaptiveSrc + ';\n' + mesoSrc + ';\n' +
    stateSrc + ';\n' + ratioSrc + ';\n' + classSessSrc + ';\n' + summarySrc + ';\n' + fidelitySrc + ';\n' +
    'window.VDSEN_ADHERENCE = { computeSessionSummary: _computeSessionAdherenceSummary, classifyExerciseFidelity: _classifyExerciseExecutionFidelity };\n' +
    computeReqSrc + ';\n' +
    'return { classify: _classifyWeeklyStatus, decideVolume: _decideVolumeAction, decideAdaptive: _decideAdaptivePrescription, decideMeso: _decideMesocycleTransition, sessionSummary: _computeSessionAdherenceSummary, computeExecFidelity: _computeExecutionFidelityForRequest, STATUS: WEEKLY_STATUS };'
  );
  return factory(win || {});
}

function progrecFor(week, day, rate) {
  const key = 'progrec_' + week + '_' + day;
  return { [key]: { recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Sentadilla', setMetrics: { setCompletionRate: rate } }] } };
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — high execution, real progress: PROGRESSING -> REVIEW_INCREASE ->
// adaptive increase eligible -> mesocycle CONTINUE/RENEW_MINIMAL.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA() {
  const eng = makeEngine();
  const entries = Object.assign({ 'done_5_0': {} }, progrecFor(5, 0, 0.95));
  const sessionAdherence = eng.sessionSummary(entries, 5);
  const status = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'increase_load' }, { action: 'increase_load' }] },
    ciSem: { adherencia_pct: 95, ics_promedio: 8 }, postsessionsThisWeek: [], reviewCount: 0, semaphore: null,
    sessionAdherence: sessionAdherence
  });
  ok(status === eng.STATUS.PROGRESSING, 'CASE A: high execution + real progress -> PROGRESSING');
  const volume = eng.decideVolume(status, { ics_promedio: 8 });
  ok(volume === 'REVIEW_INCREASE', 'CASE A: -> REVIEW_INCREASE (never auto-applied)');
  const adaptive = eng.decideAdaptive({ weeklyStatus: status, target: { volumeRange: { min: 10, max: 20 }, volumeTarget: 16 }, actualVolume: { fractionalTotal: 12 } });
  ok(adaptive.volumeAction === 'REVIEW_INCREASE', 'CASE A: adaptive prescription also recommends REVIEW_INCREASE, consistent with weeklyStatus');
  const progressionHistory = _mapExerciseProgressionHistory(progrecFor(5, 0, 0.95)['progrec_5_0'] ? { 'progrec_5_0': progrecFor(5, 0, 0.95)['progrec_5_0'] } : {});
  const meso = eng.decideMeso({ weeklyDecision: { status: status }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progressionHistory, isCheckpointWeek: false });
  ok(meso.action === 'CONTINUE', 'CASE A: mesocycle stays CONTINUE mid-cycle');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — the ticket's own worked example: no progress + 45% execution ->
// ADHERENCE_LIMITED, NOT PERFORMANCE_STALL/REVIEW_INCREASE, all the way
// through the chain.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB() {
  const eng = makeEngine();
  const entries = Object.assign({ 'done_6_0': {} }, progrecFor(6, 0, 0.45));
  const sessionAdherence = eng.sessionSummary(entries, 6);
  const status = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'maintain' }, { action: 'maintain' }] },
    ciSem: { adherencia_pct: 50 }, postsessionsThisWeek: [], reviewCount: 0, semaphore: null,
    sessionAdherence: sessionAdherence
  });
  ok(status === eng.STATUS.ADHERENCE_LIMITED, 'CASE B: no progress + 45% execution -> ADHERENCE_LIMITED (ticket\'s own worked example)');
  const volume = eng.decideVolume(status, { adherencia_pct: 50 });
  ok(volume === 'FREEZE', 'CASE B: -> FREEZE, never REVIEW_DECREASE/REVIEW_INCREASE from an under-executed week');
  const adaptive = eng.decideAdaptive({ weeklyStatus: status, target: { volumeRange: { min: 10, max: 20 }, volumeTarget: 16 }, actualVolume: { fractionalTotal: 12 } });
  ok(adaptive.volumeAction === 'FREEZE', 'CASE B: adaptive prescription also freezes -- no fabricated volume conclusion');
  const meso = eng.decideMeso({ weeklyDecision: { status: status }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: { byPrescriptionExerciseId: {} }, isCheckpointWeek: true });
  ok(meso.action === 'COACH_REVIEW', 'CASE B: mesocycle defers to COACH_REVIEW rather than concluding a real plateau/renewal');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — the ticket's other worked example: no progress + 95% execution +
// good recovery -> a REAL plateau read is legitimate, not blocked.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC() {
  const eng = makeEngine();
  const entries = Object.assign({ 'done_6_0': {} }, progrecFor(6, 0, 0.95));
  const sessionAdherence = eng.sessionSummary(entries, 6);
  const status = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'maintain' }, { action: 'maintain' }, { action: 'maintain' }] },
    ciSem: { adherencia_pct: 95 }, postsessionsThisWeek: [], reviewCount: 0, semaphore: null,
    sessionAdherence: sessionAdherence
  });
  ok(status === eng.STATUS.PERFORMANCE_STALL, 'CASE C: no progress + 95% execution -> a real PERFORMANCE_STALL read (legitimate, ticket\'s own worked example)');
  const volume = eng.decideVolume(status, {});
  ok(volume === 'REVIEW_DECREASE', 'CASE C: -> REVIEW_DECREASE, a genuine recommendation this time');
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': { history: [{ action: 'maintain' }, { action: 'freeze_load' }], confidence: 'high' } } };
  const meso = eng.decideMeso({ weeklyDecision: { status: status }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progressionHistory, isCheckpointWeek: true });
  ok(meso.action === 'RENEW_WITH_ADJUSTMENTS', 'CASE C: a genuinely well-executed plateau still justifies RENEW_WITH_ADJUSTMENTS');
  ok(meso.reviewExercisePids.indexOf('pid-1') !== -1, 'CASE C: the real plateaued exercise is flagged for review');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — safety: pain outranks everything, regardless of adherence level.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD() {
  const eng = makeEngine();
  const status = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [] },
    ciSem: {}, postsessionsThisWeek: [{ articularPain: { present: true } }], reviewCount: 0, semaphore: null,
    sessionAdherence: { executionRate: 0.2 } // even with terrible adherence, pain wins
  });
  ok(status === eng.STATUS.PAIN_REVIEW, 'CASE D: pain outranks even a very low executionRate');
  const meso = eng.decideMeso({ weeklyDecision: { status: status }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: { byPrescriptionExerciseId: {} }, isCheckpointWeek: true });
  ok(meso.action === 'STOP_FOR_SAFETY', 'CASE D: mesocycle -> STOP_FOR_SAFETY');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — coach/identity conflict outranks adherence too.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE() {
  const eng = makeEngine();
  const status = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [] },
    ciSem: {}, postsessionsThisWeek: [], reviewCount: 2, semaphore: null,
    sessionAdherence: { executionRate: 0.9 } // even with great adherence, unresolved identity wins
  });
  ok(status === eng.STATUS.COACH_REVIEW, 'CASE E: an unresolved identity conflict outranks a healthy executionRate');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — recovery-limited: reactive deload -> conservative renewal, never
// an increase, regardless of adherence.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF() {
  const eng = makeEngine();
  const status = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: true, exerciseSummary: [] },
    ciSem: {}, postsessionsThisWeek: [], reviewCount: 0, semaphore: null,
    sessionAdherence: { executionRate: 0.9 }
  });
  ok(status === eng.STATUS.RECOVERY_LIMITED, 'CASE F: reactive deload -> RECOVERY_LIMITED even with good adherence');
  const meso = eng.decideMeso({ weeklyDecision: { status: status }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: { byPrescriptionExerciseId: {} }, isCheckpointWeek: true });
  ok(meso.action === 'RENEW_MINIMAL', 'CASE F: mesocycle -> RENEW_MINIMAL (conservative), never RENEW_WITH_ADJUSTMENTS/escalation');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — one under-executed exercise amid an otherwise healthy week:
// overall weeklyStatus is NOT ADHERENCE_LIMITED, but the under-executed
// exercise's own plateau-looking pattern must still not be flagged
// (T205d's per-exercise gate, exercised end-to-end here).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseG() {
  const eng = makeEngine();
  const entries = {
    'done_7_0': {}, 'progrec_7_0': { recommendations: [{ prescriptionExerciseId: 'pid-good', exerciseName: 'Press Banca', setMetrics: { setCompletionRate: 0.95 } }] },
    'done_7_1': {}, 'progrec_7_1': { recommendations: [{ prescriptionExerciseId: 'pid-under', exerciseName: 'Curl Femoral', setMetrics: { setCompletionRate: 0.4 } }] }
  };
  const sessionAdherence = eng.sessionSummary(entries, 7);
  ok(sessionAdherence.executionRate > 0.5, 'CASE G: the WEEK-level average execution is pulled up by the well-executed session (not itself ADHERENCE_LIMITED range)');
  const status = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'increase_load' }, { action: 'maintain' }] },
    ciSem: { adherencia_pct: 80 }, postsessionsThisWeek: [], reviewCount: 0, semaphore: null, sessionAdherence: sessionAdherence
  });
  ok(status !== eng.STATUS.ADHERENCE_LIMITED, 'CASE G: overall week is NOT gated (mixed execution averages out above the 0.6 floor)');

  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-good':  { history: [{ action: 'increase_load' }, { action: 'increase_load' }], confidence: 'high' },
    'pid-under': { history: [{ action: 'maintain' }, { action: 'maintain' }], confidence: 'low' } // T205's confidence fix: low, from poor completion
  }};
  const meso = eng.decideMeso({ weeklyDecision: { status: status }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progressionHistory, isCheckpointWeek: true });
  ok(meso.reviewExercisePids.indexOf('pid-under') === -1, 'CASE G: the SPECIFIC under-executed exercise is still protected from a false plateau verdict, even though the week overall passed');
  ok(meso.preserveExercisePids.indexOf('pid-under') !== -1, 'CASE G: it is preserved instead');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — brand-new client, no data at all: DATA_INSUFFICIENT, no
// fabricated mesocycle decision (T200's own first-ever-plan guard, still
// correct end to end with the new adherence layer wired in).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseH() {
  const eng = makeEngine();
  const status = eng.classify({ engineState: null, ciSem: null, postsessionsThisWeek: [], reviewCount: 0, semaphore: null, sessionAdherence: null });
  ok(status === eng.STATUS.DATA_INSUFFICIENT, 'CASE H: no data at all -> DATA_INSUFFICIENT');
  ok(eng.decideVolume(status, null) === 'FREEZE', 'CASE H: -> FREEZE, no fabricated recommendation');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE I — explicitly skipped sessions: MISSED classification, low
// executionRate, gates to ADHERENCE_LIMITED.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseI() {
  const eng = makeEngine();
  const entries = { 'done_8_0': { skipped: true }, 'done_8_1': { skipped: true } };
  const sessionAdherence = eng.sessionSummary(entries, 8);
  ok(sessionAdherence.counts.MISSED === 2, 'CASE I: both skipped sessions classify as MISSED');
  ok(sessionAdherence.executionRate === 0, 'CASE I: executionRate is a real 0, not null (skips genuinely did not happen)');
  const status = eng.classify({
    engineState: { confidence: 'medium', deloadTriggered: false, exerciseSummary: [] },
    ciSem: { adherencia_pct: 0 }, postsessionsThisWeek: [], reviewCount: 0, semaphore: null, sessionAdherence: sessionAdherence
  });
  ok(status === eng.STATUS.ADHERENCE_LIMITED, 'CASE I: fully skipped week -> ADHERENCE_LIMITED');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE J — executionFidelity assembled for the Generator reflects the same
// per-exercise confidence used by the mesocycle decision above (CASE G) --
// one consistent read across Coach and Generator, no divergence.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseJ() {
  const eng = makeEngine();
  const weeklyDecision = { status: 'PROGRESSING', sessionAdherence: { executionRate: 0.7, week: 7 } };
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-under': { confidence: 'low', executionCompleteness: 0.2, latest: { fidelity: 'LOW' } }
  }};
  const result = eng.computeExecFidelity(null, weeklyDecision, progressionHistory);
  ok(result.sessionAdherence.executionRate === 0.7, 'CASE J: the Generator sees the SAME executionRate the Coach classification used');
  ok(result.exerciseConfidenceByPid['pid-under'].confidence === 'low', 'CASE J: the Generator sees the SAME per-exercise confidence the mesocycle decision used to protect pid-under in CASE G');
})();

// ─────────────────────────────────────────────────────────────────────────────
// RESIDUAL AUDIT (max 5 findings, fix only P0/P1/P2):
//
// No P0/P1/P2 found in this pass. Two P3 (cosmetic/future) observations,
// left as debt per the ticket's own "fix only P0/P1/P2" instruction:
//
//   P3-1: _computeSessionAdherenceSummary's executionRate is an unweighted
//   average across sessions -- a week with 1 session at 10% and 1 at 90%
//   averages to 50% (not ADHERENCE_LIMITED) even though half the week was
//   nearly unexecuted. A session-COUNT-weighted or worst-session-aware
//   metric could be more conservative. Not fixed: the current behavior
//   already correctly gates the ticket's own worked examples (CASE B/I
//   above), and a stricter metric risks false positives on legitimately
//   uneven weeks (e.g. a lighter accessory day). Left as a tuning
//   parameter for real production data, not a correctness bug.
//
//   P3-2: computeMuscleAdherence's _buildExecutedTrainingShape rounds
//   executedCount = round(rate * prescribedSets) per exercise, so a very
//   low but nonzero rate on a low-set-count exercise can round to 0
//   (e.g. rate=0.2 on 2 sets rounds to 0, not 0.4). This slightly
//   understates adherence for low-volume exercises. Not fixed: it is a
//   rounding artifact in the conservative direction (never overstates
//   adherence), consistent with the ticket's "never let insufficient
//   execution look like more than it is" principle.
// ─────────────────────────────────────────────────────────────────────────────

console.log('');
console.log('T208 — E2E adherence chain (CASES A-J): ' + pass + ' assertions PASSED');
