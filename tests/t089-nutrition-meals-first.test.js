/**
 * T089 — Reconciled: Client nutrition shows meals before secondary macro tools
 * Equivalent to T089-E2E-01
 * Run: node tests/t089-nutrition-meals-first.test.js
 *
 * Verifies the render ORDER of renderNutricion() output:
 *   comidasHtml  →  macroPanel  →  calorie adjust  →  nutri log
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

// Extract the renderNutricion body from the HTML source
var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

// Locate the cont.innerHTML template literal block inside renderNutricion
// Find the inner <div style="padding:0 14px 100px"> block
var innerStart = src.indexOf('<div style="padding:0 14px 100px">');
assert.ok(innerStart > 0, 'inner container found in source');
var innerEnd   = src.indexOf('</div>`', innerStart);
assert.ok(innerEnd   > 0, 'inner container end found');
var innerBlock = src.slice(innerStart, innerEnd);

// Find the position of each key placeholder
var posComidas  = innerBlock.indexOf('${comidasHtml}');
var posMacros   = innerBlock.indexOf('${macroPanel}');
var posCalorie  = innerBlock.indexOf('${buildCalorieAdjustWidget(');
var posNutriLog = innerBlock.indexOf('${buildNutriLogWidget(');

console.log('T089 — nutrition-meals-first');

test('comidasHtml appears before macroPanel', function() {
  assert.ok(posComidas  > -1, 'comidasHtml placeholder found');
  assert.ok(posMacros   > -1, 'macroPanel placeholder found');
  assert.ok(posComidas < posMacros,
    'comidasHtml (' + posComidas + ') must come before macroPanel (' + posMacros + ')');
});

test('comidasHtml appears before calorie adjustment widget', function() {
  assert.ok(posCalorie  > -1, 'buildCalorieAdjustWidget placeholder found');
  assert.ok(posComidas < posCalorie,
    'comidasHtml (' + posComidas + ') must come before calorie adjust (' + posCalorie + ')');
});

test('comidasHtml appears before nutrition log widget', function() {
  assert.ok(posNutriLog > -1, 'buildNutriLogWidget placeholder found');
  assert.ok(posComidas < posNutriLog,
    'comidasHtml (' + posComidas + ') must come before nutri log (' + posNutriLog + ')');
});

test('macroPanel appears before calorie adjustment (order preserved)', function() {
  assert.ok(posMacros < posCalorie,
    'macroPanel (' + posMacros + ') must come before calorie adjust (' + posCalorie + ')');
});

test('calorie adjustment appears before nutrition log (order preserved)', function() {
  assert.ok(posCalorie < posNutriLog,
    'calorie adjust (' + posCalorie + ') must come before nutri log (' + posNutriLog + ')');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
