'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { validate, hash, json, git, indexMatches, verifyDeployment, noSecrets } = require('../scripts/release/lib.cjs');
const { verifyIndex, restoreRules, recover, workflowGuard } = require('../scripts/release/live.cjs');
const state = json('.release/vdsen-client.json');
const clone = x => JSON.parse(JSON.stringify(x));
test('release state rejects numeric activation, missing gates and unknown project', () => {
  const schema = json('.release/schema/release-state.schema.json');
  validate(state, schema);
  for (const mutate of [x => { x.numeric_apply_enabled = true; }, x => { delete x.preconditions; }, x => { x.firebase_project = 'vdsen-planes'; }, x => { x.secret = 'value'; }]) {
    const bad = clone(state); mutate(bad); assert.throws(() => validate(bad, schema));
  }
  assert.throws(() => validate({}, { unknownKeyword: true }));
});
test('index identity is ordered, scope-specific and independent of JSON key order', () => {
  const live = clone(state.required_index);
  live.fields = live.fields.map(x => ({ order: x.order, fieldPath: x.fieldPath }));
  live.fields.push({ fieldPath: '__name__', order: 'DESCENDING' });
  assert.equal(indexMatches(state.required_index, live), true);
  live.fields.reverse(); assert.equal(indexMatches(state.required_index, live), false);
  assert.equal(indexMatches(state.required_index, { ...state.required_index, queryScope: 'COLLECTION_GROUP' }), false);
});
test('deployment provenance binds project, SHA, repository and ref', () => {
  const d = { projectId: state.production_project, readyState: 'READY', meta: { githubCommitSha: state.runtime_sha, githubCommitRef: 'codex/client-app-next', githubCommitOrg: 'vdsenasesoria-svg', githubCommitRepo: 'vdsen-ecosistema' } };
  verifyDeployment(d, state, state.runtime_sha, 'codex/client-app-next');
  for (const mutate of [x => { x.projectId = 'other'; }, x => { x.readyState = 'ERROR'; }, x => { x.meta.githubCommitSha = '0'.repeat(40); }, x => { x.meta.githubCommitRepo = 'fork'; }]) {
    const bad = clone(d); mutate(bad); assert.throws(() => verifyDeployment(bad, state, state.runtime_sha));
  }
});
test('secret patterns reject private material without exposing it, allow public config and PEM documentation', () => {
  noSecrets('AIza-public-web-key; -----BEGIN PRIVATE KEY-----â€¦-----END PRIVATE KEY-----', 'documentation');
  for (const text of ['gh' + 'p_' + 'x'.repeat(36), 's' + 'k-proj-' + 'x'.repeat(40), '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(40)]) {
    assert.throws(() => noSecrets(text, 'fixture'), /value withheld/);
  }
});
test('production cannot run from an agent shell or noncanonical ref', () => {
  const before = { ...process.env };
  try {
    process.env.GITHUB_ACTIONS = 'false'; assert.throws(workflowGuard);
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', PRODUCTION_RELEASE_ENABLED: 'true' });
    assert.throws(workflowGuard);
    process.env.GITHUB_REF = 'refs/heads/codex/client-app-next'; process.env.PRODUCTION_RELEASE_ENABLED = 'false'; assert.throws(workflowGuard);
  } finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
});
test('live index preflight follows pagination and blocks BUILDING before mutation', async () => {
  const before = global.fetch, token = process.env.GOOGLE_ACCESS_TOKEN;
  const requests = [];
  process.env.GOOGLE_ACCESS_TOKEN = 'test-only';
  try {
    global.fetch = async (url, options) => {
      requests.push([url, options.method]);
      const data = url.includes('pageToken=next') ? { indexes: [{ ...state.required_index, state: 'READY' }] } : { indexes: [], nextPageToken: 'next' };
      return new Response(JSON.stringify(data));
    };
    assert.equal(await verifyIndex(state), 'READY');
    assert.equal(requests.length, 2); assert.ok(requests.every(x => x[1] === 'GET' && !x[0].includes('pageSize')));
    global.fetch = async () => new Response(JSON.stringify({ indexes: [{ ...state.required_index, state: 'CREATING' }] }));
    await assert.rejects(verifyIndex(state), /not READY/);
    global.fetch = async () => new Response(JSON.stringify({ indexes: [{ ...state.required_index, state: 'READY' }, { ...state.required_index, state: 'READY' }] }));
    await assert.rejects(verifyIndex(state), /exactly one/);
  } finally { global.fetch = before; if (token === undefined) delete process.env.GOOGLE_ACCESS_TOKEN; else process.env.GOOGLE_ACCESS_TOKEN = token; }
});
test('recovery never calls Vercel if restored rules verification fails', async () => {
  const before = global.fetch, token = process.env.GOOGLE_ACCESS_TOKEN;
  const requests = [];
  process.env.GOOGLE_ACCESS_TOKEN = 'test-only';
  const oldContent = git('show', state.rollback_runtime_sha + ':firestore.rules');
  const source = { files: [{ name: 'firestore.rules', content: oldContent }] };
  const snapshot = { state, old_rules: { source, sha256: hash(oldContent) } };
  try {
    global.fetch = async (url, options) => {
      requests.push([url, options.method]);
      let data = {};
      if (options.method === 'POST') data = { name: 'projects/vdsen-ecosistema/rulesets/restored' };
      else if (url.includes('/releases/') && options.method === 'GET') data = { rulesetName: 'projects/vdsen-ecosistema/rulesets/restored' };
      else if (url.includes('/rulesets/restored')) data = { source: { files: [{ content: 'wrong-source' }] } };
      return new Response(JSON.stringify(data));
    };
    const r = {};
    await assert.rejects(recover(state, snapshot, r), /Live rules source mismatch/);
    assert.equal(r.rollback_status, 'FAIL');
    assert.ok(requests.every(x => !x[0].includes('vercel.com')));
    assert.deepEqual(requests.map(x => x[1]), ['POST', 'PATCH', 'GET', 'GET']);
    const payload = clone(snapshot); payload.old_rules.sha256 = '0'.repeat(64);
    const count = requests.length;
    await assert.rejects(restoreRules(state, payload)); assert.equal(requests.length, count);
  } finally { global.fetch = before; if (token === undefined) delete process.env.GOOGLE_ACCESS_TOKEN; else process.env.GOOGLE_ACCESS_TOKEN = token; }
});
test('result schema preserves authenticated smoke GAP and rejects invented success statuses', () => {
  const schema = json('.release/schema/release-result.schema.json');
  assert.ok(schema.properties.write_smoke.enum.includes('GAP'));
  assert.throws(() => validate('ASSUMED_PASS', schema.properties.write_smoke));
  const workflows = fs.readdirSync('.github/workflows').map(f => fs.readFileSync('.github/workflows/' + f, 'utf8'));
  for (const wf of workflows) {
    assert.ok(!wf.includes('pull_request_target'));
    for (const m of wf.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/);
  }
});
test('successful recovery verifies restored rules before switching app and compares the baseline runtime', async () => {
  const before = global.fetch, tokens = { GOOGLE_ACCESS_TOKEN: process.env.GOOGLE_ACCESS_TOKEN, VERCEL_TOKEN: process.env.VERCEL_TOKEN };
  Object.assign(process.env, { GOOGLE_ACCESS_TOKEN: 'test-only', VERCEL_TOKEN: 'test-only' });
  const requests = []; let switched = false;
  const oldContent = git('show', state.rollback_runtime_sha + ':firestore.rules');
  const source = { files: [{ name: 'firestore.rules', content: oldContent }] };
  const snapshot = { state, old_rules: { source, sha256: hash(oldContent) } };
  try {
    global.fetch = async (url, options = {}) => {
      requests.push([url, options.method || 'GET']);
      if (url.startsWith(state.production_origin + '/')) {
        const path = new URL(url).pathname.slice(1);
        return new Response(git('show', state.rollback_runtime_sha + ':' + path));
      }
      let data = {};
      if (url.includes('firebaserules.googleapis.com')) {
        if (options.method === 'POST') data = { name: 'projects/vdsen-ecosistema/rulesets/restored' };
        else if (url.includes('/releases/') && options.method === 'GET') data = { rulesetName: 'projects/vdsen-ecosistema/rulesets/restored' };
        else if (url.includes('/rulesets/restored')) data = { source };
      } else if (url.includes('/aliases/')) data = { projectId: state.production_project, deployment: { id: switched ? state.rollback_deployment : state.target_deployment } };
      else if (url.includes('/rollback/')) switched = true;
      else if (url.includes('/deployments/')) data = { projectId: state.production_project, readyState: 'READY', meta: { githubCommitSha: state.rollback_runtime_sha, githubCommitOrg: 'vdsenasesoria-svg', githubCommitRepo: 'vdsen-ecosistema' } };
      return new Response(JSON.stringify(data));
    };
    const r = {}; await recover(state, snapshot, r);
    assert.equal(r.rollback_status, 'PASS'); assert.equal(r.production_deployment, state.rollback_deployment);
    const ruleVerified = requests.findIndex(x => x[0].includes('/rulesets/restored') && x[1] === 'GET');
    const appMutation = requests.findIndex(x => x[0].includes('/rollback/') && x[1] === 'POST');
    assert.ok(ruleVerified >= 0 && appMutation > ruleVerified);
    assert.equal(requests.filter(x => x[0].startsWith(state.production_origin)).length, 4);
  } finally {
    global.fetch = before;
    for (const [key, value] of Object.entries(tokens)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
test('failure-result CLI emits a schema-valid artifact even when preflight never ran', () => {
  const parent = fs.realpathSync(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(parent, 'vdsen-release-result-test-'));
  try {
    fs.mkdirSync(path.join(temp, '.release/schema'), { recursive: true });
    for (const file of ['vdsen-client.json', 'schema/release-state.schema.json', 'schema/release-result.schema.json']) fs.copyFileSync(path.join('.release', file), path.join(temp, '.release', file));
    const run = spawnSync(process.execPath, [path.resolve('scripts/release/live.cjs'), 'release-result'], { cwd: temp, env: { ...process.env, GITHUB_RUN_ID: 'local-test-only' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const emitted = json(path.join(temp, 'release-output/result.json'));
    validate(emitted, json('.release/schema/release-result.schema.json'));
    assert.equal(emitted.release_status, 'FAIL'); assert.equal(emitted.write_smoke, 'GAP'); assert.equal(emitted.main_unchanged, false);
  } finally {
    assert.equal(path.dirname(temp), parent);
    assert.ok(path.basename(temp).startsWith('vdsen-release-result-test-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('rules_only recovery restores verified rules without any Vercel request and fails closed if the approved app changed', async () => {
  const before = global.fetch, tokens = { GOOGLE_ACCESS_TOKEN: process.env.GOOGLE_ACCESS_TOKEN, VERCEL_TOKEN: process.env.VERCEL_TOKEN };
  Object.assign(process.env, { GOOGLE_ACCESS_TOKEN: 'test-only', VERCEL_TOKEN: 'test-only' });
  const requests = []; let appDeployment = state.production_deployment;
  const oldContent = git('show', state.rollback_runtime_sha + ':firestore.rules');
  const source = { files: [{ name: 'firestore.rules', content: oldContent }] };
  const snapshot = { state, old_rules: { source, sha256: hash(oldContent) } };
  try {
    global.fetch = async (url, options = {}) => {
      requests.push([url, options.method || 'GET']);
      if (url.startsWith(state.production_origin + '/')) return new Response(git('show', state.runtime_sha + ':' + new URL(url).pathname.slice(1)));
      let data = {};
      if (url.includes('firebaserules.googleapis.com')) {
        if (options.method === 'POST') data = { name: 'projects/vdsen-ecosistema/rulesets/restored' };
        else if (url.includes('/releases/') && options.method === 'GET') data = { rulesetName: 'projects/vdsen-ecosistema/rulesets/restored' };
        else if (url.includes('/rulesets/restored')) data = { source };
      } else if (url.includes('/aliases/')) data = { projectId: state.production_project, deployment: { id: appDeployment } };
      return new Response(JSON.stringify(data));
    };
    const r = {}; await recover(state, snapshot, r, { restoreApp: false });
    assert.equal(r.rollback_status, 'PASS'); assert.equal(r.production_deployment, state.production_deployment);
    assert.ok(requests.every(x => !x[0].includes('/rollback/') && !/\/deployments/.test(x[0]) && (x[0].includes('api.vercel.com') ? x[1] === 'GET' : true)));
    appDeployment = state.rollback_deployment;
    await assert.rejects(recover(state, snapshot, {}, { restoreApp: false }), /Approved app changed/);
  } finally {
    global.fetch = before;
    for (const [key, value] of Object.entries(tokens)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
test('release apply path is rules_only: pinned immutable provenance, no deploy/promote, no app restore on failure, never reads main', () => {
  const src = fs.readFileSync('scripts/release/live.cjs', 'utf8');
  const apply = src.slice(src.indexOf('async function apply()'), src.indexOf('async function rollback()'));
  assert.ok(!/switchApp|\/v13\/deployments'|\/promote|\/rollback\//.test(apply));
  assert.ok(apply.includes('restoreApp: false'));
  assert.ok(apply.includes("git('show', s.runtime_sha + ':firestore.rules')") && apply.includes('s.rules_transition.target_sha256'));
  assert.ok(!/main:firestore|origin\/main:|HEAD:firestore\.rules|\blatest\b/i.test(src));
  assert.equal(state.release_mode, 'rules_only'); assert.equal(state.numeric_apply_enabled, false);
  // Rollback order and pinned identities.
  const rec = src.slice(src.indexOf('async function recover'), src.indexOf('async function apply()'));
  assert.ok(rec.indexOf('restoreRules(') < rec.indexOf('switchApp('));
  assert.equal(state.rollback_deployment, 'dpl_3RKY7UixzLDr9iK4NQ6VcKriz3Cn'); assert.equal(state.rollback_runtime_sha, 'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c');
  assert.equal(state.runtime_sha, 'd7bb71521d750eafd46a15fdd3c6ee157d4bd4cf');
  assert.equal(state.rules_transition.rollback_order, 'rules_then_app');
});
test('kill switch off, missing runtime SHA or missing gate/rollback artifacts stop apply and prepare before any network request', async () => {
  const { apply, prepare } = require('../scripts/release/live.cjs');
  const before = { ...process.env }, original = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/codex/client-app-next', RUNTIME_SHA: state.runtime_sha, GOOGLE_ACCESS_TOKEN: 'test-only', VERCEL_TOKEN: 'test-only' });
    for (const value of ['false', '', undefined]) {
      if (value === undefined) delete process.env.PRODUCTION_RELEASE_ENABLED; else process.env.PRODUCTION_RELEASE_ENABLED = value;
      await assert.rejects(apply()); await assert.rejects(prepare());
    }
    process.env.PRODUCTION_RELEASE_ENABLED = 'true';
    for (const sha of ['', '0'.repeat(40)]) { process.env.RUNTIME_SHA = sha; await assert.rejects(apply()); await assert.rejects(prepare()); }
    process.env.RUNTIME_SHA = state.runtime_sha;
    await assert.rejects(apply()); await assert.rejects(prepare()); // no gate results / rollback.json / READY state in this checkout
    assert.equal(calls, 0);
  } finally { global.fetch = original; for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
});
