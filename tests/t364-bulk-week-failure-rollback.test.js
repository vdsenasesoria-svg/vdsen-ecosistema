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

test('failed bulk close removes locally fabricated session closure evidence', async () => {
  global._markWeekPartialBusy = false;
  global.CURRENT_WEEK = 2;
  global.REAL_WEEK = 2;
  global.LOGS = {};
  global._saveLogsTimer = null;
  global.getSesiones = () => [{ exercises: [] }];
  global._askConfirm = async () => true;
  global._doSaveLogs = async () => false;
  global.showToast = () => {};
  let rebuilt = 0;
  global._rebuildLogsByWeek = () => { rebuilt++; };
  let renders = 0;
  global.renderEntrenamiento = () => { renders++; };
  global.renderResumen = () => { renders++; };

  await closeWeek();
  assert.equal(LOGS.done_2_0, undefined);
  assert.equal(LOGS.postsession_2_0, undefined);
  assert.equal(LOGS.progrec_2_0, undefined);
  assert.equal(rebuilt, 1);
  assert.equal(renders, 2);
  assert.equal(_markWeekPartialBusy, false);
});
