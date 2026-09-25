const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('async function _refreshLogsFromFirestore(reason) {');
assert.notEqual(start, -1, '_refreshLogsFromFirestore exists');
let depth = 0;
const brace = client.indexOf('{', start);
let end = brace;
for (; end < client.length; end++) {
  if (client[end] === '{') depth++;
  if (client[end] === '}' && --depth === 0) break;
}
const refreshSource = client.slice(start, end + 1);

function makeRuntime() {
  return new Function(`
    var USER = { uid: 'client-a' }, ACTIVE_PLAN_ID = 'plan-a';
    var CURRENT_WEEK = 1, REAL_WEEK = 1, _logsWriteInFlight = 1;
    var LOGS = { log_1_0_0_s0: { done: true, carga: '80' } };
    var EXERCISE_UNITS = {}, EXERCISE_HISTORY = {};
    var FB = {
      db: {}, doc: function() { return {}; },
      getDoc: async function() { return { exists: function() { return true; }, data: function() { return { planId: 'plan-a', currentWeek: 1, entries: {} }; } }; }
    };
    function _rebuildLogsByWeek() {}
    function renderEntrenamiento() {}
    function renderResumen() {}
    function showToast() {}
    ${refreshSource}
    return { refresh: _refreshLogsFromFirestore, log: function() { return LOGS.log_1_0_0_s0; } };
  `)();
}

test('T409: reentry sync cannot replace a pending local set with an older remote snapshot', async () => {
  const app = makeRuntime();
  await app.refresh('reentry');
  assert.deepEqual(app.log(), { done: true, carga: '80' });
});
