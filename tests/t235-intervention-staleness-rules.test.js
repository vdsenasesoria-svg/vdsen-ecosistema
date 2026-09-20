'use strict';
/**
 * T235 — Staleness / invalidation rules: a Coach intervention invalidates
 * only automated decisions that PREDATE it AND concern the SAME scope --
 * never a global invalidation, never same-name association when a PID
 * exists. History is never deleted (append-only array); only the freshest
 * matching, non-historical entry has authority.
 *
 * Run: node tests/t235-intervention-staleness-rules.test.js
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
const activeScopeSrc = extractFunction(COACH, 'function _isInterventionActiveForScope(intervention, targetType, targetId, currentPlanId)');
const findActiveSrc  = extractFunction(COACH, 'function _findActiveIntervention(interventions, targetType, targetId, currentPlanId)');
const evidenceSrc    = extractFunction(COACH, 'function _isEvidenceNewerThanIntervention(intervention, evidenceTimestampIso)');
ok([targetEnumSrc, activeScopeSrc, findActiveSrc, evidenceSrc].every(Boolean), 'prerequisite: every T235 function extracts cleanly');

const eng = new Function(
  targetEnumSrc + ';\n' + activeScopeSrc + ';\n' + findActiveSrc + ';\n' + evidenceSrc + ';\n' +
  'return { isActiveForScope: _isInterventionActiveForScope, findActive: _findActiveIntervention, isNewer: _isEvidenceNewerThanIntervention };'
)();

ok(COACH.includes('window._findActiveIntervention = _findActiveIntervention;'), 'exposed for reuse in T237 downstream integration');
ok(COACH.includes('window._isEvidenceNewerThanIntervention = _isEvidenceNewerThanIntervention;'), 'exposed for reuse in T237 downstream integration');

function intv(overrides) {
  return Object.assign({ targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', decidedAt: '2026-02-01T00:00:00.000Z', planId: 'plan-A' }, overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope match: exact targetType/targetId only, never by name.
// ─────────────────────────────────────────────────────────────────────────────

(function testScopeMatchExact() {
  ok(eng.isActiveForScope(intv(), 'EXERCISE', 'pid-1', 'plan-A') === true, 'exact PID + plan match -> active');
  ok(eng.isActiveForScope(intv(), 'EXERCISE', 'pid-2', 'plan-A') === false, 'a different PID (even same exerciseName elsewhere) -> not active for pid-2');
  ok(eng.isActiveForScope(intv(), 'MUSCLE', 'pid-1', 'plan-A') === false, 'a different targetType -> not active, even with a matching targetId string');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — a prior mesocycle's intervention is historical, not active.
// ─────────────────────────────────────────────────────────────────────────────

(function testHistoricalMesocycle() {
  ok(eng.isActiveForScope(intv({ planId: 'plan-OLD' }), 'EXERCISE', 'pid-1', 'plan-CURRENT') === false, 'CASE H: an intervention tied to a DIFFERENT (old) plan is historical, not active authority for the current plan');
  ok(eng.isActiveForScope(intv({ planId: 'plan-CURRENT' }), 'EXERCISE', 'pid-1', 'plan-CURRENT') === true, 'the SAME plan -> still active');
})();

// CLIENT-scoped decisions are plan-independent by definition.
(function testClientScopedNeverHistorical() {
  const clientIntv = intv({ targetType: 'CLIENT', targetId: 'client-1', planId: 'plan-OLD' });
  ok(eng.isActiveForScope(clientIntv, 'CLIENT', 'client-1', 'plan-CURRENT') === true, 'a CLIENT-scoped intervention remains active across a plan/mesocycle change -- it is not plan-specific');
})();

// ─────────────────────────────────────────────────────────────────────────────
// _findActiveIntervention: freshest match wins, history never deleted.
// ─────────────────────────────────────────────────────────────────────────────

(function testFindsFreshestMatch() {
  const history = [
    intv({ id: 'a', decidedAt: '2026-01-01T00:00:00.000Z', action: 'ADJUST_LOAD' }),
    intv({ id: 'b', decidedAt: '2026-02-01T00:00:00.000Z', action: 'KEEP' }), // freshest
    intv({ id: 'c', targetId: 'pid-OTHER', decidedAt: '2026-03-01T00:00:00.000Z' }) // different scope, must not match
  ];
  const result = eng.findActive(history, 'EXERCISE', 'pid-1', 'plan-A');
  ok(result && result.id === 'b', 'the FRESHEST matching-scope intervention wins (id b), not the most recently pushed array entry overall (c, wrong scope)');
  ok(history.length === 3, 'the full history array is untouched/unfiltered by the caller -- nothing is deleted');
})();

(function testNoMatchReturnsNull() {
  ok(eng.findActive([intv({ targetId: 'pid-OTHER' })], 'EXERCISE', 'pid-1', 'plan-A') === null, 'no matching-scope intervention -> null, never a fabricated fallback');
  ok(eng.findActive([], 'EXERCISE', 'pid-1', 'plan-A') === null, 'empty history -> null');
  ok(eng.findActive(null, 'EXERCISE', 'pid-1', 'plan-A') === null, 'null history -> null, no throw');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F/G — new evidence postdating the intervention is not superseded
// by the older Coach decision.
// ─────────────────────────────────────────────────────────────────────────────

(function testNewEvidenceNotSuperseded() {
  const intervention = intv({ decidedAt: '2026-02-01T00:00:00.000Z' });
  ok(eng.isNewer(intervention, '2026-02-05T00:00:00.000Z') === true, 'CASE F/G: evidence timestamped AFTER the intervention is genuinely newer -- not erased by the older decision');
  ok(eng.isNewer(intervention, '2026-01-20T00:00:00.000Z') === false, 'evidence timestamped BEFORE the intervention is not "newer" -- the intervention already accounted for it');
  ok(eng.isNewer(intervention, null) === false, 'no evidence timestamp -> false, never assumed newer');
  ok(eng.isNewer(null, '2026-02-05T00:00:00.000Z') === false, 'no intervention at all -> false, no throw');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Never mutates/deletes anything -- pure comparison functions only.
// ─────────────────────────────────────────────────────────────────────────────

ok(!activeScopeSrc.includes('updateDoc') && !activeScopeSrc.includes('setDoc') && !activeScopeSrc.includes('.splice') && !activeScopeSrc.includes('delete '),
  '_isInterventionActiveForScope never mutates/deletes anything -- pure scope comparison');
ok(!findActiveSrc.includes('updateDoc') && !findActiveSrc.includes('setDoc') && !findActiveSrc.includes('.splice('),
  '_findActiveIntervention never mutates the history array -- selection only, history remains');

console.log('');
console.log('T235 — Staleness / invalidation rules: ' + pass + ' assertions PASSED');
