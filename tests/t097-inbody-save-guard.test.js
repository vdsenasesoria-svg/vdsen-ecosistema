/**
 * T097 — _inbodySave has a double-click guard and button feedback
 * Run: node tests/t097-inbody-save-guard.test.js
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

console.log('T097 — inbody-save-guard');

test('_savingInbody flag declared', function() {
  assert.ok(src.indexOf('var _savingInbody = false') > -1, '_savingInbody flag present');
});

test('_inbodySave early-returns when flag is set', function() {
  var body = extractFnBody(src, 'async function _inbodySave(clientId)');
  assert.ok(body, '_inbodySave found');
  assert.ok(body.indexOf('if (_savingInbody) return') > -1, 'early-return guard present');
  assert.ok(body.indexOf('_savingInbody = true') > -1, 'flag set to true');
});

test('_inbodySave disables button before await', function() {
  var body = extractFnBody(src, 'async function _inbodySave(clientId)');
  assert.ok(body.indexOf('.disabled = true') > -1, 'disabled = true present');
  assert.ok(body.indexOf('Guardando') > -1, 'Guardando text present');
  var disabledPos = body.indexOf('.disabled = true');
  var awaitPos    = body.indexOf('await ');
  assert.ok(disabledPos < awaitPos, 'button disabled before await (' + disabledPos + ' < ' + awaitPos + ')');
});

test('_inbodySave restores button in finally', function() {
  var body = extractFnBody(src, 'async function _inbodySave(clientId)');
  assert.ok(body.indexOf('finally') > -1, 'finally block present');
  assert.ok(body.indexOf('_savingInbody = false') > -1, 'flag reset in finally');
  assert.ok(body.indexOf('.disabled = false') > -1, 'disabled = false in finally');
  var catchPos   = body.lastIndexOf('catch');
  var finallyPos = body.lastIndexOf('finally');
  assert.ok(finallyPos > catchPos, 'finally after catch');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
