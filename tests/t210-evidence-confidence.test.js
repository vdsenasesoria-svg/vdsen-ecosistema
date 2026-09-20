'use strict';
/**
 * T210 — Evidence accumulation / confidence: one deterministic rule for
 * when longitudinal evidence becomes trustworthy, reused by T211
 * (volume tolerance), T212 (exercise/pattern tolerance) and T213
 * (recovery sensitivity). Reuses the EXACT formula already shipped in
 * T205's _mapExerciseProgressionHistory confidence fix -- no new
 * statistical/Bayesian model, per the ticket's own instruction.
 *
 * Run: node tests/t210-evidence-confidence.test.js
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

const src = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
ok(src, '_computeEvidenceConfidence extracts cleanly');
const _computeEvidenceConfidence = new Function('return ' + src)();

ok(COACH.includes('computeConfidence: _computeEvidenceConfidence'), 'exposed via window.VDSEN_LEARNED for T211-213 reuse');

// ─────────────────────────────────────────────────────────────────────────────
// Rule: NONE/LOW/MEDIUM/HIGH tiers, count-based.
// ─────────────────────────────────────────────────────────────────────────────

(function testTiersByCount() {
  ok(_computeEvidenceConfidence([]) === 'none', 'zero observations -> none');
  ok(_computeEvidenceConfidence([1]) === 'low', 'one observation -> low');
  ok(_computeEvidenceConfidence([1, 1]) === 'low', 'two observations -> low');
  ok(_computeEvidenceConfidence([1, 1, 1]) === 'medium', 'three observations -> medium');
  ok(_computeEvidenceConfidence([1, 1, 1, 1]) === 'medium', 'four observations -> medium');
  ok(_computeEvidenceConfidence([1, 1, 1, 1, 1]) === 'high', 'five observations -> high');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rule: one exposure can never be HIGH, regardless of quality.
// ─────────────────────────────────────────────────────────────────────────────

(function testOneExposureNeverHigh() {
  ok(_computeEvidenceConfidence([1]) !== 'high', 'a single, perfect observation still cannot be HIGH');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rule: poor adherence/quality cannot produce HIGH confidence, even with
// many exposures.
// ─────────────────────────────────────────────────────────────────────────────

(function testPoorQualityCapsHigh() {
  const many = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3];
  ok(_computeEvidenceConfidence(many) === 'low', 'six low-quality (30%) observations still cap at low, never high from count alone');

  const medium = [0.6, 0.6, 0.6, 0.6, 0.6];
  ok(_computeEvidenceConfidence(medium) === 'medium', 'five medium-quality (60%) observations cap at medium, not high');

  const good = [0.9, 0.9, 0.9, 0.9, 0.9];
  ok(_computeEvidenceConfidence(good) === 'high', 'five genuinely high-quality observations DO reach high');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rule: malformed/partial data lowers confidence.
// ─────────────────────────────────────────────────────────────────────────────

(function testMalformedDataLowersConfidence() {
  const clean = [0.95, 0.95, 0.95, 0.95, 0.95];
  ok(_computeEvidenceConfidence(clean, 0) === 'high', 'sanity: 5 clean high-quality observations -> high with zero malformed');
  ok(_computeEvidenceConfidence(clean, 6) === 'low', 'the SAME 5 clean observations, but 6 malformed exposures alongside them (more unusable than usable) -> capped to low, unreliable tracking');
  ok(_computeEvidenceConfidence(clean, 2) === 'high', 'a MINORITY of malformed exposures (2 of 7 total) does not cap a genuinely strong clean record');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rule: repeated valid observations increase confidence (monotonic in n,
// holding quality constant).
// ─────────────────────────────────────────────────────────────────────────────

(function testRepeatedObservationsIncreaseConfidence() {
  const order = ['none', 'low', 'medium', 'high'];
  const rank = t => order.indexOf(t);
  let prev = _computeEvidenceConfidence([]);
  [1, 2, 3, 4, 5].forEach(n => {
    const cur = _computeEvidenceConfidence(new Array(n).fill(0.9));
    ok(rank(cur) >= rank(prev), 'confidence never decreases as more good-quality observations accumulate (n=' + n + ': ' + prev + ' -> ' + cur + ')');
    prev = cur;
  });
})();

console.log('');
console.log('T210 — Evidence confidence: ' + pass + ' assertions PASSED');
