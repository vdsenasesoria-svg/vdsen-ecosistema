'use strict';

var executor = require('./_autonomousProgression');
var sweepLib = require('./_autonomousProgressionSweep');
var planSyncLib = require('./_planActivationSync');
var randomUUID = require('node:crypto').randomUUID;
var PILOT_UID_HASH = 'fb6c056b17d798c07d06878a857c359aa70828ea44debb1bcab5eb644701fe12';
var GH_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
var GH_A4_AUDIENCE_PREFIX = 'vdsen-ayrton-runtime-a4:';
var GH_A4_REPO = 'vdsenasesoria-svg/vdsen-ecosistema';
var GH_A4_OWNER = 'vdsenasesoria-svg';
var GH_A4_REF = 'refs/heads/codex/client-app-next';
var GH_A4_WORKFLOW_REF = 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-ayrton-window.yml@refs/heads/codex/client-app-next';
var _ghJwksCache = { at: 0, keys: null };

async function fetchGithubJwks() {
  if (_ghJwksCache.keys && Date.now() - _ghJwksCache.at < 600000) return _ghJwksCache.keys;
  var res = await fetch(GH_OIDC_ISSUER + '/.well-known/jwks', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('GH_OIDC_JWKS_UNAVAILABLE');
  _ghJwksCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  return _ghJwksCache.keys;
}

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function verifyGithubA4OidcToken(token, opts) {
  opts = opts || {};
  if (typeof token !== 'string' || token.length < 40 || token.length > 8192) return { ok: false, error: 'AUTH_INVALID' };
  var parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'AUTH_INVALID' };
  var header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (_) {
    return { ok: false, error: 'AUTH_INVALID' };
  }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    return { ok: false, error: 'AUTH_INVALID' };
  }
  var keys;
  try { keys = await (opts.jwks || fetchGithubJwks)(); } catch (_) { return { ok: false, error: 'OIDC_JWKS_UNAVAILABLE' }; }
  var jwk = (keys || []).filter(function(k) { return k && k.kid === header.kid && k.kty === 'RSA'; })[0];
  if (!jwk) return { ok: false, error: 'AUTH_INVALID' };
  var crypto = require('node:crypto');
  var sigOk = false;
  try {
    sigOk = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64urlDecode(parts[2]));
  } catch (_) { sigOk = false; }
  if (!sigOk) return { ok: false, error: 'AUTH_INVALID' };

  var now = Math.floor((opts.now === undefined ? Date.now() : opts.now) / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now + 5) return { ok: false, error: 'AUTH_EXPIRED' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + 5) return { ok: false, error: 'AUTH_INVALID' };
  if (typeof payload.iat === 'number' && payload.iat > now + 60) return { ok: false, error: 'AUTH_INVALID' };
  if (payload.iss !== GH_OIDC_ISSUER) return { ok: false, error: 'OIDC_FORBIDDEN' };
  if (payload.aud !== opts.expectedAudience) return { ok: false, error: 'OIDC_FORBIDDEN' };
  if (payload.repository !== GH_A4_REPO || payload.repository_owner !== GH_A4_OWNER) return { ok: false, error: 'OIDC_FORBIDDEN' };
  if (payload.ref !== GH_A4_REF || payload.event_name !== 'workflow_dispatch' || payload.environment !== 'Production') return { ok: false, error: 'OIDC_FORBIDDEN' };
  if (payload.workflow_ref !== GH_A4_WORKFLOW_REF) return { ok: false, error: 'OIDC_FORBIDDEN' };
  if (String(payload.run_attempt) !== '1' || !/^[1-9][0-9]+$/.test(String(payload.run_id || ''))) return { ok: false, error: 'OIDC_FORBIDDEN' };
  if (payload.head_ref || payload.base_ref) return { ok: false, error: 'OIDC_FORBIDDEN' };

  return { ok: true, payload: { runId: String(payload.run_id), runAttempt: String(payload.run_attempt) } };
}
// Additional restriction only; it never enables the server switches or replaces the transactional fences.
function inspectPilotWindow(raw, uid, now, planId) {
  if (raw === undefined) return { configured: false, valid: false };
  try {
    var w = JSON.parse(raw), exp = Date.parse(w.expiresAt), clock = now === undefined ? Date.now() : now;
    var valid = w.uidHash === PILOT_UID_HASH && /^[a-f0-9]{64}$/.test(w.planHash) && /^[a-zA-Z0-9-]{8,80}$/.test(w.operationId) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(w.expiresAt) && Number.isFinite(exp) && exp > clock && exp - clock <= 168 * 3600e3;
    valid = valid && new Date(exp).toISOString() === w.expiresAt.replace('Z', '.000Z');
    var digest = function(x) { return require('node:crypto').createHash('sha256').update(x).digest('hex'); };
    return { configured: true, valid: valid === true, uidHash: w.uidHash, planHash: w.planHash, expiresAt: w.expiresAt, operationId: w.operationId,
      allowed: valid === true && typeof uid === 'string' && typeof planId === 'string' && digest(uid) === w.uidHash && digest(planId) === w.planHash };
  } catch (_) { return { configured: true, valid: false, allowed: false }; }
}

// Only fixed categories, booleans and counts reach the diagnostic sink. No token, UID, plan, record key or exception text.
function reply(res, code, body, trace, deps) {
  var id = trace.requestId || randomUUID();
  if (typeof res.setHeader === 'function') res.setHeader('x-vdsen-progression-request-id', id);
  var out = { event: 'VDSEN_PROGRESSION_TRIGGER', requestId: id, httpStatus: code, authentication: trace.authentication || 'NOT_CHECKED',
    processingEnabled: deps.enabled === true, numericApplyEnabled: deps.numericApplyEnabled === true,
    outcome: trace.outcome || (code === 401 || code === 403 ? 'AUTH_REJECTED' : code === 503 ? 'RUNTIME_NOT_CONFIGURED' : code >= 500 ? 'PROCESSING_FAILED' : 'REQUEST_REJECTED'),
    created: trace.created || 0, applied: trace.applied || 0, consumed: trace.consumed || 0,
    errorCategory: trace.errorCategory || null };
  try { (deps.log || console.info)(JSON.stringify(out)); } catch (_) { /* A diagnostic sink failure must not affect the transaction or response. */ }
  return res.status(code).json(body);
}

function makeHandler(deps) {
  deps = deps || {};
  return async function handler(req, res) {
    // GET = scheduled recovery sweep (Vercel cron, CRON_SECRET). One function on purpose: the Hobby plan caps functions at 12.
    if (req.method === 'GET' && req.query && req.query.check === 'runtime') {
      // Read-only probe. Never delegates to the executor or the scheduled sweep; no Firestore access.
      if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
      var probeToken = /^Bearer\s+(\S+)$/.exec(String(req.headers && req.headers.authorization || '').trim());
      if (!probeToken) return res.status(401).json({ error: 'AUTH_MISSING' });
      var probeIdentity;
      try { probeIdentity = await deps.verifyIdToken(probeToken[1]); } catch (_) { return res.status(401).json({ error: 'AUTH_INVALID' }); }
      if (!probeIdentity || typeof probeIdentity.uid !== 'string' || require('node:crypto').createHash('sha256').update(probeIdentity.uid).digest('hex') !== PILOT_UID_HASH) return res.status(403).json({ error: 'PROBE_FORBIDDEN' });
      var bound = inspectPilotWindow(deps.pilotWindow);
      return res.status(200).json({ schema: 'vdsen-progression-runtime-v1', processingEnabled: deps.enabled === true,
        numericApplyEnabled: deps.numericApplyEnabled === true, cronConfigured: !!deps.cronSecret,
        pilotWindow: bound.valid ? { uidHash: bound.uidHash, planHash: bound.planHash, expiresAt: bound.expiresAt, operationId: bound.operationId } : null });
    }
    if (req.method === 'GET' && req.query && req.query.check === 'runtime-a4') {
      // Read-only A4 workflow attestation probe. Verifies GitHub Actions OIDC JWT via JWKS; never touches Firestore or opens fences.
      if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
      var a4Token = /^Bearer\s+(\S+)$/.exec(String(req.headers && req.headers.authorization || '').trim());
      if (!a4Token) return res.status(401).json({ error: 'AUTH_MISSING' });
      var a4Bound = inspectPilotWindow(deps.pilotWindow, undefined, deps.now);
      if (!a4Bound.valid) return res.status(403).json({ error: 'PILOT_WINDOW_INVALID' });
      var a4Verified = await (deps.verifyA4OidcToken || verifyGithubA4OidcToken)(a4Token[1], {
        expectedAudience: GH_A4_AUDIENCE_PREFIX + a4Bound.operationId,
        jwks: deps.githubJwks,
        now: deps.now,
      });
      if (!a4Verified.ok) {
        var errStatus = a4Verified.error === 'OIDC_JWKS_UNAVAILABLE' ? 503 : (a4Verified.error === 'OIDC_FORBIDDEN' ? 403 : 401);
        return res.status(errStatus).json({ error: a4Verified.error });
      }
      return res.status(200).json({
        schema: 'vdsen-progression-runtime-v1',
        processingEnabled: deps.enabled === true,
        numericApplyEnabled: deps.numericApplyEnabled === true,
        cronConfigured: !!deps.cronSecret,
        pilotWindow: { uidHash: a4Bound.uidHash, planHash: a4Bound.planHash, expiresAt: a4Bound.expiresAt, operationId: a4Bound.operationId },
        runtimeSha: deps.runtimeSha || process.env.VERCEL_GIT_COMMIT_SHA || null,
      });
    }
    if (req.method === 'GET' && req.query && req.query.check === 'cohort-shard') {
      // T878: Read-only non-secret probe reporting SHA-256 digest of the cohort shard ACTUALLY served by this deployment.
      if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
      var csToken = /^Bearer\s+(\S+)$/.exec(String(req.headers && req.headers.authorization || '').trim());
      if (!csToken) return res.status(401).json({ error: 'AUTH_MISSING' });
      try { await deps.verifyIdToken(csToken[1]); } catch (_) { return res.status(401).json({ error: 'AUTH_INVALID' }); }
      var cid = typeof req.query.cohortId === 'string' ? req.query.cohortId.trim() : '';
      if (!/^cohort-\d{2}$/.test(cid)) return res.status(400).json({ error: 'COHORT_ID_INVALID' });
      return res.status(200).json(planSyncLib.buildServedCohortProbePayload(deps.runtimeEnv || process.env, cid));
    }
    if (req.method === 'GET' && req.query && req.query.check === 'plan-activation-status') {
      return planSyncLib.makeStatusHandler({ db: deps.db, verifyIdToken: deps.verifyIdToken })(req, res);
    }
    if (req.method === 'GET' && (deps.pilotWindow !== undefined || deps.numericPilotWindow !== undefined)) return res.status(403).json({ error: 'PILOT_CRON_DISABLED' });
    if (req.method === 'GET') return sweepLib.makeHandler({ db: deps.db, cronSecret: deps.cronSecret, enabled: deps.enabled === true,
      numericApplyEnabled: deps.numericApplyEnabled === true })(req, res);
    var trace = { requestId: randomUUID(), authentication: 'NOT_CHECKED' };
    var send = function(code, body) { return reply(res, code, body, trace, deps); };
    if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
    if ((req.query && req.query.action === 'plan-activation-sync') || (req.body && req.body.action === 'plan-activation-sync')) {
      return planSyncLib.makeHandler({
        db: deps.db,
        verifyIdToken: deps.verifyIdToken,
        commercialRoster: deps.commercialRoster,
        autoRenewalEnabled: deps.autoRenewalEnabled,
        autoRenewalMode: deps.autoRenewalMode,
        pilotScope: deps.pilotScope,
        runtimeSha: deps.runtimeSha,
        clock: deps.clock,
        dispatchRenewalWorkflow: deps.dispatchRenewalWorkflow,
        syncCohortRuntimeEnv: deps.syncCohortRuntimeEnv,
      })(req, res);
    }
    var header = req.headers && req.headers.authorization;
    var token = typeof header === 'string' && /^Bearer\s+(\S+)$/.exec(header.trim());
    if (!token) { trace.authentication = 'MISSING'; return send(401, { error: 'AUTH_MISSING' }); }
    var identity;
    try { identity = await deps.verifyIdToken(token[1]); } catch (_) { trace.authentication = 'REJECTED'; return send(401, { error: 'AUTH_INVALID' }); }
    trace.authentication = 'VERIFIED';
    // Read-only runtime probe for the isolated staging runtime (any authenticated staging user; returns a boolean-like status, never data).
    if (deps.allowProbe === true && req.query && req.query.check === 'firestore') {
      try { await deps.db.collection('releaseControl').doc('autonomousProgression').get(); return res.status(200).json({ firestore: 'READ_OK' }); }
      catch (_) { return res.status(502).json({ firestore: 'READ_FAILED' }); }
    }
    var uid = identity && identity.uid, planId = req.body && req.body.planId;
    if (!uid || typeof planId !== 'string' || !planId) return send(400, { error: 'REQUEST_INVALID' });
    if (deps.pilotWindow !== undefined && !inspectPilotWindow(deps.pilotWindow, uid, undefined, planId).allowed) {
      trace.outcome = 'OUT_OF_ALLOWLIST';
      return send(202, { status: 'OUT_OF_ALLOWLIST', created: [], applied: [], consumed: [] });
    }
    try {
      var out = await executor.processProgression({ db: deps.db, clientId: uid, planId: planId,
        enabled: deps.enabled === true, numericApplyEnabled: deps.numericApplyEnabled === true, enforceActiveEligibility: true, clock: deps.clock });
      trace.outcome = out.status;
      trace.created = (out.created || []).length;
      trace.applied = (out.applied || []).filter(function(x) { return x.written === true; }).length;
      trace.consumed = (out.consumed || []).filter(function(x) { return x.written === true; }).length;
      return send(out.status === 'DISARMED' ? 202 : 200, { status: out.status, created: out.created || [], applied: out.applied || [], consumed: out.consumed || [] });
    } catch (e) {
      // Deliberately no token, uid, plan or Firestore details in the response.
      var code = e && e.code;
      trace.errorCategory = code === 10 || code === 'aborted' ? 'CONTENTION' : code === 14 || code === 'unavailable' ? 'UNAVAILABLE' : code === 4 || code === 'deadline-exceeded' ? 'DEADLINE' : 'PROCESSING';
      return send(500, { error: 'PROGRESSION_PROCESSING_FAILED' });
    }
  };
}

async function defaultHandler(req, res) {
  var admin = require('./_firebaseAdmin'), app, firebaseAdmin;
  // Missing Firebase Admin configuration must fail CLOSED with a clean response, never crash the function (Preview has no credentials).
  try { await admin.acceptRequestOidcToken(req.headers && req.headers['x-vercel-oidc-token']); app = admin.getAdminApp(); firebaseAdmin = require('firebase-admin'); } catch (_) {
    return reply(res, 503, { error: 'RUNTIME_NOT_CONFIGURED' }, {}, { enabled: process.env.AUTONOMOUS_PROGRESSION_ENABLED === 'true', numericApplyEnabled: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED === 'true' });
  }
  return makeHandler({ db: firebaseAdmin.firestore(app), verifyIdToken: admin.verifyIdToken, cronSecret: process.env.CRON_SECRET,
    pilotWindow: process.env.VDSEN_PILOT_WINDOW,
    numericPilotWindow: process.env.VDSEN_NUMERIC_PILOT_WINDOW,
    allowProbe: admin.isFederatedMode(process.env, req.headers && req.headers['x-vercel-oidc-token']),
    enabled: process.env.AUTONOMOUS_PROGRESSION_ENABLED === 'true',
    numericApplyEnabled: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED === 'true',
    commercialRoster: function() { return planSyncLib.loadBundledCommercialRoster(); },
    autoRenewalEnabled: process.env.VDSEN_AUTO_COHORT_RENEWAL_ENABLED === 'true',
    autoRenewalMode: process.env.VDSEN_AUTO_COHORT_RENEWAL_MODE,
    pilotScope: process.env.VDSEN_AUTO_COHORT_RENEWAL_PILOT_SCOPE,
    runtimeSha: process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null,
    dispatchRenewalWorkflow: planSyncLib.createGitHubActionsRenewalDispatcher(process.env) })(req, res);
}

module.exports = defaultHandler;
module.exports.makeHandler = makeHandler;
module.exports.inspectPilotWindow = inspectPilotWindow;
module.exports.verifyGithubA4OidcToken = verifyGithubA4OidcToken;
module.exports.GH_A4_AUDIENCE_PREFIX = GH_A4_AUDIENCE_PREFIX;
module.exports.PILOT_UID_HASH = PILOT_UID_HASH;
