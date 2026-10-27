'use strict';
// T641 — fail-closed Numeric-Apply-OFF guard of the app release lane. Synthetic fixtures and fakes only: no network, no Vercel, no Firestore, no credential.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const G = require('../scripts/release/numeric-guard.cjs');
const app = require('../scripts/release/app-live.cjs');
const lib = require('../scripts/release/lib.cjs');

const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const RUNTIME = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const S = { production_project: PROJECT, vercel_team: TEAM };
const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const plain = (key, value, over) => Object.assign({ id: 'env_' + key.slice(-6), key, type: 'plain', value, target: ['production'], updatedAt: 1000 }, over || {});
const ctx = { project: PROJECT, team: TEAM, runtimeSha: RUNTIME, now: NOW };
const code = (fn, expected, label) => { try { fn(); assert.fail((label || '') + ' did not throw'); } catch (e) { assert.ok(e instanceof G.NumericGuardError, (label || '') + ' wrong error: ' + e.message); assert.equal(e.code, expected, (label || '') + ' -> ' + e.message); } };
const codeAsync = async (p, expected, label) => { try { await p; assert.fail((label || '') + ' did not reject'); } catch (e) { assert.ok(e instanceof G.NumericGuardError, (label || '') + ' wrong error: ' + e.message); assert.equal(e.code, expected, (label || '') + ' -> ' + e.message); } };
const NAMES = ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'CRON_SECRET', 'OPENAI_API_KEY'];

test('T641.1 the guard is DERIVED from the code the candidate runs: the progression switches it reads are exactly the two the guard covers; a new or dropped switch is rejected', () => {
  const names = G.discoverRuntimeEnvNames(RUNTIME, lib.git);
  assert.deepEqual(names.filter(G.isProgressionName), [...G.KNOWN_FLAGS].sort(), 'api/ reads exactly these progression variables');
  assert.deepEqual(G.assertContractCoverage(names), [...G.KNOWN_FLAGS].sort());
  code(() => G.assertContractCoverage(NAMES.concat(['AUTONOMOUS_PROGRESSION_NEW_SWITCH'])), 'UNKNOWN_RUNTIME_SWITCH', 'a new switch');
  code(() => G.assertContractCoverage(NAMES.concat(['SOMETHING_NUMERIC_APPLY_X'])), 'UNKNOWN_RUNTIME_SWITCH', 'NUMERIC_APPLY-named switch');
  code(() => G.assertContractCoverage(['AUTONOMOUS_PROGRESSION_ENABLED']), 'CONTRACT_DRIFT', 'a switch the guard assumes disappeared');
  code(() => G.discoverRuntimeEnvNames('main', lib.git), 'RUNTIME_NOT_EXPLICIT', 'only an explicit SHA');
});
test('T641.2 variables list: absent or readable plain "false" => DISARMED; every other state is REJECTED', () => {
  const ok = G.evaluateProductionEnv([], ctx); assert.equal(ok.status, 'DISARMED'); assert.deepEqual(ok.flags, { AUTONOMOUS_PROGRESSION_ENABLED: 'ABSENT', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'ABSENT' });
  const off = G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false'), plain('AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'false')], ctx);
  assert.deepEqual(off.flags, { AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_FALSE', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_FALSE' });
  code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'true')], ctx), 'NUMERIC_APPLY_ACTIVE', 'numeric ON');
  code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'true'), plain('AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'false')], ctx), 'GLOBAL_PROGRESSION_ACTIVE', 'global ON');
  for (const bad of ['TRUE', 'True', '1', 'yes', '', ' true', 'false ', 'off', null, undefined, 0, false])
    code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', bad)], ctx), bad === 'true' ? 'NUMERIC_APPLY_ACTIVE' : 'VALUE_MALFORMED', 'malformed ' + JSON.stringify(bad));
  for (const type of ['encrypted', 'sensitive', 'secret', 'shared', 'system', undefined, 'future-type'])
    code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false', { type })], ctx), 'VALUE_NOT_READABLE', 'unreadable type ' + type);
  code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false'), plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false', { id: 'dup' })], ctx), 'AMBIGUOUS_VARIABLE', 'duplicate');
  code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_SWEEP', 'false')], ctx), 'UNKNOWN_PROGRESSION_VARIABLE', 'unknown AUTONOMOUS_ variable');
  code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false', { target: undefined })], ctx), 'ENV_SCOPE_INDETERMINATE', 'no scope');
  code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false', { gitBranch: 'x' })], ctx), 'ENV_SCOPE_INDETERMINATE', 'branch scoped');
  for (const notList of [null, undefined, {}, 'x', 7]) code(() => G.evaluateProductionEnv(notList, ctx), 'ENV_LIST_INCOMPLETE', 'not a list');
  // a variable that only exists for preview/development is not used by a production deployment
  assert.equal(G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'true', { target: ['preview', 'development'] })], ctx).flags.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED, 'ABSENT');
  // a string target is normalised
  code(() => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'true', { target: 'production' })], ctx), 'NUMERIC_APPLY_ACTIVE', 'string target');
});
test('T641.3 evidence never contains a variable value, a token or a response body', () => {
  const ev = G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false'), plain('OPENAI_API_KEY', 'sk-test-SECRET-VALUE')], ctx), text = JSON.stringify(ev);
  assert.ok(!/SECRET-VALUE|sk-test|Bearer|"value"/.test(text)); assert.equal(Object.keys(ev.relevant_entries[0]).includes('value'), false);
  assert.match(ev.env_fingerprint, /^[0-9a-f]{64}$/);
});
function fakeVercel(over) {
  const calls = [];
  const base = { project: { id: PROJECT, accountId: TEAM }, env: { envs: [] } };
  const cfg = Object.assign({}, base, over || {});
  const get = async (p) => {
    calls.push(p);
    const pick = /\/env\?/.test(p) ? cfg.env : cfg.project;
    if (pick instanceof Error) throw pick;
    return typeof pick === 'function' ? pick() : pick;
  };
  return { get, calls };
}
const collect = (over, runtimeNames) => { const f = fakeVercel(over); return G.collectEvidence(S, RUNTIME, { runtimeNames: runtimeNames || NAMES, vercelGet: f.get, now: NOW }).then((ev) => ({ ev, calls: f.calls })); };
test('T641.4 effective read: GET-only, scoped to the production project, DISARMED when absent', async () => {
  const { ev, calls } = await collect();
  assert.equal(ev.status, 'DISARMED'); assert.equal(ev.project, PROJECT); assert.equal(ev.team, TEAM); assert.equal(ev.runtime_sha, RUNTIME);
  assert.deepEqual(calls, ['/v9/projects/' + PROJECT, '/v9/projects/' + PROJECT + '/env?decrypt=false'], 'two reads, decrypt=false, no other endpoint');
});
test('T641.5 failures to read are REJECTED before anything can be promoted: 401/403/404/5xx, network, incomplete or paginated lists, wrong project or team', async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    await codeAsync(collect({ env: new Error('API GET /v9/projects/x/env failed: HTTP ' + status) }), 'READ_FAILED_ENV', 'env HTTP ' + status);
    await codeAsync(collect({ project: new Error('API GET /v9/projects/x failed: HTTP ' + status) }), 'READ_FAILED_PROJECT', 'project HTTP ' + status);
  }
  await codeAsync(collect({ env: new TypeError('fetch failed') }), 'READ_FAILED_ENV', 'network');
  await codeAsync(collect({ env: {} }), 'ENV_LIST_INCOMPLETE', 'no list'); await codeAsync(collect({ env: { envs: 'x' } }), 'ENV_LIST_INCOMPLETE', 'bad list');
  await codeAsync(collect({ env: { envs: [], pagination: { next: 123 } } }), 'ENV_LIST_INCOMPLETE', 'paginated');
  await codeAsync(collect({ project: { id: 'prj_other', accountId: TEAM } }), 'PROJECT_IDENTITY_MISMATCH', 'other project');
  await codeAsync(collect({ project: { id: PROJECT, accountId: 'team_other' } }), 'TEAM_IDENTITY_MISMATCH', 'other team');
  await codeAsync(collect({ project: null }), 'PROJECT_IDENTITY_MISMATCH', 'empty project');
  await codeAsync(collect({}, NAMES.concat(['AUTONOMOUS_PROGRESSION_X'])), 'UNKNOWN_RUNTIME_SWITCH', 'candidate with an uncovered switch');
  assert.ok(!(await collect({ env: [plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false')] }).then((r) => JSON.stringify(r)).then((t) => /HTTP|Bearer/.test(t))), 'no transport details in evidence');
});
test('T641.6 deployment variable names must be explained by the evidence (shared/linked variables the project list did not show)', async () => {
  const { ev } = await collect();
  assert.equal(G.attachDeploymentEnv(ev, { env: ['OPENAI_API_KEY', 'FIREBASE_PROJECT_ID'] }).deployment_env.names_reported, true);
  code(() => G.attachDeploymentEnv(ev, { env: ['AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED'] }), 'ENV_DISCORDANCE', 'injected but not seen');
  code(() => G.attachDeploymentEnv(ev, { build: { env: ['AUTONOMOUS_PROGRESSION_ENABLED'] } }), 'ENV_DISCORDANCE', 'injected via build env');
  code(() => G.attachDeploymentEnv(ev, { env: ['AUTONOMOUS_SOMETHING_ELSE'] }), 'UNKNOWN_PROGRESSION_VARIABLE', 'unknown name');
  const seen = G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false')], ctx);
  assert.deepEqual(G.attachDeploymentEnv(seen, { env: ['AUTONOMOUS_PROGRESSION_ENABLED'] }).deployment_env.progression_names, ['AUTONOMOUS_PROGRESSION_ENABLED'], 'a plain-false variable that is injected is explained');
  const unreported = G.attachDeploymentEnv(ev, {}); assert.equal(unreported.deployment_env.names_reported, false, 'recorded honestly, never claimed');
});
test('T641.7 promotion gate: evidence must be present, DISARMED, for this exact project/team/runtime, fresh and UNCHANGED (concurrent change, stale, future, other runtime, tampered)', () => {
  const pre = G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false')], ctx), expect = { project: PROJECT, team: TEAM, runtimeSha: RUNTIME };
  assert.equal(G.assertPromotionAllowed({ preflight: pre, staged: pre, fresh: pre, expect, now: NOW + 60000 }), true);
  code(() => G.assertPromotionAllowed({ preflight: null, fresh: pre, expect, now: NOW }), 'EVIDENCE_MISSING', 'no preflight evidence');
  code(() => G.assertPromotionAllowed({ preflight: pre, fresh: undefined, expect, now: NOW }), 'EVIDENCE_MISSING', 'no fresh evidence');
  code(() => G.assertPromotionAllowed({ preflight: pre, fresh: pre, expect, now: NOW + G.MAX_EVIDENCE_AGE_MS + 1 }), 'EVIDENCE_STALE', 'stale');
  code(() => G.assertPromotionAllowed({ preflight: pre, fresh: pre, expect, now: NOW - 1 }), 'EVIDENCE_FROM_THE_FUTURE', 'future');
  const changed = G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false', { updatedAt: 2000 })], ctx);
  code(() => G.assertPromotionAllowed({ preflight: pre, fresh: changed, expect, now: NOW }), 'ENV_CHANGED_CONCURRENTLY', 'edited between pre-flight and promotion');
  const added = G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false'), plain('AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'false')], ctx);
  code(() => G.assertPromotionAllowed({ preflight: pre, fresh: added, expect, now: NOW }), 'ENV_CHANGED_CONCURRENTLY', 'variable added');
  code(() => G.assertPromotionAllowed({ preflight: pre, staged: changed, fresh: pre, expect, now: NOW }), 'ENV_CHANGED_CONCURRENTLY', 'changed while the deployment was being built');
  code(() => G.assertPromotionAllowed({ preflight: pre, fresh: pre, expect: Object.assign({}, expect, { runtimeSha: 'a'.repeat(40) }), now: NOW }), 'EVIDENCE_FOR_ANOTHER_RUNTIME', 'other runtime');
  code(() => G.assertPromotionAllowed({ preflight: pre, fresh: pre, expect: Object.assign({}, expect, { project: 'prj_other' }), now: NOW }), 'PROJECT_IDENTITY_MISMATCH', 'other project');
  code(() => G.assertPromotionAllowed({ preflight: Object.assign({}, pre, { status: 'ARMED' }), fresh: pre, expect, now: NOW }), 'EVIDENCE_NOT_DISARMED', 'tampered status');
  code(() => G.assertPromotionAllowed({ preflight: Object.assign({}, pre, { flags: { AUTONOMOUS_PROGRESSION_ENABLED: 'ARMED' } }), fresh: pre, expect, now: NOW }), 'EVIDENCE_INCONSISTENT', 'tampered flags');
  code(() => G.assertPromotionAllowed({ preflight: Object.assign({}, pre, { captured_at: 'nope' }), fresh: pre, expect, now: NOW }), 'EVIDENCE_TIMESTAMP_INVALID', 'bad timestamp');
});

// ── apply(): the REAL function with fake mutation steps. A rejected guard must mutate nothing and record no promotion.
function applyFixture(preGuard) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-apply-')), runtime = RUNTIME, wrote = [];
  fs.writeFileSync(path.join(tmp, 'app-preflight.json'), JSON.stringify({ runtime_sha: runtime, rollback_artifact: 'app-rollback-test.json', numeric_guard: preGuard }));
  fs.writeFileSync(path.join(tmp, 'app-rollback-test.json'), JSON.stringify({ candidate_sha: runtime, candidate_deployment: 'dpl_candidate000000000000000001', production_deployment: 'dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw',
    production_runtime_sha: 'b5f53af5843f466528a4b95e5a3e52d6c8c77fb1', production_project: PROJECT, vercel_team: TEAM, production_origin: 'https://x', main_sha: 'f'.repeat(40), captured_at: 'now' }));
  return { tmp, wrote };
}
async function runApply(preGuard, freshGuard) {
  const { tmp } = applyFixture(preGuard), prevOut = app.getOut(), prevRuntime = process.env.APP_RUNTIME_SHA; let promoted = 0, aliasReads = 0;
  const realNow = Date.now;
  try {
    app.setOut(tmp); process.env.APP_RUNTIME_SHA = RUNTIME;
    const steps = { promote: async () => { promoted++; }, currentApp: async () => { aliasReads++; return 'dpl_new0000000000000000000001'; }, servedSurface: () => ['vdsen-cliente.html'], verifyPublicBytes: async () => ['vdsen-cliente.html'],
      deployment: async () => ({ readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: RUNTIME } }),
      numericGuard: typeof freshGuard === 'function' ? freshGuard : async () => freshGuard };
    let error = null; try { await app.apply(steps); } catch (e) { error = e; }
    return { error, promoted, aliasReads, resultWritten: fs.existsSync(path.join(tmp, 'app-result.json')) };
  } finally { Date.now = realNow; app.setOut(prevOut); if (prevRuntime === undefined) delete process.env.APP_RUNTIME_SHA; else process.env.APP_RUNTIME_SHA = prevRuntime; fs.rmSync(tmp, { recursive: true, force: true }); }
}
test('T641.8 apply(): with a valid, fresh, unchanged proof the promotion proceeds; every failed proof stops BEFORE promoting (no promote call, no alias read, no result)', async () => {
  const fresh = () => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false')], Object.assign({}, ctx, { now: Date.now() }));
  const good = await runApply(fresh(), async () => fresh());
  assert.equal(good.error, null, good.error && good.error.message); assert.equal(good.promoted, 1);
  const cases = [
    ['no evidence in the preflight artifact', undefined, async () => fresh(), /EVIDENCE_MISSING/],
    ['numeric ON detected now', fresh(), async () => { throw new G.NumericGuardError('NUMERIC_APPLY_ACTIVE', 'x'); }, /NUMERIC_APPLY_ACTIVE/],
    ['read denied (403) now', fresh(), async () => { throw new G.NumericGuardError('READ_FAILED_ENV', 'HTTP 403'); }, /READ_FAILED_ENV/],
    ['variables changed since the preflight', fresh(), async () => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false', { updatedAt: 99 })], Object.assign({}, ctx, { now: Date.now() })), /ENV_CHANGED_CONCURRENTLY/],
    ['stale preflight evidence', G.evaluateProductionEnv([], Object.assign({}, ctx, { now: Date.now() - G.MAX_EVIDENCE_AGE_MS - 60000 })), async () => fresh(), /EVIDENCE_STALE/],
    ['evidence of another runtime', G.evaluateProductionEnv([], Object.assign({}, ctx, { runtimeSha: 'b'.repeat(40), now: Date.now() })), async () => fresh(), /EVIDENCE_FOR_ANOTHER_RUNTIME/],
    ['no fresh evidence returned', fresh(), async () => undefined, /EVIDENCE_MISSING/]];
  for (const [label, pre, freshFn, re] of cases) {
    const r = await runApply(pre, freshFn);
    assert.ok(r.error && re.test(r.error.message), label + ' -> ' + (r.error && r.error.message));
    assert.equal(r.promoted, 0, label + ': promote must not run'); assert.equal(r.aliasReads, 0, label); assert.equal(r.resultWritten, false, label + ': no result may claim a promotion');
  }
});

// ── stageProduction(): the gate runs BEFORE anything is exported, built or created
test('T641.9 stageProduction(): a failed or ARMED proof stops it before the tree export and before any Vercel CLI deploy (no side effects, GET-only reads)', async () => {
  const origCwd = process.cwd(), gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-stage-')), stageDir = path.join(tmp, 'would-be-export'), outDir = path.join(tmp, 'out');
  fs.mkdirSync(path.join(tmp, '.release'), { recursive: true }); fs.mkdirSync(outDir);
  const state = JSON.parse(fs.readFileSync(path.join(origCwd, '.release/vdsen-client.json'), 'utf8'));
  state.release_mode = 'app_only'; delete state.rules_sha; state.app_release = { runtime_sha: state.runtime_sha };   // a fixture only: stage() needs the mode, not the history
  fs.writeFileSync(path.join(tmp, '.release/vdsen-client.json'), JSON.stringify(state)); fs.copyFileSync(path.join(origCwd, '.release/deployed-product.json'), path.join(tmp, '.release/deployed-product.json'));
  const evidence = (updatedAt) => G.evaluateProductionEnv([plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false', { updatedAt })], Object.assign({}, ctx, { now: Date.now() }));
  const before = { cwd: origCwd, out: app.getOut(), fetch: global.fetch, env: Object.assign({}, process.env) }, requests = [];
  try {
    process.chdir(tmp); app.setOut(outDir);
    Object.assign(process.env, { GIT_DIR: gitDir, CLIENT_APP_RELEASE_ENABLED: 'true', APP_RUNTIME_SHA: RUNTIME, APP_STAGE_DIR: stageDir, VERCEL_TOKEN: 'token-for-test-only' });
    const scenarios = [
      ['project read denied (403)', 'ok', (url) => new Response('private-body-test-only', { status: 403 }), /READ_FAILED_PROJECT: HTTP 403/],
      ['variables read denied (403)', 'ok', (url) => url.includes('/env?') ? new Response('private-body-test-only', { status: 403 }) : new Response(JSON.stringify({ id: PROJECT, accountId: TEAM })), /READ_FAILED_ENV: HTTP 403/],
      ['numeric ON', 'ok', (url) => url.includes('/env?') ? new Response(JSON.stringify({ envs: [plain('AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'true')] })) : new Response(JSON.stringify({ id: PROJECT, accountId: TEAM })), /NUMERIC_APPLY_ACTIVE/],
      ['global ON', 'ok', (url) => url.includes('/env?') ? new Response(JSON.stringify({ envs: [plain('AUTONOMOUS_PROGRESSION_ENABLED', 'true')] })) : new Response(JSON.stringify({ id: PROJECT, accountId: TEAM })), /GLOBAL_PROGRESSION_ACTIVE/],
      ['variable edited after the preflight', 'ok', (url) => url.includes('/env?') ? new Response(JSON.stringify({ envs: [plain('AUTONOMOUS_PROGRESSION_ENABLED', 'false', { updatedAt: 555 })] })) : new Response(JSON.stringify({ id: PROJECT, accountId: TEAM })), /ENV_CHANGED_CONCURRENTLY/],
      ['preflight evidence missing', null, (url) => url.includes('/env?') ? new Response(JSON.stringify({ envs: [] })) : new Response(JSON.stringify({ id: PROJECT, accountId: TEAM })), /EVIDENCE_MISSING/]];
    for (const [label, pre, handler, re] of scenarios) {
      fs.writeFileSync(path.join(outDir, 'app-preflight.json'), JSON.stringify({ runtime_sha: RUNTIME, numeric_guard: pre === null ? undefined : evidence(1000) }));
      global.fetch = async (url, options) => { requests.push([String(url), (options && options.method) || 'GET']); return handler(String(url)); };
      await assert.rejects(() => app.stageProduction(), (e) => re.test(e.message) && !/private-body-test-only|token-for-test-only/.test(e.message), label);
      assert.equal(fs.existsSync(stageDir), false, label + ': nothing exported'); assert.equal(fs.existsSync(path.join(outDir, 'app-staged.json')), false, label + ': no staged report');
    }
    assert.ok(requests.length > 0 && requests.every(([u, m]) => m === 'GET' && /^https:\/\/api\.vercel\.com\/v9\/projects\//.test(u)), 'only GET reads of the project and its variables: ' + JSON.stringify(requests.slice(0, 2)));
  } finally {
    process.chdir(before.cwd); app.setOut(before.out); global.fetch = before.fetch;
    for (const k of Object.keys(process.env)) if (!(k in before.env)) delete process.env[k]; Object.assign(process.env, before.env);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('T641.10 summary reports the proof; no override or bypass exists; the guard module can only read; nothing prints values', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-sum-')), prev = app.getOut();
  try {
    app.setOut(tmp);
    fs.writeFileSync(path.join(tmp, 'app-preflight.json'), JSON.stringify({ candidate: 'dpl_x', production_deployment: 'dpl_y', production_runtime_sha: 'a'.repeat(40), main_sha: 'b'.repeat(40), env: { present: 5, missing: [] }, firebase_project: 'MATCH',
      numeric_guard: G.evaluateProductionEnv([], ctx), rollback_artifact: 'r.json', app_only: 'NO_FIRESTORE_MUTATION_PATH' }));
    const text = app.preflightSummary(); assert.match(text, /Numeric Apply proof \(production env\) \| DISARMED \[AUTONOMOUS_PROGRESSION_ENABLED: ABSENT; AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: ABSENT\]/);
  } finally { app.setOut(prev); fs.rmSync(tmp, { recursive: true, force: true }); }
  const guardSrc = fs.readFileSync('scripts/release/numeric-guard.cjs', 'utf8'), liveSrc = fs.readFileSync('scripts/release/app-live.cjs', 'utf8'), codeOnly = guardSrc.replace(/\/\/.*$/gm, '');
  assert.ok(!/SKIP|BYPASS|OVERRIDE|FORCE|ALLOW_ARMED|IGNORE_GUARD|NO_GUARD/i.test(codeOnly), 'no override switch in the guard');
  assert.ok(!/APP_(SKIP|IGNORE|BYPASS|ALLOW)[A-Z_]*GUARD|SKIP_NUMERIC|ALLOW_NUMERIC/i.test(liveSrc), 'no override switch in the lane');
  assert.ok(!/method:|'POST'|'PUT'|'PATCH'|'DELETE'|fetch\(|require\('node:http|writeFile|console\./.test(codeOnly), 'the guard module performs no request of its own, no write, no logging');
  assert.ok(!/process\.env\.(VERCEL_TOKEN|[A-Z_]*TOKEN)/.test(codeOnly), 'the guard never touches a credential');
  assert.ok((liveSrc.match(/numericGuard\.assertPromotionAllowed/g) || []).length >= 2, 'the gate runs before staging, after staging and before promotion');
});
