'use strict';
// Dedicated read-only path: no production release imports, client-data requests or mutation verbs.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { json, validate, environmentContract } = require('./lib.cjs');
const output = 'release-output/oidc-validation.json';
const state = () => validate(json('.release/vdsen-client.json'), json('.release/schema/release-state.schema.json'));
function base(s) {
  return {
    repository: 'vdsenasesoria-svg/vdsen-ecosistema', ref: 'refs/heads/codex/client-app-next',
    gcp_project: s.firebase_project, release_service_account: 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com',
    configuration: 'GAP', oidc_auth: 'GAP', project_metadata_read: 'GAP', firestore_index_metadata_read: 'GAP',
    firebase_rules_metadata_read: 'GAP', vercel_project_read: 'GAP', production_release_enabled: process.env.PRODUCTION_RELEASE_ENABLED === 'true',
    project_metadata_endpoint: 'GCP_PROJECT_METADATA', project_metadata_http_status: null, project_metadata_error: 'NONE',
    firestore_index_metadata_endpoint: 'FIRESTORE_INDEX_METADATA', firestore_index_metadata_http_status: null, firestore_index_metadata_error: 'NONE',
    firebase_rules_metadata_endpoint: 'FIREBASE_RULES_RELEASE_METADATA', firebase_rules_metadata_http_status: null, firebase_rules_metadata_error: 'NONE',
    vercel_project_endpoint: 'VERCEL_PROJECT_METADATA', vercel_project_http_status: null, vercel_project_error: 'NONE',
    kill_switch_configuration: process.env.PRODUCTION_RELEASE_ENABLED === 'false' ? 'EXPECTED_FALSE' : process.env.PRODUCTION_RELEASE_ENABLED === 'true' ? 'TRUE' : process.env.PRODUCTION_RELEASE_ENABLED === undefined || process.env.PRODUCTION_RELEASE_ENABLED === '' ? 'UNSET' : 'INVALID',
    mutations_performed: false, least_privilege_verification: 'GAP',
    least_privilege_note: 'Metadata success does not prove absence of IAM/key/client-data permissions; no destructive probes or client-data reads performed',
    validation_status: 'FAIL', error: null, timestamp: new Date().toISOString()
  };
}
class MetadataError extends Error {
  constructor(endpoint, httpStatus, category) {
    super(category);
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
    this.category = category;
  }
}
function httpCategory(status) {
  if ([401, 403, 404, 422].includes(status)) return 'HTTP_' + status;
  if (status >= 500) return 'HTTP_5XX';
  return 'NETWORK_ERROR';
}
function save(r) {
  validate(r, json('.release/schema/oidc-validation.schema.json'));
  fs.mkdirSync('release-output', { recursive: true });
  fs.writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
}
function configuration(s) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  assert.equal(process.env.GITHUB_REPOSITORY, 'vdsenasesoria-svg/vdsen-ecosistema');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/client-app-next');
  environmentContract(s); // Shared canonical configuration; intentionally no mutation kill-switch guard.
}
function init() {
  const s = state(), r = base(s);
  try { configuration(s); r.configuration = 'PASS'; }
  catch { r.configuration = 'FAIL'; r.error = 'CANONICAL_CONFIGURATION_OR_PUSH_CONTEXT_INVALID'; }
  save(r);
  return r.configuration === 'PASS' ? 0 : 1;
}
async function get(endpoint, url, token) {
  if (!token) throw new MetadataError(endpoint, null, 'HTTP_401');
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new MetadataError(endpoint, null, error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  }
  if (!response.ok) throw new MetadataError(endpoint, response.status, httpCategory(response.status));
  return { data: await response.json(), status: response.status }; // Failed bodies and credentials are never read, logged or persisted.
}
function diagnose(r, prefix, endpoint, httpStatus, error) {
  r[prefix + '_endpoint'] = endpoint;
  r[prefix + '_http_status'] = httpStatus;
  r[prefix + '_error'] = error;
}
async function probe(s, r) {
  configuration(s);
  assert.equal(process.env.OIDC_AUTH_OUTCOME, 'success');
  assert.ok(process.env.GOOGLE_ACCESS_TOKEN);
  r.configuration = 'PASS'; r.oidc_auth = 'PASS';
  const attempts = [
    ['project_metadata_read', 'project_metadata', async () => {
      const result = await get('GCP_PROJECT_METADATA', 'https://cloudresourcemanager.googleapis.com/v1/projects/' + s.firebase_project + '?fields=projectId', process.env.GOOGLE_ACCESS_TOKEN);
      if (result.data.projectId !== s.firebase_project) throw new MetadataError('GCP_PROJECT_METADATA', result.status, 'ASSERTION_MISMATCH');
      return { endpoint: 'GCP_PROJECT_METADATA', status: result.status };
    }],
    ['firestore_index_metadata_read', 'firestore_index_metadata', async () => {
      const result = await get('FIRESTORE_INDEX_METADATA', 'https://firestore.googleapis.com/v1/projects/' + s.firebase_project + '/databases/(default)/collectionGroups/' + s.required_index.collectionGroup + '/indexes?pageSize=1', process.env.GOOGLE_ACCESS_TOKEN);
      if (!(result.data.indexes === undefined || Array.isArray(result.data.indexes))) throw new MetadataError('FIRESTORE_INDEX_METADATA', result.status, 'ASSERTION_MISMATCH');
      return { endpoint: 'FIRESTORE_INDEX_METADATA', status: result.status };
    }],
    ['firebase_rules_metadata_read', 'firebase_rules_metadata', async () => {
      const release = await get('FIREBASE_RULES_RELEASE_METADATA', 'https://firebaserules.googleapis.com/v1/projects/' + s.firebase_project + '/releases/cloud.firestore?fields=name,rulesetName', process.env.GOOGLE_ACCESS_TOKEN);
      if (typeof release.data.rulesetName !== 'string' || !new RegExp('^projects/' + s.firebase_project + '/rulesets/[A-Za-z0-9_-]+$').test(release.data.rulesetName)) throw new MetadataError('FIREBASE_RULES_RELEASE_METADATA', release.status, 'ASSERTION_MISMATCH');
      const ruleset = await get('FIREBASE_RULESET_METADATA', 'https://firebaserules.googleapis.com/v1/' + release.data.rulesetName + '?fields=name,metadata', process.env.GOOGLE_ACCESS_TOKEN);
      if (ruleset.data.name !== release.data.rulesetName) throw new MetadataError('FIREBASE_RULESET_METADATA', ruleset.status, 'ASSERTION_MISMATCH');
      return { endpoint: 'FIREBASE_RULESET_METADATA', status: ruleset.status };
    }],
    ['vercel_project_read', 'vercel_project', async () => {
      const result = await get('VERCEL_PROJECT_METADATA', 'https://api.vercel.com/v9/projects/' + s.production_project + '?teamId=' + encodeURIComponent(s.vercel_team), process.env.VERCEL_TOKEN);
      if (result.data.id !== s.production_project || result.data.accountId !== s.vercel_team) throw new MetadataError('VERCEL_PROJECT_METADATA', result.status, 'ASSERTION_MISMATCH');
      return { endpoint: 'VERCEL_PROJECT_METADATA', status: result.status };
    }]
  ];
  await Promise.all(attempts.map(async ([key, prefix, run]) => {
    try {
      const result = await run(); r[key] = 'PASS'; diagnose(r, prefix, result.endpoint, result.status, 'NONE');
    } catch (error) {
      r[key] = 'FAIL';
      diagnose(r, prefix, error instanceof MetadataError ? error.endpoint : r[prefix + '_endpoint'], error instanceof MetadataError ? error.httpStatus : null, error instanceof MetadataError ? error.category : 'NETWORK_ERROR');
    }
  }));
  r.validation_status = attempts.every(([key]) => r[key] === 'PASS') ? 'PASS' : 'FAIL';
  if (r.validation_status === 'FAIL') r.error = 'METADATA_CAPABILITY_VALIDATION_FAILED';
  return r;
}
async function run() {
  const s = state(), r = fs.existsSync(output) ? json(output) : base(s);
  try { await probe(s, r); }
  catch { r.validation_status = 'FAIL'; r.oidc_auth = 'FAIL'; r.error = 'CANONICAL_CONFIGURATION_OR_OIDC_AUTH_FAILED'; }
  save(r);
  return r.validation_status === 'PASS' ? 0 : 1;
}
function finalize() {
  const r = fs.existsSync(output) ? json(output) : base(state());
  if (process.env.OIDC_AUTH_OUTCOME !== 'success') {
    r.oidc_auth = r.configuration === 'FAIL' ? 'GAP' : 'FAIL';
    r.validation_status = 'FAIL'; r.error ||= 'OIDC_AUTH_NOT_COMPLETED';
  }
  if (process.env.VALIDATION_OUTCOME !== 'success') {
    r.validation_status = 'FAIL'; r.error ||= 'VALIDATION_NOT_COMPLETED';
  }
  save(r);
}
if (require.main === module) {
  const command = { init, run, finalize }[process.argv[2]];
  if (!command) { console.error('Expected init, run or finalize'); process.exitCode = 1; }
  else Promise.resolve().then(command).then(code => { process.exitCode = code || 0; }).catch(() => { console.error('OIDC validation failed; details withheld'); process.exitCode = 1; });
}
module.exports = { base, configuration, probe, init, run, finalize };
