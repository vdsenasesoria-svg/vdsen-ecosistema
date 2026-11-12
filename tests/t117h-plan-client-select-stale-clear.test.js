/**
 * T117-H — planClientSelect onchange must clear window._importedPlan and planBuilder
 * so a plan parsed for client A is never accidentally saved to client B after a
 * client-switch in the Plan section selector.
 *
 * Bug: loadClientsSelect() populated the <select> but never wired an onchange handler.
 * Changing planClientSelect to client B left window._importedPlan holding client A's
 * plan. A subsequent "Guardar y activar plan" click would write client A's plan to B.
 *
 * Fix: loadClientsSelect() now assigns select.onchange to null-out _importedPlan,
 * clear planBuilder.innerHTML, and clear autoGenStatus.innerHTML.
 *
 * Run: node tests/t117h-plan-client-select-stale-clear.test.js
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

console.log('T117-H — planClientSelect stale-plan clear on change');

test('loadClientsSelect assigns onchange to planClientSelect', function() {
  var body = extractFnBody(src, 'async function loadClientsSelect(');
  assert.ok(body, 'loadClientsSelect found');
  assert.ok(body.indexOf('select.onchange') > -1,
    'select.onchange is assigned inside loadClientsSelect');
});

test('onchange handler nulls out window._importedPlan', function() {
  var body = extractFnBody(src, 'async function loadClientsSelect(');
  assert.ok(body, 'loadClientsSelect found');
  assert.ok(
    body.indexOf('window._importedPlan = null') > -1 ||
    body.indexOf("window._importedPlan=null") > -1,
    'onchange clears window._importedPlan'
  );
});

test('onchange handler clears planBuilder innerHTML', function() {
  var body = extractFnBody(src, 'async function loadClientsSelect(');
  assert.ok(body, 'loadClientsSelect found');
  assert.ok(
    body.indexOf("planBuilder") > -1 && body.indexOf(".innerHTML") > -1,
    'onchange clears planBuilder innerHTML'
  );
});

test('onchange handler clears autoGenStatus innerHTML', function() {
  var body = extractFnBody(src, 'async function loadClientsSelect(');
  assert.ok(body, 'loadClientsSelect found');
  assert.ok(
    body.indexOf("autoGenStatus") > -1,
    'onchange clears autoGenStatus'
  );
});

test('saveImportedPlan still reads clientId from arg or select (not from stale)', function() {
  var body = extractFnBody(src, 'async function saveImportedPlan(');
  assert.ok(body, 'saveImportedPlan found');
  // clientId is resolved at top of function, not from module-level state
  assert.ok(
    body.indexOf('const clientId = clientIdArg') > -1 ||
    body.indexOf('clientId = clientIdArg') > -1,
    'clientId resolved from arg at top of saveImportedPlan'
  );
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
