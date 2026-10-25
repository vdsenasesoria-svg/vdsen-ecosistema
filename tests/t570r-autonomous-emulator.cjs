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
const executor = require('../api/_autonomousProgression.js');
const trigger = require('../api/autonomous-progression-trigger.js');
const sweep = require('../api/_autonomousProgressionSweep.js');
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
    logs['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: opts.restScenario && d === 2 ? '9' : '10', unit: 'KG', rir: opts.rirTarget === undefined ? 1 : opts.rirTarget, rir_real: opts.restScenario ? 1 : (opts.rirReal === undefined ? 3 : opts.rirReal), prescriptionExerciseId: PID, ts: T0 + d * 1000 + s };
  }));
  if (!opts.noRec) logs.progrec_1_2 = { calculatedAt: '2026-09-27T12:00:00.000Z', recommendations: [{ prescriptionExerciseId: PID, exerciseId: opts.exerciseId || 'ex-1', exerciseName: 'Press', action: opts.restScenario ? 'maintain' : (opts.exerciseId ? 'increase_load' : 'increase_reps'), newReps: opts.exerciseId ? 10 : 11 }].map(r => opts.exerciseId ? Object.assign(r, { newLoad: 5 }) : r) };
  return logs;
}
function planDoc(uid, coachId, rirTarget, exerciseId) {
  return { clientId: uid, coachId, status: 'active', weeks: 3, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    days: [0, 2].map(dayIndex => ({ dayIndex, exercises: [{ prescriptionExerciseId: PID, exerciseId: exerciseId || 'ex-1', exerciseName: 'Press', repsRange: { min: 8, max: 12 }, sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: rirTarget === undefined ? 1 : rirTarget, restSeconds: 90 })) }] })) };
}
// T571: the RELEASE-owned allowlist (second fence). Fixtures list their athlete unless the test says otherwise; at most 8 recent athletes.
const ALLOWED = [];
const setRelease = (ids, extra) => db.doc('releaseControl/autonomousProgression').set(Object.assign({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ids }, extra || {}));
async function fixture(o) {
  o = o || {};
  const athlete = await signedIn(), coach = await signedIn();
  if (!o.noRelease) { ALLOWED.push(athlete.uid); await setRelease(ALLOWED.slice(-8)); }
  const planId = 'plan-' + athlete.uid, logs = evidence(o);
  await db.doc('coaches/' + coach.uid).set(Object.assign({ role: 'coach' }, o.equipmentIncrements ? { equipmentIncrements: o.equipmentIncrements } : {}, { autoApplyCanary: o.canary === false ? { enabled: false, clientIds: [] } : { enabled: true, clientIds: o.canaryOther ? ['someone-else'] : [athlete.uid], prescriptionExerciseIds: [] } }));
  await db.doc('clients/' + athlete.uid).set({ coachId: coach.uid, activePlanId: planId, coachInterventions: o.interventions || [] });
  await db.doc('plans/' + planId).set(planDoc(athlete.uid, coach.uid, o.rirTarget, o.exerciseId));
  await db.doc('logs/' + athlete.uid).set({ planId, entries: logs });
  await db.doc('logs/' + athlete.uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { athlete, coach, planId, logs };
}
const run = (f, o) => executor.processProgression(Object.assign({ db, clientId: f.athlete.uid, planId: f.planId, enabled: true, numericApplyEnabled: true,
  clock: () => new Date().toISOString() }, o || {}));
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

test('E19 (T582) a LOAD candidate with NO equipment data is NOT blocked: it becomes an ADVISORY target (no machine claim, nothing invented beyond the rule step)', { timeout: 60000 }, async () => {
  const f = await fixture({ rirTarget: 2 }); const out = await run(f);
  assert.deepEqual(out.applied.map(a => [a.written, a.blocked]), [[true, null]], JSON.stringify(out.applied));
  const [o] = await overlays(f);
  assert.equal(o.dimension, 'LOAD'); assert.equal(o.status, 'APPLIED'); assert.equal(o.equipmentId, null, 'no equipment claim'); assert.equal(o.unit, 'KG');
  assert.equal(o.previousValue, 100); assert.ok(o.appliedValue > 100 && o.appliedValue <= 110, 'a rule-sized step above the executed load: ' + o.appliedValue);
  assert.equal(o.equipmentSnapshot.source, 'ADVISORY_GENERIC'); assert.match(o.roundingReason, /^ADVISORY_/);
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
  const out = await sweep.runSweep({ db, enabled: true, numericApplyEnabled: true, clock: () => new Date().toISOString() });
  assert.ok(out.processed >= 1);
  assert.equal((await overlays(f)).length, 1, 'in-scope athlete processed without any browser call');
  assert.deepEqual(await overlays(g), [], 'out-of-scope athlete untouched');
  const again = await sweep.runSweep({ db, enabled: true, numericApplyEnabled: true }); // idempotent
  assert.equal((await overlays(f)).length, 1); assert.ok(again.processed >= 1);
  assert.deepEqual(await sweep.runSweep({ db, enabled: false, numericApplyEnabled: true }), { status: 'DISARMED', processed: 0 });
});

// ---- T570-R.2 -------------------------------------------------------------------------------------------------------------------------
const snapshotAll = async f => JSON.stringify([(await db.doc('logs/' + f.athlete.uid + '/mesos/' + f.planId).get()).data(), (await db.doc('logs/' + f.athlete.uid).get()).data(),
  (await db.doc('plans/' + f.planId).get()).data(), (await db.doc('clients/' + f.athlete.uid).get()).data()]);
const setCanary = (f, v) => db.doc('coaches/' + f.coach.uid).set({ role: 'coach', autoApplyCanary: v });
const setClientCoachCanaryAbsent = f => db.doc('coaches/' + f.coach.uid).set({ role: 'coach' });

test('CANARY boundary: absent / disabled / out-of-client => ZERO writes of any kind (materialize included)', { timeout: 90000 }, async () => {
  const absent = await fixture(); await setClientCoachCanaryAbsent(absent);
  const disabled = await fixture(); await setCanary(disabled, { enabled: false, clientIds: [disabled.athlete.uid] });
  const other = await fixture({ canaryOther: true });
  for (const f of [absent, disabled, other]) {
    const before = await snapshotAll(f);
    const out = await run(f);
    assert.equal(out.status, 'OUT_OF_CANARY'); assert.deepEqual(out.applied, []);
    assert.equal(await snapshotAll(f), before, 'not a single byte changed');
  }
});

test('CANARY boundary: PID outside scope => no record, no application; in-scope PID processes normally', { timeout: 60000 }, async () => {
  const f = await fixture(); await setCanary(f, { enabled: true, clientIds: [f.athlete.uid], prescriptionExerciseIds: ['some-other-pid'] });
  const before = await snapshotAll(f); const out = await run(f);
  assert.deepEqual(await recs(f), [], JSON.stringify(out)); assert.deepEqual(await overlays(f), []); assert.equal(await snapshotAll(f), before);
  await setCanary(f, { enabled: true, clientIds: [f.athlete.uid], prescriptionExerciseIds: [PID] });
  await run(f); assert.equal((await overlays(f)).length, 1, 'authorized athlete + PID processes normally');
});

test('CANARY boundary: disabling the canary between the pending read and the apply transaction rejects the operation', { timeout: 60000 }, async () => {
  const f = await fixture(); await run(f, { numericApplyEnabled: false });
  assert.equal((await recs(f))[0].state, 'PENDING');
  let txCount = 0;
  const racing = Object.create(db);
  racing.collection = n => db.collection(n);
  racing.runTransaction = async fn => { txCount++; await setCanary(f, { enabled: false, clientIds: [f.athlete.uid] }); return db.runTransaction(fn); };
  const out = await executor.applyPending(racing, f.athlete.uid, f.planId, () => '2026-09-28T00:00:00.000Z');
  assert.ok(txCount >= 1); assert.deepEqual(out.map(x => x.written), [false]); assert.equal(out[0].reason, 'OUT_OF_CANARY_SCOPE');
  assert.deepEqual(await overlays(f), []); assert.equal((await recs(f))[0].state, 'PENDING');
});

test('E08 causal safety: identical evidence applies; adding ONLY a pain report blocks the increase with the exact SAFETY code; SRA stays NONE', { timeout: 60000 }, async () => {
  const clean = await fixture(); const a = await run(clean);
  assert.deepEqual(a.applied.map(x => x.written), [true]);
  const [applied] = await recs(clean); assert.equal(applied.sraTrace.mutation, 'NONE');
  const pain = await fixture();
  const entries = Object.assign({}, pain.logs, { postsession_1_2: { articular: 'si', patron: 'press', eimd: 1, sleep: 8, rpe: 7 } });
  assert.deepEqual(Object.keys(entries).filter(k => !(k in pain.logs)), ['postsession_1_2'], 'the ONLY difference is the pain report');
  await db.doc('logs/' + pain.athlete.uid + '/mesos/' + pain.planId).set({ planId: pain.planId, entries });
  await db.doc('logs/' + pain.athlete.uid).set({ planId: pain.planId, entries });
  const b = await run(pain);
  assert.deepEqual(await overlays(pain), [], JSON.stringify(b));
  const codes = b.applied.map(x => x.reason);
  assert.ok(codes.length === 0 || codes.every(c => /SAFETY_CONFLICT|NOT_ELIGIBLE/.test(c)), JSON.stringify(codes));
  console.log('E08 blocking codes:', JSON.stringify(codes), 'records:', JSON.stringify((await recs(pain)).map(r => [r.state, r.reasonCode, r.magnitude && r.magnitude.reasonCodes])));
  // an informational SRA trace is never presented as an operative veto
  const t = (await recs(clean))[0].sraTrace;
  assert.equal(t.mutation, 'NONE'); assert.ok(!('veto' in t) && !('blocked' in t), 'SRA trace carries no veto field');
});

test('E06 real failed save: a denied athlete write persists nothing; the executor ignores it; the successful retry yields ONE operation', { timeout: 90000 }, async () => {
  const f = await fixture();
  await db.doc('logs/' + f.athlete.uid + '/mesos/' + f.planId).set({ planId: f.planId, entries: {} });
  await db.doc('logs/' + f.athlete.uid).set({ planId: f.planId, entries: {} });
  const foreign = await signedIn();
  // 1) the save is DENIED (athlete writing into someone else's log): the write is not confirmed
  await assert.rejects(() => setDoc(doc(foreign.db, 'logs', f.athlete.uid, 'mesos', f.planId), { planId: f.planId, entries: f.logs }, { merge: true }), /PERMISSION_DENIED|permission/i);
  const out1 = await run(f);
  assert.deepEqual(await recs(f), [], JSON.stringify(out1)); assert.deepEqual(await overlays(f), []);
  assert.deepEqual(Object.keys((await meso(f)).entries), [], 'no local data became evidence');
  // 2) the retry by the legitimate athlete succeeds (twice: duplicate retry)
  for (let i = 0; i < 2; i++) {
    await setDoc(doc(f.athlete.db, 'logs', f.athlete.uid, 'mesos', f.planId), { planId: f.planId, entries: f.logs }, { merge: true });
    await setDoc(doc(f.athlete.db, 'logs', f.athlete.uid), { planId: f.planId, entries: f.logs }, { merge: true });
    await run(f);
  }
  assert.equal((await recs(f)).length, 1); assert.equal((await overlays(f)).length, 1);
  assert.equal((await recs(f))[0].events.filter(e => e.state === 'APPLIED').length, 1);
  assert.equal(Object.keys((await meso(f)).entries).filter(k => k.startsWith('log_')).length, 6, 'no duplicated series');
});

test('CLIENT forgery: the athlete cannot create/flip APPLIED records or overlays by any write shape (set, update, dotted paths, root summary)', { timeout: 60000 }, async () => {
  const f = await fixture(); await run(f); // a legitimate APPLIED pair exists
  const [r] = await recs(f), [o] = await overlays(f), mesoRef = doc(f.athlete.db, 'logs', f.athlete.uid, 'mesos', f.planId);
  let _n = 0; const denied = p => assert.rejects(p, /PERMISSION_DENIED|permission/i, 'write shape #' + (++_n));
  await denied(updateDoc(mesoRef, { ['progressionApplications.' + r.key + '.state']: 'CONSUMED' }));
  await denied(updateDoc(mesoRef, { ['nextExposureOverlays.' + o.key + '.appliedValue']: 99 }));
  await denied(updateDoc(mesoRef, { ['nextExposureOverlays.forged']: Object.assign({}, o, { key: 'forged' }) }));
  await denied(setDoc(doc(f.athlete.db, 'logs', f.athlete.uid), { progressionApplicationSummary: { counts: { APPLIED: 9 } } }, { merge: true }));
  await denied(updateDoc(doc(f.athlete.db, 'clients', f.athlete.uid), { coachInterventions: [{ id: 'forged', targetType: 'EXERCISE', targetId: PID, action: 'NO_CHANGE', decidedAt: '2026-09-29T00:00:00.000Z' }] }));
  assert.equal((await overlays(f))[0].appliedValue, o.appliedValue, 'canonical overlay unchanged');
});

test('LOAD (T582): verified equipment, when present, gives the machine-exact load; without it LOAD is an advisory target; REPS stays independent', { timeout: 90000 }, async () => {
  const DB_EX = 'legacy-remo-mancuerna-unilateral';
  const SYNTH = { shared: { 'functional-dumbbells': { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} };
  const withCfg = await fixture({ rirTarget: 2, exerciseId: DB_EX, equipmentIncrements: SYNTH });
  const noCfg = await fixture({ rirTarget: 2, exerciseId: DB_EX });
  const a = await run(withCfg), b = await run(noCfg);
  assert.deepEqual(a.applied.map(x => [x.written, x.blocked]), [[true, null]], JSON.stringify(a.applied));
  const [o] = await overlays(withCfg); assert.equal(o.dimension, 'LOAD'); assert.equal(o.unit, 'KG'); assert.ok(o.appliedValue % 2.5 === 0, 'a realizable multiple of the configured step: ' + o.appliedValue);
  assert.deepEqual(b.applied.map(x => [x.written, x.blocked]), [[true, null]], 'no equipment data no longer blocks LOAD');
  const [ob] = await overlays(noCfg); assert.equal(ob.dimension, 'LOAD'); assert.equal(ob.equipmentId, null); assert.equal(ob.equipmentSnapshot.source, 'ADVISORY_GENERIC');
  const reps = await fixture(); const c = await run(reps);
  assert.deepEqual(c.applied.map(x => [x.written, x.blocked]), [[true, null]], 'REPS is not paralysed by missing equipment data');
});

// ---- T571 -----------------------------------------------------------------------------------------------------------------------------
const C = require('../assets/progression-application-consumer.js');
const { runTransaction } = require('firebase/firestore');
const closed = async (f, label) => {
  const before = await snapshotAll(f); const out = await run(f);
  assert.ok(['OUT_OF_ALLOWLIST'].includes(out.status), label + ' ' + JSON.stringify(out)); assert.deepEqual(out.applied, []);
  assert.equal(await snapshotAll(f), before, label + ': zero canonical writes');
};

test('ALLOWLIST second fence: absent / empty / disabled / malformed / wildcard / oversized / unlisted => zero writes, even with the Coach canary open', { timeout: 120000 }, async () => {
  const f = await fixture({ noRelease: true });                               // Coach canary enabled for this athlete, release allowlist ABSENT
  await db.doc('releaseControl/autonomousProgression').delete().catch(() => {});
  await closed(f, 'absent');
  const bad = [[[], 'empty'], [[f.athlete.uid, 5], 'non-string entry'], [['*'], 'wildcard'], [Array.from({ length: 11 }, (_, i) => 'u' + i).concat(f.athlete.uid), 'oversized'], [['someone-else'], 'unlisted']];
  for (const [ids, label] of bad) { await setRelease(ids); await closed(f, label); }
  await setRelease([f.athlete.uid], { enabled: false }); await closed(f, 'disabled');
  await setRelease([f.athlete.uid], { schema: 'wrong' }); await closed(f, 'wrong schema');
  await db.doc('releaseControl/autonomousProgression').set({ clientIds: 'not-an-array', enabled: true, schema: 'vdsen-autonomous-release-v1' }); await closed(f, 'not an array');
  await setRelease([f.athlete.uid]);                                          // only now both fences are open
  assert.equal((await run(f)).status, 'MATERIALIZED');
});

test('ALLOWLIST: the Coach cannot widen production scope from their own document or by writing the release doc', { timeout: 60000 }, async () => {
  const f = await fixture({ noRelease: true }); await setRelease(['somebody-else']);
  await assert.rejects(() => setDoc(doc(f.coach.db, 'releaseControl', 'autonomousProgression'), { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [f.athlete.uid] }), /PERMISSION_DENIED|permission/i);
  await assert.rejects(() => setDoc(doc(f.athlete.db, 'releaseControl', 'autonomousProgression'), { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [f.athlete.uid] }), /PERMISSION_DENIED|permission/i);
  await closed(f, 'coach canary alone');
});

test('ALLOWLIST: revocation between the pending read and the apply transaction rejects the operation', { timeout: 90000 }, async () => {
  const f = await fixture(); await run(f, { numericApplyEnabled: false });
  const racing = Object.create(db); racing.collection = n => db.collection(n);
  racing.runTransaction = async fn => { await setRelease(['revoked']); return db.runTransaction(fn); };
  const out = await executor.applyPending(racing, f.athlete.uid, f.planId, () => '2026-09-28T00:00:00.000Z');
  assert.deepEqual(out.map(x => [x.written, x.reason]), [[false, 'OUT_OF_ALLOWLIST']]); assert.deepEqual(await overlays(f), []);
});

test('CONCURRENCY: two simultaneous POSTs, and a cron sweep racing a POST, yield exactly one application', { timeout: 120000 }, async () => {
  const f = await fixture();
  await Promise.all([run(f), run(f)]);
  assert.equal((await overlays(f)).length, 1);
  const g = await fixture();
  await Promise.all([run(g), sweep.runSweep({ db, enabled: true, numericApplyEnabled: true, clock: () => new Date().toISOString() })]);
  const rs = await recs(g); assert.equal(rs.length, 1); assert.equal((await overlays(g)).length, 1);
  assert.equal(rs[0].events.filter(e => e.state === 'APPLIED').length, 1);
});

test('IDENTITY: invalid tokens/uids and a uid without a client never write', { timeout: 60000 }, async () => {
  const f = await fixture(); const before = await snapshotAll(f);
  const mk = uid => trigger.makeHandler({ db, enabled: true, numericApplyEnabled: true, verifyIdToken: async () => { if (uid === 'THROW') throw new Error('x'); return { uid }; } });
  const res = () => ({ statusCode: 0, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });
  for (const [uid, code] of [['THROW', 401], [undefined, 400], ['', 400], [null, 400]]) { const r = res(); await mk(uid)({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { planId: f.planId } }, r); assert.equal(r.statusCode, code, String(uid)); }
  let r = res(); await mk('ghost-uid-without-client')({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { planId: f.planId } }, r); assert.equal(r.body.status, 'PLAN_MISMATCH');
  r = res(); await mk(f.athlete.uid)({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { planId: 12345 } }, r); assert.equal(r.statusCode, 400);
  assert.equal(await snapshotAll(f), before);
});

const startTarget = async (f, reps) => {                                        // the athlete persists the FIRST working set of the target exposure
  const t = (await overlays(f))[0].target, entries = {};
  entries['log_' + t.week + '_' + t.dayIndex + '_0_s0'] = { done: true, carga: '100', reps: String(reps || 11), unit: 'KG', rir: 1, rir_real: 2, prescriptionExerciseId: PID, ts: T0 + 9e6 };
  await setDoc(doc(f.athlete.db, 'logs', f.athlete.uid, 'mesos', f.planId), { planId: f.planId, entries }, { merge: true });
  await setDoc(doc(f.athlete.db, 'logs', f.athlete.uid), { planId: f.planId, entries }, { merge: true });
};
const ackReceipt = async (f) => {                                               // exactly what the client does (real consumer module, real rules)
  const [r] = await recs(f), [o] = await overlays(f);
  return runTransaction(f.athlete.db, tx => C.recordConsumptionReceiptTransaction(tx, { meso: doc(f.athlete.db, 'logs', f.athlete.uid, 'mesos', f.planId), root: doc(f.athlete.db, 'logs', f.athlete.uid) },
    { recordKey: r.key, clientId: f.athlete.uid, now: new Date().toISOString(), shown: { provenance: 'CANONICAL_OVERLAY', overlayKey: o.key, dimension: o.dimension, appliedValue: o.appliedValue } },
    { isCurrent: () => true, canonicalOverlayRead: true }));
};

test('CONSUMED: APPLIED -> first persisted working set -> athlete receipt -> SERVER transition; no Monitor, idempotent, prescription never rewritten', { timeout: 120000 }, async () => {
  const f = await fixture(); await run(f);
  const [applied] = await overlays(f); assert.equal(applied.status, 'APPLIED');
  const early = await ackReceipt(f);
  assert.equal(early.written, false); assert.equal(early.reason, 'TARGET_NOT_STARTED', 'no receipt before the exposure started');
  await startTarget(f);
  const ack = await ackReceipt(f); assert.equal(ack.written, true, JSON.stringify(ack));
  assert.equal((await recs(f))[0].state, 'APPLIED', 'a receipt alone changes nothing canonical');
  const out = await run(f); assert.deepEqual(out.consumed.map(x => [x.written, x.reason]), [[true, null]], JSON.stringify(out.consumed));
  await run(f); await Promise.all([run(f), run(f)]);
  const [r] = await recs(f), [o] = await overlays(f);
  assert.equal(r.state, 'CONSUMED'); assert.equal(o.status, 'CONSUMED');
  assert.equal(r.events.filter(e => e.state === 'CONSUMED').length, 1); assert.equal(r.events.filter(e => e.state === 'APPLIED').length, 1);
  assert.equal(o.appliedValue, applied.appliedValue, 'prescription unchanged'); assert.equal(o.previousValue, applied.previousValue);
  const m = await meso(f), plan = (await db.doc('plans/' + f.planId).get()).data();
  const eff = F.on.effective.resolveEffective({ clientId: f.athlete.uid, planId: f.planId, activePlanId: f.planId, pid: PID, week: o.target.week, dayIndex: o.target.dayIndex,
    records: m.progressionApplications, overlays: m.nextExposureOverlays, interventions: [], plan, entries: m.entries, baseSets: F.baseSets() });
  assert.equal(eff.provenance, 'CANONICAL_OVERLAY', 'the started exposure keeps the prescription it started with');
  assert.equal(Object.values(m.entries).filter(e => e.reps === '11').length, 1, 'executed value recorded independently of the overlay');
});

test('CONSUMED: a forged/mismatched receipt or a receipt without persisted execution never consumes', { timeout: 90000 }, async () => {
  const f = await fixture(); await run(f); const [r] = await recs(f), [o] = await overlays(f);
  const forged = { recordKey: r.key, overlayKey: o.key, dimension: o.dimension, appliedValue: o.appliedValue + 3, provenance: 'CANONICAL_OVERLAY', ackAt: new Date().toISOString() };
  await updateDoc(doc(f.athlete.db, 'logs', f.athlete.uid, 'mesos', f.planId), { ['consumptionReceipts.' + r.key]: forged });   // the athlete may write receipts (and only receipts)
  let out = await run(f); assert.deepEqual(out.consumed.map(x => [x.written, x.reason]), [[false, 'TARGET_NOT_STARTED']], 'receipt without persisted execution');
  await startTarget(f); out = await run(f);
  assert.deepEqual(out.consumed.map(x => [x.written, x.reason]), [[false, 'RECEIPT_MISMATCH']]); assert.equal((await recs(f))[0].state, 'APPLIED');
});

test('CONSUMED is fenced like every canonical write: revoked allowlist / closed canary / out-of-scope PID => no transition', { timeout: 120000 }, async () => {
  for (const mode of ['allowlist', 'canary', 'pid']) {
    const f = await fixture(); await run(f); await startTarget(f); await ackReceipt(f);
    if (mode === 'allowlist') await setRelease(['revoked']);
    if (mode === 'canary') await setCanary(f, { enabled: false, clientIds: [f.athlete.uid] });
    if (mode === 'pid') await setCanary(f, { enabled: true, clientIds: [f.athlete.uid], prescriptionExerciseIds: ['other'] });
    const out = await executor.consumePending(db, f.athlete.uid, f.planId, () => '2026-09-28T00:00:00.000Z');
    assert.ok(out.every(x => x.written === false), mode);
    assert.equal((await recs(f))[0].state, 'APPLIED', mode);
  }
});

test('REST (Regla C) applies automatically', { timeout: 90000 }, async () => {
  const f = await fixture({ restScenario: true }); const out = await run(f);
  const dims = (await overlays(f)).map(o => o.dimension);
  console.log('REST scenario ->', JSON.stringify({ status: out.status, applied: out.applied, dims }));
  assert.deepEqual(dims, ['REST']);
});
