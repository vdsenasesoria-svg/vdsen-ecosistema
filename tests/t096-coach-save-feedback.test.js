/**
 * T096 — Coach nutrition/supplement save buttons have in-flight feedback
 * Run: node tests/t096-coach-save-feedback.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-coach.html', 'utf8');

// Extract the body of each function for inspection
function extractFnBody(src, fnDecl) {
  var idx = src.indexOf(fnDecl);
  if (idx === -1) return null;
  // Find the matching closing brace by counting braces
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

console.log('T096 — coach-save-feedback');

test('saveNutritionPlan disables button before async operation', function() {
  var body = extractFnBody(src, 'async function saveNutritionPlan()');
  assert.ok(body, 'saveNutritionPlan found');
  // Button must be grabbed and disabled BEFORE the await
  var btnGrab = body.indexOf('querySelector(\'[onclick="saveNutritionPlan()"]\')')
             || body.indexOf('querySelector("[onclick=\\"saveNutritionPlan()\\"]")');
  assert.ok(body.indexOf('querySelector') > -1, 'querySelector present');
  assert.ok(body.indexOf('.disabled = true') > -1, 'disabled = true present');
  assert.ok(body.indexOf('Guardando') > -1, 'Guardando text present');
  // disabled must appear before first await
  var disabledPos = body.indexOf('.disabled = true');
  var awaitPos    = body.indexOf('await ');
  assert.ok(disabledPos < awaitPos, 'button disabled before await (' + disabledPos + ' < ' + awaitPos + ')');
});

test('saveNutritionPlan restores button in finally', function() {
  var body = extractFnBody(src, 'async function saveNutritionPlan()');
  assert.ok(body.indexOf('finally') > -1, 'finally block present');
  assert.ok(body.indexOf('.disabled = false') > -1, 'disabled = false in finally');
  // finally must come after catch
  var catchPos   = body.lastIndexOf('catch');
  var finallyPos = body.lastIndexOf('finally');
  assert.ok(finallyPos > catchPos, 'finally after catch');
});

test('saveSupplementPlan disables button before async operation', function() {
  var body = extractFnBody(src, 'async function saveSupplementPlan()');
  assert.ok(body, 'saveSupplementPlan found');
  assert.ok(body.indexOf('querySelector') > -1, 'querySelector present');
  assert.ok(body.indexOf('.disabled = true') > -1, 'disabled = true present');
  assert.ok(body.indexOf('Guardando') > -1, 'Guardando text present');
  var disabledPos = body.indexOf('.disabled = true');
  var awaitPos    = body.indexOf('await ');
  assert.ok(disabledPos < awaitPos, 'button disabled before await (' + disabledPos + ' < ' + awaitPos + ')');
});

test('saveSupplementPlan restores button in finally', function() {
  var body = extractFnBody(src, 'async function saveSupplementPlan()');
  assert.ok(body.indexOf('finally') > -1, 'finally block present');
  assert.ok(body.indexOf('.disabled = false') > -1, 'disabled = false in finally');
  var catchPos   = body.lastIndexOf('catch');
  var finallyPos = body.lastIndexOf('finally');
  assert.ok(finallyPos > catchPos, 'finally after catch');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
