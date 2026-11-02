'use strict';

// Durable recovery for the autonomous progression executor.  The athlete's
// browser notification is best-effort (tab closed, response lost, offline); this
// scheduled sweep reconciles persisted evidence with no browser involved.
// Scope is bounded to the Coach-configured canary (`coaches/*.autoApplyCanary`),
// never "all clients".  Processing is idempotent, so overlap with the browser
// trigger or a retried sweep cannot double-apply.
var crypto = require('crypto');
var shadow = require('../assets/progression-auto-apply-shadow.js');
var executor = require('./_autonomousProgression');
var eligibility = require('./_clientEligibility.js');

function _data(snap) { return snap && snap.exists === true ? snap.data() : null; }
function _now(clock) { return (clock || function() { return new Date().toISOString(); })(); }

async function canaryTargets(db, clock) {
  // T685: check the bounded release fence FIRST (1 doc read). When closed or expired, skip querying coaches altogether.
  var rel = _data(await db.collection('releaseControl').doc('autonomousProgression').get());
  if (!rel || rel.schema !== eligibility.RELEASE_SCHEMA || rel.enabled !== true || !Array.isArray(rel.clientIds)) return [];
  if (!executor.releaseUnexpired(rel.expiresAt, _now(clock))) return [];
  var allowed = rel.clientIds.filter(function(x) { return typeof x === 'string' && x.trim() !== '' && x !== '*'; });
  if (!allowed.length || allowed.length > eligibility.RELEASE_MAX_CLIENTS || allowed.length !== rel.clientIds.length) return [];
  var coaches = await db.collection('coaches').where('autoApplyCanary.enabled', '==', true).get();
  var targets = [];
  for (var i = 0; i < coaches.docs.length; i++) {
    var scope = coaches.docs[i].data().autoApplyCanary || {};
    var ids = Array.isArray(scope.clientIds) ? scope.clientIds.filter(function(x) { return typeof x === 'string' && x; }) : [];
    for (var j = 0; j < ids.length; j++) targets.push(ids[j]);
  }
  return Array.from(new Set(targets)).filter(function(id) { return allowed.indexOf(id) >= 0; });
}

async function runSweep(input) {
  input = input || {};
  if (!input.enabled) return { status: 'DISARMED', processed: 0 };
  var targets = await canaryTargets(input.db, input.clock), results = [];
  if (!targets.length) return { status: 'SWEPT', processed: 0, results: [] };

  var evaluations = [];
  for (var i = 0; i < targets.length; i++) {
    var cid = targets[i];
    try {
      var clientSnap = await input.db.collection('clients').doc(cid).get();
      var client = _data(clientSnap);
      if (!client || !client.activePlanId) {
        evaluations.push({ clientId: cid, eligible: false, status: 'NO_ACTIVE_PLAN', reason: 'NO_ACTIVE_PLAN' });
        continue;
      }
      if (!eligibility.isClientStatusValid(client)) {
        evaluations.push({ clientId: cid, eligible: false, status: 'INACTIVE_CLIENT', reason: 'CLIENT_SUSPENDED_OR_INACTIVE' });
        continue;
      }
      var planSnap = await input.db.collection('plans').doc(client.activePlanId).get();
      var plan = _data(planSnap);
      if (!plan || !eligibility.isPlanStatusValid(plan, client)) {
        evaluations.push({ clientId: cid, eligible: false, status: 'SOURCE_INVALID', reason: 'PLAN_SUSPENDED_OR_REVOKED' });
        continue;
      }
      var rootSnap = await input.db.collection('logs').doc(cid).get();
      var mesoSnap = await input.db.collection('logs').doc(cid).collection('mesos').doc(client.activePlanId).get();
      var root = _data(rootSnap), meso = _data(mesoSnap);
      var authority = shadow.selectLogAuthority(meso, root, client.activePlanId);
      var rawEntries = (authority && authority.entries) || (root && root.entries) || {};
      var receipts = (meso && meso.consumptionReceipts) || null;
      var cleanEntries = eligibility.sanitizeClientEntries(rawEntries, plan, client.activePlanId);

      // Bounded read of active plan start markers (immutable request.time authority)
      var starts = {};
      try {
        var startsCol = input.db.collection('logs').doc(cid).collection('starts');
        var sq = startsCol.where('planId', '==', client.activePlanId);
        if (typeof sq.limit === 'function') sq = sq.limit(50);
        var startsSnap = await sq.get();
        if (startsSnap && Array.isArray(startsSnap.docs)) {
          startsSnap.docs.forEach(function(d) {
            starts[d.id] = typeof d.data === 'function' ? d.data() : d.data;
          });
        }
      } catch (_) {}

      var ev = eligibility.evaluateClientEligibility({
        clientId: cid,
        client: client,
        clientCreateTime: clientSnap && clientSnap.createTime,
        plan: plan,
        requestedPlanId: client.activePlanId,
        meso: meso,
        root: root,
        entries: cleanEntries,
        starts: starts,
        receipts: receipts,
        now: _now(input.clock)
      });
      evaluations.push(Object.assign({ clientId: cid, client: client, plan: plan, starts: starts }, ev));
    } catch (_) {
      evaluations.push({ clientId: cid, eligible: false, status: 'ERROR', reason: 'ERROR' });
    }
  }

  // Filter excluded vs eligible
  var eligible = evaluations.filter(function(e) { return e.eligible === true; });
  var excluded = evaluations.filter(function(e) { return e.eligible !== true; });

  var resultsMap = {};
  // Record excluded clients (zero progression transactions / zero writes)
  excluded.forEach(function(e) {
    var outStatus = (e.reason === 'PLAN_SUSPENDED_OR_REVOKED' || e.reason === 'NEEDS_PLAN_PREP')
      ? 'SOURCE_INVALID'
      : (e.reason === 'CLIENT_SUSPENDED_OR_INACTIVE' ? 'INACTIVE_CLIENT' : (e.reason || e.status || 'NOT_ELIGIBLE'));
    resultsMap[e.clientId] = { clientId: e.clientId, status: outStatus };
  });

  // Sort eligible by priority rank (Priority A -> Priority B -> Priority C), then window sessions count
  eligible.sort(function(a, b) {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    var sa = (a.activity && a.activity.windowSessionsCount) || 0;
    var sb = (b.activity && b.activity.windowSessionsCount) || 0;
    if (sa !== sb) return sb - sa;
    var la = (a.activity && a.activity.lastActivityMs) || 0;
    var lb = (b.activity && b.activity.lastActivityMs) || 0;
    return lb - la;
  });

  var toProcess = eligible.slice(0, eligibility.RELEASE_MAX_CLIENTS);
  for (var j = 0; j < toProcess.length; j++) {
    var target = toProcess[j];
    try {
      var out = await executor.processProgression({
        db: input.db, clientId: target.clientId, planId: target.client.activePlanId,
        enabled: true, numericApplyEnabled: input.numericApplyEnabled === true, clock: input.clock,
        enforceActiveEligibility: true,
        starts: target.starts
      });
      resultsMap[target.clientId] = { clientId: target.clientId, status: out.status };
    } catch (_) {
      resultsMap[target.clientId] = { clientId: target.clientId, status: 'ERROR' };
    }
  }

  // Preserve stable response format mapped to target order
  for (var k = 0; k < targets.length; k++) {
    results.push(resultsMap[targets[k]] || { clientId: targets[k], status: 'ERROR' });
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
    // Read-only runtime probe (authenticated by the same secret): proves the Firestore credential works without writing anything.
    if (req.query && req.query.check === 'firestore') {
      try { await deps.db.collection('releaseControl').doc('autonomousProgression').get(); return res.status(200).json({ firestore: 'READ_OK' }); }
      catch (_) { return res.status(502).json({ firestore: 'READ_FAILED' }); }
    }
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
