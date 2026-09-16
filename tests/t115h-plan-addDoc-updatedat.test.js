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
  var addDocIdx = body.indexOf('addDoc(collection(db, "plans")');
  assert.ok(addDocIdx > -1, 'addDoc(plans) found');
  var chunk = body.slice(addDocIdx, addDocIdx + 700);
  assert.ok(chunk.indexOf('updatedAt') > -1, 'updatedAt present in addDoc payload');
  assert.ok(chunk.indexOf('createdAt') > -1, 'createdAt also present');
});

test('saveManualPlan addDoc includes updatedAt', function() {
  var body = extractFnBody(src, 'async function saveManualPlan(');
  assert.ok(body, 'saveManualPlan found');
  var addDocIdx = body.indexOf('addDoc(collection(db, "plans")');
  assert.ok(addDocIdx > -1, 'addDoc(plans) found');
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
