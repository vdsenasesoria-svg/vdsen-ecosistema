'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const catalog = require('../assets/exercise-visual-catalog.js');
const inventory = require('./legacy-visual-final-expansion-inventory.js');

const source = fs.readFileSync('vdsen-coach.html', 'utf8');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const block = source.match(/const BASE_EXERCISES = \[(.*?)\];\s*\n\s*document\.getElementById\("loadBaseBtn"\)/s)[1];
const base = [...block.matchAll(/\{\s*name:"([^"]+)".*?motorPattern:"([^"]+)"\s*,\s*equipment:"([^"]+)"/gs)]
  .map(match => ({ name:match[1], group:match[2], equipment:match[3] }));
const visual = catalog.gyms['smart-fit-san-diego'];
const norm = value => String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const baseByName = new Map(base.map(item => [norm(item.name), item]));
const initialNames = new Set(visual.legacyEntries.slice(0, 40).map(item => norm(item.exerciseName)));
const implemented = inventory.filter(item => item.implementationStatus === 'implemented');
const blocked = inventory.filter(item => item.implementationStatus === 'blocked');

assert.equal(base.length, 85, 'TOTAL LEGACY');
assert.equal(initialNames.size, 40, 'COVERED BEFORE');
assert.equal(inventory.length, 45, 'the complete residual inventory is classified');
assert.equal(new Set(inventory.map(item => norm(item.canonicalName))).size, 45, 'residual identities are unique');
assert.equal(implemented.length, 44, 'NEW COVERED THIS RUN');
assert.equal(visual.legacyEntries.length, 84, 'TOTAL COVERED AFTER');
assert.equal(blocked.length, 1, 'LEGACY REMAINING');

inventory.forEach(item => {
  const canonical = baseByName.get(norm(item.canonicalName));
  assert.ok(canonical, item.canonicalName + ' is not a canonical BASE_EXERCISES identity');
  assert.equal(item.existingEquipment, canonical.equipment, item.canonicalName + ' equipment audit drift');
  assert.equal(item.group, canonical.group, item.canonicalName + ' group audit drift');
  assert.deepEqual(item.aliases, [], item.canonicalName + ' must not invent aliases');
  assert.deepEqual(item.existingIds, [], item.canonicalName + ' had no stable ID before this expansion');
  assert.ok(item.observableUse.includes('vdsen-coach.html:BASE_EXERCISES'), item.canonicalName + ' lacks observable source evidence');
});

implemented.forEach(item => {
  const entry = visual.legacyEntries.find(candidate => candidate.exerciseId === item.visualExerciseId);
  assert.ok(entry, item.canonicalName + ' missing visual entry');
  assert.equal(entry.exerciseName, item.canonicalName, item.canonicalName + ' must use exact canonical identity');
  assert.equal(entry.imageUrl, null, item.canonicalName + ' must not claim a licensed image');
  assert.equal(entry.assetRef, 'assets/exercises/pending-license.svg');
  assert.ok(entry.setup && entry.execution && entry.technicalObjective && entry.commonErrors.length, item.canonicalName + ' missing technical metadata');
});
blocked.forEach(item => {
  assert.equal(item.classification, 'BLOCKED_EQUIPMENT');
  assert.ok(item.technicalAmbiguity && item.collisionRisk.startsWith('high:'));
  assert.ok(!visual.legacyEntries.some(entry => norm(entry.exerciseName) === norm(item.canonicalName)), 'blocked identity must remain unmapped');
});

const allEntries = visual.entries.concat(visual.legacyEntries);
assert.equal(new Set(allEntries.map(entry => entry.exerciseId)).size, allEntries.length, 'unique exerciseId across physical and legacy entries');
const tokenOwners = new Map();
allEntries.forEach(entry => {
  [entry.exerciseName].concat(entry.aliases || []).forEach(token => {
    const key = norm(token);
    const owner = tokenOwners.get(key);
    assert.ok(!owner || owner === entry.exerciseId, 'exact alias collision: ' + token);
    tokenOwners.set(key, entry.exerciseId);
  });
});

const resolverStart = client.indexOf('function _normalizeExerciseCatalogKey(');
const resolverEnd = client.indexOf('var _exOptsClickOutHandler', resolverStart);
const sandbox = {
  window:{ VDSEN_EXERCISE_VISUAL_CATALOG:catalog }, EXERCISE_CATALOG:{}, EXERCISE_CATALOG_BY_ID:{},
  EXERCISE_CATALOG_ENTRIES:[], PRESCRIPTION_EXERCISE_CATALOG_BY_ID:{}, AMBIGUOUS_PRESCRIPTION_EXERCISE_IDS:{},
  ACTIVE_GYM_ID:'smart-fit-san-diego', ACTIVE_GYM_NAME:'San Diego', BUILTIN_CATALOG:{}, PLAN:null
};
vm.createContext(sandbox);
vm.runInContext(client.slice(resolverStart, resolverEnd), sandbox);
implemented.forEach(item => {
  const exact = sandbox._resolveExerciseVisualCatalog({ exerciseName:item.canonicalName });
  assert.ok(exact && exact.exerciseId === item.visualExerciseId, item.canonicalName + ' exact legacy resolution failed');
  assert.equal(sandbox._resolveExerciseVisualCatalog({ exerciseName:item.canonicalName + ' parcial' }), null, item.canonicalName + ' accepted fuzzy suffix');
});

const classificationCounts = inventory.reduce((counts, item) => {
  counts[item.classification] = (counts[item.classification] || 0) + 1;
  return counts;
}, {});
assert.deepEqual(classificationCounts, {
  P2_MEDIUM_VALUE_HIGH_CONFIDENCE:22,
  P1_HIGH_VALUE_HIGH_CONFIDENCE:17,
  P3_LOW_VALUE_HIGH_CONFIDENCE:5,
  BLOCKED_EQUIPMENT:1
});
const equipmentCounts = implemented.reduce((counts, item) => {
  const entry = visual.legacyEntries.find(candidate => candidate.exerciseId === item.visualExerciseId);
  counts[entry.equipmentType] = (counts[entry.equipmentType] || 0) + 1;
  return counts;
}, {});
assert.deepEqual(equipmentCounts, { free_weight:8, machine:17, cable:11, bench:1, barbell:7 });

console.log('T461 — final legacy visual coverage: PASS');
console.log(JSON.stringify({
  totalLegacy:85,
  coveredBefore:40,
  newCoveredThisRun:implemented.length,
  totalCoveredAfter:visual.legacyEntries.length,
  legacyRemaining:blocked.length,
  p1Completed:classificationCounts.P1_HIGH_VALUE_HIGH_CONFIDENCE,
  p2Completed:classificationCounts.P2_MEDIUM_VALUE_HIGH_CONFIDENCE,
  p3Completed:classificationCounts.P3_LOW_VALUE_HIGH_CONFIDENCE,
  blockedIdentity:classificationCounts.BLOCKED_IDENTITY || 0,
  blockedEquipment:classificationCounts.BLOCKED_EQUIPMENT,
  contractGap:classificationCounts.CONTRACT_GAP || 0
}));
