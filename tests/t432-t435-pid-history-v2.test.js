const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('function _historyPidKey(');
const end = client.indexOf('\nfunction showPRCelebration', start);
assert.ok(start >= 0 && end > start);
global.window = {};
const make = new Function('EXERCISE_HISTORY', 'LOGS', '_normName', '_convertCarga',
  client.slice(start, end) + '; return { rebuild: _rebuildExerciseHistoryFromLogs, get: _getExerciseHistoryEntry };');

test('T432/T435: same-name PIDs isolate and rebuild corrections independently', () => {
  const history = {};
  const logs = {
    log_a: { done: true, exerciseNameSnapshot: 'Press', prescriptionExerciseId: 'pid-a', carga: '90', reps: '8', rir_real: '2', unit: 'KG', ts: 3 },
    log_b: { done: true, exerciseNameSnapshot: 'Press', prescriptionExerciseId: 'pid-b', carga: '80', reps: '10', rir_real: '1', unit: 'KG', ts: 2 }
  };
  const api = make(history, logs, v => String(v).toLowerCase(), v => Number(v));
  api.rebuild('press', 'pid-a');
  api.rebuild('press', 'pid-b');
  assert.equal(api.get('press', 'pid-a').load, '90');
  assert.equal(api.get('press', 'pid-b').load, '80');
  logs.log_a.carga = '70';
  api.rebuild('press', 'pid-a');
  assert.equal(api.get('press', 'pid-a').load, '70');
  assert.equal(api.get('press', 'pid-b').load, '80');
});

test('T433: same PID keeps continuity when display name changes', () => {
  const history = {};
  const logs = { log_a: { done: true, exerciseNameSnapshot: 'Remo nuevo', prescriptionExerciseId: 'pid-a', carga: '100', reps: '6', rir_real: '2', unit: 'KG', ts: 1 } };
  const api = make(history, logs, v => String(v).toLowerCase(), v => Number(v));
  api.rebuild('remo antiguo', 'pid-a');
  assert.equal(api.get('remo nuevo', 'pid-a').load, '100');
});

test('T434: legacy name-only history remains a deterministic fallback', () => {
  const history = { press: { load: '75', reps: '8', rir: '2', unit: 'KG' } };
  const api = make(history, {}, v => String(v).toLowerCase(), v => Number(v));
  assert.equal(api.get('press', 'pid-legacy').load, '75');
});
