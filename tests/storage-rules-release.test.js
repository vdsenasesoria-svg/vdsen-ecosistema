'use strict';
// Synthetic rehearsal of the Storage Rules lane against an in-memory fake of the Firebase Rules API.
// No network, no credentials, no production resource is reachable from this file. The fake models the
// DOCUMENTED REST contract only; it does not and cannot prove real Firebase semantics.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const S = require('../scripts/release/storage-rules.cjs');

const manifest = S.loadManifest('.');
const LOCAL = fs.readFileSync('storage.rules', 'utf8');
const OLD = "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /{all=**} { allow read, write: if false; } } }\n";
const ENV_OK = { STORAGE_RULES_RELEASE_ENABLED: 'true' };
const PROV = { repository: 'vdsenasesoria-svg/vdsen-ecosistema', ref: 'refs/heads/codex/client-app-next', run_id: '123456789', run_attempt: '1', commit: 'c'.repeat(40), workflow: 'VDSEN Storage Rules live readback (read-only)' };
const FAST = { allowNonAtomic: true, settleAttempts: 2, settleDelayMs: 1 };

// Stateful fake. faults: "METHOD suffix" -> status | 'throw' | 'timeout' | 'apply-then-throw' | 'apply-then-5xx'.
function fakeApi({ live = OLD, faults = {}, afterPublishContent = null, onPatch = null } = {}) {
  const st = { rulesets: new Map(), release: null, updateTime: '2026-10-01T00:00:00Z', calls: [], n: 0, patches: 0 };
  const add = content => { const name = 'projects/' + manifest.firebase_project + '/rulesets/rs' + (++st.n); st.rulesets.set(name, content); return name; };
  if (live !== null) st.release = add(live);
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const doPatch = init => {
    st.release = JSON.parse(init.body).release.rulesetName; st.updateTime = 'T' + (++st.patches);
    if (afterPublishContent && st.patches === 1) st.rulesets.set(st.release, afterPublishContent);
    if (onPatch) onPatch(st, add);
  };
  st.fetch = async (url, init = {}) => {
    const name = url.replace('https://firebaserules.googleapis.com/v1/', ''), method = init.method || 'GET';
    st.calls.push(method + ' ' + name);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    for (const [k, v] of Object.entries(faults)) {
      const [m, suf] = k.split(' ');
      if (m !== method || !name.endsWith(suf)) continue;
      if (v === 'throw') throw new Error('net');
      if (v === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }
      if (v === 'apply-then-throw') { doPatch(init); throw new Error('net'); }
      if (v === 'apply-then-5xx') { doPatch(init); return reply(503, { error: { message: 'SECRET-BODY' } }); }
      return reply(v, { error: { message: 'SECRET-BODY' } });
    }
    if (method === 'GET' && name === manifest.release_name) return st.release ? reply(200, { name, rulesetName: st.release, updateTime: st.updateTime }) : reply(404, {});
    if (method === 'GET' && st.rulesets.has(name)) return reply(200, { name, source: { files: [{ name: 'storage.rules', content: st.rulesets.get(name) }] } });
    if (method === 'POST' && name.endsWith('/rulesets')) return reply(200, { name: add(JSON.parse(init.body).source.files[0].content) });
    if (method === 'PATCH' && name === manifest.release_name) { doPatch(init); return reply(200, {}); }
    return reply(404, {});
  };
  return st;
}
const opts = st => ({ manifest, token: 'test-token', fetchImpl: st.fetch });
async function capture(st) {
  const live = await S.readLive(opts(st));
  return S.buildRollbackArtifact({ manifest, live, provenance: PROV });
}
const env = sha => ({ ...ENV_OK, STORAGE_RULES_APPROVED_SHA: sha });

test('manifest registers the production bucket without inventing it; firebase.json untouched', () => {
  assert.equal(S.discoverBucket('.', manifest.firebase_project), manifest.bucket);
  assert.equal(manifest.release_name, 'projects/vdsen-ecosistema/releases/firebase.storage/' + manifest.bucket);
  assert.equal(JSON.parse(fs.readFileSync('firebase.json', 'utf8')).storage, undefined);
});

// ---- readback --------------------------------------------------------------------------------------
test('readback: success returns ruleset identity, hash, updateTime and diff, using GET only', async () => {
  const st = fakeApi();
  const live = await S.readLive({ ...opts(st), fetchImpl: S.readOnlyFetch(st.fetch) });
  assert.equal(live.ok, true); assert.equal(live.update_time, st.updateTime);
  assert.equal(S.readbackReport({ manifest, local: LOCAL, live }).rules_diff, 'DIFFERENT');
  assert.equal(S.readbackReport({ manifest, local: OLD, live }).rules_diff, 'IDENTICAL');
  assert.ok(st.calls.every(c => c.startsWith('GET ')));
});
test('read-only transport rejects any non-GET', async () => {
  const st = fakeApi();
  const ro = S.readOnlyFetch(st.fetch);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) await assert.rejects(ro('https://x', { method }), { category: 'READ_ONLY_VIOLATION' });
  assert.equal(st.calls.length, 0);
});
test('readback failures are categorised and never leak response bodies or tokens', async () => {
  for (const status of [403, 500]) {
    const live = await S.readLive(opts(fakeApi({ faults: { ['GET ' + manifest.bucket]: status } })));
    assert.equal(live.ok, false);
    assert.ok(!JSON.stringify(live).includes('SECRET-BODY') && !JSON.stringify(live).includes('test-token'));
  }
  assert.equal((await S.readLive({ ...opts(fakeApi()), token: '' })).error, 'NO_TOKEN');
  assert.equal((await S.readLive(opts(fakeApi({ faults: { ['GET ' + manifest.bucket]: 'throw' } })))).error, 'NETWORK_ERROR');
  assert.equal((await S.readLive(opts(fakeApi({ faults: { ['GET ' + manifest.bucket]: 'timeout' } })))).error, 'TIMEOUT');
  const gone = await S.readLive(opts(fakeApi({ live: null })));
  assert.equal(gone.error, 'HTTP_404');
  assert.equal(S.readbackReport({ manifest, local: LOCAL, live: gone }).rules_diff, 'UNKNOWN');
});
test('readback rejects an incomplete ruleset response (fail-closed)', async () => {
  const st = fakeApi(), orig = st.fetch;
  st.fetch = async (u, i) => { const r = await orig(u, i); return u.includes('/rulesets/') && (i?.method || 'GET') === 'GET' ? { ok: true, status: 200, text: async () => JSON.stringify({ name: u.split('/v1/')[1], source: { files: [] } }) } : r; };
  assert.equal((await S.readLive(opts(st))).error, 'ASSERTION_MISMATCH');
});

// ---- identity --------------------------------------------------------------------------------------
test('read-only identity: no silent fallback to the release/mutating service account', () => {
  const ok = 'vdsen-storage-readonly@vdsen-ecosistema.iam.gserviceaccount.com';
  assert.equal(S.assertReadonlyIdentity({ GCP_STORAGE_READONLY_SERVICE_ACCOUNT: ok, GCP_RELEASE_SERVICE_ACCOUNT: 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com' }), ok);
  assert.throws(() => S.assertReadonlyIdentity({}), /refusing to fall back/);
  assert.throws(() => S.assertReadonlyIdentity({ GCP_STORAGE_READONLY_SERVICE_ACCOUNT: '' }), /refusing to fall back/);
  assert.throws(() => S.assertReadonlyIdentity({ GCP_STORAGE_READONLY_SERVICE_ACCOUNT: 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com' }), /release service account/);
  assert.throws(() => S.assertReadonlyIdentity({ GCP_STORAGE_READONLY_SERVICE_ACCOUNT: 'someone@gmail.com' }), /unexpected/);
  assert.throws(() => S.assertReadonlyIdentity({ GCP_STORAGE_READONLY_SERVICE_ACCOUNT: ok, GCP_RELEASE_SERVICE_ACCOUNT: ok }), /release service account/);
});
test('readback workflow: dispatch-only, read-only identity and scope, no release variables, no mutating verbs', () => {
  const w = fs.readFileSync('.github/workflows/vdsen-storage-readback.yml', 'utf8').split('\r\n').join('\n');
  const code = w.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /workflow_dispatch:/);
  assert.ok(!/\bpush:|pull_request/.test(code));
  assert.match(code, /service_account: \$\{\{ vars\.GCP_STORAGE_READONLY_SERVICE_ACCOUNT \}\}/);
  assert.ok(!/service_account: \$\{\{ vars\.GCP_RELEASE_SERVICE_ACCOUNT/.test(code), 'must not authenticate as the release bot');
  assert.match(code, /access_token_scopes: https:\/\/www\.googleapis\.com\/auth\/firebase\.readonly\s*\n/);
  assert.ok(!/cloud-platform|auth\/firebase\s*$/m.test(code), 'no broad or write-capable scope');
  assert.ok(!/secrets\.|VERCEL|RELEASE_ENABLED|storage-rules\.cjs\s+(apply|rollback)/.test(code));
  assert.ok(!/contents: write|id-token: write\b[\s\S]*attestations/.test(code));
  assert.match(code, /storage-rules\.cjs capture/);
});

// ---- artifact: integrity, provenance, substitution, custody ---------------------------------------
test('rollback artifact: identity, hash, provenance and integrity verification', async () => {
  const a = await capture(fakeApi());
  assert.equal(S.verifyRollbackArtifact(manifest, a.meta, a.content), true);
  assert.equal(a.meta.rules_sha256, S.sha256(OLD)); assert.equal(a.meta.release_update_time, '2026-10-01T00:00:00Z');
  const bad = [
    [{ ...a.meta, firebase_project: 'vdsen-planes' }, a.content], [{ ...a.meta, bucket: 'other.firebasestorage.app' }, a.content],
    [{ ...a.meta, rules_sha256: '0'.repeat(64) }, a.content], [a.meta, a.content + '\n// tampered'],
    [{ ...a.meta, ruleset_name: 'projects/x/rulesets/y' }, a.content], [null, a.content],
    [{ ...a.meta, provenance: undefined }, a.content],
    [{ ...a.meta, provenance: { ...a.meta.provenance, repository: 'evil/fork' } }, a.content],
    [{ ...a.meta, provenance: { ...a.meta.provenance, ref: 'refs/heads/main' } }, a.content],
    [{ ...a.meta, provenance: { ...a.meta.provenance, run_id: 'local' } }, a.content],
    [{ ...a.meta, provenance: { ...a.meta.provenance, commit: 'HEAD' } }, a.content],
    [{ ...a.meta, provenance: { ...a.meta.provenance, source: 'hand-written' } }, a.content],
    [{ ...a.meta, captured_at: 'yesterday' }, a.content]];
  for (const [m, c] of bad) assert.throws(() => S.verifyRollbackArtifact(manifest, m, c));
  await assert.rejects(async () => S.buildRollbackArtifact({ manifest, live: await S.readLive(opts(fakeApi({ live: null }))), provenance: PROV }), /without a readable live ruleset/);
  await assert.rejects(async () => S.buildRollbackArtifact({ manifest, live: await S.readLive(opts(fakeApi())), provenance: { ...PROV, repository: 'local' } }), /provenance repository/);
});
test('artifact round-trips through disk; tamper, substitution and rename are detected', async () => {
  const a = await capture(fakeApi()), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-sr-'));
  fs.writeFileSync(path.join(dir, a.rulesFile), a.content); fs.writeFileSync(path.join(dir, a.metaFile), JSON.stringify(a.meta));
  assert.equal(S.loadRollbackArtifact(manifest, dir, a.meta.rules_sha256).meta.rules_sha256, a.meta.rules_sha256);
  const digest = S.custodyDigest(a.meta, a.content);
  assert.match(digest, /^[0-9a-f]{64}$/);
  // substitution: other-but-valid rules under the original file names
  const evil = LOCAL;
  fs.writeFileSync(path.join(dir, a.rulesFile), evil);
  assert.throws(() => S.loadRollbackArtifact(manifest, dir, a.meta.rules_sha256), /hash/);
  // substitution with a self-consistent forged pair is caught by the OUT-OF-BAND digest, not by the files
  const forgedMeta = { ...a.meta, rules_sha256: S.sha256(evil), rules_bytes: Buffer.byteLength(evil) };
  assert.notEqual(S.custodyDigest(forgedMeta, evil), digest);
  fs.writeFileSync(path.join(dir, a.rulesFile), a.content + '// x');
  assert.throws(() => S.loadRollbackArtifact(manifest, dir, a.meta.rules_sha256));
  assert.throws(() => S.loadRollbackArtifact(manifest, dir, '../x'));
});
test('capture CLI produces a custody record that declares temporary retention and unproven immutability', () => {
  const src = fs.readFileSync('scripts/release/storage-rules.cjs', 'utf8');
  assert.match(src, /retention: 'TEMPORARY_WORKFLOW_ARTIFACT'/);
  assert.match(src, /immutability: 'NOT_DEMONSTRATED'/);
});

// ---- plan ------------------------------------------------------------------------------------------
test('plan is BLOCKED without readable live rules, without artifact, or with a stale artifact; never plain READY', async () => {
  const st = fakeApi(), live = await S.readLive(opts(st)), a = await capture(st);
  const good = S.plan({ manifest, local: LOCAL, live, artifact: a });
  assert.equal(good.status, 'READY_BLOCKED_NON_ATOMIC');
  assert.deepEqual(good.blockers, ['NO_ATOMIC_PRECONDITION_IN_RULES_API']);
  assert.match(S.plan({ manifest, local: LOCAL, live, artifact: null }).blockers.join(), /ROLLBACK_ARTIFACT_MISSING/);
  const dead = await S.readLive(opts(fakeApi({ faults: { ['GET ' + manifest.bucket]: 403 } })));
  assert.match(S.plan({ manifest, local: LOCAL, live: dead, artifact: a }).blockers.join(), /LIVE_RULES_UNREADABLE:HTTP_403/);
  const drifted = await S.readLive(opts(fakeApi({ live: OLD + '// drift\n' })));
  assert.match(S.plan({ manifest, local: LOCAL, live: drifted, artifact: a }).blockers.join(), /NOT_CURRENT_LIVE/);
  assert.match(S.plan({ manifest, local: 'not rules', live, artifact: a }).blockers.join(), /LOCAL_RULES_INVALID/);
  assert.equal(S.plan({ manifest, local: OLD, live, artifact: a }).status, 'NOOP_ALREADY_LIVE');
});

// ---- mutation gates ---------------------------------------------------------------------------------
test('mutation is BLOCKED by default: no atomic precondition exists, so apply/rollback never touch the API', async () => {
  assert.equal(S.ATOMIC_PRECONDITION_AVAILABLE, false);
  const st = fakeApi(), a = await capture(st), before = st.calls.length;
  await assert.rejects(S.apply({ ...opts(st), local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) }), /MUTATION_BLOCKED_NO_ATOMIC_PRECONDITION/);
  await assert.rejects(S.rollback({ ...opts(st), artifact: a, expectedLiveSha: S.sha256(LOCAL), env: env(a.meta.rules_sha256) }), /MUTATION_BLOCKED_NO_ATOMIC_PRECONDITION/);
  assert.equal(st.calls.length, before);
});
test('even when acknowledged, apply refuses without the kill switch or with a wrong approved sha', async () => {
  const st = fakeApi(), a = await capture(st), before = st.calls.length;
  await assert.rejects(S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: {} }), /disarmed/);
  await assert.rejects(S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env('f'.repeat(64)) }), /approved sha/);
  await assert.rejects(S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: { STORAGE_RULES_RELEASE_ENABLED: 'false', STORAGE_RULES_APPROVED_SHA: S.sha256(LOCAL) } }), /disarmed/);
  assert.equal(st.calls.length, before);
});

// ---- synthetic rehearsal (acknowledged non-atomic) -------------------------------------------------
test('rehearsal: publish, verify, then the artifact restores the previous rules', async () => {
  const st = fakeApi(), a = await capture(st);
  const r = await S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) });
  assert.equal(r.status, 'APPLIED_VERIFIED'); assert.equal(st.rulesets.get(st.release), LOCAL);
  const back = await S.rollback({ ...opts(st), ...FAST, artifact: a, expectedLiveSha: S.sha256(LOCAL), env: env(a.meta.rules_sha256) });
  assert.equal(back.status, 'ROLLED_BACK_VERIFIED'); assert.equal(st.rulesets.get(st.release), OLD);
});
test('rehearsal: post-publish bytes that match neither target nor previous demand manual intervention (no stomping)', async () => {
  const st = fakeApi({ afterPublishContent: OLD + '// publish landed different bytes\n' }), a = await capture(st);
  // the landed bytes equal neither target nor previous => treated as foreign: do not stomp, require a human
  const r = await S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) });
  assert.equal(r.status, 'UNKNOWN_STATE_MANUAL_INTERVENTION'); assert.equal(r.reason, 'FOREIGN_LIVE');
});
test('concurrent change between plan and publish aborts before any write', async () => {
  const st = fakeApi(), a = await capture(st), orig = st.fetch;
  let gets = 0;
  // simulate another actor publishing right after the plan read (second GET of the release)
  st.fetch = async (u, i) => { if ((i?.method || 'GET') === 'GET' && u.endsWith(manifest.bucket) && ++gets === 2) { st.release = (() => { const n = 'projects/' + manifest.firebase_project + '/rulesets/other'; st.rulesets.set(n, OLD + '// someone else\n'); return n; })(); } return orig(u, i); };
  await assert.rejects(S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) }), /LIVE_DRIFT/);
  assert.ok(!st.calls.some(c => c.startsWith('POST ') || c.startsWith('PATCH ')));
});
test('rollback refuses to overwrite rules this release did not publish', async () => {
  const st = fakeApi(), a = await capture(st);
  await assert.rejects(S.rollback({ ...opts(st), ...FAST, artifact: a, expectedLiveSha: S.sha256(LOCAL), env: env(a.meta.rules_sha256) }), /LIVE_DRIFT/);
  await assert.rejects(S.rollback({ ...opts(st), ...FAST, artifact: a, env: env(a.meta.rules_sha256) }), /expectedLiveSha required/);
});
test('definite publish error (403) leaves live untouched; tampered artifact refuses rollback', async () => {
  const st = fakeApi({ faults: { ['PATCH ' + manifest.bucket]: 403 } }), a = await capture(st);
  await assert.rejects(S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) }), /HTTP_403/);
  assert.equal(st.rulesets.get(st.release), OLD);
  await assert.rejects(S.rollback({ ...opts(st), ...FAST, artifact: { meta: a.meta, content: a.content + '//' }, expectedLiveSha: S.sha256(OLD), env: env(a.meta.rules_sha256) }), /hash/);
});
test('timeout/5xx AFTER the mutation landed: deferred read-only verification, no blind rewrite', async () => {
  for (const fault of ['apply-then-throw', 'apply-then-5xx']) {
    const st = fakeApi({ faults: { ['PATCH ' + manifest.bucket]: fault } }), a = await capture(st);
    const r = await S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) });
    assert.equal(r.status, 'APPLIED_VERIFIED_DEFERRED', fault);
    assert.equal(st.patches, 1, 'exactly one PATCH; never retried blindly');
  }
});
test('timeout/5xx BEFORE the mutation landed: verified as not applied', async () => {
  const st = fakeApi({ faults: { ['PATCH ' + manifest.bucket]: 'timeout' } }), a = await capture(st);
  const r = await S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) });
  assert.equal(r.status, 'NOT_APPLIED_VERIFIED'); assert.equal(st.rulesets.get(st.release), OLD);
});
test('uncertain outcome with unreadable or foreign live state demands manual intervention', async () => {
  const st = fakeApi({ faults: { ['PATCH ' + manifest.bucket]: 'timeout' } }), a = await capture(st);
  const orig = st.fetch; let patched = false;
  st.fetch = async (u, i) => { if (i?.method === 'PATCH') patched = true; if (patched && (i?.method || 'GET') === 'GET') return { ok: false, status: 503, text: async () => '{}' }; return orig(u, i); };
  const r = await S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) });
  assert.equal(r.status, 'UNKNOWN_STATE_MANUAL_INTERVENTION'); assert.equal(r.reason, 'UNREADABLE');
});
test('rollback whose restoration cannot be verified is reported as ROLLBACK_UNVERIFIED, never as success', async () => {
  const st = fakeApi(), a = await capture(st);
  await S.apply({ ...opts(st), ...FAST, local: LOCAL, artifact: a, env: env(S.sha256(LOCAL)) });
  const orig = st.fetch; let patched = false;
  st.fetch = async (u, i) => { if (i?.method === 'PATCH') { patched = true; return { ok: false, status: 503, text: async () => '{}' }; } if (patched && (i?.method || 'GET') === 'GET') return { ok: false, status: 503, text: async () => '{}' }; return orig(u, i); };
  const r = await S.rollback({ ...opts(st), ...FAST, artifact: a, expectedLiveSha: S.sha256(LOCAL), env: env(a.meta.rules_sha256) });
  assert.equal(r.status, 'ROLLBACK_UNVERIFIED');
});

// ---- exposure ---------------------------------------------------------------------------------------
test('no workflow exposes Storage mutation; the CLI lists read-only commands only', () => {
  const src = fs.readFileSync('scripts/release/storage-rules.cjs', 'utf8');
  assert.match(src, /usage: storage-rules\.cjs readback\|capture\|plan\|verify-artifact/);
  for (const f of fs.readdirSync('.github/workflows')) {
    const w = fs.readFileSync(path.join('.github/workflows', f), 'utf8');
    assert.ok(!/storage-rules\.cjs\s+(apply|rollback)|STORAGE_RULES_RELEASE_ENABLED|STORAGE_RULES_APPROVED_SHA/.test(w), f);
  }
});
