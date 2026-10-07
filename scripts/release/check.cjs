'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { hash, json, git, validate, noSecrets } = require('./lib.cjs');
const { validateBaseline } = require('./baseline.cjs');
const deployedProduct = require('./deployed-product.cjs');
function workflowContract() {
  for (const name of ['vdsen-release-prod', 'vdsen-rollback', 'vdsen-oidc-validate']) {
    const source = fs.readFileSync('.github/workflows/' + name + '.yml', 'utf8');
    assert.ok(source.includes('environment: Production'), 'Canonical Environment required');
    assert.ok(!source.includes('environment: production'), 'Duplicate lowercase Environment forbidden');
    for (const variable of ['GCP_PROJECT_ID', 'GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_RELEASE_SERVICE_ACCOUNT', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID', 'PRODUCTION_RELEASE_ENABLED']) assert.ok(source.includes('vars.' + variable), 'Missing canonical variable: ' + variable);
    assert.ok(source.includes('secrets.VERCEL_TOKEN'));
    if (name !== 'vdsen-oidc-validate') assert.ok(source.includes('test "$PRODUCTION_RELEASE_ENABLED" = true'));
    const allowed = new Set(['GCP_PROJECT_ID', 'GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_RELEASE_SERVICE_ACCOUNT', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID', 'PRODUCTION_RELEASE_ENABLED']);
    for (const match of source.matchAll(/vars\.([A-Z_]+)/g)) assert.ok(allowed.has(match[1]), 'Noncanonical variable');
    for (const match of source.matchAll(/secrets\.([A-Z_]+)/g)) assert.equal(match[1], 'VERCEL_TOKEN');
    assert.ok(!source.includes('credentials_json:'));
  }
  const source = fs.readFileSync('.github/workflows/vdsen-release-check.yml', 'utf8');
  assert.ok(!/secrets\.|id-token: write|environment:|live\.cjs|google-github-actions\/auth/.test(source), 'Repo check must not need live credentials');
  // The APP-ONLY lane is separate by contract: its own kill switch, and no path into the
  // Firestore rules lane. It must never consult PRODUCTION_RELEASE_ENABLED.
  const app = fs.readFileSync('.github/workflows/vdsen-app-release-prod.yml', 'utf8');
  assert.ok(app.includes('environment: Production'), 'App lane must use the canonical Environment');
  assert.ok(!app.includes('environment: production'));
  // The lane must enforce its own switch. Accept either the plain test or the explicit
  // negative-guard form, so hardening the message does not silently drop the check.
  assert.ok(app.includes('test "$CLIENT_APP_RELEASE_ENABLED" = true') || app.includes('"$CLIENT_APP_RELEASE_ENABLED" != "true"'),
    'App lane needs its own kill switch');
  assert.ok(/\$CLIENT_APP_RELEASE_ENABLED/.test(app), 'App lane must actually read its kill switch');
  // Check actual USE, not prose: the workflow explains the rule in a comment, so the name may
  // appear as text. What must never appear is a READ of it.
  assert.ok(!/vars\.PRODUCTION_RELEASE_ENABLED/.test(app), 'App lane must not read the rules kill switch');
  assert.ok(app.includes('scripts/release/app-live.cjs'), 'App lane must use the app-only tooling');
  // Exact path, not a substring: 'live.cjs' also matches 'app-live.cjs'.
  assert.ok(!app.includes('scripts/release/live.cjs'), 'App lane must not run the rules release path');
  assert.ok(!app.includes('firestore.rules'), 'App lane must not deploy rules');
  for (const match of app.matchAll(/secrets\.([A-Z_]+)/g)) assert.equal(match[1], 'VERCEL_TOKEN');
  assert.ok(!app.includes('credentials_json:'));
  const appAllowed = new Set(['VERCEL_PROJECT_ID', 'VERCEL_ORG_ID', 'CLIENT_APP_RELEASE_ENABLED']);
  for (const match of app.matchAll(/vars\.([A-Z_]+)/g)) assert.ok(appAllowed.has(match[1]), 'App lane noncanonical variable: ' + match[1]);
  console.log('CLIENT_APP_KILL_SWITCH=' + (process.env.CLIENT_APP_RELEASE_ENABLED === 'true' ? 'true (release lane armed)' : 'false (disabled or unavailable; default false)'));
  console.log('PRODUCTION_KILL_SWITCH=' + (process.env.PRODUCTION_RELEASE_ENABLED === 'true' ? 'true (repo checks only)' : 'false (disabled or unavailable; default false)'));
}
function check(runtime = process.env.RUNTIME_SHA) {
  const state = validate(json('.release/vdsen-client.json'), json('.release/schema/release-state.schema.json'));
  validateBaseline(json('.release/known-baseline-failures.json'));
  workflowContract();
  runtime = resolveRuntime(runtime, state);
  git('cat-file', '-e', runtime + '^{commit}');
  git('merge-base', '--is-ancestor', runtime, 'origin/codex/client-app-next');
  const ref = process.env.GITHUB_REF;
  if (ref && process.env.GITHUB_EVENT_NAME !== 'pull_request') assert.equal(ref, 'refs/heads/codex/client-app-next');
  if (!ref) assert.equal(git('branch', '--show-current').trim(), 'codex/client-app-next');
  // Provenance of the DEPLOYED ARTIFACT is proven by the frozen deployed-product manifest,
  // not by forbidding product work on the branch. `runtime_sha` is the commit of the app
  // that is actually deployed; requiring HEAD to equal it made every product improvement
  // require a production deploy. The manifest pins the served surface at that deployed
  // commit and is re-verified here. The LIVE app is verified against the real deployment
  // inside the release workflow (live.cjs verifyDeployment + smoke), where credentials exist.
  const deployed = json(deployedProduct.MANIFEST);
  assert.equal(deployed.runtime_sha, state.runtime_sha, 'Deployed product manifest does not describe state.runtime_sha');
  deployedProduct.verify(state.runtime_sha, deployedProduct.MANIFEST);
  // Check committed bytes to avoid Windows checkout line ending conversions.
  assert.equal(hash(git('show', runtime + ':firestore.rules')), state.rules_transition.target_sha256);
  assert.equal(hash(git('show', 'HEAD:firestore.rules')), state.rules_transition.target_sha256);
  const indexes = JSON.parse(git('show', runtime + ':firestore.indexes.json'));
  assert.deepEqual(indexes.indexes, [state.required_index]);
  assert.deepEqual(indexes.fieldOverrides, []);
  assert.deepEqual(JSON.parse(git('show', runtime + ':package.json')), json('package.json'));
  for (const module of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../../assets/' + module + '.js').NUMERIC_APPLY_ENABLED, false, module);
  }
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  for (const file of files) {
    assert.ok(!/(^|\/)(?:\.env(?:\.local)?|.*\.(?:pem|p12|pfx)|gha-creds-.*\.json)$/.test(file), 'Forbidden credential file: ' + file);
    const bytes = fs.readFileSync(file);
    if (!bytes.includes(0)) noSecrets(bytes.toString('utf8'), file);
  }
  console.log('PASS release state / deployed-product manifest / numeric flag / rules / index / package / tracked secret patterns');
  return state;
}
function resolveRuntime(requested, state) {
  const runtime = requested || state.runtime_sha; // Push/PR use pinned state, never branch HEAD/latest.
  assert.match(runtime, /^[0-9a-f]{40}$/);
  assert.equal(runtime, state.runtime_sha, 'Runtime must be the reviewed state SHA');
  return runtime;
}
if (require.main === module) { try { check(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { check, workflowContract, resolveRuntime };
