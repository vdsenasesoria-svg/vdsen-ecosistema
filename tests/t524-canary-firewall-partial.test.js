// T524: post-policy canaries (A-G), permanent activation firewall for review / blocked branches, PARTIAL equipment readiness and
// ZERO-increment safety. The flag is forced ON only in a sandbox copy of the consumer (never shipped that way).
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

// ---------------- canaries A-G
test('T524.A Rule A with resolved equipment and valid evidence -> READY_BUT_DISABLED', () => {
  const d = decide(consumerOff, scenario({ prior: EASY, latest: EASY }));
  assert.equal(d.readiness.state, 'READY_BUT_DISABLED'); assert.equal(d.readiness.preview.primary, 'READY_BUT_DISABLED'); assert.equal(d.overlay.dimension, 'LOAD');
  assert.deepEqual(d.blockers, ['NUMERIC_APPLY_DISABLED']); assert.equal(d.canApply, false);
});

test('T524.B Rule C first occurrence -> READY_BUT_DISABLED for REST +30 s (no equipment needed)', () => {
  const d = decide(consumerOff, scenario({ prior: OK, latest: C9 }), { config: null });
  assert.equal(d.readiness.state, 'READY_BUT_DISABLED'); assert.deepEqual([d.overlay.dimension, d.overlay.previousValue, d.overlay.appliedValue], ['REST', 90, 120]);
  assert.deepEqual(d.blockers, ['NUMERIC_APPLY_DISABLED']);
});

test('T524.C Rule C persisting at the next comparable exposure -> COACH_REVIEW_REQUIRED', () => {
  const d = decide(consumerOff, scenario({ prior: C9, latest: C9 }));
  assert.equal(d.readiness.state, 'COACH_REVIEW_REQUIRED'); assert.equal(d.readiness.preview.primary, 'COACH_REVIEW_REQUIRED'); assert.equal(d.overlay, null);
  assert.deepEqual(d.blockers.filter(b => b !== 'NUMERIC_APPLY_DISABLED'), ['COACH_REVIEW_REQUIRED']);
});

test('T524.D Rule D -> COACH_REVIEW_REQUIRED', () => {
  const d = decide(consumerOff, scenario({ prior: OK, latest: D0 }));
  assert.equal(d.readiness.state, 'COACH_REVIEW_REQUIRED'); assert.equal(d.overlay, null); assert.equal(d.audit.scienceGaps.length, 0);
});

test('T524.E Rule E (direct) -> COACH_REVIEW_REQUIRED', () => {
  const d = decide(consumerOff, scenario({ prior: OK, latest: E8 }));
  assert.equal(d.readiness.state, 'COACH_REVIEW_REQUIRED'); assert.equal(d.overlay, null);
  assert.equal(scenario({ prior: OK, latest: E8 }).rec.magnitude.coachReviewRequired.branch, 'E');
});

test('T524.F the LAST working set controls the policy (not an earlier or better set)', () => {
  const easyLast = decide(consumerOff, scenario({ prior: [{ rir_real: 0 }, { rir_real: 0 }, { rir_real: 3 }], latest: [{ rir_real: 0 }, { rir_real: 0 }, { rir_real: 3 }] }));
  assert.equal(easyLast.overlay.dimension, 'LOAD', 'rule A from the last set even though earlier sets were hard');
  const hardLast = scenario({ prior: [{ rir_real: 3 }, { rir_real: 3 }, { rir_real: 0 }], latest: [{ rir_real: 3 }, { rir_real: 3 }, { rir_real: 0 }] });
  assert.equal(hardLast.rec.magnitude.coachReviewRequired.branch, 'D');
  assert.equal(hardLast.rec.magnitude.evidence.basis, 'VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET');
});

test('T524.G warm-ups cannot alter the representative set', () => {
  const warm = { warmup: true, rir_real: 0, reps: '4', carga: '40' };
  const a = scenario({ prior: [{ rir_real: 3 }, { rir_real: 3 }, warm], latest: [{ rir_real: 3 }, { rir_real: 3 }, warm] });
  assert.equal(a.rec.magnitude.evidence.setIndex, 1); assert.equal(a.rec.magnitude.ruleId, 'A'); assert.equal(a.rec.magnitude.evidence.load, 100);
  assert.equal(decide(consumerOff, a).overlay.previousValue, 100);
});

// ---------------- flag forced on ONLY in the sandbox
test('T524.H (sandbox flag ON) Rule A and first-occurrence C become EXECUTABLE; D, E and persistent C still refuse', () => {
  const ok = [scenario({ prior: EASY, latest: EASY }), scenario({ prior: OK, latest: C9 })];
  for (const sc of ok) { const d = decide(consumerOn, sc); assert.equal(d.canApply, true); assert.equal(d.readiness.state, 'EXECUTABLE'); assert.deepEqual(d.blockers, []); }
  const refuse = [scenario({ prior: OK, latest: D0 }), scenario({ prior: OK, latest: E8 }), scenario({ prior: C9, latest: C9 }), scenario({ prior: OK, latest: [{}, {}, { reps: '8', rir_real: 0 }] }), scenario({ prior: OK, latest: [{}, {}, { reps: '8', rir_real: 4 }] })];
  for (const sc of refuse) { const d = decide(consumerOn, sc); assert.equal(d.canApply, false); assert.equal(d.overlay, null); assert.equal(d.readiness.state, 'COACH_REVIEW_REQUIRED'); assert.ok(d.blockers.includes('COACH_REVIEW_REQUIRED')); }
  assert.equal(consumerOff.NUMERIC_APPLY_ENABLED, false);
});

// ---------------- permanent firewall (flag ON sandbox)
test('T524.I even with the flag on, automatic application is impossible for every blocked / review condition', () => {
  const good = () => scenario({ prior: EASY, latest: EASY });
  const cases = {
    'D': () => [scenario({ prior: OK, latest: D0 }), {}], 'E': () => [scenario({ prior: OK, latest: E8 }), {}], 'persistent C->E': () => [scenario({ prior: C9, latest: C9 }), {}],
    'unresolved equipment': () => [good(), { config: null }],
    'identity conflict': () => { const s = good(); const bad = { ...s.plan, days: [{ dayIndex: 0, exercises: [] }, s.plan.days[1]] }; return [Object.assign({}, s, { plan: bad }), {}]; },
    'stale plan': () => [good(), { ctx: { plan: { ...good().plan, updatedAt: '2026-09-30T00:00:00.000Z' } } }],
    'started target': () => [good(), { ctx: { entries: { ...good().entries, log_2_0_0_s0: { carga: '1', done: true } } } }],
    'Coach override': () => [good(), { ctx: { interventions: [{ targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', decidedAt: '2026-09-27T14:00:00.000Z', action: 'CHANGE' }] } }],
    'safety conflict': () => [good(), { ctx: { safetyConflict: true } }],
    'insufficient evidence': () => [scenario({ prior: EASY, latest: EASY, extraEntries: {} }), { ctx: {}, single: true }],
    'direction conflict': () => [scenario({ prior: [{}, {}, { reps: '6', rir_real: 0 }], latest: EASY }), {}],
    'unit mismatch': () => [scenario({ prior: EASY, latest: EASY, unit: 'LB' }), {}],
    'invalid equipment grid': () => [good(), { config: { shared: { 'functional-dumbbells': { kind: 'STEP', step: -5, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} } }]
  };
  for (const [name, mk] of Object.entries(cases)) {
    let [sc, o] = mk();
    if (o.single) { const e = { ...sc.entries }; Object.keys(e).filter(k => k.startsWith('log_1_0_')).forEach(k => delete e[k]); const rec = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan: sc.plan, entries: e, week: 1, dayIndex: 2,
      calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1, recommendation: { prescriptionExerciseId: 'pid-1', exerciseId: sc.exerciseId, exerciseName: 'X', action: 'increase_load', newLoad: 5 } }, 'x'); sc = { ...sc, rec, entries: e }; }
    const d = decide(consumerOn, sc, o);
    assert.equal(d.canApply, false, name); assert.equal(d.overlay, null, name + ' produced an overlay'); assert.equal(d.readiness.executable, false, name);
  }
});

// ---------------- partial equipment readiness
test('T524.J PARTIAL readiness: configured equipment is eligible, unconfigured equipment stays blocked (mixed batch)', () => {
  const dumb = scenario({ pid: 'pid-db', exerciseId: DB_EX, prior: EASY, latest: EASY }), bar = scenario({ pid: 'pid-bb', exerciseId: BB_EX, prior: EASY, latest: EASY });
  const rows = [['dumbbell', dumb], ['barbell', bar]].map(([n, sc]) => [n, decide(consumerOn, sc, { ctx: {} })]);
  assert.equal(rows[0][1].canApply, true); assert.equal(rows[0][1].overlay.equipmentId, 'functional-dumbbells');
  assert.equal(rows[1][1].canApply, false); assert.ok(rows[1][1].blockers.includes('UNRESOLVED_EQUIPMENT_INCREMENT')); assert.equal(rows[1][1].readiness.preview.primary, 'BLOCKED_EQUIPMENT_DATA');
  // flag off: same split, expressed as READY_BUT_DISABLED vs BLOCKED_EQUIPMENT_DATA
  assert.deepEqual([decide(consumerOff, dumb).readiness.preview.primary, decide(consumerOff, bar).readiness.preview.primary], ['READY_BUT_DISABLED', 'BLOCKED_EQUIPMENT_DATA']);
  // configuring the barbell later flips only the barbell
  const both = { shared: { ...SYNTH.shared, 'functional-olympic-barbell': { kind: 'PLATE_LOADED_BAR', barWeight: 20, smallestPlate: 1.25, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} };
  assert.equal(decide(consumerOn, bar, { config: both }).canApply, true);
});

// ---------------- zero-increment safety on the real catalog
test('T524.K ZERO increments (real catalog, no configuration): 0 executable LOAD candidates; REST stays independent', () => {
  const g = catalog.gyms['smart-fit-san-diego'], ids = g.entries.concat(g.legacyEntries).map(e => e.exerciseId);
  assert.equal(ids.length, 71);
  let load = 0, rest = 0;
  for (const id of ids) {
    const l = decide(consumerOn, scenario({ exerciseId: id, prior: EASY, latest: EASY }), { config: null });
    assert.equal(l.canApply, false, id); assert.equal(l.overlay, null, id);
    assert.ok(l.blockers.some(b => ['UNRESOLVED_EQUIPMENT_INCREMENT', 'EQUIPMENT_IDENTITY_UNRESOLVED'].includes(b)), id);
    if (l.canApply) load++;
    const r = decide(consumerOn, scenario({ exerciseId: id, prior: OK, latest: C9 }), { config: null });
    if (r.canApply && r.overlay.dimension === 'REST') rest++;
  }
  assert.equal(load, 0); assert.equal(rest, 71, 'REST +30 s never needs load-increment metadata');
});

test('T524.L no fallback increment, no implicit rounding, no equipment-type guess', () => {
  for (const type of ['machine', 'barbell', 'free_weight', 'cable', 'trap_bar', 'bench']) {
    const r = resolver.resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG', equipment: { equipmentId: 'x', equipmentType: type } });
    assert.equal(r.resolutionState, 'UNRESOLVED_EQUIPMENT_INCREMENT'); assert.equal(r.realizableLoad, null);
  }
  assert.deepEqual(Object.keys(resolver.INCREMENT_METADATA), []);
  assert.ok(!/loadIncrement|smallestPlate|barWeight/.test(fs.readFileSync(path.join(root, 'assets/exercise-visual-catalog.js'), 'utf8')));
  const noCfg = decide(consumerOff, scenario({ prior: EASY, latest: EASY }), { config: null });
  assert.equal(noCfg.equipment.realizableLoad, null); assert.ok(noCfg.blockers.includes('UNRESOLVED_EQUIPMENT_INCREMENT'));
});
