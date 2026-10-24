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

const submitPostSession = new Function(`${extract('async function submitPostSession() {')}\nreturn submitPostSession;`)();

test('failed completion cannot leave post-session evidence queued for a later save', async () => {
  global._postSessionSubmitting = false;
  global._postSessionDi = 0;
  global.CURRENT_WEEK = 3;
  global.LOGS = { engine_state: { prior: true } };
  const inputs = {
    psEimd: { value: '2' }, psArticular: { value: 'no' },
    psArticularPatternSel: { value: '' }, psSueno: { value: '7' }, psRpe: { value: '8' }
  };
  global.document = { getElementById: id => inputs[id] };
  global.closePostSessionModal = () => {};
  global.calculateProgression = () => ({ engineState: { new: true }, action: 'freeze_load' });
  global._confirmSessionDone = async () => false;
  global.showSessionSummary = () => { throw new Error('summary must not open after a failed save'); };
  global.showToast = () => {};

  assert.equal(await submitPostSession(), false);
  assert.equal(LOGS.postsession_3_0, undefined);
  assert.equal(LOGS.progrec_3_0, undefined);
  assert.deepEqual(LOGS.engine_state, { prior: true });
  assert.equal(_postSessionSubmitting, false);
});
