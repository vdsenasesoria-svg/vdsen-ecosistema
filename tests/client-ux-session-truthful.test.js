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
  const names = ['_getSessionCompletionState','_sessionHasRealLoggedSets','_getSessionLifecycleState'];
  const c = vm.createContext({});
  vm.runInContext(names.map(fn).join('\n'), c);
  const status = (o) => c._getSessionLifecycleState(o, 1, 0);
  assert.equal(status({done_1_0:{ts:123}}), 'NOT_STARTED');
  assert.equal(status({done_1_0:{ts:123}, log_1_0_0_s0:{done:true,autoFilled:true}}), 'NOT_STARTED');
  assert.equal(status({done_1_0:{ts:123}, log_1_0_0_s0:{done:true}}), 'COMPLETE');
  assert.equal(status({done_1_0:{partial:true}, log_1_0_0_s0:{done:true}}), 'PARTIAL');
  assert.equal(status({done_1_0:{partial:true}}), 'SKIPPED');
  assert.equal(status({done_1_0:{skipped:true}}), 'SKIPPED');
  assert.equal(status({log_1_0_0:{done:true,exType:'cardio',duracionMin:20}}), 'IN_PROGRESS');
  assert.equal(status({done_1_0:{ts:123},log_1_0_0:{done:true,exType:'cardio',duracionMin:20}}), 'COMPLETE');
  assert.equal(status({done_1_0:{ts:123},log_1_0_0:{done:true,exType:'circuito',rounds:4}}), 'COMPLETE');
  assert.equal(status({done_1_0:{ts:123},log_1_0_0_s0:{done:true,exType:'estacion'}}), 'COMPLETE');
  assert.equal(status({done_1_0:{ts:123},log_1_0_0_s0:{done:true,autoFilled:true},log_1_0_0_note:{done:true}}), 'NOT_STARTED');
  assert.equal(status({done_1_0:{partial:true},log_1_0_0:{done:true,exType:'cardio',duracionMin:20}}), 'PARTIAL');
});
test('load formatting renders at most one decimal without changing raw values', () => {
  const c = vm.createContext({Number,Math,String});
  vm.runInContext(fn('_fmtLoadForUi'),c);
  assert.equal(c._fmtLoadForUi(21.333333333), '21,3');
  assert.equal(c._fmtLoadForUi(20), '20');
  assert.equal(c._fmtLoadForUi(20.5), '20,5');
  const raw = 82.6666;
  assert.equal(c._fmtLoadForUi(raw), '82,7');
  assert.equal(raw, 82.6666);
  assert.ok(html.includes('_recapJoin(loads.map(function(x) { return x.v; }), 1)'));
});
test('defaults: dark and detailed, with no persistent light/express preference', () => {
  assert.ok(html.includes("document.documentElement.classList.remove('light-mode')"));
  assert.ok(!html.includes("localStorage.getItem('vdsen_light_mode')"));
  assert.ok(!html.includes("localStorage.getItem('vdsen_express_off')"));
  assert.ok(html.includes('var _detailedModeOn = true;'));
  assert.ok(!html.includes('onclick="toggleLightMode()"'));
});
test('Express is temporary and does not alter logged series', () => {
  const writes = [];
  const logs = { log_1_0_0_s0: { done: true, carga: '82.6666' } };
  const c = vm.createContext({ LOGS: logs, localStorage: { removeItem: k => writes.push(k) }, renderPerfil() {}, renderEntrenamiento() {} });
  vm.runInContext('var _detailedModeOn = true;' + fn('isExpressDisabled') + fn('setExpressDisabled'), c);
  assert.equal(c.isExpressDisabled(), true);
  c.setExpressDisabled(false);
  assert.equal(c.isExpressDisabled(), false);
  assert.equal(c.LOGS, logs);
  assert.equal(logs.log_1_0_0_s0.carga, '82.6666');
  assert.deepEqual(writes, ['vdsen_express_off']);
  const reopened = vm.createContext({});
  vm.runInContext('var _detailedModeOn = true;' + fn('isExpressDisabled'), reopened);
  assert.equal(reopened.isExpressDisabled(), true);
});
test('week checks require executed sessions; no done status based only on past week', () => {
  assert.ok(html.includes("var done = sesiones.length > 0 && sesiones.every"));
  assert.ok(!html.includes('var done    = w < REAL_WEEK;'));
  assert.ok(html.includes("var _lifecycleState  = _getSessionLifecycleState(LOGS, CURRENT_WEEK, DIA_ACTIVO);"));
});
test('recap opens in screenshot mode, is viewport sized and retains pagination', () => {
  assert.ok(html.includes('capture: true, di: di, week: week'));
  assert.ok(html.includes('#sessRecap .rc-wrap{max-width:480px;width:100%;height:100%;height:100dvh;'));
  assert.ok(html.includes('body.clientHeight - 60'));
  assert.ok(html.includes('#sessRecap .rc-data{font-size:16px}'), '320px recap numbers must remain readable');
  assert.ok(html.includes('ov.onclick = st.capture'));
});
