'use strict';
const assert = require('node:assert/strict');
const repo = 'vdsenasesoria-svg/vdsen-ecosistema';
const ref = 'refs/heads/codex/client-app-next';

function recoveryProbeRequest(env) {
  assert.ok(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === repo &&
    env.GITHUB_REF === ref && env.GITHUB_WORKFLOW_REF === repo + '/.github/workflows/vdsen-numeric-pilot.yml@' + ref &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_RUN_ATTEMPT === '1',
  'RECOVERY_IDENTITY_WORKFLOW_FORBIDDEN');
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'RECOVERY_GITHUB_OIDC_UNAVAILABLE');
  const request = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.ok(request.protocol === 'https:' &&
    /^[a-z0-9.-]+\.actions\.githubusercontent\.com$/.test(request.hostname) &&
    !request.username && !request.password && !request.port && !request.hash, 'RECOVERY_GITHUB_OIDC_UNAVAILABLE');
  return request;
}

async function acquireRecoveryProbeIdentity(env, deploymentId, fetcher = globalThis.fetch) {
  assert.match(deploymentId || '', /^dpl_[A-Za-z0-9]+$/, 'RECOVERY_PROBE_DEPLOYMENT_REQUIRED');
  const request = recoveryProbeRequest(env);
  request.searchParams.set('audience', 'vdsen-recovery-shards:' + deploymentId);
  let assertion;
  try {
    const response = await fetcher(request.toString(), {
      headers:{authorization:'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN},
      redirect:'error', cache:'no-store', signal:AbortSignal.timeout(10000),
    });
    if (response.status === 200) assertion = (await response.json()).value;
  } catch { /* Do not log credentials or provider bodies. */ }
  assert.ok(typeof assertion === 'string' && /^\S+$/.test(assertion), 'RECOVERY_GITHUB_ASSERTION_UNAVAILABLE');
  return assertion;
}

module.exports = { recoveryProbeRequest, acquireRecoveryProbeIdentity };
