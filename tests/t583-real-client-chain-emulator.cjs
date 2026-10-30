'use strict';
// T583: replay, against the REAL server executor on the Firestore Emulator, what the REAL Client produced in the browser E2E (tests/fixtures/t583-real-client-capture.json):
// the Client UI wrote the logbook entries / post-session / progrec with its own algorithm (VDSEN v3.1) for plans imported through the Coach normalizer (Motor repsRange 8-12 on ex1;
// athlete E has a LEGACY plan). Nothing here is hand-crafted evidence: only plan identity (fresh uid / plan id) and the allowlist are set by the test.
// Chain per case: Motor plan -> Client logbook -> Client progrec -> trusted executor -> PENDING -> APPLIED -> next-exposure effective prescription -> CONSUMED -> next evaluation.
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = admin.initializeApp({ projectId }, 't583-chain-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription.js');
const FX = require('./fixtures/t583-real-client-capture.json');
test.after(async () => { await app.delete(); });

const clock = () => new Date().toISOString();   // T602: the emulator stamps plan.updateTime with the real clock, so the server-materialization instant must be real too
let seq = 0;
const J = (o) => JSON.parse(JSON.stringify(o));

async function seed(name, o) {
  o = o || {};
  const sc = FX.scenarios[name], tag = 't583-' + name + '-' + (++seq) + '-' + Date.now().toString(36), uid = 'ath-' + tag, coachId = 'coach-' + tag, planId = 'plan-' + tag;
  const plan = Object.assign(J(sc.plan), { clientId: uid, coachId });
  const entries = J(o.through === 3 ? sc.entriesThroughW3 : sc.entriesThroughW2), pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId);
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: o.interventions || [] });
  await db.doc('coaches/' + coachId).set({ autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } });
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + uid).set({ planId, entries });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries });
  return { name, uid, coachId, planId, plan, pids, entries };
}
const open = (ids) => db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: new Date(Date.now() + 36e5).toISOString(), clientIds: ids });
const run = async (s, extra) => { const { keepAllowlist, ...rest } = extra || {}; if (!keepAllowlist) await open([s.uid]); return executor.processProgression(Object.assign({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true, clock }, rest)); };
const meso = async (s) => (await db.doc('logs/' + s.uid + '/mesos/' + s.planId).get()).data();
const overlays = (m) => Object.values((m && m.nextExposureOverlays) || {});
const records = (m) => Object.values((m && m.progressionApplications) || {});
const ovOf = (m, pid, week) => overlays(m).filter((o) => o.prescriptionExerciseId === pid && (week === undefined || o.target.week === week))[0];
const digest = async (s) => JSON.stringify(await Promise.all(['clients/' + s.uid, 'plans/' + s.planId, 'logs/' + s.uid, 'logs/' + s.uid + '/mesos/' + s.planId].map(async (p) => (await db.doc(p).get()).data())));
const eff = async (s, m, ov, interventions) => {
  const plan = (await db.doc('plans/' + s.planId).get()).data(), ex = plan.days[0].exercises.find((e) => e.prescriptionExerciseId === ov.prescriptionExerciseId);
  return effective.resolveEffective({ clientId: s.uid, planId: s.planId, activePlanId: s.planId, pid: ov.prescriptionExerciseId, week: ov.target.week, dayIndex: ov.target.dayIndex, records: m.progressionApplications || {}, overlays: m.nextExposureOverlays || {},
    interventions: interventions || [], plan, entries: m.entries, baseSets: ex.sets.map((x) => Object.assign({}, x)), canonicalOverlayRead: true });
};

test('T583-E1 provenance: the entries are what the REAL Client wrote (not hand-crafted) and the plans are what the Coach import produced', () => {
  const a = FX.scenarios.A;
  assert.match(FX.meta.source, /real-Client/); const k = Object.keys(a.entriesThroughW2).filter((x) => x.startsWith('log_2_0_0_s'));
  assert.equal(k.length, 3); const e = a.entriesThroughW2[k[0]];
  assert.deepEqual(Object.keys(e).sort(), ['carga', 'done', 'exerciseNameSnapshot', 'ics', 'prescriptionExerciseId', 'pump', 'reps', 'rir', 'rir_real', 'ts', 'unit'], 'the Client\'s own entry shape');
  assert.equal(typeof e.rir_real, 'string'); assert.equal(e.unit, 'KG');
  const pg = a.entriesThroughW2.progrec_2_0; assert.ok(Array.isArray(pg.recommendations) && pg.recommendations.length === 2, 'the Client ran its own progression algorithm');
  assert.deepEqual(a.plan.days[0].exercises.map((x) => x.repsRange || null), [null, { min: 8, max: 12 }], 'Motor range kept by the Coach import; fixed reps (ex0) has none');
  assert.deepEqual(FX.scenarios.E.plan.days[0].exercises.map((x) => x.repsRange || null), [null, null], 'legacy plan');
});

test('T583-E2 PLAN -> LOGBOOK -> PROGREC -> PENDING -> APPLIED: LOAD (orientative, no equipment) and REPS (inside the Motor range) from the Client real data', async () => {
  const s = await seed('A'); const planBefore = JSON.stringify((await db.doc('plans/' + s.planId).get()).data());
  const out = await run(s); assert.equal(out.status, 'MATERIALIZED', JSON.stringify(out)); assert.deepEqual(out.applied.map((a) => [a.written, a.blocked]), [[true, null], [true, null]]);
  const m = await meso(s), o0 = ovOf(m, s.pids[0]), o1 = ovOf(m, s.pids[1]);
  assert.deepEqual([o0.dimension, o0.previousValue, o0.appliedValue, o0.unit, o0.equipmentId, o0.target.week], ['LOAD', 100, 105, 'KG', null, 3]); assert.equal(o0.equipmentSnapshot.source, 'ADVISORY_GENERIC');
  assert.deepEqual([o1.dimension, o1.previousValue, o1.appliedValue, o1.equipmentId, o1.target.week], ['REPS', 10, 12, null, 3]);
  assert.ok(records(m).every((r) => r.state === 'APPLIED'));
  assert.equal(JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), planBefore, 'the base plan is never rewritten');
  assert.equal(JSON.stringify(m.entries), JSON.stringify(s.entries), 'the logbook is untouched');
  const e0 = await eff(s, m, o0), e1 = await eff(s, m, o1);
  assert.equal(e0.provenance, 'CANONICAL_OVERLAY'); assert.equal(e0.sets[0].effective.load, 105); assert.equal(e1.provenance, 'CANONICAL_OVERLAY'); assert.deepEqual(e1.sets.map((x) => x.effective.repsTarget), [12, 12, 12]);
});

test('T583-E3 ACTUAL load feedback: the athlete trains with 102.5 (not the suggested 105); the first overlays become CONSUMED; the next evaluation starts from 102.5; a range-top / matched-RIR exercise is maintained', async () => {
  const s = await seed('A'); await run(s); let m = await meso(s);
  const w2 = records(m); const receipts = {};   // what the Client appends when the athlete opens the target exposure (append-only receipt)
  w2.forEach((r) => { const ov = ovOf(m, r.prescriptionExerciseId, 3); receipts[r.key] = { recordKey: r.key, overlayKey: ov.key, dimension: ov.dimension, appliedValue: ov.appliedValue, provenance: 'CANONICAL_OVERLAY', ackAt: clock() }; });
  const w3entries = J(FX.scenarios.A.entriesThroughW3);
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ entries: w3entries, consumptionReceipts: receipts }, { merge: true }); await db.doc('logs/' + s.uid).set({ entries: w3entries }, { merge: true });
  const w3load = [0, 1, 2].map((i) => w3entries['log_3_0_0_s' + i].carga); assert.deepEqual(w3load, ['102.5', '102.5', '102.5'], 'the athlete really used 102.5');
  const out = await run(s); m = await meso(s);
  assert.ok(out.consumed.every((c) => c.written === true) && out.consumed.length === 2, JSON.stringify(out.consumed));
  assert.deepEqual(records(m).filter((r) => r.source.week === 2).map((r) => r.state), ['CONSUMED', 'CONSUMED']);
  const next = ovOf(m, s.pids[0], 4); assert.ok(next, 'a new overlay for the next exposure');
  assert.deepEqual([next.previousValue, next.appliedValue, next.unit, next.equipmentId], [102.5, 107.5, 'KG', null], 'the baseline is the EXECUTED load');
  const dp = ovOf(m, s.pids[1], 4);   // T584 double progression: REPS reached the ceiling (12) with the prescribed effort => the next progression is LOAD
  assert.deepEqual([dp.dimension, dp.previousValue, dp.appliedValue, dp.unit, dp.equipmentId], ['LOAD', 100, 102.5, 'KG', null], 'T584: at the range ceiling with the prescribed RIR the double progression moves to LOAD');
  assert.equal(records(m).filter((r) => r.source.week === 3 && r.prescriptionExerciseId === s.pids[1])[0].magnitude.ruleId, 'DP');
  assert.equal(overlays(m).filter((o) => o.target.week === 3).length, 2, 'the first overlays are not duplicated or rewritten');
  await run(s); await run(s); await Promise.all([run(s), run(s), run(s), run(s), run(s)]); m = await meso(s);
  assert.equal(overlays(m).length, 4); assert.equal(records(m).length, 4, 'repeated and simultaneous requests add nothing');
});

test('T583-E4 (T599-R D-01) MAINTAIN (reps below target at the prescribed effort = rule C): the Client says maintain, the canonical policy still decides REST +30 s and nothing else', async () => {
  const s = await seed('B'); const out = await run(s); const m = await meso(s);
  // before T599-R this was "the server applies nothing": the legacy `maintain` ended the evaluation (REJECTED NO_NUMERIC_DELTA) before rule C could be read (T600 D-01).
  assert.ok(overlays(m).length >= 1, JSON.stringify(out));
  assert.ok(overlays(m).every((o) => o.dimension === 'REST' && o.appliedValue === o.previousValue + 30), JSON.stringify(overlays(m).map((o) => [o.dimension, o.previousValue, o.appliedValue])));
  assert.ok(records(m).every((r) => (r.state === 'APPLIED' && r.dimension === 'REST') || (r.state === 'REJECTED' && r.reasonCode === 'NO_NUMERIC_DELTA') || (r.state === 'PENDING' && r.magnitude && r.magnitude.coachReviewRequired)), JSON.stringify(records(m).map((r) => [r.state, r.reasonCode, r.dimension, r.magnitude && r.magnitude.coachReviewRequired && r.magnitude.coachReviewRequired.branch])));   // C persisting at the next comparable exposure = C+E: Coach review
  assert.ok(!overlays(m).some((o) => ['LOAD', 'REPS', 'SETS'].includes(o.dimension)), 'a Client maintain never becomes a LOAD / REPS / SETS increase');
});

test('T583-E5 INSUFFICIENT performance (6 reps to failure): no increase; (T586) effort outside the band freezes the load where a VDSEN rule exists, and a reps regression (no rule) still goes to Coach review', async () => {
  const s = await seed('C'); const out = await run(s); const m = await meso(s);
  assert.ok(overlays(m).every((o) => o.dimension === 'FREEZE'), 'never an increase: the only possible application is a held load'); assert.ok(overlays(m).length <= 1);
  assert.deepEqual(out.applied.map((a) => [a.written, a.reason]).filter((x) => x[0] === false), out.applied.map((a) => [a.written, a.reason]).filter((x) => x[0] === false).map(() => [false, 'COACH_REVIEW_REQUIRED']), 'whatever is not applied goes to review, silently discarding nothing');
  assert.ok(records(m).every((r) => r.state === 'PENDING' || r.state === 'APPLIED'), 'nothing is discarded silently: it is applied (freeze) or stays reviewable');
});

test('T583-E6 INDIVIDUAL restriction: the Client recommends an increase, the reported joint pain blocks it (SAFETY_CONFLICT)', async () => {
  const s = await seed('D'); const out = await run(s); const m = await meso(s);
  assert.equal(overlays(m).length, 0); assert.deepEqual(out.applied.map((a) => [a.written, a.reason]), [[false, 'SAFETY_CONFLICT'], [false, 'SAFETY_CONFLICT']]);
  assert.equal(s.entries.postsession_2_0.articularPain.present, true, 'the pain report was written by the Client post-session modal');
});

test('T583-E7 LEGACY plan (PID + name + sets only): LOAD works without any new field; fixed reps get no invented range, so the easier-RIR progression is LOAD', async () => {
  const s = await seed('E'); const out = await run(s); const m = await meso(s);
  const o0 = ovOf(m, s.pids[0]), o1 = ovOf(m, s.pids[1]); assert.deepEqual([o0.dimension, o0.previousValue, o0.appliedValue, o0.equipmentId], ['LOAD', 100, 105, null]);
  assert.deepEqual([o1.dimension, o1.previousValue, o1.appliedValue, o1.equipmentId], ['LOAD', 100, 105, null], 'T584: fixed reps have no rep room (no range is invented), so an easier RIR moves by LOAD');
  assert.equal(overlays(m).length, 2); assert.deepEqual(out.applied.map((a) => a.written), [true, true]);
});

test('T583-E8 the Coach decides: a Coach decision on ONE exercise after the application makes the Client show its base prescription; the other exercise keeps its adjustment', async () => {
  const s = await seed('F'); await run(s); const m = await meso(s), o0 = ovOf(m, s.pids[0]), o1 = ovOf(m, s.pids[1]);
  assert.equal((await eff(s, m, o0)).provenance, 'CANONICAL_OVERLAY');
  const iv = [{ id: 'iv-1', targetType: 'EXERCISE', targetId: s.pids[0], action: 'REDUCE_SETS', decidedAt: new Date(Date.now() + 3600000).toISOString() }];
  assert.notEqual((await eff(s, m, o0, iv)).provenance, 'CANONICAL_OVERLAY'); assert.equal((await eff(s, m, o1, iv)).provenance, 'CANONICAL_OVERLAY');
});

test('T583-E9 multi-client isolation: processing one athlete never writes another; a request asserting another athlete\'s plan is rejected', async () => {
  const a = await seed('A'), e = await seed('E'), d = await seed('D'); await open([a.uid, e.uid, d.uid]);
  const before = [await digest(e), await digest(d)];
  await run(a, { keepAllowlist: true }); assert.deepEqual([await digest(e), await digest(d)], before, 'A wrote nothing of E or D');
  await run(e, { keepAllowlist: true }); await run(d, { keepAllowlist: true });
  const ma = await meso(a), me = await meso(e), md = await meso(d);
  assert.ok(overlays(ma).every((o) => o.clientId === a.uid && a.pids.includes(o.prescriptionExerciseId))); assert.ok(overlays(me).every((o) => o.clientId === e.uid)); assert.equal(overlays(md).length, 0);
  assert.equal((await executor.processProgression({ db, clientId: a.uid, planId: e.planId, enabled: true, numericApplyEnabled: true, clock })).status, 'PLAN_MISMATCH');
});

test('T583-E10 flags OFF: DISARMED writes nothing; numeric apply OFF leaves PENDING only; outside the allowlist nothing is written', async () => {
  const s = await seed('A'); const d0 = await digest(s);
  assert.deepEqual(await run(s, { enabled: false }), { status: 'DISARMED', writes: 0 }); assert.equal(await digest(s), d0);
  const pend = await run(s, { numericApplyEnabled: false }); assert.deepEqual([pend.applied, pend.consumed], [[], []]); const m = await meso(s);
  assert.equal(overlays(m).length, 0); assert.ok(records(m).every((r) => r.state === 'PENDING'));
  const t = await seed('A'); await open(['someone-else']); const d1 = await digest(t);
  assert.equal((await run(t, { keepAllowlist: true })).status, 'OUT_OF_ALLOWLIST'); assert.equal(await digest(t), d1);
});
