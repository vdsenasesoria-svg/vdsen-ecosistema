'use strict';
/**
 * T216 — E2E CASES A-L: the T210-215 longitudinal learned-state layer,
 * chained exactly as _computeLearnedStateForRequest wires it in production.
 * No case re-derives any of these functions -- all extracted verbatim from
 * vdsen-coach.html, same as every other ticket's test suite in this repo.
 *
 * Followed by a short residual audit (see bottom of file).
 *
 * Run: node tests/t216-e2e-learned-state-chain.test.js
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
// Build one shared engine exposing every real T210-214 function.
// ─────────────────────────────────────────────────────────────────────────────

const musclesSrc   = COACH.slice(COACH.indexOf('var _MOTOR_MUSCLES'), COACH.indexOf('var _EXERCISE_CANONICAL_METADATA = {'));
const metaSrc       = COACH.slice(COACH.indexOf('var _EXERCISE_CANONICAL_METADATA = {'), COACH.indexOf('function auditFractionalVolume'));
const auditSrc      = extractFunction(COACH, 'function auditFractionalVolume(training, exercisesCatalog)');
const confSrc       = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const snapSrc       = extractFunction(COACH, 'function _buildWeeklyExecutionSnapshots(planDoc, progressionHistory)');
const volSrc        = extractFunction(COACH, 'function _computeVolumeToleranceByMuscle(planDoc, progressionHistory, exercisesCatalog)');
const exSrc         = extractFunction(COACH, 'function _computeExerciseToleranceByPid(planDoc, progressionHistory)');
const patSrc        = extractFunction(COACH, 'function _computePatternTolerance(exerciseToleranceByPid, planDoc, exercisesCatalog)');
const recSrc        = extractFunction(COACH, 'function _computeRecoverySensitivity(entries, planDoc, progressionHistory)');
const learnedReqSrc = extractFunction(COACH, 'function _computeLearnedStateForRequest(entries, planDoc, progressionHistory)');

ok([musclesSrc, metaSrc, auditSrc, confSrc, snapSrc, volSrc, exSrc, patSrc, recSrc, learnedReqSrc].every(Boolean),
  'prerequisite: every function this E2E chain needs extracts cleanly from vdsen-coach.html');

function makeEngine() {
  const win = {};
  const factory = new Function('window',
    musclesSrc + ';\n' + metaSrc + ';\n' + auditSrc + ';\n' + confSrc + ';\n' + snapSrc + ';\n' +
    volSrc + ';\n' + exSrc + ';\n' + patSrc + ';\n' + recSrc + ';\n' +
    'window.VDSEN_LEARNED = { computeVolumeTolerance: _computeVolumeToleranceByMuscle, computeExerciseTolerance: _computeExerciseToleranceByPid, computePatternTolerance: _computePatternTolerance, computeRecoverySensitivity: _computeRecoverySensitivity };\n' +
    learnedReqSrc + ';\n' +
    'return { computeLearnedState: _computeLearnedStateForRequest, computeVolumeTolerance: _computeVolumeToleranceByMuscle, computeExerciseTolerance: _computeExerciseToleranceByPid };'
  );
  return factory(win);
}
const eng = makeEngine();

function plan(sets, pid) {
  return { days: [{ exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: pid || 'pid-1', sets: new Array(sets).fill({}) }] }] };
}
function historyWeeks(pid, weeks) {
  return { byPrescriptionExerciseId: { [pid]: { exerciseName: 'Press Banca', history: weeks.map(w => ({ week: w.week, action: w.action, setCompletionRate: w.rate })) } } };
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — 4+ valid weeks, high adherence, good progression -> HIGH
// confidence, TOLERATED.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA() {
  const progHist = historyWeeks('pid-1', [
    { week: 1, action: 'increase_load', rate: 0.95 }, { week: 2, action: 'increase_load', rate: 1 },
    { week: 3, action: 'increase_load', rate: 0.9 },  { week: 4, action: 'maintain', rate: 0.95 },
    { week: 5, action: 'increase_load', rate: 1 }
  ]);
  const result = eng.computeVolumeTolerance(plan(4), progHist, []);
  const m = Object.keys(result)[0];
  ok(result[m].confidence === 'high', 'CASE A: high confidence tolerated state');
  ok(result[m].evidence === 'TOLERATED', 'CASE A: TOLERATED evidence');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — same volume, high adherence, repeated recovery decline (freeze/
// reduce) -> MAY_EXCEED_TOLERANCE.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB() {
  const progHist = historyWeeks('pid-1', [
    { week: 1, action: 'freeze_load', rate: 0.95 }, { week: 2, action: 'reduce_load', rate: 0.9 },
    { week: 3, action: 'freeze_load', rate: 1 },    { week: 4, action: 'reduce_load', rate: 0.95 },
    { week: 5, action: 'freeze_load', rate: 1 }
  ]);
  const result = eng.computeVolumeTolerance(plan(4), progHist, []);
  const m = Object.keys(result)[0];
  ok(result[m].evidence === 'MAY_EXCEED_TOLERANCE', 'CASE B: repeated decline at real confidence -> MAY_EXCEED_TOLERANCE');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — poor adherence -> confidence stays LOW/NONE, never a tolerance
// conclusion either way.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC() {
  const progHist = historyWeeks('pid-1', [
    { week: 1, action: 'freeze_load', rate: 0.15 }, { week: 2, action: 'reduce_load', rate: 0.1 },
    { week: 3, action: 'freeze_load', rate: 0.2 },  { week: 4, action: 'reduce_load', rate: 0.1 },
    { week: 5, action: 'freeze_load', rate: 0.15 }
  ]);
  const result = eng.computeVolumeTolerance(plan(4), progHist, []);
  const m = Object.keys(result)[0];
  ok(result[m].confidence === 'low' || result[m].confidence === 'none', 'CASE C: poor adherence caps confidence at low/none');
  ok(result[m].evidence === 'INSUFFICIENT_DATA', 'CASE C: never concludes tolerance either way from poor adherence');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — one excellent week -> no HIGH confidence.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD() {
  const progHist = historyWeeks('pid-1', [{ week: 1, action: 'increase_load', rate: 1 }]);
  const exResult = eng.computeExerciseTolerance(plan(4), progHist);
  ok(exResult['pid-1'].confidence !== 'high', 'CASE D: a single excellent week never reaches HIGH confidence');
  ok(exResult['pid-1'].classification === 'INSUFFICIENT_DATA', 'CASE D: classification stays INSUFFICIENT_DATA');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — same PID productive across (simulated) mesocycles -> learned
// tolerance persists (history simply keeps accumulating for the SAME pid).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE() {
  const mesocycle1 = [{ week: 1, action: 'increase_load', rate: 1 }, { week: 2, action: 'increase_load', rate: 1 }];
  const mesocycle2 = [{ week: 7, action: 'increase_load', rate: 1 }, { week: 8, action: 'increase_load', rate: 1 }, { week: 9, action: 'increase_load', rate: 1 }];
  const progHist = historyWeeks('pid-1', mesocycle1.concat(mesocycle2)); // same PID across the "renewed" mesocycle
  const exResult = eng.computeExerciseTolerance(plan(4), progHist);
  ok(exResult['pid-1'].weeksObserved === 5, 'CASE E: history from BOTH mesocycles accumulates for the same PID (persistence)');
  ok(exResult['pid-1'].classification === 'PRODUCTIVE', 'CASE E: the learned PRODUCTIVE tolerance persists across the mesocycle renewal');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — a genuinely new PID inherits NO old exercise tolerance.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF() {
  const oldHistory = historyWeeks('pid-old', [
    { week: 1, action: 'increase_load', rate: 1 }, { week: 2, action: 'increase_load', rate: 1 },
    { week: 3, action: 'increase_load', rate: 1 }, { week: 4, action: 'increase_load', rate: 1 }, { week: 5, action: 'increase_load', rate: 1 }
  ]);
  const exResult = eng.computeExerciseTolerance(plan(4, 'pid-new'), oldHistory); // current plan uses pid-new; only pid-old has history
  ok(!('pid-old' in exResult), 'CASE F: the old PID is not even in the current-plan classification map');
  ok(exResult['pid-new'].classification === 'INSUFFICIENT_DATA', 'CASE F: pid-new starts with NO inherited state -- INSUFFICIENT_DATA, not PRODUCTIVE');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — Coach substitution: old exercise state does not silently
// dominate the new prescription (same mechanism as CASE F, from the
// Coach's own action rather than the Generator's).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseG() {
  const oldHistory = historyWeeks('pid-removed-by-coach', [
    { week: 1, action: 'freeze_load', rate: 0.9 }, { week: 2, action: 'freeze_load', rate: 0.9 },
    { week: 3, action: 'freeze_load', rate: 0.9 }, { week: 4, action: 'freeze_load', rate: 0.9 }, { week: 5, action: 'freeze_load', rate: 0.9 }
  ]); // this exercise looked LOW_TOLERANCE -- the Coach substituted it away
  const exResult = eng.computeExerciseTolerance(plan(4, 'pid-coach-chose'), oldHistory);
  ok(!('pid-removed-by-coach' in exResult), 'CASE G: the Coach-substituted-away PID is dropped entirely, its LOW_TOLERANCE history cannot dominate anything');
  ok(exResult['pid-coach-chose'].classification === 'INSUFFICIENT_DATA', "CASE G: the Coach's new choice starts clean, not pre-judged by the old exercise's record");
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — a deload week's action ('deload', not freeze_load/reduce_load)
// is never counted as exercise failure/decline.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseH() {
  const progHist = historyWeeks('pid-1', [
    { week: 1, action: 'increase_load', rate: 1 }, { week: 2, action: 'increase_load', rate: 1 },
    { week: 3, action: 'deload', rate: 1 }, { week: 4, action: 'increase_load', rate: 1 }, { week: 5, action: 'increase_load', rate: 1 }
  ]);
  const exResult = eng.computeExerciseTolerance(plan(4), progHist);
  ok(exResult['pid-1'].classification === 'PRODUCTIVE', "CASE H: a deload week's 'deload' action is not counted as decline -- the exercise still reads PRODUCTIVE");
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE I — legacy/no PID: safe fallback, never a silent name merge.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseI() {
  // Two exercises sharing a NAME but different PIDs -- one productive, one
  // barely executed. Neither should contaminate the other.
  const progHist = { byPrescriptionExerciseId: {
    'pid-a': { exerciseName: 'Sentadilla', history: [
      { week: 1, action: 'increase_load', setCompletionRate: 1 }, { week: 2, action: 'increase_load', setCompletionRate: 1 },
      { week: 3, action: 'increase_load', setCompletionRate: 1 }, { week: 4, action: 'increase_load', setCompletionRate: 1 }, { week: 5, action: 'increase_load', setCompletionRate: 1 }
    ]},
    'pid-b': { exerciseName: 'Sentadilla', history: [
      { week: 1, action: 'freeze_load', setCompletionRate: 0.9 }, { week: 2, action: 'freeze_load', setCompletionRate: 0.9 },
      { week: 3, action: 'freeze_load', setCompletionRate: 0.9 }, { week: 4, action: 'freeze_load', setCompletionRate: 0.9 }, { week: 5, action: 'freeze_load', setCompletionRate: 0.9 }
    ]}
  }};
  const planDoc = { days: [{ exercises: [
    { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-a', sets: [{}, {}, {}, {}] },
    { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-b', sets: [{}, {}, {}, {}] }
  ]}]};
  const exResult = eng.computeExerciseTolerance(planDoc, progHist);
  ok(exResult['pid-a'].classification === 'PRODUCTIVE', 'CASE I: pid-a keeps its own PRODUCTIVE classification');
  ok(exResult['pid-b'].classification === 'LOW_TOLERANCE', 'CASE I: pid-b (same NAME as pid-a) keeps its own LOW_TOLERANCE classification -- no silent merge by name');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE J/K — Authority Order: reliable (medium/high) learned state is
// exposed as actionable; low-confidence learned state is exposed as
// INSUFFICIENT_DATA (deterministic signal the prompt rule, tested in T214,
// then applies to keep the prior dominant). The code's role is to expose
// the correct confidence tier -- the LLM applies the actual precedence.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseJ_HighConfidenceExposedAsActionable() {
  const progHist = historyWeeks('pid-1', [
    { week: 1, action: 'increase_load', rate: 1 }, { week: 2, action: 'increase_load', rate: 1 },
    { week: 3, action: 'increase_load', rate: 1 }, { week: 4, action: 'increase_load', rate: 1 }, { week: 5, action: 'increase_load', rate: 1 }
  ]);
  const learnedState = eng.computeLearnedState({}, plan(4), progHist);
  ok(learnedState.confidence === 'high', 'CASE J: a genuinely well-evidenced client-specific signal surfaces as overall confidence HIGH -- actionable, eligible to outrank the population prior per the prompt rule');
})();

(function testCaseK_LowConfidenceStaysConservative() {
  const progHist = historyWeeks('pid-1', [{ week: 1, action: 'increase_load', rate: 1 }]);
  const learnedState = eng.computeLearnedState({}, plan(4), progHist);
  ok(learnedState.exerciseToleranceByPid['pid-1'].classification === 'INSUFFICIENT_DATA', 'CASE K: a single week never surfaces as actionable -- INSUFFICIENT_DATA correctly signals the prior must remain dominant');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE L — recovery sensitivity is exposed to the Generator but is
// structurally incapable of auto-deloading anything (no write path exists).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseL() {
  const learnedState = eng.computeLearnedState({}, { days: [] }, { byPrescriptionExerciseId: {} });
  ok('recoverySensitivity' in learnedState, 'CASE L: recoverySensitivity is exposed in the assembled learnedState');
  ok(!recSrc.includes('updateDoc') && !recSrc.includes('setDoc') && !recSrc.includes('deloadTriggered ='),
    'CASE L: _computeRecoverySensitivity has no write path at all -- it is structurally incapable of triggering a deload itself');
})();

// ─────────────────────────────────────────────────────────────────────────────
// RESIDUAL AUDIT (max 5 findings, fix only P0/P1/P2):
//
// No P0/P1/P2 found in this pass. One P3 (tuning) observation, left as
// debt per the ticket's own "fix only P0/P1/P2" instruction:
//
//   P3-1: _computeVolumeToleranceByMuscle's per-week "goodOutcome" treats a
//   deload week (action:'deload', matching neither the increase nor decline
//   filter) as goodOutcome:true (0 good >= 0 bad), so a deload week's
//   (deliberately halved) volume can land in the tolerated range's sample.
//   T212's exercise-tolerance classifier correctly excludes 'deload' from
//   both its increase/decline buckets (verified in CASE H above), but
//   T211's volume-tolerance goodOutcome check does not special-case it the
//   same way. Not fixed: a single averaged-in deload week has a small,
//   conservative effect on the tolerated range (it can only narrow/lower
//   it, since deload volume is intentionally reduced -- never inflates the
//   apparent tolerated ceiling), and excluding deload weeks entirely would
//   need a NEW per-week "was this a deload week" signal threaded through
//   _buildWeeklyExecutionSnapshots (currently derived from progressionHistory
//   alone, which does not carry a deload flag per week outside the 'deload'
//   action string itself). Left as tuning debt, not a correctness bug.
//
// Run: node tests/t216-e2e-learned-state-chain.test.js
console.log('');
console.log('T216 — E2E learned-state chain (CASES A-L): ' + pass + ' assertions PASSED');
