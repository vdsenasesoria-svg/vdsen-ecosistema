const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
global.window = {};

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('function _historyPidKey(');
assert.notEqual(start, -1, 'T417 rebuild helper exists');
const end = client.indexOf('\nfunction showPRCelebration', start);
const rebuildSource = client.slice(start, end);

function rebuild(entries) {
  return new Function(`
    var LOGS = ${JSON.stringify(entries)};
    var EXERCISE_HISTORY = { press: { load: '100', reps: '8', rir: '2', unit: 'KG' } };
    function _normName(s) { return String(s).toLowerCase(); }
    function _convertCarga(v) { return v; }
    ${rebuildSource}
    _rebuildExerciseHistoryFromLogs('press', 'pid-press');
    return EXERCISE_HISTORY['__pid__pid-press'] || EXERCISE_HISTORY.press;
  `)();
}

test('T417: corrected 100 kg -> 90 kg replaces an unsupported history maximum', () => {
  const history = rebuild({
    log_1_0_0_s0: { done: true, carga: '90', reps: '10', rir_real: '1', unit: 'KG', prescriptionExerciseId: 'pid-press', ts: 2 }
  });
  assert.deepEqual(history, { load: '90', reps: '10', rir: '1', unit: 'KG', updatedAt: 2 });
});

test('T420: another legitimate 100 kg set keeps the valid maximum after correction', () => {
  const history = rebuild({
    log_1_0_0_s0: { done: true, carga: '90', reps: '10', rir_real: '1', unit: 'KG', prescriptionExerciseId: 'pid-press', ts: 2 },
    log_2_0_0_s0: { done: true, carga: '100', reps: '8', rir_real: '2', unit: 'KG', prescriptionExerciseId: 'pid-press', ts: 3 }
  });
  assert.equal(history.load, '100');
  assert.equal(history.reps, '8');
});
