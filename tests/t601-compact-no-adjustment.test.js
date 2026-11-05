'use strict';
// T601 — with NOTHING applied the progression status is one short line. The first T599-R candidate added ~120 px to the set card and pushed GUARDAR SERIE out of the first screen on a
// 430x932 phone, which the production card (b5f53af, approved by the owner) did not. Measured in real Chrome: scripts/t601/compare.cjs ("Visibilidad").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const HTML = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name) { const i = HTML.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0; for (let k = HTML.indexOf('{', i); k < HTML.length; k++) { d += (HTML[k] === '{') - (HTML[k] === '}'); if (!d) return HTML.slice(i, k + 1); } throw new Error(name); }
const ctx = { _escHTml: (s) => String(s), Number, String, Object, Math }; vm.createContext(ctx);
vm.runInContext(fnSrc('_ruleReason') + '\n' + fnSrc('_seriesAuthorityHtml'), ctx);

test('T601-1 no authorized adjustment: one short status line, no "CAMBIO RESPECTO" block', () => {
  const html = ctx._seriesAuthorityHtml(null, 0);
  assert.match(html, /sp-authority-min/); assert.match(html, /data-progression-state="NO_AUTHORIZED_ADJUSTMENT"/); assert.match(html, /Sin autoajuste aplicado/); assert.match(html, /la referencia no es una progresión/);
  assert.doesNotMatch(html, /CAMBIO RESPECTO/); assert.ok(html.length < 260, 'short: ' + html.length);
});
test('T601-2 pending / blocked / review keep their explanation but not the empty "change" block', () => {
  for (const [state, label] of [['PENDING', /PENDIENTE/], ['BLOCKED', /BLOQUEADO/], ['COACH_REVIEW', /REVISI.N REQUERIDA/]]) {
    const html = ctx._seriesAuthorityHtml({ state, applied: false, reasons: ['INSUFFICIENT_COMPARABLE_EXPOSURES'], result: {}, baseSets: [] }, 0);
    assert.match(html, label); assert.match(html, new RegExp('data-progression-state="' + state + '"')); assert.match(html, /<p>/); assert.doesNotMatch(html, /CAMBIO RESPECTO/);
  }
});
test('T601-3 an APPLIED adjustment still shows the full before -> after with its reason and origin', () => {
  const view = { state: 'APPLIED', applied: true, ruleId: 'A', unit: 'KG', baseSets: [{ repsTarget: 10, rirTarget: 2, restSeconds: 90 }, {}, {}], previousLoad: 100,
    result: { dimension: 'LOAD', previousValue: 100, components: null, carried: null, presentation: { text: '100 → 105 kg' }, sets: [{ effective: { load: 105, repsTarget: 10, rirTarget: 2, restSeconds: 90 } }, { effective: {} }, { effective: {} }] }, reasons: [] };
  const html = ctx._seriesAuthorityHtml(view, 0);
  assert.match(html, /AUTOAJUSTE APLICADO/); assert.match(html, /CAMBIO RESPECTO/); assert.match(html, /Carga: 100 KG → 105 KG/); assert.match(html, /Motivo: /); assert.match(html, /no es una sugerencia/);
});
test('T601-4 the copy-history button only carries the long label and the warning when executed reps differ from the objective', () => {
  const src = fnSrc('_prevWeekReuseHtml');
  assert.match(src, /\(diff \? ' · COPIAR HISTORIAL' : ''\)/); assert.match(src, /\(diff \? ' · No es una recomendación' : ''\)/);
});
