/**
 * T100 — saveImportedPlan guard is unconditional (not bypassed by clientIdArg)
 * Run: node tests/t100-save-imported-plan-guard.test.js
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

console.log('T100 — save-imported-plan-guard');

test('saveImportedPlan guard is unconditional (no !clientIdArg bypass)', function() {
  var body = extractFnBody(src, 'async function saveImportedPlan(clientIdArg)');
  assert.ok(body, 'saveImportedPlan found');
  // Must NOT have the old bypassed guard
  assert.ok(body.indexOf('_savingImportedPlan && !clientIdArg') === -1, 'old bypassed guard must NOT be present');
  // Must have unconditional guard
  assert.ok(body.indexOf('if (_savingImportedPlan) return') > -1, 'unconditional guard present');
});

test('_submitModalImport disables its button before await', function() {
  var idx = src.indexOf('window._submitModalImport = async function');
  assert.ok(idx > -1, '_submitModalImport found');
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  var body = src.slice(start, i + 1);
  assert.ok(body.indexOf('.disabled = true') > -1, 'disabled = true present');
  assert.ok(body.indexOf('Guardando') > -1, 'Guardando text present');
  var disabledPos = body.indexOf('.disabled = true');
  var awaitPos    = body.indexOf('await ');
  assert.ok(disabledPos < awaitPos, 'button disabled before first await (' + disabledPos + ' < ' + awaitPos + ')');
});

test('_submitModalImport restores button in finally', function() {
  var idx = src.indexOf('window._submitModalImport = async function');
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  var body = src.slice(start, i + 1);
  assert.ok(body.indexOf('finally') > -1, 'finally block present');
  var finallyIdx = body.lastIndexOf('finally');
  var finallyBody = body.slice(finallyIdx);
  assert.ok(finallyBody.indexOf('.disabled = false') > -1, 'button restored in finally');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
