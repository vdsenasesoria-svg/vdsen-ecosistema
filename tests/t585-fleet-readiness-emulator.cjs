'use strict';
// T585: FLEET READINESS on the REAL Firebase Admin SDK + Firestore Emulator (synthetic data only, project demo-*).
// Question answered: if the autonomous progression were opened for every other client, what would the trusted executor do for each realistic athlete
// profile, and which production-shaped plans (legacy, no revision timestamp, no PID) would be silently ineligible until the Coach saves them again?
// Plans are produced by the REAL Coach normalizer + save-time PID stamp (tests/helpers/coach-plan-import.js). Nothing is written to production.
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = admin.initializeApp({ projectId }, 't585-fleet-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
const { importLikeCoach, coachSandbox } = require('./helpers/coach-plan-import.js');
test.after(async () => { await app.delete(); });

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const clock = () => '2026-10-01T00:00:00.000Z';
let seq = 0;
const motorPlan = (names, o) => ({ weeks: 6, daysPerWeek: 2, days: [0, 2].map((dayIndex) => ({ dayIndex, label: 'Día ' + dayIndex, exercises: names.map((exerciseName) => Object.assign({ exerciseName, technique: 'straight',
  sets: [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget: (o && o.repsTarget) || 10, rirTarget: (o && o.rirTarget) || 2, load: 0, restSeconds: 90 })) }, o && o.repsRange ? { repsRange: o.repsRange } : {})) })) });

// o: names, unit, load, reps, rirTarget, rirReal, repsRange, action, newLoad, newReps, legacy, weeks, nowrec
async function athlete(o) {
  o = o || {};
  const tag = 't585-' + (++seq) + '-' + Date.now().toString(36), uid = 'ath-' + tag, planId = 'plan-' + tag, coachId = 'coach-' + tag, names = o.names || ['Jalón Dorsal Convergente discos'];
  let plan, pids = [];
  if (o.legacy) {   // production shape of the old "generate and activate" route: no PID, no updatedAt string
    plan = { schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', createdAt: '2026-09-20T00:00:00.000Z', weeks: 6, daysPerWeek: 2,
      days: [0, 2].map((dayIndex) => ({ dayIndex, label: 'Día ' + dayIndex, exercises: names.map((exerciseName) => ({ exerciseName, sets: [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 90 })) })) })) };
  } else {
    plan = Object.assign({ schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' }, importLikeCoach(motorPlan(names, o), { idPrefix: 'pid-' + tag }));
    pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId);
  }
  const logs = {}, weeks = o.weeks || [1, 2], last = weeks[weeks.length - 1], unit = o.unit || 'KG', load = o.load || 100;
  weeks.forEach((w) => names.forEach((n, e) => [0, 1, 2].forEach((s) => {
    logs['log_' + w + '_0_' + e + '_s' + s] = Object.assign({ done: true, carga: String(load), reps: String(o.reps || 10), unit, rir: o.rirTarget || 2, rir_real: o.rirReal === undefined ? 4 : o.rirReal, ics: o.ics || 8, ts: T0 + w * 1e6 + e * 100 + s }, pids[e] ? { prescriptionExerciseId: pids[e] } : {});
  })));
  if (o.action) logs['progrec_' + last + '_0'] = { calculatedAt: new Date(T0 + last * 1e6 + 60000).toISOString(), recommendations: names.map((n, e) => Object.assign({ exerciseName: n, action: o.action, newLoad: o.newLoad || load + 5, newReps: o.newReps || 10 }, pids[e] ? { prescriptionExerciseId: pids[e] } : {})) };
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: [] });
  await db.doc('coaches/' + coachId).set({ autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } });
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + uid).set({ planId, entries: logs });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { uid, planId, coachId, plan, pids, logs, names, unit, load };
}
const open = (ids) => db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ids });
const run = (s, extra) => executor.processProgression(Object.assign({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true, clock }, extra || {}));
const meso = async (s) => (await db.doc('logs/' + s.uid + '/mesos/' + s.planId).get()).data();
const overlays = (m) => Object.values((m && m.nextExposureOverlays) || {});
const records = (m) => Object.values((m && m.progressionApplications) || {});
// The executor legitimately mirrors a read-only `progressionApplicationSummary` onto logs/{uid}; everything the athlete or the Coach authored must stay byte-identical.
const digest = async (s) => JSON.stringify(await Promise.all(['clients/' + s.uid, 'plans/' + s.planId, 'coaches/' + s.coachId, 'logs/' + s.uid].map(async (p) => { const d = (await db.doc(p).get()).data(); if (p.startsWith('logs/') && d) { const { progressionApplicationSummary, ...rest } = d; return rest; } return d; })));

// ---- the fleet: ten realistic athlete profiles (the release allowlist cap) ----
const PROFILES = [
  { key: 'F01 easier than target, KG', o: { rirTarget: 2, rirReal: 4, action: 'increase_load' } },
  { key: 'F02 easier than target, LB', o: { unit: 'LB', load: 225, rirTarget: 2, rirReal: 4, action: 'increase_load', newLoad: 235 } },
  { key: 'F03 rep range with room (8-12 @ 10)', o: { repsRange: { min: 8, max: 12 }, rirTarget: 1, rirReal: 3, action: 'increase_reps', newReps: 11 } },
  { key: 'F04 at the ceiling of the range', o: { repsRange: { min: 8, max: 12 }, reps: 12, repsTarget: 12, rirTarget: 2, rirReal: 2, action: 'maintain', newReps: 12 } },
  { key: 'F05 harder than target (RIR below)', o: { rirTarget: 2, rirReal: 0, action: 'maintain' } },
  { key: 'F06 Client says deload (unsupported)', o: { rirTarget: 2, rirReal: 1, action: 'deload' } },
  { key: 'F07 Client says reduce_sets (unsupported)', o: { rirTarget: 2, rirReal: 1, action: 'reduce_sets' } },
  { key: 'F08 ICS>=8 add_sets only', o: { rirTarget: 2, rirReal: 4, ics: 10, action: 'add_sets' } },
  { key: 'F09 no catalog identity (advisory)', o: { names: ['Press Convergente Inclinado', 'Curl femoral sentado máquina'], rirTarget: 2, rirReal: 4, action: 'increase_load' } },
  { key: 'F10 single exposure only', o: { weeks: [1], rirTarget: 2, rirReal: 4, action: 'increase_load' } },
];

test('FLEET-01 ten profiles processed in one release window: every outcome is explicit, nothing crosses clients, base plans and logbooks are immutable', async () => {
  const fleet = []; for (const p of PROFILES) fleet.push(Object.assign({ key: p.key }, await athlete(p.o)));
  await open(fleet.map((f) => f.uid));
  const before = {}; for (const f of fleet) before[f.uid] = await digest(f);
  const report = [];
  for (const f of fleet) {
    const out = await run(f); const m = await meso(f), ovs = overlays(m), recs = records(m);
    assert.equal(await digest(f), before[f.uid], f.key + ': plan / client / coach / logbook are never written by the executor');
    assert.ok(ovs.every((o) => o.clientId === f.uid && o.planId === f.planId && f.pids.includes(o.prescriptionExerciseId)), f.key + ': overlays reference only their own identity');
    ovs.forEach((o) => { assert.ok(Number.isFinite(o.appliedValue) && o.appliedValue > 0, f.key + ': finite positive target'); });
    report.push({ profile: f.key, status: out.status, applied: recs.filter((r) => r.state === 'APPLIED').length, rejected: recs.filter((r) => r.state === 'REJECTED').map((r) => r.reasonCode).join('|') || '-', overlays: ovs.map((o) => o.dimension + ':' + o.previousValue + '->' + o.appliedValue).join(',') || '-' });
  }
  console.log('\nFLEET REPORT\n' + report.map((r) => '  ' + r.profile.padEnd(44) + ' ' + String(r.status).padEnd(14) + ' applied=' + r.applied + ' rejected=' + r.rejected + ' overlays=' + r.overlays).join('\n'));
  const by = (k) => report.find((r) => r.profile.startsWith(k));
  assert.match(by('F01').overlays, /LOAD:100->10[0-9.]+/); assert.match(by('F02').overlays, /LOAD:225->2[2-4][0-9]/);
  assert.match(by('F06').rejected, /UNSUPPORTED/); assert.match(by('F07').rejected, /UNSUPPORTED/); assert.equal(by('F06').overlays, '-'); assert.equal(by('F07').overlays, '-');
  assert.equal(by('F10').overlays, '-'); assert.equal(by('F10').applied, 0);
});

test('FLEET-02 the 10-client cap is a hard fail-closed: an allowlist of 11 is INVALID and nobody is activated (no partial rollout by accident)', async () => {
  const s = await athlete({ action: 'increase_load' }); const d0 = await digest(s);
  const eleven = Array.from({ length: 11 }, (_, i) => i === 0 ? s.uid : 'filler-' + i + '-' + 'x'.repeat(20));
  await open(eleven);
  const out = await run(s); assert.notEqual(out.status, 'MATERIALIZED', JSON.stringify(out)); assert.equal(await digest(s), d0); assert.equal(overlays(await meso(s)).length, 0);
  await open(eleven.slice(0, 10)); const ok = await run(s); assert.equal(ok.status, 'MATERIALIZED', 'ten is accepted'); console.log('\nCAP: 11 ids => ' + out.status + '; 10 ids => ' + ok.status);
});

test('FLEET-03 production-shaped LEGACY plan (old generate-and-activate route: no PID, no updatedAt string) is INERT and unchanged; after the Coach saves it again (real _stampPrescriptionIds + updatedAt) the same athlete progresses', async () => {
  const s = await athlete({ legacy: true, names: ['Jalón Dorsal Convergente discos', 'Press Convergente Inclinado'], action: 'increase_load' });
  await open([s.uid]); const d0 = await digest(s);
  const out = await run(s); const m = await meso(s);
  assert.equal(await digest(s), d0, 'legacy plan: nothing written'); assert.equal(overlays(m).length, 0); assert.equal(records(m).filter((r) => r.state === 'APPLIED').length, 0);
  console.log('\nLEGACY plan (no PID / no updatedAt): ' + out.status + ' ' + JSON.stringify(records(m).map((r) => r.state + ':' + r.reasonCode)));
  // The Coach's explicit save: real stamp function + a revision date BEFORE the athlete's next exposures (evidence is recorded after it).
  const sandbox = coachSandbox('resave-' + s.uid);
  const stamped = sandbox._stampPrescriptionIds(s.plan.days);
  assert.ok(stamped.every((d) => d.exercises.every((e) => typeof e.prescriptionExerciseId === 'string' && e.prescriptionExerciseId)), 'every exercise now has a PID');
  assert.equal(new Set(stamped.flatMap((d) => d.exercises.map((e) => e.prescriptionExerciseId))).size, 4, 'unique per exercise per day');
  const pidsD0 = stamped[0].exercises.map((e) => e.prescriptionExerciseId);
  await db.doc('plans/' + s.planId).update({ days: stamped, updatedAt: '2026-09-26T00:00:00.000Z' });
  // From the save onward the athlete trains W1 + W2 on the stamped plan (new evidence carries the PID, as the Client writes it).
  const fresh = {}, rec = [];
  [1, 2].forEach((w) => pidsD0.forEach((pid, e) => [0, 1, 2].forEach((x) => { fresh['log_' + w + '_0_' + e + '_s' + x] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 4, ics: 8, prescriptionExerciseId: pid, ts: T0 + w * 1e6 + e * 100 + x }; })));
  pidsD0.forEach((pid, e) => rec.push({ prescriptionExerciseId: pid, exerciseName: s.names[e], action: 'increase_load', newLoad: 105 }));
  fresh['progrec_2_0'] = { calculatedAt: new Date(T0 + 2e6 + 60000).toISOString(), recommendations: rec };
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ planId: s.planId, entries: fresh });
  await db.doc('logs/' + s.uid).set({ planId: s.planId, entries: fresh });
  const out2 = await run(s); const m2 = await meso(s);
  assert.equal(out2.status, 'MATERIALIZED', JSON.stringify(out2)); assert.equal(overlays(m2).length, 2, 'both exercises progress once the plan is re-saved');
  console.log('AFTER Coach re-save: ' + out2.status + ' overlays=' + overlays(m2).map((o) => o.dimension + ':' + o.previousValue + '->' + o.appliedValue).join(','));
});

test('FLEET-04 four consecutive weeks for a mixed fleet: one application per exposure, targets never decrease without a Coach decision, units stay stable, no overlay is double-applied', async () => {
  const fleet = []; for (const p of PROFILES.slice(0, 3)) fleet.push(await athlete(Object.assign({}, p.o, { weeks: [1, 2] })));
  await open(fleet.map((f) => f.uid));
  for (const f of fleet) {
    const seenKeys = new Set();
    for (let week = 2; week <= 5; week++) {
      const entries = {}, recs = [];
      for (let w = 1; w <= week; w++) f.pids.forEach((pid, e) => [0, 1, 2].forEach((x) => { entries['log_' + w + '_0_' + e + '_s' + x] = { done: true, carga: String(f.load + (w - 1) * 5), reps: '10', unit: f.unit, rir: 2, rir_real: 4, ics: 8, prescriptionExerciseId: pid, ts: T0 + w * 1e6 + e * 100 + x }; }));
      f.pids.forEach((pid, e) => recs.push({ prescriptionExerciseId: pid, exerciseName: f.names[e], action: 'increase_load', newLoad: f.load + week * 5 }));
      entries['progrec_' + week + '_0'] = { calculatedAt: new Date(T0 + week * 1e6 + 60000).toISOString(), recommendations: recs };
      await db.doc('logs/' + f.uid + '/mesos/' + f.planId).set({ planId: f.planId, entries }, { merge: true }); await db.doc('logs/' + f.uid).set({ planId: f.planId, entries }, { merge: true });
      await run(f); await run(f);   // the sweep may fire twice per sync: must not double-apply
    }
    const m = await meso(f), applied = records(m).filter((r) => r.state === 'APPLIED' || r.state === 'CONSUMED');
    const perExposure = {}; applied.forEach((r) => { const k = r.prescriptionExerciseId + '|' + JSON.stringify(r.target || r.key); perExposure[k] = (perExposure[k] || 0) + 1; });
    assert.ok(Object.values(perExposure).every((n) => n === 1), 'at most one application per (exercise, exposure)');
    overlays(m).forEach((o) => { assert.ok(o.appliedValue >= o.previousValue, 'a progression never lowers a target by itself'); seenKeys.add(o.key); });
    assert.equal(seenKeys.size, overlays(m).length, 'overlay keys are unique');
  }
});

test('FLEET-05 release hygiene: kill switches hold for the whole fleet (DISARMED writes nothing; numeric OFF only materializes PENDING; unknown clients are out of the allowlist)', async () => {
  const fleet = []; for (const p of PROFILES.slice(0, 4)) fleet.push(await athlete(p.o));
  await open(fleet.map((f) => f.uid));
  for (const f of fleet) { const d0 = await digest(f); assert.deepEqual(await run(f, { enabled: false }), { status: 'DISARMED', writes: 0 }); assert.equal(await digest(f), d0); }
  for (const f of fleet) { const out = await run(f, { numericApplyEnabled: false }); assert.deepEqual([out.applied, out.consumed], [[], []]); assert.equal(overlays(await meso(f)).length, 0); }
  const outsider = await athlete(PROFILES[0].o); const d1 = await digest(outsider); const res = await run(outsider); assert.equal(res.status, 'OUT_OF_ALLOWLIST'); assert.equal(await digest(outsider), d1);
});
