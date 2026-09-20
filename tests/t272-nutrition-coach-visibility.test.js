'use strict';
/**
 * T272 — Coach visibility. Verifies the compact "Estado nutricional" card
 * in _renderClientTabMonitor: reuses window.VDSEN_NUTRITION entirely (no
 * second engine), reads inbodyResults/nutritionRaw/_detailFichaData/entries
 * already loaded (0 new Firestore reads), is exceptions-first (Motivo line
 * only when the recommendation isn't a plain KEEP), and never fabricates a
 * confident adherence/response label when the real classification is
 * INSUFFICIENT_DATA.
 *
 * Run: node tests/t272-nutrition-coach-visibility.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractBlock(src, marker) {
  const idx = src.indexOf(marker);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceStart, i + 1); }
  }
  return null;
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const block = extractBlock(COACH, "if (typeof window.VDSEN_NUTRITION !== 'undefined') {\n      const _nutriLog272");
ok(block, 'the T272 nutrition status card block extracts cleanly');

ok(block.includes('window.VDSEN_NUTRITION.classifyAdherence(') && block.includes('window.VDSEN_NUTRITION.classifyResponse(') && block.includes('window.VDSEN_NUTRITION.decide('),
  'reuses window.VDSEN_NUTRITION entirely -- no second nutrition engine in the render');
ok(block.includes('_detailFichaData') && block.includes('c && c.inbodyResults') && block.includes('c && c.nutritionRaw'),
  'reads inbodyResults/nutritionRaw/_detailFichaData already loaded -- 0 new Firestore reads');
ok(!/getDoc\(|await /.test(block), 'the render block performs no Firestore reads of its own');
ok(block.includes("_nutriDecision272.action !== 'KEEP'"), 'exceptions-first: the Motivo/reason line only renders when the recommendation is not a plain KEEP');
ok(block.includes('INSUFFICIENT_DATA: { label: \'DATOS INSUFICIENTES\''), 'INSUFFICIENT_DATA is shown as such (both adherence and response meta maps) -- never fabricated as a confident HIGH/LOW/ON_TARGET reading');
ok(block.includes('.map(r => _escH(r))'), 'reasons are HTML-escaped before rendering (same _escH helper used by the T223 attention-names line)');

// ─────────────────────────────────────────────────────────────────────────────
// Execute the actual meta-lookup + conditional-Motivo logic (extracted
// verbatim) against representative decision outputs.
// ─────────────────────────────────────────────────────────────────────────────

function runBlock(nutriAdherence, nutriResponse, nutriDecision) {
  const escH = function(s) { return String(s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const fakeVDSEN = {
    classifyAdherence: function() { return nutriAdherence; },
    classifyResponse: function() { return nutriResponse; },
    decide: function() { return nutriDecision; }
  };
  const entries = {};
  const c = { nutritionRaw: {}, inbodyResults: [] };
  const _detailFichaData = { data: {} };
  let html = '';
  const fn = new Function('window', '_escH', 'entries', 'c', '_detailFichaData', 'html',
    'window.VDSEN_NUTRITION = arguments[0];\n' + block + '\nreturn html;'
  );
  return fn(fakeVDSEN, escH, entries, c, _detailFichaData, html);
}

{
  const out = runBlock({ classification: 'HIGH' }, { classification: 'ON_TARGET' }, { action: 'KEEP', reasons: ['on_target'] });
  ok(out.includes('MANTENER') && out.includes('ALTA') && out.includes('EN OBJETIVO'), 'KEEP + HIGH + ON_TARGET renders MANTENER/ALTA/EN OBJETIVO');
  ok(!out.includes('Motivo'), 'KEEP renders no Motivo line -- exceptions-first, nothing to flag');
}

{
  const out = runBlock({ classification: 'LOW' }, { classification: 'OFF_TARGET' }, { action: 'FREEZE', reasons: ['adherence_low'] });
  ok(out.includes('CONGELAR') && out.includes('BAJA'), 'FREEZE + LOW adherence renders CONGELAR/BAJA');
  ok(out.includes('Motivo') && out.includes('adherence_low'), 'a non-KEEP action DOES surface the Motivo/reason line');
}

{
  const out = runBlock({ classification: 'INSUFFICIENT_DATA' }, { classification: 'INSUFFICIENT_DATA' }, { action: 'FREEZE', reasons: ['adherence_insufficient_data'] });
  ok(out.includes('DATOS INSUFICIENTES'), 'INSUFFICIENT_DATA is rendered as an honest label, never guessed as HIGH/LOW/ON_TARGET');
}

console.log('');
console.log('T272 — Coach visibility: ' + pass + ' assertions PASSED');
