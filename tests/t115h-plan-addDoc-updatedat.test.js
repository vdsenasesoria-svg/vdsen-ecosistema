/**
 * T115-H — saveManualPlan and saveImportedPlan must include updatedAt in addDoc
 * so the client plan onSnapshot listener can detect plan activation immediately.
 * Run: node tests/t115h-plan-addDoc-updatedat.test.js
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

console.log('T115-H — plan-addDoc-updatedat');

test('saveImportedPlan addDoc includes updatedAt', function() {
  var body = extractFnBody(src, 'async function saveImportedPlan(');
  assert.ok(body, 'saveImportedPlan found');
  // T591-B: the import creates the plan inside ONE transaction; its document literal is _newPlanDoc (createdAt / updatedAt from one ISO event)
  var addDocIdx = body.indexOf('buildPlanDoc: function');   // T591-C: the import document literal is built for the shared transaction
  assert.ok(addDocIdx > -1, 'buildPlanDoc (transactional plan document) found');
  var chunk = body.slice(addDocIdx, addDocIdx + 700);
  assert.ok(chunk.indexOf('updatedAt') > -1, 'updatedAt present in addDoc payload');
  assert.ok(chunk.indexOf('createdAt') > -1, 'createdAt also present');
});

test('saveManualPlan addDoc includes updatedAt', function() {
  var body = extractFnBody(src, 'async function saveManualPlan(');
  assert.ok(body, 'saveManualPlan found');
  // T591-C: the manual plan is created by the shared assignment transaction; buildPlanDoc is its document literal
  var addDocIdx = body.indexOf('buildPlanDoc: function');
  assert.ok(addDocIdx > -1, 'buildPlanDoc (transactional plan document) found');
  assert.ok(body.indexOf('_assignPlanTxn(') > -1, 'saveManualPlan creates the plan through the single assignment transaction');
  var chunk = body.slice(addDocIdx, addDocIdx + 700);
  assert.ok(chunk.indexOf('updatedAt') > -1, 'updatedAt present in addDoc payload');
  assert.ok(chunk.indexOf('createdAt') > -1, 'createdAt also present');
});

test('client listener guard exists for updatedAt', function() {
  var clientSrc = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');
  assert.ok(clientSrc.indexOf('if (!updatedAt) return') > -1 ||
            clientSrc.indexOf('!updatedAt') > -1, 'client listener has updatedAt guard');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
