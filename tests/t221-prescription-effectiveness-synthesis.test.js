'use strict';
/**
 * T221 — Prescription effectiveness synthesis: combines T219 (performance
 * response), T220 (body-composition response), T202 (session adherence)
 * and T213 (recovery sensitivity) into ONE deterministic effectiveness
 * summary. TOLERANCE != EFFECTIVENESS (Core Principle): adherence gates
 * attribution BEFORE any response is weighed. No numeric score.
 *
 * Run: node tests/t221-prescription-effectiveness-synthesis.test.js
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

const rankSrc = COACH.slice(COACH.indexOf('var _CONF_RANK = {'), COACH.indexOf('function _computePrescriptionEffectivenessSynthesis'));
const synthSrc = extractFunction(COACH, 'function _computePrescriptionEffectivenessSynthesis(input)');
ok(rankSrc && synthSrc, 'prerequisite: _computePrescriptionEffectivenessSynthesis extracts cleanly');
const computeEffectiveness = new Function(rankSrc + ';\n' + synthSrc + ';\nreturn _computePrescriptionEffectivenessSynthesis;')();

ok(COACH.includes('computeEffectiveness: _computePrescriptionEffectivenessSynthesis'), 'exposed via window.VDSEN_OUTCOME for T222/T223 reuse');
ok(!/[+\-*\/]\s*\d.*score|score\s*[+\-*\/]=/.test(synthSrc), 'no numeric score is computed -- named states only');

function perf(classes) {
  var m = {};
  classes.forEach(function(c, i) { m['pid-' + i] = { classification: c, confidence: 'high' }; });
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTIVE_TOLERATED — high adherence, positive response, no recovery cost.
// ─────────────────────────────────────────────────────────────────────────────

(function testEffectiveTolerated() {
  const result = computeEffectiveness({
    performanceResponse: perf(['RESPONDING', 'RESPONDING', 'STABLE']),
    sessionAdherence: { executionRate: 0.93 },
    recoverySensitivity: { pattern: 'STABLE_AT_CURRENT_STRESS' }
  });
  ok(result.overall === 'EFFECTIVE_TOLERATED', 'high adherence + majority RESPONDING + stable recovery -> EFFECTIVE_TOLERATED');
})();

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTIVE_BUT_COSTLY — positive response, repeated recovery problems.
// ─────────────────────────────────────────────────────────────────────────────

(function testEffectiveButCostly() {
  const result = computeEffectiveness({
    performanceResponse: perf(['RESPONDING', 'RESPONDING']),
    sessionAdherence: { executionRate: 0.9 },
    recoverySensitivity: { pattern: 'DECLINES_AT_HIGHER_STRESS' }
  });
  ok(result.overall === 'EFFECTIVE_BUT_COSTLY', 'positive response + declining recovery pattern -> EFFECTIVE_BUT_COSTLY');
})();

(function testEffectiveButCostlyFromRecoveryLimitedExercises() {
  const result = computeEffectiveness({
    performanceResponse: perf(['RESPONDING', 'RESPONDING', 'RECOVERY_LIMITED']),
    sessionAdherence: { executionRate: 0.9 }
  });
  ok(result.overall === 'EFFECTIVE_BUT_COSTLY', 'positive overall response but a RECOVERY_LIMITED exercise present -> EFFECTIVE_BUT_COSTLY');
})();

// ─────────────────────────────────────────────────────────────────────────────
// TOLERATED_BUT_UNDER_RESPONDING — high adherence, adequate recovery,
// sufficient time, no progress.
// ─────────────────────────────────────────────────────────────────────────────

(function testToleratedButUnderResponding() {
  const result = computeEffectiveness({
    performanceResponse: perf(['UNDER_RESPONDING', 'UNDER_RESPONDING', 'STABLE']),
    sessionAdherence: { executionRate: 0.9 },
    recoverySensitivity: { pattern: 'STABLE_AT_CURRENT_STRESS' }
  });
  ok(result.overall === 'TOLERATED_BUT_UNDER_RESPONDING', 'high adherence + adequate recovery + majority UNDER_RESPONDING -> TOLERATED_BUT_UNDER_RESPONDING');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — low adherence + poor outcome -> DATA_INSUFFICIENT, never
// "bad program".
// ─────────────────────────────────────────────────────────────────────────────

(function testLowAdherenceNeverBlamesProgram() {
  const result = computeEffectiveness({
    performanceResponse: perf(['UNDER_RESPONDING', 'UNDER_RESPONDING']),
    sessionAdherence: { executionRate: 0.3 }
  });
  ok(result.overall === 'DATA_INSUFFICIENT', 'CORE PRINCIPLE: low adherence + poor outcome -> DATA_INSUFFICIENT, never a "bad program" conclusion');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — pain despite good progress -> SAFETY_REVIEW, not "successful".
// ─────────────────────────────────────────────────────────────────────────────

(function testPainOutranksGoodProgress() {
  const result = computeEffectiveness({
    performanceResponse: perf(['RESPONDING', 'RESPONDING', 'COACH_REVIEW']),
    sessionAdherence: { executionRate: 0.95 }
  });
  ok(result.overall === 'SAFETY_REVIEW', 'good progress overall but a COACH_REVIEW (pain) exercise present -> SAFETY_REVIEW, never labeled effective');
})();

(function testHasPainFlagOutranksEverything() {
  const result = computeEffectiveness({
    performanceResponse: perf(['RESPONDING', 'RESPONDING']),
    sessionAdherence: { executionRate: 0.95 },
    hasPain: true
  });
  ok(result.overall === 'SAFETY_REVIEW', 'an explicit hasPain signal outranks an otherwise perfect response read');
})();

// ─────────────────────────────────────────────────────────────────────────────
// INEFFECTIVE_OR_UNCLEAR — mixed signals, no clear pattern.
// ─────────────────────────────────────────────────────────────────────────────

(function testIneffectiveOrUnclear() {
  const result = computeEffectiveness({
    performanceResponse: perf(['RESPONDING', 'UNDER_RESPONDING']),
    sessionAdherence: { executionRate: 0.9 }
  });
  ok(result.overall === 'INEFFECTIVE_OR_UNCLEAR', 'no clear majority either way -> INEFFECTIVE_OR_UNCLEAR (never fabricated)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// DATA_INSUFFICIENT — nothing judgeable at all.
// ─────────────────────────────────────────────────────────────────────────────

(function testNothingJudgeableIsInsufficient() {
  const result = computeEffectiveness({
    performanceResponse: perf(['INSUFFICIENT_DATA', 'INSUFFICIENT_DATA']),
    sessionAdherence: { executionRate: 0.9 }
  });
  ok(result.overall === 'DATA_INSUFFICIENT', 'no judgeable performance response and no body-comp evidence -> DATA_INSUFFICIENT');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Confidence: the weakest link, not the strongest.
// ─────────────────────────────────────────────────────────────────────────────

(function testConfidenceIsWeakestLink() {
  const perfResponses = { 'pid-0': { classification: 'RESPONDING', confidence: 'high' }, 'pid-1': { classification: 'RESPONDING', confidence: 'low' } };
  const result = computeEffectiveness({ performanceResponse: perfResponses, sessionAdherence: { executionRate: 0.9 } });
  ok(result.confidence === 'low', 'overall confidence is the WEAKEST contributing signal (low), not the strongest (high)');
})();

console.log('');
console.log('T221 — Prescription effectiveness synthesis: ' + pass + ' assertions PASSED');
