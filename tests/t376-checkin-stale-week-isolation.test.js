'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
function extract(decl) {
  const start = source.indexOf(decl);
  if (start < 0) throw new Error('Missing ' + decl);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unbalanced ' + decl);
}

const guardarCI = new Function(`${extract('async function guardarCI() {')}\nreturn guardarCI;`)();

test('check-in never mirrors an old-week save into a newly selected week', async () => {
  global._guardarCIInFlight = false;
  global.CURRENT_WEEK = 2;
  global.LOGS = {};
  global.LOGS_BY_WEEK = { log: { 2: [], 3: [] } };
  global._saveLogsTimer = null;
  global.USER = { uid: 'client-a', email: 'a@example.com' };
  global.window = { _ciSubjTemp: {} };
  global.ciKey = () => 'ci_sem_' + CURRENT_WEEK;
  global.getSesiones = () => [];
  global._isRealExecution = () => false;
  let resolveSave, historyWrites = 0, renders = 0;
  global._doSaveLogs = () => new Promise(resolve => { resolveSave = resolve; });
  global.FB = { db: {}, doc: () => ({}), setDoc: async () => { historyWrites++; } };
  global.showToast = () => {};
  global.renderResumen = () => { renders++; };
  global.document = { getElementById: () => null, querySelectorAll: () => [] };

  const pending = guardarCI();
  global.CURRENT_WEEK = 3;
  resolveSave(true);
  await pending;
  assert.equal(historyWrites, 0);
  assert.equal(renders, 0);
  assert.equal(_guardarCIInFlight, false);
});
