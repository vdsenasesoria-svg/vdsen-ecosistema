'use strict';
// Owner-operated wrapper: strict absolute window, actual GET-only runtime checks, canonical atomic fence writer.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const C = require('./ayrton-canary.cjs');
const P = require('./window-protocol.cjs');
const A = require('../release/app-live.cjs');
const state = () => JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
async function assertLegacyRetired(s, read = A.deployment) {
  try { await read(s, P.LEGACY_ARMED_DEPLOYMENT); }
  catch (error) {
    // A permission/transport error does not prove retirement. Only the authenticated scoped API's 404 does.
    if (/HTTP 404(?:\D|$)/.test(String(error && error.message))) return true;
    throw new Error('LEGACY_RETIREMENT_UNVERIFIED');
  }
  throw new Error('LEGACY_ARMED_DEPLOYMENT_STILL_EXISTS');
}
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function tagWindowError(message, meta = {}) {
  const err = new Error(message);
  if (meta.windowCode) err.windowCode = meta.windowCode;
  if (meta.httpStatus !== undefined) err.httpStatus = meta.httpStatus;
  if (meta.commitOutcome) err.commitOutcome = meta.commitOutcome;
  if (meta.probeTarget) err.probeTarget = meta.probeTarget;
  return err;
}

function isRedirectError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  const causeMsg = String((err.cause && err.cause.message) || '');
  return /unexpected redirect/i.test(msg) || /unexpected redirect/i.test(causeMsg);
}

function isTimeoutError(err) {
  if (!err) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(String(err.message || ''));
}

function classifyWindowError(err, stage) {
  const safeStage = SAFE_CODE_RE.test(String(stage || '')) ? String(stage) : 'UNKNOWN_STAGE';
  let code = 'WINDOW_EXECUTION_FAILED';
  if (err && typeof err.windowCode === 'string' && SAFE_CODE_RE.test(err.windowCode)) {
    code = err.windowCode;
  } else if (err && typeof err.message === 'string') {
    const trimmed = err.message.trim();
    if (SAFE_CODE_RE.test(trimmed)) code = trimmed;
    else if (isRedirectError(err)) code = 'RUNTIME_PROBE_REDIRECT_BLOCKED';
    else if (isTimeoutError(err)) code = safeStage.startsWith('RUNTIME_PROBE') ? 'RUNTIME_PROBE_TIMEOUT' : 'REQUEST_TIMEOUT';
    else if (/^ERR_ASSERTION$/.test(String(err.code || ''))) code = 'ASSERTION_FAILED';
  }
  const httpStatus = err && Number.isInteger(err.httpStatus) ? err.httpStatus : null;
  const probeTarget = err && (err.probeTarget === 'deployment_url' || err.probeTarget === 'production_alias') ? err.probeTarget : null;
  const commitOutcome = err && (err.commitOutcome === 'NOT_APPLIED' || err.commitOutcome === 'UNCERTAIN')
    ? err.commitOutcome
    : (safeStage === 'FIRESTORE_COMMIT' || safeStage === 'POST_COMMIT_READBACK' || safeStage === 'RUNTIME_PROBE_AFTER' ? 'UNCERTAIN' : 'NOT_APPLIED');
  return { code, stage: safeStage, httpStatus, commitOutcome, retryAllowed: false, ...(probeTarget ? { probeTarget } : {}) };
}

async function runtimeEvidence(w, deps = {}) {
  const s = state(); assert.equal(s.production_project, P.PROJECT); assert.equal(s.vercel_team, P.TEAM);
  await (deps.assertLegacyRetired || assertLegacyRetired)(s);
  const d = await (deps.deployment || A.deployment)(s, w.deployment);
  assert.equal(d.id || d.uid, w.deployment); assert.equal(d.projectId, P.PROJECT);
  assert.equal(d.teamId || d.ownerId, P.TEAM);
  const host = d.url; assert.match(host || '', /^[A-Za-z0-9.-]+\.vercel\.app$/);
  const oidcToken = deps.oidcToken || process.env.VDSEN_A4_OIDC_TOKEN;
  const idToken = deps.idToken || process.env.VDSEN_PILOT_ID_TOKEN;
  const useA4Oidc = typeof oidcToken === 'string' && oidcToken.length > 0;
  const token = useA4Oidc ? oidcToken : idToken;
  assert.ok(token, 'AUTHENTICATED_PROBE_BLOCKED');
  const checkMode = useA4Oidc ? 'runtime-a4' : 'runtime';
  const fetchFn = deps.fetch || fetch;
  const currentAppFn = deps.currentApp || A.currentApp;
  const probeReq = () => ({
    headers: { authorization: 'Bearer ' + token },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });

  let probeTarget = 'deployment_url';
  let response;
  let deploymentRedirected = false;
  try {
    response = await fetchFn('https://' + host + '/api/autonomous-progression-trigger?check=' + checkMode, probeReq());
    if (response && REDIRECT_STATUSES.has(response.status)) deploymentRedirected = true;
  } catch (err) {
    if (isRedirectError(err)) {
      deploymentRedirected = true;
    } else {
      throw tagWindowError(isTimeoutError(err) ? 'RUNTIME_PROBE_TIMEOUT' : 'RUNTIME_PROBE_NETWORK_ERROR', {
        windowCode: isTimeoutError(err) ? 'RUNTIME_PROBE_TIMEOUT' : 'RUNTIME_PROBE_NETWORK_ERROR',
        probeTarget,
      });
    }
  }

  // Per-deployment URLs on Vercel can be gated by Vercel Authentication SSO (HTTP 302 -> vercel.com/sso-api).
  // Never follow redirects. Fall back to the canonical production alias ONLY after verifying live alias pinning
  // to the exact staged deployment (both before and after the probe).
  if (deploymentRedirected) {
    assert.equal(await currentAppFn(s), w.deployment, 'ALIAS_CHANGED');
    const prodOrigin = String(s.production_origin || '').replace(/\/$/, '');
    assert.match(prodOrigin, /^https:\/\/[A-Za-z0-9.-]+\.vercel\.app$/, 'PRODUCTION_ORIGIN_INVALID');
    if (new URL(prodOrigin).hostname === host) {
      throw tagWindowError('RUNTIME_PROBE_REDIRECT_BLOCKED', { windowCode: 'RUNTIME_PROBE_REDIRECT_BLOCKED', probeTarget });
    }
    probeTarget = 'production_alias';
    try {
      response = await fetchFn(prodOrigin + '/api/autonomous-progression-trigger?check=' + checkMode, probeReq());
      if (response && REDIRECT_STATUSES.has(response.status)) {
        throw tagWindowError('RUNTIME_PROBE_REDIRECT_BLOCKED', { windowCode: 'RUNTIME_PROBE_REDIRECT_BLOCKED', httpStatus: response.status, probeTarget });
      }
    } catch (err) {
      if (err && err.windowCode) throw err;
      const code = isRedirectError(err) ? 'RUNTIME_PROBE_REDIRECT_BLOCKED' : (isTimeoutError(err) ? 'RUNTIME_PROBE_TIMEOUT' : 'RUNTIME_PROBE_NETWORK_ERROR');
      throw tagWindowError(code, { windowCode: code, probeTarget });
    }
  }

  if (!response || response.status !== 200) {
    const status = response && Number.isInteger(response.status) ? response.status : null;
    const code = status ? ('RUNTIME_PROBE_HTTP_' + status) : 'RUNTIME_PROBE_FAILED';
    throw tagWindowError(code, { windowCode: code, httpStatus: status, probeTarget });
  }
  const probe = await response.json();
  if (probe.runtimeSha !== undefined && probe.runtimeSha !== null) {
    assert.equal(probe.runtimeSha, w.runtimeSha, 'RUNTIME_CHANGED');
  }
  P.effectiveGate(w, { id: d.id || d.uid, projectId: d.projectId, teamId: d.teamId || d.ownerId,
    sha: d.meta && d.meta.githubCommitSha, state: d.readyState, target: d.target }, probe);
  assert.equal(await currentAppFn(s), w.deployment, 'ALIAS_CHANGED');
  const isShadow = w.mode === 'STAGE1_SHADOW';
  return { deployment: w.deployment, runtimeSha: w.runtimeSha, probeTarget, flags: { processingEnabled: true, numericApplyEnabled: !isShadow, cronConfigured: false }, capturedAt: new Date().toISOString() };
}
async function main(argv, deps = {}) {
  const arg = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
  assert.ok(argv.includes('--window'), 'Explicit immutable window file required');
  const w = JSON.parse(fs.readFileSync(arg('window'), 'utf8')), mode = arg('mode');
  assert.ok(['enable', 'stop'].includes(mode));
  const unresolvedStop = mode === 'stop' && deps.allowUnresolvedOperation === true && !w.operationId;
  if (unresolvedStop) {
    P.windowSpec({ ...w, operationId: 'unresolved-emergency-stop' }, Date.now(), true);
  } else {
    P.windowSpec(w, Date.now(), mode === 'stop');
  }
  assert.ok(!argv.includes('--replace') && !argv.includes('--ttl-hours'), 'No replacement or relative renewal');
  let before, after, inspected, readback;
  const evidence = { operationId: w.operationId || null, mode, deployment: w.deployment, runtimeSha: w.runtimeSha, expiresAt: w.expiresAt, steps: [] };
  const record = (step, facts = {}) => {
    evidence.steps.push({ step, at: new Date().toISOString(), ...facts });
    fs.writeFileSync(arg('window') + '.evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  };
  const verify = async (probeStage) => {
    stage = probeStage;
    before = await (deps.runtimeEvidence || runtimeEvidence)(w);
    record('EFFECTIVE_RUNTIME_BEFORE', { verified: true, ...(before && before.probeTarget ? { probeTarget: before.probeTarget } : {}) });
  };
  const readFences = async ({ request, token }, opts = {}) => {
    const r = await request('GET', C.RELEASE_PATH, token), c = await request('GET', 'coaches/' + w.coachId, token);
    assert.equal(r.status, 200, 'POST_COMMIT_READ_FAILED'); assert.equal(c.status, 200, 'POST_COMMIT_READ_FAILED');
    const release = C.decDoc(r.body), coach = C.decDoc(c.body);
    let revocationVerified = false;
    if (mode === 'stop' && deps.operationId && w.operationId) {
      const revRes = await request('GET', 'releaseControl/ayrtonRevocation_' + w.operationId, token);
      if (opts.allowMissingRevocation && revRes.status === 404) {
        revocationVerified = false;
      } else {
        assert.equal(revRes.status, 200, 'POST_COMMIT_REVOCATION_READ_FAILED');
        const revDoc = C.decDoc(revRes.body);
        assert.ok(revDoc && revDoc.revoked === true && revDoc.operationId === w.operationId, 'POST_COMMIT_REVOCATION_INVALID');
        revocationVerified = true;
      }
    }
    readback = { release: r.body.updateTime || null, coach: c.body.updateTime || null, releaseEnabled: release.enabled, coachEnabled: coach.autoApplyCanary && coach.autoApplyCanary.enabled, revocationVerified };
    record('FENCES_AFTER', readback); return { release, coach };
  };
  let result;
  let stage = 'PRE_READ_AND_STATE_GATE';
  const targetPid = mode === 'stop' ? undefined : (arg('pid') || w.pid || w.prescriptionExerciseId);
  if (w.mode === 'STAGE1_SHADOW' && mode !== 'stop') {
    assert.ok(targetPid, 'STAGE1_SHADOW requires an explicit single PID (--pid)');
    assert.equal(targetPid, 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83', 'ONLY_AUTHORIZED_PID');
  }
  const canaryArgs = [
    '--uid', w.uid,
    '--mode', mode,
    '--expires-at', w.expiresAt,
    ...(targetPid ? ['--pid', targetPid] : ['--legacy-window-protocol']),
    ...(argv.includes('--confirm') ? ['--confirm'] : [])
  ];
  try { result = await C.main(canaryArgs, {
    ...deps,
    legacyProtocol: !targetPid,
    authorize: async snapshot => {
      stage = 'PRE_READ_AND_STATE_GATE';
      inspected = snapshot;
      if (unresolvedStop) P.stateGate({ ...w, operationId: 'unresolved-emergency-stop' }, snapshot, mode);
      else P.stateGate(w, snapshot, mode);
      record('FENCES_BEFORE', { versions: snapshot.barrierVersions, releaseEnabled: snapshot.release && snapshot.release.enabled, coachEnabled: snapshot.coach.autoApplyCanary && snapshot.coach.autoApplyCanary.enabled });
      if (mode === 'enable') await verify('RUNTIME_PROBE_BEFORE'); // Revocation must work even if the runtime probe is broken.
      stage = 'PLAN_WRITES';
    },
    beforeCommit: async () => {
      if (mode === 'enable') { P.windowSpec(w); await verify('RUNTIME_PROBE_PRE_COMMIT'); }
      stage = 'FIRESTORE_COMMIT';
      record('COMMIT_INTENT');
    },
    onUncertainCommit: async context => { try { await readFences(context, { allowMissingRevocation: true }); } catch (_) { record('READBACK_UNVERIFIED'); } },
    afterCommit: async context => {
      stage = 'POST_COMMIT_READBACK';
      const { release, coach } = await readFences(context);
      if (unresolvedStop) P.stateGate({ ...w, operationId: 'unresolved-emergency-stop' }, { ...inspected, release, coach }, mode);
      else P.stateGate(w, { ...inspected, release, coach }, mode);
      assert.equal(release.enabled, mode === 'enable'); assert.equal(coach.autoApplyCanary.enabled, mode === 'enable');
      if (mode === 'enable') {
        assert.equal(release.expiresAt, w.expiresAt);
        stage = 'RUNTIME_PROBE_AFTER';
        after = await (deps.runtimeEvidence || runtimeEvidence)(w);
        record('EFFECTIVE_RUNTIME_AFTER', { verified: true, ...(after && after.probeTarget ? { probeTarget: after.probeTarget } : {}) });
      }
      else assert.ok(Date.parse(release.expiresAt) <= Date.now());
    },
  }); } catch (err) {
    const diag = classifyWindowError(err, stage);
    evidence.failure = diag;
    const stepName = diag.commitOutcome === 'UNCERTAIN' ? 'STOPPED_VERIFY_OR_COMMIT_UNCERTAIN' : 'STOPPED_FAIL_CLOSED';
    record(stepName, diag);
    const outErr = new Error('WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY:' + diag.code + '@' + diag.stage);
    outErr.windowError = diag;
    throw outErr;
  }
  record(result.unchanged ? 'UNCHANGED_NO_RENEWAL' : result.wrote ? 'VERIFIED' : 'SIMULATION_NO_WRITES');
  return { mode, ...result, operationId: w.operationId, deployment: w.deployment, runtimeSha: w.runtimeSha,
    verifiedBefore: !!before, verifiedAfter: !!after, barrierVersionsBefore: inspected && inspected.barrierVersions,
    readback, expiresAt: w.expiresAt };
}
module.exports = { main, runtimeEvidence, assertLegacyRetired, classifyWindowError };
if (require.main === module) main(process.argv.slice(2)).then(x => console.log(JSON.stringify(x))).catch(err => {
  const diag = err && err.windowError ? err.windowError : { code: 'WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY', stage: 'UNKNOWN_STAGE', httpStatus: null, commitOutcome: 'UNCERTAIN', retryAllowed: false };
  console.error(JSON.stringify({ status: 'WINDOW_REJECTED_OR_UNCERTAIN', ...diag }));
  process.exitCode = 1;
});
