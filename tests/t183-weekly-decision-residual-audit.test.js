'use strict';
/**
 * T183 — Residual audit of the new weekly decision chain (DATA ->
 * CLASSIFICATION -> VOLUME DECISION -> COACH MONITOR -> GENERATOR CONTEXT).
 *
 * FINDING #1 (P2, fixed): the Coach Monitor's T179 wiring used
 * entries.engine_state directly (a single, non-week-scoped key) alongside
 * THIS week's ci_sem_/postsession_ data, without checking whether
 * engine_state.weekNum actually matches the week being displayed
 * (currentWeek). If a client had already advanced to a new week without a
 * fresh calc yet, the classification would blend a stale week's
 * exerciseSummary/confidence/deloadTriggered with the current week's
 * check-in — a "missing week scoping" bug, the exact class of issue this
 * audit was told to check for. T181's Generator-context version
 * (_computeWeeklyDecisionForRequest) was already correct — it derives its
 * own target week FROM engine_state.weekNum rather than trusting an
 * external currentWeek, so ci_sem_/postsessions are always pulled for the
 * SAME week engine_state reflects. Fixed the Monitor side to match: only
 * trust engine_state for this week's classification when its own weekNum
 * stamp agrees with currentWeek; otherwise treat it as unavailable rather
 * than blending mismatched weeks.
 *
 * No other P0/P1/P2 found in this pass:
 *   - DATA: progrec_/engine_state/postsession_/ci_sem_ contracts unchanged,
 *     no new mismatch (T176's expedientes/ finding was already documented,
 *     not built on).
 *   - CLASSIFICATION/VOLUME: every threshold reused (confidence, 0.5
 *     majority split, ICS>=7, articularPain.present) — none invented.
 *   - COACH MONITOR: fixed above.
 *   - GENERATOR CONTEXT: already correctly week-scoped; additive-only,
 *     explicit prompt guardrails against safety override/re-derivation/
 *     auto-escalation (T181).
 *   - Legacy generation path (autoGeneratePlan) does not receive
 *     weeklyDecision at all — consistent with T173's already-accepted
 *     demotion of that path (it also lacks progressionHistory); not a new
 *     gap introduced by this ticket.
 *
 * Run: node tests/t183-weekly-decision-residual-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

ok(COACH.includes('const _wsEs = (_wsEsRaw && _wsEsRaw.weekNum && _wsEsRaw.weekNum !== currentWeek) ? null : _wsEsRaw;'),
  'Coach Monitor: engine_state is only trusted for this week\'s classification when its own weekNum stamp matches currentWeek');

// Behavioral: reimplement the exact guard expression against synthetic data.
function resolveEngineStateForWeek(esRaw, currentWeek) {
  return (esRaw && esRaw.weekNum && esRaw.weekNum !== currentWeek) ? null : esRaw;
}

(function testMismatchedWeekIgnored() {
  const staleEs = { weekNum: 3, confidence: 'high', exerciseSummary: [{ action: 'increase_load' }] };
  const resolved = resolveEngineStateForWeek(staleEs, 5); // client already on week 5, engine_state still reflects week 3
  ok(resolved === null, 'a week-mismatched engine_state is treated as unavailable, never blended with the current week\'s check-in data');
})();

(function testMatchedWeekUsed() {
  const freshEs = { weekNum: 5, confidence: 'high', exerciseSummary: [{ action: 'increase_load' }] };
  const resolved = resolveEngineStateForWeek(freshEs, 5);
  ok(resolved === freshEs, 'a week-matched engine_state is used as-is (no regression to the normal case)');
})();

(function testMissingWeekNumTreatedAsUsable() {
  // Legacy engine_state written before weekNum existed — no weekNum to
  // mismatch against, so it's still used (matches T177's own legacy stance:
  // "legacy without PID: safe fallback only where already supported").
  const legacyEs = { confidence: 'medium', exerciseSummary: [] };
  const resolved = resolveEngineStateForWeek(legacyEs, 5);
  ok(resolved === legacyEs, 'legacy engine_state with no weekNum at all is still used (nothing to compare against, not treated as a mismatch)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Generator-context regression: already correctly week-scoped, verify unchanged.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("var week = es && es.weekNum;") && COACH.includes("var ciSem = week ? (entries['ci_sem_' + week] || null) : null;"),
  'regression: _computeWeeklyDecisionForRequest (Generator context, T181) still derives its target week FROM engine_state.weekNum, not an external currentWeek — was already correct, unaffected by this fix');

console.log('');
console.log('T183 — Weekly decision chain residual audit: ' + pass + ' assertions PASSED');
