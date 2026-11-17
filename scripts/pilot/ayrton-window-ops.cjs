'use strict';
// T829/T830: Protected A4 wrapper for Ayrton's two Firestore fences (STATUS | ENABLE | STOP).
// Binds ENABLE to the verified ayrton-runtime-{run_id} artifact and live Vercel deployment/alias,
// never to the OFF baseline or an arbitrary workflow_dispatch deployment input.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const A = require('../release/app-live.cjs');
const C = require('./ayrton-canary.cjs');
const P = require('./window-protocol.cjs');
const W = require('./ayrton-window.cjs');

const REPO = 'vdsenasesoria-svg/vdsen-ecosistema';
const ALLOWED_ACTIONS = new Set(['STATUS', 'ENABLE', 'STOP']);
const AUTHORIZED_PID = 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83';

function invocation(env, action) {
  env = env || process.env;
  const act = String(action || env.INPUT_ACTION || 'STATUS').trim().toUpperCase();
  assert.ok(ALLOWED_ACTIONS.has(act), 'INVALID_WINDOW_ACTION: ' + act);
  assert.equal(env.GITHUB_ACTIONS, 'true', 'GITHUB_ACTIONS_REQUIRED');
  assert.equal(env.GITHUB_REPOSITORY, REPO, 'INVALID_REPOSITORY');
  assert.equal(env.GITHUB_REF, 'refs/heads/codex/client-app-next', 'CANONICAL_BRANCH_REQUIRED');
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    REPO + '/.github/workflows/vdsen-ayrton-window.yml@refs/heads/codex/client-app-next',
    'UNTRUSTED_WORKFLOW_REF'
  );

  if (act === 'ENABLE') {
    assert.equal(env.AYRTON_WINDOW_RELEASE_ENABLED, 'true', 'FENCE_ENABLE_DISARMED');
    assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'NO_JOB_RERUNS');
    assert.match(String(env.INPUT_ARM_RUN_ID || '').trim(), /^[1-9][0-9]+$/, 'ARM_RUN_ID_REQUIRED');
    const hasGhOidc = typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === 'string' && env.ACTIONS_ID_TOKEN_REQUEST_URL.length > 0
      && typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0;
    const hasIdToken = typeof env.VDSEN_PILOT_ID_TOKEN === 'string' && env.VDSEN_PILOT_ID_TOKEN.length > 0;
    assert.ok(hasGhOidc || hasIdToken, 'AUTHENTICATED_PROBE_BLOCKED');
  } else if (act === 'STOP') {
    // Emergency STOP never requires AYRTON_WINDOW_RELEASE_ENABLED=true and allows re-runs.
    assert.notEqual(env.AYRTON_WINDOW_STOP_ENABLED, 'false', 'FENCE_STOP_REVOKED');
  }
  return { authorized: true, action: act };
}

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function fetchGithubOidcToken(operationId, env = process.env, fetchFn = fetch) {
  const reqUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  assert.ok(reqUrl && reqToken, 'AUTHENTICATED_PROBE_BLOCKED');
  assert.match(String(operationId || ''), /^[a-zA-Z0-9-]{8,80}$/, 'OPERATION_ID_INVALID');
  const sep = reqUrl.includes('?') ? '&' : '?';
  const url = reqUrl + sep + 'audience=' + encodeURIComponent('vdsen-ayrton-runtime-a4:' + operationId);
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { authorization: 'bearer ' + reqToken, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(res.status, 200, 'AUTHENTICATED_PROBE_BLOCKED');
  const body = await res.json();
  assert.ok(body && typeof body.value === 'string' && body.value.length >= 40, 'AUTHENTICATED_PROBE_BLOCKED');
  return body.value;
}

async function verifyArmArtifact(opts = {}) {
  const armRunId = String(opts.armRunId || '').trim();
  assert.match(armRunId, /^[1-9][0-9]+$/, 'ARM_RUN_ID_REQUIRED');
  const s = opts.state || JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
  const gh = opts.gh || defaultGh;
  const uid = P.exactUid(String(opts.uid || '').trim());
  const coachId = String(opts.coachId || '').trim();
  const planId = String(opts.planId || '').trim();
  const pid = String(opts.pid || AUTHORIZED_PID).trim();
  const runtimeSha = String(opts.runtimeSha || '').trim();
  const operationId = String(opts.operationId || '').trim();
  const expiresAt = String(opts.expiresAt || '').trim();

  // 1. Verify workflow run provenance via GitHub API
  const run = JSON.parse(gh(['api', 'repos/' + REPO + '/actions/runs/' + armRunId]));
  assert.equal(run.path, '.github/workflows/vdsen-ayrton-runtime.yml', 'ARM_RUN_WORKFLOW_MISMATCH');
  assert.equal(run.head_branch, 'codex/client-app-next', 'ARM_RUN_BRANCH_MISMATCH');
  assert.equal(run.event, 'workflow_dispatch', 'ARM_RUN_EVENT_MISMATCH');
  assert.equal(run.status, 'completed', 'ARM_RUN_NOT_COMPLETED');
  assert.equal(run.conclusion, 'success', 'ARM_RUN_DID_NOT_SUCCEED');

  // 2. Load official ayrton-runtime-{run_id} artifact
  let report = opts.report;
  if (!report) {
    const dir = opts.artifactDir || path.join('release-output', 'arm-artifact-' + armRunId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    gh(['run', 'download', armRunId, '--repo', REPO, '--name', 'ayrton-runtime-' + armRunId, '--dir', dir]);
    const file = path.join(dir, 'ayrton-runtime.json');
    assert.ok(fs.existsSync(file), 'ARM_ARTIFACT_MISSING');
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // 3. Validate artifact contract & exact binding
  assert.equal(report.schema, 'vdsen-ayrton-runtime-release-v1', 'ARM_ARTIFACT_SCHEMA_INVALID');
  assert.equal(report.status, 'RUNTIME_READY_FENCES_CLOSED_NOT_ACTIVATED', 'ARM_ARTIFACT_STATUS_INVALID');
  assert.equal(report.mode, 'STAGE1_SHADOW', 'ARM_ARTIFACT_MODE_INVALID');
  assert.equal(report.operationId, operationId, 'ARM_OPERATION_ID_MISMATCH');
  assert.equal(report.runtimeSha, runtimeSha, 'ARM_RUNTIME_SHA_MISMATCH');
  assert.ok(report.staged && typeof report.staged.id === 'string' && /^dpl_[A-Za-z0-9]+$/.test(report.staged.id), 'ARM_STAGED_DEPLOYMENT_MISSING');
  assert.notEqual(report.staged.id, s.production_deployment, 'ARM_DEPLOYMENT_IS_OFF_BASELINE');
  assert.ok(!report.baseline || report.staged.id !== report.baseline.deployment, 'ARM_DEPLOYMENT_IS_OFF_BASELINE');
  assert.ok(report.window && typeof report.window === 'object', 'ARM_WINDOW_MISSING');
  assert.equal(report.window.deployment, report.staged.id, 'ARM_WINDOW_DEPLOYMENT_MISMATCH');
  assert.equal(report.window.uid, uid, 'ARM_WINDOW_UID_MISMATCH');
  assert.equal(report.window.coachId, coachId, 'ARM_WINDOW_COACH_MISMATCH');
  assert.equal(report.window.planId, planId, 'ARM_WINDOW_PLAN_MISMATCH');
  assert.equal(report.window.pid || report.pid, AUTHORIZED_PID, 'ONLY_AUTHORIZED_PID');
  assert.equal(pid, AUTHORIZED_PID, 'ONLY_AUTHORIZED_PID');
  assert.equal(report.window.expiresAt, expiresAt, 'ARM_WINDOW_EXPIRY_MISMATCH');
  assert.ok(report.fencesAfter && report.fencesAfter.releaseEnabled === false && report.fencesAfter.coachEnabled === false, 'ARM_FENCES_NOT_CLOSED');

  // 4. Verify live Vercel alias and deployment match staged.id (unless explicitly skipped for STOP recovery)
  if (!opts.skipVercelCheck) {
    const currentAlias = await (opts.currentApp || A.currentApp)(s);
    assert.equal(currentAlias, report.staged.id, 'ARM_ALIAS_NOT_ON_STAGED_DEPLOYMENT');
    const d = await (opts.deployment || A.deployment)(s, report.staged.id);
    assert.equal(d.id || d.uid, report.staged.id, 'ARM_VERCEL_DEPLOYMENT_MISMATCH');
    assert.equal(d.projectId, P.PROJECT, 'ARM_VERCEL_PROJECT_MISMATCH');
    assert.equal(d.teamId || d.ownerId, P.TEAM, 'ARM_VERCEL_TEAM_MISMATCH');
    assert.equal(d.target, 'production', 'ARM_VERCEL_TARGET_MISMATCH');
    assert.equal(d.readyState, 'READY', 'ARM_VERCEL_NOT_READY');
    assert.equal(d.meta && d.meta.githubCommitSha, runtimeSha, 'ARM_VERCEL_SHA_MISMATCH');
  }

  return {
    armRunId,
    deployment: report.staged.id,
    window: {
      schema: 'vdsen-ayrton-window-v1',
      mode: 'STAGE1_SHADOW',
      pid: AUTHORIZED_PID,
      uid,
      coachId,
      planId,
      runtimeSha,
      deployment: report.staged.id,
      expiresAt,
      operationId,
    },
  };
}

function buildWindow(env, state, action, now = Date.now(), verifiedDeployment = null) {
  env = env || process.env;
  const s = state || JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
  const act = String(action || env.INPUT_ACTION || 'STATUS').trim().toUpperCase();
  const pid = String(env.INPUT_PID || AUTHORIZED_PID).trim();
  const deployment = verifiedDeployment || s.production_deployment;
  if (act === 'ENABLE') {
    assert.ok(verifiedDeployment && verifiedDeployment !== s.production_deployment, 'ENABLE_REQUIRES_VERIFIED_STAGE1_DEPLOYMENT');
  }
  const w = {
    schema: 'vdsen-ayrton-window-v1',
    mode: 'STAGE1_SHADOW',
    pid,
    uid: String(env.INPUT_UID || '').trim(),
    coachId: String(env.INPUT_COACH || '').trim(),
    planId: String(env.INPUT_PLAN || '').trim(),
    runtimeSha: String(env.INPUT_RUNTIME || s.runtime_sha || '').trim(),
    deployment,
    expiresAt: String(env.INPUT_EXPIRY || '').trim(),
    operationId: String(env.INPUT_OPERATION || '').trim(),
  };
  P.windowSpec(w, now, act === 'STOP');
  assert.equal(w.pid, AUTHORIZED_PID, 'ONLY_AUTHORIZED_PID');
  return w;
}

async function executeStatus(opts = {}) {
  const uid = P.exactUid(String(opts.uid || '').trim());
  const coachId = String(opts.coachId || '').trim();
  assert.match(coachId, /^[a-zA-Z0-9_-]{1,128}$/, 'COACH_ID_REQUIRED');
  const token = opts.token || process.env.GOOGLE_ACCESS_TOKEN;
  assert.ok(token, 'GOOGLE_ACCESS_TOKEN_REQUIRED');
  const http = opts.http || C.http;

  const [relRes, coachRes, clientRes] = await Promise.all([
    http('GET', C.RELEASE_PATH, token),
    http('GET', 'coaches/' + coachId + '?mask.fieldPaths=autoApplyCanary', token),
    http('GET', 'clients/' + uid + '?mask.fieldPaths=coachId&mask.fieldPaths=activePlanId', token),
  ]);

  assert.ok(relRes.status === 200 || relRes.status === 404, 'FENCE_READ_FAILED: release status ' + relRes.status);
  assert.equal(coachRes.status, 200, 'FENCE_READ_FAILED: coach status ' + coachRes.status);
  assert.equal(clientRes.status, 200, 'FENCE_READ_FAILED: client status ' + clientRes.status);

  const release = relRes.status === 404 ? null : C.decDoc(relRes.body);
  const coach = C.decDoc(coachRes.body) || {};
  const client = C.decDoc(clientRes.body) || {};
  const canary = coach.autoApplyCanary || null;
  const sameScope = x => !!(x && Array.isArray(x.clientIds) && x.clientIds.length === 1 && x.clientIds[0] === uid);

  return {
    schema: 'vdsen-ayrton-window-status-v1',
    action: 'STATUS',
    checkedAt: new Date().toISOString(),
    releaseFence: {
      exists: !!release,
      enabled: !!(release && release.enabled === true),
      expiresAt: (release && release.expiresAt) || null,
      clientCount: release && Array.isArray(release.clientIds) ? release.clientIds.length : 0,
      exclusiveScope: release ? sameScope(release) : true,
    },
    coachFence: {
      exists: !!canary,
      enabled: !!(canary && canary.enabled === true),
      clientCount: canary && Array.isArray(canary.clientIds) ? canary.clientIds.length : 0,
      pidCount: canary && Array.isArray(canary.prescriptionExerciseIds) ? canary.prescriptionExerciseIds.length : 0,
      exclusiveScope: canary ? sameScope(canary) : true,
    },
    clientLinkConsistent: client.coachId === coachId && typeof client.activePlanId === 'string' && client.activePlanId.length > 0,
    bothClosed: !((release && release.enabled === true) || (canary && canary.enabled === true)),
  };
}

async function resolveStopWindow(env, s, opts = {}) {
  const armRunId = String(opts.armRunId || env.INPUT_ARM_RUN_ID || '').trim();
  if (armRunId) {
    try {
      const verified = await verifyArmArtifact({
        armRunId,
        state: s,
        uid: env.INPUT_UID,
        coachId: env.INPUT_COACH,
        planId: env.INPUT_PLAN,
        pid: env.INPUT_PID || AUTHORIZED_PID,
        runtimeSha: env.INPUT_RUNTIME || s.runtime_sha,
        operationId: env.INPUT_OPERATION,
        expiresAt: env.INPUT_EXPIRY,
        gh: opts.gh,
        report: opts.report,
        skipVercelCheck: true,
      });
      P.windowSpec(verified.window, opts.now, true);
      return verified.window;
    } catch (_) {
      // Fall through to live Firestore/Vercel recovery if artifact is missing/partial during emergency STOP.
    }
  }

  const uid = P.exactUid(String(env.INPUT_UID || '').trim());
  const coachId = String(env.INPUT_COACH || '').trim();
  const token = opts.token || env.GOOGLE_ACCESS_TOKEN;
  const http = opts.http || C.http;

  let planId = String(env.INPUT_PLAN || '').trim();
  let expiresAt = String(env.INPUT_EXPIRY || '').trim();
  if ((!planId || !expiresAt) && token) {
    const [clientRes, relRes] = await Promise.all([
      http('GET', 'clients/' + uid + '?mask.fieldPaths=coachId&mask.fieldPaths=activePlanId', token),
      http('GET', C.RELEASE_PATH, token),
    ]);
    const cdoc = clientRes.status === 200 ? (C.decDoc(clientRes.body) || {}) : {};
    const rdoc = relRes.status === 200 ? (C.decDoc(relRes.body) || {}) : {};
    if (!planId && typeof cdoc.activePlanId === 'string') planId = cdoc.activePlanId;
    if (!expiresAt && typeof rdoc.expiresAt === 'string') expiresAt = rdoc.expiresAt;
  }

  let deployment = s.production_deployment;
  try {
    const cur = await (opts.currentApp || A.currentApp)(s);
    if (/^dpl_[A-Za-z0-9]+$/.test(cur)) deployment = cur;
  } catch (_) {
    // Emergency STOP must still proceed if Vercel alias read fails.
  }

  const w = {
    schema: 'vdsen-ayrton-window-v1',
    mode: 'STAGE1_SHADOW',
    pid: AUTHORIZED_PID,
    uid,
    coachId,
    planId,
    runtimeSha: String(env.INPUT_RUNTIME || s.runtime_sha || '').trim(),
    deployment,
    expiresAt: expiresAt || new Date(Date.now() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    operationId: String(env.INPUT_OPERATION || 'op-emergency-stop').trim(),
  };
  P.windowSpec(w, opts.now, true);
  return w;
}

async function executeWindowAction(action, opts = {}) {
  const act = String(action || '').trim().toUpperCase();
  assert.ok(act === 'ENABLE' || act === 'STOP', 'INVALID_WINDOW_MUTATION_ACTION: ' + act);
  const env = opts.env || process.env;
  const s = opts.state || JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
  const token = opts.token || env.GOOGLE_ACCESS_TOKEN;
  assert.ok(token, 'GOOGLE_ACCESS_TOKEN_REQUIRED');

  let w;
  let oidcToken = opts.oidcToken || env.VDSEN_A4_OIDC_TOKEN || null;
  const idToken = opts.idToken || env.VDSEN_PILOT_ID_TOKEN || null;
  if (act === 'ENABLE') {
    assert.equal(env.AYRTON_WINDOW_RELEASE_ENABLED, 'true', 'FENCE_ENABLE_DISARMED');
    const hasGhOidc = typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === 'string' && env.ACTIONS_ID_TOKEN_REQUEST_URL.length > 0
      && typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0;
    assert.ok(oidcToken || idToken || hasGhOidc, 'AUTHENTICATED_PROBE_BLOCKED');

    if (opts.window) {
      assert.notEqual(opts.window.deployment, s.production_deployment, 'ARM_DEPLOYMENT_IS_OFF_BASELINE');
      P.windowSpec(opts.window, opts.now, false);
      w = opts.window;
    } else {
      const verified = await verifyArmArtifact({
        armRunId: opts.armRunId || env.INPUT_ARM_RUN_ID,
        state: s,
        uid: env.INPUT_UID,
        coachId: env.INPUT_COACH,
        planId: env.INPUT_PLAN,
        pid: env.INPUT_PID || AUTHORIZED_PID,
        runtimeSha: env.INPUT_RUNTIME || s.runtime_sha,
        operationId: env.INPUT_OPERATION,
        expiresAt: env.INPUT_EXPIRY,
        gh: opts.gh,
        report: opts.report,
        currentApp: opts.currentApp,
        deployment: opts.deployment,
      });
      P.windowSpec(verified.window, opts.now, false);
      w = verified.window;
    }
    if (!oidcToken && !idToken && hasGhOidc) {
      oidcToken = await (opts.fetchOidcToken || fetchGithubOidcToken)(w.operationId, env, opts.fetch);
    }
  } else {
    assert.notEqual(env.AYRTON_WINDOW_STOP_ENABLED, 'false', 'FENCE_STOP_REVOKED');
    w = opts.window || await resolveStopWindow(env, s, opts);
  }

  const windowFile = opts.windowFile || path.join('release-output', 'ayrton-window-request.json');
  fs.mkdirSync(path.dirname(windowFile), { recursive: true });
  fs.writeFileSync(windowFile, JSON.stringify(w));

  const runMain = opts.windowMain || W.main;
  const args = [
    '--window', windowFile,
    '--mode', act.toLowerCase(),
    ...(act === 'ENABLE' ? ['--pid', w.pid] : []),
    '--confirm',
  ];
  const res = await runMain(args, {
    token: typeof token === 'function' ? token : () => token,
    oidcToken: act === 'ENABLE' ? oidcToken : undefined,
    idToken: act === 'ENABLE' ? idToken : undefined,
    http: opts.http,
    runtimeEvidence: opts.runtimeEvidence,
    deployment: opts.deployment,
    currentApp: opts.currentApp,
    fetch: opts.fetch,
  });

  return {
    schema: 'vdsen-ayrton-window-result-v1',
    action: act,
    operationId: res.operationId,
    deployment: res.deployment,
    runtimeSha: res.runtimeSha,
    wrote: res.wrote || 0,
    unchanged: !!res.unchanged,
    verifiedBefore: !!res.verifiedBefore,
    verifiedAfter: !!res.verifiedAfter,
    readback: res.readback || null,
    expiresAt: res.expiresAt,
  };
}

if (require.main === module) {
  (async () => {
    const act = String(process.env.INPUT_ACTION || 'STATUS').trim().toUpperCase();
    invocation(process.env, act);
    let out;
    if (act === 'STATUS') {
      out = await executeStatus({ uid: process.env.INPUT_UID, coachId: process.env.INPUT_COACH });
    } else {
      out = await executeWindowAction(act, { env: process.env });
    }
    fs.mkdirSync('release-output', { recursive: true });
    fs.writeFileSync(path.join('release-output', 'ayrton-window-evidence.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(JSON.stringify(out, null, 2));
  })().catch(err => {
    const msg = String((err && err.message) || err || 'WINDOW_OP_FAILED');
    const code = /^[A-Z0-9_]+/.test(msg) ? msg.split(/[:\s]/)[0] : 'WINDOW_OP_FAILED';
    console.error(JSON.stringify({ status: 'WINDOW_OP_STOPPED', code }));
    process.exitCode = 1;
  });
}

module.exports = { invocation, verifyArmArtifact, fetchGithubOidcToken, buildWindow, executeStatus, executeWindowAction, resolveStopWindow, AUTHORIZED_PID };
