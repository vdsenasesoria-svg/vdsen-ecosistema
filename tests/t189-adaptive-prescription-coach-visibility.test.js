'use strict';
/**
 * T189 — Coach visibility for adaptive prescription decisions.
 *
 * Wires _computeAdaptivePrescriptionMap (T185-188, unmodified) into
 * _renderClientTabMonitor as one compact, exceptions-first block: only
 * muscles with a non-KEEP volumeAction render prominently; KEEP muscles
 * collapse into a <details> summary — same pattern already established by
 * T163's "Recomendaciones de progresión" (exceptions-first, KEEP secondary).
 * No giant table, no new engine — pure consumption of the T185-188 output.
 *
 * Run: node tests/t189-adaptive-prescription-coach-visibility.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: the block exists, calls the real T185-188 function (no
// recomputation), and is exceptions-first (KEEP collapsed, others prominent).
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('const _apMap = _computeAdaptivePrescriptionMap({'), '_renderClientTabMonitor calls the real _computeAdaptivePrescriptionMap (T185-188), no second engine');
ok(COACH.includes("const _apExceptions = _apEntries.filter(x => x.d.volumeAction !== 'KEEP');"), 'non-KEEP muscles are separated out as exceptions');
ok(COACH.includes("const _apKeeps      = _apEntries.filter(x => x.d.volumeAction === 'KEEP');"), 'KEEP muscles are separated out for collapsed display');
ok(COACH.includes('<details class="mt-1"><summary'), 'KEEP muscles render inside a collapsed <details> element — visually secondary, matching T163\'s established pattern');
ok(COACH.includes('_apExceptions.forEach(x => { html += _renderApCard(x); });') &&
   COACH.indexOf('_apExceptions.forEach') < COACH.indexOf('_apKeeps.forEach'),
  'exceptions render BEFORE (and outside) the collapsed KEEP section — exceptions-first ordering');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: only muscles with real applied-volume data are shown (no
// fabricated rows for muscles the previous plan never actually touched).
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('.filter(x => x.d.currentVolume != null); // only muscles with real applied-volume data'),
  'muscles with no real previous-volume data are excluded from the Coach card entirely (never fabricated)');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: no giant table — one compact card per exception, not a
// spreadsheet-style grid.
// ─────────────────────────────────────────────────────────────────────────────

ok(!COACH.includes('Prescripción adaptativa por músculo') || !/<table[^>]*>[\s\S]{0,50}Prescripción adaptativa/.test(COACH),
  'the adaptive-prescription block is not rendered as a giant <table> — compact cards instead');

console.log('');
console.log('T189 — Adaptive prescription Coach visibility: ' + pass + ' assertions PASSED');
