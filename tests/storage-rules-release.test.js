'use strict';
// Synthetic rehearsal of the Storage Rules lane against an in-memory fake of the Firebase Rules API.
// No network, no credentials, no production resource is reachable from this file.
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

// Stateful fake of firebaserules.googleapis.com. `faults` injects failures by "METHOD name-suffix".
function fakeApi({ live = OLD, faults = {}, afterPublishContent = null } = {}) {
  const st = { rulesets: new Map(), release: null, calls: [], n: 0 };
  const add = content => { const name = 'projects/' + manifest.firebase_project + '/rulesets/rs' + (++st.n); st.rulesets.set(name, content); return name; };
  if (live !== null) st.release = add(live);
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  st.fetch = async (url, init = {}) => {
    const name = url.replace('https://firebaserules.googleapis.com/v1/', ''), method = init.method || 'GET';
    st.calls.push(method + ' ' + name);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    for (const [k, v] of Object.entries(faults)) { const [m, suf] = k.split(' '); if (m === method && name.endsWith(suf)) { if (v === 'throw') throw new Error('net'); if (v === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } return reply(v, { error: { message: 'SECRET-BODY' } }); } }
    if (method === 'GET' && name === manifest.release_name) return st.release ? reply(200, { name, rulesetName: st.release }) : reply(404, {});
    if (method === 'GET' && st.rulesets.has(name)) return reply(200, { name, source: { files: [{ name: 'storage.rules', content: st.rulesets.get(name) }] } });
    if (method === 'POST' && name.endsWith('/rulesets')) return reply(200, { name: add(init.body && JSON.parse(init.body).source.files[0].content) });
    if (method === 'PATCH' && name === manifest.release_name) {
      st.release = JSON.parse(init.body).release.rulesetName;
      if (afterPublishContent && st.patches === undefined) { st.patches = 1; st.rulesets.set(st.release, afterPublishContent); }
      return reply(200, {});
    }
    return reply(404, {});
  };
  return st;
}
const opts = st => ({ manifest, token: 'test-token', fetchImpl: st.fetch });
async function capture(st) {
  const live = await S.readLive(opts(st));
  return S.buildRollbackArtifact({ manifest, live, provenance: { run_id: 'synthetic' } });
}

test('manifest registers the production bucket without inventing it', () => {
  assert.equal(S.discoverBucket('.', manifest.firebase_project), manifest.bucket);
  assert.equal(manifest.release_name, 'projects/vdsen-ecosistema/releases/firebase.storage/' + manifest.bucket);
});
test('firebase.json is untouched by Storage registration (served/hashed surface)', () => {
  assert.equal(JSON.parse(fs.readFileSync('firebase.json', 'utf8')).storage, undefined);
});
test('readback: success returns ruleset identity, hash and diff', async () => {
  const st = fakeApi();
  const live = await S.readLive(opts(st));
  assert.equal(live.ok, true);
  const r = S.readbackReport({ manifest, local: LOCAL, live });
  assert.equal(r.rules_diff, 'DIFFERENT'); assert.equal(r.mutations_performed, false);
  assert.deepEqual(st.calls.filter(c => !c.startsWith('GET')), []);
  const same = S.readbackReport({ manifest, local: OLD, live });
  assert.equal(same.rules_diff, 'IDENTICAL');
});
test('readback failures are categorised and never leak response bodies or tokens', async () => {
  for (const [fault, cat] of [['GET ' + manifest.bucket, 'HTTP_403'], ['GET rs1', 'HTTP_500']]) {
    const st = fakeApi({ faults: { [fault]: Number(cat.slice(-3)) || 500 } });
    const live = await S.readLive(opts(st));
    assert.equal(live.ok, false);
    assert.ok(!JSON.stringify(live).includes('SECRET-BODY') && !JSON.stringify(live).includes('test-token'));
  }
  assert.equal((await S.readLive({ ...opts(fakeApi()), token: '' })).error, 'NO_TOKEN');
  assert.equal((await S.readLive(opts(fakeApi({ faults: { ['GET ' + manifest.bucket]: 'throw' } })))).error, 'NETWORK_ERROR');
  assert.equal((await S.readLive(opts(fakeApi({ faults: { ['GET ' + manifest.bucket]: 'timeout' } })))).error, 'TIMEOUT');
  assert.equal((await S.readLive(opts(fakeApi({ live: null })))).error, 'HTTP_404');
  const rep = S.readbackReport({ manifest, local: LOCAL, live: await S.readLive(opts(fakeApi({ live: null }))) });
  assert.equal(rep.rules_diff, 'UNKNOWN');
});
test('readback rejects an incomplete ruleset response (fail-closed)', async () => {
  const st = fakeApi();
  const orig = st.fetch;
  st.fetch = async (u, i) => { const r = await orig(u, i); return u.includes('/rulesets/') && (i?.method || 'GET') === 'GET' ? { ok: true, status: 200, text: async () => JSON.stringify({ name: u.split('/v1/')[1], source: { files: [] } }) } : r; };
  assert.equal((await S.readLive(opts(st))).error, 'ASSERTION_MISMATCH');
});
test('rollback artifact: identity, hash, provenance and integrity verification', async () => {
  const a = await capture(fakeApi());
  assert.equal(S.verifyRollbackArtifact(manifest, a.meta, a.content), true);
  assert.equal(a.meta.rules_sha256, S.sha256(OLD));
  for (const bad of [
    [{ ...a.meta, firebase_project: 'vdsen-planes' }, a.content], [{ ...a.meta, bucket: 'other.firebasestorage.app' }, a.content],
    [{ ...a.meta, rules_sha256: '0'.repeat(64) }, a.content], [{ ...a.meta, provenance: undefined }, a.content],
    [a.meta, a.content + '\n// tampered'], [{ ...a.meta, ruleset_name: 'projects/x/rulesets/y' }, a.content], [null, a.content]])
    assert.throws(() => S.verifyRollbackArtifact(manifest, bad[0], bad[1]));
  await assert.rejects(async () => S.buildRollbackArtifact({ manifest, live: await S.readLive(opts(fakeApi({ live: null }))), provenance: {} }), /without a readable live ruleset/);
});
test('artifact round-trips through disk and detects on-disk tampering', async () => {
  const a = await capture(fakeApi()), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-sr-'));
  fs.writeFileSync(path.join(dir, a.rulesFile), a.content); fs.writeFileSync(path.join(dir, a.metaFile), JSON.stringify(a.meta));
  assert.equal(S.loadRollbackArtifact(manifest, dir, a.meta.rules_sha256).meta.rules_sha256, a.meta.rules_sha256);
  fs.appendFileSync(path.join(dir, a.rulesFile), '// x');
  assert.throws(() => S.loadRollbackArtifact(manifest, dir, a.meta.rules_sha256), /hash/);
  assert.throws(() => S.loadRollbackArtifact(manifest, dir, '../x'));
});
test('plan is BLOCKED without readable live rules, without artifact, or with a stale artifact', async () => {
  const st = fakeApi(), live = await S.readLive(opts(st)), a = await capture(st);
  assert.equal(S.plan({ manifest, local: LOCAL, live, artifact: a }).status, 'READY');
  assert.match(S.plan({ manifest, local: LOCAL, live, artifact: null }).blockers.join(), /ROLLBACK_ARTIFACT_MISSING/);
  const dead = await S.readLive(opts(fakeApi({ faults: { ['GET ' + manifest.bucket]: 403 } })));
  assert.match(S.plan({ manifest, local: LOCAL, live: dead, artifact: a }).blockers.join(), /LIVE_RULES_UNREADABLE:HTTP_403/);
  const drifted = await S.readLive(opts(fakeApi({ live: OLD + '// drift\n' })));
  assert.match(S.plan({ manifest, local: LOCAL, live: drifted, artifact: a }).blockers.join(), /NOT_CURRENT_LIVE/);
  assert.match(S.plan({ manifest, local: 'not rules', live, artifact: a }).blockers.join(), /LOCAL_RULES_INVALID/);
  assert.equal(S.plan({ manifest, local: OLD, live, artifact: a }).status, 'NOOP_ALREADY_LIVE');
});
test('apply refuses without the kill switch or with a wrong approved sha, and never calls the API', async () => {
  const st = fakeApi(), a = await capture(st), before = st.calls.length;
  await assert.rejects(S.apply({ ...opts(st), local: LOCAL, artifact: a, env: {} }), /disarmed/);
  await assert.rejects(S.apply({ ...opts(st), local: LOCAL, artifact: a, env: { ...ENV_OK, STORAGE_RULES_APPROVED_SHA: 'f'.repeat(64) } }), /approved sha/);
  await assert.rejects(S.apply({ ...opts(st), local: LOCAL, artifact: a, env: { STORAGE_RULES_RELEASE_ENABLED: 'false', STORAGE_RULES_APPROVED_SHA: S.sha256(LOCAL) } }), /disarmed/);
  assert.equal(st.calls.length, before);
});
test('apply (synthetic): publishes, verifies, and the artifact restores the previous rules', async () => {
  const st = fakeApi(), a = await capture(st), env = { ...ENV_OK, STORAGE_RULES_APPROVED_SHA: S.sha256(LOCAL) };
  const r = await S.apply({ ...opts(st), local: LOCAL, artifact: a, env });
  assert.equal(r.status, 'APPLIED_VERIFIED');
  assert.equal(st.rulesets.get(st.release), LOCAL);
  const back = await S.rollback({ ...opts(st), artifact: a, env: { ...ENV_OK, STORAGE_RULES_APPROVED_SHA: a.meta.rules_sha256 } });
  assert.equal(back.status, 'ROLLED_BACK_VERIFIED');
  assert.equal(st.rulesets.get(st.release), OLD);
});
test('apply: failed post-publish verification auto-restores the captured rules', async () => {
  const st = fakeApi({ afterPublishContent: OLD + '// not what was published\n' }), a = await capture(st);
  const r = await S.apply({ ...opts(st), local: LOCAL, artifact: a, env: { ...ENV_OK, STORAGE_RULES_APPROVED_SHA: S.sha256(LOCAL) } });
  assert.equal(r.status, 'VERIFY_FAILED_ROLLED_BACK');
  assert.equal(st.rulesets.get(st.release), OLD);
});
test('apply: publish error leaves live rules untouched and rollback with a tampered artifact is refused', async () => {
  const st = fakeApi({ faults: { ['PATCH ' + manifest.bucket]: 403 } }), a = await capture(st);
  await assert.rejects(S.apply({ ...opts(st), local: LOCAL, artifact: a, env: { ...ENV_OK, STORAGE_RULES_APPROVED_SHA: S.sha256(LOCAL) } }), /HTTP_403/);
  assert.equal(st.rulesets.get(st.release), OLD);
  const bad = { meta: a.meta, content: a.content + '//' };
  await assert.rejects(S.rollback({ ...opts(st), artifact: bad, env: { ...ENV_OK, STORAGE_RULES_APPROVED_SHA: a.meta.rules_sha256 } }), /hash/);
});
test('workflows contain no Storage mutation entry point; CLI exposes read-only commands only', () => {
  const src = fs.readFileSync('scripts/release/storage-rules.cjs', 'utf8');
  assert.match(src, /usage: storage-rules\.cjs readback\|capture\|plan/);
  for (const f of fs.readdirSync('.github/workflows')) {
    const w = fs.readFileSync(path.join('.github/workflows', f), 'utf8');
    assert.ok(!/storage-rules\.cjs\s+(apply|rollback)|STORAGE_RULES_RELEASE_ENABLED/.test(w), f);
  }
});
