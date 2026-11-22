'use strict';
// T864 — Real Numeric Apply Activation & Protected Arm-Fences Regression Suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'api/_numericPilotContract'));
const ops = require(path.join(ROOT, 'scripts/pilot/numeric-pilot-ops.cjs'));
const shadow = require(path.join(ROOT, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(ROOT, 'assets/progression-application-consumer.js'));
const effective = require(path.join(ROOT, 'assets/progression-effective-prescription.js'));
const executor = require(path.join(ROOT, 'api/_autonomousProgression.js'));

const ACTIVE_UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const ACTIVE_PLAN = 'ucwGfeXn2NGPhnY6CZjb';
const ACTIVE_PID = '8821a34a-3474-4c13-a6c9-6246f92ed438';
const COACH_ID = 'coach-ayrton-t864';
const SHA = '0e4c98db0999e24e66e0f0455d21f128101f3cca';
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

function makeAttestation(w = makeWindow()) {
  return {
    attested: true,
    status: 'ATTESTED',
    operationId: w.operationId,
    deploymentId: 'dpl_26Q4iTpsCbQvPNFR8vKwa74PrPpS',
    runtimeSha: w.runtimeSha,
    checks: [{ name: 'deployment_ready', pass: true }],
  };
}

function makeMemoryIo() {
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
    createLedgerExclusive: async (docPath, payload) => {
      if (store.has(docPath)) throw new Error('OPERATION_ALREADY_EXISTS: ' + docPath);
      store.set(docPath, structuredClone(payload));
      return structuredClone(payload);
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
  assert.equal(C.windowValid(makeWindow({ planId: '2wywK0y0pKtXRzGS8dNx' }), NOW_MS), false, 'retired T699 plan rejected');
  assert.equal(C.windowValid(makeWindow({ planId: 'D5fVjlS3NysTD6Yg2ZpW' }), NOW_MS), false, 'previous mesocycle plan rejected');
  assert.equal(C.windowValid(makeWindow({ pid: '831ccbbe-ab09-4669-a0ef-4c652ca84b7a' }), NOW_MS), false, 'retired PID rejected');
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
  const ok = ops.invocation({ ...baseEnv, VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'true' }, 'arm-fences');
  assert.deepEqual(ok, { authorized: true, action: 'arm-fences' });
  const stopOk = ops.invocation({ ...baseEnv, VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'false' }, 'stop');
  assert.deepEqual(stopOk, { authorized: true, action: 'stop' });
});

test('T864.3 executeArmFences reserves durable ledger, arms all 3 fences, verifies readback, and rejects duplicates/bad preflight', async () => {
  const io = makeMemoryIo();
  const w = makeWindow();
  const att = makeAttestation(w);

  // Rejects non-GO preflight before touching any fence
  await assert.rejects(() => ops.executeArmFences({ window: w, attestation: att, preflight: { verdict: 'NO-GO' }, coachId: COACH_ID, now: NOW_MS }, io), /ARM_PREFLIGHT_NOT_GO/);
  assert.equal(io.store.size, 0, 'zero writes on NO-GO preflight');

  // Rejects unverified attestation
  await assert.rejects(() => ops.executeArmFences({ window: w, attestation: { attested: false }, preflight: { verdict: 'GO' }, coachId: COACH_ID, now: NOW_MS }, io), /ARM_ATTESTATION_INVALID/);
  assert.equal(io.store.size, 0);

  // Valid arm succeeds atomically
  const res = await ops.executeArmFences({ window: w, attestation: att, preflight: { verdict: 'GO' }, coachId: COACH_ID, runId: '999001', now: NOW_MS }, io);
  assert.equal(res.armed, true);
  assert.equal(res.status, 'ARMED');
  assert.equal(res.fencesVerified, true);
  assert.equal(res.ledgerStatus, 'RESERVED');
  assert.equal(io.store.get('releaseControl/numericPilot').enabled, true);
  assert.equal(io.store.get('releaseControl/autonomousProgression').enabled, true);
  assert.equal(io.store.get('coaches/' + COACH_ID).autoApplyCanary.enabled, true);

  // Duplicate operationId rejected atomically
  await assert.rejects(() => ops.executeArmFences({ window: w, attestation: att, preflight: { verdict: 'GO' }, coachId: COACH_ID, runId: '999002', now: NOW_MS }, io), /OPERATION_ALREADY_EXISTS/);

  // STOP disarms all 3 fences and marks ledger STOPPED
  const stopRep = await ops.executeStop({ coachId: COACH_ID, operationId: OP_ID, reason: 'T864_TEST_STOP' }, io);
  assert.equal(stopRep.allDisarmed, true);
  assert.equal(io.store.get('releaseControl/numericPilot').enabled, false);
  assert.equal(io.store.get('releaseControl/autonomousProgression').enabled, false);
  assert.equal(io.store.get('coaches/' + COACH_ID).autoApplyCanary.enabled, false);
  assert.equal(io.store.get('releaseControl/numericPilot/operations/' + OP_ID).status, 'STOPPED');
});

test('T864.4 executeArmFencesRest enforces currentDocument.exists=false on ledger and updateMask on fences', async () => {
  const seen = [];
  const docs = new Map();
  const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
    : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  const fetcher = async (url, init) => {
    seen.push({ method: init.method, url });
    const docPath = url.split('/documents/')[1].split('?')[0];
    if (init.method === 'PATCH') {
      if (url.includes('currentDocument.exists=false') && docs.has(docPath)) {
        return { status: 409, text: async () => JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }) };
      }
      const parsed = JSON.parse(init.body);
      docs.set(docPath, parsed);
      return { status: 200, text: async () => JSON.stringify({ name: docPath, fields: parsed.fields }) };
    }
    if (!docs.has(docPath)) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => JSON.stringify({ name: docPath, fields: docs.get(docPath).fields }) };
  };

  const w = makeWindow();
  const rep = await ops.executeArmFencesRest('demo-vdsen-t864', 'tok-test', {
    window: w, attestation: makeAttestation(w), preflight: { verdict: 'GO' }, coachId: COACH_ID, runId: '999003', now: NOW_MS,
  }, fetcher);
  assert.equal(rep.armed, true);
  assert.ok(seen.some(s => s.method === 'PATCH' && s.url.includes('operations/' + OP_ID + '?currentDocument.exists=false')));
  assert.ok(seen.some(s => s.method === 'PATCH' && s.url.includes('coaches/' + COACH_ID + '?updateMask.fieldPaths=autoApplyCanary')));

  // Second call on same operationId -> 409 -> OPERATION_ALREADY_EXISTS
  await assert.rejects(() => ops.executeArmFencesRest('demo-vdsen-t864', 'tok-test', {
    window: w, attestation: makeAttestation(w), preflight: { verdict: 'GO' }, coachId: COACH_ID, runId: '999004', now: NOW_MS,
  }, fetcher), /OPERATION_ALREADY_EXISTS/);
});

test('T864.5 Workflow & static invariants: vdsen-numeric-pilot.yml exposes arm-fences with active defaults while static NUMERIC_APPLY_ENABLED stays false', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/vdsen-numeric-pilot.yml'), 'utf8');
  assert.ok(wf.includes('- arm-fences'));
  assert.ok(wf.includes("default: 'ucwGfeXn2NGPhnY6CZjb'"));
  assert.ok(wf.includes("default: '8821a34a-3474-4c13-a6c9-6246f92ed438'"));
  assert.ok(wf.includes('node scripts/pilot/numeric-pilot-ops.cjs arm-fences'));
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false, 'static shadow flag remains false');
  assert.equal(consumer.NUMERIC_APPLY_ENABLED, false, 'static consumer flag remains false');
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, '.release/vdsen-client.json'), 'utf8'));
  assert.equal(state.numeric_apply_enabled, false, 'release manifest numeric_apply_enabled remains false');
  assert.equal(typeof effective.resolveEffective, 'function');
  assert.equal(typeof executor.applyPending, 'function');
});
