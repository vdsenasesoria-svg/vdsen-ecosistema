'use strict';
// T599-R — D-02 (an overlay invalidated BEFORE its exposure started never regains authority from a later execution) and D-01 (a legacy `maintain` recommendation must not stop
// the canonical magnitude policy from evaluating valid evidence: rules C / E) plus record.dimension coherence (D-07).
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./helpers/lifecycle-fixture.js');
const { makeStore } = require('./helpers/fake-firestore.js');
const eff = require('../assets/progression-effective-prescription.js');
const shadow = F.off.shadow;

// ───────────── D-02 : pure authority ─────────────
const EDIT = '2026-09-28T09:00:00.000Z', BEFORE = Date.parse('2026-09-28T08:00:00.000Z'), AFTER = Date.parse('2026-09-28T10:00:00.000Z');
function setup(o = {}) {
  const sc = F.scenario(), a = F.applied(sc), input = F.effectiveInput(a, { canonicalOverlayRead: true });
  const target = a.overlay.target;
  if (o.planAt) input.plan = Object.assign({}, a.plan, { updatedAt: o.planAt });
  if (o.interventions) input.interventions = o.interventions;
  if (o.startTs !== undefined) input.entries = Object.assign({}, a.entries, { ['log_' + target.week + '_' + target.dayIndex + '_0_s0']: Object.assign({ done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: sc.pid, ts: 5 /* device clock: ignored for authority (T602) */ }, o.startTs === null ? {} : { sts: o.startTs }) });
  return { a, sc, input, target };
}
const verdict = (input) => eff.evaluateOverlay(input);

test('D-02.1 plan edited BEFORE the exposure starts: the later first set cannot revive the overlay', () => {
  const { input } = setup({ planAt: EDIT, startTs: AFTER });
  const v = verdict(input); assert.equal(v.usable, false); assert.equal(v.reason, 'TARGET_INVALIDATED');
  const r = eff.resolveEffective(input); assert.equal(r.provenance, 'BASE_PLAN'); assert.ok(r.sets.every((s) => s.effective.load === 0));
  assert.equal(eff.describeProgression(input).applied, false);
});
test('D-02.2 plan edited AFTER the exposure started: the application in force at the start is not retroactively removed', () => {
  const { input } = setup({ planAt: EDIT, startTs: BEFORE });
  assert.equal(verdict(input).usable, true); assert.equal(eff.resolveEffective(input).provenance, 'CANONICAL_OVERLAY');
});
test('D-02.3 plan edit and first set at the same instant, or a first set without a SERVER-confirmed timestamp: fail closed (invalidated)', () => {
  assert.equal(verdict(setup({ planAt: EDIT, startTs: Date.parse(EDIT) }).input).usable, false);
  assert.equal(verdict(setup({ planAt: EDIT, startTs: null }).input).usable, false);
});
test('D-02.4 an unedited plan keeps working before and after the first set; a not-started invalidated overlay stays invalid', () => {
  assert.equal(verdict(setup({ startTs: AFTER }).input).usable, true);
  assert.equal(verdict(setup({}).input).usable, true);
  assert.equal(verdict(setup({ planAt: EDIT }).input).reason, 'TARGET_INVALIDATED');
});
test('D-02.5 exact Coach override decided BEFORE the first set stays decisive; decided AFTER it does not rewrite the exposure', () => {
  const iv = (at) => [{ targetType: 'EXERCISE', targetId: F.scenario().pid, decidedAt: at, action: 'MODIFY' }];
  const before = verdict(setup({ interventions: iv(EDIT), startTs: AFTER }).input); assert.equal(before.usable, false); assert.equal(before.reason, 'COACH_OVERRIDE');
  assert.equal(verdict(setup({ interventions: iv(EDIT), startTs: BEFORE }).input).usable, true);
  assert.equal(verdict(setup({ interventions: iv(EDIT) }).input).reason, 'COACH_OVERRIDE', 'not started: override wins (unchanged)');
});
test('D-02.6 pain after the source session still wins over everything, started or not (unchanged guard)', () => {
  const { input, a } = setup({ startTs: AFTER });
  input.entries = Object.assign({}, input.entries, { postsession_1_1: { articularPain: { present: true } } });
  assert.equal(verdict(Object.assign({}, input, { safetyConflict: true })).reason, 'SAFETY_CONFLICT');
  void a;
});
test('D-02.7 a CONSUMED application keeps governing its own exposure (the server only consumes valid ones)', () => {
  const sc = F.scenario(), a = F.applied(sc, { state: 'CONSUMED' }), input = F.effectiveInput(a, { canonicalOverlayRead: true });
  input.plan = Object.assign({}, a.plan, { updatedAt: EDIT });
  assert.equal(verdict(input).usable, true);
});

// ───────────── D-02 : server-side consumption (receipt + execution) ─────────────
const C = F.on.consumer;
const REFS = { meso: 'logs/c/mesos/p', plan: 'plans/p', client: 'clients/c', root: 'logs/c', coach: 'coaches/k' };
const SCOPE = { enabled: true, clientIds: ['c'], prescriptionExerciseIds: [] };
function store(sc) {
  return makeStore({ [REFS.client]: { activePlanId: 'p', coachInterventions: [], coachId: 'k' }, [REFS.plan]: sc.plan,
    [REFS.meso]: { planId: 'p', entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec } }, [REFS.root]: { planId: 'p' }, [REFS.coach]: { role: 'coach', autoApplyCanary: SCOPE } });
}
async function appliedStore() {
  const sc = F.scenario(), s = store(sc);
  const r = await s.run((tx) => C.applyOverlayTransaction(tx, REFS, { recordKey: sc.rec.key, expectedRevision: sc.rec.revision, now: '2026-09-28T01:00:00.000Z', actorId: 'k',
    context: { clientId: 'c', planId: 'p', equipmentResolution: F.equipmentFor(sc), resolveNextExposure: F.shadowOn.resolveNextExposure } }, { isCurrent: () => true }));
  assert.equal(r.written, true, JSON.stringify(r.reason));
  return { s, sc, key: sc.rec.key };
}
function startAndAck(a, ts) {
  const m = a.s.docs.get(REFS.meso), o = m.nextExposureOverlays['ovl_' + a.key];
  m.entries.log_2_0_0_s0 = { carga: '102.5', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-1', ts: 5, sts: ts };
  m.consumptionReceipts = { [a.key]: { recordKey: a.key, overlayKey: o.key, dimension: o.dimension, appliedValue: o.appliedValue, provenance: 'CANONICAL_OVERLAY', ackAt: '2026-09-28T10:01:00.000Z' } };
}
const consume = (a) => a.s.run((tx) => C.consumeOverlayTransaction(tx, REFS, { recordKey: a.key, clientId: 'c', now: '2026-09-28T11:00:00.000Z', actorId: 'k' }, { isCurrent: () => true }));
const stateOf = (a) => a.s.docs.get(REFS.meso).progressionApplications[a.key].state;

test('D-02.8 server: a receipt and a first set after a PRE-START plan edit are never turned into CONSUMED', async () => {
  const a = await appliedStore(); a.s.docs.get(REFS.plan).updatedAt = EDIT; startAndAck(a, AFTER);
  const r = await consume(a); assert.equal(r.written, false); assert.equal(r.reason, 'TARGET_INVALIDATED'); assert.equal(stateOf(a), 'APPLIED');
  assert.equal(a.s.docs.get(REFS.meso).nextExposureOverlays['ovl_' + a.key].status, 'APPLIED');
});
test('D-02.9 server: the same receipt retried late (after more time) is still refused; a legitimate one is consumed', async () => {
  const bad = await appliedStore(); bad.s.docs.get(REFS.plan).updatedAt = EDIT; startAndAck(bad, AFTER);
  assert.equal((await consume(bad)).written, false); assert.equal((await consume(bad)).written, false);
  const good = await appliedStore(); startAndAck(good, AFTER);
  const r = await consume(good); assert.equal(r.written, true); assert.equal(stateOf(good), 'CONSUMED');
});
test('D-02.10 server: a plan edit AFTER the first set does not block consuming what the athlete really started with', async () => {
  const a = await appliedStore(); startAndAck(a, BEFORE); a.s.docs.get(REFS.plan).updatedAt = EDIT;
  const r = await consume(a); assert.equal(r.written, true, JSON.stringify(r.reason)); assert.equal(stateOf(a), 'CONSUMED');
});
test('D-02.11 server: an exact Coach override decided before the first set blocks consumption', async () => {
  const a = await appliedStore(); startAndAck(a, AFTER);
  a.s.docs.get(REFS.client).coachInterventions = [{ targetType: 'EXERCISE', targetId: 'pid-1', decidedAt: EDIT, action: 'MODIFY' }];
  const r = await consume(a); assert.equal(r.written, false); assert.equal(r.reason, 'COACH_OVERRIDE'); assert.equal(stateOf(a), 'APPLIED');
});

// ───────────── D-01 : legacy `maintain` must not hide rules C / E ─────────────
function build(over = {}, rec = {}) {
  const sc = F.scenario({ prior: over.prior || F.OK, latest: over.latest || F.OK });
  const plan = over.plan ? over.plan(sc.plan) : sc.plan;
  return shadow.buildRecord({ clientId: sc.clientId, planId: sc.planId, activePlanId: sc.planId, plan, entries: over.entries || sc.entries, week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    interventions: over.interventions || [], recommendation: Object.assign({ prescriptionExerciseId: sc.pid, exerciseId: sc.exerciseId, exerciseName: 'X', action: 'maintain', newLoad: 100, newReps: 10 }, rec) }, '2026-09-27T13:00:00.000Z');
}
test('D-01.1 rule C: legacy "maintain" + RIR as prescribed + last set short -> REST +30 s candidate, PENDING and eligible (not REJECTED NO_NUMERIC_DELTA)', () => {
  const r = build({ latest: F.C9 });
  assert.equal(r.state, 'PENDING'); assert.equal(r.reasonCode, 'MAGNITUDE_POLICY_MISSING');
  assert.equal(r.magnitude.ruleId, 'C'); assert.equal(r.magnitude.eligible, true);
  const c = r.magnitude.candidates[0]; assert.deepEqual([c.dimension, c.previousValue, c.finalCandidate], ['REST', 90, 120]);
  assert.equal(r.dimension, 'REST', 'D-07: the record carries the canonical dimension');
  assert.equal(r.action, 'maintain', 'the legacy trigger is preserved verbatim');
});
test('D-01.2 rule E: reps incomplete without RIR evidence -> COACH_REVIEW_REQUIRED on a PENDING (non-eligible) record', () => {
  const r = build({ latest: [{}, {}, { reps: '7', rir_real: null }] });
  assert.equal(r.state, 'PENDING'); assert.equal(r.magnitude.coachReviewRequired.branch, 'E'); assert.equal(r.magnitude.eligible, false); assert.deepEqual(r.magnitude.candidates, []);
});
test('D-01.3 negative: maintain with nothing to adjust keeps the old behaviour (REJECTED NO_NUMERIC_DELTA, no invented increment)', () => {
  const r = build({ latest: F.OK }); assert.equal(r.state, 'REJECTED'); assert.equal(r.reasonCode, 'NO_NUMERIC_DELTA'); assert.ok(!r.magnitude || !(r.magnitude.candidates || []).length);
});
test('D-01.4 negative: a single comparable exposure (insufficient evidence) never yields an eligible candidate from a maintain trigger', () => {
  const sc = F.scenario({ latest: F.C9 }), entries = Object.fromEntries(Object.entries(sc.entries).filter(([k]) => !/^log_1_0_/.test(k)));
  const r = build({ latest: F.C9, entries });
  assert.ok(!(r.state === 'PENDING' && r.magnitude && r.magnitude.eligible), JSON.stringify([r.state, r.reasonCode]));
});
test('D-01.5 negative: pain, a Coach decision or a wrong PID block the maintain path exactly as before', () => {
  const sc = F.scenario({ latest: F.C9 });
  const pain = Object.assign({}, sc.entries, { postsession_1_2: { articularPain: { present: true } } });
  const p = build({ latest: F.C9, entries: pain }); assert.ok(!(p.state === 'PENDING' && p.magnitude && p.magnitude.eligible), 'pain');
  const iv = build({ latest: F.C9, interventions: [{ targetType: 'EXERCISE', targetId: sc.pid, decidedAt: '2026-09-27T18:00:00.000Z', action: 'MODIFY' }] });
  assert.equal(iv.state, 'STALE'); assert.equal(iv.reasonCode, 'COACH_OVERRIDE');
  const w = build({ latest: F.C9 }, { prescriptionExerciseId: 'other-pid' }); assert.notEqual(w.state, 'PENDING');
});
test('D-01.6 other actions are untouched: increase_load keeps its LOAD path and a record dimension that matches the canonical decision', () => {
  const r = build({ latest: F.EASY, prior: F.EASY }, { action: 'increase_load', newLoad: 101.5 });
  assert.equal(r.state, 'PENDING'); assert.equal(r.magnitude.dimension, 'LOAD'); assert.equal(r.dimension, 'LOAD');
});
test('D-07 record.dimension follows the canonical decision, not the legacy action (REPS decided while the Client said increase_load)', () => {
  const sc = F.scenario({ latest: F.EASY, prior: F.EASY }), e1 = Object.fromEntries(Object.entries(sc.entries).map(([k, v]) => [k, Object.assign({}, v, { rir: 1 })]));
  const r = build({ latest: F.EASY, prior: F.EASY, entries: e1, plan: (p) => { const q = JSON.parse(JSON.stringify(p)); q.days.forEach((d) => d.exercises.forEach((e) => { e.repsRange = { min: 8, max: 12 }; e.sets.forEach((s) => { s.rirTarget = 1; }); })); return q; } },
    { action: 'increase_load', newLoad: 101.5 });
  assert.equal(r.magnitude.dimension, 'REPS'); assert.equal(r.dimension, 'REPS'); assert.equal(r.action, 'increase_load');
});

// ───────────── D-08 : the receipt must reach the server (no dropped trigger) ─────────────
const fs = require('node:fs'), vm = require('node:vm');
const HTML = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name) { const i = HTML.indexOf('function ' + name + '('); let d = 0; for (let k = HTML.indexOf('{', i); k < HTML.length; k++) { d += (HTML[k] === '{') - (HTML[k] === '}'); if (!d) return HTML.slice(i, k + 1); } throw new Error(name); }
test('D-08 a trigger requested while one is in flight is remembered and runs once more (never dropped); no storm', async () => {
  const calls = []; let release;
  const ctx = { USER: { uid: 'u', getIdToken: async () => 't' }, ACTIVE_PLAN_ID: 'p', FB: { db: {}, waitForPendingWrites: () => new Promise((r) => { release = r; }) }, console, Promise,
    fetch: async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ status: 'NO_CHANGE' }) }; }, _trustedProgressionPending: Object.create(null) };
  const begin = HTML.indexOf('function _scheduleTrustedProgression(');
  vm.createContext(ctx); vm.runInContext(HTML.slice(begin, HTML.indexOf('// T570-R: the athlete app never creates canonical records.', begin)), ctx);
  ctx._scheduleTrustedProgression('u', 'p'); ctx._scheduleTrustedProgression('u', 'p'); ctx._scheduleTrustedProgression('u', 'p');
  release(); await new Promise((r) => setTimeout(r, 20)); release(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 2, 'one in-flight call + exactly one remembered re-run');
});
test('D-08 the Client schedules the trigger again right after it writes a consumption receipt', () => {
  const body = fnSrc('_maybeConsumeOverlays'); const w = body.indexOf('if (res && res.written)');
  assert.ok(w > 0 && /_scheduleTrustedProgression\(uid, st\.planId\)/.test(body.slice(w, w + 160)));
});
