// T126-C: guardarNutriLog must await a real Firestore write, not a debounced timer
// Bug: before the fix, `await saveLogs()` resolved immediately (saveLogs just sets a
// debounce timer) so the success toast always fired even when Firestore failed.
'use strict';
const assert = require('assert');
const fs = require('fs');

const CLIENT = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

// Extract guardarNutriLog function body
function extractFnBody(src, name) {
  var search = 'async function ' + name + '(';
  var idx = src.indexOf(search);
  if (idx === -1) return null;
  var depth = 0, start = src.indexOf('{', idx);
  for (var i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

var fnBody = extractFnBody(CLIENT, 'guardarNutriLog');
assert.ok(fnBody, 'guardarNutriLog function must exist');

// 1. Must use _doSaveLogs() (direct write), not saveLogs() (debounced)
assert.ok(
  fnBody.includes('_doSaveLogs()'),
  'guardarNutriLog must call _doSaveLogs() for a real write'
);
assert.ok(
  !fnBody.includes('await saveLogs()'),
  'guardarNutriLog must NOT use `await saveLogs()` (debounced — always resolves immediately)'
);

// 2. Must check the return value for failure
assert.ok(
  fnBody.includes('_ok') && fnBody.includes('=== false'),
  'guardarNutriLog must check _doSaveLogs() return value for failure'
);

// 3. Success toast must come after the failure check
var toastIdx = fnBody.indexOf("showToast('✓ Registro nutricional guardado')");
var falseCheckIdx = fnBody.indexOf('=== false');
assert.ok(toastIdx > falseCheckIdx, 'success toast must come after the === false failure check');

// 4. Button re-enable must be in finally
assert.ok(
  /finally\s*\{[\s\S]{1,200}disabled\s*=\s*false/.test(fnBody),
  'guardarNutriLog must re-enable button in finally block'
);

console.log('# T126-C PASS: guardarNutriLog uses _doSaveLogs and guards success toast');
