'use strict';

// ─── MODULE_CRITICALITY table ─────────────────────────────────────────────
// Defines how critical each field is per generation module.
// Modules: training | nutritionTargets | nutritionMenu | supplementation
// Values: REQUIRED | RECOMMENDED | OPTIONAL | NOT_REQUIRED

const MODULE_CRITICALITY = {
  // ── clientProfile.base ───────────────────────────────────────────────────
  'clientProfile.base.sexo':                  { training: 'RECOMMENDED', nutritionTargets: 'REQUIRED',     nutritionMenu: 'RECOMMENDED', supplementation: 'OPTIONAL'    },
  'clientProfile.base.edad':                  { training: 'RECOMMENDED', nutritionTargets: 'REQUIRED',     nutritionMenu: 'OPTIONAL',    supplementation: 'OPTIONAL'    },
  'clientProfile.base.peso_kg':               { training: 'RECOMMENDED', nutritionTargets: 'REQUIRED',     nutritionMenu: 'OPTIONAL',    supplementation: 'OPTIONAL'    },
  'clientProfile.base.talla_cm':              { training: 'OPTIONAL',    nutritionTargets: 'REQUIRED',     nutritionMenu: 'OPTIONAL',    supplementation: 'NOT_REQUIRED'},
  'clientProfile.base.porcentaje_grasa':      { training: 'OPTIONAL',    nutritionTargets: 'RECOMMENDED',  nutritionMenu: 'OPTIONAL',    supplementation: 'OPTIONAL'    },
  'clientProfile.base.perfil':                { training: 'REQUIRED',    nutritionTargets: 'RECOMMENDED',  nutritionMenu: 'NOT_REQUIRED',supplementation: 'REQUIRED'   },

  // ── clientProfile.entrenamiento ──────────────────────────────────────────
  'clientProfile.entrenamiento.nivel':                  { training: 'REQUIRED',    nutritionTargets: 'RECOMMENDED',  nutritionMenu: 'NOT_REQUIRED',supplementation: 'RECOMMENDED'},
  'clientProfile.entrenamiento.dias_semana':            { training: 'REQUIRED',    nutritionTargets: 'RECOMMENDED',  nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.entrenamiento.duracion_sesion_min':    { training: 'RECOMMENDED', nutritionTargets: 'OPTIONAL',     nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.entrenamiento.objetivo_mesociclo':     { training: 'REQUIRED',    nutritionTargets: 'REQUIRED',     nutritionMenu: 'NOT_REQUIRED',supplementation: 'RECOMMENDED'},
  'clientProfile.entrenamiento.lesiones':               { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.entrenamiento.semana_actual_mesociclo':{ training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},

  // ── clientProfile.biomecanica ────────────────────────────────────────────
  'clientProfile.biomecanica.biotipo':            { training: 'RECOMMENDED', nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.movilidad':          { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.patrones_fuertes':   { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.patrones_debiles':   { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.asimetrias':         { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.dolor_actual':       { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},

  // ── clientProfile.prioridades ────────────────────────────────────────────
  'clientProfile.prioridades.grupos_prioritarios':{ training: 'REQUIRED',    nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.prioridades.enfoque_actual':     { training: 'REQUIRED',    nutritionTargets: 'RECOMMENDED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.prioridades.objetivo_corto':     { training: 'RECOMMENDED', nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'OPTIONAL'   },

  // ── clientProfile.preferencias ───────────────────────────────────────────
  'clientProfile.preferencias.ejercicios_favoritos':{ training: 'OPTIONAL',  nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.preferencias.ejercicios_evitar':   { training: 'RECOMMENDED',nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.preferencias.alimentos_favoritos': { training: 'NOT_REQUIRED',nutritionTargets:'NOT_REQUIRED',nutritionMenu: 'RECOMMENDED', supplementation: 'NOT_REQUIRED'},
  'clientProfile.preferencias.alimentos_evitar':    { training: 'NOT_REQUIRED',nutritionTargets:'NOT_REQUIRED',nutritionMenu: 'RECOMMENDED', supplementation: 'NOT_REQUIRED'},

  // ── clientProfile.nutricion ──────────────────────────────────────────────
  'clientProfile.nutricion.actividad_pasos_dia':       { training: 'NOT_REQUIRED',nutritionTargets: 'RECOMMENDED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.nutricion.objetivo_calorico':          { training: 'NOT_REQUIRED',nutritionTargets: 'RECOMMENDED',nutritionMenu: 'REQUIRED',    supplementation: 'NOT_REQUIRED'},
  'clientProfile.nutricion.num_comidas':                { training: 'NOT_REQUIRED',nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'REQUIRED',   supplementation: 'NOT_REQUIRED'},
  'clientProfile.nutricion.restricciones_alimentarias': { training: 'NOT_REQUIRED',nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'REQUIRED',   supplementation: 'OPTIONAL'   },

  // ── clientProfile.suplementacion ────────────────────────────────────────
  'clientProfile.suplementacion.objetivo_primario_supp':{ training: 'NOT_REQUIRED',nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'RECOMMENDED'},
  'clientProfile.suplementacion.restricciones_suplementos':{ training:'NOT_REQUIRED',nutritionTargets:'NOT_REQUIRED',nutritionMenu:'NOT_REQUIRED',supplementation:'RECOMMENDED'},

  // ── coachEvaluation ──────────────────────────────────────────────────────
  'coachEvaluation.photoAnalysis':        { training: 'OPTIONAL',    nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.biomechanics':         { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.muscles':              { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.exercisePreferences':  { training: 'OPTIONAL',    nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.finalPriorities':      { training: 'REQUIRED',    nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.assumptions':          { training: 'OPTIONAL',    nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},

  // ── engineState ──────────────────────────────────────────────────────────
  'engineState':                          { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},

  // ── previousPlan ─────────────────────────────────────────────────────────
  'previousPlan':                         { training: 'OPTIONAL',    nutritionTargets: 'OPTIONAL',    nutritionMenu: 'OPTIONAL',    supplementation: 'NOT_REQUIRED'},

  // ── trainingLogs ─────────────────────────────────────────────────────────
  'trainingLogs':                         { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},

  // ── checkins ─────────────────────────────────────────────────────────────
  'checkins':                             { training: 'RECOMMENDED', nutritionTargets: 'RECOMMENDED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
};

// ─── vdsen-coach-evaluation-v1 ───────────────────────────────────────────────

/**
 * Validates a coach evaluation object.
 * @param {object} ev
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateCoachEvaluation(ev) {
  var errors = [];
  if (!ev || typeof ev !== 'object') {
    return { valid: false, errors: ['coachEvaluation must be a non-null object'] };
  }
  if (ev.schema && ev.schema !== 'vdsen-coach-evaluation-v1') {
    errors.push('schema must be "vdsen-coach-evaluation-v1" when present');
  }
  // finalPriorities is REQUIRED for training module — warn if absent
  if (!ev.finalPriorities) {
    errors.push('coachEvaluation.finalPriorities is required');
  }
  if (ev.photoAnalysis !== undefined && typeof ev.photoAnalysis !== 'object') {
    errors.push('coachEvaluation.photoAnalysis must be an object when present');
  }
  if (ev.muscles !== undefined && !Array.isArray(ev.muscles)) {
    errors.push('coachEvaluation.muscles must be an array when present');
  }
  if (ev.assumptions !== undefined && !Array.isArray(ev.assumptions)) {
    errors.push('coachEvaluation.assumptions must be an array when present');
  }
  return { valid: errors.length === 0, errors: errors };
}

// ─── vdsen-generation-request-v1 ────────────────────────────────────────────

var VALID_MODES   = ['FULL', 'TRAINING_ONLY', 'NUTRITION_ONLY', 'SUPPLEMENTS_ONLY', 'REPAIR'];
var VALID_OUTPUT  = ['json', 'json+text'];
var VALID_PROFILES= ['natural', 'PED'];

/**
 * Validates a generation request object.
 * @param {object} req
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateGenerationRequest(req) {
  var errors   = [];
  var warnings = [];

  if (!req || typeof req !== 'object') {
    return { valid: false, errors: ['request must be a non-null object'], warnings: [] };
  }

  // schema
  if (req.schema !== 'vdsen-generation-request-v1') {
    errors.push('schema must be "vdsen-generation-request-v1"');
  }

  // requestId (optional but recommended)
  if (!req.requestId) {
    warnings.push('requestId is recommended for traceability');
  }

  // mode
  if (!req.mode) {
    errors.push('mode is required');
  } else if (VALID_MODES.indexOf(req.mode) === -1) {
    errors.push('mode must be one of: ' + VALID_MODES.join(', '));
  }

  // outputMode (optional, default json)
  if (req.outputMode && VALID_OUTPUT.indexOf(req.outputMode) === -1) {
    errors.push('outputMode must be one of: ' + VALID_OUTPUT.join(', '));
  }

  // clientProfile
  if (!req.clientProfile || typeof req.clientProfile !== 'object') {
    errors.push('clientProfile is required and must be an object');
  } else {
    var cp = req.clientProfile;
    var base = cp.base || {};

    // perfil
    if (!base.perfil) {
      errors.push('clientProfile.base.perfil is required');
    } else if (VALID_PROFILES.indexOf(base.perfil) === -1) {
      errors.push('clientProfile.base.perfil must be "natural" or "PED"');
    }

    // PED → farmacologia required
    if (base.perfil === 'PED' && (!cp.farmacologia || typeof cp.farmacologia !== 'object')) {
      warnings.push('clientProfile.farmacologia is recommended when perfil=PED');
    }

    // entrenamiento
    var ent = cp.entrenamiento || {};
    if (!ent.nivel) {
      errors.push('clientProfile.entrenamiento.nivel is required');
    }
    if (!ent.objetivo_mesociclo) {
      errors.push('clientProfile.entrenamiento.objetivo_mesociclo is required');
    }
    if (!ent.dias_semana) {
      errors.push('clientProfile.entrenamiento.dias_semana is required');
    } else if (typeof ent.dias_semana !== 'number' || ent.dias_semana < 1 || ent.dias_semana > 7) {
      errors.push('clientProfile.entrenamiento.dias_semana must be a number 1-7');
    }

    // prioridades
    var prio = cp.prioridades || {};
    if (!prio.grupos_prioritarios || !Array.isArray(prio.grupos_prioritarios) || prio.grupos_prioritarios.length === 0) {
      errors.push('clientProfile.prioridades.grupos_prioritarios is required (non-empty array)');
    }
    if (!prio.enfoque_actual) {
      errors.push('clientProfile.prioridades.enfoque_actual is required');
    }

    // warnings for recommended fields
    if (!base.sexo)           warnings.push('clientProfile.base.sexo is recommended');
    if (!base.edad)           warnings.push('clientProfile.base.edad is recommended');
    if (!base.peso_kg)        warnings.push('clientProfile.base.peso_kg is recommended');
    if (!base.talla_cm)       warnings.push('clientProfile.base.talla_cm is recommended for nutritionTargets');
  }

  // coachEvaluation (optional but REQUIRED.finalPriorities for training)
  if (req.coachEvaluation !== undefined) {
    var evResult = validateCoachEvaluation(req.coachEvaluation);
    evResult.errors.forEach(function(e) { errors.push(e); });
  } else {
    warnings.push('coachEvaluation is recommended; finalPriorities used by training module');
  }

  // restrictions (optional)
  if (req.restrictions !== undefined && typeof req.restrictions !== 'object') {
    errors.push('restrictions must be an object when present');
  }

  // musclePriorities (optional)
  if (req.musclePriorities !== undefined && !Array.isArray(req.musclePriorities)) {
    errors.push('musclePriorities must be an array when present');
  }

  // equipment (optional)
  if (req.equipment !== undefined && !Array.isArray(req.equipment)) {
    errors.push('equipment must be an array when present');
  }

  // options (optional)
  if (req.options !== undefined && typeof req.options !== 'object') {
    errors.push('options must be an object when present');
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

// ─── vdsen-generation-response-v1 ───────────────────────────────────────────

var VALID_STATUSES      = ['VALID', 'NEEDS_INPUT', 'NEEDS_COACH_REVIEW', 'INVALID', 'ERROR'];
var VALID_MOD_STATUSES  = ['OK', 'SKIPPED', 'PARTIAL', 'FAILED', 'NOT_REQUESTED'];

/**
 * Validates a generation response object.
 * @param {object} resp
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateGenerationResponse(resp) {
  var errors   = [];
  var warnings = [];

  if (!resp || typeof resp !== 'object') {
    return { valid: false, errors: ['response must be a non-null object'], warnings: [] };
  }

  // schema
  if (resp.schema !== 'vdsen-generation-response-v1') {
    errors.push('schema must be "vdsen-generation-response-v1"');
  }

  // status
  if (!resp.status) {
    errors.push('status is required');
  } else if (VALID_STATUSES.indexOf(resp.status) === -1) {
    errors.push('status must be one of: ' + VALID_STATUSES.join(', '));
  }

  // requestId echo (recommended)
  if (!resp.requestId) {
    warnings.push('requestId should echo the original request id');
  }

  // generatedAt
  if (!resp.generatedAt) {
    warnings.push('generatedAt timestamp is recommended');
  }

  // plan — required when status=VALID
  if (resp.status === 'VALID') {
    if (!resp.plan || typeof resp.plan !== 'object') {
      errors.push('plan is required when status=VALID');
    } else if (resp.plan.schema !== 'vdsen-plan-v2') {
      errors.push('plan.schema must be "vdsen-plan-v2"');
    }
  }

  // missingFields — required when status=NEEDS_INPUT
  if (resp.status === 'NEEDS_INPUT') {
    if (!Array.isArray(resp.missingFields) || resp.missingFields.length === 0) {
      errors.push('missingFields (non-empty array) is required when status=NEEDS_INPUT');
    }
  }

  // moduleStatus (optional but recommended)
  if (resp.moduleStatus !== undefined) {
    if (typeof resp.moduleStatus !== 'object') {
      errors.push('moduleStatus must be an object when present');
    } else {
      var modules = ['training', 'nutritionTargets', 'nutritionMenu', 'supplementation'];
      modules.forEach(function(m) {
        if (resp.moduleStatus[m] !== undefined && VALID_MOD_STATUSES.indexOf(resp.moduleStatus[m]) === -1) {
          errors.push('moduleStatus.' + m + ' must be one of: ' + VALID_MOD_STATUSES.join(', '));
        }
      });
    }
  } else {
    warnings.push('moduleStatus is recommended for per-module tracking');
  }

  // errors array (required when status=ERROR or INVALID)
  if ((resp.status === 'ERROR' || resp.status === 'INVALID') && !Array.isArray(resp.errors)) {
    errors.push('errors array is required when status=ERROR or INVALID');
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  MODULE_CRITICALITY:           MODULE_CRITICALITY,
  validateCoachEvaluation:      validateCoachEvaluation,
  validateGenerationRequest:    validateGenerationRequest,
  validateGenerationResponse:   validateGenerationResponse,
};
