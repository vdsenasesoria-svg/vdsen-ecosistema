'use strict';

// ─── Evidence Labels (used inline throughout) ─────────────────────────────────
// RULE:          Deterministic — calendar/arithmetic. No uncertainty.
// HEURISTIC:     Practical pattern; NOT a universal biological law.
// MONITOR:       Requires longitudinal observation to validate per individual.
// COACH_DECISION: Human judgment; algorithm narrows options, coach decides.
// GUARDRAIL:     Safety-oriented; prevents harm without claiming it's universal.

// ─── Architectural Decision ───────────────────────────────────────────────────
// vdsen-plan-v2 is NOT modified. daysPerWeek stays integer.
// Topology lives in:
//   response.decisionTrace.trainingTopologyDecision
//   response.audit.trainingTopology
//
// The plan's days[] is treated as a weekly session template.
// Topology is a scheduling layer ABOVE the plan: it decides HOW sessions
// repeat across a mesocycle. Topology calendar and session content are
// kept strictly separate.
//
// Strategy B from spec §21: daysPerWeek = number of sessions in the
// generated week block; topology stored separately in decisionTrace.

// ─── Topology Definitions ─────────────────────────────────────────────────────
// (RULE) Each standard topology: trainDays contiguous TRAIN days + restDays REST days,
// repeating. cycleDays = trainDays + restDays.

var TOPOLOGY_DEFINITIONS = {
  ONE_ON_ONE_OFF:   { trainDays: 1, restDays: 1, cycleDays: 2 },
  TWO_ON_ONE_OFF:   { trainDays: 2, restDays: 1, cycleDays: 3 },
  THREE_ON_ONE_OFF: { trainDays: 3, restDays: 1, cycleDays: 4 },
  FOUR_ON_ONE_OFF:  { trainDays: 4, restDays: 1, cycleDays: 5 },
  FIVE_ON_TWO_OFF:  { trainDays: 5, restDays: 2, cycleDays: 7 },
  SIX_ON_ONE_OFF:   { trainDays: 6, restDays: 1, cycleDays: 7 },
  // CUSTOM: pattern defined explicitly by caller
};

var STANDARD_TOPOLOGY_IDS = [
  'ONE_ON_ONE_OFF',
  'TWO_ON_ONE_OFF',
  'THREE_ON_ONE_OFF',
  'FOUR_ON_ONE_OFF',
  'FIVE_ON_TWO_OFF',
  'SIX_ON_ONE_OFF',
];

// ─── Reason Codes ─────────────────────────────────────────────────────────────
var TOPOLOGY_REASON_CODES = {
  TOPOLOGY_SELECTED:                     'TOPOLOGY_SELECTED',
  TOPOLOGY_COACH_FIXED:                  'TOPOLOGY_COACH_FIXED',
  TOPOLOGY_PREFERENCE_MATCH:             'TOPOLOGY_PREFERENCE_MATCH',
  TOPOLOGY_FREQUENCY_MATCH:              'TOPOLOGY_FREQUENCY_MATCH',
  TOPOLOGY_VOLUME_DISTRIBUTION:          'TOPOLOGY_VOLUME_DISTRIBUTION',
  TOPOLOGY_RECOVERY_DISTRIBUTION:        'TOPOLOGY_RECOVERY_DISTRIBUTION',
  TOPOLOGY_ADHERENCE:                    'TOPOLOGY_ADHERENCE',
  TOPOLOGY_LEARNED_RESPONSE:             'TOPOLOGY_LEARNED_RESPONSE',
  TOPOLOGY_INSUFFICIENT_HISTORY:         'TOPOLOGY_INSUFFICIENT_HISTORY',
  CONSECUTIVE_TRAINING_DAYS_WARNING:     'CONSECUTIVE_TRAINING_DAYS_WARNING',
  PRIORITY_MUSCLE_SPACING_WARNING:       'PRIORITY_MUSCLE_SPACING_WARNING',
  TOPOLOGY_VOLUME_CONCENTRATION_WARNING: 'TOPOLOGY_VOLUME_CONCENTRATION_WARNING',
  TOPOLOGY_RECOVERY_MISMATCH:            'TOPOLOGY_RECOVERY_MISMATCH',
  TOPOLOGY_FREQUENCY_MISMATCH:           'TOPOLOGY_FREQUENCY_MISMATCH',
  TOPOLOGY_LOGISTIC_CONFLICT:            'TOPOLOGY_LOGISTIC_CONFLICT',
};

// ─── Topology Metrics ─────────────────────────────────────────────────────────
/**
 * Computes deterministic (RULE) metrics for a topology.
 * All values are exact rationals; no internal rounding.
 *
 * @param {string}   topologyId      - Standard id or 'CUSTOM'
 * @param {string[]} [customPattern] - Required when topologyId === 'CUSTOM'
 * @returns {object|null}
 */
function computeTopologyMetrics(topologyId, customPattern) {
  // CUSTOM topology: derive from explicit pattern array
  if (topologyId === 'CUSTOM') {
    if (!Array.isArray(customPattern) || customPattern.length === 0) return null;
    var trainCount = 0;
    var restCount  = 0;
    for (var j = 0; j < customPattern.length; j++) {
      if (customPattern[j] === 'TRAIN') trainCount++;
      else if (customPattern[j] === 'REST') restCount++;
    }
    var cycleLen = customPattern.length;
    var maxConsec = _maxConsecutive(customPattern, 'TRAIN');
    return {
      topologyId: 'CUSTOM',
      trainDays:  trainCount,
      restDays:   restCount,
      cycleDays:  cycleLen,
      sessionsPerWeekEquivalent: trainCount / cycleLen * 7, // RULE
      restDayDensity:            restCount  / cycleLen,     // RULE
      maxConsecutiveTrainingDays: maxConsec,                // RULE
      pattern: customPattern.slice(),
    };
  }

  var def = TOPOLOGY_DEFINITIONS[topologyId];
  if (!def) return null;

  // Standard topology: all train days are contiguous, then all rest days.
  // maxConsecutiveTrainingDays = trainDays (RULE for X_ON_Y_OFF).
  var pattern = [];
  for (var t = 0; t < def.trainDays; t++) pattern.push('TRAIN');
  for (var r = 0; r < def.restDays;  r++) pattern.push('REST');

  return {
    topologyId: topologyId,
    trainDays:  def.trainDays,
    restDays:   def.restDays,
    cycleDays:  def.cycleDays,
    sessionsPerWeekEquivalent: def.trainDays / def.cycleDays * 7, // RULE
    restDayDensity:            def.restDays  / def.cycleDays,     // RULE
    maxConsecutiveTrainingDays: def.trainDays,                    // RULE
    pattern: pattern,
  };
}

// RULE: count longest consecutive streak of a value in an array.
function _maxConsecutive(arr, value) {
  var max = 0;
  var cur = 0;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === value) { cur++; if (cur > max) max = cur; }
    else { cur = 0; }
  }
  return max;
}

// ─── AB Split Metrics ─────────────────────────────────────────────────────────
/**
 * IMPORTANT: these metrics are ONLY valid when sessions alternate A→B→A→B... perfectly.
 * They describe calendar math for a 2-session split, not universal exposure frequency.
 * (RULE for the arithmetic; HEURISTIC for applying it to any real split.)
 *
 * @param {string}   topologyId
 * @param {string[]} [customPattern]
 * @returns {object|null}
 */
function computeABMetrics(topologyId, customPattern) {
  var m = computeTopologyMetrics(topologyId, customPattern);
  if (!m) return null;

  var exposureFreqAB       = m.sessionsPerWeekEquivalent / 2;          // RULE
  var meanInterExposureDays = exposureFreqAB > 0 ? 7 / exposureFreqAB : null; // RULE

  return {
    topologyId: topologyId,
    effectiveExposureFrequencyAB: exposureFreqAB,
    meanInterExposureDaysAB:      meanInterExposureDays,
    note: 'RULE: calendar arithmetic for perfectly alternating A/B split only. Not a hypertrophy prediction.',
  };
}

// ─── Calendar Generator ─────────────────────────────────────────────────────
/**
 * Generates a flat TRAIN/REST calendar for numberOfDays by repeating the topology cycle.
 * Pure function: topology scheduling layer, completely separate from session content.
 * (RULE: calendar arithmetic only.)
 *
 * @param {string}   topologyId
 * @param {number}   numberOfDays
 * @param {string[]} [customPattern]
 * @returns {string[]}  e.g. ['TRAIN','TRAIN','REST','TRAIN','TRAIN','REST',...]
 */
function generateTopologyCalendar(topologyId, numberOfDays, customPattern) {
  var m = computeTopologyMetrics(topologyId, customPattern);
  if (!m || !m.pattern || m.pattern.length === 0) return [];
  var pattern  = m.pattern;
  var calendar = [];
  for (var i = 0; i < numberOfDays; i++) {
    calendar.push(pattern[i % pattern.length]);
  }
  return calendar;
}

// ─── Feasibility Check ────────────────────────────────────────────────────────
// (GUARDRAIL) Hard constraint: trainDays must not exceed availableDays.
// This is a calendar constraint, not a health claim.

function _isFeasible(metrics, availableDays) {
  if (!metrics) return false;
  return metrics.trainDays <= availableDays;
}

// ─── Frequency Match Score ────────────────────────────────────────────────────
// (HEURISTIC) Quantifies how well a topology distributes sessions for muscle targets.
// Uses AB-split frequency estimate as a proxy for exposure frequency.
// Lower score = better match.
//
// Priority weights: high=3, normal=2, maintenance=1.
// Documented as HEURISTIC — not validated fisiología weights.

var _PRIORITY_WEIGHTS = { high: 3, normal: 2, maintenance: 1 };

function _frequencyMatchScore(metrics, muscleTargets) {
  if (!muscleTargets || muscleTargets.length === 0) return 0;

  // AB-split frequency as first-pass estimate of exposure frequency.
  // Actual exposure depends on split content — this is a scheduling estimate.
  var exposureEstimate = metrics.sessionsPerWeekEquivalent / 2; // HEURISTIC proxy

  var weightedError = 0;
  var totalWeight   = 0;

  muscleTargets.forEach(function(mt) {
    var targetFreq = typeof mt.frequencyTarget === 'number' ? mt.frequencyTarget : 2;
    var weight     = _PRIORITY_WEIGHTS[mt.priority] || 2;
    weightedError += Math.abs(exposureEstimate - targetFreq) * weight;
    totalWeight   += weight;
  });

  return totalWeight > 0 ? weightedError / totalWeight : 0;
}

// ─── Topology Burden Index ────────────────────────────────────────────────────
// (HEURISTIC_SCORE) Internal ranking only. NOT a physiological magnitude.
// Combines normalized consecutive days and rest density.
// Range [0..1]; higher = more demanding scheduling pattern.

function _topologyBurdenIndex(metrics) {
  var consecutiveFactor = (metrics.maxConsecutiveTrainingDays - 1) / 5; // [0..1] normalized on 1-6 range
  var densityFactor     = 1 - metrics.restDayDensity;                    // [0..1]
  return (consecutiveFactor + densityFactor) / 2;                        // HEURISTIC average
}

// ─── Readiness Penalty ────────────────────────────────────────────────────────
// (GUARDRAIL) When fatigued, penalize high-density candidates.
// Does NOT block any topology — only adjusts ranking.
// Applies the MINIMAL CHANGE SUFFICIENT principle.

function _readinessPenalty(metrics, readiness) {
  var burden = _topologyBurdenIndex(metrics);
  if (readiness === 'fatigued') {
    return burden * 0.5;  // HEURISTIC weight
  }
  if (readiness === 'progressing') {
    return -burden * 0.1; // small bonus for higher density when progressing
  }
  return 0;
}

// ─── Learned State Score ─────────────────────────────────────────────────────
// (MONITOR → RULE when confidence >= medium)
// RULE: learned_state prevails over heuristic at medium/high confidence.

function _learnedStateScore(topologyId, learnedState) {
  if (!learnedState || learnedState.currentTopology !== topologyId) {
    return { reward: 0, hasLearned: false };
  }

  var confidence = learnedState.confidence || 'none';
  if (confidence === 'none' || confidence === 'low') {
    return { reward: 0, hasLearned: false };
  }

  var perfTrend = learnedState.sessionPerformanceTrend || 'unknown';
  var lateTrend = learnedState.lateSequencePerformanceTrend || 'unknown';
  var recTrend  = learnedState.recoveryTrend || 'unknown';

  var positive = 0;
  if (perfTrend === 'improving' || perfTrend === 'stable') positive++;
  if (recTrend  === 'improving' || recTrend  === 'adequate') positive++;

  var negative = 0;
  if (lateTrend === 'declining') negative++;
  if (perfTrend === 'declining') negative++;
  if (recTrend  === 'declining') negative++;

  var netSignal   = positive - negative;
  var multiplier  = confidence === 'high' ? 1.0 : 0.5;
  // Reward is subtracted from compositeScore (lower = better)
  var reward = netSignal * multiplier * -0.3;

  return { reward: reward, hasLearned: true, confidence: confidence, netSignal: netSignal };
}

// ─── Warning Generator ────────────────────────────────────────────────────────
// Generates HEURISTIC/MONITOR warnings for a candidate.
// Warnings never become errors — they are MONITOR/COACH_DECISION signals.

function _generateWarnings(metrics, muscleTargets, readiness, learnedState) {
  var warnings = [];

  // HEURISTIC: many consecutive training days + fatigue → watch signal
  if (metrics.maxConsecutiveTrainingDays >= 4) {
    warnings.push({
      code:          'CONSECUTIVE_TRAINING_DAYS_WARNING',
      severity:      metrics.maxConsecutiveTrainingDays >= 5 ? 'WATCH' : 'INFO',
      message:       'HEURISTIC: ' + metrics.maxConsecutiveTrainingDays +
                     ' días consecutivos. Monitorizar calidad de sesiones tardías.',
      evidenceStatus: 'HEURISTIC',
    });
  }

  // GUARDRAIL: high burden + fatigued readiness
  if (readiness === 'fatigued' && _topologyBurdenIndex(metrics) > 0.6) {
    warnings.push({
      code:          'TOPOLOGY_RECOVERY_MISMATCH',
      severity:      'WATCH',
      message:       'GUARDRAIL: Alta densidad de entrenamiento con readiness fatigued. ' +
                     'Considerar redistribución de sesiones.',
      evidenceStatus: 'GUARDRAIL',
    });
  }

  // MONITOR: learned state shows declining performance at end of sequences
  if (learnedState &&
      learnedState.currentTopology === metrics.topologyId &&
      learnedState.lateSequencePerformanceTrend === 'declining' &&
      (learnedState.confidence === 'medium' || learnedState.confidence === 'high')) {
    warnings.push({
      code:          'TOPOLOGY_RECOVERY_MISMATCH',
      severity:      'WATCH',
      message:       'MONITOR: El historial muestra deterioro de rendimiento al final de ' +
                     'secuencias de entrenamiento. Evaluar redistribución.',
      evidenceStatus: 'MONITOR',
    });
  }

  return warnings;
}

// ─── Candidate Evaluator ─────────────────────────────────────────────────────

function _evaluateCandidate(topologyId, input) {
  var avail    = typeof input.availableDays === 'number' ? input.availableDays : 7;
  var metrics  = computeTopologyMetrics(topologyId, input.customPattern);
  var feasible = _isFeasible(metrics, avail);

  var freqScore     = _frequencyMatchScore(metrics, input.muscleTargets);
  var readinessPen  = _readinessPenalty(metrics, input.readiness || 'neutral');
  var learnedResult = _learnedStateScore(topologyId, input.learnedState);
  var warnings      = _generateWarnings(metrics, input.muscleTargets, input.readiness || 'neutral', input.learnedState);

  // Composite score: lower = better. (HEURISTIC multi-criteria ranking.)
  var composite = freqScore + readinessPen + learnedResult.reward;

  var reasonCodes = [];
  if (!learnedResult.hasLearned) {
    reasonCodes.push('TOPOLOGY_INSUFFICIENT_HISTORY');
  } else {
    reasonCodes.push('TOPOLOGY_LEARNED_RESPONSE');
  }
  if (freqScore < 0.3) reasonCodes.push('TOPOLOGY_FREQUENCY_MATCH');
  if (metrics && metrics.restDayDensity > 0.25) reasonCodes.push('TOPOLOGY_RECOVERY_DISTRIBUTION');

  return {
    topology:       topologyId,
    feasible:       feasible,
    metrics:        metrics,
    freqMatchScore: freqScore,
    burdenIndex:    _topologyBurdenIndex(metrics), // HEURISTIC_SCORE
    compositeScore: feasible ? composite : Infinity,
    warnings:       warnings,
    reasonCodes:    reasonCodes,
    learnedInfo:    learnedResult,
    explanation:    _buildCandidateExplanation(topologyId, metrics, freqScore, learnedResult, warnings),
  };
}

function _buildCandidateExplanation(id, m, freqScore, learnedResult, warnings) {
  if (!m) return id + ': no metrics available.';
  var parts = [
    id + ': ' + m.sessionsPerWeekEquivalent.toFixed(7) + ' ses/sem eq., ' +
    'máx ' + m.maxConsecutiveTrainingDays + ' días consecutivos, ' +
    'descanso ' + (m.restDayDensity * 100).toFixed(1) + '%.',
  ];
  if (learnedResult.hasLearned) {
    parts.push('Historial observado (confianza: ' + learnedResult.confidence + ').');
  } else {
    parts.push('Sin historial suficiente — evaluación heurística.');
  }
  if (warnings.length) {
    parts.push('Advertencias: ' + warnings.map(function(w) { return w.code; }).join(', ') + '.');
  }
  return parts.join(' ');
}

// ─── compareTrainingTopologies ────────────────────────────────────────────────
/**
 * Multi-criteria topology selector.
 *
 * Level 1 (hard constraints/GUARDRAIL): calendar feasibility, coach veto.
 * Level 2 (HEURISTIC): frequency target match.
 * Level 3 (HEURISTIC): volume distribution / burden index.
 * Level 4 (MONITOR→RULE): learned state at medium/high confidence.
 * Level 5 (COACH_DECISION): adherence / preference.
 *
 * PROHIBITIONS enforced by architecture:
 *   - No hardcoded "hypertrophy → TWO_ON_ONE_OFF".
 *   - No "72h" rule.
 *   - maxConsecutiveTrainingDays is never an automatic ERROR.
 *   - availableDays does not obligate training all days.
 *
 * @param {object}   input
 * @param {Array}    [input.muscleTargets]      [{muscle, frequencyTarget, volumeTarget, priority}]
 * @param {number}   [input.availableDays=7]    Max calendar days (not an obligation)
 * @param {number}   [input.sessionDurationMin]
 * @param {string}   [input.readiness]          'progressing'|'neutral'|'fatigued'
 * @param {string}   [input.previousTopology]
 * @param {object}   [input.learnedState]       trainingTopologyState
 * @param {Array}    [input.restrictions]
 * @param {object}   [input.coachPreference]    { mode, preferredTopology, customPattern }
 * @returns {{ selected, candidates }}
 */
function compareTrainingTopologies(input) {
  input = input || {};

  var coachPref = input.coachPreference || null;
  var readiness = input.readiness || 'neutral';
  var avail     = typeof input.availableDays === 'number' ? input.availableDays : 7;

  // ── Level 0: Coach FIXED (INVARIANT — coach_constraint source) ───────────
  if (coachPref && coachPref.mode === 'fixed' && coachPref.preferredTopology) {
    var fixedId      = coachPref.preferredTopology;
    var fixedMetrics = computeTopologyMetrics(fixedId, coachPref.customPattern);
    var fixedWarnings = fixedMetrics
      ? _generateWarnings(fixedMetrics, input.muscleTargets, readiness, input.learnedState)
      : [];

    if (fixedMetrics && !_isFeasible(fixedMetrics, avail)) {
      fixedWarnings.push({
        code:          'TOPOLOGY_LOGISTIC_CONFLICT',
        severity:      'WARN',
        message:       'GUARDRAIL: ' + fixedId + ' requiere ' + fixedMetrics.trainDays +
                       ' días de entrenamiento pero solo ' + avail + ' están disponibles.',
        evidenceStatus: 'GUARDRAIL',
      });
    }

    return {
      selected: {
        topology:    fixedId,
        source:      'coach_constraint',
        confidence:  'high',
        metrics:     fixedMetrics,
        warnings:    fixedWarnings,
        reasonCodes: ['TOPOLOGY_COACH_FIXED'],
        explanation: 'Topología fijada por el coach. Se respeta la restricción.',
      },
      candidates: [],
    };
  }

  // ── Evaluate all standard topologies ─────────────────────────────────────
  var evaluated = STANDARD_TOPOLOGY_IDS.map(function(tid) {
    return _evaluateCandidate(tid, input);
  });

  // HEURISTIC bonus for coach 'preferred' (not fixed)
  if (coachPref && coachPref.mode === 'preferred' && coachPref.preferredTopology) {
    evaluated.forEach(function(c) {
      if (c.topology === coachPref.preferredTopology && c.feasible) {
        c.compositeScore -= 0.2; // HEURISTIC preference bonus
        if (c.reasonCodes.indexOf('TOPOLOGY_PREFERENCE_MATCH') === -1) {
          c.reasonCodes.push('TOPOLOGY_PREFERENCE_MATCH');
        }
      }
    });
  }

  // ── Level 1: Filter feasible ──────────────────────────────────────────────
  var feasible = evaluated.filter(function(c) { return c.feasible; });
  if (feasible.length === 0) feasible = evaluated; // fallback: show all

  // ── Level 4: Learned state bias (RULE when confidence >= medium) ──────────
  // A topology with positive performance history at medium/high confidence
  // receives a substantial score reduction (better).
  if (input.learnedState &&
      (input.learnedState.confidence === 'high' || input.learnedState.confidence === 'medium') &&
      input.learnedState.lateSequencePerformanceTrend !== 'declining' &&
      input.learnedState.sessionPerformanceTrend !== 'declining') {

    var learnedTop = input.learnedState.currentTopology;
    feasible.forEach(function(c) {
      if (c.topology === learnedTop) {
        var bias = input.learnedState.confidence === 'high' ? -0.5 : -0.25;
        c.compositeScore += bias;
        if (c.reasonCodes.indexOf('TOPOLOGY_LEARNED_RESPONSE') === -1) {
          c.reasonCodes.push('TOPOLOGY_LEARNED_RESPONSE');
        }
      }
    });
  }

  // ── Sort by composite score (lower = better) ──────────────────────────────
  feasible.sort(function(a, b) { return a.compositeScore - b.compositeScore; });

  var best = feasible[0] || evaluated[0];

  // Build final reason codes for selected candidate
  var finalCodes = ['TOPOLOGY_SELECTED'];
  best.reasonCodes.forEach(function(c) {
    if (finalCodes.indexOf(c) === -1) finalCodes.push(c);
  });
  finalCodes.push('TOPOLOGY_VOLUME_DISTRIBUTION');
  finalCodes = finalCodes.filter(function(v, i, a) { return a.indexOf(v) === i; });

  // Determine source/confidence
  var source     = 'heuristic';
  var confidence = 'medium';
  if (input.learnedState && best.learnedInfo && best.learnedInfo.hasLearned) {
    source     = 'learned_state';
    confidence = best.learnedInfo.confidence || 'low';
  }

  return {
    selected: {
      topology:    best.topology,
      source:      source,
      confidence:  confidence,
      metrics:     best.metrics,
      warnings:    best.warnings,
      reasonCodes: finalCodes,
      explanation: best.explanation,
    },
    candidates: evaluated,
  };
}

// ─── buildTrainingTopologyDecision ───────────────────────────────────────────
/**
 * Constructs the trainingTopologyDecision object for response.decisionTrace.
 * Does NOT modify vdsen-plan-v2.
 *
 * @param {object} compareResult  - Output from compareTrainingTopologies()
 * @param {object} [muscleSpacing] - Optional per-muscle spacing data
 * @returns {object|null}
 */
function buildTrainingTopologyDecision(compareResult, muscleSpacing) {
  if (!compareResult || !compareResult.selected) return null;
  var sel = compareResult.selected;
  var m   = sel.metrics || {};

  var decision = {
    topology:                   sel.topology,
    pattern:                    m.pattern   || [],
    cycleDays:                  m.cycleDays  || null,
    trainingDaysPerCycle:       m.trainDays  || null,
    restDaysPerCycle:           m.restDays   || null,
    sessionsPerWeekEquivalent:  m.sessionsPerWeekEquivalent  || null,
    restDayDensity:             m.restDayDensity             || null,
    maxConsecutiveTrainingDays: m.maxConsecutiveTrainingDays || null,
    source:      sel.source      || 'heuristic',
    confidence:  sel.confidence  || 'medium',
    reasonCodes: sel.reasonCodes || [],
    rationale:   _buildDecisionRationale(sel, m),
    warnings:    sel.warnings    || [],
  };

  if (muscleSpacing && typeof muscleSpacing === 'object') {
    decision.muscleSpacing = muscleSpacing;
  }

  return decision;
}

function _buildDecisionRationale(sel, m) {
  var parts = [];

  if (!m || !m.topologyId) return parts;

  parts.push(
    'La topología ' + sel.topology + ' ofrece ' +
    (m.sessionsPerWeekEquivalent || 0).toFixed(2) +
    ' sesiones equivalentes por semana, ' +
    'máximo ' + m.maxConsecutiveTrainingDays + ' días consecutivos, ' +
    'densidad de descanso ' + (m.restDayDensity * 100).toFixed(1) + '%.'
  );

  if (sel.source === 'learned_state') {
    parts.push(
      'El historial observado (confianza: ' + sel.confidence + ') respalda esta topología. ' +
      'Se aplica la regla: learned_state prevalece sobre heurística a confianza media/alta.'
    );
  } else {
    parts.push(
      'Sin historial suficiente para declarar superioridad individual. ' +
      'La selección es HEURÍSTICA y se monitorizará con rendimiento, RIR, recuperación y adherencia.'
    );
  }

  if (sel.warnings && sel.warnings.length > 0) {
    parts.push(
      'Advertencias registradas: ' +
      sel.warnings.map(function(w) { return w.code; }).join(', ') + '. ' +
      'No son errores — requieren seguimiento de coach.'
    );
  }

  parts.push(
    'La recuperación se evalúa dinámicamente: rendimiento, RIR real, sueño, soreness/EIMD, ' +
    'RPE y adherencia. No se asume una duración fija de recuperación muscular. ' +
    'La disponibilidad de días no obliga a usar todos los días disponibles.'
  );

  return parts;
}

// ─── Topology Audit Block ─────────────────────────────────────────────────────
/**
 * Builds the audit.trainingTopology block for a generation response.
 * Compatible with ALLOWED_RESPONSE_ROOT (audit is already permitted).
 */
function buildTopologyAudit(compareResult) {
  if (!compareResult || !compareResult.selected) return null;
  var sel = compareResult.selected;
  var m   = sel.metrics || {};

  return {
    topology:                   sel.topology,
    cyclePattern:               m.pattern || [],
    sessionsPerWeekEquivalent:  m.sessionsPerWeekEquivalent || null,
    maxConsecutiveTrainingDays: m.maxConsecutiveTrainingDays || null,
    restDayDensity:             m.restDayDensity || null,
    source:                     sel.source || 'heuristic',
    confidence:                 sel.confidence || 'medium',
    muscleFrequencyMatch:       {},  // populated by caller when exercise data is available
    warnings: (sel.warnings || []).map(function(w) {
      return { code: w.code, severity: w.severity, evidenceStatus: w.evidenceStatus };
    }),
  };
}

// ─── Reference Table ─────────────────────────────────────────────────────────
// (RULE) Calendar arithmetic only. NOT hypertrophy predictions.
// *AB metrics valid only for perfectly alternating A/B split.

var TOPOLOGY_REFERENCE_TABLE = STANDARD_TOPOLOGY_IDS.map(function(id) {
  var m  = computeTopologyMetrics(id);
  var ab = computeABMetrics(id);
  return {
    topology:                   id,
    sessionsPerWeekEquivalent:  m.sessionsPerWeekEquivalent,
    restDayDensityPct:          m.restDayDensity * 100,
    maxConsecutiveTrainingDays: m.maxConsecutiveTrainingDays,
    abFrequency:                ab.effectiveExposureFrequencyAB,
    abMeanInterExposureDays:    ab.meanInterExposureDaysAB,
    note: 'RULE: calendar arithmetic. *AB only for perfectly alternating A/B split.',
  };
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  TOPOLOGY_DEFINITIONS:          TOPOLOGY_DEFINITIONS,
  STANDARD_TOPOLOGY_IDS:         STANDARD_TOPOLOGY_IDS,
  TOPOLOGY_REASON_CODES:         TOPOLOGY_REASON_CODES,
  TOPOLOGY_REFERENCE_TABLE:      TOPOLOGY_REFERENCE_TABLE,
  computeTopologyMetrics:        computeTopologyMetrics,
  computeABMetrics:              computeABMetrics,
  generateTopologyCalendar:      generateTopologyCalendar,
  compareTrainingTopologies:     compareTrainingTopologies,
  buildTrainingTopologyDecision: buildTrainingTopologyDecision,
  buildTopologyAudit:            buildTopologyAudit,
  // Internal helpers — exported for unit tests
  _isFeasible:            _isFeasible,
  _frequencyMatchScore:   _frequencyMatchScore,
  _topologyBurdenIndex:   _topologyBurdenIndex,
  _readinessPenalty:      _readinessPenalty,
  _learnedStateScore:     _learnedStateScore,
  _maxConsecutive:        _maxConsecutive,
};
