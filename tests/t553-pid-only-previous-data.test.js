'use strict';
// T553: PID is the ONLY exercise identity for every plan-bound prior-exposure helper. `_getPrevWeekData` (warm-up base, history-day autofill, legacy advisory engine)
// had a positional + exercise-name fallback for PID-less evidence. Now it is built on the same resolver as ÚLTIMA SEMANA / USAR CARGA/REPS (`_prevWeekRef`) and fails closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  assert.ok(i > -1, 'missing function ' + name);
  let d = 0; const j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}' && --d === 0) return SRC.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const FNS = ['_exNotePidKey', '_exNoteCtx', '_exNoteValid', '_exNoteShadowed', '_prevWeekRef', '_prevWeekRefOf', '_getPrevWeekData', '_avgArr', '_warmupReferenceLoad', '_getExerciseHistoryEntry', '_historyPidKey'];
function world(o) {
  o = o || {};
  const ctx = { console, Number, Math, JSON, Date, Object, Array, String, parseInt, parseFloat, isNaN, RegExp,
    LOGS: o.logs || {}, ACTIVE_PLAN_ID: 'planA', CURRENT_WEEK: o.week || 2, EXERCISE_HISTORY: o.history || {},
    _EJERCICIOS_DIA: o.ex || [{ prescriptionExerciseId: 'pidA', exerciseName: 'Press banca', sets: [{ load: 100, repsTarget: 8, rirTarget: 2 }] }, { prescriptionExerciseId: 'pidB', exerciseName: 'Remo', sets: [] }] };
  ctx.window = ctx; vm.createContext(ctx);
  for (const f of FNS) if (SRC.includes('function ' + f + '(')) vm.runInContext(fnSrc(f), ctx);
  return ctx;
}
const set = o => Object.assign({ carga: '80', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: '3', ics: 8, prescriptionExerciseId: 'pidA', exerciseNameSnapshot: 'Press banca', ts: 1 }, o);
const W1 = () => ({ log_1_1_0_s0: set({}), log_1_1_0_s1: set({ carga: '82.5', reps: '8', rir_real: '1' }) });
const prev = (w, di, ei, pid, name) => { const r = w._getPrevWeekData(w.CURRENT_WEEK, di === undefined ? 1 : di, ei === undefined ? 0 : ei, 8, pid === undefined ? 'pidA' : pid, name === undefined ? 'Press banca' : name); return r && JSON.parse(JSON.stringify(r)); };

test('T553.1 same plan + same PID + exactly week-1 => valid previous-week data (averages of the executed standard sets)', () => {
  const r = prev(world({ logs: W1() })); assert.equal(r.numSets, 2); assert.equal(r.avgLoad, 81.25); assert.equal(r.avgReps, 9); assert.equal(r.avgRIR, 2); assert.equal(r.avgICS, 8); assert.equal(r.unit, 'KG');
});
test('T553.2 same NAME + different PID => no result (the exercise-name guard was an authority)', () => {
  const logs = { log_1_1_0_s0: set({ prescriptionExerciseId: 'pidZ' }) }; assert.equal(prev(world({ logs })), null);
  assert.equal(prev(world({ logs: { log_1_1_0_s0: set({ prescriptionExerciseId: null, exerciseNameSnapshot: 'Press banca' }) } })), null, 'same snapshot name, no PID');
});
test('T553.3 same POSITION + different PID => no result', () => {
  assert.equal(prev(world({ logs: W1() }), 1, 1, 'pidB', 'Remo'), null, 'another exercise at another position');
  assert.equal(prev(world({ logs: { log_1_1_0_s0: set({ prescriptionExerciseId: 'pidZ' }) } }), 1, 0, 'pidA'), null, 'same (day, exercise) slot, other PID');
});
test('T553.4 missing PID => no result, with or without matching positional evidence', () => {
  const logs = { log_1_1_0_s0: { carga: '80', reps: '10', done: true, unit: 'KG' } };   // legacy evidence, no PID
  assert.equal(prev(world({ logs }), 1, 0, '', 'Press banca'), null); assert.equal(prev(world({ logs }), 1, 0, null, 'Press banca'), null); assert.equal(prev(world({ logs: W1() }), 1, 0, '', 'Press banca'), null);
});
test('T553.5 ambiguous duplicate PID (same PID at two previous positions) => no result', () => { assert.equal(prev(world({ logs: Object.assign(W1(), { log_1_3_1_s0: set({}) }) })), null); });
test('T553.6 different plan => no result: the plan boundary is the loader (T552) and the resolver only knows PIDs; another plan\'s PID never matches', () => {
  assert.equal(prev(world({ logs: { log_1_1_0_s0: set({ prescriptionExerciseId: 'pid-of-plan-B' }) } })), null);
});
test('T553.7 Week 1 => no result; Week 3 with only Week 1 evidence => no fallback', () => {
  assert.equal(prev(world({ logs: W1(), week: 1 })), null); assert.equal(prev(world({ logs: W1(), week: 3 })), null);
});
test('T553.8 Express-only => no standard previous performance; mixed => only the standard sets; warm-up / autoFilled / undone excluded', () => {
  const ex = { log_1_1_0_s0: set({ express: true }), log_1_1_0_s1: set({ expressFinal: true }) }; assert.equal(prev(world({ logs: ex })), null);
  assert.equal(prev(world({ logs: Object.assign({ log_1_1_0_s0: set({ carga: '90' }) }, { log_1_1_0_s1: set({ express: true }) }) })).avgLoad, 90);
  for (const f of [{ warmup: true }, { autoFilled: true }, { done: false }]) assert.equal(prev(world({ logs: { log_1_1_0_s0: set(f) } })), null, JSON.stringify(f));
});
test('T553.9 substituted exposure => no plan-bound previous data (current substitute, or a previous substitute logged without the plan PID)', () => {
  assert.equal(prev(world({ logs: Object.assign(W1(), { exsub_2_1_0: { nombre: 'Otro' } }) })), null);
  assert.equal(prev(world({ logs: { log_1_1_0_s0: set({ prescriptionExerciseId: null }) } })), null);
});
test('T553.10 the resolver never substitutes the Coach prescription as athlete history, never reads names or positions', () => {
  assert.equal(prev(world({ logs: {} })), null, 'plan load 100 is not history');
  const body = fnSrc('_getPrevWeekData'); assert.ok(!/_normName|exerciseName|exerciseNameSnapshot|LOGS_BY_WEEK|'log_'\s*\+\s*prevWeek|legacySets/.test(body), 'no name guard, no positional loop in the previous-week helper');
  assert.ok(body.includes('_prevWeekRef') || body.includes('_prevWeekRefOf'), 'built on the canonical resolver (one identity model)');
});
test('T553.11 warm-up base: previous execution and exercise history are PID-only (no name-keyed history, COACH_PLAN is a labelled non-history source)', () => {
  const h = { pidA_key: 1 }; const w = world({ history: { 'press banca': { load: '70', unit: 'KG' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(w._getExerciseHistoryEntry('press banca', undefined))), {}, 'name-keyed history is no longer read');
  assert.deepEqual(JSON.parse(JSON.stringify(w._getExerciseHistoryEntry('press banca', ''))), {});
  const ph = SRC.includes('function _historyPidKey(') ? w._historyPidKey('pidA') : null; if (ph) { const w2 = world({ history: { [ph]: { load: '60', unit: 'KG' } } }); assert.equal(w2._getExerciseHistoryEntry('x', 'pidA').load, '60'); }
  const r = JSON.parse(JSON.stringify(w._warmupReferenceLoad(null, {}, null))); assert.equal(r.source, 'NONE', 'no PID evidence => no invented base');
  const r2 = JSON.parse(JSON.stringify(w._warmupReferenceLoad({ avgLoad: 80 }, {}, { load: 100 }))); assert.equal(r2.source, 'PREVIOUS_EXECUTION');
});
test('T553.12 history-day autofill reads the previous unit from the same resolver (no positional log key) and fails closed without PID evidence', () => {
  const mk = SRC.slice(SRC.indexOf('async function markSessionDoneFromHistory('), SRC.indexOf('async function markWeekCompleteFromHistory(')); assert.ok(!/prevSetKey/.test(mk) && /prev\.unit/.test(mk), 'unit comes from _getPrevWeekData');
  const wk = SRC.slice(SRC.indexOf('async function markWeekCompleteFromHistory('), SRC.indexOf('async function markWeekCompleteFromHistory(') + 6000); assert.ok(!/prevSetKey/.test(wk) && /prev\.unit/.test(wk));
});
test('T553.13 callers: the unused banner lookup is gone; advisory + warm-up + autofill share the one PID-only helper; no caller passes a name that could authorise a match', () => {
  assert.ok(!SRC.includes('var _prevWeekBanner = _getPrevWeekData('), 'LEGACY_UNUSED lookup removed');
  assert.ok(!/_getPrevWeekData\([^)]*(?:nombre|exerciseName|\.nombre)[^)]*\)/.test(SRC.replace(/function _getPrevWeekData\([^)]*\)/, '')), 'no caller passes an exercise name');
});
