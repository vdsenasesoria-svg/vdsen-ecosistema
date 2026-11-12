'use strict';
// T778: Client stabilization regression tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function fnSrc(name) {
  let i = SRC.indexOf('async function ' + name + '(');
  if (i < 0) i = SRC.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'missing function ' + name);
  let d = 0, q = null, esc = false;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    const c = SRC[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && SRC[k + 1] === '/') { k = SRC.indexOf('\n', k); continue; }
    if (c === '/' && SRC[k + 1] === '*') { k = SRC.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++;
    else if (c === '}' && --d === 0) return SRC.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}

test('T778.1 getTodaySummary counts structured exercises instead of returning 0 ejercicios', () => {
  const sesiones = [{
    dia: 'DÍA 1 — Empuje',
    exercises: [
      { nombre: 'Press banca', numSeries: 3 },
      { nombre: 'Cardio Z2', exerciseType: 'cardio', duracionMin: 25 },
      { nombre: 'Solo semana 3', technique: 'Y3T', activeWeeks: [3], numSeries: 3 }
    ]
  }];
  const ctx = {
    PLAN: { entrenamiento: { sesiones } },
    LOGS: {},
    CURRENT_WEEK: 1,
    getSesiones: () => sesiones,
    isTechniqueActive: (ej, w) => !ej.activeWeeks || ej.activeWeeks.includes(w),
    _getExType: (ej) => ej.exerciseType || 'fuerza',
    _escHTml: (s) => String(s),
    _stripDayNo: (s) => String(s),
    _progressText: (sd, st, cd, ct) => `${sd}/${st} series · ${cd}/${ct} cardio`,
    _SESSION_LIFECYCLE_LABELS: { NOT_STARTED: 'Pendiente', IN_PROGRESS: 'En curso', COMPLETE: 'Completada', PARTIAL: 'Parcial', SKIPPED: 'Omitida' },
    _getSessionCompletionState: () => 'NOT_STARTED',
    _sessionHasRealLoggedSets: () => false,
    _calcSessionStats: () => ({ completedSets: 0, strengthSets: 0, cardioDone: 0 }),
    _dayTotals: () => ({ sets: 3, cardio: 1 }),
    _getSessionLifecycleState: () => 'NOT_STARTED'
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('_getTodayHomeState') + '\n' + fnSrc('getTodaySummary'), ctx);
  const html = ctx.getTodaySummary();
  assert.ok(html.includes('<b class="t-num">2</b> ejercicios'), 'expected 2 active exercises, got: ' + html);
});

test('T778.2 _getTodayHomeState does not inflate totalSets with cardio/circuit exercises', () => {
  const sesiones = [{
    dia: 'DÍA 1 — Mix',
    exercises: [
      { nombre: 'Press banca', numSeries: 3 },
      { nombre: 'Cardio Z2', exerciseType: 'cardio', duracionMin: 30 },
      { nombre: 'Circuito', exerciseType: 'circuito', rounds: 4 }
    ]
  }];
  const ctx = {
    LOGS: {},
    isTechniqueActive: () => true,
    _getExType: (ej) => ej.exerciseType || 'fuerza',
    _SESSION_LIFECYCLE_LABELS: { NOT_STARTED: 'Pendiente', IN_PROGRESS: 'En curso', COMPLETE: 'Completada', PARTIAL: 'Parcial', SKIPPED: 'Omitida' },
    _getSessionLifecycleState: () => 'NOT_STARTED',
    _calcSessionStats: () => ({ completedSets: 0, strengthSets: 0, cardioDone: 0 }),
    _dayTotals: () => ({ sets: 3, cardio: 1 })
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('_getTodayHomeState'), ctx);
  const home = ctx._getTodayHomeState({}, 1, sesiones);
  assert.equal(home.progress.totalSets, 3);
  assert.equal(home.progress.strengthTotal, 3);
  assert.equal(home.progress.cardioTotal, 1);
});

test('T778.3 .sp-authority-min wraps cleanly without ellipsis truncation on narrow phones', () => {
  const m = SRC.match(/\.sp-authority-min\{[^}]+\}/);
  assert.ok(m, '.sp-authority-min rule exists');
  assert.ok(!/white-space\s*:\s*nowrap|text-overflow\s*:\s*ellipsis/.test(m[0]), 'must not truncate with nowrap/ellipsis: ' + m[0]);
});

test('T778.4 _confirmSessionDone reverts done_ entry if _doSaveLogs rejects', async () => {
  const ctx = {
    CURRENT_WEEK: 1,
    DIA_ACTIVO: 0,
    LOGS: {},
    _saveLogsTimer: null,
    clearTimeout: () => {},
    _doSaveLogs: async () => { throw new Error('offline'); },
    showToast: () => {},
    renderEntrenamiento: () => {},
    renderResumen: () => {},
    Date
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('_confirmSessionDone'), ctx);
  const ok = await ctx._confirmSessionDone(0);
  assert.equal(ok, false);
  assert.equal(ctx.LOGS['done_1_0'], undefined, 'done_ must be reverted when _doSaveLogs rejects');
});
