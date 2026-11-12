// T536: Firestore RULES security suite (real emulator + repository firestore.rules, authenticated identities).
// Boundary under test: the athlete owns EXECUTION truth (entries, units, history, week, receipts); the canonical progression state
// (progressionApplications, nextExposureOverlays, progressionApplicationSummary) is writable only by the OWNER Coach (clients/{uid}.coachId).
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't536-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

async function as(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't536-' + apps.length);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid } });
  return db;
}
const denied = async (p, why) => { try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; } assert.fail('expected PERMISSION_DENIED: ' + why); };
const allowed = async (p, why) => { try { await p; } catch (e) { assert.fail('expected ALLOWED (' + why + '): ' + e.code + ' ' + e.message); } };

const rec = (state, key) => ({ key, clientId: null, planId: null, prescriptionExerciseId: 'pid-1', state, revision: 2, reasonCode: 'APPLIED_BY_POLICY',
  source: { week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z' }, nextExposure: { week: 2, dayIndex: 0 },
  events: [{ state, operationKey: 'apply:' + key }], lifecycle: { overlayKey: 'ovl_' + key, appliedAt: 'x', intervention: { id: 'iv', action: 'KEEP' } } });
const ovl = (key, dimension, applied) => ({ key: 'ovl_' + key, schema: 'vdsen-next-exposure-overlay-v1', sourceRecordKey: key, status: 'APPLIED', prescriptionExerciseId: 'pid-1', dimension,
  previousValue: 100, requestedValue: applied, appliedValue: applied, unit: 'KG', target: { week: 2, dayIndex: 0 }, operationKey: 'apply:' + key,
  equipmentSnapshot: { source: 'COACH_CONFIGURED', scope: 'SHARED' }, source: { week: 1, dayIndex: 2 } });
const SUMMARY = { planId: null, autoCount: 0, counts: { APPLIED: 1 }, items: [] };

async function world() {
  const id = randomUUID().slice(0, 8), C = 'cli-' + id, O = 'own-' + id, U = 'oth-' + id, S = 'str-' + id, P = 'plan-' + id;
  const A = rec('APPLIED', 'v1_aaaaaaaaaaaaaaaa'), R = rec('REVERTED', 'v1_bbbbbbbbbbbbbbbb');
  for (const r of [A, R]) { r.clientId = C; r.planId = P; }
  const s = Object.assign({}, SUMMARY, { planId: P });
  await adminDb.doc('coaches/' + O).set({ role: 'coach', equipmentIncrements: { shared: {}, gyms: {} } });
  await adminDb.doc('coaches/' + U).set({ role: 'coach' });
  await adminDb.doc('clients/' + C).set({ coachId: O, activePlanId: P, coachInterventions: [] });
  await adminDb.doc('plans/' + P).set({ coachId: O, clientId: C, weeks: 4, days: [] });
  const entries = { log_1_0_0_s0: { carga: '100', reps: '10', unit: 'KG', done: true, prescriptionExerciseId: 'pid-1', ts: 1 } };
  await adminDb.doc('logs/' + C).set({ planId: P, entries, currentWeek: 1, updatedAt: 1, exerciseUnits: {}, exerciseHistory: {}, progressionApplicationSummary: s });
  await adminDb.doc('logs/' + C + '/mesos/' + P).set({ planId: P, entries, currentWeek: 1, updatedAt: 1, exerciseUnits: {}, exerciseHistory: {},
    progressionApplications: { [A.key]: A, [R.key]: R }, nextExposureOverlays: { ['ovl_' + A.key]: ovl(A.key, 'LOAD', 102.5), ovl_reps: ovl(A.key, 'REPS', 11), ovl_rest: ovl(A.key, 'REST', 120) },
    progressionApplicationSummary: s });
  await adminDb.doc('exercises/ex-' + id).set({ name: 'X', coachId: O });
  return { id, C, O, U, S, P, A, R, meso: 'logs/' + C + '/mesos/' + P, root: 'logs/' + C, ex: 'exercises/ex-' + id, db: { C: await as(C), O: await as(O), U: await as(U), S: await as(S) } };
}
const ref = (w, who, path) => doc(w.db[who], path);
const meso = (w, who) => ref(w, who, w.meso);
const adminMeso = async w => (await adminDb.doc(w.meso).get()).data();

// ------------------------------------------------------------------------------------------------ malicious CLIENT (15 attacks + variants)
test('R01 client cannot create progressionApplications (new meso document and existing one)', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(setDoc(ref(w, 'C', 'logs/' + w.C + '/mesos/plan-new'), { planId: 'plan-new', entries: {}, progressionApplications: { x: rec('PENDING', 'x') } }), 'create meso with records');
  await denied(updateDoc(meso(w, 'C'), { 'progressionApplications.v1_cccccccccccccccc': rec('PENDING', 'v1_cccccccccccccccc') }), 'add PENDING record');
  await denied(setDoc(meso(w, 'C'), { progressionApplications: { v1_dddddddddddddddd: rec('PENDING', 'v1_dddddddddddddddd') } }, { merge: true }), 'merge-add record');
});
test('R02 client cannot create an APPLIED record', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(updateDoc(meso(w, 'C'), { 'progressionApplications.v1_eeeeeeeeeeeeeeee': rec('APPLIED', 'v1_eeeeeeeeeeeeeeee') }), 'fake APPLIED');
});
test('R03 client cannot create a nextExposureOverlay', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(updateDoc(meso(w, 'C'), { 'nextExposureOverlays.ovl_fake': ovl('v1_ffffffffffffffff', 'LOAD', 500) }), 'fake overlay');
  await denied(setDoc(ref(w, 'C', 'logs/' + w.C + '/mesos/plan-new2'), { planId: 'plan-new2', entries: {}, nextExposureOverlays: { ovl_fake: ovl('v1_ffffffffffffffff', 'LOAD', 500) } }), 'fake overlay on create');
});
test('R04-R10 client cannot alter overlay load / reps / rest / PID / target / equipment snapshot / operationKey', { timeout: 60000 }, async () => {
  const w = await world(), k = 'ovl_' + w.A.key;
  const attacks = [['load', { ['nextExposureOverlays.' + k + '.appliedValue']: 999 }], ['reps', { 'nextExposureOverlays.ovl_reps.appliedValue': 30 }], ['rest', { 'nextExposureOverlays.ovl_rest.appliedValue': 1 }],
    ['pid', { ['nextExposureOverlays.' + k + '.prescriptionExerciseId']: 'pid-other' }], ['target week', { ['nextExposureOverlays.' + k + '.target.week']: 9 }],
    ['target day', { ['nextExposureOverlays.' + k + '.target.dayIndex']: 3 }], ['equipment snapshot', { ['nextExposureOverlays.' + k + '.equipmentSnapshot.source']: 'FORGED' }],
    ['operationKey', { ['nextExposureOverlays.' + k + '.operationKey']: 'apply:forged' }], ['source exposure', { ['nextExposureOverlays.' + k + '.source.week']: 7 }],
    ['record events / idempotency', { ['progressionApplications.' + w.A.key + '.events']: [] }], ['record key', { ['progressionApplications.' + w.A.key + '.key']: 'v1_0000000000000000' }],
    ['record source', { ['progressionApplications.' + w.A.key + '.source.week']: 5 }]];
  for (const [why, patch] of attacks) await denied(updateDoc(meso(w, 'C'), patch), why);
  await denied(setDoc(meso(w, 'C'), { nextExposureOverlays: { [k]: ovl(w.A.key, 'LOAD', 999) } }, { mergeFields: ['nextExposureOverlays'] }), 'whole-map overwrite');
  const m = await adminMeso(w); assert.equal(m.nextExposureOverlays[k].appliedValue, 102.5);
});
test('R11-R13 client cannot force APPLIED -> REVERTED / OVERRIDDEN / STALE', { timeout: 60000 }, async () => {
  const w = await world(), key = 'progressionApplications.' + w.A.key;
  for (const st of ['REVERTED', 'OVERRIDDEN', 'STALE', 'CONSUMED']) await denied(updateDoc(meso(w, 'C'), { [key + '.state']: st }), 'state -> ' + st);
  await denied(updateDoc(meso(w, 'C'), { ['nextExposureOverlays.ovl_' + w.A.key + '.status']: 'REVERTED' }), 'overlay status');
  assert.equal((await adminMeso(w)).progressionApplications[w.A.key].state, 'APPLIED');
});
test('R14 client cannot resurrect a terminal record (REVERTED -> APPLIED)', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(updateDoc(meso(w, 'C'), { ['progressionApplications.' + w.R.key + '.state']: 'APPLIED' }), 'resurrect');
  await denied(updateDoc(meso(w, 'C'), { ['progressionApplications.' + w.R.key]: rec('APPLIED', w.R.key) }), 'replace terminal record');
  assert.equal((await adminMeso(w)).progressionApplications[w.R.key].state, 'REVERTED');
});
test('R15 client cannot fabricate Coach decision metadata (record lifecycle, summary, clients/coachInterventions)', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(updateDoc(meso(w, 'C'), { ['progressionApplications.' + w.A.key + '.lifecycle.intervention']: { id: 'forged', action: 'KEEP', decidedAt: '2026-10-01T00:00:00.000Z' } }), 'record metadata');
  await denied(updateDoc(meso(w, 'C'), { progressionApplicationSummary: { planId: w.P, autoCount: 9, counts: {}, items: [] } }), 'meso summary');
  await denied(updateDoc(ref(w, 'C', w.root), { progressionApplicationSummary: { planId: w.P, autoCount: 9, counts: {}, items: [] } }), 'root summary');
  await denied(updateDoc(ref(w, 'C', 'clients/' + w.C), { coachInterventions: [{ id: 'forged', targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP' }] }), 'client doc interventions');
});
test('R16 client cannot delete or wholesale replace a document that holds canonical state', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(deleteDoc(meso(w, 'C')), 'delete meso'); await denied(deleteDoc(ref(w, 'C', w.root)), 'delete root');
  await denied(setDoc(meso(w, 'C'), { planId: w.P, entries: {} }), 'replace meso (drops canonical fields)');
  await denied(setDoc(ref(w, 'C', w.root), { planId: w.P, entries: {} }), 'replace root (drops summary)');
  assert.ok((await adminMeso(w)).progressionApplications[w.A.key]);
});

// ------------------------------------------------------------------------------------------------ legitimate CLIENT execution (no regression)
test('L01 client persists execution exactly as _doSaveLogs does (mergeFields on meso and root); canonical state is preserved', { timeout: 60000 }, async () => {
  const w = await world();
  const payload = { entries: { log_1_0_0_s0: { carga: '100', reps: '10', unit: 'KG', done: true, rir_real: 2, ics: 8, pump: 1, prescriptionExerciseId: 'pid-1', ts: 1 },
    log_2_0_0_s0: { carga: '100', reps: '9', unit: 'KG', done: true, rir_real: 1, prescriptionExerciseId: 'pid-1', ts: 2 }, done_2_0: true, postsession_2_0: { eimd: 2, articularPain: { present: false }, ts: 3 },
    progrec_2_0: { calculatedAt: 'x', recommendations: [] }, exskip_2_1_0: { reason: 'pain' } }, currentWeek: 2, planId: w.P, exerciseUnits: { '0_0': 'KG' }, exerciseHistory: { x: { load: '100' } }, updatedAt: Date.now() };
  await allowed(setDoc(meso(w, 'C'), payload, { mergeFields: Object.keys(payload) }), 'meso save');
  await allowed(setDoc(ref(w, 'C', w.root), payload, { mergeFields: Object.keys(payload) }), 'root save');
  const m = await adminMeso(w);
  assert.equal(m.entries.log_2_0_0_s0.reps, '9'); assert.equal(m.currentWeek, 2);
  assert.equal(m.progressionApplications[w.A.key].state, 'APPLIED'); assert.equal(m.nextExposureOverlays['ovl_' + w.A.key].appliedValue, 102.5);
});
test('L02 first save of a brand-new plan creates the meso document (no canonical fields)', { timeout: 60000 }, async () => {
  const w = await world(), p = { entries: { log_1_0_0_s0: { done: true } }, currentWeek: 1, planId: 'plan-n3', exerciseUnits: {}, exerciseHistory: {}, updatedAt: 5 };
  await allowed(setDoc(ref(w, 'C', 'logs/' + w.C + '/mesos/plan-n3'), p, { mergeFields: Object.keys(p) }), 'create');
});
test('L03 fine-grained execution writes (dotted entry updates, notes, RIR, skip, history) are allowed', { timeout: 60000 }, async () => {
  const w = await world();
  await allowed(updateDoc(meso(w, 'C'), { 'entries.log_3_0_0_s0': { carga: '105', reps: '8', unit: 'KG', done: true, rir_real: 0, ics: 7, pump: 2, note: 'ok', prescriptionExerciseId: 'pid-1', ts: 9 } }), 'set');
  await allowed(updateDoc(meso(w, 'C'), { 'entries.exskip_3_1_0': { reason: 'dolor' }, currentWeek: 3, updatedAt: 10, exerciseHistory: { z: { load: '1' } } }), 'skip/history');
  await allowed(updateDoc(ref(w, 'C', w.root), { 'entries.ci_sem_3': { peso: '80', hrv: 60, who5: 20 } }), 'checkin');
});
test('L04 consumption acknowledgement: append-only receipts; existing receipts cannot be changed or removed', { timeout: 60000 }, async () => {
  const w = await world(), r1 = { overlayKey: 'ovl_' + w.A.key, dimension: 'LOAD', appliedValue: 102.5, provenance: 'CANONICAL_OVERLAY', ackAt: '2026-10-01T00:00:00.000Z' };
  await allowed(updateDoc(meso(w, 'C'), { ['consumptionReceipts.' + w.A.key]: r1 }), 'first receipt');
  await allowed(updateDoc(meso(w, 'C'), { 'consumptionReceipts.v1_bbbbbbbbbbbbbbbb': r1 }), 'second receipt (append)');
  await denied(updateDoc(meso(w, 'C'), { ['consumptionReceipts.' + w.A.key]: Object.assign({}, r1, { appliedValue: 1 }) }), 'edit receipt');
  await denied(updateDoc(meso(w, 'C'), { ['consumptionReceipts.' + w.A.key + '.appliedValue']: 1 }), 'edit receipt field');
  await denied(updateDoc(meso(w, 'C'), { consumptionReceipts: {} }), 'wipe receipts');
  assert.equal((await adminMeso(w)).consumptionReceipts[w.A.key].appliedValue, 102.5);
});

// ------------------------------------------------------------------------------------------------ Coach ownership
test('C01 OWNER coach may perform lifecycle writes on its client (state, overlay, summaries)', { timeout: 60000 }, async () => {
  const w = await world();
  await allowed(updateDoc(meso(w, 'O'), { ['progressionApplications.' + w.A.key + '.state']: 'REVERTED', ['nextExposureOverlays.ovl_' + w.A.key + '.status']: 'REVERTED' }), 'owner revert');
  await allowed(updateDoc(meso(w, 'O'), { 'nextExposureOverlays.ovl_new': ovl(w.A.key, 'LOAD', 105) }), 'owner overlay');
  await allowed(updateDoc(ref(w, 'O', w.root), { progressionApplicationSummary: { planId: w.P, autoCount: 0, counts: {}, items: [] } }), 'owner summary');
});
test('C02 UNRELATED coach cannot touch another coach client canonical state (apply / override / revert / stale / summary / delete)', { timeout: 60000 }, async () => {
  const w = await world(), key = 'progressionApplications.' + w.A.key;
  for (const st of ['REVERTED', 'OVERRIDDEN', 'STALE', 'CONSUMED']) await denied(updateDoc(meso(w, 'U'), { [key + '.state']: st }), 'state ' + st);
  await denied(updateDoc(meso(w, 'U'), { 'nextExposureOverlays.ovl_x': ovl(w.A.key, 'LOAD', 300) }), 'overlay create');
  await denied(updateDoc(meso(w, 'U'), { ['nextExposureOverlays.ovl_' + w.A.key + '.appliedValue']: 300 }), 'overlay edit');
  await denied(updateDoc(ref(w, 'U', w.root), { progressionApplicationSummary: { planId: w.P, autoCount: 3, counts: {}, items: [] } }), 'root summary');
  await denied(deleteDoc(meso(w, 'U')), 'delete');
  await denied(updateDoc(ref(w, 'U', 'clients/' + w.C), { coachInterventions: [{ id: 'x' }] }), 'client doc');
  assert.equal((await adminMeso(w)).progressionApplications[w.A.key].state, 'APPLIED');
});
test('C03 a self-registered pseudo-coach (client creates its own coaches/{uid} doc) gains NO canonical authority over its own or others logs', { timeout: 60000 }, async () => {
  const w = await world();
  await adminDb.doc('coaches/' + w.C).set({ role: 'coach' });   // what any authenticated user can do today under the coaches rule
  await denied(updateDoc(meso(w, 'C'), { ['progressionApplications.' + w.A.key + '.state']: 'REVERTED' }), 'pseudo-coach on its own client (coachId is the real owner)');
  await denied(updateDoc(meso(w, 'C'), { 'nextExposureOverlays.ovl_forged': ovl(w.A.key, 'LOAD', 999) }), 'pseudo-coach overlay');
});
test('C04 stranger (neither the client nor any coach) can read or write nothing under logs', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(getDoc(meso(w, 'S')), 'read'); await denied(updateDoc(meso(w, 'S'), { currentWeek: 9 }), 'write'); await denied(setDoc(ref(w, 'S', w.root), { currentWeek: 9 }, { merge: true }), 'root write');
});
test('C05 legacy Coach log operations keep working for the OWNER coach; an unrelated coach is denied (T538 tenant isolation)', { timeout: 60000 }, async () => {
  const w = await world();
  await allowed(updateDoc(ref(w, 'O', w.root), { currentWeek: 3, updatedAt: Date.now() }), 'owner week');
  await denied(updateDoc(ref(w, 'U', w.root), { currentWeek: 4, updatedAt: Date.now() }), 'unrelated coach: evidence fields are tenant-private');
});

// ------------------------------------------------------------------------------------------------ equipment metadata
test('E01 equipment increments: only the owning coach writes coaches/{uid}.equipmentIncrements; athletes and other coaches cannot', { timeout: 60000 }, async () => {
  const w = await world(), inc = { shared: { 'functional-dumbbells': { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} };
  await allowed(updateDoc(ref(w, 'O', 'coaches/' + w.O), { equipmentIncrements: inc }), 'owner coach');
  await denied(updateDoc(ref(w, 'U', 'coaches/' + w.O), { equipmentIncrements: inc }), 'other coach');
  await denied(updateDoc(ref(w, 'C', 'coaches/' + w.O), { equipmentIncrements: inc }), 'athlete');
  await denied(setDoc(ref(w, 'C', 'coaches/' + w.O), { equipmentIncrements: inc }, { merge: true }), 'athlete merge');
});
test('E02 exercise catalog: loadIncrement / any exercise field is writable only by the coach that owns the exercise (or claims a legacy one)', { timeout: 60000 }, async () => {
  const w = await world(), inc = { kind: 'STEP', step: 2.5, unit: 'KG', source: 'EXERCISE_METADATA' };
  await allowed(updateDoc(ref(w, 'O', w.ex), { loadIncrement: inc }), 'owner');
  await denied(updateDoc(ref(w, 'U', w.ex), { loadIncrement: inc }), 'unrelated coach');
  await denied(updateDoc(ref(w, 'C', w.ex), { loadIncrement: inc }), 'athlete');
  await adminDb.doc('coaches/' + w.C).set({ role: 'coach' });
  await denied(updateDoc(ref(w, 'C', w.ex), { loadIncrement: inc }), 'pseudo-coach');
  await denied(deleteDoc(ref(w, 'U', w.ex)), 'unrelated delete');
  await allowed(addDoc(collection(w.db.U, 'exercises'), { name: 'mine', coachId: w.U }), 'a coach creates its own exercise');
  await denied(addDoc(collection(w.db.U, 'exercises'), { name: 'spoof', coachId: w.O }), 'cannot create exercises in another coach namespace');
  await denied(addDoc(collection(w.db.S, 'exercises'), { name: 'athlete', coachId: w.S, loadIncrement: inc }), 'athlete without a coach document');
});
