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

const markSessionDone = new Function(`${extract('async function markSessionDone(di) {')}\nreturn markSessionDone;`)();

test('failed session reopen restores its done entry and week context', async () => {
  const done = { ts: 100, partial: true };
  global.LOGS = { done_2_0: done };
  global.CURRENT_WEEK = 2;
  global.REAL_WEEK = 2;
  global._markSessionBusy = {};
  global._saveLogsTimer = null;
  global.getSesiones = () => [{ exercises: [] }];
  global.getTotalWeeks = () => 6;
  global._doSaveLogs = async () => false;
  global.showToast = () => {};
  let renders = 0;
  global.renderEntrenamiento = () => { renders++; };
  global.renderResumen = () => { renders++; };

  await markSessionDone(0);
  assert.equal(LOGS.done_2_0, done);
  assert.equal(REAL_WEEK, 2);
  assert.equal(CURRENT_WEEK, 2);
  assert.equal(_markSessionBusy[0], false);
  assert.equal(renders, 2);
});
