'use strict';

/**
 * Lazy Firebase Admin initialization — real implementation behind
 * api/_vdsenAuth.js's injectable deps. Required only at call time (never at
 * module load), so nothing outside a real request touches firebase-admin.
 *
 * Credential comes ONLY from environment variables (Vercel Project Settings
 * -> Environment Variables). Never committed, never logged, never sent to
 * the browser -- this file only runs server-side inside a Vercel function.
 */

var _app = null;
// Vercel OIDC token state. The token identifies the DEPLOYMENT (not the end user), so one token per instance is correct; what must hold is that
// (a) only a token Vercel actually signed is ever accepted (the header is client-reachable and an unverified value written to the shared file would
// poison every later credential refresh), (b) an absent / invalid / expired / older token never clears or downgrades a good one, (c) the file the
// credential reader consumes is replaced atomically. Never logged.
var _oidcToken = null, _oidcExp = 0, _writtenToken = null;

// ---- Workload Identity Federation (Vercel OIDC -> Google STS -> service-account impersonation) ---------------------------------
// Opt-in ONLY with FIREBASE_AUTH_MODE=wif plus NON-secret identifiers. No private key exists anywhere in this mode. The production project
// ids are refused outright: this mode exists for the isolated staging runtime.
var WIF_FORBIDDEN_PROJECTS = ['vdsen-ecosistema', 'vdsen-planes'];
// The ONE Vercel project that may run in federated mode is the isolated staging project; it is recognised by its (public) project id, either
// from the platform-provided VERCEL_PROJECT_ID or from the project_id claim of the OIDC token it receives. The claim is only a mode selector:
// the actual authorisation is Google's (STS verifies the token signature and the provider condition pins the exact project subject).
var STAGING_VERCEL_PROJECT_ID = 'prj_ZefsZK0hyGe7WxNqenR7MO9f2H8O';
var STAGING_WIF_DEFAULTS = { FIREBASE_PROJECT_ID: 'vdsen-ecosistema-staging', GCP_PROJECT_NUMBER: '436059785391', GCP_WIF_POOL_ID: 'vercel-staging',
  GCP_WIF_PROVIDER_ID: 'vercel-t573', GCP_RUNTIME_SERVICE_ACCOUNT: 'vdsen-t573-runtime@vdsen-ecosistema-staging.iam.gserviceaccount.com' };
function _oidcProjectId(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8')).project_id || null; } catch (_) { return null; }
}
function isFederatedMode(env, token) {
  return env.FIREBASE_AUTH_MODE === 'wif' || env.VERCEL_PROJECT_ID === STAGING_VERCEL_PROJECT_ID || (!!token && _oidcProjectId(token) === STAGING_VERCEL_PROJECT_ID);
}
// ---- OIDC token verification (RS256 against Vercel's published JWKS; claims pinned to the isolated staging project) -------------------------
var OIDC_TEAM = 'vdsenasesoria-svgs-projects';
var OIDC_ISSUER = 'https://oidc.vercel.com/' + OIDC_TEAM, OIDC_AUDIENCE = 'https://vercel.com/' + OIDC_TEAM;
var _jwksCache = { at: 0, keys: null };
async function _fetchJwks() {
  if (_jwksCache.keys && Date.now() - _jwksCache.at < 600000) return _jwksCache.keys;
  var res = await fetch(OIDC_ISSUER + '/.well-known/jwks');
  if (!res.ok) throw new Error('FIREBASE_WIF_JWKS_UNAVAILABLE');
  _jwksCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  return _jwksCache.keys;
}
function _b64(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
// -> verified payload or null. Never throws, never logs the token.
async function verifyOidcToken(token, opts) {
  try {
    opts = opts || {};
    if (typeof token !== 'string' || token.length < 40 || token.length > 8192) return null;
    var parts = token.split('.'); if (parts.length !== 3) return null;
    var header = JSON.parse(_b64(parts[0]).toString('utf8')), payload = JSON.parse(_b64(parts[1]).toString('utf8'));
    if (header.alg !== 'RS256' || !header.kid) return null;
    var keys = await (opts.jwks || _fetchJwks)(), jwk = (keys || []).filter(function(k) { return k.kid === header.kid && k.kty === 'RSA'; })[0];
    if (!jwk) return null;
    var crypto = require('crypto');
    var ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), _b64(parts[2]));
    if (!ok) return null;
    var now = Math.floor((opts.now || Date.now()) / 1000);
    if (payload.iss !== OIDC_ISSUER || payload.aud !== OIDC_AUDIENCE || payload.project_id !== STAGING_VERCEL_PROJECT_ID) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now + 30 || (typeof payload.nbf === 'number' && payload.nbf > now + 5)) return null;
    return payload;
  } catch (_) { return null; }
}
// Accepts a request's token only if verified; keeps whichever verified token expires last. Returns whether a usable token is now held.
async function acceptRequestOidcToken(token, opts) {
  var p = await verifyOidcToken(token, opts);
  if (p && p.exp > _oidcExp) { _oidcToken = token; _oidcExp = p.exp; }
  return !!_oidcToken && _oidcExp > Math.floor(((opts && opts.now) || Date.now()) / 1000) + 30;
}
// Atomic replacement of the file the external-account reader consumes (write temp, rename); only when the token changed.
function _writeSubjectToken(tokenPath) {
  var fs = require('fs');
  if (!_oidcToken || _writtenToken === _oidcToken) return;
  var tmp = tokenPath + '.' + process.pid + '.' + require('crypto').randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, _oidcToken, { mode: 0o600 });
  fs.renameSync(tmp, tokenPath);
  _writtenToken = _oidcToken;
}
function _resetOidcStateForTest() { _oidcToken = null; _oidcExp = 0; _writtenToken = null; _jwksCache = { at: 0, keys: null }; _app = null; }

// Pure: validates the environment and returns the external-account configuration (public identifiers only).
function buildFederatedConfig(env, tokenPath) {
  var projectId = env.FIREBASE_PROJECT_ID, number = env.GCP_PROJECT_NUMBER, pool = env.GCP_WIF_POOL_ID, provider = env.GCP_WIF_PROVIDER_ID, sa = env.GCP_RUNTIME_SERVICE_ACCOUNT;
  if (!projectId || !number || !pool || !provider || !sa) throw new Error('FIREBASE_WIF_NOT_CONFIGURED');
  if (WIF_FORBIDDEN_PROJECTS.indexOf(projectId) >= 0 || !/-staging$/.test(projectId)) throw new Error('FIREBASE_WIF_FORBIDDEN_PROJECT');
  if (!/^\d{6,20}$/.test(number) || !/^[a-z0-9-]{4,32}$/.test(pool) || !/^[a-z0-9-]{4,32}$/.test(provider)) throw new Error('FIREBASE_WIF_BAD_IDENTIFIER');
  if (sa.indexOf('@' + projectId + '.iam.gserviceaccount.com') < 0) throw new Error('FIREBASE_WIF_SERVICE_ACCOUNT_OUTSIDE_PROJECT');
  return { projectId: projectId, config: {
    type: 'external_account',
    audience: '//iam.googleapis.com/projects/' + number + '/locations/global/workloadIdentityPools/' + pool + '/providers/' + provider,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + sa + ':generateAccessToken',
    credential_source: { file: tokenPath, format: { type: 'text' } }
  } };
}

function getFederatedApp() {
  var os = require('os'), path = require('path'), fs = require('fs');
  var tokenPath = path.join(os.tmpdir(), 'vdsen-wif-subject-token'), cfgPath = path.join(os.tmpdir(), 'vdsen-wif-config.json');
  var built = buildFederatedConfig(Object.assign({}, STAGING_WIF_DEFAULTS, process.env), tokenPath);
  if (!_oidcToken) throw new Error('FIREBASE_WIF_NO_OIDC_TOKEN');
  if (_oidcExp <= Math.floor(Date.now() / 1000) + 30) throw new Error('FIREBASE_WIF_OIDC_EXPIRED');
  // The credential reader re-reads this file whenever it must refresh the Google access token; it only ever sees a complete, verified token.
  _writeSubjectToken(tokenPath);
  if (!fs.existsSync(cfgPath)) { fs.writeFileSync(cfgPath + '.tmp', JSON.stringify(built.config), { mode: 0o600 }); fs.renameSync(cfgPath + '.tmp', cfgPath); }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = cfgPath;
  if (_app) return _app;
  var admin = require('firebase-admin');
  _app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: built.projectId }, 'vdsen-wif');
  return _app;
}

function getAdminApp() {
  if (isFederatedMode(process.env, _oidcToken)) return getFederatedApp();
  var projectId   = process.env.FIREBASE_PROJECT_ID;
  var clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  var privateKey  = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
  }

  // Validate the request environment before accepting a cached SDK app.  The
  // Firebase Admin module is process-global, so a neighbouring serverless
  // handler (or test) may already have initialized it; that must not turn a
  // misconfigured request into an authenticated one.
  if (_app) return _app;

  var admin = require('firebase-admin');
  if (admin.apps && admin.apps.length) {
    _app = admin.apps[0];
    return _app;
  }

  _app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   projectId,
      clientEmail: clientEmail,
      // Vercel env vars store literal "\n" as two characters; restore real newlines.
      privateKey:  privateKey.replace(/\\n/g, '\n')
    })
  });
  return _app;
}

// -> Promise<{ uid: string }>. Throws on any invalid/expired/malformed token
// (signature, issuer, audience, expiry) -- the caller (_vdsenAuth.js) maps
// any throw to a generic 401, never distinguishing the reason to the client.
async function verifyIdToken(token) {
  var app = getAdminApp();
  var admin = require('firebase-admin');
  var decoded = await admin.auth(app).verifyIdToken(token);
  return { uid: decoded.uid };
}

// -> Promise<boolean>. PAID / GENERATIVE API entitlement (T539). Two DISTINCT concepts:
//   * coaches/{uid} existing  = a COACH APP ACCOUNT (self-registration is open by product design; rules give it no access to other tenants)
//   * coaches/{uid}.apiAccessEnabled === true = ENTITLEMENT to the paid endpoints; managed ONLY by the Admin SDK
//     (firestore.rules forbid any client to create / change / drop it; see docs/COACH_API_ENTITLEMENT.md).
// Missing document, missing field, false, or any non-boolean-true value => false. Errors propagate (the caller fails closed).
async function isAuthorizedCoach(uid) {
  var app = getAdminApp();
  var admin = require('firebase-admin');
  var snap = await admin.firestore(app).collection('coaches').doc(uid).get();
  return snap.exists === true && !!snap.data() && snap.data().apiAccessEnabled === true;
}

module.exports = {
  acceptRequestOidcToken: acceptRequestOidcToken,
  verifyOidcToken:      verifyOidcToken,
  _internal:            { writeSubjectToken: _writeSubjectToken, resetForTest: _resetOidcStateForTest },
  isFederatedMode:      isFederatedMode,
  buildFederatedConfig: buildFederatedConfig,
  getAdminApp:       getAdminApp,
  verifyIdToken:      verifyIdToken,
  isAuthorizedCoach:  isAuthorizedCoach
};
