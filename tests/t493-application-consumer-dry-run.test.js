// T493: canonical next-exposure overlay consumer, DRY-RUN. Accepts only canonical records; exact identity;
// idempotent/stale-safe/reversible; writes nothing while NUMERIC_APPLY_ENABLED=false.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const B = consumer.BLOCKERS;

const PID = 'pid-A', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const deepFreeze = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
  { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };

function entriesFor(last, prescribedRir = 2) {
  const e = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => {
    e['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, rir: prescribedRir, rir_real: 2,
      prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, s === 2 ? last : {});
  }));
  return e;
}
function makeRecord(last, opts = {}) {
  return shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan: opts.plan || plan, entries: entriesFor(last, opts.rir), week: 1, dayIndex: 2,
    calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
}
const resolution = (over = {}) => resolver.resolveLoad(Object.assign({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG',
  equipment: { equipmentId: 'eq-1', gymId: 'g', loadIncrement: { kind: 'STEP', step: 2.5, unit: 'KG', source: 'GYM_METADATA' } } }, over));
const ctxFor = (over = {}) => Object.assign({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entriesFor({ rir_real: 3 }), interventions: [],
  equipmentResolution: resolution(), existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure }, over);
const good = () => makeRecord({ rir_real: 3 });
const plan1 = (record, over = {}) => consumer.planApplication({ record, context: ctxFor(over) });
const only = (d, code) => assert.deepEqual(d.blockers.filter(b => b !== B.NUMERIC_APPLY_DISABLED), code ? [].concat(code) : []);

test('T493.1 an eligible canonical LOAD candidate with a resolved equipment produces an exact overlay plan, applied nowhere', () => {
  const rec = good();
  assert.equal(rec.magnitude.eligible, true);
  const d = plan1(rec);
  assert.equal(d.mode, 'DRY_RUN'); assert.equal(d.wouldApply, true); assert.equal(d.canApply, false); assert.equal(d.applied, false);
  only(d, null); assert.ok(d.blockers.includes(B.NUMERIC_APPLY_DISABLED));
  const o = d.overlay;
  assert.equal(o.key, 'ovl_' + rec.key); assert.equal(o.schema, 'vdsen-next-exposure-overlay-v1');
  assert.deepEqual([o.clientId, o.planId, o.prescriptionExerciseId], ['c', 'p', PID]);
  assert.deepEqual(o.source, { week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z' }); assert.deepEqual(o.target, { week: 2, dayIndex: 0 });
  assert.equal(o.dimension, 'LOAD'); assert.equal(o.previousValue, 100); assert.equal(o.requestedValue, 102.5); assert.equal(o.appliedValue, 102.5);
  assert.equal(o.equipmentId, 'eq-1'); assert.equal(o.status, 'PLANNED'); assert.equal(o.reversibleUntil, 'TARGET_EXPOSURE_START');
  assert.equal(o.provenance.methodologyFamily, 'EHRENSTEIN_APEKS_DERIVED'); assert.equal(o.provenance.directionConsistency, 'CONSISTENT');
  assert.equal(d.audit.event, 'OVERLAY_WOULD_APPLY'); assert.equal(d.audit.actor, 'SYSTEM_DRY_RUN');
});

test('T493.2 the base plan and the record are never mutated (vdsen-plan-v2 stays pure)', () => {
  const rec = deepFreeze(good()), frozenPlan = deepFreeze(structuredClone(plan)), entries = deepFreeze(entriesFor({ rir_real: 3 }));
  assert.doesNotThrow(() => plan1(rec, { plan: frozenPlan, entries }));
  assert.deepEqual(frozenPlan, plan);
});

test('T493.3 only canonical records are accepted -- never a raw legacy progrec', () => {
  const legacy = { prescriptionExerciseId: PID, action: 'increase_load', newLoad: 82.5, newReps: 10, newSets: 3, exerciseName: 'Remo' };
  for (const bad of [legacy, { key: 'v1_x', prescriptionExerciseId: PID }, null, undefined, {}]) only(plan1(bad), B.NOT_CANONICAL_RECORD);
  const rec = good();
  for (const tweak of [r => { delete r.magnitude; }, r => { r.magnitude.mode = 'APPLY'; }, r => { r.magnitude.numericApplyAllowed = true; }, r => { r.magnitude.schema = 'x'; },
    r => { delete r.nextExposure; }, r => { delete r.source; }]) {
    const c = structuredClone(rec); tweak(c);
    assert.ok(plan1(c).blockers.includes(B.NOT_CANONICAL_RECORD));
    assert.equal(plan1(c).wouldApply, false);
  }
});

test('T493.4 LOAD needs a resolved physical load; without equipment metadata it is UNRESOLVED_EQUIPMENT_INCREMENT', () => {
  const rec = good();
  only(plan1(rec, { equipmentResolution: undefined }), B.UNRESOLVED_EQUIPMENT_INCREMENT);
  const unresolved = resolver.resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG', equipment: { equipmentId: 'x', equipmentType: 'machine' } });
  only(plan1(rec, { equipmentResolution: unresolved }), B.UNRESOLVED_EQUIPMENT_INCREMENT);
  only(plan1(rec, { equipmentResolution: resolution({ desiredLoad: 101, roundingMode: 'CEIL' }) }), B.EQUIPMENT_RESOLUTION_MISMATCH); // resolved, but for another desired load
  only(plan1(rec, { equipmentResolution: resolution({ roundingMode: 'CEIL', desiredLoad: 102.5 }) }), null);
  const stack5 = resolution({ equipment: { equipmentId: 'st', gymId: 'g', loadIncrement: { kind: 'STEP', step: 5, unit: 'KG', source: 'COACH_CONFIGURED' } } });
  only(plan1(rec, { equipmentResolution: stack5 }), B.DIRECTION_NOT_REALIZABLE); // T503: specific blocker instead of a generic mismatch
});

function customRecord(repsBySet, rir, rirReal, last = {}, priorLast = last) {
  const custom = structuredClone(plan);
  custom.days.forEach(d => { d.exercises[0].sets = repsBySet.map((r, i) => ({ setIndex: i, repsTarget: r, rirTarget: rir, restSeconds: 90 })); });
  const e = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => repsBySet.forEach((r, s) => {
    e['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: String(r), unit: 'KG', done: true, rir, rir_real: rirReal, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, d === 0 ? priorLast : last);
  }));
  const rec = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan: custom, entries: e, week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z',
    sourceMatches: true, sourcePidCount: 1, recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', action: 'increase_load', newLoad: 5 } }, 'x');
  return { rec, custom, e };
}

test('T493.5 REPS and REST canonical candidates are actionable without equipment; volume is never an overlay', () => {
  // REPS: rule A on target RIR 1, last set target 8 inside the 8-12 range -> 9
  const r = customRecord([12, 10, 8], 1, 2);
  assert.equal(r.rec.magnitude.ruleId, 'A'); assert.equal(r.rec.magnitude.eligible, true);
  const reps = plan1(r.rec, { plan: r.custom, entries: r.e, equipmentResolution: undefined });
  assert.equal(reps.wouldApply, true); only(reps, null);
  assert.deepEqual([reps.overlay.dimension, reps.overlay.previousValue, reps.overlay.appliedValue, reps.overlay.unit, reps.overlay.equipmentId], ['REPS', 8, 9, 'REPS', null]);
  // no headroom: single-valued target -> range bound blocks it
  const flat = customRecord([10, 10, 10], 1, 2);
  assert.equal(plan1(flat.rec, { plan: flat.custom, entries: flat.e, equipmentResolution: undefined }).wouldApply, false);
  // REST: rule C (+30 s first), base rest 90 -> 120
  // T523: the FIRST comparable occurrence (previous exposure met its targets); a repeat is Coach review (see t523)
  const c = customRecord([10, 10, 10], 2, 2, { reps: '9' }, {});
  assert.equal(c.rec.magnitude.ruleId, 'C'); assert.equal(c.rec.magnitude.eligible, true);
  const rest = plan1(c.rec, { plan: c.custom, entries: c.e, equipmentResolution: undefined });
  assert.equal(rest.wouldApply, true);
  assert.deepEqual([rest.overlay.dimension, rest.overlay.previousValue, rest.overlay.appliedValue, rest.overlay.unit], ['REST', 90, 120, 'SECONDS']);
  // Rule B is Coach review only: never an overlay
  const b = customRecord([10, 10, 10], 2, 2, { reps: '12' });
  assert.deepEqual(b.rec.magnitude.coachReview.map(x => x.code), ['COACH_REVIEW_VOLUME_INCREASE']);
  const bd = plan1(b.rec, { plan: b.custom, entries: b.e, equipmentResolution: undefined });
  assert.equal(bd.wouldApply, false); assert.equal(bd.overlay, null);
  for (const d of [plan1(good()), reps, rest]) assert.ok(['LOAD', 'REPS', 'REST'].includes(d.overlay.dimension));
});

test('T493.6 unresolved policy branches and ineligible evidence never plan an application', () => {
  const dRec = makeRecord({ rir_real: 1 });
  only(plan1(dRec, { entries: entriesFor({ rir_real: 1 }) }), B.COACH_REVIEW_REQUIRED); // T523: D is Coach review only
  const unconfirmed = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    entries: Object.assign(entriesFor({ rir_real: 3 }), { log_1_0_0_s2: { carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: PID, ts: T0 } }),
    recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', action: 'increase_load', newLoad: 5 } }, 'x');
  assert.equal(unconfirmed.magnitude.directionConsistency, 'UNCONFIRMED');
  only(plan1(unconfirmed), B.DIRECTION_UNCONFIRMED); // T504: specific blocker instead of the generic NOT_ELIGIBLE
});

test('T493.7 exact client / plan / PID / target-exposure guards', () => {
  const rec = good();
  assert.ok(plan1(rec, { clientId: 'other' }).blockers.includes(B.CLIENT_MISMATCH));
  assert.ok(plan1(rec, { planId: 'other', activePlanId: 'other' }).blockers.includes(B.PLAN_MISMATCH));
  assert.ok(plan1(rec, { activePlanId: 'p2' }).blockers.includes(B.PLAN_MISMATCH), 'plan switched after the record');
  assert.ok(plan1(rec, { plan: Object.assign({}, plan, { updatedAt: '2026-09-28T00:00:00.000Z' }) }).blockers.includes(B.PLAN_CHANGED));
  assert.ok(plan1(rec, { plan: Object.assign({}, plan, { updatedAt: null }) }).blockers.includes(B.PLAN_CHANGED));
  const dup = structuredClone(plan); dup.days[0].exercises.push(structuredClone(dup.days[0].exercises[0]));
  assert.ok(plan1(rec, { plan: dup }).blockers.includes(B.IDENTITY_UNRESOLVED));
  const gone = structuredClone(plan); gone.days[0].exercises[0].prescriptionExerciseId = 'pid-other';
  assert.ok(plan1(rec, { plan: gone }).blockers.includes(B.IDENTITY_UNRESOLVED), 'same name, different PID never gains authority');
  const moved = structuredClone(plan); moved.days = moved.days.filter(d => d.dayIndex !== 0);
  const dTarget = plan1(rec, { plan: moved });
  assert.ok(dTarget.blockers.includes(B.IDENTITY_UNRESOLVED) || dTarget.blockers.includes(B.TARGET_EXPOSURE_CHANGED));
  assert.ok(plan1(rec, { resolveNextExposure: () => ({ week: 2, dayIndex: 2 }) }).blockers.includes(B.TARGET_EXPOSURE_CHANGED));
});

test('T493.8 no mutation once the target exposure started (sets, express, skip, close) and reversal follows the same rule', () => {
  const rec = good();
  for (const key of ['log_2_0_0_s0', 'exexpress_2_0_0', 'exskip_2_0_0', 'ss_step_2_0_g_r0_m0', 'done_2_0'])
    assert.ok(plan1(rec, { entries: Object.assign(entriesFor({ rir_real: 3 }), { [key]: { done: true } }) }).blockers.includes(B.TARGET_ALREADY_STARTED), key);
  assert.equal(consumer.targetStarted(entriesFor({ rir_real: 3 }), 2, 0), false);
  const overlay = plan1(rec).overlay;
  assert.equal(consumer.planReversal({ overlay, context: ctxFor() }).wouldRevert, true);
  const started = ctxFor({ entries: Object.assign(entriesFor({ rir_real: 3 }), { log_2_0_0_s0: { done: true } }) });
  assert.deepEqual(consumer.planReversal({ overlay, context: started }).blockers, [B.TARGET_ALREADY_STARTED]);
  assert.ok(consumer.planReversal({ overlay, context: ctxFor({ clientId: 'x' }) }).blockers.includes(B.CLIENT_MISMATCH));
  assert.ok(consumer.planReversal({ overlay: { schema: 'nope' }, context: ctxFor() }).blockers.includes(B.NOT_CANONICAL_RECORD));
});

test('T493.9 Coach override, Coach KEEP and safety outrank the canonical overlay', () => {
  const rec = good();
  const iv = a => ({ targetType: 'EXERCISE', targetId: PID, planId: 'p', action: a, decidedAt: '2026-09-27T12:01:00.000Z' });
  assert.ok(plan1(rec, { interventions: [iv('KEEP')] }).blockers.includes(B.COACH_OVERRIDE));
  assert.ok(plan1(rec, { interventions: [iv('CHANGE')] }).blockers.includes(B.COACH_OVERRIDE));
  assert.ok(!plan1(rec, { interventions: [iv('NO_CHANGE')] }).blockers.includes(B.COACH_OVERRIDE));
  assert.ok(!plan1(rec, { interventions: [Object.assign(iv('KEEP'), { decidedAt: '2026-09-27T11:00:00.000Z' })] }).blockers.includes(B.COACH_OVERRIDE), 'older than the evidence');
  assert.ok(!plan1(rec, { interventions: [Object.assign(iv('KEEP'), { targetId: 'pid-other' })] }).blockers.includes(B.COACH_OVERRIDE), 'other exercise');
  const kept = shadow.transition(rec, 'KEEP_ORIGINAL', 1, 'op', '2026-09-27T14:00:00.000Z', 'coach').record;
  assert.ok(plan1(kept).blockers.includes(B.COACH_KEEP_ORIGINAL)); assert.equal(plan1(kept).wouldApply, false);
  assert.ok(plan1(shadow.markStale(rec, 'PLAN_CHANGED', 'x')).blockers.includes(B.RECORD_NOT_PENDING));
  const unsafe = structuredClone(rec); unsafe.magnitude.reasonCodes.push('SAFETY_CONFLICT'); unsafe.magnitude.eligible = false;
  assert.ok(plan1(unsafe).blockers.includes(B.SAFETY_CONFLICT)); assert.ok(plan1(rec, { safetyConflict: true }).blockers.includes(B.SAFETY_CONFLICT));
  assert.equal(plan1(unsafe).wouldApply, false);
});

test('T493.10 idempotent: the deterministic key blocks a second application', () => {
  const rec = good(), first = plan1(rec);
  assert.deepEqual(plan1(rec).overlay, first.overlay);
  const again = plan1(rec, { existingOverlays: { [first.overlay.key]: first.overlay } });
  assert.ok(again.blockers.includes(B.ALREADY_RECORDED)); assert.equal(again.wouldApply, false);
  assert.equal(consumer.overlayKey(rec), 'ovl_' + rec.key);
});

test('T493.11 with numeric apply disabled the transaction is never touched', async () => {
  const spy = { calls: 0, get: async () => { spy.calls++; }, set: () => { spy.calls++; } };
  const res = await consumer.applyOverlayTransaction(spy, {}, { recordKey: 'v1_x', context: {} }, { isCurrent: () => true });
  assert.deepEqual(res, { written: false, reason: B.NUMERIC_APPLY_DISABLED }); assert.equal(spy.calls, 0);
  assert.equal(consumer.NUMERIC_APPLY_ENABLED, false); assert.equal(shadow.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
  assert.equal(plan1(good()).canApply, false);
});

// The transactional logic is exercised on a sandbox copy with the flag forced on (never shipped that way).
function enabledConsumer() { return require('./helpers/lifecycle-sandbox.js').build(true).consumer; }
function store(rec, over = {}) {
  const docs = new Map([
    ['clients/c', Object.assign({ activePlanId: 'p', coachInterventions: [] }, over.client)],
    ['plans/p', structuredClone(plan)],
    ['logs/c/mesos/p', Object.assign({ planId: 'p', entries: entriesFor({ rir_real: 3 }), progressionApplications: { [rec.key]: rec } }, over.meso)]]);
  const writes = [];
  const tx = { get: async ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) }),
    set: (ref, value) => { writes.push(ref); docs.set(ref, Object.assign({}, docs.get(ref), structuredClone(value))); } };
  return { docs, writes, tx, refs: { client: 'clients/c', plan: 'plans/p', meso: 'logs/c/mesos/p' } };
}
const input = rec => ({ recordKey: rec.key, expectedRevision: rec.revision, context: { clientId: 'c', planId: 'p', equipmentResolution: resolution(), now: 'n', canaryScope: { enabled: true, clientIds: ['c'], prescriptionExerciseIds: [] }, resolveNextExposure: shadow.resolveNextExposure } });

test('T493.12 (flag forced on in a sandbox) one atomic write, idempotent across retries and two devices; plan and LOGS untouched', async () => {
  const c = enabledConsumer(), rec = good(), s = store(rec);
  assert.equal(c.NUMERIC_APPLY_ENABLED, true);
  const r1 = await c.applyOverlayTransaction(s.tx, s.refs, input(rec), { isCurrent: () => true });
  assert.equal(r1.written, true); assert.deepEqual(s.writes, ['logs/c/mesos/p']);
  const meso = s.docs.get('logs/c/mesos/p'); assert.equal(Object.keys(meso.nextExposureOverlays).length, 1);
  assert.equal(meso.nextExposureOverlays['ovl_' + rec.key].appliedValue, 102.5);
  assert.deepEqual(s.docs.get('plans/p'), plan, 'vdsen-plan-v2 untouched'); assert.deepEqual(meso.entries, entriesFor({ rir_real: 3 }));
  const r2 = await c.applyOverlayTransaction(s.tx, s.refs, input(rec), { isCurrent: () => true });
  assert.equal(r2.written, false); assert.equal(r2.reason, B.ALREADY_RECORDED); assert.equal(s.writes.length, 1, 'retry / second device: no duplicate');
  assert.equal(meso.progressionApplications[rec.key].state, 'APPLIED', 'T531: the record moves PENDING -> APPLIED in the same write');
  const [a, b] = await Promise.all([1, 2].map(() => c.applyOverlayTransaction(store(rec).tx, store(rec).refs, input(rec), { isCurrent: () => true })));
  assert.ok(a && b);
});

test('T493.13 (flag forced on) stale callbacks, revision conflicts, started targets and Coach edits made before commit are refused', async () => {
  const c = enabledConsumer(), rec = good();
  let s = store(rec);
  const stale = await c.applyOverlayTransaction(s.tx, s.refs, input(rec), { isCurrent: () => false });
  assert.deepEqual([stale.written, stale.reason, s.writes.length], [false, B.STALE_CALLBACK, 0]);
  const conflict = await c.applyOverlayTransaction(s.tx, s.refs, Object.assign(input(rec), { expectedRevision: 99 }), { isCurrent: () => true });
  assert.deepEqual([conflict.written, conflict.reason, s.writes.length], [false, B.REVISION_CONFLICT, 0]);
  s = store(rec, { meso: { entries: Object.assign(entriesFor({ rir_real: 3 }), { log_2_0_0_s0: { done: true } }) } });
  assert.equal((await c.applyOverlayTransaction(s.tx, s.refs, input(rec), { isCurrent: () => true })).reason, B.TARGET_ALREADY_STARTED);
  s = store(rec, { client: { coachInterventions: [{ targetType: 'EXERCISE', targetId: PID, planId: 'p', action: 'KEEP', decidedAt: '2026-09-27T12:01:00.000Z' }] } });
  assert.equal((await c.applyOverlayTransaction(s.tx, s.refs, input(rec), { isCurrent: () => true })).reason, B.COACH_OVERRIDE);
  s = store(rec, { client: { activePlanId: 'p-new' } });
  assert.equal((await c.applyOverlayTransaction(s.tx, s.refs, input(rec), { isCurrent: () => true })).reason, B.PLAN_MISMATCH);
  assert.equal(s.writes.length, 0);
});

test('T493.14 the consumer never writes plans/, is not wired into the apps, and reads no legacy fields', () => {
  const src = fs.readFileSync(path.join(root, 'assets/progression-application-consumer.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/updateDoc|setDoc|addDoc|fetch\(|localStorage|document\.|Date\.now|new Date\(/.test(src));
  assert.equal((src.match(/tx\.set\(/g) || []).length, 1);
  assert.ok(/function _commitLifecycle\(tx, refs, w\)/.test(src) && !/tx\.set\(refs\.(plan|client)/.test(src) && !/refs\.(plan|client)[^a-zA-Z]*,\s*\{ *progression/.test(src));
  assert.ok(!/newLoad|newReps|newSets|progrec|recommendedLoad|substituteExercise/.test(src));
  // T531: the athlete app may only ever CONSUME (never plan/apply): checked by the T532 client tests.
  const coachSrc = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
  assert.ok(!coachSrc.includes('applyOverlayTransaction'), 'the Coach app only ever runs the read-only dry-run planner (T494)');
});
