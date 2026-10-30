// T538: TENANT isolation (real emulator + repository firestore.rules). A Coach reaches a client's private data ONLY when
// clients/{clientId}.coachId == that Coach. Identities: OWNER coach, OTHER coach, MALICIOUS authenticated user (self-created coaches doc), ATHLETE(S).
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, orderBy, limit } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't538-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

async function as(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't538-' + apps.length);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid } });
  return db;
}
const denied = async (p, why) => { try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; } assert.fail('expected PERMISSION_DENIED: ' + why); };
const allowed = async (p, why) => { try { return await p; } catch (e) { assert.fail('expected ALLOWED (' + why + '): ' + e.code + ' ' + e.message); } };

async function world() {
  const id = randomUUID().slice(0, 8), C = 'cli-' + id, C2 = 'cli2-' + id, O = 'own-' + id, X = 'oth-' + id, M = 'mal-' + id, P = 'plan-' + id, ORPH = 'orph-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach', displayName: 'Owner' });
  await adminDb.doc('coaches/' + X).set({ role: 'coach', displayName: 'Other' });
  await adminDb.doc('coaches/' + M).set({ role: 'coach', displayName: 'self-created' });   // what the open registration / auto-create allows any authenticated user to do
  await adminDb.doc('clients/' + C).set({ coachId: O, email: 'a@x.com', displayName: 'Athlete', phone: '5215500000000', activePlanId: P, coachInterventions: [] });
  await adminDb.doc('clients/' + C2).set({ coachId: X, email: 'b@x.com', displayName: 'Other athlete', activePlanId: null });
  await adminDb.doc('clients/' + ORPH).set({ email: 'o@x.com', displayName: 'Orphan' });   // no coachId: unclaimed
  await adminDb.doc('plans/' + P).set({ coachId: O, clientId: C, weeks: 4, days: [] });
  const entries = { log_1_0_0_s0: { carga: '100', reps: '10', done: true, prescriptionExerciseId: 'pid-1', ts: 1 } };
  await adminDb.doc('logs/' + C).set({ planId: P, entries, currentWeek: 1, updatedAt: 1, exerciseUnits: {}, exerciseHistory: {} });
  await adminDb.doc('logs/' + C + '/mesos/' + P).set({ planId: P, entries, currentWeek: 1, updatedAt: 1, exerciseUnits: {}, exerciseHistory: {} });
  await adminDb.doc('fichas_onboarding/' + C).set({ data: { peso: 90, lesiones: 'private' } });
  await adminDb.doc('fichas_renovacion/' + C).set({ data: { peso: 91 } });
  await adminDb.doc('compendio/' + O).set({ content: 'private compendium' });
  await adminDb.doc('templates/tpl-' + id).set({ name: 'T', coachId: O, days: [] });
  await adminDb.doc('plans_backup/bk-' + id).set({ coachId: O, clientId: C, originalPlanId: P, backedUpAt: '2026-09-01T00:00:00.000Z', nutritionRaw: { secret: 1 } });
  await adminDb.doc('fichas_publicas/fp-' + id).set({ coachId: O, nombre: 'Prospect', data: { telefono: '5511' } });
  await adminDb.doc('phone_index/5215500000000').set({ email: 'a@x.com', uid: C });
  const w = { id, C, C2, O, X, M, P, ORPH };
  w.db = { O: await as(O), X: await as(X), M: await as(M), C: await as(C), C2: await as(C2), A3: await as('ath3-' + id) };
  return w;
}
const R = (w, who, p) => doc(w.db[who], p);

// ------------------------------------------------------------------------------------------------ cross-tenant READS
test('T01 an unrelated or self-created Coach cannot read another Coach client profile (get, list, filtered list)', { timeout: 60000 }, async () => {
  const w = await world();
  for (const who of ['X', 'M']) {
    await denied(getDoc(R(w, who, 'clients/' + w.C)), who + ' get');
    await denied(getDocs(collection(w.db[who], 'clients')), who + ' unfiltered list');
    await denied(getDocs(query(collection(w.db[who], 'clients'), where('coachId', '==', w.O))), who + ' list of the owner clients');
  }
  await allowed(getDoc(R(w, 'O', 'clients/' + w.C)), 'owner get');
  const own = await allowed(getDocs(query(collection(w.db.O, 'clients'), where('coachId', '==', w.O))), 'owner list');
  assert.deepEqual(own.docs.map(d => d.id), [w.C]);
});
test('T02 private evidence is unreadable across tenants: logs (root + mesos), onboarding / renewal forms', { timeout: 60000 }, async () => {
  const w = await world();
  for (const who of ['X', 'M', 'A3']) {
    await denied(getDoc(R(w, who, 'logs/' + w.C)), who + ' logs root');
    await denied(getDoc(R(w, who, 'logs/' + w.C + '/mesos/' + w.P)), who + ' logs meso');
    await denied(getDocs(collection(w.db[who], 'logs', w.C, 'mesos')), who + ' mesos list');
    await denied(getDoc(R(w, who, 'fichas_onboarding/' + w.C)), who + ' ficha');
    await denied(getDoc(R(w, who, 'fichas_renovacion/' + w.C)), who + ' renovacion');
  }
  for (const who of ['O', 'C']) { await allowed(getDoc(R(w, who, 'logs/' + w.C)), who + ' logs'); await allowed(getDoc(R(w, who, 'fichas_onboarding/' + w.C)), who + ' ficha'); }
  await allowed(getDoc(R(w, 'O', 'fichas_renovacion/' + w.C)), 'owner renovacion');
  await allowed(getDocs(collection(w.db.O, 'logs', w.C, 'mesos')), 'owner mesos list (Monitor / historical mesocycles)');
  await allowed(getDocs(collection(w.db.C, 'logs', w.C, 'mesos')), 'athlete own mesos list');
});
test('T03 Coach-private collections are readable only by their coach: compendio, templates, plan backups, prospect forms', { timeout: 60000 }, async () => {
  const w = await world();
  for (const who of ['X', 'M', 'C']) {
    await denied(getDoc(R(w, who, 'compendio/' + w.O)), who + ' compendio');
    await denied(getDocs(query(collection(w.db[who], 'templates'), where('coachId', '==', w.O))), who + ' templates');
    await denied(getDocs(query(collection(w.db[who], 'plans_backup'), where('coachId', '==', w.O), where('clientId', '==', w.C), orderBy('backedUpAt', 'desc'), limit(1))), who + ' backups');
    await denied(getDoc(R(w, who, 'fichas_publicas/fp-' + w.id)), who + ' prospect form');
  }
  await allowed(getDoc(R(w, 'O', 'compendio/' + w.O)), 'owner compendio');
  await allowed(getDocs(query(collection(w.db.O, 'templates'), where('coachId', '==', w.O))), 'owner templates');
  await allowed(getDocs(query(collection(w.db.O, 'plans_backup'), where('coachId', '==', w.O), where('clientId', '==', w.C), orderBy('backedUpAt', 'desc'), limit(1))), 'owner backups');
  await allowed(getDoc(R(w, 'O', 'fichas_publicas/fp-' + w.id)), 'owner prospect');
});

// ------------------------------------------------------------------------------------------------ cross-tenant WRITES (evidence poisoning)
test('T04 an unrelated or self-created Coach cannot poison execution evidence: entries, currentWeek, history, units, new logs, delete', { timeout: 60000 }, async () => {
  const w = await world();
  for (const who of ['X', 'M']) for (const path of ['logs/' + w.C, 'logs/' + w.C + '/mesos/' + w.P]) {
    await denied(updateDoc(R(w, who, path), { currentWeek: 9, updatedAt: Date.now() }), who + ' week ' + path);
    await denied(updateDoc(R(w, who, path), { 'entries.log_9_0_0_s0': { carga: '999', reps: '1', done: true, prescriptionExerciseId: 'pid-1' } }), who + ' entries ' + path);
    await denied(updateDoc(R(w, who, path), { exerciseHistory: { x: { load: '1' } } }), who + ' history ' + path);
    await denied(setDoc(R(w, who, path), { entries: {}, currentWeek: 1 }), who + ' replace ' + path);
    await denied(deleteDoc(R(w, who, path)), who + ' delete ' + path);
  }
  await denied(setDoc(R(w, 'M', 'logs/' + w.C + '/mesos/plan-new'), { planId: 'plan-new', entries: {} }), 'new meso doc');
  const m = (await adminDb.doc('logs/' + w.C).get()).data(); assert.equal(m.currentWeek, 1); assert.equal(Object.keys(m.entries).length, 1);
  await allowed(updateDoc(R(w, 'O', 'logs/' + w.C), { currentWeek: 2, updatedAt: Date.now() }), 'owner week change (Coach tool)');
  await allowed(setDoc(R(w, 'O', 'logs/' + w.C + '/mesos/' + w.P), { entries: {}, currentWeek: 1, planId: w.P, exerciseUnits: {}, updatedAt: 5 }, { mergeFields: ['entries', 'currentWeek', 'planId', 'exerciseUnits', 'updatedAt'] }), 'owner plan reset');
});
test('T05 an unrelated Coach cannot materialize, consume, revert, override or stale another Coach lifecycle (canonical + evidence fields)', { timeout: 60000 }, async () => {
  const w = await world();
  await adminDb.doc('logs/' + w.C + '/mesos/' + w.P).update({ progressionApplications: { k: { state: 'APPLIED' } }, nextExposureOverlays: { ovl_k: { status: 'APPLIED' } }, progressionApplicationSummary: { counts: {} } });
  for (const who of ['X', 'M']) {
    const m = R(w, who, 'logs/' + w.C + '/mesos/' + w.P);
    await denied(updateDoc(m, { 'progressionApplications.k.state': 'REVERTED' }), who + ' revert');
    await denied(updateDoc(m, { 'progressionApplications.new': { state: 'PENDING' } }), who + ' materialize');
    await denied(updateDoc(m, { 'consumptionReceipts.k': { ackAt: 'x' } }), who + ' receipt');
    await denied(updateDoc(R(w, who, 'logs/' + w.C), { progressionApplicationSummary: { counts: {} } }), who + ' summary');
    await denied(updateDoc(R(w, who, 'clients/' + w.C), { coachInterventions: [{ id: 'forged' }] }), who + ' interventions');
  }
});
test('T06 phone index: an unrelated Coach cannot redirect or delete the login entry of another Coach client', { timeout: 60000 }, async () => {
  const w = await world();
  for (const who of ['X', 'M']) {
    await denied(setDoc(R(w, who, 'phone_index/5215500000000'), { email: 'evil@x.com', uid: w.C }, { merge: true }), who + ' redirect');
    await denied(setDoc(R(w, who, 'phone_index/5215500000000'), { email: 'evil@x.com', uid: 'me' }, { merge: true }), who + ' repoint');
    await denied(deleteDoc(R(w, who, 'phone_index/5215500000000')), who + ' delete');
  }
  await allowed(setDoc(R(w, 'O', 'phone_index/5215500000000'), { email: 'a@x.com', uid: w.C, updatedAt: 'now' }, { merge: true }), 'owner repair');
  await allowed(setDoc(R(w, 'O', 'phone_index/5215511111111'), { email: 'n@x.com', uid: w.C }), 'owner new entry for its client');
  await allowed(getDoc(doc(await as('anon-' + w.id), 'phone_index/5215500000000')), 'public read (login by phone) is unchanged');
});

// ------------------------------------------------------------------------------------------------ identity / role escalation
test('T07 an ATHLETE (existing client account) cannot turn itself into a Coach; a fresh account can register but gains nothing', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(setDoc(R(w, 'C', 'coaches/' + w.C), { role: 'coach', email: 'a@x.com' }), 'athlete self-promotion');
  await denied(setDoc(R(w, 'C2', 'coaches/' + w.C2), { role: 'coach' }), 'another athlete');
  await allowed(setDoc(R(w, 'A3', 'coaches/ath3-' + w.id), { role: 'coach', displayName: 'fresh' }), 'open coach registration (product design) is unchanged');
  await denied(getDoc(R(w, 'A3', 'logs/' + w.C)), 'fresh coach reads nothing of other tenants');
  await denied(getDoc(R(w, 'A3', 'clients/' + w.C)), 'fresh coach reads no client');
});
test('T08 athletes are isolated from each other', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(getDoc(R(w, 'C2', 'clients/' + w.C)), 'other athlete profile'); await denied(getDoc(R(w, 'C2', 'logs/' + w.C)), 'other athlete logs');
  await denied(updateDoc(R(w, 'C2', 'logs/' + w.C), { currentWeek: 5 }), 'other athlete write'); await denied(setDoc(R(w, 'C2', 'fichas_onboarding/' + w.C), { data: {} }, { merge: true }), 'other athlete ficha write');
  await allowed(setDoc(R(w, 'C', 'fichas_onboarding/' + w.C), { data: { peso: 92 } }, { merge: true }), 'own ficha write (onboarding form)');
  await allowed(updateDoc(R(w, 'C', 'logs/' + w.C), { currentWeek: 2, updatedAt: 9 }), 'own logs');
});

// ------------------------------------------------------------------------------------------------ legitimate owner-Coach and legacy operations keep working
test('T09 owner Coach operations keep working: create client, own-list, ficha/renovacion writes, backups, templates, compendium, exercises, delete order', { timeout: 60000 }, async () => {
  const w = await world(), id = w.id;
  await allowed(setDoc(R(w, 'O', 'clients/new-' + id), { coachId: w.O, email: 'n@x.com', displayName: 'N', role: 'client', activePlanId: null }, { merge: true }), 'create client');
  await allowed(setDoc(R(w, 'O', 'fichas_onboarding/new-' + id), { data: { peso: 80 } }), 'ficha for own new client');
  await allowed(setDoc(R(w, 'O', 'fichas_renovacion/' + w.C), { updatedBy: 'coach', data: { peso: 93 } }, { merge: true }), 'renovacion');
  await allowed(addDoc(collection(w.db.O, 'plans_backup'), { coachId: w.O, clientId: w.C, backedUpAt: 'x' }), 'backup');
  await allowed(addDoc(collection(w.db.O, 'templates'), { coachId: w.O, name: 'n', days: [] }), 'template');
  await allowed(setDoc(R(w, 'O', 'compendio/' + w.O), { content: 'x' }), 'compendium');
  await allowed(addDoc(collection(w.db.O, 'exercises'), { coachId: w.O, name: 'e' }), 'exercise');
  await allowed(updateDoc(R(w, 'O', 'fichas_publicas/fp-' + id), { status: 'convertida' }), 'prospect status');
  // delete order used by the Coach app: phone index, plan, logs, ficha, then the client document
  await allowed(deleteDoc(R(w, 'O', 'phone_index/5215500000000')), 'phone index'); await allowed(deleteDoc(R(w, 'O', 'logs/' + w.C)), 'logs'); await allowed(deleteDoc(R(w, 'O', 'fichas_onboarding/' + w.C)), 'ficha');
  await allowed(deleteDoc(R(w, 'O', 'clients/' + w.C)), 'client');
});
test('T10 unclaimed (orphan) clients: NOT claimable by any coach (T539: admin recovery only), not browsable, owned clients cannot be stolen', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(setDoc(R(w, 'M', 'clients/' + w.C), { coachId: w.M }, { merge: true }), 'cannot steal an owned client');
  await denied(getDoc(R(w, 'X', 'clients/' + w.ORPH)), 'unclaimed clients are not browsable');
  await denied(setDoc(R(w, 'X', 'clients/' + w.ORPH), { coachId: w.X }, { merge: true }), 'claim orphan is no longer a Coach capability');
  await denied(getDocs(query(collection(w.db.M, 'clients'), where('coachId', '==', ''))), 'no orphan enumeration');
});

test('T11 unused permissive collections are closed (sessions); diag_pings remains coach-only', { timeout: 60000 }, async () => {
  const w = await world();
  await denied(setDoc(R(w, 'C', 'sessions/s1'), { x: 1 }), 'athlete sessions write'); await denied(getDoc(R(w, 'O', 'sessions/s1')), 'coach sessions read');
});
