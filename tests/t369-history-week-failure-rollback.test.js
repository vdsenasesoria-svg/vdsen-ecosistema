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

const closeFromHistory = new Function(`${extract('async function markWeekCompleteFromHistory() {')}\nreturn markWeekCompleteFromHistory;`)();

test('failed history close rolls back its fabricated session closure evidence', async () => {
  global.CURRENT_WEEK = 2;
  global.REAL_WEEK = 2;
  global.LOGS = {};
  global.EXERCISE_HISTORY = {};
  global._saveLogsTimer = null;
  global.getSesiones = () => [{ exercises: [] }];
  global.confirm = () => true;
  global.getAdjustedRIR = () => 2;
  global.calculateProgression = () => null;
  global._doSaveLogs = async () => false;
  global.showToast = () => {};
  global._rebuildLogsByWeek = () => {};
  global.renderEntrenamiento = () => {};
  global.renderResumen = () => {};

  await closeFromHistory();
  assert.equal(LOGS.done_2_0, undefined);
  assert.equal(LOGS.postsession_2_0, undefined);
  assert.equal(LOGS.progrec_2_0, undefined);
});
