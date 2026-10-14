'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { validate, hash, json, git, indexMatches, verifyDeployment, noSecrets } = require('../scripts/release/lib.cjs');
const { verifyIndex, restoreRules, recover, workflowGuard } = require('../scripts/release/live.cjs');
const deployedProduct = require('../scripts/release/deployed-product.cjs');
const state = json('.release/vdsen-client.json');
const clone = x => JSON.parse(JSON.stringify(x));

test('deployed product manifest is honest and the release check no longer forbids product work', () => {
  const manifest = json(deployedProduct.MANIFEST);
  // The manifest describes the DEPLOYED runtime, and the state agrees with it.
  assert.equal(manifest.schema, 'vdsen-deployed-product-v1');
  assert.equal(manifest.runtime_sha, state.runtime_sha, 'manifest must describe state.runtime_sha');
  // It is not unverified metadata: every DEPLOYED path is re-hashed at that runtime. The manifest
  // records the deployed surface only — candidate-only paths are deliberately absent from it, which
  // is what lets a candidate add served assets without a production deploy.
  assert.deepEqual(Object.keys(manifest.files).sort(), [...deployedProduct.DEPLOYED].sort());
  deployedProduct.verify(state.runtime_sha, deployedProduct.MANIFEST);
  // The served surface really covers what a client downloads.
  for (const must of ['vdsen-cliente.html', 'vdsen-coach.html', 'ficha-publica.html', 'sw.js', 'firestore.rules']) {
    assert.ok(deployedProduct.SERVED.includes(must), 'served surface must include ' + must);
  }
  // The deployed rules are the reviewed target rules — independent cross-check.
  assert.equal(manifest.files['firestore.rules'], state.rules_transition.target_sha256);
  // DECOUPLING: check() proves provenance from the manifest, never by demanding that HEAD
  // equal the deployed runtime. That equality is what made every product improvement
  // require a production deploy, and it is logically impossible for an undeployed candidate.
  const src = fs.readFileSync('scripts/release/check.cjs', 'utf8');
  assert.ok(src.includes('deployedProduct.verify'), 'check must verify the deployed product manifest');
  assert.ok(!src.includes('Runtime/package mismatch'), 'the runtime-vs-HEAD product ban must be gone');
  assert.ok(!/git\('diff',\s*'--name-only',\s*runtime,\s*'HEAD'\)/.test(src), 'check must not diff the deployed runtime against HEAD');
  // Tampering with the manifest still fails: the guard protects, it is not a rubber stamp.
  const tampered = clone(manifest);
  tampered.files['vdsen-cliente.html'] = 'f'.repeat(64);
  const tmp = path.join(os.tmpdir(), 'dpm-tampered-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(tampered));
  try { assert.throws(() => deployedProduct.verify(state.runtime_sha, tmp), /does not describe the deployed runtime/); }
  finally { fs.rmSync(tmp, { force: true }); }
  const wrongRuntime = clone(manifest); wrongRuntime.runtime_sha = '0'.repeat(40);
  const tmp2 = path.join(os.tmpdir(), 'dpm-wrong-' + process.pid + '.json');
  fs.writeFileSync(tmp2, JSON.stringify(wrongRuntime));
  try { assert.throws(() => deployedProduct.verify(state.runtime_sha, tmp2), /!= deployed/); }
  finally { fs.rmSync(tmp2, { force: true }); }
});
test('release state rejects numeric activation, missing gates and unknown project', () => {
  const schema = json('.release/schema/release-state.schema.json');
  validate(state, schema);
  for (const mutate of [x => { x.numeric_apply_enabled = true; }, x => { delete x.preconditions; }, x => { x.firebase_project = 'vdsen-planes'; }, x => { x.secret = 'value'; }]) {
    const bad = clone(state); mutate(bad); assert.throws(() => validate(bad, schema));
  }
  assert.throws(() => validate({}, { unknownKeyword: true }));
});
test('release state requires the decoupled RULES rollback provenance fields and rejects malformed values', () => {
  const schema = json('.release/schema/release-state.schema.json');
  validate(state, schema);
  for (const drop of ['rollback_sha256', 'rollback_source_path']) {
    const bad = clone(state); delete bad.rules_transition[drop];
    assert.throws(() => validate(bad, schema), undefined, 'missing ' + drop + ' must be rejected');
  }
  for (const value of ['nothex', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(65), '']) {
    const bad = clone(state); bad.rules_transition.rollback_sha256 = value;
    assert.throws(() => validate(bad, schema), undefined, 'malformed rollback_sha256 must be rejected: ' + value);
  }
  for (const value of ['firestore.rules', '.release/rollback/firestore.rules', '.release/rollback/firestore.rules.' + 'a'.repeat(64) + '.txt', '.release/rollback/' + 'a'.repeat(64) + '.rules', '']) {
    const bad = clone(state); bad.rules_transition.rollback_source_path = value;
    assert.throws(() => validate(bad, schema), undefined, 'malformed rollback_source_path must be rejected: ' + value);
  }
  assert.equal(state.rules_transition.rollback_source_path, '.release/rollback/firestore.rules.' + state.rules_transition.rollback_sha256 + '.rules');
  assert.notEqual(state.rules_transition.rollback_sha256, hash(git('show', state.rollback_runtime_sha + ':firestore.rules')));
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
  const oldContent = fs.readFileSync(state.rules_transition.rollback_source_path, 'utf8');
  const source = { files: [{ name: 'firestore.rules', content: oldContent }] };
  const snapshot = { package_sha: git('rev-parse', 'HEAD').trim(), state, old_rules: { source, sha256: hash(oldContent) } };
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
  // RULES rollback source is the reviewed immutable reference (decoupled from the app runtime).
  const oldContent = fs.readFileSync(state.rules_transition.rollback_source_path, 'utf8');
  const source = { files: [{ name: 'firestore.rules', content: oldContent }] };
  const snapshot = { package_sha: git('rev-parse', 'HEAD').trim(), state, old_rules: { source, sha256: hash(oldContent) } };
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
    // The smoke surface is 4 fixed paths plus one CONDITIONAL path that is only fetched when the
    // runtime commit actually tracks it (`assets/progression-effective-prescription.js`). The
    // previous runtime did not, so this was a hardcoded 4; the deployed app release does, so a
    // literal would silently pin a stale snapshot rather than the documented behaviour.
    const smokePaths = ['vdsen-cliente.html', 'vdsen-coach.html', 'ficha-publica.html', 'sw.js'];
    if (git('ls-tree', '-r', '--name-only', state.rollback_runtime_sha).split('\n').includes('assets/progression-effective-prescription.js')) {
      smokePaths.push('assets/progression-effective-prescription.js');
    }
    assert.equal(requests.filter(x => x[0].startsWith(state.production_origin)).length, smokePaths.length);
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
  const oldContent = fs.readFileSync(state.rules_transition.rollback_source_path, 'utf8');
  const source = { files: [{ name: 'firestore.rules', content: oldContent }] };
  const snapshot = { package_sha: git('rev-parse', 'HEAD').trim(), state, old_rules: { source, sha256: hash(oldContent) } };
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
  // The state now records an APP release, so the mode is app_only. The assertions above still prove
  // live.cjs (the RULES lane) cannot deploy, promote switch the app or read main, so this does not
  // relax anything: it only stops the test from pinning a stale snapshot.
  assert.equal(state.release_mode, 'app_only'); assert.equal(state.numeric_apply_enabled, false);
  // Rollback order and pinned identities.
  const rec = src.slice(src.indexOf('async function recover'), src.indexOf('async function apply()'));
  assert.ok(rec.indexOf('restoreRules(') < rec.indexOf('switchApp('));
  assert.equal(state.rollback_deployment, 'dpl_FngrtpodSKHZ9aPk75aA5SS7JGnB'); assert.equal(state.rollback_runtime_sha, 'd7bb71521d750eafd46a15fdd3c6ee157d4bd4cf');
  assert.equal(state.runtime_sha, '8365410cf7f09427c79ead77aa4f769c16e9a803');
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

// ─────────────────────────────────────────────────────────────────────────────
// Deployed surface vs CANDIDATE surface.
//
// `SERVED` used to be one registry that `verify()` required entirely at the deployed runtime commit.
// That coupled product development to a production deploy: the moment a candidate added a served
// asset the frozen manifest could not verify, and the only way out was to regenerate the manifest
// and pretend the new file was already live — falsifying production metadata. Adding product files
// to canonical does not authorize a production deploy, so the concepts are separate now.
test('deployed manifest verifies against the DEPLOYED runtime and is untouched by candidate work', () => {
  const manifest = clone(json(deployedProduct.MANIFEST));
  // 1. the current production manifest verifies
  deployedProduct.verify(state.runtime_sha, deployedProduct.MANIFEST);
  // 2. adding a candidate-only served path must NOT invalidate it
  const realServed = [...deployedProduct.SERVED];
  const realCandidate = [...deployedProduct.CANDIDATE_ONLY];
  try {
    deployedProduct.SERVED.push('assets/client-export/harness-probe.js');
    deployedProduct.CANDIDATE_ONLY.push('assets/client-export/harness-probe.js');
    deployedProduct.verify(state.runtime_sha, deployedProduct.MANIFEST);
  } finally {
    // Restore BOTH registries to what they were. Emptying CANDIDATE_ONLY here would wipe the real
    // client-export paths, because this test runs before the one that counts them.
    deployedProduct.SERVED.length = 0; deployedProduct.SERVED.push(...realServed);
    deployedProduct.CANDIDATE_ONLY.length = 0; deployedProduct.CANDIDATE_ONLY.push(...realCandidate);
  }
  // 3. nothing rewrote the manifest
  assert.deepEqual(json(deployedProduct.MANIFEST), manifest, 'la verificacion no debe reescribir el manifiesto');
});

test('a tampered deployed manifest is rejected, and an unknown path is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-dp-'));
  try {
    const good = clone(json(deployedProduct.MANIFEST));
    // 5. a tampered hash must fail
    const bad = clone(good);
    const first = Object.keys(bad.files)[0];
    bad.files[first] = '0'.repeat(64);
    fs.writeFileSync(path.join(dir, 'tampered.json'), JSON.stringify(bad));
    assert.throws(() => deployedProduct.verify(state.runtime_sha, path.join(dir, 'tampered.json')), /does not describe the deployed runtime/);
    // 6. a path that is no longer a recognized product path must fail
    const unknown = clone(good);
    unknown.files['assets/not-a-product-path.js'] = '0'.repeat(64);
    fs.writeFileSync(path.join(dir, 'unknown.json'), JSON.stringify(unknown));
    assert.throws(() => deployedProduct.verify(state.runtime_sha, path.join(dir, 'unknown.json')), /unknown path/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('candidate surface verification requires every registered path to exist in the candidate', () => {
  // 3. every registered path exists in the CANDIDATE, so it passes. HEAD is the candidate: the
  //    deployed runtime does NOT contain the candidate-only export assets, which is the whole point.
  const ok = deployedProduct.verifyCandidate('HEAD', { entryPoints: ['vdsen-cliente.html', 'vdsen-coach.html'] });
  assert.equal(ok.paths, deployedProduct.SERVED.length);
  assert.equal(ok.candidate_only, deployedProduct.CANDIDATE_ONLY.length);
  // 4. a registry entry naming a file that does not exist must FAIL
  const realServed = [...deployedProduct.SERVED];
  try {
    deployedProduct.SERVED.push('assets/client-export/definitely-missing.js');
    assert.throws(() => deployedProduct.verifyCandidate('HEAD'), /missing a registered served path/);
  } finally { deployedProduct.SERVED.length = 0; deployedProduct.SERVED.push(...realServed); }
  // 7. an entry point referencing a local asset the registry forgot must FAIL.
  //    `gitBytes` always reads the REAL checkout (it shells out to git in the repo), so a throwaway
  //    repo commit cannot be seen from here. Instead the registry is emptied and a real product
  //    entry point is used: every `assets/...` reference in it then counts as unregistered.
  const savedServed2 = [...deployedProduct.SERVED];
  deployedProduct.SERVED.length = 0;
  try {
    assert.throws(() => deployedProduct.verifyCandidate('HEAD', { entryPoints: ['vdsen-coach.html'] }),
      /references an unregistered browser asset: assets\//);
  } finally { deployedProduct.SERVED.length = 0; deployedProduct.SERVED.push(...savedServed2); }
  // and with the real registry restored the same call passes again
  deployedProduct.verifyCandidate('HEAD', { entryPoints: ['vdsen-coach.html'] });
});

test('product CI does not require a production deploy to carry a candidate-only served path', () => {
  // The point of the split: product work must not force production metadata to be falsified.
  const manifest = json(deployedProduct.MANIFEST);
  assert.equal(Object.keys(manifest.files).length, 26, 'produccion sigue sirviendo 26 rutas');
  assert.equal(deployedProduct.DEPLOYED.length, 26);
  // The client export registers its browser assets as CANDIDATE-ONLY: the candidate intends to serve
  // them, production does not yet, and the frozen manifest must stay honest about that difference.
  // 11 client-export routes + 8 Coach image-upload routes (image-upload-v2).
  assert.equal(deployedProduct.CANDIDATE_ONLY.length, 19, 'el export aporta 11 y la subida de imagenes 8');
  for (const f of deployedProduct.CANDIDATE_ONLY) {
    // Explicit namespace allow-list. A candidate-only path may only come from a namespace that is
    // deliberately undeployed yet: the client export and the Coach image upload.
    assert.ok(
      f.startsWith('assets/client-export/') || f.startsWith('assets/coach-image-upload/'),
      'namespace candidato no permitido: ' + f
    );
    assert.ok(deployedProduct.SERVED.includes(f), 'una ruta candidata tambien es parte de la superficie servida');
    assert.ok(!deployedProduct.DEPLOYED.includes(f), 'una ruta candidata NO puede estar desplegada');
  }
  // and the frozen surface must remain a subset of the candidate surface
  for (const f of deployedProduct.DEPLOYED) assert.ok(deployedProduct.SERVED.includes(f), 'la superficie desplegada es subconjunto de la candidata');
});
