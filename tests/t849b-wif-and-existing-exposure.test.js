'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'vdsen-ayrton-window.yml');
const CLIENT_HTML_PATH = path.join(ROOT, 'vdsen-cliente.html');
const trigger = require(path.join(ROOT, 'api', 'autonomous-progression-trigger.js'));
const shadow = require(path.join(ROOT, 'assets', 'progression-auto-apply-shadow.js'));

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const PID = 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83';
const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');

function mkRes() {
  const out = { statusCode: 0, body: null, headers: {} };
  return {
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.statusCode = c; return { json(b) { out.body = b; return out; } }; },
  };
}

function makeInMemoryDb(seedDocs, startsDocs = []) {
  const store = new Map(Object.entries(seedDocs).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const mkSnap = (key, val) => ({
    id: key.split('/').pop(),
    exists: val !== undefined,
    data: () => (val === undefined ? undefined : JSON.parse(JSON.stringify(val))),
    createTime: { toMillis: () => Date.parse('2026-10-01T00:00:00Z') },
    updateTime: { toMillis: () => Date.parse('2026-11-20T06:30:00Z') },
  });
  const docRef = (key) => ({
    _key: key,
    async get() { return mkSnap(key, store.get(key)); },
    collection(sub) { return colRef(key + '/' + sub); },
  });
  const colRef = (prefix) => ({
    doc(id) { return docRef(prefix + '/' + id); },
    orderBy() { return { limit() { return { _startsQuery: true }; } }; },
  });
  const db = {
    collection(name) { return colRef(name); },
    async runTransaction(fn) {
      const staged = new Map();
      const tx = {
        async get(ref) {
          if (ref && ref._startsQuery) {
            return { docs: startsDocs.map(d => ({ id: d.id, data: () => ({ ...d.data }) })) };
          }
          const val = staged.has(ref._key) ? staged.get(ref._key) : store.get(ref._key);
          return mkSnap(ref._key, val);
        },
        set(ref, data, opts) {
          const prev = staged.has(ref._key) ? staged.get(ref._key) : store.get(ref._key);
          const next = opts && opts.merge && prev && typeof prev === 'object'
            ? { ...JSON.parse(JSON.stringify(prev)), ...JSON.parse(JSON.stringify(data)) }
            : JSON.parse(JSON.stringify(data));
          staged.set(ref._key, next);
        },
      };
      const res = await fn(tx);
      for (const [k, v] of staged.entries()) store.set(k, v);
      return res;
    },
  };
  return { db, store };
}

function baseSeed(entries) {
  const futureExp = new Date(Date.now() + 2 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    ['clients/' + UID]: { coachId: COACH, activePlanId: PLAN, status: 'active' },
    ['coaches/' + COACH]: {
      apiAccessEnabled: true,
      autoApplyCanary: { enabled: true, clientIds: [UID], prescriptionExerciseIds: [PID] },
    },
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [UID],
      expiresAt: futureExp,
    },
    ['plans/' + PLAN]: {
      clientId: UID,
      coachId: COACH,
      status: 'active',
      weeks: 6,
      updatedAt: '2026-11-01T00:00:00Z',
      days: [{
        dayIndex: 0,
        name: 'Día 1',
        exercises: [{
          name: 'Press Convergente Inclinado',
          prescriptionExerciseId: PID,
          muscleGroup: 'pecho',
          repsRange: '6-8',
          sets: [
            { repsTarget: 6, rirTarget: 3, restSeconds: 180 },
            { repsTarget: 6, rirTarget: 3, restSeconds: 180 },
            { repsTarget: 6, rirTarget: 2, restSeconds: 180 },
            { repsTarget: 6, rirTarget: 2, restSeconds: 180 },
          ],
        }],
      }],
    },
    ['logs/' + UID]: { planId: PLAN, updatedAt: Date.parse('2026-11-20T06:45:00Z'), entries },
    ['logs/' + UID + '/mesos/' + PLAN]: { planId: PLAN, updatedAt: Date.parse('2026-11-20T06:45:00Z'), entries },
  };
}

function makeExposureLogs(week, load, reps, rir, tsIso) {
  const ts = Date.parse(tsIso);
  const out = {};
  for (let s = 0; s < 4; s++) {
    out['log_' + week + '_0_0_s' + s] = {
      prescriptionExerciseId: PID,
      exerciseName: 'Press Convergente Inclinado',
      carga: load,
      unit: 'kg',
      reps,
      repsTarget: 6,
      rir: 2,
      rir_real: rir,
      ics: 10,
      done: true,
      ts: ts + s * 60000,
    };
  }
  out['done_' + week + '_0'] = { ts: ts + 300000, partial: true };
  return out;
}

test('T849B.1 vdsen-ayrton-window.yml uses dedicated GCP_PILOT_WINDOW_SERVICE_ACCOUNT without altering contracts or adding keys', () => {
  const yml = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(yml, /service_account:\s*\$\{\{\s*vars\.GCP_PILOT_WINDOW_SERVICE_ACCOUNT\s*\}\}/);
  assert.ok(!yml.includes('GCP_RELEASE_SERVICE_ACCOUNT'), 'window workflow must not authenticate as vdsen-release-bot');
  assert.match(yml, /workload_identity_provider:\s*\$\{\{\s*vars\.GCP_WORKLOAD_IDENTITY_PROVIDER\s*\}\}/);
  assert.match(yml, /token_format:\s*access_token/);
  assert.match(yml, /create_credentials_file:\s*false/);
  assert.match(yml, /access_token_scopes:\s*https:\/\/www\.googleapis\.com\/auth\/datastore/);
  assert.match(yml, /environment:\s*Production/);
  assert.match(yml, /id-token:\s*write/);
  assert.match(yml, /AYRTON_WINDOW_RELEASE_ENABLED:\s*\$\{\{\s*vars\.AYRTON_WINDOW_RELEASE_ENABLED\s*\}\}/);
  assert.ok(!/credentials_json|service_account_key/i.test(yml), 'no persistent JSON keys allowed');
});

test('T849B.2 Authenticated reload in vdsen-cliente.html schedules deferred trigger when persisted progrec_* exists without re-saving sets', () => {
  const html = fs.readFileSync(CLIENT_HTML_PATH, 'utf8');
  const idx = html.indexOf('function _captureLifecycleState(');
  assert.ok(idx > 0, '_captureLifecycleState must exist');
  const block = html.slice(idx, idx + 2000);
  assert.ok(block.includes('progrec_\\d+_\\d+'), 'must detect persisted progrec_* entries');
  assert.ok(block.includes('_scheduleTrustedProgression(uid, planId)'), 'must schedule deferred progression trigger on reload');
});

test('T849B.3 Existing 4-set exposure distinguishes: trigger OK, NO_CHANGE idempotency, INSUFFICIENT_EVIDENCE (AUTO 0 != failure), and SHADOW candidate created with NUMERIC_APPLY_ENABLED=false', async () => {
  const futureExp = new Date(Date.now() + 2 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pilotWindow = JSON.stringify({
    uidHash: sha256(UID),
    planHash: sha256(PLAN),
    expiresAt: futureExp,
    operationId: 'op-t849b-existing-replay',
  });
  const starts = [{
    id: PLAN + '_3_0_0',
    data: {
      at: { toMillis: () => Date.parse('2026-11-20T06:20:00Z') },
      planId: PLAN,
      prescriptionExerciseId: PID,
      week: 3,
      dayIndex: 0,
      exerciseIndex: 0,
      setKey: 'log_3_0_0_s0',
    },
  }];

  // Case A: 1 single existing exposure (Press Convergente Inclinado, 4 sets) with actionable rec ->
  // Trigger executes OK (HTTP 200), creates 1 PENDING record with INSUFFICIENT_COMPARABLE_EXPOSURES (eligible=false, applied=[]),
  // second reload returns NO_CHANGE (idempotent), entries & plan untouched.
  const entriesSingle = {
    ...makeExposureLogs(3, 60, 6, 3, '2026-11-20T06:40:00Z'),
    progrec_3_0: {
      calculatedAt: '2026-11-20T06:40:00Z',
      recommendations: [{
        prescriptionExerciseId: PID,
        exerciseName: 'Press Convergente Inclinado',
        action: 'increase_load',
        newLoad: 62.5,
      }],
    },
  };
  const { db: db1, store: store1 } = makeInMemoryDb(baseSeed(entriesSingle), starts);
  const planBefore1 = JSON.stringify(store1.get('plans/' + PLAN));
  const entriesBefore1 = JSON.stringify(store1.get('logs/' + UID + '/mesos/' + PLAN).entries);

  const handler1 = trigger.makeHandler({
    db: db1,
    verifyIdToken: async () => ({ uid: UID }),
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow,
    log() {},
  });

  const first = await handler1({ method: 'POST', headers: { authorization: 'Bearer valid-id-token' }, body: { planId: PLAN } }, mkRes());
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.status, 'MATERIALIZED');
  assert.equal(first.body.created.length, 1);
  assert.deepEqual(first.body.applied, [], 'NUMERIC_APPLY_ENABLED=false never applies');
  const meso1 = store1.get('logs/' + UID + '/mesos/' + PLAN);
  const rec1 = meso1.progressionApplications[first.body.created[0]];
  assert.equal(rec1.state, shadow.STATES.PENDING);
  assert.equal(rec1.magnitude.eligible, false);
  assert.equal(rec1.magnitude.actionable, false);
  assert.ok((rec1.magnitude.reasonCodes || []).includes('INSUFFICIENT_COMPARABLE_EXPOSURES') || rec1.magnitude.unresolved === 'INSUFFICIENT_COMPARABLE_EXPOSURES');
  assert.equal(JSON.stringify(store1.get('plans/' + PLAN)), planBefore1, 'prescription untouched');
  assert.equal(JSON.stringify(meso1.entries), entriesBefore1, 'existing 4 sets never duplicated or mutated');

  // Repeat reload trigger -> NO_CHANGE (idempotent)
  const repeat = await handler1({ method: 'POST', headers: { authorization: 'Bearer valid-id-token' }, body: { planId: PLAN } }, mkRes());
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.body.status, 'NO_CHANGE');
  assert.deepEqual(repeat.body.created, []);

  // Case B: Single exposure where client rec is 'maintain' (no numeric delta) ->
  // Trigger executes OK (HTTP 200), record is REJECTED (NO_NUMERIC_DELTA), AUTO count = 0 (NOT an engine failure!)
  const entriesMaintain = {
    ...makeExposureLogs(3, 60, 6, 3, '2026-11-20T06:40:00Z'),
    progrec_3_0: {
      calculatedAt: '2026-11-20T06:40:00Z',
      recommendations: [{
        prescriptionExerciseId: PID,
        exerciseName: 'Press Convergente Inclinado',
        action: 'maintain',
        newReps: 6,
      }],
    },
  };
  const { db: db2, store: store2 } = makeInMemoryDb(baseSeed(entriesMaintain), starts);
  const handler2 = trigger.makeHandler({
    db: db2,
    verifyIdToken: async () => ({ uid: UID }),
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow,
    log() {},
  });
  const resMaintain = await handler2({ method: 'POST', headers: { authorization: 'Bearer valid-id-token' }, body: { planId: PLAN } }, mkRes());
  assert.equal(resMaintain.statusCode, 200);
  assert.equal(resMaintain.body.status, 'MATERIALIZED');
  const summary2 = store2.get('logs/' + UID).progressionApplicationSummary;
  assert.equal(summary2.autoCount, 0, 'AUTO 0 with REJECTED/NO_NUMERIC_DELTA is a valid engine outcome, not a failure');
  assert.equal(summary2.counts.REJECTED, 1);

  // Case C: Two comparable exposures -> SHADOW candidate created (PENDING, magnitude.eligible=true, applied=[])
  const entriesTwo = {
    ...makeExposureLogs(2, 60, 6, 4, '2026-11-13T06:40:00Z'),
    ...makeExposureLogs(3, 60, 6, 4, '2026-11-20T06:40:00Z'),
    progrec_3_0: {
      calculatedAt: '2026-11-20T06:40:00Z',
      recommendations: [{
        prescriptionExerciseId: PID,
        exerciseName: 'Press Convergente Inclinado',
        action: 'increase_load',
        newLoad: 62.5,
      }],
    },
  };
  const { db: db3, store: store3 } = makeInMemoryDb(baseSeed(entriesTwo), starts);
  const handler3 = trigger.makeHandler({
    db: db3,
    verifyIdToken: async () => ({ uid: UID }),
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow,
    log() {},
  });
  const resTwo = await handler3({ method: 'POST', headers: { authorization: 'Bearer valid-id-token' }, body: { planId: PLAN } }, mkRes());
  assert.equal(resTwo.statusCode, 200);
  assert.equal(resTwo.body.status, 'MATERIALIZED');
  assert.equal(resTwo.body.created.length, 1);
  assert.deepEqual(resTwo.body.applied, [], 'SHADOW mode never applies numerically');
  const meso3 = store3.get('logs/' + UID + '/mesos/' + PLAN);
  const rec3 = meso3.progressionApplications[resTwo.body.created[0]];
  assert.equal(rec3.state, shadow.STATES.PENDING);
  assert.equal(rec3.magnitude.eligible, true);
  assert.equal(store3.get('logs/' + UID).progressionApplicationSummary.autoCount, 1);
});
