// T549: athlete exercise-note evidence (`exnotepid_*` + the `exnote_W_D_E` mirror inside logs entries). Real emulator + repository firestore.rules.
// The athlete writes only its own log doc; the owner Coach reads it; other athlete / other Coach are denied. No rules change is needed for notes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
const adminApp = initAdmin({ projectId }, 't549-admin'); const adminDb = getAdminFirestore(adminApp); const apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });
async function as(uid) { const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't549-' + apps.length); apps.push(app); const db = getFirestore(app); const [h, p] = process.env.FIRESTORE_EMULATOR_HOST.split(':'); connectFirestoreEmulator(db, h, Number(p), { mockUserToken: { sub: uid } }); return db; }
const denied = async (p, why) => { try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; } assert.fail('expected PERMISSION_DENIED: ' + why); };
const allowed = async (p, why) => { try { return await p; } catch (e) { assert.fail('expected ALLOWED (' + why + '): ' + e.code + ' ' + e.message); } };
const NOTE = { planId: 'planA', prescriptionExerciseId: 'pid-1', week: 1, day: 1, exerciseIndex: 0, exerciseNameSnapshot: 'Press', text: 'Mejor control con 80 kg', updatedAt: Date.now() };
async function world() {
  const id = randomUUID().slice(0, 8), O = 'own-' + id, X = 'oth-' + id, A = 'ath-' + id, B = 'ath2-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach' }); await adminDb.doc('coaches/' + X).set({ role: 'coach' });
  await adminDb.doc('clients/' + A).set({ coachId: O, email: 'a@x.com' }); await adminDb.doc('clients/' + B).set({ coachId: X, email: 'b@x.com' });
  return { A, B, O, X, db: { A: await as(A), B: await as(B), O: await as(O), X: await as(X) } };
}
const payload = { entries: { exnotepid_1_pidx: NOTE, exnote_1_1_0: NOTE.text }, currentWeek: 1, planId: 'planA', updatedAt: Date.now() };

test('T549.S1 the athlete writes its own note evidence (root log + meso log) with the CURRENT rules; no rules change is needed', async () => {
  const w = await world();
  await allowed(setDoc(doc(w.db.A, 'logs/' + w.A), payload, { mergeFields: Object.keys(payload) }), 'athlete writes root log');
  await allowed(setDoc(doc(w.db.A, 'logs/' + w.A + '/mesos/planA'), payload, { mergeFields: Object.keys(payload) }), 'athlete writes meso log');
  const s = (await adminDb.doc('logs/' + w.A).get()).data(); assert.equal(s.entries.exnotepid_1_pidx.text, 'Mejor control con 80 kg');
});
test('T549.S2 reads: the athlete and the OWNER coach; other athlete and other Coach are denied', async () => {
  const w = await world(); await adminDb.doc('logs/' + w.A).set(payload);
  await allowed(getDoc(doc(w.db.A, 'logs/' + w.A)), 'self'); await allowed(getDoc(doc(w.db.O, 'logs/' + w.A)), 'owner coach');
  await denied(getDoc(doc(w.db.B, 'logs/' + w.A)), 'other athlete'); await denied(getDoc(doc(w.db.X, 'logs/' + w.A)), 'other coach');
});
test('T549.S3 writes: another athlete / another Coach cannot write or overwrite the note evidence', async () => {
  const w = await world(); await adminDb.doc('logs/' + w.A).set(payload);
  const forged = { entries: { exnotepid_1_pidx: Object.assign({}, NOTE, { text: 'forged' }) }, updatedAt: 1 };
  await denied(setDoc(doc(w.db.B, 'logs/' + w.A), forged, { mergeFields: ['entries', 'updatedAt'] }), 'other athlete writes A log');
  await denied(setDoc(doc(w.db.X, 'logs/' + w.A), forged, { mergeFields: ['entries', 'updatedAt'] }), 'other coach writes A log');
  assert.equal((await adminDb.doc('logs/' + w.A).get()).data().entries.exnotepid_1_pidx.text, 'Mejor control con 80 kg', 'note untouched');
});
test('T549.S4 note keys never reach canonical progression state (the athlete still cannot write progressionApplications next to a note)', async () => {
  const w = await world();
  await denied(setDoc(doc(w.db.A, 'logs/' + w.A), { entries: payload.entries, progressionApplications: { x: { state: 'APPLIED' } } }, { mergeFields: ['entries', 'progressionApplications'] }), 'canonical field with a note');
});
