// Run only against a local Firestore emulator with firestore.rules and demo project.
// Requires the app-matched firebase@10.12.0 SDK on NODE_PATH; the repo does not
// declare it as a Node dependency. FIRESTORE_EMULATOR_HOST must be set explicitly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, runTransaction } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const root = path.join(__dirname, '..');
const clientHtml = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const coachHtml = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const adminApp = initAdmin({ projectId }, 't476-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];

function functionSource(source, name) {
  const start = source.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, quote = null, escaped = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Cannot extract ' + name);
}

async function signedIn() {
  const uid = 't476-' + randomUUID();
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId },
    't476-' + apps.length);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid } });
  return { uid, db };
}

async function fixture() {
  const client = await signedIn();
  const coach = await signedIn();
  const planId = 'plan-' + client.uid;
  const calculatedAt = new Date().toISOString();
  const plan = { clientId: client.uid, coachId: coach.uid, status: 'active', weeks: 4,
    updatedAt: new Date(Date.now() - 60000).toISOString(), days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A',
        exerciseName: 'Remo', sets: [{ load: 50, repsTarget: 10 }] }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A',
        exerciseName: 'Remo', sets: [{ load: 50, repsTarget: 10 }] }] }
    ] };
  const rec = { prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A', exerciseName: 'Remo',
    action: 'increase_load', newLoad: 52, newReps: 10 };
  const parent = { calculatedAt, recommendations: [rec] };
  await adminDb.doc('coaches/' + coach.uid).set({ role: 'coach' });
  await adminDb.doc('clients/' + client.uid).set({ coachId: coach.uid, activePlanId: planId,
    coachInterventions: [] });
  await adminDb.doc('plans/' + planId).set(plan);
  await adminDb.doc('logs/' + client.uid).set({ planId, entries: { progrec_1_0: parent } });
  await adminDb.doc('logs/' + client.uid + '/mesos/' + planId).set({ planId,
    entries: { progrec_1_0: parent, obsolete: { value: true } } });
  return { client, coach, planId, plan, rec, parent };
}

function clientContext(f) {
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow }, USER: { uid: f.client.uid },
    ACTIVE_PLAN_ID: f.planId, FB: { db: f.client.db, doc,
      setDoc: (ref, value, opts) => setDoc(ref, structuredClone(value), opts),
      runTransaction: (db, fn) => runTransaction(db, tx => fn({
        get: ref => tx.get(ref),
        set: (ref, value, opts) => tx.set(ref, structuredClone(value), opts),
        update: (ref, value) => tx.update(ref, structuredClone(value))
      })) },
    LOGS: { progrec_1_0: f.parent }, REAL_WEEK: 1, EXERCISE_UNITS: {}, EXERCISE_HISTORY: {},
    _saveLogsTimer: null, _logsWriteInFlight: 0, _showSaveOk: () => {},
    document: { getElementById: () => null }, showToast: () => {}, console };
  vm.createContext(context);
  vm.runInContext(functionSource(clientHtml, '_doSaveLogs'), context);
  vm.runInContext(functionSource(clientHtml, '_recordShadowProgression'), context);
  return context;
}

function coachContext(f, item) {
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow },
    _shadowMonitorContext: { clientId: f.client.uid, planId: f.planId, items: [item] },
    _detailClientId: f.client.uid, _detailClientData: { activePlanId: f.planId },
    _detailPlanData: f.plan, _detailActiveTab: 'monitor', _shadowActionBusy: false,
    currentCoach: { uid: f.coach.uid },
    _buildCoachIntervention: input => ({ ...input, id: 't476-' + input.action }),
    showToast: () => {}, document: { getElementById: () => null },
    db: f.coach.db, doc,
    runTransaction: (db, fn) => runTransaction(db, tx => fn({
      get: ref => tx.get(ref),
      set: (ref, value, opts) => tx.set(ref, structuredClone(value), opts),
      update: (ref, value) => tx.update(ref, structuredClone(value))
    })), console };
  vm.createContext(context);
  vm.runInContext(functionSource(coachHtml, '_onShadowAutoAction'), context);
  vm.runInContext(functionSource(coachHtml, '_reconcileShadowAuto'), context);
  return context;
}

test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

test('mergeFields retains audit fields and replaces the owned entries map under real Firestore rules', { timeout: 30000 }, async () => {
  const f = await fixture(), ctx = clientContext(f);
  const mesoRef = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId);
  const rootRef = doc(f.client.db, 'logs', f.client.uid);
  await setDoc(mesoRef, { progressionApplications: { prior: { state: 'PENDING' } },
    progressionApplicationSummary: { autoCount: 1 } }, { merge: true });
  await setDoc(rootRef, { progressionApplicationSummary: { autoCount: 1 } }, { merge: true });
  assert.equal(await ctx._doSaveLogs(), true);
  const meso = (await getDoc(mesoRef)).data(), rootLog = (await getDoc(rootRef)).data();
  assert.deepEqual(meso.entries, { progrec_1_0: f.parent });
  assert.equal(meso.progressionApplications.prior.state, 'PENDING');
  assert.equal(meso.progressionApplicationSummary.autoCount, 1);
  assert.equal(rootLog.progressionApplicationSummary.autoCount, 1);
  assert.deepEqual(rootLog.entries, { progrec_1_0: f.parent });
});

test('concurrent client callbacks keep one key and atomically mirror the summary; late/wrong contexts do not write', { timeout: 30000 }, async () => {
  const f = await fixture(), a = clientContext(f), b = clientContext(f);
  const mesoRef = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId);
  const rootRef = doc(f.client.db, 'logs', f.client.uid);
  await Promise.all([
    a._recordShadowProgression(f.client.uid, f.planId, 1, 0, f.parent),
    b._recordShadowProgression(f.client.uid, f.planId, 1, 0, f.parent)
  ]);
  let meso = (await getDoc(mesoRef)).data(), rootLog = (await getDoc(rootRef)).data();
  assert.equal(Object.keys(meso.progressionApplications).length, 1);
  assert.equal(meso.progressionApplicationSummary.autoCount, 1);
  assert.deepEqual(rootLog.progressionApplicationSummary, meso.progressionApplicationSummary);
  assert.equal(await a._recordShadowProgression(f.client.uid, f.planId, 1, 0, f.parent), true);
  assert.equal(Object.keys((await getDoc(mesoRef)).data().progressionApplications).length, 1);
  const other = await fixture();
  assert.equal(await a._recordShadowProgression(other.client.uid, other.planId, 1, 0, other.parent), false);
  assert.equal((await getDoc(doc(other.client.db, 'logs', other.client.uid, 'mesos', other.planId)))
    .data().progressionApplications, undefined);
  a.FB = { ...a.FB, runTransaction: (db, fn) => runTransaction(db, async tx => {
    const guarded = { ...tx, get: async ref => {
      const snap = await tx.get(ref);
      if (ref.path === rootRef.path) a.USER = { uid: other.client.uid };
      return snap;
    } };
    return fn(guarded);
  }) };
  assert.equal(await a._recordShadowProgression(f.client.uid, f.planId, 1, 0, f.parent), false);
  meso = (await getDoc(mesoRef)).data(); rootLog = (await getDoc(rootRef)).data();
  assert.equal(Object.keys(meso.progressionApplications).length, 1);
  assert.deepEqual(rootLog.progressionApplicationSummary, meso.progressionApplicationSummary);
  a.USER = { uid: f.client.uid };
  a.FB.runTransaction = b.FB.runTransaction;
  await adminDb.doc('clients/' + f.client.uid).update({ activePlanId: other.planId });
  assert.equal(await a._recordShadowProgression(f.client.uid, f.planId, 1, 0, f.parent), false);
  assert.equal(Object.keys((await getDoc(mesoRef)).data().progressionApplications).length, 1);
  assert.deepEqual((await getDoc(doc(f.client.db, 'plans', f.planId))).data(), f.plan);
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false);
  assert.equal(shadow.attemptNumericApply().reasonCode, 'MAGNITUDE_POLICY_MISSING');
});

test('a denied write rolls back both documents in one real Firestore transaction', { timeout: 30000 }, async () => {
  const f = await fixture();
  const mesoRef = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId);
  const rootRef = doc(f.client.db, 'logs', f.client.uid);
  const planRef = doc(f.client.db, 'plans', f.planId);
  const beforeMeso = (await getDoc(mesoRef)).data();
  const beforeRoot = (await getDoc(rootRef)).data();
  await assert.rejects(runTransaction(f.client.db, async tx => {
    await tx.get(mesoRef);
    await tx.get(rootRef);
    await tx.get(planRef);
    tx.set(mesoRef, { progressionApplicationSummary: { autoCount: 99 } }, { merge: true });
    tx.set(rootRef, { progressionApplicationSummary: { autoCount: 99 } }, { merge: true });
    tx.update(planRef, { forbidden: true }); // active plan and client cannot update plans
  }), { code: 'permission-denied' });
  assert.deepEqual((await getDoc(mesoRef)).data(), beforeMeso);
  assert.deepEqual((await getDoc(rootRef)).data(), beforeRoot);
  assert.deepEqual((await getDoc(planRef)).data(), f.plan);
});

test('Coach CAS is idempotent under concurrent retries; intervention and both summaries commit together', { timeout: 30000 }, async () => {
  const f = await fixture(), clientCtx = clientContext(f);
  assert.equal(await clientCtx._recordShadowProgression(f.client.uid, f.planId, 1, 0, f.parent), true);
  const mesoRef = doc(f.coach.db, 'logs', f.client.uid, 'mesos', f.planId);
  const rootRef = doc(f.coach.db, 'logs', f.client.uid);
  const first = (await getDoc(mesoRef)).data();
  const item = first.progressionApplicationSummary.items[0];
  const c1 = coachContext(f, item), c2 = coachContext(f, item);
  const normalTransaction = c1.runTransaction;
  c1.runTransaction = (db, fn) => normalTransaction(db, tx => fn({ ...tx,
    get: async ref => {
      const snap = await tx.get(ref);
      if (ref.path === rootRef.path) c1._detailClientId = 'late-context';
      return snap;
    }
  }));
  await c1._onShadowAutoAction('KEEP_ORIGINAL', item.key, 1, { disabled: false });
  assert.equal((await getDoc(mesoRef)).data().progressionApplications[item.key].state, 'PENDING');
  c1._detailClientId = f.client.uid;
  c1.runTransaction = normalTransaction;
  await Promise.all([
    c1._onShadowAutoAction('KEEP_ORIGINAL', item.key, 1, { disabled: false }),
    c2._onShadowAutoAction('KEEP_ORIGINAL', item.key, 1, { disabled: false })
  ]);
  let meso = (await getDoc(mesoRef)).data();
  let clientData = (await getDoc(doc(f.coach.db, 'clients', f.client.uid))).data();
  assert.equal(meso.progressionApplications[item.key].state, 'REJECTED');
  assert.equal(meso.progressionApplications[item.key].revision, 2);
  assert.equal(clientData.coachInterventions.length, 1);
  assert.equal(meso.progressionApplicationSummary.autoCount, 0);
  assert.deepEqual((await getDoc(rootRef)).data().progressionApplicationSummary,
    meso.progressionApplicationSummary);
  await c1._onShadowAutoAction('KEEP_ORIGINAL', item.key, 1, { disabled: false });
  clientData = (await getDoc(doc(f.coach.db, 'clients', f.client.uid))).data();
  assert.equal(clientData.coachInterventions.length, 1);
  c1._shadowMonitorContext.items = [meso.progressionApplicationSummary.items[0]];
  await c1._onShadowAutoAction('REVERT_DECISION', item.key, 2, { disabled: false });
  meso = (await getDoc(mesoRef)).data();
  clientData = (await getDoc(doc(f.coach.db, 'clients', f.client.uid))).data();
  assert.equal(meso.progressionApplications[item.key].state, 'PENDING');
  assert.equal(meso.progressionApplications[item.key].revision, 3);
  assert.equal(clientData.coachInterventions.length, 2);
  assert.deepEqual((await getDoc(rootRef)).data().progressionApplicationSummary,
    meso.progressionApplicationSummary);
  assert.deepEqual((await getDoc(doc(f.coach.db, 'plans', f.planId))).data(), f.plan);
});
