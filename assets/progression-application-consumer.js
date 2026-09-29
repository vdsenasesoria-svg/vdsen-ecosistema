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
  var api = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_APPLICATION_CONSUMER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(_req, _root) {
  'use strict';

  var NUMERIC_APPLY_ENABLED = false;
  var SCHEMA = 'vdsen-next-exposure-overlay-v1';
  var BLOCKERS = Object.freeze({
    NUMERIC_APPLY_DISABLED: 'NUMERIC_APPLY_DISABLED',
    NOT_CANONICAL_RECORD: 'NOT_CANONICAL_RECORD', RECORD_NOT_PENDING: 'RECORD_NOT_PENDING',
    CLIENT_MISMATCH: 'CLIENT_MISMATCH', PLAN_MISMATCH: 'PLAN_MISMATCH', PLAN_CHANGED: 'PLAN_CHANGED',
    IDENTITY_UNRESOLVED: 'IDENTITY_UNRESOLVED', TARGET_EXPOSURE_CHANGED: 'TARGET_EXPOSURE_CHANGED',
    TARGET_ALREADY_STARTED: 'TARGET_ALREADY_STARTED', COACH_OVERRIDE: 'COACH_OVERRIDE',
    COACH_KEEP_ORIGINAL: 'COACH_KEEP_ORIGINAL', SAFETY_CONFLICT: 'SAFETY_CONFLICT',
    NOT_ELIGIBLE: 'NOT_ELIGIBLE', MAGNITUDE_BRANCH_UNRESOLVED: 'MAGNITUDE_BRANCH_UNRESOLVED',
    UNRESOLVED_EQUIPMENT_INCREMENT: 'UNRESOLVED_EQUIPMENT_INCREMENT', EQUIPMENT_RESOLUTION_MISMATCH: 'EQUIPMENT_RESOLUTION_MISMATCH',
    DIRECTION_NOT_REALIZABLE: 'DIRECTION_NOT_REALIZABLE', UNIT_MISMATCH: 'UNIT_MISMATCH', EQUIPMENT_OUT_OF_RANGE: 'EQUIPMENT_OUT_OF_RANGE',
    EQUIPMENT_INPUT_INVALID: 'EQUIPMENT_INPUT_INVALID',
    OUT_OF_CANARY_SCOPE: 'OUT_OF_CANARY_SCOPE',
    COACH_REVIEW_REQUIRED: 'COACH_REVIEW_REQUIRED', ACTIVATION_GUARD_FAILED: 'ACTIVATION_GUARD_FAILED', EQUIPMENT_IDENTITY_UNRESOLVED: 'EQUIPMENT_IDENTITY_UNRESOLVED', SCIENCE_POLICY_UNRESOLVED: 'SCIENCE_POLICY_UNRESOLVED',
    EVIDENCE_COUNT_INSUFFICIENT: 'EVIDENCE_COUNT_INSUFFICIENT', DIRECTION_CONFLICTING: 'DIRECTION_CONFLICTING',
    DIRECTION_UNCONFIRMED: 'DIRECTION_UNCONFIRMED', READINESS_VETO: 'READINESS_VETO',
    NO_ACTIONABLE_CANDIDATE: 'NO_ACTIONABLE_CANDIDATE', STRUCTURAL_DIMENSION_NOT_AUTHORIZED: 'STRUCTURAL_DIMENSION_NOT_AUTHORIZED',
    ALREADY_RECORDED: 'ALREADY_RECORDED', STALE_CALLBACK: 'STALE_CALLBACK', REVISION_CONFLICT: 'REVISION_CONFLICT'
  });

  // T504: every blocker belongs to exactly one readiness gate (fixed order). A candidate is executable only when
  // every gate passes (or is not applicable) AND the activation flag is on.
  var GATES = Object.freeze({
    IDENTITY: [BLOCKERS.NOT_CANONICAL_RECORD, BLOCKERS.CLIENT_MISMATCH, BLOCKERS.PLAN_MISMATCH, BLOCKERS.IDENTITY_UNRESOLVED, BLOCKERS.OUT_OF_CANARY_SCOPE],
    FRESHNESS: [BLOCKERS.PLAN_CHANGED, BLOCKERS.RECORD_NOT_PENDING, BLOCKERS.ALREADY_RECORDED],
    TARGET_EXPOSURE: [BLOCKERS.TARGET_EXPOSURE_CHANGED],
    COACH_OVERRIDE: [BLOCKERS.COACH_OVERRIDE, BLOCKERS.COACH_KEEP_ORIGINAL],
    SAFETY: [BLOCKERS.SAFETY_CONFLICT, BLOCKERS.READINESS_VETO],
    EVIDENCE_COUNT: [BLOCKERS.EVIDENCE_COUNT_INSUFFICIENT],
    DIRECTION_CONSISTENCY: [BLOCKERS.DIRECTION_CONFLICTING, BLOCKERS.DIRECTION_UNCONFIRMED],
    POLICY_REVIEW: [BLOCKERS.COACH_REVIEW_REQUIRED],
    MAGNITUDE_BRANCH: [BLOCKERS.MAGNITUDE_BRANCH_UNRESOLVED, BLOCKERS.SCIENCE_POLICY_UNRESOLVED, BLOCKERS.NOT_ELIGIBLE, BLOCKERS.NO_ACTIONABLE_CANDIDATE, BLOCKERS.STRUCTURAL_DIMENSION_NOT_AUTHORIZED],
    EQUIPMENT_IDENTITY: [BLOCKERS.EQUIPMENT_IDENTITY_UNRESOLVED],
    EQUIPMENT_INCREMENT: [BLOCKERS.UNRESOLVED_EQUIPMENT_INCREMENT, BLOCKERS.DIRECTION_NOT_REALIZABLE, BLOCKERS.EQUIPMENT_OUT_OF_RANGE,
      BLOCKERS.EQUIPMENT_INPUT_INVALID, BLOCKERS.EQUIPMENT_RESOLUTION_MISMATCH],
    UNIT: [BLOCKERS.UNIT_MISMATCH],
    TARGET_STARTED: [BLOCKERS.TARGET_ALREADY_STARTED],
    ACTIVATION_GUARD: [BLOCKERS.ACTIVATION_GUARD_FAILED]
  });

  // T520: quick-scan classes for the Coach. The precise blocker codes stay underneath (readiness.gates / blockers).
  // Priority when several apply: SAFETY > CONTEXT > EVIDENCE > COACH_REVIEW > POLICY_OTHER > EQUIPMENT_DATA. COACH_REVIEW_REQUIRED is a
  // designed product state (D/E, persistent C->E), not an error.
  var PREVIEW_CLASSES = Object.freeze({
    BLOCKED_SAFETY: [BLOCKERS.SAFETY_CONFLICT, BLOCKERS.READINESS_VETO],
    BLOCKED_CONTEXT: [BLOCKERS.NOT_CANONICAL_RECORD, BLOCKERS.CLIENT_MISMATCH, BLOCKERS.PLAN_MISMATCH, BLOCKERS.IDENTITY_UNRESOLVED, BLOCKERS.OUT_OF_CANARY_SCOPE, BLOCKERS.PLAN_CHANGED,
      BLOCKERS.RECORD_NOT_PENDING, BLOCKERS.ALREADY_RECORDED, BLOCKERS.TARGET_EXPOSURE_CHANGED, BLOCKERS.TARGET_ALREADY_STARTED, BLOCKERS.COACH_OVERRIDE,
      BLOCKERS.COACH_KEEP_ORIGINAL, BLOCKERS.ACTIVATION_GUARD_FAILED, BLOCKERS.STALE_CALLBACK, BLOCKERS.REVISION_CONFLICT],
    BLOCKED_EVIDENCE: [BLOCKERS.EVIDENCE_COUNT_INSUFFICIENT, BLOCKERS.DIRECTION_CONFLICTING, BLOCKERS.DIRECTION_UNCONFIRMED, BLOCKERS.NOT_ELIGIBLE,
      BLOCKERS.NO_ACTIONABLE_CANDIDATE, BLOCKERS.STRUCTURAL_DIMENSION_NOT_AUTHORIZED],
    COACH_REVIEW_REQUIRED: [BLOCKERS.COACH_REVIEW_REQUIRED],
    BLOCKED_POLICY_OTHER: [BLOCKERS.MAGNITUDE_BRANCH_UNRESOLVED, BLOCKERS.SCIENCE_POLICY_UNRESOLVED],
    BLOCKED_EQUIPMENT_DATA: [BLOCKERS.EQUIPMENT_IDENTITY_UNRESOLVED, BLOCKERS.UNRESOLVED_EQUIPMENT_INCREMENT, BLOCKERS.EQUIPMENT_RESOLUTION_MISMATCH, BLOCKERS.DIRECTION_NOT_REALIZABLE,
      BLOCKERS.UNIT_MISMATCH, BLOCKERS.EQUIPMENT_OUT_OF_RANGE, BLOCKERS.EQUIPMENT_INPUT_INVALID]
  });
  function _previewClassOf(blockers, readyExceptFlag) {
    var real = blockers.filter(function(b) { return b !== BLOCKERS.NUMERIC_APPLY_DISABLED; });
    var present = Object.keys(PREVIEW_CLASSES).filter(function(c) { return PREVIEW_CLASSES[c].some(function(b) { return real.indexOf(b) >= 0; }); });
    if (!real.length && readyExceptFlag) return { primary: NUMERIC_APPLY_ENABLED ? 'EXECUTABLE' : 'READY_BUT_DISABLED', all: [] };
    return { primary: present[0] || 'BLOCKED_CONTEXT', all: present };
  }

  // T505: science/product items that must be closed (director decision) before numeric application may be enabled.
  // Kept in sync with progression-magnitude-policy.js SCIENCE_GAPS (verified by tests).
  var ACTIVATION_PREREQUISITES = Object.freeze([]);
  var PRODUCT_POLICIES = Object.freeze(['RULE_D_E_COACH_REVIEW_ONLY', 'RULE_C_THEN_E_COACH_REVIEW', 'REPRESENTATIVE_SET_LAST_STANDARD_WORKING_SET']);

  // T512: unsupported science is LOCALIZED: only branches that need a missing rule are blocked. D and E adjustments need the
  // reps-vs-load alternative; Rule A and Rule C candidates do not. C+E is informational (E deferred, C stands).
  function _scienceGapsFor(m) {
    // T523: no known science gap remains (D/E, C/E precedence and the representative set are closed product policy). A FUTURE unknown
    // branch would declare unresolved.scienceGap and would then block with SCIENCE_POLICY_UNRESOLVED.
    return m && m.unresolved && m.unresolved.scienceGap ? [String(m.unresolved.scienceGap)] : [];
  }

  // T513: ACTIVATION GUARD. Defense in depth: every fact required to write an overlay is RE-VERIFIED here directly from the
  // record, the overlay and the context, independently of the blocker list. Even if NUMERIC_APPLY_ENABLED is later flipped
  // and some blocker path regresses, a candidate still fails unless all of these hold.
  var GUARD_CHECKS = Object.freeze(['exactClient', 'exactActivePlan', 'exactPid', 'validSourceExposure', 'exactTargetExposure', 'targetNotStarted',
    'planNotChanged', 'noCoachOverride', 'noSafetyConflict', 'noPolicyReview', 'evidenceEligible', 'directionConsistent', 'magnitudeResolved', 'equipmentIdentityResolved',
    'equipmentIncrementResolved', 'unitCompatible', 'physicallyRealizable', 'idempotencyKeyValid', 'transactionContextCurrent']);
  var _SOURCES = { EXERCISE_METADATA: true, GYM_METADATA: true, COACH_CONFIGURED: true };
  function _int(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0; }

  function verifyActivationPreconditions(input) {
    input = input || {};
    var record = input.record || {}, overlay = input.overlay || null, ctx = input.context || {}, m = record.magnitude || {};
    var src = record.source || {}, tgt = record.nextExposure || {}, plan = ctx.plan || {};
    var calcAt = _time(src.calculatedAt), planAt = _time(plan.updatedAt);
    var cands = m.candidates || [], cand = cands.length === 1 ? cands[0] : null;
    var isLoad = !!(overlay && overlay.dimension === 'LOAD'), er = ctx.equipmentResolution || {};
    var r = {};
    r.exactClient = !!record.clientId && record.clientId === ctx.clientId && !!overlay && overlay.clientId === record.clientId;
    r.exactActivePlan = !!record.planId && record.planId === ctx.planId && ctx.planId === ctx.activePlanId && !!overlay && overlay.planId === record.planId;
    r.exactPid = typeof record.prescriptionExerciseId === 'string' && record.prescriptionExerciseId !== '' && !!overlay && overlay.prescriptionExerciseId === record.prescriptionExerciseId;
    r.validSourceExposure = _int(src.week) && _int(src.dayIndex) && calcAt !== null && !!overlay && overlay.source && overlay.source.week === src.week && overlay.source.dayIndex === src.dayIndex;
    r.exactTargetExposure = _int(tgt.week) && _int(tgt.dayIndex) && (tgt.week > src.week || (tgt.week === src.week && tgt.dayIndex > src.dayIndex)) &&
      !!overlay && !!overlay.target && overlay.target.week === tgt.week && overlay.target.dayIndex === tgt.dayIndex;
    r.targetNotStarted = _int(tgt.week) && _int(tgt.dayIndex) && !targetStarted(ctx.entries, tgt.week, tgt.dayIndex);
    r.planNotChanged = calcAt !== null && planAt !== null && planAt <= calcAt;
    r.noCoachOverride = !(Array.isArray(ctx.interventions) ? ctx.interventions : []).some(function(iv) {
      return iv && iv.targetType === 'EXERCISE' && iv.targetId === record.prescriptionExerciseId && (!iv.planId || iv.planId === record.planId) &&
        _time(iv.decidedAt) !== null && calcAt !== null && _time(iv.decidedAt) >= calcAt && iv.action !== 'NO_CHANGE'; }) &&
      !(record.state === 'REJECTED' && record.reasonCode === 'COACH_KEEP_ORIGINAL');
    r.noSafetyConflict = ctx.safetyConflict !== true && (m.reasonCodes || []).indexOf('SAFETY_CONFLICT') < 0;
    r.noPolicyReview = !m.coachReviewRequired;
    r.evidenceEligible = m.eligible === true && _num(m.comparableExposureCount) !== null && m.comparableExposureCount >= 2 && record.state === 'PENDING';
    r.directionConsistent = m.directionConsistency === 'CONSISTENT' || m.directionConsistency === 'NOT_APPLICABLE';
    r.magnitudeResolved = !m.unresolved && !!cand && m.mode === 'SHADOW' && m.numericApplyAllowed === false;
    r.equipmentIdentityResolved = !isLoad || (typeof er.equipmentId === 'string' && er.equipmentId !== '' && overlay.equipmentId === er.equipmentId);
    r.equipmentIncrementResolved = !isLoad || (er.resolutionState === 'RESOLVED' && !!_SOURCES[er.incrementSource]);
    r.unitCompatible = !isLoad || (!!er.unit && !!m.evidence && String(er.unit).toUpperCase() === String(m.evidence.unit || '').toUpperCase() && overlay.unit === er.unit);
    r.physicallyRealizable = !!overlay && _num(overlay.appliedValue) !== null && overlay.appliedValue >= 0 &&
      (!isLoad || (_num(er.realizableLoad) === overlay.appliedValue && overlay.appliedValue > 0 &&
        ((m.direction === 'UP' && overlay.appliedValue > overlay.previousValue) || (m.direction === 'DOWN' && overlay.appliedValue < overlay.previousValue))));
    r.idempotencyKeyValid = /^v1_[a-f0-9]{16}$/.test(String(record.key || '')) && !!overlay && overlay.key === 'ovl_' + record.key && overlay.sourceRecordKey === record.key;
    r.transactionContextCurrent = ctx.transactionCurrent !== false;
    var checks = GUARD_CHECKS.map(function(c) { return { check: c, ok: r[c] === true }; });
    var failed = checks.filter(function(c) { return !c.ok; }).map(function(c) { return c.check; });
    return { ok: failed.length === 0, failed: failed, checks: checks };
  }

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
      else if (g === 'ACTIVATION_GUARD') state = out.guard ? 'PASS' : 'NOT_EVALUATED';
      else if (g === 'EQUIPMENT_IDENTITY' || g === 'EQUIPMENT_INCREMENT' || g === 'UNIT') state = !candEvaluated ? 'NOT_EVALUATED' : (isLoad ? 'PASS' : 'NOT_APPLICABLE');
      else state = 'PASS';
      return { gate: g, state: state, codes: codes };
    });
    var real = blockers.filter(function(b) { return b !== BLOCKERS.NUMERIC_APPLY_DISABLED; });
    var readyExceptFlag = out.wouldApply === true && real.length === 0 &&
      gates.every(function(x) { return x.state === 'PASS' || x.state === 'NOT_APPLICABLE'; });
    return { gates: gates, readyExceptFlag: readyExceptFlag, executable: readyExceptFlag && NUMERIC_APPLY_ENABLED, numericApplyEnabled: NUMERIC_APPLY_ENABLED,
      preview: _previewClassOf(blockers, readyExceptFlag),
      state: !readyExceptFlag ? (_previewClassOf(blockers, false).primary === 'COACH_REVIEW_REQUIRED' ? 'COACH_REVIEW_REQUIRED' : 'BLOCKED') : (NUMERIC_APPLY_ENABLED ? 'EXECUTABLE' : 'READY_BUT_DISABLED'),
      activationPrerequisites: ACTIVATION_PREREQUISITES.slice(), localizedScienceGaps: _scienceGapsFor(m), globalProvisional: [], productPolicies: PRODUCT_POLICIES.slice() };
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
          UNRESOLVED_EQUIPMENT_INCREMENT: BLOCKERS.UNRESOLVED_EQUIPMENT_INCREMENT, UNRESOLVED_EQUIPMENT_IDENTITY: BLOCKERS.EQUIPMENT_IDENTITY_UNRESOLVED };
        blockers.push(!r ? BLOCKERS.UNRESOLVED_EQUIPMENT_INCREMENT : (byState[r.resolutionState] || BLOCKERS.EQUIPMENT_RESOLUTION_MISMATCH));
        return null;
      }
      if (_num(r.requestedLoad) !== _num(c.rawCandidate) || !r.equipmentId) { blockers.push(BLOCKERS.EQUIPMENT_RESOLUTION_MISMATCH); return null; }
      return { dimension: 'LOAD', previousValue: _num(c.previousValue), requestedValue: _num(c.rawCandidate),
        appliedValue: _num(r.realizableLoad), unit: r.unit || null, equipmentId: r.equipmentId, roundingReason: r.roundingReason || null,
        // T518: the increment metadata used is SNAPSHOTTED into the overlay, so a later change of the configuration can never
        // silently alter an overlay that was already recorded (nor executed LOGS, which never reference equipment metadata).
        equipmentSnapshot: { source: r.incrementSource || null, scope: r.incrementScope || null, revision: _num(r.incrementRevision),
          configuredAt: r.incrementConfiguredAt || null, kind: r.incrementKind || null, unit: r.unit || null } };
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
  // Additive Coach config `autoApplyCanary` = { enabled:false, clientIds:[], prescriptionExerciseIds:[] }. Anything malformed -> disabled, empty.
  function normalizeCanaryScope(raw) {
    var ids = function(a) { return Array.isArray(a) ? a.filter(function(x) { return typeof x === 'string' && x; }) : []; };
    raw = raw && typeof raw === 'object' ? raw : {};
    return { enabled: raw.enabled === true, clientIds: ids(raw.clientIds), prescriptionExerciseIds: ids(raw.prescriptionExerciseIds) };
  }
  // In scope only when enabled AND the client is listed AND (no PID list = every PID of that client | PID listed).
  function inCanaryScope(raw, clientId, pid) {
    var sc = normalizeCanaryScope(raw);
    return sc.enabled && sc.clientIds.indexOf(clientId) >= 0 && (!sc.prescriptionExerciseIds.length || sc.prescriptionExerciseIds.indexOf(pid) >= 0);
  }

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
      // T526: pre-live canary scope. Opt-in: an absent scope leaves behavior unchanged; a present scope is enforced (disabled = everything out).
      if (ctx.canaryScope !== undefined && !inCanaryScope(ctx.canaryScope, record.clientId, record.prescriptionExerciseId)) blockers.push(BLOCKERS.OUT_OF_CANARY_SCOPE);
      if (record.state === 'REJECTED' && record.reasonCode === 'COACH_KEEP_ORIGINAL') blockers.push(BLOCKERS.COACH_KEEP_ORIGINAL);
      else if (record.state !== 'PENDING') blockers.push(BLOCKERS.RECORD_NOT_PENDING);
      var plan = ctx.plan || {}, calcAt = _time(record.source.calculatedAt), planAt = _time(plan.updatedAt);
      if (calcAt === null || planAt === null || planAt > calcAt) blockers.push(BLOCKERS.PLAN_CHANGED);
      var t = record.nextExposure, pid = record.prescriptionExerciseId;
      var targetDay = (Array.isArray(plan.days) ? plan.days : []).filter(function(d) { return d.dayIndex === t.dayIndex; })[0];
      var matches = ((targetDay && targetDay.exercises) || []).filter(function(e) { return e.prescriptionExerciseId === pid; });
      if (matches.length !== 1) blockers.push(BLOCKERS.IDENTITY_UNRESOLVED);
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
      if (m.coachReviewRequired) blockers.push(BLOCKERS.COACH_REVIEW_REQUIRED);
      if (m.unresolved) { blockers.push(BLOCKERS.MAGNITUDE_BRANCH_UNRESOLVED); if (_scienceGapsFor(m).length) blockers.push(BLOCKERS.SCIENCE_POLICY_UNRESOLVED); }
      else if (!m.eligible && !specific.length && !m.coachReviewRequired) blockers.push(BLOCKERS.NOT_ELIGIBLE);
      var cand = (m.unresolved || m.coachReviewRequired || !m.eligible) ? null : _candidateFor(m, ctx, blockers);
      var key = overlayKey(record);
      // one overlay per exact target exposure, whatever its state: a new candidate never stacks on / resurrects an earlier application
      var eo = ctx.existingOverlays;
      if (eo && (eo[key] || Object.keys(eo).some(function(k) {
        var x = eo[k]; return x && x.clientId === record.clientId && x.planId === record.planId && x.prescriptionExerciseId === pid && x.target && x.target.week === t.week && x.target.dayIndex === t.dayIndex; })))
        blockers.push(BLOCKERS.ALREADY_RECORDED);
      if (!blockers.length && cand) {
        out.wouldApply = true;
        out.overlay = { key: key, schema: SCHEMA, clientId: record.clientId, planId: record.planId, prescriptionExerciseId: pid,
          sourceRecordKey: record.key, sourceRevision: record.revision,
          source: { week: record.source.week, dayIndex: record.source.dayIndex, calculatedAt: record.source.calculatedAt },
          target: { week: t.week, dayIndex: t.dayIndex }, dimension: cand.dimension, previousValue: cand.previousValue,
          requestedValue: cand.requestedValue, appliedValue: cand.appliedValue, unit: cand.unit, equipmentId: cand.equipmentId,
          equipmentSnapshot: cand.equipmentSnapshot || null,
          roundingReason: cand.roundingReason, status: 'PLANNED', reversibleUntil: 'TARGET_EXPOSURE_START',
          provenance: { methodologyFamily: m.methodologyFamily, ruleAuthority: m.ruleAuthority, evidenceLevel: m.evidenceLevel, ruleId: m.ruleId,
            comparableExposureCount: m.comparableExposureCount, directionConsistency: m.directionConsistency || null } };
      }
    }
    out.guard = null;
    if (out.wouldApply) {
      out.guard = verifyActivationPreconditions({ record: record, overlay: out.overlay, context: ctx });
      if (!out.guard.ok) { blockers.push(BLOCKERS.ACTIVATION_GUARD_FAILED); out.wouldApply = false; out.overlay = null; }
    }
    if (!NUMERIC_APPLY_ENABLED) blockers.push(BLOCKERS.NUMERIC_APPLY_DISABLED);
    out.canApply = out.wouldApply && NUMERIC_APPLY_ENABLED && blockers.length === 0 && !!out.guard && out.guard.ok === true;
    var er = ctx.equipmentResolution;
    if (er && m && (m.candidates || []).some(function(cd) { return cd && cd.dimension === 'LOAD'; })) {
      out.equipment = { equipmentId: er.equipmentId || null, equipmentType: er.equipmentType || null, unit: er.unit || null,
        requestedLoad: _num(er.requestedLoad), currentLoad: _num(er.currentLoad), realizableLoad: _num(er.realizableLoad), delta: _num(er.delta),
        roundingReason: er.roundingReason || null, incrementSource: er.incrementSource || null, incrementScope: er.incrementScope || null, incrementRevision: _num(er.incrementRevision),
        incrementConfiguredAt: er.incrementConfiguredAt || null,
        resolutionState: er.resolutionState || null, reasons: Array.isArray(er.reasons) ? er.reasons.slice() : [] };
    }
    out.readiness = _readiness(out, record, m);
    out.audit = { event: out.wouldApply ? 'OVERLAY_WOULD_APPLY' : 'OVERLAY_BLOCKED', at: ctx.now || null, actor: 'SYSTEM_DRY_RUN',
      recordKey: out.recordKey, revision: record && record.revision !== undefined ? record.revision : null, blockers: blockers.slice(),
      overlayKey: out.overlay ? out.overlay.key : null, unresolvedRules: m && m.unresolved ? (m.unresolved.rules || []).slice() : null,
      scienceGaps: _scienceGapsFor(m),
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

  // ---------------------------------------------------------------------------------------------------------------------
  // T531: APPLICATION LIFECYCLE (behind NUMERIC_APPLY_ENABLED). The canonical progression application RECORD is the lifecycle record;
  // the overlay mirrors its state. Record + overlay + Monitor summary are ALWAYS committed together, in ONE transaction, by
  // _commitLifecycle (the only tx.set of this module) -- so "overlay written but record PENDING" and "record APPLIED but overlay missing"
  // cannot exist. Every transition is idempotent by a deterministic operationKey and re-verifies its guards INSIDE the transaction.
  //   PENDING -> APPLIED     applyOverlayTransaction       (flag on, activation guard, canary scope, exact context)
  //   APPLIED -> CONSUMED    consumeOverlayTransaction     (flag on; first PERSISTED working set of the exact PID exposure)
  //   APPLIED -> OVERRIDDEN  overrideOverlayTransaction    (exact Coach decision after APPLIED, before the target starts)
  //   APPLIED -> REVERTED    revertOverlayTransaction      (Coach, before the target starts, expectedRevision)
  //   APPLIED -> STALE       staleOverlayTransaction       (plan replaced / PID or target invalidated, before the target starts)
  // Override / revert / stale are allowed with the flag off: they are safety valves that can only REMOVE effect.
  // ---------------------------------------------------------------------------------------------------------------------
  function _shadow() { return _req ? _req('./progression-auto-apply-shadow.js') : (_root && _root.VDSEN_AUTO_APPLY_SHADOW) || null; }
  function _effective() { return _req ? _req('./progression-effective-prescription.js') : (_root && _root.VDSEN_EFFECTIVE_PRESCRIPTION) || null; }
  function _read(snap) { return snap && typeof snap.exists === 'function' && snap.exists() ? snap.data() : null; }
  function _fail(reason, extra) { return Object.assign({ written: false, reason: reason }, extra || {}); }

  async function _loadLifecycle(tx, refs, input, which) {
    var st = { meso: null, plan: null, client: null, coach: null };
    if (which.meso) st.meso = _read(await tx.get(refs.meso));
    if (which.plan && refs.plan) st.plan = _read(await tx.get(refs.plan));
    if (which.client && refs.client) st.client = _read(await tx.get(refs.client));
    if (which.coach && refs.coach) st.coach = _read(await tx.get(refs.coach));
    return st;
  }
  // The pair (record, overlay) an APPLIED-state transition operates on; null + reason when it is not exactly consistent.
  function _pair(meso, recordKey) {
    var record = meso && meso.progressionApplications && meso.progressionApplications[recordKey];
    if (!record) return { reason: BLOCKERS.NOT_CANONICAL_RECORD };
    var okey = record.lifecycle && record.lifecycle.overlayKey, overlay = okey && meso.nextExposureOverlays && meso.nextExposureOverlays[okey];
    return { record: record, overlay: overlay || null, okey: okey || null };
  }
  function _consistent(pair, state) {
    var r = pair.record, o = pair.overlay;
    return !!(o && r.state === state && o.status === state && o.sourceRecordKey === r.key && o.key === 'ovl_' + r.key && o.clientId === r.clientId && o.planId === r.planId &&
      o.prescriptionExerciseId === r.prescriptionExerciseId);
  }
  // Timestamps are always supplied by the caller (this module stays deterministic and never reads a clock).
  function _now(input, ctx) { return (input && input.now) || (ctx && ctx.now) || null; }

  // One atomic commit of record + overlay (+ summary mirrors). Idempotence and every guard are decided BEFORE this is called.
  function _lifecycleWrite(shadow, meso, key, record, overlayKey, overlay) {
    var records = Object.assign({}, meso.progressionApplications || {}); records[key] = record;
    var overlays = Object.assign({}, meso.nextExposureOverlays || {}); overlays[overlayKey] = overlay;
    return { records: records, overlays: overlays, summary: shadow.summarize(records, record.planId) };
  }
  function _commitLifecycle(tx, refs, w) {
    [[refs.meso, { progressionApplications: w.records, nextExposureOverlays: w.overlays, progressionApplicationSummary: w.summary }],
     [refs.root, { progressionApplicationSummary: w.summary }]].forEach(function(x) { if (x[0]) tx.set(x[0], x[1], { merge: true }); });
  }
  function _transition(shadow, pair, to, op, input, patch, overlayPatch, ctx) {
    var at = _now(input, ctx);
    var t = shadow.lifecycleTransition(pair.record, to, { expectedRevision: pair.record.revision, operationKey: op, at: at, actorId: input.actorId || null,
      reasonCode: input.reasonCode, patch: patch });
    if (!t.ok) return { fail: _fail(t.reasonCode) };
    return { record: t.record, overlay: Object.assign({}, pair.overlay, { status: to }, overlayPatch || {}) };
  }

  async function applyOverlayTransaction(tx, refs, input, guards) {
    if (!NUMERIC_APPLY_ENABLED) return { written: false, reason: BLOCKERS.NUMERIC_APPLY_DISABLED };
    guards = guards || {};
    if (guards.isCurrent && !guards.isCurrent()) return { written: false, reason: BLOCKERS.STALE_CALLBACK };
    var shadow = _shadow(), eff = _effective();
    if (!shadow || !eff) return _fail('LIFECYCLE_UNAVAILABLE');
    var st = await _loadLifecycle(tx, refs, input, { meso: true, plan: true, client: true, coach: true });
    var mesoSnapOk = !!st.meso, planOk = !!st.plan, clientOk = !!st.client;
    if (!mesoSnapOk || !planOk || !clientOk) return { written: false, reason: BLOCKERS.NOT_CANONICAL_RECORD };
    var meso = st.meso, record = (meso.progressionApplications || {})[input.recordKey];
    var op = record ? 'apply:' + record.key : null;
    if (record && op && (record.events || []).some(function(e) { return e.operationKey === op; })) return { written: false, idempotent: true, reason: BLOCKERS.ALREADY_RECORDED };
    var ic = input.context || {};
    // Canary scope: the Coach document is authoritative when supplied (re-read INSIDE the transaction); otherwise the caller's; absent = disabled.
    var scope = refs.coach ? (st.coach && st.coach.autoApplyCanary) : ic.canaryScope;
    var entries = meso.entries;
    var safety = ic.safetyConflict === true;
    if (!safety && record && record.source && record.nextExposure) safety = eff.painReportedBetween(entries, record.source, record.nextExposure);
    var decision = planApplication({ record: record, context: Object.assign({}, ic, {
      canaryScope: normalizeCanaryScope(scope), safetyConflict: safety,
      plan: st.plan, interventions: st.client.coachInterventions, entries: entries,
      existingOverlays: meso.nextExposureOverlays, activePlanId: st.client.activePlanId,
      transactionCurrent: guards.isCurrent ? guards.isCurrent() : true }) });
    if (!decision.canApply) return { written: false, reason: decision.blockers[0], decision: decision };
    if (input.expectedRevision !== undefined && record.revision !== input.expectedRevision) return { written: false, reason: BLOCKERS.REVISION_CONFLICT };
    var at = _now(input, ic);
    if (!at) return _fail('TIMESTAMP_MISSING');
    var overlay = Object.assign({}, decision.overlay, { status: 'APPLIED', appliedAt: at, operationKey: op });
    var t = shadow.lifecycleTransition(record, 'APPLIED', { expectedRevision: record.revision, operationKey: op, at: at, actorId: input.actorId || null,
      reasonCode: 'APPLIED_BY_POLICY', patch: { overlayKey: overlay.key, appliedAt: at, target: overlay.target,
        // self-contained audit facts for the Coach feed (before -> after, and the equipment resolution used)
        change: { dimension: overlay.dimension, previousValue: overlay.previousValue, appliedValue: overlay.appliedValue, unit: overlay.unit, ruleId: overlay.provenance && overlay.provenance.ruleId || null },
        equipment: overlay.equipmentId ? { equipmentId: overlay.equipmentId, roundingReason: overlay.roundingReason || null,
          source: overlay.equipmentSnapshot && overlay.equipmentSnapshot.source || null, scope: overlay.equipmentSnapshot && overlay.equipmentSnapshot.scope || null,
          revision: overlay.equipmentSnapshot ? overlay.equipmentSnapshot.revision : null } : null } });
    if (!t.ok) return _fail(t.reasonCode, { decision: decision });
    var w1 = _lifecycleWrite(shadow, meso, record.key, t.record, overlay.key, overlay);
    _commitLifecycle(tx, refs, w1);
    return { written: true, overlayKey: overlay.key, decision: decision, record: t.record, overlay: overlay, summary: w1.summary };
  }

  // APPLIED -> CONSUMED: only on persisted evidence (LOGS in the meso document, re-read inside the transaction), never on render.
  async function consumeOverlayTransaction(tx, refs, input, guards) {
    if (!NUMERIC_APPLY_ENABLED) return { written: false, reason: BLOCKERS.NUMERIC_APPLY_DISABLED };
    guards = guards || {};
    if (guards.isCurrent && !guards.isCurrent()) return { written: false, reason: BLOCKERS.STALE_CALLBACK };
    var shadow = _shadow(), eff = _effective();
    if (!shadow || !eff) return _fail('LIFECYCLE_UNAVAILABLE');
    var st = await _loadLifecycle(tx, refs, input, { meso: true });
    if (!st.meso) return { written: false, reason: BLOCKERS.NOT_CANONICAL_RECORD };
    var pair = _pair(st.meso, input.recordKey);
    if (!pair.record) return _fail(pair.reason);
    var r = pair.record, op = 'consume:' + r.key;
    if ((r.events || []).some(function(e) { return e.operationKey === op; })) return { written: false, idempotent: true, reason: 'ALREADY_CONSUMED' };
    if (r.clientId !== input.clientId || r.planId !== st.meso.planId) return _fail(r.clientId !== input.clientId ? BLOCKERS.CLIENT_MISMATCH : BLOCKERS.PLAN_MISMATCH);
    if (r.state !== 'APPLIED') return _fail('INVALID_TRANSITION');
    if (!_consistent(pair, 'APPLIED')) return _fail('RECORD_OVERLAY_INCONSISTENT');
    var tgt = pair.overlay.target, sh = input.shown || {};
    if (!eff.pidExposureStarted(st.meso.entries, r.prescriptionExerciseId, tgt.week, tgt.dayIndex)) return _fail('TARGET_NOT_STARTED');
    // what the athlete was actually shown must be this overlay (otherwise the overlay was NOT consumed)
    if (sh.provenance !== 'CANONICAL_OVERLAY' || sh.overlayKey !== pair.overlay.key || sh.appliedValue !== pair.overlay.appliedValue || sh.dimension !== pair.overlay.dimension) return _fail('OVERLAY_NOT_SHOWN');
    var at = _now(input, null);
    if (!at) return _fail('TIMESTAMP_MISSING');
    var shown = { provenance: sh.provenance, overlayKey: sh.overlayKey, dimension: sh.dimension, previousValue: pair.overlay.previousValue, appliedValue: sh.appliedValue, unit: pair.overlay.unit };
    var tr = _transition(shadow, pair, 'CONSUMED', op, Object.assign({}, input, { reasonCode: 'TARGET_STARTED' }), { consumedAt: at, shownPrescription: shown }, { consumedAt: at, shownPrescription: shown }, null);
    if (tr.fail) return tr.fail;
    var w2 = _lifecycleWrite(shadow, st.meso, r.key, tr.record, pair.overlay.key, tr.overlay);
    _commitLifecycle(tx, refs, w2);
    return { written: true, overlayKey: pair.overlay.key, record: tr.record, overlay: tr.overlay, summary: w2.summary };
  }

  // What a Coach decision / plan change would do to an APPLIED, not-yet-started overlay. Pure.
  function planLifecycleReconciliation(input) {
    input = input || {}; var eff = _effective(), o = input.overlay, r = input.record;
    if (!eff || !r || !o || r.state !== 'APPLIED' || o.status !== 'APPLIED') return { action: 'NONE', reason: 'NOT_APPLIED' };
    var t = o.target;
    if (eff.pidExposureStarted(input.entries, r.prescriptionExerciseId, t.week, t.dayIndex)) return { action: 'NONE', reason: 'TARGET_STARTED' };
    var ev = eff.evaluateOverlay({ clientId: r.clientId, planId: r.planId, activePlanId: input.activePlanId, pid: r.prescriptionExerciseId, week: t.week, dayIndex: t.dayIndex,
      records: { [r.key]: r }, overlays: { [o.key]: o }, interventions: input.interventions, plan: input.plan, entries: input.entries, safetyConflict: false });
    if (ev.usable) return { action: 'NONE', reason: null };
    if (ev.reason === 'COACH_OVERRIDE') return { action: 'OVERRIDE', reason: ev.reason };
    if (ev.reason === 'PLAN_MISMATCH' || ev.reason === 'TARGET_INVALIDATED') return { action: 'STALE', reason: ev.reason === 'PLAN_MISMATCH' ? 'PLAN_CHANGED' : ev.reason };
    return { action: 'NONE', reason: ev.reason };
  }
  function _latestDecision(interventions, record, from) {
    var best = null;
    (Array.isArray(interventions) ? interventions : []).forEach(function(iv) {
      if (!iv || iv.targetType !== 'EXERCISE' || iv.targetId !== record.prescriptionExerciseId || (iv.planId && iv.planId !== record.planId) || iv.action === 'NO_CHANGE') return;
      var t = _time(iv.decidedAt); if (t === null || from === null || t < from) return;
      if (!best || t > _time(best.decidedAt)) best = iv;
    });
    return best;
  }

  // Shared body of override / revert / stale: all require an APPLIED, consistent pair and a target that has NOT started.
  async function _removeEffectTransaction(tx, refs, input, guards, kind) {
    guards = guards || {};
    if (guards.isCurrent && !guards.isCurrent()) return { written: false, reason: BLOCKERS.STALE_CALLBACK };
    var shadow = _shadow(), eff = _effective();
    if (!shadow || !eff) return _fail('LIFECYCLE_UNAVAILABLE');
    var st = await _loadLifecycle(tx, refs, input, { meso: true, client: kind !== 'REVERT', plan: kind === 'STALE' });
    if (!st.meso) return { written: false, reason: BLOCKERS.NOT_CANONICAL_RECORD };
    var pair = _pair(st.meso, input.recordKey);
    if (!pair.record) return _fail(pair.reason);
    var r = pair.record, op = { OVERRIDE: 'override:', REVERT: 'revert:', STALE: 'stale:' }[kind] + r.key, to = { OVERRIDE: 'OVERRIDDEN', REVERT: 'REVERTED', STALE: 'STALE' }[kind];
    if ((r.events || []).some(function(e) { return e.operationKey === op; })) return { written: false, idempotent: true, reason: 'ALREADY_' + to };
    if (r.state !== 'APPLIED') return _fail('INVALID_TRANSITION');
    if (!_consistent(pair, 'APPLIED')) return _fail('RECORD_OVERLAY_INCONSISTENT');
    if (input.clientId !== undefined && r.clientId !== input.clientId) return _fail(BLOCKERS.CLIENT_MISMATCH);
    var t = pair.overlay.target;
    if (eff.pidExposureStarted(st.meso.entries, r.prescriptionExerciseId, t.week, t.dayIndex)) return _fail(BLOCKERS.TARGET_ALREADY_STARTED);
    var at = _now(input, null), patch, reason;
    if (!at) return _fail('TIMESTAMP_MISSING');
    if (kind === 'REVERT') {
      if (input.expectedRevision === undefined || r.revision !== input.expectedRevision) return _fail(BLOCKERS.REVISION_CONFLICT);
      if (input.overlayKey !== undefined && input.overlayKey !== pair.overlay.key) return _fail('RECORD_OVERLAY_INCONSISTENT');
      patch = { revertedAt: at }; reason = 'REVERTED_BY_COACH';
    } else if (kind === 'OVERRIDE') {
      var iv = _latestDecision(st.client && st.client.coachInterventions, r, _time(r.source && r.source.calculatedAt));
      if (!iv) return _fail('NO_COACH_DECISION');
      patch = { overriddenAt: at, intervention: { id: iv.id || null, action: iv.action || null, decidedAt: iv.decidedAt } }; reason = 'COACH_OVERRIDE';
    } else {
      var plan = st.plan, activePlanId = st.client && st.client.activePlanId;
      var rec = planLifecycleReconciliation({ record: r, overlay: pair.overlay, entries: st.meso.entries, activePlanId: activePlanId, plan: plan || {}, interventions: [] });
      if (rec.action !== 'STALE') return _fail('NOT_STALE');
      patch = { staleAt: at, staleReason: rec.reason }; reason = rec.reason;
    }
    var tr = _transition(shadow, pair, to, op, Object.assign({}, input, { reasonCode: reason }), patch, Object.keys(patch).reduce(function(o, k) { o[k] = patch[k]; return o; }, {}), null);
    if (tr.fail) return tr.fail;
    var w3 = _lifecycleWrite(shadow, st.meso, r.key, tr.record, pair.overlay.key, tr.overlay);
    _commitLifecycle(tx, refs, w3);
    return { written: true, overlayKey: pair.overlay.key, record: tr.record, overlay: tr.overlay, summary: w3.summary };
  }
  function overrideOverlayTransaction(tx, refs, input, guards) { return _removeEffectTransaction(tx, refs, input, guards, 'OVERRIDE'); }
  function revertOverlayTransaction(tx, refs, input, guards) { return _removeEffectTransaction(tx, refs, input, guards, 'REVERT'); }
  function staleOverlayTransaction(tx, refs, input, guards) { return _removeEffectTransaction(tx, refs, input, guards, 'STALE'); }

  return { NUMERIC_APPLY_ENABLED: NUMERIC_APPLY_ENABLED, SCHEMA: SCHEMA, BLOCKERS: BLOCKERS, GATES: GATES, PREVIEW_CLASSES: PREVIEW_CLASSES, GUARD_CHECKS: GUARD_CHECKS, verifyActivationPreconditions: verifyActivationPreconditions, ACTIVATION_PREREQUISITES: ACTIVATION_PREREQUISITES, normalizeCanaryScope: normalizeCanaryScope, inCanaryScope: inCanaryScope, overlayKey: overlayKey,
    targetStarted: targetStarted, planApplication: planApplication, planReversal: planReversal, applyOverlayTransaction: applyOverlayTransaction,
    consumeOverlayTransaction: consumeOverlayTransaction, overrideOverlayTransaction: overrideOverlayTransaction, revertOverlayTransaction: revertOverlayTransaction,
    staleOverlayTransaction: staleOverlayTransaction, planLifecycleReconciliation: planLifecycleReconciliation };
});
