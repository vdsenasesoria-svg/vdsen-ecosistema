'use strict';
// T864 / T864-B — Real Numeric Apply Activation, Official Preflight Contract & Atomic Arm-Fences Regression Suite.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-vdsen-t864-test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'api/_numericPilotContract'));
const ops = require(path.join(ROOT, 'scripts/pilot/numeric-pilot-ops.cjs'));
const { DEFAULT_PROJECT_ID, DEFAULT_TEAM_ID } = require(path.join(ROOT, 'scripts/pilot/numeric-attestation.cjs'));
const shadow = require(path.join(ROOT, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(ROOT, 'assets/progression-application-consumer.js'));
const effective = require(path.join(ROOT, 'assets/progression-effective-prescription.js'));
const executor = require(path.join(ROOT, 'api/_autonomousProgression.js'));

const ACTIVE_UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const ACTIVE_PLAN = 'ucwGfeXn2NGPhnY6CZjb';
const ACTIVE_PID = '8821a34a-3474-4c13-a6c9-6246f92ed438';
const COACH_ID = 'coach-ayrton-t864';
const SHA = '0e4c98db0999e24e66e0f0455d21f128101f3cca';
const DEPLOYMENT_ID = 'dpl_26Q4iTpsCbQvPNFR8vKwa74PrPpS';
const ALIAS = 'vdsen-ecosistema.vercel.app';
const OP_ID = 'op-t864-ayrton-numeric-01';
const NOW_ISO = '2026-11-22T12:00:00Z';
const NOW_MS = Date.parse(NOW_ISO);

function makeWindow(over = {}) {
  return {
    schema: 'vdsen-numeric-pilot-v1',
    mode: 'NUMERIC_APPLY',
    uid: ACTIVE_UID,
    planId: ACTIVE_PLAN,
    pid: ACTIVE_PID,
    runtimeSha: SHA,
    operationId: OP_ID,
    startsAt: '2026-11-22T10:00:00Z',
    expiresAt: '2026-11-22T22:00:00Z',
    ...over,
  };
}

function makeProviderFetcher(w = makeWindow()) {
  return async (url) => {
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
        meta: { githubCommitSha: w.runtimeSha, vdsenPilotOperation: w.operationId },
      }),
    };
  };
}

async function runRealGoPreflight(w = makeWindow(), nowMs = NOW_MS) {
  const fetcher = makeProviderFetcher(w);
  const preflight = await ops.runPreflight({
    window: w,
    deploymentId: DEPLOYMENT_ID,
    expectedAlias: ALIAS,
    currentRunId: '999001',
    vercelToken: 'test-vercel-token',
    activeRuns: [{ id: '999001', status: 'in_progress' }],
    priorOperations: [],
    priorOperationsSourceVerified: true,
    priorOperationsCoverageComplete: true,
    fences: {
      releaseControl: { enabled: false, clientIds: [ACTIVE_UID], expiresAt: w.expiresAt },
      numericPilot: { enabled: false, uid: ACTIVE_UID, planId: ACTIVE_PLAN, pid: ACTIVE_PID, runtimeSha: w.runtimeSha, operationId: w.operationId, expiresAt: w.expiresAt },
      coach: { autoApplyCanary: { enabled: false, clientIds: [ACTIVE_UID], prescriptionExerciseIds: [ACTIVE_PID] } },
    },
    now: nowMs,
    io: { fetcher },
  });
  assert.equal(preflight.schema, 'vdsen-numeric-preflight-v1');
  assert.equal(preflight.decision, 'GO');
  return preflight;
}

function makeAtomicMemoryIo(opts = {}) {
  const store = new Map();
  const deepMerge = (target, src) => {
    const out = Object.assign({}, target || {});
    for (const [k, v] of Object.entries(src || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k], v);
      else out[k] = structuredClone(v);
    }
    return out;
  };
  return {
    store,
    commitAtomicArm: async (batch) => {
      if (opts.failCommit) throw new Error('ATOMIC_COMMIT_ABORTED: simulated write failure');
      if (store.has(batch.ledgerPath)) throw new Error('OPERATION_ALREADY_EXISTS: ' + batch.ledgerPath);
      // All-or-nothing staged application
      const next = new Map(store);
      next.set(batch.ledgerPath, structuredClone(batch.ledgerPayload));
      next.set(batch.releasePath, deepMerge(next.get(batch.releasePath), batch.releasePayload));
      next.set(batch.numericFencePath, deepMerge(next.get(batch.numericFencePath), batch.numericFencePayload));
      next.set(batch.coachPath, deepMerge(next.get(batch.coachPath), batch.coachPayload));
      store.clear();
      for (const [k, v] of next.entries()) store.set(k, v);
      return { committed: true };
    },
    writeFence: async (docPath, fields) => {
      const nested = ops.unflattenFields(fields);
      const merged = deepMerge(store.get(docPath), nested);
      store.set(docPath, merged);
      return structuredClone(merged);
    },
    readFence: async (docPath) => store.has(docPath) ? structuredClone(store.get(docPath)) : null,
    recordStop: async (opId, stopData) => {
      const p = 'releaseControl/numericPilot/operations/' + opId;
      const cur = store.get(p) || { operationId: opId };
      const updated = Object.assign({}, cur, { status: 'STOPPED', stoppedAt: stopData.stoppedAt || NOW_ISO, stopReason: stopData.reason });
      store.set(p, updated);
      return { success: true, operationId: opId, status: 'STOPPED', modified: true };
    },
  };
}

test('T864.1 Contract binds Ayrton active plan ucwGfeXn2NGPhnY6CZjb and D1 PID 8821a34a..., rejecting retired IDs', () => {
  assert.equal(C.UID, ACTIVE_UID);
  assert.equal(C.PLAN, ACTIVE_PLAN);
  assert.equal(C.PID, ACTIVE_PID);
  assert.equal(C.windowValid(makeWindow(), NOW_MS), true);
  assert.equal(C.windowValid(makeWindow({ planId: '2wywK0y0pKtXRzGS8dNx' }), NOW_MS), false);
  assert.equal(C.windowValid(makeWindow({ planId: 'D5fVjlS3NysTD6Yg2ZpW' }), NOW_MS), false);
  assert.equal(C.windowValid(makeWindow({ pid: '831ccbbe-ab09-4669-a0ef-4c652ca84b7a' }), NOW_MS), false);
});

test('T864.2 arm-fences invocation requires explicit VDSEN_NUMERIC_PILOT_RELEASE_ENABLED=true and attempt 1', () => {
  const baseEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
    GITHUB_REF: 'refs/heads/codex/client-app-next',
    GITHUB_RUN_ATTEMPT: '1',
  };
  assert.throws(() => ops.invocation({ ...baseEnv, VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'false' }, 'arm-fences'), /NUMERIC_PILOT_ARM_DISABLED/);
  assert.throws(() => ops.invocation({ ...baseEnv, VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'true', GITHUB_RUN_ATTEMPT: '2' }, 'arm-fences'), /NO_JOB_RERUNS/);
  assert.deepEqual(ops.invocation({ ...baseEnv, VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'true' }, 'arm-fences'), { authorized: true, action: 'arm-fences' });
  assert.deepEqual(ops.invocation({ ...baseEnv, VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'false' }, 'stop'), { authorized: true, action: 'stop' });
});

test('T864.3 executeArmFences enforces strict official runPreflight() decision===GO and rejects verdict/ready aliases, NO-GO, BLOCKED, and mismatches', async () => {
  const io = makeAtomicMemoryIo();
  const w = makeWindow();
  const goPreflight = await runRealGoPreflight(w);
  const att = goPreflight.attestation;

  // Rejects legacy/synthetic { verdict: 'GO', ready: true } bypass
  await assert.rejects(
    () => ops.executeArmFences({ window: w, attestation: att, preflight: { verdict: 'GO', ready: true }, coachId: COACH_ID, now: NOW_MS }, io),
    /ARM_PREFLIGHT_SCHEMA_INVALID/
  );
  // Rejects NO-GO and BLOCKED official decisions
  await assert.rejects(
    () => ops.executeArmFences({ window: w, attestation: att, preflight: { ...goPreflight, decision: 'NO-GO' }, coachId: COACH_ID, now: NOW_MS }, io),
    /ARM_PREFLIGHT_NOT_GO/
  );
  await assert.rejects(
    () => ops.executeArmFences({ window: w, attestation: att, preflight: { ...goPreflight, decision: 'BLOCKED' }, coachId: COACH_ID, now: NOW_MS }, io),
    /ARM_PREFLIGHT_NOT_GO/
  );
  // Rejects window identity mismatch between preflight and target
  await assert.rejects(
    () => ops.executeArmFences({ window: w, attestation: att, preflight: { ...goPreflight, window: makeWindow({ operationId: 'op-other-999' }) }, coachId: COACH_ID, now: NOW_MS }, io),
    /ARM_PREFLIGHT_WINDOW_MISMATCH/
  );
  assert.equal(io.store.size, 0, 'zero writes on any rejected preflight');

  // Official GO preflight succeeds atomically
  const res = await ops.executeArmFences({ window: w, attestation: att, preflight: goPreflight, coachId: COACH_ID, runId: '999001', now: NOW_MS }, io);
  assert.equal(res.armed, true);
  assert.equal(res.atomicCommit, true);
  assert.equal(res.fencesVerified, true);
  assert.equal(res.ledgerStatus, 'RESERVED');

  // Duplicate operationId rejected atomically without touching existing fences
  await assert.rejects(
    () => ops.executeArmFences({ window: w, attestation: att, preflight: goPreflight, coachId: COACH_ID, runId: '999002', now: NOW_MS }, io),
    /OPERATION_ALREADY_EXISTS/
  );

  // STOP disarms all 3 fences and marks ledger STOPPED independently
  const stopRep = await ops.executeStop({ coachId: COACH_ID, operationId: OP_ID, reason: 'T864B_TEST_STOP' }, io);
  assert.equal(stopRep.allDisarmed, true);
  assert.equal(io.store.get('releaseControl/numericPilot').enabled, false);
  assert.equal(io.store.get('releaseControl/autonomousProgression').enabled, false);
  assert.equal(io.store.get('coaches/' + COACH_ID).autoApplyCanary.enabled, false);
  assert.equal(io.store.get('releaseControl/numericPilot/operations/' + OP_ID).status, 'STOPPED');
});

test('T864.4 Atomic commit failure leaves ZERO partially armed fences and preserves STOP independence', async () => {
  const io = makeAtomicMemoryIo({ failCommit: true });
  const w = makeWindow();
  const goPreflight = await runRealGoPreflight(w);

  await assert.rejects(
    () => ops.executeArmFences({ window: w, attestation: goPreflight.attestation, preflight: goPreflight, coachId: COACH_ID, runId: '999010', now: NOW_MS }, io),
    /ATOMIC_COMMIT_ABORTED/
  );
  assert.equal(io.store.size, 0, 'all-or-nothing: zero fences or ledger docs written on failure');
});

test('T864.5 executeArmFencesRest sends ONE single atomic :commit RPC with 4 writes and currentDocument.exists=false on ledger', async () => {
  const commits = [];
  const docs = new Map();
  const fetcher = async (url, init) => {
    if (init.method === 'POST' && url.endsWith('/documents:commit')) {
      const body = JSON.parse(init.body);
      commits.push({ url, writeCount: body.writes.length, writes: body.writes });
      // Enforce currentDocument.exists=false atomically across the entire batch
      for (const w of body.writes) {
        const docPath = w.update.name.split('/documents/')[1];
        if (w.currentDocument && w.currentDocument.exists === false && docs.has(docPath)) {
          return { status: 409, text: async () => JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }) };
        }
      }
      for (const w of body.writes) {
        const docPath = w.update.name.split('/documents/')[1];
        docs.set(docPath, { fields: w.update.fields });
      }
      return { status: 200, text: async () => JSON.stringify({ writeResults: body.writes.map(() => ({})) }) };
    }
    const docPath = url.split('/documents/')[1].split('?')[0];
    if (!docs.has(docPath)) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => JSON.stringify({ name: docPath, fields: docs.get(docPath).fields }) };
  };

  const w = makeWindow();
  const goPreflight = await runRealGoPreflight(w);
  const rep = await ops.executeArmFencesRest('demo-vdsen-t864', 'tok-test', {
    window: w, attestation: goPreflight.attestation, preflight: goPreflight, coachId: COACH_ID, runId: '999003', now: NOW_MS,
  }, fetcher);
  assert.equal(rep.armed, true);
  assert.equal(rep.atomicCommit, true);
  assert.equal(commits.length, 1, 'exactly ONE atomic :commit RPC');
  assert.equal(commits[0].writeCount, 4, 'all 4 writes bundled in one atomic commit');
  assert.deepEqual(commits[0].writes[0].currentDocument, { exists: false });
  assert.deepEqual(commits[0].writes[3].updateMask.fieldPaths, ['autoApplyCanary']);

  // Second atomic commit on same operationId -> 409 -> OPERATION_ALREADY_EXISTS
  await assert.rejects(() => ops.executeArmFencesRest('demo-vdsen-t864', 'tok-test', {
    window: w, attestation: goPreflight.attestation, preflight: goPreflight, coachId: COACH_ID, runId: '999004', now: NOW_MS,
  }, fetcher), /OPERATION_ALREADY_EXISTS/);
});

test('T864.6 Workflow & static invariants: vdsen-numeric-pilot.yml exposes arm-fences with active defaults while static NUMERIC_APPLY_ENABLED stays false', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/vdsen-numeric-pilot.yml'), 'utf8');
  assert.ok(wf.includes('- arm-fences'));
  assert.ok(wf.includes("default: 'ucwGfeXn2NGPhnY6CZjb'"));
  assert.ok(wf.includes("default: '8821a34a-3474-4c13-a6c9-6246f92ed438'"));
  assert.ok(wf.includes('node scripts/pilot/numeric-pilot-ops.cjs arm-fences'));
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false);
  assert.equal(consumer.NUMERIC_APPLY_ENABLED, false);
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, '.release/vdsen-client.json'), 'utf8'));
  assert.equal(state.numeric_apply_enabled, false);
  assert.equal(typeof effective.resolveEffective, 'function');
  assert.equal(typeof executor.applyPending, 'function');
});
