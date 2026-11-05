/**
 * T105-H — removeExercise (manual plan editor) asks for confirmation before deleting
 * Run: node tests/t105h-remove-exercise-confirm.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-coach.html', 'utf8');

function extractFnBody(src, fnDecl) {
  var idx = src.indexOf(fnDecl);
  if (idx === -1) return null;
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

console.log('T105-H — remove-exercise-confirm (manual plan editor)');

test('removeExercise is declared async', function() {
  assert.ok(src.indexOf('async function removeExercise(') > -1, 'async function removeExercise found');
});

test('removeExercise calls _askConfirm before splice', function() {
  var body = extractFnBody(src, 'async function removeExercise(');
  assert.ok(body, 'removeExercise body found');
  var askIdx = body.indexOf('_askConfirm');
  var spliceIdx = body.indexOf('splice');
  assert.ok(askIdx > -1, '_askConfirm present');
  assert.ok(spliceIdx > askIdx, 'splice is after _askConfirm');
});

test('removeExercise returns early when confirmation refused', function() {
  var body = extractFnBody(src, 'async function removeExercise(');
  assert.ok(body.indexOf('return') > -1, 'early return present');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
