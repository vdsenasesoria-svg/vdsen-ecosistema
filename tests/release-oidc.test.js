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
    global.fetch = async url => url.includes('cloudresourcemanager')
      ? { ok: false, status: 503, async json() { deniedBodyReads++; throw new Error('private-body-test-only'); } }
      : new Response(JSON.stringify(response(url)));
    let r = await probe(state, base(state));
    assert.equal(r.project_metadata_http_status, 503); assert.equal(r.project_metadata_error, 'HTTP_5XX'); assert.equal(deniedBodyReads, 0);
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

const SENTINELS = ['google-test-only', 'vercel-test-only', 'Bearer', 'Authorization', 'private-message-test-only', 'private-description-test-only', 'team_OTHERFOREIGNID'];
const schema = () => json('.release/schema/oidc-validation.schema.json');
test('Firestore index metadata uses one canonical request without pageSize and requires HTTP 200 with a valid structure', async () => {
  const before = { ...process.env }, original = global.fetch, calls = [];
  try {
    Object.assign(process.env, fixture());
    global.fetch = async (url, options) => { calls.push([url, options]); return new Response(JSON.stringify(response(url))); };
    let r = await probe(state, base(state));
    const fsCalls = calls.filter(([u]) => u.includes('firestore.googleapis.com'));
    assert.equal(fsCalls.length, 1); assert.ok(!fsCalls[0][0].includes('pageSize') && !fsCalls[0][0].includes('?'));
    assert.ok(fsCalls[0][0].endsWith('/collectionGroups/' + state.required_index.collectionGroup + '/indexes'));
    assert.equal(r.firestore_index_metadata_http_status, 200); assert.equal(r.validation_status, 'PASS');
    // Malformed structure fails closed.
    global.fetch = async url => new Response(JSON.stringify(url.includes('firestore.googleapis.com') ? { indexes: 'bad' } : response(url)));
    r = await probe(state, base(state));
    assert.equal(r.firestore_index_metadata_read, 'FAIL'); assert.equal(r.firestore_index_metadata_error, 'ASSERTION_MISMATCH');
  } finally { global.fetch = original; restore(before); }
});
test('HTTP 400 is HTTP_400, other statuses are never NETWORK_ERROR, and structured Firestore errors are bounded', async () => {
  const before = { ...process.env }, original = global.fetch, calls = [];
  try {
    Object.assign(process.env, fixture());
    const body = { error: { code: 400, message: 'private-message-test-only', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'pageSize', description: 'private-description-test-only' }] }] } };
    global.fetch = async (url, options) => {
      calls.push([url, options]);
      return url.includes('firestore.googleapis.com') ? new Response(JSON.stringify(body), { status: 400 }) : new Response(JSON.stringify(response(url)));
    };
    const r = await probe(state, base(state));
    validate(r, schema());
    assert.equal(r.firestore_index_metadata_http_status, 400); assert.equal(r.firestore_index_metadata_error, 'HTTP_400');
    assert.equal(r.firestore_index_api_error_code, 400); assert.equal(r.firestore_index_api_error_status, 'INVALID_ARGUMENT');
    assert.equal(r.firestore_index_api_error_reason, 'FIELD_VIOLATION'); assert.equal(r.firestore_index_api_error_field, 'pageSize');
    assert.equal(calls.filter(([u]) => u.includes('firestore.googleapis.com')).length, 1);
    assert.ok(calls.every(([, o]) => o.method === 'GET' && o.body === undefined));
    assert.equal(r.validation_status, 'FAIL'); assert.equal(r.mutations_performed, false);
    for (const secret of SENTINELS) assert.ok(!JSON.stringify(r).includes(secret), secret);

    global.fetch = async url => url.includes('firestore.googleapis.com') ? new Response('not-json-private-test-only', { status: 400 }) : new Response(JSON.stringify(response(url)));
    let r2 = await probe(state, base(state));
    assert.equal(r2.firestore_index_api_error_status, 'ABSENT'); assert.ok(!JSON.stringify(r2).includes('not-json-private-test-only'));
    global.fetch = async url => url.includes('firestore.googleapis.com') ? new Response('{}', { status: 429 }) : new Response(JSON.stringify(response(url)));
    r2 = await probe(state, base(state));
    assert.equal(r2.firestore_index_metadata_error, 'HTTP_OTHER');
    global.fetch = async url => url.includes('firestore.googleapis.com') ? new Response(JSON.stringify({ error: { code: 403, status: 'x'.repeat(5000), details: [{ reason: 'private reason with spaces', fieldViolations: [{ field: 'a b/private-message-test-only' }] }] } }), { status: 403 }) : new Response(JSON.stringify(response(url)));
    r2 = await probe(state, base(state)); validate(r2, schema());
    assert.equal(r2.firestore_index_api_error_status, 'OTHER'); assert.equal(r2.firestore_index_api_error_reason, 'OTHER'); assert.equal(r2.firestore_index_api_error_field, 'OTHER');
    assert.ok(JSON.stringify(r2).length < 4000);
  } finally { global.fetch = original; restore(before); }
});
test('NETWORK_ERROR is only emitted for transport failures', () => {
  const source = fs.readFileSync('scripts/release/oidc-validate.cjs', 'utf8');
  assert.ok(!/return 'NETWORK_ERROR'/.test(source.slice(source.indexOf('function httpCategory'), source.indexOf('const GOOGLE_STATUSES'))));
});
test('Vercel failures yield controlled codes and MATCH/MISMATCH/ABSENT team result without raw team IDs or bodies', async () => {
  const before = { ...process.env }, original = global.fetch;
  try {
    Object.assign(process.env, fixture());
    const cases = [
      [{ error: { code: 'forbidden', message: 'private-message-test-only', teamId: state.vercel_team } }, 403, 'project_access_denied', 'team', 'MATCH'],
      [{ error: { code: 'forbidden', message: 'private-message-test-only', scope: 'team_OTHERFOREIGNID' } }, 403, 'team_scope_mismatch', 'team', 'MISMATCH'],
      [{ error: { code: 'forbidden', message: 'Not authorized: Trying to access resource under scope "x"' } }, 403, 'scope_mismatch', 'ABSENT', 'ABSENT'],
      [{ error: { code: 'forbidden', message: 'private-message-test-only' } }, 403, 'forbidden', 'ABSENT', 'ABSENT'],
      [{ error: { code: 'forbidden', invalidToken: true, message: 'private-message-test-only' } }, 403, 'invalid_token', 'ABSENT', 'ABSENT'],
      [{ error: { code: 'unauthorized', message: 'private-message-test-only' } }, 401, 'unauthorized', 'ABSENT', 'ABSENT'],
      [{ error: { code: 'weird_private_code', message: 'private-message-test-only' } }, 403, 'unknown', 'ABSENT', 'ABSENT']
    ];
    for (const [body, status, code, scopeType, teamMatch] of cases) {
      global.fetch = async url => url.includes('api.vercel.com') ? new Response(JSON.stringify(body), { status }) : new Response(JSON.stringify(response(url)));
      const r = await probe(state, base(state)); validate(r, schema());
      assert.equal(r.vercel_project_http_status, status); assert.equal(r.vercel_project_error, 'HTTP_' + status);
      assert.equal(r.vercel_api_error_code, code); assert.equal(r.vercel_api_error_scope_type, scopeType); assert.equal(r.vercel_api_error_team_match, teamMatch);
      for (const secret of [...SENTINELS, 'weird_private_code']) assert.ok(!JSON.stringify(r).includes(secret), secret);
      assert.equal(r.mutations_performed, false);
    }
    global.fetch = async url => url.includes('api.vercel.com') ? new Response('private-message-test-only', { status: 403 }) : new Response(JSON.stringify(response(url)));
    const r = await probe(state, base(state));
    assert.equal(r.vercel_api_error_code, 'ABSENT'); assert.ok(!JSON.stringify(r).includes('private-message-test-only'));
  } finally { global.fetch = original; restore(before); }
});
test('diagnostics patch adds no mutation path and leaves kill switch and production workflows untouched', () => {
  const script = fs.readFileSync('scripts/release/oidc-validate.cjs', 'utf8');
  assert.ok(!/require\('\.\/live|child_process|method: '(?:POST|PATCH|PUT|DELETE)'|\/documents\/|\/keys|iam\.googleapis/.test(script));
  assert.ok(!/console\.(log|error)\([^)]*(response|body|token|Authorization)/i.test(script.replace(/console\.error\('OIDC validation failed; details withheld'\)/, '')));
  assert.equal(base(state).mutations_performed, false);
  const before = { ...process.env };
  try { Object.assign(process.env, fixture()); assert.equal(base(state).production_release_enabled, false); } finally { restore(before); }
  for (const f of ['vdsen-release-prod', 'vdsen-rollback']) {
    const source = fs.readFileSync('.github/workflows/' + f + '.yml', 'utf8');
    assert.ok(source.includes('test "$PRODUCTION_RELEASE_ENABLED" = true'));
  }
});
