'use strict';

// Durable recovery for the autonomous progression executor.  The athlete's
// browser notification is best-effort (tab closed, response lost, offline); this
// scheduled sweep reconciles persisted evidence with no browser involved.
// Scope is bounded to the Coach-configured canary (`coaches/*.autoApplyCanary`),
// never "all clients".  Processing is idempotent, so overlap with the browser
// trigger or a retried sweep cannot double-apply.
var crypto = require('crypto');
var executor = require('./_autonomousProgression');

function _data(snap) { return snap && snap.exists === true ? snap.data() : null; }

async function canaryTargets(db) {
  var coaches = await db.collection('coaches').where('autoApplyCanary.enabled', '==', true).get();
  var targets = [];
  for (var i = 0; i < coaches.docs.length; i++) {
    var scope = coaches.docs[i].data().autoApplyCanary || {};
    var ids = Array.isArray(scope.clientIds) ? scope.clientIds.filter(function(x) { return typeof x === 'string' && x; }) : [];
    for (var j = 0; j < ids.length; j++) targets.push(ids[j]);
  }
  // Second fence: only athletes the RELEASE system lists are even attempted (each is re-checked inside its transactions).
  var rel = _data(await db.collection('releaseControl').doc('autonomousProgression').get());
  var allowed = rel && rel.enabled === true && Array.isArray(rel.clientIds) ? rel.clientIds : [];
  return Array.from(new Set(targets)).filter(function(id) { return allowed.indexOf(id) >= 0; });
}

async function runSweep(input) {
  input = input || {};
  if (!input.enabled) return { status: 'DISARMED', processed: 0 };
  var targets = await canaryTargets(input.db), results = [];
  for (var i = 0; i < targets.length; i++) {
    try {
      var client = _data(await input.db.collection('clients').doc(targets[i]).get());
      if (!client || !client.activePlanId) { results.push({ clientId: targets[i], status: 'NO_ACTIVE_PLAN' }); continue; }
      var out = await executor.processProgression({ db: input.db, clientId: targets[i], planId: client.activePlanId, enabled: true,
        numericApplyEnabled: input.numericApplyEnabled === true, clock: input.clock });
      results.push({ clientId: targets[i], status: out.status });
    } catch (_) {
      // One athlete failing never blocks the rest; the next sweep retries.
      results.push({ clientId: targets[i], status: 'ERROR' });
    }
  }
  return { status: 'SWEPT', processed: results.length, results: results };
}

function _secretOk(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  var m = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!m) return false;
  var a = Buffer.from(m[1]), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeHandler(deps) {
  deps = deps || {};
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    if (!_secretOk(req.headers && req.headers.authorization, deps.cronSecret)) return res.status(401).json({ error: 'AUTH_INVALID' });
    try {
      var out = await runSweep({ db: deps.db, enabled: deps.enabled === true, numericApplyEnabled: deps.numericApplyEnabled === true });
      return res.status(out.status === 'DISARMED' ? 202 : 200).json({ status: out.status, processed: out.processed });
    } catch (_) {
      return res.status(500).json({ error: 'SWEEP_FAILED' });
    }
  };
}

async function defaultHandler(req, res) {
  var admin = require('./_firebaseAdmin');
  var app = admin.getAdminApp(), firebaseAdmin = require('firebase-admin');
  return makeHandler({ db: firebaseAdmin.firestore(app), cronSecret: process.env.CRON_SECRET,
    enabled: process.env.AUTONOMOUS_PROGRESSION_ENABLED === 'true',
    numericApplyEnabled: process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED === 'true' })(req, res);
}

module.exports = defaultHandler;
module.exports.makeHandler = makeHandler;
module.exports.runSweep = runSweep;
