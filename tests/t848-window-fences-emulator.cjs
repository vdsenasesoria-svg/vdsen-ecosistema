'use strict';
// T848: Real Firestore Emulator REST validation of ayrton-window.cjs + ayrton-canary.cjs
// Exercises real Firestore REST GET and documents:commit (with updateMask + currentDocument preconditions),
// verifying ENABLE, invalid ENABLE fail-closed, STOP under adverse conditions, uncertain commit reconciliation,
// zero prescription mutations, and NUMERIC_APPLY_ENABLED=false.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'scripts/pilot/ayrton-window.cjs'));
const C = require(path.join(ROOT, 'scripts/pilot/ayrton-canary.cjs'));
const { AUTHORIZED_PID } = require(path.join(ROOT, 'scripts/pilot/ayrton-window-ops.cjs'));

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const emuHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/, 'T848 emulator test must only run against a demo-* project');

const adminApp = initAdmin({ projectId }, 't848-admin');
const adminDb = getAdminFirestore(adminApp);

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const RUNTIME_SHA = 'af2629a8e6f9f4473bd583005d5ed2a5f2be9d5f';
const STAGE1_DEPLOYMENT = 'dpl_7voyJqHZSo1vY2rb8dawPwCbWfRK';
const FUTURE_EXP = new Date(Date.now() + 2 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PAST_EXP = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

const PROD_DB_PREFIX = 'projects/' + C.PROJECT + '/databases/(default)/documents/';
const EMU_DB_PREFIX = 'projects/' + projectId + '/databases/(default)/documents/';
const EMU_BASE = 'http://' + emuHost + '/v1/' + EMU_DB_PREFIX;

// Real Firestore Emulator REST adapter (uses exact ayrton-canary.cjs commit payloads against real emulator REST API).
async function emuHttp(method, p, _token, body) {
  if (method === 'COMMIT') {
    const rewritten = {
      writes: body.writes.map(w => ({
        ...w,
        update: {
          ...w.update,
          name: w.update.name.replace(PROD_DB_PREFIX, EMU_DB_PREFIX),
        },
      })),
    };
    const r = await fetch(EMU_BASE.replace(/\/$/, '') + ':commit', {
      method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify(rewritten),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) { /* non-json */ }
    return { status: r.status, body: j };
  }
  const r = await fetch(EMU_BASE + p, {
    method,
    headers: { authorization: 'Bearer owner' },
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (_) { /* non-json */ }
  return { status: r.status, body: j };
}

async function seedCleanState() {
  const planData = {
    clientId: UID,
    coachId: COACH,
    days: [{
      name: 'Día 1',
      exercises: [{
        name: 'Press Convergente Inclinado',
        prescriptionExerciseId: AUTHORIZED_PID,
        sets: 4,
        reps: '6',
        rir: '3/2',
      }],
    }],
  };
  await adminDb.doc('clients/' + UID).set({ coachId: COACH, activePlanId: PLAN });
  await adminDb.doc('plans/' + PLAN).set(planData);
  await adminDb.doc('coaches/' + COACH).set({
    apiAccessEnabled: true,
    autoApplyCanary: { enabled: false, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] },
  });
  await adminDb.doc(C.RELEASE_PATH).set({
    schema: C.RELEASE_SCHEMA,
    enabled: false,
    clientIds: [UID],
    expiresAt: PAST_EXP,
  });
  return planData;
}

function makeWindow(opId) {
  return {
    schema: 'vdsen-ayrton-window-v1',
    mode: 'STAGE1_SHADOW',
    pid: AUTHORIZED_PID,
    uid: UID,
    coachId: COACH,
    planId: PLAN,
    runtimeSha: RUNTIME_SHA,
    deployment: STAGE1_DEPLOYMENT,
    expiresAt: FUTURE_EXP,
    operationId: opId,
  };
}

test('T848-EMU.1 Real Firestore REST ENABLE opens exclusive fences atomically with NUMERIC_APPLY_ENABLED=false and zero plan mutations', async () => {
  const originalPlan = await seedCleanState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't848-emu-enable-'));
  const file = path.join(tmpDir, 'win.json');
  const opId = 'op-t848-emu-enable-1';
  fs.writeFileSync(file, JSON.stringify(makeWindow(opId)));
  try {
    const res = await W.main(['--window', file, '--mode', 'enable', '--confirm'], {
      token: () => 'emu-owner-token',
      operationId: opId,
      http: emuHttp,
      runtimeEvidence: async w => ({
        deployment: w.deployment,
        runtimeSha: w.runtimeSha,
        probeTarget: 'production_alias',
        flags: { processingEnabled: true, numericApplyEnabled: false, cronConfigured: false },
        capturedAt: new Date().toISOString(),
      }),
      log() {},
    });
    assert.equal(res.wrote, 4);
    assert.equal(res.readback.releaseEnabled, true);
    assert.equal(res.readback.coachEnabled, true);

    const relSnap = await adminDb.doc(C.RELEASE_PATH).get();
    const coachSnap = await adminDb.doc('coaches/' + COACH).get();
    const opSnap = await adminDb.doc('releaseControl/ayrtonOperation_' + opId).get();
    const activeSnap = await adminDb.doc('releaseControl/ayrtonActiveWindow').get();
    const planSnap = await adminDb.doc('plans/' + PLAN).get();

    assert.equal(relSnap.data().enabled, true);
    assert.deepEqual(relSnap.data().clientIds, [UID]);
    assert.equal(coachSnap.data().autoApplyCanary.enabled, true);
    assert.deepEqual(coachSnap.data().autoApplyCanary.prescriptionExerciseIds, [AUTHORIZED_PID]);
    assert.equal(coachSnap.data().apiAccessEnabled, true, 'unrelated coach fields preserved');
    assert.equal(opSnap.data().status, 'ENABLED');
    assert.equal(activeSnap.data().active, true);
    assert.deepEqual(planSnap.data(), originalPlan, 'prescription must remain completely untouched');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T848-EMU.2 Invalid ENABLE (probe failure) fails closed BEFORE writing Firestore; STOP closes fences and writes durable revocation without runtime probe', async () => {
  await seedCleanState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't848-emu-stop-'));
  const file = path.join(tmpDir, 'win.json');
  const opId = 'op-t848-emu-stop-2';
  fs.writeFileSync(file, JSON.stringify(makeWindow(opId)));
  try {
    // 1. Invalid ENABLE -> fails at RUNTIME_PROBE_BEFORE, zero Firestore mutations
    await assert.rejects(() => W.main(['--window', file, '--mode', 'enable', '--confirm'], {
      token: () => 'emu-owner-token',
      operationId: opId,
      http: emuHttp,
      runtimeEvidence: async () => {
        const e = new Error('RUNTIME_PROBE_REDIRECT_BLOCKED');
        e.windowCode = 'RUNTIME_PROBE_REDIRECT_BLOCKED';
        throw e;
      },
      log() {},
    }), /RUNTIME_PROBE_REDIRECT_BLOCKED@RUNTIME_PROBE_BEFORE/);

    assert.equal((await adminDb.doc(C.RELEASE_PATH).get()).data().enabled, false);
    assert.equal((await adminDb.doc('releaseControl/ayrtonOperation_' + opId).get()).exists, false);

    // 2. STOP executes 5-document atomic REST commit (even with closed fences & broken runtime probe)
    const stopRes = await W.main(['--window', file, '--mode', 'stop', '--confirm'], {
      token: () => 'emu-owner-token',
      operationId: opId,
      http: emuHttp,
      runtimeEvidence: async () => { throw new Error('MUST_NOT_RUN_ON_STOP'); },
      log() {},
    });
    assert.equal(stopRes.wrote, 5);
    assert.equal(stopRes.readback.releaseEnabled, false);
    assert.equal(stopRes.readback.coachEnabled, false);
    assert.equal(stopRes.readback.revocationVerified, true);

    const revSnap = await adminDb.doc('releaseControl/ayrtonRevocation_' + opId).get();
    const opSnap = await adminDb.doc('releaseControl/ayrtonOperation_' + opId).get();
    const activeSnap = await adminDb.doc('releaseControl/ayrtonActiveWindow').get();
    assert.equal(revSnap.data().revoked, true);
    assert.equal(opSnap.data().status, 'REVOKED');
    assert.equal(activeSnap.data().active, false);

    // 3. Subsequent ENABLE for revoked opId is rejected BEFORE commit
    await assert.rejects(() => W.main(['--window', file, '--mode', 'enable', '--confirm'], {
      token: () => 'emu-owner-token',
      operationId: opId,
      http: emuHttp,
      runtimeEvidence: async w => ({ deployment: w.deployment, runtimeSha: w.runtimeSha, flags: { processingEnabled: true, numericApplyEnabled: false, cronConfigured: false } }),
      log() {},
    }), /OPERATION_REVOKED@PRE_READ_AND_STATE_GATE/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T848-EMU.3 Uncertain commit on real emulator emits reconciliation FENCES_AFTER evidence without retry', async () => {
  await seedCleanState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't848-emu-uncertain-'));
  const file = path.join(tmpDir, 'win.json');
  const opId = 'op-t848-emu-uncertain-3';
  fs.writeFileSync(file, JSON.stringify(makeWindow(opId)));
  let commits = 0;
  try {
    await assert.rejects(() => W.main(['--window', file, '--mode', 'stop', '--confirm'], {
      token: () => 'emu-secret-never-log',
      operationId: opId,
      http: async (m, p, tok, body) => {
        if (m === 'COMMIT') { commits++; return { status: 503, body: {} }; }
        return emuHttp(m, p, tok, body);
      },
      log() {},
    }), /FIRESTORE_COMMIT_UNCERTAIN_HTTP_503@FIRESTORE_COMMIT/);
    assert.equal(commits, 1);
    const evText = fs.readFileSync(file + '.evidence.json', 'utf8');
    assert.ok(!evText.includes('emu-secret-never-log'));
    const ev = JSON.parse(evText);
    assert.equal(ev.failure.code, 'FIRESTORE_COMMIT_UNCERTAIN_HTTP_503');
    assert.equal(ev.failure.commitOutcome, 'UNCERTAIN');
    assert.equal(ev.failure.retryAllowed, false);
    assert.ok(ev.steps.some(s => s.step === 'FENCES_AFTER' && s.releaseEnabled === false && s.coachEnabled === false));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test.after(async () => {
  await deleteAdmin(adminApp).catch(() => {});
});
