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

test('a failed coach-history mirror keeps the primary check-in success feedback honest', async () => {
  global._guardarCIInFlight = false;
  global.CURRENT_WEEK = 2;
  global.LOGS = {};
  global.LOGS_BY_WEEK = { log: { 2: [] } };
  global._saveLogsTimer = null;
  global.USER = { uid: 'client-a', email: 'a@example.com' };
  global.window = { _ciSubjTemp: {} };
  global.ciKey = () => 'ci_sem_2';
  global.getSesiones = () => [];
  global._isRealExecution = () => false;
  global._doSaveLogs = async () => true;
  global.FB = { db: {}, doc: () => ({}), setDoc: async () => { throw new Error('offline mirror'); } };
  const toasts = [];
  global.showToast = message => toasts.push(message);
  global.renderResumen = () => {};
  global.document = { getElementById: () => null, querySelectorAll: () => [] };

  await guardarCI();
  assert.ok(toasts.some(message => /GUARDADO.*pendiente/.test(message)));
  assert.ok(!toasts.some(message => /^ERROR AL GUARDAR/.test(message)));
});
