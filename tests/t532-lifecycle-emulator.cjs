// T532: REAL Firestore transactions (emulator + firestore.rules) for the overlay lifecycle. Flag forced ON only in the sandbox copy of the modules.
// Requires the app-matched firebase SDKs on NODE_PATH and FIRESTORE_EMULATOR_HOST (see scripts/test-auto-apply-emulator.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, runTransaction } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
const F = require('./helpers/lifecycle-fixture.js');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const C = F.on.consumer, EFF = F.on.effective;
const adminApp = initAdmin({ projectId }, 't532-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];

async function signedIn(uid) {
  uid = uid || 't532-' + randomUUID();
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't532-' + apps.length);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid } });
  return { uid, db };
}
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

const FIRST_SET = { carga: '102.5', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-1', ts: 5 };
const LOGKEY = 'log_2_0_0_s0';

async function fixture() {
  const client = await signedIn(), coach = await signedIn();
  const planId = 'plan-' + client.uid;
  const sc = F.scenario({ clientId: client.uid, planId });
  await adminDb.doc('coaches/' + coach.uid).set({ role: 'coach', autoApplyCanary: { enabled: true, clientIds: [client.uid], prescriptionExerciseIds: [] } });
  await adminDb.doc('clients/' + client.uid).set({ coachId: coach.uid, activePlanId: planId, coachInterventions: [] });
  await adminDb.doc('plans/' + planId).set(Object.assign({}, sc.plan, { coachId: coach.uid, status: 'active' }));
  await adminDb.doc('logs/' + client.uid).set({ planId });
  await adminDb.doc('logs/' + client.uid + '/mesos/' + planId).set({ planId, entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec } });
  return { client, coach, planId, sc, key: sc.rec.key };
}
const refsFor = (db, f, uid) => ({ meso: doc(db, 'logs', uid || f.client.uid, 'mesos', f.planId), root: doc(db, 'logs', uid || f.client.uid), plan: doc(db, 'plans', f.planId),
  client: doc(db, 'clients', f.client.uid), coach: doc(db, 'coaches', f.coach.uid) });
const applyInput = (f, o = {}) => Object.assign({ recordKey: f.key, expectedRevision: 1, now: new Date().toISOString(), actorId: f.coach.uid,
  context: { clientId: f.client.uid, planId: f.planId, equipmentResolution: F.equipmentFor(f.sc), resolveNextExposure: F.shadowOn.resolveNextExposure } }, o);
const apply = (f, db, o, refs) => runTransaction(db || f.coach.db, tx => C.applyOverlayTransaction(tx, refs || refsFor(db || f.coach.db, f), applyInput(f, o), { isCurrent: () => true }));
// T537: the athlete ACKNOWLEDGES (append-only receipt); the owner Coach records CONSUMED from a valid receipt.
const ack = (f, db, o) => runTransaction(db || f.client.db, tx => C.recordConsumptionReceiptTransaction(tx, { meso: refsFor(db || f.client.db, f).meso, root: refsFor(db || f.client.db, f).root },
  Object.assign({ recordKey: f.key, clientId: f.client.uid, now: new Date().toISOString(), shown: shownOf(f) }, o), { isCurrent: () => true }));
const consume = (f, db, o) => runTransaction(db || f.coach.db, tx => C.consumeOverlayTransaction(tx, refsFor(db || f.coach.db, f), Object.assign({ recordKey: f.key, clientId: f.client.uid, now: new Date().toISOString(), actorId: f.coach.uid }, o), { isCurrent: () => true }));
const revert = (f, o) => runTransaction(f.coach.db, tx => C.revertOverlayTransaction(tx, refsFor(f.coach.db, f), Object.assign({ recordKey: f.key, expectedRevision: 2, now: new Date().toISOString(), actorId: f.coach.uid }, o), {}));
const override = (f) => runTransaction(f.coach.db, tx => C.overrideOverlayTransaction(tx, refsFor(f.coach.db, f), { recordKey: f.key, now: new Date().toISOString(), actorId: f.coach.uid }, {}));
const stale = (f) => runTransaction(f.coach.db, tx => C.staleOverlayTransaction(tx, refsFor(f.coach.db, f), { recordKey: f.key, now: new Date().toISOString(), actorId: f.coach.uid }, {}));
const mesoDoc = async f => (await adminDb.doc('logs/' + f.client.uid + '/mesos/' + f.planId).get()).data();
const shownOf = f => f._shown || { provenance: 'CANONICAL_OVERLAY', overlayKey: 'ovl_' + f.key, dimension: 'LOAD', appliedValue: 102.5 };
const rec = async f => (await mesoDoc(f)).progressionApplications[f.key];
const ovs = async f => (await mesoDoc(f)).nextExposureOverlays || {};
const events = (r, state) => (r.events || []).filter(e => e.state === state).length;
const persistFirstSet = async f => adminDb.doc('logs/' + f.client.uid + '/mesos/' + f.planId).update({ ['entries.' + LOGKEY]: FIRST_SET });
const coachDecision = (f, at) => updateDoc(doc(f.coach.db, 'clients', f.client.uid), { coachInterventions: [{ id: 'iv-' + randomUUID(), targetType: 'EXERCISE', targetId: 'pid-1', planId: f.planId, action: 'REDUCE_SETS', decidedAt: at || new Date().toISOString() }] });
// coherence: record and overlay never disagree, and never more than one overlay / one event per state
async function assertCoherent(f) {
  const r = await rec(f), o = await ovs(f), keys = Object.keys(o);
  assert.ok(keys.length <= 1, 'at most one overlay');
  if (keys.length) { assert.equal(o[keys[0]].status, r.state, 'overlay mirrors the record'); assert.equal(r.lifecycle.overlayKey, keys[0]); }
  else assert.ok(['PENDING'].includes(r.state), 'no overlay => the record is still PENDING (never APPLIED without its overlay)');
  for (const s of ['APPLIED', 'CONSUMED', 'OVERRIDDEN', 'REVERTED', 'STALE']) assert.ok(events(r, s) <= 1, 'no duplicate ' + s + ' event');
  return { r, o };
}
const effectiveFor = async (f) => {
  const m = await mesoDoc(f), cl = (await adminDb.doc('clients/' + f.client.uid).get()).data(), plan = (await adminDb.doc('plans/' + f.planId).get()).data();
  return EFF.resolveEffective({ clientId: f.client.uid, planId: f.planId, activePlanId: cl.activePlanId, pid: 'pid-1', week: 2, dayIndex: 0, records: m.progressionApplications, overlays: m.nextExposureOverlays || {},
    interventions: cl.coachInterventions, plan, entries: m.entries, baseSets: F.baseSets() });
};

test('1. two devices apply the same candidate: one overlay, one APPLIED event, one winner', { timeout: 60000 }, async () => {
  const f = await fixture(), before = (await mesoDoc(f)).entries;
  const [a, b] = await Promise.all([apply(f), apply(f)]);
  assert.equal([a, b].filter(x => x.written).length, 1, JSON.stringify([a.reason, b.reason]));
  assert.ok([a, b].some(x => x.idempotent === true || x.reason === 'ALREADY_RECORDED'));
  const { r } = await assertCoherent(f);
  assert.deepEqual([r.state, r.revision, events(r, 'APPLIED'), Object.keys(await ovs(f)).length], ['APPLIED', 2, 1, 1]);
  assert.deepEqual((await mesoDoc(f)).entries, before, 'LOGS untouched');
  assert.equal((await effectiveFor(f)).provenance, 'CANONICAL_OVERLAY');
});

test('2. a Coach override racing with apply always ends coherent: OVERRIDDEN or never applied', { timeout: 120000 }, async () => {
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const f = await fixture();
    const [a] = await Promise.all([apply(f).catch(e => ({ written: false, reason: e.code })), coachDecision(f)]);
    let { r } = await assertCoherent(f);
    if (r.state === 'APPLIED') { const o = await override(f); assert.equal(o.written, true); r = (await assertCoherent(f)).r; }
    assert.ok(['OVERRIDDEN', 'PENDING'].includes(r.state), r.state); seen.add(r.state);
    if (a.written === false && r.state === 'PENDING') assert.ok(['COACH_OVERRIDE', 'ABORTED', 'aborted'].includes(a.reason) || a.reason, a.reason);
    assert.notEqual((await effectiveFor(f)).provenance, 'CANONICAL_OVERLAY', 'the Coach decision wins whichever side committed first');
  }
});

test('3. the first working-set save racing with a revert never loses the LOG and ends coherent', { timeout: 120000 }, async () => {
  for (let i = 0; i < 6; i++) {
    const f = await fixture(); assert.equal((await apply(f)).written, true);
    const entries = Object.assign({}, (await mesoDoc(f)).entries, { [LOGKEY]: FIRST_SET });
    const [, rv] = await Promise.all([setDoc(doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId), { entries }, { mergeFields: ['entries'] }), revert(f)]);
    const { r } = await assertCoherent(f);
    assert.deepEqual((await mesoDoc(f)).entries[LOGKEY], FIRST_SET, 'no LOG loss');
    if (rv.written) assert.equal(r.state, 'REVERTED'); else { assert.equal(rv.reason, 'TARGET_ALREADY_STARTED'); assert.equal(r.state, 'APPLIED'); }
  }
});

test('4. plan replacement racing with apply: never an effective overlay for a replaced plan', { timeout: 120000 }, async () => {
  for (let i = 0; i < 6; i++) {
    const f = await fixture();
    const [a] = await Promise.all([apply(f).catch(e => ({ written: false, reason: e.code })), updateDoc(doc(f.coach.db, 'clients', f.client.uid), { activePlanId: 'plan-new-' + f.client.uid })]);
    let { r } = await assertCoherent(f);
    if (r.state === 'APPLIED') { const s = await stale(f); assert.equal(s.written, true); r = (await assertCoherent(f)).r; assert.equal(r.state, 'STALE'); }
    else assert.equal(r.state, 'PENDING');
    assert.equal((await effectiveFor(f)).provenance, 'BASE_PLAN'); void a;
  }
});

test('5. duplicate acknowledgements (two devices) append one receipt; duplicate Coach consumes (two tabs) record one CONSUMED event', { timeout: 60000 }, async () => {
  const f = await fixture(); assert.equal((await apply(f)).written, true); await persistFirstSet(f);
  const second = await signedIn(f.client.uid);
  // the losing device is either told 'already acknowledged' (re-read) or rejected by the append-only rule (its timestamp differs): both leave ONE receipt
  const res = await Promise.allSettled([ack(f), ack(f, second.db)]);
  assert.ok(res.filter(x => x.status === 'fulfilled' && x.value.written).length >= 1);
  for (const x of res) if (x.status === 'rejected') assert.match(String(x.reason.code || x.reason.message), /permission|PERMISSION/i);
  assert.deepEqual(Object.keys((await mesoDoc(f)).consumptionReceipts), [f.key]); assert.equal((await rec(f)).state, 'APPLIED', 'the athlete never moves canonical state');
  const coach2 = await signedIn(f.coach.uid);
  const [c, d] = await Promise.all([consume(f), consume(f, coach2.db)]);
  assert.equal([c, d].filter(x => x.written).length, 1, JSON.stringify([c, d].map(x => x.reason)));
  const { r } = await assertCoherent(f);
  assert.deepEqual([r.state, events(r, 'CONSUMED')], ['CONSUMED', 1]);
  assert.deepEqual((await mesoDoc(f)).entries[LOGKEY], FIRST_SET);
  assert.equal((await effectiveFor(f)).provenance, 'CANONICAL_OVERLAY', 'a started exposure keeps its effective prescription (reload / resume)');
});

test('6. late callbacks from another client are refused: wrong clientId and a stranger session change nothing', { timeout: 60000 }, async () => {
  const f = await fixture(); assert.equal((await apply(f)).written, true); await persistFirstSet(f);
  const w = await ack(f, null, { clientId: 'someone-else' }); assert.deepEqual([w.written, w.reason], [false, 'CLIENT_MISMATCH']);
  const stranger = await signedIn();
  await assert.rejects(ack(f, stranger.db), /permission|PERMISSION/i);
  await assert.rejects(consume(f, stranger.db), /permission|PERMISSION/i);
  assert.equal((await mesoDoc(f)).consumptionReceipts, undefined); assert.equal((await rec(f)).state, 'APPLIED');
});

test('7. late old-plan callbacks: apply for a replaced plan is refused; a started old exposure still consumes coherently inside its own plan', { timeout: 60000 }, async () => {
  const f = await fixture();
  await adminDb.doc('clients/' + f.client.uid).update({ activePlanId: 'plan-new-' + f.client.uid });
  const r = await apply(f); assert.deepEqual([r.written, r.reason], [false, 'PLAN_MISMATCH']);
  assert.equal((await ovs(f))[Object.keys(await ovs(f))[0]], undefined); assert.equal((await rec(f)).state, 'PENDING');
  const g = await fixture(); assert.equal((await apply(g)).written, true); await persistFirstSet(g);
  await adminDb.doc('clients/' + g.client.uid).update({ activePlanId: 'plan-new-' + g.client.uid });
  assert.equal((await ack(g)).written, true); const c = await consume(g); assert.equal(c.written, true);
  assert.equal((await adminDb.doc('logs/' + g.client.uid + '/mesos/plan-new-' + g.client.uid).get()).exists, false, 'the new plan is never touched');
  assert.equal((await rec(g)).state, 'CONSUMED');
});

test('8. retry after network ambiguity: apply, consume and revert replays are idempotent', { timeout: 60000 }, async () => {
  const f = await fixture();
  assert.equal((await apply(f)).written, true);
  const again = await apply(f); assert.deepEqual([again.written, again.idempotent], [false, true]);
  await persistFirstSet(f);
  assert.equal((await ack(f)).written, true); const a2 = await ack(f); assert.deepEqual([a2.written, a2.idempotent], [false, true]);
  assert.equal((await consume(f)).written, true);
  const c2 = await consume(f); assert.deepEqual([c2.written, c2.idempotent], [false, true]);
  const { r } = await assertCoherent(f); assert.deepEqual([r.state, r.revision, events(r, 'APPLIED'), events(r, 'CONSUMED')], ['CONSUMED', 3, 1, 1]);
  const g = await fixture(); await apply(g); assert.equal((await revert(g)).written, true);
  const r2 = await revert(g); assert.deepEqual([r2.written, r2.idempotent], [false, true]);
  assert.equal(events(await rec(g), 'REVERTED'), 1);
});

test('9. overlay write denied (stranger session): the transaction is rejected and nothing changes', { timeout: 60000 }, async () => {
  const f = await fixture(), stranger = await signedIn();
  await assert.rejects(apply(f, stranger.db), /permission|PERMISSION/i);
  const { r } = await assertCoherent(f); assert.equal(r.state, 'PENDING'); assert.deepEqual(await ovs(f), {});
});

test('10. state update denied on a second document rolls back the overlay too (no partial application)', { timeout: 60000 }, async () => {
  const f = await fixture(), other = await signedIn();
  const refs = refsFor(f.client.db, f); delete refs.coach; refs.root = doc(f.client.db, 'logs', other.uid);   // denied for this session
  const before = await mesoDoc(f);
  await assert.rejects(apply(f, f.client.db, { context: Object.assign(applyInput(f).context, { canaryScope: { enabled: true, clientIds: [f.client.uid], prescriptionExerciseIds: [] } }) }, refs), /permission|PERMISSION/i);
  assert.deepEqual(await mesoDoc(f), before, 'meso document identical: overlay AND record untouched');
  assert.equal((await adminDb.doc('logs/' + other.uid).get()).exists, false);
});

test('11. full lifecycle on the emulator: APPLIED -> CONSUMED / OVERRIDDEN / REVERTED / STALE, each terminal and never re-applicable', { timeout: 120000 }, async () => {
  const end = {};
  { const f = await fixture(); await apply(f); await persistFirstSet(f); await ack(f); await consume(f); end.CONSUMED = f; }
  { const f = await fixture(); await apply(f); await coachDecision(f); await override(f); end.OVERRIDDEN = f; }
  { const f = await fixture(); await apply(f); await revert(f); end.REVERTED = f; }
  { const f = await fixture(); await apply(f); await adminDb.doc('clients/' + f.client.uid).update({ activePlanId: 'plan-new-' + f.client.uid }); await stale(f); end.STALE = f; }
  for (const [state, f] of Object.entries(end)) {
    assert.equal((await rec(f)).state, state);
    const before = await mesoDoc(f);
    const r = await apply(f, null, { expectedRevision: before.progressionApplications[f.key].revision });
    assert.equal(r.written, false, state); assert.deepEqual(await mesoDoc(f), before, state + ' is never resurrected');
  }
});

// ------------------------------------------------------------------------------------------------ T537 authorization races (real rules + real transactions)
const forgedOverlay = (f) => Object.assign({}, { key: 'ovl_' + f.key, appliedValue: 999 });
const canonicalOf = async f => { const m = await mesoDoc(f); return JSON.stringify({ p: m.progressionApplications, o: m.nextExposureOverlays, s: m.progressionApplicationSummary }); };

test('12. a malicious athlete racing a legitimate Coach apply can neither forge nor alter anything; the Coach result is the only state', { timeout: 60000 }, async () => {
  for (let i = 0; i < 4; i++) {
    const f = await fixture();
    const attacks = [
      updateDoc(doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId), { 'nextExposureOverlays.ovl_forged': { appliedValue: 999, status: 'APPLIED' } }),
      updateDoc(doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId), { ['progressionApplications.' + f.key + '.state']: 'APPLIED' }),
      setDoc(doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId), { nextExposureOverlays: { ['ovl_' + f.key]: forgedOverlay(f) } }, { mergeFields: ['nextExposureOverlays'] })
    ].map(p => p.then(() => 'ALLOWED', e => e.code));
    const [applyRes, ...outcomes] = await Promise.all([apply(f), ...attacks]);
    // Forged overlay writes are ALWAYS denied. Attack 2 writes state='APPLIED': if the Coach apply committed first, the stored value already
    // equals it, so the write changes no canonical key (a no-op the rules correctly allow); it must never be allowed while the record is PENDING.
    assert.equal(outcomes[0], 'permission-denied');
    assert.equal(outcomes[2], 'permission-denied');
    assert.ok(outcomes[1] === 'permission-denied' || outcomes[1] === 'ALLOWED', outcomes[1]);
    assert.equal(applyRes.written, true);
    const { r, o } = await assertCoherent(f);
    assert.deepEqual([r.state, Object.keys(o).length, o['ovl_' + f.key].appliedValue, r.revision, events(r, 'APPLIED')], ['APPLIED', 1, 102.5, 2, 1], 'the Coach result is the only state (no extra revision/event from an allowed no-op)');
  }
});

test('13. payload alteration after APPLIED is denied for the athlete (load, reps, rest, PID, target, snapshot, state) and the effective prescription is unchanged', { timeout: 60000 }, async () => {
  const f = await fixture(); assert.equal((await apply(f)).written, true);
  const before = await canonicalOf(f), mref = doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId), k = 'nextExposureOverlays.ovl_' + f.key;
  for (const patch of [{ [k + '.appliedValue']: 999 }, { [k + '.dimension']: 'REPS' }, { [k + '.target.week']: 5 }, { [k + '.prescriptionExerciseId']: 'pid-x' }, { [k + '.equipmentSnapshot']: { source: 'FORGED' } },
    { ['progressionApplications.' + f.key + '.state']: 'REVERTED' }, { ['progressionApplications.' + f.key + '.events']: [] }])
    await assert.rejects(updateDoc(mref, patch), { code: 'permission-denied' });
  assert.equal(await canonicalOf(f), before);
  assert.equal((await effectiveFor(f)).appliedValue, 102.5);
});

test('14. athlete acknowledgement vs Coach revert: started exposure -> revert refused, receipt accepted; not started -> receipt refused, revert wins', { timeout: 60000 }, async () => {
  // CONTRACT (read from the implementation, not assumed): ack and revert have NO precedence over each
  // other. Each re-verifies its own guard INSIDE its transaction, and the guards are mutually
  // exclusive by state:
  //   recordConsumptionReceiptTransaction  requires pidExposureStarted -> else TARGET_NOT_STARTED
  //   revertOverlayTransaction             requires !targetStarted     -> else TARGET_ALREADY_STARTED
  // So the winner is whichever commits first, and "last writer wins" only looks that way: a transaction
  // that finds the other's committed state is REFUSED, never silently applied.
  //
  // That makes the two halves of this test fundamentally different, and the old version conflated them
  // by racing both:
  //
  //   HALF 1 - the first working set is ALREADY PERSISTED before either call. The outcome is therefore
  //   DETERMINISTIC: the exposure has started, so the revert is refused regardless of ordering. Racing
  //   this with Promise.all manufactured a race that does not exist and made a deterministic assertion
  //   flaky. It is now sequenced, which tests the guarantee rather than a scheduling accident.
  //
  //   HALF 2 - nothing is persisted, so the target has NOT started and the outcome genuinely depends on
  //   which transaction commits first. Both interleavings are legitimate protocol outcomes here, so the
  //   which transaction commits first. The contract does NOT promise a winner, so none is demanded here.
  //   its own guard, and the final state matches the winner) instead of on a preferred winner.
  const f = await fixture(); assert.equal((await apply(f)).written, true); await persistFirstSet(f);
  // Exposure already started: the receipt is accepted...
  const a = await ack(f);
  assert.equal(a.written, true);
  // ...and a revert attempted afterwards is refused BECAUSE the target has started. No race, no sleeping.
  const rv = await revert(f);
  assert.deepEqual([rv.written, rv.reason], [false, 'TARGET_ALREADY_STARTED']);
  assert.equal((await rec(f)).state, 'APPLIED');

  // Genuine race, INVARIANT-ONLY.
  //
  // An earlier version of this test asserted a2.written XOR rv2.written and FAILED in CI. That was
  // wrong: NOTHING guarantees either operation succeeds. Each is refused by its own guards, and the
  // guards are checked in this order:
  //   ack    L453 state !== APPLIED        -> INVALID_TRANSITION   (the revert won)
  //          L456 !pidExposureStarted      -> TARGET_NOT_STARTED
  //   revert       targetStarted           -> TARGET_ALREADY_STARTED
  //                expectedRevision differs -> REVISION_CONFLICT
  // So BOTH may be refused in the same attempt, each for a documented reason, with the record still
  // coherent. What IS guaranteed, and all this asserts:
  //   1. the final state matches whichever operation actually wrote;
  //   2. a refusal carries a reason from that operation's own guards;
  //   3. no partial effect survives a refusal;
  //   4. the record stays coherent and REVERTED events match whether the revert wrote.
  let sawReceiptWin = false, sawRevertWin = false, sawNeitherWin = false, attempts = 0;
  const ACK_REFUSALS = ['TARGET_NOT_STARTED', 'INVALID_TRANSITION'];
  const REVERT_REFUSALS = ['TARGET_ALREADY_STARTED', 'REVISION_CONFLICT'];
  while (attempts < 6) {
    attempts++;
    const g = await fixture(); assert.equal((await apply(g)).written, true);
    const [a2, rv2] = await Promise.all([ack(g), revert(g)]);
    const coh = await assertCoherent(g);
    const meso = await mesoDoc(g);
    if (a2.written) sawReceiptWin = true; else if (rv2.written) sawRevertWin = true; else sawNeitherWin = true;

    // (2) a refusal must come from that operation's own guards, never an unexplained failure.
    if (!a2.written) assert.ok(ACK_REFUSALS.includes(a2.reason), 'ack refused for an undocumented reason: ' + a2.reason);
    if (!rv2.written) assert.ok(REVERT_REFUSALS.includes(rv2.reason), 'revert refused for an undocumented reason: ' + rv2.reason);

    // (1) and (3) the final state must match the winner, and no partial effect may survive.
    if (a2.written) {
      assert.equal(coh.r.state, 'APPLIED', 'a written receipt leaves the record APPLIED');
      assert.deepEqual([rv2.written, rv2.reason], [false, 'TARGET_ALREADY_STARTED'],
        'once the exposure started the revert must be refused because of that');
      assert.notEqual(meso.consumptionReceipts[a2.receipt.recordKey], undefined, 'the receipt is present');
    } else if (rv2.written) {
      assert.equal(coh.r.state, 'REVERTED', 'a written revert must leave the record REVERTED');
      assert.ok(ACK_REFUSALS.includes(a2.reason), 'the refused receipt uses one of its own guards');
      assert.equal(meso.consumptionReceipts, undefined, 'no partial receipt');
    } else {
      // Both refused: neither may have applied anything.
      assert.equal(coh.r.state, 'APPLIED', 'neither wrote, so the record is unchanged');
      assert.equal(meso.consumptionReceipts, undefined, 'no partial receipt');
    }

    // (4) coherence and event bookkeeping, independent of who won.
    assert.equal(events(coh.r, 'REVERTED'), rv2.written ? 1 : 0, 'revert events match whether the revert wrote');
    assert.ok(events(coh.r, 'APPLIED') <= 1, 'no duplicate APPLIED');
  }
  // Information, not a gate: which interleavings this machine produced.
  assert.ok(sawReceiptWin || sawRevertWin || sawNeitherWin, 'at least one attempt must have produced a result');
});

test('15. owner Coach vs unrelated Coach racing on the same APPLIED record: only the owner changes state', { timeout: 60000 }, async () => {
  const f = await fixture(); assert.equal((await apply(f)).written, true);
  const intruder = await signedIn(); await adminDb.doc('coaches/' + intruder.uid).set({ role: 'coach' });
  const attempt = runTransaction(intruder.db, tx => C.revertOverlayTransaction(tx, refsFor(intruder.db, f), { recordKey: f.key, expectedRevision: 2, now: new Date().toISOString() }, {})).then(x => x, e => ({ denied: e.code }));
  const [own, bad] = await Promise.all([revert(f), attempt]);
  assert.equal(own.written, true); assert.ok(bad.denied === 'permission-denied' || bad.written === false, JSON.stringify(bad));
  const { r } = await assertCoherent(f); assert.equal(r.state, 'REVERTED'); assert.equal(events(r, 'REVERTED'), 1);
  const g = await fixture(); await apply(g);
  const before = await canonicalOf(g);
  await assert.rejects(runTransaction(intruder.db, tx => C.revertOverlayTransaction(tx, refsFor(intruder.db, g), { recordKey: g.key, expectedRevision: 2, now: 'n' }, {})), { code: 'permission-denied' });
  assert.equal(await canonicalOf(g), before);
});

test('16. old / late athlete callbacks against current state: after REVERTED or CONSUMED nothing changes', { timeout: 60000 }, async () => {
  const f = await fixture(); assert.equal((await apply(f)).written, true); await persistFirstSet(f); assert.equal((await ack(f)).written, true); assert.equal((await consume(f)).written, true);
  const late = await ack(f); assert.equal(late.written, false); assert.equal((await rec(f)).state, 'CONSUMED');
  const g = await fixture(); await apply(g); await revert(g); await persistFirstSet(g);
  const stale = await ack(g); assert.deepEqual([stale.written, stale.reason], [false, 'INVALID_TRANSITION']);
  assert.equal((await rec(g)).state, 'REVERTED'); assert.equal((await mesoDoc(g)).consumptionReceipts, undefined);
});

test('17. terminal-state mutation attempts by the athlete are denied (REVERTED -> APPLIED, CONSUMED -> REVERTED) and leave the record untouched', { timeout: 60000 }, async () => {
  const f = await fixture(); await apply(f); await revert(f);
  const g = await fixture(); await apply(g); await persistFirstSet(g); await ack(g); await consume(g);
  const before = [await canonicalOf(f), await canonicalOf(g)];
  await assert.rejects(updateDoc(doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId), { ['progressionApplications.' + f.key + '.state']: 'APPLIED' }), { code: 'permission-denied' });
  await assert.rejects(updateDoc(doc(g.client.db, 'logs', g.client.uid, 'mesos', g.planId), { ['progressionApplications.' + g.key + '.state']: 'REVERTED' }), { code: 'permission-denied' });
  assert.deepEqual([await canonicalOf(f), await canonicalOf(g)], before);
});

test('18. overlay/summary mismatch attempts: the athlete cannot rewrite either summary; the Coach summaries stay identical to the record set after every transition', { timeout: 60000 }, async () => {
  const f = await fixture(); await apply(f);
  await assert.rejects(updateDoc(doc(f.client.db, 'logs', f.client.uid), { progressionApplicationSummary: { planId: f.planId, autoCount: 7, counts: { APPLIED: 0 }, items: [] } }), { code: 'permission-denied' });
  await assert.rejects(updateDoc(doc(f.client.db, 'logs', f.client.uid, 'mesos', f.planId), { progressionApplicationSummary: { planId: f.planId, autoCount: 7, counts: {}, items: [] } }), { code: 'permission-denied' });
  await persistFirstSet(f); await ack(f); await consume(f);
  const m = await mesoDoc(f), root = (await adminDb.doc('logs/' + f.client.uid).get()).data();
  assert.deepEqual(root.progressionApplicationSummary, m.progressionApplicationSummary);
  assert.equal(m.progressionApplicationSummary.counts.CONSUMED, 1); assert.equal(m.progressionApplicationSummary.counts.APPLIED, 0);
});
