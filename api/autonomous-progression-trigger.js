'use strict';

var executor = require('./_autonomousProgression');
var sweepLib = require('./_autonomousProgressionSweep');
var randomUUID = require('node:crypto').randomUUID;

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
    if (req.method === 'GET') return sweepLib.makeHandler({ db: deps.db, cronSecret: deps.cronSecret, enabled: deps.enabled === true,
      numericApplyEnabled: deps.numericApplyEnabled === true })(req, res);
    var trace = { requestId: randomUUID(), authentication: 'NOT_CHECKED' };
    var send = function(code, body) { return reply(res, code, body, trace, deps); };
    if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
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
    try {
      var out = await executor.processProgression({ db: deps.db, clientId: uid, planId: planId,
        enabled: deps.enabled === true, numericApplyEnabled: deps.numericApplyEnabled === true });
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
    allowProbe: admin.isFederatedMode(process.env, req.headers && req.headers['x-vercel-oidc-token']),
    enabled: process.env.AUTONOMOUS_PROGRESSION_ENABLED === 'true',
    numericApplyEnabled: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED === 'true' })(req, res);
}

module.exports = defaultHandler;
module.exports.makeHandler = makeHandler;
