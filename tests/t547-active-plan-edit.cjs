// T547: ACTIVE PLAN OWNER EDIT (real emulator + repository firestore.rules).
// The Coach editor (saveTrainingPlan), quick-add, update-plan modal and extend/shrink weeks all UPDATE the active plan of one of the Coach's own
// clients. The T538 rules made `status == 'active'` (and `draft_approved`) immutable, so every one of those paths returned PERMISSION_DENIED.
// Contract: the OWNER Coach may revise the prescription of its own ACTIVE plan; nobody else may write it; coachId / clientId are immutable in the edit
// path; a plan can only be re-pointed (clientId-only migration) to a client the same Coach owns; delete behaviour is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, deleteField } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't547-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

async function as(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't547-' + apps.length);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  if (uid) connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid } }); else connectFirestoreEmulator(db, host, Number(port));
  return db;
}
const denied = async (p, why) => { try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; } assert.fail('expected PERMISSION_DENIED: ' + why); };
const allowed = async (p, why) => { try { return await p; } catch (e) { assert.fail('expected ALLOWED (' + why + '): ' + e.code + ' ' + e.message); } };

const DAYS = [{ dayIndex: 0, label: 'D1', exercises: [{ exerciseName: 'Press', prescriptionExerciseId: 'pid-1', sets: [3, 2, 2].map((r, i) => ({ setIndex: i, repsTarget: 8, rirTarget: r, restSeconds: 120 })) }] }];
const EDITED = [{ dayIndex: 0, label: 'D1', exercises: [{ exerciseName: 'Press', prescriptionExerciseId: 'pid-1', sets: [3, 2, 1].map((r, i) => ({ setIndex: i, repsTarget: 8, rirTarget: r, restSeconds: 120 })) }] }];

async function world() {
  const id = randomUUID().slice(0, 8), O = 'own-' + id, X = 'oth-' + id, M = 'mal-' + id, C = 'cli-' + id, C2 = 'cli2-' + id, CX = 'clix-' + id;
  const P = 'plan-act-' + id, PD = 'plan-dap-' + id, PD2 = 'plan-dap2-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach' }); await adminDb.doc('coaches/' + X).set({ role: 'coach' }); await adminDb.doc('coaches/' + M).set({ role: 'coach' });
  await adminDb.doc('clients/' + C).set({ coachId: O, email: 'a@x.com', activePlanId: P });
  await adminDb.doc('clients/' + C2).set({ coachId: O, email: 'b@x.com', activePlanId: PD });
  await adminDb.doc('clients/' + CX).set({ coachId: X, email: 'c@x.com', activePlanId: null });
  const base = { weeks: 6, daysPerWeek: 1, days: DAYS, createdAt: '2026-09-27T13:13:01.547Z', updatedAt: '2026-09-27T13:13:01.547Z', generatedBy: 'import' };
  await adminDb.doc('plans/' + P).set(Object.assign({}, base, { coachId: O, clientId: C, status: 'active' }));                 // ACTIVE (status), referenced by the client
  await adminDb.doc('plans/' + PD).set(Object.assign({}, base, { coachId: O, clientId: C2, status: 'draft_approved' }));      // AI plan: stays draft_approved while ACTIVE for the client
  await adminDb.doc('plans/' + PD2).set(Object.assign({}, base, { coachId: O, clientId: C2, status: 'draft_approved' }));     // approved draft that is NOT active: immutable source of truth
  const w = { id, O, X, M, C, C2, CX, P, PD, PD2 };
  w.db = { O: await as(O), X: await as(X), M: await as(M), C: await as(C), U: await as(null) };
  return w;
}
const R = (w, who, p) => doc(w.db[who], p);
const NOW = () => new Date().toISOString();

test('T547.R1 OWNER Coach may revise the prescription of its own ACTIVE plan (status active)', { timeout: 60000 }, async () => {
  const w = await world();
  await allowed(updateDoc(R(w, 'O', 'plans/' + w.P), { days: EDITED, daysPerWeek: 1, coachId: w.O, updatedAt: NOW() }), 'saveTrainingPlan-shaped update');
  await allowed(updateDoc(R(w, 'O', 'plans/' + w.P), { weeks: 7, rirByWeek: { 1: 3 }, updatedAt: NOW() }), 'extend weeks');
  const s = (await adminDb.doc('plans/' + w.P).get()).data();
  assert.equal(s.createdAt, '2026-09-27T13:13:01.547Z', 'createdAt untouched'); assert.equal(s.clientId, w.C); assert.equal(s.coachId, w.O);
  assert.deepEqual(s.days[0].exercises[0].sets.map(x => x.rirTarget), [3, 2, 1]);
});

test('T547.R2 OWNER Coach may revise an AI plan that is ACTIVE for its client (draft_approved + clients.activePlanId); a NON-active approved draft stays immutable', { timeout: 60000 }, async () => {
  const w = await world();
  await allowed(updateDoc(R(w, 'O', 'plans/' + w.PD), { days: EDITED, updatedAt: NOW() }), 'active draft_approved plan');
  await denied(updateDoc(R(w, 'O', 'plans/' + w.PD2), { days: EDITED, updatedAt: NOW() }), 'non-active draft_approved plan is the immutable approved source');
});

test('T547.R3 nobody else can write the plan: other Coach, self-created Coach, the athlete, unauthenticated', { timeout: 60000 }, async () => {
  const w = await world();
  for (const who of ['X', 'M', 'C', 'U']) await denied(updateDoc(R(w, who, 'plans/' + w.P), { days: EDITED, updatedAt: NOW() }), who + ' updates the active plan');
  for (const who of ['X', 'M', 'C', 'U']) await denied(setDoc(R(w, who, 'plans/' + w.P), { coachId: who === 'X' ? w.X : 'x', clientId: w.C, status: 'active', days: [] }), who + ' overwrites the active plan');
  const s = (await adminDb.doc('plans/' + w.P).get()).data();
  assert.deepEqual(s.days, DAYS, 'content untouched');
});

test('T547.R4 ownership identity is immutable in the edit path: coachId / clientId changes and coachId removal are denied', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(updateDoc(R(w, 'O', 'plans/' + w.P), { days: EDITED, coachId: w.X }), 'hand the plan to another Coach');
  await denied(updateDoc(R(w, 'O', 'plans/' + w.P), { days: EDITED, clientId: w.C2 }), 'clientId change together with an edit');
  await denied(updateDoc(R(w, 'O', 'plans/' + w.P), { days: EDITED, clientId: w.CX }), 'cross-tenant clientId together with an edit');
  await denied(updateDoc(R(w, 'O', 'plans/' + w.P), { coachId: 'someone-else' }), 'coachId-only change');
  await denied(updateDoc(R(w, 'O', 'plans/' + w.P), { coachId: deleteField() }), 'coachId removal');
  const s = (await adminDb.doc('plans/' + w.P).get()).data(); assert.equal(s.coachId, w.O); assert.equal(s.clientId, w.C);
});

test('T547.R5 cross-tenant adoption is denied: a plan can only be re-pointed (clientId-only migration) to a client the SAME Coach owns', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(updateDoc(R(w, 'O', 'plans/' + w.P), { clientId: w.CX }), 'adopt into another tenant client (the client could then read the plan)');
  await denied(updateDoc(R(w, 'O', 'plans/' + w.P), { clientId: 'does-not-exist-' + w.id }), 'unknown target client');
  await allowed(updateDoc(R(w, 'O', 'plans/' + w.P), { clientId: w.C2 }), 'documented UID-migration: clientId-only to an own client');
});

test('T547.R6 delete and create behaviour are unchanged: an active plan cannot be deleted; a plan cannot be created under another coachId', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(deleteDoc(R(w, 'O', 'plans/' + w.P)), 'owner cannot delete an active plan');
  await denied(deleteDoc(R(w, 'X', 'plans/' + w.P)), 'other coach cannot delete');
  await denied(addDoc(collection(w.db.O, 'plans'), { coachId: w.X, clientId: w.C, status: 'active', days: [] }), 'create under another coachId');
  await allowed(addDoc(collection(w.db.O, 'plans'), { coachId: w.O, clientId: w.C, status: 'active', days: [], createdAt: NOW(), updatedAt: NOW() }), 'create own plan');
});

test('T547.R7 reads are unchanged: owner and the athlete read the plan; other coach and unauthenticated cannot', { timeout: 60000 }, async () => {
  const w = await world();
  await allowed(getDoc(R(w, 'O', 'plans/' + w.P)), 'owner'); await allowed(getDoc(R(w, 'C', 'plans/' + w.P)), 'athlete');
  await denied(getDoc(R(w, 'X', 'plans/' + w.P)), 'other coach'); await denied(getDoc(R(w, 'U', 'plans/' + w.P)), 'unauth');
});
