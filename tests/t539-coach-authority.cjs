// T539: Coach doc authority fields (server-managed apiAccessEnabled), orphan ownership, and the full principal matrix on the real emulator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, where } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't539-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });
async function as(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't539-' + apps.length);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  if (uid) connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid } }); else connectFirestoreEmulator(db, host, Number(port));
  return db;
}
const denied = async (p, why) => { try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; } assert.fail('expected PERMISSION_DENIED: ' + why); };
const allowed = async (p, why) => { try { return await p; } catch (e) { assert.fail('expected ALLOWED (' + why + '): ' + e.code + ' ' + e.message); } };
const uid = p => p + '-' + randomUUID().slice(0, 8);

// ------------------------------------------------------------------------------------------------ Coach doc protected fields
test('A01 self-created Coach docs cannot carry the API entitlement; ordinary registration still works', { timeout: 60000 }, async () => {
  const u = uid('reg'), db = await as(u);
  await denied(setDoc(doc(db, 'coaches', u), { role: 'coach', displayName: 'x', apiAccessEnabled: true }), 'create with apiAccessEnabled=true');
  await denied(setDoc(doc(db, 'coaches', u), { role: 'coach', apiAccessEnabled: false }), 'create with apiAccessEnabled=false (the field is server-managed too)');
  await allowed(setDoc(doc(db, 'coaches', u), { role: 'coach', displayName: 'x', email: 'x@x.com', createdAt: 'now' }), 'ordinary registration (open by product design)');
  assert.equal((await adminDb.doc('coaches/' + u).get()).data().apiAccessEnabled, undefined, 'default: no entitlement');
});
test('A02 a Coach cannot set, flip, drop, delete-and-recreate the entitlement; normal profile updates stay allowed', { timeout: 60000 }, async () => {
  const off = uid('off'), on = uid('on'), dOff = await as(off), dOn = await as(on);
  await adminDb.doc('coaches/' + off).set({ role: 'coach', apiAccessEnabled: false });
  await adminDb.doc('coaches/' + on).set({ role: 'coach', apiAccessEnabled: true, equipmentIncrements: { shared: {}, gyms: {} } });
  await denied(updateDoc(doc(dOff, 'coaches', off), { apiAccessEnabled: true }), 'false -> true');
  await denied(setDoc(doc(dOff, 'coaches', off), { apiAccessEnabled: true }, { merge: true }), 'merge false -> true');
  await denied(updateDoc(doc(dOn, 'coaches', on), { apiAccessEnabled: false }), 'true -> false');
  await denied(updateDoc(doc(dOn, 'coaches', on), { apiAccessEnabled: deleteFieldSentinel() }), 'drop the field');
  await denied(setDoc(doc(dOn, 'coaches', on), { role: 'coach' }), 'full replace that would drop the field');
  await denied(deleteDoc(doc(dOn, 'coaches', on)), 'delete an entitled doc (delete + recreate must not shed it)');
  await allowed(updateDoc(doc(dOn, 'coaches', on), { displayName: 'New name', phone: '+52 55 0000 0000', equipmentIncrements: { shared: { a: { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} } }), 'profile + equipment update');
  await allowed(setDoc(doc(dOn, 'coaches', on), { displayName: 'd', email: 'e@x.com', role: 'coach' }, { merge: true }), 'ensureCoachDoc merge');
  await allowed(updateDoc(doc(dOff, 'coaches', off), { displayName: 'ok' }), 'profile update of a non-entitled coach');
  assert.equal((await adminDb.doc('coaches/' + on).get()).data().apiAccessEnabled, true); assert.equal((await adminDb.doc('coaches/' + off).get()).data().apiAccessEnabled, false);
  // a non-entitled doc without the field can be deleted and re-registered, but never re-created WITH the field
  const plain = uid('plain'), dP = await as(plain); await adminDb.doc('coaches/' + plain).set({ role: 'coach' });
  await allowed(deleteDoc(doc(dP, 'coaches', plain)), 'delete a doc with no server-managed field');
  await denied(setDoc(doc(dP, 'coaches', plain), { role: 'coach', apiAccessEnabled: true }), 'recreate with the entitlement');
});
function deleteFieldSentinel() { return require('firebase/firestore').deleteField(); }
test('A03 the Admin SDK (trusted server) manages the entitlement: grant and revoke bypass client rules; the coach only reads it', { timeout: 60000 }, async () => {
  const u = uid('adm'), db = await as(u);
  await adminDb.doc('coaches/' + u).set({ role: 'coach' });
  await adminDb.doc('coaches/' + u).set({ apiAccessEnabled: true }, { merge: true });
  assert.equal((await allowed(getDoc(doc(db, 'coaches', u)), 'read own')).data().apiAccessEnabled, true);
  await adminDb.doc('coaches/' + u).set({ apiAccessEnabled: false }, { merge: true });
  assert.equal((await getDoc(doc(db, 'coaches', u))).data().apiAccessEnabled, false);
});

// ------------------------------------------------------------------------------------------------ orphan ownership
async function world() {
  const id = randomUUID().slice(0, 8), O = 'own-' + id, X = 'oth-' + id, M = 'mal-' + id, C = 'cli-' + id, ORPH = 'orph-' + id, N = 'new-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach', apiAccessEnabled: true });
  await adminDb.doc('coaches/' + X).set({ role: 'coach' });
  await adminDb.doc('coaches/' + M).set({ role: 'coach' });   // self-promoted / self-created
  await adminDb.doc('clients/' + C).set({ coachId: O, email: 'a@x.com', displayName: 'A', activePlanId: null });
  await adminDb.doc('clients/' + ORPH).set({ email: 'o@x.com', displayName: 'Orphan' });
  await adminDb.doc('clients/orph-empty-' + id).set({ email: 'e@x.com', coachId: '' });
  return { id, O, X, M, C, ORPH, N, db: { O: await as(O), X: await as(X), M: await as(M), C: await as(C), ORPH: await as(ORPH), N: await as(N), U: await as(null) } };
}
test('O01 nobody can claim an unowned client: other coach, self-promoted coach, the athlete itself; coachId stays immutable', { timeout: 60000 }, async () => {
  const w = await world();
  for (const who of ['X', 'M', 'O']) for (const c of [w.ORPH, 'orph-empty-' + w.id]) {
    await denied(setDoc(doc(w.db[who], 'clients', c), { coachId: w[who] }, { merge: true }), who + ' claim ' + c);
    await denied(updateDoc(doc(w.db[who], 'clients', c), { coachId: w[who] }), who + ' claim(update) ' + c);
  }
  await denied(updateDoc(doc(w.db.ORPH, 'clients', w.ORPH), { coachId: w.M }), 'athlete assigns a coach to itself');
  await denied(updateDoc(doc(w.db.C, 'clients', w.C), { coachId: w.M }), 'athlete reassigns its coach');
  await denied(updateDoc(doc(w.db.X, 'clients', w.C), { coachId: w.X }), 'other coach steals an owned client');
  await denied(updateDoc(doc(w.db.O, 'clients', w.C), { coachId: w.X }), 'even the owner cannot hand it over through the client SDK');
  assert.equal((await adminDb.doc('clients/' + w.ORPH).get()).data().coachId, undefined); assert.equal((await adminDb.doc('clients/' + w.C).get()).data().coachId, w.O);
});
test('O02 normal client creation keeps working; a Coach cannot create or overwrite a client under another coach or adopt an existing one', { timeout: 60000 }, async () => {
  const w = await world();
  await allowed(setDoc(doc(w.db.O, 'clients', w.N), { coachId: w.O, email: 'n@x.com', displayName: 'N', role: 'client', activePlanId: null, nutritionPlan: {}, supplementPlan: {} }, { merge: true }), 'intended Coach-created onboarding');
  await allowed(updateDoc(doc(w.db.O, 'clients', w.N), { displayName: 'Renamed', phone: '5215500000000' }), 'owner edits its client');
  await denied(setDoc(doc(w.db.M, 'clients', 'x-' + w.id), { coachId: w.X, email: 'evil' }), 'create under another coach');
  await denied(setDoc(doc(w.db.M, 'clients', w.C), { coachId: w.M, email: 'evil@x.com' }), 'overwrite an existing owned athlete');
  await denied(setDoc(doc(w.db.M, 'clients', w.C), { coachId: w.M }, { merge: true }), 'adopt an existing owned athlete (merge)');
  assert.equal((await adminDb.doc('clients/' + w.C).get()).data().email, 'a@x.com');
  // documented residual: a brand-new client doc for an Auth uid that has none is indistinguishable from intended onboarding
  await allowed(setDoc(doc(w.db.M, 'clients', 'preclaim-' + w.id), { coachId: w.M }), 'RESIDUAL (reported): pre-claiming an athlete uid that has no client document yet');
});

// ------------------------------------------------------------------------------------------------ principal matrix
test('M01 principal matrix: tenant ownership does NOT need the API entitlement; nothing else changes with it', { timeout: 90000 }, async () => {
  const w = await world();
  const notEntitled = uid('own-ne'), dNE = await as(notEntitled);
  await adminDb.doc('coaches/' + notEntitled).set({ role: 'coach' });
  await adminDb.doc('clients/ne-cli-' + w.id).set({ coachId: notEntitled, email: 'ne@x.com' });
  await adminDb.doc('logs/ne-cli-' + w.id).set({ planId: 'p', entries: {}, currentWeek: 1 });
  await adminDb.doc('logs/' + w.C).set({ planId: 'p', entries: {}, currentWeek: 1 });
  // OWNER_NOT_ENTITLED: full tenant access to its client, none to others
  await allowed(getDoc(doc(dNE, 'clients', 'ne-cli-' + w.id)), 'not-entitled owner reads its client'); await allowed(updateDoc(doc(dNE, 'logs', 'ne-cli-' + w.id), { currentWeek: 2 }), 'not-entitled owner writes its logs');
  await denied(getDoc(doc(dNE, 'clients', w.C)), 'not-entitled owner vs another coach client');
  // OWNER_ENTITLED behaves identically for Firestore
  await allowed(updateDoc(doc(w.db.O, 'logs', w.C), { currentWeek: 2 }), 'entitled owner writes its logs'); await allowed(getDocs(query(collection(w.db.O, 'clients'), where('coachId', '==', w.O))), 'entitled owner list');
  // OTHER and SELF_PROMOTED
  for (const who of ['X', 'M']) { await denied(getDoc(doc(w.db[who], 'clients', w.C)), who + ' read client'); await denied(getDoc(doc(w.db[who], 'logs', w.C)), who + ' read logs'); await denied(updateDoc(doc(w.db[who], 'logs', w.C), { currentWeek: 9 }), who + ' write logs'); }
  // ATHLETE
  await allowed(getDoc(doc(w.db.C, 'clients', w.C)), 'athlete reads own client'); await allowed(updateDoc(doc(w.db.C, 'logs', w.C), { currentWeek: 3 }), 'athlete saves execution');
  await denied(updateDoc(doc(w.db.C, 'coaches', w.C), { x: 1 }), 'athlete has no coach doc'); await denied(setDoc(doc(w.db.C, 'coaches', w.C), { role: 'coach' }), 'athlete cannot become a coach');
  // UNAUTHENTICATED
  for (const p of ['clients/' + w.C, 'logs/' + w.C, 'coaches/' + w.O, 'fichas_onboarding/' + w.C, 'compendio/' + w.O]) await denied(getDoc(doc(w.db.U, p)), 'unauthenticated read ' + p);
  await denied(setDoc(doc(w.db.U, 'logs', w.C), { currentWeek: 9 }, { merge: true }), 'unauthenticated write');
  await allowed(getDoc(doc(w.db.U, 'phone_index', 'x')), 'the phone-login index stays public-read');
});
