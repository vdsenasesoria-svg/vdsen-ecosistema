'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

const start = client.indexOf('function _instructionValue(');
const end = client.indexOf('function _buildTechniqueAndInstructionsHtml(', start);
ok(start >= 0 && end > start, 'client defines an isolated exercise-instruction adapter');

const sandbox = {
  _escHTml: (value) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
};
vm.createContext(sandbox);
vm.runInContext(client.slice(start, end), sandbox);

const catalog = {
  exerciseInstructions: {
    setup: 'Polea a la altura del hombro',
    execution: 'Ejecuta con control',
    cues: ['Torso estable'],
    avoid: ['Impulso']
  }
};
const exercise = {
  exerciseInstructions: { setup: 'Texto duplicado en el plan' },
  athleteSpecificTechniqueNote: 'Usa el ROM tolerado esta semana',
  clientSelectionRationale: 'Variante estable para el objetivo actual.'
};
const guide = sandbox._normalizeExerciseInstructions(exercise, catalog);
ok(guide.setup === 'Polea a la altura del hombro', 'canonical catalog guidance has priority over duplicated plan guidance');
ok(guide.individualNotes === 'Usa el ROM tolerado esta semana', 'athlete-specific note remains separate from canonical guidance');

const html = sandbox._buildExerciseGuideHtml(exercise, catalog, 0, 0);
ok(html.includes('<details') && html.includes('CÓMO REALIZARLO'), 'exercise guidance is collapsed with the requested client label');
ok(html.includes('SETUP') && html.includes('EJECUCIÓN') && html.includes('CLAVES TÉCNICAS') && html.includes('EVITA'), 'complete guidance renders the supported sections');
ok(html.includes('AJUSTE PARA TI') && html.includes('¿POR QUÉ ESTE EJERCICIO?'), 'individual note and client-safe rationale are visible without engine reasoning');

const partial = sandbox._buildExerciseGuideHtml({ exerciseInstructions:{ execution:'Solo ejecución' } }, null, 1, 2);
ok(partial.includes('EJECUCIÓN') && !partial.includes('EVITA'), 'partial guidance is null-safe and omits empty sections');
ok(sandbox._buildExerciseGuideHtml({}, null, 1, 3) === '', 'exercise without guidance keeps the legacy workout UI unchanged');

const escaped = sandbox._buildExerciseGuideHtml({ exerciseInstructions:{ execution:'<img src=x onerror=alert(1)>' } }, null, 2, 1);
ok(!escaped.includes('<img') && escaped.includes('&lt;img'), 'instruction content is HTML-escaped');
ok(client.includes('prescriptionExerciseId: e.prescriptionExerciseId || undefined'), 'stable prescriptionExerciseId remains preserved');
ok(client.includes("schema: planData.schema || 'vdsen-plan-v2'"), 'vdsen-plan-v2 remains the client fallback schema');
ok(client.includes('if (!ej || ej.mediaClientVisible !== true) return'), 'exercise images and video require explicit client visibility');

console.log('\nT446 — Client exercise instructions: ' + pass + ' assertions PASSED.');
