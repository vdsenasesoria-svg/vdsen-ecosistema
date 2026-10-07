'use strict';
// Tests for the APP-ONLY production release lane.
//
// Every gate is exercised by calling the exported pure contract functions directly, so no
// test touches production or the network. One source-level test proves the invariant that
// matters most: this lane has no Firestore/rules mutation path at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../scripts/release/app-live.cjs');

const RUNTIME = 'c3e78380d3a076e643a1957203c093260851210e';
const PROD_DEPLOYMENT = 'dpl_FngrtpodSKHZ9aPk75aA5SS7JGnB';
const PROD_RUNTIME = 'd7bb71521d750eafd46a15fdd3c6ee157d4bd4cf';
const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const MAIN = 'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c';

const candidate = (over = {}) => Object.assign({
  id: 'dpl_candidate000000000000000001',
  projectId: PROJECT,
  teamId: TEAM,
  target: 'preview',
  readyState: 'READY',
  source: 'git',
  created: 1000,
  meta: { githubCommitSha: RUNTIME, githubCommitRef: 'codex/client-app-next' },
}, over);

const clone = (x) => JSON.parse(JSON.stringify(x));
const throws = (fn, re, label) => {
  try { fn(); assert.fail(label + ' (no lanzo)'); }
  catch (e) { assert.match(e.message, re, label + ' :: ' + e.message); }
};

test('A12-1 wrong candidate SHA -> FAIL', () => {
  throws(() => app.assertCandidate(candidate({ meta: { githubCommitSha: 'a'.repeat(40), githubCommitRef: 'x' } }),
    { runtime: RUNTIME, project: PROJECT, team: TEAM }), /githubCommitSha does not match/, 'sha distinto');
});

test('A12-2 candidate not READY -> FAIL', () => {
  throws(() => app.assertCandidate(candidate({ readyState: 'BUILDING' }), { runtime: RUNTIME, project: PROJECT, team: TEAM }),
    /not READY/, 'no listo');
});

test('A12-3 candidate project mismatch -> FAIL', () => {
  throws(() => app.assertCandidate(candidate({ projectId: 'prj_otro' }), { runtime: RUNTIME, project: PROJECT, team: TEAM }),
    /project mismatch/, 'proyecto distinto');
});

test('A12-4 candidate team mismatch -> FAIL', () => {
  throws(() => app.assertCandidate(candidate({ teamId: 'team_otro' }), { runtime: RUNTIME, project: PROJECT, team: TEAM }),
    /team mismatch/, 'equipo distinto');
});

test('A12-5 candidate already production -> FAIL unless explicitly handled', () => {
  throws(() => app.assertCandidateNotAlreadyProduction(candidate(), candidate().id),
    /already the production deployment/, 'candidato ya en produccion');
  assert.equal(app.assertCandidateNotAlreadyProduction(candidate(), PROD_DEPLOYMENT), true);
  // and a production-targeted deployment is not accepted as the pre-promotion candidate
  throws(() => app.assertCandidate(candidate({ target: 'production' }), { runtime: RUNTIME, project: PROJECT, team: TEAM }),
    /must not already be a production deployment/, 'target production');
  // MEASURED: Vercel only populates `target` for production; a preview reports null/absent.
  // Requiring target === 'preview' rejected a valid candidate, so null must be allowed.
  assert.equal(app.assertCandidate(candidate({ target: null }), { runtime: RUNTIME, project: PROJECT, team: TEAM }).target, null);
  const noTarget = candidate(); delete noTarget.target;
  assert.equal(app.assertCandidate(noTarget, { runtime: RUNTIME, project: PROJECT, team: TEAM }).target, undefined);
});

test('A12-6 production baseline deployment mismatch -> FAIL', () => {
  throws(() => app.assertBaseline({ aliasDeploymentId: 'dpl_otro', expectedDeploymentId: PROD_DEPLOYMENT, mainSha: MAIN, expectedMainSha: MAIN }),
    /baseline deployment mismatch/, 'baseline distinta');
  assert.equal(app.assertBaseline({ aliasDeploymentId: PROD_DEPLOYMENT, expectedDeploymentId: PROD_DEPLOYMENT, mainSha: MAIN, expectedMainSha: MAIN }), undefined);
});

test('A12-7 main baseline changed -> FAIL', () => {
  throws(() => app.assertBaseline({ aliasDeploymentId: PROD_DEPLOYMENT, expectedDeploymentId: PROD_DEPLOYMENT, mainSha: 'b'.repeat(40), expectedMainSha: MAIN }),
    /main moved/, 'main movido');
});

test('A12-8 app kill switch false -> FAIL', () => {
  const previous = process.env.CLIENT_APP_RELEASE_ENABLED;
  try {
    delete process.env.CLIENT_APP_RELEASE_ENABLED;
    throws(() => app.assertKillSwitch(), /CLIENT_APP_RELEASE_ENABLED must be true/, 'kill switch ausente');
    process.env.CLIENT_APP_RELEASE_ENABLED = 'false';
    throws(() => app.assertKillSwitch(), /CLIENT_APP_RELEASE_ENABLED must be true/, 'kill switch false');
    process.env.CLIENT_APP_RELEASE_ENABLED = 'true';
    assert.equal(app.assertKillSwitch(), undefined);
  } finally {
    if (previous === undefined) delete process.env.CLIENT_APP_RELEASE_ENABLED; else process.env.CLIENT_APP_RELEASE_ENABLED = previous;
  }
});

test('A12-9 the rules kill switch is irrelevant to this lane and stays false', () => {
  // The app lane must not read PRODUCTION_RELEASE_ENABLED at all.
  const src = fs.readFileSync('scripts/release/app-live.cjs', 'utf8');
  assert.ok(!src.includes('PRODUCTION_RELEASE_ENABLED'), 'app lane must not consult the rules kill switch');
  assert.equal(app.assertKillSwitch.length, 0, 'kill switch check takes no argument');
  // and the repo state still declares the rules switch false
  assert.equal(require('../scripts/release/lib.cjs').json('.release/vdsen-client.json').numeric_apply_enabled, false);
});

test('A12-10 missing Production Firebase env -> FAIL', () => {
  const full = app.REQUIRED_PROD_ENV.map((k) => ({ key: k, target: ['production'], value: k === 'FIREBASE_PROJECT_ID' ? 'vdsen-ecosistema' : 'x' }));
  assert.deepEqual(app.assertEnvironment(full), { present: app.REQUIRED_PROD_ENV.length, missing: [] });
  for (const missing of ['FIREBASE_PRIVATE_KEY', 'OPENAI_API_KEY', 'FIREBASE_PROJECT_ID']) {
    const partial = full.filter((e) => e.key !== missing);
    throws(() => app.assertEnvironment(partial), new RegExp('Missing Production-scoped variables: ' + missing), 'falta ' + missing);
  }
  // a variable that exists but only for preview is still missing for production
  const previewOnly = full.map((e) => (e.key === 'OPENAI_MODEL' ? { key: 'OPENAI_MODEL', target: ['preview'] } : e));
  throws(() => app.assertEnvironment(previewOnly), /Missing Production-scoped variables: OPENAI_MODEL/, 'solo preview');
});

test('A12-10b FIREBASE_PROJECT_ID must name the released project', () => {
  const ok = [{ key: 'FIREBASE_PROJECT_ID', target: ['production'], value: 'vdsen-ecosistema' }];
  assert.equal(app.assertFirebaseProject(ok, 'vdsen-ecosistema'), 'MATCH');
  throws(() => app.assertFirebaseProject([{ key: 'FIREBASE_PROJECT_ID', target: ['production'], value: 'otro-proyecto' }], 'vdsen-ecosistema'),
    /does not match the released Firebase project/, 'proyecto firebase distinto');
});

test('A12-11 rollback artifact must exist before mutation', () => {
  throws(() => app.assertRollbackArtifact(null), /must exist BEFORE mutation/, 'sin artefacto');
  const good = {
    candidate_sha: RUNTIME, candidate_deployment: candidate().id, production_deployment: PROD_DEPLOYMENT,
    production_runtime_sha: PROD_RUNTIME, production_project: PROJECT, vercel_team: TEAM,
    production_origin: 'https://vdsen-ecosistema.vercel.app', main_sha: MAIN, captured_at: '2026-10-07T00:00:00.000Z',
  };
  assert.equal(app.assertRollbackArtifact(good).candidate_deployment, candidate().id);
  for (const field of ['candidate_sha', 'production_deployment', 'production_runtime_sha', 'main_sha', 'captured_at']) {
    const bad = clone(good); delete bad[field];
    throws(() => app.assertRollbackArtifact(bad), new RegExp('missing ' + field), 'falta ' + field);
  }
});

test('A12-12 failed post-promotion verification triggers APP rollback', async () => {
  // Behavioural: run the REAL apply() with fake mutation steps pointed at a temp output dir,
  // and make the post-promotion byte smoke fail. apply() must fail loudly and mark the result
  // as requiring an APP rollback, with rules untouched.
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'applane-'));
  const prevOut = app.getOut();
  const prevRuntime = process.env.APP_RUNTIME_SHA;
  try {
    app.setOut(tmp);
    process.env.APP_RUNTIME_SHA = RUNTIME;
    fs.writeFileSync(path.join(tmp, 'app-preflight.json'), JSON.stringify({ runtime_sha: RUNTIME, rollback_artifact: 'app-rollback-test.json' }));
    fs.writeFileSync(path.join(tmp, 'app-rollback-test.json'), JSON.stringify({
      candidate_sha: RUNTIME, candidate_deployment: 'dpl_candidate000000000000000001',
      production_deployment: PROD_DEPLOYMENT, production_runtime_sha: PROD_RUNTIME,
      production_project: PROJECT, vercel_team: TEAM, production_origin: 'https://x', main_sha: MAIN, captured_at: 'now',
    }));
    const steps = {
      promote: async () => 'ok',
      currentApp: async () => 'dpl_new0000000000000000000001',
      deployment: async () => ({ readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: RUNTIME } }),
      servedSurface: () => ['vdsen-cliente.html'],
      verifyPublicBytes: async () => { throw new Error('Public byte mismatch: vdsen-cliente.html'); },
    };
    await assert.rejects(() => app.apply(steps), /Public byte mismatch/);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'app-result.json'), 'utf8'));
    assert.equal(saved.app_release_status, 'FAIL', 'debe marcar FAIL');
    assert.equal(saved.rollback_required, true, 'debe exigir rollback de la APP');
    assert.equal(saved.rules_mutated, false, 'no debe tocar reglas');
    assert.equal(saved.previous_deployment, PROD_DEPLOYMENT, 'debe recordar el deployment previo');

    // and a promoted deployment carrying the wrong SHA is rejected before any success claim
    throws(() => app.assertPromoted({ readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: 'c'.repeat(40) } },
      { runtime: RUNTIME, project: PROJECT, team: TEAM, productionDeploymentId: 'dpl_x' }), /Promoted runtime SHA mismatch/, 'sha promovido distinto');

    // the success path, for contrast, is clean
    const okSteps = Object.assign({}, steps, { verifyPublicBytes: async () => ['vdsen-cliente.html'] });
    const ok = await app.apply(okSteps);
    assert.equal(ok.app_release_status, 'SUCCESS');
    assert.equal(ok.rules_mutated, false);
    assert.equal(ok.production_deployment, 'dpl_new0000000000000000000001');
  } finally {
    app.setOut(prevOut);
    if (prevRuntime === undefined) delete process.env.APP_RUNTIME_SHA; else process.env.APP_RUNTIME_SHA = prevRuntime;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A12-13 APP rollback does not mutate Firestore rules', () => {
  const src = fs.readFileSync('scripts/release/app-live.cjs', 'utf8');
  const rb = src.slice(src.indexOf('async function rollbackApp()'), src.indexOf('function releaseResult()'));
  for (const forbidden of ['rules', 'firestore', 'firebaserules', 'ruleset', 'restoreRules']) {
    assert.ok(!new RegExp(forbidden, 'i').test(rb.replace(/rules_mutated: false/g, '').replace(/\/\/.*$/gm, '')),
      'rollbackApp must not reference ' + forbidden);
  }
  assert.ok(/rules_mutated: false/.test(rb), 'rollback result must state rules were not mutated');
  // the lane as a whole has no Firestore endpoint
  assert.equal(app.assertAppOnlySources(), true);
});

test('A12-14 production byte mismatch -> FAIL', () => {
  const src = fs.readFileSync('scripts/release/app-live.cjs', 'utf8');
  assert.ok(/assert\.equal\(actual, expected, 'Public byte mismatch: ' \+ p\)/.test(src), 'byte mismatch must assert');
  assert.ok(/cache: 'no-store'/.test(src), 'byte smoke must use cache-busting');
  assert.ok(/redirect: 'error'/.test(src), 'byte smoke must not follow redirects');
});

test('A12-15 exact successful candidate -> PASS', () => {
  const c = app.assertCandidate(candidate(), { runtime: RUNTIME, project: PROJECT, team: TEAM });
  assert.equal(c.meta.githubCommitSha, RUNTIME);
  assert.equal(c.target, 'preview');
  assert.equal(c.readyState, 'READY');
  assert.equal(app.assertCandidateNotAlreadyProduction(c, PROD_DEPLOYMENT), true);
  assert.equal(app.assertPromoted({ readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: RUNTIME } },
    { runtime: RUNTIME, project: PROJECT, team: TEAM, productionDeploymentId: 'dpl_new' }), undefined);
});

test('A12-16 no secret values are printed', () => {
  const src = fs.readFileSync('scripts/release/app-live.cjs', 'utf8');
  assert.ok(!/console\.log\([^)]*TOKEN/.test(src), 'must not log tokens');
  assert.ok(!/console\.log\([^)]*PRIVATE_KEY/.test(src), 'must not log keys');
  assert.ok(!/console\.log\([^)]*envs/.test(src), 'must not log the env array');
  assert.ok(/Identify WHICH operation failed/.test(src), 'the no-print rule is documented');
  // and a failure names the ENDPOINT, so a 400 is triageable without another 25-minute run
  assert.ok(/API ' \+ method \+ ' ' \+ where \+ ' failed: HTTP '/.test(src), 'el error debe identificar el endpoint');
  assert.ok(/new URL\(url\)\.pathname/.test(src), 'solo el path, nunca la query con el team id');
  // the artifact guard rejects secret-looking content
  throws(() => app.assertRollbackArtifact({
    candidate_sha: RUNTIME, candidate_deployment: 'dpl_a', production_deployment: 'dpl_b',
    production_runtime_sha: PROD_RUNTIME, production_project: PROJECT, vercel_team: TEAM,
    production_origin: 'https://x', main_sha: MAIN, captured_at: 'now', note: 'Bearer abc',
  }), /must not contain secrets/, 'secreto en artefacto');
});

test('A12-17 no use of latest/HEAD as a runtime target', () => {
  for (const bad of ['latest', 'HEAD', 'main', 'codex/client-app-next', '']) {
    throws(() => app.assertExplicitRuntime(bad), /never latest\/HEAD\/branch|must be a full 40-char commit SHA/, 'rechaza ' + JSON.stringify(bad));
  }
  throws(() => app.assertExplicitRuntime(undefined), /Explicit runtime SHA required/, 'rechaza undefined');
  assert.ok(app.FORBIDDEN_RUNTIME_VALUES.includes('latest'));
  assert.equal(app.assertExplicitRuntime(RUNTIME), RUNTIME);
});

test('A12-18 the lane cannot mutate Firestore, rules, IAM or main', () => {
  const src = fs.readFileSync('scripts/release/app-live.cjs', 'utf8');
  const forbiddenImport = 'require(' + JSON.stringify('./li' + 've.cjs') + ')';
  assert.ok(!src.includes(forbiddenImport), 'must not import the rules lane');
  // Precise on purpose: an earlier version matched the bare word `force`, which is also how you
  // clean a temporary directory (`fs.rmSync(dir, { force: true })`) - a false positive that fired
  // as soon as the lane began exporting the candidate tree. History-MUTATING git verbs are what
  // must be absent, together with any force push.
  assert.ok(!/git\('(push|commit|reset|checkout|switch|merge|rebase|tag|branch|clean)'/.test(src), 'must not touch git history');
  assert.ok(!/force-with-lease|--force\b|git push/.test(src), 'must not force push');
  assert.ok(!/iam|serviceAccount|service-account|google-github-actions/.test(src), 'no IAM/credential work');
  assert.ok(!/NUMERIC_APPLY_ENABLED\s*=/.test(src), 'must not change the numeric flag');

  // The ONLY Firestore/rules contact is the single read-only observation, and it is a GET
  // (api() defaults to GET; no method argument is passed on that call).
  const observed = src.match(/firebaserules\.googleapis\.com/g) || [];
  assert.equal(observed.length, 1, 'exactly one rules API reference');
  assert.ok(!/firestore\.googleapis\.com/.test(src), 'the rules API is the only Firebase contact');
  const obs = src.slice(src.indexOf('async function observeLiveRulesReadOnly'));
  const obsCall = obs.slice(0, obs.indexOf('} catch'));
  assert.ok(!/,\s*'(POST|PATCH|PUT|DELETE)'/.test(obsCall), 'the rules observation must be read-only (GET)');
  assert.ok(/if \(!token\) return/.test(obsCall), 'the observation is optional');

  // Exactly two Vercel mutations, both documented endpoints (promote + revert).
  // Counted via the POST marker and located by endpoint fragment: a path-matching regex is
  // fragile here because the paths contain nested encodeURIComponent(...) calls.
  const postMarkers = (src.match(/, 'POST'\)/g) || []).length;
  assert.equal(postMarkers, 2, 'exactly two Vercel mutations');
  assert.ok(src.includes("'/v10/projects/' + encodeURIComponent(s.production_project) + '/promote/' + encodeURIComponent(id), 'POST')"),
    'promotion uses the documented promote endpoint');
  assert.ok(src.includes("'/v1/projects/' + encodeURIComponent(s.production_project) + '/rollback/' + encodeURIComponent(id), 'POST')"),
    'revert uses the documented rollback endpoint');
  // every other Vercel call is a read on a read endpoint
  const allCalls = [...src.matchAll(/vercel\(s, '([^']+)'/g)].map((m) => m[1]);
  assert.ok(allCalls.length >= 4, 'las llamadas Vercel existen (' + allCalls.length + ')');
  const reads = allCalls.filter((p) => !p.includes('/promote/') && !p.includes('/rollback/'));
  assert.ok(reads.length >= 3, 'las lecturas existen (' + reads.length + ')');
  // Keep this explicit. A regex with alternation is a trap here: /v(4|6|9|13)\// fails on
  // /v13 because /v1 matches first. /v10/projects/ is the prefix shared by the two mutation
  // endpoints, which are pinned separately above by their 'POST' marker.
  const allowedReadPrefixes = ['/v4/aliases/', '/v13/deployments/', '/v7/deployments?projectId=', '/v9/projects/', '/v10/projects/', '/v1/projects/'];
  for (const m of reads) {
    assert.ok(allowedReadPrefixes.some((p) => m.startsWith(p)), 'unexpected read endpoint: ' + m);
  }
  // Contract: the LIVE-production read must be ONE cheap request, because it runs inside a
  // convergence poll. Paging the deployment list there multiplied into >100 requests and the
  // upstream answered HTTP 400. The list endpoint is only for resolving the candidate SHA.
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/async function currentApp\(s\)[\s\S]{0,400}?\/v4\/aliases\//.test(code), 'currentApp debe resolver por alias en una sola llamada');
  assert.ok(!code.includes('&target=production'), 'currentApp ya no debe paginar la lista de deployments');
  // /v6 was retired (HTTP 400); the published spec lists only /v7 and /v13.
  assert.ok(code.includes('/v7/deployments'), 'la lista de deployments debe usar /v7');
  assert.ok(!code.includes('/v6/deployments'), 'no debe usar el endpoint retirado /v6');
  assert.equal(reads.filter((m) => m.startsWith('/v10/projects/')).length, 1, 'promote es el unico v10');
  assert.equal(reads.filter((m) => m.startsWith('/v1/projects/')).length, 1, 'rollback es el unico v1');
});

test('A12-19 candidate resolution uses exact metadata, never chronology', () => {
  const src = fs.readFileSync('scripts/release/app-live.cjs', 'utf8');
  const fn = src.slice(src.indexOf('async function resolveCandidate'), src.indexOf('async function productionEnv'));
  assert.ok(/githubCommitSha === runtime/.test(fn), 'must filter by exact SHA');
  assert.ok(/projectId === s\.production_project/.test(fn), 'must filter by exact project');
  assert.ok(/Ambiguous candidates for one SHA/.test(fn), 'must refuse ambiguity');
  assert.ok(!/most recent|latest/i.test(fn.replace(/most recently created/g, '')), 'must not select by recency alone');
});

test('A12-21 the deployment list uses uid; id must be normalised', () => {
  // Measured against the live API: a production entry has `uid` and NO `id`. Without
  // normalisation, `currentApp()` returns undefined and `awaitApp()` never matches.
  const raw = { uid: 'dpl_u1d000000000000000000001', projectId: PROJECT, target: 'production', readyState: 'READY', created: 1 };
  assert.equal(raw.id, undefined, 'el objeto crudo no trae id');
  const n = app.normalizeDeployment(raw);
  assert.equal(n.id, 'dpl_u1d000000000000000000001', 'id debe derivarse de uid');
  assert.equal(n.uid, 'dpl_u1d000000000000000000001', 'uid se conserva');
  assert.equal(app.normalizeDeployment({ id: 'dpl_real', uid: 'dpl_uid_other' }).id, 'dpl_real', 'un id existente manda');
  assert.equal(app.normalizeDeployment(null), null);
  assert.equal(app.normalizeDeployment(undefined), undefined);
  const src = fs.readFileSync('scripts/release/app-live.cjs', 'utf8');
  assert.ok(/\(list\.deployments \|\| \[\]\)\.map\(normalizeDeployment\)/.test(src), 'la lista debe normalizar');
});

test('A12-22 the Vercel URL separator must respect an existing query string', () => {
  // THE bug behind every HTTP 400 in the preflight: appending '?teamId=' unconditionally
  // produced '..?projectId=X&limit=40?teamId=Y' whenever the path already had a query, and the
  // upstream answered 400. Paths WITHOUT a query were fine, which is exactly why the alias
  // worked and the deployment list never did.
  const s = { vercel_team: 'team_TEST', production_project: 'prj_TEST' };
  const withQuery = app.vercelUrl(s, '/v7/deployments?projectId=X&limit=40');
  const without = app.vercelUrl(s, '/v4/aliases/host.example');
  assert.ok(withQuery.includes('limit=40&teamId='), 'una query existente usa & : ' + withQuery);
  assert.ok(!withQuery.includes('40?teamId'), 'nunca dos separadores ?');
  assert.equal((withQuery.match(/\?/g) || []).length, 1, 'exactamente un ?');
  assert.ok(without.includes('?teamId='), 'sin query usa ? : ' + without);
  assert.equal((without.match(/\?/g) || []).length, 1, 'exactamente un ?');
  assert.ok(withQuery.includes('teamId=team_TEST') && without.includes('teamId=team_TEST'), 'toda peticion lleva el team');
  const src = fs.readFileSync('scripts/release/app-live.cjs', 'utf8');
  assert.ok(/function vercelUrl\(s, p\)/.test(src), 'un unico constructor de URL');
  assert.ok(/const sep = p\.includes\('\?'\) \? '&' : '\?'/.test(src), 'el separador depende de la query existente');
  assert.ok(!/VERCEL_API \+ p \+ '\?teamId='/.test(src), 'no debe quedar el append ciego');
});

test('A12-20 served surface matches the frozen deployed-product manifest', () => {
  const surface = app.servedSurface();
  assert.ok(surface.includes('vdsen-cliente.html'), 'debe cubrir la app del cliente');
  assert.ok(surface.includes('sw.js'), 'debe cubrir el service worker');
  assert.ok(surface.length > 10, 'superficie completa');
  // and the manifest still describes the DEPLOYED runtime, not the candidate
  const manifest = require('../scripts/release/lib.cjs').json('.release/deployed-product.json');
  assert.equal(manifest.runtime_sha, PROD_RUNTIME, 'el manifiesto debe seguir describiendo lo desplegado');
});
