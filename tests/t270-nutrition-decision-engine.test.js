'use strict';
/**
 * T270 — Nutrition decision engine. Executes the REAL _decideNutritionAction,
 * which combines T268 (adherence) + T269 (response) into ONE deterministic
 * REVIEW recommendation. Never mutates active nutrition -- returns a
 * recommendation + reasons only.
 *
 * Run: node tests/t270-nutrition-decision-engine.test.js
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

const src = extractFunction(COACH, 'function _decideNutritionAction(input)');
ok(src, '_decideNutritionAction extracts cleanly');
ok(COACH.includes('decide: _decideNutritionAction') && COACH.includes('ACTION: NUTRITION_ACTION'),
  'exposed via window.VDSEN_NUTRITION.decide/.ACTION');
ok(!/setDoc|updateDoc|addDoc|runTransaction/.test(src),
  '_decideNutritionAction never writes to Firestore -- a recommendation only, no automatic mutation of active nutrition');

const actionEnumSrc = extractFunction(COACH, 'var NUTRITION_ACTION = {').replace(/^var NUTRITION_ACTION = /, '');
const decide = new Function('var NUTRITION_ACTION = ' + actionEnumSrc + ';\nreturn ' + src)();

function ah(cls) { return { classification: cls }; }
function rp(cls) { return { classification: cls }; }

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — high adherence + on-target response -> KEEP.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ adherence: ah('HIGH'), response: rp('ON_TARGET') });
  ok(r.action === 'KEEP', 'CASE A: high adherence + ON_TARGET -> KEEP');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — high adherence + repeated slow response -> REVIEW_DECREASE_CALORIES
// (a review recommendation, not an automatic mutation).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ adherence: ah('HIGH'), response: rp('SLOW_RESPONSE') });
  ok(r.action === 'REVIEW_DECREASE_CALORIES', 'CASE B: high adherence + SLOW_RESPONSE -> REVIEW_DECREASE_CALORIES');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — low adherence + poor outcome -> FREEZE, NEVER a calorie change
// (Core Principle: insufficient execution evidence != "target not working").
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ adherence: ah('LOW'), response: rp('OFF_TARGET') });
  ok(r.action === 'FREEZE', 'CASE C: low adherence + OFF_TARGET -> FREEZE, not REVIEW_DECREASE_CALORIES/REVIEW_MACROS');
  ok(r.reasons.some(function(x) { return x.indexOf('adherence_low') !== -1; }), 'CASE C: the reason cites adherence, not the outcome -- never blames the calorie target under unproven execution');
}
{
  const r = decide({ adherence: ah('INSUFFICIENT_DATA'), response: rp('OFF_TARGET') });
  ok(r.action === 'FREEZE', 'CASE C variant: INSUFFICIENT_DATA adherence + OFF_TARGET -> also FREEZE, same gating');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — fast response + recovery/performance declining -> COACH_REVIEW,
// not an automatic increase. Fast response ALONE (no decline) -> REVIEW_INCREASE_CALORIES.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ adherence: ah('HIGH'), response: rp('FAST_RESPONSE'), recoveryDeclining: true });
  ok(r.action === 'COACH_REVIEW', 'CASE D: fast response + declining recovery -> COACH_REVIEW, never an automatic calorie increase');
}
{
  const r = decide({ adherence: ah('HIGH'), response: rp('FAST_RESPONSE'), recoveryDeclining: false });
  ok(r.action === 'REVIEW_INCREASE_CALORIES', 'fast response with no recovery concern -> REVIEW_INCREASE_CALORIES (a review recommendation)');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — measurement conflict -> FREEZE, no adjustment of any kind,
// outranks adherence entirely.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ adherence: ah('HIGH'), response: rp('MEASUREMENT_CONFLICT') });
  ok(r.action === 'FREEZE', 'CASE F: MEASUREMENT_CONFLICT -> FREEZE regardless of adherence -- data integrity outranks everything else');
}

// ─────────────────────────────────────────────────────────────────────────────
// No stated goal (T269's COACH_REVIEW passthrough) -> COACH_REVIEW here too.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ adherence: ah('HIGH'), response: rp('COACH_REVIEW') });
  ok(r.action === 'COACH_REVIEW', 'no stated goal -> COACH_REVIEW, never assumed/defaulted to KEEP');
}

// ─────────────────────────────────────────────────────────────────────────────
// One measurement (response INSUFFICIENT_DATA) with real adherence ->
// COACH_REVIEW, not KEEP and not a calorie change -- nothing to decide on.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ adherence: ah('HIGH'), response: rp('INSUFFICIENT_DATA') });
  ok(r.action === 'COACH_REVIEW', 'high adherence but insufficient outcome evidence -> COACH_REVIEW, deferred, not KEEP');
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIUM adherence + OFF_TARGET/SLOW_RESPONSE -> COACH_REVIEW (execution
// not fully proven -- cannot confidently blame the calorie target).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r1 = decide({ adherence: ah('MEDIUM'), response: rp('OFF_TARGET') });
  ok(r1.action === 'COACH_REVIEW', 'MEDIUM adherence + OFF_TARGET -> COACH_REVIEW, not REVIEW_MACROS (adherence not proven enough)');
  const r2 = decide({ adherence: ah('MEDIUM'), response: rp('SLOW_RESPONSE') });
  ok(r2.action === 'COACH_REVIEW', 'MEDIUM adherence + SLOW_RESPONSE -> COACH_REVIEW, not REVIEW_DECREASE_CALORIES');
}

// ─────────────────────────────────────────────────────────────────────────────
// HIGH adherence + OFF_TARGET -> REVIEW_MACROS (execution proven, outcome
// wrong direction -- a macro/structure review, not a blanket calorie cut).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ adherence: ah('HIGH'), response: rp('OFF_TARGET') });
  ok(r.action === 'REVIEW_MACROS', 'HIGH adherence + OFF_TARGET -> REVIEW_MACROS');
}

// ─────────────────────────────────────────────────────────────────────────────
// Missing input entirely -> safe INSUFFICIENT_DATA-driven FREEZE, never a
// crash or a guessed KEEP.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({});
  ok(r.action === 'FREEZE', 'missing adherence/response entirely -> defaults to INSUFFICIENT_DATA -> FREEZE, never a guessed KEEP');
}

console.log('');
console.log('T270 — Nutrition decision engine: ' + pass + ' assertions PASSED');
