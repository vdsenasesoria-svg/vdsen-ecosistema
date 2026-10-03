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
    kill_switch_configuration: process.env.PRODUCTION_RELEASE_ENABLED === 'false' ? 'EXPECTED_FALSE' : process.env.PRODUCTION_RELEASE_ENABLED === 'true' ? 'TRUE' : process.env.PRODUCTION_RELEASE_ENABLED === undefined || process.env.PRODUCTION_RELEASE_ENABLED === '' ? 'UNSET' : 'INVALID',
    mutations_performed: false, least_privilege_verification: 'GAP',
    least_privilege_note: 'Metadata success does not prove absence of IAM/key/client-data permissions; no destructive probes or client-data reads performed',
    validation_status: 'FAIL', error: null, timestamp: new Date().toISOString()
  };
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
async function get(url, token) {
  assert.ok(token, 'Missing workflow credential');
  const response = await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, 'Metadata request denied');
  return response.json(); // No response content or credentials are logged or persisted.
}
async function probe(s, r) {
  configuration(s);
  assert.equal(process.env.OIDC_AUTH_OUTCOME, 'success');
  assert.ok(process.env.GOOGLE_ACCESS_TOKEN);
  r.configuration = 'PASS'; r.oidc_auth = 'PASS';
  const attempts = [
    ['project_metadata_read', async () => {
      const project = await get('https://cloudresourcemanager.googleapis.com/v1/projects/' + s.firebase_project + '?fields=projectId', process.env.GOOGLE_ACCESS_TOKEN);
      assert.equal(project.projectId, s.firebase_project);
    }],
    ['firestore_index_metadata_read', async () => {
      const indexes = await get('https://firestore.googleapis.com/v1/projects/' + s.firebase_project + '/databases/(default)/collectionGroups/' + s.required_index.collectionGroup + '/indexes?pageSize=1', process.env.GOOGLE_ACCESS_TOKEN);
      assert.ok(indexes.indexes === undefined || Array.isArray(indexes.indexes));
    }],
    ['firebase_rules_metadata_read', async () => {
      const release = await get('https://firebaserules.googleapis.com/v1/projects/' + s.firebase_project + '/releases/cloud.firestore?fields=name,rulesetName', process.env.GOOGLE_ACCESS_TOKEN);
      assert.equal(typeof release.rulesetName, 'string');
      assert.ok(new RegExp('^projects/' + s.firebase_project + '/rulesets/[A-Za-z0-9_-]+$').test(release.rulesetName));
      const ruleset = await get('https://firebaserules.googleapis.com/v1/' + release.rulesetName + '?fields=name,metadata', process.env.GOOGLE_ACCESS_TOKEN);
      assert.equal(ruleset.name, release.rulesetName);
    }],
    ['vercel_project_read', async () => {
      const project = await get('https://api.vercel.com/v9/projects/' + s.production_project + '?teamId=' + encodeURIComponent(s.vercel_team), process.env.VERCEL_TOKEN);
      assert.equal(project.id, s.production_project);
      assert.equal(project.accountId, s.vercel_team);
    }]
  ];
  await Promise.all(attempts.map(async ([key, run]) => {
    try { await run(); r[key] = 'PASS'; }
    catch { r[key] = 'FAIL'; }
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
