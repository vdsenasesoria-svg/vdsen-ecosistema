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

test('_applyAllModuloD is removed (T487): no Modulo D plan write exists, so no updatedAt gap can exist', function() {
  assert.ok(src.indexOf('_applyAllModuloD') === -1, '_applyAllModuloD must not exist in vdsen-coach.html (T487)');
});

test('client live plan listener gates on updatedAt (contract exists)', function() {
  // Verify the client has the updatedAt equality guard that this contract targets
  assert.ok(clientSrc.indexOf('updatedAt === FB._planLastUpdatedAt') !== -1,
    'Client plan listener updatedAt guard not found — contract reference changed');
});

test('_applyRecLoadsToMonitor is removed (T487)', function() {
  assert.ok(src.indexOf('_applyRecLoadsToMonitor') === -1, '_applyRecLoadsToMonitor must not exist (T487)');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed');
if (FAIL > 0) process.exit(1);
