'use strict';
/**
 * T257 — Coach decision historicity. Verifies coachInterventions[] is
 * represented correctly within a historical mesociclo's time window,
 * respecting planId/targetType/targetId/decidedAt/planUpdatedAtSnapshot/
 * status, reusing T252's _buildHistoricalMesocycleView filtering (no new
 * filtering engine). Never rewrites history -- the source
 * coachInterventions[] array is read-only input throughout.
 *
 * Run: node tests/t257-coach-decision-historicity.test.js
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

const targetEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'), COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'));
const fidelitySrc   = extractFunction(COACH, 'function _classifyExerciseExecutionFidelity(setCompletionRate)');
const mapHistSrc    = extractFunction(COACH, 'function _mapExerciseProgressionHistory(progrecs)');
const viewSrc       = extractFunction(COACH, 'function _buildHistoricalMesocycleView(planId, mesoDoc, planDoc, coachInterventions)');

ok([targetEnumSrc, fidelitySrc, mapHistSrc, viewSrc].every(Boolean), 'prerequisite: all real dependencies extract cleanly');

// Confirms T234's own field is genuinely captured at decision time (T236
// wiring), not merely modeled in the type -- so it's real data to verify.
ok(COACH.includes('planUpdatedAtSnapshot: ctx.planUpdatedAt'), 'confirmed planUpdatedAtSnapshot is genuinely populated at decision time (T236), not a dead field');

// Confirms the Monitor detail view now surfaces individual decisions
// (targetType/action/status/decidedAt), not just a bare count.
ok(COACH.includes("_escH(d.targetType || '?') + ' · ' + _escH(d.action || '?') + ' · ' + _escH(d.status || '?')"), 'each historical Coach decision is rendered with its real targetType/action/status/decidedAt, not just a count');

function makeEngine() {
  const fakeWindow = { VDSEN_BUILD: { _mapExerciseProgressionHistory: new Function(fidelitySrc + ';\n' + mapHistSrc + '; return _mapExerciseProgressionHistory;')() } };
  return new Function('window', targetEnumSrc + ';\n' + viewSrc + ';\nreturn _buildHistoricalMesocycleView;')(fakeWindow);
}
const build = makeEngine();

function intv(overrides) {
  return Object.assign({ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', status: 'RESOLVED', decidedAt: '2026-01-15T00:00:00.000Z', planId: 'plan-A', planUpdatedAtSnapshot: '2026-01-10T00:00:00.000Z' }, overrides);
}

const mesoDoc = { currentWeek: 4, updatedAt: Date.parse('2026-02-01T00:00:00.000Z'), entries: {
  'postsession_1_0': { ts: Date.parse('2026-01-01T00:00:00.000Z') }
} };

// ─────────────────────────────────────────────────────────────────────────────
// All 6 required fields survive intact into coachDecisions -- never
// stripped, never rewritten.
// ─────────────────────────────────────────────────────────────────────────────

(function testAllFieldsPreserved() {
  const original = intv({});
  const result = build('plan-A', mesoDoc, null, [original]);
  ok(result.coachDecisions.length === 1, 'the EXERCISE/planId-exact decision is attributed to this mesociclo');
  const d = result.coachDecisions[0];
  ok(d.planId === 'plan-A' && d.targetType === 'EXERCISE' && d.targetId === 'pid-1' && d.decidedAt === '2026-01-15T00:00:00.000Z' && d.planUpdatedAtSnapshot === '2026-01-10T00:00:00.000Z' && d.status === 'RESOLVED',
    'all 6 required fields (planId/targetType/targetId/decidedAt/planUpdatedAtSnapshot/status) survive completely unmodified');
  ok(d === original, 'the exact same object reference is returned (a filter, not a rebuild) -- provenance is never reconstructed or paraphrased');
})();

// ─────────────────────────────────────────────────────────────────────────────
// planId-exact scoping for EXERCISE/MUSCLE/MESOCYCLE -- a decision from a
// DIFFERENT plan is never attributed here, however plausible its targetId.
// ─────────────────────────────────────────────────────────────────────────────

(function testPlanIdExactScoping() {
  ['EXERCISE', 'MUSCLE', 'MESOCYCLE'].forEach(function(scope) {
    const wrongPlan = intv({ targetType: scope, planId: 'plan-DIFFERENT' });
    const result = build('plan-A', mesoDoc, null, [wrongPlan]);
    ok(result.coachDecisions.length === 0, scope + '-scoped decision from a DIFFERENT plan is never attributed to this mesociclo');
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-scope: temporal-window-only, never a structural planId claim
// (T235's own contract -- CLIENT decisions have no planId to match against
// in the first place).
// ─────────────────────────────────────────────────────────────────────────────

(function testClientScopeTemporalOnly() {
  const withinWindow = intv({ targetType: 'CLIENT', targetId: 'client-1', planId: null, decidedAt: '2026-01-10T00:00:00.000Z' });
  const beforeWindow = intv({ targetType: 'CLIENT', targetId: 'client-1', planId: null, decidedAt: '2025-01-01T00:00:00.000Z' });
  const afterWindow  = intv({ targetType: 'CLIENT', targetId: 'client-1', planId: null, decidedAt: '2026-03-01T00:00:00.000Z' });
  const result = build('plan-A', mesoDoc, null, [withinWindow, beforeWindow, afterWindow]);
  ok(result.coachDecisions.length === 1 && result.coachDecisions[0].decidedAt === '2026-01-10T00:00:00.000Z',
    'exactly the CLIENT-scope decision decided WITHIN this mesociclo\'s real [startedAt,endedAt] window is included -- before/after are correctly excluded, never a structural "belongs to this plan" claim');
})();

// ─────────────────────────────────────────────────────────────────────────────
// No window available (no real evidence at all) -> CLIENT-scope decisions
// are conservatively excluded rather than guessed included.
// ─────────────────────────────────────────────────────────────────────────────

(function testClientScopeConservativeWithoutWindow() {
  const clientIntv = intv({ targetType: 'CLIENT', targetId: 'client-1', planId: null, decidedAt: '2026-01-10T00:00:00.000Z' });
  const emptyMeso = { currentWeek: null, updatedAt: null, entries: {} };
  const result = build('plan-empty', emptyMeso, null, [clientIntv]);
  ok(result.coachDecisions.length === 0, 'without a real startedAt/endedAt window (no evidence at all in this mesociclo), a CLIENT-scope decision is conservatively excluded rather than guessed as belonging here');
})();

// ─────────────────────────────────────────────────────────────────────────────
// History is never rewritten: the ORIGINAL coachInterventions array (and
// each object within it) is completely untouched by building the view.
// ─────────────────────────────────────────────────────────────────────────────

(function testNeverMutatesHistory() {
  const original = intv({});
  const frozenCopy = JSON.parse(JSON.stringify(original));
  const list = [original];
  build('plan-A', mesoDoc, null, list);
  ok(JSON.stringify(original) === JSON.stringify(frozenCopy), 'the intervention record itself is byte-identical after building the historical view -- never mutated');
  ok(list.length === 1 && list[0] === original, 'the source array is never spliced/filtered in place -- the original list of interventions is fully intact');
})();

console.log('');
console.log('T257 — Coach decision historicity: ' + pass + ' assertions PASSED');
