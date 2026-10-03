'use strict';
// Only workflow jobs may call this CLI. No Admin SDK, document writes or IAM operations.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { hash, json, git, validate, indexMatches, verifyDeployment } = require('./lib.cjs');
const { check } = require('./check.cjs');
const state = () => validate(json('.release/vdsen-client.json'), json('.release/schema/release-state.schema.json'));
const save = (name, data) => { fs.mkdirSync('release-output', { recursive: true }); fs.writeFileSync('release-output/' + name, JSON.stringify(data, null, 2) + '\n'); };
function workflowGuard() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Live tooling requires GitHub Actions');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/client-app-next');
  assert.equal(process.env.PRODUCTION_RELEASE_ENABLED, 'true', 'Emergency stop is enabled');
}
async function api(url, token, method = 'GET', body) {
  assert.ok(token, 'Missing workflow credential');
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.ok(r.ok, 'API ' + method + ' failed: HTTP ' + r.status); // Never print response bodies or tokens.
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}
const google = (path, method, body) => api('https://firebaserules.googleapis.com/v1/' + path, process.env.GOOGLE_ACCESS_TOKEN, method, body);
const vercel = (s, path, method) => api('https://api.vercel.com' + path + '?teamId=' + encodeURIComponent(s.vercel_team), process.env.VERCEL_TOKEN, method);
const releaseName = s => 'projects/' + s.firebase_project + '/releases/cloud.firestore';
const deployment = (s, id) => vercel(s, '/v13/deployments/' + encodeURIComponent(id));
async function liveRules(s) {
  const release = await google(releaseName(s));
  assert.ok(release.rulesetName.startsWith('projects/' + s.firebase_project + '/rulesets/'));
  const ruleset = await google(release.rulesetName);
  assert.equal(ruleset.source?.files?.length, 1, 'Unexpected live rules source shape');
  assert.equal(typeof ruleset.source.files[0].content, 'string');
  return { ruleset: release.rulesetName, source: ruleset.source, sha256: hash(ruleset.source.files[0].content) };
}
async function verifyLiveRules(s, expectedHash) {
  const live = await liveRules(s);
  assert.equal(live.sha256, expectedHash, 'Live rules source mismatch');
  return live;
}
async function verifyIndex(s) {
  let page = '';
  const matches = [];
  do {
    const url = 'https://firestore.googleapis.com/v1/projects/' + s.firebase_project + '/databases/(default)/collectionGroups/' + s.required_index.collectionGroup + '/indexes?pageSize=100' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
    const data = await api(url, process.env.GOOGLE_ACCESS_TOKEN);
    matches.push(...(data.indexes || []).filter(x => indexMatches(s.required_index, x)));
    page = data.nextPageToken || '';
  } while (page);
  assert.equal(matches.length, 1, 'Expected exactly one matching index');
  assert.equal(matches[0].state, 'READY', 'Required index is not READY');
  return 'READY';
}
async function currentApp(s) {
  const a = await vercel(s, '/v4/aliases/' + new URL(s.production_origin).hostname);
  assert.equal(a.projectId, s.production_project);
  assert.ok(a.deployment?.id, 'Missing production alias deployment');
  return a.deployment.id;
}
async function awaitApp(s, id) {
  for (let i = 0; i < 30; i++) {
    if (await currentApp(s) === id) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.fail('Production alias did not converge');
}
async function switchApp(s, id, rollback = false) {
  await vercel(s, (rollback ? '/v1' : '/v10') + '/projects/' + s.production_project + '/' + (rollback ? 'rollback' : 'promote') + '/' + encodeURIComponent(id), 'POST');
  await awaitApp(s, id);
}
async function restoreRules(s, snapshot) {
  // Recreate from captured source; restoration does not depend on ruleset retention.
  assert.equal(snapshot.old_rules.sha256, hash(snapshot.old_rules.source.files[0].content));
  const r = await google('projects/' + s.firebase_project + '/rulesets', 'POST', { source: snapshot.old_rules.source });
  await google(releaseName(s), 'PATCH', { release: { name: releaseName(s), rulesetName: r.name }, updateMask: 'rulesetName' });
  return verifyLiveRules(s, snapshot.old_rules.sha256);
}
async function smoke(s, runtime) {
  // Public surfaces prove exact served bytes. They cannot prove authenticated reads/writes.
  const tracked = new Set(git('ls-tree', '-r', '--name-only', runtime).trim().split('\n'));
  const paths = ['vdsen-cliente.html', 'vdsen-coach.html', 'ficha-publica.html', 'sw.js'];
  if (tracked.has('assets/progression-effective-prescription.js')) paths.push('assets/progression-effective-prescription.js');
  for (const path of paths) {
    const r = await fetch(s.production_origin + '/' + path + '?release=' + runtime, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, 200, 'Public smoke HTTP failure: ' + path);
    assert.equal(hash(Buffer.from(await r.arrayBuffer())), hash(git('show', runtime + ':' + path)), 'Public runtime mismatch: ' + path);
  }
  return { client_smoke: 'GAP', coach_smoke: 'GAP', security_smoke: 'GAP', write_smoke: 'GAP' };
}
function result(s, operation) {
  return { release_id: process.env.GITHUB_RUN_ID, operation, release_status: 'FAIL', runtime_sha: s.runtime_sha, production_deployment: null, previous_deployment: null, old_ruleset: null, new_ruleset: null, index_status: 'GAP', client_smoke: 'GAP', coach_smoke: 'GAP', security_smoke: 'GAP', write_smoke: 'GAP', rollback_status: 'NOT_NEEDED', main_unchanged: true, numeric_apply_enabled: false, timestamp: new Date().toISOString(), error: null };
}
const mainSha = () => {
  const sha = git('ls-remote', 'origin', 'refs/heads/main').trim().split(/\s/)[0];
  assert.match(sha, /^[0-9a-f]{40}$/, 'main reference unavailable');
  return sha;
};
async function prepare() {
  workflowGuard();
  const s = check();
  assert.equal(s.release_status, 'READY', 'Reviewed release state not READY');
  assert.ok(Object.values(s.preconditions).every(x => x === true), 'Unreviewed production preconditions');
  const r = result(s, 'release');
  try {
    r.index_status = await verifyIndex(s);
    assert.equal(s.production_deployment, s.rollback_deployment, 'Baseline must be rollback deployment');
    assert.equal(await currentApp(s), s.production_deployment, 'Stale production baseline');
    verifyDeployment(await deployment(s, s.rollback_deployment), s, s.rollback_runtime_sha);
    verifyDeployment(await deployment(s, s.target_deployment), s, s.runtime_sha, 'codex/client-app-next');
    const old = await liveRules(s);
    const snapshot = { release_id: process.env.GITHUB_RUN_ID, release_reason: process.env.RELEASE_REASON || '', package_sha: git('rev-parse', 'HEAD').trim(), state: s, old_rules: old, main_sha: mainSha(), captured_at: new Date().toISOString() };
    save('rollback.json', snapshot);
    r.old_ruleset = old.ruleset; r.previous_deployment = s.production_deployment;
  } catch (e) { r.error = e.message; throw e; }
  finally { save('result.json', r); }
}
async function recover(s, snapshot, r) {
  r.rollback_status = 'FAIL';
  const restored = await restoreRules(s, snapshot);
  r.new_ruleset = restored.ruleset;
  // Only after rule verification can the old app be restored.
  if (await currentApp(s) !== snapshot.state.rollback_deployment) await switchApp(s, snapshot.state.rollback_deployment, true);
  verifyDeployment(await deployment(s, snapshot.state.rollback_deployment), s, snapshot.state.rollback_runtime_sha);
  await smoke(s, snapshot.state.rollback_runtime_sha);
  r.production_deployment = snapshot.state.rollback_deployment;
  r.rollback_status = 'PASS';
}
async function apply() {
  workflowGuard();
  const s = check();
  const snapshot = json('release-output/rollback.json');
  assert.deepEqual(snapshot.state, s);
  assert.equal(snapshot.package_sha, git('rev-parse', 'HEAD').trim());
  assert.equal(snapshot.release_id, process.env.GITHUB_RUN_ID);
  assert.ok(Date.now() - Date.parse(snapshot.captured_at) < 30 * 60 * 1000, 'Expired preflight');
  const r = json('release-output/result.json');
  let mayHaveMutated = false;
  try {
    await verifyIndex(s);
    await verifyLiveRules(s, snapshot.old_rules.sha256);
    assert.equal(await currentApp(s), s.production_deployment);
    verifyDeployment(await deployment(s, s.target_deployment), s, s.runtime_sha, 'codex/client-app-next');
    assert.equal(mainSha(), snapshot.main_sha, 'main changed during preflight');
    mayHaveMutated = true; // Set before POST: response failure can follow a committed mutation.
    await switchApp(s, s.target_deployment);
    r.production_deployment = s.target_deployment;
    const content = git('show', s.runtime_sha + ':firestore.rules');
    assert.equal(hash(content), s.rules_transition.target_sha256);
    const target = await google('projects/' + s.firebase_project + '/rulesets', 'POST', { source: { files: [{ name: 'firestore.rules', content }] } });
    r.new_ruleset = target.name;
    await google(releaseName(s), 'PATCH', { release: { name: releaseName(s), rulesetName: target.name }, updateMask: 'rulesetName' });
    await verifyLiveRules(s, s.rules_transition.target_sha256);
    Object.assign(r, await smoke(s, s.runtime_sha));
    r.release_status = 'PARTIAL'; // Authenticated production evidence is unavailable, never manufacture PASS.
  } catch (e) {
    r.error = e.message; r.release_status = 'FAIL';
    if (mayHaveMutated) {
      try { await recover(s, snapshot, r); } catch (recovery) { r.error += '; recovery failed: ' + recovery.message; }
    }
    throw e;
  } finally {
    try { r.main_unchanged = mainSha() === snapshot.main_sha; }
    catch { r.main_unchanged = false; r.error = (r.error || '') + '; main verification unavailable'; }
    if (!r.main_unchanged) r.release_status = 'FAIL';
    validate(r, json('.release/schema/release-result.schema.json'));
    save('result.json', r);
    assert.ok(r.main_unchanged, 'main unchanged gate failed');
  }
}
async function rollback() {
  workflowGuard();
  const s = state();
  const snapshot = json('release-output/rollback.json');
  const r = result(s, 'rollback');
  const beforeMain = mainSha();
  try {
    validate(snapshot.state, json('.release/schema/release-state.schema.json'));
    assert.match(process.env.RELEASE_RUN_ID || '', /^\d+$/);
    const run = await api('https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.RELEASE_RUN_ID, process.env.GH_TOKEN);
    assert.equal(run.path, '.github/workflows/vdsen-release-prod.yml');
    assert.equal(run.event, 'workflow_dispatch');
    assert.equal(run.head_branch, 'codex/client-app-next');
    assert.equal(run.head_sha, snapshot.package_sha);
    assert.equal(String(run.id), snapshot.release_id);
    assert.equal(run.status, 'completed', 'Release run still active');
    assert.equal(snapshot.state.production_project, s.production_project);
    assert.equal(snapshot.state.firebase_project, s.firebase_project);
    assert.equal(snapshot.state.vercel_team, s.vercel_team);
    assert.equal(snapshot.state.production_origin, s.production_origin);
    assert.equal(process.env.ROLLBACK_DEPLOYMENT, snapshot.state.rollback_deployment);
    assert.equal(snapshot.old_rules.source.files.length, 1);
    assert.equal(hash(snapshot.old_rules.source.files[0].content), snapshot.old_rules.sha256);
    const live = await liveRules(s);
    assert.ok([snapshot.old_rules.sha256, snapshot.state.rules_transition.target_sha256].includes(live.sha256), 'Superseding rules; refuse stale rollback');
    assert.ok([snapshot.state.target_deployment, snapshot.state.rollback_deployment].includes(await currentApp(s)), 'Superseding app; refuse stale rollback');
    verifyDeployment(await deployment(s, snapshot.state.rollback_deployment), s, snapshot.state.rollback_runtime_sha);
    r.runtime_sha = snapshot.state.rollback_runtime_sha;
    r.previous_deployment = await currentApp(s); r.old_ruleset = live.ruleset;
    r.index_status = await verifyIndex(s);
    await recover(s, snapshot, r);
    r.release_status = 'PARTIAL';
  } catch (e) { r.error = e.message; throw e; }
  finally {
    try { r.main_unchanged = mainSha() === beforeMain; }
    catch { r.main_unchanged = false; r.error = (r.error || '') + '; main verification unavailable'; }
    if (!r.main_unchanged) r.release_status = 'FAIL';
    validate(r, json('.release/schema/release-result.schema.json'));
    save('result.json', r);
    assert.ok(r.main_unchanged, 'main unchanged gate failed');
  }
}
if (require.main === module) {
  const fallback = () => {
    if (!fs.existsSync('release-output/result.json')) {
      const r = result(state(), process.argv[2] === 'rollback-result' ? 'rollback' : 'release');
      r.error = 'Workflow failed before a detailed result was available';
      r.main_unchanged = false; // Not observed; never assert an unexecuted check.
      validate(r, json('.release/schema/release-result.schema.json')); save('result.json', r);
    }
  };
  const command = { prepare, apply, rollback, 'release-result': fallback, 'rollback-result': fallback }[process.argv[2]];
  if (!command) { console.error('Expected prepare, apply or rollback'); process.exitCode = 1; }
  else Promise.resolve().then(command).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { api, liveRules, verifyIndex, verifyLiveRules, switchApp, restoreRules, smoke, recover, prepare, apply, rollback, workflowGuard };
