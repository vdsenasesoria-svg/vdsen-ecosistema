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

test('history close does not advance or render after navigation changes week context', async () => {
  global.CURRENT_WEEK = 2;
  global.REAL_WEEK = 2;
  global.LOGS = {};
  global.EXERCISE_HISTORY = {};
  global._saveLogsTimer = null;
  global.getSesiones = () => [{ exercises: [] }];
  global.confirm = () => true;
  global.getAdjustedRIR = () => 2;
  global.calculateProgression = () => null;
  global.showToast = () => {};
  global._rebuildLogsByWeek = () => {};
  let resolveSave, advances = 0, renders = 0;
  global._doSaveLogs = () => new Promise(resolve => { resolveSave = resolve; });
  global._autoAdvanceWeekIfDone = async () => { advances++; };
  global.renderEntrenamiento = () => { renders++; };
  global.renderResumen = () => { renders++; };

  const pending = closeFromHistory();
  global.CURRENT_WEEK = 3;
  global.REAL_WEEK = 3;
  resolveSave(true);
  await pending;
  assert.equal(advances, 0);
  assert.equal(renders, 0);
});
