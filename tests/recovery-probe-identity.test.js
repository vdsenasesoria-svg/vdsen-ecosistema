'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {acquireRecoveryProbeIdentity} = require('../scripts/pilot/recovery-probe-identity.cjs');
const repository = 'vdsenasesoria-svg/vdsen-ecosistema';
const ref = 'refs/heads/codex/client-app-next';
const broker = 'https://vdsen-fixture.run.app/v1/vdsen-recovery-attestation';
const uid = 'vdsen-recovery-attestor-fixture';
const now = 10000;
const env = {
  GITHUB_ACTIONS:'true', GITHUB_REPOSITORY:repository, GITHUB_REF:ref,
  GITHUB_WORKFLOW_REF:repository+'/.github/workflows/vdsen-numeric-pilot.yml@'+ref,
  GITHUB_EVENT_NAME:'workflow_dispatch', GITHUB_RUN_ATTEMPT:'1',
  VDSEN_RECOVERY_IDENTITY_BROKER_URL:broker, VDSEN_RECOVERY_ATTESTOR_UID:uid,
  ACTIONS_ID_TOKEN_REQUEST_URL:'https://fixture.actions.githubusercontent.com/token',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture-request-token',
};
const identity = {uid, vdsenScope:'vdsen:cohort-shard:read', firebase:{sign_in_provider:'custom'}, iat:now-10, exp:now+3500};

test('protected workflow exchanges OIDC only for its configured probe identity', async () => {
  const calls = [];
  const deps = {
    now:()=>now*1000,
    verifyIdToken:async (token) => { assert.equal(token,'fixture-id-token'); return identity; },
    fetcher:async (url, opts) => {
      calls.push([url,opts]);
      return {status:200,json:async () => calls.length===1 ? {value:'fixture-oidc'} : {idToken:'fixture-id-token'}};
    },
  };
  assert.equal(await acquireRecoveryProbeIdentity(env,deps),'fixture-id-token');
  assert.equal(new URL(calls[0][0]).searchParams.get('audience'),broker);
  assert.equal(calls[1][0],broker);
  assert.equal(calls[1][1].headers.authorization,'Bearer fixture-oidc');
  assert.ok(calls.every(([,opts])=>opts.redirect==='error'));
  await assert.rejects(acquireRecoveryProbeIdentity({...env,GITHUB_REF:'refs/heads/main'},deps), /WORKFLOW_FORBIDDEN/);
  await assert.rejects(acquireRecoveryProbeIdentity({...env,VDSEN_RECOVERY_IDENTITY_BROKER_URL:''},deps), /BROKER_NOT_CONFIGURED/);
});

test('rejects invalid, expired, stale and unrelated Firebase credentials without echoing tokens', async () => {
  const acquire = (verifyIdToken, grant = {idToken:'fixture-id-token'}) => acquireRecoveryProbeIdentity(env,{
    now:()=>now*1000, verifyIdToken,
    fetcher:async (_url,opts)=>({status:200,json:async ()=>opts.method==='GET' ? {value:'fixture-oidc'} : grant}),
  });
  await assert.rejects(acquire(async ()=>{throw new Error('fixture-id-token');}), /^Error: RECOVERY_FIREBASE_TOKEN_INVALID$/);
  for (const wrong of [{uid:'client-fixture'},{vdsenScope:'wrong'},{iat:now-91},{exp:now},{exp:now+3601}]) {
    await assert.rejects(acquire(async ()=>({...identity,...wrong})), /IDENTITY_FORBIDDEN/);
  }
  await assert.rejects(acquire(async ()=>identity,{idToken:'fixture-id-token',refreshToken:'fixture-refresh'}), /GRANT_INVALID/);
});
