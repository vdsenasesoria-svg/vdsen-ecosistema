'use strict';
// T602 — server-verifiable temporal authority. Order of events for overlay authority comes from timestamps the DATABASE assigned (entry `sts` = serverTimestamp at commit; plan document
// `updateTime`; record.createdAt written by the executor) — never from the athlete's device clock (`ts`, progrec.calculatedAt). Server-side consumption re-evaluates inside its transaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./helpers/lifecycle-fixture.js');
const { makeStore } = require('./helpers/fake-firestore.js');
const eff = require('../assets/progression-effective-prescription.js');

const C = F.on.consumer;
const REFS = { meso: 'logs/c/mesos/p', plan: 'plans/p', client: 'clients/c', root: 'logs/c', coach: 'coaches/k' };
const SCOPE = { enabled: true, clientIds: ['c'], prescriptionExerciseIds: [] };
const T = (iso) => Date.parse(iso);
const EDIT = T('2026-09-28T09:00:00.000Z'), BEFORE = EDIT - 5 * 60000, AFTER = EDIT + 5 * 60000;

async function appliedStore() {
  const sc = F.scenario(), s = makeStore({ [REFS.client]: { activePlanId: 'p', coachInterventions: [], coachId: 'k' }, [REFS.plan]: sc.plan,
    [REFS.meso]: { planId: 'p', entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec } }, [REFS.root]: { planId: 'p' }, [REFS.coach]: { role: 'coach', autoApplyCanary: SCOPE } });
  const r = await s.run((tx) => C.applyOverlayTransaction(tx, REFS, { recordKey: sc.rec.key, expectedRevision: sc.rec.revision, now: '2026-09-28T01:00:00.000Z', actorId: 'k',
    context: { clientId: 'c', planId: 'p', equipmentResolution: F.equipmentFor(sc), resolveNextExposure: F.shadowOn.resolveNextExposure } }, { isCurrent: () => true }));
  assert.equal(r.written, true, JSON.stringify(r.reason)); return { s, sc, key: sc.rec.key };
}
function firstSet(a, sts, extra) {   // sts = server commit time (ms); the device clock `ts` is deliberately WRONG by a day
  const m = a.s.docs.get(REFS.meso), o = m.nextExposureOverlays['ovl_' + a.key];
  m.entries.log_2_0_0_s0 = Object.assign({ carga: '102.5', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-1', ts: sts - 24 * 3600000, sts: sts == null ? undefined : { seconds: Math.floor(sts / 1000), nanoseconds: 0 } }, extra || {});
  if (sts == null) delete m.entries.log_2_0_0_s0.sts;
  m.consumptionReceipts = { [a.key]: { recordKey: a.key, overlayKey: o.key, dimension: o.dimension, appliedValue: o.appliedValue, provenance: 'CANONICAL_OVERLAY', ackAt: '2026-10-30T00:00:00.000Z' } };   // a very late receipt
}
const consume = (a) => a.s.run((tx) => C.consumeOverlayTransaction(tx, REFS, { recordKey: a.key, clientId: 'c', now: '2026-10-30T01:00:00.000Z', actorId: 'k' }, { isCurrent: () => true }));
const stateOf = (a) => a.s.docs.get(REFS.meso).progressionApplications[a.key].state;

test('T602.1 the plan document\'s SERVER commit time decides, even when the Coach app\'s updatedAt string is wrong (clock BEHIND)', async () => {
  const a = await appliedStore(); a.s.docs.get(REFS.plan).updatedAt = '2026-09-26T00:00:00.000Z';   // Coach clock behind: the string claims an old edit
  a.s.times.set(REFS.plan, EDIT); firstSet(a, AFTER);                                                // the database says the plan was last written 5 min before the first set
  const r = await consume(a); assert.equal(r.written, false); assert.equal(r.reason, 'TARGET_INVALIDATED'); assert.equal(stateOf(a), 'APPLIED');
});
test('T602.2 a Coach clock AHEAD (updatedAt in the future) does not invalidate a legitimately started exposure when the database says the edit came later', async () => {
  const a = await appliedStore(); a.s.docs.get(REFS.plan).updatedAt = '2027-01-01T00:00:00.000Z';
  a.s.times.set(REFS.plan, AFTER); firstSet(a, BEFORE);
  const r = await consume(a); assert.equal(r.written, true, JSON.stringify(r.reason)); assert.equal(stateOf(a), 'CONSUMED');
});
test('T602.3 late OFFLINE write: the set was done before the edit but synced after it -> its server stamp is after the edit -> no authority (fail closed); the training record is kept', async () => {
  const a = await appliedStore(); a.s.times.set(REFS.plan, EDIT); firstSet(a, AFTER);
  const r = await consume(a); assert.equal(r.written, false); assert.equal(stateOf(a), 'APPLIED');
  assert.equal(a.s.docs.get(REFS.meso).entries.log_2_0_0_s0.carga, '102.5', 'the execution evidence is never lost or altered');
});
test('T602.4 historical data with no server-confirmed time: consumption fails closed only when an invalidation exists', async () => {
  const bad = await appliedStore(); bad.s.times.set(REFS.plan, EDIT); firstSet(bad, null);
  assert.equal((await consume(bad)).written, false);
  const ok = await appliedStore(); firstSet(ok, null);
  const r = await consume(ok); assert.equal(r.written, true, JSON.stringify(r.reason));
});
test('T602.5 concurrent devices: the EARLIEST server-confirmed working set defines the start; a later set from another device cannot change it', async () => {
  const a = await appliedStore(); a.s.times.set(REFS.plan, EDIT); firstSet(a, BEFORE);
  a.s.docs.get(REFS.meso).entries.log_2_0_0_s1 = { carga: '102.5', reps: '9', unit: 'KG', done: true, prescriptionExerciseId: 'pid-1', ts: 1, sts: { seconds: Math.floor(AFTER / 1000), nanoseconds: 0 } };
  assert.equal((await consume(a)).written, true, 'device A started before the edit; device B\'s later set is irrelevant');
  const b = await appliedStore(); b.s.times.set(REFS.plan, EDIT); firstSet(b, AFTER);
  b.s.docs.get(REFS.meso).entries.log_2_0_0_s1 = { carga: '102.5', reps: '9', unit: 'KG', done: true, prescriptionExerciseId: 'pid-1', ts: 1, sts: { seconds: Math.floor((AFTER + 60000) / 1000), nanoseconds: 0 } };
  assert.equal((await consume(b)).written, false, 'both devices started after the edit');
});
test('T602.6 Coach override: decided before the first server-confirmed set blocks; after it does not', async () => {
  const iv = (at) => [{ targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', decidedAt: new Date(at).toISOString(), action: 'MODIFY' }];
  const bad = await appliedStore(); bad.s.docs.get(REFS.client).coachInterventions = iv(EDIT); firstSet(bad, AFTER);
  const rb = await consume(bad); assert.equal(rb.written, false); assert.equal(rb.reason, 'COACH_OVERRIDE');
  const ok = await appliedStore(); ok.s.docs.get(REFS.client).coachInterventions = iv(AFTER); firstSet(ok, BEFORE);
  assert.equal((await consume(ok)).written, true);
});
test('T602.7 the reference instant is the server\'s materialization time, not the athlete\'s progrec.calculatedAt (athlete clock 30+ days ahead cannot hide a later plan edit)', () => {
  const sc = F.scenario(), a = F.applied(sc), input = F.effectiveInput(a, { canonicalOverlayRead: true });
  const rec = Object.values(a.records)[0]; rec.source = Object.assign({}, rec.source, { calculatedAt: '2026-11-30T00:00:00.000Z' });   // device clock far ahead
  input.plan = Object.assign({}, a.plan, { updatedAt: '2026-09-28T09:00:00.000Z' });                                                    // edit AFTER createdAt (09-27T13:00Z), BEFORE the bogus calculatedAt
  assert.equal(eff.evaluateOverlay(input).usable, false);
});
test('T602.8 the device clock is irrelevant: ts far in the past or future with a correct server stamp gives the same verdict', () => {
  const sc = F.scenario(), a = F.applied(sc), t = a.overlay.target, key = 'log_' + t.week + '_' + t.dayIndex + '_0_s0';
  for (const ts of [1, Date.now(), Date.now() + 365 * 86400000]) {
    const input = F.effectiveInput(a, { canonicalOverlayRead: true }); input.plan = Object.assign({}, a.plan, { updatedAt: new Date(EDIT).toISOString() });
    input.entries = Object.assign({}, a.entries, { [key]: { done: true, carga: '100', reps: '10', unit: 'KG', prescriptionExerciseId: sc.pid, ts, sts: AFTER } });
    assert.equal(eff.evaluateOverlay(input).usable, false);
    input.entries[key].sts = BEFORE; assert.equal(eff.evaluateOverlay(input).usable, true);
  }
});

// ── Client side: the stamp is written by the real merge path and its echo is not "news" ──
const fs = require('node:fs'), vm = require('node:vm');
const HTML = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name) { const i = HTML.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0; for (let k = HTML.indexOf('{', i); k < HTML.length; k++) { d += (HTML[k] === '{') - (HTML[k] === '}'); if (!d) return HTML.slice(i, k + 1); } throw new Error(name); }
const sandbox = { Object, JSON, Array, String, Number, FB: { serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }), FieldPath: function (a, b) { this.p = [a, b]; }, deleteField: () => ({ __del: 1 }) } };
vm.createContext(sandbox); vm.runInContext(['_hasKey', '_deepEq', '_noSts', '_mapDiff', '_buildMergeWrite'].map((n) => { try { return fnSrc(n); } catch (e) { return ''; } }).join('\n'), sandbox);
test('T602.9 the Client stamps `sts` with the database timestamp on every persisted WORKING set (done) and only on those', () => {
  const set = { log_2_0_0_s0: { done: true, carga: '100', ts: 1 }, log_2_0_0_s1: { done: false, carga: '100' }, exnote_2_0: 'x', postsession_2_0: { rpe: 7 } };
  const w = sandbox._buildMergeWrite({}, { entries: { set, del: [] } });
  assert.deepEqual(w.data.entries.log_2_0_0_s0.sts, { __sentinel: 'serverTimestamp' });
  assert.equal(w.data.entries.log_2_0_0_s0.ts, 1, 'the device clock stays as display data');
  assert.equal('sts' in w.data.entries.log_2_0_0_s1, false); assert.equal(w.data.entries.exnote_2_0, 'x'); assert.equal('sts' in w.data.entries.postsession_2_0, false);
  assert.equal(set.log_2_0_0_s0.sts, undefined, 'the caller\'s object is never mutated');
});
test('T602.10 the server stamp coming back in the snapshot is NOT news: an echo of our own write must not be adopted as a remote change', () => {
  const local = { log_2_0_0_s0: { done: true, carga: '100' } }, remote = { log_2_0_0_s0: { done: true, carga: '100', sts: { seconds: 1, nanoseconds: 0 } } };
  const d = sandbox._mapDiff(remote, local, false); assert.deepEqual(JSON.parse(JSON.stringify(d)), { set: {}, del: [] });
  const changed = sandbox._mapDiff({ log_2_0_0_s0: { done: true, carga: '102.5', sts: { seconds: 1, nanoseconds: 0 } } }, local, false); assert.equal(Object.keys(changed.set).length, 1, 'a real change is still news');
});
