'use strict';
// T829: Protected A4 wrapper for Ayrton's two Firestore fences (STATUS | ENABLE | STOP).
// Reuses ayrton-window.cjs, ayrton-canary.cjs, and window-protocol.cjs without widening scope.
// Never accepts or logs Firebase ID tokens, WIF access tokens, or personal document payloads.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const C = require('./ayrton-canary.cjs');
const P = require('./window-protocol.cjs');
const W = require('./ayrton-window.cjs');

const ALLOWED_ACTIONS = new Set(['STATUS', 'ENABLE', 'STOP']);
const AUTHORIZED_PID = 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83';

function invocation(env, action) {
  env = env || process.env;
  const act = String(action || env.INPUT_ACTION || 'STATUS').trim().toUpperCase();
  assert.ok(ALLOWED_ACTIONS.has(act), 'INVALID_WINDOW_ACTION: ' + act);
  assert.equal(env.GITHUB_ACTIONS, 'true', 'GITHUB_ACTIONS_REQUIRED');
  assert.equal(env.GITHUB_REPOSITORY, 'vdsenasesoria-svg/vdsen-ecosistema', 'INVALID_REPOSITORY');
  assert.equal(env.GITHUB_REF, 'refs/heads/codex/client-app-next', 'CANONICAL_BRANCH_REQUIRED');
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-ayrton-window.yml@refs/heads/codex/client-app-next',
    'UNTRUSTED_WORKFLOW_REF'
  );

  if (act === 'ENABLE') {
    assert.equal(env.AYRTON_WINDOW_RELEASE_ENABLED, 'true', 'FENCE_ENABLE_DISARMED');
    assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'NO_JOB_RERUNS');
    assert.ok(typeof env.VDSEN_PILOT_ID_TOKEN === 'string' && env.VDSEN_PILOT_ID_TOKEN.length > 0, 'AUTHENTICATED_PROBE_BLOCKED');
  } else if (act === 'STOP') {
    // Emergency STOP never requires AYRTON_WINDOW_RELEASE_ENABLED=true and allows re-runs.
    assert.notEqual(env.AYRTON_WINDOW_STOP_ENABLED, 'false', 'FENCE_STOP_REVOKED');
  }
  return { authorized: true, action: act };
}

function buildWindow(env, state, action, now = Date.now()) {
  env = env || process.env;
  const s = state || JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
  const act = String(action || env.INPUT_ACTION || 'STATUS').trim().toUpperCase();
  const pid = String(env.INPUT_PID || AUTHORIZED_PID).trim();
  const w = {
    schema: 'vdsen-ayrton-window-v1',
    mode: 'STAGE1_SHADOW',
    pid,
    uid: String(env.INPUT_UID || '').trim(),
    coachId: String(env.INPUT_COACH || '').trim(),
    planId: String(env.INPUT_PLAN || '').trim(),
    runtimeSha: String(env.INPUT_RUNTIME || s.runtime_sha || '').trim(),
    deployment: s.production_deployment,
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

async function executeWindowAction(action, opts = {}) {
  const act = String(action || '').trim().toUpperCase();
  assert.ok(act === 'ENABLE' || act === 'STOP', 'INVALID_WINDOW_MUTATION_ACTION: ' + act);
  const env = opts.env || process.env;
  const token = opts.token || env.GOOGLE_ACCESS_TOKEN;
  assert.ok(token, 'GOOGLE_ACCESS_TOKEN_REQUIRED');

  if (act === 'ENABLE') {
    assert.equal(env.AYRTON_WINDOW_RELEASE_ENABLED, 'true', 'FENCE_ENABLE_DISARMED');
    const idToken = opts.idToken || env.VDSEN_PILOT_ID_TOKEN;
    assert.ok(typeof idToken === 'string' && idToken.length > 0, 'AUTHENTICATED_PROBE_BLOCKED');
  } else {
    assert.notEqual(env.AYRTON_WINDOW_STOP_ENABLED, 'false', 'FENCE_STOP_REVOKED');
  }

  const w = opts.window || buildWindow(env, opts.state, act, opts.now);
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
    idToken: opts.idToken || env.VDSEN_PILOT_ID_TOKEN,
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

module.exports = { invocation, buildWindow, executeStatus, executeWindowAction, AUTHORIZED_PID };
