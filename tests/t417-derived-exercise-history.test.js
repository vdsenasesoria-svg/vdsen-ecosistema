const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('function _rebuildExerciseHistoryFromLogs(exNameKey, prescriptionExerciseId) {');
assert.notEqual(start, -1, 'T417 rebuild helper exists');
let depth = 0;
const brace = client.indexOf('{', start);
let end = brace;
for (; end < client.length; end++) {
  if (client[end] === '{') depth++;
  if (client[end] === '}' && --depth === 0) break;
}
const rebuildSource = client.slice(start, end + 1);

function rebuild(entries) {
  return new Function(`
    var LOGS = ${JSON.stringify(entries)};
    var EXERCISE_HISTORY = { press: { load: '100', reps: '8', rir: '2', unit: 'KG' } };
    function _normName(s) { return String(s).toLowerCase(); }
    function _convertCarga(v) { return v; }
    ${rebuildSource}
    _rebuildExerciseHistoryFromLogs('press', 'pid-press');
    return EXERCISE_HISTORY.press;
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
