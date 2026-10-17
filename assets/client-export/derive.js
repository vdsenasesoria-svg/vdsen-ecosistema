/* VDSEN client export — DERIVED ANALYTICS. Deterministic functions of the normalized model; they NEVER mutate it and NEVER replace raw
 * history. Every output block carries `derived: true` and the formulas/denominators used. Missing inputs yield null / structured
 * ADHERENCE_INSUFFICIENT_DATA — values are never fabricated.
 */
(function(root, factory) {
  var api = factory(typeof require === 'function' && typeof module === 'object' ? require('./util.js') : root.VDSEN_CE_UTIL);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_DERIVE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(U) {
  'use strict';

  var FORMULAS = {
    observed_set: 'exercise log with done === true and NOT a synthetic Express set (Express S1..S(n-1) carry prescribed, not observed, values)',
    volume_load: 'sum(load * reps) over observed sets with numeric load and reps, kept per unit (kg / lb are never mixed or converted)',
    average_rir_observed: 'mean of rir_real over observed sets that have a numeric rir_real (prescribed RIR is excluded)',
    session_set_completion_ratio: 'observed sets / planned sets of the planned day (null when the plan day is unknown)',
    adherence_completed_session: 'a session whose done_{W}_{D} marker is true (or a non-auto-closed object); AUTO_CLOSED_NO_DATA is never completed',
    adherence_denominator_full_plan: 'plan.weeks * plan.daysPerWeek',
    adherence_denominator_through_last_activity_week: 'max(week with any session evidence) * plan.daysPerWeek',
    adherence_missed: 'denominator_through_last_activity_week - completed - partial (auto-closed days count as missed)',
    adherence_rate: 'completed / denominator, rounded to 4 decimals; null when the denominator is 0 or unknown',
    trend: 'last value - first value in chronological order; direction UP/DOWN/FLAT from the sign of the delta; no thresholds are applied'
  };

  function observed(r) { return r.done === true && r.synthetic_express !== true; }
  function stats(rows) {
    var loads = rows.map(function(r) { return r.load; }).filter(function(x) { return x !== null; });
    var reps = rows.map(function(r) { return r.reps; }).filter(function(x) { return x !== null; });
    var rirs = rows.map(function(r) { return r.rir_observed; }).filter(function(x) { return x !== null; });
    var ics = rows.map(function(r) { return r.ics; }).filter(function(x) { return x !== null; });
    var vol = 0, volN = 0;
    rows.forEach(function(r) { if (r.load !== null && r.reps !== null) { vol += r.load * r.reps; volN++; } });
    return {
      sets_logged: rows.length, load_avg: U.round(U.mean(loads)), load_max: loads.length ? Math.max.apply(null, loads) : null,
      reps_avg: U.round(U.mean(reps)), volume_load: volN ? U.round(vol) : null, rir_observed_avg: U.round(U.mean(rirs)), rir_observed_n: rirs.length,
      ics_avg: U.round(U.mean(ics)), ics_n: ics.length
    };
  }
  function groupBy(arr, keyFn) { var o = {}, order = []; arr.forEach(function(x) { var k = keyFn(x); if (!o[k]) { o[k] = []; order.push(k); } o[k].push(x); }); return { map: o, order: order }; }
  function rpeOf(post) {
    if (!U.isObj(post)) return null;
    var v = U.num(post.rpeAverage !== undefined ? post.rpeAverage : post.rpe);
    return v;
  }

  function performance(model) {
    var logs = model.training.exercise_logs, obs = logs.filter(observed);
    var planned = {};
    model.training.sessions.forEach(function(s) { planned[s.session_id] = s.planned_exercises.reduce(function(a, e) { return a + e.planned_sets; }, 0); });
    var sessionSummaries = model.training.sessions.map(function(s) {
      var rows = obs.filter(function(r) { return r.session_id === s.session_id; });
      var byUnit = {};
      var g = groupBy(rows, function(r) { return r.unit === null ? 'unknown' : String(r.unit).toLowerCase(); });
      g.order.sort().forEach(function(u) { byUnit[u] = stats(g.map[u]).volume_load; });
      var st = stats(rows), plannedSets = s.planned_exercises.length ? planned[s.session_id] : null;
      return { session_id: s.session_id, plan_id: s.plan_id, week: s.week, day_index: s.day_index, status: s.completion.status, sets_logged: st.sets_logged, planned_sets: plannedSets,
        set_completion_ratio: plannedSets ? U.round(st.sets_logged / plannedSets, 4) : null, volume_load_by_unit: byUnit, rir_observed_avg: st.rir_observed_avg, ics_avg: st.ics_avg, session_rpe: rpeOf(s.post_session) };
    });
    var byMeso = groupBy(obs, function(r) { return r.plan_id === null ? '~' : r.plan_id; });
    var names = {};
    obs.forEach(function(r) { var n = r.performed_exercise_name; if (typeof n !== 'string' || !n.trim()) return; var k = n.trim().toLowerCase(); if (!names[k]) names[k] = n.trim(); });
    var exercises = Object.keys(names).sort().map(function(k) {
      var mesos = [];
      model.training.mesocycles.forEach(function(m) {
        var rows = obs.filter(function(r) { return (r.plan_id === m.plan_id) && typeof r.performed_exercise_name === 'string' && r.performed_exercise_name.trim().toLowerCase() === k; });
        if (!rows.length) return;
        var wk = groupBy(rows, function(r) { return r.week + '|' + (r.unit === null ? 'unknown' : String(r.unit).toLowerCase()); });
        var weeks = U.sortBy(wk.order.map(function(w) { var p = w.split('|'); var o = { week: Number(p[0]), unit: p[1] }; var s = stats(wk.map[w]); Object.keys(s).forEach(function(x) { o[x] = s[x]; }); return o; }), function(x) { return [x.week, x.unit]; });
        var change = {}; var units = {}; weeks.forEach(function(x) { units[x.unit] = 1; });
        Object.keys(units).sort().forEach(function(u) {
          var ws = weeks.filter(function(x) { return x.unit === u && x.load_avg !== null; });
          change[u] = ws.length >= 2 ? { first_week: ws[0].week, last_week: ws[ws.length - 1].week, first_load_avg: ws[0].load_avg, last_load_avg: ws[ws.length - 1].load_avg,
            delta: U.round(ws[ws.length - 1].load_avg - ws[0].load_avg), pct: ws[0].load_avg ? U.round((ws[ws.length - 1].load_avg - ws[0].load_avg) / ws[0].load_avg * 100) : null } : null;
        });
        var pids = {}; rows.forEach(function(r) { if (r.prescription_exercise_id) pids[r.prescription_exercise_id] = 1; });
        mesos.push({ plan_id: m.plan_id, mesocycle_order: m.order, prescription_exercise_ids: Object.keys(pids).sort(), weeks: weeks, load_change_by_unit: change });
      });
      return { exercise_name: names[k], grouping: 'performed exercise name, case-insensitive (exercise identity only; clients are never matched by name)', mesocycles: mesos };
    });
    var all = stats(obs);
    var rpes = sessionSummaries.map(function(s) { return s.session_rpe; }).filter(function(x) { return x !== null; });
    return {
      derived: true, formulas: { observed_set: FORMULAS.observed_set, volume_load: FORMULAS.volume_load, average_rir_observed: FORMULAS.average_rir_observed, session_set_completion_ratio: FORMULAS.session_set_completion_ratio },
      totals: { exercise_log_records: logs.length, observed_sets: obs.length, synthetic_express_sets_excluded: logs.filter(function(r) { return r.synthetic_express; }).length,
        undone_sets_excluded: logs.filter(function(r) { return !r.done; }).length, rir_observed_avg: all.rir_observed_avg, rir_observed_n: all.rir_observed_n, ics_avg: all.ics_avg,
        session_rpe_avg: U.round(U.mean(rpes)), session_rpe_n: rpes.length, distinct_exercises: exercises.length },
      by_mesocycle: byMeso.order.map(function(k) { var s = stats(byMeso.map[k]); s.plan_id = k === '~' ? null : k; return s; }),
      session_summaries: sessionSummaries, exercises: exercises
    };
  }

  function adherence(model) {
    var items = [];
    model.training.mesocycles.forEach(function(m) {
      var sess = model.training.sessions.filter(function(s) { return s.plan_id === m.plan_id; });
      var base = { mesocycle_id: m.mesocycle_id, plan_id: m.plan_id, order: m.order, entries_source: m.entries_source };
      if (!sess.length) { items.push(Object.assign(base, { status: 'ADHERENCE_INSUFFICIENT_DATA', reason: 'NO_SESSION_EVIDENCE' })); return; }
      if (!m.plan_available || !m.weeks || !m.days_per_week) { items.push(Object.assign(base, { status: 'ADHERENCE_INSUFFICIENT_DATA', reason: 'PLAN_STRUCTURE_UNKNOWN',
        sessions_completed_observed: sess.filter(function(s) { return s.completion.status === 'COMPLETED'; }).length })); return; }
      var dpw = m.days_per_week, weeks = m.weeks;
      var inPlan = sess.filter(function(s) { return s.week >= 1 && s.week <= weeks && s.day_index >= 0 && s.day_index < dpw; });
      var lastWeek = Math.max.apply(null, m.weeks_with_data.filter(function(w) { return w >= 1 && w <= weeks; }).concat([0]));
      var completed = inPlan.filter(function(s) { return s.completion.status === 'COMPLETED'; });
      var partial = inPlan.filter(function(s) { return s.completion.status === 'PARTIAL'; });
      var auto = inPlan.filter(function(s) { return s.completion.status === 'AUTO_CLOSED_NO_DATA'; });
      var through = lastWeek * dpw, full = weeks * dpw;
      var byWeek = [], byDay = [];
      for (var w = 1; w <= lastWeek; w++) {
        var cw = completed.filter(function(s) { return s.week === w; }).length, pw = partial.filter(function(s) { return s.week === w; }).length;
        byWeek.push({ week: w, planned: dpw, completed: cw, partial: pw, missed: dpw - cw - pw, completion_rate: U.round(cw / dpw, 4) });
      }
      for (var d = 0; d < dpw; d++) {
        var cd = completed.filter(function(s) { return s.day_index === d; }).length, pd = partial.filter(function(s) { return s.day_index === d; }).length;
        var lbl = m.week_structure[d] ? m.week_structure[d].day_label : null;
        byDay.push({ day_index: d, day_label: lbl, planned: lastWeek, completed: cd, partial: pd, missed: lastWeek - cd - pd, completion_rate: lastWeek ? U.round(cd / lastWeek, 4) : null });
      }
      items.push(Object.assign(base, {
        status: 'OK', weeks: weeks, days_per_week: dpw, last_activity_week: lastWeek,
        planned_sessions_full_plan: full, planned_sessions_through_last_activity_week: through,
        completed: completed.length, partial: partial.length, auto_closed_no_data: auto.length, missed_through_last_activity_week: through - completed.length - partial.length,
        sessions_outside_plan_structure: sess.length - inPlan.length,
        completion_rate_full_plan: full ? U.round(completed.length / full, 4) : null,
        completion_rate_through_last_activity_week: through ? U.round(completed.length / through, 4) : null,
        by_week: byWeek, by_training_day: byDay
      }));
    });
    var ok = items.filter(function(i) { return i.status === 'OK'; });
    var overall;
    if (!ok.length) overall = { status: 'ADHERENCE_INSUFFICIENT_DATA', reason: items.length ? 'NO_MESOCYCLE_WITH_PLAN_STRUCTURE_AND_EVIDENCE' : 'NO_MESOCYCLES' };
    else {
      var pl = ok.reduce(function(a, i) { return a + i.planned_sessions_through_last_activity_week; }, 0), cp = ok.reduce(function(a, i) { return a + i.completed; }, 0);
      var pa = ok.reduce(function(a, i) { return a + i.partial; }, 0);
      overall = { status: 'OK', denominator: 'planned_sessions_through_last_activity_week summed over the mesocycles listed in included_mesocycles', included_mesocycles: ok.map(function(i) { return i.mesocycle_id; }),
        excluded_mesocycles: items.filter(function(i) { return i.status !== 'OK'; }).map(function(i) { return { mesocycle_id: i.mesocycle_id, reason: i.reason }; }),
        planned: pl, completed: cp, partial: pa, missed: pl - cp - pa, completion_rate: pl ? U.round(cp / pl, 4) : null };
    }
    return { derived: true, formulas: { completed: FORMULAS.adherence_completed_session, denominator_full_plan: FORMULAS.adherence_denominator_full_plan,
      denominator_through_last_activity_week: FORMULAS.adherence_denominator_through_last_activity_week, missed: FORMULAS.adherence_missed, rate: FORMULAS.adherence_rate },
      overall: overall, by_mesocycle: items };
  }

  function trend(points) {
    var p = points.filter(function(x) { return x.value !== null; });
    if (p.length < 2) return { n: p.length, first: p[0] ? p[0].value : null, last: p[0] ? p[0].value : null, delta: null, direction: null, mean: p.length ? U.round(p[0].value) : null };
    var first = p[0].value, last = p[p.length - 1].value, d = U.round(last - first);
    return { n: p.length, first: first, last: last, delta: d, direction: d > 0 ? 'UP' : (d < 0 ? 'DOWN' : 'FLAT'), mean: U.round(U.mean(p.map(function(x) { return x.value; }))),
      first_at: p[0].timestamp, last_at: p[p.length - 1].timestamp };
  }
  function recoveryTrends(model) {
    var rows = model.recovery, metric = {};
    function add(name, r, v) { v = U.num(v); (metric[name] = metric[name] || []).push({ value: v, timestamp: r.timestamp }); }
    rows.forEach(function(r) {
      var v = r.values; if (!U.isObj(v)) return;
      if (r.type === 'weekly_checkin') { add('who5', r, v.who5); add('hrv', r, v.hrv); add('weight', r, v.peso); }
      else {
        add('eimd', r, v.eimd); add('session_rpe', r, v.rpeAverage !== undefined ? v.rpeAverage : v.rpe);
        add('sleep_hours', r, v.sleepHours !== undefined ? v.sleepHours : v.sleep);
        if (v.articular !== undefined) { (metric.articular_pain_reports = metric.articular_pain_reports || []).push({ value: (v.articular === true || v.articular === 'si' || v.articular === 'sí') ? 1 : (v.articular === false || v.articular === 'no' ? 0 : null), timestamp: r.timestamp }); }
      }
    });
    var out = {}; Object.keys(metric).sort().forEach(function(k) { out[k] = trend(metric[k]); });
    var wsrc = [];
    model.body_metrics.forEach(function(b) {
      if (b.type === 'weekly_checkin' && U.isObj(b.values)) wsrc.push({ value: U.num(b.values.peso), timestamp: b.timestamp });
      else if (b.type === 'inbody' && U.isObj(b.values)) wsrc.push({ value: U.num(b.values.peso !== undefined ? b.values.peso : (b.values.weight !== undefined ? b.values.weight : b.values.pesoKg)), timestamp: b.timestamp });
    });
    var bw = trend(wsrc), perWeek = null;
    var a = U.toMs(bw.first_at), z = U.toMs(bw.last_at);
    if (bw.delta !== null && a !== null && z !== null && z > a) perWeek = U.round(bw.delta / ((z - a) / 604800000), 3);
    bw.change_per_week = perWeek;
    return { derived: true, formulas: { trend: FORMULAS.trend }, recovery: out, bodyweight: bw };
  }

  function derive(model) {
    return { performance: performance(model), adherence: adherence(model), trends: recoveryTrends(model) };
  }

  return { derive: derive, performance: performance, adherence: adherence, trends: recoveryTrends, FORMULAS: FORMULAS };
});
