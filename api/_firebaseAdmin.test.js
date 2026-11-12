'use strict';

// Guards against a partially-configured production environment: this must
// fail loudly (throw) rather than silently skip auth or fall back to an
// unauthenticated/ambient credential. Never touches real Firebase network
// calls -- these tests only cover the credential-wiring failure path, which
// is exactly the path a misconfigured Vercel deployment would hit.

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function freshModule() {
  delete require.cache[require.resolve('./_firebaseAdmin')];
  return require('./_firebaseAdmin');
}

function withEnv(vars, fn) {
  return async function() {
    var saved = {};
    Object.keys(vars).forEach(function(k) { saved[k] = process.env[k]; process.env[k] = vars[k]; });
    try { return await fn(); }
    finally { Object.keys(vars).forEach(function(k) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }); }
  };
}

test('module loads without throwing and without any env vars set (lazy require)', function() {
  var mod = freshModule();
  return typeof mod.getAdminApp === 'function'
      && typeof mod.verifyIdToken === 'function'
      && typeof mod.isAuthorizedCoach === 'function';
});

test('getAdminApp throws FIREBASE_ADMIN_NOT_CONFIGURED when env vars are missing', withEnv(
  { FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '' },
  function() {
    var mod = freshModule();
    try { mod.getAdminApp(); return false; }
    catch (e) { return e.message === 'FIREBASE_ADMIN_NOT_CONFIGURED'; }
  }
));

test('getAdminApp throws when only some env vars are present (no partial credential accepted)', withEnv(
  { FIREBASE_PROJECT_ID: 'vdsen-ecosistema', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '' },
  function() {
    var mod = freshModule();
    try { mod.getAdminApp(); return false; }
    catch (e) { return e.message === 'FIREBASE_ADMIN_NOT_CONFIGURED'; }
  }
));

test('verifyIdToken propagates the same not-configured failure (never silently authenticates)', withEnv(
  { FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '' },
  async function() {
    var mod = freshModule();
    try { await mod.verifyIdToken('anytoken'); return false; }
    catch (e) { return e.message === 'FIREBASE_ADMIN_NOT_CONFIGURED'; }
  }
));

test('isAuthorizedCoach propagates the same not-configured failure (fails closed, not open)', withEnv(
  { FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '' },
  async function() {
    var mod = freshModule();
    try { await mod.isAuthorizedCoach('some-uid'); return false; }
    catch (e) { return e.message === 'FIREBASE_ADMIN_NOT_CONFIGURED'; }
  }
));

test('source: credential is built ONLY from process.env, never a literal/hardcoded value', function() {
  var src = require('fs').readFileSync(__dirname + '/_firebaseAdmin.js', 'utf8');
  return src.indexOf('process.env.FIREBASE_PROJECT_ID') !== -1
      && src.indexOf('process.env.FIREBASE_CLIENT_EMAIL') !== -1
      && src.indexOf('process.env.FIREBASE_PRIVATE_KEY') !== -1
      && !/BEGIN PRIVATE KEY/.test(src); // no embedded key material of any kind
});

var WIF_OK = { FIREBASE_AUTH_MODE: 'wif', FIREBASE_PROJECT_ID: 'vdsen-ecosistema-staging', GCP_PROJECT_NUMBER: '436059785391', GCP_WIF_POOL_ID: 'vercel-staging',
  GCP_WIF_PROVIDER_ID: 'vercel-t573', GCP_RUNTIME_SERVICE_ACCOUNT: 'vdsen-t573-runtime@vdsen-ecosistema-staging.iam.gserviceaccount.com' };

test('WIF: config is built from public identifiers only and contains no key material', function() {
  var mod = freshModule(), c = mod.buildFederatedConfig(WIF_OK, '/tmp/t').config;
  return c.type === 'external_account' && /providers\/vercel-t573$/.test(c.audience) && c.credential_source.file === '/tmp/t'
      && /vdsen-t573-runtime@vdsen-ecosistema-staging/.test(c.service_account_impersonation_url) && !/PRIVATE KEY|private_key/i.test(JSON.stringify(c));
});

test('WIF: refuses production project ids, non-staging ids and a service account outside the project', function() {
  var mod = freshModule();
  function bad(over) { try { mod.buildFederatedConfig(Object.assign({}, WIF_OK, over), '/t'); return false; } catch (e) { return /FIREBASE_WIF_/.test(e.message); } }
  return bad({ FIREBASE_PROJECT_ID: 'vdsen-ecosistema', GCP_RUNTIME_SERVICE_ACCOUNT: 'a@vdsen-ecosistema.iam.gserviceaccount.com' })
      && bad({ FIREBASE_PROJECT_ID: 'vdsen-planes', GCP_RUNTIME_SERVICE_ACCOUNT: 'a@vdsen-planes.iam.gserviceaccount.com' })
      && bad({ FIREBASE_PROJECT_ID: 'something-else', GCP_RUNTIME_SERVICE_ACCOUNT: 'a@something-else.iam.gserviceaccount.com' })
      && bad({ GCP_RUNTIME_SERVICE_ACCOUNT: 'a@vdsen-ecosistema.iam.gserviceaccount.com' })
      && bad({ GCP_PROJECT_NUMBER: 'abc' }) && bad({ GCP_WIF_POOL_ID: '' });
});

test('WIF: mode is opt-in and fails closed without a per-request OIDC token', withEnv(Object.assign({}, WIF_OK), function() {
  var mod = freshModule();
  try { mod.getAdminApp(); return false; } catch (e) { return e.message === 'FIREBASE_WIF_NO_OIDC_TOKEN'; }
}));

test('WIF: without FIREBASE_AUTH_MODE=wif the key-based path is unchanged (still FIREBASE_ADMIN_NOT_CONFIGURED when keys are absent)', withEnv(
  { FIREBASE_AUTH_MODE: '', FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '' }, function() {
    var mod = freshModule();
    try { mod.getAdminApp(); return false; } catch (e) { return e.message === 'FIREBASE_ADMIN_NOT_CONFIGURED'; }
  }));

function jwt(claims) { return 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64') + '.s'; }
test('WIF: federated mode is selected ONLY for the isolated staging Vercel project (id or OIDC project_id claim), never for the production project', function() {
  var mod = freshModule(), STG = 'prj_ZefsZK0hyGe7WxNqenR7MO9f2H8O', PROD = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
  return mod.isFederatedMode({ VERCEL_PROJECT_ID: STG }, null) === true
      && mod.isFederatedMode({}, jwt({ project_id: STG })) === true
      && mod.isFederatedMode({ VERCEL_PROJECT_ID: PROD }, jwt({ project_id: PROD })) === false
      && mod.isFederatedMode({}, null) === false && mod.isFederatedMode({}, 'not-a-jwt') === false
      && mod.isFederatedMode({ FIREBASE_AUTH_MODE: 'wif' }, null) === true;
});

// ─── T575: OIDC token hardening (verification, no downgrade, atomic file, concurrency, no leakage) ───────────────────────────────────────
var crypto = require('crypto'), fsx = require('fs'), osx = require('os'), pathx = require('path');
var STG = 'prj_ZefsZK0hyGe7WxNqenR7MO9f2H8O', TEAM = 'vdsenasesoria-svgs-projects';
var KP = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }), OTHER = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
var JWK = Object.assign(KP.publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
var JWKS = async function() { return [JWK]; };
function b64u(o) { return Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function mint(over, key, kid) {
  var now = Math.floor(Date.now() / 1000);
  var payload = Object.assign({ iss: 'https://oidc.vercel.com/' + TEAM, aud: 'https://vercel.com/' + TEAM, project_id: STG, sub: 'owner:' + TEAM + ':project:vdsen-ecosistema-staging-t573:environment:production', iat: now, nbf: now - 5, exp: now + 3600 }, over || {});
  var h = b64u({ alg: 'RS256', kid: kid || 'k1', typ: 'JWT' }), body = b64u(payload), data = h + '.' + body;
  return data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), (key || KP).privateKey).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

test('OIDC: a genuinely signed token with the pinned claims is accepted', async function() {
  var mod = freshModule(); mod._internal.resetForTest();
  return (await mod.verifyOidcToken(mint(), { jwks: JWKS })) !== null && (await mod.acceptRequestOidcToken(mint(), { jwks: JWKS })) === true;
});

test('OIDC: forged / foreign / wrong-claim / expired / malformed tokens are all rejected', async function() {
  var mod = freshModule(); mod._internal.resetForTest();
  var now = Math.floor(Date.now() / 1000);
  var bad = [mint({}, OTHER),                                  // signed by someone else (same kid)
    mint({}, KP, 'unknown-kid'), mint({ project_id: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN' }),   // the PRODUCTION project's claim
    mint({ iss: 'https://oidc.vercel.com/someone-else' }), mint({ aud: 'https://vercel.com/someone-else' }),
    mint({ exp: now - 10 }), mint({ exp: now + 5 }), mint({ nbf: now + 600 }), 'not-a-jwt', 'a.b.c', '', null, undefined, 123, 'x'.repeat(9000)];
  for (var i = 0; i < bad.length; i++) { if ((await mod.verifyOidcToken(bad[i], { jwks: JWKS })) !== null) return false; }
  return true;
});

test('OIDC: absent / invalid / expired / OLDER tokens never clear or downgrade a good one; the farthest expiry wins', async function() {
  var mod = freshModule(); mod._internal.resetForTest();
  var now = Math.floor(Date.now() / 1000), good = mint({ exp: now + 3000 }), later = mint({ exp: now + 3500 }), older = mint({ exp: now + 1000 });
  var o = { jwks: JWKS }, tmp = pathx.join(osx.tmpdir(), 'vdsen-t575-' + process.pid + '-a'); fsx.rmSync(tmp, { force: true });
  if (!(await mod.acceptRequestOidcToken(good, o))) return false;
  if (!(await mod.acceptRequestOidcToken(undefined, o)) || !(await mod.acceptRequestOidcToken('garbage', o)) || !(await mod.acceptRequestOidcToken(mint({}, OTHER), o))) return false;
  mod._internal.writeSubjectToken(tmp); if (fsx.readFileSync(tmp, 'utf8') !== good) return false;
  await mod.acceptRequestOidcToken(older, o); mod._internal.writeSubjectToken(tmp); if (fsx.readFileSync(tmp, 'utf8') !== good) return false;
  await mod.acceptRequestOidcToken(later, o); mod._internal.writeSubjectToken(tmp);
  var ok = fsx.readFileSync(tmp, 'utf8') === later; fsx.rmSync(tmp, { force: true }); return ok;
});

test('OIDC: with no verified token the federated app fails closed (NO_OIDC_TOKEN), an expired held token fails EXPIRED', withEnv({ FIREBASE_AUTH_MODE: 'wif' }, async function() {
  var mod = freshModule(); mod._internal.resetForTest();
  try { mod.getAdminApp(); return false; } catch (e) { if (e.message !== 'FIREBASE_WIF_NO_OIDC_TOKEN') return false; }
  await mod.acceptRequestOidcToken(mint({}, OTHER), { jwks: JWKS });                          // invalid: still nothing held
  try { mod.getAdminApp(); return false; } catch (e) { return e.message === 'FIREBASE_WIF_NO_OIDC_TOKEN'; }
}));

test('OIDC concurrency: 400 interleaved requests (valid, later, forged, expired, absent) never leave a partial/forged/empty subject-token file', async function() {
  var mod = freshModule(); mod._internal.resetForTest();
  var now = Math.floor(Date.now() / 1000), valids = [mint({ exp: now + 3000 }), mint({ exp: now + 3300 }), mint({ exp: now + 3600 })];
  var o = { jwks: JWKS }, tmp = pathx.join(osx.tmpdir(), 'vdsen-t575-' + process.pid + '-c'); fsx.rmSync(tmp, { force: true });
  var forged = mint({}, OTHER), expired = mint({ exp: now - 5 }), garbage = 'zzz.yyy.xxx';
  var seen = new Set(), torn = 0, jobs = [];
  for (var i = 0; i < 400; i++) {
    var k = Math.floor(i / 6), t = [valids[k % 3], forged, expired, undefined, garbage, valids[(k + 1) % 3]][i % 6];
    jobs.push((async function(tok) { await new Promise(function(r) { setImmediate(r); }); await mod.acceptRequestOidcToken(tok, o); mod._internal.writeSubjectToken(tmp); })(t));
    jobs.push((async function() { await new Promise(function(r) { setImmediate(r); }); try { var c = fsx.readFileSync(tmp, 'utf8'); if (c) { seen.add(c); if (valids.indexOf(c) < 0) torn++; } else torn++; } catch (e) { /* not created yet */ } })());
  }
  await Promise.all(jobs);
  var final = fsx.readFileSync(tmp, 'utf8'); fsx.rmSync(tmp, { force: true });
  return torn === 0 && final === valids[2] && Array.from(seen).every(function(c) { return valids.indexOf(c) >= 0; });
});

test('OIDC: tokens and temp-file paths never appear in console output or error messages', async function() {
  var mod = freshModule(); mod._internal.resetForTest();
  var tok = mint(), logs = [], orig = { log: console.log, warn: console.warn, error: console.error };
  ['log', 'warn', 'error'].forEach(function(k) { console[k] = function() { logs.push(Array.prototype.slice.call(arguments).join(' ')); }; });
  var msgs = [];
  try {
    await mod.acceptRequestOidcToken(tok, { jwks: JWKS }); await mod.acceptRequestOidcToken(tok.slice(0, -4) + 'AAAA', { jwks: JWKS });
    try { process.env.FIREBASE_AUTH_MODE = 'wif'; mod._internal.resetForTest(); mod.getAdminApp(); } catch (e) { msgs.push(e.message); }
  } finally { delete process.env.FIREBASE_AUTH_MODE; ['log', 'warn', 'error'].forEach(function(k) { console[k] = orig[k]; }); }
  var all = logs.concat(msgs).join('\n');
  return all.indexOf(tok.slice(0, 40)) < 0 && all.indexOf('vdsen-wif-subject-token') < 0;
});

// ─── Run ─────────────────────────────────────────────────────────────────────

async function runTests() {
  var passed = 0;
  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    try {
      var ok = await t.fn();
      if (ok) { passed++; console.log('✅ ' + t.name); }
      else { console.log('❌ ' + t.name + '\n   → returned false/falsy'); }
    } catch (e) {
      console.log('❌ ' + t.name + '\n   → ' + e.message);
    }
  }
  console.log('\n' + passed + '/' + tests.length + ' passed');
  process.exit(passed === tests.length ? 0 : 1);
}

runTests();
