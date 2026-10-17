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
var _oidcToken = null;   // per-request Vercel OIDC token (header x-vercel-oidc-token); never logged, never persisted beyond the function's /tmp

// ---- Workload Identity Federation (Vercel OIDC -> Google STS -> service-account impersonation) ---------------------------------
// Opt-in ONLY with FIREBASE_AUTH_MODE=wif plus NON-secret identifiers. No private key exists anywhere in this mode. The production project
// ids are refused outright: this mode exists for the isolated staging runtime.
var WIF_FORBIDDEN_PROJECTS = ['vdsen-ecosistema', 'vdsen-planes'];
function setRequestOidcToken(token) { _oidcToken = typeof token === 'string' && token.length > 20 ? token : null; }

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
  var built = buildFederatedConfig(process.env, tokenPath);
  if (!_oidcToken) throw new Error('FIREBASE_WIF_NO_OIDC_TOKEN');
  // The credential reader re-reads this file whenever it must refresh the Google access token, so it is rewritten on every request.
  fs.writeFileSync(tokenPath, _oidcToken, { mode: 0o600 });
  fs.writeFileSync(cfgPath, JSON.stringify(built.config), { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = cfgPath;
  if (_app) return _app;
  var admin = require('firebase-admin');
  _app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: built.projectId }, 'vdsen-wif');
  return _app;
}

function getAdminApp() {
  if (process.env.FIREBASE_AUTH_MODE === 'wif') return getFederatedApp();
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
  setRequestOidcToken:  setRequestOidcToken,
  buildFederatedConfig: buildFederatedConfig,
  getAdminApp:       getAdminApp,
  verifyIdToken:      verifyIdToken,
  isAuthorizedCoach:  isAuthorizedCoach
};
