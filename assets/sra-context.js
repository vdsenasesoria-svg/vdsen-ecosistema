(function(root) {
'use strict';
function _computeEvidenceConfidence(observations, malformedCount) {
    observations = Array.isArray(observations) ? observations : [];
    malformedCount = malformedCount || 0;
    var n = observations.length;

    // Count-based tier: one exposure can never be HIGH (T210 rule).
    var tier = n === 0 ? 'none' : n <= 2 ? 'low' : n <= 4 ? 'medium' : 'high';

    // Quality gate: poor adherence/fidelity cannot produce HIGH confidence,
    // even with many exposures (T210 rule) -- same thresholds as T205.
    var avgQuality = n ? (observations.reduce(function(a, b) { return a + b; }, 0) / n) : null;
    if (avgQuality !== null) {
      if (avgQuality < 0.5 && tier !== 'none') tier = 'low';
      else if (avgQuality < 0.75 && tier === 'high') tier = 'medium';
    }

    // Malformed/partial data lowers confidence: if unusable exposures
    // outnumber (or match) the usable ones, the tracking itself is
    // unreliable -- cap at low regardless of how good the clean ones look.
    if (malformedCount > 0 && malformedCount >= n && tier !== 'none') tier = 'low';

    return tier;
  }
function _sraPersistedSnapshots(entries, planDoc) {
    var allowed = {}, weekMap = {};
    ((planDoc && planDoc.days) || []).forEach(function(day) {
      (day.exercises || []).forEach(function(ex) {
        var pid = ex.prescriptionExerciseId;
        if (typeof pid === 'string' && pid) allowed[pid] = (allowed[pid] || 0) + 1;
      });
    });
    Object.keys(entries || {}).forEach(function(key) {
      var match = key.match(/^log_(\d+)_(\d+)_(\d+)_s(\d+)$/), e = entries[key];
      if (!match || !e || e.done !== true || e.autoFilled || e.pending || e.failed || e.rollback || e.stale || e.express || e.expressFinal || e.warmup || e.exType) return;
      // Never infer PID from the DOM, exercise name or current plan position.
      if (allowed[e.prescriptionExerciseId] !== 1) return;
      var week = match[1], pid = e.prescriptionExerciseId;
      if (!weekMap[week]) weekMap[week] = { exercises: [], days: {} };
      weekMap[week].days[match[2]] = true;
      var ex = weekMap[week].exercises.find(function(x) { return x.prescriptionExerciseId === pid; });
      if (!ex) { ex = { prescriptionExerciseId: pid, sets: [] }; weekMap[week].exercises.push(ex); }
      // A map key identifies one persisted set. Repeated clicks cannot append evidence.
      ex.sets.push(e);
    });
    return weekMap;
  }

function _computeRecoverySensitivity(entries, planDoc, progressionHistory) {
    entries = entries || {};
    var deloadByWeek = {};
    var weekMap = _sraPersistedSnapshots(entries, planDoc);
    Object.keys(entries).forEach(function(k) {
      var m = k.match(/^progrec_(\d+)_(\d+)$/);
      if (!m || !weekMap[m[1]] || !weekMap[m[1]].days[m[2]]) return;
      var w = parseInt(m[1], 10);
      var entry = entries[k];
      if (!entry || !Array.isArray(entry.deloadTriggers) || entry.pending || entry.failed || entry.stale || entry.rollback) return;
      var triggerCount = entry.deloadTriggers.length;
      deloadByWeek[w] = Math.max(deloadByWeek[w] || 0, triggerCount);
    });

    var weekStress = {};
    Object.keys(weekMap).forEach(function(w) {
      weekStress[w] = weekMap[w].exercises.reduce(function(sum, ex) { return sum + (ex.sets ? ex.sets.length : 0); }, 0);
    });

    var weeks = Object.keys(weekStress).map(Number).filter(function(w) { return deloadByWeek.hasOwnProperty(w); });
    var n = weeks.length;
    var confidence = _computeEvidenceConfidence(weeks.map(function() { return 1; }));

    if (confidence === 'none' || confidence === 'low') {
      return { pattern: 'INSUFFICIENT_DATA', confidence: confidence, weeksObserved: n,
        classification: 'RULE', signal: 'INSUFFICIENT_DATA',
        reason: 'No hay suficientes exposiciones persistidas y comparables para inferir recuperación.',
        evidence: { persistedWeeks: n, deloadSignals: Object.keys(deloadByWeek).length },
        dataStatus: 'INSUFFICIENT_DATA', reviewRequired: true };
    }

    var avgStress = weeks.reduce(function(sum, w) { return sum + weekStress[w]; }, 0) / n;
    var highStressWeeks = weeks.filter(function(w) { return weekStress[w] > avgStress; });
    var lowStressWeeks  = weeks.filter(function(w) { return weekStress[w] <= avgStress; });

    var highDeloadRate = highStressWeeks.length ? highStressWeeks.filter(function(w) { return deloadByWeek[w] > 0; }).length / highStressWeeks.length : 0;
    var lowDeloadRate  = lowStressWeeks.length  ? lowStressWeeks.filter(function(w) { return deloadByWeek[w] > 0; }).length / lowStressWeeks.length : 0;

    var pattern = 'STABLE_AT_CURRENT_STRESS';
    if (highStressWeeks.length && lowStressWeeks.length && highDeloadRate > lowDeloadRate && highDeloadRate >= 0.5) {
      pattern = 'DECLINES_AT_HIGHER_STRESS';
    }

    var signal = pattern === 'DECLINES_AT_HIGHER_STRESS' ? 'RECOVERY_REVIEW' : 'RECOVERY_MONITOR';
    return {
      pattern: pattern, confidence: confidence, weeksObserved: n,
      highStressDeloadRate: parseFloat(highDeloadRate.toFixed(2)),
      lowStressDeloadRate:  parseFloat(lowDeloadRate.toFixed(2)),
      // SRA is a contextual MONITOR over existing persisted evidence, never a prescription mutation.
      classification: 'MONITOR', signal: signal,
      reason: pattern === 'DECLINES_AT_HIGHER_STRESS'
        ? 'Las señales existentes de recuperación coinciden más en semanas de mayor exposición; requiere revisión Coach.'
        : 'Sin patrón persistido de deterioro relativo al nivel de exposición actual.',
      evidence: { persistedWeeks: n, highStressWeeks: highStressWeeks.length, lowStressWeeks: lowStressWeeks.length },
      dataStatus: 'PERSISTED_COMPARABLE_EVIDENCE', reviewRequired: pattern === 'DECLINES_AT_HIGHER_STRESS'
    };
  }
function _buildSraTrace(input) {
    input = input || {};
    var sra = input.sra || {};
    var pid = input.prescriptionExerciseId;
    if (!input.clientId || !pid) sra = { dataStatus: 'INSUFFICIENT_DATA', reviewRequired: true, reason: 'Identidad longitudinal incompleta.' };
    return {
      clientId: input.clientId || null, prescriptionExerciseId: pid || null,
      inputEvidence: sra.evidence || {}, evidenceWindow: sra.weeksObserved || 0,
      classification: sra.classification || 'RULE', ruleOrRange: input.ruleOrRange || sra.classification || 'RULE',
      sessionVolume: 'MONITOR_ONLY', numericApplyEnabled: false,
      progressionSignal: input.progressionSignal || 'UNAVAILABLE', sraSignal: sra.signal || 'INSUFFICIENT_DATA',
      agreementState: sra.reviewRequired !== false ? 'CONFLICT_OR_REVIEW' : 'NO_CONFLICT_IDENTIFIED',
      finalRecommendation: sra.reviewRequired !== false ? 'REVIEW_REQUIRED' : (input.recommendation || 'MONITOR'), reason: sra.reason || 'Evidencia insuficiente.',
      reviewRequired: sra.reviewRequired !== false, dataStatus: sra.dataStatus || 'INSUFFICIENT_DATA', mutation: 'NONE'
    };
  }

  // Programming template 2026: actual session RPE x reported minutes; exact sum(load x reps).
  // Context only. Missing days, missing duration and constant load never become fabricated zeros or permission to apply.
  function sessionMonitoring(input) {
    input = input || {}; var plan = input.planDoc || {}, entries = input.entries || {};
    var out = { source: 'VDSEN_PROGRAMMING_2026', classification: 'MONITOR', numericApplyEnabled: false, mutation: 'NONE', sessions: [],
      acuteEWMA7: null, chronicEWMA28: null, acwr: null, monotony7: null, strain7: null, reasons: [] };
    if (!input.clientId || (plan.clientId && plan.clientId !== input.clientId)) { out.reasons.push('IDENTITY_MISMATCH'); return out; }
    function num(x) { if ((typeof x !== 'string' && typeof x !== 'number') || x === '') return null; var n = Number(x); return Number.isFinite(n) ? n : null; }
    var known = {}, locations = {}, grouped = {};
    (plan.days || []).forEach(function(d) { (d.exercises || []).forEach(function(e, ei) { if (e.prescriptionExerciseId && e.exerciseType !== 'cardio') { known[e.prescriptionExerciseId] = (known[e.prescriptionExerciseId] || 0) + 1; locations[e.prescriptionExerciseId] = String(d.dayIndex) + '_' + ei; } }); });
    Object.keys(entries).forEach(function(k) {
      var m = /^log_(\d+)_(\d+)_(\d+)_s\d+$/.exec(k), e = entries[k];
      if (!m || !e || known[e.prescriptionExerciseId] !== 1 || locations[e.prescriptionExerciseId] !== m[2] + '_' + m[3] || e.done !== true || e.autoFilled || e.pending || e.failed || e.rollback || e.stale || e.express || e.expressFinal || e.warmup || e.exType) return;
      var id = m[1] + '_' + m[2]; (grouped[id] || (grouped[id] = [])).push(e);
    });
    Object.keys(grouped).forEach(function(id) {
      var done = entries['done_' + id], post = entries['postsession_' + id], prep = entries['readiness_' + id];
      if (!done || (typeof done === 'object' && (done.skipped || done.autoClosed || done.express || done.pending || done.failed || done.rollback || done.stale))) return;
      post = post && !post.pending && !post.failed && !post.rollback && !post.stale && !post.partial && !post.autoClosed ? post : {};
      var duration = num(post.durationMinutes), rpe = num(post.rpeAverage), ts = num(done.ts);
      var s = { week: Number(id.split('_')[0]), dayIndex: Number(id.split('_')[1]), at: ts, workingSets: grouped[id].length,
        reportedDurationMinutes: duration > 0 && duration <= 720 ? duration : null, sessionRPE: rpe >= 1 && rpe <= 10 ? rpe : null,
        loadAU: null, repetitions: 0, tonnageByUnit: {}, realRIR: null, readiness: null, sleepHours: num(post.sleepHours), eimd: num(post.eimd), reasons: [] };
      var rirs = [];
      grouped[id].forEach(function(e) {
        var reps = num(e.reps), load = num(e.carga), rir = num(e.rir_real);
        if (reps > 0) s.repetitions += reps;
        if (reps > 0 && load !== null && load >= 0 && ['KG', 'LB'].indexOf(e.unit) >= 0) s.tonnageByUnit[e.unit] = (s.tonnageByUnit[e.unit] || 0) + load * reps;
        if (rir !== null && rir >= 0 && rir <= 10) rirs.push(rir);
      });
      s.realRIR = rirs.length ? rirs.reduce(function(a,b) { return a+b; }, 0) / rirs.length : null;
      if (prep && prep.completed === true && !prep.pending && !prep.failed && !prep.stale && !prep.rollback) s.readiness = { pain: num(prep.dolor), motivation: num(prep.motivacion), composite: null };
      if (s.reportedDurationMinutes !== null && s.sessionRPE !== null) s.loadAU = s.reportedDurationMinutes * s.sessionRPE;
      else s.reasons.push('REPORTED_SESSION_DURATION_OR_RPE_MISSING');
      out.sessions.push(s);
    });
    out.sessions.sort(function(a,b) { return a.week - b.week || a.dayIndex - b.dayIndex; });
    var days = {};
    out.sessions.forEach(function(s) { if (!(s.at > 0) || !Number.isFinite(new Date(s.at).getTime())) return; var day = new Date(s.at).toISOString().slice(0,10); if (s.loadAU === null) days[day] = null; else if (days[day] !== null) days[day] = (days[day] || 0) + s.loadAU; });
    var keys = Object.keys(days).sort(), daily = [], prev = null;
    keys.forEach(function(k) { var t = Date.parse(k); if (days[k] === null || (prev !== null && t - prev !== 86400000)) daily = []; if (days[k] !== null) daily.push(days[k]); prev = t; });
    function ewma(n) { var v = daily[0], alpha = 2 / (n + 1); daily.slice(1).forEach(function(x) { v = alpha*x + (1-alpha)*v; }); return v; }
    if (daily.length >= 7) {
      out.acuteEWMA7 = ewma(7); var last = daily.slice(-7), mean = last.reduce(function(a,b) { return a+b; },0) / 7;
      var sd = Math.sqrt(last.reduce(function(a,x) { return a + Math.pow(x-mean,2); },0) / 6);
      if (sd > 0) { out.monotony7 = mean / sd; out.strain7 = last.reduce(function(a,b) { return a+b; },0) * out.monotony7; }
      else out.reasons.push('MONOTONY_ZERO_VARIANCE');
    }
    if (daily.length >= 28) { out.chronicEWMA28 = ewma(28); if (out.chronicEWMA28 > 0) out.acwr = out.acuteEWMA7 / out.chronicEWMA28; }
    else out.reasons.push('INCOMPLETE_DAILY_HISTORY_NO_REST_DAYS_INFERRED');
    out.sessionCount = out.sessions.length;
    out.reportedSessionCount = out.sessions.filter(function(s) { return s.loadAU !== null; }).length;
    out.sessions = out.sessions.slice(-2); // Bounded canonical provenance, not another copy of the athlete's history.
    return out;
  }

  function buildContext(input) {
    input = input || {};
    var entries = input.entries || {}, pid = input.prescriptionExerciseId;
    var scoped = {};
    Object.keys(entries).forEach(function(k) {
      if (/^progrec_/.test(k) || (entries[k] && entries[k].prescriptionExerciseId === pid)) scoped[k] = entries[k];
    });
    var plan = input.planDoc || {};
    var known = (plan.days || []).some(function(d) { return (d.exercises || []).some(function(e) { return e.prescriptionExerciseId === pid; }); });
    var progression = null, latest = -1;
    Object.keys(scoped).forEach(function(k) {
      var m = k.match(/^progrec_(\d+)_(\d+)$/), r = scoped[k];
      if (!m || !r || r.pending || r.failed || r.stale || r.rollback) return;
      (r.recommendations || []).forEach(function(rec) {
        if (rec.prescriptionExerciseId === pid && Number(m[1]) > latest) { progression = rec.action || null; latest = Number(m[1]); }
      });
    });
    var sra = _computeRecoverySensitivity(input.clientId && known && (!plan.clientId || plan.clientId === input.clientId) ? scoped : {}, plan, null);
    input = Object.assign({}, input, { progressionSignal: input.progressionSignal || progression || 'UNAVAILABLE' });
    var trace = _buildSraTrace(Object.assign({}, input, { sra: sra }));
    if (known && input.clientId && (!plan.clientId || plan.clientId === input.clientId)) trace.inputEvidence.sessionMonitoring = input.sessionMonitoring || sessionMonitoring(input);
    return trace;
  }
  function renderTrace(trace, audience) {
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
    var label = trace.reviewRequired ? 'Revisión Coach requerida' : 'Seguimiento de recuperación';
    return '<section class="card p-3 mb-3" aria-label="SRA recuperación"><strong>' + label + '</strong><p>' + esc(trace.reason) + '</p>'
      + '<details><summary>Decision Trace · solo lectura</summary><p>Ejercicio: ' + esc(trace.prescriptionExerciseId) + ' · Recuperación: ' + esc(trace.sraSignal)
      + ' · Progresión: ' + esc(trace.progressionSignal) + '</p><p>' + esc(trace.ruleOrRange) + ' · ' + esc(trace.classification) + ' · ' + esc(trace.dataStatus)
      + ' · ' + esc(trace.evidenceWindow) + ' semanas persistidas · ' + esc(trace.agreementState) + '</p><p>' + esc(trace.finalRecommendation)
      + ' · Volumen de sesión: MONITOR_ONLY</p><p>Cliente: ' + esc(trace.clientId) + ' · Revisión: ' + esc(trace.reviewRequired) + ' · Mutación: ' + esc(trace.mutation) + '</p><pre>' + esc(JSON.stringify(trace.inputEvidence)) + '</pre></details></section>';
  }

var api = { computeRecoverySensitivity: _computeRecoverySensitivity, buildSraTrace: _buildSraTrace, buildContext: buildContext, sessionMonitoring: sessionMonitoring, renderTrace: renderTrace, NUMERIC_APPLY_ENABLED: false };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.VDSEN_SRA = api;
})(typeof window !== 'undefined' ? window : globalThis);
