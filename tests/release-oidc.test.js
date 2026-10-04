'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { json, validate } = require('../scripts/release/lib.cjs');
const { base, configuration, probe } = require('../scripts/release/oidc-validate.cjs');
const { resolveRuntime } = require('../scripts/release/check.cjs');
const state = json('.release/vdsen-client.json');
function fixture() {
  return { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema', GITHUB_REF: 'refs/heads/codex/client-app-next', GCP_PROJECT_ID: state.firebase_project, GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/github/providers/release', GCP_RELEASE_SERVICE_ACCOUNT: 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com', VERCEL_PROJECT_ID: state.production_project, VERCEL_ORG_ID: state.vercel_team, PRODUCTION_RELEASE_ENABLED: 'false', OIDC_AUTH_OUTCOME: 'success', GOOGLE_ACCESS_TOKEN: 'google-test-only', VERCEL_TOKEN: 'vercel-test-only' };
}
function restore(before) { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); }
function response(url) {
  if (url.includes('cloudresourcemanager')) return { projectId: state.firebase_project };
  if (url.includes('firestore.googleapis.com')) return { indexes: [] };
  if (url.includes('/releases/')) return { name: 'projects/' + state.firebase_project + '/releases/cloud.firestore', rulesetName: 'projects/' + state.firebase_project + '/rulesets/example' };
  if (url.includes('/rulesets/')) return { name: 'projects/' + state.firebase_project + '/rulesets/example' };
  return { id: state.production_project, accountId: state.vercel_team };
}
test('push bootstrap triggers only canonical branch; credentialed validation has no PR or production mutation path', () => {
  for (const file of ['vdsen-release-check', 'vdsen-oidc-validate']) {
    const source = fs.readFileSync('.github/workflows/' + file + '.yml', 'utf8');
    assert.match(source, /  push:\r?\n    branches: \[codex\/client-app-next\]/);
    assert.ok(!source.includes('branches: [main]'));
  }
  const oidc = fs.readFileSync('.github/workflows/vdsen-oidc-validate.yml', 'utf8');
  assert.match(oidc, /environment: Production/); assert.match(oidc, /id-token: write/);
  assert.ok(!/pull_request|workflow_dispatch|live\.cjs|deploy|rollback|promote|credentials_json:/.test(oidc));
  assert.ok(!oidc.includes('test "$PRODUCTION_RELEASE_ENABLED" = true'));
  assert.match(oidc, /secrets\.VERCEL_TOKEN/);
  for (const variable of ['GCP_PROJECT_ID', 'GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_RELEASE_SERVICE_ACCOUNT', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID']) assert.ok(oidc.includes('vars.' + variable));
  const script = fs.readFileSync('scripts/release/oidc-validate.cjs', 'utf8');
  assert.ok(!/require\('\.\/live|method: '(?:POST|PATCH|PUT|DELETE)'|\/documents\/|\/keys/.test(script));
});
test('missing push input resolves only to approved state SHA and a mismatched explicit SHA is rejected', () => {
  assert.equal(resolveRuntime('', state), state.runtime_sha);
  assert.equal(resolveRuntime(undefined, state), state.runtime_sha);
  assert.equal(resolveRuntime(state.runtime_sha, state), state.runtime_sha);
  assert.throws(() => resolveRuntime('0'.repeat(40), state));
});
test('read-only metadata validation passes with kill switch false and sends only scoped GET requests', async () => {
  const before = { ...process.env }, original = global.fetch, calls = [];
  try {
    Object.assign(process.env, fixture());
    global.fetch = async (url, options) => { calls.push([url, options]); return new Response(JSON.stringify(response(url))); };
    const r = await probe(state, base(state));
    validate(r, json('.release/schema/oidc-validation.schema.json'));
    assert.equal(r.validation_status, 'PASS'); assert.equal(r.production_release_enabled, false);
    assert.equal(r.kill_switch_configuration, 'EXPECTED_FALSE'); assert.equal(r.mutations_performed, false);
    assert.equal(r.least_privilege_verification, 'GAP');
    for (const prefix of ['project_metadata', 'firestore_index_metadata', 'firebase_rules_metadata', 'vercel_project']) {
      assert.equal(r[prefix + '_http_status'], 200); assert.equal(r[prefix + '_error'], 'NONE');
    }
    assert.equal(r.project_metadata_endpoint, 'GCP_PROJECT_METADATA');
    assert.equal(r.firestore_index_metadata_endpoint, 'FIRESTORE_INDEX_METADATA');
    assert.equal(r.firebase_rules_metadata_endpoint, 'FIREBASE_RULESET_METADATA');
    assert.equal(r.vercel_project_endpoint, 'VERCEL_PROJECT_METADATA');
    assert.equal(calls.length, 5); assert.ok(calls.every(([, o]) => o.method === 'GET' && o.body === undefined));
    assert.ok(calls.every(([u]) => !/\/documents\/|\/keys|iam\.googleapis/.test(u)));
    assert.ok(!JSON.stringify(r).includes('google-test-only') && !JSON.stringify(r).includes('vercel-test-only'));
  } finally { global.fetch = original; restore(before); }
});
test('missing provider/service account or wrong project/ref fails before metadata requests', async () => {
  const before = { ...process.env }, original = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; throw new Error('Unexpected network'); };
    for (const [key, value] of [['GCP_WORKLOAD_IDENTITY_PROVIDER', ''], ['GCP_RELEASE_SERVICE_ACCOUNT', ''], ['GCP_PROJECT_ID', 'other'], ['GITHUB_REF', 'refs/heads/main'], ['GITHUB_EVENT_NAME', 'pull_request']]) {
      Object.assign(process.env, fixture()); process.env[key] = value;
      assert.throws(() => configuration(state)); await assert.rejects(probe(state, base(state)));
    }
    assert.equal(calls, 0);
  } finally { global.fetch = original; restore(before); }
});
test('denied Google/index/Rules/Vercel reads fail closed without persisting denial bodies or tokens', async () => {
  const before = { ...process.env }, original = global.fetch;
  try {
    Object.assign(process.env, fixture());
    const failures = [
      ['cloudresourcemanager', 'project_metadata', 'GCP_PROJECT_METADATA'],
      ['firestore.googleapis.com', 'firestore_index_metadata', 'FIRESTORE_INDEX_METADATA'],
      ['/releases/', 'firebase_rules_metadata', 'FIREBASE_RULES_RELEASE_METADATA'],
      ['/rulesets/', 'firebase_rules_metadata', 'FIREBASE_RULESET_METADATA'],
      ['api.vercel.com', 'vercel_project', 'VERCEL_PROJECT_METADATA']
    ];
    for (const [part, prefix, endpoint] of failures) {
      global.fetch = async url => url.includes(part) ? new Response('private-response-test-only', { status: 403 }) : new Response(JSON.stringify(response(url)));
      const r = await probe(state, base(state));
      assert.equal(r.validation_status, 'FAIL'); assert.equal(r.mutations_performed, false);
      assert.equal(r[prefix + '_http_status'], 403); assert.equal(r[prefix + '_error'], 'HTTP_403'); assert.equal(r[prefix + '_endpoint'], endpoint);
      assert.ok(!JSON.stringify(r).includes('private-response-test-only'));
    }
    global.fetch = async url => new Response(JSON.stringify(url.includes('api.vercel.com') ? { id: 'other', accountId: state.vercel_team } : response(url)));
    const mismatch = await probe(state, base(state));
    assert.equal(mismatch.vercel_project_read, 'FAIL'); assert.equal(mismatch.vercel_project_http_status, 200); assert.equal(mismatch.vercel_project_error, 'ASSERTION_MISMATCH');
    process.env.OIDC_AUTH_OUTCOME = 'failure'; await assert.rejects(probe(state, base(state)));
  } finally { global.fetch = original; restore(before); }
});
test('sanitized diagnostics classify HTTP, timeout and network failures without reading denied bodies', async () => {
  const before = { ...process.env }, original = global.fetch;
  try {
    Object.assign(process.env, fixture());
    let deniedBodyReads = 0;
    global.fetch = async url => url.includes('firestore.googleapis.com')
      ? { ok: false, status: 503, async json() { deniedBodyReads++; throw new Error('private-body-test-only'); } }
      : new Response(JSON.stringify(response(url)));
    let r = await probe(state, base(state));
    assert.equal(r.firestore_index_metadata_http_status, 503); assert.equal(r.firestore_index_metadata_error, 'HTTP_5XX'); assert.equal(deniedBodyReads, 0);
    assert.ok(!JSON.stringify(r).includes('private-body-test-only'));

    global.fetch = async url => {
      if (url.includes('api.vercel.com')) { const error = new Error('private-timeout-test-only'); error.name = 'TimeoutError'; throw error; }
      return new Response(JSON.stringify(response(url)));
    };
    r = await probe(state, base(state));
    assert.equal(r.vercel_project_http_status, null); assert.equal(r.vercel_project_error, 'TIMEOUT');
    assert.ok(!JSON.stringify(r).includes('private-timeout-test-only'));

    global.fetch = async url => {
      if (url.includes('cloudresourcemanager')) throw new Error('private-network-test-only');
      return new Response(JSON.stringify(response(url)));
    };
    r = await probe(state, base(state));
    assert.equal(r.project_metadata_http_status, null); assert.equal(r.project_metadata_error, 'NETWORK_ERROR');
    assert.ok(!JSON.stringify(r).includes('private-network-test-only'));
    validate(r, json('.release/schema/oidc-validation.schema.json'));
  } finally { global.fetch = original; restore(before); }
});
test('authentication failure still emits a schema-valid failure artifact through the CLI', () => {
  const parent = fs.realpathSync(os.tmpdir()), temp = fs.mkdtempSync(path.join(parent, 'vdsen-oidc-test-'));
  try {
    fs.mkdirSync(path.join(temp, '.release/schema'), { recursive: true });
    for (const file of ['vdsen-client.json', 'schema/release-state.schema.json', 'schema/oidc-validation.schema.json']) fs.copyFileSync(path.join('.release', file), path.join(temp, '.release', file));
    const script = path.resolve('scripts/release/oidc-validate.cjs');
    const env = fixture();
    const init = spawnSync(process.execPath, [script, 'init'], { cwd: temp, env, encoding: 'utf8' }); assert.equal(init.status, 0);
    const finish = spawnSync(process.execPath, [script, 'finalize'], { cwd: temp, env: { ...env, OIDC_AUTH_OUTCOME: 'failure', VALIDATION_OUTCOME: 'skipped' }, encoding: 'utf8' }); assert.equal(finish.status, 0);
    const r = json(path.join(temp, 'release-output/oidc-validation.json'));
    validate(r, json('.release/schema/oidc-validation.schema.json'));
    assert.equal(r.oidc_auth, 'FAIL'); assert.equal(r.validation_status, 'FAIL'); assert.equal(r.mutations_performed, false);
    assert.ok(!JSON.stringify(r).includes(env.GOOGLE_ACCESS_TOKEN));
  } finally { assert.equal(path.dirname(temp), parent); assert.ok(path.basename(temp).startsWith('vdsen-oidc-test-')); fs.rmSync(temp, { recursive: true, force: true }); }
});
