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
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unbalanced ' + decl);
}

const runtime = new Function(`${extract('async function _submitPresession(di) {')}
${extract('async function _skipPresession(di) {')}
return { _submitPresession, _skipPresession };`)();

function setup(saveResult) {
  global.LOGS = {};
  global.CURRENT_WEEK = 2;
  global.USER = { uid: 'client-a' };
  global._preSelState = { energia: 4, sueno: 3, motivacion: 5 };
  const buttons = [{ disabled: false }, { disabled: false }];
  const overlay = { removed: false, querySelectorAll: () => buttons, remove() { this.removed = true; } };
  global.document = { getElementById: () => overlay };
  global._doSaveLogs = async () => saveResult;
  global.showToast = () => {};
  global._preSelect = () => {};
  return { buttons, overlay };
}

test('pre-session only closes after persistence succeeds', async () => {
  const ui = setup(true);
  assert.equal(await runtime._submitPresession(1), true);
  assert.deepEqual(LOGS.presession_pre_2_1.energia, 4);
  assert.equal(ui.overlay.removed, true);
});

test('pre-session failure restores the modal controls and removes the unsaved entry', async () => {
  const ui = setup(false);
  assert.equal(await runtime._submitPresession(1), false);
  assert.equal(LOGS.presession_pre_2_1, undefined);
  assert.equal(ui.overlay.removed, false);
  assert.ok(ui.buttons.every(button => button.disabled === false));
});

test('skip failure also keeps the pre-session modal open without a false success', async () => {
  const ui = setup(false);
  assert.equal(await runtime._skipPresession(1), false);
  assert.equal(LOGS.presession_pre_2_1, undefined);
  assert.equal(ui.overlay.removed, false);
  assert.ok(ui.buttons.every(button => button.disabled === false));
});
