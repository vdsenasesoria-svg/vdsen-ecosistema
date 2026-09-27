'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(ROOT, 'vdsen-cliente.html'), 'utf8');
const catalog = require(path.join(ROOT, 'assets', 'exercise-visual-catalog.js'));
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

const sanDiego = catalog.gyms['smart-fit-san-diego'];
ok(sanDiego && sanDiego.gym === 'Smart Fit San Diego', 'catalog exposes the Smart Fit San Diego site explicitly');
ok(sanDiego.entries.length === 31, 'all 31 confirmed machines/implements are represented');

const required = ['exerciseId','exerciseName','gym','equipment','instructions','setup','execution','commonErrors','variants'];
sanDiego.entries.forEach((entry) => {
  required.forEach((field) => assert.ok(Object.prototype.hasOwnProperty.call(entry, field), entry.exerciseName + ' missing ' + field));
  assert.ok(entry.imageUrl || entry.assetRef, entry.exerciseName + ' missing imageUrl/assetRef');
});
pass++;
console.log('  ✓ every site entry carries the required visual-sheet metadata');

const stateStart = client.indexOf('function _normalizeExerciseCatalogKey(');
const stateEnd = client.indexOf('var _exOptsClickOutHandler', stateStart);
ok(stateStart >= 0 && stateEnd > stateStart, 'client exposes an isolated identity resolver');

const resolverSandbox = {
  window: { VDSEN_EXERCISE_VISUAL_CATALOG: catalog },
  EXERCISE_CATALOG: {},
  EXERCISE_CATALOG_BY_ID: {},
  EXERCISE_CATALOG_ENTRIES: [],
  PRESCRIPTION_EXERCISE_CATALOG_BY_ID: {},
  AMBIGUOUS_PRESCRIPTION_EXERCISE_IDS: {},
  ACTIVE_GYM_ID: 'smart-fit-san-diego',
  ACTIVE_GYM_NAME: 'San Diego',
  BUILTIN_CATALOG: {},
  PLAN: null
};
vm.createContext(resolverSandbox);
vm.runInContext(client.slice(stateStart, stateEnd), resolverSandbox);

const pidRecord = { exerciseId:'pid-wins', exerciseName:'Ficha por PID' };
resolverSandbox.PRESCRIPTION_EXERCISE_CATALOG_BY_ID['pid-1'] = pidRecord;
const pidResolved = resolverSandbox._resolveExerciseVisualCatalog({
  prescriptionExerciseId:'pid-1', exerciseId:'sf-sd-belt-squat', exerciseName:'Nombre conflictivo'
});
ok(pidResolved === pidRecord, 'prescriptionExerciseId has priority over exerciseId and name');

const byId = resolverSandbox._resolveExerciseVisualCatalog({ exerciseId:'sf-sd-belt-squat', exerciseName:'Texto renombrado' });
ok(byId && byId.exerciseId === 'sf-sd-belt-squat' && byId._identityLevel === 'exerciseId', 'exerciseId resolves the canonical site record without using position');

const legacy = resolverSandbox._resolveExerciseVisualCatalog({ exerciseName:'Remo Inclinado Impulse — agarre neutro' });
ok(legacy && legacy.exerciseId === 'sf-sd-impulse-chest-supported-incline-row', 'legacy fallback accepts an exact registered variant');
ok(legacy._prescribedVariant && legacy._prescribedVariant.name === 'Remo Inclinado Impulse — agarre neutro', 'exact prescribed variant is retained for the sheet');
ok(resolverSandbox._resolveExerciseVisualCatalog({ exerciseName:'Remo Inclinado Impulse agarre' }) === null, 'legacy fallback rejects fuzzy/partial names');

resolverSandbox.ACTIVE_GYM_ID = 'bugambilias';
resolverSandbox.ACTIVE_GYM_NAME = 'Bugambilias';
const bugambiliasShared = resolverSandbox._resolveExerciseVisualCatalog({ exerciseName:'Belt Squat' });
ok(bugambiliasShared && bugambiliasShared.exerciseId === 'sf-sd-belt-squat', 'Bugambilias resolves the shared base catalog');

resolverSandbox.ACTIVE_GYM_ID = 'smart-fit-san-diego';
resolverSandbox.ACTIVE_GYM_NAME = 'San Diego';
resolverSandbox.PLAN = { entrenamiento:{ sesiones:[{ exercises:[
  { prescriptionExerciseId:'pid-duplicate', exerciseId:'sf-sd-belt-squat', exerciseName:'Belt Squat' },
  { prescriptionExerciseId:'pid-duplicate', exerciseId:'sf-sd-hex-bar', exerciseName:'Barra Hexagonal' }
] }] } };
resolverSandbox._primePrescriptionExerciseCatalog();
ok(resolverSandbox.AMBIGUOUS_PRESCRIPTION_EXERCISE_IDS['pid-duplicate'] === true && !resolverSandbox.PRESCRIPTION_EXERCISE_CATALOG_BY_ID['pid-duplicate'], 'duplicate prescriptionExerciseId is marked ambiguous instead of becoming positional authority');

const guideStart = client.indexOf('function _instructionValue(');
const guideEnd = client.indexOf('function _buildTechniqueAndInstructionsHtml(', guideStart);
const guideSandbox = {
  window: {},
  document: { addEventListener(){}, getElementById(){ return null; }, body:{ style:{} }, activeElement:null },
  PLAN: null,
  ACTIVE_GYM_NAME: 'San Diego',
  _resolveExerciseVisualCatalog(){ return null; },
  _escHTml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
};
vm.createContext(guideSandbox);
vm.runInContext(client.slice(guideStart, guideEnd), guideSandbox);

const variantHtml = guideSandbox._buildExerciseVisualSheetHtml(
  { exerciseName:'Hip Thrust Machine — bilateral' },
  Object.assign({}, legacy, {
    exerciseName:'Hip Thrust Machine', equipment:'Hip Thrust Machine', gym:'Smart Fit San Diego',
    setup:'Ajusta el cinturón.', execution:'Extiende la cadera.', technicalObjective:'Glúteo mayor.', commonErrors:['Hiperextender lumbar.'],
    _prescribedVariant:{ name:'Hip Thrust Machine — bilateral', objective:'Extensión bilateral.' }, imageUrl:null, assetRef:'assets/exercises/pending-license.svg', imageStatus:'pending_license'
  })
);
ok(variantHtml.includes('Variante prescrita') && variantHtml.includes('Hip Thrust Machine — bilateral'), 'visual sheet renders the prescribed variant instructions');
ok(variantHtml.includes('Preparación') && variantHtml.includes('Ejecución') && variantHtml.includes('Objetivo técnico') && variantHtml.includes('Errores a evitar'), 'visual sheet renders all required instruction sections');
ok(variantHtml.includes('pending-license.svg') && variantHtml.includes('Imagen pendiente'), 'missing licensed image renders the controlled placeholder');

ok(client.includes("prescriptionExerciseId: e.prescriptionExerciseId || undefined") && client.includes("exerciseId: e.exerciseId || undefined"), 'plan adapter preserves both stable identity fields');
ok(client.includes("schema: planData.schema || 'vdsen-plan-v2'"), 'vdsen-plan-v2 remains unchanged');
ok(client.includes('openExerciseVisualSheet('+"'"+'+di+'+"'"+','+"'"+'+ei+'+"'"+')') || client.includes('openExerciseVisualSheet(\'+di+\',\'+ei+\')'), 'exercise render exposes the visual sheet from the exercise title');
ok(client.includes('prescriptionExerciseId: _ejExprMeta.prescriptionExerciseId || undefined'), 'execution logging still persists prescription identity');

console.log('\nT450 — Exercise visual catalog: ' + pass + ' assertions PASSED.');
