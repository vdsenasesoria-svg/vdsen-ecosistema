/* Phase 1 auto-apply contract. Recommendations come from the existing Progression Engine. */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_AUTO_APPLY_SHADOW = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var NUMERIC_APPLY_ENABLED = false;
  var STATES = Object.freeze({ PENDING: 'PENDING', REJECTED: 'REJECTED', STALE: 'STALE',
    APPLIED: 'APPLIED', CONSUMED: 'CONSUMED', OVERRIDDEN: 'OVERRIDDEN', REVERTED: 'REVERTED' });
  // T529: THE lifecycle firewall. The progression application record is the single canonical lifecycle record. Terminal states have no
  // outgoing edge: a new candidate needs a new record identity (idempotency key), never a resurrection. REJECTED->PENDING exists only
  // through the Coach REVERT_DECISION action (transition()), never through lifecycleTransition(). REJECTED->STALE is the pre-existing
  // plan-change sweep (markStale).
  var ALLOWED_TRANSITIONS = Object.freeze({
    PENDING: Object.freeze(['APPLIED', 'REJECTED', 'STALE']),
    APPLIED: Object.freeze(['CONSUMED', 'OVERRIDDEN', 'REVERTED', 'STALE']),
    REJECTED: Object.freeze(['PENDING', 'STALE']), STALE: Object.freeze([]), CONSUMED: Object.freeze([]), OVERRIDDEN: Object.freeze([]), REVERTED: Object.freeze([])
  });
  var REASONS = Object.freeze({
    MAGNITUDE_POLICY_MISSING: 'MAGNITUDE_POLICY_MISSING',
    IDENTITY_MISSING: 'IDENTITY_MISSING', IDENTITY_CONFLICT: 'IDENTITY_CONFLICT',
    SOURCE_MISMATCH: 'SOURCE_MISMATCH', CALCULATED_AT_MISSING: 'CALCULATED_AT_MISSING',
    PLAN_TIMESTAMP_MISSING: 'PLAN_TIMESTAMP_MISSING',
    PLAN_CHANGED: 'PLAN_CHANGED', COACH_OVERRIDE: 'COACH_OVERRIDE',
    NO_NEXT_EXPOSURE: 'NO_NEXT_EXPOSURE', EXPOSURE_PASSED: 'EXPOSURE_PASSED',
    UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION', NO_NUMERIC_DELTA: 'NO_NUMERIC_DELTA',
    NON_COMPARABLE_VALUE: 'NON_COMPARABLE_VALUE',
    COACH_KEEP_ORIGINAL: 'COACH_KEEP_ORIGINAL', REVISION_CONFLICT: 'REVISION_CONFLICT',
    INVALID_TRANSITION: 'INVALID_TRANSITION', NOT_APPLIED: 'NOT_APPLIED', NUMERIC_APPLY_DISABLED: 'NUMERIC_APPLY_DISABLED',
    APPLIED_BY_POLICY: 'APPLIED_BY_POLICY', TARGET_STARTED: 'TARGET_STARTED', REVERTED_BY_COACH: 'REVERTED_BY_COACH', TARGET_INVALIDATED: 'TARGET_INVALIDATED'
  });

  function _validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
  function _daysForPid(plan, pid) {
    return (Array.isArray(plan && plan.days) ? plan.days : []).filter(function(day) {
      return (day.exercises || []).some(function(ex) { return ex.prescriptionExerciseId === pid; });
    }).map(function(day) { return day.dayIndex; }).filter(Number.isInteger).sort(function(a, b) { return a - b; });
  }
  function resolveNextExposure(plan, pid, week, dayIndex) {
    var days = _daysForPid(plan, pid);
    var lastWeek = Number(plan && plan.weeks);
    if (!pid || !Number.isInteger(week) || !Number.isInteger(dayIndex) || !Number.isInteger(lastWeek)) return null;
    for (var w = week; w <= lastWeek; w++) {
      for (var i = 0; i < days.length; i++) {
        if (w > week || days[i] > dayIndex) return { week: w, dayIndex: days[i] };
      }
    }
    return null;
  }
  function _fingerprint(parts) {
    var raw = JSON.stringify(parts), a = 2166136261, b = 5381;
    for (var i = 0; i < raw.length; i++) {
      a = Math.imul(a ^ raw.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ raw.charCodeAt(i);
    }
    return 'v1_' + (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  function idempotencyKey(input) {
    var rec = input.recommendation || {};
    return _fingerprint([input.clientId, input.planId, input.week, input.dayIndex,
      input.calculatedAt || null, rec.prescriptionExerciseId || null,
      rec.exerciseName || null, rec.action || null, rec.newLoad, rec.newReps]);
  }
  function _latestIntervention(interventions, planId, pid, calculatedAt) {
    var relevant = (Array.isArray(interventions) ? interventions : []).filter(function(iv) {
      return iv && iv.targetType === 'EXERCISE' && iv.targetId === pid &&
        (!iv.planId || iv.planId === planId) && _validTime(iv.decidedAt) &&
        Date.parse(iv.decidedAt) >= Date.parse(calculatedAt);
    });
    relevant.sort(function(a, b) { return Date.parse(b.decidedAt) - Date.parse(a.decidedAt); });
    return relevant.length > 0 && relevant[0].action !== 'NO_CHANGE';
  }
  function assess(input) {
    var rec = input.recommendation || {}, plan = input.plan || {};
    var pid = rec.prescriptionExerciseId;
    if (!input.clientId || !input.planId || !Number.isInteger(input.week) || !Number.isInteger(input.dayIndex))
      return { state: STATES.REJECTED, reasonCode: REASONS.IDENTITY_MISSING, nextExposure: null };
    if (!pid) return { state: STATES.REJECTED, reasonCode: REASONS.IDENTITY_MISSING, nextExposure: null };
    if (!_validTime(input.calculatedAt)) return { state: STATES.REJECTED, reasonCode: REASONS.CALCULATED_AT_MISSING, nextExposure: null };
    if (input.activePlanId !== input.planId || (plan.clientId && plan.clientId !== input.clientId))
      return { state: STATES.STALE, reasonCode: REASONS.PLAN_CHANGED, nextExposure: null };
    if (input.sourceMatches === false)
      return { state: STATES.STALE, reasonCode: REASONS.SOURCE_MISMATCH, nextExposure: null };
    if (!_validTime(plan.updatedAt))
      return { state: STATES.REJECTED, reasonCode: REASONS.PLAN_TIMESTAMP_MISSING, nextExposure: null };
    if (Date.parse(plan.updatedAt) > Date.parse(input.calculatedAt))
      return { state: STATES.STALE, reasonCode: REASONS.PLAN_CHANGED, nextExposure: null };
    if (_latestIntervention(input.interventions, input.planId, pid, input.calculatedAt))
      return { state: STATES.STALE, reasonCode: REASONS.COACH_OVERRIDE, nextExposure: null };
    var days = Array.isArray(plan.days) ? plan.days : [];
    var sourceDay = days.find(function(day) { return day.dayIndex === input.dayIndex; });
    var sourceMatches = (sourceDay && sourceDay.exercises || []).filter(function(ex) { return ex.prescriptionExerciseId === pid; });
    if (sourceMatches.length !== 1 || input.sourcePidCount > 1)
      return { state: STATES.REJECTED, reasonCode: REASONS.IDENTITY_CONFLICT, nextExposure: null };
    if (rec.exerciseId && sourceMatches[0].exerciseId && rec.exerciseId !== sourceMatches[0].exerciseId)
      return { state: STATES.REJECTED, reasonCode: REASONS.IDENTITY_CONFLICT, nextExposure: null };
    var dimension = null;
    if (rec.action === 'increase_load' || rec.action === 'reduce_load') {
      if (!Number.isFinite(Number(rec.newLoad)) || Number(rec.newLoad) <= 0)
        return { state: STATES.REJECTED, reasonCode: REASONS.NON_COMPARABLE_VALUE, nextExposure: null };
      dimension = 'LOAD';
    } else if (rec.action === 'increase_reps' || rec.action === 'reduce_reps' || rec.action === 'maintain') {
      if (!Number.isInteger(Number(rec.newReps)) || Number(rec.newReps) <= 0)
        return { state: STATES.REJECTED, reasonCode: REASONS.NON_COMPARABLE_VALUE, nextExposure: null };
      var targets = (sourceMatches[0].sets || []).map(function(s) { return Number(s.repsTarget); });
      if (!targets.length || targets.some(function(t) { return !Number.isInteger(t) || t <= 0 || t !== targets[0]; }))
        return { state: STATES.REJECTED, reasonCode: REASONS.NON_COMPARABLE_VALUE, nextExposure: null };
      if (rec.action === 'maintain' && Number(rec.newReps) === targets[0])
        return { state: STATES.REJECTED, reasonCode: REASONS.NO_NUMERIC_DELTA, nextExposure: null };
      dimension = 'REPS';
    } else return { state: STATES.REJECTED, reasonCode: REASONS.UNSUPPORTED_ACTION, nextExposure: null };
    var next = resolveNextExposure(plan, pid, input.week, input.dayIndex);
    if (!next) return { state: STATES.REJECTED, reasonCode: REASONS.NO_NEXT_EXPOSURE, nextExposure: null };
    return { state: STATES.PENDING, reasonCode: REASONS.MAGNITUDE_POLICY_MISSING, nextExposure: next, dimension: dimension };
  }
  function _policy() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      try { return require('./progression-magnitude-policy.js'); } catch (e) { return null; }
    }
    return typeof globalThis !== 'undefined' ? globalThis.VDSEN_MAGNITUDE_POLICY || null : null;
  }
  // Phase 2A: shadow magnitude decision. Never applied; only computed behind the Phase 1 guards.
  function _magnitude(input, decision) {
    var policy = _policy(), rec = input.recommendation || {}, pid = rec.prescriptionExerciseId;
    if (!policy) return null;
    if (decision.state !== STATES.PENDING) return policy.reject(pid, decision.reasonCode);
    var plan = input.plan || {}, day = (Array.isArray(plan.days) ? plan.days : []).find(function(d) { return d.dayIndex === input.dayIndex; });
    var ex = ((day && day.exercises) || []).filter(function(e) { return e.prescriptionExerciseId === pid; })[0];
    return policy.evaluate({ clientId: input.clientId, planId: input.planId, prescriptionExerciseId: pid, plan: plan,
      prescription: ex ? { prescriptionExerciseId: pid, sets: ex.sets, repsRange: ex.repsRange } : null,
      exposures: policy.extractExposures(input.entries, pid, { planId: input.planId, clientId: input.clientId }),
      context: { readinessVeto: input.readinessVeto === true } });
  }
  function buildRecord(input, at) {
    var decision = assess(input), rec = input.recommendation || {};
    var key = idempotencyKey(input);
    var magnitude = _magnitude(input, decision);
    return Object.assign({
      key: key, clientId: input.clientId, planId: input.planId,
      prescriptionExerciseId: rec.prescriptionExerciseId || null,
      exerciseNameSnapshot: rec.exerciseName || '', action: rec.action || null,
      dimension: decision.dimension || null,
      source: { week: input.week, dayIndex: input.dayIndex, calculatedAt: input.calculatedAt || null },
      nextExposure: decision.nextExposure, state: decision.state, reasonCode: decision.reasonCode,
      revision: 1, createdAt: at, updatedAt: at,
      events: [{ state: decision.state, reasonCode: decision.reasonCode, at: at, operationKey: key }]
    }, magnitude ? { magnitude: magnitude } : {});
  }
  function transition(record, action, expectedRevision, operationKey, at, actorId) {
    if (!record || !operationKey) return { ok: false, reasonCode: REASONS.INVALID_TRANSITION };
    if ((record.events || []).some(function(e) { return e.operationKey === operationKey; })) return { ok: true, idempotent: true, record: record };
    if (record.revision !== expectedRevision) return { ok: false, reasonCode: REASONS.REVISION_CONFLICT };
    var nextState, reasonCode;
    if (action === 'KEEP_ORIGINAL' && record.state === STATES.PENDING) {
      nextState = STATES.REJECTED; reasonCode = REASONS.COACH_KEEP_ORIGINAL;
    } else if (action === 'REVERT_DECISION' && record.state === STATES.REJECTED && record.reasonCode === REASONS.COACH_KEEP_ORIGINAL) {
      nextState = STATES.PENDING; reasonCode = REASONS.MAGNITUDE_POLICY_MISSING;
    } else return { ok: false, reasonCode: REASONS.INVALID_TRANSITION };
    return { ok: true, idempotent: false, record: Object.assign({}, record, {
      state: nextState, reasonCode: reasonCode, revision: record.revision + 1, updatedAt: at,
      events: (record.events || []).concat([{ state: nextState, reasonCode: reasonCode, at: at,
        operationKey: operationKey, actorId: actorId || null }])
    }) };
  }
  // Generic lifecycle edge on the canonical record. p = { expectedRevision, operationKey, at, actorId, reasonCode, patch }.
  // Idempotent by operationKey; revision-checked; APPLIED can only be created while the activation flag is on.
  function lifecycleTransition(record, to, p) {
    p = p || {};
    if (!record || !p.operationKey || !STATES[to] || to === STATES.PENDING) return { ok: false, reasonCode: REASONS.INVALID_TRANSITION };
    if ((record.events || []).some(function(e) { return e.operationKey === p.operationKey; })) return { ok: true, idempotent: true, record: record };
    if (to === STATES.APPLIED && !NUMERIC_APPLY_ENABLED) return { ok: false, reasonCode: REASONS.NUMERIC_APPLY_DISABLED };
    if (record.revision !== p.expectedRevision) return { ok: false, reasonCode: REASONS.REVISION_CONFLICT };
    if (!(ALLOWED_TRANSITIONS[record.state] || []).some(function(t) { return t === to; })) return { ok: false, reasonCode: REASONS.INVALID_TRANSITION };
    var reason = p.reasonCode || record.reasonCode;
    return { ok: true, idempotent: false, record: Object.assign({}, record, {
      state: to, reasonCode: reason, revision: record.revision + 1, updatedAt: p.at,
      lifecycle: Object.assign({}, record.lifecycle || {}, p.patch || {}),
      events: (record.events || []).concat([{ state: to, reasonCode: reason, at: p.at, operationKey: p.operationKey, actorId: p.actorId || null }])
    }) };
  }
  function markStale(record, reasonCode, at) {
    if (!record || (record.state !== STATES.PENDING && record.state !== STATES.APPLIED && record.state !== STATES.REJECTED)) return record;
    return Object.assign({}, record, { state: STATES.STALE, reasonCode: reasonCode,
      revision: record.revision + 1, updatedAt: at,
      events: (record.events || []).concat([{ state: STATES.STALE, reasonCode: reasonCode, at: at,
        operationKey: record.key + ':stale:' + record.revision }]) });
  }
  function summarize(records, planId) {
    var all = Object.keys(records || {}).map(function(k) { return records[k]; }).filter(function(r) { return r && r.planId === planId; });
    var counts = {}; Object.keys(STATES).forEach(function(k) { counts[k] = 0; });
    all.forEach(function(r) { if (counts[r.state] !== undefined) counts[r.state]++; });
    all.sort(function(a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    return { planId: planId, autoCount: counts.PENDING, counts: counts, items: all.slice(0, 8).map(function(r) {
      return { key: r.key, revision: r.revision, state: r.state, reasonCode: r.reasonCode,
        exerciseNameSnapshot: r.exerciseNameSnapshot, prescriptionExerciseId: r.prescriptionExerciseId,
        action: r.action, dimension: r.dimension || null, lifecycle: r.lifecycle || null,
        source: r.source, nextExposure: r.nextExposure, updatedAt: r.updatedAt,
        magnitude: (r.magnitude && _policy()) ? _policy().compact(r.magnitude) : null };
    }) };
  }
  // T537: which of the two log documents is the authoritative evidence source (same rule the athlete app uses to load its LOGS).
  // T553: LEGACY_UNBOUND_EVIDENCE (identical to the athlete app): a root log with execution evidence and no usable planId is never the active plan's log.
  function isLegacyUnboundLog(d) {
    return !!d && !(typeof d.planId === 'string' && d.planId !== '') &&
      Object.keys(d.entries || {}).some(function(k) { return k.indexOf('log_') === 0 || k.indexOf('done_') === 0; });
  }
  function selectLogAuthority(mesoData, rootData, planId) {
    if (isLegacyUnboundLog(rootData)) rootData = null;
    if (!mesoData) return rootData || null;
    if (!rootData || (rootData.planId && rootData.planId !== planId)) return mesoData;
    if (mesoData.planId && mesoData.planId !== planId) return rootData;
    function clock(d) { var n = Number(d.updatedAt); return Number.isFinite(n) && n > 0 ? n : 0; }
    function evidence(d) { return Object.keys(d.entries || {}).filter(function(k) { return k.indexOf('done_') === 0 || k.indexOf('log_') === 0; }); }
    function dominates(a, b) {
      var ka = evidence(a), kb = evidence(b);
      return ka.length > kb.length && kb.every(function(k) { return Object.prototype.hasOwnProperty.call(a.entries, k); });
    }
    if (dominates(rootData, mesoData)) return rootData;
    if (dominates(mesoData, rootData)) return mesoData;
    return clock(rootData) > clock(mesoData) ? rootData : mesoData;
  }

  // T537: PENDING records are created ONLY by the owner Coach (the database security rules deny the athlete every canonical write). The athlete's
  // persisted progrec_* entries are just EVIDENCE INPUT; the record and its magnitude are (re)computed here from persisted LOGS.
  // input = { clientId, planId, activePlanId, plan, interventions, entries, records, at, isStarted(entries, week, dayIndex) }
  // -> { records, changed, created: [key], staled: [key] }   (pure; never mutates its inputs)
  function materializeRecords(input) {
    var records = Object.assign({}, input.records || {}), entries = input.entries || {}, created = [], staled = [];
    if (!input.clientId || !input.planId || input.activePlanId !== input.planId) return { records: records, changed: false, created: created, staled: staled };
    var at = input.at;
    function stale(key, reason) { var before = records[key]; records[key] = markStale(records[key], reason, at); if (records[key] !== before) staled.push(key); }
    Object.keys(entries).sort().forEach(function(entryKey) {
      var m = /^progrec_(\d+)_(\d+)$/.exec(entryKey), parent = entries[entryKey];
      if (!m || !parent || !_validTime(parent.calculatedAt) || !Array.isArray(parent.recommendations) || !parent.recommendations.length) return;
      var week = Number(m[1]), dayIndex = Number(m[2]);
      parent.recommendations.forEach(function(rec) {
        if (!rec) return;
        var base = { clientId: input.clientId, planId: input.planId, activePlanId: input.activePlanId, plan: input.plan, interventions: input.interventions, entries: entries,
          week: week, dayIndex: dayIndex, calculatedAt: parent.calculatedAt, recommendation: rec, sourceMatches: true,
          sourcePidCount: rec.prescriptionExerciseId ? parent.recommendations.filter(function(r) { return r && r.prescriptionExerciseId === rec.prescriptionExerciseId; }).length : 0 };
        var candidate = buildRecord(base, at);
        if (candidate.state === STATES.PENDING && candidate.nextExposure && typeof input.isStarted === 'function' &&
            input.isStarted(entries, candidate.nextExposure.week, candidate.nextExposure.dayIndex))
          candidate = markStale(candidate, REASONS.EXPOSURE_PASSED, at);
        var prior = records[candidate.key];
        if (prior) {
          if (prior.planId !== input.planId || prior.clientId !== input.clientId || prior.prescriptionExerciseId !== candidate.prescriptionExerciseId ||
              prior.source.calculatedAt !== candidate.source.calculatedAt) throw new Error('SHADOW_KEY_COLLISION');
          if (prior.state === STATES.PENDING && candidate.state === STATES.STALE) stale(candidate.key, candidate.reasonCode);
          return;
        }
        Object.keys(records).forEach(function(key) {
          var old = records[key];
          if (old && old.state === STATES.PENDING && old.prescriptionExerciseId && old.prescriptionExerciseId === candidate.prescriptionExerciseId &&
              old.source.week === week && old.source.dayIndex === dayIndex) stale(key, REASONS.SOURCE_MISMATCH);
        });
        records[candidate.key] = candidate; created.push(candidate.key);
      });
    });
    return { records: records, changed: created.length > 0 || staled.length > 0, created: created, staled: staled };
  }

  function attemptNumericApply() {
    return { ok: false, reasonCode: REASONS.MAGNITUDE_POLICY_MISSING, applied: false };
  }
  return { NUMERIC_APPLY_ENABLED: NUMERIC_APPLY_ENABLED, STATES: STATES, REASONS: REASONS, ALLOWED_TRANSITIONS: ALLOWED_TRANSITIONS, lifecycleTransition: lifecycleTransition,
    resolveNextExposure: resolveNextExposure, idempotencyKey: idempotencyKey, assess: assess,
    buildRecord: buildRecord, transition: transition, markStale: markStale,
    summarize: summarize, selectLogAuthority: selectLogAuthority, isLegacyUnboundLog: isLegacyUnboundLog, materializeRecords: materializeRecords, attemptNumericApply: attemptNumericApply };
});
