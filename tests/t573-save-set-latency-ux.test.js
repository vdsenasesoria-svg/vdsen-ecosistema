'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CLIENT = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fn(name) {
  const start = CLIENT.indexOf(name); assert.ok(start >= 0, name + ' missing');
  const brace = CLIENT.indexOf('{', start); let depth = 0;
  for (let i = brace; i < CLIENT.length; i++) { if (CLIENT[i] === '{') depth++; else if (CLIENT[i] === '}' && --depth === 0) return CLIENT.slice(start, i + 1); }
  throw new Error('unbalanced ' + name);
}
const complete = fn('async function completeSet(');
const save = fn('async function _doSaveLogs()');

test('T573 save-set telemetry covers the full click-to-settlement path', () => {
  for (const metric of ['CLICK_TO_VISUAL_FEEDBACK','CLICK_TO_LOCAL_STATE_UPDATE','CLICK_TO_FIRESTORE_REQUEST_START','FIRESTORE_REQUEST_DURATION','CLICK_TO_FINAL_SETTLEMENT','RENDER_TIME_AFTER_SAVE']) assert.ok(CLIENT.includes(metric), metric);
  assert.ok(complete.indexOf("_measureSaveSet(key, 'VISUAL_FEEDBACK')") < complete.indexOf('LOGS[key] = {'));
  assert.ok(complete.indexOf("_measureSaveSet(key, 'LOCAL_STATE_UPDATE')") < complete.indexOf('await _doSaveLogs()'));
  assert.ok(complete.includes("_measureSaveSet(key, 'FINAL_SETTLEMENT')") && complete.includes("_measureSaveSet(key, 'RENDER_COMPLETE')"));
});

test('T573 starts the two authoritative log writes before waiting', () => {
  const mesoStart = save.indexOf('var _mesoWrite = ACTIVE_PLAN_ID');
  const rootStart = save.indexOf('var _rootWrite = Promise.resolve();');
  const wait = save.indexOf('await Promise.all([_mesoWrite, _rootWrite]);');
  assert.ok(mesoStart >= 0 && rootStart > mesoStart && wait > rootStart);
  assert.ok(save.includes("_measureSaveSet(_saveSetMeasurementActiveKey, 'FIRESTORE_REQUEST_START')"));
  assert.ok(save.includes("_measureSaveSet(_saveSetMeasurementActiveKey, 'FIRESTORE_REQUEST_END')"));
});

test('T573 preserves truthful retry, identity and accessible sticky action contracts', () => {
  assert.ok(complete.includes('if (_setSaved === false)') && complete.includes('NO SE GUARDÓ'));
  assert.ok(complete.includes('if (_saveBtn && _saveBtn.disabled) return;'));
  assert.ok(complete.includes('prescriptionExerciseId: _logPid || undefined'));
  assert.ok(CLIENT.includes('.workout-set-current .set-actions{position:sticky'));
  assert.ok(CLIENT.includes('env(safe-area-inset-bottom,0px)'));
  assert.ok(CLIENT.includes('aria-busy'));
});
