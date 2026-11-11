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
var eligibility = require('./_clientEligibility.js');
var numericPilot = require('./_numericPilotContract.js');
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
    decision: function(id) { return db.collection('clients').doc(clientId).collection('decisions').doc(id); },
    // T689: authoritative plan activation record
    activation: function(targetPlanId) { return db.collection('clients').doc(clientId).collection('plan_activations').doc(targetPlanId); }
  };
}

function _webTx(tx) {
  return { get: async function(ref) { var s = await tx.get(ref); return { exists: function() { return s.exists === true; }, data: function() { return s.data(); },
    // T602: the document's commit time on the SERVER clock (Admin snapshot updateTime), for temporal authority decisions.
    updateTime: function() { var t = s.updateTime; return t && typeof t.toMillis === 'function' ? t.toMillis() : null; } }; },
    set: function(ref, data, opts) { return opts ? tx.set(ref, data, opts) : tx.set(ref, data); } };
}

async function materialize(db, clientId, requestedPlanId, clock, opts) {
  opts = opts || {};
  // A configured numeric lane never falls back to the general/shadow scope.
  var numericMode = process.env.VDSEN_NUMERIC_PILOT_WINDOW !== undefined || process.env.VDSEN_NUMERIC_PILOT_ENABLED === 'true' ||
    process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED === 'true';
  var numericWindow = numericMode ? numericPilot.runtimeAuthorization(process.env, Date.now(), clientId) : null;
  if (numericMode && (!numericWindow || clientId !== numericWindow.uid || requestedPlanId !== numericWindow.planId)) return { status: 'OUT_OF_NUMERIC_PILOT' };
  return db.runTransaction(async function(tx) {
    var clientRef = db.collection('clients').doc(clientId);
    var clientSnap = await tx.get(clientRef), client = _data(clientSnap);
    // The authenticated athlete is the sole tenant selector. A plan id from
    // the browser is only an equality assertion against the canonical client.
    if (!client || !client.activePlanId || client.activePlanId !== requestedPlanId || !eligibility.isClientStatusValid(client)) return { status: 'PLAN_MISMATCH' };
    var refs = _refs(db, clientId, requestedPlanId, client.coachId);
    // Release-controlled canary: re-read INSIDE this transaction, before any read of evidence or any write.
    // No canary document / disabled / athlete not listed => zero writes of any kind.
    if (!(await _releaseGate(db, tx, clientId, clock))) return { status: 'OUT_OF_ALLOWLIST' };
    var coachData = refs.coach ? _data(await tx.get(refs.coach)) : null;
    var scope = consumer.normalizeCanaryScope(coachData && coachData.autoApplyCanary);
    if (!scope.enabled || scope.clientIds.indexOf(clientId) < 0) return { status: 'OUT_OF_CANARY' };
    var snaps = await Promise.all([tx.get(refs.plan), tx.get(refs.meso), tx.get(refs.root)]);
    var plan = _data(snaps[0]), meso = _data(snaps[1]), root = _data(snaps[2]);
    if (!plan || !root || !eligibility.isPlanStatusValid(plan, client) || (plan.clientId && plan.clientId !== clientId) || root.planId !== requestedPlanId || (meso && meso.planId !== requestedPlanId)) return { status: 'SOURCE_INVALID' };
    if (numericMode) {
      var freshWindow = numericPilot.runtimeAuthorization(process.env, Date.now(), clientId);
      var numericFence = _data(await tx.get(db.collection('releaseControl').doc('numericPilot')));
      var releaseFence = _data(await tx.get(db.collection('releaseControl').doc('autonomousProgression')));
      var fenceForClient = (numericFence && numericFence.windows && numericFence.windows[clientId]) || numericFence;
      var isCohort = freshWindow && freshWindow.schema === numericPilot.COHORT_SCHEMA;
      var releaseAllowed = releaseFence && Array.isArray(releaseFence.clientIds) &&
        (isCohort
          ? (releaseFence.clientIds.length >= 1 && releaseFence.clientIds.length <= 10 && releaseFence.clientIds.indexOf(clientId) >= 0)
          : (releaseFence.clientIds.length === 1 && releaseFence.clientIds[0] === clientId));
      if (!freshWindow || JSON.stringify(freshWindow) !== JSON.stringify(numericWindow) || !numericFence || numericFence.enabled !== true ||
          !fenceForClient || fenceForClient.enabled !== true ||
          !releaseAllowed || releaseFence.expiresAt !== freshWindow.expiresAt ||
          ['schema', 'mode', 'uid', 'planId', 'pid', 'runtimeSha', 'operationId', 'startsAt', 'expiresAt'].some(function(k) { return fenceForClient[k] !== freshWindow[k]; }) ||
          !numericPilot.scopeValid(coachData && coachData.autoApplyCanary, clientId, freshWindow.pid, plan, { cohort: isCohort })) return { status: 'OUT_OF_NUMERIC_PILOT' };
    }
    var authority = shadow.selectLogAuthority(meso, root, requestedPlanId);
    if (!authority) return { status: 'SOURCE_INVALID' };
    var cleanEntries = eligibility.sanitizeClientEntries(authority.entries || {}, plan, requestedPlanId);

    // Enforce full client eligibility evaluation when requested (sweep and individual trigger)
    if (opts.enforceActiveEligibility === true) {
      var starts = (opts.starts && typeof opts.starts === 'object') ? opts.starts : {};
      if (Object.keys(starts).length === 0) {
        try {
          var startsCol = db.collection('logs').doc(clientId).collection('starts');
          var sq = startsCol.orderBy('at', 'desc').limit(50);
          var startsSnap = await tx.get(sq);
          if (startsSnap && Array.isArray(startsSnap.docs)) {
            startsSnap.docs.forEach(function(d) {
              starts[d.id] = typeof d.data === 'function' ? d.data() : d.data;
            });
          }
        } catch (readErr) {
          return {
            status: 'READ_FAILED',
            eligible: false,
            reason: 'STARTS_READ_FAILED',
            error: readErr && readErr.message,
            created: [],
            applied: [],
            consumed: []
          };
        }
      }

      var clientEval = eligibility.evaluateClientEligibility({
        clientId: clientId,
        client: client,
        clientCreateTime: clientSnap && clientSnap.createTime,
        plan: plan,
        requestedPlanId: requestedPlanId,
        meso: meso,
        root: root,
        entries: cleanEntries,
        starts: starts,
        receipts: (meso && meso.consumptionReceipts) || null,
        releaseDoc: { schema: RELEASE_SCHEMA, enabled: true, expiresAt: _now(clock) },
        coachDoc: coachData,
        now: _now(clock)
      });
      if (!clientEval.eligible) {
        var ineligStatus = clientEval.reason === 'PLAN_SUSPENDED_OR_REVOKED' || clientEval.reason === 'NEEDS_PLAN_PREP'
          ? 'SOURCE_INVALID'
          : (clientEval.reason || 'NOT_ELIGIBLE');
        return { status: ineligStatus, eligible: false, reason: clientEval.reason, created: [], applied: [], consumed: [] };
      }
    }

    var existingRecords = (meso && meso.progressionApplications) || {};
    var hasWork = Object.keys(cleanEntries).some(function(k) { return /^progrec_\d+_\d+$/.test(k); }) || Object.keys(existingRecords).length > 0;
    var decisionTimes = {};
    if (hasWork) {
      for (var di = 0, ivs = (Array.isArray(client.coachInterventions) ? client.coachInterventions : []).filter(function(iv) { return iv && iv.id && iv.targetType === 'EXERCISE'; }).slice(-200); di < ivs.length; di++) {
        var dd = _data(await tx.get(refs.decision(String(ivs[di].id)))); if (dd && dd.at && dd.id === ivs[di].id) decisionTimes[ivs[di].id] = dd.at;
      }
    }
    var verifiedInterventions = effective.withServerDecisionTimes(client.coachInterventions, decisionTimes);
    var out = shadow.materializeRecords({
      clientId: clientId, planId: requestedPlanId, activePlanId: client.activePlanId,
      plan: plan, interventions: verifiedInterventions, entries: cleanEntries,
      records: existingRecords, overlays: (meso && meso.nextExposureOverlays) || {}, structural: true, at: _now(clock), isStarted: consumer.targetStarted
    });
    // SRA is attached as a read-only provenance trace, not a second decision
    // engine and never a gate for an otherwise valid progression candidate.
    // PID-level scope: a record for a PID outside the canary is never created.
    var createdBefore = out.created.length;
    out.created = out.created.filter(function(key) {
      var pid = out.records[key].prescriptionExerciseId;
      var inScope = consumer.inCanaryScope(coachData.autoApplyCanary, clientId, pid) && (!numericMode || pid === numericWindow.pid);
      if (!inScope) delete out.records[key];
      return inScope;
    });
    if (numericMode) {
      // A numeric pilot may neither create nor alter lifecycle records for other PIDs.
      out.staled = out.staled.filter(function(key) {
        var prior = existingRecords[key];
        if (prior && prior.prescriptionExerciseId !== numericWindow.pid) { out.records[key] = prior; return false; }
        return true;
      });
      out.changed = out.created.length > 0 || out.staled.length > 0;
    } else if (createdBefore && !out.created.length) out.changed = false;
    var sessionMonitoring = out.created.length ? sra.sessionMonitoring({ clientId: clientId, planDoc: plan, entries: cleanEntries }) : null;
    out.created.forEach(function(key) {
      var record = out.records[key];
      out.records[key] = Object.assign({}, record, { sraTrace: sra.buildContext({ clientId: clientId, prescriptionExerciseId: record.prescriptionExerciseId,
        planDoc: plan, entries: cleanEntries, recommendation: record.action || 'MONITOR', sessionMonitoring: sessionMonitoring }) });
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
  // A direct call must not bypass the independently authorized numeric lane.
  var authorizedWindow = numericPilot.runtimeAuthorization(process.env, Date.now(), clientId);
  if (!authorizedWindow || clientId !== authorizedWindow.uid || planId !== authorizedWindow.planId) return [];
  var snap = await db.collection('logs').doc(clientId).collection('mesos').doc(planId).get();
  var meso = _data(snap);
  var clientDoc = _data(await db.collection('clients').doc(clientId).get());
  if (!clientDoc || clientDoc.activePlanId !== planId || !eligibility.isClientStatusValid(clientDoc)) return [];
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
      if (!client || client.activePlanId !== planId || !eligibility.isClientStatusValid(client)) return { written: false, reason: 'PLAN_MISMATCH' };
      var refs = _refs(db, clientId, planId, client.coachId);
      if (!(await _releaseGate(db, tx, clientId, clock))) return { written: false, reason: 'OUT_OF_ALLOWLIST' };
      var planDoc = _data(await tx.get(refs.plan));
      if (!planDoc || (planDoc.clientId && planDoc.clientId !== clientId) || (planDoc.coachId && planDoc.coachId !== client.coachId)) {
        return { written: false, reason: 'PLAN_MISMATCH' };
      }
      if (!eligibility.isPlanStatusValid(planDoc, client)) return { written: false, reason: 'PLAN_MISMATCH' };
      var coachDoc = refs.coach ? _data(await tx.get(refs.coach)) : null;
      // T582: a verified equipment increment is used when available; otherwise the LOAD target is advisory (never a guessed machine increment).
      var equipmentResolution = null;
      var pre = _data(await tx.get(refs.meso)), precord = pre && pre.progressionApplications && pre.progressionApplications[key];
      // Re-read both fences and the canonical record in the same transaction as the write.
      var numericFence = _data(await tx.get(db.collection('releaseControl').doc('numericPilot')));
      var nw = numericPilot.runtimeAuthorization(process.env, Date.now(), clientId);
      var releaseFence = _data(await tx.get(db.collection('releaseControl').doc('autonomousProgression')));
      var fenceForClient = (numericFence && numericFence.windows && numericFence.windows[clientId]) || numericFence;
      var opRef = db.collection('releaseControl').doc('numericPilot').collection('operations').doc(authorizedWindow.operationId);
      var opDoc = _data(await tx.get(opRef));
      if (!opDoc) {
        return { written: false, reason: 'NUMERIC_LEDGER_MISSING' };
      }
      if (opDoc.status !== 'RESERVED') {
        return { written: false, reason: 'NUMERIC_LEDGER_NOT_RESERVED' };
      }
      if (Array.isArray(opDoc.appliedRecordKeys) && opDoc.appliedRecordKeys.indexOf(key) >= 0) {
        return { written: false, reason: 'ALREADY_APPLIED_FOR_OPERATION' };
      }
      if (!numericPilot.ledgerValid(opDoc, nw, key)) {
        return { written: false, reason: 'NUMERIC_LEDGER_INVALID' };
      }
      if (precord && !consumer.inCanaryScope(coachDoc && coachDoc.autoApplyCanary, clientId, precord.prescriptionExerciseId)) {
        return { written: false, reason: 'OUT_OF_CANARY_SCOPE' };
      }
      if (!numericPilot.transactionAllowed(authorizedWindow, nw, fenceForClient, releaseFence,
          coachDoc && coachDoc.autoApplyCanary, clientId, precord, planDoc, opDoc, key)) {
        return { written: false, reason: 'NUMERIC_PILOT_NOT_AUTHORIZED' };
      }
      if (precord && precord.magnitude && (precord.magnitude.candidates || []).some(function(c) { return c && c.dimension === 'LOAD'; })) {
        // Increments come only from verified, already-configured sources (coach equipmentIncrements config + the catalog's canonical equipment
        // identity). Nothing is inferred from the equipment type or the exercise name; no data => BLOCKED_EQUIPMENT_DATA for LOAD only.
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
      var appRes = await consumer.applyOverlayTransaction(webTx, refs, { recordKey: key, actorId: 'trusted-progressor', now: _now(clock), context: {
        clientId: clientId, planId: planId, equipmentResolution: equipmentResolution
      } }, { isCurrent: function() { return true; }, trustedServerNumericApply: true });
      if (appRes && appRes.written === true) {
        var appliedKeys = Array.isArray(opDoc.appliedRecordKeys) ? opDoc.appliedRecordKeys.slice() : [];
        if (appliedKeys.indexOf(key) < 0) appliedKeys.push(key);
        var hist = Array.isArray(opDoc.history) ? opDoc.history.slice() : [];
        hist.push({
          sequence: hist.length + 1,
          action: 'RECORD_APPLIED',
          recordKey: key,
          at: _now(clock),
          actor: 'trusted-progressor'
        });
        if (typeof tx.update === 'function') {
          tx.update(opRef, {
            appliedRecordKeys: appliedKeys,
            history: hist
          });
        } else {
          tx.set(opRef, {
            appliedRecordKeys: appliedKeys,
            history: hist
          }, { merge: true });
        }
      }
      return appRes;
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
      var clientSnap = await tx.get(db.collection('clients').doc(clientId)), client = _data(clientSnap);
      if (!client || !eligibility.isClientStatusValid(client)) return { written: false, reason: 'PLAN_MISMATCH' };
      var refs = _refs(db, clientId, planId, client.coachId);
      if (!(await _releaseGate(db, tx, clientId, clock))) return { written: false, reason: 'OUT_OF_ALLOWLIST' };
      var planDoc = _data(await tx.get(refs.plan));
      if (!planDoc || (planDoc.clientId && planDoc.clientId !== clientId) || (planDoc.coachId && planDoc.coachId !== client.coachId)) {
        return { written: false, reason: 'PLAN_MISMATCH' };
      }
      if (eligibility.isPlanSuspendedOrRevoked(planDoc)) {
        return { written: false, reason: 'PLAN_MISMATCH' };
      }
      var coachData = refs.coach ? _data(await tx.get(refs.coach)) : null;
      var m = _data(await tx.get(refs.meso)), rec = m && m.progressionApplications && m.progressionApplications[key];
      if (!rec || !consumer.inCanaryScope(coachData && coachData.autoApplyCanary, clientId, rec.prescriptionExerciseId)) return { written: false, reason: 'OUT_OF_CANARY_SCOPE' };
      var rootDoc = refs.root ? _data(await tx.get(refs.root)) : null;
      var authDoc = shadow.selectLogAuthority ? shadow.selectLogAuthority(m, rootDoc, planId) : m;
      var entries = (authDoc && authDoc.entries) || (m && m.entries) || {};
      var tgt = rec.nextExposure || {};
      if (client.activePlanId !== planId) {
        // T532 test 7 / T686.1 / T687: For a replaced plan, consumption is only allowed if there is CANONICAL
        // temporal evidence that the exposure started before the plan substitution occurred.
        // A simple device-level entry with `done: true` does NOT constitute chronological proof.
        var tday = (Array.isArray(planDoc.days) ? planDoc.days : []).filter(function(d) { return d.dayIndex === tgt.dayIndex; })[0];
        var exIdx = ((tday && tday.exercises) || []).map(function(e) { return e.prescriptionExerciseId; }).indexOf(rec.prescriptionExerciseId);
        var startMarkerSnap = (exIdx >= 0 && typeof refs.start === 'function') ? await tx.get(refs.start(planId, tgt.week, tgt.dayIndex, exIdx)) : null;
        var startMarker = _data(startMarkerSnap);
        // T687: Support Firestore Timestamp, objects with toMillis(), seconds/nanoseconds, ISO strings, and numbers via parseWallClockMs.
        var startAtMs = startMarker ? eligibility.parseWallClockMs(startMarker.at) : null;
        if (!Number.isFinite(startAtMs)) {
          // Without an immutable start marker (where rules force request.time), we have no canonical server timestamp.
          // Device-level done: true entries fail closed.
          return { written: false, reason: 'PLAN_MISMATCH' };
        }
        // Marker structural consistency: verify planId, week, dayIndex, exerciseIndex match target
        if (startMarker.planId !== planId || Number(startMarker.week) !== tgt.week || Number(startMarker.dayIndex) !== tgt.dayIndex || Number(startMarker.exerciseIndex) !== exIdx) {
          return { written: false, reason: 'PLAN_MISMATCH' };
        }
        if (!effective.pidExposureStarted(entries, rec.prescriptionExerciseId, tgt.week, tgt.dayIndex, rec.executionExerciseId)) {
          return { written: false, reason: 'PLAN_MISMATCH' };
        }
        // T688 / T689: Look for plan replacement timestamp.
        // An authoritative plan replacement timestamp marks when the new plan was ACTIVATED
        // (or the old plan SUPERSEDED), never when the new plan document was originally drafted/created.
        // Equating creation (createTime / createdAt) to activation is false: a plan created earlier can
        // legitimately be activated after an exposure has already started under the previous plan.
        var newPlanSnap = await tx.get(db.collection('plans').doc(client.activePlanId));
        if (!newPlanSnap || !newPlanSnap.exists) {
          // T689: Missing new plan in Firestore fails closed, even if the client retains an activePlanActivatedAt.
          return { written: false, reason: 'PLAN_MISMATCH' };
        }
        var newPlanDoc = _data(newPlanSnap);
        if (!newPlanDoc || typeof newPlanDoc !== 'object') {
          return { written: false, reason: 'PLAN_MISMATCH' };
        }
        // T689: Check authorization and tenant consistency
        if ((newPlanDoc.clientId && newPlanDoc.clientId !== clientId) ||
            (newPlanDoc.coachId && client.coachId && newPlanDoc.coachId !== client.coachId) ||
            newPlanDoc.status === 'revoked' || newPlanDoc.active === false) {
          return { written: false, reason: 'PLAN_MISMATCH' };
        }

        // T689 / T692 / T693: Authoritative immutable plan activation record verification
        var replacementMs = null;
        var actDoc = null;

        // 1. Direct authoritative lookup via pinned activeActivationId (eliminates loose newPlanId query)
        if (client.activeActivationId && db && typeof db.collection === 'function') {
          var actRef = db.collection('clients').doc(clientId).collection('plan_activations').doc(client.activeActivationId);
          var actSnap = await tx.get(actRef).catch(function() { return null; });
          if (!actSnap || !actSnap.exists) {
            // Contradictory: activeActivationId is pinned on client but record is missing -> fail closed
            return { written: false, reason: 'PLAN_MISMATCH' };
          }
          var parsedAct = _data(actSnap);
          // T694: Detect obsolete/stale activeActivationId from a prior plan assignment if mode changed to legacy
          if (parsedAct && parsedAct.newPlanId === client.activePlanId) {
            actDoc = parsedAct;
          }
        } else if (typeof refs.activation === 'function') {
          // 2. Compatibility fallback: keyed by planId
          var actSnapLegacy = await tx.get(refs.activation(client.activePlanId)).catch(function() { return null; });
          if (actSnapLegacy && actSnapLegacy.exists) {
            actDoc = _data(actSnapLegacy);
          }
        }

        // 3. Strict validation of authoritative activation record
        if (actDoc) {
          if (!actDoc || typeof actDoc !== 'object') {
            return { written: false, reason: 'PLAN_MISMATCH' };
          }
          if (actDoc.clientId && actDoc.clientId !== clientId) {
            return { written: false, reason: 'PLAN_MISMATCH' };
          }
          if (actDoc.coachId && client.coachId && actDoc.coachId !== client.coachId) {
            return { written: false, reason: 'PLAN_MISMATCH' };
          }
          if (actDoc.newPlanId && actDoc.newPlanId !== client.activePlanId) {
            return { written: false, reason: 'PLAN_MISMATCH' };
          }
          if (actDoc.previousPlanId !== undefined && actDoc.previousPlanId !== planId) {
            return { written: false, reason: 'PLAN_MISMATCH' };
          }
          // Verify active/valid state of the new plan
          var newPlanRef = db.collection('plans').doc(client.activePlanId);
          var newPlanSnap = await tx.get(newPlanRef).catch(function() { return null; });
          if (!newPlanSnap || !newPlanSnap.exists) {
            return { written: false, reason: 'PLAN_MISMATCH' };
          }
          var newPlanData = _data(newPlanSnap);
          if (!newPlanData || (newPlanData.status !== 'active' && newPlanData.status !== 'draft_approved')) {
            return { written: false, reason: 'PLAN_NOT_ACTIVE' };
          }
          // Verify authoritative temporal provenance
          replacementMs = eligibility.parseWallClockMs(actDoc.at);
          if (replacementMs === null || isNaN(replacementMs) || replacementMs <= 0) {
            return { written: false, reason: 'ACTIVATION_TIMESTAMP_INVALID' };
          }
        }

        // 4. Fallback for un-migrated legacy clients without plan_activations
        if (replacementMs === null) {
          var candidateVal = client.activePlanActivatedAt ||
                             client.planActivatedAt ||
                             (newPlanDoc && newPlanDoc.activatedAt) ||
                             (planDoc && planDoc.supersededAt) ||
                             client.activePlanUpdatedAt ||
                             client.planChangedAt || null;
          replacementMs = eligibility.parseWallClockMs(candidateVal);
        }
        // If there is no reliable replacement timestamp, we cannot establish chronology; fail closed without guessing dates.
        if (!Number.isFinite(replacementMs)) {
          return { written: false, reason: 'PLAN_MISMATCH' };
        }
        if (startAtMs > replacementMs) {
          // Canonical proof demonstrates the exposure started AFTER the plan was activated/substituted.
          return { written: false, reason: 'PLAN_MISMATCH' };
        }
      } else {
        if (!eligibility.isPlanStatusValid(planDoc, client)) return { written: false, reason: 'PLAN_MISMATCH' };
      }
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
  var m = await materialize(input.db, input.clientId, input.planId, input.clock, input);
  var terminalStatuses = [
    'PLAN_MISMATCH', 'SOURCE_INVALID', 'OUT_OF_CANARY', 'OUT_OF_ALLOWLIST',
    'INACTIVE_CLIENT', 'NO_VERIFIABLE_APP_USAGE', 'AWAITING_FIRST_ACTIVITY',
    'NEW_CLIENT_AWAITING_FIRST_ACTIVITY', 'NEEDS_VERIFIED_ACTIVITY',
    'NO_TEMPORAL_EVIDENCE', 'SAFETY_HOLD', 'NOT_ELIGIBLE',
    'READ_FAILED', 'STARTS_READ_FAILED', 'OUT_OF_NUMERIC_PILOT'
  ];
  if (terminalStatuses.indexOf(m.status) >= 0 || !input.numericApplyEnabled) return Object.assign({}, m, { applied: [], consumed: [] });
  var hasPending = !(m.summary && m.summary.counts && m.summary.counts.PENDING === 0);
  var applied = hasPending ? await applyPending(input.db, input.clientId, input.planId, input.clock) : [];
  var hasApplied = !(m.summary && m.summary.counts && m.summary.counts.APPLIED === 0) || applied.some(function(a) { return a && a.written; });
  return Object.assign({}, m, { applied: applied, consumed: hasApplied ? await consumePending(input.db, input.clientId, input.planId, input.clock) : [] });
}

module.exports = { materialize: materialize, applyPending: applyPending, consumePending: consumePending, releaseGate: _releaseGate, releaseUnexpired: _releaseUnexpired, processProgression: processProgression, eligibility: eligibility };
