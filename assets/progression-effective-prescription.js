/* T530: THE authority for the EFFECTIVE athlete prescription of one exact exposure (client + plan + PID + week + day).
 *   effective = base plan + eligible canonical overlay
 *   precedence: SAFETY > exact Coach target-exposure override > eligible canonical overlay > base plan
 * Pure. Never mutates its inputs, never reads legacy progrec, never uses names as identity, never touches LOGS values (it only asks
 * whether the exact PID exposure has started). With NUMERIC_APPLY_ENABLED=false the base plan is ALWAYS the effective prescription. */
(function(root, factory) {
  var api = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_EFFECTIVE_PRESCRIPTION = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(req, root) {
  'use strict';

  var NUMERIC_APPLY_ENABLED = false;
  var OVERLAY_SCHEMA = 'vdsen-next-exposure-overlay-v1';
  var PROVENANCE = Object.freeze({ BASE_PLAN: 'BASE_PLAN', CANONICAL_OVERLAY: 'CANONICAL_OVERLAY', COACH_OVERRIDE: 'COACH_OVERRIDE', SAFETY_FALLBACK: 'SAFETY_FALLBACK' });
  var LABEL = 'Autoajuste VDSEN';

  function _policy() {
    if (req) { try { return req('./progression-magnitude-policy.js'); } catch (e) { /* fall through */ } }
    return root && root.VDSEN_MAGNITUDE_POLICY || null;
  }
  function _time(v) { var t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; }
  function _num(v) { var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN); return Number.isFinite(n) ? n : null; }
  function _kind(x) { var p = _policy(); return p && p.explicitSetKind ? p.explicitSetKind(x) : null; }

  // TARGET EXPOSURE START (single definition): the first legitimate PERSISTED working-set execution of the exact PID in the exact
  // week/day = a done log entry for that PID that is not autofilled, not express / expressFinal and not an explicitly tagged warm-up / drop /
  // intensification set. Rendering or opening the page never counts.
  function pidExposureStarted(entries, pid, week, dayIndex) {
    if (!pid || !entries) return false;
    var re = new RegExp('^log_' + week + '_' + dayIndex + '_\\d+_s\\d+$');
    return Object.keys(entries).some(function(k) {
      var e = entries[k];
      return re.test(k) && e && typeof e === 'object' && e.prescriptionExerciseId === pid && e.done === true &&
        e.autoFilled !== true && e.express !== true && e.expressFinal !== true && !_kind(e);
    });
  }

  // SAFETY signal readable at any time from LOGS: an articular-pain report in a session strictly AFTER the source exposure and strictly
  // BEFORE the target exposure (same definition of pain as the magnitude policy evidence: postsession articular 'si' / articularPain.present).
  function painReportedBetween(entries, source, target) {
    if (!entries || !source || !target) return false;
    function after(w, d, a) { return w > a.week || (w === a.week && d > a.dayIndex); }
    return Object.keys(entries).some(function(k) {
      var m = /^postsession_(\d+)_(\d+)$/.exec(k), ps = entries[k];
      if (!m || !ps || typeof ps !== 'object') return false;
      var w = Number(m[1]), d = Number(m[2]);
      var pain = !!((ps.articularPain && ps.articularPain.present) || ps.articular === 'si');
      return pain && after(w, d, source) && after(target.week, target.dayIndex, { week: w, dayIndex: d });
    });
  }

  function _values(map) { return map && typeof map === 'object' ? Object.keys(map).map(function(k) { return map[k]; }) : []; }
  function _daysWithPid(plan, pid) {
    return (Array.isArray(plan && plan.days) ? plan.days : []).filter(function(d) { return (d.exercises || []).some(function(e) { return e.prescriptionExerciseId === pid; }); })
      .map(function(d) { return d.dayIndex; }).filter(Number.isInteger).sort(function(a, b) { return a - b; });
  }
  function _nextExposure(plan, pid, week, day) {
    var days = _daysWithPid(plan, pid), last = Number(plan && plan.weeks);
    if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(last)) return null;
    for (var w = week; w <= last; w++) for (var i = 0; i < days.length; i++) if (w > week || days[i] > day) return { week: w, dayIndex: days[i] };
    return null;
  }

  // -> { usable, reason, provenance, overlay, record, state }   (pure decision; no flag: the flag is applied by resolveEffective)
  function evaluateOverlay(input) {
    input = input || {};
    var pid = input.pid, week = input.week, day = input.dayIndex;
    function no(reason, prov, extra) { return Object.assign({ usable: false, reason: reason, provenance: prov || PROVENANCE.BASE_PLAN, overlay: null, record: null, state: null }, extra || {}); }
    if (!input.clientId || !input.planId || !pid || !Number.isInteger(week) || !Number.isInteger(day)) return no('IDENTITY_MISSING');
    var found = _values(input.overlays).filter(function(o) {
      return o && o.schema === OVERLAY_SCHEMA && o.clientId === input.clientId && o.planId === input.planId && o.prescriptionExerciseId === pid &&
        o.target && o.target.week === week && o.target.dayIndex === day;
    });
    if (!found.length) return no('NO_OVERLAY');
    if (found.length > 1) return no('AMBIGUOUS_OVERLAYS');
    var o = found[0], r = input.records && input.records[o.sourceRecordKey];
    if (!r) return no('RECORD_MISSING');
    if (r.key !== o.sourceRecordKey || r.clientId !== o.clientId || r.planId !== o.planId || r.prescriptionExerciseId !== o.prescriptionExerciseId ||
        o.key !== 'ovl_' + r.key || !r.lifecycle || r.lifecycle.overlayKey !== o.key) return no('RECORD_OVERLAY_INCONSISTENT');
    if (r.state !== 'APPLIED' && r.state !== 'CONSUMED') return no('OVERLAY_' + r.state, PROVENANCE.BASE_PLAN, { state: r.state });
    if (o.status !== r.state) return no('RECORD_OVERLAY_INCONSISTENT');
    if (input.planId !== input.activePlanId) return no('PLAN_MISMATCH');
    var ok = { usable: true, reason: null, provenance: PROVENANCE.CANONICAL_OVERLAY, overlay: o, record: r, state: r.state };
    if (input.safetyConflict === true || painReportedBetween(input.entries, r.source, o.target)) return no('SAFETY_CONFLICT', PROVENANCE.SAFETY_FALLBACK, { state: r.state });
    // A started exposure keeps the prescription it started with: no retroactive override/stale.
    if (r.state === 'CONSUMED' || pidExposureStarted(input.entries, pid, week, day)) return ok;
    // Any exact Coach decision since the source calculation counts: the apply gate refused every decision it could SEE at commit, so a
    // decision visible now was necessarily written after the commit (independent of clock skew between devices).
    var calcAt = _time(r.source && r.source.calculatedAt), from = calcAt;
    var overridden = (Array.isArray(input.interventions) ? input.interventions : []).some(function(iv) {
      return iv && iv.targetType === 'EXERCISE' && iv.targetId === pid && (!iv.planId || iv.planId === input.planId) && _time(iv.decidedAt) !== null &&
        from !== null && _time(iv.decidedAt) >= from && iv.action !== 'NO_CHANGE';
    });
    if (overridden) return no('COACH_OVERRIDE', PROVENANCE.COACH_OVERRIDE, { state: r.state });
    var plan = input.plan || {}, planAt = _time(plan.updatedAt), t = _nextExposure(plan, pid, r.source && r.source.week, r.source && r.source.dayIndex);
    var targetDay = (Array.isArray(plan.days) ? plan.days : []).filter(function(d) { return d.dayIndex === day; })[0];
    var inTarget = ((targetDay && targetDay.exercises) || []).filter(function(e) { return e.prescriptionExerciseId === pid; });
    if (planAt === null || calcAt === null || planAt > calcAt || inTarget.length !== 1 || !t || t.week !== week || t.dayIndex !== day) return no('TARGET_INVALIDATED', PROVENANCE.BASE_PLAN, { state: r.state });
    return ok;
  }

  function _fmt(n) { return String(Number(n)); }
  function _presentation(o) {
    var unit = o.dimension === 'LOAD' ? (String(o.unit).toUpperCase() === 'LB' ? 'lb' : 'kg') : o.dimension === 'REPS' ? 'reps' : 's';
    return { label: LABEL, text: _fmt(o.previousValue) + ' → ' + _fmt(o.appliedValue) + ' ' + unit };
  }
  function _copy(s) { return Object.assign({}, s); }
  // Explicitly tagged warm-up / drop / intensification sets keep their base values (the overlay adjusts the STANDARD working sets).
  function _adjust(baseSets, o) {
    return (Array.isArray(baseSets) ? baseSets : []).map(function(bs) {
      var base = _copy(bs), eff = _copy(bs), adjusted = false;
      if (!_kind(bs)) {
        if (o.dimension === 'LOAD') { eff.load = o.appliedValue; adjusted = true; }
        else if (o.dimension === 'REST') { eff.restSeconds = o.appliedValue; adjusted = true; }
        else if (o.dimension === 'REPS' && _num(bs.repsTarget) !== null) { eff.repsTarget = o.appliedValue; adjusted = true; }
      }
      return { base: base, effective: eff, adjusted: adjusted };
    });
  }

  // Effective prescription for one exposure. input = evaluateOverlay input + { baseSets, unit (current display unit, for LOAD) }.
  function resolveEffective(input) {
    input = input || {};
    var baseSets = Array.isArray(input.baseSets) ? input.baseSets : [];
    function base(reason, prov, extra) {
      return Object.assign({ provenance: prov || PROVENANCE.BASE_PLAN, reason: reason, overlayKey: null, dimension: null, previousValue: null, appliedValue: null, unit: null, presentation: null,
        sets: baseSets.map(function(s) { return { base: _copy(s), effective: _copy(s), adjusted: false }; }) }, extra || {});
    }
    if (!NUMERIC_APPLY_ENABLED) return base('NUMERIC_APPLY_DISABLED');
    var ev = evaluateOverlay(input);
    if (!ev.usable) return base(ev.reason, ev.provenance);
    var o = ev.overlay;
    if (o.dimension === 'LOAD' && input.unit && String(input.unit).toUpperCase() !== String(o.unit).toUpperCase()) return base('UNIT_MISMATCH');
    return { provenance: PROVENANCE.CANONICAL_OVERLAY, reason: null, overlayKey: o.key, state: ev.state, dimension: o.dimension, previousValue: o.previousValue, appliedValue: o.appliedValue,
      unit: o.unit, presentation: _presentation(o), sets: _adjust(baseSets, o) };
  }

  return { NUMERIC_APPLY_ENABLED: NUMERIC_APPLY_ENABLED, OVERLAY_SCHEMA: OVERLAY_SCHEMA, PROVENANCE: PROVENANCE, LABEL: LABEL,
    pidExposureStarted: pidExposureStarted, painReportedBetween: painReportedBetween, evaluateOverlay: evaluateOverlay, resolveEffective: resolveEffective };
});
