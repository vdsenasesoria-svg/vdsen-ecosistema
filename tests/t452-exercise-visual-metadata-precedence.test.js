'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const catalog = require(path.join(__dirname, '..', 'assets', 'exercise-visual-catalog.js'));
const start = client.indexOf('function _normalizeExerciseCatalogKey(');
const end = client.indexOf('var _exOptsClickOutHandler', start);
assert.ok(start >= 0 && end > start, 'identity resolver must be extractable');

const sandbox = {
  window:{ VDSEN_EXERCISE_VISUAL_CATALOG:catalog },
  EXERCISE_CATALOG:{}, EXERCISE_CATALOG_BY_ID:{}, EXERCISE_CATALOG_ENTRIES:[],
  PRESCRIPTION_EXERCISE_CATALOG_BY_ID:{}, AMBIGUOUS_PRESCRIPTION_EXERCISE_IDS:{},
  ACTIVE_GYM_ID:'smart-fit-san-diego', ACTIVE_GYM_NAME:'San Diego', BUILTIN_CATALOG:{}, PLAN:null
};
vm.createContext(sandbox);
vm.runInContext(client.slice(start, end), sandbox);

sandbox.EXERCISE_CATALOG_ENTRIES = [
  { exerciseId:'generic-coach', name:'Belt Squat', instructions:'GENERIC_COACH' },
  { exerciseId:'site-firestore', name:'Belt Squat', gym:'Smart Fit San Diego', instructions:'SITE_FIRESTORE' }
];
let resolved = sandbox._resolveExerciseVisualCatalog({ exerciseName:'Belt Squat' });
assert.ok(resolved && resolved.instructions === 'SITE_FIRESTORE', 'site-specific Firestore metadata wins over generic Coach metadata');

sandbox.EXERCISE_CATALOG_ENTRIES = [
  { exerciseId:'generic-coach', name:'Belt Squat', instructions:'GENERIC_COACH' }
];
resolved = sandbox._resolveExerciseVisualCatalog({ exerciseName:'Belt Squat' });
assert.ok(resolved && resolved._catalogSource === 'site_catalog', 'site catalog wins over generic Coach metadata for exact legacy name fallback');

sandbox.EXERCISE_CATALOG_BY_ID = {
  'generic-coach': { exerciseId:'generic-coach', name:'Belt Squat', instructions:'GENERIC_BY_EXACT_ID' }
};
resolved = sandbox._resolveExerciseVisualCatalog({ exerciseId:'generic-coach', exerciseName:'Belt Squat' });
assert.ok(resolved && resolved.instructions === 'GENERIC_BY_EXACT_ID' && resolved._identityLevel === 'exerciseId', 'exact exerciseId remains stronger than name-based source precedence');

sandbox.EXERCISE_CATALOG_BY_ID = {};
sandbox.EXERCISE_CATALOG_ENTRIES = [
  { exerciseId:'site-a', name:'Belt Squat', gym:'San Diego', instructions:'A' },
  { exerciseId:'site-b', name:'Belt Squat', gym:'Smart Fit San Diego', instructions:'B' }
];
assert.strictEqual(sandbox._resolveExerciseVisualCatalog({ exerciseName:'Belt Squat' }), null, 'same-tier duplicate metadata stays ambiguous and is not selected by position');

console.log('T452 — exercise visual metadata precedence: PASS');
