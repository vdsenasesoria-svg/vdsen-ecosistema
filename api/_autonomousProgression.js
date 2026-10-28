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
// The consumer loads this module through an injected require (_req), which Vercel's file tracer cannot follow: without this literal
// require it is absent from the deployed function and applyPending throws MODULE_NOT_FOUND (hosted-only; see _functionBundleTrace.test.js).
var effective = require('../assets/progression-effective-prescription.js');
// T586: same reason for the structural / fatigue rules (loaded lazily by the magnitude policy through a literal require).
require('../assets/progression-structural-policy.js');

// T582 (owner decision): equipment data is OPTIONAL. LOAD no longer blocks for lack of equipment identity / increments: it falls back to an advisory target
// (see resolveAdvisoryLoad). These reasons remain only as classifications for a consumer that is handed an explicit equipment resolution, and
// ADVISORY_LOAD_UNAVAILABLE (unknown unit / no usable executed load) is the only LOAD data block left. REPS / REST never depend on equipment.
var EQUIPMENT_BLOCKERS = ['UNRESOLVED_EQUIPMENT_INCREMENT', 'EQUIPMENT_IDENTITY_UNRESOLVED', 'EQUIPMENT_RESOLUTION_MISMATCH', 'UNIT_MISMATCH',
  'EQUIPMENT_OUT_OF_RANGE', 'EQUIPMENT_INPUT_INVALID', 'DIRECTION_NOT_REALIZABLE'];

// Second canary fence, owned by the RELEASE system (not the Coach): releaseControl/autonomousProgression, writable only with Admin
// credentials (no Firestore rule matches it, so every client/Coach access is denied). Re-read INSIDE every canonical transaction.
// Missing / disabled / malformed / oversized / wildcard / not listing the athlete => closed. Both fences must be open.
var RELEASE_SCHEMA = 'vdsen-autonomous-release-v1', RELEASE_MAX_CLIENTS = 10;
// T657: the release fence EXPIRES. `expiresAt` is a strict UTC ISO-8601 string written only by Admin; the executor compares it with its own clock inside every
// transaction (no CRON involved). Absent / malformed / not-in-the-future / more than RELEASE_MAX_TTL_MS ahead => closed. The window cap bounds a hand-written doc.
var RELEASE_MAX_TTL_MS = 31 * 24 * 3600 * 1000, ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function _releaseUnexpired(expiresAt, nowIso) {
  if (typeof expiresAt !== 'string' || !ISO_UTC.test(expiresAt)) return false;
  var exp = Date.parse(expiresAt), now = Date.parse(nowIso);
  return isFinite(exp) && isFinite(now) && exp > now && exp - now <= RELEASE_MAX_TTL_MS;
}
async function _releaseGate(db, tx, clientId, clock) {
  var d = _data(await tx.get(db.collection('releaseControl').doc('autonomousProgression')));
  if (!d || d.schema !== RELEASE_SCHEMA || d.enabled !== true || !Array.isArray(d.clientIds)) return false;
  if (!_releaseUnexpired(d.expiresAt, _now(clock))) return false;
  var ids = d.clientIds;
  if (!ids.length || ids.length > RELEASE_MAX_CLIENTS || ids.some(function(x) { return typeof x !== 'string' || !x || x === '*'; })) return false;
  return typeof clientId === 'string' && clientId !== '' && ids.indexOf(clientId) >= 0;
}

function _data(snap) { return snap && snap.exists === true ? snap.data() : null; }
function _now(clock) { return (clock || function() { return new Date().toISOString(); })(); }

function _refs(db, clientId, planId, coachId) {
  return {
    client: db.collection('clients').doc(clientId),
    plan: db.collection('plans').doc(planId),
    meso: db.collection('logs').doc(clientId).collection('mesos').doc(planId),
    root: db.collection('logs').doc(clientId),
    coach: coachId ? db.collection('coaches').doc(coachId) : null,
    // T603: database-stamped records (their `at` is forced to request.time by firestore.rules): exposure start markers and Coach decision records.
    start: function(pid, week, dayIndex, exIdx) { return db.collection('logs').doc(clientId).collection('starts').doc(pid + '_' + week + '_' + dayIndex + '_' + exIdx); },
    decision: function(id) { return db.collection('clients').doc(clientId).collection('decisions').doc(id); }
  };
}

function _webTx(tx) {
  return { get: async function(ref) { var s = await tx.get(ref); return { exists: function() { return s.exists === true; }, data: function() { return s.data(); },
    // T602: the document's commit time on the SERVER clock (Admin snapshot updateTime), for temporal authority decisions.
    updateTime: function() { var t = s.updateTime; return t && typeof t.toMillis === 'function' ? t.toMillis() : null; } }; },
    set: function(ref, data, opts) { return opts ? tx.set(ref, data, opts) : tx.set(ref, data); } };
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
    if (!(await _releaseGate(db, tx, clientId, clock))) return { status: 'OUT_OF_ALLOWLIST' };
    var coachData = refs.coach ? _data(await tx.get(refs.coach)) : null;
    var scope = consumer.normalizeCanaryScope(coachData && coachData.autoApplyCanary);
    if (!scope.enabled || scope.clientIds.indexOf(clientId) < 0) return { status: 'OUT_OF_CANARY' };
    var decisionTimes = {};
    for (var di = 0, ivs = (Array.isArray(client.coachInterventions) ? client.coachInterventions : []).filter(function(iv) { return iv && iv.id && iv.targetType === 'EXERCISE'; }).slice(-200); di < ivs.length; di++) {
      var dd = _data(await tx.get(refs.decision(String(ivs[di].id)))); if (dd && dd.at && dd.id === ivs[di].id) decisionTimes[ivs[di].id] = dd.at;
    }
    var verifiedInterventions = effective.withServerDecisionTimes(client.coachInterventions, decisionTimes);
    var snaps = await Promise.all([tx.get(refs.plan), tx.get(refs.meso), tx.get(refs.root)]);
    var plan = _data(snaps[0]), meso = _data(snaps[1]), root = _data(snaps[2]);
    if (!plan || !root || (plan.clientId && plan.clientId !== clientId) || root.planId !== requestedPlanId || (meso && meso.planId !== requestedPlanId)) return { status: 'SOURCE_INVALID' };
    var authority = shadow.selectLogAuthority(meso, root, requestedPlanId);
    if (!authority) return { status: 'SOURCE_INVALID' };
    var out = shadow.materializeRecords({
      clientId: clientId, planId: requestedPlanId, activePlanId: client.activePlanId,
      plan: plan, interventions: verifiedInterventions, entries: authority.entries || {},
      records: (meso && meso.progressionApplications) || {}, overlays: (meso && meso.nextExposureOverlays) || {}, structural: true, at: _now(clock), isStarted: consumer.targetStarted
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
      if (!(await _releaseGate(db, tx, clientId, clock))) return { written: false, reason: 'OUT_OF_ALLOWLIST' };
      // T582: a verified equipment increment is used when available; otherwise the LOAD target is advisory (never a guessed machine increment).
      var equipmentResolution = null;
      var pre = _data(await tx.get(refs.meso)), precord = pre && pre.progressionApplications && pre.progressionApplications[key];
      if (precord && precord.magnitude && (precord.magnitude.candidates || []).some(function(c) { return c && c.dimension === 'LOAD'; })) {
        // Increments come only from verified, already-configured sources (coach equipmentIncrements config + the catalog's canonical equipment
        // identity). Nothing is inferred from the equipment type or the exercise name; no data => BLOCKED_EQUIPMENT_DATA for LOAD only.
        var coachDoc = refs.coach ? _data(await tx.get(refs.coach)) : null, planDoc = _data(await tx.get(refs.plan));
        var pex = null;
        ((planDoc && planDoc.days) || []).forEach(function(d) { (d.exercises || []).forEach(function(e) { if (!pex && e.prescriptionExerciseId === precord.prescriptionExerciseId) pex = e; }); });
        // Identity of the prescribed exercise: the plan's own exerciseId, else the Coach's EXPLICIT link for this exact prescriptionExerciseId
        // (coaches/{uid}.exerciseLinks, written by that Coach only). Never inferred from the exercise name or position; an unknown id stays unresolved.
        var links = coachDoc && coachDoc.exerciseLinks && typeof coachDoc.exerciseLinks === 'object' ? coachDoc.exerciseLinks : null;
        var linkedId = pex ? (pex.exerciseId || (links && typeof links[pex.prescriptionExerciseId] === 'string' ? links[pex.prescriptionExerciseId] : null)) : null;
        var ref = linkedId ? equipmentContext.equipmentRefForExercise({ catalog: visualCatalog, exerciseId: linkedId, config: coachDoc && coachDoc.equipmentIncrements }) : null;
        equipmentResolution = ref ? equipment.resolveForCandidate({ magnitude: precord.magnitude, equipment: ref }) : null;
        // T582: verified equipment, when it fully resolves, still gives the machine-exact load. Anything else (no id, no increment, a tie, a configured limit,
        // a unit mismatch) is NOT a reason to withhold the progression: the athlete gets an advisory target and records the load they really use.
        if (!equipmentResolution || equipmentResolution.resolutionState !== 'RESOLVED') equipmentResolution = equipment.resolveAdvisoryLoad({ magnitude: precord.magnitude });
      }
      // The consumer was written against the web SDK, where `snap.exists` is a
      // function; Admin snapshots expose a boolean. Adapt rather than touch the module.
      var webTx = _webTx(tx);
      return consumer.applyOverlayTransaction(webTx, refs, { recordKey: key, actorId: 'trusted-progressor', now: _now(clock), context: {
        clientId: clientId, planId: planId, equipmentResolution: equipmentResolution
      } }, { isCurrent: function() { return true; }, trustedServerNumericApply: true });
    });
    var reason = r && r.reason || null;
    results.push({ recordKey: key, written: r && r.written === true, reason: reason, blocked: reason && EQUIPMENT_BLOCKERS.indexOf(reason) >= 0 ? 'BLOCKED_EQUIPMENT_DATA' : (reason === 'ADVISORY_LOAD_UNAVAILABLE' ? 'BLOCKED_LOAD_DATA' : null) });
  }
  return results;
}

// APPLIED -> CONSUMED. The athlete only appends a receipt; the server validates it against the canonical record, overlay, PID, plan,
// exposure and the PERSISTED first working set (all re-read inside the transaction by the consumer) and performs the transition.
// It never changes the prescription and never runs without both canary fences.
async function consumePending(db, clientId, planId, clock) {
  var meso = _data(await db.collection('logs').doc(clientId).collection('mesos').doc(planId).get());
  var keys = Object.keys((meso && meso.consumptionReceipts) || {}).filter(function(key) {
    var r = meso.progressionApplications && meso.progressionApplications[key];
    return r && r.state === shadow.STATES.APPLIED;
  });
  var results = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var r = await db.runTransaction(async function(tx) {
      var client = _data(await tx.get(db.collection('clients').doc(clientId)));
      if (!client || client.activePlanId !== planId) return { written: false, reason: 'PLAN_MISMATCH' };
      var refs = _refs(db, clientId, planId, client.coachId);
      if (!(await _releaseGate(db, tx, clientId, clock))) return { written: false, reason: 'OUT_OF_ALLOWLIST' };
      var coachData = refs.coach ? _data(await tx.get(refs.coach)) : null;
      var m = _data(await tx.get(refs.meso)), rec = m && m.progressionApplications && m.progressionApplications[key];
      if (!rec || !consumer.inCanaryScope(coachData && coachData.autoApplyCanary, clientId, rec.prescriptionExerciseId)) return { written: false, reason: 'OUT_OF_CANARY_SCOPE' };
      return consumer.consumeOverlayTransaction(_webTx(tx), refs, { recordKey: key, clientId: clientId, actorId: 'trusted-progressor', now: _now(clock) },
        { isCurrent: function() { return true; }, trustedServerNumericApply: true });
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
  if (['PLAN_MISMATCH', 'SOURCE_INVALID', 'OUT_OF_CANARY', 'OUT_OF_ALLOWLIST'].indexOf(m.status) >= 0 || !input.numericApplyEnabled) return Object.assign({}, m, { applied: [], consumed: [] });
  var applied = await applyPending(input.db, input.clientId, input.planId, input.clock);
  return Object.assign({}, m, { applied: applied, consumed: await consumePending(input.db, input.clientId, input.planId, input.clock) });
}

module.exports = { materialize: materialize, applyPending: applyPending, consumePending: consumePending, releaseGate: _releaseGate, processProgression: processProgression };
