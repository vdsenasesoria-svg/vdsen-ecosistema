'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('vdsen-cliente.html', 'utf8');

function extractFunction(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature + ' exists');
  let depth = 0;
  let end = source.indexOf('{', start);
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) return source.slice(start, end + 1);
  }
  throw new Error('unterminated ' + signature);
}

const confirm = extractFunction('async function _confirmSessionDone(di)');
const partial = extractFunction('async function _endSessionAsPartial(di)');
const stop = extractFunction('function stopRestTimer()');

for (const [name, fn] of [['complete', confirm], ['partial', partial]]) {
  const saved = fn.indexOf('var _ok = await _doSaveLogs();') >= 0
    ? fn.indexOf('var _ok = await _doSaveLogs();')
    : fn.indexOf('var ok = await _doSaveLogs();');
  const stopAt = fn.indexOf('stopRestTimer();');
  assert.ok(stopAt > saved, name + ' closure stops an already-active rest timer only after persistence succeeds');
  assert.ok(stopAt < fn.indexOf('renderEntrenamiento();', stopAt), name + ' closure clears rest UI before the closed session renders');
}

assert.ok(stop.includes('_restEndMs = 0'), 'rest state clears its end timestamp');
assert.ok(stop.includes("localStorage.removeItem('vdsen_restEnd')"), 'rest state clears persisted recovery data');
assert.ok(stop.includes('window._nextAction25 = null'), 'rest next-action CTA is cleared');

console.log('T465 — completed session clears active rest timer: PASS');
