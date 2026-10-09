const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('async function _doSaveLogs()');
assert.ok(start >= 0);
let depth = 0, end = client.indexOf('{', start);
for (; end < client.length; end++) {
  if (client[end] === '{') depth++;
  if (client[end] === '}' && --depth === 0) break;
}
const source = client.slice(start, end + 1);

test('T441: a save started by A never writes A payload to B after logout/login', async () => {
  const runtime = new Function(`
    var USER = { uid: 'A' }, ACTIVE_PLAN_ID = 'plan-a', REAL_WEEK = 1;
    var LOGS = { log_a: { done: true } }, EXERCISE_UNITS = {}, EXERCISE_HISTORY = {};
    var _saveLogsTimer = null, _logsWriteInFlight = 0, calls = [];
    var document = { getElementById: function(){ return null; }, createElement: function(){ return { style:{}, addEventListener:function(){} }; }, body:{ appendChild:function(){} } };
    var navigator = { onLine: true };
    function showToast() {} function _showSaveOk() {}
    var FB = {
      doc: function(){ return Array.prototype.join.call(arguments, '/'); },
      setDoc: async function(path, payload) { calls.push({ path:path, payload:payload }); if (calls.length === 1) USER = { uid: 'B' }; }
    };
    ${source}
    return { save: _doSaveLogs, calls: calls };
  `)();
  const ok = await runtime.save();
  assert.equal(ok, false);
  assert.deepEqual(runtime.calls.map(c => c.path), ['/logs/A/mesos/plan-a']);
});
