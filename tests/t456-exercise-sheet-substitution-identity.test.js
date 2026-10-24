'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const start = client.indexOf('function _getPlanExerciseAt(');
const end = client.indexOf('function openExerciseVisualSheet(', start);
assert.ok(start >= 0 && end > start, 'visual-sheet exercise selector must be extractable');

const planExercise = {
  exerciseName:'Press de Pecho discos Impulse', nombre:'Press de Pecho discos Impulse',
  prescriptionExerciseId:'pid-original', exerciseId:'sf-sd-impulse-chest-press-plate-loaded', sets:[{repsTarget:8}]
};
const sandbox = {
  PLAN:{ entrenamiento:{ sesiones:[{ exercises:[planExercise] }] } },
  LOGS:{ 'exsub_2_0_0':{ nombre:'Press Inclinado discos Impulse', original:'Press de Pecho discos Impulse', nota:'Máquina ocupada' } },
  CURRENT_WEEK:2
};
vm.createContext(sandbox);
vm.runInContext(client.slice(start, end), sandbox);

const displayed = sandbox._getPlanExerciseAt(0, 0);
assert.strictEqual(displayed.exerciseName, 'Press Inclinado discos Impulse', 'sheet follows the exercise currently displayed after substitution');
assert.strictEqual(displayed.nombre, 'Press Inclinado discos Impulse', 'display name and lookup name stay aligned');
assert.strictEqual(displayed.prescriptionExerciseId, undefined, 'substitute never reuses the original prescriptionExerciseId as visual authority');
assert.strictEqual(displayed.exerciseId, undefined, 'substitute never reuses the original exerciseId as visual authority');
assert.deepStrictEqual(planExercise.sets, [{repsTarget:8}], 'selector does not mutate the plan exercise');
assert.strictEqual(sandbox.LOGS['exsub_2_0_0'].nombre, 'Press Inclinado discos Impulse', 'selector does not mutate the execution log');

const source = client.slice(start, end);
assert.ok(!source.includes('saveLogs(') && !source.includes('_doSaveLogs('), 'opening the substituted sheet remains read-only');

console.log('T456 — exercise sheet substitution identity: PASS');
