/**
 * T104-H — removeExRow asks for confirmation before deleting an exercise
 * Run: node tests/t104h-remove-ex-confirm.test.js
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

console.log('T104-H — remove-ex-confirm');

test('removeExRow is declared async', function() {
  assert.ok(src.indexOf('async function removeExRow(') > -1, 'async function removeExRow found');
});

test('removeExRow calls _askConfirm before removing', function() {
  var body = extractFnBody(src, 'async function removeExRow(');
  assert.ok(body, 'removeExRow body found');
  var askIdx = body.indexOf('_askConfirm');
  var removeIdx = body.indexOf('el.remove()');
  assert.ok(askIdx > -1, '_askConfirm present');
  assert.ok(removeIdx > askIdx, 'el.remove() is after _askConfirm');
});

test('removeExRow returns early when confirmation refused', function() {
  var body = extractFnBody(src, 'async function removeExRow(');
  assert.ok(body.indexOf('return') > -1, 'early return present');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
