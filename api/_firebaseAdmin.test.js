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
