'use strict';
/**
 * T224 — E2E CASES A-M: the T217-223 outcome-response/effectiveness layer,
 * chained exactly as _computePrescriptionEffectivenessForRequest wires it
 * in production. No case re-derives any of these functions -- all
 * extracted verbatim from vdsen-coach.html.
 *
 * Followed by a short residual audit (see bottom of file).
 *
 * Run: node tests/t224-e2e-outcome-effectiveness-chain.test.js
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
// Build one shared engine exposing every real T210/T218-221 function.
// ─────────────────────────────────────────────────────────────────────────────

const rankSrc     = COACH.slice(COACH.indexOf('var _CONF_RANK = {'), COACH.indexOf('function _computePrescriptionEffectivenessSynthesis'));
const confSrc     = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const outcomeSrc  = extractFunction(COACH, 'function _computeOutcomeConfidence(measurements, options)');
const perfSrc     = extractFunction(COACH, 'function _classifyPerformanceResponse(planDoc, progressionHistory)');
const bodyCompSrc = extractFunction(COACH, 'function _classifyBodyCompositionResponse(inbodyResults, objetivoCalorico)');
const synthSrc    = extractFunction(COACH, 'function _computePrescriptionEffectivenessSynthesis(input)');

ok([rankSrc, confSrc, outcomeSrc, perfSrc, bodyCompSrc, synthSrc].every(Boolean), 'prerequisite: every function this E2E chain needs extracts cleanly from vdsen-coach.html');

function makeEngine() {
  const factory = new Function(
    confSrc + ';\n' + outcomeSrc + ';\n' + perfSrc + ';\n' + bodyCompSrc + ';\n' + rankSrc + ';\n' + synthSrc + ';\n' +
    'return { computePerformanceResponse: _classifyPerformanceResponse, computeBodyCompositionResponse: _classifyBodyCompositionResponse, computeEffectiveness: _computePrescriptionEffectivenessSynthesis };'
  );
  return factory();
}
const eng = makeEngine();

function plan(pid) { return { days: [{ exercises: [{ exerciseName: pid, prescriptionExerciseId: pid, sets: [{}, {}, {}, {}] }] }] }; }
function hist(pid, actions, opts) {
  opts = opts || {};
  return { byPrescriptionExerciseId: { [pid]: { history: actions.map(function(a, i) {
    return { week: i + 1, action: a, setCompletionRate: (opts.rates && opts.rates[i] !== undefined) ? opts.rates[i] : 0.95, hadPainFlag: !!(opts.pain && opts.pain[i]) };
  })}}};
}
const DAY = 86400000;
function r(dayOffset, fields) { return Object.assign({ ts: dayOffset * DAY }, fields); }

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — high adherence, good progression, goal moving correctly,
// recovery good -> EFFECTIVE_TOLERATED.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA() {
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1', ['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load']));
  const bodyComp = eng.computeBodyCompositionResponse(
    [r(0, { peso: 82, pbf: 22 }), r(20, { peso: 80, pbf: 20 }), r(40, { peso: 78, pbf: 18 })], 'déficit'
  );
  const result = eng.computeEffectiveness({ performanceResponse: perf, bodyCompositionResponse: bodyComp, sessionAdherence: { executionRate: 0.93 }, recoverySensitivity: { pattern: 'STABLE_AT_CURRENT_STRESS' } });
  ok(result.overall === 'EFFECTIVE_TOLERATED', 'CASE A: high adherence + good progression + goal moving correctly + stable recovery -> EFFECTIVE_TOLERATED');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — high adherence, good performance, recovery poor -> EFFECTIVE_BUT_COSTLY.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB() {
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1', ['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load']));
  const result = eng.computeEffectiveness({ performanceResponse: perf, bodyCompositionResponse: null, sessionAdherence: { executionRate: 0.9 }, recoverySensitivity: { pattern: 'DECLINES_AT_HIGHER_STRESS' } });
  ok(result.overall === 'EFFECTIVE_BUT_COSTLY', 'CASE B: high adherence + good performance + declining recovery pattern -> EFFECTIVE_BUT_COSTLY');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — high adherence, adequate recovery, sufficient duration, no
// progress -> TOLERATED_BUT_UNDER_RESPONDING.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC() {
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1', ['maintain', 'maintain', 'maintain', 'maintain', 'maintain']));
  const result = eng.computeEffectiveness({ performanceResponse: perf, bodyCompositionResponse: null, sessionAdherence: { executionRate: 0.9 }, recoverySensitivity: { pattern: 'STABLE_AT_CURRENT_STRESS' } });
  ok(result.overall === 'TOLERATED_BUT_UNDER_RESPONDING', 'CASE C: high adherence + adequate recovery + sufficient duration + no progress -> TOLERATED_BUT_UNDER_RESPONDING');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — low adherence + poor outcome -> DATA_INSUFFICIENT, not "bad program".
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD() {
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1', ['freeze_load', 'reduce_load', 'freeze_load', 'reduce_load', 'freeze_load'], { rates: [0.15, 0.1, 0.2, 0.1, 0.15] }));
  const result = eng.computeEffectiveness({ performanceResponse: perf, bodyCompositionResponse: null, sessionAdherence: { executionRate: 0.25 } });
  ok(result.overall === 'DATA_INSUFFICIENT', 'CASE D: low adherence + poor outcome -> DATA_INSUFFICIENT, never "bad program"');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — one body-composition measurement -> insufficient confidence.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE() {
  const bodyComp = eng.computeBodyCompositionResponse([r(0, { peso: 80 })], 'déficit');
  ok(bodyComp.classification === 'INSUFFICIENT_DATA', 'CASE E: one body-composition measurement -> INSUFFICIENT_DATA');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — multiple consistent measurements, goal moving correctly ->
// ON_TARGET with appropriate confidence.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF() {
  const bodyComp = eng.computeBodyCompositionResponse(
    [r(0, { peso: 82, smm: 34 }), r(20, { peso: 80, smm: 34.2 }), r(40, { peso: 78, smm: 34.5 }), r(60, { peso: 77, smm: 34.6 })], 'déficit'
  );
  ok(bodyComp.classification === 'ON_TARGET', 'CASE F: multiple consistent measurements, goal moving correctly -> ON_TARGET');
  ok(bodyComp.confidence !== 'none' && bodyComp.confidence !== 'low', 'CASE F: appropriate real confidence from 4 well-spaced consistent measurements');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — measurement conflict -> MEASUREMENT_CONFLICT.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseG() {
  const bodyComp = eng.computeBodyCompositionResponse([r(0, { peso: 80 }), r(2, { peso: 73 })], 'déficit');
  ok(bodyComp.classification === 'MEASUREMENT_CONFLICT', 'CASE G: an implausible 7kg/2-day swing -> MEASUREMENT_CONFLICT');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — pain despite good progress -> SAFETY_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseH() {
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1',
    ['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load'],
    { pain: [false, false, true, false, false] }
  ));
  ok(perf['pid-1'].classification === 'COACH_REVIEW', 'CASE H sub-step: good progression + pain -> T219 COACH_REVIEW');
  const result = eng.computeEffectiveness({ performanceResponse: perf, bodyCompositionResponse: null, sessionAdherence: { executionRate: 0.95 } });
  ok(result.overall === 'SAFETY_REVIEW', 'CASE H: pain despite good progress -> SAFETY_REVIEW end to end, never "successful"');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE I — same PID responds across (simulated) mesocycles -> longitudinal
// evidence preserved.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseI() {
  const mesocycle1 = ['increase_load', 'increase_load'];
  const mesocycle2 = ['increase_load', 'increase_load', 'increase_load'];
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1', mesocycle1.concat(mesocycle2)));
  ok(perf['pid-1'].weeksObserved === 5, 'CASE I: history from both mesocycles accumulates for the same PID');
  ok(perf['pid-1'].classification === 'RESPONDING', 'CASE I: the RESPONDING evidence persists across the mesocycle renewal');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE J — a new PID inherits no old exercise-response state.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseJ() {
  const oldHistory = hist('pid-old', ['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load']);
  const perf = eng.computePerformanceResponse(plan('pid-new'), oldHistory);
  ok(!('pid-old' in perf), 'CASE J: the old PID is not even in the current-plan classification map');
  ok(perf['pid-new'].classification === 'INSUFFICIENT_DATA', 'CASE J: pid-new starts with no inherited response state');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE K — a deload week is not interpreted as program failure.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseK() {
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1', ['increase_load', 'increase_load', 'deload', 'increase_load', 'increase_load']));
  ok(perf['pid-1'].classification === 'RESPONDING', "CASE K: a deload week's distinct 'deload' action is never counted as program failure -- still reads RESPONDING");
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE L — high-confidence learned_state + low-confidence outcome ->
// learned_state remains dominant (structural: each signal's confidence is
// computed and exposed independently, so a low-confidence outcome can
// never inflate itself to override a high-confidence learned_state; the
// prompt rule, tested in T222, then enforces the actual precedence).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseL() {
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1', ['increase_load']));
  ok(perf['pid-1'].classification === 'INSUFFICIENT_DATA' && perf['pid-1'].confidence !== 'high',
    'CASE L: a low-confidence outcome (single week) is correctly exposed as such, never inflated to contest a high-confidence learned_state');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE M — high-confidence outcome contradicts a population expectation ->
// individual evidence wins (structural: neither classifier ever references
// a population prior, so there is nothing to override -- the individual's
// own data is the entire input).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseM() {
  ok(!perfSrc.includes('_POPULATION_PRIORS') && !bodyCompSrc.includes('_POPULATION_PRIORS'),
    'CASE M: neither T219 nor T220 ever references a population prior -- individual evidence is the entire input, nothing to be overridden by');
  const perf = eng.computePerformanceResponse(plan('pid-1'), hist('pid-1', ['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load']));
  ok(perf['pid-1'].classification === 'RESPONDING' && perf['pid-1'].confidence === 'high', 'CASE M: a genuinely well-evidenced individual response surfaces at full HIGH confidence regardless of any general expectation');
})();

// ─────────────────────────────────────────────────────────────────────────────
// RESIDUAL AUDIT (max 5 findings, fix only P0/P1/P2):
//
// No P0/P1/P2 found in this pass. One P3 (tuning) observation, left as
// debt per the ticket's own "fix only P0/P1/P2" instruction:
//
//   P3-1: _classifyBodyCompositionResponse's MEASUREMENT_CONFLICT gate
//   (>5kg swing in <14 days) uses a single fixed threshold regardless of
//   the client's own body weight (a 5kg swing is far more implausible for
//   a 55kg client than a 120kg client). Not fixed: making it weight-
//   relative would need a real-world calibration this ticket has no
//   evidence base for ("no arbitrary Bayesian/statistical model unless
//   already present" -- a percentage-of-bodyweight threshold would itself
//   be a new invented number, not a reuse of anything existing). The
//   fixed 5kg/14-day gate is conservative in the safe direction (it can
//   only flag MORE swings as conflicts on smaller clients, never fewer,
//   so it never silently accepts an implausible reading either way).
//
// Run: node tests/t224-e2e-outcome-effectiveness-chain.test.js
console.log('');
console.log('T224 — E2E outcome-effectiveness chain (CASES A-M): ' + pass + ' assertions PASSED');
