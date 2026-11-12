/**
 * T107-H — showUpdatePlanModal apply button is disabled during write (in-flight guard)
 * Run: node tests/t107h-update-plan-inflight.test.js
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

console.log('T107-H — update-plan-inflight');

test('showUpdatePlanModal apply button checks disabled at start of onclick', function() {
  var body = extractFnBody(src, 'async function showUpdatePlanModal(');
  assert.ok(body, 'showUpdatePlanModal body found');
  assert.ok(body.indexOf('_updApplyBtn.disabled') > -1, '_updApplyBtn.disabled referenced');
  assert.ok(body.indexOf('if (_updApplyBtn.disabled) return') > -1, 'early return on disabled present');
});

test('showUpdatePlanModal disables apply button before updateDoc', function() {
  var body = extractFnBody(src, 'async function showUpdatePlanModal(');
  var disableIdx = body.indexOf('_updApplyBtn.disabled = true');
  var updateDocIdx = body.indexOf('await updateDoc');
  assert.ok(disableIdx > -1, 'disable before write present');
  assert.ok(updateDocIdx > disableIdx, 'updateDoc is after disable');
});

test('showUpdatePlanModal restores button on error', function() {
  var body = extractFnBody(src, 'async function showUpdatePlanModal(');
  assert.ok(body.indexOf("_updApplyBtn.textContent = 'Aplicar actualización'") > -1, 'button text restored on error');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
