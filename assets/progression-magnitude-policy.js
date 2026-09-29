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
 * Rule D  RIR harder than prescribed: per missing RIR -> -1 rep OR -2.5% load (alternatives).
 * Rule E  reps incomplete: per missing rep -> -2 reps OR -5% load (alternatives).
 * Load-vs-reps for D/E and the D+E / A+E / C+E collisions have no deterministic VDSEN
 * precedence in the source: they stay POLICY_BRANCH_REQUIRES_RESOLUTION. Equipment
 * increments have no contract: raw load candidates never get a finalCandidate.
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
  var EVIDENCE_BASIS = 'LAST_SET_CURRENT_RUNTIME_HEURISTIC';
  // T505: science/product gaps the repository does NOT settle (searched: docs/CONTEXTO_GENERADOR.md,
  // docs/CONTEXTO_MAESTRO.md, references/*). "Double progression: reps first, then load" (CONTEXTO_GENERADOR §8) governs
  // progression UP (Rule A) and does not select between reps and load for the D/E adjustments. Each gap keeps an explicit
  // code and must be closed by a director decision before NUMERIC_APPLY_ENABLED may ever be true.
  var SCIENCE_GAPS = Object.freeze([
    Object.freeze({ id: 'RULE_D_E_ALTERNATIVE_NOT_DEFINED', rules: ['D', 'E'], surfacesAs: 'POLICY_BRANCH_REQUIRES_RESOLUTION',
      question: 'When reps fall short and/or RIR is harder than prescribed: reduce reps or reduce load?' }),
    Object.freeze({ id: 'RULE_C_E_PRECEDENCE_NOT_DEFINED', rules: ['C', 'E'], surfacesAs: 'collision.classification=AMBIGUOUS',
      question: 'Correct RIR with incomplete reps: rest first (C) and E after, or E first as the runtime evaluates it?' }),
    Object.freeze({ id: 'REPRESENTATIVE_SET_NOT_DEFINED', rules: ['A', 'C', 'D', 'E'], surfacesAs: 'evidence.basis=' + EVIDENCE_BASIS,
      question: 'Which set represents an exposure: last set (current runtime heuristic), average, or the set with the worst signal?' })
  ]);
  var PCT = Object.freeze({ A_LOAD: 2.5, D_LOAD: 2.5, E_LOAD: 5 });
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
    NUMERIC_ACTIVATION_DISABLED: 'NUMERIC_ACTIVATION_DISABLED',
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
      evidence: null, candidates: [], unresolved: null, collision: null, coachReview: [],
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
        ts: e.ts });
    });
    Object.keys(groups).forEach(function(k) {
      groups[k].sets.sort(function(a, b) { return a.setIndex - b.setIndex; });
      out.push(groups[k]);
    });
    out.sort(function(a, b) { return a.week - b.week || a.dayIndex - b.dayIndex; });
    return out;
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
      var sets = (x.sets || []), real = [], sawAuto = false, sawExpress = false;
      sets.forEach(function(s) {
        if (!s || s.done !== true) return;
        if (s.autoFilled === true) { sawAuto = true; return; }
        if (s.express === true) { sawExpress = true; return; }
        var reps = _num(s.reps);
        if (reps === null || reps <= 0) return;
        real.push(s);
      });
      if (!real.length) return drop(sawAuto ? REASONS.AUTOFILLED_EVIDENCE : sawExpress ? REASONS.EXPRESS_EVIDENCE : REASONS.INVALID_EVIDENCE);
      var last = real[real.length - 1], ts = _time(last.ts);
      if (planEdit !== null && (ts === null || ts < planEdit)) return drop(REASONS.PRESCRIPTION_CHANGED);
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
    var sets = exposure.sets, last = sets[sets.length - 1], presSets = (prescription && prescription.sets) || [];
    var presLast = presSets[Math.min(last.setIndex, presSets.length - 1)] || presSets[presSets.length - 1] || {};
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

    // ── Decision set: last executed set of the latest exposure (same basis as Modulo D). ──
    var sets = latest.sets, last = sets[sets.length - 1];
    var presSets = input.prescription.sets || [];
    var presLast = presSets[Math.min(last.setIndex, presSets.length - 1)] || presSets[presSets.length - 1] || {};
    var repsTarget = _num(presLast.repsTarget);
    var repsTargets = sets.map(function(s) {
      var p = presSets[Math.min(s.setIndex, presSets.length - 1)]; return p ? _num(p.repsTarget) : null;
    });
    var reps = _num(last.reps), load = _num(last.load), unit = latest.unit;
    var rirTarget = _num(last.rirPrescribed); if (rirTarget === null) rirTarget = _num(presLast.rirTarget);
    var rirReal = _num(last.rirReal);
    var range = _repRange(input.prescription);
    res.evidence = { basis: EVIDENCE_BASIS, week: latest.week, dayIndex: latest.dayIndex, setIndex: last.setIndex,
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

    function unresolved(rules, collisionClass, runtimeOrder, candidates) {
      res.candidates = candidates;
      res.unresolved = { code: REASONS.POLICY_BRANCH_REQUIRES_RESOLUTION, rules: rules };
      res.reasonCodes.push(REASONS.POLICY_BRANCH_REQUIRES_RESOLUTION);
      if (collisionClass) res.collision = { rules: rules, classification: collisionClass, runtimeOrder: runtimeOrder };
      res.ruleId = rules.join('+');
    }
    function eCandidates() {
      return [_repsCandidate('E', repsTarget, -2 * missingReps, range), _loadCandidate('E', load, PCT.E_LOAD * missingReps, -1)];
    }
    function dCandidates() {
      var d = Math.abs(rirDiff);
      return [_repsCandidate('D', repsTarget, -d, range), _loadCandidate('D', load, PCT.D_LOAD * d, -1)];
    }

    if (cls === 'C') {
      // C vs E: the source text makes rest the FIRST intervention; the runtime Modulo D
      // evaluates E first. No deterministic combination is authorized.
      res.ruleId = 'C'; res.dimension = 'REST';
      var restNow = _num(presLast.restSeconds);
      res.candidates = [{ dimension: 'REST', ruleId: 'C', deltaSeconds: REST_INCREMENT_SECONDS, previousValue: restNow,
        rawCandidate: restNow === null ? null : restNow + REST_INCREMENT_SECONDS,
        finalCandidate: restNow === null ? null : restNow + REST_INCREMENT_SECONDS, boundState: null,
        blockers: restNow === null ? [REASONS.NO_REST_BASE] : [] }];
      res.collision = { rules: ['C', 'E'], classification: PRECEDENCE.AMBIGUOUS, runtimeOrder: 'E_BEFORE_C',
        deferredRule: 'E', note: 'C recorded as first intervention; E not combined automatically' };
    } else if (cls === 'D+E') {
      unresolved(['D', 'E'], PRECEDENCE.CURRENT_RUNTIME_HEURISTIC, 'E_BEFORE_D', dCandidates().concat(eCandidates()));
    } else if (cls === 'A+E') {
      unresolved(['A', 'E'], PRECEDENCE.AMBIGUOUS, 'E_BEFORE_A', eCandidates());
    } else if (cls === 'E') {
      unresolved(['E'], null, null, eCandidates());
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
      unresolved(['D'], null, null, dCandidates());
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
    if (prior && (direction === 'UP' || direction === 'DOWN' || direction === 'REST')) {
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
    } else if (direction === 'UP' || direction === 'DOWN' || direction === 'REST') {
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
    EVIDENCE_BASIS: EVIDENCE_BASIS, SCIENCE_GAPS: SCIENCE_GAPS, PCT: PCT, REST_INCREMENT_SECONDS: REST_INCREMENT_SECONDS,
    extractExposures: extractExposures, evaluate: evaluate, reject: reject, compact: compact };
});
