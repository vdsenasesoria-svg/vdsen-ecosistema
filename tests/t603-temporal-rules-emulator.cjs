// T603: REAL Firestore (emulator + repository firestore.rules). The two temporal authorities that cannot be trusted to a device clock:
//   - logs/{uid}/starts/{plan_week_day_exercise}: the exposure start marker (athlete, immutable, `at` forced to request.time, only after the working set is persisted)
//   - clients/{uid}/decisions/{interventionId}: the Coach decision record (owner Coach, immutable, `at` forced to request.time)
// Synthetic users only. Rules are NOT deployed anywhere by this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
const adminApp = initAdmin({ projectId }, 't603-admin'), adminDb = getAdminFirestore(adminApp), apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });
async function as(uid) { const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't603-' + apps.length); apps.push(app); const db = getFirestore(app); const [h, p] = process.env.FIRESTORE_EMULATOR_HOST.split(':'); connectFirestoreEmulator(db, h, Number(p), { mockUserToken: { sub: uid } }); return db; }
const denied = async (p, why) => { try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; } assert.fail('expected PERMISSION_DENIED: ' + why); };
const allowed = async (p, why) => { try { return await p; } catch (e) { assert.fail('expected ALLOWED (' + why + '): ' + e.code + ' ' + e.message); } };
const SET = { done: true, carga: '100', reps: '10', unit: 'KG', prescriptionExerciseId: 'pid-1', ts: 1 };
async function world() {
  const id = randomUUID().slice(0, 8), O = 'own-' + id, X = 'oth-' + id, A = 'ath-' + id, B = 'ath2-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach' }); await adminDb.doc('coaches/' + X).set({ role: 'coach' });
  await adminDb.doc('clients/' + A).set({ coachId: O }); await adminDb.doc('clients/' + B).set({ coachId: X });
  return { A, B, O, X, planId: 'plan-' + id, db: { A: await as(A), B: await as(B), O: await as(O), X: await as(X) } };
}
const marker = (w, o) => Object.assign({ planId: w.planId, week: 2, dayIndex: 0, exerciseIndex: 0, setKey: 'log_2_0_0_s0', at: serverTimestamp() }, o || {});
const mid = (w, week, day, ex) => w.planId + '_' + (week === undefined ? 2 : week) + '_' + (day === undefined ? 0 : day) + '_' + (ex === undefined ? 0 : ex);
const persistSet = (w, key, entry) => adminDb.doc('logs/' + w.A + '/mesos/' + w.planId).set({ planId: w.planId, entries: { [key || 'log_2_0_0_s0']: entry || SET } }, { merge: true });

test('T603.M1 valid marker: created by the athlete AFTER the set is persisted; `at` is the database time, not the device clock', async () => {
  const w = await world(); await persistSet(w);
  const before = Date.now() - 2000;
  await allowed(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w)), marker(w)), 'marker after the persisted working set');
  const m = (await adminDb.doc('logs/' + w.A + '/starts/' + mid(w)).get()).data();
  assert.ok(m.at.toMillis() >= before && m.at.toMillis() <= Date.now() + 2000, 'server time');
  await allowed(getDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w))), 'athlete reads'); await allowed(getDoc(doc(w.db.O, 'logs/' + w.A + '/starts/' + mid(w))), 'owner coach reads');
  await denied(getDoc(doc(w.db.B, 'logs/' + w.A + '/starts/' + mid(w))), 'other athlete'); await denied(getDoc(doc(w.db.X, 'logs/' + w.A + '/starts/' + mid(w))), 'other coach');
});
test('T603.M2 FORGED timestamps are rejected: a past/future client Timestamp, a number, an ISO string, a null', async () => {
  const w = await world(); await persistSet(w);
  for (const [why, at] of [['past Timestamp (backdated start)', Timestamp.fromMillis(Date.now() - 3600000)], ['future Timestamp (delayed start)', Timestamp.fromMillis(Date.now() + 3600000)], ['now() as a client Timestamp', Timestamp.now()],
    ['number', Date.now() - 5000], ['ISO string', '2020-01-01T00:00:00.000Z'], ['null', null]])
    await denied(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w)), marker(w, { at })), why);
  const missing = marker(w); delete missing.at; await denied(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w)), missing), 'absent timestamp');
});
test('T603.M3 a marker cannot be created before the working set exists, for a set that is not "done", or pointing at another exposure', async () => {
  const w = await world();
  await denied(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w)), marker(w)), 'no set persisted yet (cannot pre-create / advance a future exposure)');
  await persistSet(w, 'log_2_0_0_s0', Object.assign({}, SET, { done: false }));
  await denied(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w)), marker(w)), 'set not done');
  await persistSet(w);
  await denied(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w, 2, 0, 1)), marker(w, { exerciseIndex: 1, setKey: 'log_2_0_1_s0' })), 'other exercise has no persisted set');
  await denied(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w)), marker(w, { setKey: 'log_3_0_0_s0' })), 'setKey of another exposure');
  await denied(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w, 3, 0, 0)), marker(w)), 'document id does not match week/day/exercise');
  await denied(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w)), marker(w, { extra: 1 })), 'extra field');
});
test('T603.M4 immutable and single: no update, no delete, a second device cannot move or recreate it; nobody else can create one', async () => {
  const w = await world(); await persistSet(w);
  const ref = (d) => doc(d, 'logs/' + w.A + '/starts/' + mid(w));
  await allowed(setDoc(ref(w.db.A), marker(w)), 'first creation');
  const first = (await adminDb.doc('logs/' + w.A + '/starts/' + mid(w)).get()).data().at.toMillis();
  await denied(setDoc(ref(w.db.A), marker(w)), 'second device re-creates (would move the start)');
  await denied(updateDoc(ref(w.db.A), { at: serverTimestamp() }), 'update'); await denied(deleteDoc(ref(w.db.A)), 'delete');
  assert.equal((await adminDb.doc('logs/' + w.A + '/starts/' + mid(w)).get()).data().at.toMillis(), first);
  const v = await world(); await persistSet(v);
  await denied(setDoc(doc(v.db.O, 'logs/' + v.A + '/starts/' + mid(v)), marker(v)), 'the owner Coach cannot create athlete evidence');
  await denied(setDoc(doc(v.db.B, 'logs/' + v.A + '/starts/' + mid(v)), marker(v)), 'another athlete'); await denied(setDoc(doc(v.db.X, 'logs/' + v.A + '/starts/' + mid(v)), marker(v)), 'another coach');
});
test('T603.M5 offline ordering: the log write and then the marker, queued in order, both commit (the marker rule reads the committed log)', async () => {
  const w = await world(); const p = 'logs/' + w.A + '/mesos/' + w.planId;
  await allowed(setDoc(doc(w.db.A, p), { planId: w.planId, entries: { log_2_0_0_s0: SET } }, { mergeFields: ['planId', new (require('firebase/firestore').FieldPath)('entries', 'log_2_0_0_s0')] }), 'log write first');
  await allowed(setDoc(doc(w.db.A, 'logs/' + w.A + '/starts/' + mid(w)), marker(w)), 'marker second');
});
test('T603.M6 the training record is NEVER lost: the athlete may still write a forged `sts` (rules cannot iterate entries) but it carries no authority — the log persists as written', async () => {
  const w = await world(); const forged = Object.assign({}, SET, { sts: Timestamp.fromMillis(Date.now() - 86400000) });
  await allowed(setDoc(doc(w.db.A, 'logs/' + w.A + '/mesos/' + w.planId), { planId: w.planId, entries: { log_2_0_0_s0: forged } }, { merge: true }), 'free-form entries (execution truth belongs to the athlete)');
  assert.equal((await adminDb.doc('logs/' + w.A + '/mesos/' + w.planId).get()).data().entries.log_2_0_0_s0.carga, '100');
});
const DEC = (w, id, o) => Object.assign({ id, targetType: 'EXERCISE', targetId: 'pid-1', planId: w.planId, action: 'MODIFY', decidedBy: w.O, at: serverTimestamp() }, o || {});
test('T603.D1 Coach decision record: owner Coach creates it with the database time; forged times, wrong actor, extra fields and other principals are denied', async () => {
  const w = await world(), ref = (d, id) => doc(d, 'clients/' + w.A + '/decisions/' + id);
  await allowed(setDoc(ref(w.db.O, 'iv-1'), DEC(w, 'iv-1')), 'owner coach');
  const at = (await adminDb.doc('clients/' + w.A + '/decisions/iv-1').get()).data().at.toMillis(); assert.ok(Math.abs(at - Date.now()) < 5000, 'server time');
  await denied(setDoc(ref(w.db.O, 'iv-2'), DEC(w, 'iv-2', { at: Timestamp.fromMillis(Date.now() - 3600000) })), 'backdated decision'); await denied(setDoc(ref(w.db.O, 'iv-3'), DEC(w, 'iv-3', { at: '2020-01-01T00:00:00.000Z' })), 'ISO string');
  await denied(setDoc(ref(w.db.O, 'iv-4'), DEC(w, 'iv-4', { decidedBy: 'someone-else' })), 'actor mismatch'); await denied(setDoc(ref(w.db.O, 'iv-5'), DEC(w, 'iv-6')), 'id mismatch'); await denied(setDoc(ref(w.db.O, 'iv-7'), DEC(w, 'iv-7', { x: 1 })), 'extra field');
  await denied(setDoc(ref(w.db.X, 'iv-8'), DEC(w, 'iv-8', { decidedBy: w.X })), 'another coach'); await denied(setDoc(ref(w.db.A, 'iv-9'), DEC(w, 'iv-9', { decidedBy: w.A })), 'the athlete');
  await denied(setDoc(ref(w.db.O, 'iv-1'), DEC(w, 'iv-1')), 're-create'); await denied(updateDoc(ref(w.db.O, 'iv-1'), { at: serverTimestamp() }), 'update'); await denied(deleteDoc(ref(w.db.O, 'iv-1')), 'delete');
  await allowed(getDoc(ref(w.db.A, 'iv-1')), 'the athlete may read its own decisions'); await denied(getDoc(ref(w.db.X, 'iv-1')), 'another coach cannot read');
});
