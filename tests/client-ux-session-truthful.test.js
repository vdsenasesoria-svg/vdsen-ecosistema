'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
function fn(name) {
  const i = html.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'missing ' + name);
  let start = html.indexOf('{', i), depth = 0;
  for (let p = start; p < html.length; p++) {
    if (html[p] === '{') depth++;
    if (html[p] === '}' && --depth === 0) return html.slice(i, p+1);
  }
  throw Error('unterminated ' + name);
}
test('visual status never shows complete from closure alone; autofill is not execution', () => {
  const names = ['_getSessionCompletionState','_sessionHasRealLoggedSets','_getSessionLifecycleState','_visibleSessionLifecycleState'];
  const c = vm.createContext({});
  vm.runInContext(names.map(fn).join('\n'), c);
  const status = (o) => c._visibleSessionLifecycleState(o, 1, 0);
  assert.equal(status({done_1_0:{ts:123}}), 'NOT_STARTED');
  assert.equal(status({done_1_0:{ts:123}, log_1_0_0_s0:{done:true,autoFilled:true}}), 'NOT_STARTED');
  assert.equal(status({done_1_0:{ts:123}, log_1_0_0_s0:{done:true}}), 'COMPLETE');
  assert.equal(status({done_1_0:{partial:true}, log_1_0_0_s0:{done:true}}), 'PARTIAL');
  assert.equal(status({done_1_0:{partial:true}}), 'SKIPPED');
  assert.equal(status({done_1_0:{skipped:true}}), 'SKIPPED');
});
test('load formatting renders at most one decimal without changing raw values', () => {
  const c = vm.createContext({Number,Math,String});
  vm.runInContext(fn('_fmtLoadForUi'),c);
  assert.equal(c._fmtLoadForUi(21.333333333), '21,3');
  assert.equal(c._fmtLoadForUi(20), '20');
  assert.equal(c._fmtLoadForUi(20.5), '20,5');
  assert.ok(html.includes('_recapJoin(loads.map(function(x) { return x.v; }), 1)'));
});
test('defaults: dark and detailed, with no persistent light/express preference', () => {
  assert.ok(html.includes("document.documentElement.classList.remove('light-mode')"));
  assert.ok(!html.includes("localStorage.getItem('vdsen_light_mode')"));
  assert.ok(!html.includes("localStorage.getItem('vdsen_express_off')"));
  assert.ok(html.includes('var _detailedModeOn = true;'));
  assert.ok(!html.includes('onclick="toggleLightMode()"'));
});
test('week checks require executed sessions; no done status based only on past week', () => {
  assert.ok(html.includes("var done = sesiones.length > 0 && sesiones.every"));
  assert.ok(!html.includes('var done    = w < REAL_WEEK;'));
  assert.ok(html.includes("var _lifecycleState  = _visibleSessionLifecycleState(LOGS, CURRENT_WEEK, DIA_ACTIVO);"));
});
test('recap opens in screenshot mode, is viewport sized and retains pagination', () => {
  assert.ok(html.includes('capture: true, di: di, week: week'));
  assert.ok(html.includes('#sessRecap .rc-wrap{max-width:480px;width:100%;height:100%;height:100dvh;'));
  assert.ok(html.includes('body.clientHeight - 60'));
  assert.ok(html.includes('ov.onclick = st.capture'));
});
