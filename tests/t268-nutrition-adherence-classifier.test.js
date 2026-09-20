'use strict';
/**
 * T268 — Nutrition adherence classifier. Executes the REAL
 * _classifyNutritionAdherence against real-shaped nutrilog_* entries vs
 * a nutritionRaw target. HIGH/MEDIUM/LOW/INSUFFICIENT_DATA only --
 * never inferred from bodyweight (that input is never even accepted).
 *
 * Run: node tests/t268-nutrition-adherence-classifier.test.js
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

const src = extractFunction(COACH, 'function _classifyNutritionAdherence(nutrilogEntries, targets, options)');
ok(src, '_classifyNutritionAdherence extracts cleanly');
ok(COACH.includes('window.VDSEN_NUTRITION = {') && COACH.includes('classifyAdherence: _classifyNutritionAdherence'),
  'exposed via window.VDSEN_NUTRITION.classifyAdherence, the same cross-script-block pattern as VDSEN_OUTCOME/VDSEN_ADHERENCE');

const classify = new Function('return ' + src)();

function day(offsetDays, kcal, prot, nowTs) {
  return { kcal: kcal, prot: prot, ts: nowTs - offsetDays * 86400000 };
}

const NOW = Date.now();
const TARGETS = { calorias: 2200, proteina: 180 };

// ─────────────────────────────────────────────────────────────────────────────
// No log data at all -> INSUFFICIENT_DATA (never fake precision).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify([], TARGETS);
  ok(r.classification === 'INSUFFICIENT_DATA' && r.daysLogged === 0, 'zero logged days -> INSUFFICIENT_DATA');
}

// ─────────────────────────────────────────────────────────────────────────────
// Only 1-2 days logged -> still INSUFFICIENT_DATA (below minDays=3).
// ─────────────────────────────────────────────────────────────────────────────
{
  const entries = [day(0, 2200, 180, NOW), day(1, 2150, 175, NOW)];
  const r = classify(entries, TARGETS);
  ok(r.classification === 'INSUFFICIENT_DATA' && r.daysLogged === 2, 'only 2 logged days (below minDays) -> INSUFFICIENT_DATA, not a guessed HIGH/LOW');
}

// ─────────────────────────────────────────────────────────────────────────────
// No real target (calorias missing/0) -> INSUFFICIENT_DATA even with
// plenty of logged days -- never compares against a fabricated target.
// ─────────────────────────────────────────────────────────────────────────────
{
  const entries = [0,1,2,3,4].map(function(i) { return day(i, 2200, 180, NOW); });
  const r = classify(entries, { calorias: 0 });
  ok(r.classification === 'INSUFFICIENT_DATA', 'no real calorie target to compare against -> INSUFFICIENT_DATA, never a fabricated comparison');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 days, tight to target on both kcal and protein -> HIGH.
// ─────────────────────────────────────────────────────────────────────────────
{
  const entries = [0,1,2,3,4].map(function(i) { return day(i, 2200 + (i % 2 === 0 ? 50 : -50), 185, NOW); });
  const r = classify(entries, TARGETS);
  ok(r.classification === 'HIGH' && r.daysLogged === 5, 'tight adherence to both kcal and protein across 5 days -> HIGH');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 days, moderately off (kcal ~25% over, protein ~70%) -> MEDIUM.
// ─────────────────────────────────────────────────────────────────────────────
{
  const entries = [0,1,2,3,4].map(function(i) { return day(i, 2750, 130, NOW); });
  const r = classify(entries, TARGETS);
  ok(r.classification === 'MEDIUM', 'moderate deviation (kcal +25%, protein ~72%) -> MEDIUM, not HIGH');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 days, way off target -> LOW.
// ─────────────────────────────────────────────────────────────────────────────
{
  const entries = [0,1,2,3,4].map(function(i) { return day(i, 3400, 90, NOW); });
  const r = classify(entries, TARGETS);
  ok(r.classification === 'LOW', 'large deviation (kcal +55%, protein 50%) -> LOW');
}

// ─────────────────────────────────────────────────────────────────────────────
// Old entries outside the 7-day window are excluded -- only current
// adherence is judged, not stale history.
// ─────────────────────────────────────────────────────────────────────────────
{
  const entries = [0,1,2].map(function(i) { return day(i, 2200, 180, NOW); }) // recent, high
    .concat([20,21,22,23,24].map(function(i) { return day(i, 3400, 90, NOW); })); // old, bad -- must be excluded
  const r = classify(entries, TARGETS);
  ok(r.daysLogged === 3, 'entries older than the 7-day window are excluded from the count');
  ok(r.classification === 'INSUFFICIENT_DATA' || r.classification === 'HIGH', 'the stale, out-of-window bad days never drag down a currently-tight adherence read');
}

// ─────────────────────────────────────────────────────────────────────────────
// The classifier's signature never accepts a bodyweight/InBody argument --
// structurally cannot infer adherence from body composition (Core
// Principle), confirmed by extracted source itself.
// ─────────────────────────────────────────────────────────────────────────────
ok(!src.includes('inbodyResults') && !src.includes('.peso') && !src.includes('ci_sem'),
  'the classifier never references inbodyResults/peso/ci_sem -- adherence is judged ONLY from nutrilog macro-logging, never from bodyweight (Core Principle)');

console.log('');
console.log('T268 — Nutrition adherence classifier: ' + pass + ' assertions PASSED');
