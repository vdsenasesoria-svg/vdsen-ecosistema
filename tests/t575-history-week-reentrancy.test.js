'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
function extract(decl) {
  const start = source.indexOf(decl);
  assert.ok(start >= 0, 'missing ' + decl);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + decl);
}

const closeFromHistory = new Function(`${extract('async function markWeekCompleteFromHistory() {')}\nreturn markWeekCompleteFromHistory;`)();

test('T575-1 history-close refuses a second activation while its save is pending', async () => {
  global.CURRENT_WEEK = 2;
  global.REAL_WEEK = 2;
  global.LOGS = {};
  global.EXERCISE_HISTORY = {};
  global._saveLogsTimer = null;
  globalThis._markWeekHistoryBusy = false;
  global.getSesiones = () => [{ exercises: [] }];
  let confirmations = 0;
  global.confirm = () => { confirmations++; return true; };
  global.getAdjustedRIR = () => 2;
  global.calculateProgression = () => null;
  global.showToast = () => {};
  global._rebuildLogsByWeek = () => {};
  global.renderEntrenamiento = () => {};
  global.renderResumen = () => {};
  global._autoAdvanceWeekIfDone = async () => {};
  let saves = 0, resolveSave;
  global._doSaveLogs = () => { saves++; return new Promise(resolve => { resolveSave = resolve; }); };

  const first = closeFromHistory();
  const second = closeFromHistory();
  assert.equal(saves, 1);
  assert.equal(confirmations, 1, 'the second invocation must not show a duplicate confirmation');
  resolveSave(true);
  await Promise.all([first, second]);
  assert.equal(globalThis._markWeekHistoryBusy, false, 'the completed path remains retryable');
});

test('T575-2 the busy flag is always released, including a failed save', async () => {
  global.CURRENT_WEEK = 2;
  global.REAL_WEEK = 2;
  global.LOGS = {};
  global.EXERCISE_HISTORY = {};
  global._saveLogsTimer = null;
  globalThis._markWeekHistoryBusy = false;
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
  assert.equal(globalThis._markWeekHistoryBusy, false);
});
