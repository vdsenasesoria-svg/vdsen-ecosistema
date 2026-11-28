'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {acquireRecoveryProbeIdentity} = require('../scripts/pilot/recovery-probe-identity.cjs');
const repo = 'vdsenasesoria-svg/vdsen-ecosistema';
const ref = 'refs/heads/codex/client-app-next';
const env = {
  GITHUB_ACTIONS:'true', GITHUB_REPOSITORY:repo, GITHUB_REF:ref,
  GITHUB_WORKFLOW_REF:repo+'/.github/workflows/vdsen-numeric-pilot.yml@'+ref,
  GITHUB_EVENT_NAME:'workflow_dispatch', GITHUB_RUN_ATTEMPT:'1',
  ACTIONS_ID_TOKEN_REQUEST_URL:'https://fixture.actions.githubusercontent.com/token',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture-request-token',
};
test('recovery requests only a deployment-bound GitHub assertion from the protected workflow', async () => {
  const fetcher = async (url, opts) => {
    assert.equal(new URL(url).searchParams.get('audience'),'vdsen-recovery-shards:dpl_fixture');
    assert.equal(opts.redirect,'error');
    return Response.json({value:'fixture-assertion'});
  };
  assert.equal(await acquireRecoveryProbeIdentity(env,'dpl_fixture',fetcher),'fixture-assertion');
  await assert.rejects(acquireRecoveryProbeIdentity({...env,GITHUB_REF:'refs/heads/main'},'dpl_fixture',fetcher), /WORKFLOW_FORBIDDEN/);
  await assert.rejects(acquireRecoveryProbeIdentity({...env,ACTIONS_ID_TOKEN_REQUEST_URL:'https://example.test/token'},'dpl_fixture',fetcher), /OIDC_UNAVAILABLE/);
});
