'use strict';

// Trusted progression executor.  It is deliberately server-only: it accepts
// only a verified uid, re-reads the client/plan/log documents inside each
// transaction, and never treats request payload as training evidence.
var shadow = require('../assets/progression-auto-apply-shadow.js');
var consumer = require('../assets/progression-application-consumer.js');
var equipment = require('../assets/progression-equipment-resolver.js');
var sra = require('../assets/sra-context.js');

function _data(snap) { return snap && snap.exists === true ? snap.data() : null; }
function _now(clock) { return (clock || function() { return new Date().toISOString(); })(); }

function _refs(db, clientId, planId, coachId) {
  return {
    client: db.collection('clients').doc(clientId),
    plan: db.collection('plans').doc(planId),
    meso: db.collection('logs').doc(clientId).collection('mesos').doc(planId),
    root: db.collection('logs').doc(clientId),
    coach: coachId ? db.collection('coaches').doc(coachId) : null
  };
}

async function materialize(db, clientId, requestedPlanId, clock) {
  return db.runTransaction(async function(tx) {
    var clientRef = db.collection('clients').doc(clientId);
    var clientSnap = await tx.get(clientRef), client = _data(clientSnap);
    // The authenticated athlete is the sole tenant selector. A plan id from
    // the browser is only an equality assertion against the canonical client.
    if (!client || !client.activePlanId || client.activePlanId !== requestedPlanId) return { status: 'PLAN_MISMATCH' };
    var refs = _refs(db, clientId, requestedPlanId, client.coachId);
    var snaps = await Promise.all([tx.get(refs.plan), tx.get(refs.meso), tx.get(refs.root)]);
    var plan = _data(snaps[0]), meso = _data(snaps[1]), root = _data(snaps[2]);
    if (!plan || !root || (plan.clientId && plan.clientId !== clientId) || root.planId !== requestedPlanId || (meso && meso.planId !== requestedPlanId)) return { status: 'SOURCE_INVALID' };
    var authority = shadow.selectLogAuthority(meso, root, requestedPlanId);
    if (!authority) return { status: 'SOURCE_INVALID' };
    var out = shadow.materializeRecords({
      clientId: clientId, planId: requestedPlanId, activePlanId: client.activePlanId,
      plan: plan, interventions: client.coachInterventions, entries: authority.entries || {},
      records: (meso && meso.progressionApplications) || {}, at: _now(clock), isStarted: consumer.targetStarted
    });
    // SRA is attached as a read-only provenance trace, not a second decision
    // engine and never a gate for an otherwise valid progression candidate.
    out.created.forEach(function(key) {
      var record = out.records[key];
      out.records[key] = Object.assign({}, record, { sraTrace: sra.buildContext({ clientId: clientId, prescriptionExerciseId: record.prescriptionExerciseId,
        planDoc: plan, entries: authority.entries || {}, recommendation: record.action || 'MONITOR' }) });
    });
    var summary = shadow.summarize(out.records, requestedPlanId);
    if (out.changed) {
      // Never write entries, plan, client, or any user-supplied value.
      tx.set(refs.meso, { planId: requestedPlanId, progressionApplications: out.records, progressionApplicationSummary: summary }, { merge: true });
      tx.set(refs.root, { progressionApplicationSummary: summary }, { merge: true });
    }
    return { status: out.changed ? 'MATERIALIZED' : 'NO_CHANGE', created: out.created, summary: summary, coachId: client.coachId || null };
  });
}

async function applyPending(db, clientId, planId, clock) {
  var snap = await db.collection('logs').doc(clientId).collection('mesos').doc(planId).get();
  var meso = _data(snap);
  var keys = Object.keys((meso && meso.progressionApplications) || {}).filter(function(key) {
    return meso.progressionApplications[key] && meso.progressionApplications[key].state === shadow.STATES.PENDING;
  });
  var results = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var r = await db.runTransaction(async function(tx) {
      var clientSnap = await tx.get(db.collection('clients').doc(clientId)), client = _data(clientSnap);
      if (!client || client.activePlanId !== planId) return { written: false, reason: 'PLAN_MISMATCH' };
      var refs = _refs(db, clientId, planId, client.coachId);
      // LOAD has no fallback or guessed increment: the existing resolver is
      // intentionally given no equipment data unless a future trusted source
      // supplies it, so that branch remains blocked fail-closed.
      var equipmentResolution = equipment.resolveForCandidate({ magnitude: null, equipment: null });
      // The consumer was written against the web SDK, where `snap.exists` is a
      // function; Admin snapshots expose a boolean. Adapt rather than touch the module.
      var webTx = { get: async function(ref) { var s = await tx.get(ref); return { exists: function() { return s.exists === true; }, data: function() { return s.data(); } }; },
        set: function(ref, data, opts) { return opts ? tx.set(ref, data, opts) : tx.set(ref, data); } };
      return consumer.applyOverlayTransaction(webTx, refs, { recordKey: key, actorId: 'trusted-progressor', now: _now(clock), context: {
        clientId: clientId, planId: planId, equipmentResolution: equipmentResolution
      } }, { isCurrent: function() { return true; }, trustedServerNumericApply: true });
    });
    results.push({ recordKey: key, written: r && r.written === true, reason: r && r.reason || null });
  }
  return results;
}

// `enabled` and `numericApplyEnabled` are supplied only by the Vercel route.
// Both default false: importing this module cannot enable a production write.
async function processProgression(input) {
  input = input || {};
  if (!input.enabled) return { status: 'DISARMED', writes: 0 };
  var m = await materialize(input.db, input.clientId, input.planId, input.clock);
  if (m.status === 'PLAN_MISMATCH' || m.status === 'SOURCE_INVALID' || !input.numericApplyEnabled) return Object.assign({}, m, { applied: [] });
  return Object.assign({}, m, { applied: await applyPending(input.db, input.clientId, input.planId, input.clock) });
}

module.exports = { materialize: materialize, applyPending: applyPending, processProgression: processProgression };
