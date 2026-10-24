'use strict';
/**
 * T220 — Body-composition response classification: ON_TARGET/
 * PARTIAL_RESPONSE/OFF_TARGET/INSUFFICIENT_DATA/MEASUREMENT_CONFLICT/
 * COACH_REVIEW. A response classifier, not a medical diagnosis.
 *
 * Uses ONLY clients/{uid}.inbodyResults[] (fotometria/photo-estimates are
 * a different measurement method, deliberately not cross-referenced here)
 * and the stated goal (objetivo_calorico) -- never invented when absent.
 * No missing metric is guessed; T218's outcome confidence gates the whole
 * classification.
 *
 * Run: node tests/t220-body-composition-response.test.js
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

const confSrc    = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const outcomeSrc = extractFunction(COACH, 'function _computeOutcomeConfidence(measurements, options)');
const bodyCompSrc = extractFunction(COACH, 'function _classifyBodyCompositionResponse(inbodyResults, objetivoCalorico)');
ok(confSrc && outcomeSrc && bodyCompSrc, 'prerequisite: _classifyBodyCompositionResponse and its dependencies extract cleanly');
const computeBodyCompositionResponse = new Function(confSrc + ';\n' + outcomeSrc + ';\n' + bodyCompSrc + ';\nreturn _classifyBodyCompositionResponse;')();

ok(COACH.includes('computeBodyCompositionResponse: _classifyBodyCompositionResponse'), 'exposed via window.VDSEN_OUTCOME for T221/T222 reuse');

const DAY = 86400000;
function r(dayOffset, fields) { return Object.assign({ ts: dayOffset * DAY }, fields); }

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — one measurement -> INSUFFICIENT_DATA.
// ─────────────────────────────────────────────────────────────────────────────

(function testOneMeasurementInsufficient() {
  const result = computeBodyCompositionResponse([r(0, { peso: 80 })], 'déficit');
  ok(result.classification === 'INSUFFICIENT_DATA', 'a single body-composition measurement -> INSUFFICIENT_DATA, no strong conclusion drawn');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — multiple consistent measurements, goal moving correctly ->
// ON_TARGET with real confidence.
// ─────────────────────────────────────────────────────────────────────────────

(function testOnTargetDeficit() {
  const results = [
    r(0, { peso: 82, smm: 34, pbf: 22 }),
    r(20, { peso: 80.5, smm: 34.2, pbf: 20.5 }),
    r(40, { peso: 79, smm: 34.5, pbf: 19 }),
    r(60, { peso: 78, smm: 34.6, pbf: 18 })
  ];
  const result = computeBodyCompositionResponse(results, 'déficit');
  ok(result.classification === 'ON_TARGET', 'weight down, PBF down, SMM preserved, on a déficit goal -> ON_TARGET (got: ' + result.classification + ')');
  ok(result.confidence !== 'none' && result.confidence !== 'low', 'appropriate real confidence with 4 well-spaced measurements');
})();

(function testOnTargetSurplus() {
  const results = [
    r(0, { peso: 70, smm: 30 }),
    r(20, { peso: 71.5, smm: 30.8 }),
    r(40, { peso: 73, smm: 31.5 })
  ];
  const result = computeBodyCompositionResponse(results, 'superávit');
  ok(result.classification === 'ON_TARGET', 'weight up, SMM up, on a superávit goal -> ON_TARGET');
})();

// ─────────────────────────────────────────────────────────────────────────────
// OFF_TARGET / PARTIAL_RESPONSE — goal not moving correctly.
// ─────────────────────────────────────────────────────────────────────────────

(function testOffTarget() {
  const results = [
    r(0, { peso: 80, smm: 34, pbf: 20 }),
    r(20, { peso: 82, smm: 33.5, pbf: 22 }),
    r(40, { peso: 84, smm: 33, pbf: 24 })
  ];
  const result = computeBodyCompositionResponse(results, 'déficit');
  ok(result.classification === 'OFF_TARGET', 'weight up, PBF up, SMM down, on a déficit goal -> OFF_TARGET (got: ' + result.classification + ')');
})();

(function testPartialResponse() {
  const results = [
    r(0, { peso: 80, pbf: 22 }),
    r(20, { peso: 79, pbf: 22.5 }), // weight down (met) but PBF not down (not met)
    r(40, { peso: 78, pbf: 23 })
  ];
  const result = computeBodyCompositionResponse(results, 'déficit');
  ok(result.classification === 'PARTIAL_RESPONSE', 'weight moving correctly but PBF not -> PARTIAL_RESPONSE (got: ' + result.classification + ')');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — measurement conflict: an implausible consecutive weight swing.
// ─────────────────────────────────────────────────────────────────────────────

(function testMeasurementConflict() {
  const results = [r(0, { peso: 80 }), r(3, { peso: 74 })]; // -6kg in 3 days
  const result = computeBodyCompositionResponse(results, 'déficit');
  ok(result.classification === 'MEASUREMENT_CONFLICT', 'a 6kg swing in 3 days is physiologically implausible -> MEASUREMENT_CONFLICT, not taken as a real trend');
})();

(function testPlausibleSwingIsNotConflict() {
  const results = [r(0, { peso: 80 }), r(3, { peso: 79.5 }), r(20, { peso: 78 }), r(40, { peso: 77 })]; // realistic pace
  const result = computeBodyCompositionResponse(results, 'déficit');
  ok(result.classification !== 'MEASUREMENT_CONFLICT', 'a realistic-pace weight change is never flagged as a conflict');
})();

// ─────────────────────────────────────────────────────────────────────────────
// No goal stated -> COACH_REVIEW, never assumed.
// ─────────────────────────────────────────────────────────────────────────────

(function testNoGoalStatedIsCoachReview() {
  const results = [r(0, { peso: 80 }), r(20, { peso: 78 }), r(40, { peso: 76 })];
  const result = computeBodyCompositionResponse(results, undefined);
  ok(result.classification === 'COACH_REVIEW', 'no stated objetivo_calorico -> COACH_REVIEW, the direction is never assumed');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Do not invent missing metrics -- SMM/PBF simply drop out when absent,
// never fabricated.
// ─────────────────────────────────────────────────────────────────────────────

(function testMissingMetricsNeverInvented() {
  const results = [r(0, { peso: 80 }), r(20, { peso: 78 }), r(40, { peso: 76 })]; // no smm/pbf at all
  const result = computeBodyCompositionResponse(results, 'déficit');
  ok(result.deltas.smm === null && result.deltas.pbf === null, 'missing smm/pbf report as null deltas, never a fabricated number');
  ok(result.classification === 'ON_TARGET', 'classification still works from the one real metric available (peso)');
})();

console.log('');
console.log('T220 — Body-composition response classification: ' + pass + ' assertions PASSED');
