'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function extractFunction(source, name, nextMarker) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, name + ' must be extractable');
  return source.slice(start, end);
}

const card = extractFunction(client, '_buildExCard', '// ════════════════════════════════════════════════════════════════════════════\n// RENDERERS Y HANDLERS');

assert.ok(card.includes('var visualCatData = !_exSubData ? _resolveExerciseVisualCatalog(ej) : null;'),
  'visual catalog metadata must have a presentation-only variable');
assert.ok(!card.includes('var catData = !_exSubData ? _resolveExerciseVisualCatalog(ej) : null;'),
  'visual metadata must never replace the progression catalog');
assert.ok(card.includes("var catData = (!_exSubData && ej.exerciseId && EXERCISE_CATALOG_BY_ID[String(ej.exerciseId)])"),
  'progression catalog keeps the pre-existing exerciseId/name resolution path');
assert.ok(card.includes('_buildTechniqueAndInstructionsHtml(ej, visualCatData || catData, di, ei)'),
  'instructions may prefer visual metadata without changing progression inputs');

console.log('T451 — visual metadata remains presentation-only: PASS');
