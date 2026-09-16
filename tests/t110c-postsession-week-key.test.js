/**
 * T110-C — submitPostSession must use CURRENT_WEEK (not REAL_WEEK) for postsession_ key
 *
 * Bug: postsession key was built with REAL_WEEK, so marking a past-week session
 * as done while viewing week N (where N < REAL_WEEK) wrote post-session data into
 * the current training week's slot instead of the viewed week's slot.
 *
 * Run: node tests/t110c-postsession-week-key.test.js
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

console.log('T110-C — submitPostSession postsession_ week key');

test('submitPostSession exists', function() {
  assert.ok(src.indexOf('async function submitPostSession()') > -1, 'function declaration found');
});

test('postsession key uses CURRENT_WEEK', function() {
  var body = extractFnBody(src, 'async function submitPostSession()');
  assert.ok(body, 'function body extracted');
  assert.ok(
    body.indexOf("'postsession_'+CURRENT_WEEK+'_'+di") > -1,
    "postsession_ key must use CURRENT_WEEK"
  );
});

test('postsession key does NOT use REAL_WEEK', function() {
  var body = extractFnBody(src, 'async function submitPostSession()');
  assert.ok(body, 'function body extracted');
  assert.ok(
    body.indexOf("'postsession_'+REAL_WEEK+'_'+di") === -1,
    "postsession_ key must not use REAL_WEEK (causes wrong-week write)"
  );
});

test('progrec key also uses CURRENT_WEEK (consistency)', function() {
  var body = extractFnBody(src, 'async function submitPostSession()');
  assert.ok(body, 'function body extracted');
  assert.ok(
    body.indexOf("'progrec_'+CURRENT_WEEK+'_'+di") > -1,
    "progrec_ key must use CURRENT_WEEK for consistent week indexing"
  );
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
