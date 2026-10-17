const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('async function _confirmSessionDone(di) {');
assert.notEqual(start, -1, '_confirmSessionDone exists');
let depth = 0;
const brace = client.indexOf('{', start);
let end = brace;
for (; end < client.length; end++) {
  if (client[end] === '{') depth++;
  if (client[end] === '}' && --depth === 0) break;
}
const confirmSource = client.slice(start, end + 1);

function makeRuntime() {
  return new Function(`
    var CURRENT_WEEK = 1, REAL_WEEK = 1, DIA_ACTIVO = 0;
    var LOGS = {}, _saveLogsTimer = null, advances = 0, renders = 0, toasts = 0;
    var navigator = { onLine: true };
    var resolveSave;
    function _doSaveLogs() { return new Promise(function(resolve) { resolveSave = resolve; }); }
    function _autoAdvanceDia() { advances++; }
    async function _autoAdvanceWeekIfDone() { advances++; }
    function renderEntrenamiento() { renders++; }
    function renderResumen() { renders++; }
    function showToast() { toasts++; }
    ${confirmSource}
    return {
      close: _confirmSessionDone,
      resolveSave: function(result) { resolveSave(result); },
      changeContext: function() { CURRENT_WEEK = 2; DIA_ACTIVO = 1; },
      state: function() { return { advances: advances, renders: renders, toasts: toasts, done: LOGS.done_1_0 }; }
    };
  `)();
}

test('T406: a closing session resolving in another week cannot navigate or report success there', async () => {
  const app = makeRuntime();
  const pending = app.close(0);
  app.changeContext();
  app.resolveSave(true);
  await pending;
  assert.deepEqual(app.state(), { advances: 0, renders: 0, toasts: 0, done: { ts: app.state().done.ts } });
});
