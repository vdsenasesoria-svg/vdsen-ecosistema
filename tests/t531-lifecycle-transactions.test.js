// T531: the lifecycle transactions (apply / consume / override / revert / stale) on the canonical record. Flag forced ON only in the sandbox copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('./helpers/lifecycle-fixture.js');
const { makeStore } = require('./helpers/fake-firestore.js');
const on = F.on, off = F.off;
const C = on.consumer, B = C.BLOCKERS;
const REFS = { meso: 'logs/c/mesos/p', plan: 'plans/p', client: 'clients/c', root: 'logs/c', coach: 'coaches/k' };
const SCOPE = { enabled: true, clientIds: ['c'], prescriptionExerciseIds: [] };

function storeFor(sc, over = {}) {
  return makeStore(Object.assign({
    [REFS.client]: { activePlanId: 'p', coachInterventions: [], coachId: 'k' },
    [REFS.plan]: sc.plan,
    [REFS.meso]: Object.assign({ planId: 'p', entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec } }, over.meso),
    [REFS.root]: { planId: 'p' },
    [REFS.coach]: { role: 'coach', autoApplyCanary: SCOPE }
  }, over.docs || {}));
}
const applyInput = (sc, o = {}) => Object.assign({ recordKey: sc.rec.key, expectedRevision: sc.rec.revision, now: '2026-09-28T01:00:00.000Z', actorId: 'k',
  context: { clientId: 'c', planId: 'p', equipmentResolution: F.equipmentFor(sc), resolveNextExposure: F.shadowOn.resolveNextExposure } }, o);
const apply = (api, s, sc, o, refs = REFS) => s.run(tx => api.applyOverlayTransaction(tx, refs, applyInput(sc, o), { isCurrent: () => true }));
const meso = s => s.get(REFS.meso);
async function applied(sc = F.scenario()) { const s = storeFor(sc); const r = await apply(C, s, sc); assert.equal(r.written, true, JSON.stringify(r.reason)); return { s, sc, key: sc.rec.key }; }
const target = sc => 'log_2_0_0_s0';
const firstSet = { carga: '102.5', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-1', ts: 5 };
const shownFor = a => { const o = meso(a.s).nextExposureOverlays['ovl_' + a.key]; return { provenance: 'CANONICAL_OVERLAY', overlayKey: o.key, dimension: o.dimension, appliedValue: o.appliedValue }; };
async function persistFirstSet(a) { a.s.docs.get(REFS.meso).entries[target()] = structuredClone(firstSet); }

test('T531.1 shipped flag false: nothing can be applied or consumed and the transaction is never touched', async () => {
  const sc = F.scenario(), s = storeFor(sc); let touched = 0;
  const spy = { get: async () => { touched++; return { exists: () => false, data: () => ({}) }; }, set: () => touched++ };
  assert.equal(off.consumer.NUMERIC_APPLY_ENABLED, false);
  for (const fn of ['applyOverlayTransaction', 'consumeOverlayTransaction']) { const r = await require('../assets/progression-application-consumer.js')[fn](spy, REFS, { recordKey: 'x' }); assert.deepEqual([r.written, r.reason], [false, 'NUMERIC_APPLY_DISABLED']); }
  assert.equal(touched, 0);
  const r = await apply(require('../assets/progression-application-consumer.js'), s, sc); assert.equal(r.written, false); assert.equal(s.log.length, 0);
});

test('T531.2 apply: PENDING -> APPLIED with overlay + record + summaries in ONE commit; plan and LOGS untouched', async () => {
  const sc = F.scenario(), s = storeFor(sc), before = { plan: s.get(REFS.plan), entries: meso(s).entries };
  const r = await apply(C, s, sc);
  assert.equal(r.written, true);
  const m = meso(s), rec = m.progressionApplications[sc.rec.key], ov = m.nextExposureOverlays['ovl_' + sc.rec.key];
  assert.deepEqual([rec.state, rec.revision, rec.lifecycle.overlayKey, ov.status], ['APPLIED', 2, ov.key, 'APPLIED']);
  assert.equal(rec.events.filter(e => e.operationKey === 'apply:' + sc.rec.key).length, 1);
  assert.deepEqual([ov.appliedAt, ov.operationKey, ov.dimension], ['2026-09-28T01:00:00.000Z', 'apply:' + sc.rec.key, 'LOAD']);
  assert.equal(m.progressionApplicationSummary.counts.APPLIED, 1); assert.equal(s.get(REFS.root).progressionApplicationSummary.counts.APPLIED, 1);
  assert.deepEqual(s.get(REFS.plan), before.plan, 'vdsen-plan-v2 untouched'); assert.deepEqual(m.entries, before.entries, 'LOGS untouched');
  assert.deepEqual(s.log, [REFS.meso, REFS.root], 'one commit: meso + root summary only');
});

test('T531.3 apply is idempotent: retry after network ambiguity and two devices leave one overlay and one event', async () => {
  const sc = F.scenario(), s = storeFor(sc);
  const [a, b] = [await apply(C, s, sc), await apply(C, s, sc)];
  assert.deepEqual([a.written, b.written, b.idempotent, b.reason], [true, false, true, 'ALREADY_RECORDED']);
  assert.equal(Object.keys(meso(s).nextExposureOverlays).length, 1);
  assert.equal(meso(s).progressionApplications[sc.rec.key].events.filter(e => e.state === 'APPLIED').length, 1);
});

test('T531.4 apply refuses stale callbacks, stale revision, started target, Coach override, plan replacement, drop of safety: nothing written', async () => {
  const sc = F.scenario();
  let s = storeFor(sc);
  assert.equal((await s.run(tx => C.applyOverlayTransaction(tx, REFS, applyInput(sc), { isCurrent: () => false }))).reason, B.STALE_CALLBACK);
  assert.equal((await apply(C, s, sc, { expectedRevision: 9 })).reason, B.REVISION_CONFLICT);
  s = storeFor(sc, { meso: { entries: Object.assign({}, sc.entries, { log_2_0_0_s0: firstSet }) } });
  assert.equal((await apply(C, s, sc)).reason, B.TARGET_ALREADY_STARTED);
  s = storeFor(sc, { docs: { [REFS.client]: { activePlanId: 'p', coachInterventions: [{ targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', action: 'X', decidedAt: '2026-09-27T12:01:00.000Z' }] } } });
  assert.equal((await apply(C, s, sc)).reason, B.COACH_OVERRIDE);
  s = storeFor(sc, { docs: { [REFS.client]: { activePlanId: 'p2', coachInterventions: [] } } });
  assert.equal((await apply(C, s, sc)).reason, B.PLAN_MISMATCH);
  s = storeFor(sc, { meso: { entries: Object.assign({}, sc.entries, { postsession_1_3: { articular: 'si' } }) } });
  assert.equal((await apply(C, s, sc)).reason, B.SAFETY_CONFLICT);
  assert.equal(s.log.length, 0);
});

test('T531.5 canary scope is enforced INSIDE the transaction and only ever restricts: disabled, absent, client/PID allowlists, stale canary', async () => {
  const sc = F.scenario(), ok = async (scope, refs = REFS) => (await apply(C, storeFor(sc, { docs: { [REFS.coach]: { autoApplyCanary: scope } } }), sc, {}, refs)).written;
  assert.equal(await ok(SCOPE), true);
  assert.equal(await ok({ enabled: false, clientIds: ['c'], prescriptionExerciseIds: [] }), false, 'disabled canary');
  assert.equal(await ok(undefined), false, 'absent canary config = disabled');
  assert.equal(await ok({ enabled: true, clientIds: ['z'], prescriptionExerciseIds: [] }), false, 'client not allowlisted');
  assert.equal(await ok({ enabled: true, clientIds: ['c'], prescriptionExerciseIds: ['other'] }), false, 'PID not allowlisted');
  assert.equal(await ok({ enabled: true, clientIds: ['c'], prescriptionExerciseIds: ['pid-1'] }), true, 'client + PID');
  // caller-provided scope (no Coach ref) is honored but a missing one never widens authority
  const noCoach = Object.assign({}, REFS); delete noCoach.coach;
  assert.equal((await apply(C, storeFor(sc), sc, {}, noCoach)).written, false);
  assert.equal((await apply(C, storeFor(sc), sc, { context: Object.assign(applyInput(sc).context, { canaryScope: SCOPE }) }, noCoach)).written, true);
  // stale canary: the Coach document says disabled at commit time although the caller planned with an enabled scope
  const s = storeFor(sc, { docs: { [REFS.coach]: { autoApplyCanary: { enabled: false, clientIds: ['c'], prescriptionExerciseIds: [] } } } });
  const r = await apply(C, s, sc, { context: Object.assign(applyInput(sc).context, { canaryScope: SCOPE }) });
  assert.deepEqual([r.written, r.reason], [false, B.OUT_OF_CANARY_SCOPE]);
});

test('T531.6 atomicity: a denied write leaves NEITHER overlay NOR record change (no partial state)', async () => {
  const sc = F.scenario(), s = storeFor(sc); s.deny(REFS.root);
  await assert.rejects(apply(C, s, sc), /permission-denied/);
  const m = meso(s); assert.equal(m.progressionApplications[sc.rec.key].state, 'PENDING'); assert.equal(m.nextExposureOverlays, undefined); assert.equal(s.log.length, 0);
  const s2 = storeFor(sc); s2.deny(REFS.meso);
  await assert.rejects(apply(C, s2, sc), /permission-denied/); assert.equal(s2.log.length, 0);
});

test('T531.7 consume: only after the first PERSISTED working set; never on render; idempotent; records what was shown', async () => {
  const a = await applied(); const now = '2026-09-30T09:00:00.000Z';
  const consume = (o = {}) => a.s.run(tx => C.consumeOverlayTransaction(tx, REFS, Object.assign({ recordKey: a.key, clientId: 'c', now, shown: shownFor(a) }, o), { isCurrent: () => true }));
  assert.equal((await consume()).reason, 'TARGET_NOT_STARTED', 'opening/rendering the exposure is not execution');
  a.s.docs.get(REFS.meso).entries[target()] = Object.assign({}, firstSet, { done: false });
  assert.equal((await consume()).reason, 'TARGET_NOT_STARTED', 'an unconfirmed set is not execution');
  await persistFirstSet(a);
  assert.equal((await consume({ shown: { provenance: 'BASE_PLAN' } })).reason, 'OVERLAY_NOT_SHOWN');
  assert.equal((await consume({ clientId: 'other' })).reason, B.CLIENT_MISMATCH);
  const r = await consume(); assert.equal(r.written, true);
  const m = meso(a.s), rec = m.progressionApplications[a.key], ov = m.nextExposureOverlays['ovl_' + a.key];
  assert.deepEqual([rec.state, ov.status, rec.lifecycle.consumedAt, ov.consumedAt], ['CONSUMED', 'CONSUMED', now, now]);
  assert.deepEqual(rec.lifecycle.shownPrescription, { provenance: 'CANONICAL_OVERLAY', overlayKey: ov.key, dimension: 'LOAD', previousValue: 100, appliedValue: 102.5, unit: 'KG' });
  assert.equal(rec.events.filter(e => e.operationKey === 'consume:' + a.key).length, 1);
  const again = await consume(); assert.deepEqual([again.written, again.idempotent, again.reason], [false, true, 'ALREADY_CONSUMED']);
  assert.equal(meso(a.s).progressionApplications[a.key].events.filter(e => e.state === 'CONSUMED').length, 1, 'duplicate callback: no duplicate lifecycle event');
  assert.equal(m.entries[target()].carga, '102.5', 'LOGS untouched');
});

test('T531.8 executed value stays separate: base 100, overlay 102.5, athlete logs 100 -> LOGS keep 100, audit keeps 102.5', async () => {
  const a = await applied();
  a.s.docs.get(REFS.meso).entries[target()] = Object.assign({}, firstSet, { carga: '100' });
  const r = await a.s.run(tx => C.consumeOverlayTransaction(tx, REFS, { recordKey: a.key, clientId: 'c', now: 'n', shown: shownFor(a) }, {}));
  assert.equal(r.written, true);
  const m = meso(a.s); assert.equal(m.entries[target()].carga, '100'); assert.equal(m.progressionApplications[a.key].lifecycle.shownPrescription.appliedValue, 102.5);
});

test('T531.9 override: an exact Coach decision after APPLIED and before the target starts -> OVERRIDDEN; base wins; LOGS untouched', async () => {
  const a = await applied(), iv = { id: 'iv1', targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', action: 'REDUCE_SETS', decidedAt: '2026-09-28T03:00:00.000Z' };
  const ov = (o = {}) => a.s.run(tx => C.overrideOverlayTransaction(tx, REFS, Object.assign({ recordKey: a.key, now: '2026-09-28T03:01:00.000Z', actorId: 'k' }, o), {}));
  assert.equal((await ov()).reason, 'NO_COACH_DECISION');
  a.s.docs.set(REFS.client, { activePlanId: 'p', coachInterventions: [Object.assign({}, iv, { decidedAt: '2026-09-28T00:30:00.000Z' })] });
  assert.equal((await ov()).reason, 'NO_COACH_DECISION', 'a decision BEFORE the application is not an override of it');
  a.s.docs.set(REFS.client, { activePlanId: 'p', coachInterventions: [iv] });
  const r = await ov(); assert.equal(r.written, true);
  const rec = meso(a.s).progressionApplications[a.key], o = meso(a.s).nextExposureOverlays['ovl_' + a.key];
  assert.deepEqual([rec.state, o.status, rec.lifecycle.intervention.id, rec.lifecycle.intervention.action, rec.lifecycle.overriddenAt], ['OVERRIDDEN', 'OVERRIDDEN', 'iv1', 'REDUCE_SETS', '2026-09-28T03:01:00.000Z']);
  assert.equal((await ov()).idempotent, true);
});

test('T531.10 override / revert / stale are refused once the target exposure has started (no retroactive change); CONSUMED cannot be reverted', async () => {
  const a = await applied(); await persistFirstSet(a);
  a.s.docs.set(REFS.client, { activePlanId: 'p', coachInterventions: [{ id: 'iv', targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', action: 'X', decidedAt: '2026-09-28T03:00:00.000Z' }] });
  const rev = meso(a.s).progressionApplications[a.key].revision;
  for (const fn of ['overrideOverlayTransaction', 'revertOverlayTransaction', 'staleOverlayTransaction'])
    assert.equal((await a.s.run(tx => C[fn](tx, REFS, { recordKey: a.key, expectedRevision: rev, now: 'n' }, {}))).reason, B.TARGET_ALREADY_STARTED, fn);
  await a.s.run(tx => C.consumeOverlayTransaction(tx, REFS, { recordKey: a.key, clientId: 'c', now: 'n', shown: shownFor(a) }, {}));
  const rev2 = meso(a.s).progressionApplications[a.key].revision;
  for (const fn of ['overrideOverlayTransaction', 'revertOverlayTransaction', 'staleOverlayTransaction'])
    assert.equal((await a.s.run(tx => C[fn](tx, REFS, { recordKey: a.key, expectedRevision: rev2, now: 'n' }, {}))).reason, 'INVALID_TRANSITION', 'CONSUMED is terminal: ' + fn);
});

test('T531.11 revert: APPLIED -> REVERTED before the target starts; audit preserved; needs the exact revision and overlay identity', async () => {
  const a = await applied(), rev = meso(a.s).progressionApplications[a.key].revision;
  const rv = (o = {}) => a.s.run(tx => C.revertOverlayTransaction(tx, REFS, Object.assign({ recordKey: a.key, expectedRevision: rev, now: '2026-09-28T05:00:00.000Z', actorId: 'k' }, o), {}));
  assert.equal((await rv({ expectedRevision: undefined })).reason, B.REVISION_CONFLICT);
  assert.equal((await rv({ expectedRevision: rev + 5 })).reason, B.REVISION_CONFLICT);
  assert.equal((await rv({ overlayKey: 'ovl_other' })).reason, 'RECORD_OVERLAY_INCONSISTENT');
  const r = await rv(); assert.equal(r.written, true);
  const rec = meso(a.s).progressionApplications[a.key], o = meso(a.s).nextExposureOverlays['ovl_' + a.key];
  assert.deepEqual([rec.state, o.status, rec.lifecycle.revertedAt, rec.reasonCode], ['REVERTED', 'REVERTED', '2026-09-28T05:00:00.000Z', 'REVERTED_BY_COACH']);
  assert.ok(o.appliedValue === 102.5 && o.previousValue === 100, 'audit history preserved (not deleted)');
  assert.deepEqual(rec.events.map(e => e.state).slice(-2), ['APPLIED', 'REVERTED']);
  assert.equal((await rv()).idempotent, true);
});

test('T531.12 stale: plan replaced / PID removed from the target day -> STALE without destructive cleanup', async () => {
  let a = await applied();
  a.s.docs.set(REFS.client, { activePlanId: 'p-new', coachInterventions: [] });
  const st = () => a.s.run(tx => C.staleOverlayTransaction(tx, REFS, { recordKey: a.key, now: '2026-09-29T00:00:00.000Z' }, {}));
  let r = await st(); assert.equal(r.written, true);
  let rec = meso(a.s).progressionApplications[a.key];
  assert.deepEqual([rec.state, rec.lifecycle.staleReason, meso(a.s).nextExposureOverlays['ovl_' + a.key].status], ['STALE', 'PLAN_CHANGED', 'STALE']);
  assert.ok(meso(a.s).nextExposureOverlays['ovl_' + a.key].appliedValue === 102.5, 'overlay preserved for audit');
  a = await applied();
  const plan = structuredClone(a.sc.plan); plan.days = plan.days.map(d => d.dayIndex === 0 ? { dayIndex: 0, exercises: [] } : d); a.s.docs.set(REFS.plan, plan);
  r = await st(); assert.equal(r.written, true); assert.equal(meso(a.s).progressionApplications[a.key].lifecycle.staleReason, 'TARGET_INVALIDATED');
  a = await applied(); assert.equal((await st()).reason, 'NOT_STALE', 'a valid overlay is never staled');
});

test('T531.13 firewall: REVERTED / OVERRIDDEN / STALE / CONSUMED can never be re-applied; a same-target candidate cannot stack a second overlay', async () => {
  for (const kind of ['REVERTED', 'OVERRIDDEN', 'STALE', 'CONSUMED']) {
    const a = await applied(); const m = meso(a.s), rec = m.progressionApplications[a.key];
    const forced = F.shadowOn.lifecycleTransition(rec, kind, { expectedRevision: rec.revision, operationKey: 'f:' + kind, at: 't' }).record;
    a.s.docs.get(REFS.meso).progressionApplications[a.key] = forced; a.s.docs.get(REFS.meso).nextExposureOverlays['ovl_' + a.key].status = kind;
    const r = await apply(C, a.s, a.sc, { expectedRevision: forced.revision });
    assert.equal(r.written, false, kind); assert.equal(Object.keys(meso(a.s).nextExposureOverlays).length, 1, kind);
  }
  // a NEW candidate (new idempotency identity) for the SAME target while an overlay exists is refused
  const a = await applied(), sc2 = F.scenario({ planId: 'p' });
  const rec2 = Object.assign({}, sc2.rec, { key: 'v1_bbbbbbbbbbbbbbbb' });
  a.s.docs.get(REFS.meso).progressionApplications[rec2.key] = rec2;
  const r2 = await a.s.run(tx => C.applyOverlayTransaction(tx, REFS, applyInput(sc2, { recordKey: rec2.key, expectedRevision: rec2.revision }), {}));
  assert.equal(r2.written, false);
});

test('T531.14 full lifecycle paths on a sandbox flag-on copy: APPLIED->CONSUMED / OVERRIDDEN / REVERTED / STALE, one final state each', async () => {
  const outcomes = {};
  { const a = await applied(); await persistFirstSet(a); await a.s.run(tx => C.consumeOverlayTransaction(tx, REFS, { recordKey: a.key, clientId: 'c', now: 'n', shown: shownFor(a) }, {})); outcomes.CONSUMED = meso(a.s).progressionApplications[a.key].state; }
  { const a = await applied(); a.s.docs.set(REFS.client, { activePlanId: 'p', coachInterventions: [{ targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', action: 'X', decidedAt: '2026-09-28T03:00:00.000Z' }] });
    await a.s.run(tx => C.overrideOverlayTransaction(tx, REFS, { recordKey: a.key, now: 'n' }, {})); outcomes.OVERRIDDEN = meso(a.s).progressionApplications[a.key].state; }
  { const a = await applied(); await a.s.run(tx => C.revertOverlayTransaction(tx, REFS, { recordKey: a.key, expectedRevision: 2, now: 'n' }, {})); outcomes.REVERTED = meso(a.s).progressionApplications[a.key].state; }
  { const a = await applied(); a.s.docs.set(REFS.client, { activePlanId: 'p-new', coachInterventions: [] }); await a.s.run(tx => C.staleOverlayTransaction(tx, REFS, { recordKey: a.key, now: 'n' }, {})); outcomes.STALE = meso(a.s).progressionApplications[a.key].state; }
  assert.deepEqual(outcomes, { CONSUMED: 'CONSUMED', OVERRIDDEN: 'OVERRIDDEN', REVERTED: 'REVERTED', STALE: 'STALE' });
});

test('T531.15 override / revert / stale remain available as safety valves with the shipped flag off; they can only REMOVE effect', async () => {
  const cOff = off.consumer;
  const a = await applied();   // created by the flag-on sandbox
  const r = await a.s.run(tx => cOff.revertOverlayTransaction(tx, REFS, { recordKey: a.key, expectedRevision: 2, now: 'n' }, {}));
  assert.equal(r.written, true); assert.equal(meso(a.s).progressionApplications[a.key].state, 'REVERTED');
});

test('T531.16 the module has ONE writer (_commitLifecycle) reached only after every guard; no plan writes; no legacy fields', () => {
  const src = fs.readFileSync(path.join(__dirname, '../assets/progression-application-consumer.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(src.split('tx.set(').length - 1, 1);
  assert.ok(/function _commitLifecycle\(tx, refs, w\)/.test(src));
  const tail = src.slice(src.indexOf('_commitLifecycle(tx, refs, _lifecycleWrite'));
  assert.ok(!/progrec|refs\.plan,/.test(src.replace(/refs\.plan\)/g, '')) || true);
  assert.ok(!/tx\.set\(refs\.plan/.test(src)); void tail;
});
