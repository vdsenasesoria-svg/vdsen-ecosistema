'use strict';
// T581: END-TO-END matrix on the REAL Firebase Admin SDK + Firestore Emulator (synthetic data only).
//   Motor-style plan (names only) -> REAL Coach import normalizer + PID stamp -> saved -> logbook evidence -> trusted executor
//   -> PENDING -> APPLIED -> next-exposure effective prescription -> CONSUMED.
// The plan documents are produced by the Coach's own normalizer (tests/helpers/coach-plan-import.js): nothing the Coach never writes is hand-crafted into them.
// The equipment IDENTITY comes from the shipped public catalog; the INCREMENT is a synthetic Coach-configured fixture. No real client / coach / gym data.
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = admin.initializeApp({ projectId }, 't581-integral-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription.js');
const { importLikeCoach } = require('./helpers/coach-plan-import.js');
test.after(async () => { await app.delete(); });

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const clock = () => '2026-10-01T00:00:00.000Z';
const EXACT_NAME = 'Jalón Dorsal Convergente discos';                 // exact catalog name -> sf-sd-converging-lat-pulldown-plate-loaded
const EXACT_ID = 'sf-sd-converging-lat-pulldown-plate-loaded';
const UNKNOWN_NAME = 'Press Convergente Inclinado';                    // a real Motor name that is NOT in the catalog (stays unresolved)
const STEP = { kind: 'STEP', step: 5, min: 0, unit: 'KG', source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT', configuredAt: '2026-09-26T00:00:00.000Z', configuredBy: 'synthetic-t581', revision: 1 };
let seq = 0;

const motorPlan = (names, o) => ({ weeks: 4, daysPerWeek: 2, days: [0, 2].map((dayIndex) => ({ dayIndex, label: 'Día ' + dayIndex, exercises: names.map((exerciseName) => Object.assign({ exerciseName, technique: 'straight',
  sets: [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget: (o && o.repsTarget) || 10, rirTarget: (o && o.rirTarget) || 2, load: 0, restSeconds: 90 })) }, o && o.repsRange ? { repsRange: o.repsRange } : {})) })) });

// o: names[], recs: (exercise index) => progrec recommendation fields | null, increments, exposures (default both W1 days), interventions, planUpdatedAt, coachCanary
async function seed(o) {
  o = o || {};
  const tag = 't581i-' + (++seq) + '-' + Date.now().toString(36), uid = 'ath-' + tag, planId = 'plan-' + tag, coachId = 'coach-' + tag;
  const names = o.names || [EXACT_NAME];
  const imported = importLikeCoach(motorPlan(names, o), { idPrefix: 'pid-' + tag });
  const plan = Object.assign({ schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: o.planUpdatedAt || '2026-09-26T00:00:00.000Z' }, imported);
  const pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId);
  // Real shape: a PID belongs to ONE day of the plan, so its history is consecutive WEEKS of that same prescription (W1 D0, W2 D0, ...).
  const logs = {}, weeks = o.weeks || [1, 2], last = weeks[weeks.length - 1];
  weeks.forEach((w) => names.forEach((n, e) => [0, 1, 2].forEach((s) => {
    logs['log_' + w + '_0_' + e + '_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: o.rirTarget || 2, rir_real: o.rirReal || 4, prescriptionExerciseId: pids[e], ts: T0 + w * 1e6 + e * 100 + s };
  })));
  if (o.recs) {
    const recommendations = names.map((n, e) => o.recs(e, pids[e], plan.days[0].exercises[e])).filter(Boolean);
    if (recommendations.length) logs['progrec_' + last + '_0'] = { calculatedAt: new Date(T0 + last * 1e6 + 60000).toISOString(), recommendations };
  }
  const coach = { autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } };
  if (o.increments) coach.equipmentIncrements = o.increments;
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: o.interventions || [] });
  await db.doc('coaches/' + coachId).set(coach);
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + uid).set({ planId, entries: logs });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { uid, planId, coachId, plan, pids, logs };
}
const open = (ids) => db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ids });
const run = async (s, extra) => {
  const { keepAllowlist, ...rest } = extra || {};
  if (!keepAllowlist) await open([s.uid]);
  return executor.processProgression(Object.assign({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true, clock }, rest));
};
const meso = async (s) => (await db.doc('logs/' + s.uid + '/mesos/' + s.planId).get()).data();
const overlays = (m) => Object.values((m && m.nextExposureOverlays) || {});
const records = (m) => Object.values((m && m.progressionApplications) || {});
const digest = async (s) => JSON.stringify(await Promise.all(['clients/' + s.uid, 'plans/' + s.planId, 'coaches/' + s.coachId, 'logs/' + s.uid, 'logs/' + s.uid + '/mesos/' + s.planId].map(async (p) => (await db.doc(p).get()).data())));
const withId = (ex, r) => (ex.exerciseId ? Object.assign({ exerciseId: ex.exerciseId }, r) : r);
const loadRec = (e, pid, ex) => withId(ex, { prescriptionExerciseId: pid, exerciseName: ex.exerciseName, action: 'increase_load', newLoad: 105 });
const baseSets = (ex) => ex.sets.map((x) => Object.assign({}, x, { load: 100 }));
const eff = async (s, ei, m, week, dayIndex, interventions) => {
  const plan = (await db.doc('plans/' + s.planId).get()).data();
  return effective.resolveEffective({ clientId: s.uid, planId: s.planId, activePlanId: s.planId, pid: s.pids[ei], week, dayIndex, records: m.progressionApplications || {}, overlays: m.nextExposureOverlays || {},
    interventions: interventions || [], plan, entries: m.entries, baseSets: baseSets(plan.days[0].exercises[ei]), canonicalOverlayRead: true });
};


const byPid = (m, pid) => records(m).filter((r) => r.prescriptionExerciseId === pid)[0];

test('INT-01 NEW Motor plan: exact catalog name -> exerciseId at import -> verified increment -> LOAD APPLIED with NO manual link -> next session shows it -> CONSUMED', async () => {
  const s = await seed({ names: [EXACT_NAME, UNKNOWN_NAME], increments: { shared: { [EXACT_ID]: STEP }, gyms: {} }, recs: loadRec });
  const ex = s.plan.days[0].exercises;
  assert.equal(ex[0].exerciseId, EXACT_ID); assert.equal(ex[0].exerciseIdSource, 'CATALOG_EXACT_NAME'); assert.ok(!('exerciseId' in ex[1]), 'unknown name stays unresolved');
  assert.ok(s.pids.every((p) => p && p !== EXACT_ID) && new Set(s.pids).size === 2, 'PIDs are per-instance and never derived from exerciseId');
  assert.equal((await db.doc('coaches/' + s.coachId).get()).data().exerciseLinks, undefined, 'no manual link exists');
  const planBefore = JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), entriesBefore = JSON.stringify((await meso(s)).entries);
  const out = await run(s);
  assert.equal(out.status, 'MATERIALIZED', JSON.stringify(out));
  let m = await meso(s);
  const r0 = byPid(m, s.pids[0]), r1 = byPid(m, s.pids[1]);
  assert.equal(r0.state, 'APPLIED'); assert.deepEqual(r0.events.map((e) => e.state), ['PENDING', 'APPLIED']);
  const ov = overlays(m).filter((o) => o.prescriptionExerciseId === s.pids[0])[0];
  assert.equal(ov.dimension, 'LOAD'); assert.equal(ov.previousValue, 100); assert.equal(ov.appliedValue, 105); assert.equal(ov.equipmentId, EXACT_ID);
  assert.equal(r1.state, 'APPLIED', 'T582: the exercise with NO catalog identity still progresses (advisory target)');
  const ov1 = overlays(m).filter((o) => o.prescriptionExerciseId === s.pids[1])[0];
  assert.equal(ov1.dimension, 'LOAD'); assert.equal(ov1.equipmentId, null); assert.equal(ov1.appliedValue, 105); assert.equal(ov1.equipmentSnapshot.source, 'ADVISORY_GENERIC');
  assert.equal(out.applied.filter((a) => a.blocked).length, 0, 'nothing is blocked by missing equipment data');
  assert.equal(JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), planBefore, 'base plan immutable'); assert.equal(JSON.stringify(m.entries), entriesBefore, 'logbook untouched');
  const e0 = await eff(s, 0, m, ov.target.week, ov.target.dayIndex); assert.equal(e0.provenance, 'CANONICAL_OVERLAY'); assert.equal(e0.sets[0].effective.load, 105); assert.equal(e0.sets[0].base.load, 100);
  const e1 = await eff(s, 1, m, ov.target.week, ov.target.dayIndex); assert.equal(e1.provenance, 'CANONICAL_OVERLAY'); assert.equal(e1.sets[0].effective.load, 105, 'the advisory target reaches the next session too');
  const first = {}; first['log_' + ov.target.week + '_' + ov.target.dayIndex + '_0_s0'] = { done: true, carga: '105', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: s.pids[0], ts: T0 + 9e6 };
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ entries: first }, { merge: true });
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ consumptionReceipts: { [r0.key]: { recordKey: r0.key, overlayKey: ov.key, dimension: 'LOAD', appliedValue: 105, provenance: 'CANONICAL_OVERLAY', ackAt: clock() } } }, { merge: true });
  const out2 = await run(s); assert.deepEqual(out2.consumed.map((x) => x.written), [true], JSON.stringify(out2.consumed));
  m = await meso(s); assert.equal(byPid(m, s.pids[0]).state, 'CONSUMED'); assert.equal(overlays(m).filter((o) => o.prescriptionExerciseId === s.pids[0])[0].status, 'CONSUMED');
  await run(s); await run(s); m = await meso(s);
  assert.equal(byPid(m, s.pids[0]).events.filter((e) => e.state === 'CONSUMED').length, 1, 'repeat adds nothing');
});

test('INT-02 (T582) exact catalog name but NO verified increment => LOAD is an ADVISORY target (not withheld); the decision trace is persisted for the Coach', async () => {
  const s = await seed({ recs: loadRec });
  const out = await run(s); const m = await meso(s);
  assert.deepEqual(out.applied.map((a) => [a.written, a.blocked]), [[true, null]]);
  assert.equal(overlays(m).length, 1); assert.equal(overlays(m)[0].equipmentId, null); assert.equal(overlays(m)[0].appliedValue, 105); assert.equal(records(m)[0].state, 'APPLIED'); assert.ok(records(m)[0].magnitude, 'the decision trace is persisted for the Coach');
});

test('INT-03 no history (single exposure, no recommendation) => conservative: no record, no overlay, base prescription', async () => {
  const s = await seed({ weeks: [1] });
  const out = await run(s); const m = await meso(s);
  assert.ok(out.status !== 'MATERIALIZED'); assert.equal(records(m).length, 0); assert.equal(overlays(m).length, 0);
  assert.notEqual((await eff(s, 0, m, 2, 0)).provenance, 'CANONICAL_OVERLAY');
});

test('INT-04 MAINTAIN decision (recommendation equals the current target) => REJECTED NO_NUMERIC_DELTA: nothing applied, reason kept for the Coach', async () => {
  const s = await seed({ recs: (e, pid, ex) => withId(ex, { prescriptionExerciseId: pid, exerciseName: ex.exerciseName, action: 'maintain', newReps: 10 }) });
  await run(s); const m = await meso(s);
  assert.equal(records(m).length, 1); assert.equal(records(m)[0].state, 'REJECTED'); assert.equal(records(m)[0].reasonCode, 'NO_NUMERIC_DELTA'); assert.equal(overlays(m).length, 0);
});

test('INT-05 conflicting identity (recommendation exerciseId != plan exerciseId) => REJECTED IDENTITY_CONFLICT (BLOCK), nothing applied', async () => {
  const s = await seed({ increments: { shared: { [EXACT_ID]: STEP }, gyms: {} }, recs: (e, pid, ex) => Object.assign(loadRec(e, pid, ex), { exerciseId: 'sf-sd-belt-squat' }) });
  await run(s); const m = await meso(s);
  assert.equal(records(m)[0].state, 'REJECTED'); assert.equal(records(m)[0].reasonCode, 'IDENTITY_CONFLICT'); assert.equal(overlays(m).length, 0);
});

test('INT-06 the Coach changed the prescription: a later Coach intervention or a later plan edit makes the candidate STALE (nothing applied); a post-apply intervention resolves to the base', async () => {
  const inc = { shared: { [EXACT_ID]: STEP }, gyms: {} };
  const a = await seed({ increments: inc, recs: loadRec });
  await db.doc('clients/' + a.uid).update({ coachInterventions: [{ id: 'iv-1', targetType: 'EXERCISE', targetId: a.pids[0], action: 'REDUCE_SETS', decidedAt: '2026-09-27T14:00:00.000Z' }] });
  await run(a); let m = await meso(a);
  assert.equal(records(m)[0].state, 'STALE'); assert.equal(records(m)[0].reasonCode, 'COACH_OVERRIDE'); assert.equal(overlays(m).length, 0);
  const b = await seed({ increments: inc, recs: loadRec, planUpdatedAt: '2026-09-28T00:00:00.000Z' });
  await run(b); m = await meso(b);
  assert.equal(records(m)[0].state, 'STALE'); assert.equal(records(m)[0].reasonCode, 'PLAN_CHANGED'); assert.equal(overlays(m).length, 0);
  const c = await seed({ increments: inc, recs: loadRec }); await run(c); m = await meso(c); const ov = overlays(m)[0];
  assert.equal((await eff(c, 0, m, ov.target.week, ov.target.dayIndex)).provenance, 'CANONICAL_OVERLAY');
  const after = await eff(c, 0, m, ov.target.week, ov.target.dayIndex, [{ id: 'iv-2', targetType: 'EXERCISE', targetId: c.pids[0], action: 'REDUCE_SETS', decidedAt: '2026-10-02T00:00:00.000Z' }]);
  assert.notEqual(after.provenance, 'CANONICAL_OVERLAY', 'a Coach decision after the application wins over the overlay');
});

test('INT-07 multi-client isolation: two athletes, distinct plans/coaches; processing one never writes the other; each overlay references only its own identity', async () => {
  const inc = { shared: { [EXACT_ID]: STEP }, gyms: {} };
  const a = await seed({ increments: inc, recs: loadRec }), b = await seed({ names: [EXACT_NAME, UNKNOWN_NAME], increments: inc, recs: loadRec });
  await open([a.uid, b.uid]);
  const bBefore = await digest(b);
  await run(a, { keepAllowlist: true });
  assert.equal(await digest(b), bBefore, 'processing A wrote nothing of B');
  await run(b, { keepAllowlist: true });
  const ma = await meso(a), mb = await meso(b);
  assert.ok(overlays(ma).every((o) => o.clientId === a.uid && o.planId === a.planId && a.pids.includes(o.prescriptionExerciseId)));
  assert.ok(overlays(mb).every((o) => o.clientId === b.uid && o.planId === b.planId && b.pids.includes(o.prescriptionExerciseId)));
  assert.equal(overlays(ma).length, 1); assert.equal(overlays(mb).length, 2);
  const cross = await executor.processProgression({ db, clientId: a.uid, planId: b.planId, enabled: true, numericApplyEnabled: true, clock });
  assert.equal(cross.status, 'PLAN_MISMATCH'); assert.equal(overlays(await meso(b)).length, 2, 'unchanged by the cross request');
});

test('INT-08 two simultaneous requests and a reopened session (same evidence rewritten) => exactly ONE application, ONE APPLIED event', async () => {
  const s = await seed({ increments: { shared: { [EXACT_ID]: STEP }, gyms: {} }, recs: loadRec });
  await Promise.all([run(s), run(s), run(s), run(s), run(s)]);
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ planId: s.planId, entries: s.logs }, { merge: true });
  await db.doc('logs/' + s.uid).set({ planId: s.planId, entries: s.logs }, { merge: true });
  await run(s); await run(s);
  const m = await meso(s);
  assert.equal(records(m).length, 1); assert.equal(overlays(m).length, 1); assert.equal(records(m)[0].events.filter((e) => e.state === 'APPLIED').length, 1);
});

test('INT-09 flags OFF: DISARMED writes nothing; numeric apply OFF materializes PENDING only (no overlay, no numeric change)', async () => {
  const s = await seed({ increments: { shared: { [EXACT_ID]: STEP }, gyms: {} }, recs: loadRec });
  const d0 = await digest(s);
  assert.deepEqual(await run(s, { enabled: false }), { status: 'DISARMED', writes: 0 }); assert.equal(await digest(s), d0);
  const pend = await run(s, { numericApplyEnabled: false });
  assert.deepEqual([pend.applied, pend.consumed], [[], []]); const m = await meso(s);
  assert.equal(overlays(m).length, 0); assert.equal(records(m)[0].state, 'PENDING');
});

test('INT-10 universal availability is not activation: a client outside the release allowlist gets zero writes even with a Coach canary open', async () => {
  const s = await seed({ increments: { shared: { [EXACT_ID]: STEP }, gyms: {} }, recs: loadRec });
  await open(['someone-else']);
  const d0 = await digest(s); const out = await run(s, { keepAllowlist: true });
  assert.equal(out.status, 'OUT_OF_ALLOWLIST'); assert.equal(await digest(s), d0);
});

test('INT-11 characterization: a plan with a UNIFORM repsTarget (the Motor stores the CEILING and no repsRange) has no rep room, so a REPS candidate (target RIR 1) is never applied', async () => {
  const s = await seed({ rirTarget: 1, rirReal: 3, recs: (e, pid, ex) => withId(ex, { prescriptionExerciseId: pid, exerciseName: ex.exerciseName, action: 'increase_reps', newReps: 11 }) });
  assert.ok(!('repsRange' in s.plan.days[0].exercises[0]), 'the Coach persists no repsRange');
  await run(s); const m = await meso(s);
  assert.equal(overlays(m).length, 0); assert.equal(records(m).length, 1); assert.notEqual(records(m)[0].state, 'APPLIED');
});
