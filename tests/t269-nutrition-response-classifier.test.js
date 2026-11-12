'use strict';
/**
 * T269 — Nutrition response classifier. Executes the REAL
 * _classifyNutritionResponse, which wraps T220's _classifyBodyCompositionResponse
 * (reused verbatim, no second outcome engine) and only adds a weekly-rate
 * refinement (SLOW_RESPONSE/FAST_RESPONSE) on top of an already-ON_TARGET
 * directional read for a déficit/superávit goal.
 *
 * Run: node tests/t269-nutrition-response-classifier.test.js
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

const evidenceSrc   = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const outcomeConfSrc = extractFunction(COACH, 'function _computeOutcomeConfidence(measurements, options)');
const bodyCompSrc    = extractFunction(COACH, 'function _classifyBodyCompositionResponse(inbodyResults, objetivoCalorico)');
const responseSrc    = extractFunction(COACH, 'function _classifyNutritionResponse(inbodyResults, objetivoCalorico)');

ok([evidenceSrc, outcomeConfSrc, bodyCompSrc, responseSrc].every(Boolean), 'all 4 real dependent functions extract cleanly');
ok(COACH.includes('classifyResponse: _classifyNutritionResponse'), 'exposed via window.VDSEN_NUTRITION.classifyResponse');

const classify = new Function(
  evidenceSrc + ';\n' + outcomeConfSrc + ';\n' + bodyCompSrc + ';\n' + responseSrc + ';\n' +
  'return _classifyNutritionResponse;'
)();

const DAY = 86400000;
const NOW = Date.now();
function inb(weeksAgo, peso, extra) { return Object.assign({ ts: NOW - weeksAgo * 7 * DAY, peso: peso }, extra || {}); }

// ─────────────────────────────────────────────────────────────────────────────
// One measurement -> INSUFFICIENT_DATA (passthrough from T220 unchanged).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify([inb(0, 80)], 'déficit');
  ok(r.classification === 'INSUFFICIENT_DATA', 'a single InBody measurement -> INSUFFICIENT_DATA, never a rate guess');
}

// ─────────────────────────────────────────────────────────────────────────────
// Implausible consecutive swing -> MEASUREMENT_CONFLICT (passthrough).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify([inb(1, 80), inb(0, 90)], 'déficit');
  ok(r.classification === 'MEASUREMENT_CONFLICT', 'an implausible weight swing -> MEASUREMENT_CONFLICT, passthrough from T220, never a rate computed on noise');
}

// ─────────────────────────────────────────────────────────────────────────────
// No stated goal -> COACH_REVIEW (passthrough).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify([inb(8, 80), inb(4, 79), inb(0, 78)], null);
  ok(r.classification === 'COACH_REVIEW', 'no stated goal -> COACH_REVIEW, passthrough, never assumed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrong-direction outcome -> OFF_TARGET (passthrough, no rate refinement
// applied to an already-wrong-direction result).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify([inb(6, 80), inb(3, 81), inb(0, 82)], 'déficit'); // gained weight on a cut
  ok(r.classification === 'OFF_TARGET', 'weight gained on a déficit goal -> OFF_TARGET, no rate refinement applied');
}

// ─────────────────────────────────────────────────────────────────────────────
// Déficit, on-pace rate (~0.6%/week) -> ON_TARGET (refined, not just passed
// through as T220's own ON_TARGET).
// ─────────────────────────────────────────────────────────────────────────────
{
  // 80kg -> 6 weeks -> lose ~0.6%/week = ~2.88kg total
  const r = classify([inb(6, 80), inb(3, 78.55), inb(0, 77.1)], 'déficit');
  ok(r.classification === 'ON_TARGET' && typeof r.ratePctPerWeek === 'number', 'déficit at ~0.6%BW/week -> ON_TARGET with a computed rate');
}

// ─────────────────────────────────────────────────────────────────────────────
// Déficit, too-slow rate (~0.1%/week over 8 weeks, adequate time) ->
// SLOW_RESPONSE.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify([inb(8, 80, { pbf: 20 }), inb(4, 79.68, { pbf: 19.95 }), inb(0, 79.36, { pbf: 19.9 })], 'déficit'); // ~0.1%/week
  ok(r.classification === 'SLOW_RESPONSE', 'déficit moving correct direction but far too slowly over 8 weeks -> SLOW_RESPONSE');
}

// ─────────────────────────────────────────────────────────────────────────────
// Déficit, too-fast rate (~2%/week) -> FAST_RESPONSE.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify([inb(4, 80), inb(2, 76.8), inb(0, 73.6)], 'déficit'); // 8% over 4 weeks = 2%/week
  ok(r.classification === 'FAST_RESPONSE', 'déficit losing ~2%BW/week -> FAST_RESPONSE (too fast, not automatically \"better\")');
}

// ─────────────────────────────────────────────────────────────────────────────
// Superávit, on-pace rate -> ON_TARGET; superávit too fast -> FAST_RESPONSE.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rOk = classify([inb(6, 75), inb(3, 75.675), inb(0, 76.35)], 'superávit'); // ~0.3%/week
  ok(rOk.classification === 'ON_TARGET', 'superávit at ~0.3%BW/week -> ON_TARGET');
  const rFast = classify([inb(4, 75), inb(2, 76.575), inb(0, 78.15)], 'superávit'); // ~1.05%/week
  ok(rFast.classification === 'FAST_RESPONSE', 'superávit gaining ~1%BW/week -> FAST_RESPONSE (rapid gain, not automatically desirable)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Recomposition (mantenimiento): weight stable, composition improving ->
// ON_TARGET, never rate-refined (no directional axis for this goal).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify([inb(6, 75, { pbf: 18, smm: 34 }), inb(3, 75.1, { pbf: 17.25, smm: 34.4 }), inb(0, 75.2, { pbf: 16.5, smm: 34.8 })], 'mantenimiento');
  ok(r.classification === 'ON_TARGET' && r.ratePctPerWeek === undefined, 'recomposition (weight stable, pbf down, smm up) -> ON_TARGET, never given a fabricated rate axis');
}

console.log('');
console.log('T269 — Nutrition response classifier: ' + pass + ' assertions PASSED');
