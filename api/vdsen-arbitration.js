'use strict';

/**
 * VDSEN Unified Arbitration Kernel — Phase 1 (shadow/read-only)
 *
 * Pure deterministic coordination layer between M1, N1-DE and S1.
 * It NEVER writes Firestore and NEVER mutates a plan. Engines submit proposals;
 * this module classifies causal validity, posterior-learning eligibility and
 * cross-engine collisions as ALLOW / MODIFY / BLOCK / HOLD / REVIEW_REQUIRED.
 *
 * No clinical thresholds live here. Inputs are categorical states produced by
 * existing VDSEN authorities/validators. This preserves frozen engines and the
 * vdsen-plan-v2 persistence contract while establishing one arbitration path.
 */

var ROUTING = Object.freeze({
  R0_BIOLOGICAL_SAFETY: 0,
  R1_DATA_CONTRACT_INTEGRITY: 1,
  R2_MODE_CONSTRAINTS: 2,
  R3_RECOVERY_CAPACITY: 3,
  R4_NUTRITION_ADAPTATION: 4,
  R5_TRAINING_PROGRESSION: 5,
  R6_SUPPLEMENTATION: 6
});

var ACTION = Object.freeze({
  ALLOW: 'ALLOW',
  MODIFY: 'MODIFY',
  BLOCK: 'BLOCK',
  HOLD: 'HOLD',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});

var CONTEXT_EVENT = Object.freeze({
  TRAINING_LOAD_TRANSITION: 'TRAINING_LOAD_TRANSITION',
  DELOAD_ACTIVE: 'DELOAD_ACTIVE',
  INJURY_EVENT: 'INJURY_EVENT',
  ILLNESS_EVENT: 'ILLNESS_EVENT',
  PHARMACOLOGY_TRANSITION: 'PHARMACOLOGY_TRANSITION',
  CONTEST_MANIPULATION: 'CONTEST_MANIPULATION',
  HYDRATION_INSTABILITY: 'HYDRATION_INSTABILITY',
  ADHERENCE_INVALID: 'ADHERENCE_INVALID',
  SLEEP_DISRUPTION: 'SLEEP_DISRUPTION',
  GI_TOLERANCE_EVENT: 'GI_TOLERANCE_EVENT'
});

var COLLISION = Object.freeze({
  RECOVERY_ENERGY_CONFLICT: 'RECOVERY_ENERGY_CONFLICT',
  TRAINING_ENERGY_AVAILABILITY_CONFLICT: 'TRAINING_ENERGY_AVAILABILITY_CONFLICT',
  HEMODYNAMIC_STIMULANT_CONFLICT: 'HEMODYNAMIC_STIMULANT_CONFLICT',
  INVALID_TDEE_LEARNING_WINDOW: 'INVALID_TDEE_LEARNING_WINDOW',
  TRAINING_TRANSITION_WEIGHT_CONFUSION: 'TRAINING_TRANSITION_WEIGHT_CONFUSION',
  LOW_ADHERENCE_INFERENCE_BLOCKED: 'LOW_ADHERENCE_INFERENCE_BLOCKED',
  MULTIPLE_MAJOR_CHANGES: 'MULTIPLE_MAJOR_CHANGES'
});

var _LEARNING_CONTAMINANTS = Object.freeze([
  CONTEXT_EVENT.TRAINING_LOAD_TRANSITION,
  CONTEXT_EVENT.DELOAD_ACTIVE,
  CONTEXT_EVENT.INJURY_EVENT,
  CONTEXT_EVENT.ILLNESS_EVENT,
  CONTEXT_EVENT.PHARMACOLOGY_TRANSITION,
  CONTEXT_EVENT.CONTEST_MANIPULATION,
  CONTEXT_EVENT.HYDRATION_INSTABILITY,
  CONTEXT_EVENT.ADHERENCE_INVALID
]);

var _WEIGHT_CONTAMINANTS = Object.freeze([
  CONTEXT_EVENT.TRAINING_LOAD_TRANSITION,
  CONTEXT_EVENT.DELOAD_ACTIVE,
  CONTEXT_EVENT.PHARMACOLOGY_TRANSITION,
  CONTEXT_EVENT.CONTEST_MANIPULATION,
  CONTEXT_EVENT.HYDRATION_INSTABILITY,
  CONTEXT_EVENT.ILLNESS_EVENT
]);

var _PERFORMANCE_CONTAMINANTS = Object.freeze([
  CONTEXT_EVENT.TRAINING_LOAD_TRANSITION,
  CONTEXT_EVENT.DELOAD_ACTIVE,
  CONTEXT_EVENT.INJURY_EVENT,
  CONTEXT_EVENT.ILLNESS_EVENT,
  CONTEXT_EVENT.PHARMACOLOGY_TRANSITION,
  CONTEXT_EVENT.SLEEP_DISRUPTION,
  CONTEXT_EVENT.GI_TOLERANCE_EVENT
]);

function _upper(v) {
  return typeof v === 'string' ? v.trim().toUpperCase() : v;
}

function _uniq(values) {
  var seen = Object.create(null);
  return (values || []).filter(function(v) {
    if (!v || seen[v]) return false;
    seen[v] = true;
    return true;
  });
}

function _eventSet(context) {
  var set = Object.create(null);
  var events = context && Array.isArray(context.events) ? context.events : [];
  events.forEach(function(e) { set[_upper(e)] = true; });
  return set;
}

function buildCausalContext(input) {
  input = input || {};
  var events = [];
  if (Array.isArray(input.events)) events = events.concat(input.events.map(_upper));

  var flagMap = {
    trainingLoadTransition: CONTEXT_EVENT.TRAINING_LOAD_TRANSITION,
    deloadActive: CONTEXT_EVENT.DELOAD_ACTIVE,
    injuryEvent: CONTEXT_EVENT.INJURY_EVENT,
    illnessEvent: CONTEXT_EVENT.ILLNESS_EVENT,
    pharmacologyTransition: CONTEXT_EVENT.PHARMACOLOGY_TRANSITION,
    contestManipulation: CONTEXT_EVENT.CONTEST_MANIPULATION,
    hydrationInstability: CONTEXT_EVENT.HYDRATION_INSTABILITY,
    adherenceInvalid: CONTEXT_EVENT.ADHERENCE_INVALID,
    sleepDisruption: CONTEXT_EVENT.SLEEP_DISRUPTION,
    giToleranceEvent: CONTEXT_EVENT.GI_TOLERANCE_EVENT
  };
  Object.keys(flagMap).forEach(function(k) {
    if (input[k] === true) events.push(flagMap[k]);
  });

  events = _uniq(events);
  return Object.freeze({
    events: Object.freeze(events.slice()),
    invalidatesMetabolicLearning: events.some(function(e) { return _LEARNING_CONTAMINANTS.indexOf(e) !== -1; })
  });
}

function _signal(name, raw, invalid, reasons) {
  var value = raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'value') ? raw.value : raw;
  return Object.freeze({
    signal: name,
    value: value === undefined ? null : value,
    validity: invalid ? 'INVALID_FOR_NUTRITION_INFERENCE' : 'VALID',
    reasonCodes: Object.freeze(_uniq(reasons).slice())
  });
}

/**
 * Applies causal validity without changing the observed value. Invalid means
 * "do not use this signal for this inference", not "the observation is false".
 */
function validateSignals(signals, context) {
  signals = signals || {};
  context = context || buildCausalContext({});
  var ev = _eventSet(context);

  function reasonsFor(contaminants) {
    return contaminants.filter(function(e) { return !!ev[e]; });
  }

  var weightReasons = reasonsFor(_WEIGHT_CONTAMINANTS);
  var perfReasons = reasonsFor(_PERFORMANCE_CONTAMINANTS);
  var adherenceReasons = ev[CONTEXT_EVENT.ADHERENCE_INVALID] ? [CONTEXT_EVENT.ADHERENCE_INVALID] : [];

  return Object.freeze({
    weightTrend: _signal('WEIGHT_TREND', signals.weightTrend, weightReasons.length > 0, weightReasons),
    adherenceScore: _signal('ADHERENCE_SCORE', signals.adherenceScore, adherenceReasons.length > 0, adherenceReasons),
    performanceTrend: _signal('PERFORMANCE_TREND', signals.performanceTrend, perfReasons.length > 0, perfReasons),
    biofeedbackComposite: _signal('BIOFEEDBACK_COMPOSITE', signals.biofeedbackComposite, false, [])
  });
}

function posteriorLearningGate(input) {
  input = input || {};
  var context = input.context || buildCausalContext({});
  var reasons = [];
  var adherence = _upper(input.adherence);
  var dataQuality = _upper(input.dataQuality);

  if (adherence === 'LOW' || adherence === 'INSUFFICIENT_DATA' || adherence === 'INVALID') {
    reasons.push('ADHERENCE_NOT_VALID_FOR_LEARNING');
  }
  if (dataQuality === 'CRITICAL_INVALID' || dataQuality === 'MEASUREMENT_CONFLICT' || dataQuality === 'INSUFFICIENT_DATA') {
    reasons.push('DATA_NOT_VALID_FOR_LEARNING');
  }
  if (input.observationWindowMet === false) reasons.push('MINIMUM_OBSERVATION_WINDOW_NOT_MET');
  if (context.invalidatesMetabolicLearning) reasons = reasons.concat(context.events);

  reasons = _uniq(reasons);
  return Object.freeze({
    posteriorUpdate: reasons.length === 0,
    decisionMakingAllowed: dataQuality !== 'CRITICAL_INVALID',
    freezeReasonCodes: Object.freeze(reasons.slice())
  });
}

function _proposalDomain(p) {
  return _upper(p && (p.domain || p.engine));
}

function _proposalDecision(p) {
  return _upper(p && (p.decision || p.action));
}

function _routingForProposal(p) {
  var d = _proposalDomain(p);
  if (d === 'N1-DE' || d === 'N1' || d === 'NUTRITION' || d === 'NUTRITION_ADAPTATION') return ROUTING.R4_NUTRITION_ADAPTATION;
  if (d === 'M1' || d === 'TRAINING' || d === 'TRAINING_PROGRESSION') return ROUTING.R5_TRAINING_PROGRESSION;
  if (d === 'S1' || d === 'SUPPLEMENTATION') return ROUTING.R6_SUPPLEMENTATION;
  return 99;
}

function _proposalId(p, idx) {
  return (p && (p.id || p.proposalId)) || ('proposal-' + idx);
}

function _decisionRecord(p, idx, action, reasonCodes) {
  return {
    proposalId: _proposalId(p, idx),
    domain: _proposalDomain(p) || 'UNKNOWN',
    requestedDecision: _proposalDecision(p) || null,
    routing: _routingForProposal(p),
    action: action,
    reasonCodes: _uniq(reasonCodes || [])
  };
}

function _isTrainingProgress(decision) {
  return ['PROGRESS', 'PROGRESS_VOLUME', 'INCREASE_VOLUME', 'INCREASE_LOAD', 'PROGRESS_LOAD'].indexOf(decision) !== -1;
}

function _isNutritionDecrease(decision) {
  return ['DECREASE', 'DECREASE_CALORIES', 'REVIEW_DECREASE_CALORIES'].indexOf(decision) !== -1;
}

function _isStimulantProposal(p) {
  if (!p) return false;
  if (p.stimulant === true) return true;
  var tags = Array.isArray(p.tags) ? p.tags.map(_upper) : [];
  return tags.indexOf('STIMULANT') !== -1 || tags.indexOf('STIM') !== -1;
}

/**
 * Resolve proposal collisions. Does not apply requested changes and does not
 * calculate magnitudes. Caller remains responsible for domain validators.
 */
function resolveArbitration(input) {
  input = input || {};
  var proposals = Array.isArray(input.proposals) ? input.proposals : [];
  var context = input.context || buildCausalContext({});
  var safety = _upper(input.safetyStatus || (input.safety && input.safety.status));
  var dataQuality = _upper(input.dataQuality || (input.data && input.data.status));
  var recovery = _upper(input.recoveryStatus || (input.recovery && input.recovery.status));
  var energy = _upper(input.energyAvailability || (input.nutrition && input.nutrition.energyAvailability));
  var hemodynamic = _upper(input.hemodynamicStatus || (input.safety && input.safety.hemodynamicStatus));
  var exception = input.singleMajorChangeException === true;
  var decisions = [];
  var collisions = [];

  // R0 preemption: safety always outranks performance/adaptation.
  if (safety === 'HARD_STOP') {
    proposals.forEach(function(p, i) {
      decisions.push(_decisionRecord(p, i, ACTION.BLOCK, ['BIOLOGICAL_HARD_STOP']));
    });
    return Object.freeze({
      status: ACTION.HOLD,
      collision: proposals.length > 0,
      collisionCodes: Object.freeze(proposals.length ? ['BIOLOGICAL_HARD_STOP'] : []),
      winnerAuthority: 'R0_BIOLOGICAL_SAFETY',
      decisions: Object.freeze(decisions),
      posteriorUpdateAllowed: false
    });
  }

  // R1 preemption: invalid evidence cannot justify an automatic change.
  if (dataQuality === 'CRITICAL_INVALID') {
    proposals.forEach(function(p, i) {
      decisions.push(_decisionRecord(p, i, ACTION.HOLD, ['CRITICAL_DATA_INVALID']));
    });
    return Object.freeze({
      status: ACTION.HOLD,
      collision: proposals.length > 0,
      collisionCodes: Object.freeze(['CRITICAL_DATA_INVALID']),
      winnerAuthority: 'R1_DATA_CONTRACT_INTEGRITY',
      decisions: Object.freeze(decisions),
      posteriorUpdateAllowed: false
    });
  }

  proposals.forEach(function(p, i) {
    var domain = _proposalDomain(p);
    var d = _proposalDecision(p);
    var action = ACTION.ALLOW;
    var reasons = [];

    if ((recovery === 'COMPROMISED' || recovery === 'RECOVERY_COMPROMISED') && _isNutritionDecrease(d)) {
      action = ACTION.BLOCK;
      reasons.push(COLLISION.RECOVERY_ENERGY_CONFLICT);
      collisions.push(COLLISION.RECOVERY_ENERGY_CONFLICT);
    }

    if ((energy === 'LOW' || energy === 'LOW_ENERGY_AVAILABILITY') && (domain === 'M1' || domain === 'TRAINING' || domain === 'TRAINING_PROGRESSION') && _isTrainingProgress(d)) {
      action = ACTION.BLOCK;
      reasons.push(COLLISION.TRAINING_ENERGY_AVAILABILITY_CONFLICT);
      collisions.push(COLLISION.TRAINING_ENERGY_AVAILABILITY_CONFLICT);
    }

    if ((hemodynamic === 'WARNING' || hemodynamic === 'UNSAFE' || hemodynamic === 'REVIEW') && _isStimulantProposal(p)) {
      action = ACTION.BLOCK;
      reasons.push(COLLISION.HEMODYNAMIC_STIMULANT_CONFLICT);
      collisions.push(COLLISION.HEMODYNAMIC_STIMULANT_CONFLICT);
    }

    decisions.push(_decisionRecord(p, i, action, reasons));
  });

  // Prefer one major causal intervention per cycle unless an explicit exception exists.
  var major = proposals.map(function(p, i) { return { p: p, i: i }; })
    .filter(function(x) { return x.p && x.p.majorChange === true; })
    .sort(function(a, b) { return _routingForProposal(a.p) - _routingForProposal(b.p); });

  if (major.length > 1 && !exception) {
    collisions.push(COLLISION.MULTIPLE_MAJOR_CHANGES);
    var keepId = _proposalId(major[0].p, major[0].i);
    decisions = decisions.map(function(r) {
      var isMajor = major.some(function(x) { return _proposalId(x.p, x.i) === r.proposalId; });
      if (isMajor && r.proposalId !== keepId && r.action === ACTION.ALLOW) {
        return Object.assign({}, r, { action: ACTION.HOLD, reasonCodes: r.reasonCodes.concat([COLLISION.MULTIPLE_MAJOR_CHANGES]) });
      }
      return r;
    });
  }

  var contextEvents = _eventSet(context);
  if (contextEvents[CONTEXT_EVENT.TRAINING_LOAD_TRANSITION] || contextEvents[CONTEXT_EVENT.DELOAD_ACTIVE]) {
    collisions.push(COLLISION.TRAINING_TRANSITION_WEIGHT_CONFUSION);
  }
  if (context.invalidatesMetabolicLearning) collisions.push(COLLISION.INVALID_TDEE_LEARNING_WINDOW);
  if (contextEvents[CONTEXT_EVENT.ADHERENCE_INVALID]) collisions.push(COLLISION.LOW_ADHERENCE_INFERENCE_BLOCKED);

  collisions = _uniq(collisions);
  var hasBlocked = decisions.some(function(d) { return d.action === ACTION.BLOCK; });
  var hasHeld = decisions.some(function(d) { return d.action === ACTION.HOLD; });

  return Object.freeze({
    status: hasBlocked ? ACTION.MODIFY : (hasHeld ? ACTION.HOLD : ACTION.ALLOW),
    collision: collisions.length > 0,
    collisionCodes: Object.freeze(collisions.slice()),
    winnerAuthority: hasBlocked ? 'HIGHER_PRIORITY_CONSTRAINT' : null,
    decisions: Object.freeze(decisions.map(Object.freeze)),
    posteriorUpdateAllowed: !context.invalidatesMetabolicLearning
  });
}

function crossEngineValidate(input) {
  input = input || {};
  var arbitration = input.arbitration || resolveArbitration(input);
  var errors = [];
  var warnings = [];

  if (arbitration.status === ACTION.HOLD) warnings.push('ARBITRATION_HOLD');
  arbitration.decisions.forEach(function(d) {
    if (d.action === ACTION.BLOCK) warnings.push('BLOCKED_' + d.proposalId);
  });
  if (input.numericApplyEnabled === true && arbitration.status !== ACTION.ALLOW) {
    errors.push('NUMERIC_APPLY_REQUIRES_CLEAN_ARBITRATION');
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(_uniq(errors)),
    warnings: Object.freeze(_uniq(warnings)),
    commitAllowed: errors.length === 0 && arbitration.status === ACTION.ALLOW
  });
}

module.exports = {
  ROUTING: ROUTING,
  ACTION: ACTION,
  CONTEXT_EVENT: CONTEXT_EVENT,
  COLLISION: COLLISION,
  buildCausalContext: buildCausalContext,
  validateSignals: validateSignals,
  posteriorLearningGate: posteriorLearningGate,
  resolveArbitration: resolveArbitration,
  crossEngineValidate: crossEngineValidate
};
