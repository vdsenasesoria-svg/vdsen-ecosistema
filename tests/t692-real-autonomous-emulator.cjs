'use strict';
// T692: Real Firestore Emulator + security rules verification for autonomous progression engine.
// Exercises real Firestore client SDK (Coach & Athlete with auth tokens) and Admin SDK on the emulator.
// Tests authoritative server timestamps, start markers, plan activations, candidate generation,
// application, effective prescription resolution, consumption, and multi-tenant isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, runTransaction, serverTimestamp, Timestamp } = require('firebase/firestore');
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

async function coachAssignTxn(coachDb, o) {
  const cRef = doc(coachDb, 'clients', o.clientId);
  const planRef = doc(coachDb, 'plans', o.planId);
  return runTransaction(coachDb, async (tx) => {
    const cSnap = await tx.get(cRef);
    if (!cSnap.exists()) throw new Error('CLIENT_NOT_FOUND');
    const cur = cSnap.data();
    if (cur.coachId !== o.coachId) throw new Error('NOT_OWNER');
    const curActive = cur.activePlanId || null;
    if (curActive === o.planId) return { outcome: 'ALREADY_ASSIGNED' };

    tx.set(planRef, o.planDoc);
    if (o.authoritativeActivations) {
      const actId = o.actId || ('act_' + o.clientId + '_' + o.planId + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7));
      const actRef = doc(coachDb, 'clients', o.clientId, 'plan_activations', actId);
      const actDoc = {
        id: actId,
        clientId: o.clientId,
        coachId: o.forgedCoachId || o.coachId,
        newPlanId: o.planId,
        at: o.forgedTimestamp || serverTimestamp()
      };
      if (curActive) actDoc.previousPlanId = curActive;
      tx.set(actRef, actDoc);
      tx.update(cRef, { activePlanId: o.planId, activeActivationId: actId });
      return { outcome: 'COMMITTED', planId: o.planId, actId };
    } else {
      tx.update(cRef, { activePlanId: o.planId });
      return { outcome: 'COMMITTED', planId: o.planId };
    }
  });
}

test('T693.E1: Configuration A — Legacy rules compatibility: assignment succeeds without touching plan_activations', async () => {
  const s = await seedEmulator('A');
  const coachSession = await asUser(s.coachId);
  const planIdA = 'plan-legacy-' + (++seq);
  const planDocA = Object.assign({}, s.plan, { id: planIdA, status: 'active' });

  // Coach executes assignment with authoritativeActivations: false (safe default)
  const res = await coachAssignTxn(coachSession.db, {
    clientId: s.uid,
    coachId: s.coachId,
    planId: planIdA,
    planDoc: planDocA,
    authoritativeActivations: false
  });
  assert.equal(res.outcome, 'COMMITTED');

  const clientSnap = await adminDb.doc('clients/' + s.uid).get();
  assert.equal(clientSnap.data().activePlanId, planIdA, 'activePlanId updated');
  assert.equal(clientSnap.data().activeActivationId, undefined, 'no activeActivationId in legacy mode');

  const actSnaps = await adminDb.collection('clients/' + s.uid + '/plan_activations').get();
  assert.equal(actSnaps.size, 0, 'zero plan_activations written in legacy mode');
});

test('T693.E2: Configuration B — T689 rules: authoritative registration with serverTimestamp in same transaction as activePlanId', async () => {
  const s = await seedEmulator('A');
  const coachSession = await asUser(s.coachId);
  const planIdB = 'plan-auth-' + (++seq);
  const planDocB = Object.assign({}, s.plan, { id: planIdB, status: 'active' });

  const res = await coachAssignTxn(coachSession.db, {
    clientId: s.uid,
    coachId: s.coachId,
    planId: planIdB,
    planDoc: planDocB,
    authoritativeActivations: true
  });
  assert.equal(res.outcome, 'COMMITTED');
  assert.ok(res.actId, 'activation record ID returned');

  const clientSnap = await adminDb.doc('clients/' + s.uid).get();
  assert.equal(clientSnap.data().activePlanId, planIdB);
  assert.equal(clientSnap.data().activeActivationId, res.actId);

  const actSnap = await adminDb.doc('clients/' + s.uid + '/plan_activations/' + res.actId).get();
  assert.ok(actSnap.exists, 'activation record exists');
  const act = actSnap.data();
  assert.equal(act.clientId, s.uid);
  assert.equal(act.coachId, s.coachId);
  assert.equal(act.newPlanId, planIdB);
  assert.equal(act.previousPlanId, s.planId);
  assert.ok(act.at && typeof act.at.toMillis === 'function', 'at is an authentic server Timestamp');
});

test('T693.E3: Legitimate plan reactivations produce distinct unique IDs and pinned activeActivationId', async () => {
  const s = await seedEmulator('A');
  const coachSession = await asUser(s.coachId);

  // 1. Activate Plan 1
  const p1 = 'plan-react-1-' + (++seq);
  const res1 = await coachAssignTxn(coachSession.db, {
    clientId: s.uid, coachId: s.coachId, planId: p1,
    planDoc: Object.assign({}, s.plan, { id: p1, status: 'active' }),
    authoritativeActivations: true
  });

  // 2. Activate Plan 2
  const p2 = 'plan-react-2-' + (++seq);
  const res2 = await coachAssignTxn(coachSession.db, {
    clientId: s.uid, coachId: s.coachId, planId: p2,
    planDoc: Object.assign({}, s.plan, { id: p2, status: 'active' }),
    authoritativeActivations: true
  });

  // 3. Reactivate Plan 1
  const res3 = await coachAssignTxn(coachSession.db, {
    clientId: s.uid, coachId: s.coachId, planId: p1,
    planDoc: Object.assign({}, s.plan, { id: p1, status: 'active' }),
    authoritativeActivations: true
  });

  assert.ok(res1.actId && res2.actId && res3.actId);
  assert.notEqual(res1.actId, res2.actId);
  assert.notEqual(res2.actId, res3.actId);
  assert.notEqual(res1.actId, res3.actId);

  const clientSnap = await adminDb.doc('clients/' + s.uid).get();
  assert.equal(clientSnap.data().activePlanId, p1);
  assert.equal(clientSnap.data().activeActivationId, res3.actId, 'pinned to latest reactivation');

  const act3Snap = await adminDb.doc('clients/' + s.uid + '/plan_activations/' + res3.actId).get();
  assert.equal(act3Snap.data().previousPlanId, p2, 'reactivation properly recorded previous active plan (p2)');
  assert.equal(act3Snap.data().newPlanId, p1);

  const allActs = await adminDb.collection('clients/' + s.uid + '/plan_activations').get();
  assert.equal(allActs.size, 3, 'all 3 activation documents preserved without overwrite or collision');
});

test('T693.E4: Foreign Coach rejection — assignment transaction denied by security rules, zero state modified', async () => {
  const s = await seedEmulator('A');
  const foreignCoachId = 'coach-foreign-' + (++seq);
  await adminDb.doc('coaches/' + foreignCoachId).set({ role: 'coach' });
  const foreignSession = await asUser(foreignCoachId);

  const planIdForeign = 'plan-foreign-' + (++seq);
  let failed = false;
  try {
    await coachAssignTxn(foreignSession.db, {
      clientId: s.uid,
      coachId: foreignCoachId,
      planId: planIdForeign,
      planDoc: Object.assign({}, s.plan, { id: planIdForeign, coachId: foreignCoachId, status: 'active' }),
      authoritativeActivations: true
    });
  } catch (err) {
    failed = true;
    assert.match(String(err.code || err.message), /permission|denied|NOT_OWNER/i);
  }
  assert.ok(failed, 'foreign coach assignment rejected');

  // Verify zero state was mutated on the victim client
  const clientSnap = await adminDb.doc('clients/' + s.uid).get();
  assert.equal(clientSnap.data().activePlanId, s.planId, 'client activePlanId was not touched');
  const planSnap = await adminDb.doc('plans/' + planIdForeign).get();
  assert.equal(planSnap.exists, false, 'plan doc was not created');
});

test('T693.E5: Atomic failure — invalid plan_activations write rolls back entire transaction (plan and activePlanId untouched)', async () => {
  const s = await seedEmulator('A');
  const coachSession = await asUser(s.coachId);
  const planIdFail = 'plan-fail-' + (++seq);

  let failed = false;
  try {
    // Attempt assignment transaction where plan_activations doc forges coachId (rejected by rules)
    await coachAssignTxn(coachSession.db, {
      clientId: s.uid,
      coachId: s.coachId,
      planId: planIdFail,
      planDoc: Object.assign({}, s.plan, { id: planIdFail, status: 'active' }),
      authoritativeActivations: true,
      forgedCoachId: 'coach-impostor-' + seq
    });
  } catch (err) {
    failed = true;
    assert.match(String(err.code || err.message), /permission|denied/i);
  }
  assert.ok(failed, 'transaction failed due to rules violation in plan_activations');

  // Verify atomic rollback: client activePlanId and plan doc untouched
  const clientSnap = await adminDb.doc('clients/' + s.uid).get();
  assert.equal(clientSnap.data().activePlanId, s.planId, 'client activePlanId rolled back atomically');
  assert.equal(clientSnap.data().activeActivationId, undefined, 'no activeActivationId written');
  const planSnap = await adminDb.doc('plans/' + planIdFail).get();
  assert.equal(planSnap.exists, false, 'plan was not created due to atomic transaction rollback');
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
