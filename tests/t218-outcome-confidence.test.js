'use strict';
/**
 * T218 — Goal-response confidence: one deterministic NONE/LOW/MEDIUM/HIGH
 * rule for outcome observations, reused by T219 (performance response) and
 * T220 (body-composition response). Builds on T210's shared count+quality
 * rule and adds two outcome-specific gates: measurement-method consistency
 * and time-horizon sufficiency.
 *
 * Run: node tests/t218-outcome-confidence.test.js
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
ok(confSrc && outcomeSrc, 'prerequisite: _computeOutcomeConfidence and its T210 dependency extract cleanly');
const _computeOutcomeConfidence = new Function(confSrc + ';\n' + outcomeSrc + ';\nreturn _computeOutcomeConfidence;')();

ok(COACH.includes('computeConfidence: _computeOutcomeConfidence'), 'exposed via window.VDSEN_OUTCOME for T219/T220 reuse');

const DAY = 86400000;
function m(ts, opts) { return Object.assign({ ts: ts }, opts || {}); }

// ─────────────────────────────────────────────────────────────────────────────
// Rule: one measurement never HIGH.
// ─────────────────────────────────────────────────────────────────────────────

(function testOneMeasurementNeverHigh() {
  ok(_computeOutcomeConfidence([m(0)]) !== 'high', 'a single measurement can never be HIGH');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rule: low adherence (qualityWeight) reduces confidence.
// ─────────────────────────────────────────────────────────────────────────────

(function testLowAdherenceReducesConfidence() {
  const goodMeasurements = [0, 20, 40, 60, 80].map(d => m(d * DAY, { qualityWeight: 0.9 }));
  ok(_computeOutcomeConfidence(goodMeasurements) === 'high', 'sanity: 5 well-spaced, high-quality measurements -> high');

  const poorMeasurements = [0, 20, 40, 60, 80].map(d => m(d * DAY, { qualityWeight: 0.2 }));
  ok(_computeOutcomeConfidence(poorMeasurements) === 'low', 'the SAME 5 measurements, but low adherence/quality behind them -> capped at low');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rule: different measurement methods reduce confidence.
// ─────────────────────────────────────────────────────────────────────────────

(function testMixedMethodsReduceConfidence() {
  const consistent = [0, 20, 40, 60, 80].map(d => m(d * DAY, { qualityWeight: 1, method: 'inbody' }));
  ok(_computeOutcomeConfidence(consistent) === 'high', 'sanity: 5 measurements, all the SAME method -> high');

  const mixed = [0, 20, 40, 60, 80].map((d, i) => m(d * DAY, { qualityWeight: 1, method: i % 2 === 0 ? 'inbody' : 'photo' }));
  ok(_computeOutcomeConfidence(mixed) === 'medium', 'the SAME 5 measurements, but mixing InBody and photo-estimated methods -> downgraded to medium, never silently trusted as high');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rule: insufficient time horizon -> LOW/NONE regardless of count/quality.
// ─────────────────────────────────────────────────────────────────────────────

(function testInsufficientTimeHorizon() {
  // 5 measurements but all crammed into 3 days -- real count, but no real
  // time for the body/performance to actually change.
  const crammed = [0, 0.5, 1, 2, 3].map(d => m(d * DAY, { qualityWeight: 1 }));
  ok(_computeOutcomeConfidence(crammed) === 'low', 'insufficient time horizon (3 days span) caps confidence at low, even with 5 high-quality observations');

  const properSpan = [0, 20, 40, 60, 80].map(d => m(d * DAY, { qualityWeight: 1 }));
  ok(_computeOutcomeConfidence(properSpan) === 'high', 'a real time span (80 days) does not get penalized');
})();

(function testCustomMinDays() {
  const shortSpan = [0, 1, 2, 3, 5].map(d => m(d * DAY, { qualityWeight: 1 })); // 5 measurements, high count+quality tier, 5-day span
  ok(_computeOutcomeConfidence(shortSpan, { minDays: 3 }) === 'high', 'a caller-tuned minDays (3) accepts a 5-day span without capping (stays high)');
  ok(_computeOutcomeConfidence(shortSpan, { minDays: 10 }) === 'low', 'the same 5-day span is capped when the caller requires a longer minDays (10)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rule: does not invent biological certainty -- zero measurements is none,
// never guessed upward by any of the gates above.
// ─────────────────────────────────────────────────────────────────────────────

(function testNoMeasurementsIsNone() {
  ok(_computeOutcomeConfidence([]) === 'none', 'zero measurements -> none, unaffected by method/time gates');
})();

console.log('');
console.log('T218 — Outcome confidence: ' + pass + ' assertions PASSED');
