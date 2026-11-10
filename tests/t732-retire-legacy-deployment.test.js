'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const R = require('../scripts/release/retire-legacy-deployment.cjs');
const { LEGACY_ARMED_DEPLOYMENT: LEGACY, PROTECTED_PROD_DEPLOYMENT: PROD, PROTECTED_ROLLBACK_DEPLOYMENT: ROLLBACK, EXPECTED_PROJECT: PROJECT, EXPECTED_TEAM: TEAM, AYRTON_UID: UID } = R;

const RUNTIME_SHA = 'ec3b30f99d095c90fc8e1d54cf05366a0427205a';
const ROLLBACK_SHA = '353df8c12982cad7f4dc89b3622a6b63b3127b52';
const SECRET = 'SECRET_VERCEL_TOKEN_VALUE', GSECRET = 'SECRET_GOOGLE_TOKEN_VALUE', HSECRET = 'SECRET_GITHUB_TOKEN_VALUE';
const NOW = Date.parse('2026-11-10T03:00:00Z');
const STATE = Object.freeze({
  production_deployment: PROD, rollback_deployment: ROLLBACK, production_project: PROJECT, vercel_team: TEAM, runtime_sha: RUNTIME_SHA, rollback_runtime_sha: ROLLBACK_SHA,
  production_origin: 'https://vdsen-ecosistema.vercel.app',
  app_release: { safe_recovery_deployment: ROLLBACK, safe_recovery_runtime_sha: ROLLBACK_SHA },
});
const ENV = Object.freeze({ GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema', GITHUB_REF: R.CANONICAL_REF, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '900' });
const COACH = 'C'.repeat(28);

const enc = (v) => typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const fsDoc = (obj, updateTime) => ({ name: 'x', fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])), updateTime: updateTime || '2026-11-10T02:34:33.063708Z' });

function world(over = {}) {
  const w = {
    calls: [], deleted: false, snapshotsSeen: 0,
    prod: { id: PROD, projectId: PROJECT, teamId: TEAM, readyState: 'READY', target: 'production', meta: { githubCommitSha: RUNTIME_SHA } },
    rollback: { id: ROLLBACK, projectId: PROJECT, teamId: TEAM, readyState: 'READY', target: 'production', meta: { githubCommitSha: ROLLBACK_SHA } },
    legacy: { id: LEGACY, projectId: PROJECT, teamId: TEAM, readyState: 'READY' },
    prodAlias: { alias: 'vdsen-ecosistema.vercel.app', projectId: PROJECT, deployment: { id: PROD } },
    legacyAliases: { aliases: [] },
    projectAliases: [{ aliases: [{ alias: 'vdsen-ecosistema.vercel.app', deploymentId: PROD }], pagination: { next: null } }],
    client: { coachId: COACH },
    release: { schema: 'vdsen-autonomous-release-v1', enabled: false, clientIds: [UID], expiresAt: '2026-11-10T02:34:32Z' },
    coach: { autoApplyCanary: { enabled: false, clientIds: [UID], prescriptionExerciseIds: [] } },
    releaseVersion: '2026-11-10T02:34:33.063708Z',
    runs: { in_progress: [], queued: [], waiting: [] }, history: [],
    deleteResponse: { status: 200, body: { uid: LEGACY, state: 'DELETED' } },
    hooks: {}, // name -> (w, n) => response | undefined
  };
  Object.assign(w, over);
  const count = {};
  w.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET', u = new URL(url);
    w.calls.push({ method, url, headers: opts.headers });
    const key = method + ' ' + u.pathname;
    count[key] = (count[key] || 0) + 1;
    const hook = w.hooks[key] || w.hooks[u.pathname];
    if (hook) { const r = hook(w, count[key]); if (r) return respond(r); }
    return respond(route(w, method, u));
  };
  w.count = (m, p) => count[m + ' ' + p] || 0;
  return w;
}
function respond(r) {
  if (r instanceof Error) throw r;
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => { if (r.raw !== undefined) return r.raw; return r.body; }, text: async () => JSON.stringify(r.body) };
}
function route(w, method, u) {
  const p = u.pathname;
  if (method === 'DELETE' && p === '/v13/deployments/' + LEGACY) { w.deleted = w.deleteResponse.status === 200 && w.deleteResponse.body && w.deleteResponse.body.state === 'DELETED'; return w.deleteResponse; }
  if (method !== 'GET') return { status: 405, body: {} };
  if (u.host === 'api.vercel.com') {
    if (p === '/v13/deployments/' + PROD) return { status: 200, body: w.prod };
    if (p === '/v13/deployments/' + ROLLBACK) return { status: 200, body: w.rollback };
    if (p === '/v13/deployments/' + LEGACY) return w.deleted ? { status: 404, body: { error: {} } } : { status: 200, body: w.legacy };
    if (p === '/v4/aliases/vdsen-ecosistema.vercel.app') return { status: 200, body: w.prodAlias };
    if (p === '/v2/deployments/' + LEGACY + '/aliases') return { status: 200, body: w.legacyAliases };
    if (p === '/v4/aliases') { const page = u.searchParams.has('until') ? Number(u.searchParams.get('until')) : 0; return { status: 200, body: w.projectAliases[page] }; }
  }
  if (u.host === 'firestore.googleapis.com') {
    if (p.endsWith('/clients/' + UID)) return { status: 200, body: fsDoc(w.client) };
    if (p.endsWith('/releaseControl/autonomousProgression')) return { status: 200, body: fsDoc(w.release, w.releaseVersion) };
    if (p.endsWith('/coaches/' + COACH)) return { status: 200, body: fsDoc(w.coach) };
  }
  if (u.host === 'api.github.com') {
    const st = u.searchParams.get('status');
    if (p.endsWith('/actions/runs') && st) return { status: 200, body: { total_count: w.runs[st].length, workflow_runs: w.runs[st] } };
    if (p.endsWith('/workflows/vdsen-retire-legacy-deployment.yml/runs')) return { status: 200, body: { total_count: w.history.length, workflow_runs: w.history } };
  }
  return { status: 404, body: {} };
}
const run = (w, extra = {}) => R.retireLegacyDeployment(STATE, Object.assign({ env: ENV, fetch: w.fetch, now: () => NOW, vercelToken: SECRET, googleToken: GSECRET, githubToken: HSECRET }, extra));
const deletes = (w) => w.calls.filter((c) => c.method === 'DELETE');
async function blocked(w, reasonRe, extra) {
  const r = await run(w, extra);
  assert.equal(r.verdict, 'BLOCKED', JSON.stringify(r));
  assert.match(r.reason, reasonRe);
  assert.equal(deletes(w).length, 0, 'no DELETE may be issued');
  return r;
}

test('T733 happy path: two identical snapshots, ONE exact DELETE, four-read verification -> LEGACY_RETIRED_VERIFIED', async () => {
  const w = world(), r = await run(w);
  assert.equal(r.verdict, 'LEGACY_RETIRED_VERIFIED', JSON.stringify(r));
  assert.equal(deletes(w).length, 1);
  assert.equal(deletes(w)[0].url, 'https://api.vercel.com/v13/deployments/' + LEGACY + '?teamId=' + TEAM);
  assert.ok(w.calls.every((c) => c.method === 'GET' || c.method === 'DELETE'));
  assert.ok(w.calls.filter((c) => c.method === 'DELETE').every((c) => !c.url.includes(PROD) && !c.url.includes(ROLLBACK)));
  assert.equal(w.count('GET', '/v13/deployments/' + PROD), 4, 'two snapshots + two post reads');
  assert.equal(w.count('GET', '/v13/deployments/' + LEGACY), 3, 'two snapshots + post read');
  assert.equal(r.post_verification.legacy.status, 404);
  assert.equal(r.post_verification.production_before.valid && r.post_verification.production_after.valid && r.post_verification.rollback.valid, true);
});

test('T733 alias: HTTP 400/403 on any alias read blocks (a failed read is not absence of aliases)', async () => {
  for (const status of [400, 403]) {
    for (const path of ['/v4/aliases/vdsen-ecosistema.vercel.app', '/v2/deployments/' + LEGACY + '/aliases', '/v4/aliases']) {
      await blocked(world({ hooks: { [path]: () => ({ status, body: {} }) } }), /ALIAS(ES)?_READ_FAILED_/);
    }
  }
});

test('T733 alias: malformed responses block (production alias, legacy aliases, project list, pagination)', async () => {
  await blocked(world({ prodAlias: { alias: 'vdsen-ecosistema.vercel.app', projectId: PROJECT } }), /PROD_ALIAS_MALFORMED/);
  await blocked(world({ prodAlias: { alias: 'other.example', projectId: PROJECT, deployment: { id: PROD } } }), /PROD_ALIAS_MALFORMED/);
  await blocked(world({ legacyAliases: { aliases: 'none' } }), /LEGACY_ALIASES_MALFORMED/);
  await blocked(world({ legacyAliases: {} }), /LEGACY_ALIASES_MALFORMED/);
  await blocked(world({ projectAliases: [{ aliases: null, pagination: { next: null } }] }), /PROJECT_ALIASES_MALFORMED/);
  await blocked(world({ projectAliases: [{ aliases: [42], pagination: { next: null } }] }), /PROJECT_ALIASES_MALFORMED/);
  await blocked(world({ hooks: { '/v4/aliases': () => ({ status: 200, body: {}, raw: ['array'] }) } }), /PROJECT_ALIASES_READ_FAILED_200/);
  await blocked(world({ projectAliases: [{ aliases: Array.from({ length: 100 }, (_, i) => ({ alias: 'a' + i + '.x', deploymentId: PROD })) }] }), /PAGINATION_MALFORMED/);
});

test('T733 alias: any alias tied to the legacy deployment blocks (legacy list, project-wide list on a later page, production alias)', async () => {
  await blocked(world({ legacyAliases: { aliases: [{ alias: 'old.vercel.app', uid: 'a1' }] } }), /LEGACY_HAS_ACTIVE_ALIAS/);
  await blocked(world({ projectAliases: [{ aliases: [{ alias: 'a.x', deploymentId: PROD }], pagination: { next: 1 } }, { aliases: [{ alias: 'b.x', deploymentId: LEGACY }], pagination: { next: null } }] }), /LEGACY_HAS_ACTIVE_ALIAS/);
  await blocked(world({ prodAlias: { alias: 'vdsen-ecosistema.vercel.app', projectId: PROJECT, deployment: { id: LEGACY } } }), /LEGACY_IS_PRODUCTION_ALIAS_TARGET/);
  await blocked(world({ prodAlias: { alias: 'vdsen-ecosistema.vercel.app', projectId: PROJECT, deployment: { id: 'dpl_other' } } }), /PROD_ALIAS_TARGET_MISMATCH/);
  await blocked(world({ prodAlias: { alias: 'vdsen-ecosistema.vercel.app', projectId: 'prj_other', deployment: { id: PROD } } }), /PROD_ALIAS_PROJECT_MISMATCH/);
  assert.equal((await run(world({ prodAlias: { alias: 'vdsen-ecosistema.vercel.app', deployment: { id: PROD } } }))).verdict, 'LEGACY_RETIRED_VERIFIED', 'projectId may be omitted by the API; the target deployment is verified separately');
});

test('T733 identity: absent/invalid githubCommitSha is not evidence; state, target, SHA and rollback provenance are enforced', async () => {
  await blocked(world({ prod: { ...world().prod, meta: {} } }), /PROD_SHA_MISSING/);
  await blocked(world({ prod: { ...world().prod, meta: { githubCommitSha: 'short' } } }), /PROD_SHA_MISSING/);
  await blocked(world({ prod: { ...world().prod, meta: { githubCommitSha: 'a'.repeat(40) } } }), /PROD_SHA_MISMATCH/);
  await blocked(world({ prod: { ...world().prod, readyState: 'ERROR' } }), /PROD_NOT_READY/);
  await blocked(world({ prod: { ...world().prod, projectId: 'prj_other' } }), /PROD_IDENTITY_MISMATCH/);
  await blocked(world({ rollback: { ...world().rollback, meta: {} } }), /ROLLBACK_SHA_MISSING/);
  await blocked(world({ rollback: { ...world().rollback, meta: { githubCommitSha: 'b'.repeat(40) } } }), /ROLLBACK_OFF_PROVENANCE_MISMATCH/);
  await blocked(world({ rollback: { ...world().rollback, teamId: 'team_other' } }), /ROLLBACK_IDENTITY_MISMATCH/);
  await blocked(world({ legacy: { ...world().legacy, projectId: 'prj_other' } }), /LEGACY_IDENTITY_MISMATCH/);
  await blocked(world({ hooks: { ['/v13/deployments/' + LEGACY]: () => ({ status: 404, body: {} }) } }), /LEGACY_ALREADY_RETIRED/);
});

test('T733 Firestore: enabled fences, live window, foreign scope, unreadable or missing credential all block before DELETE', async () => {
  await blocked(world({ release: { ...world().release, enabled: true } }), /RELEASE_FENCE_NOT_DISABLED/);
  await blocked(world({ release: { ...world().release, enabled: undefined } }), /RELEASE_FENCE_NOT_DISABLED|FIRESTORE_READ_UNAVAILABLE/);
  await blocked(world({ coach: { autoApplyCanary: { enabled: true, clientIds: [UID] } } }), /COACH_CANARY_NOT_DISABLED/);
  await blocked(world({ coach: {} }), /COACH_CANARY_NOT_DISABLED/);
  await blocked(world({ release: { ...world().release, expiresAt: '2026-11-10T03:30:00Z' } }), /RELEASE_WINDOW_STILL_VALID_OR_UNREADABLE/);
  await blocked(world({ release: { ...world().release, expiresAt: 'garbage' } }), /RELEASE_WINDOW_STILL_VALID_OR_UNREADABLE/);
  await blocked(world({ release: { ...world().release, clientIds: [UID, 'X'.repeat(28)] } }), /FENCE_SCOPE_NOT_AYRTON_ONLY/);
  await blocked(world({ coach: { autoApplyCanary: { enabled: false, clientIds: ['X'.repeat(28)] } } }), /FENCE_SCOPE_NOT_AYRTON_ONLY/);
  for (const p of ['/releaseControl/autonomousProgression', '/coaches/' + COACH, '/clients/' + UID]) {
    const w = world({ hooks: {} });
    const orig = w.fetch;
    w.fetch = async (url, o) => (String(url).includes('firestore') && String(url).includes(p) ? respond({ status: 403, body: {} }) : orig(url, o));
    await blocked(w, /FIRESTORE_READ_UNAVAILABLE/);
  }
  await blocked(world(), /MISSING_CREDENTIAL/, { googleToken: '' });
  await blocked(world(), /MISSING_CREDENTIAL/, { vercelToken: '' });
});

test('T733 context: non-canonical branch/repository/event and reruns are rejected before any network call', async () => {
  for (const [patch, re] of [[{ GITHUB_REF: 'refs/heads/feature/x' }, /REF_NOT_CANONICAL/], [{ GITHUB_REPOSITORY: 'someone/else' }, /REPOSITORY_NOT_CANONICAL/],
    [{ GITHUB_EVENT_NAME: 'pull_request' }, /EVENT_NOT_DISPATCH/], [{ GITHUB_RUN_ATTEMPT: '2' }, /RERUN_NOT_AUTHORIZED/], [{ GITHUB_RUN_ID: '' }, /RUN_ID_INVALID/]]) {
    const w = world();
    await blocked(w, re, { env: { ...ENV, ...patch } });
    assert.equal(w.calls.length, 0);
  }
});

test('T733 concurrency: another active production operation or an uncertain prior retirement blocks; own run is ignored', async () => {
  const mk = (id, file, extra) => ({ id, path: '.github/workflows/' + file, ...extra });
  await blocked(world({ runs: { in_progress: [mk(1, 'vdsen-release-prod.yml')], queued: [], waiting: [] } }), /CONCURRENT_PRODUCTION_OPERATION/);
  await blocked(world({ runs: { in_progress: [], queued: [mk(2, 'vdsen-retire-legacy-deployment.yml')], waiting: [] } }), /CONCURRENT_PRODUCTION_OPERATION/);
  await blocked(world({ runs: { in_progress: [], queued: [], waiting: [mk(3, 'vdsen-ayrton-runtime.yml@refs/heads/x')] } }), /CONCURRENT_PRODUCTION_OPERATION/);
  await blocked(world({ history: [mk(4, 'vdsen-retire-legacy-deployment.yml', { conclusion: 'cancelled' })] }), /PRIOR_RETIREMENT_UNCERTAIN/);
  await blocked(world({ runs: { in_progress: [{ id: 5, path: 'x' }], queued: [], waiting: [] }, hooks: { '/repos/vdsenasesoria-svg/vdsen-ecosistema/actions/runs': () => ({ status: 200, body: { total_count: 500, workflow_runs: [] } }) } }), /CONCURRENCY_READ_UNAVAILABLE/);
  await blocked(world({ hooks: { '/repos/vdsenasesoria-svg/vdsen-ecosistema/actions/runs': () => ({ status: 403, body: {} }) } }), /CONCURRENCY_READ_UNAVAILABLE/);
  const ok = world({ runs: { in_progress: [mk(900, 'vdsen-retire-legacy-deployment.yml'), mk(6, 'vdsen-release-check.yml')], queued: [], waiting: [] } });
  assert.equal((await run(ok)).verdict, 'LEGACY_RETIRED_VERIFIED');
});

test('T733 window: a change between preflight and DELETE stops without DELETE (production, alias, fences, concurrency)', async () => {
  await blocked(world({ hooks: { '/v4/aliases/vdsen-ecosistema.vercel.app': (w, n) => n >= 2 ? { status: 200, body: { alias: 'vdsen-ecosistema.vercel.app', projectId: PROJECT, deployment: { id: 'dpl_changed' } } } : undefined } }), /RECHECK_PROD_ALIAS_TARGET_MISMATCH/);
  await blocked(world({ hooks: { ['/v13/deployments/' + PROD]: (w, n) => n >= 2 ? { status: 200, body: { ...w.prod, meta: { githubCommitSha: 'c'.repeat(40) } } } : undefined } }), /RECHECK_PROD_SHA_MISMATCH/);
  const w1 = world(); const f1 = w1.fetch; let seen = 0;
  w1.fetch = async (u, o) => { if (String(u).includes('releaseControl')) { seen++; if (seen >= 2) w1.releaseVersion = '2026-11-10T02:59:59.000000Z'; } return f1(u, o); };
  await blocked(w1, /STATE_CHANGED_BEFORE_DELETE/);
  const w2 = world(); const f2 = w2.fetch; let secondSnapshot = 0;
  w2.fetch = async (u, o) => { if (String(u).includes('releaseControl')) { secondSnapshot++; if (secondSnapshot >= 2) w2.release = { ...w2.release, enabled: true }; } return f2(u, o); };
  await blocked(w2, /RECHECK_RELEASE_FENCE_NOT_DISABLED/);
  await blocked(world({ hooks: { '/repos/vdsenasesoria-svg/vdsen-ecosistema/actions/runs': (w, n) => n > 3 ? { status: 200, body: { total_count: 1, workflow_runs: [{ id: 77, path: '.github/workflows/vdsen-rollback.yml' }] } } : undefined } }), /RECHECK_CONCURRENT_PRODUCTION_OPERATION/);
});

test('T733 DELETE: uncertain results are reconciled by reads and never retried', async () => {
  const net = world({ hooks: { ['DELETE /v13/deployments/' + LEGACY]: () => new Error('socket hang up') } });
  const r1 = await run(net);
  assert.equal(r1.verdict, 'UNCERTAIN'); assert.match(r1.reason, /DELETE_RESULT_NOT_CLEAN_NETWORK/);
  assert.equal(deletes(net).length, 1);
  assert.equal(r1.post_verification.legacy.status, 200, 'reconciliation shows the legacy still exists');
  const unclean = world({ deleteResponse: { status: 200, body: { uid: 'dpl_other', state: 'DELETED' } } });
  const r2 = await run(unclean); assert.equal(r2.verdict, 'UNCERTAIN'); assert.equal(deletes(unclean).length, 1);
  const rejected = world({ deleteResponse: { status: 403, body: {} } });
  const r3 = await run(rejected); assert.equal(r3.verdict, 'UNCERTAIN'); assert.match(r3.reason, /DELETE_RESULT_NOT_CLEAN_403/); assert.equal(deletes(rejected).length, 1);
  const timeout = world({ deleteResponse: { status: 504, body: {} } });
  assert.equal((await run(timeout)).verdict, 'UNCERTAIN'); assert.equal(deletes(timeout).length, 1);
});

test('T733 post verification: mismatching or failing identity after DELETE is UNCERTAIN', async () => {
  const afterDelete = (mk) => world({ hooks: { ['/v13/deployments/' + PROD]: (w, n) => (w.deleted ? mk(w) : undefined) } });
  for (const mk of [(w) => ({ status: 200, body: { ...w.prod, projectId: 'prj_other' } }), (w) => ({ status: 500, body: {} }), (w) => ({ status: 200, body: { ...w.prod, meta: {} } })]) {
    const w = afterDelete(mk), r = await run(w);
    assert.equal(r.verdict, 'UNCERTAIN'); assert.equal(r.reason, 'POST_VERIFICATION_FAILED'); assert.equal(deletes(w).length, 1);
  }
  const rb = world({ hooks: { ['/v13/deployments/' + ROLLBACK]: (w) => (w.deleted ? { status: 200, body: { ...w.rollback, id: 'dpl_wrong' } } : undefined) } });
  assert.equal((await run(rb)).verdict, 'UNCERTAIN');
  const leg = world({ hooks: { ['/v13/deployments/' + LEGACY]: (w) => (w.deleted ? { status: 403, body: {} } : undefined) } });
  const r = await run(leg); assert.equal(r.verdict, 'UNCERTAIN'); assert.equal(r.post_verification.legacy.retired, false, 'a 403 is not a 404');
});

test('T733 safety: constants are immutable, the DELETE target is fixed, no credential is ever echoed', async () => {
  assert.equal(LEGACY, 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K'); assert.equal(PROD, 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H'); assert.equal(ROLLBACK, 'dpl_AuykDuRaXejkbUzFNjFz6XocNPZt');
  assert.equal(PROJECT, 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN'); assert.equal(TEAM, 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8');
  assert.equal(R.executeSingleDelete.length, 1, 'takes only a context: no caller-supplied deployment ID');
  for (const w of [world(), world({ deleteResponse: { status: 403, body: {} } }), world({ prodAlias: {} })]) {
    const text = JSON.stringify(await run(w));
    for (const s of [SECRET, GSECRET, HSECRET, 'Bearer', 'Authorization']) assert.ok(!text.includes(s), 'result leaked ' + s);
  }
  const bad = await R.retireLegacyDeployment({ ...STATE, production_deployment: 'dpl_other' }, { env: ENV, fetch: world().fetch, now: () => NOW, vercelToken: 'a', googleToken: 'b', githubToken: 'c' });
  assert.equal(bad.verdict, 'BLOCKED'); assert.equal(bad.reason, 'MANIFEST_CONTRACT_MISMATCH');
});

test('T733 workflow: canonical-only, non-cancelling shared lock, no reruns, read-only token scopes, existing secret only', () => {
  const wf = fs.readFileSync('.github/workflows/vdsen-retire-legacy-deployment.yml', 'utf8').split('\r\n').join('\n');
  const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /^concurrency:\n  group: vdsen-production\n  cancel-in-progress: false$/m);
  assert.ok(code.includes("github.ref == 'refs/heads/codex/client-app-next'") && code.includes("github.repository == 'vdsenasesoria-svg/vdsen-ecosistema'") && code.includes('github.run_attempt == 1'));
  assert.match(code, /^on:\n  workflow_dispatch:/m); assert.ok(!/pull_request|push:|schedule:/.test(code));
  assert.match(code, /^permissions:\n  contents: read\n  actions: read\n  id-token: write$/m);
  assert.ok(!/(contents|actions|packages|pull-requests|issues|checks|statuses|deployments): write/.test(code));
  assert.ok(code.includes('environment: Production') && !code.includes('environment: production'));
  assert.deepEqual([...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]), ['VERCEL_TOKEN']);
  assert.deepEqual([...new Set([...code.matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]))].sort(), ['GCP_PROJECT_ID', 'GCP_RELEASE_SERVICE_ACCOUNT', 'GCP_WORKLOAD_IDENTITY_PROVIDER']);
  assert.ok(!code.includes('credentials_json:') && !/pull_request_target/.test(code));
  assert.ok(code.includes('dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K') && !code.includes(PROD) && !code.includes(ROLLBACK));
  assert.ok(!/echo[^\n]*(VERCEL_TOKEN|GOOGLE_ACCESS_TOKEN|GITHUB_TOKEN|secrets\.)/.test(code));
  assert.ok(!/\$\{\{\s*inputs\.[^}]*\}\}/.test(code.split('\n').filter((l) => /^\s+run:/.test(l)).join('\n')), 'inputs never interpolated into shell');
});
