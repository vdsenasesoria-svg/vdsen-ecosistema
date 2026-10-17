'use strict';
/**
 * T272 — Coach visibility. Verifies the compact "Estado nutricional" card
 * in _renderClientTabMonitor: sources adherence/response/action from the
 * shared canonical decision snapshot (T279's _monitorSnapshot.nutritionDecision,
 * itself built by window.VDSEN_SNAPSHOT.build, T276 -- no second nutrition
 * engine in the render), is exceptions-first (Motivo line only when the
 * recommendation isn't a plain KEEP), and never fabricates a confident
 * adherence/response label when the real classification is
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

const block = extractBlock(COACH, "if (_monitorSnapshot && _monitorSnapshot.nutritionDecision) {\n      const _nutriAdherence272");
ok(block, 'the T272 nutrition status card block extracts cleanly');

ok(block.includes('_monitorSnapshot.nutritionDecision.adherence') && block.includes('_monitorSnapshot.nutritionDecision.response') && block.includes('_monitorSnapshot.nutritionDecision.action'),
  'sources adherence/response/action from the shared canonical snapshot -- no second nutrition engine in the render (FIXED for T279\'s snapshot routing)');
ok(!/getDoc\(|await /.test(block), 'the render block performs no Firestore reads of its own');
// The snapshot itself (built once per render, T279) is what actually reads
// inbodyResults/nutritionRaw/ficha -- confirmed at the snapshot-build call
// site, not duplicated inside this card's own block anymore.
ok(COACH.includes('clientDoc: c, planDoc: p, planId: (c && c.activePlanId) || null,') && COACH.includes('logsDoc: logsData, fd: (_detailFichaData && _detailFichaData.data) || {}'),
  'the shared snapshot build call (once per render) is what supplies clientDoc/planDoc/ficha -- 0 new Firestore reads, same discipline as before, just centralized');
ok(block.includes("_nutriDecision272.action !== 'KEEP'"), 'exceptions-first: the Motivo/reason line only renders when the recommendation is not a plain KEEP');
ok(block.includes('INSUFFICIENT_DATA: { label: \'DATOS INSUFICIENTES\''), 'INSUFFICIENT_DATA is shown as such (both adherence and response meta maps) -- never fabricated as a confident HIGH/LOW/ON_TARGET reading');
ok(block.includes('.map(r => _escH(r))'), 'reasons are HTML-escaped before rendering (same _escH helper used by the T223 attention-names line)');

// ─────────────────────────────────────────────────────────────────────────────
// Execute the actual meta-lookup + conditional-Motivo logic (extracted
// verbatim) against representative decision outputs.
// ─────────────────────────────────────────────────────────────────────────────

function runBlock(nutriAdherence, nutriResponse, nutriDecision) {
  const escH = function(s) { return String(s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const _monitorSnapshot = {
    nutritionDecision: { adherence: nutriAdherence, response: nutriResponse, action: nutriDecision.action, reasons: nutriDecision.reasons }
  };
  let html = '';
  const fn = new Function('_escH', '_monitorSnapshot', 'html', block + '\nreturn html;');
  return fn(escH, _monitorSnapshot, html);
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
