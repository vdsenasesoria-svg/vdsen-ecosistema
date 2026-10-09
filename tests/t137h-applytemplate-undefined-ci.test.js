/**
 * T137-H — applyTemplate must not reference the undefined variable `ci`.
 *
 * Bug: applyTemplate created the plan (addDoc) and activated it
 * (updateDoc activePlanId) successfully, then executed
 * `showToast('Plan asignado a '+opts[ci].name+' ✅')` — but `ci` was never
 * declared anywhere in the function. This threw a ReferenceError, which the
 * surrounding catch(e) turned into `showToast('Error: ' + e.message, true)`.
 * The net effect: the plan WAS created and activated (writes already
 * committed), but the coach was shown a red "Error: ci is not defined" toast
 * telling them it failed — a false-failure report that could lead a coach to
 * retry and create a duplicate plan, or to manually "fix" a client that was
 * never actually broken.
 *
 * Fix: T137-H replaces `opts[ci].name` with `sel.name` — `sel` is the option
 * object already resolved by _selectModal() earlier in the same function and
 * carries the chosen client's { id, name }.
 *
 * Run: node tests/t137h-applytemplate-undefined-ci.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
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

console.log('T137-H — applyTemplate no longer references undefined `ci`');

var body = extractFnBody(src, 'async function applyTemplate(');

test('applyTemplate function is present', function () {
  assert.ok(body, 'applyTemplate function found in HTML source');
});

test('applyTemplate does not reference opts[ci] anywhere', function () {
  assert.ok(body, 'function body present');
  assert.ok(
    body.indexOf('opts[ci]') === -1,
    'applyTemplate must not reference the undefined variable `ci` via opts[ci]'
  );
});

test('applyTemplate does not declare or receive a `ci` variable', function () {
  assert.ok(body, 'function body present');
  // Guard against a future re-introduction under a different guise: `ci` must
  // not appear as a bare identifier (word boundary) anywhere in the body.
  assert.ok(
    !/\bci\b/.test(body),
    'applyTemplate must not reference an identifier named `ci` at all'
  );
});

test('applyTemplate reports the assigned client using sel.name', function () {
  assert.ok(body, 'function body present');
  assert.ok(
    body.indexOf("showToast('Plan asignado a '+sel.name+' ✅')") > -1,
    'success toast must use sel.name (the _selectModal result already in scope)'
  );
});

test('success toast appears after the client is actually activated (updateDoc)', function () {
  assert.ok(body, 'function body present');
  var updateDocIdx = body.indexOf('activePlanId: planRef.id');
  var toastIdx = body.indexOf("showToast('Plan asignado a '+sel.name+' ✅')");
  assert.ok(updateDocIdx > -1, 'activePlanId updateDoc present');
  assert.ok(toastIdx > -1, 'success toast present');
  assert.ok(updateDocIdx < toastIdx, 'success toast must come after activation write');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
