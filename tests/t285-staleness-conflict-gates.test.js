'use strict';
/**
 * T285 — Staleness and conflict gates. Executes the REAL 4 domain gate
 * functions against real T284 classification, and confirms (source-level,
 * no reimplementation) that the progression-edit-staleness gate (CASE B)
 * already exists inline in _computeWeeklyDecisionForRequest.
 *
 * Run: node tests/t285-staleness-conflict-gates.test.js
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

const enumSrc = extractFunction(COACH, 'var EVIDENCE_QUALITY = {').replace(/^var EVIDENCE_QUALITY = /, '');
const classifySrc = extractFunction(COACH, 'function _classifyEvidenceQuality(input)');
const legacyQualSrc = extractFunction(COACH, 'function _classifyProgressionLegacyQuality(progressionHistory)');
const checkinQualSrc = extractFunction(COACH, 'function _classifyWeeklyCheckinQuality(logsDoc, entries)');
const nutrQualSrc = extractFunction(COACH, 'function _classifyNutritionAdherenceQuality(nutritionDecision)');
const bodyQualSrc = extractFunction(COACH, 'function _classifyBodyCompositionQuality(prescriptionEffectiveness)');

[classifySrc, legacyQualSrc, checkinQualSrc, nutrQualSrc, bodyQualSrc].forEach(function(s) {
  ok(!!s, 'prerequisite: all 4 real gate functions + the T284 classifier extract cleanly');
});

function makeWindow() {
  return new Function('window',
    'var EVIDENCE_QUALITY = ' + enumSrc + ';\n' + classifySrc + ';\n' +
    'window.VDSEN_EVIDENCE = { classify: _classifyEvidenceQuality, STATUS: EVIDENCE_QUALITY };\n' +
    legacyQualSrc + ';\n' + checkinQualSrc + ';\n' + nutrQualSrc + ';\n' + bodyQualSrc + ';\n' +
    'return { legacy: _classifyProgressionLegacyQuality, checkin: _classifyWeeklyCheckinQuality, nutrition: _classifyNutritionAdherenceQuality, bodyComp: _classifyBodyCompositionQuality };'
  )({});
}
const g = makeWindow();

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 1 gate: progression legacy quality.
// ─────────────────────────────────────────────────────────────────────────────
{
  ok(g.legacy({ byPrescriptionExerciseId: {}, unindexedCount: 0 }).status === 'UNRESOLVED', 'no progression evidence at all -> UNRESOLVED');
  ok(g.legacy({ byPrescriptionExerciseId: { 'pid-1': {} }, unindexedCount: 0 }).status === 'VALID', 'clean PID-indexed evidence, no legacy noise -> VALID');
  ok(g.legacy({ byPrescriptionExerciseId: { 'pid-1': {} }, unindexedCount: 2 }).status === 'LEGACY', 'CASE F: legacy PID-less recommendations mixed in with valid PID data -> flagged LEGACY (surfaced, never silently dropped, never allowed to override the PID-exact data)');
}

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 2 gate: weekly check-in quality (CASE C / CASE I).
// ─────────────────────────────────────────────────────────────────────────────
{
  const missing = g.checkin({ currentWeek: 5 }, {});
  ok(missing.status === 'UNRESOLVED', 'CASE I: no ci_sem_5 at all for the canonical current week -> UNRESOLVED, never "recovery good" by default');

  const stale = g.checkin({ currentWeek: 5 }, { 'ci_sem_5': { peso: 80 }, engine_state: { weekNum: 4 } });
  ok(stale.status === 'STALE', 'CASE C: a real check-in exists, but the engine\'s own last-computed week (4) lags the canonical current week (5) -> STALE for the current weekly decision');

  const valid = g.checkin({ currentWeek: 5 }, { 'ci_sem_5': { peso: 80 }, engine_state: { weekNum: 5 } });
  ok(valid.status === 'VALID', 'check-in present and engine week matches the canonical current week -> VALID');
}

// ─────────────────────────────────────────────────────────────────────────────
// Nutrition adherence completeness gate (CASE E).
// ─────────────────────────────────────────────────────────────────────────────
{
  const insufficientDaysZero = g.nutrition({ adherence: { classification: 'INSUFFICIENT_DATA', daysLogged: 0, windowDays: 7 } });
  ok(insufficientDaysZero.status === 'UNRESOLVED', 'zero nutrilog days at all -> UNRESOLVED');

  const oneOfSeven = g.nutrition({ adherence: { classification: 'INSUFFICIENT_DATA', daysLogged: 1, windowDays: 7 } });
  ok(oneOfSeven.status === 'PARTIAL' && Math.abs(oneOfSeven.completeness - 1 / 3) < 1e-9, 'CASE E: 1 logged day (below T268\'s own minDays=3 threshold) -> PARTIAL with a real completeness fraction, not UNRESOLVED and not a fabricated calorie adjustment basis');

  const full = g.nutrition({ adherence: { classification: 'HIGH', daysLogged: 5, windowDays: 7 } });
  ok(full.status === 'VALID', '5+ of 7 days logged (T268\'s own real classification threshold) -> VALID');
}

// ─────────────────────────────────────────────────────────────────────────────
// Body-composition conflict gate (CASE D).
// ─────────────────────────────────────────────────────────────────────────────
{
  const none = g.bodyComp({ bodyCompositionResponse: { classification: 'INSUFFICIENT_DATA', measurementsUsed: 0 } });
  ok(none.status === 'UNRESOLVED', 'no usable InBody measurements -> UNRESOLVED');

  const conflict = g.bodyComp({ bodyCompositionResponse: { classification: 'MEASUREMENT_CONFLICT', measurementsUsed: 2 } });
  ok(conflict.status === 'CONFLICTING', 'CASE D: method-incompatible/implausible measurements -> CONFLICTING, never a confident nutrition adjustment basis');

  const onTarget = g.bodyComp({ bodyCompositionResponse: { classification: 'ON_TARGET', measurementsUsed: 3 } });
  ok(onTarget.status === 'VALID', 'a real, non-conflicting body-composition read -> VALID');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE B (already exists, not reimplemented): a progrec predating a Coach
// plan edit already routes to COACH_REVIEW via reviewCount, never
// "automatically applied" as current.
// ─────────────────────────────────────────────────────────────────────────────
{
  ok(COACH.includes('var editStale = !!(planDoc && planDoc.updatedAt && entry.calculatedAt && Date.parse(planDoc.updatedAt) > Date.parse(entry.calculatedAt));'),
    'CASE B confirmed already handled: a progrec whose calculatedAt predates the plan\'s own updatedAt is flagged editStale');
  ok(COACH.includes('if (idStale || editStale) reviewItems.push(r.exerciseName || \'ejercicio sin nombre\');'),
    'CASE B confirmed: an editStale (or idStale) recommendation is pushed into reviewItems, which drives weeklyStatus to COACH_REVIEW (T177) -- never silently/automatically applied as current');
}

console.log('');
console.log('T285 — Staleness and conflict gates: ' + pass + ' assertions PASSED');
