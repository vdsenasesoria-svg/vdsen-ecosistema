// T558 (release preparation): REAL production topology rehearsal against the repository firestore.rules (emulator only; nothing production).
// The exported production plan of the athlete Ayrton has coachId == clientId (the SAME Firebase uid is both Coach and athlete). Every staging rehearsal so far used
// SEPARATE coach / athlete uids. This suite proves what the T537-T552 rules do for the same-uid topology, and what an ORPHAN client (no coachId) can no longer do.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, updateDoc, addDoc, collection, getDocs, query, where } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
const adminApp = initAdmin({ projectId }, 't558-admin'); const adminDb = getAdminFirestore(adminApp); const apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });
async function as(uid) { const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't558-' + apps.length); apps.push(app); const db = getFirestore(app); const [h, p] = process.env.FIRESTORE_EMULATOR_HOST.split(':'); connectFirestoreEmulator(db, h, Number(p), { mockUserToken: { sub: uid } }); return db; }
const denied = async (p, why) => { try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; } assert.fail('expected PERMISSION_DENIED: ' + why); };
const allowed = async (p, why) => { try { return await p; } catch (e) { assert.fail('expected ALLOWED (' + why + '): ' + e.code + ' ' + e.message); } };
const NOW = () => new Date().toISOString();
async function world(opts) {
  opts = opts || {}; const id = randomUUID().slice(0, 8), U = 'self-' + id, X = 'oth-' + id, PLAN = 'plan-' + id;
  await adminDb.doc('coaches/' + U).set({ role: 'coach' }); await adminDb.doc('coaches/' + X).set({ role: 'coach' });
  await adminDb.doc('clients/' + U).set(opts.orphan ? { email: 'a@x.com' } : { coachId: U, email: 'a@x.com', activePlanId: PLAN });
  await adminDb.doc('plans/' + PLAN).set({ coachId: U, clientId: U, status: 'active', weeks: 6, daysPerWeek: 1, days: [], createdAt: NOW(), updatedAt: NOW() });   // the production shape: coachId == clientId
  return { U, X, PLAN, id, db: { U: await as(U), X: await as(X) } };
}
test('T558.1 SAME-UID Coach + athlete: reads its client doc, its plan, and its own logs (athlete path)', async () => {
  const w = await world(); await allowed(getDoc(doc(w.db.U, 'clients/' + w.U)), 'client doc'); await allowed(getDoc(doc(w.db.U, 'plans/' + w.PLAN)), 'plan');
  await allowed(setDoc(doc(w.db.U, 'logs/' + w.U), { planId: w.PLAN, currentWeek: 1, entries: { log_1_0_0_s0: { done: true, carga: '40', reps: '8' } } }, { mergeFields: ['planId', 'currentWeek', 'entries'] }), 'root log write');
  await allowed(setDoc(doc(w.db.U, 'logs/' + w.U + '/mesos/' + w.PLAN), { planId: w.PLAN, currentWeek: 1, entries: { log_1_0_0_s0: { done: true } } }, { mergeFields: ['planId', 'currentWeek', 'entries'] }), 'meso write'); await allowed(getDoc(doc(w.db.U, 'logs/' + w.U + '/mesos/' + w.PLAN)), 'meso read');
});
test('T558.2 SAME-UID Coach: edits the active plan (coachId == auth.uid), lists its plans, updates its client doc', async () => {
  const w = await world(); await allowed(updateDoc(doc(w.db.U, 'plans/' + w.PLAN), { weeks: 7, updatedAt: NOW() }), 'owner edit of the active plan');
  const snap = await allowed(getDocs(query(collection(w.db.U, 'plans'), where('coachId', '==', w.U))), 'coach plan list'); assert.ok(snap.docs.some(d => d.id === w.PLAN));
  await allowed(updateDoc(doc(w.db.U, 'clients/' + w.U), { nutritionPlan: { calorias: '2500', texto: 'x' } }), 'coach writes the client doc');
  await allowed(addDoc(collection(w.db.U, 'plans'), { coachId: w.U, clientId: w.U, status: 'active', weeks: 6, daysPerWeek: 1, days: [], createdAt: NOW(), updatedAt: NOW() }), 'create a plan for its own client doc (ownsClient)');
});
test('T558.3 the same-uid topology does not widen anything: ANOTHER coach cannot read / edit that plan, client, or logs', async () => {
  const w = await world(); await denied(getDoc(doc(w.db.X, 'plans/' + w.PLAN)), 'other coach plan read'); await denied(updateDoc(doc(w.db.X, 'plans/' + w.PLAN), { weeks: 9 }), 'other coach plan edit');
  await denied(getDoc(doc(w.db.X, 'clients/' + w.U)), 'other coach client read'); await denied(getDoc(doc(w.db.X, 'logs/' + w.U)), 'other coach logs read'); await denied(setDoc(doc(w.db.X, 'logs/' + w.U), { entries: {} }), 'other coach logs write');
});
test('T558.4 ORPHAN client (no coachId on clients/{uid}): the athlete still trains (own plan + logs) but the Coach can NO LONGER read / write that client doc (admin recovery only)', async () => {
  const w = await world({ orphan: true }); await allowed(getDoc(doc(w.db.U, 'plans/' + w.PLAN)), 'athlete reads its plan (clientId == uid)');
  await allowed(setDoc(doc(w.db.U, 'logs/' + w.U + '/mesos/' + w.PLAN), { planId: w.PLAN, currentWeek: 1, entries: {} }, { mergeFields: ['planId', 'currentWeek', 'entries'] }), 'athlete writes its own meso');
  await allowed(getDoc(doc(w.db.U, 'clients/' + w.U)), 'a uid always reads its OWN client doc'); await denied(getDoc(doc(w.db.X, 'clients/' + w.U)), 'another coach never reads an unowned client');
  await denied(addDoc(collection(w.db.U, 'plans'), { coachId: w.U, clientId: w.U, status: 'active', weeks: 6, daysPerWeek: 1, days: [], createdAt: NOW(), updatedAt: NOW() }), 'plan CREATE for a client without coachId is refused (ownsClient)');
});
