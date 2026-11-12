'use strict';
/**
 * T246 — Prescription identity contract. T245 found NO real identity
 * fragmentation: `prescriptionExerciseId` (PID), minted via
 * crypto.randomUUID() and matched EXACT-ONLY everywhere in the chain
 * (_findActiveIntervention, _mapExerciseProgressionHistory,
 * _getLatestEvidenceTimestampForScope, _isRecommendationSupersededByIntervention),
 * already answers "which exact prescription produced this evidence?"
 * conservatively (null/excluded when absent, never guessed by name or
 * position). Per "antes de crear una nueva abstracción, busca una
 * existente": NO new _resolvePrescriptionIdentity function is built here
 * -- this file is the CONTRACT TEST proving the existing mechanism
 * already satisfies every required scenario.
 *
 * Required scenarios (all against REAL, unmodified functions):
 *   - same name, different PID -> no bleed
 *   - exercise reordered within a plan -> identity unaffected (index-free)
 *   - different week -> still resolves by PID, aggregated correctly
 *   - new plan -> historical (plan-scoped), per T235's CASE H
 *   - legacy log (positional log_* entry) -> never enters PID-identity path at all
 *   - legacy data without a PID -> excluded/unindexed, never guessed
 *   - session started before a new activation -> plan-scope boundary holds
 *
 * Run: node tests/t246-prescription-identity-contract.test.js
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

const targetEnumSrc  = COACH.slice(COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'), COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'));
const activeScopeSrc = extractFunction(COACH, 'function _isInterventionActiveForScope(intervention, targetType, targetId, currentPlanId)');
const findActiveSrc  = extractFunction(COACH, 'function _findActiveIntervention(interventions, targetType, targetId, currentPlanId)');
const timestampSrc   = extractFunction(COACH, 'function _getLatestEvidenceTimestampForScope(targetType, targetId, entries, planDoc, clientDoc)');
const mapHistSrc     = extractFunction(COACH, 'function _mapExerciseProgressionHistory(progrecs)');
const canonicalSrc   = "var _classifyExerciseExecutionFidelity = function(){ return 'HIGH'; };"; // stub, unused by identity paths but referenced by mapHistSrc

ok([targetEnumSrc, activeScopeSrc, findActiveSrc, timestampSrc, mapHistSrc].every(Boolean), 'prerequisite: every real identity-relevant function extracts cleanly -- no new abstraction needed for this contract');

const eng = new Function(
  targetEnumSrc + ';\n' + activeScopeSrc + ';\n' + findActiveSrc + ';\n' + timestampSrc + ';\n' + canonicalSrc + ';\n' + mapHistSrc + ';\n' +
  'var _EXERCISE_CANONICAL_METADATA = {};\n' +
  'return { findActive: _findActiveIntervention, getEvidenceTs: _getLatestEvidenceTimestampForScope, mapHistory: _mapExerciseProgressionHistory };'
)();

function intv(targetType, targetId, decidedAt, planId) {
  return { targetType: targetType, targetId: targetId, action: 'KEEP', status: 'RESOLVED', decidedAt: decidedAt, planId: planId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Same name, different PID -> no bleed (across every identity-relevant fn).
// ─────────────────────────────────────────────────────────────────────────────

(function testSameNameDifferentPid() {
  const interventions = [intv('EXERCISE', 'pid-OLD', '2026-01-01T00:00:00.000Z', 'plan-A')];
  ok(eng.findActive(interventions, 'EXERCISE', 'pid-NEW', 'plan-A') === null, 'a re-prescribed exercise sharing the OLD exercise\'s NAME but a NEW PID never inherits the old intervention');

  const entries = { 'progrec_1_0': { calculatedAt: '2026-02-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-NEW', exerciseName: 'Sentadilla' }] } };
  ok(eng.getEvidenceTs('EXERCISE', 'pid-OLD', entries, null, null) === null, 'evidence for the NEW pid (same exercise name) is never attributed to the OLD pid\'s evidence timestamp');

  const progrecs = { progrec_1_0: { recommendations: [{ prescriptionExerciseId: 'pid-OLD', exerciseName: 'Sentadilla' }, { prescriptionExerciseId: 'pid-NEW', exerciseName: 'Sentadilla' }] } };
  const hist = eng.mapHistory(progrecs).byPrescriptionExerciseId;
  ok(hist['pid-OLD'] && hist['pid-NEW'] && hist['pid-OLD'] !== hist['pid-NEW'], 'progressionHistory keeps two identically-named exercises under two DISTINCT PID entries -- never merged by name');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Exercise reordered within a plan -> identity is index-free.
// ─────────────────────────────────────────────────────────────────────────────

(function testReordered() {
  // The SAME recommendation set, in reverse array order -- identity resolution
  // must be entirely unaffected, since nothing here ever reads array index.
  const forward = { progrec_1_0: { recommendations: [{ prescriptionExerciseId: 'pid-A' }, { prescriptionExerciseId: 'pid-B' }] } };
  const reversed = { progrec_1_0: { recommendations: [{ prescriptionExerciseId: 'pid-B' }, { prescriptionExerciseId: 'pid-A' }] } };
  const histForward = eng.mapHistory(forward).byPrescriptionExerciseId;
  const histReversed = eng.mapHistory(reversed).byPrescriptionExerciseId;
  ok(Object.keys(histForward).sort().join(',') === Object.keys(histReversed).sort().join(','), 'reordering exercises within the SAME recommendation batch produces the identical set of PID-keyed history entries');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Different week -> still resolves by PID, aggregated across weeks.
// ─────────────────────────────────────────────────────────────────────────────

(function testDifferentWeek() {
  const entries = {
    'progrec_1_0': { calculatedAt: '2026-01-10T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1' }] },
    'progrec_4_0': { calculatedAt: '2026-02-10T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1' }] }
  };
  ok(eng.getEvidenceTs('EXERCISE', 'pid-1', entries, null, null) === '2026-02-10T00:00:00.000Z', 'evidence across DIFFERENT weeks for the SAME pid correctly resolves to the freshest, by PID alone -- week number is not part of identity');
})();

// ─────────────────────────────────────────────────────────────────────────────
// New plan -> historical (T235's CASE H, re-confirmed here as an identity
// contract property, not just a staleness property).
// ─────────────────────────────────────────────────────────────────────────────

(function testNewPlanHistorical() {
  const interventions = [intv('EXERCISE', 'pid-1', '2025-01-01T00:00:00.000Z', 'plan-OLD')];
  ok(eng.findActive(interventions, 'EXERCISE', 'pid-1', 'plan-NEW') === null, 'the SAME PID under a NEW plan does not inherit a DIFFERENT plan\'s intervention -- identity is PID+plan-scope together, not PID alone');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Legacy log (positional log_{W}_{D}_{E}_s{S} entry) never enters any
// PID-identity path -- confirmed by construction (the regexes below only
// ever match progrec_/postsession_/ci_sem_, never log_).
// ─────────────────────────────────────────────────────────────────────────────

(function testLegacyPositionalLogNeverConsulted() {
  const entries = {
    'log_1_0_0_s0': { carga: 80, reps: 8, ts: Date.now(), rir_real: 2 }, // positional, no PID at all
    'progrec_1_0':  { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1' }] }
  };
  ok(eng.getEvidenceTs('EXERCISE', 'pid-1', entries, null, null) === '2026-01-01T00:00:00.000Z', 'a positional per-set log entry alongside a real progrec entry never corrupts or contributes to the PID-scoped evidence timestamp -- only progrec.calculatedAt is ever read for EXERCISE scope');
  ok(eng.getEvidenceTs('EXERCISE', 'pid-DOES-NOT-EXIST-IN-ANY-LOG', entries, null, null) === null, 'a PID with no progrec entry never falls back to guessing from a positional log entry');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Legacy data without a PID -> excluded (unindexedCount), never guessed.
// ─────────────────────────────────────────────────────────────────────────────

(function testLegacyNoPid() {
  const progrecs = { progrec_1_0: { recommendations: [{ exerciseName: 'Sentadilla vieja sin PID' /* no prescriptionExerciseId at all -- pre-T159 legacy shape */ }] } };
  const result = eng.mapHistory(progrecs);
  ok(Object.keys(result.byPrescriptionExerciseId).length === 0, 'a legacy recommendation with no prescriptionExerciseId is never assigned a fabricated identity');
  ok(result.unindexedCount === 1, 'it is explicitly counted as unindexed instead -- ambiguous legacy data stays explicitly ambiguous, never silently misattributed');

  const entries = { 'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ exerciseName: 'Sentadilla vieja sin PID' }] } };
  ok(eng.getEvidenceTs('EXERCISE', 'pid-1', entries, null, null) === null, 'a legacy PID-less recommendation never matches ANY real PID lookup, however plausible the exercise name looks');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Session started before a new activation -> plan-scope boundary holds.
// A PID whose evidence/intervention predates a plan switch must not be
// readable as "current" once currentPlanId moves on -- identity alone
// (PID) is never sufficient without the plan-scope check.
// ─────────────────────────────────────────────────────────────────────────────

(function testSessionBeforeNewActivation() {
  // Client started a session (and the Coach separately KEEP'd this PID)
  // while plan-A was active; the Coach then activates plan-B mid-flow.
  const interventions = [intv('EXERCISE', 'pid-1', '2026-01-15T00:00:00.000Z', 'plan-A')];
  ok(eng.findActive(interventions, 'EXERCISE', 'pid-1', 'plan-A') !== null, 'while plan-A is still current, the session-time decision for pid-1 is correctly active');
  ok(eng.findActive(interventions, 'EXERCISE', 'pid-1', 'plan-B') === null, 'the instant the Coach activates plan-B, that SAME pid-1 decision stops being current authority -- the boundary is enforced by plan-scope, not by when the session happened to start');
})();

console.log('');
console.log('T246 — Prescription identity contract: ' + pass + ' assertions PASSED (no new abstraction needed)');
