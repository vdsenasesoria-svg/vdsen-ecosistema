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
    return _buildSraTrace(Object.assign({}, input, { sra: sra }));
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

var api = { computeRecoverySensitivity: _computeRecoverySensitivity, buildSraTrace: _buildSraTrace, buildContext: buildContext, renderTrace: renderTrace, NUMERIC_APPLY_ENABLED: false };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.VDSEN_SRA = api;
})(typeof window !== 'undefined' ? window : globalThis);
