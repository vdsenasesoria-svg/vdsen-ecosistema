'use strict';
/**
 * T244 — Post-generation output continuity check (P1 fix): T237/T238 give
 * the Generator's PROMPT explicit instructions to honor a Coach's RESOLVED
 * KEEP decision, but nothing deterministic ever verified the LLM's OUTPUT
 * actually complied -- authority could silently be lost between Coach ->
 * Generator -> new plan with zero visibility. _checkCoachInterventionContinuity
 * closes that gap the same way the existing _checkResponseConsistency
 * (audit vs plan shape) already does: a pure, additive, NON-BLOCKING
 * output check surfaced in the Plan Preview modal. It never recomputes
 * intervention/staleness logic (that's already resolved in
 * coachInterventionContext) and never auto-fixes/blocks anything -- the
 * Coach decides.
 *
 * Run: node tests/t244-generator-output-continuity-check.test.js
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

const fnSrc = extractFunction(COACH, 'function _checkCoachInterventionContinuity(req, rawPlan)');
const normalizePlanSrc  = extractFunction(COACH, 'function _normalizePlan(p)');
const normalizeTrainSrc = extractFunction(COACH, 'function _normalizeTraining(t)');
const normalizeNutrSrc  = extractFunction(COACH, 'function _normalizeNutrition(n)');
const normalizeSupplSrc = extractFunction(COACH, 'function _normalizeSupplementation(s)');
const normalizeSrc = [normalizeTrainSrc, normalizeNutrSrc, normalizeSupplSrc, normalizePlanSrc].join(';\n');
ok(fnSrc, '_checkCoachInterventionContinuity extracts cleanly');
ok([normalizePlanSrc, normalizeTrainSrc, normalizeNutrSrc, normalizeSupplSrc].every(Boolean), '_normalizePlan and its 3 dependencies extract cleanly');

ok(!fnSrc.includes('updateDoc') && !fnSrc.includes('setDoc'), 'never writes to Firestore -- pure read/check');
ok(!fnSrc.includes('_findActiveIntervention') && !fnSrc.includes('_isEvidenceNewerThanIntervention') && !fnSrc.includes('_isRecommendationSupersededByIntervention'),
  'never recomputes intervention/staleness logic itself -- reads the ALREADY-resolved coachInterventionContext.resolvedItems only, no second engine');

// Wiring: called in the preview flow, rendered non-blockingly, never gates
// save/activation.
ok(COACH.includes('const interventionContinuityIssues = _checkCoachInterventionContinuity(req, rawPlan);'), 'wired into _vdsenAIShowPreview alongside the existing consistency check');
ok(COACH.includes('⚠️ Decisión del Coach no reflejada en el nuevo plan.'), 'surfaced as its own clearly-labeled banner in the Plan Preview modal (reuses the exact established auditHtml banner pattern)');
ok(!/if\s*\(\s*interventionContinuityIssues\.length\s*\)\s*\{\s*return/.test(COACH), 'the check never early-returns/blocks the preview or save flow -- advisory only');

const eng = new Function(normalizeSrc + ';\n' + fnSrc + ';\nreturn _checkCoachInterventionContinuity;')();

// ─────────────────────────────────────────────────────────────────────────────
// No coachInterventionContext / no resolvedItems -> silently clean, never
// a fabricated warning.
// ─────────────────────────────────────────────────────────────────────────────

(function testNoContextIsClean() {
  ok(eng(null, {}).length === 0, 'no req at all -> no issues');
  ok(eng({}, {}).length === 0, 'req present but no coachInterventionContext -> no issues');
  ok(eng({ coachInterventionContext: { resolvedItems: [] } }, {}).length === 0, 'empty resolvedItems -> no issues');
})();

// ─────────────────────────────────────────────────────────────────────────────
// A KEEP'd PID that IS still in the plan -> no issue.
// ─────────────────────────────────────────────────────────────────────────────

(function testKeptPidPresent() {
  const req = { coachInterventionContext: { resolvedItems: [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP' }] } };
  const rawPlan = { entrenamiento: { days: [{ exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-1' }] }] } };
  ok(eng(req, rawPlan).length === 0, 'the KEEP\'d PID is present in the generated plan -- no continuity issue');
})();

// ─────────────────────────────────────────────────────────────────────────────
// A KEEP'd PID that is MISSING from the new plan -> flagged.
// ─────────────────────────────────────────────────────────────────────────────

(function testKeptPidMissing() {
  const req = { coachInterventionContext: { resolvedItems: [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP' }] } };
  const rawPlan = { entrenamiento: { days: [{ exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-2' }] }] } };
  const issues = eng(req, rawPlan);
  ok(issues.length === 1 && issues[0].indexOf('pid-1') !== -1, 'a KEEP\'d PID missing from the new plan is flagged, naming the exact PID');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Only EXERCISE/KEEP resolvedItems are checked -- MUSCLE/CLIENT-scoped or
// non-KEEP resolved decisions are out of this check's scope (a muscle or
// whole-client decision isn't a single PID to look for in the plan).
// ─────────────────────────────────────────────────────────────────────────────

(function testOnlyExerciseKeepChecked() {
  const req = { coachInterventionContext: { resolvedItems: [
    { targetType: 'MUSCLE', targetId: 'quads', action: 'KEEP' },
    { targetType: 'EXERCISE', targetId: 'pid-3', action: 'ADJUST_LOAD' } // not KEEP -- Coach already changed it, not "keep as-is"
  ] } };
  const rawPlan = { entrenamiento: { days: [] } };
  ok(eng(req, rawPlan).length === 0, 'MUSCLE-scoped and non-KEEP EXERCISE decisions are not checked for PID presence -- out of scope for this specific continuity check');
})();

// ─────────────────────────────────────────────────────────────────────────────
// activeDecisions (REVIEWED, not resolved) are never checked -- only
// resolvedItems are binding enough to warrant a continuity flag.
// ─────────────────────────────────────────────────────────────────────────────

(function testActiveDecisionsNeverChecked() {
  const req = { coachInterventionContext: { resolvedItems: [], activeDecisions: [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP' }] } };
  const rawPlan = { entrenamiento: { days: [{ exercises: [{ exerciseName: 'X', prescriptionExerciseId: 'pid-OTHER' }] }] } };
  ok(eng(req, rawPlan).length === 0, 'a REVIEWED-but-not-resolved KEEP is never treated as a binding continuity requirement (matches T238\'s reviewed-vs-resolved distinction)');
})();

console.log('');
console.log('T244 — Generator output continuity check: ' + pass + ' assertions PASSED');
