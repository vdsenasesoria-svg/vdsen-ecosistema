'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const catalog = require('../assets/exercise-visual-catalog.js');

const ID = 'sf-sd-converging-lat-pulldown-plate-loaded';
const NAME = 'Jalón Dorsal Convergente discos';
const ALIAS = 'Jalón dorsal plate-loaded';
const sanDiego = catalog.gyms['smart-fit-san-diego'];
const bugambilias = catalog.gyms.bugambilias;
const matches = sanDiego.entries.filter(entry => entry.exerciseId === ID || entry.equipmentId === ID || entry.exerciseName === NAME || (entry.aliases || []).includes(ALIAS));

assert.equal(matches.length, 1, 'the machine has one canonical definition');
const machine = matches[0];
assert.equal(machine.exerciseId, ID);
assert.equal(machine.equipmentId, ID);
assert.equal(machine.exerciseName, NAME);
assert.equal(machine.equipment, 'Máquina plate-loaded · discos');
assert.equal(machine.equipmentType, 'machine');
assert.deepEqual(machine.aliases, [ALIAS]);
assert.deepEqual(machine.variants, []);
assert.equal(machine.imageUrl, null);
assert.equal(machine.assetRef, 'assets/exercises/pending-license.svg');
assert.ok(machine.setup && machine.execution && machine.technicalObjective && machine.commonErrors.length >= 3);
assert.equal(new Set(sanDiego.entries.map(entry => entry.exerciseId)).size, sanDiego.entries.length, 'exerciseId remains unique');
const equipmentIds = sanDiego.entries.map(entry => entry.equipmentId).filter(Boolean);
assert.equal(new Set(equipmentIds).size, equipmentIds.length, 'declared equipmentId values remain unique');

assert.strictEqual(bugambilias, sanDiego, 'Bugambilias shares the same catalog object');
assert.strictEqual(bugambilias.entries, sanDiego.entries, 'the machine is not duplicated per site');
assert.ok(sanDiego.aliases.includes('San Diego') && sanDiego.aliases.includes('Smart Fit San Diego') && sanDiego.aliases.includes('Bugambilias'));

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const resolverStart = client.indexOf('function _normalizeExerciseCatalogKey(');
const resolverEnd = client.indexOf('var _exOptsClickOutHandler', resolverStart);
const sandbox = {
  window:{ VDSEN_EXERCISE_VISUAL_CATALOG:catalog }, EXERCISE_CATALOG:{}, EXERCISE_CATALOG_BY_ID:{},
  EXERCISE_CATALOG_ENTRIES:[], PRESCRIPTION_EXERCISE_CATALOG_BY_ID:{}, AMBIGUOUS_PRESCRIPTION_EXERCISE_IDS:{},
  ACTIVE_GYM_ID:'smart-fit-san-diego', ACTIVE_GYM_NAME:'San Diego', BUILTIN_CATALOG:{}, PLAN:null
};
vm.createContext(sandbox);
vm.runInContext(client.slice(resolverStart, resolverEnd), sandbox);
assert.equal(sandbox._resolveExerciseVisualCatalog({ exerciseId:ID, exerciseName:'otro' }).exerciseId, ID, 'Client resolves by exerciseId');
assert.equal(sandbox._resolveExerciseVisualCatalog({ exerciseName:NAME }).exerciseId, ID, 'Client resolves the exact canonical name');
assert.equal(sandbox._resolveExerciseVisualCatalog({ exerciseName:ALIAS }).exerciseId, ID, 'Client resolves the exact alias');
assert.equal(sandbox._resolveExerciseVisualCatalog({ exerciseName:'Jalón Dorsal Convergente' }), null, 'Client rejects a partial/fuzzy name');
sandbox.ACTIVE_GYM_ID = 'bugambilias';
sandbox.ACTIVE_GYM_NAME = 'Bugambilias';
assert.equal(sandbox._resolveExerciseVisualCatalog({ exerciseId:ID }).exerciseId, ID, 'Bugambilias resolves the shared machine');

const coach = fs.readFileSync('vdsen-coach.html', 'utf8');
assert.match(coach, /assets\/exercise-visual-catalog\.js/);
assert.match(coach, /function openVisualMetadataEditor\(exercise\)/);
assert.match(coach, /Identidad protegida/);
assert.ok(!fs.readFileSync('assets/exercise-visual-metadata-editor.js', 'utf8').includes("'exerciseId'"), 'Coach visual patch cannot mutate exerciseId');
assert.ok(!fs.readFileSync('assets/exercise-visual-metadata-editor.js', 'utf8').includes("'prescriptionExerciseId'"), 'Coach visual patch cannot mutate prescriptionExerciseId');

console.log('T462 — converging plate-loaded lat pulldown catalog: PASS');
