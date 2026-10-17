'use strict';

var executor = require('./_autonomousProgression');
var sweepLib = require('./_autonomousProgressionSweep');

function makeHandler(deps) {
  deps = deps || {};
  return async function handler(req, res) {
    // GET = scheduled recovery sweep (Vercel cron, CRON_SECRET). One function on purpose: the Hobby plan caps functions at 12.
    if (req.method === 'GET') return sweepLib.makeHandler({ db: deps.db, cronSecret: deps.cronSecret, enabled: deps.enabled === true,
      numericApplyEnabled: deps.numericApplyEnabled === true })(req, res);
    if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    var header = req.headers && req.headers.authorization;
    var token = typeof header === 'string' && /^Bearer\s+(\S+)$/.exec(header.trim());
    if (!token) return res.status(401).json({ error: 'AUTH_MISSING' });
    var identity;
    try { identity = await deps.verifyIdToken(token[1]); } catch (_) { return res.status(401).json({ error: 'AUTH_INVALID' }); }
    var uid = identity && identity.uid, planId = req.body && req.body.planId;
    if (!uid || typeof planId !== 'string' || !planId) return res.status(400).json({ error: 'REQUEST_INVALID' });
    try {
      var out = await executor.processProgression({ db: deps.db, clientId: uid, planId: planId,
        enabled: deps.enabled === true, numericApplyEnabled: deps.numericApplyEnabled === true });
      return res.status(out.status === 'DISARMED' ? 202 : 200).json({ status: out.status, created: out.created || [], applied: out.applied || [] });
    } catch (e) {
      // Deliberately no token, uid, plan or Firestore details in the response.
      return res.status(500).json({ error: 'PROGRESSION_PROCESSING_FAILED' });
    }
  };
}

async function defaultHandler(req, res) {
  var admin = require('./_firebaseAdmin');
  var app = admin.getAdminApp(), firebaseAdmin = require('firebase-admin');
  return makeHandler({ db: firebaseAdmin.firestore(app), verifyIdToken: admin.verifyIdToken, cronSecret: process.env.CRON_SECRET,
    enabled: process.env.AUTONOMOUS_PROGRESSION_ENABLED === 'true',
    numericApplyEnabled: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED === 'true' })(req, res);
}

module.exports = defaultHandler;
module.exports.makeHandler = makeHandler;
