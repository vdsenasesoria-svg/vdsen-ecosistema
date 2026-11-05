'use strict';
/**
 * T312 — Home information hierarchy.
 *
 * Reorders renderResumen()'s existing template (no new markup beyond what
 * T308-T311 already added) to the ticket's required order:
 *   1. TODAY SESSION / 2. PRIMARY CTA / 3. TODAY PROGRESS  (HOY card + chips)
 *   4. WEEK OVERVIEW                                        (stat-row + week-grid)
 *   5. relevant recovery/resume message                      (stale banner)
 *   6. optional compact contextual info                      (check-in + widgets)
 *
 * No analytics/dashboard content was added or removed -- purely a reorder.
 *
 * Run: node tests/t312-home-information-hierarchy.test.js
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

const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');

// ── Order assertion: each marker's position must be strictly increasing. ──
const markers = [
  ['HOY — SEM', 'today session / primary CTA / today progress (HOY card)'],
  ['${buildWeekDayChips()}', 'today progress (day chips, part of the HOY block)'],
  ['class="stat-row"', 'week overview (stat-row)'],
  ['class="week-grid"', 'week overview (week-grid)'],
  ['${buildStaleSessionHomeBanner()}', 'recovery/resume message (stale banner)'],
  ['CHECK-IN SEM', 'contextual info (check-in card, first of the trailing widgets)'],
];
let lastIdx = -1;
markers.forEach(function(pair) {
  const idx = renderResumenSrc.indexOf(pair[0]);
  ok(idx !== -1, 'marker present: ' + pair[1]);
  ok(idx > lastIdx, 'hierarchy order holds: "' + pair[1] + '" comes after the previous section');
  lastIdx = idx;
});

// ── No new analytics/dashboard content introduced by this reorder. ────────
const widgetCalls = ['buildMesocicloReportWidget', 'buildStreakWidget', 'buildHistorialWidget', 'buildBodyMapWidget', 'buildVolumenWidget', 'buildVolumenMesocicloWidget', 'buildRezagadosWidget'];
widgetCalls.forEach(function(fn) {
  ok(renderResumenSrc.includes('${' + fn + '()}'), 'pre-existing widget ' + fn + ' is still present (nothing removed, only reordered)');
  ok(renderResumenSrc.indexOf('${' + fn + '()}') > lastIdx || renderResumenSrc.indexOf('${' + fn + '()}') > renderResumenSrc.indexOf('CHECK-IN SEM'),
    fn + ' stays in the trailing "contextual info" section, after the recovery banner');
});

console.log('');
console.log('T312 — Home information hierarchy: ' + pass + ' assertions PASSED');
