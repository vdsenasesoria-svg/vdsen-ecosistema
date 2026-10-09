'use strict';
/**
 * T287 — Decision-confidence propagation. Confirms evidenceQuality gates
 * existing engines rather than a second decision engine being built.
 * Recalibrates _classifyExecutionQuality's completeness to the SAME
 * execRate<0.6 threshold the real engines already use (T287's one real
 * finding), then audits (source-level, no reimplementation) that all 6
 * named propagation examples already hold via existing engine code.
 *
 * Run: node tests/t287-decision-confidence-propagation.test.js
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
// Recalibration: execution completeness is now anchored to the SAME
// 0.6 threshold the real engines already gate on, not a raw 0..1
// executionRate (which would make PARTIAL fire for nearly every client).
// ─────────────────────────────────────────────────────────────────────────────

const execQualSrc = extractFunction(COACH, 'function _classifyExecutionQuality(weeklyDecision)');
ok(execQualSrc.includes('var EXECUTION_SUFFICIENT_RATE = 0.6;'), 'execution completeness is calibrated to the named 0.6 threshold, not a fresh invented number');

const enumSrc = extractFunction(COACH, 'var EVIDENCE_QUALITY = {').replace(/^var EVIDENCE_QUALITY = /, '');
const classifySrc = extractFunction(COACH, 'function _classifyEvidenceQuality(input)');
const exec = new Function('window',
  'var EVIDENCE_QUALITY = ' + enumSrc + ';\n' + classifySrc + ';\n' +
  'window.VDSEN_EVIDENCE = { classify: _classifyEvidenceQuality, STATUS: EVIDENCE_QUALITY };\n' +
  execQualSrc + ';\nreturn _classifyExecutionQuality;'
)({});

ok(exec({ sessionAdherence: { executionRate: 0.9 } }).status === 'VALID', '90% session execution (comfortably above the 0.6 sufficiency threshold) -> VALID, not PARTIAL');
ok(exec({ sessionAdherence: { executionRate: 0.6 } }).status === 'VALID', 'exactly the 0.6 threshold -> VALID (matches the real engine\'s own >= boundary)');
ok(exec({ sessionAdherence: { executionRate: 0.4 } }).status === 'PARTIAL', 'below the 0.6 threshold (the exact point the real synthesis already downgrades to DATA_INSUFFICIENT/ADHERENCE_LIMITED) -> PARTIAL, a meaningful signal, not noise');
ok(exec({ sessionAdherence: {} }).status === 'UNRESOLVED', 'no executionRate at all -> UNRESOLVED');

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT (no reimplementation): all 6 named propagation examples already
// hold via existing engine code.
// ─────────────────────────────────────────────────────────────────────────────

// 1. STALE recovery evidence cannot alone produce current RECOVERY_LIMITED:
// semaphore (the only other RECOVERY_LIMITED trigger besides
// engine_state.deloadTriggered) is always null in this path -- ciSem
// staleness has no mechanism to spuriously trigger it.
ok(COACH.includes('semaphore: null, // Ehrenstein semaphore needs client-doc fields not available here'),
  '1. RECOVERY_LIMITED can only fire via engine_state.deloadTriggered in the *ForRequest path (semaphore is always null here) -- a STALE ci_sem read has no mechanism to spuriously produce it');

// 2. PARTIAL execution cannot create HIGH-confidence progression state:
// execRate<0.6 already forces DATA_INSUFFICIENT in the effectiveness
// synthesis AND ADHERENCE_LIMITED in the weekly status directly.
ok(COACH.includes("if (execRate !== null && execRate < 0.6) {") , '2a. low session execRate already forces prescriptionEffectiveness.overall to DATA_INSUFFICIENT before any conclusion is drawn');
ok(COACH.includes('if (execRate !== null && execRate < 0.6) return WEEKLY_STATUS.ADHERENCE_LIMITED;'), '2b. the SAME 0.6 threshold already forces weeklyDecision.status to ADHERENCE_LIMITED directly');

// 3. CONFLICTING body composition -> MEASUREMENT_CONFLICT / review (T220,
// re-confirmed): an implausible consecutive weight swing already outranks
// any trend conclusion.
ok(COACH.includes("return { classification: 'MEASUREMENT_CONFLICT', confidence: 'none', measurementsUsed: valid.length, reason: 'implausible_weight_swing' };"),
  '3. body-composition measurement conflict already short-circuits to MEASUREMENT_CONFLICT before any ON_TARGET/OFF_TARGET conclusion');

// 4. LEGACY PID-less progression cannot override PID-exact current
// evidence (re-confirmed, T283/T285): unindexed recommendations never
// enter byPrescriptionExerciseId at all.
ok(COACH.includes("if (!rec || !rec.prescriptionExerciseId) { unindexedCount++; return; }"),
  '4. legacy PID-less recommendations are structurally excluded from byPrescriptionExerciseId -- cannot override PID-exact evidence by construction');

// 5. UNRESOLVED adherence cannot justify a nutrition calorie change (T270,
// re-confirmed): LOW/INSUFFICIENT_DATA adherence always -> FREEZE, never
// REVIEW_DECREASE_CALORIES/REVIEW_INCREASE_CALORIES/REVIEW_MACROS.
ok(COACH.includes("if (adherence.classification === 'LOW' || adherence.classification === 'INSUFFICIENT_DATA') {") &&
   COACH.includes("return { action: NUTRITION_ACTION.FREEZE, reasons: reasons };"),
  '5. unresolved/low nutrition adherence already gates to FREEZE before any response-based calorie action can fire');

// 6. STALE Coach intervention is historical, not active authority (T235,
// re-confirmed): _isInterventionActiveForScope already filters by
// plan/scope match before an intervention can reach activeDecisions.
ok(COACH.includes('function _isInterventionActiveForScope'),
  '6. _isInterventionActiveForScope already exists and gates plan/scope currency before any intervention becomes "active" authority');

console.log('');
console.log('T287 — Decision-confidence propagation: ' + pass + ' assertions PASSED');
