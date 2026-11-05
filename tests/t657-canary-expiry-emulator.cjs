// T657: the release fence EXPIRES. The authoritative executor compares releaseControl/autonomousProgression.expiresAt with its own clock inside every
// transaction (materialize / apply / consume) - no CRON involved. Absent / malformed / expired / too-far-ahead => closed with zero writes of any kind.
// Canary documents are produced by the operational tool's own planWrites() so what is tested is what the operator would write. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
const executor = require('../api/_autonomousProgression.js');
const canaryTool = require('../scripts/pilot/ayrton-canary.cjs');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't657-admin');
const db = getAdminFirestore(adminApp);
const PID = 'pid-1', T0 = Date.parse('2026-09-27T12:00:00.000Z');
test.after(async () => { await deleteAdmin(adminApp); });

function evidence() {
  const logs = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { logs['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 1, rir_real: 3, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }; }));
  logs.progrec_1_2 = { calculatedAt: '2026-09-27T12:00:00.000Z', recommendations: [{ prescriptionExerciseId: PID, exerciseId: 'ex-1', exerciseName: 'Press', action: 'increase_reps', newReps: 11 }] };
  return logs;
}
const planDoc = (uid, coachId) => ({ clientId: uid, coachId, status: 'active', weeks: 3, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
  days: [0, 2].map(dayIndex => ({ dayIndex, exercises: [{ prescriptionExerciseId: PID, exerciseId: 'ex-1', exerciseName: 'Press', repsRange: { min: 8, max: 12 }, sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: 1, restSeconds: 90 })) }] })) });
const newUid = p => p + randomUUID().replace(/-/g, '').slice(0, 28);
async function client(coachId, uid) {
  const planId = 'plan-' + uid, logs = evidence();
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: [] });
  await db.doc('plans/' + planId).set(planDoc(uid, coachId));
  await db.doc('logs/' + uid).set({ planId, entries: logs });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { uid, planId };
}
async function applyTool(mode, uid, coachId, opts) {
  const rel = (await db.doc(canaryTool.RELEASE_PATH).get()).data() || null, coach = (await db.doc('coaches/' + coachId).get()).data() || {};
  const { writes, refusals } = canaryTool.planWrites(mode, uid, { release: rel, coach, coachId }, opts);
  for (const w of writes) await db.doc(w.path).set(w.fields, { merge: true });
  return { writes, refusals };
}
const T_NOW = Date.parse('2026-11-01T10:00:00.000Z');
const at = ms => () => new Date(ms).toISOString();
const run = (c, o) => executor.processProgression(Object.assign({ db, clientId: c.uid, planId: c.planId, enabled: true, numericApplyEnabled: true, clock: at(T_NOW) }, o || {}));
const meso = async c => (await db.doc('logs/' + c.uid + '/mesos/' + c.planId).get()).data();
const snapshot = async c => JSON.stringify([await meso(c), (await db.doc('logs/' + c.uid).get()).data(), (await db.doc('clients/' + c.uid).get()).data(), (await db.doc('plans/' + c.planId).get()).data()]);
const recs = async c => Object.values((await meso(c)).progressionApplications || {});
const ovls = async c => Object.values((await meso(c)).nextExposureOverlays || {});
async function arm(c, coachId, relPatch) {
  await db.doc(canaryTool.RELEASE_PATH).delete().catch(() => {});
  await db.doc('coaches/' + coachId).set({ role: 'coach', autoApplyCanary: { enabled: true, clientIds: [c.uid], prescriptionExerciseIds: [] } });
  const doc = Object.assign({ schema: canaryTool.RELEASE_SCHEMA, enabled: true, clientIds: [c.uid], expiresAt: new Date(T_NOW + 3600e3).toISOString() }, relPatch || {});
  if (doc.expiresAt === undefined) delete doc.expiresAt;   // 'absent' case
  await db.doc(canaryTool.RELEASE_PATH).set(doc);
}
async function fresh() { const coachId = 'coach-' + newUid(''), c = await client(coachId, newUid('A')); await db.doc('coaches/' + coachId).set({ role: 'coach' }); return { coachId, c }; }

test('T657.1 the operational tool writes an expiry; the athlete applies once while the fence is valid', async () => {
  const { coachId, c } = await fresh();
  await db.doc(canaryTool.RELEASE_PATH).delete().catch(() => {});
  await applyTool('enable', c.uid, coachId, { now: new Date(T_NOW), ttlHours: 2 });
  const rel = (await db.doc(canaryTool.RELEASE_PATH).get()).data();
  assert.equal(rel.expiresAt, '2026-11-01T12:00:00Z'); assert.deepEqual(rel.clientIds, [c.uid]);
  const out = await run(c);
  assert.deepEqual(out.applied.map(x => x.written), [true], JSON.stringify(out));
  assert.equal((await ovls(c)).length, 1);
});

test('T657.2 absent / malformed / past / equal-to-now / too-far-ahead expiresAt => closed, zero writes of any kind', async () => {
  const cases = [
    ['absent', undefined], ['null', null], ['number', T_NOW + 3600e3], ['date only', '2026-11-02'], ['not a date', 'mañana'], ['impossible date', '2026-13-45T10:00:00Z'],
    ['offset instead of Z', '2026-11-02T10:00:00+01:00'], ['space separator', '2026-11-02 10:00:00Z'], ['past', '2026-10-31T10:00:00Z'], ['equal to now', '2026-11-01T10:00:00Z'],
    ['32 days ahead', '2026-12-03T10:00:01Z'], ['year 2099', '2099-01-01T00:00:00Z'], ['empty string', ''], ['object', { seconds: 1 }]];
  for (const [label, value] of cases) {
    const { coachId, c } = await fresh();
    await arm(c, coachId, { expiresAt: value });
    const before = await snapshot(c);
    const out = await run(c);
    assert.equal(out.status, 'OUT_OF_ALLOWLIST', label + ' ' + JSON.stringify(out)); assert.deepEqual(out.applied, [], label);
    assert.equal(await snapshot(c), before, label + ': byte-identical documents');
  }
  // boundary controls: the shortest and longest valid windows are open
  for (const [label, value] of [['1 s ahead', '2026-11-01T10:00:01Z'], ['exactly 31 days', '2026-12-02T10:00:00Z'], ['with millis', '2026-11-01T10:30:00.123Z']]) {
    const { coachId, c } = await fresh(); await arm(c, coachId, { expiresAt: value });
    assert.deepEqual((await run(c)).applied.map(x => x.written), [true], label);
  }
});

test('T657.3 the executor clock decides: the same fence is open before expiry and closed at/after it (no CRON, nothing else required)', async () => {
  const { coachId, c } = await fresh(); await arm(c, coachId, { expiresAt: '2026-11-01T10:30:00Z' });
  const before = await snapshot(c);
  assert.equal((await run(c, { clock: at(Date.parse('2026-11-01T10:30:00Z')) })).status, 'OUT_OF_ALLOWLIST', 'at the instant of expiry');
  assert.equal((await run(c, { clock: at(Date.parse('2026-11-01T11:00:00Z')) })).status, 'OUT_OF_ALLOWLIST', 'after expiry');
  assert.equal(await snapshot(c), before);
  const ok = await run(c, { clock: at(Date.parse('2026-11-01T10:29:59Z')) });
  assert.deepEqual(ok.applied.map(x => x.written), [true]);
});

test('T657.4 expiry between materialize and apply: the PENDING record is never applied; an already APPLIED record is left unchanged and never consumed', async () => {
  const { coachId, c } = await fresh(); await arm(c, coachId, { expiresAt: '2026-11-01T10:30:00Z' });
  const mat = await run(c, { numericApplyEnabled: false });
  assert.equal(mat.status, 'MATERIALIZED'); assert.equal((await recs(c))[0].state, 'PENDING');
  const snap = await snapshot(c);
  const late = await run(c, { clock: at(Date.parse('2026-11-01T11:00:00Z')) });
  assert.equal(late.status, 'OUT_OF_ALLOWLIST'); assert.equal(await snapshot(c), snap); assert.equal((await ovls(c)).length, 0);
  // direct calls to the lower-level entry points are fenced as well (not only processProgression)
  const direct = await executor.applyPending(db, c.uid, c.planId, at(Date.parse('2026-11-01T11:00:00Z')));
  assert.deepEqual(direct.map(x => [x.written, x.reason]), [[false, 'OUT_OF_ALLOWLIST']]); assert.equal(await snapshot(c), snap);
  // apply while valid, then expire: the APPLIED record and its overlay stay exactly as they were
  const ok = await run(c); assert.deepEqual(ok.applied.map(x => x.written), [true]);
  const applied = await snapshot(c);
  const after = await executor.consumePending(db, c.uid, c.planId, at(Date.parse('2026-11-01T11:00:00Z')));
  assert.deepEqual(after, []); assert.equal(await snapshot(c), applied, 'expiry never rewrites or reverts an applied prescription');
  assert.equal((await recs(c))[0].events.filter(e => e.state === 'APPLIED').length, 1);
});

test('T657.5 stop through the tool expires the fence immediately and revokes both barriers; a later enable re-opens with a fresh window', async () => {
  const { coachId, c } = await fresh();
  await db.doc(canaryTool.RELEASE_PATH).delete().catch(() => {});
  await applyTool('enable', c.uid, coachId, { now: new Date(T_NOW), ttlHours: 24 });
  await run(c, { numericApplyEnabled: false });
  await applyTool('stop', c.uid, coachId, { now: new Date(T_NOW) });
  const rel = (await db.doc(canaryTool.RELEASE_PATH).get()).data();
  assert.equal(rel.enabled, false); assert.equal(rel.expiresAt, '2026-11-01T10:00:00Z');
  const snap = await snapshot(c);
  assert.equal((await run(c)).status, 'OUT_OF_ALLOWLIST'); assert.equal(await snapshot(c), snap);
  await applyTool('enable', c.uid, coachId, { now: new Date(T_NOW), ttlHours: 1 });
  assert.deepEqual((await run(c)).applied.map(x => x.written), [true]);
});

test('T657.6 concurrency around the expiry: 8 simultaneous callers after expiry write nothing; 8 before expiry produce exactly one application', async () => {
  const { coachId, c } = await fresh(); await arm(c, coachId, { expiresAt: '2026-11-01T10:30:00Z' });
  const snap = await snapshot(c);
  const late = await Promise.all(Array.from({ length: 8 }, () => run(c, { clock: at(Date.parse('2026-11-01T10:31:00Z')) })));
  assert.ok(late.every(o => o.status === 'OUT_OF_ALLOWLIST' && o.applied.length === 0), JSON.stringify(late.map(o => o.status)));
  assert.equal(await snapshot(c), snap);
  const early = await Promise.allSettled(Array.from({ length: 8 }, () => run(c)));
  const done = early.filter(r => r.status === 'fulfilled').map(r => r.value);
  assert.ok(done.length >= 1, 'at least one caller completes: ' + JSON.stringify(early.filter(r => r.status === 'rejected').map(r => String(r.reason && r.reason.message))));
  assert.equal(done.reduce((n, o) => n + o.applied.filter(x => x.written).length, 0), 1, 'exactly one effective application');
  const recsNow = await recs(c); assert.equal(recsNow.length, 1); assert.equal(recsNow[0].events.filter(e => e.state === 'APPLIED').length, 1); assert.equal((await ovls(c)).length, 1);
});

test('T657.7 another client of the same coach is never reached, valid or expired fence', async () => {
  const { coachId, c } = await fresh(); const other = await client(coachId, newUid('B'));
  await arm(c, coachId, { expiresAt: '2026-11-01T10:30:00Z' });
  const beforeOther = await snapshot(other);
  assert.equal((await run(other)).status, 'OUT_OF_ALLOWLIST'); assert.equal(await snapshot(other), beforeOther);
  assert.deepEqual((await run(c)).applied.map(x => x.written), [true]);
  assert.equal((await run(other)).status, 'OUT_OF_ALLOWLIST'); assert.equal(await snapshot(other), beforeOther);
  assert.equal((await recs(other)).length, 0);
});

test('T657.8 static contract: the expiry check lives in the executor and does not depend on any cron/schedule code', () => {
  const src = require('node:fs').readFileSync(require.resolve('../api/_autonomousProgression.js'), 'utf8');
  assert.match(src, /_releaseUnexpired\(d\.expiresAt, _now\(clock\)\)/);
  assert.ok(!/cron/i.test(src.replace(/\/\/.*$/gm, '')), 'no cron dependency in the executor');
});
