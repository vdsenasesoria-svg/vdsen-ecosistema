/**
 * T103-H — _updateDirtyTabUI also updates the training editor save button
 * Run: node tests/t103h-dirty-training-btn.test.js
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

console.log('T103-H — dirty-training-btn');

test('_updateDirtyTabUI queries the saveTrainingPlan button', function() {
  var body = extractFnBody(src, 'function _updateDirtyTabUI(isDirty)');
  assert.ok(body, '_updateDirtyTabUI found');
  assert.ok(body.indexOf('saveTrainingPlan') > -1, 'saveTrainingPlan selector present');
});

test('_updateDirtyTabUI guards against disabled button', function() {
  var body = extractFnBody(src, 'function _updateDirtyTabUI(isDirty)');
  assert.ok(body.indexOf('tBtn.disabled') > -1, 'disabled guard present');
});

test('_updateDirtyTabUI sets warning text on dirty', function() {
  var body = extractFnBody(src, 'function _updateDirtyTabUI(isDirty)');
  assert.ok(body.indexOf('⚠️ Guardar cambios') > -1, 'warning text present');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
