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

const guardarNutriLog = new Function(`${extract('async function guardarNutriLog() {')}\nreturn guardarNutriLog;`)();

test('failed nutrition save restores the prior daily entry', async () => {
  global.LOGS = { nutrilog_2026_09_22: { kcal: '2100', prot: '160' } };
  global.USER = { uid: 'client-a' };
  global._todayKey = () => '2026_09_22';
  global._doSaveLogs = async () => false;
  global.showToast = () => {};
  global.renderNutricion = () => {};
  const button = { disabled: false, textContent: '✓ GUARDAR REGISTRO' };
  global.document = {
    querySelector: () => button,
    getElementById: () => null
  };

  await guardarNutriLog();
  assert.deepEqual(LOGS.nutrilog_2026_09_22, { kcal: '2100', prot: '160' });
  assert.equal(button.disabled, false);
});
