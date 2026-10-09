// T526: pre-live canary scope (dry-run only, additive, disabled by default). Absent scope = unchanged; present scope is enforced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const consumerSrc = fs.readFileSync(path.join(root, 'assets/progression-application-consumer.js'), 'utf8');
const consumerOff = require(path.join(root, 'assets/progression-application-consumer.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const C = require(path.join(root, 'assets/equipment-context.js'));
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const consumerOn = (() => { const m = { exports: {} }; new vm.Script('(function(module, globalThis){' + consumerSrc.replace('var NUMERIC_APPLY_ENABLED = false;', 'var NUMERIC_APPLY_ENABLED = true;') + '\n})').runInThisContext()(m, {}); return m.exports; })();

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const step = (n, o) => Object.assign({ kind: 'STEP', step: n, unit: 'KG', source: 'COACH_CONFIGURED' }, o);
const SYNTH = { shared: { 'functional-dumbbells': step(2.5) }, gyms: {} };   // synthetic, test-only
const DB_EX = 'legacy-remo-mancuerna-unilateral', BB_EX = 'legacy-remo-barra-prono';

// scenario builder: one PID, one plan exercise (exerciseId), two exposures given as per-set overrides
function scenario({ pid = 'pid-1', exerciseId = DB_EX, prior, latest, unit = 'KG', prescription = {}, planUpdatedAt = '2026-09-26T00:00:00.000Z', extraEntries = {} }) {
  const sets = [0, 1, 2].map(i => Object.assign({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 }, prescription));
  const plan = { clientId: 'c', weeks: 4, updatedAt: planUpdatedAt, days: [0, 2].map(d => ({ dayIndex: d, exercises: [{ prescriptionExerciseId: pid, exerciseId, exerciseName: 'X', sets }] })) };
  const entries = {};
  [[1, 0, prior], [1, 2, latest]].forEach(([w, d, ov]) => ov.forEach((o, s) => { entries['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit, done: true, rir: 2, rir_real: 2,
    prescriptionExerciseId: pid, ts: T0 + d * 1000 + s }, o); }));
  const rec = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: Object.assign(entries, extraEntries), week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z',
    sourceMatches: true, sourcePidCount: 1, recommendation: { prescriptionExerciseId: pid, exerciseId, exerciseName: 'X', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
  return { rec, plan, entries, exerciseId };
}
function decide(api, sc, { config = SYNTH, ctx = {}, equipment } = {}) {
  const ref = equipment !== undefined ? equipment : C.equipmentRefForExercise({ catalog, exerciseId: sc.exerciseId, config });
  const eqRes = resolver.resolveForCandidate({ magnitude: sc.rec.magnitude, equipment: ref });
  return api.planApplication({ record: sc.rec, context: Object.assign({ clientId: 'c', planId: 'p', activePlanId: 'p', plan: sc.plan, entries: Object.assign({}, sc.entries),
    interventions: [], equipmentResolution: eqRes || undefined, existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure }, ctx) });
}
const OK = [{}, {}, {}], EASY = [{}, {}, { rir_real: 3 }], C9 = [{}, {}, { reps: '9', rir_real: 2 }], D0 = [{}, {}, { rir_real: 0 }], E8 = [{}, {}, { reps: '8', rir_real: '' }];


const on = (o) => Object.assign({ enabled: true, clientIds: ['c'], prescriptionExerciseIds: [] }, o);
const run = (api, canaryScope) => decide(api, scenario({ prior: EASY, latest: EASY }), { ctx: canaryScope === undefined ? {} : { canaryScope } });
const other = (d) => d.blockers.filter(b => b !== 'NUMERIC_APPLY_DISABLED');

test('T526.1 normalization: malformed / missing config -> disabled and empty', () => {
  for (const raw of [undefined, null, 'x', 5, [], { enabled: 'true' }, { enabled: 1 }]) assert.deepEqual(consumerOff.normalizeCanaryScope(raw), { enabled: false, clientIds: [], prescriptionExerciseIds: [] });
  assert.deepEqual(consumerOff.normalizeCanaryScope({ enabled: true, clientIds: ['a', 5, '', null], prescriptionExerciseIds: 'p' }), { enabled: true, clientIds: ['a'], prescriptionExerciseIds: [] });
});
test('T526.2 default {enabled:false} puts everything OUT of scope (BLOCKED_CONTEXT)', () => {
  const d = run(consumerOff, { enabled: false, clientIds: ['c'], prescriptionExerciseIds: [] });
  assert.deepEqual(other(d), ['OUT_OF_CANARY_SCOPE']); assert.equal(d.readiness.state, 'BLOCKED'); assert.equal(d.readiness.preview.primary, 'BLOCKED_CONTEXT'); assert.equal(d.overlay, null);
});
test('T526.3 enabled + listed client (all PIDs) -> READY_BUT_DISABLED', () => {
  assert.equal(run(consumerOff, on()).readiness.state, 'READY_BUT_DISABLED');
});
test('T526.4 client not listed / PID not listed -> out of scope; PID listed -> in scope', () => {
  assert.deepEqual(other(run(consumerOff, on({ clientIds: ['z'] }))), ['OUT_OF_CANARY_SCOPE']);
  assert.deepEqual(other(run(consumerOff, on({ prescriptionExerciseIds: ['nope'] }))), ['OUT_OF_CANARY_SCOPE']);
  assert.equal(run(consumerOff, on({ prescriptionExerciseIds: ['pid-1'] })).readiness.state, 'READY_BUT_DISABLED');
});
test('T526.5 scope absent -> behavior unchanged (dry-run audit of everything)', () => {
  assert.equal(run(consumerOff, undefined).readiness.state, 'READY_BUT_DISABLED');
});
test('T526.6 sandbox flag-on: out-of-scope still cannot apply; in-scope can (scope never widens authority)', () => {
  assert.equal(run(consumerOn, { enabled: false, clientIds: ['c'], prescriptionExerciseIds: [] }).canApply, false);
  assert.equal(run(consumerOn, on()).canApply, true);
});
test('T526.7 shipped flag stays false and the scope module never enables anything', () => {
  assert.equal(consumerOff.NUMERIC_APPLY_ENABLED, false);
  assert.equal(run(consumerOff, on()).canApply, false);
});
