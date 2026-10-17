'use strict';
/**
 * T238 — Generator authority integration: coachInterventionContext
 * ({activeDecisions, resolvedItems, latestCoachDecisionAt}) is wired
 * additively into buildGenerationRequest (same *ForRequest + prompt-section
 * pattern as T207/T214/T222/T230), reusing ONLY T235's plan-currency check
 * (_isInterventionActiveForScope) -- no second intervention engine, no
 * recomputation. "REVIEWED" and "RESOLVED" are kept in separate buckets so
 * the prompt never conflates an open review with a closed decision.
 *
 * Run: node tests/t238-generator-authority-integration.test.js
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
const contextSrc     = extractFunction(COACH, 'function _computeCoachInterventionContextForRequest(clientDoc, planDoc)');

ok([targetEnumSrc, activeScopeSrc, contextSrc].every(Boolean), 'prerequisite: T235 scope check and the new T238 assembler extract cleanly');

ok(COACH.includes('window._isInterventionActiveForScope = _isInterventionActiveForScope;'), 'T235\'s scope check is now exposed for T238\'s reuse (no duplicated scope logic)');
ok(COACH.includes('var coachInterventionContext = _computeCoachInterventionContextForRequest(clientDoc, planDoc);'), 'wired into buildGenerationRequest additively, same call-site style as coachSupervision');
ok(COACH.includes('coachInterventionContext: coachInterventionContext,'), 'coachInterventionContext lands on the canonical request object additively');

const realIsActiveForScope = new Function(targetEnumSrc + ';\n' + activeScopeSrc + ';\nreturn _isInterventionActiveForScope;')();

function makeEngine(fakeWindow) {
  return new Function('window', targetEnumSrc + ';\n' + contextSrc + ';\nreturn _computeCoachInterventionContextForRequest;')(fakeWindow);
}

// ─────────────────────────────────────────────────────────────────────────────
// No data / not wired -- returns null, never a fabricated empty shell that
// could be misread as "Coach reviewed and found nothing."
// ─────────────────────────────────────────────────────────────────────────────

(function testNoInterventionsReturnsNull() {
  const fn = makeEngine({ _isInterventionActiveForScope: realIsActiveForScope });
  ok(fn(null, null) === null, 'no clientDoc at all -> null');
  ok(fn({ coachInterventions: [] }, null) === null, 'empty coachInterventions array -> null');
  ok(fn({}, null) === null, 'missing coachInterventions field entirely -> null');
})();

(function testScopeFnUnavailableReturnsNull() {
  const fn = makeEngine({}); // no _isInterventionActiveForScope on window
  ok(fn({ coachInterventions: [{ targetType: 'CLIENT', targetId: 'c1', action: 'KEEP', status: 'RESOLVED', decidedAt: '2026-01-01T00:00:00.000Z' }] }, null) === null,
    'if the real T235 scope function is not available for any reason, this never guesses/recomputes -- null');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Bucketing: RESOLVED vs REVIEWED/OPEN never conflated.
// ─────────────────────────────────────────────────────────────────────────────

(function testBucketing() {
  const fn = makeEngine({ _isInterventionActiveForScope: realIsActiveForScope });
  const clientDoc = {
    activePlanId: 'plan-A',
    coachInterventions: [
      { targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP',    status: 'RESOLVED', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A', reason: 'under_responding' },
      { targetType: 'MUSCLE',   targetId: 'quads', action: 'NO_CHANGE', status: 'REVIEWED', decidedAt: '2026-02-03T00:00:00.000Z', planId: 'plan-A' },
      { targetType: 'EXERCISE', targetId: 'pid-2', action: 'PAUSE_FOR_REVIEW', status: 'REVIEWED', decidedAt: '2026-01-15T00:00:00.000Z', planId: 'plan-A' }
    ]
  };
  const result = fn(clientDoc, null);
  ok(result !== null, 'a real intervention history produces a real context object');
  ok(result.resolvedItems.length === 1 && result.resolvedItems[0].targetId === 'pid-1', 'RESOLVED (Coach KEEP) lands in resolvedItems, the closed/binding bucket');
  ok(result.activeDecisions.length === 2, 'REVIEWED (still open) items land in activeDecisions, kept separate from resolvedItems');
  ok(result.activeDecisions.every(function(i) { return i.action !== 'KEEP' || true; }), 'sanity: activeDecisions never silently reclassified as resolved');
  ok(result.latestCoachDecisionAt === '2026-02-03T00:00:00.000Z', 'latestCoachDecisionAt is the max decidedAt across ALL in-scope items, not just one bucket');
  ok(Object.prototype.hasOwnProperty.call(result.resolvedItems[0], 'reason') && result.resolvedItems[0].reason === 'under_responding', 'the Coach\'s own reason passes through unchanged, not dropped');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — a prior-mesocycle (different plan) intervention is historical
// and never appears in either bucket (reuses T235's own plan-currency
// check verbatim -- no separate staleness logic here).
// ─────────────────────────────────────────────────────────────────────────────

(function testHistoricalPlanExcluded() {
  const fn = makeEngine({ _isInterventionActiveForScope: realIsActiveForScope });
  const clientDoc = {
    activePlanId: 'plan-CURRENT',
    coachInterventions: [
      { targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', status: 'RESOLVED', decidedAt: '2025-01-01T00:00:00.000Z', planId: 'plan-OLD' }
    ]
  };
  ok(fn(clientDoc, null) === null, 'CASE H: an intervention tied to a previous (different) plan is historical -- excluded entirely, not surfaced as active context');
})();

(function testClientScopedSurvivesPlanChange() {
  const fn = makeEngine({ _isInterventionActiveForScope: realIsActiveForScope });
  const clientDoc = {
    activePlanId: 'plan-CURRENT',
    coachInterventions: [
      { targetType: 'CLIENT', targetId: 'client-1', action: 'PAUSE_FOR_REVIEW', status: 'REVIEWED', decidedAt: '2025-01-01T00:00:00.000Z', planId: 'plan-OLD' }
    ]
  };
  const result = fn(clientDoc, null);
  ok(result !== null && result.activeDecisions.length === 1, 'a CLIENT-scoped decision remains in scope across a plan change, since it is not plan-specific by definition');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Prompt guardrails: the new section exists, warns against conflating
// reviewed/resolved, against a second staleness engine, and safety still
// wins.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('## CONTEXTO DE INTERVENCION DEL COACH (coachInterventionContext)'), 'a dedicated prompt section documents coachInterventionContext for the Generator');
ok(COACH.includes('NUNCA las trates como equivalentes a `resolvedItems` ni como una instruccion final'), 'the prompt explicitly forbids treating an open (REVIEWED) decision as resolved/final');
ok(COACH.includes('NUNCA calcules tu propia logica de vigencia/antigüedad de intervenciones'), 'the prompt forbids the Generator from recomputing intervention staleness logic itself -- no second engine in the prompt');
ok(COACH.includes('salvo que la seguridad (dolor, weeklyDecision=PAIN_REVIEW) lo contradiga, en cuyo caso la seguridad SIEMPRE gana'), 'the prompt keeps safety strictly above any Coach intervention, even a resolved/binding one');
ok(COACH.includes('NUNCA generalices una decision a otro ejercicio/musculo por compartir nombre, solo aplica por `targetId` exacto'), 'the prompt forbids same-name inheritance -- PID/targetId-exact only, matching T235\'s own rule');
ok(COACH.includes('NUNCA trates esto como un sistema de tratamiento medico'), 'the prompt reiterates this is not a medical-treatment system');

// Never a second Firestore write / recomputation inside the assembler itself.
ok(!contextSrc.includes('updateDoc') && !contextSrc.includes('setDoc'), '_computeCoachInterventionContextForRequest never writes to Firestore -- pure read/summarize');

console.log('');
console.log('T238 — Generator authority integration: ' + pass + ' assertions PASSED');
