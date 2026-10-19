'use strict';
// T584: replay, against the REAL server executor on the Firestore Emulator, what the REAL Client produced in the browser E2E (tests/fixtures/t584-real-client-capture.json):
// the Client UI wrote the logbook entries / post-session / progrec with its own algorithm (VDSEN v3.1) with TECHNIQUE (ICS) >= 8, where the Client recommends add_sets (volume-first).
// Nothing here is hand-crafted evidence: only plan identity (fresh uid / plan id) and the allowlist are set by the test.
// Chain per case: Motor plan -> Client logbook -> Client progrec -> trusted executor -> PENDING -> APPLIED -> next-exposure effective prescription -> CONSUMED -> next evaluation.
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = admin.initializeApp({ projectId }, 't584-chain-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription.js');
const FX = require('./fixtures/t584-real-client-capture.json');
test.after(async () => { await app.delete(); });

const clock = () => '2026-10-19T12:00:00.000Z';
let seq = 0;
const J = (o) => JSON.parse(JSON.stringify(o));

async function seed(name, o) {
  o = o || {};
  const sc = FX.scenarios[name], tag = 't584-' + name + '-' + (++seq) + '-' + Date.now().toString(36), uid = 'ath-' + tag, coachId = 'coach-' + tag, planId = 'plan-' + tag;
  const plan = Object.assign(J(sc.plan), { clientId: uid, coachId });
  const entries = J(o.through === 3 ? sc.entriesThroughW3 : sc.entriesThroughW2), pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId);
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: o.interventions || [] });
  await db.doc('coaches/' + coachId).set({ autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } });
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + uid).set({ planId, entries });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries });
  return { name, uid, coachId, planId, plan, pids, entries };
}
const open = (ids) => db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ids });
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

test('T584-E1 provenance: the entries are what the REAL Client wrote with ICS >= 8, and the Client itself recommended add_sets (volume-first)', () => {
  assert.match(FX.meta.source, /real-Client/);
  for (const name of ['G', 'I', 'K', 'L']) {
    const e = FX.scenarios[name].entriesThroughW2, ics = Object.keys(e).filter((k) => k.startsWith('log_2_0_')).map((k) => e[k].ics);
    assert.ok(ics.length === 6 && ics.every((x) => x === 8), name + ' ICS 8');
    assert.deepEqual(e.progrec_2_0.recommendations.map((r) => r.action), ['add_sets', 'add_sets'], name + ': the Client recommends volume, not load/reps');
  }
});

test('T584-E2 ICS >= 8: the Client recommends add_sets and the server STILL evaluates LOAD (orientative) and REPS (inside the Motor range) from the evidence; the volume decision stays with the Coach', async () => {
  const s = await seed('G'); const planBefore = JSON.stringify((await db.doc('plans/' + s.planId).get()).data());
  const out = await run(s); assert.equal(out.status, 'MATERIALIZED', JSON.stringify(out)); assert.deepEqual(out.applied.map((a) => [a.written, a.blocked]), [[true, null], [true, null]]);
  const m = await meso(s), o0 = ovOf(m, s.pids[0]), o1 = ovOf(m, s.pids[1]);
  assert.deepEqual([o0.dimension, o0.previousValue, o0.appliedValue, o0.unit, o0.equipmentId], ['LOAD', 100, 105, 'KG', null]);
  assert.deepEqual([o1.dimension, o1.previousValue, o1.appliedValue, o1.equipmentId], ['REPS', 10, 12, null]);
  assert.ok(records(m).every((r) => r.action === 'add_sets' && r.state === 'APPLIED'), 'the record keeps the Client volume recommendation as its source action');
  assert.equal(JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), planBefore, 'the plan is not rewritten: NO set is added automatically (volume is the Coach decision)');
  assert.equal(s.entries.progrec_2_0.recommendations[0].newSets, 4, 'the add_sets recommendation stays visible to the Coach in the logbook / monitor');
  const e0 = await eff(s, m, o0), e1 = await eff(s, m, o1);
  assert.equal(e0.sets[0].effective.load, 105); assert.deepEqual(e1.sets.map((x) => x.effective.repsTarget), [12, 12, 12]); assert.equal(e0.sets.length, 3, 'still 3 sets');
});

test('T584-E3 DOUBLE PROGRESSION + ACTUAL load: the athlete used 102.5 (not 105) and reached the 12-rep ceiling at the prescribed RIR; the next evaluation moves the curl to LOAD and starts the press from 102.5', async () => {
  const s = await seed('G'); await run(s); let m = await meso(s); const receipts = {};
  records(m).forEach((r) => { const ov = ovOf(m, r.prescriptionExerciseId, 3); receipts[r.key] = { recordKey: r.key, overlayKey: ov.key, dimension: ov.dimension, appliedValue: ov.appliedValue, provenance: 'CANONICAL_OVERLAY', ackAt: clock() }; });
  const w3 = J(FX.scenarios.G.entriesThroughW3); assert.deepEqual([0, 1, 2].map((i) => w3['log_3_0_0_s' + i].carga), ['102.5', '102.5', '102.5']); assert.deepEqual([0, 1, 2].map((i) => w3['log_3_0_1_s' + i].reps), ['12', '12', '12']);
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ entries: w3, consumptionReceipts: receipts }, { merge: true }); await db.doc('logs/' + s.uid).set({ entries: w3 }, { merge: true });
  const out = await run(s); m = await meso(s);
  assert.deepEqual(out.consumed.map((c) => c.written), [true, true]); assert.deepEqual(records(m).filter((r) => r.source.week === 2).map((r) => r.state), ['CONSUMED', 'CONSUMED']);
  const n0 = ovOf(m, s.pids[0], 4), n1 = ovOf(m, s.pids[1], 4);
  assert.deepEqual([n0.dimension, n0.previousValue, n0.appliedValue, n0.equipmentId], ['LOAD', 102.5, 107.5, null], 'baseline = the EXECUTED load');
  assert.deepEqual([n1.dimension, n1.previousValue, n1.appliedValue, n1.equipmentId], ['LOAD', 100, 102.5, null], 'ceiling reached with the prescribed effort: reps first is exhausted, load next');
  const r1 = records(m).filter((r) => r.source.week === 3 && r.prescriptionExerciseId === s.pids[1])[0];
  assert.equal(r1.magnitude.ruleId, 'DP'); assert.deepEqual(r1.magnitude.doubleProgression, { ceiling: 12, trigger: 'RIR_AS_PRESCRIBED_AT_CEILING' });
  const e1 = await eff(s, m, n1); assert.equal(e1.provenance, 'CANONICAL_OVERLAY'); assert.equal(e1.sets[0].effective.load, 102.5);
  // KNOWN LIMIT (documented, not hidden): overlays are per EXPOSURE. The load step never touches reps, and the REPS overlay of the previous exposure (12) does not carry over, so this exposure's reps target is the
  // BASE prescription (10). With Motor-compliant plans (repsTarget = the range ceiling) the base IS the ceiling, which is the Client's own double-progression contract (newReps = repsTarget).
  assert.deepEqual(e1.sets.map((x) => x.effective.repsTarget), [10, 10, 10]);
  await run(s); await Promise.all([run(s), run(s), run(s), run(s), run(s)]); m = await meso(s);
  assert.equal(overlays(m).length, 4); assert.equal(records(m).length, 4, 'repeated and simultaneous requests add nothing');
});

test('T584-E4 flags OFF with the real Client data: DISARMED writes nothing; numeric apply OFF leaves PENDING only (what WOULD be prescribed, for observation) and a later activation applies those SAME records once', async () => {
  const s = await seed('I'); const d0 = await digest(s);
  assert.deepEqual(await run(s, { enabled: false }), { status: 'DISARMED', writes: 0 }); assert.equal(await digest(s), d0);
  const obs = await run(s, { numericApplyEnabled: false }); assert.deepEqual([obs.applied, obs.consumed], [[], []]); let m = await meso(s);
  assert.equal(overlays(m).length, 0); assert.ok(records(m).every((r) => r.state === 'PENDING'));
  assert.deepEqual(records(m).map((r) => r.magnitude.candidates[0].dimension).sort(), ['LOAD', 'REPS'], 'the observation shows the LOAD and REPS decisions that would apply');
  const keys = records(m).map((r) => r.key).sort();
  await run(s); m = await meso(s); assert.deepEqual(records(m).map((r) => r.key).sort(), keys, 'no new record: the activation applies the observed ones'); assert.equal(overlays(m).length, 2);
  const t = await seed('I'); await open(['someone-else']); const d1 = await digest(t); assert.equal((await run(t, { keepAllowlist: true })).status, 'OUT_OF_ALLOWLIST'); assert.equal(await digest(t), d1);
});

test('T584-E5 insufficient performance with ICS 8: nothing is increased; it goes to Coach review', async () => {
  const s = await seed('J'); const out = await run(s); const m = await meso(s);
  assert.equal(overlays(m).length, 0); assert.deepEqual(out.applied.map((a) => [a.written, a.reason]), [[false, 'COACH_REVIEW_REQUIRED'], [false, 'COACH_REVIEW_REQUIRED']]);
});

test('T584-E6 individual restriction with ICS 8: the independent evaluation computes the candidates but joint pain blocks them (SAFETY_CONFLICT)', async () => {
  const s = await seed('K'); const out = await run(s); const m = await meso(s);
  assert.equal(s.entries.postsession_2_0.articularPain.present, true); assert.equal(overlays(m).length, 0);
  assert.deepEqual(out.applied.map((a) => [a.written, a.reason]), [[false, 'SAFETY_CONFLICT'], [false, 'SAFETY_CONFLICT']]);
  assert.deepEqual(records(m).map((r) => r.magnitude.candidates[0].dimension).sort(), ['LOAD', 'REPS']);
});

test('T584-E7 the Coach decides: a decision on one exercise makes the Client show its base prescription; the other keeps its adjustment', async () => {
  const s = await seed('L'); await run(s); const m = await meso(s), o0 = ovOf(m, s.pids[0]), o1 = ovOf(m, s.pids[1]);
  const iv = [{ id: 'iv-1', targetType: 'EXERCISE', targetId: s.pids[0], action: 'REDUCE_SETS', decidedAt: '2026-10-20T00:00:00.000Z' }];
  assert.notEqual((await eff(s, m, o0, iv)).provenance, 'CANONICAL_OVERLAY'); assert.equal((await eff(s, m, o1, iv)).provenance, 'CANONICAL_OVERLAY');
});

test('T584-E8 multi-client isolation: processing one athlete never writes another', async () => {
  const g = await seed('G'), k = await seed('K'), l = await seed('L'); await open([g.uid, k.uid, l.uid]);
  const before = [await digest(k), await digest(l)]; await run(g, { keepAllowlist: true }); assert.deepEqual([await digest(k), await digest(l)], before, 'G wrote nothing of K or L');
  await run(l, { keepAllowlist: true }); await run(k, { keepAllowlist: true });
  assert.ok(overlays(await meso(g)).every((o) => o.clientId === g.uid && g.pids.includes(o.prescriptionExerciseId))); assert.equal(overlays(await meso(k)).length, 0);
  assert.equal((await executor.processProgression({ db, clientId: g.uid, planId: l.planId, enabled: true, numericApplyEnabled: true, clock })).status, 'PLAN_MISMATCH');
});
