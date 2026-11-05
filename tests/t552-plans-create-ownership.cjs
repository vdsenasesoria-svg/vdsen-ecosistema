// T552: plans CREATE must prove tenant ownership of the target client (real emulator + repository firestore.rules).
// Before: only `coachId == auth.uid` was checked, so any coach doc (self-creatable) could create a plan whose clientId points at ANOTHER coach's client
// (the client app reads plans where clientId == its uid => the plan would be delivered to a foreign client). After: clientId must reference an EXISTING
// client owned by the creating coach, and coachId must be the creator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, addDoc, collection } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
const adminApp = initAdmin({ projectId }, 't552-admin'); const adminDb = getAdminFirestore(adminApp); const apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });
async function as(uid) { const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't552-' + apps.length); apps.push(app); const db = getFirestore(app); const [h, p] = process.env.FIRESTORE_EMULATOR_HOST.split(':'); if (uid) connectFirestoreEmulator(db, h, Number(p), { mockUserToken: { sub: uid } }); else connectFirestoreEmulator(db, h, Number(p)); return db; }
const denied = async (p, why) => { try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; } assert.fail('expected PERMISSION_DENIED: ' + why); };
const allowed = async (p, why) => { try { return await p; } catch (e) { assert.fail('expected ALLOWED (' + why + '): ' + e.code + ' ' + e.message); } };
const NOW = () => new Date().toISOString();
const plan = (coachId, clientId, extra) => Object.assign({ coachId, clientId, status: 'active', weeks: 6, daysPerWeek: 1, days: [], createdAt: NOW(), updatedAt: NOW() }, extra || {});
async function world() {
  const id = randomUUID().slice(0, 8), O = 'own-' + id, X = 'oth-' + id, M = 'mal-' + id, C = 'cli-' + id, CX = 'clix-' + id, C2 = 'cli2-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach' }); await adminDb.doc('coaches/' + X).set({ role: 'coach' }); await adminDb.doc('coaches/' + M).set({ role: 'coach' });   // M = self-promoted coach doc
  await adminDb.doc('clients/' + C).set({ coachId: O, email: 'a@x.com' }); await adminDb.doc('clients/' + C2).set({ coachId: O, email: 'a2@x.com' }); await adminDb.doc('clients/' + CX).set({ coachId: X, email: 'x@x.com' });
  return { O, X, M, C, C2, CX, id, db: { O: await as(O), X: await as(X), M: await as(M), C: await as(C), U: await as(null) } };
}
const create = (w, who, data) => addDoc(collection(w.db[who], 'plans'), data);

test('T552.C1 OWNER coach may create a plan for its OWN client', async () => {
  const w = await world(); await allowed(create(w, 'O', plan(w.O, w.C)), 'own client'); await allowed(create(w, 'O', plan(w.O, w.C2, { status: 'draft_approved' })), 'own client, other status');
  await allowed(setDoc(doc(w.db.O, 'plans/plan-' + w.id), plan(w.O, w.C)), 'setDoc with an explicit id');
});
test('T552.C2 OWNER coach cannot create a plan for ANOTHER coach\'s client (the foreign client would receive it)', async () => {
  const w = await world(); await denied(create(w, 'O', plan(w.O, w.CX)), 'other coach client'); await denied(setDoc(doc(w.db.O, 'plans/plan-x-' + w.id), plan(w.O, w.CX)), 'setDoc other coach client');
});
test('T552.C3 clientId must reference an EXISTING client: unknown / missing / empty / non-string clientId are denied', async () => {
  const w = await world(); await denied(create(w, 'O', plan(w.O, 'does-not-exist-' + w.id)), 'unknown client');
  const noClient = plan(w.O, w.C); delete noClient.clientId; await denied(create(w, 'O', noClient), 'missing clientId');
  await denied(create(w, 'O', plan(w.O, '')), 'empty clientId'); await denied(create(w, 'O', plan(w.O, null)), 'null clientId'); await denied(create(w, 'O', plan(w.O, 123)), 'non-string clientId');
});
test('T552.C4 OTHER coach: cannot create for the owner\'s client (own coachId) nor forge coachId = owner', async () => {
  const w = await world(); await denied(create(w, 'X', plan(w.X, w.C)), 'other coach, own coachId, foreign client'); await denied(create(w, 'X', plan(w.O, w.C)), 'forged coachId = owner');
  await allowed(create(w, 'X', plan(w.X, w.CX)), 'control: the other coach\'s own client');
});
test('T552.C5 SELF-PROMOTED coach doc cannot bypass tenant ownership (isCoachUser alone grants nothing)', async () => {
  const w = await world(); await denied(create(w, 'M', plan(w.M, w.C)), 'self-promoted coach, victim client'); await denied(create(w, 'M', plan(w.O, w.C)), 'self-promoted coach forging coachId');
  await denied(create(w, 'M', plan(w.M, 'does-not-exist-' + w.id)), 'self-promoted coach, unknown client');
});
test('T552.C6 ATHLETE and UNAUTHENTICATED users cannot create plans', async () => {
  const w = await world(); await denied(create(w, 'C', plan(w.O, w.C)), 'athlete forging coachId'); await denied(create(w, 'C', plan(w.C, w.C)), 'athlete as its own coach'); await denied(create(w, 'U', plan(w.O, w.C)), 'unauthenticated');
});
test('T552.C7 existing create guards stay: coachId must be the creator; farmacologia / pharmacoPlan still refused', async () => {
  const w = await world(); await denied(create(w, 'O', plan(w.X, w.C)), 'coachId of another coach'); await denied(create(w, 'O', plan(w.O, w.C, { farmacologia: {} })), 'farmacologia'); await denied(create(w, 'O', plan(w.O, w.C, { pharmacoPlan: {} })), 'pharmacoPlan');
});
test('T552.C8 update / delete behaviour unchanged (T547): owner still edits its active plan; nobody else does; the clientId-only migration still needs an owned target', async () => {
  const w = await world(); const ref = await create(w, 'O', plan(w.O, w.C)); const { updateDoc } = require('firebase/firestore');
  await allowed(updateDoc(doc(w.db.O, 'plans/' + ref.id), { weeks: 7, updatedAt: NOW() }), 'owner edit'); await denied(updateDoc(doc(w.db.X, 'plans/' + ref.id), { weeks: 8 }), 'other coach edit');
  await denied(updateDoc(doc(w.db.O, 'plans/' + ref.id), { clientId: w.CX }), 'adopt into foreign client'); await allowed(updateDoc(doc(w.db.O, 'plans/' + ref.id), { clientId: w.C2 }), 'migrate to own client');
});
