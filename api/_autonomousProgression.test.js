'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const executor = require('./_autonomousProgression');
const trigger = require('./autonomous-progression-trigger');

function fakeDb(seed) {
  const docs = new Map(Object.entries(seed || {}));
  const ref = path => ({ path, collection: name => ref(path + '/' + name), doc: id => ref(path + '/' + id) });
  const snapshot = r => ({ exists: docs.has(r.path), data: () => structuredClone(docs.get(r.path)) });
  const tx = { get: async r => snapshot(r), set: (r, value) => docs.set(r.path, Object.assign({}, docs.get(r.path) || {}, structuredClone(value))) };
  return { docs, collection: name => ref(name), runTransaction: async fn => fn(tx) };
}
function seed() {
  const pid = 'pid-1', planId = 'plan-1', uid = 'athlete-1';
  const logs = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { logs['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: pid, ts: 1 + s }; }));
  logs.progrec_1_2 = { calculatedAt: '2026-01-02T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: pid, exerciseId: 'ex-1', exerciseName: 'Press', action: 'increase_reps', newReps: 11 }] };
  return { uid, planId, docs: {
    ['clients/' + uid]: { activePlanId: planId, coachId: 'coach-1' },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: new Date(Date.now() + 36e5).toISOString(), clientIds: [uid] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: { clientId: uid, weeks: 3, updatedAt: '2026-01-01T00:00:00.000Z', days: [0, 2].map(dayIndex => ({ dayIndex, exercises: [{ prescriptionExerciseId: pid, exerciseId: 'ex-1', exerciseName: 'Press', sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) },
    ['logs/' + uid]: { planId, entries: logs, updatedAt: 2 },
    ['logs/' + uid + '/mesos/' + planId]: { planId, entries: logs, updatedAt: 2 }
  }};
}
test('T570-R trusted executor is disarmed by default and does not read or write', async () => {
  const s = seed(), db = fakeDb(s.docs), before = structuredClone([...db.docs]);
  const out = await executor.processProgression({ db, clientId: s.uid, planId: s.planId });
  assert.deepEqual(out, { status: 'DISARMED', writes: 0 });
  assert.deepEqual([...db.docs], before);
});
test('T570-R materializes only from server-re-read athlete evidence and rejects a foreign plan assertion', async () => {
  const s = seed(), db = fakeDb(s.docs);
  const wrong = await executor.processProgression({ db, clientId: s.uid, planId: 'other', enabled: true });
  assert.equal(wrong.status, 'PLAN_MISMATCH');
  const out = await executor.processProgression({ db, clientId: s.uid, planId: s.planId, enabled: true, clock: () => '2026-01-03T00:00:00.000Z' });
  assert.equal(out.status, 'MATERIALIZED');
  const meso = db.docs.get('logs/' + s.uid + '/mesos/' + s.planId);
  assert.equal(Object.keys(meso.progressionApplications).length, 1);
  assert.equal(Object.values(meso.progressionApplications)[0].sraTrace.mutation, 'NONE', 'SRA is persisted as read-only trace only');
  assert.deepEqual(meso.entries, s.docs['logs/' + s.uid + '/mesos/' + s.planId].entries, 'executor never rewrites execution evidence');
  assert.equal(db.docs.get('plans/' + s.planId).updatedAt, '2026-01-01T00:00:00.000Z', 'executor never edits plan');
});
test('T570-R trigger authenticates the athlete token and never accepts body client identity', async () => {
  const s = seed(), db = fakeDb(s.docs), calls = [];
  const handler = trigger.makeHandler({ db, enabled: false, verifyIdToken: async token => { calls.push(token); return { uid: s.uid }; } });
  const response = { statusCode: 0, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
  await handler({ method: 'POST', headers: { authorization: 'Bearer verified-token' }, body: { planId: s.planId, clientId: 'other' } }, response);
  assert.equal(response.statusCode, 202); assert.equal(response.body.status, 'DISARMED'); assert.deepEqual(calls, ['verified-token']);
});
test('T570-R cron GET on the single function requires CRON_SECRET and is disarmed by default', async () => {
  const handler = trigger.makeHandler({ db: fakeDb({}), enabled: false, cronSecret: 's3cret', verifyIdToken: async () => { throw new Error('unused'); } });
  const res = () => ({ statusCode: 0, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });
  let r = res(); await handler({ method: 'GET', headers: {} }, r); assert.equal(r.statusCode, 401);
  r = res(); await handler({ method: 'GET', headers: { authorization: 'Bearer wrong!' } }, r); assert.equal(r.statusCode, 401);
  r = res(); await handler({ method: 'GET', headers: { authorization: 'Bearer s3cret' } }, r); assert.equal(r.statusCode, 202);
});
test('T570-R no canary document => OUT_OF_CANARY and zero writes (fake db)', async () => {
  const s = seed(); delete s.docs['coaches/coach-1']; const db = fakeDb(s.docs), before = structuredClone([...db.docs]);
  const out = await executor.processProgression({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true });
  assert.equal(out.status, 'OUT_OF_CANARY'); assert.deepEqual([...db.docs], before);
});

test('T571 no release allowlist document => OUT_OF_ALLOWLIST and zero writes even with an open Coach canary (fake db)', async () => {
  const s = seed(); delete s.docs['releaseControl/autonomousProgression']; const db = fakeDb(s.docs), before = structuredClone([...db.docs]);
  const out = await executor.processProgression({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true });
  assert.equal(out.status, 'OUT_OF_ALLOWLIST'); assert.deepEqual([...db.docs], before);
});
test('T571 default handler without Firebase Admin configuration fails closed with 503 (no function crash)', async () => {
  const saved = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].map(k => [k, process.env[k]]);
  saved.forEach(([k]) => delete process.env[k]);
  try {
    const res = { statusCode: 0, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
    await trigger({ method: 'GET', headers: {} }, res);
    assert.deepEqual([res.statusCode, res.body], [503, { error: 'RUNTIME_NOT_CONFIGURED' }]);
  } finally { saved.forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; }); }
});
