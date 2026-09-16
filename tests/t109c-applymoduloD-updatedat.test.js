/**
 * T109-C — _applyAllModuloD must include updatedAt in its plan write
 * so the client live plan listener (onSnapshot) detects the change.
 *
 * Contract: every updateDoc on plans/{id} that should be detected by the
 * client must include `updatedAt` — see vdsen-cliente.html ~line 1706:
 *   if (updatedAt === FB._planLastUpdatedAt) return; // sin cambios reales
 *
 * _applyRecLoadsToMonitor (line 15118) is the reference: it includes updatedAt.
 * _applyAllModuloD (line 14853) must match that contract.
 *
 * Run: node tests/t109c-applymoduloD-updatedat.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-coach.html', 'utf8');
var clientSrc = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

function extractFnBody(src, fnDecl) {
  var idx = src.indexOf(fnDecl);
  if (idx === -1) return null;
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    i++;
  }
  return null;
}

console.log('T109-C — _applyAllModuloD updatedAt contract');

test('_applyAllModuloD is defined', function() {
  assert.ok(src.indexOf('async function _applyAllModuloD') !== -1,
    '_applyAllModuloD not found in vdsen-coach.html');
});

test('_applyAllModuloD includes updatedAt in its updateDoc call', function() {
  var body = extractFnBody(src, 'async function _applyAllModuloD');
  assert.ok(body, '_applyAllModuloD body not extractable');
  // Must include updatedAt in the updateDoc payload
  assert.ok(body.indexOf('updatedAt') !== -1,
    '_applyAllModuloD calls updateDoc without updatedAt — client live listener will ignore this write. ' +
    'Reference fix: add updatedAt: new Date().toISOString() to the updateDoc payload (see _applyRecLoadsToMonitor line 15118).');
});

test('client live plan listener gates on updatedAt (contract exists)', function() {
  // Verify the client has the updatedAt equality guard that this contract targets
  assert.ok(clientSrc.indexOf('updatedAt === FB._planLastUpdatedAt') !== -1,
    'Client plan listener updatedAt guard not found — contract reference changed');
});

test('_applyRecLoadsToMonitor includes updatedAt (reference implementation)', function() {
  var body = extractFnBody(src, 'async function _applyRecLoadsToMonitor');
  assert.ok(body, '_applyRecLoadsToMonitor body not extractable');
  assert.ok(body.indexOf('updatedAt') !== -1,
    '_applyRecLoadsToMonitor is the reference implementation but lacks updatedAt');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed');
if (FAIL > 0) process.exit(1);
