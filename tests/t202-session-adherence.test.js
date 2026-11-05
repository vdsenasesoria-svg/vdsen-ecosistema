'use strict';
/**
 * T202 — Session adherence: PRESCRIBED SESSION -> ACTUAL EXECUTION.
 *
 * COMPLETE/PARTIAL/MISSED/INSUFFICIENT_DATA, built from data already
 * computed and persisted: the F76 session-completion state machine
 * (ported verbatim from vdsen-cliente.html) and the SAME
 * setMetrics.setCompletionRate calculateProgression already writes into
 * THIS session's own progrec_{W}_{D} entry (T203's source, reused here at
 * the whole-session level). No new Firestore field, no plan-structure
 * lookup: "opening the workout" (a PENDING doneEntry) is never treated as
 * adherence evidence in either direction.
 *
 * T205(c) — the pre-existing ADHERENCE_LIMITED gate in _classifyWeeklyStatus
 * only looked at engine_state.confidence, a CUMULATIVE raw-logged-set count
 * across the whole mesocycle. That can read 'medium'/'high' purely from
 * elapsed time even when every single week was poorly executed (e.g.
 * consistent attendance, ~45% of prescribed sets done every week). A new
 * gate (4b) feeds this week's own sessionAdherence.executionRate in
 * additively -- closing exactly the gap the ticket's own worked example
 * describes: "No progress + 45% execution -> ADHERENCE_LIMITED NOT
 * REVIEW_INCREASE".
 *
 * Run: node tests/t202-session-adherence.test.js
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

const stateSrc   = extractFunction(COACH, 'function _getSessionCompletionState(doneEntry)');
const ratioSrc   = extractFunction(COACH, 'function _sessionExecutionRatio(doneEntry, progrecEntry)');
const classSrc   = extractFunction(COACH, 'function _classifySessionAdherence(doneEntry, progrecEntry)');
const summarySrc = extractFunction(COACH, 'function _computeSessionAdherenceSummary(entries, week)');
ok(stateSrc && ratioSrc && classSrc && summarySrc, 'prerequisite: all 4 T202 functions extract cleanly');

function makeAdherenceEngine() {
  const factory = new Function(
    stateSrc + ';\n' + ratioSrc + ';\n' + classSrc + ';\n' + summarySrc + ';\n' +
    'return { state: _getSessionCompletionState, ratio: _sessionExecutionRatio, classify: _classifySessionAdherence, summary: _computeSessionAdherenceSummary };'
  );
  return factory();
}
const adh = makeAdherenceEngine();

// ─────────────────────────────────────────────────────────────────────────────
// _getSessionCompletionState — F76 state machine, byte-identical semantics.
// ─────────────────────────────────────────────────────────────────────────────

(function testSessionStateMachine() {
  ok(adh.state(undefined) === 'PENDING', 'no doneEntry -> PENDING');
  ok(adh.state(true) === 'REAL_COMPLETE', 'legacy boolean true -> REAL_COMPLETE');
  ok(adh.state({ skipped: true }) === 'SKIPPED', 'skipped, not auto-closed -> SKIPPED');
  ok(adh.state({ skipped: true, autoClosed: true }) === 'AUTO_CLOSED_NO_DATA', 'skipped AND auto-closed -> AUTO_CLOSED_NO_DATA');
  ok(adh.state({ autoClosed: true }) === 'AUTO_CLOSED', 'auto-closed with data -> AUTO_CLOSED');
  ok(adh.state({}) === 'REAL_COMPLETE', 'plain completed object -> REAL_COMPLETE');
})();

// ─────────────────────────────────────────────────────────────────────────────
// _classifySessionAdherence — the 4-way classification.
// ─────────────────────────────────────────────────────────────────────────────

(function testClassification() {
  ok(adh.classify(undefined, null) === 'INSUFFICIENT_DATA', 'PENDING (never opened) -> INSUFFICIENT_DATA, never MISSED (opening/not-opening is not adherence evidence)');
  ok(adh.classify({ skipped: true }, null) === 'MISSED', 'explicitly skipped -> MISSED');
  ok(adh.classify({ skipped: true, autoClosed: true }, null) === 'MISSED', 'auto-closed with no data (navigation-only) -> MISSED');

  const highProgrec = { recommendations: [{ setMetrics: { setCompletionRate: 0.9 } }, { setMetrics: { setCompletionRate: 1 } }] };
  ok(adh.classify({}, highProgrec) === 'COMPLETE', 'real completion with ~95% avg set completion -> COMPLETE');

  const partialProgrec = { recommendations: [{ setMetrics: { setCompletionRate: 0.5 } }] };
  ok(adh.classify({}, partialProgrec) === 'PARTIAL', 'real completion with 50% avg set completion -> PARTIAL');

  const barelyProgrec = { recommendations: [{ setMetrics: { setCompletionRate: 0.1 } }] };
  ok(adh.classify({}, barelyProgrec) === 'MISSED', 'session marked done but only 10% of sets actually logged -> MISSED (the shell was opened, almost nothing executed)');

  ok(adh.classify({}, null) === 'INSUFFICIENT_DATA', 'real completion but no progrec/setMetrics evidence at all -> INSUFFICIENT_DATA, not assumed COMPLETE or MISSED');
})();

// ─────────────────────────────────────────────────────────────────────────────
// _computeSessionAdherenceSummary — the aggregate executionRate fed into
// decision confidence.
// ─────────────────────────────────────────────────────────────────────────────

(function testWorkedExample_LowExecutionRate() {
  // 3 sessions this week, each with real completion but only ~45% avg set
  // completion -- matches the ticket's own worked example.
  const entries = {
    'done_4_0': {}, 'progrec_4_0': { recommendations: [{ setMetrics: { setCompletionRate: 0.45 } }] },
    'done_4_1': {}, 'progrec_4_1': { recommendations: [{ setMetrics: { setCompletionRate: 0.45 } }] },
    'done_4_2': {}, 'progrec_4_2': { recommendations: [{ setMetrics: { setCompletionRate: 0.45 } }] }
  };
  const summary = adh.summary(entries, 4);
  ok(Math.abs(summary.executionRate - 0.45) < 1e-9, 'aggregate executionRate reflects the true ~45% average (got: ' + summary.executionRate + ')');
  ok(summary.counts.PARTIAL === 3, 'all 3 sessions classify as PARTIAL individually');
})();

(function testHighExecutionRate() {
  const entries = {
    'done_4_0': {}, 'progrec_4_0': { recommendations: [{ setMetrics: { setCompletionRate: 0.95 } }] }
  };
  const summary = adh.summary(entries, 4);
  ok(summary.executionRate > 0.9, 'a well-executed week reports a high executionRate');
  ok(summary.counts.COMPLETE === 1, 'the single session classifies as COMPLETE');
})();

(function testSkippedSessionCountsAsZero() {
  const entries = { 'done_4_0': { skipped: true } };
  const summary = adh.summary(entries, 4);
  ok(summary.executionRate === 0, 'a skipped session contributes ratio 0, not null (it genuinely did not happen)');
  ok(summary.counts.MISSED === 1, 'counted as MISSED');
})();

(function testPendingSessionIgnoredInAverage() {
  const entries = {}; // no done_4_0 key at all -- session hasn't happened yet, no key exists to iterate
  const summary = adh.summary(entries, 4);
  ok(summary.executionRate === null, 'no sessions for this week at all -> executionRate null, not zero (never fabricates adherence data)');
})();

(function testNoWeekReturnsSafeEmpty() {
  const summary = adh.summary({ 'done_4_0': {} }, undefined);
  ok(summary.executionRate === null && summary.sessions.length === 0, 'no week number -> safe empty summary, no throw');
})();

// ─────────────────────────────────────────────────────────────────────────────
// T205(c) — the ADHERENCE_LIMITED gate now also fires on a low week-scoped
// executionRate, closing the gap the pure count-based engine_state.confidence
// check could miss.
// ─────────────────────────────────────────────────────────────────────────────

const semSrc      = extractFunction(COACH, 'function _calcEhrensteinSemaphore(subjScore, subjVulner, avgICS, umbral)');
const wsMetaSrc    = COACH.slice(COACH.indexOf('var WEEKLY_STATUS = {'), COACH.indexOf('function _classifyWeeklyStatus'));
const classifySrc = extractFunction(COACH, 'function _classifyWeeklyStatus(input)');
const volumeSrc   = extractFunction(COACH, 'function _decideVolumeAction(status, ciSem)');

function makeWeeklyEngine() {
  const factory = new Function(wsMetaSrc + ';\n' + semSrc + ';\n' + classifySrc + ';\n' + volumeSrc + ';\n' +
    'return { classify: _classifyWeeklyStatus, decideVolume: _decideVolumeAction, STATUS: WEEKLY_STATUS };');
  return factory();
}
const weekly = makeWeeklyEngine();

(function testWorkedExample_LowAdherenceBlocksFalseConfidence() {
  // engine_state.confidence reads 'high' (large cumulative raw count from
  // many weeks of partial attendance) but THIS week's real execution rate
  // is only 45% -- must still gate to ADHERENCE_LIMITED, never let a
  // 'high'-confidence engine_state read produce PROGRESSING/PERFORMANCE_STALL.
  const input = {
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'maintain' }, { action: 'maintain' }] },
    ciSem: { adherencia_pct: 50 },
    postsessionsThisWeek: [],
    reviewCount: 0,
    semaphore: null,
    sessionAdherence: { executionRate: 0.45 }
  };
  const status = weekly.classify(input);
  ok(status === weekly.STATUS.ADHERENCE_LIMITED, 'T205 worked example: no progress + 45% execution -> ADHERENCE_LIMITED, NOT PERFORMANCE_STALL/REVIEW_INCREASE (got: ' + status + ')');
  ok(weekly.decideVolume(status, input.ciSem) === 'FREEZE', 'ADHERENCE_LIMITED -> FREEZE, no volume conclusion drawn from an under-executed week');
})();

(function testHighExecutionStillReachesRealConclusion() {
  // Same shape, but a genuinely well-executed week (95%) with no progress --
  // this IS legitimate evidence of a plateau, must NOT be blocked.
  const input = {
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'maintain' }, { action: 'maintain' }, { action: 'maintain' }] },
    ciSem: { adherencia_pct: 95 },
    postsessionsThisWeek: [],
    reviewCount: 0,
    semaphore: null,
    sessionAdherence: { executionRate: 0.95 }
  };
  const status = weekly.classify(input);
  ok(status === weekly.STATUS.PERFORMANCE_STALL, 'T205 worked example: no progress + 95% execution + good recovery -> a real plateau read (PERFORMANCE_STALL) is legitimate, not blocked (got: ' + status + ')');
})();

(function testMissingSessionAdherenceIsSafeNoOp() {
  // Existing callers that don't pass sessionAdherence at all (or T177/T178's
  // own test suite) must behave EXACTLY as before -- purely additive.
  const input = {
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'increase_load' }, { action: 'increase_load' }] },
    ciSem: { adherencia_pct: 95, ics_promedio: 8 },
    postsessionsThisWeek: [],
    reviewCount: 0,
    semaphore: null
  };
  ok(weekly.classify(input) === weekly.STATUS.PROGRESSING, 'no sessionAdherence field at all -> unchanged behavior (PROGRESSING)');
})();

console.log('');
console.log('T202 — Session adherence: ' + pass + ' assertions PASSED');
