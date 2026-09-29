// Test-only fixtures for the lifecycle suites: real shadow records built from synthetic LOGS + plan (never production data).
const path = require('node:path');
const { build } = require('./lifecycle-sandbox.js');
const root = path.join(__dirname, '..', '..');
const C = require(path.join(root, 'assets/equipment-context.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const on = build(true), off = build(false);
const shadowOn = on.shadow;

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const SYNTH = { shared: { 'functional-dumbbells': { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} };   // synthetic, test-only
const DB_EX = 'legacy-remo-mancuerna-unilateral';
const OK = [{}, {}, {}], EASY = [{}, {}, { rir_real: 3 }], C9 = [{}, {}, { reps: '9', rir_real: 2 }];
const NOW = '2026-09-28T00:00:00.000Z';

function scenario({ pid = 'pid-1', exerciseId = DB_EX, prior = EASY, latest = EASY, unit = 'KG', planUpdatedAt = '2026-09-26T00:00:00.000Z', clientId = 'c', planId = 'p' } = {}) {
  const sets = [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 }));
  const plan = { clientId, weeks: 4, updatedAt: planUpdatedAt, days: [0, 2].map(d => ({ dayIndex: d, exercises: [{ prescriptionExerciseId: pid, exerciseId, exerciseName: 'X', sets }] })) };
  const entries = {};
  [[1, 0, prior], [1, 2, latest]].forEach(([w, d, ov]) => ov.forEach((o, s) => { entries['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit, done: true, rir: 2, rir_real: 2,
    prescriptionExerciseId: pid, ts: T0 + d * 1000 + s }, o); }));
  const rec = shadowOn.buildRecord({ clientId, planId, activePlanId: planId, plan, entries, week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    recommendation: { prescriptionExerciseId: pid, exerciseId, exerciseName: 'X', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
  return { rec, plan, entries, exerciseId, pid, clientId, planId };
}
function context(sc, extra = {}) {
  return Object.assign({ clientId: sc.clientId, planId: sc.planId, activePlanId: sc.planId, plan: sc.plan, entries: Object.assign({}, sc.entries), interventions: [], existingOverlays: {}, now: NOW,
    resolveNextExposure: shadowOn.resolveNextExposure }, extra);
}
function equipmentFor(sc, config = SYNTH) {
  const ref = C.equipmentRefForExercise({ catalog, exerciseId: sc.exerciseId, config });
  return resolver.resolveForCandidate({ magnitude: sc.rec.magnitude, equipment: ref });
}
// dry-run decision through the (flag-on) consumer
function decide(sc, { config = SYNTH, ctx = {}, api = on.consumer } = {}) {
  return api.planApplication({ record: sc.rec, context: context(sc, Object.assign({ equipmentResolution: equipmentFor(sc, config) || undefined }, ctx)) });
}
// APPLIED (or later) state built from the canonical pieces: { record, overlay, records, overlays, plan, entries, sc }
function applied(sc, { state = 'APPLIED', appliedAt = '2026-09-28T01:00:00.000Z', ctx = {}, config = SYNTH } = {}) {
  const d = decide(sc, { config, ctx });
  if (!d.overlay) throw new Error('fixture: no overlay planned: ' + JSON.stringify(d.blockers));
  const overlay = Object.assign({}, d.overlay, { status: 'APPLIED', appliedAt, operationKey: 'apply:' + sc.rec.key });
  let record = shadowOn.lifecycleTransition(sc.rec, 'APPLIED', { expectedRevision: sc.rec.revision, operationKey: 'apply:' + sc.rec.key, at: appliedAt, actorId: 'coach',
    reasonCode: 'APPLIED_BY_POLICY', patch: { overlayKey: overlay.key, appliedAt } }).record;
  if (state !== 'APPLIED') {
    record = shadowOn.lifecycleTransition(record, state, { expectedRevision: record.revision, operationKey: state + ':' + record.key, at: '2026-09-28T02:00:00.000Z', actorId: 'x', reasonCode: state }).record;
    overlay.status = state;
  }
  return { sc, record, overlay, records: { [record.key]: record }, overlays: { [overlay.key]: overlay }, plan: sc.plan, entries: Object.assign({}, sc.entries) };
}
function baseSets() { return [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, restSeconds: 90, rirTarget: 2, load: 0 })); }
function effectiveInput(a, extra = {}) {
  return Object.assign({ clientId: a.sc.clientId, planId: a.sc.planId, activePlanId: a.sc.planId, pid: a.sc.pid, week: a.overlay.target.week, dayIndex: a.overlay.target.dayIndex,
    records: a.records, overlays: a.overlays, interventions: [], plan: a.plan, entries: a.entries, baseSets: baseSets() }, extra);
}
module.exports = { on, off, shadowOn, SYNTH, OK, EASY, C9, NOW, T0, scenario, context, equipmentFor, decide, applied, baseSets, effectiveInput };
