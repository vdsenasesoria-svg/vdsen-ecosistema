/**
 * T099 — guardarCI has an in-flight guard preventing concurrent auto-save + manual save
 * Run: node tests/t099-guardarci-inflight-guard.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

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

console.log('T099 — guardarCI-inflight-guard');

test('_guardarCIInFlight flag declared', function() {
  assert.ok(src.indexOf('var _guardarCIInFlight = false') > -1, '_guardarCIInFlight flag present');
});

test('guardarCI early-returns when flag is set', function() {
  var body = extractFnBody(src, 'async function guardarCI()');
  assert.ok(body, 'guardarCI found');
  assert.ok(body.indexOf('if (_guardarCIInFlight) return') > -1, 'early-return guard present');
  assert.ok(body.indexOf('_guardarCIInFlight = true') > -1, 'flag set to true');
});

test('_guardarCIInFlight set before first await', function() {
  var body = extractFnBody(src, 'async function guardarCI()');
  var flagPos = body.indexOf('_guardarCIInFlight = true');
  var awaitPos = body.indexOf('await ');
  assert.ok(flagPos < awaitPos, 'flag set before first await (' + flagPos + ' < ' + awaitPos + ')');
});

test('_guardarCIInFlight reset in finally', function() {
  var body = extractFnBody(src, 'async function guardarCI()');
  assert.ok(body.indexOf('finally') > -1, 'finally block present');
  // finally block must contain the flag reset
  var finallyIdx = body.lastIndexOf('finally');
  var finallyBody = body.slice(finallyIdx);
  assert.ok(finallyBody.indexOf('_guardarCIInFlight = false') > -1, 'flag reset in finally');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
