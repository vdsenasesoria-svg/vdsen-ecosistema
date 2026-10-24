'use strict';
// T599R independent audit — shared helpers. LOCAL EMULATORS ONLY (Auth 9099, Firestore 8085, project demo-vdsen-client-e2e). Synthetic athletes only. Read-only wrt the product:
// nothing under vdsen-cliente.html / vdsen-coach.html / assets/ / api/ is modified; the product is imported or served as is.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..', '..');
const PROJECT = 'demo-vdsen-client-e2e', AUTH = 'http://127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'; process.env.GCLOUD_PROJECT = PROJECT; process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const admin = require(path.join(root, 'node_modules', 'firebase-admin'));
const app = admin.apps.find((a) => a && a.name === 't599r') || admin.initializeApp({ projectId: PROJECT }, 't599r');
const db = admin.firestore(app);
const { importLikeCoach } = require(path.join(root, 'tests', 'helpers', 'coach-plan-import.js'));
const CREDS = path.join(os.tmpdir(), 'vdsen-client-e2e-creds.json');   // the shared E2E server (serve.cjs) reads athlete credentials from here
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signUp(label) {
  const email = label + '-' + crypto.randomBytes(3).toString('hex') + '@example.test', password = crypto.randomBytes(12).toString('base64url') + 'aA1!';
  const r = await fetch(AUTH + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  if (!r.ok) throw new Error('signUp ' + r.status);
  return { email, password, uid: (await r.json()).localId };
}
const S = (n, reps, rir, rest) => Array.from({ length: n }, (_, i) => ({ setIndex: i, repsTarget: reps, rirTarget: rir, load: 0, restSeconds: rest }));   // the Coach prescribes NO kg/lb: load 0
// exercises: [{ name, muscleGroup, repsRange, sets:[...] , w1: {load, reps:[..], rirReal, ics, rir}}]
function buildPlan(exercises, prefix, extra) {
  const motor = { weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'Dia 1 - T599R', exercises: exercises.map((e) => ({ exerciseName: e.name, technique: 'straight', muscleGroup: e.muscleGroup, repsRange: e.repsRange, sets: e.sets })) }] };
  return Object.assign({ schema: 'vdsen-plan-v2', status: 'active', generatedBy: 'import', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' }, importLikeCoach(motor, { idPrefix: prefix }), extra || {});
}
// Week-1 history is the ONLY synthetic evidence; week 2 is executed through the REAL Client UI (which also writes post-session + progrec with its own v3.1 algorithm).
async function seedAthlete(label, exercises, o) {
  o = o || {};
  const coach = o.coach || await signUp('t599r-coach'), a = await signUp('t599r-' + label.toLowerCase()), planId = 'plan-t599r-' + label.toLowerCase() + '-' + crypto.randomBytes(2).toString('hex');
  const plan = buildPlan(exercises, 't599r-' + label.toLowerCase(), Object.assign({ coachId: coach.uid, clientId: a.uid }, o.planExtra || {}));
  const pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId), entries = {}, w1pids = o.foreignW1Pid ? pids.map((_, i) => 'pid-foreign-' + i) : pids;   // foreignW1Pid: week-1 evidence carries a PID that is NOT in the plan (same exercise NAME snapshot): identity must not follow the name
  if (!o.noWeek1) {
    plan.days[0].exercises.forEach((ex, e) => { const w = exercises[e].w1; if (!w) return;
      ex.sets.forEach((s, si) => { entries['log_1_0_' + e + '_s' + si] = { done: true, carga: String(w.load), reps: String(Array.isArray(w.reps) ? w.reps[si] : w.reps), unit: 'KG', rir: w.rir, rir_real: w.rirReal, ics: w.ics, pump: 1, exerciseNameSnapshot: exercises[e].name, prescriptionExerciseId: w1pids[e], ts: T0 + e * 100 + si }; }); });
    entries.done_1_0 = true;
    if (o.week1Post) entries.postsession_1_0 = o.week1Post;
  }
  await db.doc('clients/' + a.uid).set({ displayName: 'T599R ' + label, email: a.email, coachId: coach.uid, activePlanId: planId, role: 'client', coachInterventions: [] });
  await db.doc('coaches/' + coach.uid).set({ displayName: 'T599R Coach', email: coach.email, role: 'coach', autoApplyCanary: { enabled: true, clientIds: [a.uid], prescriptionExerciseIds: [] } }, { merge: true });
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + a.uid).set({ planId, currentWeek: o.noWeek1 ? 1 : 2, entries });
  await db.doc('logs/' + a.uid + '/mesos/' + planId).set({ planId, entries });
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [a.uid] });   // sandbox allowlist of the athlete under test only
  let all = { who: {} }; try { all = JSON.parse(fs.readFileSync(CREDS, 'utf8')); } catch (e) { /* new file */ }
  all.who[label] = { email: a.email, password: a.password, uid: a.uid, planId, pids }; fs.writeFileSync(CREDS, JSON.stringify(all));
  return { label, uid: a.uid, planId, coachUid: coach.uid, pids, plan, coach };
}
const meso = async (a) => (await db.doc('logs/' + a.uid + '/mesos/' + a.planId).get()).data() || {};
const root_ = async (a) => (await db.doc('logs/' + a.uid).get()).data() || {};
const recordsOf = (m) => Object.values((m && m.progressionApplications) || {});
const overlaysOf = (m) => Object.values((m && m.nextExposureOverlays) || {});
const recFor = (m, pid) => recordsOf(m).filter((r) => r.prescriptionExerciseId === pid);
const ovFor = (m, pid) => overlaysOf(m).filter((o) => o.prescriptionExerciseId === pid);
const slim = (r) => r && ({ state: r.state, reasonCode: r.reasonCode, action: r.action, dimension: r.dimension, nextExposure: r.nextExposure, magnitude: r.magnitude && { eligible: r.magnitude.eligible, ruleId: r.magnitude.ruleId, dimension: r.magnitude.dimension, direction: r.magnitude.direction,
  directionConsistency: r.magnitude.directionConsistency, comparableExposureCount: r.magnitude.comparableExposureCount, reasonCodes: r.magnitude.reasonCodes, coachReviewRequired: r.magnitude.coachReviewRequired && r.magnitude.coachReviewRequired.branch,
  candidates: (r.magnitude.candidates || []).map((c) => ({ dimension: c.dimension, ruleId: c.ruleId, previousValue: c.previousValue, rawCandidate: c.rawCandidate, finalCandidate: c.finalCandidate, components: c.components, blockers: c.blockers })), structural: r.magnitude.structural && r.magnitude.structural.kind } });
const slimOv = (o) => o && ({ dimension: o.dimension, previousValue: o.previousValue, appliedValue: o.appliedValue, unit: o.unit, target: o.target, status: o.status, components: o.components || null, loadUnit: o.loadUnit });
module.exports = { root, db, admin, PROJECT, CREDS, T0, sleep, signUp, S, buildPlan, seedAthlete, meso, root_, recordsOf, overlaysOf, recFor, ovFor, slim, slimOv };
