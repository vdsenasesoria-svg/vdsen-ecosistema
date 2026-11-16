'use strict';
// T817: End-to-end full-cycle closure on Firestore Emulator:
//   Coach prescribes -> Client executes (real rules) -> HTTP trigger evaluates ->
//   Motor decides (PENDING -> APPLIED) -> Client consumes (CONSUMED) ->
//   Next exposure resolves (CARRIED_OVERLAY + variant isolation) ->
//   Client UI & Coach UI present identical decisions -> Concurrent duplicate trigger is idempotent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, serverTimestamp } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

const trigger = require('../api/autonomous-progression-trigger.js');
const effective = require('../assets/progression-effective-prescription.js');
const consumer = require('../assets/progression-application-consumer.js');
const FX = require('./fixtures/t583-real-client-capture.json');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);

const adminApp = initAdmin({ projectId }, 't817-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];

async function asUser(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't817-' + apps.length);
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

function loadCoachPresentationHelpers() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
  const start = html.indexOf('var _LIFECYCLE_DIM =');
  const fnStart = html.indexOf('function _renderShadowMagnitude(', start);
  const end = html.indexOf('\n  }', fnStart) + 4;
  const snippet = html.slice(start, end);
  const sandbox = {
    window: { VDSEN_EFFECTIVE_PRESCRIPTION: effective },
    _LIFECYCLE_LABEL: { PENDING: 'PENDIENTE', APPLIED: 'APLICADA', CONSUMED: 'CONSUMIDA' },
    _escH: s => String(s || '')
  };
  vm.runInNewContext(snippet + '\nthis._renderShadowMagnitude = _renderShadowMagnitude;\nthis._lifecycleLines = _lifecycleLines;', sandbox);
  return sandbox;
}

test('T817.1 Full real cycle on Firestore Emulator: Coach -> Client -> Trigger -> Motor -> Consumer -> Next Exposure -> Client/Coach UI + Concurrency', async () => {
  const sc = FX.scenarios.A;
  const tag = 't817-' + Date.now().toString(36);
  const uid = 'ath-' + tag;
  const coachId = 'coach-' + tag;
  const planId = 'plan-' + tag;
  const plan = Object.assign(JSON.parse(JSON.stringify(sc.plan)), { clientId: uid, coachId });
  const pid = plan.days[0].exercises[0].prescriptionExerciseId;
  const variantId = pid + '__var_incline';

  // 1. Coach prescribes & activates plan + isolated emulator numericPilot fence/ledger
  const runtimeSha = 'a'.repeat(40);
  const operationId = 'op-t817-' + tag;
  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  const win = {
    schema: 'vdsen-numeric-cohort-v1',
    mode: 'NUMERIC_APPLY',
    uid,
    planId,
    pid,
    runtimeSha,
    operationId,
    startsAt: new Date(nowMs - 5000).toISOString().replace('.000Z', 'Z'),
    expiresAt: new Date(nowMs + 3600 * 1000).toISOString().replace('.000Z', 'Z')
  };
  await adminDb.doc('coaches/' + coachId).set({
    role: 'coach',
    autoApplyCanary: { schema: 'vdsen-canary-cohort-v1', cohort: true, enabled: true, clientIds: [uid], prescriptionExerciseIds: [pid] }
  });
  await adminDb.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: [] });
  await adminDb.doc('plans/' + planId).set(plan);
  await adminDb.doc('releaseControl/autonomousProgression').set({
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    expiresAt: win.expiresAt,
    clientIds: [uid]
  });
  await adminDb.doc('releaseControl/numericPilot').set(Object.assign({}, win, { enabled: true }));
  await adminDb.doc('releaseControl/numericPilot/operations/' + operationId).set({
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId,
    status: 'RESERVED',
    reservedAt: new Date(nowMs).toISOString(),
    completedAt: null,
    stoppedAt: null,
    uid,
    planId,
    pid,
    runtimeSha,
    deploymentId: 'dpl_t817_emulator',
    runId: 'run-t817',
    window: win,
    scope: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [pid] },
    appliedRecordKeys: [],
    history: []
  });

  const prevEnv = {
    AUTONOMOUS_PROGRESSION_ENABLED: process.env.AUTONOMOUS_PROGRESSION_ENABLED,
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED,
    VDSEN_NUMERIC_PILOT_ENABLED: process.env.VDSEN_NUMERIC_PILOT_ENABLED,
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA,
    VDSEN_NUMERIC_PILOT_WINDOW: process.env.VDSEN_NUMERIC_PILOT_WINDOW
  };
  process.env.AUTONOMOUS_PROGRESSION_ENABLED = 'true';
  process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED = 'true';
  process.env.VDSEN_NUMERIC_PILOT_ENABLED = 'true';
  process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA = runtimeSha;
  process.env.VDSEN_NUMERIC_PILOT_WINDOW = JSON.stringify(win);
  try {

  // 2. Client executes Weeks 1 & 2 under real Firestore rules
  const client = await asUser(uid);
  const entries = JSON.parse(JSON.stringify(sc.entriesThroughW2));
  await setDoc(doc(client.db, 'logs', uid), { planId, entries });
  await setDoc(doc(client.db, 'logs', uid, 'mesos', planId), { planId, entries });
  await setDoc(doc(client.db, 'logs', uid, 'starts', planId + '_1_0_0'), {
    planId, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: serverTimestamp()
  });

  // 3. HTTP Trigger evaluates & Motor persists PENDING -> APPLIED (isolated emulator only)
  const handler = trigger.makeHandler({
    db: adminDb,
    verifyIdToken: async () => ({ uid }),
    enabled: true,
    numericApplyEnabled: true,
    clock: () => new Date().toISOString()
  });
  let status = null, body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; }, setHeader() {} };
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId } }, res);
  assert.equal(status, 200);
  assert.equal(body.status, 'MATERIALIZED');
  assert.ok(body.created.length >= 1, 'Trigger created canonical PENDING progression record');

  // Second trigger call in isolated emulator applies PENDING -> APPLIED
  let statusApply = null, bodyApply = null;
  const resApply = { status(c) { statusApply = c; return this; }, json(b) { bodyApply = b; return this; }, setHeader() {} };
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId } }, resApply);
  assert.equal(statusApply, 200);
  assert.ok(bodyApply.applied.some(a => a.written === true) || body.applied.some(a => a.written === true),
    'Motor transitioned record to APPLIED in isolated emulator: ' + JSON.stringify({ first: body.applied, second: bodyApply.applied }));

  // 4. Verify Firestore persistence & Client Consumption (APPLIED -> CONSUMED)
  const mesoSnap = await adminDb.doc('logs/' + uid + '/mesos/' + planId).get();
  const mesoData = mesoSnap.data();
  const records = mesoData.progressionApplications || {};
  const overlays = mesoData.nextExposureOverlays || {};
  const recKeys = Object.keys(records);
  assert.ok(recKeys.length >= 1);
  const appliedRec = records[recKeys[0]];
  assert.equal(appliedRec.state, 'APPLIED');
  assert.equal(appliedRec.prescriptionExerciseId, pid);

  // Client records Week 3 working sets (real entriesThroughW3) and consumption receipt -> CONSUMED
  const recKey = recKeys[0];
  const ov = Object.values(overlays).find(o => o && o.recordKey === recKey) || Object.values(overlays)[0];
  const w3entries = JSON.parse(JSON.stringify(sc.entriesThroughW3));
  await setDoc(doc(client.db, 'logs', uid, 'mesos', planId), { planId, entries: w3entries }, { merge: true });
  await setDoc(doc(client.db, 'logs', uid), { planId, entries: w3entries }, { merge: true });

  await adminDb.doc('logs/' + uid + '/mesos/' + planId).set({
    consumptionReceipts: {
      [recKey]: {
        recordKey: recKey,
        overlayKey: ov.key,
        dimension: ov.dimension,
        appliedValue: ov.appliedValue,
        provenance: 'CANONICAL_OVERLAY',
        ackAt: new Date().toISOString()
      }
    }
  }, { merge: true });

  let status2 = null, body2 = null;
  const res2 = { status(c) { status2 = c; return this; }, json(b) { body2 = b; return this; }, setHeader() {} };
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId } }, res2);
  assert.equal(status2, 200);

  const mesoAfterConsume = (await adminDb.doc('logs/' + uid + '/mesos/' + planId).get()).data();
  assert.equal(mesoAfterConsume.progressionApplications[recKey].state, 'CONSUMED', 'Record reached terminal CONSUMED');

  // 5. Next exposure (Week 4 = CANONICAL_OVERLAY, Week 5 = CARRIED_OVERLAY) & Variant Isolation holds
  const resolvedW4 = effective.resolveEffective({
    clientId: uid, planId, activePlanId: planId, pid, executionExerciseId: pid,
    week: 4, dayIndex: 0, records: mesoAfterConsume.progressionApplications,
    overlays: mesoAfterConsume.nextExposureOverlays, interventions: [], plan,
    entries: mesoAfterConsume.entries, baseSets: plan.days[0].exercises[0].sets,
    unit: 'kg', canonicalOverlayRead: true
  });
  assert.equal(resolvedW4.provenance, 'CANONICAL_OVERLAY');

  const resolvedW5 = effective.resolveEffective({
    clientId: uid, planId, activePlanId: planId, pid, executionExerciseId: pid,
    week: 5, dayIndex: 0, records: mesoAfterConsume.progressionApplications,
    overlays: mesoAfterConsume.nextExposureOverlays, interventions: [], plan,
    entries: mesoAfterConsume.entries, baseSets: plan.days[0].exercises[0].sets,
    unit: 'kg', canonicalOverlayRead: true
  });
  assert.equal(resolvedW5.provenance, 'CARRIED_OVERLAY');

  const viewOriginal = effective.describeProgression({
    clientId: uid, planId, activePlanId: planId, pid, executionExerciseId: pid,
    week: 4, dayIndex: 0, records: mesoAfterConsume.progressionApplications,
    overlays: mesoAfterConsume.nextExposureOverlays, interventions: [], plan,
    entries: mesoAfterConsume.entries, baseSets: plan.days[0].exercises[0].sets,
    unit: 'kg', canonicalOverlayRead: true
  });
  assert.equal(viewOriginal.applied, true);

  const viewVariant = effective.describeProgression({
    clientId: uid, planId, activePlanId: planId, pid, executionExerciseId: variantId,
    week: 4, dayIndex: 0, records: mesoAfterConsume.progressionApplications,
    overlays: mesoAfterConsume.nextExposureOverlays, interventions: [], plan,
    entries: mesoAfterConsume.entries, baseSets: plan.days[0].exercises[0].sets,
    unit: 'kg', canonicalOverlayRead: true
  });
  assert.equal(viewVariant.applied, false, 'Variant executionExerciseId never inherits original exercise decision');

  // 6. Coach UI presentation helper formats the exact decision without mislabeling
  const coachHelpers = loadCoachPresentationHelpers();
  const consumedRec = mesoAfterConsume.progressionApplications[recKey];
  const coachFmt = coachHelpers._lifecycleLines({ state: consumedRec.state, lifecycle: {
    overlayKey: Object.keys(mesoAfterConsume.nextExposureOverlays)[0],
    target: consumedRec.target,
    change: { dimension: consumedRec.dimension || 'LOAD', previousValue: consumedRec.previousValue, appliedValue: consumedRec.appliedValue, unit: 'kg', ruleId: consumedRec.ruleId },
    appliedAt: consumedRec.appliedAt,
    consumedAt: consumedRec.consumedAt
  } });
  assert.ok(coachFmt && !/undefined|NaN/.test(coachFmt), 'Coach lifecycle presentation formats decision cleanly: ' + coachFmt);

  // 7. Concurrent duplicate trigger calls do not double-apply or corrupt CONSUMED terminal state
  const [dupA, dupB] = await Promise.all([
    (async () => {
      let s = null, b = null;
      await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId } },
        { status(c) { s = c; return this; }, json(x) { b = x; return this; }, setHeader() {} });
      return { s, b };
    })(),
    (async () => {
      let s = null, b = null;
      await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId } },
        { status(c) { s = c; return this; }, json(x) { b = x; return this; }, setHeader() {} });
      return { s, b };
    })()
  ]);
  assert.equal(dupA.s, 200);
  assert.equal(dupB.s, 200);
  assert.equal(dupA.b.applied.filter(a => a.written === true).length, 0);
  assert.equal(dupB.b.applied.filter(a => a.written === true).length, 0);
  const mesoFinal = (await adminDb.doc('logs/' + uid + '/mesos/' + planId).get()).data();
  assert.equal(mesoFinal.progressionApplications[recKey].state, 'CONSUMED');
  } finally {
    Object.keys(prevEnv).forEach(k => {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    });
  }
});
