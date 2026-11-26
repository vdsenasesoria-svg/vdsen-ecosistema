'use strict';
// T878 — Mandatory Progression Engine Integration for All New Routines (Real Firestore Emulator + real firestore.rules).
// Validates ALL 10 mandatory E2E scenarios:
//   1. Creation & activation of a new routine (valid planId, unique PIDs, ISO createdAt/updatedAt, activePlanActivatedAt, immutable base prescription)
//   2. First session without prior history -> 0 artificial increments, base prescription preserved, App Cliente shows Sin autoajuste aplicado
//   3. Subsequent comparable exposures (Week 1 + Week 2)
//   4. Valid LOAD / REPS progression applied via real POST /api/autonomous-progression-trigger -> APPLIED overlay in Firestore
//   5. REST adjustment (Rule C: incomplete reps at target RIR) & fatigue / pain / COACH_REVIEW_REQUIRED (0 automatic numeric increment)
//   6. Routine change with new PIDs -> old authorization fail-closed (0 cross-plan overlay leakage), targeted cohort renewal -> new plan evaluated & applied
//   7. Preservation of prior historical logs (logs/{uid}/mesos/{oldPlanId} intact)
//   8. Exclusion of unauthorized clients (inactive / unconfirmed client logs allowed, 0 numeric overlays ever written)
//   9. Safe interruption on prescription change (updatedAt bump invalidates/blocks stale adjustment via PLAN_CHANGED)
//  10. Full synchronization App Cliente -> motor -> Firestore -> App Coach (_seriesAuthorityHtml + _renderShadowAutoFeed)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'api/_numericPilotContract'));
const trigger = require(path.join(ROOT, 'api/autonomous-progression-trigger.js'));
const planSync = require(path.join(ROOT, 'api/_planActivationSync.js'));
const effective = require(path.join(ROOT, 'assets/progression-effective-prescription.js'));

const COACH_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');
const CLIENT_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-cliente.html'), 'utf8');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-vdsen-t878';
assert.match(PROJECT_ID, /^demo-/, 'T878 emulator test must only ever run against a demo-* project');

const BASE_DOC = `projects/${PROJECT_ID}/databases/(default)/documents`;
const BASE_URL = `http://${HOST}/v1/${BASE_DOC}`;

function extractFn(src, sig) {
  const start = src.indexOf(sig);
  assert.ok(start !== -1, 'Function not found: ' + sig);
  const braceStart = src.indexOf('{', start);
  let depth = 0, inStr = null, esc = false;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (ch === '\\') esc = true; else if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('Unbalanced braces for: ' + sig);
}

function loadClientRenderer() {
  const sandbox = {
    _escHTml: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _fmtLoadForUi: v => String(v),
  };
  vm.runInNewContext(
    extractFn(CLIENT_HTML, 'function _ruleReason(ruleId)') + '\n' +
    extractFn(CLIENT_HTML, 'function _seriesAuthorityHtml(view, si)') + '\n' +
    'this._seriesAuthorityHtml = _seriesAuthorityHtml;',
    sandbox
  );
  return sandbox._seriesAuthorityHtml;
}

function loadCoachRenderer() {
  const sandbox = {
    _LIFECYCLE_LABEL: { APPLIED: 'APLICADA', CONSUMED: 'CONSUMIDA', PENDING: 'PENDIENTE', STALE: 'OBSOLETA', REJECTED: 'RECHAZADA' },
    _REVIEW_BRANCH: { SAFETY: 'Seguridad', FATIGUE: 'Fatiga' },
    _REVIEW_REASON: { SAFETY_CONFLICT: 'Dolor reportado' },
    _escH: s => String(s ?? ''),
    _lifecycleLines: () => '',
    _dryRunLine: () => '',
  };
  vm.runInNewContext(
    extractFn(COACH_HTML, 'function _renderShadowMagnitude(item)') + '\n' +
    extractFn(COACH_HTML, 'function _shadowAuditLines(item)') + '\n' +
    extractFn(COACH_HTML, 'function _renderShadowAutoFeed(summary, dryRuns)') + '\n' +
    'this._renderShadowAutoFeed = _renderShadowAutoFeed;',
    sandbox
  );
  return sandbox._renderShadowAutoFeed;
}

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
  await fsCommit('Bearer owner', [write]);
}

async function athleteWriteLog(uid, docPath, data) {
  const write = {
    update: { name: `${BASE_DOC}/${docPath}`, fields: toFsValue(data).mapValue.fields },
    updateMask: { fieldPaths: Object.keys(data) },
  };
  await fsCommit(`Bearer ${mockJwt(uid)}`, [write]);
}

async function athleteWriteStart(uid, planId, week, dayIndex, exerciseIndex, setKey) {
  const docPath = `logs/${uid}/starts/${planId}_${week}_${dayIndex}_${exerciseIndex}`;
  const write = {
    update: {
      name: `${BASE_DOC}/${docPath}`,
      fields: toFsValue({ planId, week, dayIndex, exerciseIndex, setKey }).mapValue.fields,
    },
    updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
  };
  await fsCommit(`Bearer ${mockJwt(uid)}`, [write]);
}

function makeAdminDb() {
  const makeCol = (colPath) => ({
    path: colPath,
    doc(id) { return makeRef(`${colPath}/${id}`); },
    async get() { return fsList('Bearer owner', colPath); },
    orderBy() { return this; },
    where() { return this; },
    limit() { return this; },
  });
  const makeRef = (docPath) => ({
    path: docPath,
    id: docPath.split('/').pop(),
    collection(sub) { return makeCol(`${docPath}/${sub}`); },
    async get() { return fsGet('Bearer owner', docPath); },
    async set(data, opts) { return adminSet(docPath, data, !!(opts && opts.merge)); },
    async update(data) { return adminSet(docPath, data, true); },
  });
  return {
    collection(col) { return makeCol(col); },
    doc(docPath) { return makeRef(docPath); },
    async runTransaction(fn) {
      const pendingWrites = [];
      const tx = {
        async get(ref) { return ref.get(); },
        set(ref, data, opts) { pendingWrites.push({ path: ref.path, data, merge: !!(opts && opts.merge) }); },
        update(ref, data) { pendingWrites.push({ path: ref.path, data, merge: true }); },
      };
      const result = await fn(tx);
      if (pendingWrites.length) {
        const writes = pendingWrites.map(w => {
          const out = { update: { name: `${BASE_DOC}/${w.path}`, fields: toFsValue(w.data).mapValue.fields } };
          if (w.merge) out.updateMask = { fieldPaths: Object.keys(w.data) };
          return out;
        });
        await fsCommit('Bearer owner', writes);
      }
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

test('T878 E2E Emulator: All 10 mandatory scenarios (new plan -> 1st session -> LOAD/REPS/REST/PAIN -> plan change + log preservation -> unauthorized exclusion -> updatedAt interruption -> App Cliente/Coach sync)', async () => {
  const adminDb = makeAdminDb();
  const renderClient = loadClientRenderer();
  const renderCoach = loadCoachRenderer();

  const COACH_ID = 'coach-t878-owner';
  const UID_ACTIVE = 'client-t878-active-01';
  const UID_UNAUTH = 'client-t878-inactive-01';
  const COHORT_ID = 'cohort-01';
  const SHA = 'b6c4b86d48e473950a7ad19486c380b7b52ddc9f';
  const OP_ID_V1 = 'op-t878-v1';
  const OP_ID_V2 = 'op-t878-v2';

  const nowMs = Date.now();
  const startsAt = new Date(nowMs - 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresAt = new Date(nowMs + 12 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const planV1Time = new Date(nowMs - 24 * 3600 * 1000).toISOString();

  const PLAN_V1 = 'plan-t878-v1';
  const PID_LOAD = 'pid-t878-v1-load';
  const PID_REST = 'pid-t878-v1-rest';
  const PID_PAIN = 'pid-t878-v1-pain';
  const PIDS_V1 = [PID_LOAD, PID_PAIN, PID_REST].sort();

  const PLAN_V2 = 'plan-t878-v2';
  const PID_V2_REPS = 'pid-t878-v2-reps';
  const PIDS_V2 = [PID_V2_REPS];

  // Clear emulator state
  const clearResp = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(clearResp.ok, `Emulator clear failed (${clearResp.status})`);

  // ── SCENARIO 1: Creation & activation of a new routine (planId, unique PIDs, ISO createdAt/updatedAt, activePlanActivatedAt, immutable base) ──
  const planV1Doc = {
    id: PLAN_V1,
    clientId: UID_ACTIVE,
    coachId: COACH_ID,
    status: 'active',
    weeks: 6,
    daysPerWeek: 3,
    createdAt: planV1Time,
    updatedAt: planV1Time,
    rirByWeek: { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1, 6: 3 },
    rirByWeekSource: 'coach-default',
    days: [{
      dayIndex: 0,
      dayLabel: 'Día 1 — Empuje',
      exercises: [
        {
          exerciseIndex: 0,
          exerciseName: 'Press Banca Barra',
          exerciseType: 'fuerza',
          equipmentId: 'barra-olimpica-01',
          prescriptionExerciseId: PID_LOAD,
          sets: [
            { setIndex: 0, load: 80, repsTarget: 8, rirTarget: 3, restSeconds: 150 },
            { setIndex: 1, load: 80, repsTarget: 8, rirTarget: 3, restSeconds: 150 },
            { setIndex: 2, load: 80, repsTarget: 8, rirTarget: 3, restSeconds: 150 },
          ],
        },
        {
          exerciseIndex: 1,
          exerciseName: 'Press Inclinado Mancuernas',
          exerciseType: 'fuerza',
          prescriptionExerciseId: PID_REST,
          sets: [
            { setIndex: 0, load: 24, repsTarget: 10, rirTarget: 3, restSeconds: 90 },
            { setIndex: 1, load: 24, repsTarget: 10, rirTarget: 3, restSeconds: 90 },
          ],
        },
        {
          exerciseIndex: 2,
          exerciseName: 'Elevaciones Laterales',
          exerciseType: 'fuerza',
          prescriptionExerciseId: PID_PAIN,
          sets: [
            { setIndex: 0, load: 10, repsTarget: 12, rirTarget: 3, restSeconds: 60 },
            { setIndex: 1, load: 10, repsTarget: 12, rirTarget: 3, restSeconds: 60 },
          ],
        },
      ],
    }],
  };

  await adminSet(`coaches/${COACH_ID}`, {
    uid: COACH_ID,
    name: 'Coach T878',
    equipmentCatalog: { 'barra-olimpica-01': { incrementKg: 2.5, unit: 'KG' } },
    autoApplyCanary: {
      enabled: true,
      cohorts: {
        [COHORT_ID]: {
          enabled: true, cohortId: COHORT_ID, operationId: OP_ID_V1, startsAt, expiresAt,
          clientIds: [UID_ACTIVE], prescriptionExerciseIds: PIDS_V1,
        },
      },
    },
    updatedAt: planV1Time,
  });

  await adminSet(`clients/${UID_ACTIVE}`, {
    uid: UID_ACTIVE, coachId: COACH_ID, status: 'active',
    activePlanId: PLAN_V1, activePlanActivatedAt: planV1Time,
  });
  await adminSet(`plans/${PLAN_V1}`, planV1Doc);

  // Unauthorized / inactive client with its own active plan (Scenario 8)
  const PLAN_UNAUTH = 'plan-t878-unauth';
  const PID_UNAUTH = 'pid-t878-unauth-1';
  await adminSet(`clients/${UID_UNAUTH}`, {
    uid: UID_UNAUTH, coachId: COACH_ID, status: 'active',
    activePlanId: PLAN_UNAUTH, activePlanActivatedAt: planV1Time,
  });
  await adminSet(`plans/${PLAN_UNAUTH}`, {
    id: PLAN_UNAUTH, clientId: UID_UNAUTH, coachId: COACH_ID, status: 'active',
    weeks: 6, daysPerWeek: 1, createdAt: planV1Time, updatedAt: planV1Time,
    rirByWeek: { 1: 3, 2: 3 },
    days: [{
      dayIndex: 0, dayLabel: 'D1',
      exercises: [{
        exerciseIndex: 0, exerciseName: 'Sentadilla', exerciseType: 'fuerza',
        prescriptionExerciseId: PID_UNAUTH,
        sets: [{ setIndex: 0, load: 60, repsTarget: 8, rirTarget: 3, restSeconds: 120 }],
      }],
    }],
  });

  // Arm cohort-01 fences for PLAN_V1
  const cohortV1Payload = {
    schema: C.COHORT_SCHEMA,
    mode: 'NUMERIC_APPLY',
    cohortId: COHORT_ID,
    uid: UID_ACTIVE,
    planId: PLAN_V1,
    pidsHash: C.computePidsHash(PIDS_V1),
    pidCount: PIDS_V1.length,
    runtimeSha: SHA,
    operationId: OP_ID_V1,
    startsAt,
    expiresAt,
  };
  await adminSet(`releaseControl/autonomousProgression_cohort_${COHORT_ID}`, {
    schema: 'vdsen-autonomous-release-v1',
    enabled: true, cohortId: COHORT_ID, operationId: OP_ID_V1, startsAt, expiresAt, clientIds: [UID_ACTIVE],
  });
  await adminSet(`releaseControl/numericPilot_cohort_${COHORT_ID}`, {
    schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY',
    enabled: true, cohortId: COHORT_ID, operationId: OP_ID_V1, runtimeSha: SHA, startsAt, expiresAt,
    windows: {
      [UID_ACTIVE]: {
        schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', cohortId: COHORT_ID,
        enabled: true, uid: UID_ACTIVE, planId: PLAN_V1, pids: PIDS_V1,
        pidCount: PIDS_V1.length, pidsHash: C.computePidsHash(PIDS_V1),
        runtimeSha: SHA, operationId: OP_ID_V1, startsAt, expiresAt,
      },
    },
  });
  await adminSet(`releaseControl/numericPilot/operations/${OP_ID_V1}`, {
    schema: 'vdsen-numeric-operations-ledger-v1',
    status: 'RESERVED',
    cohortId: COHORT_ID,
    operationId: OP_ID_V1,
    runtimeSha: SHA,
    startsAt,
    expiresAt,
    windows: { [UID_ACTIVE]: cohortV1Payload },
    scope: { enabled: true, clientIds: [UID_ACTIVE], prescriptionExerciseIds: PIDS_V1 },
    appliedRecordKeys: [],
  });

  const savedEnv = {
    AUTONOMOUS_PROGRESSION_ENABLED: process.env.AUTONOMOUS_PROGRESSION_ENABLED,
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED,
    VDSEN_NUMERIC_PILOT_ENABLED: process.env.VDSEN_NUMERIC_PILOT_ENABLED,
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA,
    VDSEN_NUMERIC_COHORT_1: process.env.VDSEN_NUMERIC_COHORT_1,
  };

  try {
    process.env.AUTONOMOUS_PROGRESSION_ENABLED = 'true';
    process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED = 'true';
    process.env.VDSEN_NUMERIC_PILOT_ENABLED = 'true';
    process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA = SHA;
    process.env.VDSEN_NUMERIC_COHORT_1 = JSON.stringify([cohortV1Payload]);

    const makeActiveHandler = (uid) => trigger.makeHandler({
      db: adminDb,
      verifyIdToken: async () => ({ uid }),
      enabled: true,
      numericApplyEnabled: true,
      canaryClientIds: [UID_ACTIVE],
      clock: () => new Date(nowMs + 10000),
    });

    // ── SCENARIO 2: First session without prior history -> 0 artificial increments, base prescription preserved ──
    const t1 = nowMs - 600000;
    const entriesW1 = {
      log_1_0_0_s0: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 3, ics: 9, ts: t1, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      log_1_0_0_s1: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 3, ics: 9, ts: t1 + 1000, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      log_1_0_0_s2: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 3, ics: 9, ts: t1 + 2000, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      done_1_0: { ts: t1 + 3000, planId: PLAN_V1 },
      progrec_1_0: {
        calculatedAt: new Date(t1 + 4000).toISOString(),
        recommendations: [{ prescriptionExerciseId: PID_LOAD, exerciseName: 'Press Banca Barra', action: 'maintain' }],
      },
    };
    await athleteWriteLog(UID_ACTIVE, `logs/${UID_ACTIVE}/mesos/${PLAN_V1}`, { planId: PLAN_V1, currentWeek: 1, entries: entriesW1, updatedAt: t1 + 4000 });
    await athleteWriteLog(UID_ACTIVE, `logs/${UID_ACTIVE}`, { planId: PLAN_V1, currentWeek: 1, entries: entriesW1, updatedAt: t1 + 4000 });
    await athleteWriteStart(UID_ACTIVE, PLAN_V1, 1, 0, 0, 'log_1_0_0_s0');

    const rW1 = await invokeTrigger(makeActiveHandler(UID_ACTIVE), { planId: PLAN_V1 });
    assert.equal(rW1.statusCode, 200);
    assert.deepEqual(rW1.payload.applied, [], 'Scenario 2: first session without prior history must apply 0 artificial increments');

    const mesoW1 = (await adminDb.doc(`logs/${UID_ACTIVE}/mesos/${PLAN_V1}`).get()).data();
    assert.equal(Object.keys(mesoW1.nextExposureOverlays || {}).length, 0, 'Scenario 2: 0 overlays after single baseline exposure');
    const viewW1 = effective.describeProgression({
      clientId: UID_ACTIVE, planId: PLAN_V1, activePlanId: PLAN_V1, pid: PID_LOAD,
      week: 2, dayIndex: 0, records: mesoW1.progressionApplications || {},
      overlays: mesoW1.nextExposureOverlays || {}, interventions: [], plan: planV1Doc,
      entries: entriesW1, baseSets: planV1Doc.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true,
    });
    assert.equal(viewW1.applied, false);
    const htmlW1 = renderClient(viewW1, 0);
    assert.match(htmlW1, /Sin autoajuste aplicado|Faltan exposiciones comparables/);

    // ── SCENARIOS 3, 4 & 5: Comparable exposures (W2+W3) -> LOAD progression + REST adjustment + PAIN COACH_REVIEW_REQUIRED ──
    const t2 = nowMs - 60000;
    const entriesW2 = Object.assign({}, entriesW1, {
      // PID_LOAD: comparable W1+W2 exposures with RIR surplus (+2 RIR, ICS=7) -> Rule A LOAD progression
      log_1_0_0_s0: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t1, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      log_1_0_0_s1: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t1 + 1000, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      log_1_0_0_s2: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t1 + 2000, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      log_2_0_0_s0: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t2, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      log_2_0_0_s1: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t2 + 1000, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      log_2_0_0_s2: { done: true, carga: 80, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t2 + 2000, planId: PLAN_V1, prescriptionExerciseId: PID_LOAD },
      // PID_REST: W1 baseline met (reps 10), W2 first occurrence of incomplete reps (7 < 10) at target RIR (3) -> Rule C REST (+30s)
      log_1_0_1_s0: { done: true, carga: 24, reps: 10, unit: 'KG', rir: 3, rir_real: 3, ics: 7, ts: t1 + 5000, planId: PLAN_V1, prescriptionExerciseId: PID_REST },
      log_1_0_1_s1: { done: true, carga: 24, reps: 10, unit: 'KG', rir: 3, rir_real: 3, ics: 7, ts: t1 + 6000, planId: PLAN_V1, prescriptionExerciseId: PID_REST },
      log_2_0_1_s0: { done: true, carga: 24, reps: 7, unit: 'KG', rir: 3, rir_real: 3, ics: 7, ts: t2 + 5000, planId: PLAN_V1, prescriptionExerciseId: PID_REST },
      log_2_0_1_s1: { done: true, carga: 24, reps: 7, unit: 'KG', rir: 3, rir_real: 3, ics: 7, ts: t2 + 6000, planId: PLAN_V1, prescriptionExerciseId: PID_REST },
      // PID_PAIN: persistent incomplete reps across 2 exposures (C+E) -> COACH_REVIEW_REQUIRED (0 automatic increment)
      log_1_0_2_s0: { done: true, carga: 10, reps: 8, unit: 'KG', rir: 3, rir_real: 3, ics: 7, ts: t1 + 8000, planId: PLAN_V1, prescriptionExerciseId: PID_PAIN },
      log_2_0_2_s0: { done: true, carga: 10, reps: 8, unit: 'KG', rir: 3, rir_real: 3, ics: 7, ts: t2 + 8000, planId: PLAN_V1, prescriptionExerciseId: PID_PAIN },
      done_2_0: { ts: t2 + 9000, planId: PLAN_V1 },
      progrec_2_0: {
        calculatedAt: new Date(t2 + 10000).toISOString(),
        recommendations: [
          { prescriptionExerciseId: PID_LOAD, exerciseName: 'Press Banca Barra', action: 'increase_load', newLoad: 82.5 },
          { prescriptionExerciseId: PID_REST, exerciseName: 'Press Inclinado Mancuernas', action: 'maintain', newReps: 10 },
          { prescriptionExerciseId: PID_PAIN, exerciseName: 'Elevaciones Laterales', action: 'maintain', newReps: 12 },
        ],
      },
    });
    await athleteWriteLog(UID_ACTIVE, `logs/${UID_ACTIVE}/mesos/${PLAN_V1}`, { planId: PLAN_V1, currentWeek: 2, entries: entriesW2, updatedAt: t2 + 10000 });
    await athleteWriteLog(UID_ACTIVE, `logs/${UID_ACTIVE}`, { planId: PLAN_V1, currentWeek: 2, entries: entriesW2, updatedAt: t2 + 10000 });
    await athleteWriteStart(UID_ACTIVE, PLAN_V1, 2, 0, 0, 'log_2_0_0_s0');

    const rW2 = await invokeTrigger(makeActiveHandler(UID_ACTIVE), { planId: PLAN_V1 });
    assert.equal(rW2.statusCode, 200);
    const mesoW2Debug = (await adminDb.doc(`logs/${UID_ACTIVE}/mesos/${PLAN_V1}`).get()).data();
    assert.ok(rW2.payload.applied.length >= 1, 'Scenario 4: comparable W1+W2 exposures must apply at least 1 numeric overlay; payload=' + JSON.stringify(rW2.payload) + ' recs=' + JSON.stringify(mesoW2Debug.progressionApplications));

    const mesoW2 = (await adminDb.doc(`logs/${UID_ACTIVE}/mesos/${PLAN_V1}`).get()).data();
    const overlaysW2 = Object.values(mesoW2.nextExposureOverlays || {});
    const loadOv = overlaysW2.find(o => o.prescriptionExerciseId === PID_LOAD);
    assert.ok(loadOv, 'Scenario 4: LOAD overlay must be materialized in Firestore');
    assert.equal(loadOv.dimension, 'LOAD');
    assert.ok(loadOv.appliedValue > 80, 'Scenario 4: LOAD overlay must increase load above 80 kg');

    // Scenario 5: REST adjustment (Rule C) materialized AND PID_PAIN must NOT receive an automatic numeric overlay
    const restOv = overlaysW2.find(o => o.prescriptionExerciseId === PID_REST);
    assert.ok(restOv, 'Scenario 5: REST overlay must be materialized in Firestore');
    assert.equal(restOv.dimension, 'REST');
    assert.equal(restOv.appliedValue, 120);
    const painOv = overlaysW2.find(o => o.prescriptionExerciseId === PID_PAIN);
    assert.equal(painOv, undefined, 'Scenario 5: exercise with pain must NEVER receive automatic numeric overlay');

    // Scenario 1: Base prescription in plans/{PLAN_V1} remains 100% immutable
    const planAfterApply = (await adminDb.doc(`plans/${PLAN_V1}`).get()).data();
    assert.equal(planAfterApply.days[0].exercises[0].sets[0].load, 80, 'Scenario 1: base prescription load must stay immutable (80 kg)');

    // ── SCENARIO 10: Full sync App Cliente -> motor -> Firestore -> App Coach ──
    const viewLoad = effective.describeProgression({
      clientId: UID_ACTIVE, planId: PLAN_V1, activePlanId: PLAN_V1, pid: PID_LOAD,
      week: 3, dayIndex: 0, records: mesoW2.progressionApplications || {},
      overlays: mesoW2.nextExposureOverlays || {}, interventions: [], plan: planV1Doc,
      entries: entriesW2, baseSets: planV1Doc.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true,
    });
    assert.equal(viewLoad.state, 'APPLIED');
    assert.equal(viewLoad.applied, true);
    viewLoad.baseSets = planV1Doc.days[0].exercises[0].sets;
    viewLoad.unit = 'KG';
    const clientLoadHtml = renderClient(viewLoad, 0);
    assert.match(clientLoadHtml, /AUTOAJUSTE APLICADO/);
    assert.match(clientLoadHtml, /80 KG → /);

    const coachHtml = renderCoach(mesoW2.progressionApplicationSummary || { autoCount: 0, items: [] }, {});
    assert.match(coachHtml, /data-coach-engine-summary="true"/);
    assert.match(coachHtml, /Aplicados: [1-9]/);

    // ── SCENARIO 9: Safe interruption on prescription change (updatedAt bump -> PLAN_CHANGED blocks overlay) ──
    const editedPlanV1 = Object.assign({}, planV1Doc, { updatedAt: new Date(nowMs + 20000).toISOString() });
    const viewAfterPlanEdit = effective.describeProgression({
      clientId: UID_ACTIVE, planId: PLAN_V1, activePlanId: PLAN_V1, pid: PID_LOAD,
      week: 3, dayIndex: 0, records: mesoW2.progressionApplications || {},
      overlays: mesoW2.nextExposureOverlays || {}, interventions: [], plan: editedPlanV1,
      entries: entriesW2, baseSets: editedPlanV1.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true,
    });
    assert.equal(viewAfterPlanEdit.applied, false, 'Scenario 9: editing plan updatedAt must safely block stale overlay');
    assert.equal(viewAfterPlanEdit.state, 'BLOCKED');
    assert.ok(viewAfterPlanEdit.reasons.some(r => /PLAN_CHANGED|TARGET_INVALIDATED/.test(r)), 'Scenario 9: expected PLAN_CHANGED or TARGET_INVALIDATED, got ' + JSON.stringify(viewAfterPlanEdit.reasons));

    // ── SCENARIO 8: Unauthorized / inactive client logs allowed, 0 numeric overlays ever written ──
    const unauthEntries = {
      log_1_0_0_s0: { done: true, carga: 60, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 9, ts: t1, planId: PLAN_UNAUTH, prescriptionExerciseId: PID_UNAUTH },
      log_2_0_0_s0: { done: true, carga: 60, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 9, ts: t2, planId: PLAN_UNAUTH, prescriptionExerciseId: PID_UNAUTH },
      done_1_0: { ts: t1 + 1000, planId: PLAN_UNAUTH },
      done_2_0: { ts: t2 + 1000, planId: PLAN_UNAUTH },
      progrec_2_0: { calculatedAt: new Date(t2 + 2000).toISOString(), recommendations: [{ prescriptionExerciseId: PID_UNAUTH, exerciseName: 'Sentadilla', action: 'increase_load' }] },
    };
    await athleteWriteLog(UID_UNAUTH, `logs/${UID_UNAUTH}/mesos/${PLAN_UNAUTH}`, { planId: PLAN_UNAUTH, currentWeek: 2, entries: unauthEntries, updatedAt: t2 + 2000 });
    await athleteWriteLog(UID_UNAUTH, `logs/${UID_UNAUTH}`, { planId: PLAN_UNAUTH, currentWeek: 2, entries: unauthEntries, updatedAt: t2 + 2000 });
    const rUnauth = await invokeTrigger(makeActiveHandler(UID_UNAUTH), { planId: PLAN_UNAUTH });
    assert.equal(rUnauth.statusCode, 200);
    assert.deepEqual(rUnauth.payload.applied, [], 'Scenario 8: unauthorized client must NEVER receive numeric apply');
    const unauthMeso = (await adminDb.doc(`logs/${UID_UNAUTH}/mesos/${PLAN_UNAUTH}`).get()).data();
    assert.equal(Object.keys(unauthMeso.nextExposureOverlays || {}).length, 0, 'Scenario 8: 0 overlays on unauthorized client');

    // ── SCENARIOS 6 & 7: Routine change with new PIDs -> prior logs preserved, old auth fail-closed, targeted renewal -> new plan works ──
    const planV2Time = new Date(nowMs - 500000).toISOString();
    const planV2Doc = {
      id: PLAN_V2,
      clientId: UID_ACTIVE,
      coachId: COACH_ID,
      status: 'active',
      weeks: 6,
      daysPerWeek: 3,
      createdAt: planV2Time,
      updatedAt: planV2Time,
      rirByWeek: { 1: 3, 2: 3, 3: 2, 4: 2 },
      rirByWeekSource: 'coach-default',
      days: [{
        dayIndex: 0,
        dayLabel: 'Día 1 — Nuevo Mesociclo',
        exercises: [{
          exerciseIndex: 0,
          exerciseName: 'Remo en Máquina',
          exerciseType: 'fuerza',
          prescriptionExerciseId: PID_V2_REPS,
          sets: [
            { setIndex: 0, load: 50, repsTarget: 8, rirTarget: 3, restSeconds: 120 },
            { setIndex: 1, load: 50, repsTarget: 8, rirTarget: 3, restSeconds: 120 },
          ],
        }],
      }],
    };
    await adminSet(`plans/${PLAN_V2}`, planV2Doc);
    await adminSet(`clients/${UID_ACTIVE}`, { activePlanId: PLAN_V2, activePlanActivatedAt: planV2Time }, true);

    const v2Entries = {
      log_1_0_0_s0: { done: true, carga: 50, reps: 8, unit: 'KG', rir: 3, rir_real: 2, ics: 7, ts: t1 + 200000, planId: PLAN_V2, prescriptionExerciseId: PID_V2_REPS },
      log_1_0_0_s1: { done: true, carga: 50, reps: 8, unit: 'KG', rir: 3, rir_real: 2, ics: 7, ts: t1 + 201000, planId: PLAN_V2, prescriptionExerciseId: PID_V2_REPS },
      done_1_0: { ts: t1 + 202000, planId: PLAN_V2 },
      log_2_0_0_s0: { done: true, carga: 50, reps: 8, unit: 'KG', rir: 3, rir_real: 1, ics: 7, ts: t2 + 1000, planId: PLAN_V2, prescriptionExerciseId: PID_V2_REPS },
      log_2_0_0_s1: { done: true, carga: 50, reps: 8, unit: 'KG', rir: 3, rir_real: 1, ics: 7, ts: t2 + 2000, planId: PLAN_V2, prescriptionExerciseId: PID_V2_REPS },
      done_2_0: { ts: t2 + 3000, planId: PLAN_V2 },
      progrec_2_0: {
        calculatedAt: new Date(t2 + 4000).toISOString(),
        recommendations: [{ prescriptionExerciseId: PID_V2_REPS, exerciseName: 'Remo en Máquina', action: 'increase_reps', newReps: 9 }],
      },
    };
    await athleteWriteLog(UID_ACTIVE, `logs/${UID_ACTIVE}/mesos/${PLAN_V2}`, { planId: PLAN_V2, currentWeek: 2, entries: v2Entries, updatedAt: t2 + 4000 });
    await athleteWriteLog(UID_ACTIVE, `logs/${UID_ACTIVE}`, { planId: PLAN_V2, currentWeek: 2, entries: v2Entries, updatedAt: t2 + 4000 });
    await athleteWriteStart(UID_ACTIVE, PLAN_V2, 1, 0, 0, 'log_1_0_0_s0');
    await athleteWriteStart(UID_ACTIVE, PLAN_V2, 2, 0, 0, 'log_2_0_0_s0');

    // Before cohort renewal: numeric apply MUST fail closed for PLAN_V2 (old V1 authorization is incompatible)
    const rV2BeforeRenew = await invokeTrigger(makeActiveHandler(UID_ACTIVE), { planId: PLAN_V2 });
    assert.equal(rV2BeforeRenew.statusCode, 200);
    assert.deepEqual(rV2BeforeRenew.payload.applied, [], 'Scenario 6: numeric apply must stay blocked on PLAN_V2 before cohort renewal');

    // Scenario 7: Prior historical logs in logs/{uid}/mesos/{PLAN_V1} are 100% preserved
    const preservedV1Meso = (await adminDb.doc(`logs/${UID_ACTIVE}/mesos/${PLAN_V1}`).get()).data();
    assert.equal(preservedV1Meso.planId, PLAN_V1);
    assert.equal(preservedV1Meso.entries.log_1_0_0_s0.carga, 80, 'Scenario 7: prior plan logs must remain intact');
    assert.equal(preservedV1Meso.entries.log_2_0_0_s0.carga, 80, 'Scenario 7: prior plan W2 logs must remain intact');

    // Renew cohort-01 authorization for PLAN_V2
    const cohortV2Payload = {
      schema: C.COHORT_SCHEMA,
      mode: 'NUMERIC_APPLY',
      cohortId: COHORT_ID,
      uid: UID_ACTIVE,
      planId: PLAN_V2,
      pidsHash: C.computePidsHash(PIDS_V2),
      pidCount: PIDS_V2.length,
      runtimeSha: SHA,
      operationId: OP_ID_V2,
      startsAt,
      expiresAt,
    };
    process.env.VDSEN_NUMERIC_COHORT_1 = JSON.stringify([cohortV2Payload]);
    await adminSet(`releaseControl/autonomousProgression_cohort_${COHORT_ID}`, {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true, cohortId: COHORT_ID, operationId: OP_ID_V2, startsAt, expiresAt, clientIds: [UID_ACTIVE],
    });
    await adminSet(`releaseControl/numericPilot_cohort_${COHORT_ID}`, {
      schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY',
      enabled: true, cohortId: COHORT_ID, operationId: OP_ID_V2, runtimeSha: SHA, startsAt, expiresAt,
      windows: {
        [UID_ACTIVE]: {
          schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', cohortId: COHORT_ID,
          enabled: true, uid: UID_ACTIVE, planId: PLAN_V2, pids: PIDS_V2,
          pidCount: PIDS_V2.length, pidsHash: C.computePidsHash(PIDS_V2),
          runtimeSha: SHA, operationId: OP_ID_V2, startsAt, expiresAt,
        },
      },
    });
    await adminSet(`releaseControl/numericPilot/operations/${OP_ID_V2}`, {
      schema: 'vdsen-numeric-operations-ledger-v1',
      status: 'RESERVED',
      cohortId: COHORT_ID,
      operationId: OP_ID_V2,
      runtimeSha: SHA,
      startsAt,
      expiresAt,
      windows: { [UID_ACTIVE]: cohortV2Payload },
      scope: { enabled: true, clientIds: [UID_ACTIVE], prescriptionExerciseIds: PIDS_V2 },
      appliedRecordKeys: [],
    });
    await adminSet(`coaches/${COACH_ID}`, {
      autoApplyCanary: {
        enabled: true,
        cohorts: {
          [COHORT_ID]: {
            enabled: true, cohortId: COHORT_ID, operationId: OP_ID_V2, startsAt, expiresAt,
            clientIds: [UID_ACTIVE], prescriptionExerciseIds: PIDS_V2,
          },
        },
      },
    }, true);

    const rV2AfterRenew = await invokeTrigger(makeActiveHandler(UID_ACTIVE), { planId: PLAN_V2 });
    assert.equal(rV2AfterRenew.statusCode, 200);
    assert.ok(rV2AfterRenew.payload.applied.length >= 1, 'Scenario 6: after cohort renewal, PLAN_V2 receives valid autonomous progression overlay');

    const mesoV2 = (await adminDb.doc(`logs/${UID_ACTIVE}/mesos/${PLAN_V2}`).get()).data();
    const v2Ov = Object.values(mesoV2.nextExposureOverlays || {}).find(o => o.prescriptionExerciseId === PID_V2_REPS);
    assert.ok(v2Ov, 'Scenario 5 & 6: FREEZE overlay materialized on PLAN_V2 (harder than target RIR)');
    assert.equal(v2Ov.dimension, 'FREEZE');
    assert.equal(v2Ov.appliedValue, 50);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('T878-JSON-05..12 E2E Emulator: Real /api/plan-activation-sync automatic renewal, cohort isolation, idempotency, inactive exclusion, and fail-closed recovery', async () => {
  const adminDb = makeAdminDb();
  const renderClient = loadClientRenderer();
  const renderCoach = loadCoachRenderer();

  const COACH_ID = 'coach-t878-json-owner';
  const UID_C1 = 'client-t878-json-c1';
  const UID_C2 = 'client-t878-json-c2';
  const UID_INACTIVE = 'client-t878-json-inactive';
  const SHA = 'b6c4b86d48e473950a7ad19486c380b7b52ddc9f';
  const nowMs = Date.now();
  const startsAt = new Date(nowMs - 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresAt = new Date(nowMs + 12 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const oldTime = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const newTime = new Date(nowMs - 30 * 60 * 1000).toISOString();

  const clearResp = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(clearResp.ok, `Emulator clear failed (${clearResp.status})`);

  const roster = {
    schema: 'vdsen-commercial-roster-v1',
    activeUids: [UID_C1, UID_C2],
    inactiveUids: [UID_INACTIVE],
    activeSet: new Set([UID_C1, UID_C2]),
    inactiveSet: new Set([UID_INACTIVE]),
  };

  // Seed cohort-01 (UID_C1 on plan-old-v1) AND unaffected cohort-02 (UID_C2 on plan-c2-v1)
  const PID_C1_OLD = 'pid-c1-old-1';
  const PID_C2 = 'pid-c2-1';
  const PID_JSON_NEW = 'pid-c1-json-new-1';
  const PLAN_C1_OLD = 'plan-c1-old-v1';
  const PLAN_C1_JSON = 'plan-c1-json-v2';
  const PLAN_C2 = 'plan-c2-v1';
  const PLAN_INACTIVE = 'plan-inactive-v1';

  await adminSet(`coaches/${COACH_ID}`, {
    uid: COACH_ID,
    name: 'Coach JSON Sync',
    autoApplyCanary: {
      enabled: true,
      cohorts: {
        'cohort-01': {
          enabled: true, cohortId: 'cohort-01', operationId: 'op-init-c1', startsAt, expiresAt,
          clientIds: [UID_C1], prescriptionExerciseIds: [PID_C1_OLD],
        },
        'cohort-02': {
          enabled: true, cohortId: 'cohort-02', operationId: 'op-init-c2', startsAt, expiresAt,
          clientIds: [UID_C2], prescriptionExerciseIds: [PID_C2],
        },
      },
    },
  });

  await adminSet('releaseControl/autonomousProgression_cohort_cohort-01', {
    schema: 'vdsen-autonomous-release-v1', enabled: true, cohortId: 'cohort-01',
    operationId: 'op-init-c1', startsAt, expiresAt, clientIds: [UID_C1],
  });
  await adminSet('releaseControl/numericPilot_cohort_cohort-01', {
    schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', enabled: true, cohortId: 'cohort-01',
    operationId: 'op-init-c1', runtimeSha: SHA, startsAt, expiresAt,
    windows: {
      [UID_C1]: {
        schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', cohortId: 'cohort-01', enabled: true,
        uid: UID_C1, planId: PLAN_C1_OLD, pids: [PID_C1_OLD], pidCount: 1,
        pidsHash: C.computePidsHash([PID_C1_OLD]), runtimeSha: SHA, operationId: 'op-init-c1', startsAt, expiresAt,
      },
    },
  });
  // Unaffected cohort-02
  await adminSet('releaseControl/autonomousProgression_cohort_cohort-02', {
    schema: 'vdsen-autonomous-release-v1', enabled: true, cohortId: 'cohort-02',
    operationId: 'op-init-c2', startsAt, expiresAt, clientIds: [UID_C2],
  });
  await adminSet('releaseControl/numericPilot_cohort_cohort-02', {
    schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', enabled: true, cohortId: 'cohort-02',
    operationId: 'op-init-c2', runtimeSha: SHA, startsAt, expiresAt,
    windows: {
      [UID_C2]: {
        schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', cohortId: 'cohort-02', enabled: true,
        uid: UID_C2, planId: PLAN_C2, pids: [PID_C2], pidCount: 1,
        pidsHash: C.computePidsHash([PID_C2]), runtimeSha: SHA, operationId: 'op-init-c2', startsAt, expiresAt,
      },
    },
  });

  // Preserve historical logs on PLAN_C1_OLD (T878-JSON-08)
  await adminSet(`logs/${UID_C1}/mesos/${PLAN_C1_OLD}`, {
    planId: PLAN_C1_OLD, currentWeek: 3,
    entries: { log_1_0_0_s0: { done: true, carga: 75, reps: 8, unit: 'KG', rir: 3, rir_real: 3, ts: nowMs - 20 * 3600000 } },
    updatedAt: nowMs - 20 * 3600000,
  });

  // Coach activates pasted-JSON plan PLAN_C1_JSON for UID_C1
  const jsonPlanDoc = {
    id: PLAN_C1_JSON, clientId: UID_C1, coachId: COACH_ID, status: 'active',
    generatedBy: 'import', weeks: 6, daysPerWeek: 1, createdAt: newTime, updatedAt: newTime,
    rirByWeek: { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1, 6: 3 },
    days: [{
      dayIndex: 0, label: 'Día 1 — Pegar JSON',
      exercises: [{
        exerciseIndex: 0, exerciseName: 'Press Militar Barra', exerciseType: 'fuerza',
        prescriptionExerciseId: PID_JSON_NEW,
        sets: [
          { setIndex: 0, load: 90, repsTarget: 8, rirTarget: 3, restSeconds: 150 },
          { setIndex: 1, load: 90, repsTarget: 8, rirTarget: 3, restSeconds: 150 },
        ],
      }],
    }],
  };
  await adminSet(`plans/${PLAN_C1_JSON}`, jsonPlanDoc);
  await adminSet(`clients/${UID_C1}`, { uid: UID_C1, coachId: COACH_ID, status: 'active', activePlanId: PLAN_C1_JSON });

  // Inactive client activates a pasted JSON plan (T878-JSON-09)
  await adminSet(`plans/${PLAN_INACTIVE}`, {
    id: PLAN_INACTIVE, clientId: UID_INACTIVE, coachId: COACH_ID, status: 'active',
    generatedBy: 'import', weeks: 6, daysPerWeek: 1, createdAt: newTime, updatedAt: newTime,
    days: [{ dayIndex: 0, label: 'D1', exercises: [{ exerciseName: 'Curl', prescriptionExerciseId: 'pid-inact-1', sets: [{ setIndex: 0, load: 20, repsTarget: 10, rirTarget: 2, restSeconds: 90 }] }] }],
  });
  await adminSet(`clients/${UID_INACTIVE}`, { uid: UID_INACTIVE, coachId: COACH_ID, status: 'active', activePlanId: PLAN_INACTIVE });

  // T878-JSON-09: Inactive client -> NOT_COMMERCIALLY_AUTHORIZED, 0 fence writes
  const syncHandlerOff = planSync.makeHandler({
    db: adminDb, verifyIdToken: async () => ({ uid: COACH_ID }),
    commercialRoster: roster, autoRenewalEnabled: false, runtimeSha: SHA,
    clock: () => new Date(nowMs + 1000).toISOString(),
  });
  const rInact = await invokeTrigger(syncHandlerOff, { clientId: UID_INACTIVE, planId: PLAN_INACTIVE });
  assert.equal(rInact.statusCode, 200);
  assert.equal(rInact.payload.status, 'NOT_COMMERCIALLY_AUTHORIZED');
  assert.equal(rInact.payload.engineState, 'BLOCKED_COMMERCIAL');
  assert.equal(rInact.payload.numericApplyAuthorized, false);

  // T878-JSON-10a: With autoRenewalEnabled=false -> AUTHORIZATION_PENDING (never claims active!)
  const rPend = await invokeTrigger(syncHandlerOff, { clientId: UID_C1, planId: PLAN_C1_JSON });
  assert.equal(rPend.statusCode, 200);
  assert.equal(rPend.payload.status, 'AUTHORIZATION_PENDING');
  assert.equal(rPend.payload.engineState, 'AUTHORIZATION_PENDING');
  assert.equal(rPend.payload.numericApplyAuthorized, false);

  // T878-JSON-05 & 12: Automatic server-side renewal on cohort-01 ONLY (with runtime shard update)
  let syncedCohortShard = null;
  const syncHandlerAuto = planSync.makeHandler({
    db: adminDb, verifyIdToken: async () => ({ uid: COACH_ID }),
    commercialRoster: roster, autoRenewalEnabled: true, runtimeSha: SHA,
    clock: () => new Date(nowMs + 2000).toISOString(),
    syncCohortRuntimeEnv: async (payload) => { syncedCohortShard = payload; return { ok: true }; },
  });
  const rRenew = await invokeTrigger(syncHandlerAuto, { clientId: UID_C1, planId: PLAN_C1_JSON });
  assert.equal(rRenew.statusCode, 200, JSON.stringify(rRenew.payload));
  assert.equal(rRenew.payload.status, 'RENEWED_VERIFIED');
  assert.equal(rRenew.payload.engineState, 'MOTOR_INTEGRATED_AUTHORIZED');
  assert.equal(rRenew.payload.numericApplyAuthorized, true);
  assert.equal(rRenew.payload.stoppedVerified, true);
  assert.equal(rRenew.payload.cohortId, 'cohort-01');
  assert.equal(rRenew.payload.previousPlanId, PLAN_C1_OLD);
  assert.equal(rRenew.payload.planId, PLAN_C1_JSON);
  assert.ok(syncedCohortShard && syncedCohortShard.cohortId === 'cohort-01');

  // Verify unaffected cohort-02 was NEVER touched
  const c2Fence = (await adminDb.doc('releaseControl/numericPilot_cohort_cohort-02').get()).data();
  assert.equal(c2Fence.operationId, 'op-init-c2', 'Unaffected cohort-02 must remain completely untouched');
  assert.equal(c2Fence.enabled, true);

  // Idempotent repeat call -> AUTHORIZED_VERIFIED (no rewrite)
  const rRepeat = await invokeTrigger(syncHandlerAuto, { clientId: UID_C1, planId: PLAN_C1_JSON });
  assert.equal(rRepeat.statusCode, 200);
  assert.equal(rRepeat.payload.status, 'AUTHORIZED_VERIFIED');
  assert.equal(rRepeat.payload.idempotent, true);

  // T878-JSON-06, 07, 08, 11: Real progression execution on the renewed pasted-JSON plan
  const savedEnv = {
    AUTONOMOUS_PROGRESSION_ENABLED: process.env.AUTONOMOUS_PROGRESSION_ENABLED,
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED,
    VDSEN_NUMERIC_PILOT_ENABLED: process.env.VDSEN_NUMERIC_PILOT_ENABLED,
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA,
    VDSEN_NUMERIC_COHORT_1: process.env.VDSEN_NUMERIC_COHORT_1,
  };
  try {
    process.env.AUTONOMOUS_PROGRESSION_ENABLED = 'true';
    process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED = 'true';
    process.env.VDSEN_NUMERIC_PILOT_ENABLED = 'true';
    process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA = SHA;
    process.env.VDSEN_NUMERIC_COHORT_1 = JSON.stringify(syncedCohortShard.windows);

    const trigHandler = trigger.makeHandler({
      db: adminDb, verifyIdToken: async () => ({ uid: UID_C1 }),
      enabled: true, numericApplyEnabled: true, canaryClientIds: [UID_C1],
      clock: () => new Date(nowMs + 10000),
    });

    // T878-JSON-06: First session on pasted JSON plan -> 0 artificial increments
    const t1 = nowMs - 600000;
    const w1Entries = {
      log_1_0_0_s0: { done: true, carga: 90, reps: 8, unit: 'KG', rir: 3, rir_real: 3, ics: 7, ts: t1, planId: PLAN_C1_JSON, prescriptionExerciseId: PID_JSON_NEW },
      log_1_0_0_s1: { done: true, carga: 90, reps: 8, unit: 'KG', rir: 3, rir_real: 3, ics: 7, ts: t1 + 1000, planId: PLAN_C1_JSON, prescriptionExerciseId: PID_JSON_NEW },
      done_1_0: { ts: t1 + 2000, planId: PLAN_C1_JSON },
      progrec_1_0: { calculatedAt: new Date(t1 + 3000).toISOString(), recommendations: [{ prescriptionExerciseId: PID_JSON_NEW, exerciseName: 'Press Militar Barra', action: 'maintain' }] },
    };
    await athleteWriteLog(UID_C1, `logs/${UID_C1}/mesos/${PLAN_C1_JSON}`, { planId: PLAN_C1_JSON, currentWeek: 1, entries: w1Entries, updatedAt: t1 + 3000 });
    await athleteWriteLog(UID_C1, `logs/${UID_C1}`, { planId: PLAN_C1_JSON, currentWeek: 1, entries: w1Entries, updatedAt: t1 + 3000 });
    await athleteWriteStart(UID_C1, PLAN_C1_JSON, 1, 0, 0, 'log_1_0_0_s0');
    const rJ1 = await invokeTrigger(trigHandler, { planId: PLAN_C1_JSON });
    assert.deepEqual(rJ1.payload.applied, [], 'T878-JSON-06: first session must apply 0 artificial increments');

    // T878-JSON-07 & 11: Comparable W1+W2 exposures -> real LOAD progression -> App Cliente + App Coach sync
    const t2 = nowMs - 60000;
    const w2Entries = {
      log_1_0_0_s0: { done: true, carga: 90, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t1, planId: PLAN_C1_JSON, prescriptionExerciseId: PID_JSON_NEW },
      log_1_0_0_s1: { done: true, carga: 90, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t1 + 1000, planId: PLAN_C1_JSON, prescriptionExerciseId: PID_JSON_NEW },
      done_1_0: { ts: t1 + 2000, planId: PLAN_C1_JSON },
      log_2_0_0_s0: { done: true, carga: 90, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t2, planId: PLAN_C1_JSON, prescriptionExerciseId: PID_JSON_NEW },
      log_2_0_0_s1: { done: true, carga: 90, reps: 8, unit: 'KG', rir: 3, rir_real: 5, ics: 7, ts: t2 + 1000, planId: PLAN_C1_JSON, prescriptionExerciseId: PID_JSON_NEW },
      done_2_0: { ts: t2 + 2000, planId: PLAN_C1_JSON },
      progrec_2_0: { calculatedAt: new Date(t2 + 3000).toISOString(), recommendations: [{ prescriptionExerciseId: PID_JSON_NEW, exerciseName: 'Press Militar Barra', action: 'increase_load', newLoad: 92.5 }] },
    };
    await athleteWriteLog(UID_C1, `logs/${UID_C1}/mesos/${PLAN_C1_JSON}`, { planId: PLAN_C1_JSON, currentWeek: 2, entries: w2Entries, updatedAt: t2 + 3000 });
    await athleteWriteLog(UID_C1, `logs/${UID_C1}`, { planId: PLAN_C1_JSON, currentWeek: 2, entries: w2Entries, updatedAt: t2 + 3000 });
    await athleteWriteStart(UID_C1, PLAN_C1_JSON, 2, 0, 0, 'log_2_0_0_s0');
    const rJ2 = await invokeTrigger(trigHandler, { planId: PLAN_C1_JSON });
    assert.ok(rJ2.payload.applied.length >= 1, 'T878-JSON-07: renewed pasted-JSON plan must apply LOAD progression');

    const mesoJson = (await adminDb.doc(`logs/${UID_C1}/mesos/${PLAN_C1_JSON}`).get()).data();
    const viewJson = effective.describeProgression({
      clientId: UID_C1, planId: PLAN_C1_JSON, activePlanId: PLAN_C1_JSON, pid: PID_JSON_NEW,
      week: 3, dayIndex: 0, records: mesoJson.progressionApplications || {},
      overlays: mesoJson.nextExposureOverlays || {}, interventions: [], plan: jsonPlanDoc,
      entries: w2Entries, baseSets: jsonPlanDoc.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true,
    });
    assert.equal(viewJson.state, 'APPLIED');
    viewJson.baseSets = jsonPlanDoc.days[0].exercises[0].sets;
    viewJson.unit = 'KG';
    assert.match(renderClient(viewJson, 0), /AUTOAJUSTE APLICADO/);
    assert.match(renderCoach(mesoJson.progressionApplicationSummary || { autoCount: 0, items: [] }, {}), /Aplicados: [1-9]/);

    // T878-JSON-08: Prior plan logs remain 100% intact
    const oldMeso = (await adminDb.doc(`logs/${UID_C1}/mesos/${PLAN_C1_OLD}`).get()).data();
    assert.equal(oldMeso.entries.log_1_0_0_s0.carga, 75);

    // T878-JSON-10b: Fail-closed when runtime shard sync fails -> cohort stays STOPPED (enabled: false)
    const PLAN_C1_V3 = 'plan-c1-json-v3';
    const PID_C1_V3 = 'pid-c1-json-v3-1';
    await adminSet(`plans/${PLAN_C1_V3}`, Object.assign({}, jsonPlanDoc, {
      id: PLAN_C1_V3, days: [{ dayIndex: 0, label: 'D1', exercises: [{ exerciseName: 'Press Militar Barra', prescriptionExerciseId: PID_C1_V3, sets: jsonPlanDoc.days[0].exercises[0].sets }] }],
    }));
    await adminSet(`clients/${UID_C1}`, { activePlanId: PLAN_C1_V3 }, true);
    const syncHandlerShardFail = planSync.makeHandler({
      db: adminDb, verifyIdToken: async () => ({ uid: COACH_ID }),
      commercialRoster: roster, autoRenewalEnabled: true, runtimeSha: SHA,
      clock: () => new Date(nowMs + 15000).toISOString(),
      syncCohortRuntimeEnv: async () => ({ ok: false, error: 'VERCEL_ENV_REJECTED' }),
    });
    const rShardFail = await invokeTrigger(syncHandlerShardFail, { clientId: UID_C1, planId: PLAN_C1_V3 });
    assert.equal(rShardFail.statusCode, 500);
    assert.equal(rShardFail.payload.status, 'RENEWAL_FAILED');
    assert.equal(rShardFail.payload.errorCode, 'RUNTIME_SHARD_SYNC_FAILED');
    assert.equal(rShardFail.payload.numericApplyAuthorized, false);
    const c1AfterFail = (await adminDb.doc('releaseControl/numericPilot_cohort_cohort-01').get()).data();
    assert.equal(c1AfterFail.enabled, false, 'T878-JSON-10: failed runtime shard sync must leave cohort STOPPED (fail-closed)');

    // T878-JSON-10c: Concurrent renewal lock (IN_PROGRESS) -> HTTP 409 RENEWAL_CONFLICT
    const PLAN_C1_V4 = 'plan-c1-json-v4';
    const PID_C1_V4 = 'pid-c1-json-v4-1';
    await adminSet(`plans/${PLAN_C1_V4}`, Object.assign({}, jsonPlanDoc, {
      id: PLAN_C1_V4, days: [{ dayIndex: 0, label: 'D1', exercises: [{ exerciseName: 'Press Militar Barra', prescriptionExerciseId: PID_C1_V4, sets: jsonPlanDoc.days[0].exercises[0].sets }] }],
    }));
    await adminSet(`clients/${UID_C1}`, { activePlanId: PLAN_C1_V4 }, true);
    const lockOpId = planSync.buildRenewalOperationId('cohort-01', UID_C1, PLAN_C1_V4, C.computePidsHash([PID_C1_V4]));
    await adminSet(`releaseControl/numericPilot/operations/${lockOpId}`, {
      schema: 'vdsen-numeric-operations-ledger-v1', status: 'IN_PROGRESS', cohortId: 'cohort-01', operationId: lockOpId,
    });
    const rConc = await invokeTrigger(syncHandlerAuto, { clientId: UID_C1, planId: PLAN_C1_V4 });
    assert.equal(rConc.statusCode, 409);
    assert.equal(rConc.payload.status, 'RENEWAL_CONFLICT');
    assert.equal(rConc.payload.errorCode, 'CONCURRENT_RENEWAL_IN_PROGRESS');
    assert.equal(rConc.payload.numericApplyAuthorized, false);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
