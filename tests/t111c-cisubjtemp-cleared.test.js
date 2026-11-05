/**
 * T111-C — guardarCI must clear window._ciSubjTemp after a successful save
 *
 * Bug: _ciSubjTemp (Ehrenstein subjective questionnaire button buffer) was never
 * reset after a successful guardarCI(). Stale values from week N silently bled
 * into week N+1 if the user saved check-in without re-clicking the buttons,
 * corrupting subj_score and individual field values in the coach's panel.
 *
 * Run: node tests/t111c-cisubjtemp-cleared.test.js
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

console.log('T111-C — guardarCI clears _ciSubjTemp after save');

test('guardarCI exists', function() {
  assert.ok(src.indexOf('async function guardarCI()') > -1, 'function declaration found');
});

test('_ciSubjTemp is used in guardarCI', function() {
  var body = extractFnBody(src, 'async function guardarCI()');
  assert.ok(body, 'function body extracted');
  assert.ok(body.indexOf('_ciSubjTemp') > -1, '_ciSubjTemp referenced inside guardarCI');
});

test('_ciSubjTemp is reset to null inside guardarCI try block', function() {
  var body = extractFnBody(src, 'async function guardarCI()');
  assert.ok(body, 'function body extracted');
  assert.ok(
    body.indexOf('window._ciSubjTemp = null') > -1,
    'window._ciSubjTemp must be set to null after successful save'
  );
});

test('_ciSubjTemp reset occurs before the outer catch (ERROR AL GUARDAR)', function() {
  var body = extractFnBody(src, 'async function guardarCI()');
  assert.ok(body, 'function body extracted');
  var resetPos     = body.indexOf('window._ciSubjTemp = null');
  // Identify the outer catch by its unique error string rather than the first } catch(e)
  // (the function contains inner catches for adherencia/RIR calculations that come first)
  var outerCatchPos = body.indexOf('ERROR AL GUARDAR');
  assert.ok(resetPos > -1, 'reset present');
  assert.ok(outerCatchPos > -1, 'outer catch landmark (ERROR AL GUARDAR) present');
  // reset must appear before the outer catch success path ends
  assert.ok(resetPos < outerCatchPos, 'reset (' + resetPos + ') before outer catch (' + outerCatchPos + ')');
});

test('setCISubj still writes to _ciSubjTemp', function() {
  var setCIBody = extractFnBody(src, 'function setCISubj(');
  assert.ok(setCIBody, 'setCISubj body extracted');
  assert.ok(setCIBody.indexOf('_ciSubjTemp') > -1, 'setCISubj still uses _ciSubjTemp');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
