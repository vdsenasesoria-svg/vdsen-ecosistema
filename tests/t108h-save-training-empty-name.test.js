/**
 * T108-H — saveTrainingPlan warns and blocks if any exercise has an empty name
 * Run: node tests/t108h-save-training-empty-name.test.js
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

console.log('T108-H — save-training-empty-name');

test('saveTrainingPlan checks for empty exercise names before writing', function() {
  var body = extractFnBody(src, 'async function saveTrainingPlan(');
  assert.ok(body, 'saveTrainingPlan found');
  assert.ok(body.indexOf('_hasEmptyName') > -1, '_hasEmptyName check present');
});

test('saveTrainingPlan shows warning toast on empty name', function() {
  var body = extractFnBody(src, 'async function saveTrainingPlan(');
  var emptyCheckIdx = body.indexOf('_hasEmptyName');
  var toastIdx = body.indexOf("ejercicios sin nombre");
  assert.ok(toastIdx > -1, 'empty-name warning toast present');
  assert.ok(toastIdx > emptyCheckIdx, 'toast is after empty name check');
});

test('saveTrainingPlan restores button state on early return for empty name', function() {
  var body = extractFnBody(src, 'async function saveTrainingPlan(');
  var emptyCheckIdx = body.indexOf('_hasEmptyName');
  // Should reset _savingTrainingPlan and button before the early return
  var resetIdx = body.indexOf('_savingTrainingPlan = false', emptyCheckIdx);
  assert.ok(resetIdx > emptyCheckIdx, '_savingTrainingPlan reset before early return');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
