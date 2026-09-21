'use strict';
/**
 * T319 — Progress / measurements client view (audit; already correct, no
 * code change). Fully confirmed during T315's audit and re-verified end-to-
 * end in T323 (cases G/H); this phase formalizes that conclusion.
 *
 * The client's "¿cómo voy?" question is already answered honestly using
 * only real available data:
 *  - buildHistorialWidget(): per-exercise strength history (load/volume/
 *    ICS trend bars) plus a check-in trend table (peso/HRV/WHO-5) across
 *    every logged week -- a single data point yields first===last, so
 *    loadDelta is honestly 0 (a flat trend), never a fabricated direction.
 *  - _buildWeightSparkline(): weight/InBody (% grasa, músculo, visceral)
 *    sparkline -- a single measurement renders one centered point, never
 *    an invented multi-point line; each series only plots when real data
 *    for that metric exists (`if (!isNaN(v) && v > 0) pts[m.key].push(...)`).
 *  - No learned_state, no supervision states, no prescription-effectiveness
 *    internals are exposed to the client -- those remain Coach-side only.
 *
 * Run: node tests/t319-progress-measurements-client-view.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + decl);
}

const historialSrc  = extractFunction(CLIENT, 'function buildHistorialWidget() {');
const sparklineSrc  = extractFunction(CLIENT, 'function _buildWeightSparkline() {');

ok(historialSrc.includes('var first = data.weeks[weekNums[0]];') && historialSrc.includes('var last = data.weeks[weekNums[weekNums.length-1]];'),
  'strength history compares the earliest vs latest REAL logged week only -- never an interpolated/invented midpoint');
ok(sparklineSrc.includes('if (!isNaN(v) && v > 0) pts[m.key].push({ w: w, v: v });'), 'each metric (weight/%grasa/músculo/visceral) only plots weeks where real data exists for that specific metric');
ok(sparklineSrc.includes('if (allWeeks.length === 1) return padL + cW / 2;'), 'a single measurement renders as one centered point, never a fabricated line/direction');
ok(!/learned_state|supervisionState|prescriptionEffectiveness/i.test(historialSrc + sparklineSrc), 'no Coach-internal analytics (learned_state, supervision states, prescription-effectiveness) leak into the client-facing Progress view');
ok(historialSrc.includes("var ci = LOGS['ci_sem_'+w];"), 'check-in trend data (peso/HRV/WHO-5) is read directly from real ci_sem_ entries, week-labeled, not aggregated/obscured');

console.log('');
console.log('T319 — Progress/measurements client view: ' + pass + ' assertions PASSED. Already correct (confirmed T315, proven end-to-end T323); no code changed.');
