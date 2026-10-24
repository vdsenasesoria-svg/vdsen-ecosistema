/**
 * T106-H — training editor has a Descartar button that calls _discardTrainingEditorChanges
 * Run: node tests/t106h-discard-training-btn.test.js
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

console.log('T106-H — discard-training-btn');

test('renderTrainingEditor includes Descartar button', function() {
  var body = extractFnBody(src, 'function renderTrainingEditor(');
  assert.ok(body, 'renderTrainingEditor found');
  assert.ok(body.indexOf('_discardTrainingEditorChanges') > -1, '_discardTrainingEditorChanges call present');
  assert.ok(body.indexOf('Descartar') > -1, 'Descartar label present');
});

test('_discardTrainingEditorChanges is defined', function() {
  assert.ok(src.indexOf('function _discardTrainingEditorChanges(') > -1, '_discardTrainingEditorChanges defined');
});

test('_discardTrainingEditorChanges calls _discardEditorChanges and toggleTrainingEditor', function() {
  var body = extractFnBody(src, 'function _discardTrainingEditorChanges(');
  assert.ok(body, '_discardTrainingEditorChanges body found');
  assert.ok(body.indexOf('_discardEditorChanges') > -1, '_discardEditorChanges called');
  assert.ok(body.indexOf('toggleTrainingEditor') > -1, 'toggleTrainingEditor called');
});

test('_discardTrainingEditorChanges calls markEditorClean', function() {
  var body = extractFnBody(src, 'function _discardTrainingEditorChanges(');
  assert.ok(body.indexOf('markEditorClean') > -1, 'markEditorClean called');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
