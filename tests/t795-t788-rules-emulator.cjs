// T795: Real Firestore Emulator verification of firestore.t788.rules (T788 4-contract isolation, immutability, and fichas_publicas).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where, serverTimestamp, writeBatch, runTransaction
} = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);

const adminApp = initAdmin({ projectId }, 't795-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];
const [emuHost, emuPort] = process.env.FIRESTORE_EMULATOR_HOST.split(':');

function putRules(rulesFile) {
  const source = fs.readFileSync(path.join(__dirname, '..', rulesFile), 'utf8');
  const body = JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: source }] } });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: emuHost,
      port: Number(emuPort),
      path: `/emulator/v1/projects/${projectId}:securityRules`,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`putRules(${rulesFile}) failed: HTTP ${res.statusCode} ${data}`));
      });
    });
    req.once('error', reject);
    req.write(body);
    req.end();
  });
}

async function as(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: `${projectId}.firebaseapp.com`, projectId }, `t795-${apps.length}`);
  apps.push(app);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, emuHost, Number(emuPort), { mockUserToken: { sub: uid } });
  return db;
}

const denied = async (p, why) => {
  try { await p; } catch (e) { assert.match(String(e.code || e.message), /permission|PERMISSION/i, why); return; }
  assert.fail('expected PERMISSION_DENIED: ' + why);
};
const allowed = async (p, why) => {
  try { return await p; } catch (e) { assert.fail(`expected ALLOWED (${why}): ${e.code} ${e.message}`); }
};

test.before(async () => {
  await putRules('firestore.t788.rules');
});

test.after(async () => {
  await putRules('firestore.rules');
  await Promise.all(apps.map(deleteApp));
  await deleteAdmin(adminApp);
});

test('T795.1 firestore.t788.rules: fichas_publicas tenant query succeeds for owner coach and denies other coach', async () => {
  const id = randomUUID().slice(0, 8);
  const O = 'coach-o-' + id, X = 'coach-x-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach' });
  await adminDb.doc('coaches/' + X).set({ role: 'coach' });
  await adminDb.doc('fichas_publicas/fp-' + id).set({ coachId: O, nombre: 'Prospecto ' + id });

  const dbO = await as(O);
  const dbX = await as(X);
  const snap = await allowed(getDocs(query(collection(dbO, 'fichas_publicas'), where('coachId', '==', O))), 'owner coach list query');
  assert.ok(snap.docs.some(d => d.id === 'fp-' + id));
  await denied(getDoc(doc(dbX, 'fichas_publicas', 'fp-' + id)), 'other coach read');
  await denied(getDocs(query(collection(dbX, 'fichas_publicas'), where('coachId', '==', O))), 'other coach list query');
  await denied(deleteDoc(doc(dbX, 'fichas_publicas', 'fp-' + id)), 'other coach delete');
});

test('T795.2 firestore.t788.rules: 4-contract seguimiento lifecycle, metric immutability, and cross-tenant isolation', async () => {
  const id = randomUUID().slice(0, 8);
  const O = 'coach-o2-' + id, X = 'coach-x2-' + id, C = 'cli-a-' + id, C2 = 'cli-b-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach' });
  await adminDb.doc('coaches/' + X).set({ role: 'coach' });
  await adminDb.doc('clients/' + C).set({ coachId: O, email: 'c@x.com' });
  await adminDb.doc('clients/' + C2).set({ coachId: X, email: 'c2@x.com' });

  const dbO = await as(O), dbX = await as(X), dbC = await as(C), dbC2 = await as(C2);
  const reqId = 'req_' + id, chkId = 'chk_' + id, revId = 'rev_' + chkId;

  // 1. Coach creates checkin_request
  await allowed(setDoc(doc(dbO, 'clients', C, 'checkin_requests', reqId), {
    id: reqId, clientId: C, coachId: O, status: 'pending', note: 'Semana 4', requestedAt: serverTimestamp()
  }), 'owner coach creates checkin_request');
  await denied(setDoc(doc(dbX, 'clients', C, 'checkin_requests', 'req_x_' + id), {
    id: 'req_x_' + id, clientId: C, coachId: X, status: 'pending', requestedAt: serverTimestamp()
  }), 'other coach cannot create checkin_request');

  // 2. Client creates immutable checkin with 5 scales and updates request to sent
  await allowed(setDoc(doc(dbC, 'clients', C, 'checkins', chkId), {
    id: chkId, clientId: C, status: 'sent', pesoKg: 78.5, energia: 4, recuperacion: 4, sueno: 3, fatiga: 2, rendimiento: 5,
    submittedAt: serverTimestamp()
  }), 'client creates checkin');
  await allowed(updateDoc(doc(dbC, 'clients', C, 'checkin_requests', reqId), {
    status: 'sent', checkinId: chkId, fulfilledAt: serverTimestamp()
  }), 'client fulfills checkin_request');

  // 3. Coach CANNOT alter client-declared metrics on checkins/{checkinId}
  await denied(updateDoc(doc(dbO, 'clients', C, 'checkins', chkId), { pesoKg: 99 }), 'coach cannot alter client pesoKg');
  await denied(updateDoc(doc(dbO, 'clients', C, 'checkins', chkId), { energia: 1 }), 'coach cannot alter client energia');
  await denied(deleteDoc(doc(dbO, 'clients', C, 'checkins', chkId)), 'coach cannot delete checkin');

  // 4. Coach creates separate checkin_reviews/{reviewId} (create-only) and updates review status on checkin
  await allowed(setDoc(doc(dbO, 'clients', C, 'checkin_reviews', revId), {
    id: revId, checkinId: chkId, clientId: C, coachId: O, status: 'reviewed', reviewedAt: serverTimestamp()
  }), 'owner coach creates checkin_review');
  await denied(updateDoc(doc(dbO, 'clients', C, 'checkin_reviews', revId), { status: 'pending' }), 'checkin_review is create-only');
  await allowed(updateDoc(doc(dbO, 'clients', C, 'checkins', chkId), {
    status: 'reviewed', reviewedAt: serverTimestamp(), reviewedByCoachId: O
  }), 'owner coach updates review metadata only');

  // 5. Cross-coach and cross-client reads denied
  await denied(getDoc(doc(dbX, 'clients', C, 'checkins', chkId)), 'other coach cannot read checkin');
  await denied(getDoc(doc(dbX, 'clients', C, 'checkin_reviews', revId)), 'other coach cannot read checkin_review');
  await denied(getDoc(doc(dbC2, 'clients', C, 'checkins', chkId)), 'other client cannot read checkin');

  // 6. Audit proof: logs/{clientId} allows owner coach overwrite (NOT immutable)
  await allowed(setDoc(doc(dbO, 'logs', C), { seguimientoItems: [{ id: chkId, pesoKg: 99 }] }, { merge: true }),
    'owner coach retains write access on logs/{clientId} mirror');

  // 7. Adversarial: client cannot forge checkin_reviews or write checkin_request_lock
  await denied(setDoc(doc(dbC, 'clients', C, 'checkin_reviews', 'rev_fake_' + id), {
    id: 'rev_fake_' + id, checkinId: chkId, clientId: C, coachId: O, status: 'reviewed', reviewedAt: serverTimestamp()
  }), 'client cannot forge checkin_review');
  await denied(setDoc(doc(dbC, 'clients', C, 'checkin_request_lock', 'active'), {
    clientId: C, coachId: O, activeRequestId: reqId
  }), 'client cannot write checkin_request_lock');
  await denied(setDoc(doc(dbX, 'clients', C, 'checkin_request_lock', 'active'), {
    clientId: C, coachId: X, activeRequestId: reqId
  }), 'other coach cannot write checkin_request_lock');
});

test('T795.3 firestore.t788.rules: atomic writeBatch/existsAfter and single-pending-request lock', async () => {
  const id = randomUUID().slice(0, 8);
  const O = 'coach-o3-' + id, C = 'cli-a3-' + id, C2 = 'cli-b3-' + id;
  await adminDb.doc('coaches/' + O).set({ role: 'coach' });
  await adminDb.doc('clients/' + C).set({ coachId: O, email: 'c3@x.com' });
  await adminDb.doc('clients/' + C2).set({ coachId: O, email: 'c3b@x.com' });

  const dbO = await as(O), dbC = await as(C), dbC2 = await as(C2);
  const reqId = 'req_bat_' + id, chkId = 'chk_bat_' + id, otherChkId = 'chk_other_' + id;

  // Coach creates request + lock atomically via runTransaction
  await allowed(runTransaction(dbO, async tx => {
    const lockRef = doc(dbO, 'clients', C, 'checkin_request_lock', 'active');
    const lockSnap = await tx.get(lockRef);
    assert.equal(lockSnap.exists(), false);
    tx.set(doc(dbO, 'clients', C, 'checkin_requests', reqId), {
      id: reqId, clientId: C, coachId: O, status: 'pending', requestedAt: serverTimestamp()
    });
    tx.set(lockRef, { clientId: C, coachId: O, activeRequestId: reqId, updatedAtMs: Date.now() });
  }), 'coach creates request + active lock atomically');

  // Other client creates its own checkin
  await allowed(setDoc(doc(dbC2, 'clients', C2, 'checkins', otherChkId), {
    id: otherChkId, clientId: C2, status: 'sent', submittedAt: serverTimestamp()
  }), 'other client creates own checkin');

  // DENY: client C tries to fulfill reqId with non-existent checkinId
  await denied(updateDoc(doc(dbC, 'clients', C, 'checkin_requests', reqId), {
    status: 'sent', checkinId: 'nonexistent_' + id, fulfilledAt: serverTimestamp()
  }), 'cannot fulfill request with nonexistent checkinId');

  // DENY: client C tries to fulfill reqId with another client's checkinId
  await denied(updateDoc(doc(dbC, 'clients', C, 'checkin_requests', reqId), {
    status: 'sent', checkinId: otherChkId, fulfilledAt: serverTimestamp()
  }), 'cannot fulfill request with another client checkinId');

  // ALLOW: atomic writeBatch creating checkins/{chkId} AND fulfilling checkin_requests/{reqId} (existsAfter)
  const batch = writeBatch(dbC);
  batch.set(doc(dbC, 'clients', C, 'checkins', chkId), {
    id: chkId, clientId: C, requestId: reqId, status: 'sent', pesoKg: 80.2, submittedAt: serverTimestamp()
  });
  batch.update(doc(dbC, 'clients', C, 'checkin_requests', reqId), {
    status: 'sent', checkinId: chkId, fulfilledAt: serverTimestamp()
  });
  await allowed(batch.commit(), 'atomic writeBatch checkin + checkin_request succeeds via existsAfter');
});

test('T795.4 FE151 (firestore.rules): subcollections denied, unfiltered fichas_publicas denied, and logs mirror writable by coach', async () => {
  await putRules('firestore.rules');
  try {
    const id = randomUUID().slice(0, 8);
    const O = 'coach-fe-' + id, X = 'coach-fe-x-' + id, C = 'cli-fe-' + id;
    await adminDb.doc('coaches/' + O).set({ role: 'coach' });
    await adminDb.doc('coaches/' + X).set({ role: 'coach' });
    await adminDb.doc('clients/' + C).set({ coachId: O, email: 'cfe@x.com' });
    await adminDb.doc('fichas_publicas/fp_fe_' + id).set({ coachId: O, nombre: 'Prospecto FE151' });
    await adminDb.doc('fichas_publicas/fp_fe_x_' + id).set({ coachId: X, nombre: 'Prospecto Otro' });
    const dbO = await as(O), dbC = await as(C);
    await denied(getDocs(collection(dbO, 'fichas_publicas')), 'FE151 denies unfiltered fichas_publicas list');
    await denied(setDoc(doc(dbC, 'clients', C, 'checkins', 'chk_fe_' + id), {
      id: 'chk_fe_' + id, clientId: C, status: 'sent', submittedAt: serverTimestamp()
    }), 'FE151 denies clients/{id}/checkins');
    await denied(setDoc(doc(dbO, 'clients', C, 'checkin_requests', 'req_fe_' + id), {
      id: 'req_fe_' + id, clientId: C, coachId: O, status: 'pending', requestedAt: serverTimestamp()
    }), 'FE151 denies clients/{id}/checkin_requests');
    await denied(setDoc(doc(dbO, 'clients', C, 'checkin_reviews', 'rev_fe_' + id), {
      id: 'rev_fe_' + id, checkinId: 'chk_fe_' + id, clientId: C, coachId: O, status: 'reviewed', reviewedAt: serverTimestamp()
    }), 'FE151 denies clients/{id}/checkin_reviews');
    await allowed(setDoc(doc(dbO, 'logs', C), { seguimientoItems: [{ id: 'chk_fe_' + id }] }, { merge: true }),
      'FE151 allows coach write on logs/{clientId} mirror');
  } finally {
    await putRules('firestore.t788.rules');
  }
});
