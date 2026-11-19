'use strict';
// T842: Isolated End-to-End Functional Validation of the VDSEN Autonomous Progression Chain
// in STAGE1_SHADOW mode (NUMERIC_APPLY_ENABLED=false) on the real Firestore Emulator + real rules:
//   App Cliente (real calculateProgression + Firestore client SDK under real rules)
//     -> logs/{uid}, logs/{uid}/mesos/{planId}, logs/{uid}/starts/{startId}
//     -> POST /api/autonomous-progression-trigger (real makeHandler, numericApplyEnabled=false)
//     -> api/_autonomousProgression.js + assets/progression-*.js
//     -> STAGE1_SHADOW decision persisted in progressionApplications & progressionApplicationSummary
//     -> App Coach (authenticated Coach Firestore client SDK under real rules + real vdsen-coach.html consumer)
//   Plus negative, security, concurrency, idempotency, STOP, fences, expired window, and persistence error suites.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, serverTimestamp } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

const ROOT = path.join(__dirname, '..');
const CLIENT_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-cliente.html'), 'utf8');
const COACH_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');

const trigger = require(path.join(ROOT, 'api/autonomous-progression-trigger.js'));
const shadow = require(path.join(ROOT, 'assets/progression-auto-apply-shadow.js'));
const policy = require(path.join(ROOT, 'assets/progression-magnitude-policy.js'));
const consumer = require(path.join(ROOT, 'assets/progression-application-consumer.js'));
const effective = require(path.join(ROOT, 'assets/progression-effective-prescription.js'));
const variantIdentity = require(path.join(ROOT, 'assets/progression-variant-identity.js'));

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/, 'T842 must only ever run against a demo-* emulator project');

const adminApp = initAdmin({ projectId }, 't842-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];

async function asUser(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't842-' + apps.length);
  apps.push(app);
  const cdb = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(cdb, host, Number(port), { mockUserToken: { sub: uid } });
  return { uid, db: cdb };
}

test.after(async () => {
  await Promise.all(apps.map(deleteApp));
  await deleteAdmin(adminApp);
});

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, 'Missing function signature: ' + signature);
  let depth = 0, started = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('Unterminated function: ' + signature);
}

function runRealClientCalculateProgression(plan, logs, currentWeek, dayIndex, postData) {
  const deloadSrc = extractFunction(CLIENT_HTML, 'function _computeDeloadTriggers(');
  const calcSrc = extractFunction(CLIENT_HTML, 'function calculateProgression(');
  const sandbox = {
    PLAN: plan,
    LOGS: logs,
    LOGS_BY_WEEK: { log: {}, done: {}, postsession: {}, progrec: {} },
    CURRENT_WEEK: currentWeek,
    REAL_WEEK: currentWeek,
    MEV_MRV_BY_MUSCLE: {},
    MRV_BY_PATTERN: {},
    EXERCISE_CATALOG: {},
    window: { VDSEN_VARIANT_IDENTITY: variantIdentity },
    getSesiones: () => (plan.days || []).map((d) => ({
      dayIndex: d.dayIndex,
      label: d.label,
      exercises: (d.exercises || []).map((e) => ({
        nombre: e.exerciseName,
        exerciseName: e.exerciseName,
        prescriptionExerciseId: e.prescriptionExerciseId,
        exerciseId: e.exerciseId,
        alternatives: e.alternatives || [],
        numSeries: (e.sets || []).length,
        sets: e.sets || [],
        repsRange: e.repsRange && typeof e.repsRange === 'object'
          ? (e.repsRange.min + '-' + e.repsRange.max)
          : (e.repsRange || (e.sets && e.sets[0] ? String(e.sets[0].repsTarget) : '10')),
        rir: String((e.sets && e.sets[0] && e.sets[0].rirTarget !== undefined) ? e.sets[0].rirTarget : 2)
      }))
    })),
    getTotalWeeks: () => plan.weeks || 4,
    _getExType: (ej) => (ej && (ej.exerciseType === 'cardio' || ej.tipo === 'cardio') ? 'cardio' : 'strength'),
    _getCatalogData: () => null,
    getExUnit: () => 'KG',
    _avgArr: (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0),
    _getAlpha: () => ({ pct: 0.025, capKg: 2.5 }),
    _getMaxSets: (_cat, numSets) => Math.max(5, numSets + 1),
    _getPrevWeekData: (week, di, ei, maxSets) => {
      if (week <= 1) return null;
      const sets = [];
      for (let s = 0; s < maxSets; s++) {
        const k = 'log_' + (week - 1) + '_' + di + '_' + ei + '_s' + s;
        if (logs[k] && logs[k].done && !logs[k].autoFilled) sets.push(logs[k]);
      }
      if (!sets.length) return null;
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const rirs = sets.map((s) => parseFloat(s.rir_real)).filter((v) => !isNaN(v) && v >= 0 && v <= 5);
      return {
        avgLoad: avg(sets.map((s) => parseFloat(s.carga) || 0)),
        avgReps: avg(sets.map((s) => parseFloat(s.reps) || 0)),
        avgICS: 7.5,
        avgRIR: rirs.length ? avg(rirs) : null,
        numSets: sets.length,
        topLoad: Math.max(...sets.map((s) => parseFloat(s.carga) || 0))
      };
    },
    isY3TExercise: () => false,
    getEffectiveSets: (ej) => ej.sets || [],
    _roundUnit: (v, unit) => (unit === 'LB' ? Math.round(v / 2.5) * 2.5 : Math.round(v / 1.25) * 1.25),
    _applyAlpha: (load, alpha, unit) => {
      const inc = Math.min(load * alpha.pct, alpha.capKg);
      const step = unit === 'LB' ? Math.ceil(inc / 2.5) * 2.5 : Math.ceil(inc / 1.25) * 1.25;
      return +(load + Math.max(step, 1.25)).toFixed(2);
    },
    _getWeeklyVolumeByMuscle: () => 0,
    _getWeeklyVolumeByPattern: () => 0,
    _getEngineState: () => null,
    _updateEngineState: () => null,
    Date, Math, Number, String, Object, Array, JSON, parseFloat, parseInt, isNaN, isFinite
  };
  vm.runInNewContext(deloadSrc + '\n' + calcSrc + '\nthis.calculateProgression = calculateProgression;', sandbox);
  return sandbox.calculateProgression(dayIndex, postData);
}

function loadRealCoachShadowConsumer() {
  const reviewStart = COACH_HTML.indexOf('var _REVIEW_BRANCH =');
  const reviewEnd = COACH_HTML.indexOf('function _reviewRequiredLines(', reviewStart);
  const labelStart = COACH_HTML.indexOf('var _LIFECYCLE_LABEL =');
  const feedEnd = COACH_HTML.indexOf('// T534: transactional reversal of an APPLIED overlay', labelStart);
  const sandbox = {
    window: {
      VDSEN_EFFECTIVE_PRESCRIPTION: effective,
      VDSEN_AUTO_APPLY_SHADOW: shadow,
      VDSEN_APPLICATION_CONSUMER: consumer
    },
    _escH: (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    Array, Number, String, Object, JSON, Date, Math, RegExp
  };
  vm.runInNewContext(
    COACH_HTML.slice(reviewStart, reviewEnd) + '\n' +
    COACH_HTML.slice(labelStart, feedEnd) +
    '\nthis._renderShadowAutoFeed = _renderShadowAutoFeed;' +
    '\nthis._renderShadowMagnitude = _renderShadowMagnitude;' +
    '\nthis._shadowAuditLines = _shadowAuditLines;' +
    '\nthis._dryRunLine = _dryRunLine;' +
    '\nthis._lifecycleLines = _lifecycleLines;',
    sandbox
  );
  return sandbox;
}

let seq = 0;
function makeTag(label) {
  return 't842-' + label + '-' + (++seq) + '-' + Date.now().toString(36);
}

function makePlan({ clientId, coachId, pidInScope, pidOutOfScope, weeks = 4, status = 'active', active, updatedAt = '2026-09-26T00:00:00.000Z' }) {
  const exercises = [
    {
      prescriptionExerciseId: pidInScope,
      exerciseName: 'Press de pecho T842',
      technique: 'straight',
      alternatives: [],
      repsRange: { min: 8, max: 12 },
      sets: [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 90, drop: false }))
    }
  ];
  if (pidOutOfScope) {
    exercises.push({
      prescriptionExerciseId: pidOutOfScope,
      exerciseName: 'Elevaciones laterales T842',
      technique: 'straight',
      alternatives: [],
      repsRange: { min: 10, max: 15 },
      sets: [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget: 12, rirTarget: 2, load: 0, restSeconds: 60, drop: false }))
    });
  }
  const plan = {
    schema: 'vdsen-plan-v2',
    clientId,
    coachId,
    status,
    generatedBy: 'import',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt,
    weeks,
    daysPerWeek: 1,
    days: [{ dayIndex: 0, label: 'Día 1 - Empuje', exercises }]
  };
  if (active !== undefined) plan.active = active;
  return plan;
}

async function seedShadowFixture(label, opts = {}) {
  const tag = makeTag(label);
  const uid = 'ath-' + tag;
  const coachId = 'coach-' + tag;
  const planId = 'plan-' + tag;
  const pidInScope = 'pid-in-' + tag;
  const pidOutOfScope = opts.includeOutOfScope ? 'pid-out-' + tag : null;
  const plan = makePlan({
    clientId: uid,
    coachId,
    pidInScope,
    pidOutOfScope,
    weeks: opts.weeks || 4,
    status: opts.planStatus !== undefined ? opts.planStatus : 'active',
    active: opts.planActive
  });
  const futureExp = new Date(Date.now() + 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  await adminDb.doc('coaches/' + coachId).set({
    role: 'coach',
    autoApplyCanary: opts.canaryDoc !== undefined ? opts.canaryDoc : {
      enabled: true,
      clientIds: [uid],
      prescriptionExerciseIds: [pidInScope]
    }
  });
  await adminDb.doc('clients/' + uid).set({
    coachId,
    activePlanId: opts.activePlanId !== undefined ? opts.activePlanId : planId,
    coachInterventions: []
  });
  if (opts.skipPlanDoc !== true) {
    await adminDb.doc('plans/' + planId).set(plan);
  }
  if (opts.skipReleaseDoc !== true) {
    await adminDb.doc('releaseControl/autonomousProgression').set(opts.releaseDoc !== undefined ? opts.releaseDoc : {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: futureExp,
      clientIds: [uid]
    });
  }
  return { tag, uid, coachId, planId, pidInScope, pidOutOfScope, plan, futureExp };
}

async function callTrigger(handler, req) {
  let status = null, body = null;
  const headers = {};
  const res = {
    status(c) { status = c; return this; },
    json(b) { body = b; return this; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; }
  };
  await handler(req, res);
  return { status, body, headers };
}

function makeShadowHandler(uid, extra = {}) {
  const diagLogs = [];
  const handler = trigger.makeHandler(Object.assign({
    db: adminDb,
    verifyIdToken: async (tok) => {
      if (tok === 'bad-token') throw new Error('invalid');
      return { uid };
    },
    enabled: true,
    numericApplyEnabled: false,
    clock: () => new Date().toISOString(),
    log: (line) => diagLogs.push(line)
  }, extra));
  return { handler, diagLogs };
}

async function writeRealClientSessions(clientDb, { uid, planId, plan, pidInScope, pidOutOfScope, weeks = [1, 2], carga = '100', reps = '10', rir = 2, rirReal = 4, ics = 7.5, articularPain = false, extraSetProps = {}, writeStarts = true, progActionOverride = null }) {
  const entries = {};
  const baseTs = Date.now() - 86400000 * 14;
  for (const w of weeks) {
    for (let s = 0; s < 3; s++) {
      entries['log_' + w + '_0_0_s' + s] = Object.assign({
        done: true, carga: String(carga), reps: String(reps), unit: 'KG',
        rir, rir_real: rirReal, ics, prescriptionExerciseId: pidInScope,
        executionExerciseId: pidInScope, ts: baseTs + w * 1000000 + s
      }, extraSetProps);
    }
    if (pidOutOfScope) {
      for (let s = 0; s < 3; s++) {
        entries['log_' + w + '_0_1_s' + s] = {
          done: true, carga: '12', reps: '12', unit: 'KG',
          rir: 2, rir_real: 4, ics: 7.5, prescriptionExerciseId: pidOutOfScope,
          executionExerciseId: pidOutOfScope, ts: baseTs + w * 1000000 + 100 + s
        };
      }
    }
    const postData = {
      eimd: 2,
      articularPain: { present: articularPain, pattern: articularPain ? 'shoulder' : '' },
      sleepHours: 7,
      rpeAverage: 7,
      ts: baseTs + w * 1000000 + 5000
    };
    entries['postsession_' + w + '_0'] = postData;
    entries['done_' + w + '_0'] = { ts: baseTs + w * 1000000 + 6000 };

    if (progActionOverride) {
      entries['progrec_' + w + '_0'] = {
        calculatedAt: new Date().toISOString(),
        recommendations: [{
          prescriptionExerciseId: pidInScope,
          exerciseName: 'Press de pecho T842',
          action: progActionOverride.action,
          newLoad: progActionOverride.newLoad,
          newReps: progActionOverride.newReps
        }]
      };
    } else {
      const rec = runRealClientCalculateProgression(plan, entries, w, 0, postData);
      if (rec) {
        const sanitized = JSON.parse(JSON.stringify(rec, (_k, v) => (typeof v === 'number' && !isFinite(v)) ? null : v));
        entries['progrec_' + w + '_0'] = Object.assign({ calculatedAt: new Date().toISOString() }, sanitized);
      }
    }
  }

  // Real Firestore client SDK writes governed by firestore.t689.rules (merge: true preserves server-owned progressionApplicationSummary/progressionApplications, matching _doSaveLogs)
  await setDoc(doc(clientDb, 'logs', uid), { planId, currentWeek: weeks[weeks.length - 1], entries, updatedAt: Date.now() }, { merge: true });
  await setDoc(doc(clientDb, 'logs', uid, 'mesos', planId), { planId, currentWeek: weeks[weeks.length - 1], entries, updatedAt: Date.now() }, { merge: true });
  if (writeStarts) {
    for (const w of weeks) {
      const startRef = doc(clientDb, 'logs', uid, 'starts', planId + '_' + w + '_0_0');
      const existing = await getDoc(startRef);
      if (!existing.exists()) {
        await setDoc(startRef, {
          planId, week: w, dayIndex: 0, exerciseIndex: 0, setKey: 'log_' + w + '_0_0_s0', at: serverTimestamp()
        });
      }
    }
  }
  return entries;
}

// ============================================================================
// T842.E1 — Primary End-to-End STAGE1_SHADOW Chain
// ============================================================================
test('T842.E1 Primary STAGE1_SHADOW E2E: App Cliente -> Rules -> Trigger -> Motor -> Firestore -> App Coach consumer (NUMERIC_APPLY_ENABLED=false)', async () => {
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false, 'NUMERIC_APPLY_ENABLED must remain false');
  assert.equal(policy.NUMERIC_APPLY_ENABLED, false, 'Policy NUMERIC_APPLY_ENABLED must remain false');
  assert.notEqual(process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED, 'true');

  const f = await seedShadowFixture('e1', { includeOutOfScope: true });
  const planBefore = JSON.stringify((await adminDb.doc('plans/' + f.planId).get()).data());

  // 1. Client writes real Week 1 & Week 2 logbook + real calculateProgression progrec + start markers under real Firestore rules
  const clientUser = await asUser(f.uid);
  const entries = await writeRealClientSessions(clientUser.db, {
    uid: f.uid, planId: f.planId, plan: f.plan,
    pidInScope: f.pidInScope, pidOutOfScope: f.pidOutOfScope,
    weeks: [1, 2], carga: '100', reps: '10', rir: 2, rirReal: 4, ics: 7.5
  });
  assert.ok(entries.progrec_2_0 && entries.progrec_2_0.recommendations.length >= 1, 'Real client calculateProgression produced progrec_2_0');

  // 2. Security check under real rules: Client CANNOT tamper with progressionApplications or releaseControl
  await assert.rejects(
    setDoc(doc(clientUser.db, 'logs', f.uid, 'mesos', f.planId), { progressionApplications: { forged: { state: 'APPLIED' } } }, { merge: true }),
    /permission-denied|PERMISSION_DENIED/i,
    'Firestore rules must block athlete from writing progressionApplications'
  );
  await assert.rejects(
    setDoc(doc(clientUser.db, 'releaseControl', 'autonomousProgression'), { enabled: true }),
    /permission-denied|PERMISSION_DENIED/i,
    'Firestore rules must block athlete from writing releaseControl'
  );

  // 3. HTTP Trigger in STAGE1_SHADOW mode (enabled: true, numericApplyEnabled: false)
  const { handler, diagLogs } = makeShadowHandler(f.uid);
  const r = await callTrigger(handler, {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-t842-token' },
    body: { planId: f.planId }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'MATERIALIZED');
  assert.ok(r.body.created.length >= 1, 'In-scope records created');
  assert.deepEqual(r.body.applied, [], 'SHADOW mode must never apply numeric overlays');
  assert.deepEqual(r.body.consumed, [], 'SHADOW mode must never consume overlays');
  assert.match(r.headers['x-vdsen-progression-request-id'], /^[a-f0-9-]{36}$/i);

  // Diagnostic sink check (no UID / token leak)
  assert.equal(diagLogs.length, 1);
  const diag = JSON.parse(diagLogs[0]);
  assert.equal(diag.outcome, 'MATERIALIZED');
  assert.equal(diag.processingEnabled, true);
  assert.equal(diag.numericApplyEnabled, false);
  assert.equal(diag.created, r.body.created.length);
  assert.equal(diag.applied, 0);
  assert.ok(!diagLogs[0].includes(f.uid), 'Diagnostic log must not leak UID');
  assert.ok(!diagLogs[0].includes('synthetic-t842-token'), 'Diagnostic log must not leak token');

  // 4. Verify durable Firestore evidence (meso + root) and zero mutation of original plan
  const mesoData = (await adminDb.doc('logs/' + f.uid + '/mesos/' + f.planId).get()).data();
  const rootData = (await adminDb.doc('logs/' + f.uid).get()).data();
  const records = mesoData.progressionApplications || {};
  const recList = Object.values(records);
  assert.equal(recList.length, r.body.created.length);
  assert.ok(recList.every((x) => x.prescriptionExerciseId === f.pidInScope), 'Every materialized record must belong to in-scope PID only (out-of-scope PID excluded)');
  assert.ok(recList.every((x) => x.prescriptionExerciseId !== f.pidOutOfScope), 'Out-of-scope PID must never produce a record');
  const rec = recList.find((x) => x.source && x.source.week === 2);
  assert.ok(rec, 'Week 2 shadow decision record exists');
  assert.equal(rec.state, 'PENDING');
  assert.equal(rec.prescriptionExerciseId, f.pidInScope);
  assert.deepEqual(rec.nextExposure, { week: 3, dayIndex: 0 });
  assert.equal(rec.magnitude.mode, 'SHADOW');
  assert.equal(rec.magnitude.eligible, true);
  assert.equal(rec.magnitude.numericApplyAllowed, false);
  assert.equal(rec.magnitude.applied, false);
  assert.equal(rec.magnitude.ruleId, 'A');
  assert.equal(rec.magnitude.dimension, 'LOAD');
  assert.equal(rec.magnitude.candidates[0].rawCandidate, 105);
  assert.ok(rec.sraTrace, 'SRA read-only provenance trace attached');
  assert.equal(Object.keys(mesoData.nextExposureOverlays || {}).length, 0, 'Zero overlays written in SHADOW');

  assert.deepEqual(mesoData.progressionApplicationSummary, rootData.progressionApplicationSummary);
  assert.equal(rootData.progressionApplicationSummary.planId, f.planId);
  assert.equal(rootData.progressionApplicationSummary.autoCount, recList.filter((x) => x.state === 'PENDING').length);
  assert.equal(rootData.progressionApplicationSummary.counts.APPLIED, 0);

  const planAfter = JSON.stringify((await adminDb.doc('plans/' + f.planId).get()).data());
  assert.equal(planAfter, planBefore, 'Original prescription in plans/{planId} must remain byte-for-byte intact');

  // 5. App Coach reads persisted summary & canonical records under real Firestore rules
  const coachUser = await asUser(f.coachId);
  const otherCoach = await asUser('coach-intruder-' + f.tag);
  const coachRootSnap = await getDoc(doc(coachUser.db, 'logs', f.uid));
  const coachMesoSnap = await getDoc(doc(coachUser.db, 'logs', f.uid, 'mesos', f.planId));
  assert.equal(coachRootSnap.exists(), true);
  assert.equal(coachMesoSnap.exists(), true);

  // Cross-tenant Coach isolation under real rules
  await assert.rejects(
    getDoc(doc(otherCoach.db, 'logs', f.uid)),
    /permission-denied|PERMISSION_DENIED/i,
    'Unrelated coach must be denied reading athlete logs'
  );
  await assert.rejects(
    setDoc(doc(coachUser.db, 'releaseControl', 'autonomousProgression'), { enabled: false }),
    /permission-denied|PERMISSION_DENIED/i,
    'Coach must be denied writing releaseControl'
  );

  // 6. Real App Coach consumer renders the persisted STAGE1_SHADOW decision
  const coachUI = loadRealCoachShadowConsumer();
  const autoSummary = coachRootSnap.data().progressionApplicationSummary;
  const canonicalRecords = coachMesoSnap.data().progressionApplications;
  const dryRuns = {};
  for (const it of autoSummary.items) {
    dryRuns[it.key] = consumer.planApplication({
      record: canonicalRecords[it.key],
      context: {
        clientId: f.uid, planId: f.planId, activePlanId: f.planId,
        plan: f.plan, entries: coachMesoSnap.data().entries,
        interventions: [], existingOverlays: {},
        resolveNextExposure: shadow.resolveNextExposure, now: new Date().toISOString()
      }
    });
  }
  const coachHtml = coachUI._renderShadowAutoFeed(autoSummary, dryRuns);
  assert.ok(!/undefined|NaN/.test(coachHtml), 'Coach rendered HTML must not contain undefined/NaN');
  assert.match(coachHtml, /AUTO \d+/);
  assert.match(coachHtml, /CANDIDATO SHADOW · NO APLICADO/);
  assert.match(coachHtml, /Candidato resuelto en shadow — no se aplica/);
  assert.match(coachHtml, /prescripción original intacta/);
  assert.match(coachHtml, /105/);
  assert.match(coachHtml, /Sem 3 · Día 1/);
  assert.match(coachHtml, /Mantener original/);
});

// ============================================================================
// T842.E2 — Idempotency & Concurrency in STAGE1_SHADOW
// ============================================================================
test('T842.E2 Duplicate sequential calls & concurrent trigger burst are idempotent and produce exactly 1 SHADOW record', async () => {
  // Part A: Sequential duplicate execution
  const f1 = await seedShadowFixture('e2-seq');
  const u1 = await asUser(f1.uid);
  await writeRealClientSessions(u1.db, { uid: f1.uid, planId: f1.planId, plan: f1.plan, pidInScope: f1.pidInScope });
  const { handler: h1 } = makeShadowHandler(f1.uid);

  const first = await callTrigger(h1, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: f1.planId } });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'MATERIALIZED');
  assert.ok(first.body.created.length >= 1);
  const m1BeforeDup = (await adminDb.doc('logs/' + f1.uid + '/mesos/' + f1.planId).get()).data();
  const snapBeforeDup = JSON.stringify(m1BeforeDup.progressionApplications);

  const second = await callTrigger(h1, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: f1.planId } });
  assert.equal(second.status, 200);
  assert.equal(second.body.status, 'NO_CHANGE');
  assert.deepEqual(second.body.created, []);
  assert.deepEqual(second.body.applied, []);

  const m1 = (await adminDb.doc('logs/' + f1.uid + '/mesos/' + f1.planId).get()).data();
  assert.equal(JSON.stringify(m1.progressionApplications), snapBeforeDup, 'Duplicate trigger must not alter any record or revision');
  const w2Rec1 = Object.values(m1.progressionApplications || {}).find((r) => r.source && r.source.week === 2);
  assert.ok(w2Rec1 && w2Rec1.state === 'PENDING' && w2Rec1.revision === 1, 'Week 2 PENDING record stays at revision 1');
  assert.equal(Object.keys(m1.nextExposureOverlays || {}).length, 0);

  // Part B: Concurrent burst (3 simultaneous POST requests on fresh athlete)
  const f2 = await seedShadowFixture('e2-conc');
  const u2 = await asUser(f2.uid);
  await writeRealClientSessions(u2.db, { uid: f2.uid, planId: f2.planId, plan: f2.plan, pidInScope: f2.pidInScope });
  const { handler: h2 } = makeShadowHandler(f2.uid);
  const req = () => ({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: f2.planId } });
  const burst = await Promise.all([callTrigger(h2, req()), callTrigger(h2, req()), callTrigger(h2, req())]);

  const materializedCall = burst.find((x) => x.status === 200 && x.body.status === 'MATERIALIZED');
  assert.ok(materializedCall, 'At least one concurrent call materializes');
  assert.ok(burst.every((x) => x.status === 200 || x.status === 500), 'Concurrent calls either succeed or fail closed on contention');
  const m2 = (await adminDb.doc('logs/' + f2.uid + '/mesos/' + f2.planId).get()).data();
  const k2 = Object.keys(m2.progressionApplications || {});
  assert.equal(k2.length, materializedCall.body.created.length, 'Concurrent burst must never create duplicate records');
  const w2Rec2 = Object.values(m2.progressionApplications || {}).find((r) => r.source && r.source.week === 2);
  assert.ok(w2Rec2 && w2Rec2.state === 'PENDING' && w2Rec2.revision === 1, 'Concurrent Week 2 PENDING record stays at revision 1');
  assert.equal(m2.progressionApplicationSummary.autoCount, Object.values(m2.progressionApplications).filter((x) => x.state === 'PENDING').length);
  assert.equal(Object.keys(m2.nextExposureOverlays || {}).length, 0);
});

// ============================================================================
// T842.E3 — Negative Auth, Tenant Isolation, Inactive/Missing Plan, Out-of-Scope
// ============================================================================
test('T842.E3 Unauthorized caller, wrong method, cross-tenant, missing/inactive plan, and out-of-scope exercise produce zero writes', async () => {
  const f = await seedShadowFixture('e3');
  const u = await asUser(f.uid);
  await writeRealClientSessions(u.db, { uid: f.uid, planId: f.planId, plan: f.plan, pidInScope: f.pidInScope });
  const { handler } = makeShadowHandler(f.uid);

  // Missing auth -> 401
  const rNoAuth = await callTrigger(handler, { method: 'POST', headers: {}, body: { planId: f.planId } });
  assert.equal(rNoAuth.status, 401);
  assert.equal(rNoAuth.body.error, 'AUTH_MISSING');

  // Invalid token -> 401
  const rBadAuth = await callTrigger(handler, { method: 'POST', headers: { authorization: 'Bearer bad-token' }, body: { planId: f.planId } });
  assert.equal(rBadAuth.status, 401);
  assert.equal(rBadAuth.body.error, 'AUTH_INVALID');

  // Wrong method -> 405
  const rPut = await callTrigger(handler, { method: 'PUT', headers: { authorization: 'Bearer tok' }, body: { planId: f.planId } });
  assert.equal(rPut.status, 405);

  // Missing planId -> 400
  const rNoPlan = await callTrigger(handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: {} });
  assert.equal(rNoPlan.status, 400);

  // Cross-tenant authenticated intruder targeting victim's planId -> PLAN_MISMATCH, 0 writes
  const { handler: intruderHandler } = makeShadowHandler('ath-intruder-' + f.tag);
  const rIntruder = await callTrigger(intruderHandler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: f.planId } });
  assert.equal(rIntruder.status, 200);
  assert.equal(rIntruder.body.status, 'PLAN_MISMATCH');
  assert.equal((await adminDb.doc('logs/' + f.uid + '/mesos/' + f.planId).get()).data().progressionApplications, undefined);

  // Missing plan doc -> SOURCE_INVALID, 0 writes
  const fMissing = await seedShadowFixture('e3-missing', { skipPlanDoc: true });
  const uMissing = await asUser(fMissing.uid);
  await writeRealClientSessions(uMissing.db, { uid: fMissing.uid, planId: fMissing.planId, plan: fMissing.plan, pidInScope: fMissing.pidInScope });
  const rMissing = await callTrigger(makeShadowHandler(fMissing.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fMissing.planId } });
  assert.equal(rMissing.body.status, 'SOURCE_INVALID');
  assert.equal((await adminDb.doc('logs/' + fMissing.uid + '/mesos/' + fMissing.planId).get()).data().progressionApplications, undefined);

  // Inactive plan doc -> SOURCE_INVALID, 0 writes
  const fInact = await seedShadowFixture('e3-inactive', { planStatus: 'inactive', planActive: false });
  const uInact = await asUser(fInact.uid);
  await writeRealClientSessions(uInact.db, { uid: fInact.uid, planId: fInact.planId, plan: fInact.plan, pidInScope: fInact.pidInScope });
  const rInact = await callTrigger(makeShadowHandler(fInact.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fInact.planId } });
  assert.equal(rInact.body.status, 'SOURCE_INVALID');
  assert.equal((await adminDb.doc('logs/' + fInact.uid + '/mesos/' + fInact.planId).get()).data().progressionApplications, undefined);

  // Exercise completely out of canary PID scope -> NO_CHANGE, 0 records
  const fOut = await seedShadowFixture('e3-outscope');
  await adminDb.doc('coaches/' + fOut.coachId).set({
    role: 'coach',
    autoApplyCanary: { enabled: true, clientIds: [fOut.uid], prescriptionExerciseIds: ['pid-completely-different'] }
  });
  const uOut = await asUser(fOut.uid);
  await writeRealClientSessions(uOut.db, { uid: fOut.uid, planId: fOut.planId, plan: fOut.plan, pidInScope: fOut.pidInScope });
  const rOut = await callTrigger(makeShadowHandler(fOut.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fOut.planId } });
  assert.equal(rOut.body.status, 'NO_CHANGE');
  assert.deepEqual(rOut.body.created, []);
  assert.equal((await adminDb.doc('logs/' + fOut.uid + '/mesos/' + fOut.planId).get()).data().progressionApplications, undefined);
});

// ============================================================================
// T842.E4 — Incomplete Logbook, Invalid Data, Ineligible Session & Multi-State Coach Validation
// ============================================================================
test('T842.E4 Incomplete logbook, invalid/non-canonical sets, ineligible session, Coach Review (C+E), Maintain, and Safety Conflict on Emulator', async () => {
  const coachUI = loadRealCoachShadowConsumer();

  // 1. Missing start markers -> ineligible (no verifiable App Cliente activity), 0 writes
  const fNoStart = await seedShadowFixture('e4-nostart');
  const uNoStart = await asUser(fNoStart.uid);
  await writeRealClientSessions(uNoStart.db, { uid: fNoStart.uid, planId: fNoStart.planId, plan: fNoStart.plan, pidInScope: fNoStart.pidInScope, writeStarts: false });
  const rNoStart = await callTrigger(makeShadowHandler(fNoStart.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fNoStart.planId } });
  assert.ok(['NO_VERIFIABLE_APP_USAGE', 'NEEDS_VERIFIED_ACTIVITY', 'AWAITING_FIRST_ACTIVITY', 'NEW_CLIENT_AWAITING_FIRST_ACTIVITY', 'NO_TEMPORAL_EVIDENCE'].includes(rNoStart.body.status), 'Expected activity gate rejection, got: ' + rNoStart.body.status);
  assert.equal((await adminDb.doc('logs/' + fNoStart.uid + '/mesos/' + fNoStart.planId).get()).data().progressionApplications, undefined);

  // 2. Single comparable exposure (W1 only) -> PENDING, magnitude.eligible=false (INSUFFICIENT_COMPARABLE_EXPOSURES), Coach renders blocked
  const fSingle = await seedShadowFixture('e4-single');
  const uSingle = await asUser(fSingle.uid);
  await writeRealClientSessions(uSingle.db, {
    uid: fSingle.uid, planId: fSingle.planId, plan: fSingle.plan, pidInScope: fSingle.pidInScope,
    weeks: [1], progActionOverride: { action: 'increase_load', newLoad: 102.5, newReps: 10 }
  });
  const rSingle = await callTrigger(makeShadowHandler(fSingle.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fSingle.planId } });
  assert.equal(rSingle.body.status, 'MATERIALIZED');
  const mSingle = (await adminDb.doc('logs/' + fSingle.uid + '/mesos/' + fSingle.planId).get()).data();
  const recSingle = Object.values(mSingle.progressionApplications)[0];
  assert.equal(recSingle.magnitude.eligible, false);
  assert.ok(recSingle.magnitude.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES'));
  assert.equal(Object.keys(mSingle.nextExposureOverlays || {}).length, 0);
  const htmlSingle = coachUI._renderShadowAutoFeed(mSingle.progressionApplicationSummary, {});
  assert.match(htmlSingle, /Sin evidencia suficiente o bloqueada/);

  // 3. Invalid / non-canonical evidence (autoFilled=true) -> excluded, never eligible
  const fAuto = await seedShadowFixture('e4-autofill');
  const uAuto = await asUser(fAuto.uid);
  await writeRealClientSessions(uAuto.db, {
    uid: fAuto.uid, planId: fAuto.planId, plan: fAuto.plan, pidInScope: fAuto.pidInScope,
    weeks: [1, 2], extraSetProps: { autoFilled: true }, progActionOverride: { action: 'increase_load', newLoad: 102.5, newReps: 10 }
  });
  const rAuto = await callTrigger(makeShadowHandler(fAuto.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fAuto.planId } });
  const mAuto = (await adminDb.doc('logs/' + fAuto.uid + '/mesos/' + fAuto.planId).get()).data();
  const recsAuto = Object.values(mAuto.progressionApplications || {});
  assert.ok(recsAuto.every((x) => x.magnitude && x.magnitude.eligible === false), 'Auto-filled sets must never yield an eligible candidate');
  assert.equal(Object.keys(mAuto.nextExposureOverlays || {}).length, 0);

  // 4. Last week of plan (no next exposure) -> REJECTED / NO_NEXT_EXPOSURE
  const fLast = await seedShadowFixture('e4-lastwk', { weeks: 2 });
  const uLast = await asUser(fLast.uid);
  await writeRealClientSessions(uLast.db, {
    uid: fLast.uid, planId: fLast.planId, plan: fLast.plan, pidInScope: fLast.pidInScope,
    weeks: [1, 2], progActionOverride: { action: 'increase_load', newLoad: 102.5, newReps: 10 }
  });
  const rLast = await callTrigger(makeShadowHandler(fLast.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fLast.planId } });
  assert.equal(rLast.body.status, 'MATERIALIZED');
  const mLast = (await adminDb.doc('logs/' + fLast.uid + '/mesos/' + fLast.planId).get()).data();
  const recLastW2 = Object.values(mLast.progressionApplications).find((x) => x.source.week === 2);
  assert.equal(recLastW2.state, 'REJECTED');
  assert.equal(recLastW2.reasonCode, 'NO_NEXT_EXPOSURE');

  // 5. Coach Review Required (Rule C->E: reps incomplete at target RIR across 2 comparable exposures)
  const fRev = await seedShadowFixture('e4-review');
  const uRev = await asUser(fRev.uid);
  await writeRealClientSessions(uRev.db, {
    uid: fRev.uid, planId: fRev.planId, plan: fRev.plan, pidInScope: fRev.pidInScope,
    weeks: [1, 2], reps: '8', rir: 2, rirReal: 2, progActionOverride: { action: 'maintain', newLoad: 100, newReps: 10 }
  });
  await callTrigger(makeShadowHandler(fRev.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fRev.planId } });
  const mRev = (await adminDb.doc('logs/' + fRev.uid + '/mesos/' + fRev.planId).get()).data();
  const recRevW2 = Object.values(mRev.progressionApplications).find((x) => x.source.week === 2);
  assert.equal(recRevW2.state, 'PENDING');
  assert.equal(recRevW2.magnitude.coachReviewRequired.branch, 'C+E');
  assert.equal(Object.keys(mRev.nextExposureOverlays || {}).length, 0);
  const htmlRev = coachUI._renderShadowAutoFeed(mRev.progressionApplicationSummary, {});
  assert.match(htmlRev, /REVISIÓN DEL COACH REQUERIDA/);
  assert.match(htmlRev, /sin candidato automático/);

  // 6. Maintain / No change recommended -> REJECTED / NO_NUMERIC_DELTA
  const fMaint = await seedShadowFixture('e4-maint');
  const uMaint = await asUser(fMaint.uid);
  await writeRealClientSessions(uMaint.db, {
    uid: fMaint.uid, planId: fMaint.planId, plan: fMaint.plan, pidInScope: fMaint.pidInScope,
    weeks: [1, 2], reps: '10', rir: 2, rirReal: 2, progActionOverride: { action: 'maintain', newLoad: 100, newReps: 10 }
  });
  await callTrigger(makeShadowHandler(fMaint.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fMaint.planId } });
  const mMaint = (await adminDb.doc('logs/' + fMaint.uid + '/mesos/' + fMaint.planId).get()).data();
  const recMaint = Object.values(mMaint.progressionApplications).find((x) => x.source.week === 2);
  assert.equal(recMaint.state, 'REJECTED');
  assert.equal(recMaint.reasonCode, 'NO_NUMERIC_DELTA');
  const htmlMaint = coachUI._renderShadowAutoFeed(mMaint.progressionApplicationSummary, {});
  assert.match(htmlMaint, /RECHAZADA/);
  assert.match(htmlMaint, /NO_NUMERIC_DELTA/);

  // 7. Safety conflict (articularPain=true) -> blocked by SAFETY_HOLD or SAFETY_CONFLICT, never eligible, zero overlays
  const fPain = await seedShadowFixture('e4-pain');
  const uPain = await asUser(fPain.uid);
  await writeRealClientSessions(uPain.db, {
    uid: fPain.uid, planId: fPain.planId, plan: fPain.plan, pidInScope: fPain.pidInScope,
    weeks: [1, 2], articularPain: true, progActionOverride: { action: 'increase_load', newLoad: 102.5, newReps: 10 }
  });
  const rPain = await callTrigger(makeShadowHandler(fPain.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fPain.planId } });
  const mPain = (await adminDb.doc('logs/' + fPain.uid + '/mesos/' + fPain.planId).get()).data();
  assert.equal(Object.keys(mPain.nextExposureOverlays || {}).length, 0);
  if (rPain.body.status === 'SAFETY_HOLD') {
    assert.equal(mPain.progressionApplications, undefined, 'SAFETY_HOLD blocks materialization completely');
  } else {
    const recPain = Object.values(mPain.progressionApplications || {}).find((x) => x.source.week === 2);
    assert.ok(recPain && recPain.magnitude.eligible === false && recPain.magnitude.reasonCodes.includes('SAFETY_CONFLICT'));
    const htmlPain = coachUI._renderShadowAutoFeed(mPain.progressionApplicationSummary, {});
    assert.match(htmlPain, /conflicto de seguridad/);
  }
});

// ============================================================================
// T842.E5 — STOP, Revocation, Expired Window, Closed/Inconsistent Fences, Persistence Error
// ============================================================================
test('T842.E5 Closed/inconsistent fences, expired windows, STOP mid-lifecycle, and persistence failure fail closed with zero improper writes', async () => {
  const pastIso = new Date(Date.now() - 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const futureIso = new Date(Date.now() + 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // 1. Both fences closed -> OUT_OF_ALLOWLIST, 0 writes
  const fClosed = await seedShadowFixture('e5-closed', {
    releaseDoc: { schema: 'vdsen-autonomous-release-v1', enabled: false, expiresAt: futureIso, clientIds: [] },
    canaryDoc: { enabled: false, clientIds: [], prescriptionExerciseIds: [] }
  });
  const uClosed = await asUser(fClosed.uid);
  await writeRealClientSessions(uClosed.db, { uid: fClosed.uid, planId: fClosed.planId, plan: fClosed.plan, pidInScope: fClosed.pidInScope });
  const rClosed = await callTrigger(makeShadowHandler(fClosed.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fClosed.planId } });
  assert.equal(rClosed.body.status, 'OUT_OF_ALLOWLIST');
  assert.equal((await adminDb.doc('logs/' + fClosed.uid + '/mesos/' + fClosed.planId).get()).data().progressionApplications, undefined);

  // 2. Inconsistent fences: release open + canary closed -> OUT_OF_CANARY, 0 writes
  const fInc1 = await seedShadowFixture('e5-inc1', {
    canaryDoc: { enabled: false, clientIds: [], prescriptionExerciseIds: [] }
  });
  const uInc1 = await asUser(fInc1.uid);
  await writeRealClientSessions(uInc1.db, { uid: fInc1.uid, planId: fInc1.planId, plan: fInc1.plan, pidInScope: fInc1.pidInScope });
  const rInc1 = await callTrigger(makeShadowHandler(fInc1.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fInc1.planId } });
  assert.equal(rInc1.body.status, 'OUT_OF_CANARY');
  assert.equal((await adminDb.doc('logs/' + fInc1.uid + '/mesos/' + fInc1.planId).get()).data().progressionApplications, undefined);

  // 3. Inconsistent fences: release closed + canary open -> OUT_OF_ALLOWLIST, 0 writes
  const fInc2 = await seedShadowFixture('e5-inc2', {
    releaseDoc: { schema: 'vdsen-autonomous-release-v1', enabled: false, expiresAt: futureIso, clientIds: ['other'] }
  });
  const uInc2 = await asUser(fInc2.uid);
  await writeRealClientSessions(uInc2.db, { uid: fInc2.uid, planId: fInc2.planId, plan: fInc2.plan, pidInScope: fInc2.pidInScope });
  const rInc2 = await callTrigger(makeShadowHandler(fInc2.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fInc2.planId } });
  assert.equal(rInc2.body.status, 'OUT_OF_ALLOWLIST');
  assert.equal((await adminDb.doc('logs/' + fInc2.uid + '/mesos/' + fInc2.planId).get()).data().progressionApplications, undefined);

  // 4. Expired releaseControl window -> OUT_OF_ALLOWLIST, 0 writes
  const fExp = await seedShadowFixture('e5-exp');
  await adminDb.doc('releaseControl/autonomousProgression').set({
    schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: pastIso, clientIds: [fExp.uid]
  });
  const uExp = await asUser(fExp.uid);
  await writeRealClientSessions(uExp.db, { uid: fExp.uid, planId: fExp.planId, plan: fExp.plan, pidInScope: fExp.pidInScope });
  const rExp = await callTrigger(makeShadowHandler(fExp.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fExp.planId } });
  assert.equal(rExp.body.status, 'OUT_OF_ALLOWLIST');
  assert.equal((await adminDb.doc('logs/' + fExp.uid + '/mesos/' + fExp.planId).get()).data().progressionApplications, undefined);

  // 5. Expired VDSEN_PILOT_WINDOW -> HTTP 202 OUT_OF_ALLOWLIST, 0 writes
  const fWin = await seedShadowFixture('e5-win');
  const uWin = await asUser(fWin.uid);
  await writeRealClientSessions(uWin.db, { uid: fWin.uid, planId: fWin.planId, plan: fWin.plan, pidInScope: fWin.pidInScope });
  const expiredPilotWindow = JSON.stringify({
    uidHash: trigger.PILOT_UID_HASH,
    planHash: crypto.createHash('sha256').update(fWin.planId).digest('hex'),
    expiresAt: pastIso,
    operationId: 'op-t842-expired-win'
  });
  const rWin = await callTrigger(
    makeShadowHandler(fWin.uid, { pilotWindow: expiredPilotWindow }).handler,
    { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fWin.planId } }
  );
  assert.equal(rWin.status, 202);
  assert.equal(rWin.body.status, 'OUT_OF_ALLOWLIST');
  assert.equal((await adminDb.doc('logs/' + fWin.uid + '/mesos/' + fWin.planId).get()).data().progressionApplications, undefined);

  // 6. STOP during/after processing: Cycle 1 materializes; STOP revokes fences & switch; Cycle 2 writes nothing; prior evidence stays readable
  const fStop = await seedShadowFixture('e5-stop');
  const uStop = await asUser(fStop.uid);
  await writeRealClientSessions(uStop.db, { uid: fStop.uid, planId: fStop.planId, plan: fStop.plan, pidInScope: fStop.pidInScope, weeks: [1, 2] });
  const rCycle1 = await callTrigger(makeShadowHandler(fStop.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fStop.planId } });
  assert.equal(rCycle1.body.status, 'MATERIALIZED');
  const beforeStop = JSON.stringify((await adminDb.doc('logs/' + fStop.uid + '/mesos/' + fStop.planId).get()).data().progressionApplications);

  // Execute STOP (close fences) + log Week 3
  await adminDb.doc('releaseControl/autonomousProgression').set({
    schema: 'vdsen-autonomous-release-v1', enabled: false, expiresAt: pastIso, clientIds: []
  });
  await adminDb.doc('coaches/' + fStop.coachId).set({
    role: 'coach', autoApplyCanary: { enabled: false, clientIds: [], prescriptionExerciseIds: [] }
  });
  await writeRealClientSessions(uStop.db, { uid: fStop.uid, planId: fStop.planId, plan: fStop.plan, pidInScope: fStop.pidInScope, weeks: [1, 2, 3] });

  const rAfterStopFence = await callTrigger(makeShadowHandler(fStop.uid).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fStop.planId } });
  assert.equal(rAfterStopFence.body.status, 'OUT_OF_ALLOWLIST');

  const rAfterStopSwitch = await callTrigger(makeShadowHandler(fStop.uid, { enabled: false }).handler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fStop.planId } });
  assert.equal(rAfterStopSwitch.status, 202);
  assert.equal(rAfterStopSwitch.body.status, 'DISARMED');

  const afterStop = JSON.stringify((await adminDb.doc('logs/' + fStop.uid + '/mesos/' + fStop.planId).get()).data().progressionApplications);
  assert.equal(afterStop, beforeStop, 'STOP must preserve existing shadow records and write zero new records');

  // 7. Persistence failure during transaction -> HTTP 500, zero partial writes in Firestore
  const fErr = await seedShadowFixture('e5-err');
  const uErr = await asUser(fErr.uid);
  await writeRealClientSessions(uErr.db, { uid: fErr.uid, planId: fErr.planId, plan: fErr.plan, pidInScope: fErr.pidInScope });
  const failingDb = {
    collection: (...args) => adminDb.collection(...args),
    runTransaction: async () => { const e = new Error('Simulated emulator persistence error'); e.code = 10; throw e; }
  };
  const { handler: errHandler, diagLogs: errLogs } = makeShadowHandler(fErr.uid, { db: failingDb });
  const rErr = await callTrigger(errHandler, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { planId: fErr.planId } });
  assert.equal(rErr.status, 500);
  assert.deepEqual(rErr.body, { error: 'PROGRESSION_PROCESSING_FAILED' });
  assert.equal(JSON.parse(errLogs[0]).errorCategory, 'CONTENTION');
  assert.equal((await adminDb.doc('logs/' + fErr.uid + '/mesos/' + fErr.planId).get()).data().progressionApplications, undefined, 'Failed transaction must leave zero partial writes');
});
