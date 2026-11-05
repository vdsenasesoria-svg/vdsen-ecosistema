'use strict';
// All data below is synthetic; the exact identifiers exercise the real production contract in a demo project only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const C = require('../api/_numericPilotContract');
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription');
const F = require('./helpers/lifecycle-fixture');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'emulator required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = initializeApp({ projectId }, 't699-real-contract');
const db = getFirestore(app);
test.after(() => deleteApp(app));

test('real contract in emulator: pending -> applied overlay -> effective prescription', async () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const coach = 'synthetic-coach-t699';
  const t = Math.floor(Date.now() / 1000) * 1000;
  const iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
  const window = { schema: 'vdsen-numeric-pilot-v1', mode: 'NUMERIC_APPLY', uid: C.UID, planId: C.PLAN, pid: C.PID,
    runtimeSha: 'a'.repeat(40), operationId: 'synthetic-emulator-699', startsAt: iso(t - 1000), expiresAt: iso(t + 3600000) };
  const env = { AUTONOMOUS_PROGRESSION_ENABLED: 'true', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true', VDSEN_NUMERIC_PILOT_RUNTIME_SHA: window.runtimeSha, VDSEN_NUMERIC_PILOT_WINDOW: JSON.stringify(window) };
  const keys = [...Object.keys(env), 'CRON_SECRET'];
  const previous = keys.map(k => [k, process.env[k]]);
  try {
    Object.assign(process.env, env); delete process.env.CRON_SECRET;
    await db.doc('clients/' + C.UID).set({ activePlanId: C.PLAN, coachId: coach });
    await db.doc('coaches/' + coach).set({ autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] } });
    await db.doc('plans/' + C.PLAN).set(sc.plan);
    await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [C.UID], expiresAt: window.expiresAt });
    await db.doc('releaseControl/numericPilot').set({ ...window, enabled: true });
    await db.doc('logs/' + C.UID).set({ planId: C.PLAN, entries: sc.entries });
    const meso = db.doc('logs/' + C.UID + '/mesos/' + C.PLAN);
    await meso.set({ planId: C.PLAN, entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec }, nextExposureOverlays: {} });
    const base = (await db.doc('plans/' + C.PLAN).get()).data();
    const result = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(result.length, 1); assert.equal(result[0].written, true, JSON.stringify(result));
    const m = (await meso.get()).data();
    assert.equal(m.progressionApplications[sc.rec.key].state, 'APPLIED');
    const overlays = Object.values(m.nextExposureOverlays);
    assert.equal(overlays.length, 1); assert.equal(overlays[0].status, 'APPLIED');
    const resolved = effective.resolveEffective({ clientId: C.UID, planId: C.PLAN, activePlanId: C.PLAN, pid: C.PID,
      week: overlays[0].target.week, dayIndex: overlays[0].target.dayIndex, records: m.progressionApplications,
      overlays: m.nextExposureOverlays, interventions: [], plan: base, entries: sc.entries, baseSets: F.baseSets(), canonicalOverlayRead: true });
    assert.equal(resolved.provenance, 'CANONICAL_OVERLAY');
    assert.deepEqual((await db.doc('plans/' + C.PLAN).get()).data(), base);
    assert.deepEqual(await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString()), []);
    // Reset only synthetic emulator data to test concurrent application of one pending decision.
    const pending = { planId: C.PLAN, entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec }, nextExposureOverlays: {} };
    await meso.set(pending);
    const simultaneous = await Promise.all(Array.from({ length: 3 }, () => executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString())));
    assert.equal(simultaneous.flat().filter(r => r.written).length, 1);
    const concurrentResult = (await meso.get()).data();
    assert.equal(concurrentResult.progressionApplications[sc.rec.key].state, 'APPLIED');
    assert.equal(Object.keys(concurrentResult.nextExposureOverlays).length, 1);
    await meso.set(pending);
    await db.doc('releaseControl/numericPilot').set({ enabled: false }, { merge: true });
    const stopped = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.ok(stopped.every(r => !r.written));
    const afterStop = (await meso.get()).data();
    assert.equal(afterStop.progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual(afterStop.nextExposureOverlays, {});
  } finally {
    previous.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
});
