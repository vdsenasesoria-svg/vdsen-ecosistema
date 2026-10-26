'use strict';
// T618 — provenance diagnostic, SYNTHETIC fixtures only (no remote call is ever made: every fetch is an in-memory fake).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const P = require('../scripts/release/provenance-diagnostic.cjs');
const { json, validate } = require('../scripts/release/lib.cjs');
const state = json('.release/vdsen-client.json');
const schema = () => json('.release/schema/oidc-validation.schema.json');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SECRET_SOURCE = 'rules_version = "2"; // SYNTHETIC-RULES-SOURCE-MARKER-DO-NOT-LEAK\nservice cloud.firestore {}\r\n';
const RS = 'projects/vdsen-ecosistema/rulesets/rs-synthetic-001';

// A routable fake of the Google/Vercel read APIs. `over` replaces any (url-substring -> handler) to inject faults.
function fake(over, calls) {
  over = over || {};
  const base = {
    '/releases/cloud.firestore': () => ({ name: 'projects/vdsen-ecosistema/releases/cloud.firestore', rulesetName: RS, createTime: '2026-01-01T00:00:00.000000Z', updateTime: '2026-10-20T10:00:00.123456Z' }),
    '/rulesets/': () => ({ name: RS, createTime: '2026-10-20T09:59:00Z', source: { files: [{ name: 'firestore.rules', content: SECRET_SOURCE }] } }),
    '/v9/projects/': () => ({ id: state.production_project, accountId: state.vercel_team }),
    '/v4/aliases/': () => ({ alias: 'vdsen-ecosistema.vercel.app', deploymentId: 'dpl_SyntheticDeploy01', projectId: state.production_project }),
    '/v13/deployments/': () => ({ id: 'dpl_SyntheticDeploy01', projectId: state.production_project, readyState: 'READY', target: 'production', createdAt: Date.parse('2026-10-21T12:00:00Z'),
      meta: { githubCommitSha: 'f'.repeat(40) }, alias: ['vdsen-ecosistema.vercel.app'] })
  };
  return async (url, options) => {
    (calls || []).push([url, options]);
    const merged = Object.assign({}, base, over), route = [...new Set([...Object.keys(over), ...Object.keys(base)])].find((k) => url.includes(k));   // overrides take precedence
    const h = merged[route];
    if (h === undefined) return new Response('{}', { status: 404 });
    if (typeof h === 'number') return new Response('private-body-test-only', { status: h });
    if (h instanceof Error) throw h;
    return new Response(JSON.stringify(h(url)), { status: 200 });
  };
}
const collect = (over, calls) => P.collect({ state, googleToken: 'google-token-test-only', vercelToken: 'vercel-token-test-only', fetchImpl: fake(over, calls) });

// ── hash contract ──
test('T618.1 hash: deterministic, order independent, length-prefixed (no delimiter ambiguity), content untouched (CRLF / BOM / Unicode are significant)', () => {
  const a = { name: 'a.rules', content: 'x' }, b = { name: 'b.rules', content: 'yy' };
  const d1 = P.canonicalRulesDigest([a, b]), d2 = P.canonicalRulesDigest([b, a]);
  assert.equal(d1.sha256, d2.sha256); assert.equal(d1.fileCount, 2); assert.equal(d1.contentBytesTotal, 3); assert.ok(d1.canonicalBytes > d1.contentBytesTotal); assert.equal(d1.rawSingleFileSha256, null);
  assert.deepEqual(d1.fileNames, ['a.rules', 'b.rules']);
  const expected = Buffer.concat([Buffer.from('vdsen-rules-source-v1\n2\n'), Buffer.from('7:a.rules1:x7:b.rules2:yy')]);
  assert.equal(d1.sha256, sha(expected), 'documented byte layout');
  assert.notEqual(P.canonicalRulesDigest([{ name: 'ab', content: 'c' }]).sha256, P.canonicalRulesDigest([{ name: 'a', content: 'bc' }]).sha256, 'name/content boundary cannot be shifted');
  assert.notEqual(P.canonicalRulesDigest([{ name: 'a', content: 'x\r\n' }]).sha256, P.canonicalRulesDigest([{ name: 'a', content: 'x\n' }]).sha256, 'newlines are not normalized');
  assert.notEqual(P.canonicalRulesDigest([{ name: 'a', content: '﻿x' }]).sha256, P.canonicalRulesDigest([{ name: 'a', content: 'x' }]).sha256, 'BOM is not stripped');
  assert.equal(P.canonicalRulesDigest([{ name: 'a', content: 'é' }]).contentBytesTotal, 2, 'UTF-8 byte length, not code units');
  assert.deepEqual(P.canonicalRulesDigest([{ name: 'é', content: '' }, { name: 'z', content: '' }]).fileNames, ['z', 'é'].filter((n) => /^[A-Za-z0-9_./-]{1,100}$/.test(n)), 'bytewise (UTF-8) name order: z (0x7a) before é (0xc3 0xa9); non-allowlisted names are not published');
  assert.equal(P.canonicalRulesDigest([{ name: 'é', content: '' }, { name: 'z', content: '' }]).sha256, P.canonicalRulesDigest([{ name: 'z', content: '' }, { name: 'é', content: '' }]).sha256);
  const one = P.canonicalRulesDigest([{ name: 'firestore.rules', content: SECRET_SOURCE }]);
  assert.equal(one.rawSingleFileSha256, sha(Buffer.from(SECRET_SOURCE, 'utf8'))); assert.equal(one.contentBytesTotal, Buffer.byteLength(SECRET_SOURCE));
});
test('T618.2 hash: malformed or ambiguous sources are rejected, never hashed', () => {
  for (const bad of [null, [], 'x', [{ name: '', content: 'x' }], [{ name: 'a', content: 1 }], [{ name: 'a', content: 'x' }, { name: 'a', content: 'y' }], [{ name: 'a', content: '\uD800' }], [null]])
    assert.equal(P.canonicalRulesDigest(bad).ok, false, JSON.stringify(bad));
  assert.equal(P.knownComparison(P.KNOWN_RULES_SHA256.HISTORIC_FILE), 'RAW_SINGLE_FILE_MATCHES_HISTORIC_HASH');
  assert.equal(P.knownComparison(P.KNOWN_RULES_SHA256.T603_CANDIDATE_FILE), 'RAW_SINGLE_FILE_MATCHES_T603_CANDIDATE_HASH');
  assert.equal(P.knownComparison('0'.repeat(64)), 'NO_MATCH'); assert.equal(P.knownComparison(null), 'NOT_COMPARABLE_MULTI_FILE');
});
// ── Firebase ──
test('T618.3 Firebase: records release/ruleset identity, API dates, hash and size; GET only; never the source; never claims byte equivalence or a verified rollback', async () => {
  const calls = [], r = await collect({}, calls), f = r.firebase.production;
  assert.equal(f.status, 'VERIFIED_READ_CONSISTENT'); assert.equal(f.project, 'vdsen-ecosistema'); assert.equal(f.project_number, '1066774387899'); assert.equal(f.environment, 'production');
  assert.equal(f.ruleset_id, 'rs-synthetic-001'); assert.equal(f.release_update_time, '2026-10-20T10:00:00.123456Z'); assert.equal(f.ruleset_create_time, '2026-10-20T09:59:00Z');
  assert.equal(f.canonical_bytes > 0, true); assert.equal(f.content_bytes_total, Buffer.byteLength(SECRET_SOURCE)); assert.equal(f.source_file_count, 1); assert.deepEqual(f.source_file_names, ['firestore.rules']);
  assert.equal(f.canonical_sha256, P.canonicalRulesDigest([{ name: 'firestore.rules', content: SECRET_SOURCE }]).sha256);
  assert.equal(f.known_hash_comparison, 'NO_MATCH'); assert.equal(f.api_representation_byte_equivalence, 'NOT_ASSERTED'); assert.equal(f.rollback_provenance, 'PARTIAL_NOT_VERIFIED'); assert.equal(f.source_content_persisted, false);
  const out = JSON.stringify(r); assert.ok(!out.includes('SYNTHETIC-RULES-SOURCE-MARKER') && !out.includes('rules_version'), 'no Rules source in the result');
  assert.ok(calls.length > 0 && calls.every(([, o]) => o.method === 'GET' && o.body === undefined && Object.keys(o.headers).join() === 'Authorization' && o.redirect === 'error'));
  assert.ok(calls.every(([u]) => /^https:\/\/(firebaserules\.googleapis\.com|api\.vercel\.com)\//.test(u) && !/iam|\/documents\/|\/keys/.test(u)));
  validate({ ...state && {}, repository: 'vdsenasesoria-svg/vdsen-ecosistema' }, { type: 'object' });
});
test('T618.4 Firebase: a historic-hash single file is recognised as a hash match (still NOT a byte-equivalence or rollback claim)', async () => {
  const hit = { '/rulesets/': () => ({ name: RS, createTime: '2026-10-20T09:59:00Z', source: { files: [{ name: 'firestore.rules', content: 'abc' }] } }) };
  const f = (await collect(hit)).firebase.production;
  assert.equal(f.raw_single_file_sha256, sha('abc')); assert.equal(f.known_hash_comparison, 'NO_MATCH');
  const multi = { '/rulesets/': () => ({ name: RS, source: { files: [{ name: 'b', content: '2' }, { name: 'a', content: '1' }] } }) };
  const m = (await collect(multi)).firebase.production;
  assert.equal(m.source_file_count, 2); assert.deepEqual(m.source_file_names, ['a', 'b']); assert.equal(m.raw_single_file_sha256, null); assert.equal(m.known_hash_comparison, 'NOT_COMPARABLE_MULTI_FILE');
  assert.equal(m.canonical_sha256, P.canonicalRulesDigest([{ name: 'a', content: '1' }, { name: 'b', content: '2' }]).sha256);
});
test('T618.5 Firebase: inconsistent responses are rejected (wrong release, foreign ruleset, mismatched name, duplicate/invalid files, release changed while reading)', async () => {
  const cases = {
    'wrong release name': { '/releases/cloud.firestore': () => ({ name: 'projects/other/releases/cloud.firestore', rulesetName: RS }) },
    'ruleset of another project': { '/releases/cloud.firestore': () => ({ name: 'projects/vdsen-ecosistema/releases/cloud.firestore', rulesetName: 'projects/vdsen-planes/rulesets/x' }) },
    'ruleset name mismatch': { '/rulesets/': () => ({ name: 'projects/vdsen-ecosistema/rulesets/other', source: { files: [{ name: 'a', content: 'x' }] } }) },
    'duplicate file names': { '/rulesets/': () => ({ name: RS, source: { files: [{ name: 'a', content: 'x' }, { name: 'a', content: 'y' }] } }) },
    'no files': { '/rulesets/': () => ({ name: RS, source: { files: [] } }) },
    'missing source': { '/rulesets/': () => ({ name: RS }) }
  };
  for (const [why, over] of Object.entries(cases)) {
    const f = (await collect(over)).firebase.production;
    assert.equal(f.status, 'INCONSISTENT', why); assert.equal(f.canonical_sha256, null, why); assert.equal(f.known_hash_comparison, 'NOT_COMPARABLE_NO_SOURCE'); assert.equal(f.rollback_provenance, 'PARTIAL_NOT_VERIFIED');
  }
  let n = 0;
  const moving = (await collect({ '/releases/cloud.firestore': () => ({ name: 'projects/vdsen-ecosistema/releases/cloud.firestore', rulesetName: RS, updateTime: ++n === 1 ? '2026-10-20T10:00:00Z' : '2026-10-20T10:00:05Z' }) })).firebase.production;
  assert.equal(moving.status, 'INCONSISTENT'); assert.equal(moving.error, 'INCONSISTENT_RELEASE_CHANGED_DURING_READ'); assert.equal(moving.canonical_sha256, null);
});
test('T618.6 HTTP 401 / 403 / 404 / 5xx / network / timeout: recorded as NOT_VERIFIED with a category only; no body, no token; nothing inferred from 404', async () => {
  for (const [status, cat] of [[401, 'HTTP_401'], [403, 'HTTP_403'], [404, 'HTTP_404'], [503, 'HTTP_5XX']]) {
    const r = await collect({ '/releases/cloud.firestore': status, '/v4/aliases/': status });
    const f = r.firebase.production, v = r.vercel;
    assert.equal(f.status, 'NOT_VERIFIED'); assert.equal(f.error, cat); assert.equal(f.http_status, status); assert.equal(f.canonical_sha256, null);
    assert.equal(v.status, 'NOT_VERIFIED'); assert.equal(v.error, cat); assert.equal(v.alias_to_deployment_correspondence, 'NOT_VERIFIED'); assert.equal(v.deletion_inferred_from_http_404, false);
    const out = JSON.stringify(r); assert.ok(!out.includes('private-body-test-only') && !out.includes('google-token-test-only') && !out.includes('vercel-token-test-only') && !/Bearer/.test(out));
  }
  const net = await collect({ '/releases/cloud.firestore': new TypeError('fetch failed') }); assert.equal(net.firebase.production.error, 'NETWORK_ERROR');
  const to = await collect({ '/releases/cloud.firestore': Object.assign(new Error('t'), { name: 'TimeoutError' }) }); assert.equal(to.firebase.production.error, 'TIMEOUT');
  const noToken = await P.collect({ state, googleToken: '', vercelToken: '', fetchImpl: async () => { throw new Error('must not be called without a token'); } });
  assert.equal(noToken.firebase.production.error, 'HTTP_401'); assert.equal(noToken.vercel.error, 'HTTP_401');
});
test('T618.7 staging is best effort: a denied staging read never affects production and is recorded as such', async () => {
  const r = await collect({ '/projects/vdsen-ecosistema-staging/': 403 });
  assert.equal(r.firebase.production.status, 'VERIFIED_READ_CONSISTENT'); assert.equal(r.firebase.staging.status, 'NOT_VERIFIED'); assert.equal(r.firebase.staging.error, 'HTTP_403');
  assert.equal(r.firebase.staging.project, 'vdsen-ecosistema-staging'); assert.equal(r.firebase.staging.project_number, '436059785391');
});
// ── Vercel ──
test('T618.8 Vercel: alias -> deployment correspondence is VERIFIED only with matching project, deployment id, production target and listed alias; READY is not acceptance', async () => {
  const v = (await collect({})).vercel;
  assert.equal(v.status, 'VERIFIED_READ_CONSISTENT'); assert.equal(v.alias_to_deployment_correspondence, 'VERIFIED'); assert.equal(v.deployment_id, 'dpl_SyntheticDeploy01'); assert.equal(v.alias_deployment_id, v.deployment_id);
  assert.equal(v.deployment_state, 'READY'); assert.equal(v.deployment_created_at, '2026-10-21T12:00:00.000Z'); assert.equal(v.deployment_commit_sha, 'f'.repeat(40)); assert.equal(v.project_identity, 'VERIFIED');
  assert.equal(v.ready_means_functional_acceptance, false); assert.equal(v.team_id, 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8'); assert.equal(v.project_id, 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN'); assert.equal(v.domain, 'vdsen-ecosistema.vercel.app');
  const dep = (over) => ({ '/v13/deployments/': () => Object.assign({ id: 'dpl_SyntheticDeploy01', projectId: state.production_project, readyState: 'READY', target: 'production', createdAt: 1, meta: {}, alias: ['vdsen-ecosistema.vercel.app'] }, over) });
  assert.equal((await collect(dep({}))).vercel.deployment_commit_sha, 'ABSENT', 'no commit: ABSENT, never guessed');
  assert.equal((await collect(dep({ gitSource: { sha: 'a'.repeat(40) } }))).vercel.deployment_commit_sha, 'a'.repeat(40));
  assert.equal((await collect(dep({ meta: { githubCommitSha: 'not-a-sha' } }))).vercel.deployment_commit_sha, 'ABSENT');
  for (const [why, over, reason] of [['preview target', dep({ target: 'preview' }), 'DEPLOYMENT_TARGET_NOT_PRODUCTION'], ['other project', dep({ projectId: 'prj_other' }), 'DEPLOYMENT_PROJECT_NOT_CONFIRMED'],
    ['alias not listed', dep({ alias: ['other.vercel.app'] }), 'ALIAS_NOT_LISTED_ON_DEPLOYMENT'], ['alias of another project', { '/v4/aliases/': () => ({ deploymentId: 'dpl_SyntheticDeploy01', projectId: 'prj_other' }) }, 'ALIAS_PROJECT_NOT_CONFIRMED']]) {
    const x = (await collect(over)).vercel; assert.equal(x.alias_to_deployment_correspondence, 'NOT_VERIFIED', why); assert.equal(x.correspondence_reason, reason, why); assert.equal(x.status, 'NOT_VERIFIED');
  }
  const mismatch = (await collect({ '/v13/deployments/': () => ({ id: 'dpl_Different0001', projectId: state.production_project }) })).vercel;
  assert.equal(mismatch.status, 'INCONSISTENT'); assert.equal(mismatch.alias_to_deployment_correspondence, 'NOT_VERIFIED');
  const foreign = (await collect({ '/v9/projects/': () => ({ id: state.production_project, accountId: 'team_other' }) })).vercel; assert.equal(foreign.status, 'INCONSISTENT'); assert.equal(foreign.project_identity, 'NOT_VERIFIED');
});
// ── whole artifact, schema, privacy ──
test('T618.9 the complete result validates against the artifact schema; a forged extra field / source / header / body is rejected by the allowlist', async () => {
  const r = await collect({}), sc = schema();
  const full = { repository: 'vdsenasesoria-svg/vdsen-ecosistema', provenance: r };
  const props = sc.properties.provenance; validate(r, props);
  for (const mutate of [(x) => { x.firebase.production.source = SECRET_SOURCE; }, (x) => { x.firebase.production.headers = { Authorization: 'Bearer x' }; }, (x) => { x.vercel.body = {}; }, (x) => { x.extra = 1; },
    (x) => { x.firebase.production.canonical_sha256 = 'ABC'; }, (x) => { x.firebase.production.rollback_provenance = 'VERIFIED'; }, (x) => { x.firebase.production.api_representation_byte_equivalence = 'ASSERTED'; },
    (x) => { x.vercel.ready_means_functional_acceptance = true; }, (x) => { x.vercel.deletion_inferred_from_http_404 = true; }, (x) => { x.source_content_persisted = true; }, (x) => { x.methods = ['POST']; }]) {
    const copy = JSON.parse(JSON.stringify(r)); mutate(copy); assert.throws(() => validate(copy, props));
  }
  assert.ok(full.provenance);
  assert.ok(JSON.stringify(r).length < 6000, 'minimum data');
});
test('T618.10 oidc-validate wiring: provenance is attached, GET-only, never changes validation_status, and an old artifact (without provenance) still validates', async () => {
  const { base, probe } = require('../scripts/release/oidc-validate.cjs');
  const before = { ...process.env }, original = global.fetch, calls = [];
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema', GITHUB_REF: 'refs/heads/codex/client-app-next', GCP_PROJECT_ID: state.firebase_project, VERCEL_PROJECT_ID: state.production_project,
      VERCEL_ORG_ID: state.vercel_team, GCP_RELEASE_SERVICE_ACCOUNT: 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com', GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/p/providers/q',
      OIDC_AUTH_OUTCOME: 'success', GOOGLE_ACCESS_TOKEN: 'google-token-test-only', VERCEL_TOKEN: 'vercel-token-test-only', PRODUCTION_RELEASE_ENABLED: 'false' });
    const route = fake({});
    global.fetch = async (url, o) => {
      calls.push([url, o]);
      if (url.includes('cloudresourcemanager')) return new Response(JSON.stringify({ projectId: state.firebase_project }));
      if (url.includes('firestore.googleapis.com')) return new Response(JSON.stringify({ indexes: [] }));
      return route(url, o);
    };
    const r = await probe(state, base(state));
    validate(r, schema());
    assert.equal(r.validation_status, 'PASS'); assert.ok(r.provenance); assert.equal(r.provenance.firebase.production.status, 'VERIFIED_READ_CONSISTENT'); assert.equal(r.provenance.vercel.alias_to_deployment_correspondence, 'VERIFIED');
    assert.ok(calls.every(([, o]) => o.method === 'GET' && o.body === undefined)); assert.equal(r.mutations_performed, false);
    // an unverifiable provenance does not turn the capability checks into FAIL
    global.fetch = async (url, o) => url.includes('cloudresourcemanager') ? new Response(JSON.stringify({ projectId: state.firebase_project })) : url.includes('firestore.googleapis.com') ? new Response(JSON.stringify({ indexes: [] })) :
      url.includes('/rulesets/') && !url.includes('fields=name,createTime') ? route(url, o) : url.includes('/v4/aliases/') ? new Response('x', { status: 404 }) : route(url, o);
    const r2 = await probe(state, base(state)); validate(r2, schema());
    assert.equal(r2.validation_status, 'PASS'); assert.equal(r2.provenance.vercel.alias_to_deployment_correspondence, 'NOT_VERIFIED'); assert.equal(r2.provenance.vercel.error, 'HTTP_404');
    const legacy = base(state); legacy.validation_status = 'PASS'; validate(legacy, schema());
  } finally { global.fetch = original; for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
});
test('T618.11 static guarantees: GET only, no logging, no release/deploy imports, no new triggers, artifact retention 30 days, release routes untouched', () => {
  const src = fs.readFileSync('scripts/release/provenance-diagnostic.cjs', 'utf8');
  assert.ok(!/method: '(?:POST|PATCH|PUT|DELETE)'|console\.|process\.stdout|writeFile|appendFile|require\('\.\/live|require\('\.\/app-live|child_process|process\.env/.test(src), 'no write verbs, logging, persistence, release imports or env reads');
  assert.equal((src.match(/method: '/g) || []).length, 1); assert.match(src, /method: 'GET'/);
  const wf = fs.readFileSync('.github/workflows/vdsen-oidc-validate.yml', 'utf8');
  assert.match(wf, /retention-days: 30/); assert.match(wf, /path: release-output\/oidc-validation\.json/); assert.ok(!/pull_request|workflow_dispatch/.test(wf)); assert.match(wf, /  push:\r?\n    branches: \[codex\/client-app-next\]/);
  for (const f of ['scripts/release/live.cjs', 'scripts/release/app-live.cjs', 'scripts/release/check.cjs', 'scripts/release/app-diagnostics.cjs']) assert.ok(!fs.readFileSync(f, 'utf8').includes('provenance-diagnostic'), f + ' must not depend on the diagnostic');
  assert.ok(!/NUMERIC_APPLY_ENABLED\s*=\s*true/.test(src));
});

test('T618.12 privacy gate: provenance is persisted into the artifact ONLY when the runner proved a private repository; otherwise it is withheld (the repository is public today)', async () => {
  const { persistable } = require('../scripts/release/oidc-validate.cjs');
  const r = Object.assign({}, require('../scripts/release/oidc-validate.cjs').base(state), { provenance: await collect({}) });
  const before = process.env.ARTIFACT_PRIVACY_VERIFIED;
  try {
    delete process.env.ARTIFACT_PRIVACY_VERIFIED;
    let p = persistable(r); assert.equal(p.provenance, undefined); assert.equal(p.provenance_publication, 'WITHHELD_PRIVACY_NOT_VERIFIED'); validate(p, schema()); assert.ok(!JSON.stringify(p).includes('rs-synthetic-001'));
    process.env.ARTIFACT_PRIVACY_VERIFIED = 'false'; p = persistable(r); assert.equal(p.provenance, undefined);
    process.env.ARTIFACT_PRIVACY_VERIFIED = 'true'; p = persistable(r); assert.ok(p.provenance); assert.equal(p.provenance_publication, 'PUBLISHED_PRIVATE_REPOSITORY_VERIFIED'); validate(p, schema());
    assert.ok(r.provenance, 'the in-memory result is never mutated');
  } finally { if (before === undefined) delete process.env.ARTIFACT_PRIVACY_VERIFIED; else process.env.ARTIFACT_PRIVACY_VERIFIED = before; }
  const wf = fs.readFileSync('.github/workflows/vdsen-oidc-validate.yml', 'utf8');
  assert.equal((wf.match(/ARTIFACT_PRIVACY_VERIFIED: \$\{\{ github\.event\.repository\.private == true && 'true' \|\| 'false' \}\}/g) || []).length, 2, 'run and finalize derive it from the runner-provided repository privacy flag');
});
