'use strict';

// Trusted progression executor.  It is deliberately server-only: it accepts
// only a verified uid, re-reads the client/plan/log documents inside each
// transaction, and never treats request payload as training evidence.
var shadow = require('../assets/progression-auto-apply-shadow.js');
var consumer = require('../assets/progression-application-consumer.js');
var equipment = require('../assets/progression-equipment-resolver.js');
var sra = require('../assets/sra-context.js');
var equipmentContext = require('../assets/equipment-context.js');
var visualCatalog = require('../assets/exercise-visual-catalog.js');

// Reasons that mean "the engine proposed a LOAD change but verified equipment data cannot realize it". Only the LOAD dimension is
// blocked; REPS / REST candidates never depend on equipment data.
var EQUIPMENT_BLOCKERS = ['UNRESOLVED_EQUIPMENT_INCREMENT', 'EQUIPMENT_IDENTITY_UNRESOLVED', 'EQUIPMENT_RESOLUTION_MISMATCH', 'UNIT_MISMATCH',
  'EQUIPMENT_OUT_OF_RANGE', 'EQUIPMENT_INPUT_INVALID', 'DIRECTION_NOT_REALIZABLE'];

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
    // Release-controlled canary: re-read INSIDE this transaction, before any read of evidence or any write.
    // No canary document / disabled / athlete not listed => zero writes of any kind.
    var coachData = refs.coach ? _data(await tx.get(refs.coach)) : null;
    var scope = consumer.normalizeCanaryScope(coachData && coachData.autoApplyCanary);
    if (!scope.enabled || scope.clientIds.indexOf(clientId) < 0) return { status: 'OUT_OF_CANARY' };
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
    // PID-level scope: a record for a PID outside the canary is never created.
    var createdBefore = out.created.length;
    out.created = out.created.filter(function(key) {
      var inScope = consumer.inCanaryScope(coachData.autoApplyCanary, clientId, out.records[key].prescriptionExerciseId);
      if (!inScope) delete out.records[key];
      return inScope;
    });
    if (createdBefore && !out.created.length) out.changed = false;
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
  var clientDoc = _data(await db.collection('clients').doc(clientId).get());
  var coachDoc = clientDoc && clientDoc.coachId ? _data(await db.collection('coaches').doc(clientDoc.coachId).get()) : null;
  var canary = coachDoc && coachDoc.autoApplyCanary;
  // Cheap pre-filter only; the authoritative scope check is repeated inside each transaction by the consumer.
  var keys = Object.keys((meso && meso.progressionApplications) || {}).filter(function(key) {
    var r = meso.progressionApplications[key];
    return r && r.state === shadow.STATES.PENDING && consumer.inCanaryScope(canary, clientId, r.prescriptionExerciseId);
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
      var equipmentResolution = null;
      var pre = _data(await tx.get(refs.meso)), precord = pre && pre.progressionApplications && pre.progressionApplications[key];
      if (precord && precord.magnitude && (precord.magnitude.candidates || []).some(function(c) { return c && c.dimension === 'LOAD'; })) {
        // Increments come only from verified, already-configured sources (coach equipmentIncrements config + the catalog's canonical equipment
        // identity). Nothing is inferred from the equipment type or the exercise name; no data => BLOCKED_EQUIPMENT_DATA for LOAD only.
        var coachDoc = refs.coach ? _data(await tx.get(refs.coach)) : null, planDoc = _data(await tx.get(refs.plan));
        var pex = null;
        ((planDoc && planDoc.days) || []).forEach(function(d) { (d.exercises || []).forEach(function(e) { if (!pex && e.prescriptionExerciseId === precord.prescriptionExerciseId) pex = e; }); });
        var ref = pex && pex.exerciseId ? equipmentContext.equipmentRefForExercise({ catalog: visualCatalog, exerciseId: pex.exerciseId, config: coachDoc && coachDoc.equipmentIncrements }) : null;
        equipmentResolution = ref ? equipment.resolveForCandidate({ magnitude: precord.magnitude, equipment: ref }) : null;
      }
      // The consumer was written against the web SDK, where `snap.exists` is a
      // function; Admin snapshots expose a boolean. Adapt rather than touch the module.
      var webTx = { get: async function(ref) { var s = await tx.get(ref); return { exists: function() { return s.exists === true; }, data: function() { return s.data(); } }; },
        set: function(ref, data, opts) { return opts ? tx.set(ref, data, opts) : tx.set(ref, data); } };
      return consumer.applyOverlayTransaction(webTx, refs, { recordKey: key, actorId: 'trusted-progressor', now: _now(clock), context: {
        clientId: clientId, planId: planId, equipmentResolution: equipmentResolution
      } }, { isCurrent: function() { return true; }, trustedServerNumericApply: true });
    });
    var reason = r && r.reason || null;
    results.push({ recordKey: key, written: r && r.written === true, reason: reason, blocked: reason && EQUIPMENT_BLOCKERS.indexOf(reason) >= 0 ? 'BLOCKED_EQUIPMENT_DATA' : null });
  }
  return results;
}

// `enabled` and `numericApplyEnabled` are supplied only by the Vercel route.
// Both default false: importing this module cannot enable a production write.
async function processProgression(input) {
  input = input || {};
  if (!input.enabled) return { status: 'DISARMED', writes: 0 };
  var m = await materialize(input.db, input.clientId, input.planId, input.clock);
  if (m.status === 'PLAN_MISMATCH' || m.status === 'SOURCE_INVALID' || m.status === 'OUT_OF_CANARY' || !input.numericApplyEnabled) return Object.assign({}, m, { applied: [] });
  return Object.assign({}, m, { applied: await applyPending(input.db, input.clientId, input.planId, input.clock) });
}

module.exports = { materialize: materialize, applyPending: applyPending, processProgression: processProgression };
