'use strict';
// T597: the Client uses the athlete's latest valid PID-bound execution as its
// reference. A personal best remains separate metadata and can never become a
// working-load default by accident.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');

function fn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
function world(logs) {
  const ctx = { LOGS: logs || {}, EXERCISE_HISTORY: {}, Date: { now: () => 1000 }, Number, String, Object, Array, Math, parseFloat, parseInt,
    _normName: value => String(value || '').trim().toLowerCase(),
    _convertCarga: (value, from, to) => {
      const n = Number(value); if (!Number.isFinite(n)) return '';
      if (String(from).toUpperCase() === String(to).toUpperCase()) return String(n);
      return String(String(from).toUpperCase() === 'KG' ? n * 2.20462 : n * 0.453592);
    },
    _roundUnit: value => Math.round(Number(value) * 10) / 10,
    _escHTml: value => String(value),
    showPRCelebration: () => { throw new Error('celebration must be opt-in'); }
  };
  ctx.window = ctx; vm.createContext(ctx);
  for (const name of ['_historyPidKey', '_historySnapshot', '_historyLast', '_historyPersonalBest', '_historyEntry', '_getExerciseHistoryEntry', '_recordExerciseHistoryAndPR', '_rebuildExerciseHistoryFromLogs', '_rebuildLoadedHistoryReferences', '_logbookReferenceHtml', '_effectiveSetTargetHtml']) vm.runInContext(fn(name), ctx);
  return ctx;
}
const set = (load, ts, extra) => Object.assign({ done: true, carga: String(load), reps: '10', rir_real: '2', unit: 'KG', ts, prescriptionExerciseId: 'pidA' }, extra || {});

test('T597-A/B first valid record becomes the immediate reference; a later lower working set replaces it without erasing the PR', () => {
  const w = world();
  w._recordExerciseHistoryAndPR('press', 'Press', '10', '10', '2', 'KG', false, 'pidA');
  assert.equal(w._getExerciseHistoryEntry('press', 'pidA').load, '10');
  w._recordExerciseHistoryAndPR('press', 'Press', '15', '8', '2', 'KG', false, 'pidA');
  w._recordExerciseHistoryAndPR('press', 'Press', '10', '10', '2', 'KG', false, 'pidA');
  const ref = w._getExerciseHistoryEntry('press', 'pidA');
  assert.equal(ref.load, '10', 'latest valid work load is the reference');
  assert.equal(ref.personalBest.load, '15', 'PR is retained separately');
  assert.match(w._logbookReferenceHtml(ref, 'KG', false), /Última carga de trabajo válida: 10 KG/);
});

test('T597-C/D/E rebuild follows timestamps, ignores invalid evidence, and recalculates after a correction', () => {
  const w = world({ log_old: set(15, 10), log_latest: set(10, 20), log_warmup: set(30, 30, { warmup: true }), log_other: set(50, 40, { prescriptionExerciseId: 'pidB' }) });
  w._rebuildExerciseHistoryFromLogs('press', 'pidA');
  let ref = w._getExerciseHistoryEntry('press', 'pidA');
  assert.equal(ref.load, '10'); assert.equal(ref.personalBest.load, '15');
  delete w.LOGS.log_latest; w._rebuildExerciseHistoryFromLogs('press', 'pidA');
  ref = w._getExerciseHistoryEntry('press', 'pidA');
  assert.equal(ref.load, '15', 'removing the corrected latest entry rebuilds the reference');
  assert.deepEqual(JSON.parse(JSON.stringify(w._getExerciseHistoryEntry('press', 'pidB'))), {}, 'PID isolation remains fail-closed');
  assert.equal(w._recordExerciseHistoryAndPR('press', 'Press', '99', '1', '0', 'KG', false, null), false, 'PID-less substitutions cannot write history');
});

test('T597-E2 loading an old flat cache reconciles it from PID-bound real logs', () => {
  const w = world({ log_old: set(15, 10), log_latest: set(10, 20) });
  w.EXERCISE_HISTORY.__pid__pidA = { load: '15', reps: '8', unit: 'KG', updatedAt: 10 };
  w._rebuildLoadedHistoryReferences();
  const ref = w._getExerciseHistoryEntry('press', 'pidA');
  assert.equal(ref.load, '10'); assert.equal(ref.personalBest.load, '15');
});

test('T597-F/G/I Coach supplies only structure; logbook references convert units; only an applied overlay has numerical target authority', () => {
  const w = world();
  const coach = w._effectiveSetTargetHtml({ load: 100, repsTarget: 8, rirTarget: 2 }, 'COACH', 'KG', false);
  assert.match(coach, /ESTRUCTURA COACH/); assert.doesNotMatch(coach, /CARGA 100/);
  const applied = w._effectiveSetTargetHtml({ load: 102.5, repsTarget: 8, rirTarget: 2 }, 'AUTOAJUSTE VDSEN', 'KG', false);
  assert.match(applied, /OBJETIVO AUTOAJUSTE VDSEN/); assert.match(applied, /CARGA 102.5 KG/);
  const ref = w._historyEntry({ load: '10', unit: 'KG', reps: '10', updatedAt: 1 });
  assert.match(w._logbookReferenceHtml(ref, 'LB', false), /22(?:\.0)? LB/);
  assert.match(w._logbookReferenceHtml({}, 'KG', false), /SIN HISTORIAL/);
});

test('T597-H/J UI wiring keeps the reference before editable execution and leaves Numeric Apply ownership outside the history renderer', () => {
  const card = SRC.slice(SRC.indexOf('function _buildExCard('), SRC.indexOf('function _buildExCard(') + 60000);
  assert.match(card, /var _historyReferenceHtml = _logbookReferenceHtml\(histEx, unit, isIsometric\)/);
  const targetAt = card.indexOf('_historyReferenceHtml+');
  assert.ok(targetAt >= 0 && targetAt < card.indexOf("'<div class=\"sp-fields\">'", targetAt));
  const body = fn('_logbookReferenceHtml');
  for (const forbidden of ['LOGS', 'setDoc', 'updateDoc', 'NUMERIC_APPLY_ENABLED', 'progressionApplications']) assert.ok(!body.includes(forbidden), forbidden);
});

test('T597-K switching KG/LB converts BOTH the last reference and the separate personal best, and keeps the flat view equal to the last execution', () => {
  const w = world({ log_1_0_0_s0: set(10, 20) });
  w.EXERCISE_HISTORY.__pid__pidA = w._historyEntry({ load: '10', reps: '10', rir: '2', unit: 'KG', updatedAt: 20 }, { load: '15', reps: '8', rir: '2', unit: 'KG', updatedAt: 10 });
  const run = new (require('node:vm').Script)(`
    var LOGS_BY_WEEK = { log: { 1: ['log_1_0_0_s0'] }, progrec: {} }, EXERCISE_UNITS = {}, CURRENT_WEEK = 1;
    var document = { getElementById: function() { return null; } };
    function getExUnit() { return 'KG'; } function getSesiones() { return [{ exercises: [{ prescriptionExerciseId: 'pidA', numSeries: 1 }] }]; }
    function _roundUnit(v) { return Math.round(Number(v) * 10) / 10; }
    ${fn('toggleExUnit').replace(/\n  \/\/ ── 4\.[\s\S]*$/, '\n}')}
    toggleExUnit(0, 0);`);
  try { run.runInContext(w); } catch (e) { assert.fail('toggleExUnit stub run failed: ' + e.message); }
  const h = w.EXERCISE_HISTORY.__pid__pidA;
  assert.equal(h.last.unit, 'LB'); assert.equal(h.personalBest.unit, 'LB');
  assert.equal(h.last.load, '22'); assert.equal(h.personalBest.load, '33.1');
  assert.equal(h.load, h.last.load); assert.equal(h.unit, 'LB');
  assert.equal(w.LOGS.log_1_0_0_s0.unit, 'LB', 'the logbook entry itself is converted by the same action');
});
