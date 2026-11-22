'use strict';
// T864-B — Reproducible E2E Numeric Apply Validation on real Firestore Emulator + real firestore.rules.
// Validates the complete live-equivalent route:
//   Official runPreflight() GO -> atomic executeArmFencesRest() (:commit all-or-nothing)
//   -> concurrent duplicate rejection (0 partial arm)
//   -> 2 comparable exposures on ucwGfeXn2NGPhnY6CZjb / 8821a34a-3474-4c13-a6c9-6246f92ed438 under real firestore.rules
//   -> POST /api/autonomous-progression-trigger (authorized numeric runtime window)
//   -> REAL NUMERIC_APPLY (APPLIED + nextExposureOverlays) -> effective.resolveEffective()
//   -> idempotent repeat (0 re-applied) -> executeStopRest() (allDisarmed=true, ledger=STOPPED).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'api/_numericPilotContract'));
const ops = require(path.join(ROOT, 'scripts/pilot/numeric-pilot-ops.cjs'));
const { DEFAULT_PROJECT_ID, DEFAULT_TEAM_ID } = require(path.join(ROOT, 'scripts/pilot/numeric-attestation.cjs'));
const trigger = require(path.join(ROOT, 'api/autonomous-progression-trigger.js'));
const effective = require(path.join(ROOT, 'assets/progression-effective-prescription.js'));

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-vdsen-t864';
assert.match(PROJECT_ID, /^demo-/, 'T864 emulator test must only ever run against a demo-* project');

const BASE_DOC = `projects/${PROJECT_ID}/databases/(default)/documents`;
const BASE_URL = `http://${HOST}/v1/${BASE_DOC}`;

function mockJwt(uid) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.`;
}

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) fields[k] = toFsValue(val);
    }
    return { mapValue: { fields } };
  }
  throw new Error('Unsupported value: ' + typeof v);
}

function fromFsValue(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return { toMillis: () => Date.parse(v.timestampValue), toDate: () => new Date(v.timestampValue), _iso: v.timestampValue };
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFsValue(val);
    return out;
  }
  return null;
}

function fromDoc(docJson) {
  const out = {};
  for (const [k, val] of Object.entries(docJson.fields || {})) out[k] = fromFsValue(val);
  return out;
}

async function fsCommit(authHeader, writes) {
  const resp = await fetch(`http://${HOST}/v1/${BASE_DOC}:commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authHeader },
    body: JSON.stringify({ writes }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Firestore commit failed (${resp.status}): ${text}`);
  return JSON.parse(text);
}

async function fsGet(authHeader, docPath) {
  const resp = await fetch(`${BASE_URL}/${docPath}`, { headers: { authorization: authHeader }, signal: AbortSignal.timeout(10000) });
  if (resp.status === 404) return { exists: false, id: docPath.split('/').pop(), data: () => undefined };
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Firestore get failed (${resp.status}): ${text}`);
  const parsed = JSON.parse(text);
  const d = fromDoc(parsed);
  return {
    exists: true,
    id: docPath.split('/').pop(),
    createTime: parsed.createTime ? { toMillis: () => Date.parse(parsed.createTime) } : undefined,
    data: () => d,
  };
}

async function fsList(authHeader, colPath) {
  const resp = await fetch(`${BASE_URL}/${colPath}?pageSize=100`, { headers: { authorization: authHeader }, signal: AbortSignal.timeout(10000) });
  if (resp.status === 404) return { docs: [], forEach: () => {} };
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Firestore list failed (${resp.status}): ${text}`);
  const parsed = JSON.parse(text);
  const docs = (parsed.documents || []).map(j => {
    const d = fromDoc(j);
    return { id: j.name.split('/').pop(), exists: true, data: () => d };
  });
  return { docs, forEach: fn => docs.forEach(fn) };
}

async function adminSet(docPath, data, merge = false) {
  const write = { update: { name: `${BASE_DOC}/${docPath}`, fields: toFsValue(data).mapValue.fields } };
  if (merge) write.updateMask = { fieldPaths: Object.keys(data) };
  return fsCommit('Bearer owner', [write]);
}

async function athleteWriteStart(uid, planId, week, dayIndex, exerciseIndex, setKey) {
  const docName = `${BASE_DOC}/logs/${uid}/starts/${planId}_${week}_${dayIndex}_${exerciseIndex}`;
  return fsCommit(`Bearer ${mockJwt(uid)}`, [{
    update: { name: docName, fields: toFsValue({ planId, week, dayIndex, exerciseIndex, setKey }).mapValue.fields },
    updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
  }]);
}

async function athleteWriteLog(uid, docPath, payload) {
  return fsCommit(`Bearer ${mockJwt(uid)}`, [{
    update: { name: `${BASE_DOC}/${docPath}`, fields: toFsValue(payload).mapValue.fields },
  }]);
}

function makeAdminDb() {
  function docRef(docPath) {
    return {
      path: docPath,
      id: docPath.split('/').pop(),
      get: () => fsGet('Bearer owner', docPath),
      set: (data, opts) => adminSet(docPath, data, !!(opts && opts.merge)),
      collection: (sub) => colRef(`${docPath}/${sub}`),
    };
  }
  function colRef(colPath) {
    return {
      path: colPath,
      doc: (id) => docRef(`${colPath}/${id}`),
      get: () => fsList('Bearer owner', colPath),
      orderBy() { return this; },
      where() { return this; },
      limit() { return this; },
    };
  }
  return {
    doc: docRef,
    collection: colRef,
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => { pending.push({ path: ref.path, data, merge: !!(opts && opts.merge) }); },
        update: (ref, data) => { pending.push({ path: ref.path, data, merge: true }); },
      };
      const result = await fn(tx);
      for (const w of pending) await adminSet(w.path, w.data, w.merge);
      return result;
    },
  };
}

async function invokeTrigger(handler, body) {
  let statusCode = 0, payload = null;
  const req = { method: 'POST', headers: { authorization: 'Bearer synth-token' }, body };
  const res = {
    setHeader() {},
    status(c) { statusCode = c; return this; },
    json(d) { payload = d; return this; },
    end() { return this; },
  };
  await handler(req, res);
  return { statusCode, payload };
}

test('T864-B E2E: Official GO preflight -> atomic arm-fences -> REAL NUMERIC_APPLY -> overlay -> effective prescription -> idempotency -> STOP', async () => {
  const adminDb = makeAdminDb();
  const UID = C.UID;
  const PLAN_ID = C.PLAN;
  const PID = C.PID;
  const COACH_ID = 'coach-ayrton-t864-e2e';
  const SHA = '0e4c98db0999e24e66e0f0455d21f128101f3cca';
  const DEPLOYMENT_ID = 'dpl_26Q4iTpsCbQvPNFR8vKwa74PrPpS';
  const ALIAS = 'vdsen-ecosistema.vercel.app';
  const OP_ID = 'op-t864b-e2e-atomic-01';
  const nowMs = Date.now();
  const startsAt = new Date(nowMs - 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresAt = new Date(nowMs + 12 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const planTime = new Date(nowMs - 24 * 3600 * 1000).toISOString();

  const win = {
    schema: 'vdsen-numeric-pilot-v1',
    mode: 'NUMERIC_APPLY',
    uid: UID,
    planId: PLAN_ID,
    pid: PID,
    runtimeSha: SHA,
    operationId: OP_ID,
    startsAt,
    expiresAt,
  };
  const plan = {
    id: PLAN_ID,
    clientId: UID,
    coachId: COACH_ID,
    status: 'active',
    weeks: 13,
    daysPerWeek: 7,
    createdAt: planTime,
    activatedAt: planTime,
    updatedAt: planTime,
    rirByWeek: { 1: 3, 2: 3, 3: 3, 4: 2 },
    days: [{
      dayIndex: 0,
      dayLabel: 'Sábado · D1 — Superior P1 completo',
      exercises: [{
        exerciseIndex: 2,
        exerciseName: 'Press Convergente Inclinado',
        exerciseType: 'fuerza',
        equipmentId: 'maquina-convergente-01',
        prescriptionExerciseId: PID,
        sets: [
          { setIndex: 0, load: 30, repsTarget: 8, rirTarget: 3, restSeconds: 150 },
          { setIndex: 1, load: 30, repsTarget: 8, rirTarget: 3, restSeconds: 150 },
          { setIndex: 2, load: 30, repsTarget: 8, rirTarget: 3, restSeconds: 150 },
        ],
      }],
    }],
  };

  // Seed disarmed fences, coach, client, and active plan
  await adminSet('releaseControl/autonomousProgression', { enabled: false, clientIds: [UID], expiresAt });
  await adminSet('releaseControl/numericPilot', { enabled: false, uid: UID, planId: PLAN_ID, pid: PID, runtimeSha: SHA, operationId: OP_ID, expiresAt });
  await adminSet(`coaches/${COACH_ID}`, {
    uid: COACH_ID,
    name: 'Coach Ayrton T864',
    equipmentCatalog: { 'maquina-convergente-01': { incrementKg: 2.5, unit: 'KG' } },
    autoApplyCanary: { enabled: false, clientIds: [UID], prescriptionExerciseIds: [PID] },
    updatedAt: planTime,
  });
  await adminSet(`clients/${UID}`, {
    uid: UID, coachId: COACH_ID, activePlanId: PLAN_ID,
    name: 'Ayrton T864', createdAt: new Date(nowMs - 60 * 86400000).toISOString(), updatedAt: planTime,
  });
  await adminSet(`plans/${PLAN_ID}`, plan);

  // 1) Official runPreflight() -> MUST return schema=vdsen-numeric-preflight-v1 & decision==='GO'
  const liveFences = await ops.fetchFencesFromRest(PROJECT_ID, 'owner', COACH_ID);
  const providerFetcher = async (url) => {
    if (url.includes('/aliases/')) {
      return { status: 200, json: async () => ({ alias: ALIAS, deploymentId: DEPLOYMENT_ID, projectId: DEFAULT_PROJECT_ID }) };
    }
    return {
      status: 200,
      json: async () => ({
        id: DEPLOYMENT_ID,
        projectId: DEFAULT_PROJECT_ID,
        teamId: DEFAULT_TEAM_ID,
        target: 'production',
        readyState: 'READY',
        alias: [ALIAS],
        env: ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'VDSEN_NUMERIC_PILOT_ENABLED'],
        meta: { githubCommitSha: SHA, vdsenPilotOperation: OP_ID },
      }),
    };
  };
  const preflight = await ops.runPreflight({
    window: win,
    deploymentId: DEPLOYMENT_ID,
    expectedAlias: ALIAS,
    currentRunId: '449999001',
    vercelToken: 'demo-token',
    activeRuns: [{ id: '449999001', status: 'in_progress' }],
    priorOperations: [],
    priorOperationsSourceVerified: true,
    priorOperationsCoverageComplete: true,
    fences: liveFences,
    now: nowMs,
    io: { fetcher: providerFetcher },
  });
  assert.equal(preflight.schema, 'vdsen-numeric-preflight-v1');
  assert.equal(preflight.decision, 'GO');

  // 2) Atomic arm-fences (:commit all-or-nothing) + concurrent duplicate conflict rejection
  const armResults = await Promise.allSettled([
    ops.executeArmFencesRest(PROJECT_ID, 'owner', { window: win, attestation: preflight.attestation, preflight, coachId: COACH_ID, runId: '449999001', now: nowMs }),
    ops.executeArmFencesRest(PROJECT_ID, 'owner', { window: win, attestation: preflight.attestation, preflight, coachId: COACH_ID, runId: '449999002', now: nowMs }),
  ]);
  const fulfilled = armResults.filter(r => r.status === 'fulfilled');
  const rejected = armResults.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent arm succeeds atomically');
  assert.equal(rejected.length, 1, 'concurrent duplicate rejected atomically');
  assert.match(rejected[0].reason.message, /OPERATION_ALREADY_EXISTS/);
  assert.equal(fulfilled[0].value.armed, true);
  assert.equal(fulfilled[0].value.atomicCommit, true);
  assert.equal(fulfilled[0].value.ledgerStatus, 'RESERVED');

  // 3) Athlete logs 2 comparable exposures under real firestore.rules
  const t1 = nowMs - 600000;
  const t2 = nowMs - 60000;
  const calcAt = new Date(t2 + 5000).toISOString();
  const entries = {
    log_1_0_2_s0: { done: true, carga: 30, reps: 8, unit: 'KG', rir: 3, rir_real: 2, ics: 10, ts: t1, planId: PLAN_ID, prescriptionExerciseId: PID },
    log_1_0_2_s1: { done: true, carga: 30, reps: 8, unit: 'KG', rir: 3, rir_real: 2, ics: 10, ts: t1 + 1000, planId: PLAN_ID, prescriptionExerciseId: PID },
    log_1_0_2_s2: { done: true, carga: 30, reps: 8, unit: 'KG', rir: 3, rir_real: 2, ics: 10, ts: t1 + 2000, planId: PLAN_ID, prescriptionExerciseId: PID },
    done_1_0: { ts: t1 + 3000, planId: PLAN_ID },
    log_2_0_2_s0: { done: true, carga: 30, reps: 8, unit: 'KG', rir: 3, rir_real: 1, ics: 10, ts: t2, planId: PLAN_ID, prescriptionExerciseId: PID },
    log_2_0_2_s1: { done: true, carga: 30, reps: 8, unit: 'KG', rir: 3, rir_real: 1, ics: 10, ts: t2 + 1000, planId: PLAN_ID, prescriptionExerciseId: PID },
    log_2_0_2_s2: { done: true, carga: 30, reps: 8, unit: 'KG', rir: 3, rir_real: 1, ics: 10, ts: t2 + 2000, planId: PLAN_ID, prescriptionExerciseId: PID },
    done_2_0: { ts: t2 + 3000, planId: PLAN_ID },
    progrec_2_0: {
      calculatedAt: calcAt,
      recommendations: [{ prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado', action: 'increase_reps', newReps: 9 }],
    },
  };
  await athleteWriteLog(UID, `logs/${UID}/mesos/${PLAN_ID}`, { planId: PLAN_ID, currentWeek: 2, entries, updatedAt: t2 + 5000 });
  await athleteWriteLog(UID, `logs/${UID}`, { planId: PLAN_ID, currentWeek: 2, entries, updatedAt: t2 + 5000 });
  await athleteWriteStart(UID, PLAN_ID, 1, 0, 2, 'log_1_0_2_s0');
  await athleteWriteStart(UID, PLAN_ID, 2, 0, 2, 'log_2_0_2_s0');

  // 4) Real NUMERIC_APPLY via autonomous-progression-trigger
  const savedEnv = {
    AUTONOMOUS_PROGRESSION_ENABLED: process.env.AUTONOMOUS_PROGRESSION_ENABLED,
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED,
    VDSEN_NUMERIC_PILOT_ENABLED: process.env.VDSEN_NUMERIC_PILOT_ENABLED,
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA,
    VDSEN_NUMERIC_PILOT_WINDOW: process.env.VDSEN_NUMERIC_PILOT_WINDOW,
  };
  try {
    process.env.AUTONOMOUS_PROGRESSION_ENABLED = 'true';
    process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED = 'true';
    process.env.VDSEN_NUMERIC_PILOT_ENABLED = 'true';
    process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA = SHA;
    process.env.VDSEN_NUMERIC_PILOT_WINDOW = JSON.stringify(win);

    const handler = trigger.makeHandler({
      db: adminDb,
      verifyIdToken: async () => ({ uid: UID }),
      enabled: true,
      numericApplyEnabled: true,
      canaryClientIds: [UID],
      log: () => {},
    });

    const trig = await invokeTrigger(handler, { planId: PLAN_ID, week: 2, dayIndex: 0 });
    assert.equal(trig.statusCode, 200);
    assert.equal((trig.payload.created || []).length, 1);
    assert.equal((trig.payload.applied || []).length, 1);

    const mesoAfter = (await adminDb.doc(`logs/${UID}/mesos/${PLAN_ID}`).get()).data();
    const apps = Object.values(mesoAfter.progressionApplications || {});
    const overlays = Object.values(mesoAfter.nextExposureOverlays || {});
    assert.equal(apps.length, 1);
    assert.equal(apps[0].state, 'APPLIED');
    assert.equal(overlays.length, 1);

    // Effective prescription resolution for Coach & Client (Week 3 Day 0)
    const eff = effective.resolveEffective({
      plan, exercise: plan.days[0].exercises[0], week: 3, dayIndex: 0,
      overlays: mesoAfter.nextExposureOverlays || {}, entries: mesoAfter.entries || {}, interventions: [],
    });
    assert.ok(eff, 'effective prescription resolved');

    // 5) Idempotency: repeat trigger creates 0 and applies 0
    const trigRepeat = await invokeTrigger(handler, { planId: PLAN_ID, week: 2, dayIndex: 0 });
    assert.equal(trigRepeat.statusCode, 200);
    assert.equal((trigRepeat.payload.created || []).length, 0);
    assert.equal((trigRepeat.payload.applied || []).length, 0);

    // 6) STOP emergency disarm -> all 3 fences false + ledger STOPPED
    const stopRep = await ops.executeStopRest(PROJECT_ID, 'owner', { coachId: COACH_ID, operationId: OP_ID, reason: 'T864B_E2E_STOP' });
    assert.equal(stopRep.allDisarmed, true);
    const ledgerAfterStop = (await adminDb.doc(`releaseControl/numericPilot/operations/${OP_ID}`).get()).data();
    assert.equal(ledgerAfterStop.status, 'STOPPED');
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
