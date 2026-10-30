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
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, runTransaction, FieldPath, deleteField } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const root = path.join(__dirname, '..');
const clientHtml = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const coachHtml = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const { MERGE_HELPERS_SRC } = require(path.join(root, 'tests', 'helpers', 'client-log-merge.js'));   // T593-R: per-entry merge helpers of the real Client
const adminApp = initAdmin({ projectId }, 't476-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];

function functionSource(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
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

// structuredClone would turn the SDK delete sentinel into a plain object: copy plain objects / arrays, keep every other instance (FieldValue) as is
function cloneKeepingFieldValues(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Array.from(v, cloneKeepingFieldValues);   // Array.from: a host-realm array (v.map would keep the vm realm)
  if (v.constructor && v.constructor.name !== 'Object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneKeepingFieldValues(x)]));
}
function clientContext(f) {
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow }, USER: { uid: f.client.uid },
    ACTIVE_PLAN_ID: f.planId, FB: { db: f.client.db, doc, FieldPath, deleteField,
      setDoc: (ref, value, opts) => setDoc(ref, cloneKeepingFieldValues(value), opts),   // T593-R: host-realm copy (the vm objects are cross-realm) that keeps the real FieldValue delete sentinel
      runTransaction: (db, fn) => runTransaction(db, tx => fn({
        get: ref => tx.get(ref),
        set: (ref, value, opts) => tx.set(ref, /decisions/.test(ref.path) ? value : structuredClone(value), opts),   // T603: the decision record carries a serverTimestamp sentinel (not cloneable)
        update: (ref, value) => tx.update(ref, structuredClone(value))
      })) },
    LOGS: { progrec_1_0: f.parent }, REAL_WEEK: 1, EXERCISE_UNITS: {}, EXERCISE_HISTORY: {},
    _sraSaveGeneration: 0, _sraPersisted: { version: 0, entries: {} }, _saveLogsTimer: null, _logsWriteInFlight: 0, _showSaveOk: () => {},
    document: { getElementById: () => null }, showToast: () => {}, console, _syncPending: 0, _WRITE_GRACE_MS: 5000, _renderSyncBadge() {}, _deferredWriteFailed() {}, localStorage: { setItem() {} }, navigator: { onLine: true }, setTimeout, clearTimeout };
  vm.createContext(context);
  ['_getSessionCompletionState', '_sessionHasRealLoggedSets', '_getSessionLifecycleState']
    .forEach(name => vm.runInContext(functionSource(clientHtml, name), context));
  vm.runInContext(functionSource(clientHtml, '_selectLogAuthority'), context);
  vm.runInContext(MERGE_HELPERS_SRC, context);
  vm.runInContext(functionSource(clientHtml, '_acceptSraPersisted') + '\n' + functionSource(clientHtml, '_fbWriteOrQueue') + '\n' + functionSource(clientHtml, '_writeLocalBackup') + '\n' + functionSource(clientHtml, '_doSaveLogs'), context);
  return context;
}

// T537: PENDING records are materialized by the OWNER Coach (real Coach function, real SDK transactions, real rules).
function materializerContext(f, coachDb) {
  const db = coachDb || f.coach.db;
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow, VDSEN_APPLICATION_CONSUMER: require(path.join(root, 'assets/progression-application-consumer.js')) },
    currentCoach: { uid: f.coach.uid }, _detailClientId: f.client.uid, db, doc,
    runTransaction: (d, fn) => runTransaction(d, tx => fn({
      get: ref => tx.get(ref),
      set: (ref, value, opts) => tx.set(ref, /decisions/.test(ref.path) ? value : structuredClone(value), opts),   // T603: the decision record carries a serverTimestamp sentinel (not cloneable)
      update: (ref, value) => tx.update(ref, structuredClone(value))
    })), console };
  vm.createContext(context);
  vm.runInContext(functionSource(coachHtml, '_materializeShadowRecords'), context);
  return context;
}

function coachContext(f, item) {
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow },
    _shadowMonitorContext: { clientId: f.client.uid, planId: f.planId, items: [item] },
    _detailClientId: f.client.uid, _detailClientData: { activePlanId: f.planId },
    _detailPlanData: f.plan, _detailActiveTab: 'monitor', _shadowActionBusy: false,
    currentCoach: { uid: f.coach.uid },
    _buildCoachIntervention: input => ({ ...input, id: 't476-' + input.action }),
    _decisionRecord: r => ({ id: r.id, targetType: r.targetType, targetId: r.targetId, planId: r.planId || null, action: r.action, decidedBy: r.decidedBy, at: require('firebase/firestore').serverTimestamp() }),   // T603: the real record written next to every Coach decision
    showToast: () => {}, document: { getElementById: () => null },
    db: f.coach.db, doc,
    runTransaction: (db, fn) => runTransaction(db, tx => fn({
      get: ref => tx.get(ref),
      set: (ref, value, opts) => tx.set(ref, /decisions/.test(ref.path) ? value : structuredClone(value), opts),   // T603: the decision record carries a serverTimestamp sentinel (not cloneable)
      update: (ref, value) => tx.update(ref, structuredClone(value))
    })), console };
  vm.createContext(context);
  vm.runInContext(functionSource(coachHtml, '_onShadowAutoAction'), context);
  vm.runInContext(functionSource(coachHtml, '_reconcileShadowAuto'), context);
  return context;
}

test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

test('the save retains canonical fields and merges the owned entries KEY BY KEY (another device entries survive) under real Firestore rules', { timeout: 30000 }, async () => {
  const f = await fixture(), ctx = clientContext(f);
  const mesoRef = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId);
  const rootRef = doc(f.client.db, 'logs', f.client.uid);
  // canonical fields exist (written by the Coach side, here via admin): the athlete's save must keep them and be ALLOWED
  await adminDb.doc(mesoRef.path).set({ progressionApplications: { prior: { state: 'PENDING' } }, progressionApplicationSummary: { autoCount: 1 } }, { merge: true });
  await adminDb.doc(rootRef.path).set({ progressionApplicationSummary: { autoCount: 1 } }, { merge: true });
  // T593-R: another device of the same athlete already saved an entry this device has never seen: a save must NOT erase it
  const other = { done: true, carga: '100', reps: '10', ts: 5 };
  await adminDb.doc(mesoRef.path).set({ entries: { log_9_9_9_s9: other } }, { merge: true });
  await adminDb.doc(rootRef.path).set({ entries: { log_9_9_9_s9: other } }, { merge: true });
  assert.equal(await ctx._doSaveLogs(), true);   // the pre-existing 'obsolete' entry is unknown to this device (not in its baseline): it is never guessed away, only a knowing delete removes an entry
  const meso = (await getDoc(mesoRef)).data(), rootLog = (await getDoc(rootRef)).data();
  assert.deepEqual(meso.entries, { progrec_1_0: f.parent, obsolete: { value: true }, log_9_9_9_s9: other });
  assert.equal(meso.progressionApplications.prior.state, 'PENDING');
  assert.equal(meso.progressionApplicationSummary.autoCount, 1);
  assert.equal(rootLog.progressionApplicationSummary.autoCount, 1);
  assert.deepEqual(rootLog.entries, { progrec_1_0: f.parent, log_9_9_9_s9: other });
  // a deletion the athlete made knowingly (the key was in the baseline) is a field-path delete and is also ALLOWED by the rules
  vm.runInContext("_setBaselines({ progrec_1_0: LOGS.progrec_1_0, done_1_1: { ts: 1 } }, {}, {}); _logsHeal = false;", ctx);
  await adminDb.doc(mesoRef.path).set({ entries: { done_1_1: { ts: 1 } } }, { merge: true });
  assert.equal(await ctx._doSaveLogs(), true);
  const after = (await getDoc(mesoRef)).data();
  assert.ok(!('done_1_1' in after.entries), 'deleted by field path'); assert.ok('log_9_9_9_s9' in after.entries, 'the other device entry is still there'); assert.equal(after.progressionApplications.prior.state, 'PENDING');
});

test('Coach materialization repairs nothing in LOGS and uses the newer root source when the meso mirror lags (no false STALE)', { timeout: 30000 }, async () => {
  const f = await fixture(), ctx = materializerContext(f);
  const mesoRef = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId);
  const rootRef = doc(f.client.db, 'logs', f.client.uid);
  const old = { calculatedAt: new Date(Date.parse(f.parent.calculatedAt) - 60000).toISOString(), recommendations: f.parent.recommendations };
  await adminDb.doc(mesoRef.path).set({ planId: f.planId, entries: { progrec_1_0: old, done_1_0: { ts: 1 } }, updatedAt: 1 });
  await adminDb.doc(rootRef.path).set({ planId: f.planId, entries: { progrec_1_0: f.parent, done_1_0: { ts: 1 } }, updatedAt: 2 });
  const mesoEntriesBefore = (await getDoc(mesoRef)).data().entries;
  assert.ok(await ctx._materializeShadowRecords(f.client.uid, f.planId));
  const meso = (await getDoc(mesoRef)).data(), rootLog = (await getDoc(rootRef)).data();
  const records = Object.values(meso.progressionApplications);
  assert.equal(records.length, 1); assert.equal(records[0].state, 'PENDING'); assert.equal(records[0].source.calculatedAt, f.parent.calculatedAt);
  assert.deepEqual(meso.entries, mesoEntriesBefore, 'the Coach never rewrites executed LOGS (no mirror repair)');
  assert.deepEqual(rootLog.progressionApplicationSummary, meso.progressionApplicationSummary);
});

test('evidence older than the authoritative root cannot become PENDING; a newer calculation supersedes an older PENDING', { timeout: 30000 }, async () => {
  const f = await fixture(), ctx = materializerContext(f);
  const mesoRef = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId);
  const rootRef = doc(f.client.db, 'logs', f.client.uid);
  const old = { calculatedAt: new Date(Date.parse(f.parent.calculatedAt) - 30000).toISOString(), recommendations: f.parent.recommendations };
  await adminDb.doc(mesoRef.path).set({ planId: f.planId, entries: { progrec_1_0: old }, updatedAt: 1 });
  await adminDb.doc(rootRef.path).set({ planId: f.planId, entries: { progrec_1_0: old }, updatedAt: 1 });
  assert.ok(await ctx._materializeShadowRecords(f.client.uid, f.planId));
  await adminDb.doc(mesoRef.path).set({ entries: { progrec_1_0: f.parent }, updatedAt: 3 }, { merge: true });
  await adminDb.doc(rootRef.path).set({ entries: { progrec_1_0: f.parent }, updatedAt: 3 }, { merge: true });
  assert.ok(await ctx._materializeShadowRecords(f.client.uid, f.planId));
  const meso = (await getDoc(mesoRef)).data(), states = Object.values(meso.progressionApplications).map(r => r.state).sort();
  assert.deepEqual(states, ['PENDING', 'STALE']);
  assert.equal((await getDoc(rootRef)).data().progressionApplicationSummary.autoCount, 1);
  assert.equal(await ctx._materializeShadowRecords(f.client.uid, f.planId), null, 'nothing new => no write');
});

test('two Coach tabs materializing concurrently keep one key; a non-owner Coach and a Coach switched to another client write nothing', { timeout: 30000 }, async () => {
  const f = await fixture(), a = materializerContext(f), b = materializerContext(f);
  const mesoRef = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId);
  const rootRef = doc(f.client.db, 'logs', f.client.uid);
  await Promise.all([a._materializeShadowRecords(f.client.uid, f.planId), b._materializeShadowRecords(f.client.uid, f.planId)]);
  let meso = (await getDoc(mesoRef)).data(), rootLog = (await getDoc(rootRef)).data();
  assert.equal(Object.keys(meso.progressionApplications).length, 1);
  assert.equal(meso.progressionApplicationSummary.autoCount, 1);
  assert.deepEqual(rootLog.progressionApplicationSummary, meso.progressionApplicationSummary);
});

test('a non-owner Coach, a Coach switched to another client and an athlete session with a forged Coach identity write nothing', { timeout: 30000 }, async () => {
  const f = await fixture(), a = materializerContext(f);
  const mesoRef = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId);
  await a._materializeShadowRecords(f.client.uid, f.planId);
  const other = await signedIn();
  await adminDb.doc('coaches/' + other.uid).set({ role: 'coach' });
  const foreign = materializerContext(f, other.db); foreign.currentCoach = { uid: other.uid };
  await adminDb.doc(mesoRef.path).update({ progressionApplications: {}, progressionApplicationSummary: { autoCount: 0, counts: {}, items: [] } });
  const foreignResult = await foreign._materializeShadowRecords(f.client.uid, f.planId).then(() => 'resolved', e => e.code);
  assert.ok(foreignResult === 'permission-denied' || foreignResult === 'resolved', 'a non-owner Coach is stopped by the rules (plan read) or by the ownership guard');
  const switched = materializerContext(f); switched._detailClientId = 'late-context';
  assert.equal(await switched._materializeShadowRecords(f.client.uid, f.planId), null);
  assert.deepEqual((await getDoc(mesoRef)).data().progressionApplications, {}, 'nothing was written by either');
  const clientDb = materializerContext(f, f.client.db); clientDb.currentCoach = { uid: f.coach.uid };
  await assert.rejects(clientDb._materializeShadowRecords(f.client.uid, f.planId), { code: 'permission-denied' }, 'even a forged in-page Coach identity cannot write from an athlete session (rules)');
  assert.deepEqual((await getDoc(doc(f.coach.db, 'plans', f.planId))).data(), f.plan);
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
  const f = await fixture(), matCtx = materializerContext(f);
  assert.ok(await matCtx._materializeShadowRecords(f.client.uid, f.planId));
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
