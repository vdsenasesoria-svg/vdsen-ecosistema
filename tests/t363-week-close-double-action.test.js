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

test('rapid week-close taps open only one confirmation flow', async () => {
  global._markWeekPartialBusy = false;
  global.CURRENT_WEEK = 1;
  global.REAL_WEEK = 1;
  global.LOGS = {};
  global.getSesiones = () => [{ exercises: [] }];
  global.showToast = () => {};
  let resolveConfirm;
  let confirmations = 0;
  global._askConfirm = () => { confirmations++; return new Promise(resolve => { resolveConfirm = resolve; }); };

  const first = closeWeek();
  const second = closeWeek();
  assert.equal(confirmations, 1);
  resolveConfirm(false);
  await Promise.all([first, second]);
  assert.equal(_markWeekPartialBusy, false);
});
