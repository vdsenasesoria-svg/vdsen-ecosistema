'use strict';
/**
 * VDSEN — Progression-first master integration audit (T159 continuation).
 *
 * Context: a large master directive asked to make the Progression Engine
 * the ecosystem's rector axis — deterministic, reactive deload (not
 * calendar-based), PID-first identity, explainable persistence, Coach/
 * Generator consumption. Auditing the actual codebase (calculateProgression
 * in vdsen-cliente.html, _getPrevWeekData, the embedded Generator prompt in
 * vdsen-coach.html, and api/vdsen-build-request.js) found the engine is
 * ALREADY mature and covers most of the directive:
 *   - PID-first identity resolution with ambiguity guard (no silent
 *     mutation on duplicate/ambiguous prescriptionExerciseId), legacy
 *     positional fallback gated by an exerciseNameSnapshot guard.
 *   - Reactive deload (isDeload = deloadTriggers.length >= 2, based on
 *     WHO-5/RPE/sleep/HRV/energía signals) — the "last week" flag is
 *     tracked SEPARATELY and never forces deload on its own.
 *   - Trend-vs-isolated-session distinction (prevWeek/prevPrevWeek
 *     comparisons gate load/volume changes, plateau detection).
 *   - MRV-gated volume increases, independent from load/reps progression.
 *   - engineState (confidence, globalAction, deloadTriggered) already
 *     flows into the Generator's build-request contract.
 *   - Coach overrides are naturally respected: calculateProgression only
 *     writes an advisory progrec_ recommendation, never mutates the live
 *     prescription directly — the Coach decides whether to apply it.
 *
 * Two real, fixable issues were found and fixed here:
 *
 * 1. LEGACY CONFLICT (actively used): the embedded Generator system prompt
 *    (_MOTOR_PROMPT_EMBEDDED in vdsen-coach.html) and CLAUDE.md both
 *    asserted "Semana 6 = deload automático" as an authoritative rule —
 *    directly contradicting the already-implemented reactive deload engine
 *    and instructing the AI generator to treat week 6 as a guaranteed
 *    deload. Fixed: both now describe the real reactive mechanism.
 *
 * 2. PERSISTENCE GAP: the progrec_{W}_{D} recommendation objects persisted
 *    by calculateProgression did not carry prescriptionExerciseId (used
 *    internally for identity resolution but dropped before persistence),
 *    the RIR actually prescribed/observed this week (only rirTarget for
 *    the NEXT week was kept), the rep-range target, or the previous week's
 *    average reps. Fixed additively (new fields only — no existing field
 *    renamed/removed) so Coach/Generator consumers can trace a
 *    recommendation back to the exact prescribed instance and see the
 *    evidence behind it, per the "no just a text opinion, a why" goal.
 *
 * Remaining, real gap NOT fixed here (documented, out of this pass's
 * scope): api/vdsen-build-request.js does not yet pluck the newly-added
 * prescriptionExerciseId through to the Generator's per-exercise context
 * (it only forwards the aggregate engineState + raw trainingLogs) — a
 * natural Fase I follow-up once this persistence groundwork exists.
 *
 * Run: node tests/t159-progression-persistence-and-deload-legacy.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT   = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const COACH    = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLAUDEMD = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

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

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1 — legacy "week 6 = automatic deload" claim removed from the
// Generator's system prompt and from CLAUDE.md; reactive model documented.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(!COACH.includes('Semana 6 = deload automático'), 'the embedded Generator prompt must no longer assert an automatic week-6 deload');
assert.ok(!COACH.includes('semana 6 deload.'), 'the embedded Generator prompt\'s technique-periodization line must no longer name week 6 as a bare deload');
assert.ok(COACH.includes('Deload reactivo, no por calendario'), 'the embedded Generator prompt must describe the real reactive deload mechanism');
assert.ok(COACH.includes('deloadTriggers.length >= 2') === false && COACH.includes('≥2 señales reales de fatiga'), 'the prompt must describe the >=2 fatigue-signal trigger in plain language for the LLM');

assert.ok(!CLAUDEMD.includes('Semana 6 = deload automático'), 'CLAUDE.md must no longer assert an automatic week-6 deload');
assert.ok(CLAUDEMD.includes('Deload reactivo'), 'CLAUDE.md must document the reactive deload mechanism');
assert.ok(CLAUDEMD.includes('deloadTriggers.length >= 2'), 'CLAUDE.md must cite the actual trigger condition used by calculateProgression');

console.log('Legacy "week 6 = automatic deload" claim removed from Generator prompt + CLAUDE.md, reactive model documented — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the reactive deload engine itself (P6) is unchanged —
// isDeload still keyed off real signal count, isLastWeek tracked separately
// and never forces isDeload on its own.
// ─────────────────────────────────────────────────────────────────────────────

const calcProgFn = extractFunction(CLIENT, 'function calculateProgression(di, postData)');
assert.ok(calcProgFn, 'calculateProgression must exist');
// T162 refactored the inline trigger check into a shared _computeDeloadTriggers()
// helper (single source of truth, also reused by getAdjustedRIR) — the >= 2
// threshold itself is unchanged, just relocated. Verify both sides of that.
assert.ok(calcProgFn.includes('var isDeload = _deloadResult.isDeload;'), 'T159/T162 regression: calculateProgression must still derive isDeload from the shared trigger result');
const deloadTriggersFn = extractFunction(CLIENT, 'function _computeDeloadTriggers(week, postDataOverride)');
assert.ok(deloadTriggersFn && deloadTriggersFn.includes('return { triggers: triggers, isDeload: triggers.length >= 2 };'), 'T159/T162 regression: the >= 2 reactive deload trigger condition must remain unchanged inside the shared helper');
assert.ok(calcProgFn.includes('var isLastWeek = CURRENT_WEEK >= _tw2;'), 'T159 regression: isLastWeek must remain a separate, non-forcing flag');
assert.ok(
  !/isLastWeek\s*&&\s*!isDeload[\s\S]{0,40}isDeload\s*=\s*true/.test(calcProgFn),
  'T159 regression: isLastWeek must never be upgraded into a forced isDeload=true'
);

console.log('Reactive deload engine (P6) unchanged — isLastWeek never forces deload — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 — progrec_ persistence now carries identity + evidence fields
// additively (existing fields untouched).
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  calcProgFn.includes('prescriptionExerciseId: ej.prescriptionExerciseId || undefined,'),
  'T159: the persisted recommendation must carry prescriptionExerciseId (POSITION != IDENTITY)'
);
assert.ok(
  calcProgFn.includes('exerciseId: ej.exerciseId || undefined,'),
  'T159: the persisted recommendation must carry exerciseId'
);
assert.ok(
  calcProgFn.includes('prescribedRIR: rirObj,'),
  'T159: the persisted recommendation must carry the RIR objective this week was actually evaluated against'
);
assert.ok(
  calcProgFn.includes('observedRIR: _rirRaw.length ? +avgRIR.toFixed(2) : null,'),
  'T159: the persisted recommendation must carry the observed (real) average RIR, null when no real RIR was logged (never a fabricated fallback value)'
);
assert.ok(
  calcProgFn.includes('repRangeTarget: { low: repsLow, high: repsTarget },'),
  'T159: the persisted recommendation must carry the rep-range target it was evaluated against'
);
assert.ok(
  calcProgFn.includes('trend: prevWeek ? { prevLoad: prevWeek.avgLoad, prevReps: prevWeek.avgReps, prevSets: prevWeek.numSets, prevICS: prevWeek.avgICS } : null,'),
  'T159: trend must now also carry prevReps alongside the pre-existing prevLoad/prevSets/prevICS'
);

console.log('progrec_ persistence: prescriptionExerciseId/prescribedRIR/observedRIR/repRangeTarget/prevReps added additively — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression: pre-existing return fields (action, newLoad, newSets, newReps,
// rirTarget, reason, substituteExercise, setMetrics) all remain, unrenamed.
// ─────────────────────────────────────────────────────────────────────────────

['action: action,', 'newLoad: newLoad,', 'newSets: newSets,', 'newReps: newReps,',
 'rirTarget: rirTarget,', "reason: reasons.join(' | '),", 'substituteExercise: sub,']
  .forEach(function(frag) {
    assert.ok(calcProgFn.includes(frag), 'T159 regression: pre-existing field literal "' + frag + '" must remain unchanged');
  });
assert.ok(calcProgFn.includes('setMetrics: {'), 'T159 regression: setMetrics block must remain');

console.log('All pre-existing calculateProgression() return fields unchanged — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression: PID-first identity resolution in _getPrevWeekData untouched —
// ambiguity still returns null (no silent mutation), legacy name-guard intact.
// ─────────────────────────────────────────────────────────────────────────────

const getPrevWeekFn = extractFunction(CLIENT, 'function _getPrevWeekData(week, di, ei, maxSets, prescriptionExerciseId, exerciseName)');
assert.ok(getPrevWeekFn, '_getPrevWeekData must exist');
assert.ok(/if \(candidateSets\.length && Object\.keys\(positions\)\.length > 1\) \{\s*return null; \/\/ corrupt identity/.test(getPrevWeekFn), 'T159 regression: ambiguous prescriptionExerciseId across positions must still refuse to match (no silent mutation)');
assert.ok(getPrevWeekFn.includes('return null; // name mismatch → NEW_EXERCISE_REFERENCE (no incorrect history)'), 'T159 regression: legacy positional fallback name-guard must remain (prevents cross-exercise history contamination)');

console.log('_getPrevWeekData PID-first identity resolution and ambiguity/name guards unchanged — OK');

console.log('');
console.log('T159 continuation — progression persistence + deload legacy audit: ALL ASSERTIONS PASSED');
