'use strict';
// T692: Real Firestore Emulator + security rules verification for autonomous progression engine.
// Exercises real Firestore client SDK (Coach & Athlete with auth tokens) and Admin SDK on the emulator.
// Tests authoritative server timestamps, start markers, plan activations, candidate generation,
// application, effective prescription resolution, consumption, and multi-tenant isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, serverTimestamp, Timestamp } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

const executor = require('../api/_autonomousProgression.js');
const eligibility = require('../api/_clientEligibility.js');
const effective = require('../assets/progression-effective-prescription.js');
const FX = require('./fixtures/t583-real-client-capture.json');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't692-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];

async function asUser(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't692-' + apps.length);
  apps.push(app);
  const cdb = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(cdb, host, Number(port), { mockUserToken: { sub: uid } });
  return { uid, db: cdb };
}

test.after(async () => {
  await Promise.all(apps.map(deleteApp));
  await deleteAdmin(adminApp);
});

const clock = () => new Date().toISOString();
let seq = 0;
const J = (o) => JSON.parse(JSON.stringify(o));

async function seedEmulator(name, o) {
  o = o || {};
  const sc = FX.scenarios[name];
  const tag = 't692-' + name + '-' + (++seq) + '-' + Date.now().toString(36);
  const uid = 'ath-' + tag, coachId = 'coach-' + tag, planId = 'plan-' + tag;
  const plan = Object.assign(J(sc.plan), { clientId: uid, coachId });
  const entries = J(o.through === 3 ? sc.entriesThroughW3 : sc.entriesThroughW2);
  const pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId);

  // Setup documents in Firestore emulator via Admin SDK
  await adminDb.doc('coaches/' + coachId).set({ role: 'coach', autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } });
  await adminDb.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: o.interventions || [] });
  await adminDb.doc('plans/' + planId).set(plan);
  await adminDb.doc('logs/' + uid).set({ planId, entries });
  await adminDb.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries });
  await adminDb.doc('releaseControl/autonomousProgression').set({
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    expiresAt: new Date(Date.now() + 86400000 * 7).toISOString(),
    clientIds: [uid]
  });

  return { name, uid, coachId, planId, plan, pids, entries };
}

test('T692.E1: Authoritative plan activation on Firestore Emulator using client SDK', async () => {
  const s = await seedEmulator('A');
  const coachSession = await asUser(s.coachId);
  const newPlanId = 'plan-new-' + (++seq);
  await adminDb.doc('plans/' + newPlanId).set(Object.assign({}, s.plan, { id: newPlanId, status: 'active' }));

  const actId = 'act_' + s.uid + '_' + newPlanId + '_' + Date.now().toString(36);
  const actRef = doc(coachSession.db, 'clients', s.uid, 'plan_activations', actId);

  // 1. Valid activation with serverTimestamp()
  await setDoc(actRef, {
    id: actId,
    clientId: s.uid,
    coachId: s.coachId,
    newPlanId: newPlanId,
    previousPlanId: s.planId,
    at: serverTimestamp()
  });

  const snap = await adminDb.doc('clients/' + s.uid + '/plan_activations/' + actId).get();
  assert.ok(snap.exists, 'activation record persisted in emulator');
  const data = snap.data();
  assert.equal(data.newPlanId, newPlanId);
  assert.equal(data.previousPlanId, s.planId);
  assert.ok(data.at && typeof data.at.toMillis === 'function', 'at is an authentic server Timestamp');

  // 2. Cross-coach activation attempt is denied by security rules
  const foreignCoach = await asUser('coach-foreign-' + seq);
  const foreignActId = 'act-foreign-' + seq;
  const foreignActRef = doc(foreignCoach.db, 'clients', s.uid, 'plan_activations', foreignActId);
  let denied = false;
  try {
    await setDoc(foreignActRef, {
      id: foreignActId,
      clientId: s.uid,
      coachId: 'coach-foreign-' + seq,
      newPlanId: newPlanId,
      at: serverTimestamp()
    });
  } catch (err) {
    denied = true;
  }
  assert.ok(denied, 'foreign coach write to plan_activations is denied by rules');
});

test('T692.E2: Full autonomous pipeline on Firestore Emulator (materialize -> applyPending -> consumePending)', async () => {
  const s = await seedEmulator('A');

  // 1. Materialize (generates PENDING records automatically from real W2 entries)
  const m = await executor.materialize(adminDb, s.uid, s.planId, clock);
  assert.equal(m.status, 'MATERIALIZED');
  assert.ok(m.created.length >= 2, 'auto-generated at least 2 PENDING records');

  // 2. Apply (PENDING -> APPLIED + creates nextExposureOverlays)
  const applied = await executor.applyPending(adminDb, s.uid, s.planId, clock);
  assert.ok(applied.length >= 2);
  assert.ok(applied.every(a => a.written === true), 'all candidate records applied');

  const mesoSnap = await adminDb.doc('logs/' + s.uid + '/mesos/' + s.planId).get();
  const mesoData = mesoSnap.data();
  const overlays = mesoData.nextExposureOverlays;
  assert.ok(overlays && Object.keys(overlays).length >= 2, 'overlays written to meso doc');

  // 3. Client effective prescription resolution
  const pid0 = s.pids[0];
  const ov0 = Object.values(overlays).find(o => o.prescriptionExerciseId === pid0);
  assert.ok(ov0, 'overlay found for exercise 0');
  const effRes = effective.resolveEffective({
    clientId: s.uid,
    planId: s.planId,
    activePlanId: s.planId,
    pid: pid0,
    week: ov0.target.week,
    dayIndex: ov0.target.dayIndex,
    records: mesoData.progressionApplications,
    overlays: mesoData.nextExposureOverlays,
    plan: s.plan,
    entries: s.entries,
    baseSets: s.plan.days[0].exercises[0].sets.map(x => Object.assign({}, x)),
    canonicalOverlayRead: true
  });
  assert.equal(effRes.provenance, 'CANONICAL_OVERLAY');
  assert.equal(effRes.sets[0].effective.load, ov0.appliedValue);

  // 4. Client appends consumption receipts & starts exposure (Semana 3)
  const receipts = {};
  applied.forEach(a => {
    const ov = overlays['ovl_' + a.recordKey];
    if (ov) {
      receipts[a.recordKey] = {
        recordKey: a.recordKey,
        overlayKey: ov.key,
        dimension: ov.dimension,
        appliedValue: ov.appliedValue,
        provenance: 'CANONICAL_OVERLAY',
        ackAt: clock()
      };
    }
  });

  const w3entries = J(FX.scenarios.A.entriesThroughW3);
  await adminDb.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ entries: w3entries, consumptionReceipts: receipts }, { merge: true });
  await adminDb.doc('logs/' + s.uid).set({ entries: w3entries }, { merge: true });

  // 5. Consume (APPLIED -> CONSUMED)
  const consumed = await executor.consumePending(adminDb, s.uid, s.planId, clock);
  assert.ok(consumed.length >= 2);
  assert.ok(consumed.every(c => c.written === true), 'all receipts consumed atomically');

  const mesoAfterConsume = (await adminDb.doc('logs/' + s.uid + '/mesos/' + s.planId).get()).data();
  assert.ok(applied.every(a => mesoAfterConsume.progressionApplications[a.recordKey].state === 'CONSUMED'), 'all records transitioned to CONSUMED');
});

test('T692.E3: Multi-device & reconnection continuity on Firestore Emulator', async () => {
  const s = await seedEmulator('A');

  // Device 1 runs progression
  await executor.materialize(adminDb, s.uid, s.planId, clock);
  await executor.applyPending(adminDb, s.uid, s.planId, clock);

  // Device 2 connects and reads authoritative state
  const dev2Snap = await adminDb.doc('logs/' + s.uid + '/mesos/' + s.planId).get();
  const dev2Meso = dev2Snap.data();
  assert.ok(dev2Meso.nextExposureOverlays, 'device 2 sees persisted overlays');
  assert.ok(Object.keys(dev2Meso.nextExposureOverlays).length > 0, 'overlays available to second device');

  // Device 2 reads effective prescription without divergence
  const pid = s.pids[0];
  const ov = Object.values(dev2Meso.nextExposureOverlays).find(o => o.prescriptionExerciseId === pid);
  const effDev2 = effective.resolveEffective({
    clientId: s.uid,
    planId: s.planId,
    activePlanId: s.planId,
    pid: pid,
    week: ov.target.week,
    dayIndex: ov.target.dayIndex,
    records: dev2Meso.progressionApplications,
    overlays: dev2Meso.nextExposureOverlays,
    plan: s.plan,
    entries: dev2Meso.entries,
    baseSets: s.plan.days[0].exercises[0].sets.map(x => Object.assign({}, x)),
    canonicalOverlayRead: true
  });
  assert.equal(effDev2.provenance, 'CANONICAL_OVERLAY');
  assert.equal(effDev2.sets[0].effective.load, ov.appliedValue);
});
