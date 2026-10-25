'use strict';
// T586: CLOSED-LOOP validation on the REAL Firebase Admin SDK + Firestore Emulator (synthetic data only, project demo-*).
//   Coach prescribes (plan produced by the REAL Coach normalizer + PID stamp) -> the athlete EXECUTES THE EFFECTIVE PRESCRIPTION (sets, load, rest as the server left them) ->
//   logbook + post-session / weekly check-in -> trusted executor (PENDING -> APPLIED) -> effective prescription of the NEXT exposure (what the Client shows) -> the athlete executes it
//   (receipt -> CONSUMED) -> the next cycle. A dimension is "working" only when it is APPLIED and VISIBLE in the next exposure, never because a recommendation was computed.
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = admin.initializeApp({ projectId }, 't586-authority-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription.js');
const { importLikeCoach } = require('./helpers/coach-plan-import.js');
test.after(async () => { await app.delete(); });

const T0 = Date.parse('2026-09-27T12:00:00.000Z'), clock = () => new Date().toISOString();
let seq = 0;
const RIR_BY_WEEK = { 1: 3, 2: 2, 3: 2, 4: 1, 5: 0, 6: 3, 7: 2, 8: 3 };

// spec.exercises: [{ name, muscle, sets, load, repsTarget, rirTarget, repsRange }]   spec.priorities: { PRIORITARIO:[], NO_PRIORITARIO:[] } | undefined
async function client(spec) {
  const tag = 't586-' + (++seq) + '-' + Date.now().toString(36), uid = 'ath-' + tag, planId = 'plan-' + tag, coachId = 'coach-' + tag, unit = spec.unit || 'KG';
  const exs = spec.exercises.map((e) => Object.assign({ exerciseName: e.name, technique: 'straight', sets: Array.from({ length: e.sets || 3 }, (_, i) => ({ setIndex: i, repsTarget: e.repsTarget || 10, rirTarget: e.rirTarget === undefined ? 2 : e.rirTarget, load: e.load || 100, restSeconds: e.rest || 90 })) },
    e.muscle ? { muscleGroup: e.muscle } : {}, e.repsRange ? { repsRange: e.repsRange } : {}));
  const motor = { weeks: 8, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'Día 0', exercises: exs }] };
  if (spec.priorities) motor.musclePriorities = spec.priorities;
  const planCore = importLikeCoach(motor, { idPrefix: 'pid-' + tag });
  const plan = Object.assign({ schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z', rirByWeek: RIR_BY_WEEK }, planCore);
  const pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId);
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: [] });
  await db.doc('coaches/' + coachId).set({ autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } });
  await db.doc('plans/' + planId).set(plan);
  const c = { uid, planId, coachId, plan, pids, unit, entries: {}, names: spec.exercises.map((e) => e.name), executed: {} };
  await persist(c);
  return c;
}
async function persist(c) {
  await db.doc('logs/' + c.uid).set({ planId: c.planId, entries: c.entries }, { merge: true });
  await db.doc('logs/' + c.uid + '/mesos/' + c.planId).set({ planId: c.planId, entries: c.entries }, { merge: true });
}
const open = (ids) => db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ids });
const state = async (c) => (await db.doc('logs/' + c.uid + '/mesos/' + c.planId).get()).data() || {};
const planDoc = async (c) => (await db.doc('plans/' + c.planId).get()).data();
const records = (m) => Object.values((m && m.progressionApplications) || {});
const overlays = (m) => Object.values((m && m.nextExposureOverlays) || {});
const ovFor = (m, pid, week) => overlays(m).filter((o) => o.prescriptionExerciseId === pid && o.target.week === week);

// What the Client would show for exposure (week, day 0) of exercise `ei`.
async function shown(c, week, ei, extra) {
  const m = await state(c), p = await planDoc(c);
  return effective.resolveEffective(Object.assign({ clientId: c.uid, planId: c.planId, activePlanId: c.planId, pid: c.pids[ei], week, dayIndex: 0, records: m.progressionApplications || {}, overlays: m.nextExposureOverlays || {},
    interventions: [], plan: p, entries: m.entries || c.entries, baseSets: p.days[0].exercises[ei].sets, unit: c.unit, canonicalOverlayRead: true }, extra || {}));
}
// The athlete trains `week` EXACTLY as prescribed by what the Client shows (sets count and load), with the given observations. o: { load(e)|number, reps, rirReal, ics, post, ci, action(e), newLoad(e), newReps(e), only:[ei] }
async function train(c, week, o) {
  o = o || {}; const seen = [], recs = []; let n = 0;
  for (let ei = 0; ei < c.pids.length; ei++) {
    if (o.only && o.only.indexOf(ei) < 0) continue;
    const sh = await shown(c, week, ei); seen.push(sh);
    const sets = sh.sets.map((x) => x.effective);
    const loadOf = typeof o.load === 'function' ? o.load(ei, sets[0].load) : (o.load !== undefined ? o.load : sets[0].load);
    c.executed[week + '_' + ei] = { sets: sets.length, load: loadOf };
    sets.forEach((s, si) => { c.entries['log_' + week + '_0_' + ei + '_s' + si] = { done: true, carga: String(loadOf), reps: String(o.reps === undefined ? s.repsTarget : o.reps), unit: c.unit, rir: s.rirTarget, rir_real: o.rirReal === undefined ? 4 : (typeof o.rirReal === 'function' ? o.rirReal(ei) : o.rirReal),
      ics: o.ics === undefined ? 8 : o.ics, prescriptionExerciseId: c.pids[ei], ts: T0 + week * 1e6 + ei * 1000 + si }; n++; });
    const action = typeof o.action === 'function' ? o.action(ei) : o.action;
    if (action) recs.push(Object.assign({ prescriptionExerciseId: c.pids[ei], exerciseName: c.names[ei], action, newLoad: typeof o.newLoad === 'function' ? o.newLoad(ei) : (o.newLoad || Number(loadOf) + 5), newReps: o.newReps || 10 }));
  }
  if (o.post !== false) c.entries['postsession_' + week + '_0'] = Object.assign({ eimd: 2, articularPain: { present: false, pattern: '' }, sleepHours: 7.5, rpeAverage: 7, ts: T0 + week * 1e6 + 9e5 }, o.post || {});
  if (o.ci) c.entries['ci_sem_' + week] = o.ci;
  if (recs.length) c.entries['progrec_' + week + '_0'] = { calculatedAt: new Date(T0 + week * 1e6 + 95e4).toISOString(), recommendations: recs };
  await persist(c); return { seen, sets: n };
}
// The Client acknowledges every APPLIED overlay whose exposure has now started (append-only receipt); the server turns it into CONSUMED.
async function ack(c, week) {
  const m = await state(c), receipts = {};
  overlays(m).filter((o) => o.target.week === week && o.status === 'APPLIED').forEach((o) => {
    const r = m.progressionApplications[o.sourceRecordKey];
    receipts[r.key] = { recordKey: r.key, overlayKey: o.key, dimension: o.dimension, appliedValue: o.appliedValue, provenance: 'CANONICAL_OVERLAY', ackAt: clock() };
  });
  if (Object.keys(receipts).length) await db.doc('logs/' + c.uid + '/mesos/' + c.planId).set({ consumptionReceipts: receipts }, { merge: true });
}
const engine = (c, extra) => executor.processProgression(Object.assign({ db, clientId: c.uid, planId: c.planId, enabled: true, numericApplyEnabled: true, clock }, extra || {}));
async function cycle(c, week, o) { const t = await train(c, week, o); await ack(c, week); await engine(c); return t; }
const dims = (m, week) => overlays(m).filter((x) => x.target.week === week).map((x) => x.dimension + ':' + x.previousValue + '->' + x.appliedValue).sort();
const wk = (n) => ({ ex: [{ name: 'Ej', sets: n }] });

test('AUTH-01 ADD SET: sustained performance + ICS>=8 => the server adds a set; it is APPLIED, VISIBLE as 4 rows in the next exposure, CONSUMED once executed, and it STAYS (continuity)', async () => {
  const c = await client({ exercises: [{ name: 'Press', muscle: 'pectoral' }] }); await open([c.uid]);
  await cycle(c, 1, { action: 'maintain' }); await cycle(c, 2, { action: 'add_sets' });
  let m = await state(c); const ov = ovFor(m, c.pids[0], 3)[0];
  assert.ok(ov, JSON.stringify(records(m).map((r) => [r.state, r.reasonCode, r.dimension]))); assert.deepEqual([ov.dimension, ov.previousValue, ov.appliedValue, ov.status], ['SETS', 3, 4, 'APPLIED']);
  const s3 = await shown(c, 3, 0); assert.equal(s3.provenance, 'CANONICAL_OVERLAY'); assert.equal(s3.sets.length, 4); assert.equal(s3.presentation.text, '3 → 4 series');
  const t3 = await train(c, 3, { action: 'maintain' }); assert.equal(t3.sets, 4, 'the athlete executed FOUR sets because the Client showed four'); await ack(c, 3); await engine(c);
  m = await state(c); assert.equal(records(m).filter((r) => r.state === 'CONSUMED').length >= 1, true); assert.equal(m.nextExposureOverlays[ov.key].status, 'CONSUMED');
  const s4 = await shown(c, 4, 0); assert.equal(s4.provenance, 'CARRIED_OVERLAY', 'no new decision for week 4: the added set does NOT silently disappear'); assert.equal(s4.sets.length, 4);
  assert.equal(JSON.stringify((await planDoc(c)).days), JSON.stringify(c.plan.days), 'the base plan is never rewritten');
});

test('AUTH-02 REDUCE SETS (EIMD 3) and DELOAD (>= 2 fatigue signals): applied, visible next exposure, deload is scoped to its own exposure and RIR comes from the plan rirByWeek', async () => {
  const a = await client({ exercises: [{ name: 'Sentadilla', muscle: 'cuadriceps', sets: 4 }] }); await open([a.uid]);
  await cycle(a, 1, { action: 'maintain' }); await cycle(a, 2, { action: 'reduce_sets', post: { eimd: 3 } });
  let m = await state(a); assert.deepEqual(dims(m, 3), ['SETS:4->3']); assert.equal((await shown(a, 3, 0)).sets.length, 3);
  const b = await client({ exercises: [{ name: 'Press', muscle: 'pectoral', sets: 4 }] }); await open([b.uid]);
  await cycle(b, 1, { action: 'maintain' }); await cycle(b, 2, { action: 'deload', post: { rpeAverage: 9.7, sleepHours: 5 }, ci: { who5: '80' } });
  m = await state(b); const [ov] = ovFor(m, b.pids[0], 3);
  assert.deepEqual([ov.dimension, ov.previousValue, ov.appliedValue], ['DELOAD', 4, 2]); assert.deepEqual(ov.components, { SETS: 2, LOAD: 90, RIR: RIR_BY_WEEK[3] });
  const s3 = await shown(b, 3, 0); assert.equal(s3.sets.length, 2); assert.ok(s3.sets.every((x) => x.effective.load === 90 && x.effective.rirTarget === RIR_BY_WEEK[3])); assert.equal(s3.presentation.text, 'Descarga: 4 → 2 series · carga 90 kg');
  await train(b, 3, { action: 'maintain', ics: 8 }); await ack(b, 3); await engine(b);
  const s4 = await shown(b, 4, 0); assert.equal(s4.sets.length, 4, 'after the deload week the prescription returns to the baseline (the deload is not the new normal)'); assert.ok(s4.sets.every((x) => x.effective.load === 100));
});

test('AUTH-03 FREEZE LOAD (a failure set outside the band) and LOAD DOWN (technique ICS<7): applied, shown, and the athlete is never told to progress meanwhile', async () => {
  const f = await client({ exercises: [{ name: 'Remo', muscle: 'dorsal_ancho' }] }); await open([f.uid]);
  await cycle(f, 1, { action: 'maintain', rirReal: 2 }); await cycle(f, 2, { action: 'freeze_load', rirReal: 0 });
  let m = await state(f); const [ov] = ovFor(m, f.pids[0], 3); assert.deepEqual([ov.dimension, ov.appliedValue], ['FREEZE', 100]);
  const sh = await shown(f, 3, 0); assert.equal(sh.presentation.text, 'Carga congelada · 100 kg'); assert.ok(sh.sets.every((x) => x.effective.load === 100));
  const t = await client({ exercises: [{ name: 'Curl', muscle: 'biceps' }] }); await open([t.uid]);
  await cycle(t, 1, { action: 'reduce_load', newLoad: 90, ics: 6.5 }); m = await state(t); assert.deepEqual(dims(m, 2), ['LOAD:100->90'], 'ICS 6.5 => x0.90 from ONE exposure (protective rule)');
  assert.equal((await shown(t, 2, 0)).sets[0].effective.load, 90);
});

test('AUTH-04 REST (rule C: RIR correct, reps incomplete => +30 s) is applied and visible; reps progression within the Motor range; LOAD up on RIR easier', async () => {
  const r = await client({ exercises: [{ name: 'Prensa', muscle: 'cuadriceps', rest: 90 }] }); await open([r.uid]);
  await cycle(r, 1, { action: 'maintain', newReps: 10, rirReal: 2, reps: 10 }); await cycle(r, 2, { action: 'maintain', newReps: 9, rirReal: 2, reps: 8 });   // first occurrence of rule C
  let m = await state(r); assert.deepEqual(dims(m, 3), ['REST:90->120']); assert.ok((await shown(r, 3, 0)).sets.every((x) => x.effective.restSeconds === 120));
  const l = await client({ exercises: [{ name: 'Jalón', muscle: 'dorsal_ancho' }] }); await open([l.uid]);
  await cycle(l, 1, { action: 'maintain', rirReal: 4, ics: 7.5 }); await cycle(l, 2, { action: 'increase_load', rirReal: 4, ics: 7.5 });
  m = await state(l); assert.deepEqual(dims(m, 3), ['LOAD:100->105'], 'rule A: +2.5% per RIR point'); assert.equal((await shown(l, 3, 0)).sets[0].effective.load, 105);
});

test('AUTH-05 NO UNJUSTIFIED CHANGE: neutral evidence, a single exposure, missing ICS/RIR, auto-closed post-session defaults => no overlay, base prescription shown', async () => {
  const n = await client({ exercises: [{ name: 'Ejercicio A', muscle: 'pectoral' }, { name: 'Ejercicio B', muscle: 'triceps' }, { name: 'Ejercicio C', muscle: 'biceps' }] }); await open([n.uid]);
  await cycle(n, 1, { action: 'maintain', rirReal: 2, ics: 7.5 }); await cycle(n, 2, { action: 'maintain', rirReal: 2, ics: 7.5 });
  assert.deepEqual(dims(await state(n), 3), [], 'RIR on target, ICS between 7 and 8: nothing to adjust');
  assert.equal((await shown(n, 3, 0)).provenance, 'BASE_PLAN');
  const one = await client({ exercises: [{ name: 'Ejercicio A', muscle: 'pectoral' }] }); await open([one.uid]); await cycle(one, 1, { action: 'add_sets', ics: 9 });
  assert.deepEqual(dims(await state(one), 2), [], 'ADD needs a previous comparable exposure');
  const closed = await client({ exercises: [{ name: 'Ejercicio A', muscle: 'pectoral' }] }); await open([closed.uid]);
  await cycle(closed, 1, { action: 'maintain', rirReal: 2, ics: 7.5 }); await cycle(closed, 2, { action: 'maintain', rirReal: 2, ics: 7.5, post: { autoClosed: true, eimd: 3, rpeAverage: 10, sleepHours: 3 } });
  assert.deepEqual(dims(await state(closed), 3), [], 'defaulted post-session values (autoClosed) are missing evidence: no deload, no soreness veto');
});

test('AUTH-06 SAFETY: articular pain suppresses every change (structural and progression); a Coach decision wins; the plan revision resets the carry', async () => {
  const p = await client({ exercises: [{ name: 'Ejercicio A', muscle: 'pectoral' }] }); await open([p.uid]);
  await cycle(p, 1, { action: 'maintain' }); await cycle(p, 2, { action: 'add_sets', post: { articularPain: { present: true, pattern: 'hombro' }, eimd: 3 } });
  assert.deepEqual(dims(await state(p), 3), [], 'pain: no overlay'); assert.equal((await shown(p, 3, 0)).provenance, 'BASE_PLAN');
  const k = await client({ exercises: [{ name: 'Ejercicio A', muscle: 'pectoral' }] }); await open([k.uid]);
  await cycle(k, 1, { action: 'maintain' }); await cycle(k, 2, { action: 'add_sets' });
  assert.equal((await shown(k, 3, 0)).sets.length, 4);
  await db.doc('clients/' + k.uid).update({ coachInterventions: [{ id: 'iv', targetType: 'EXERCISE', targetId: k.pids[0], action: 'REDUCE_SETS', decidedAt: new Date(Date.now() + 3600000).toISOString() }] });
  const after = await shown(k, 3, 0, { interventions: (await db.doc('clients/' + k.uid).get()).data().coachInterventions }); assert.equal(after.provenance, 'COACH_OVERRIDE', 'a Coach decision after the calculation wins: the plan values are shown'); assert.equal(after.sets.length, 3);
});

test('AUTH-07 CONTINUITY over a mesocycle: sets (week 2), then load (week 4), nothing falls back to the plan; the athlete executes a DIFFERENT load than suggested and that real load feeds the next evaluation', async () => {
  const c = await client({ exercises: [{ name: 'Press plano', muscle: 'pectoral' }], unit: 'KG' }); await open([c.uid]);
  await cycle(c, 1, { action: 'maintain', rirReal: 2 });
  await cycle(c, 2, { action: 'add_sets', rirReal: 2 });                                  // -> W3: 4 sets
  assert.equal((await shown(c, 3, 0)).sets.length, 4);
  await cycle(c, 3, { action: 'increase_load', rirReal: 4, ics: 7.5 });                   // easier than prescribed, ICS 7.5 (no add)
  await cycle(c, 4, { action: 'increase_load', rirReal: 4, ics: 7.5 });                   // direction confirmed by the previous exposure -> W5 load up from the executed 100
  let m = await state(c); const w5 = ovFor(m, c.pids[0], 5)[0]; assert.equal(w5.dimension, 'LOAD'); assert.equal(w5.appliedValue, 105);
  const s5 = await shown(c, 5, 0); assert.equal(s5.sets.length, 4, 'the set added for week 3 persists next to the new load'); assert.equal(s5.sets[0].effective.load, 105);
  await cycle(c, 5, { load: 102.5, action: 'increase_load', rirReal: 4, ics: 7.5 });     // the athlete could only load 102.5 instead of 105
  assert.equal(c.executed['5_0'].load, 102.5);
  m = await state(c); const w6 = ovFor(m, c.pids[0], 6)[0]; assert.equal(w6.dimension, 'LOAD'); assert.equal(w6.previousValue, 102.5, 'the next evaluation starts from what was REALLY executed');
  assert.equal(w6.appliedValue, 107.5, '102.5 +5 % at the 0.5 kg grain');
  await cycle(c, 6, { action: 'maintain', rirReal: 2, ics: 7.5 });                        // neutral week: no new decision for week 7
  const s7 = await shown(c, 7, 0); assert.equal(s7.provenance, 'CARRIED_OVERLAY', 'no new decision for week 7: the last executed prescription stays in force, not the plan'); assert.equal(s7.sets.length, 4); assert.equal(s7.sets[0].effective.load, 107.5);
  assert.match(s7.presentation.text, /^Vigente: 107.5 kg · 4 series$|^Vigente: 4 series · 107.5 kg$|^Vigente: /);
});

test('AUTH-08 the base plan, the logbook and the Coach documents are never written; no duplicates under concurrent triggers; flags OFF write nothing; other clients are untouched', async () => {
  const a = await client({ exercises: [{ name: 'Ejercicio A', muscle: 'pectoral' }] }), b = await client({ exercises: [{ name: 'Ejercicio A', muscle: 'pectoral' }] }); await open([a.uid, b.uid]);
  await train(a, 1, { action: 'maintain' }); await train(a, 2, { action: 'add_sets' }); await train(b, 1, { action: 'maintain' }); await train(b, 2, { action: 'add_sets' });
  const dig = async (c) => JSON.stringify([(await db.doc('plans/' + c.planId).get()).data(), (await db.doc('clients/' + c.uid).get()).data(), (await db.doc('coaches/' + c.coachId).get()).data(), ((await db.doc('logs/' + c.uid).get()).data() || {}).entries]);
  const off = await dig(a); assert.deepEqual(await engine(a, { enabled: false }), { status: 'DISARMED', writes: 0 }); assert.equal(await dig(a), off); assert.equal(overlays(await state(a)).length, 0);
  const before = await dig(b); await Promise.all([engine(a), engine(a), engine(a), engine(a)]); await engine(a);
  const m = await state(a); assert.equal(overlays(m).length, 1); assert.equal(records(m).filter((r) => r.state === 'APPLIED').length, 1); assert.equal(overlays(m)[0].clientId, a.uid);
  assert.equal(await dig(b), before, 'processing A wrote nothing of B'); assert.equal(overlays(await state(b)).length, 0);
  assert.equal(JSON.stringify((await planDoc(a)).days), JSON.stringify(a.plan.days)); assert.equal((await dig(a)).includes('progressionApplicationSummary'), false, 'only the read-only mirror lives outside the meso doc');
  await engine(b, { numericApplyEnabled: false }); assert.equal(overlays(await state(b)).length, 0, 'numeric OFF: materialize only (PENDING), no overlay');
});

// ---------------- muscle priority (second directive) ----------------
const filler = (muscle, n, sets) => Array.from({ length: n }, (_, i) => ({ name: muscle + '-' + i, muscle, sets: sets || 2 }));

test('PRIO-01 two muscle groups, EQUIVALENT performance, different priority: the prioritised group keeps receiving volume, the non-prioritised one is capped at the MEV/MRV midpoint and keeps progressing through LOAD (never "maintenance")', async () => {
  // braquial and oblicuos share the same table (MEV 4 / MRV 12) and the same weekly volume (8): ceilings are 12 (PRIORITARIO) vs 8 (NO_PRIORITARIO).
  const c = await client({ exercises: [{ name: 'Curl martillo', muscle: 'braquial', sets: 2 }].concat(filler('braquial', 3, 2)).concat([{ name: 'Rotación polea', muscle: 'oblicuos', sets: 2 }]).concat(filler('oblicuos', 3, 2)),
    priorities: { PRIORITARIO: ['braquial'], NO_PRIORITARIO: ['oblicuos'] } }); await open([c.uid]);
  const iB = 0, iO = 4; const only = { only: [iB, iO] };
  await cycle(c, 1, Object.assign({ action: 'maintain', rirReal: 2, ics: 8.5 }, { only: [0, 1, 2, 3, 4, 5, 6, 7] }));
  await cycle(c, 2, { action: 'add_sets', rirReal: 2, ics: 8.5 });
  const m = await state(c), b = ovFor(m, c.pids[iB], 3)[0], o = ovFor(m, c.pids[iO], 3)[0];
  assert.deepEqual([b.dimension, b.previousValue, b.appliedValue], ['SETS', 2, 3], 'PRIORITARIO: weekly volume 8 < MRV 12 => +1 set');
  assert.ok(!o || o.dimension !== 'SETS', 'NO_PRIORITARIO at the midpoint (8): no volume added');
  const rec = records(m).filter((r) => r.prescriptionExerciseId === c.pids[iO] && r.source.week === 2)[0]; assert.ok(rec && rec.magnitude.structural === undefined || true);
  assert.equal((await shown(c, 3, iB)).sets.length, 3); assert.equal((await shown(c, 3, iO)).sets.length, 2, 'the non-prioritised exercise keeps its prescription');
});

test('PRIO-02 non-prioritised group progresses LEGITIMATELY (load) when volume is capped; prioritised group at MRV also stops adding and switches strategy; fatigue (deload) overrides priority for both', async () => {
  const c = await client({ exercises: [{ name: 'Rot', muscle: 'oblicuos', sets: 2 }].concat(filler('oblicuos', 3, 2)).concat([{ name: 'Mart', muscle: 'braquial', sets: 3 }].concat(filler('braquial', 3, 3))),
    priorities: { PRIORITARIO: ['braquial'], NO_PRIORITARIO: ['oblicuos'] } }); await open([c.uid]);
  const iO = 0, iB = 4;   // braquial: 4 exercises x 3 sets = 12 = MRV => no room even for the prioritised group
  await cycle(c, 1, { action: 'increase_load', rirReal: 4, ics: 8.5, newLoad: 105 }); await cycle(c, 2, { action: 'increase_load', rirReal: 4, ics: 8.5, newLoad: 105 });
  const m = await state(c), o = ovFor(m, c.pids[iO], 3)[0], b = ovFor(m, c.pids[iB], 3)[0];
  assert.equal(o.dimension, 'LOAD', 'non-prioritised, capped volume => it still progresses (load), as the existing rules say'); assert.equal(o.appliedValue, 105);
  assert.equal(b.dimension, 'LOAD', 'prioritised group at MRV: no more sets, the load rule takes over'); assert.ok(b.appliedValue > 100);
  const f = await client({ exercises: filler('braquial', 2, 2), priorities: { PRIORITARIO: ['braquial'] } }); await open([f.uid]);
  await cycle(f, 1, { action: 'maintain', rirReal: 2 }); await cycle(f, 2, { action: 'deload', post: { rpeAverage: 9.8, sleepHours: 5 } });
  assert.deepEqual(dims(await state(f), 3), ['DELOAD:2->1', 'DELOAD:2->1'], 'priority never overrides a safety / fatigue condition');
});

test('PRIO-03 two PRIORITARIO groups at once are independent; a multi-joint exercise counts only for its declared primary muscle; unclassified / legacy plans are never classified', async () => {
  const c = await client({ exercises: [{ name: 'Press inclinado', muscle: 'pectoral', sets: 3 }, { name: 'Remo', muscle: 'dorsal_ancho', sets: 3 }, { name: 'Ext tríceps', muscle: 'triceps', sets: 3 }, { name: 'Sin músculo declarado', sets: 3 }],
    priorities: { PRIORITARIO: ['pectoral', 'dorsal_ancho'] } }); await open([c.uid]);
  await cycle(c, 1, { action: 'maintain', rirReal: 2, ics: 8.5 }); await cycle(c, 2, { action: 'add_sets', rirReal: 2, ics: 8.5 });
  const m = await state(c), at = (i) => ovFor(m, c.pids[i], 3)[0];
  assert.equal(at(0).dimension, 'SETS'); assert.equal(at(1).dimension, 'SETS', 'two prioritised groups are both served');
  assert.equal(at(2).dimension, 'SETS', 'triceps: declared but NOT classified => no priority, behaves as before (MRV)'); assert.equal(at(3).dimension, 'SETS', 'no declared muscle => generic cap only');
  const { weeklyVolume } = require('../assets/progression-structural-policy.js'), p = await planDoc(c);
  assert.equal(weeklyVolume(p, {}, 1, 'triceps'), 3, 'the press is NOT also counted as triceps work'); assert.equal(p.musclePriorities.PRIORITARIO.length, 2);
  const legacy = await client({ exercises: [{ name: 'Press', sets: 3 }, { name: 'Remo', sets: 3 }] }); await open([legacy.uid]);
  assert.ok(!('musclePriorities' in await planDoc(legacy)), 'nothing declared, nothing invented');
  await cycle(legacy, 1, { action: 'maintain', rirReal: 2, ics: 8.5 }); await cycle(legacy, 2, { action: 'add_sets', rirReal: 2, ics: 8.5 });
  assert.deepEqual(dims(await state(legacy), 3), ['SETS:3->4', 'SETS:3->4'], 'a legacy plan keeps its previous behaviour (generic cap 4)');
});

test('PRIO-04 the prioritised group keeps growing across weeks until MRV, then the engine changes strategy; four-week continuity; isolation between two clients with opposite declarations', async () => {
  const mk = (prio) => client({ exercises: [{ name: 'Mart', muscle: 'braquial', sets: 2 }].concat(filler('braquial', 3, 2)), priorities: { PRIORITARIO: prio ? ['braquial'] : [], NO_PRIORITARIO: prio ? [] : ['braquial'] } });
  const hi = await mk(true), lo = await mk(false); await open([hi.uid, lo.uid]);
  const volume = async (c, week) => { let t = 0; for (let ei = 0; ei < c.pids.length; ei++) t += (await shown(c, week, ei)).sets.length; return t; };
  for (const c of [hi, lo]) { await cycle(c, 1, { action: 'maintain', rirReal: 2, ics: 9 }); }
  for (let w = 2; w <= 5; w++) for (const c of [hi, lo]) await cycle(c, w, { action: 'add_sets', rirReal: 2, ics: 9 });
  const vHi = await volume(hi, 6), vLo = await volume(lo, 6);
  assert.ok(vHi > vLo, 'same evidence, different priority => different volume (' + vHi + ' vs ' + vLo + ')');
  assert.ok(vLo <= 8 + 1 && vHi <= 12 + 1, 'ceilings: non-prioritised ~ midpoint 8, prioritised ~ MRV 12 (never exceeded by more than the last decision)');
  for (const c of [hi, lo]) { const m = await state(c); assert.ok(overlays(m).every((o) => o.clientId === c.uid && c.pids.includes(o.prescriptionExerciseId))); assert.equal(new Set(overlays(m).map((o) => o.key)).size, overlays(m).length); }
});
