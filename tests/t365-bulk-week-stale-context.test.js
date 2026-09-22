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

const closeWeek = new Function(`${extract('async function markWeekDoneWithPartialData() {')}\nreturn markWeekDoneWithPartialData;`)();

test('bulk close aborts when its confirmation resolves in a different week context', async () => {
  global._markWeekPartialBusy = false;
  global.CURRENT_WEEK = 2;
  global.REAL_WEEK = 2;
  global.LOGS = {};
  global.getSesiones = () => [{ exercises: [] }];
  global.showToast = () => {};
  let resolveConfirm;
  global._askConfirm = () => new Promise(resolve => { resolveConfirm = resolve; });
  global._doSaveLogs = async () => { throw new Error('must not write stale context'); };

  const pending = closeWeek();
  global.CURRENT_WEEK = 3;
  global.REAL_WEEK = 3;
  resolveConfirm(true);
  await pending;
  assert.deepEqual(LOGS, {});
  assert.equal(_markWeekPartialBusy, false);
});
