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

const autoAdvance = new Function(`${extract('async function _autoAdvanceWeekIfDone(fromOtherWeekView) {')}\nreturn _autoAdvanceWeekIfDone;`)();

test('failed week advancement restores the persisted week context', async () => {
  global.LOGS = { done_1_0: { ts: 1 } };
  global.REAL_WEEK = 1;
  global.CURRENT_WEEK = 1;
  global._saveLogsTimer = null;
  global.getSesiones = () => [{ exercises: [] }];
  global.getTotalWeeks = () => 3;
  global._doSaveLogs = async () => false;
  global.showToast = () => {};
  let renders = 0;
  global.renderEntrenamiento = () => { renders++; };
  global.renderResumen = () => { renders++; };
  global._autoAdvanceDia = () => { throw new Error('must not advance UI after failed persistence'); };

  assert.equal(await autoAdvance(false), false);
  assert.equal(REAL_WEEK, 1);
  assert.equal(CURRENT_WEEK, 1);
  assert.equal(renders, 2);
});
