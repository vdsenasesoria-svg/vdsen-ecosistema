// T547: the Coach editor must not flatten per-set prescription. Behaviour is proven end-to-end by scripts/client-staging-coach-editor-fidelity.cjs
// (real editor, Ayrton-shaped plan); these are the static contracts that keep the flattening from coming back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync('vdsen-coach.html', 'utf8');
const save = src.slice(src.indexOf('async function saveTrainingPlan()'), src.indexOf('async function saveTrainingPlan()') + 6000);

test('T547.E1 saveTrainingPlan reads per-set rows (_exCollectSets), not three uniform inputs', () => {
  assert.ok(save.includes('_exCollectSets(row, perf.sets)'));
  assert.ok(!/Array\.from\(\{length: sets\}[^;]*\)\)\s*,\s*\n\s*\.\.\.perf\.ex/.test(save.replace(/row\.querySelector\('\.exset'\)[^:]*:/, '')) || save.includes("row.querySelector('.exset')"), 'uniform rebuild only as legacy fallback');
});
test('T547.E2 empty coachNote is not added to a stored exercise that lacked it', () => {
  assert.ok(save.includes("(coachNote || row.dataset.hadCoachnote) ? { coachNote } : {}"));
});
test('T547.E3 per-set controls render every stored field and the header inputs are bulk setters', () => {
  for (const k of ['repsTarget', 'rirTarget', 'restSeconds', 'tempo', 'setNote', 'drop']) assert.ok(src.includes('data-sf="' + k + '"') || src.includes("f('" + k + "'"), k);
  assert.ok(src.includes('data-bulk="rirTarget"') && src.includes('_exBulkApply'));
});
test('T547.E4 RIR 0 is a valid per-set value (no `|| 2` coercion in the per-set reader)', () => {
  const rd = src.slice(src.indexOf('function _exReadSetValue'), src.indexOf('function _exCollectSets'));
  assert.ok(!/\|\|\s*2/.test(rd));
});
