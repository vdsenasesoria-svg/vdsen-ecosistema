'use strict';
// FLAKY REPRODUCTION / STABILITY HARNESS for the t532 ack-vs-revert race.
//
// WHY THIS EXISTS
// tests/t532-lifecycle-emulator.cjs::14 used to race ack against revert with Promise.all and assert
// that ACK wins. That test is flaky, and a rerun of the same commit proved it: the CI run at
// 8be3792d failed on it and passed on attempt 2.
//
// WHAT IT SHOWS
//   --mode=old : reproduces the CURRENT flaky assertion (ack must win) by racing them. Reports how
//                often ack really wins, which is the nondeterminism the old test depended on.
//   --mode=new : exercises the replacement contract. The winner is scheduling-dependent BY DESIGN, so
//                it asserts only what the protocol guarantees, plus a deterministic branch.
//
// The two guards in the implementation are mutually exclusive by STATE, not by precedence:
//   recordConsumptionReceiptTransaction  requires pidExposureStarted -> else TARGET_NOT_STARTED
//   revertOverlayTransaction             requires !targetStarted     -> else TARGET_ALREADY_STARTED
// So whichever transaction commits first wins and the other is REFUSED. There is no winner priority
// to assert, which is exactly why the old test could not be deterministic.
//
// DEMO PROJECT ONLY. Not part of permanent CI (100 iterations is too slow); the deterministic test in
// t532 is the permanent gate. See docs/T532_ACK_REVERT_CONTRACT.md.
//
//   node scripts/t532-race-repro.cjs --mode=old --n=100
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { initializeApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, runTransaction } = require('firebase/firestore');
const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
const F = require(path.join(__dirname, '..', 'tests', 'helpers', 'lifecycle-fixture.js'));

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const MODE = arg('mode', 'new');
const N = Number(arg('n', '100'));

const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
if (!/^demo-/.test(projectId)) { console.error('ABORT: project must be demo-*, got ' + projectId); process.exit(2); }
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('ABORT: FIRESTORE_EMULATOR_HOST is required (run via scripts/test-auto-apply-emulator.cjs or with the emulator up)'); process.exit(2); }

const C = F.on.consumer;
const adminDb = getAdminFirestore(initAdmin({ projectId }, 't532repro-admin'));
const apps = [];
async function signedIn() {
  const uid = 't532repro-' + randomUUID();
  const app = initializeApp({ apiKey: 'demo-key', projectId }, 't532repro-' + apps.length);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid } });
  return { uid, db };
}

const FIRST_SET = { carga: '102.5', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-1' };
const LOGKEY = 'log_2_0_0_s0';

async function fixture() {
  const client = await signedIn(), coach = await signedIn();
  const planId = 'plan-' + client.uid;
  const sc = F.scenario({ clientId: client.uid, planId });
  await adminDb.doc('coaches/' + coach.uid).set({ role: 'coach', autoApplyCanary: { enabled: true, clientIds: [client.uid], plans: [planId] } });
  await adminDb.doc('clients/' + client.uid).set({ coachId: coach.uid, activePlanId: planId, coachInterventions: [] });
  await adminDb.doc('plans/' + planId).set(Object.assign({}, sc.plan, { coachId: coach.uid, status: 'active' }));
  await adminDb.doc('logs/' + client.uid).set({ planId });
  await adminDb.doc('logs/' + client.uid + '/mesos/' + planId).set({ planId, entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec } });
  return { client, coach, planId, sc, key: sc.rec.key };
}
const refsFor = (db, f) => ({ meso: doc(db, 'logs', f.client.uid, 'mesos', f.planId), root: doc(db, 'logs', f.client.uid),
  client: doc(db, 'clients', f.client.uid), coach: doc(db, 'coaches', f.coach.uid), plan: doc(db, 'plans', f.planId) });
const shownOf = (f) => ({ provenance: 'CANONICAL_OVERLAY', overlayKey: 'ovl_' + f.key, dimension: 'LOAD', appliedValue: 102.5,
  prescriptionExerciseId: 'pid-1', week: 2, dayIndex: 0 });
const apply = (f) => runTransaction(f.coach.db, (tx) => C.applyOverlayTransaction(tx, refsFor(f.coach.db, f), Object.assign(
  { recordKey: f.key, expectedRevision: 1, now: new Date().toISOString(), actorId: f.coach.uid },
  { context: { clientId: f.client.uid, planId: f.planId, equipmentResolution: F.equipmentFor(f.sc), resolveNextExposure: F.scenario().resolveNextExposure }, shown: shownOf(f) }), {}));
const ack = (f) => runTransaction(f.client.db, (tx) => C.recordConsumptionReceiptTransaction(tx,
  { meso: refsFor(f.client.db, f).meso, root: refsFor(f.client.db, f).root },
  { recordKey: f.key, clientId: f.client.uid, now: new Date().toISOString(), shown: shownOf(f) }, {}));
const revert = (f) => runTransaction(f.coach.db, (tx) => C.revertOverlayTransaction(tx, refsFor(f.coach.db, f),
  { recordKey: f.key, expectedRevision: 2, now: new Date().toISOString(), actorId: f.coach.uid }, {}));
const persistFirstSet = (f) => adminDb.doc('logs/' + f.client.uid + '/mesos/' + f.planId).update({ ['entries.' + LOGKEY]: FIRST_SET });
const rec = async (f) => (await adminDb.doc('logs/' + f.client.uid + '/mesos/' + f.planId).get()).data().progressionApplications[f.key];

(async () => {
  let pass = 0; const failures = []; let receiptWins = 0, revertWins = 0;

  for (let i = 0; i < N; i++) {
    try {
      const f = await fixture();
      assert.equal((await apply(f)).written, true);

      if (MODE === 'old') {
        // EXACTLY the old test's shape: persist first, then race, then demand ack wins.
        await persistFirstSet(f);
        const [a, rv] = await Promise.all([ack(f), revert(f)]);
        assert.equal(a.written, true, 'ack must win');
        assert.deepEqual([rv.written, rv.reason], [false, 'TARGET_ALREADY_STARTED']);
        assert.equal((await rec(f)).state, 'APPLIED');
        pass++;
      } else {
        // THE REPLACEMENT: deterministic branch (already started) then the invariant branch.
        await persistFirstSet(f);
        const a = await ack(f);
        assert.equal(a.written, true);
        const rv = await revert(f);
        assert.deepEqual([rv.written, rv.reason], [false, 'TARGET_ALREADY_STARTED']);
        assert.equal((await rec(f)).state, 'APPLIED');

        const g = await fixture();
        assert.equal((await apply(g)).written, true);
        const [a2, rv2] = await Promise.all([ack(g), revert(g)]);
        assert.notEqual(Boolean(a2.written), Boolean(rv2.written), 'exactly one may win');
        const r = await rec(g);
        if (a2.written) {
          receiptWins++;
          assert.deepEqual([rv2.written, rv2.reason], [false, 'TARGET_ALREADY_STARTED']);
          assert.equal(r.state, 'APPLIED');
        } else {
          revertWins++;
          assert.deepEqual([a2.written, a2.reason], [false, 'TARGET_NOT_STARTED']);
          assert.equal(rv2.written, true);
          assert.equal(r.state, 'REVERTED');
        }
        pass++;
      }
    } catch (e) { failures.push('#' + i + ': ' + (e && e.message)); }
  }

  console.log('  mode=' + MODE + '  n=' + N + '  pass=' + pass + '  fail=' + failures.length);
  if (MODE === 'new') console.log('  interleavings: receipt-first=' + receiptWins + ' revert-first=' + revertWins + '  (both NOT required to pass)');
  failures.slice(0, 5).forEach((f) => console.log('    ' + f));
  console.log('  VDSEN_T532_REPRO_COMPLETE mode=' + MODE + ' pass=' + pass + ' failures=' + failures.length);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(2); });
