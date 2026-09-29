/* T493: canonical next-exposure OVERLAY consumer -- DRY-RUN infrastructure only.
 *
 * It accepts ONLY canonical Phase 1/2A shadow records (record.magnitude from
 * progression-magnitude-policy.js) -- never a raw legacy progrec -- and answers "what WOULD be applied to
 * the exact next exposure, and why not". Precedence (future): SAFETY > Coach exact-exposure override >
 * eligible canonical overlay > base plan. The base plan (vdsen-plan-v2) is never mutated: an application is
 * an additive overlay record for ONE exact (client, plan, PID, target exposure).
 *
 * While NUMERIC_APPLY_ENABLED is false nothing is ever written: planApplication() returns
 * canApply=false, and applyOverlayTransaction() refuses to touch the transaction.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_APPLICATION_CONSUMER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var NUMERIC_APPLY_ENABLED = false;
  var SCHEMA = 'vdsen-next-exposure-overlay-v1';
  var BLOCKERS = Object.freeze({
    NUMERIC_APPLY_DISABLED: 'NUMERIC_APPLY_DISABLED',
    NOT_CANONICAL_RECORD: 'NOT_CANONICAL_RECORD', RECORD_NOT_PENDING: 'RECORD_NOT_PENDING',
    CLIENT_MISMATCH: 'CLIENT_MISMATCH', PLAN_MISMATCH: 'PLAN_MISMATCH', PLAN_CHANGED: 'PLAN_CHANGED',
    PID_NOT_UNIQUE_IN_TARGET: 'PID_NOT_UNIQUE_IN_TARGET', TARGET_EXPOSURE_CHANGED: 'TARGET_EXPOSURE_CHANGED',
    TARGET_ALREADY_STARTED: 'TARGET_ALREADY_STARTED', COACH_OVERRIDE: 'COACH_OVERRIDE',
    COACH_KEEP_ORIGINAL: 'COACH_KEEP_ORIGINAL', SAFETY_CONFLICT: 'SAFETY_CONFLICT',
    NOT_ELIGIBLE: 'NOT_ELIGIBLE', POLICY_BRANCH_REQUIRES_RESOLUTION: 'POLICY_BRANCH_REQUIRES_RESOLUTION',
    UNRESOLVED_EQUIPMENT_INCREMENT: 'UNRESOLVED_EQUIPMENT_INCREMENT', EQUIPMENT_RESOLUTION_MISMATCH: 'EQUIPMENT_RESOLUTION_MISMATCH',
    DIRECTION_NOT_REALIZABLE: 'DIRECTION_NOT_REALIZABLE', UNIT_MISMATCH: 'UNIT_MISMATCH', EQUIPMENT_OUT_OF_RANGE: 'EQUIPMENT_OUT_OF_RANGE',
    EQUIPMENT_INPUT_INVALID: 'EQUIPMENT_INPUT_INVALID',
    EVIDENCE_COUNT_INSUFFICIENT: 'EVIDENCE_COUNT_INSUFFICIENT', DIRECTION_CONFLICTING: 'DIRECTION_CONFLICTING',
    DIRECTION_UNCONFIRMED: 'DIRECTION_UNCONFIRMED', READINESS_VETO: 'READINESS_VETO',
    NO_ACTIONABLE_CANDIDATE: 'NO_ACTIONABLE_CANDIDATE', STRUCTURAL_DIMENSION_NOT_AUTHORIZED: 'STRUCTURAL_DIMENSION_NOT_AUTHORIZED',
    ALREADY_RECORDED: 'ALREADY_RECORDED', STALE_CALLBACK: 'STALE_CALLBACK', REVISION_CONFLICT: 'REVISION_CONFLICT'
  });

  // T504: every blocker belongs to exactly one readiness gate (fixed order). A candidate is executable only when
  // every gate passes (or is not applicable) AND the activation flag is on.
  var GATES = Object.freeze({
    IDENTITY: [BLOCKERS.NOT_CANONICAL_RECORD, BLOCKERS.CLIENT_MISMATCH, BLOCKERS.PLAN_MISMATCH, BLOCKERS.PID_NOT_UNIQUE_IN_TARGET],
    FRESHNESS: [BLOCKERS.PLAN_CHANGED, BLOCKERS.RECORD_NOT_PENDING, BLOCKERS.ALREADY_RECORDED],
    TARGET_EXPOSURE: [BLOCKERS.TARGET_EXPOSURE_CHANGED],
    COACH_OVERRIDE: [BLOCKERS.COACH_OVERRIDE, BLOCKERS.COACH_KEEP_ORIGINAL],
    SAFETY: [BLOCKERS.SAFETY_CONFLICT, BLOCKERS.READINESS_VETO],
    EVIDENCE_COUNT: [BLOCKERS.EVIDENCE_COUNT_INSUFFICIENT],
    DIRECTION_CONSISTENCY: [BLOCKERS.DIRECTION_CONFLICTING, BLOCKERS.DIRECTION_UNCONFIRMED],
    MAGNITUDE_BRANCH: [BLOCKERS.POLICY_BRANCH_REQUIRES_RESOLUTION, BLOCKERS.NOT_ELIGIBLE, BLOCKERS.NO_ACTIONABLE_CANDIDATE, BLOCKERS.STRUCTURAL_DIMENSION_NOT_AUTHORIZED],
    EQUIPMENT_INCREMENT: [BLOCKERS.UNRESOLVED_EQUIPMENT_INCREMENT, BLOCKERS.DIRECTION_NOT_REALIZABLE, BLOCKERS.EQUIPMENT_OUT_OF_RANGE,
      BLOCKERS.EQUIPMENT_INPUT_INVALID, BLOCKERS.EQUIPMENT_RESOLUTION_MISMATCH],
    UNIT: [BLOCKERS.UNIT_MISMATCH],
    TARGET_STARTED: [BLOCKERS.TARGET_ALREADY_STARTED]
  });

  // T505: science/product items that must be closed (director decision) before numeric application may be enabled.
  // Kept in sync with progression-magnitude-policy.js SCIENCE_GAPS (verified by tests).
  var ACTIVATION_PREREQUISITES = Object.freeze(['RULE_D_E_ALTERNATIVE_NOT_DEFINED', 'RULE_C_E_PRECEDENCE_NOT_DEFINED', 'REPRESENTATIVE_SET_NOT_DEFINED']);

  function _readiness(out, record, m) {
    var blockers = out.blockers, canonical = blockers.indexOf(BLOCKERS.NOT_CANONICAL_RECORD) < 0;
    var cands = (m && m.candidates) || [];
    var candEvaluated = canonical && m && !m.unresolved && m.eligible === true && cands.length === 1;
    var isLoad = candEvaluated && cands[0].dimension === 'LOAD';
    var gates = Object.keys(GATES).map(function(g) {
      var codes = GATES[g].filter(function(c) { return blockers.indexOf(c) >= 0; });
      var state;
      if (!canonical && g !== 'IDENTITY') state = 'NOT_EVALUATED';
      else if (codes.length) state = 'BLOCKED';
      else if (g === 'EQUIPMENT_INCREMENT' || g === 'UNIT') state = !candEvaluated ? 'NOT_EVALUATED' : (isLoad ? 'PASS' : 'NOT_APPLICABLE');
      else state = 'PASS';
      return { gate: g, state: state, codes: codes };
    });
    var real = blockers.filter(function(b) { return b !== BLOCKERS.NUMERIC_APPLY_DISABLED; });
    var readyExceptFlag = out.wouldApply === true && real.length === 0 &&
      gates.every(function(x) { return x.state === 'PASS' || x.state === 'NOT_APPLICABLE'; });
    return { gates: gates, readyExceptFlag: readyExceptFlag, executable: readyExceptFlag && NUMERIC_APPLY_ENABLED, numericApplyEnabled: NUMERIC_APPLY_ENABLED,
      activationPrerequisites: ACTIVATION_PREREQUISITES.slice() };
  }

  function _time(v) { return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null; }
  function _num(v) {
    if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
    var n = Number(v); return Number.isFinite(n) ? n : null;
  }
  function overlayKey(record) { return 'ovl_' + record.key; }

  // Session-level and conservative: logs carry positions, not identity, so any trace of the target session
  // (sets, express, skip, close) means it has started.
  function targetStarted(entries, week, dayIndex) {
    var prefixes = ['log_' + week + '_' + dayIndex + '_', 'exexpress_' + week + '_' + dayIndex + '_',
      'exskip_' + week + '_' + dayIndex + '_', 'ss_step_' + week + '_' + dayIndex + '_'];
    var closed = 'done_' + week + '_' + dayIndex;
    return Object.keys(entries || {}).some(function(k) {
      return k === closed || prefixes.some(function(p) { return k.indexOf(p) === 0; });
    });
  }

  function _candidateFor(magnitude, ctx, blockers) {
    var cands = (magnitude && magnitude.candidates) || [];
    if (cands.length !== 1) { blockers.push(BLOCKERS.NO_ACTIONABLE_CANDIDATE); return null; }
    var c = cands[0];
    if (c.dimension === 'LOAD') {
      var r = ctx.equipmentResolution;
      if (!r || r.resolutionState !== 'RESOLVED' || _num(r.realizableLoad) === null) {
        var byState = { DIRECTION_NOT_REALIZABLE: BLOCKERS.DIRECTION_NOT_REALIZABLE, UNIT_MISMATCH: BLOCKERS.UNIT_MISMATCH,
          OUT_OF_RANGE: BLOCKERS.EQUIPMENT_OUT_OF_RANGE, INVALID_INPUT: BLOCKERS.EQUIPMENT_INPUT_INVALID,
          UNRESOLVED_EQUIPMENT_INCREMENT: BLOCKERS.UNRESOLVED_EQUIPMENT_INCREMENT };
        blockers.push(!r ? BLOCKERS.UNRESOLVED_EQUIPMENT_INCREMENT : (byState[r.resolutionState] || BLOCKERS.EQUIPMENT_RESOLUTION_MISMATCH));
        return null;
      }
      if (_num(r.requestedLoad) !== _num(c.rawCandidate) || !r.equipmentId) { blockers.push(BLOCKERS.EQUIPMENT_RESOLUTION_MISMATCH); return null; }
      return { dimension: 'LOAD', previousValue: _num(c.previousValue), requestedValue: _num(c.rawCandidate),
        appliedValue: _num(r.realizableLoad), unit: r.unit || null, equipmentId: r.equipmentId, roundingReason: r.roundingReason || null };
    }
    if (c.dimension === 'REPS' || c.dimension === 'REST') {
      if (_num(c.finalCandidate) === null) { blockers.push(BLOCKERS.NO_ACTIONABLE_CANDIDATE); return null; }
      return { dimension: c.dimension, previousValue: _num(c.previousValue), requestedValue: _num(c.rawCandidate),
        appliedValue: _num(c.finalCandidate), unit: c.dimension === 'REST' ? 'SECONDS' : 'REPS', equipmentId: null, roundingReason: null };
    }
    blockers.push(BLOCKERS.STRUCTURAL_DIMENSION_NOT_AUTHORIZED);
    return null;
  }

  // Dry-run planner. Pure: reads its inputs, returns a decision; never writes.
  function planApplication(input) {
    input = input || {}; var record = input.record, ctx = input.context || {}, blockers = [];
    var out = { mode: 'DRY_RUN', schema: SCHEMA, canApply: false, wouldApply: false, blockers: blockers, overlay: null, equipment: null,
      numericApplyEnabled: NUMERIC_APPLY_ENABLED, applied: false, recordKey: record && record.key || null, audit: null };
    var m = record && record.magnitude;
    if (!record || !record.key || !m || m.mode !== 'SHADOW' || m.numericApplyAllowed !== false || m.schema !== 'vdsen-magnitude-shadow-v1' ||
        !record.prescriptionExerciseId || !record.source || !record.nextExposure) {
      blockers.push(BLOCKERS.NOT_CANONICAL_RECORD);
    } else {
      // exact identity / context
      if (record.clientId !== ctx.clientId) blockers.push(BLOCKERS.CLIENT_MISMATCH);
      if (record.planId !== ctx.planId || ctx.activePlanId !== ctx.planId) blockers.push(BLOCKERS.PLAN_MISMATCH);
      if (record.state === 'REJECTED' && record.reasonCode === 'COACH_KEEP_ORIGINAL') blockers.push(BLOCKERS.COACH_KEEP_ORIGINAL);
      else if (record.state !== 'PENDING') blockers.push(BLOCKERS.RECORD_NOT_PENDING);
      var plan = ctx.plan || {}, calcAt = _time(record.source.calculatedAt), planAt = _time(plan.updatedAt);
      if (calcAt === null || planAt === null || planAt > calcAt) blockers.push(BLOCKERS.PLAN_CHANGED);
      var t = record.nextExposure, pid = record.prescriptionExerciseId;
      var targetDay = (Array.isArray(plan.days) ? plan.days : []).filter(function(d) { return d.dayIndex === t.dayIndex; })[0];
      var matches = ((targetDay && targetDay.exercises) || []).filter(function(e) { return e.prescriptionExerciseId === pid; });
      if (matches.length !== 1) blockers.push(BLOCKERS.PID_NOT_UNIQUE_IN_TARGET);
      if (typeof ctx.resolveNextExposure === 'function') {
        var fresh = ctx.resolveNextExposure(plan, pid, record.source.week, record.source.dayIndex);
        if (!fresh || fresh.week !== t.week || fresh.dayIndex !== t.dayIndex) blockers.push(BLOCKERS.TARGET_EXPOSURE_CHANGED);
      }
      if (targetStarted(ctx.entries, t.week, t.dayIndex)) blockers.push(BLOCKERS.TARGET_ALREADY_STARTED);
      // Coach exact-exposure/exercise override: any explicit decision on this PID at or after the source calculation.
      var overridden = (Array.isArray(ctx.interventions) ? ctx.interventions : []).some(function(iv) {
        return iv && iv.targetType === 'EXERCISE' && iv.targetId === pid && (!iv.planId || iv.planId === record.planId) &&
          _time(iv.decidedAt) !== null && _time(iv.decidedAt) >= calcAt && iv.action !== 'NO_CHANGE';
      });
      if (overridden) blockers.push(BLOCKERS.COACH_OVERRIDE);
      // SAFETY outranks everything below
      if ((m.reasonCodes || []).indexOf('SAFETY_CONFLICT') >= 0 || ctx.safetyConflict === true) blockers.push(BLOCKERS.SAFETY_CONFLICT);
      // canonical eligibility
      var rc = m.reasonCodes || [], specific = [];
      if (!m.eligible) {
        if (rc.indexOf('INSUFFICIENT_COMPARABLE_EXPOSURES') >= 0) specific.push(BLOCKERS.EVIDENCE_COUNT_INSUFFICIENT);
        if (rc.indexOf('READINESS_VETO') >= 0) specific.push(BLOCKERS.READINESS_VETO);
        if (rc.indexOf('CONFLICTING_DIRECTION_ACROSS_EXPOSURES') >= 0) specific.push(BLOCKERS.DIRECTION_CONFLICTING);
        if (rc.indexOf('DIRECTION_NOT_CONFIRMED_BY_PRIOR_EXPOSURE') >= 0) specific.push(BLOCKERS.DIRECTION_UNCONFIRMED);
        specific.forEach(function(b) { if (blockers.indexOf(b) < 0) blockers.push(b); });
      }
      if (m.unresolved) blockers.push(BLOCKERS.POLICY_BRANCH_REQUIRES_RESOLUTION);
      else if (!m.eligible && !specific.length) blockers.push(BLOCKERS.NOT_ELIGIBLE);
      var cand = (m.unresolved || !m.eligible) ? null : _candidateFor(m, ctx, blockers);
      var key = overlayKey(record);
      if (ctx.existingOverlays && ctx.existingOverlays[key]) blockers.push(BLOCKERS.ALREADY_RECORDED);
      if (!blockers.length && cand) {
        out.wouldApply = true;
        out.overlay = { key: key, schema: SCHEMA, clientId: record.clientId, planId: record.planId, prescriptionExerciseId: pid,
          sourceRecordKey: record.key, sourceRevision: record.revision,
          source: { week: record.source.week, dayIndex: record.source.dayIndex, calculatedAt: record.source.calculatedAt },
          target: { week: t.week, dayIndex: t.dayIndex }, dimension: cand.dimension, previousValue: cand.previousValue,
          requestedValue: cand.requestedValue, appliedValue: cand.appliedValue, unit: cand.unit, equipmentId: cand.equipmentId,
          roundingReason: cand.roundingReason, status: 'PLANNED', reversibleUntil: 'TARGET_EXPOSURE_START',
          provenance: { methodologyFamily: m.methodologyFamily, ruleAuthority: m.ruleAuthority, evidenceLevel: m.evidenceLevel, ruleId: m.ruleId,
            comparableExposureCount: m.comparableExposureCount, directionConsistency: m.directionConsistency || null } };
      }
    }
    if (!NUMERIC_APPLY_ENABLED) blockers.push(BLOCKERS.NUMERIC_APPLY_DISABLED);
    out.canApply = out.wouldApply && NUMERIC_APPLY_ENABLED && blockers.length === 0;
    var er = ctx.equipmentResolution;
    if (er && m && (m.candidates || []).some(function(cd) { return cd && cd.dimension === 'LOAD'; })) {
      out.equipment = { equipmentId: er.equipmentId || null, equipmentType: er.equipmentType || null, unit: er.unit || null,
        requestedLoad: _num(er.requestedLoad), currentLoad: _num(er.currentLoad), realizableLoad: _num(er.realizableLoad), delta: _num(er.delta),
        roundingReason: er.roundingReason || null, incrementSource: er.incrementSource || null,
        resolutionState: er.resolutionState || null, reasons: Array.isArray(er.reasons) ? er.reasons.slice() : [] };
    }
    out.readiness = _readiness(out, record, m);
    out.audit = { event: out.wouldApply ? 'OVERLAY_WOULD_APPLY' : 'OVERLAY_BLOCKED', at: ctx.now || null, actor: 'SYSTEM_DRY_RUN',
      recordKey: out.recordKey, revision: record && record.revision !== undefined ? record.revision : null, blockers: blockers.slice(),
      overlayKey: out.overlay ? out.overlay.key : null, unresolvedRules: m && m.unresolved ? (m.unresolved.rules || []).slice() : null,
      collision: m && m.collision ? { rules: (m.collision.rules || []).slice(), classification: m.collision.classification || null } : null };
    return out;
  }

  // Reversal is only possible before the target exposure has started.
  function planReversal(input) {
    input = input || {}; var overlay = input.overlay, ctx = input.context || {}, blockers = [];
    if (!overlay || overlay.schema !== SCHEMA) blockers.push(BLOCKERS.NOT_CANONICAL_RECORD);
    else {
      if (overlay.clientId !== ctx.clientId) blockers.push(BLOCKERS.CLIENT_MISMATCH);
      if (overlay.planId !== ctx.planId || ctx.activePlanId !== ctx.planId) blockers.push(BLOCKERS.PLAN_MISMATCH);
      if (targetStarted(ctx.entries, overlay.target.week, overlay.target.dayIndex)) blockers.push(BLOCKERS.TARGET_ALREADY_STARTED);
    }
    return { mode: 'DRY_RUN', wouldRevert: blockers.length === 0, blockers: blockers, overlayKey: overlay && overlay.key || null,
      audit: { event: blockers.length ? 'REVERT_BLOCKED' : 'OVERLAY_WOULD_REVERT', at: ctx.now || null, actor: 'SYSTEM_DRY_RUN', blockers: blockers.slice() } };
  }

  // Transactional/idempotent write spec: every guard is re-read INSIDE the transaction by the caller-provided
  // reader. With NUMERIC_APPLY_ENABLED=false it never touches the transaction.
  async function applyOverlayTransaction(tx, refs, input, guards) {
    if (!NUMERIC_APPLY_ENABLED) return { written: false, reason: BLOCKERS.NUMERIC_APPLY_DISABLED };
    guards = guards || {};
    if (guards.isCurrent && !guards.isCurrent()) return { written: false, reason: BLOCKERS.STALE_CALLBACK };
    var mesoSnap = await tx.get(refs.meso), planSnap = await tx.get(refs.plan), clientSnap = await tx.get(refs.client);
    if (!mesoSnap.exists() || !planSnap.exists() || !clientSnap.exists()) return { written: false, reason: BLOCKERS.NOT_CANONICAL_RECORD };
    var meso = mesoSnap.data(), record = (meso.progressionApplications || {})[input.recordKey];
    var decision = planApplication({ record: record, context: Object.assign({}, input.context, {
      plan: planSnap.data(), interventions: clientSnap.data().coachInterventions, entries: meso.entries,
      existingOverlays: meso.nextExposureOverlays, activePlanId: clientSnap.data().activePlanId }) });
    if (!decision.canApply) return { written: false, reason: decision.blockers[0], decision: decision };
    if (input.expectedRevision !== undefined && record.revision !== input.expectedRevision) return { written: false, reason: BLOCKERS.REVISION_CONFLICT };
    tx.set(refs.meso, { nextExposureOverlays: Object.assign({}, meso.nextExposureOverlays || {}, (function() { var o = {}; o[decision.overlay.key] = decision.overlay; return o; })()) }, { merge: true });
    return { written: true, overlayKey: decision.overlay.key, decision: decision };
  }

  return { NUMERIC_APPLY_ENABLED: NUMERIC_APPLY_ENABLED, SCHEMA: SCHEMA, BLOCKERS: BLOCKERS, GATES: GATES, ACTIVATION_PREREQUISITES: ACTIVATION_PREREQUISITES, overlayKey: overlayKey,
    targetStarted: targetStarted, planApplication: planApplication, planReversal: planReversal, applyOverlayTransaction: applyOverlayTransaction };
});
