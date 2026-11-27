'use strict';

const assert = require('node:assert/strict');
const repo = 'vdsenasesoria-svg/vdsen-ecosistema';
const ref = 'refs/heads/codex/client-app-next';
const workflow = repo + '/.github/workflows/vdsen-numeric-pilot.yml@' + ref;
const scope = 'vdsen:cohort-shard:read';

async function acquireRecoveryProbeIdentity(env, deps = {}) {
  assert.ok(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === repo &&
    env.GITHUB_REF === ref && env.GITHUB_WORKFLOW_REF === workflow &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_RUN_ATTEMPT === '1',
  'RECOVERY_IDENTITY_WORKFLOW_FORBIDDEN');
  const broker = env.VDSEN_RECOVERY_IDENTITY_BROKER_URL;
  const uid = env.VDSEN_RECOVERY_ATTESTOR_UID;
  assert.ok(/^https:\/\/[a-z0-9-]+\.run\.app\/v1\/vdsen-recovery-attestation$/.test(broker || '') &&
    /^vdsen-recovery-attestor-[a-z0-9-]+$/.test(uid || ''), 'RECOVERY_IDENTITY_BROKER_NOT_CONFIGURED');
  const request = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.ok(request.protocol === 'https:' &&
    /^[a-z0-9.-]+\.actions\.githubusercontent\.com$/.test(request.hostname) &&
    !request.username && !request.password && !request.port && !request.hash &&
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'RECOVERY_GITHUB_OIDC_UNAVAILABLE');
  request.searchParams.set('audience', broker);
  const fetcher = deps.fetcher || globalThis.fetch;
  async function exchange(url, bearer, method) {
    let response;
    try {
      response = await fetcher(url, {method, headers:{authorization:'Bearer ' + bearer},
        redirect:'error', cache:'no-store', signal:AbortSignal.timeout(10000)});
      if (response.status === 200) return await response.json();
    } catch { /* Do not surface provider response bodies or credentials. */ }
    throw new Error('RECOVERY_IDENTITY_EXCHANGE_FAILED');
  }
  const assertion = (await exchange(request.toString(), env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'GET')).value;
  assert.ok(typeof assertion === 'string' && /^\S+$/.test(assertion), 'RECOVERY_GITHUB_ASSERTION_INVALID');
  const grant = await exchange(broker, assertion, 'POST');
  assert.ok(!Object.hasOwn(grant, 'refreshToken') && !Object.hasOwn(grant, 'refresh_token') &&
    typeof grant.idToken === 'string' && /^\S+$/.test(grant.idToken), 'RECOVERY_IDENTITY_GRANT_INVALID');
  const verify = deps.verifyIdToken || (async token => {
    const { initializeApp, getApps } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    const app = getApps().find(candidate => candidate.name === 'vdsen-recovery-attestation') ||
      initializeApp({projectId:'vdsen-ecosistema'}, 'vdsen-recovery-attestation');
    return getAuth(app).verifyIdToken(token);
  });
  assert.ok(!process.env.FIREBASE_AUTH_EMULATOR_HOST || deps.verifyIdToken, 'RECOVERY_AUTH_EMULATOR_FORBIDDEN');
  let identity;
  try { identity = await verify(grant.idToken); } catch { throw new Error('RECOVERY_FIREBASE_TOKEN_INVALID'); }
  const now = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  assert.ok(identity.uid === uid && identity.vdsenScope === scope &&
    identity.firebase?.sign_in_provider === 'custom' &&
    Number.isInteger(identity.iat) && identity.iat <= now && now - identity.iat <= 90 &&
    Number.isInteger(identity.exp) && identity.exp > now && identity.exp - identity.iat <= 3600,
  'RECOVERY_FIREBASE_IDENTITY_FORBIDDEN');
  return grant.idToken;
}

module.exports = { acquireRecoveryProbeIdentity };
