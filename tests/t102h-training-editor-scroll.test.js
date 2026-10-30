/**
 * T102-H — toggleTrainingEditor scrolls editor into view when opening
 * Run: node tests/t102h-training-editor-scroll.test.js
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

console.log('T102-H — training-editor-scroll');

test('toggleTrainingEditor calls scrollIntoView when opening', function() {
  var body = extractFnBody(src, 'function toggleTrainingEditor()');
  assert.ok(body, 'toggleTrainingEditor found');
  assert.ok(body.indexOf('scrollIntoView') > -1, 'scrollIntoView present');
  assert.ok(body.indexOf("behavior: 'smooth'") > -1, 'smooth behavior present');
  assert.ok(body.indexOf("block: 'start'") > -1, "block: 'start' present");
});

test('scrollIntoView is guarded by !open branch only', function() {
  var body = extractFnBody(src, 'function toggleTrainingEditor()');
  // scrollIntoView must be inside the if (!open) block
  var ifOpenIdx = body.indexOf('if (!open)');
  var scrollIdx = body.indexOf('scrollIntoView');
  assert.ok(ifOpenIdx > -1, 'if (!open) block present');
  assert.ok(scrollIdx > ifOpenIdx, 'scrollIntoView is after if (!open) check');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
