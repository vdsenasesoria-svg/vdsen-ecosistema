// T570-R: REAL Firestore (emulator + firestore.rules) end-to-end for the trusted autonomous progression executor.
// Admin SDK = the trusted server; client SDK sessions = athlete / foreign coach (must be rejected by firestore.rules).
// Requires FIRESTORE_EMULATOR_HOST + app-matched SDKs on NODE_PATH (see scripts/test-auto-apply-emulator.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
const executor = require('../api/autonomous-progression.js');
const trigger = require('../api/autonomous-progression-trigger.js');
const sweep = require('../api/autonomous-progression-sweep.js');
const F = require('./helpers/lifecycle-fixture.js');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't570r-admin');
const db = getAdminFirestore(adminApp);
const apps = [];
async function signedIn(uid) {
  uid = uid || 't570r-' + randomUUID();
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't570r-' + apps.length);
  apps.push(app);
  const cdb = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(cdb, host, Number(port), { mockUserToken: { sub: uid } });
  return { uid, db: cdb };
}
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

const PID = 'pid-1', T0 = Date.parse('2026-09-27T12:00:00.000Z');
function evidence(opts) {
  opts = opts || {};
  const logs = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => {
    logs['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: opts.rirTarget === undefined ? 1 : opts.rirTarget, rir_real: opts.rirReal === undefined ? 3 : opts.rirReal, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s };
  }));
  if (!opts.noRec) logs.progrec_1_2 = { calculatedAt: '2026-09-27T12:00:00.000Z', recommendations: [{ prescriptionExerciseId: PID, exerciseId: 'ex-1', exerciseName: 'Press', action: 'increase_reps', newReps: 11 }] };
  return logs;
}
function planDoc(uid, coachId, rirTarget) {
  return { clientId: uid, coachId, status: 'active', weeks: 3, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    days: [0, 2].map(dayIndex => ({ dayIndex, exercises: [{ prescriptionExerciseId: PID, exerciseId: 'ex-1', exerciseName: 'Press', repsRange: { min: 8, max: 12 }, sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: rirTarget === undefined ? 1 : rirTarget, restSeconds: 90 })) }] })) };
}
async function fixture(o) {
  o = o || {};
  const athlete = await signedIn(), coach = await signedIn();
  const planId = 'plan-' + athlete.uid, logs = evidence(o);
  await db.doc('coaches/' + coach.uid).set({ role: 'coach', autoApplyCanary: o.canary === false ? { enabled: false, clientIds: [] } : { enabled: true, clientIds: o.canaryOther ? ['someone-else'] : [athlete.uid], prescriptionExerciseIds: [] } });
  await db.doc('clients/' + athlete.uid).set({ coachId: coach.uid, activePlanId: planId, coachInterventions: o.interventions || [] });
  await db.doc('plans/' + planId).set(planDoc(athlete.uid, coach.uid, o.rirTarget));
  await db.doc('logs/' + athlete.uid).set({ planId, entries: logs });
  await db.doc('logs/' + athlete.uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { athlete, coach, planId, logs };
}
const run = (f, o) => executor.processProgression(Object.assign({ db, clientId: f.athlete.uid, planId: f.planId, enabled: true, numericApplyEnabled: true,
  clock: () => '2026-09-28T00:00:00.000Z' }, o || {}));
const meso = async f => (await db.doc('logs/' + f.athlete.uid + '/mesos/' + f.planId).get()).data();
const recs = async f => Object.values((await meso(f)).progressionApplications || {});
const overlays = async f => Object.values((await meso(f)).nextExposureOverlays || {});

test('E01/E02 persisted evidence -> trusted executor materializes AND applies, no Coach session involved', { timeout: 60000 }, async () => {
  const f = await fixture(), before = (await meso(f)).entries;
  const out = await run(f);
  assert.equal(out.status, 'MATERIALIZED', JSON.stringify(out));
  assert.deepEqual(out.applied.map(a => [a.written, a.reason]), [[true, null]], JSON.stringify(out.applied));
  const [r] = await recs(f), [o] = await overlays(f);
  assert.equal(r.state, 'APPLIED'); assert.equal(o.status, 'APPLIED'); assert.equal(o.dimension, 'REPS');
  assert.equal(r.sraTrace.mutation, 'NONE', 'E08/SRA is a read-only trace');
  assert.deepEqual((await meso(f)).entries, before, 'E17 execution evidence untouched');
  assert.equal((await db.doc('plans/' + f.planId).get()).data().updatedAt, '2026-09-26T00:00:00.000Z', 'base plan immutable');
});

test('E03/E15 the next exposure resolves the canonical overlay (no Monitor opened)', { timeout: 60000 }, async () => {
  const f = await fixture(); await run(f);
  const m = await meso(f), cl = (await db.doc('clients/' + f.athlete.uid).get()).data(), plan = (await db.doc('plans/' + f.planId).get()).data();
  const eff = F.on.effective.resolveEffective({ clientId: f.athlete.uid, planId: f.planId, activePlanId: cl.activePlanId, pid: PID, week: 2, dayIndex: 0,
    records: m.progressionApplications, overlays: m.nextExposureOverlays || {}, interventions: cl.coachInterventions, plan, entries: m.entries, baseSets: F.baseSets() });
  assert.equal(eff.provenance, 'CANONICAL_OVERLAY', eff.reason);
  assert.equal(eff.sets[0].effective.repsTarget, (await overlays(f))[0].appliedValue); assert.equal(eff.sets[0].effective.repsTarget, 12); assert.equal(eff.sets[0].base.repsTarget, 10);
});

test('E04/E16/E05 duplicates, retries and concurrent devices produce exactly one application', { timeout: 60000 }, async () => {
  const f = await fixture();
  await Promise.all([run(f), run(f), run(f)]);
  await run(f);
  const rs = await recs(f), os = await overlays(f);
  assert.equal(rs.length, 1); assert.equal(os.length, 1);
  assert.equal(rs[0].events.filter(e => e.state === 'APPLIED').length, 1);
  assert.equal(rs[0].revision, 2);
});

test('E07 insufficient evidence keeps the base prescription', { timeout: 60000 }, async () => {
  const f = await fixture({ noRec: true }); const out = await run(f);
  assert.deepEqual(await overlays(f), []); assert.ok(out.status !== 'MATERIALIZED' || out.applied.every(a => !a.written));
});

test('E09 replaced plan: stale plan assertion cannot materialize or apply', { timeout: 60000 }, async () => {
  const f = await fixture(); await db.doc('clients/' + f.athlete.uid).update({ activePlanId: 'plan-new' });
  const out = await run(f);
  assert.equal(out.status, 'PLAN_MISMATCH'); assert.deepEqual(await overlays(f), []); assert.deepEqual(await recs(f), []);
});

test('E10 exposure already started: no retroactive adjustment', { timeout: 60000 }, async () => {
  const f = await fixture(); await run(f); // would apply; build a second client where W2 D0 already started
  const g = await fixture();
  const started = Object.assign({}, g.logs, { log_2_0_0_s0: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: PID, ts: 9 } });
  await db.doc('logs/' + g.athlete.uid + '/mesos/' + g.planId).set({ planId: g.planId, entries: started });
  await db.doc('logs/' + g.athlete.uid).set({ planId: g.planId, entries: started });
  const out = await run(g);
  assert.deepEqual(await overlays(g), [], JSON.stringify(out));
});

test('E11 athlete and foreign coach cannot write canonical progression state (firestore.rules)', { timeout: 60000 }, async () => {
  const f = await fixture(), foreign = await signedIn();
  const bad = [['athlete', f.athlete.db], ['foreign coach', foreign.db]];
  for (const [who, cdb] of bad) {
    await assert.rejects(() => setDoc(doc(cdb, 'logs', f.athlete.uid, 'mesos', f.planId), { progressionApplications: { x: { state: 'APPLIED' } } }, { merge: true }), /PERMISSION_DENIED|permission/i, who);
    await assert.rejects(() => setDoc(doc(cdb, 'logs', f.athlete.uid, 'mesos', f.planId), { nextExposureOverlays: { x: { status: 'APPLIED' } } }, { merge: true }), /PERMISSION_DENIED|permission/i, who);
  }
});

test('E12/E13/E14 disarmed, out-of-scope and disabled canary perform zero mutations', { timeout: 60000 }, async () => {
  const a = await fixture(); const snapA = JSON.stringify(await meso(a));
  assert.deepEqual(await executor.processProgression({ db, clientId: a.athlete.uid, planId: a.planId }), { status: 'DISARMED', writes: 0 });
  assert.equal(JSON.stringify(await meso(a)), snapA, 'E12 disarmed');
  const noNum = await run(a, { numericApplyEnabled: false }); assert.deepEqual(noNum.applied, []); assert.deepEqual(await overlays(a), []);
  const b = await fixture({ canaryOther: true }); await run(b); assert.deepEqual(await overlays(b), [], 'E13 out of canary scope');
  const c = await fixture({ canary: false }); await run(c); assert.deepEqual(await overlays(c), [], 'E14 canary disabled');
  // E14 b: disabling AFTER materialization stops any later application
  const d = await fixture(); await run(d, { numericApplyEnabled: false });
  await db.doc('coaches/' + d.coach.uid).update({ autoApplyCanary: { enabled: false, clientIds: [d.athlete.uid] } });
  await run(d); assert.deepEqual(await overlays(d), []);
});

test('E19 a LOAD candidate with no verified equipment increment is blocked: no overlay, no invented load', { timeout: 60000 }, async () => {
  const f = await fixture({ rirTarget: 2 }); const out = await run(f);
  assert.deepEqual(await overlays(f), [], JSON.stringify(out));
  assert.deepEqual(out.applied.map(a => a.reason), ['UNRESOLVED_EQUIPMENT_INCREMENT']);
});

test('E20 a Coach intervention prevails and never loads a LOAD overlay', { timeout: 60000 }, async () => {
  const f = await fixture({ interventions: [{ id: 'iv-1', targetType: 'EXERCISE', targetId: PID, planId: 'plan-x', action: 'REDUCE_SETS', decidedAt: '2026-09-27T14:00:00.000Z' }] });
  const out = await run(f);
  assert.ok((await overlays(f)).every(o => o.dimension !== 'LOAD'), JSON.stringify(out));
});

test('E18 longitudinal: a second exposure cycle does not duplicate or regress the first application', { timeout: 60000 }, async () => {
  const f = await fixture(); await run(f);
  const more = Object.assign({}, f.logs); // week 2 sessions executed AFTER the overlay was applied
  [[2, 0], [2, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { more['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: '11', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: PID, ts: T0 + 9e6 + s }; }));
  more.progrec_2_2 = { calculatedAt: '2026-10-04T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: PID, exerciseId: 'ex-1', exerciseName: 'Press', action: 'increase_reps', newReps: 12 }] };
  await db.doc('logs/' + f.athlete.uid + '/mesos/' + f.planId).update({ entries: more });
  await db.doc('logs/' + f.athlete.uid).update({ entries: more });
  await run(f); await run(f);
  const rs = await recs(f);
  assert.ok(rs.length <= 2); assert.equal(rs.filter(r => r.state === 'APPLIED').length, (await overlays(f)).length);
  assert.equal(rs.filter(r => r.week === 1 || r.source && r.source.week === 1)[0].events.filter(e => e.state === 'APPLIED').length, 1);
});

test('endpoint: bearer auth is mandatory, uid comes from the verified token, body client identity ignored', { timeout: 60000 }, async () => {
  const f = await fixture(), other = await fixture();
  const handler = trigger.makeHandler({ db, enabled: true, numericApplyEnabled: true, verifyIdToken: async t => { if (t !== 'ok') throw new Error('bad'); return { uid: f.athlete.uid }; } });
  const res = () => ({ statusCode: 0, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });
  let r = res(); await handler({ method: 'POST', headers: {}, body: { planId: f.planId } }, r); assert.equal(r.statusCode, 401);
  r = res(); await handler({ method: 'POST', headers: { authorization: 'Bearer nope' }, body: { planId: f.planId } }, r); assert.equal(r.statusCode, 401);
  r = res(); await handler({ method: 'POST', headers: { authorization: 'Bearer ok' }, body: { planId: other.planId, clientId: other.athlete.uid } }, r);
  assert.equal(r.body.status, 'PLAN_MISMATCH'); assert.deepEqual(await overlays(other), []);
  r = res(); await handler({ method: 'POST', headers: { authorization: 'Bearer ok' }, body: { planId: f.planId } }, r); assert.equal(r.statusCode, 200);
  assert.equal((await overlays(f)).length, 1);
});

test('durable recovery: the cron sweep processes pending evidence when the browser never notified', { timeout: 180000 }, async () => {
  const f = await fixture(), g = await fixture({ canaryOther: true });
  const out = await sweep.runSweep({ db, enabled: true, numericApplyEnabled: true, clock: () => '2026-09-28T00:00:00.000Z' });
  assert.ok(out.processed >= 1);
  assert.equal((await overlays(f)).length, 1, 'in-scope athlete processed without any browser call');
  assert.deepEqual(await overlays(g), [], 'out-of-scope athlete untouched');
  const again = await sweep.runSweep({ db, enabled: true, numericApplyEnabled: true }); // idempotent
  assert.equal((await overlays(f)).length, 1); assert.ok(again.processed >= 1);
  assert.deepEqual(await sweep.runSweep({ db, enabled: false, numericApplyEnabled: true }), { status: 'DISARMED', processed: 0 });
});

test('E06 a failed save persists no evidence: the executor creates no record and no overlay', { timeout: 60000 }, async () => {
  const f = await fixture();
  await db.doc('logs/' + f.athlete.uid + '/mesos/' + f.planId).set({ planId: f.planId, entries: {} });
  await db.doc('logs/' + f.athlete.uid).set({ planId: f.planId, entries: {} });
  const out = await run(f);
  assert.deepEqual(await overlays(f), [], JSON.stringify(out)); assert.deepEqual(await recs(f), []);
});

test('E08 an unfavorable articular signal never authorizes an increase (SRA trace stays NONE)', { timeout: 60000 }, async () => {
  const f = await fixture();
  const withPain = Object.assign({}, f.logs, { postsession_1_2: { articular: 'si', patron: 'press', eimd: 2, sleep: 5, rpe: 9 } });
  await db.doc('logs/' + f.athlete.uid + '/mesos/' + f.planId).set({ planId: f.planId, entries: withPain });
  await db.doc('logs/' + f.athlete.uid).set({ planId: f.planId, entries: withPain });
  const out = await run(f);
  assert.deepEqual(await overlays(f), [], JSON.stringify(out));
  (await recs(f)).forEach(r => assert.equal(r.sraTrace.mutation, 'NONE'));
});
