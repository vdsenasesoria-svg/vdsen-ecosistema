'use strict';
// T595-B — completeSet disables its button and relabels it "GUARDANDO…" before validating. Every exit that does not re-render the panel (rejected input, repeated event, failed write)
// must hand the button back with its ORIGINAL label. Measured in real Chrome (scripts/e2e-client-chain/save-latency-e2e.cjs): an empty load left it disabled on "GUARDANDO…", and a failed
// write threw `_techLower is not defined` (a render-local variable) after the rollback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
function extract(decl) { const start = client.indexOf(decl), b = client.indexOf('{', start); let d = 0; assert.ok(start >= 0, decl); for (let i = b; i < client.length; i++) { d += (client[i] === '{') - (client[i] === '}'); if (!d) return client.slice(start, i + 1); } throw Error(decl); }
const src = extract('async function completeSet(');

test('T595B-1 completeSet never references the render-local _techLower', () => {
  assert.equal(/\b_techLower\b/.test(src), false);
});

test('T595B-2 the original label is captured once and restored on every early exit and on a failed write', () => {
  assert.match(src, /var _saveBtnLabel = _saveBtn \? _saveBtn\.textContent : ''/);
  assert.ok((src.match(/_restoreSaveBtn\(\)/g) || []).length >= 6, 'prev.done, carga, reps, ICS, RIR and the failed write all restore the button');
  for (const msg of ["Ingresa la carga (> 0)", "ICS debe ser entre 1 y 10", "RIR debe ser entre 0 y 5"]) {
    const i = src.indexOf(msg); assert.ok(i > 0, msg);
    assert.match(src.slice(i, i + 160), /_restoreSaveBtn\(\); return;/, msg + ' restores before returning');
  }
  const failed = src.slice(src.indexOf('if (_setSaved === false)'));
  assert.match(failed.slice(0, failed.indexOf('return false;') + 13), /_restoreSaveBtn\(\);\s*return false;/);
});

test('T595B-3 behaviour: a rejected input restores the button; a failed write restores it and rolls the set back', async () => {
  const mk = (carga, saveResult) => {
    const btn = { disabled: false, textContent: '✓ GUARDAR SERIE 1', attrs: {}, isConnected: true, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    const toasts = [];
    const els = { setrow_k: { dataset: { exname: 'Press' }, querySelector: () => btn }, carga_k: { value: carga }, reps_k: { value: '10' }, rir_k: null, ics_k: null };
    const fn = new Function('btn', 'els', 'toasts', 'saveResult', `
      var CURRENT_WEEK = 1, REAL_WEEK = 1, DIA_ACTIVO = 0, EJ_ACTIVO = 0, LOGS = {}, USER = {}, ACTIVE_PLAN_ID = 'p', _EJERCICIOS_DIA = [{ exerciseName: 'Press' }], _saveLogsTimer = null, LOGS_BY_WEEK = { log: {} };
      var document = { getElementById: function(id) { return els[id] === undefined ? null : els[id]; } };
      function showToast(m) { toasts.push(m); } function getExUnit() { return 'kg'; } function _coachRIR() { return 2; } function getAdjustedRIR() { return 2; }
      function _lbwTrack() {} function _historyPidKey() { return null; } function _recordExerciseHistoryAndPR() { return false; } function _rebuildExerciseHistoryFromLogs() {}
      async function _doSaveLogs() { return saveResult; }
      ${src}
      return completeSet;`)(btn, els, toasts, saveResult);
    return { btn, toasts, run: () => fn('k', 0, 0, 0, 'kg') };
  };
  const bad = mk('', true); await bad.run();
  assert.equal(bad.btn.disabled, false); assert.equal(bad.btn.textContent, '✓ GUARDAR SERIE 1'); assert.equal(bad.btn.attrs['aria-busy'], undefined); assert.ok(bad.toasts.length);
  const failedWrite = mk('80', false); const r = await failedWrite.run();
  assert.equal(r, false); assert.equal(failedWrite.btn.disabled, false); assert.equal(failedWrite.btn.textContent, '✓ GUARDAR SERIE 1');
});
