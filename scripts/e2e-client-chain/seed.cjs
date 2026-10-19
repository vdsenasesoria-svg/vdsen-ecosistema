// LOCAL emulators only (127.0.0.1). SYNTHETIC data: a test Coach + several test athletes (Auth Emulator). Each athlete has a plan and ONE prior exposure (week 1) in the logbook.
// Plans for A..D,F are Motor-style output imported through the REAL Coach normalizer (ex1 carries the Motor's repsRange 8-12); athlete E has a LEGACY plan (PID + name + sets only).
// The Coach canary and the release allowlist list ONLY these synthetic athletes. Credentials go to a scratch file (never printed). argv[2] = worktree.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const { importLikeCoach } = require(path.join(root, 'tests', 'helpers', 'coach-plan-import.js'));
const AUTH = 'http://127.0.0.1:9099', FS = 'http://127.0.0.1:8085', PROJECT = 'demo-vdsen-client-e2e', OUT = path.join(require('os').tmpdir(), 'vdsen-client-e2e-creds.json');
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const put = async (docPath, data) => { const r = await fetch(FS + '/v1/projects/' + PROJECT + '/databases/(default)/documents/' + docPath, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) }) }); if (!r.ok) throw new Error('seed ' + docPath + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200)); };
const signUp = async (label) => { const email = label + '-' + crypto.randomBytes(3).toString('hex') + '@example.test', password = crypto.randomBytes(12).toString('base64url') + 'aA1!'; const r = await fetch(AUTH + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }); if (!r.ok) throw new Error('signUp ' + r.status); return { email, password, uid: (await r.json()).localId }; };
const NAMES = (process.argv[3] || 'A,B,C,D,E,F').split(',').map((x) => x.trim()).filter(Boolean);   // athlete labels; label E gets the LEGACY plan

(async () => {
  const coach = await signUp('coach-e2e'); const out = { coachUid: coach.uid, who: {} };
  const T0 = Date.parse('2026-09-27T12:00:00.000Z');
  const S = (reps, rir) => [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget: reps, rirTarget: rir, load: 0, restSeconds: 90 }));
  const motor = { weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'Día 1 - Empuje', exercises: [
    { exerciseName: 'Press de pecho E2E', technique: 'straight', sets: S(10, 2) },
    { exerciseName: 'Curl predicador E2E', technique: 'straight', repsRange: { min: 8, max: 12 }, sets: S(10, 1) }] }] };
  const ids = [];
  for (const name of NAMES) {
    const a = await signUp('atleta-' + name.toLowerCase() + '-e2e'); ids.push(a.uid);
    const planId = 'plan-e2e-' + name.toLowerCase() + '-' + crypto.randomBytes(2).toString('hex');
    let plan;
    if (name === 'E') {   // legacy plan: PID + name + sets only; no repsRange, no new fields
      plan = { schema: 'vdsen-plan-v2', coachId: coach.uid, clientId: a.uid, status: 'active', generatedBy: 'import', weeks: 4, daysPerWeek: 1, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
        days: [{ dayIndex: 0, label: 'Día 1 - Empuje', exercises: [{ prescriptionExerciseId: 'legacy-e-0', exerciseName: 'Press de pecho E2E', alternatives: [], technique: 'straight', sets: S(10, 2) }, { prescriptionExerciseId: 'legacy-e-1', exerciseName: 'Curl predicador E2E', alternatives: [], technique: 'straight', sets: S(10, 1) }] }] };
    } else {
      plan = Object.assign({ schema: 'vdsen-plan-v2', coachId: coach.uid, clientId: a.uid, status: 'active', generatedBy: 'import', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' }, importLikeCoach(motor, { idPrefix: 'pid-e2e-' + name.toLowerCase() }));
    }
    const pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId), entries = {};
    plan.days[0].exercises.forEach((ex, e) => [0, 1, 2].forEach((s) => { entries['log_1_0_' + e + '_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: e === 0 ? 2 : 1, rir_real: e === 0 ? 4 : 3, ics: 7, pump: 1, prescriptionExerciseId: pids[e], ts: T0 + e * 100 + s }; }));
    entries.done_1_0 = true;
    await put('clients/' + a.uid, { displayName: 'Atleta ' + name + ' E2E', email: a.email, coachId: coach.uid, activePlanId: planId, role: 'client', coachInterventions: [] });
    await put('plans/' + planId, plan);
    await put('logs/' + a.uid, { planId, currentWeek: 2, entries });
    await put('logs/' + a.uid + '/mesos/' + planId, { planId, entries });
    out.who[name] = { email: a.email, password: a.password, uid: a.uid, planId, pids };
  }
  await put('coaches/' + coach.uid, { displayName: 'Coach E2E', email: coach.email, role: 'coach', autoApplyCanary: { enabled: true, clientIds: ids, prescriptionExerciseIds: [] } });
  await put('releaseControl/autonomousProgression', { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ids });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('seeded coach + ' + NAMES.length + ' synthetic athletes (' + NAMES.join(',') + '); credentials in scratch file, not printed');
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
