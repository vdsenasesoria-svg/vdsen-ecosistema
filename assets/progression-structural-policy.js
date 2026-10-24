/* T586: STRUCTURAL / FATIGUE rules of the autonomous progression (sets, load reductions, freeze, deload) + muscle-priority differentiation.
 * Pure: no I/O, no clocks. Called by the magnitude policy (ONE engine, one candidate per exposure); it never applies anything.
 *
 * SOURCE OF EVERY RULE: the VDSEN v3.1 progression algorithm that already ships in the athlete app (`calculateProgression` / `_computeDeloadTriggers`) and the
 * MEV/MRV table of the VDSEN compendium (Module 2.1) that the same app embeds. Nothing here is a new physiological rule and there is no generic percentage per category:
 *   DELOAD        >= 2 fatigue signals (WHO-5 < 52, session RPE > 9, sleep < 6 h, HRV down >= 15 %, energy <= 3)  ->  sets = max(1, round(sets / 2)), load x 0.90
 *   LOAD DOWN     average ICS < 6 -> x 0.85 ; average ICS < 7 -> x 0.90
 *   REDUCE SETS   post-session EIMD = 3 (veto)  ->  sets - 1 (minimum 1)
 *   ADD SET       performance sustained vs the previous comparable exposure AND average ICS >= 8 AND sets < max sets AND weekly muscle volume + 1 <= ceiling   ->  sets + 1
 *   (precedence: deload > technique > soreness > effort (freeze / x0.95) > add set; the effort rules outrank adding volume: deliberate, conservative refinement of v3.1)
 *   FREEZE LOAD   a set reached RIR 0 outside the +-1 band, or effort harder than prescribed (average RIR - target < -1)  ->  hold the load
 *   LOAD DOWN x0.95  the SAME "harder than prescribed" condition at two consecutive comparable exposures
 * MUSCLE PRIORITY (declared by the Coach in the initial prescription; unclassified or legacy plans are NEVER classified here): the ONLY thing priority changes is the
 * volume ceiling for ADD SET, taken from the same MEV/MRV table (the app's own comment: "optimal hypertrophy volume = midpoint"):
 *   PRIORITARIO -> up to MRV     NO_PRIORITARIO -> up to the MEV/MRV midpoint     (no declared class -> MRV, exactly as before)
 * Priority never overrides a safety condition (pain, deload, ICS, EIMD) and never changes a percentage. Volume counts ONLY the exercise's declared primary muscle
 * (no secondary counting), so a multi-joint exercise is never counted several times as a prime mover.
 * Not covered because no VDSEN rule defines it (reported, never guessed): reps regression, regression magnitude after one hard exposure beyond the v3.1 numbers,
 * volume redistribution BETWEEN muscles under fatigue, RIR-target adaptation outside a plan-declared `rirByWeek`. */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_STRUCTURAL_POLICY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var MODEL = 'vdsen-structural-v1';
  var PRIORITY = Object.freeze({ PRIORITARIO: 'PRIORITARIO', NO_PRIORITARIO: 'NO_PRIORITARIO' });
  // Same values as MEV_MRV_BY_MUSCLE in vdsen-cliente.html (parity enforced by tests/t586-structural-policy.test.js).
  var MEV_MRV = Object.freeze({
    pectoral: { mev: 10, mrv: 22 }, dorsal_ancho: { mev: 10, mrv: 20 }, trapecio_medio: { mev: 8, mrv: 18 }, delt_anterior: { mev: 0, mrv: 12 },
    delt_lateral: { mev: 8, mrv: 20 }, delt_posterior: { mev: 8, mrv: 18 }, biceps: { mev: 8, mrv: 18 }, braquial: { mev: 4, mrv: 12 }, triceps: { mev: 8, mrv: 18 },
    cuadriceps: { mev: 10, mrv: 20 }, isquios: { mev: 8, mrv: 16 }, gluteo_mayor: { mev: 8, mrv: 20 }, gluteo_medio: { mev: 4, mrv: 12 },
    gastrocnemio: { mev: 8, mrv: 16 }, soleo: { mev: 8, mrv: 16 }, erectores: { mev: 4, mrv: 12 }, recto_abdominal: { mev: 6, mrv: 16 },
    oblicuos: { mev: 4, mrv: 12 }, serrato: { mev: 0, mrv: 8 }
  });
  var FATIGUE = Object.freeze({ WHO5_MIN: 52, RPE_MAX: 9, SLEEP_MIN: 6, HRV_DROP: 0.85, ENERGY_MAX: 3, TRIGGERS_FOR_DELOAD: 2 });
  var FACTOR = Object.freeze({ DELOAD_LOAD: 0.9, ICS_LT6: 0.85, ICS_LT7: 0.9, HARD_TWICE: 0.95 });
  var DEFAULT_MAX_SETS = 4;   // uncatalogued exercise: the app's own conservative cap

  function _num(v) { if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function _clean(n) { return Math.round(n * 1e6) / 1e6; }
  function _avg(a) { return a.length ? a.reduce(function(x, y) { return x + y; }, 0) / a.length : null; }
  function _grain(unit) { return unit === 'LB' ? 1 : 0.5; }   // same advisory grain as resolveAdvisoryLoad (equipment-independent)
  function _round(v, unit) { var g = _grain(unit); return _clean(Math.round(v / g) * g); }

  // Fatigue signals. Auto-closed / partial post-sessions carry DEFAULTS the athlete never entered (eimd 2, sleep 7, rpe 7): they are missing evidence, never evidence.
  function _realPost(post) { return post && typeof post === 'object' && post.autoClosed !== true && post.partial !== true ? post : null; }
  function fatigueSignals(post, ci, prevCi) {
    var p = _realPost(post), c = ci && typeof ci === 'object' ? ci : {}, prev = prevCi && typeof prevCi === 'object' ? prevCi : {}, t = [];
    var who5 = _num(c.who5); if (who5 !== null && who5 > 0 && who5 < FATIGUE.WHO5_MIN) t.push('WHO5_LOW');
    var rpe = p ? _num(p.rpeAverage) : null; if (rpe !== null && rpe > FATIGUE.RPE_MAX) t.push('RPE_HIGH');
    var sleep = p ? _num(p.sleepHours) : null; if (sleep !== null && sleep > 0 && sleep < FATIGUE.SLEEP_MIN) t.push('SLEEP_LOW');
    var hrv = _num(c.hrv), hrvPrev = _num(prev.hrv); if (hrv !== null && hrvPrev !== null && hrvPrev > 0 && hrv < hrvPrev * FATIGUE.HRV_DROP) t.push('HRV_DOWN');
    var en = _num(c.energia); if (en !== null && en > 0 && en <= FATIGUE.ENERGY_MAX) t.push('ENERGY_LOW');
    return { triggers: t, isDeload: t.length >= FATIGUE.TRIGGERS_FOR_DELOAD };
  }
  function _eimd(post) { var p = _realPost(post), v = p ? _num(p.eimd) : null; return v !== null && v >= 1 && v <= 3 ? v : null; }

  function _maxSets(fatigueCost) {
    var fc = _num(fatigueCost); if (fc === null) return DEFAULT_MAX_SETS;
    return fc >= 5 ? 3 : fc >= 4 ? 4 : fc >= 3 ? 5 : 6;
  }
  // Set-level metrics of ONE exposure (standard working sets already selected by the caller).
  function metrics(exposure) {
    var sets = (exposure && exposure.sets) || [];
    var ics = sets.map(function(s) { return _num(s.ics); }).filter(function(v) { return v !== null && v > 0; });
    var rir = sets.map(function(s) { return _num(s.rirReal); }).filter(function(v) { return v !== null && v >= 0 && v <= 5; });
    var reps = sets.map(function(s) { return _num(s.reps) || 0; }), loads = sets.map(function(s) { return _num(s.load) || 0; });
    return { n: sets.length, avgICS: _avg(ics), avgRIR: _avg(rir), minRIR: rir.length ? Math.min.apply(null, rir) : null, validRir: rir,
      avgReps: _avg(reps), avgLoad: _avg(loads), unit: exposure && exposure.unit || null };
  }
  function _targetRir(exposure, prescription) {
    var v = (exposure.sets || []).map(function(s) { return _num(s.rirPrescribed); }).filter(function(x) { return x !== null; });
    if (v.length) return v[v.length - 1];
    var ps = (prescription && prescription.sets) || [], last = ps[ps.length - 1];
    return last ? _num(last.rirTarget) : null;
  }
  // Lowest repetition count the prescription accepts: the range minimum, else the smallest per-set target.
  function _repsFloor(prescription) {
    var r = prescription && prescription.repsRange; if (r && _num(r.min) !== null) return _num(r.min);
    var ts = ((prescription && prescription.sets) || []).map(function(s) { return _num(s && s.repsTarget); }).filter(function(x) { return x !== null; });
    return ts.length ? Math.min.apply(null, ts) : null;
  }
  function _repsTarget(prescription) {
    var r = prescription && prescription.repsRange; if (r && _num(r.max) !== null) return _num(r.max);
    var ts = ((prescription && prescription.sets) || []).map(function(s) { return _num(s && s.repsTarget); }).filter(function(x) { return x !== null; });
    return ts.length ? Math.max.apply(null, ts) : null;
  }

  // Weekly volume of ONE primary muscle for `week`: executed standard working sets of each exercise declaring it; an exercise with none executed yet counts its prescribed
  // sets (the app's own proxy). `carried` = { pid: sets } overrides the prescribed count with the carried (already applied) set count.
  function weeklyVolume(plan, entries, week, muscle, carried) {
    if (!muscle) return null;
    var total = 0;
    (Array.isArray(plan && plan.days) ? plan.days : []).forEach(function(d) {
      (d.exercises || []).forEach(function(e, ei) {
        if (e.muscleGroup !== muscle) return;
        var done = 0;
        Object.keys(entries || {}).forEach(function(k) {
          var m = /^log_(\d+)_(\d+)_(\d+)_s\d+$/.exec(k), x = entries[k];
          if (m && Number(m[1]) === week && Number(m[2]) === d.dayIndex && x && x.done === true && x.autoFilled !== true && x.express !== true && x.expressFinal !== true &&
              (!e.prescriptionExerciseId || x.prescriptionExerciseId === e.prescriptionExerciseId)) done++;
        });
        var planned = carried && e.prescriptionExerciseId && Number.isInteger(carried[e.prescriptionExerciseId]) ? carried[e.prescriptionExerciseId] : (e.sets || []).length;
        total += done > 0 ? done : planned;
      });
    });
    return total;
  }
  function priorityOf(plan, muscle) {
    var p = plan && plan.musclePriorities;
    if (!muscle || !p || typeof p !== 'object') return null;
    if (Array.isArray(p.PRIORITARIO) && p.PRIORITARIO.indexOf(muscle) >= 0) return PRIORITY.PRIORITARIO;
    if (Array.isArray(p.NO_PRIORITARIO) && p.NO_PRIORITARIO.indexOf(muscle) >= 0) return PRIORITY.NO_PRIORITARIO;
    return null;
  }
  // Volume ceiling for ADD SET: from the MEV/MRV table only. null = no muscle declared (or unknown key) -> no muscle check, as the app does for an uncatalogued exercise.
  function volumeCeiling(muscle, priority) {
    var t = muscle && MEV_MRV[muscle]; if (!t) return null;
    return priority === PRIORITY.NO_PRIORITARIO ? Math.floor((t.mev + t.mrv) / 2) : t.mrv;
  }

  function _decision(kind, ruleId, dimension, direction, safety, candidate, evidence, extra) {
    return Object.assign({ model: MODEL, kind: kind, ruleId: ruleId, dimension: dimension, direction: direction, safety: safety === true, candidate: candidate, evidence: evidence }, extra || {});
  }

  // input: { prescription:{sets,repsRange,muscleGroup,fatigueCost}, latest, prior, comparableCount, context:{post, ci, prevCi, plan, volume, priority} } -> decision | null.
  // `latest`/`prior` = comparable exposures ({week,dayIndex,sets,unit}); sets are the executed STANDARD working sets in setIndex order.
  function evaluate(input) {
    input = input || {};
    var latest = input.latest, prior = input.prior, rx = input.prescription || {}, ctx = input.context || {};
    if (!latest || !latest.sets || !latest.sets.length) return null;
    var m = metrics(latest), pm = prior ? metrics(prior) : null, unit = m.unit;
    if (m.n < 1) return null;
    var signals = fatigueSignals(ctx.post, ctx.ci, ctx.prevCi);
    var evidence = { model: MODEL, workingSets: m.n, avgICS: m.avgICS, avgRIR: m.avgRIR, avgLoad: m.avgLoad, unit: unit, week: latest.week, dayIndex: latest.dayIndex, fatigueTriggers: signals.triggers };

    // 1) DELOAD (>= 2 fatigue signals): fatigue outranks everything, and priority never overrides it.
    if (signals.isDeload) {
      var load = m.avgLoad, loadNew = load && load > 0 && (unit === 'KG' || unit === 'LB') ? _round(load * FACTOR.DELOAD_LOAD, unit) : null;
      var setsNew = Math.max(1, Math.round(m.n / 2));
      var comp = { SETS: setsNew }; if (loadNew !== null && loadNew < load) comp.LOAD = loadNew;
      var rbw = ctx.plan && ctx.plan.rirByWeek, tgt = ctx.targetWeek, rirT = rbw && tgt !== undefined ? _num(rbw[tgt] !== undefined ? rbw[tgt] : rbw[String(tgt)]) : null;
      if (rirT !== null) comp.RIR = rirT;
      return _decision('DELOAD', 'S-DELOAD', 'DELOAD', 'DOWN', true,
        { dimension: 'DELOAD', ruleId: 'S-DELOAD', previousValue: m.n, rawCandidate: setsNew, finalCandidate: setsNew, components: comp, previousLoad: load, factors: { load: FACTOR.DELOAD_LOAD, sets: 0.5 }, blockers: [] }, evidence, { minExposures: 1 });
    }
    // 2) technique: very low / low ICS -> load down (average ICS of the exposure; absent ICS never triggers).
    if (m.avgICS !== null && m.avgICS < 7 && m.avgLoad && m.avgLoad > 0) {
      var f = m.avgICS < 6 ? FACTOR.ICS_LT6 : FACTOR.ICS_LT7;
      return _decision('LOAD_DOWN', m.avgICS < 6 ? 'S-ICS-LT6' : 'S-ICS-LT7', 'LOAD', 'DOWN', true,
        { dimension: 'LOAD', ruleId: m.avgICS < 6 ? 'S-ICS-LT6' : 'S-ICS-LT7', unitPct: -(1 - f) * 100, previousValue: m.avgLoad, rawCandidate: _clean(m.avgLoad * f), finalCandidate: null, blockers: [] }, evidence, { minExposures: 1 });
    }
    // 3) muscle soreness veto: EIMD 3 -> one set less (never below 1).
    if (_eimd(ctx.post) === 3 && m.n > 1) {
      return _decision('REDUCE_SETS', 'S-EIMD3', 'SETS', 'DOWN', true,
        { dimension: 'SETS', ruleId: 'S-EIMD3', previousValue: m.n, rawCandidate: m.n - 1, finalCandidate: m.n - 1, blockers: [] }, evidence, { minExposures: 1 });
    }
    var muscle = typeof rx.muscleGroup === 'string' && MEV_MRV[rx.muscleGroup] ? rx.muscleGroup : null, priority = ctx.priority || null;
    var maxSets = _maxSets(rx.fatigueCost), ceiling = volumeCeiling(muscle, priority), vol = ctx.volume === undefined ? null : ctx.volume;
    var volumeInfo = { muscle: muscle, priority: priority, weekly: vol, ceiling: ceiling };
    // 4) effort rules (v3.1 averages and +-1 band): a set at RIR 0 outside the band, or effort harder than prescribed. DELIBERATE, conservative refinement of v3.1: these outrank adding
    //    volume (v3.1 would still add a set when the athlete is already working harder than prescribed; adding stimulus there is not justified).
    var rirObj = _targetRir(latest, rx);
    if (m.avgRIR !== null && rirObj !== null) {
      var withinBand = m.validRir.filter(function(v) { return Math.abs(v - rirObj) <= 1; }).length;
      var zeroFalse = m.minRIR === 0 && m.validRir.length > 0 && withinBand < m.validRir.length;
      var err = m.avgRIR - rirObj, matchBand = Math.abs(err) <= 1;
      if (zeroFalse) {
        return _decision('FREEZE_LOAD', 'S-FREEZE-ZERO', 'FREEZE', 'HOLD', true,
          { dimension: 'FREEZE', ruleId: 'S-FREEZE-ZERO', previousValue: m.avgLoad, rawCandidate: m.avgLoad, finalCandidate: m.avgLoad, blockers: [] }, evidence, { minExposures: 1, volume: volumeInfo });
      }
      if (!matchBand && err < 0) {
        var pRir = pm && pm.avgRIR !== null ? pm.avgRIR : null, pObj = prior ? _targetRir(prior, rx) : null;
        var priorHard = pRir !== null && pObj !== null && (pRir - pObj) < -1;
        if (priorHard && m.avgLoad && m.avgLoad > 0) {
          return _decision('LOAD_DOWN', 'S-HARD-TWICE', 'LOAD', 'DOWN', true,
            { dimension: 'LOAD', ruleId: 'S-HARD-TWICE', unitPct: -(1 - FACTOR.HARD_TWICE) * 100, previousValue: m.avgLoad, rawCandidate: _clean(m.avgLoad * FACTOR.HARD_TWICE), finalCandidate: null, blockers: [] }, evidence, { minExposures: 2 });
        }
        return _decision('FREEZE_LOAD', 'S-FREEZE-HARD', 'FREEZE', 'HOLD', true,
          { dimension: 'FREEZE', ruleId: 'S-FREEZE-HARD', previousValue: m.avgLoad, rawCandidate: m.avgLoad, finalCandidate: m.avgLoad, blockers: [] }, evidence, { minExposures: 1, volume: volumeInfo });
      }
    }
    // 5) add one set (performance-driven, never EIMD-driven). Needs a previous comparable exposure (the progression-direction evidence rule).
    var performedWell = false;
    if (pm && pm.avgReps > 0) {
      var repsHeld = m.avgReps >= pm.avgReps - 0.5;
      var rirHeld = pm.avgRIR === null ? true : (m.avgRIR !== null && m.avgRIR <= pm.avgRIR + 0.5);
      var loadHeld = m.avgLoad >= pm.avgLoad * 0.98;
      performedWell = repsHeld && rirHeld && loadHeld;
    }
    var volumeBlocked = ceiling !== null && vol !== null && vol + 1 > ceiling;
    // Conservative refinement of v3.1 (which compares only against the previous exposure): no volume is added while the prescribed repetitions are NOT being completed (that is rule C /
    // E territory: rest or review, never more stimulus).
    var repsFloor = _repsFloor(rx), repsOk = repsFloor === null || (m.avgReps !== null && m.avgReps >= repsFloor);
    if (pm && performedWell && repsOk && m.avgICS !== null && m.avgICS >= 8 && m.n < maxSets && !volumeBlocked) {
      return _decision('ADD_SETS', 'S-ADD', 'SETS', 'UP', false,
        { dimension: 'SETS', ruleId: 'S-ADD', previousValue: m.n, rawCandidate: m.n + 1, finalCandidate: m.n + 1, blockers: [] },
        Object.assign({}, evidence, { maxSets: maxSets }), { minExposures: 2, volume: { muscle: muscle, priority: priority, weekly: vol, ceiling: ceiling } });
    }
    return null;
  }

  return { MODEL: MODEL, PRIORITY: PRIORITY, MEV_MRV: MEV_MRV, FATIGUE: FATIGUE, FACTOR: FACTOR, DEFAULT_MAX_SETS: DEFAULT_MAX_SETS,
    fatigueSignals: fatigueSignals, metrics: metrics, weeklyVolume: weeklyVolume, priorityOf: priorityOf, volumeCeiling: volumeCeiling, evaluate: evaluate };
});
