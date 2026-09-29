/* Phase 2A: Ehrenstein/APEKS-derived micro-adjustment MAGNITUDE policy — SHADOW ONLY.
 * Pure: no I/O, no Firestore, no DOM, no clocks. It never applies anything: every decision
 * carries numericApplyAllowed=false. Rule shapes follow the VDSEN v4.2 "Motor de
 * micro-ajuste Ehrenstein" contract; the numeric magnitudes are coaching heuristics
 * (level C), not universal scientific rules.
 *
 * Rule A  RIR easier than prescribed: per +1 RIR -> target RIR 1: +1 rep (inside range);
 *         target RIR >= 2: +2.5% load.
 * Rule B  +2 reps over target in both of the last 2 sets -> COACH_REVIEW_VOLUME_INCREASE only.
 * Rule C  RIR correct but reps incomplete -> +30 s rest (first intervention).
 * Rule D  RIR harder than prescribed.
 * Rule E  reps incomplete.
 *
 * T523 VDSEN PRODUCT POLICY (director decisions; NOT scientific claims, NOT an Ehrenstein rule):
 *   D and E  -> COACH_REVIEW_REQUIRED only. No source establishes a safe automatic regression magnitude, so the system
 *               never automatically reduces load, target reps, sets or RIR (no numeric candidate).
 *   C then E -> the FIRST comparable occurrence of C (RIR correct, reps incomplete) yields REST +30 s only; if the same
 *               condition persists at the NEXT comparable exposure, E is reached and, by the rule above, goes to
 *               COACH_REVIEW_REQUIRED. Never a double automatic intervention.
 *   Representative set = the LAST valid WORKING set of the exposure (warm-ups, autofilled, express and planned drop
 *               sets excluded; nothing substituted). Provenance VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET.
 * Rule A and Rule C (first occurrence) are independent of these review branches. Equipment increments have no
 * contract here: raw load candidates never get a finalCandidate.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_MAGNITUDE_POLICY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var PROVENANCE = Object.freeze({
    methodologyFamily: 'EHRENSTEIN_APEKS_DERIVED',
    ruleAuthority: 'VDSEN_HEURISTIC',
    evidenceLevel: 'C'
  });
  var MIN_COMPARABLE_EXPOSURES = 2;
  var NUMERIC_APPLY_ENABLED = false;
  var EVIDENCE_BASIS = 'VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET';
  // T523: the three formerly open decisions are now CLOSED VDSEN PRODUCT POLICY (director decisions). They are product choices,
  // never scientific claims. The historical gap ids are kept only as provenance.
  var PRODUCT_POLICIES = Object.freeze([
    Object.freeze({ id: 'RULE_D_E_COACH_REVIEW_ONLY', resolves: 'RULE_D_E_ALTERNATIVE_NOT_DEFINED', rules: ['D', 'E'], source: 'VDSEN_PRODUCT_POLICY', scientificClaim: false,
      behavior: 'D and E never produce a numeric candidate; the state is COACH_REVIEW_REQUIRED.' }),
    Object.freeze({ id: 'RULE_C_THEN_E_COACH_REVIEW', resolves: 'RULE_C_E_PRECEDENCE_NOT_DEFINED', rules: ['C', 'E'], source: 'VDSEN_PRODUCT_POLICY', scientificClaim: false,
      behavior: 'First comparable C -> REST +30 s only; the same condition at the next comparable exposure -> COACH_REVIEW_REQUIRED.' }),
    Object.freeze({ id: 'REPRESENTATIVE_SET_LAST_STANDARD_WORKING_SET', resolves: 'REPRESENTATIVE_SET_NOT_DEFINED', rules: ['A', 'C', 'D', 'E'], source: 'VDSEN_PRODUCT_POLICY', scientificClaim: false,
      provenance: EVIDENCE_BASIS, behavior: 'The last valid executed working set of the exposure represents it.' })
  ]);
  // Genuinely UNKNOWN science branches would be listed here (and block with SCIENCE_POLICY_UNRESOLVED). None remain.
  var SCIENCE_GAPS = Object.freeze([]);
  var REVIEW_POLICY = 'VDSEN_PRODUCT_POLICY_COACH_REVIEW_ONLY';
  var PCT = Object.freeze({ A_LOAD: 2.5 }); // D/E have NO automatic magnitude (T523)
  var REST_INCREMENT_SECONDS = 30;

  var REASONS = Object.freeze({
    IDENTITY_CONFLICT: 'IDENTITY_CONFLICT', STALE: 'STALE', COACH_OVERRIDE: 'COACH_OVERRIDE',
    READINESS_VETO: 'READINESS_VETO', INSUFFICIENT_COMPARABLE_EXPOSURES: 'INSUFFICIENT_COMPARABLE_EXPOSURES',
    PID_MISMATCH: 'PID_MISMATCH', PLAN_MISMATCH: 'PLAN_MISMATCH', CLIENT_MISMATCH: 'CLIENT_MISMATCH',
    AUTOFILLED_EVIDENCE: 'AUTOFILLED_EVIDENCE', EXPRESS_EVIDENCE: 'EXPRESS_EVIDENCE',
    INVALID_EVIDENCE: 'INVALID_EVIDENCE', UNIT_MISMATCH: 'UNIT_MISMATCH',
    PRESCRIPTION_CHANGED: 'PRESCRIPTION_CHANGED', TARGET_NOT_NUMERIC: 'TARGET_NOT_NUMERIC',
    RIR_EVIDENCE_MISSING: 'RIR_EVIDENCE_MISSING', RULE_A_TARGET_RIR_UNDEFINED: 'RULE_A_TARGET_RIR_UNDEFINED',
    POLICY_BRANCH_REQUIRES_RESOLUTION: 'POLICY_BRANCH_REQUIRES_RESOLUTION',
    EQUIPMENT_INCREMENT_POLICY_MISSING: 'EQUIPMENT_INCREMENT_POLICY_MISSING',
    REP_RANGE_UPPER_BOUND: 'REP_RANGE_UPPER_BOUND', REP_RANGE_LOWER_BOUND: 'REP_RANGE_LOWER_BOUND',
    NO_LOAD_BASE: 'NO_LOAD_BASE', NO_REST_BASE: 'NO_REST_BASE', NO_ADJUSTMENT_NEEDED: 'NO_ADJUSTMENT_NEEDED',
    NUMERIC_ACTIVATION_DISABLED: 'NUMERIC_ACTIVATION_DISABLED', COACH_REVIEW_REQUIRED: 'COACH_REVIEW_REQUIRED', NO_WORKING_SET: 'NO_WORKING_SET',
    COACH_REVIEW_VOLUME_INCREASE: 'COACH_REVIEW_VOLUME_INCREASE',
    CONFLICTING_DIRECTION_ACROSS_EXPOSURES: 'CONFLICTING_DIRECTION_ACROSS_EXPOSURES',
    DIRECTION_NOT_CONFIRMED_BY_PRIOR_EXPOSURE: 'DIRECTION_NOT_CONFIRMED_BY_PRIOR_EXPOSURE',
    SAFETY_CONFLICT: 'SAFETY_CONFLICT'
  });
  var PRECEDENCE = Object.freeze({
    EXPLICIT_VDSEN_PRECEDENCE: 'EXPLICIT_VDSEN_PRECEDENCE',
    CURRENT_RUNTIME_HEURISTIC: 'CURRENT_RUNTIME_HEURISTIC',
    AMBIGUOUS: 'AMBIGUOUS'
  });

  function _num(value) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  // Floating-point hygiene only (100 * 1.025 -> 102.49999999999999); NOT equipment rounding.
  function _clean(n) { return Math.round(n * 1e6) / 1e6; }
  function _time(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { var t = Date.parse(value); return Number.isFinite(t) ? t : null; }
    return null;
  }

  function _base(pid, extra) {
    return Object.assign({
      schema: 'vdsen-magnitude-shadow-v1', mode: 'SHADOW',
      methodologyFamily: PROVENANCE.methodologyFamily, ruleAuthority: PROVENANCE.ruleAuthority,
      evidenceLevel: PROVENANCE.evidenceLevel, prescriptionExerciseId: pid || null,
      eligible: false, actionable: false, ruleId: null, dimension: null,
      evidence: null, candidates: [], unresolved: null, coachReviewRequired: null, collision: null, coachReview: [],
      comparableExposureCount: 0, comparableExposures: [], excludedExposures: [],
      reasonCodes: [], activationBlockers: [REASONS.NUMERIC_ACTIVATION_DISABLED],
      numericApplyAllowed: false, applied: false
    }, extra || {});
  }
  function reject(pid, reasonCode) {
    return _base(pid, { reasonCodes: [reasonCode] });
  }

  // ── Evidence extraction from executed LOGS entries (identity is the snapshotted PID,
  //    never the position index: POSITION != IDENTITY). ─────────────────────────────
  function extractExposures(entries, pid, scope) {
    var groups = {}, out = [];
    if (!pid || !entries) return out;
    Object.keys(entries).forEach(function(key) {
      var m = /^log_(\d+)_(\d+)_(\d+)_s(\d+)$/.exec(key);
      var e = entries[key];
      if (!m || !e || typeof e !== 'object' || e.prescriptionExerciseId !== pid) return;
      var gk = m[1] + '_' + m[2] + '_' + m[3];
      var ps = entries['postsession_' + m[1] + '_' + m[2]];
      var pain = !!(ps && ((ps.articularPain && ps.articularPain.present) || ps.articular === 'si'));
      var g = groups[gk] || (groups[gk] = { week: Number(m[1]), dayIndex: Number(m[2]), exerciseIndex: Number(m[3]),
        prescriptionExerciseId: pid, planId: scope && scope.planId, clientId: scope && scope.clientId, sets: [], painFlag: pain });
      g.sets.push({ setIndex: Number(m[4]), load: e.carga, reps: e.reps, unit: e.unit, done: e.done === true,
        rirPrescribed: e.rir, rirReal: e.rir_real, autoFilled: e.autoFilled === true, express: e.express === true,
        warmup: e.warmup === true || e.isWarmup === true, drop: e.drop === true || e.isDrop === true || e.isDropSet === true || e.dropSet === true,
        intensification: e.intensification === true || e.isIntensification === true, setType: typeof e.setType === 'string' ? e.setType : undefined, ts: e.ts });
    });
    Object.keys(groups).forEach(function(k) {
      groups[k].sets.sort(function(a, b) { return a.setIndex - b.setIndex; });
      out.push(groups[k]);
    });
    out.sort(function(a, b) { return a.week - b.week || a.dayIndex - b.dayIndex; });
    return out;
  }

  // T528: a STANDARD WORKING set is an executed set that is not explicitly tagged as a warm-up, a planned drop set or another
  // intensification set. ONLY explicit tags/structure classify (boolean flags or an exact setType token); a load decrease, a label or
  // a name never does. Excluded sets stay legitimate training work (LOGS/volume) -- they are excluded from representative selection only.
  var NON_STANDARD_TYPES = Object.freeze({ warmup: 'WARMUP', warm_up: 'WARMUP', 'warm-up': 'WARMUP', 'drop-set': 'DROP_SET', drop: 'DROP_SET', dropset: 'DROP_SET', drop_set: 'DROP_SET', intensification: 'INTENSIFICATION' });
  function _explicitKind(x) {
    if (!x || typeof x !== 'object') return null;
    if (x.warmup === true || x.isWarmup === true) return 'WARMUP';
    if (x.drop === true || x.isDrop === true || x.isDropSet === true || x.dropSet === true) return 'DROP_SET';
    if (x.intensification === true || x.isIntensification === true) return 'INTENSIFICATION';
    var t = x.setType !== undefined ? x.setType : x.type;
    return typeof t === 'string' && Object.prototype.hasOwnProperty.call(NON_STANDARD_TYPES, t) ? NON_STANDARD_TYPES[t] : null;   // exact token, no normalization
  }
  function _isWorkingSet(s, prescription) {
    if (!s || _explicitKind(s)) return false;
    var ps = prescription && Array.isArray(prescription.sets) ? prescription.sets[s.setIndex] : null;
    return !_explicitKind(ps);
  }

  // T523/T528: THE representative-set authority. Every canonical consumer selects the exposure representative
  // set here: the LAST valid executed STANDARD working set, in the canonical (setIndex) order. Provenance
  // VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET -- a product heuristic, not scientific consensus. exposure.sets are already working sets.
  function selectRepresentativeSet(exposure, prescription) {
    var sets = exposure && Array.isArray(exposure.sets) ? exposure.sets.filter(function(s) { return _isWorkingSet(s, prescription); }) : [];
    if (!sets.length) return null;
    // canonical order = ascending setIndex (stable), independent of the order the evidence arrives in
    sets = sets.map(function(s, i) { return [s, i]; }).sort(function(a, b) { return (_num(a[0].setIndex) - _num(b[0].setIndex)) || (a[1] - b[1]); }).map(function(x) { return x[0]; });
    var set = sets[sets.length - 1], presSets = (prescription && prescription.sets) || [];
    var presSet = presSets[Math.min(set.setIndex, presSets.length - 1)] || presSets[presSets.length - 1] || {};
    return { set: set, presSet: presSet, workingSets: sets, provenance: EVIDENCE_BASIS };
  }

  // Comparable exposure = same client/plan/PID, real (done, not autoFilled, not express)
  // executed sets with numeric reps, one load unit, and executed after the last plan edit.
  function _comparable(exposures, input) {
    var kept = [], excluded = [], pid = input.prescriptionExerciseId;
    var planEdit = _time(input.plan && input.plan.updatedAt);
    (Array.isArray(exposures) ? exposures : []).forEach(function(x) {
      var tag = { week: x && x.week, dayIndex: x && x.dayIndex };
      function drop(reason) { excluded.push(Object.assign(tag, { reason: reason })); }
      if (!x || x.prescriptionExerciseId !== pid) return drop(REASONS.PID_MISMATCH);
      if (x.planId !== undefined && input.planId && x.planId !== input.planId) return drop(REASONS.PLAN_MISMATCH);
      if (x.clientId !== undefined && input.clientId && x.clientId !== input.clientId) return drop(REASONS.CLIENT_MISMATCH);
      var sets = (x.sets || []), real = [], sawAuto = false, sawExpress = false, sawNonWorking = false;
      sets.forEach(function(s) {
        if (!s || s.done !== true) return;
        if (s.autoFilled === true) { sawAuto = true; return; }
        if (s.express === true) { sawExpress = true; return; }
        if (!_isWorkingSet(s, input.prescription)) { sawNonWorking = true; return; }
        var reps = _num(s.reps);
        if (reps === null || reps <= 0) return;
        real.push(s);
      });
      if (!real.length) return drop(sawAuto ? REASONS.AUTOFILLED_EVIDENCE : sawExpress ? REASONS.EXPRESS_EVIDENCE : sawNonWorking ? REASONS.NO_WORKING_SET : REASONS.INVALID_EVIDENCE);
      var last = selectRepresentativeSet({ sets: real }, input.prescription).set, ts = _time(last.ts);
      if (planEdit !== null && (ts === null || ts < planEdit)) return drop(REASONS.PRESCRIPTION_CHANGED);
      real = selectRepresentativeSet({ sets: real }, input.prescription).workingSets; // canonical setIndex order
      kept.push({ week: x.week, dayIndex: x.dayIndex, sets: real, unit: String(last.unit || 'KG').toUpperCase(), painFlag: x.painFlag === true });
    });
    var latestUnit = kept.length ? kept[kept.length - 1].unit : null;
    var finalKept = kept.filter(function(x) {
      if (x.unit === latestUnit) return true;
      excluded.push({ week: x.week, dayIndex: x.dayIndex, reason: REASONS.UNIT_MISMATCH });
      return false;
    });
    return { kept: finalKept, excluded: excluded };
  }

  function _repRange(prescription) {
    var r = prescription && prescription.repsRange;
    if (r && _num(r.min) !== null && _num(r.max) !== null) return { min: _num(r.min), max: _num(r.max) };
    var targets = ((prescription && prescription.sets) || []).map(function(s) { return _num(s && s.repsTarget); })
      .filter(function(n) { return n !== null; });
    return targets.length ? { min: Math.min.apply(null, targets), max: Math.max.apply(null, targets) } : null;
  }

  function _loadCandidate(ruleId, load, pct, sign) {
    var blockers = [REASONS.EQUIPMENT_INCREMENT_POLICY_MISSING];
    if (load === null || load <= 0) blockers = [REASONS.NO_LOAD_BASE];
    return { dimension: 'LOAD', ruleId: ruleId, unitPct: sign * pct, previousValue: load,
      rawCandidate: (load === null || load <= 0) ? null : _clean(load + load * sign * pct / 100),
      finalCandidate: null, boundState: null, blockers: blockers };
  }
  function _repsCandidate(ruleId, target, delta, range) {
    var raw = target + delta, bound = null, blockers = [];
    if (range && raw > range.max) { bound = REASONS.REP_RANGE_UPPER_BOUND; blockers.push(bound); }
    if (range && raw < range.min) { bound = REASONS.REP_RANGE_LOWER_BOUND; blockers.push(bound); }
    if (!range) blockers.push(REASONS.TARGET_NOT_NUMERIC);
    return { dimension: 'REPS', ruleId: ruleId, delta: delta, previousValue: target, rawCandidate: raw,
      finalCandidate: blockers.length ? null : raw, boundState: bound, blockers: blockers };
  }

  function _volumeReview(sets, repsTargets) {
    if (sets.length < 2) return null;
    var last2 = sets.slice(-2);
    var over = last2.filter(function(s, i) {
      var idx = sets.length - 2 + i, t = repsTargets[idx];
      return t !== null && t !== undefined && _num(s.reps) >= t + 2;
    });
    if (over.length < 2) return null;
    return { code: REASONS.COACH_REVIEW_VOLUME_INCREASE, ruleId: 'B', ruleAuthority: PROVENANCE.ruleAuthority,
      autoApplyAllowed: false, evidence: { lastSets: last2.map(function(s) { return { setIndex: s.setIndex, reps: _num(s.reps) }; }) } };
  }

  // ── One classification of the executed evidence into a source rule (A/C/D/E and collisions). It is the
  // single place the branching lives; evaluate() builds candidates from it and the direction check
  // reuses it for the previous exposure. ────────────────────────────────────────────────────────────
  function _classify(reps, repsTarget, rirReal, rirTarget) {
    var haveRir = rirReal !== null && rirTarget !== null, diff = haveRir ? rirReal - rirTarget : null;
    if (reps < repsTarget) {
      if (haveRir && diff === 0) return 'C';
      if (haveRir && diff < 0) return 'D+E';
      if (haveRir && diff > 0) return 'A+E';
      return 'E';
    }
    if (!haveRir) return 'NO_RIR';
    if (diff > 0) return rirTarget >= 1 ? 'A' : 'A_TARGET_RIR_UNDEFINED';
    if (diff < 0) return 'D';
    return 'MAINTAIN';
  }
  var DIRECTION = { A: 'UP', C: 'REST', D: 'DOWN', E: 'DOWN', 'D+E': 'DOWN', MAINTAIN: 'HOLD' };
  function _directionOf(rule) { return DIRECTION[rule] || 'UNKNOWN'; }
  // Decision-set values of an exposure (last executed set, same basis as the latest).
  function _decisionSet(exposure, prescription) {
    var rep = selectRepresentativeSet(exposure, prescription), last = rep.set, presLast = rep.presSet;
    var rirTarget = _num(last.rirPrescribed); if (rirTarget === null) rirTarget = _num(presLast.rirTarget);
    return { reps: _num(last.reps), repsTarget: _num(presLast.repsTarget), rirReal: _num(last.rirReal), rirTarget: rirTarget };
  }

  function evaluate(input) {
    input = input || {};
    var pid = input.prescriptionExerciseId || null, ctx = input.context || {};
    if (!pid || !input.prescription ||
        (input.prescription.prescriptionExerciseId && input.prescription.prescriptionExerciseId !== pid))
      return reject(pid, REASONS.IDENTITY_CONFLICT);
    if (ctx.identityConflict) return reject(pid, REASONS.IDENTITY_CONFLICT);
    if (ctx.stale) return reject(pid, REASONS.STALE);
    if (ctx.coachOverride) return reject(pid, REASONS.COACH_OVERRIDE);

    var cmp = _comparable(input.exposures, input);
    var res = _base(pid, {
      comparableExposureCount: cmp.kept.length,
      comparableExposures: cmp.kept.map(function(x) { return { week: x.week, dayIndex: x.dayIndex }; }),
      excludedExposures: cmp.excluded
    });
    var latest = cmp.kept[cmp.kept.length - 1];
    if (!latest) { res.reasonCodes.push(REASONS.INSUFFICIENT_COMPARABLE_EXPOSURES); return res; }

    // ── Decision set: the LAST valid working set of the latest exposure (T523 product policy). ──
    var repSet = selectRepresentativeSet(latest, input.prescription), sets = repSet.workingSets, last = repSet.set;
    var presSets = input.prescription.sets || [];
    var presLast = repSet.presSet;
    var repsTarget = _num(presLast.repsTarget);
    var repsTargets = sets.map(function(s) {
      var p = presSets[Math.min(s.setIndex, presSets.length - 1)]; return p ? _num(p.repsTarget) : null;
    });
    var reps = _num(last.reps), load = _num(last.load), unit = latest.unit;
    var rirTarget = _num(last.rirPrescribed); if (rirTarget === null) rirTarget = _num(presLast.rirTarget);
    var rirReal = _num(last.rirReal);
    var range = _repRange(input.prescription);
    res.evidence = { basis: EVIDENCE_BASIS, workingSetCount: sets.length, week: latest.week, dayIndex: latest.dayIndex, setIndex: last.setIndex,
      rirPrescribed: rirTarget, rirObserved: rirReal, repsTarget: repsTarget, repsExecuted: reps,
      load: load, unit: unit, repRange: range };
    res.coachReview = repsTarget === null ? [] : [_volumeReview(sets, repsTargets)].filter(Boolean);
    res.reasonCodes.push(REASONS.NUMERIC_ACTIVATION_DISABLED);

    if (repsTarget === null) { res.reasonCodes.push(REASONS.TARGET_NOT_NUMERIC); return res; }
    var threshold = cmp.kept.length >= MIN_COMPARABLE_EXPOSURES;
    if (!threshold) res.reasonCodes.push(REASONS.INSUFFICIENT_COMPARABLE_EXPOSURES);
    if (ctx.readinessVeto) { res.reasonCodes.push(REASONS.READINESS_VETO); threshold = false; }
    var prior = cmp.kept.length >= 2 ? cmp.kept[cmp.kept.length - 2] : null;
    if (prior) res.previousExposure = { week: prior.week, dayIndex: prior.dayIndex };

    var missingReps = repsTarget - reps;
    var haveRir = rirReal !== null && rirTarget !== null;
    var rirDiff = haveRir ? rirReal - rirTarget : null;
    var cls = _classify(reps, repsTarget, rirReal, rirTarget);

    // T523: previous COMPARABLE exposure's classification (same representative-set authority). "Comparable" is guaranteed by
    // cmp.kept: stale / excluded / non-comparable exposures never count as persistence.
    var priorCls = null;
    if (prior) {
      var pds = _decisionSet(prior, input.prescription);
      priorCls = (pds.reps === null || pds.repsTarget === null) ? null : _classify(pds.reps, pds.repsTarget, pds.rirReal, pds.rirTarget);
    }
    function review(branch, reason) {
      res.ruleId = branch; res.dimension = null; res.candidates = [];
      res.coachReviewRequired = { code: REASONS.COACH_REVIEW_REQUIRED, branch: branch, reason: reason, policy: REVIEW_POLICY, scientificClaim: false,
        observed: { repsExecuted: reps, rirObserved: rirReal }, prescribed: { repsTarget: repsTarget, rirTarget: rirTarget },
        sourceExposure: { week: latest.week, dayIndex: latest.dayIndex }, previousExposure: prior ? { week: prior.week, dayIndex: prior.dayIndex } : null };
      res.reasonCodes.push(REASONS.COACH_REVIEW_REQUIRED);
    }

    if (cls === 'C') {
      if (priorCls === 'C') {
        // Persistent C: E is reached, and E is Coach review only. No second automatic intervention.
        review('C+E', 'C_PERSISTS_AT_NEXT_COMPARABLE_EXPOSURE');
        res.collision = { rules: ['C', 'E'], classification: PRECEDENCE.EXPLICIT_VDSEN_PRECEDENCE, order: 'C_THEN_E', policy: 'VDSEN_PRODUCT_POLICY' };
      } else {
        // First comparable occurrence: REST +30 s ONLY (E is not applied simultaneously).
        res.ruleId = 'C'; res.dimension = 'REST';
        var restNow = _num(presLast.restSeconds);
        res.candidates = [{ dimension: 'REST', ruleId: 'C', deltaSeconds: REST_INCREMENT_SECONDS, previousValue: restNow,
          rawCandidate: restNow === null ? null : restNow + REST_INCREMENT_SECONDS,
          finalCandidate: restNow === null ? null : restNow + REST_INCREMENT_SECONDS, boundState: null,
          blockers: restNow === null ? [REASONS.NO_REST_BASE] : [] }];
        res.collision = { rules: ['C', 'E'], classification: PRECEDENCE.EXPLICIT_VDSEN_PRECEDENCE, order: 'C_FIRST_THEN_E_IF_PERSISTS', deferredRule: 'E', policy: 'VDSEN_PRODUCT_POLICY' };
      }
    } else if (cls === 'D+E') {
      review('D+E', 'REPS_INCOMPLETE_AND_EFFORT_HARDER_THAN_PRESCRIBED');
    } else if (cls === 'A+E') {
      review('A+E', 'REPS_INCOMPLETE_WITH_EASIER_EFFORT_THAN_PRESCRIBED');
    } else if (cls === 'E') {
      review('E', 'REPS_INCOMPLETE_WITHOUT_RIR_EVIDENCE');
    } else if (cls === 'NO_RIR') {
      res.reasonCodes.push(REASONS.RIR_EVIDENCE_MISSING);
      return res;
    } else if (cls === 'A') {
      res.ruleId = 'A';
      if (rirTarget >= 2) {
        res.dimension = 'LOAD';
        res.candidates = [_loadCandidate('A', load, PCT.A_LOAD * rirDiff, 1)];
      } else {
        res.dimension = 'REPS';
        res.candidates = [_repsCandidate('A', repsTarget, rirDiff, range)];
      }
    } else if (cls === 'A_TARGET_RIR_UNDEFINED') {
      res.ruleId = 'A';
      res.reasonCodes.push(REASONS.RULE_A_TARGET_RIR_UNDEFINED);
      res.reasonCodes.push(REASONS.POLICY_BRANCH_REQUIRES_RESOLUTION);
      res.unresolved = { code: REASONS.POLICY_BRANCH_REQUIRES_RESOLUTION, rules: ['A'] };
    } else if (cls === 'D') {
      review('D', 'EFFORT_HARDER_THAN_PRESCRIBED');
    } else {
      res.ruleId = 'MAINTAIN';
      res.reasonCodes.push(REASONS.NO_ADJUSTMENT_NEEDED);
    }

    var blocked = res.candidates.some(function(c) { return c.blockers.some(function(b) {
      return b === REASONS.REP_RANGE_UPPER_BOUND || b === REASONS.REP_RANGE_LOWER_BOUND ||
        b === REASONS.TARGET_NOT_NUMERIC || b === REASONS.NO_LOAD_BASE || b === REASONS.NO_REST_BASE; }); });
    res.candidates.forEach(function(c) {
      c.blockers.forEach(function(b) { if (res.reasonCodes.indexOf(b) < 0) res.reasonCodes.push(b); });
    });
    // eligible = evidence threshold met AND one deterministic rule outcome with a candidate AND the direction
    // is confirmed by the previous comparable exposure AND no safety conflict. One unusually good/bad
    // session never becomes structural authority; conflicting evidence goes to review, never to apply.
    var direction = _directionOf(cls);
    res.direction = direction;
    res.directionConsistency = 'NOT_APPLICABLE';
    var painFlagged = cmp.kept.slice(-2).some(function(x) { return x.painFlag === true; });
    if (ctx.safetyConflict === true || painFlagged) {
      res.reasonCodes.push(REASONS.SAFETY_CONFLICT); threshold = false;
    }
    if (res.coachReviewRequired) {
      res.directionConsistency = 'NOT_APPLICABLE'; // a review state is not an action: no confirmation needed
    } else if (prior && (direction === 'UP' || direction === 'DOWN')) {
      var ps = _decisionSet(prior, input.prescription);
      var priorDirection = (ps.reps === null || ps.repsTarget === null) ? 'UNKNOWN' : _directionOf(_classify(ps.reps, ps.repsTarget, ps.rirReal, ps.rirTarget));
      res.previousExposureSignal = priorDirection;
      if (priorDirection === direction) res.directionConsistency = 'CONSISTENT';
      else if ((direction === 'UP' && priorDirection === 'DOWN') || (direction === 'DOWN' && priorDirection === 'UP')) {
        res.directionConsistency = 'CONFLICTING'; res.reasonCodes.push(REASONS.CONFLICTING_DIRECTION_ACROSS_EXPOSURES);
        res.review = { code: REASONS.CONFLICTING_DIRECTION_ACROSS_EXPOSURES, exposures: [res.previousExposure, { week: latest.week, dayIndex: latest.dayIndex }] };
      } else {
        res.directionConsistency = 'UNCONFIRMED'; res.reasonCodes.push(REASONS.DIRECTION_NOT_CONFIRMED_BY_PRIOR_EXPOSURE);
      }
    } else if (direction === 'UP' || direction === 'DOWN') {
      res.directionConsistency = 'UNCONFIRMED';
    }
    var directionOk = res.directionConsistency === 'CONSISTENT' || res.directionConsistency === 'NOT_APPLICABLE';
    res.eligible = threshold && directionOk && !res.unresolved && res.candidates.length > 0 && !blocked;
    res.actionable = NUMERIC_APPLY_ENABLED && res.eligible &&
      res.candidates.every(function(c) { return c.finalCandidate !== null; });
    return res;
  }

  // Compact projection stored in the Monitor summary (bounded size).
  function compact(decision) {
    if (!decision) return null;
    var primary = decision.candidates && decision.candidates[0];
    return { mode: decision.mode, eligible: !!decision.eligible, ruleId: decision.ruleId,
      dimension: decision.dimension, methodologyFamily: decision.methodologyFamily,
      ruleAuthority: decision.ruleAuthority, evidenceLevel: decision.evidenceLevel,
      comparableExposureCount: decision.comparableExposureCount,
      unresolved: decision.unresolved ? decision.unresolved.code : null,
      direction: decision.direction || null, directionConsistency: decision.directionConsistency || null,
      review: decision.review ? decision.review.code : null,
      coachReviewRequired: decision.coachReviewRequired ? { code: decision.coachReviewRequired.code, branch: decision.coachReviewRequired.branch, reason: decision.coachReviewRequired.reason,
        policy: decision.coachReviewRequired.policy, observed: decision.coachReviewRequired.observed, prescribed: decision.coachReviewRequired.prescribed,
        sourceExposure: decision.coachReviewRequired.sourceExposure, previousExposure: decision.coachReviewRequired.previousExposure } : null,
      candidates: (decision.candidates || []).map(function(c) {
        return { dimension: c.dimension, ruleId: c.ruleId, rawCandidate: c.rawCandidate,
          finalCandidate: c.finalCandidate, deltaSeconds: c.deltaSeconds === undefined ? null : c.deltaSeconds,
          blockers: c.blockers }; }),
      evidence: decision.evidence ? { basis: decision.evidence.basis, rirPrescribed: decision.evidence.rirPrescribed,
        rirObserved: decision.evidence.rirObserved, repsTarget: decision.evidence.repsTarget,
        repsExecuted: decision.evidence.repsExecuted, load: decision.evidence.load, unit: decision.evidence.unit } : null,
      activationBlockers: decision.activationBlockers || [],
      coachReview: (decision.coachReview || []).map(function(r) { return r.code; }),
      reasonCodes: decision.reasonCodes, numericApplyAllowed: false, applied: false,
      primaryRaw: primary ? primary.rawCandidate : null };
  }

  return { PROVENANCE: PROVENANCE, REASONS: REASONS, PRECEDENCE: PRECEDENCE,
    NUMERIC_APPLY_ENABLED: NUMERIC_APPLY_ENABLED, MIN_COMPARABLE_EXPOSURES: MIN_COMPARABLE_EXPOSURES,
    EVIDENCE_BASIS: EVIDENCE_BASIS, SCIENCE_GAPS: SCIENCE_GAPS, PRODUCT_POLICIES: PRODUCT_POLICIES, REVIEW_POLICY: REVIEW_POLICY, selectRepresentativeSet: selectRepresentativeSet, explicitSetKind: _explicitKind, PCT: PCT, REST_INCREMENT_SECONDS: REST_INCREMENT_SECONDS,
    extractExposures: extractExposures, evaluate: evaluate, reject: reject, compact: compact };
});
