'use strict';

// ─── MODULE_CRITICALITY table ─────────────────────────────────────────────────
// "¿Qué tan necesario es este INPUT para generar este módulo?"
// Módulos: training | nutritionTargets | nutritionMenu | supplementation
// Valores: REQUIRED | RECOMMENDED | OPTIONAL | NOT_REQUIRED
// NOTA: estos valores son completamente distintos de moduleStatus.
// MODULE_CRITICALITY responde al INPUT; moduleStatus responde al ESTADO del módulo.

const MODULE_CRITICALITY = {
  // ── clientProfile.base ────────────────────────────────────────────────────
  'clientProfile.base.sexo':                   { training: 'RECOMMENDED', nutritionTargets: 'REQUIRED',    nutritionMenu: 'RECOMMENDED', supplementation: 'OPTIONAL'    },
  'clientProfile.base.edad':                   { training: 'RECOMMENDED', nutritionTargets: 'REQUIRED',    nutritionMenu: 'OPTIONAL',    supplementation: 'OPTIONAL'    },
  'clientProfile.base.peso_kg':                { training: 'RECOMMENDED', nutritionTargets: 'REQUIRED',    nutritionMenu: 'OPTIONAL',    supplementation: 'OPTIONAL'    },
  'clientProfile.base.talla_cm':               { training: 'OPTIONAL',    nutritionTargets: 'REQUIRED',    nutritionMenu: 'OPTIONAL',    supplementation: 'NOT_REQUIRED'},
  'clientProfile.base.porcentaje_grasa':       { training: 'OPTIONAL',    nutritionTargets: 'RECOMMENDED', nutritionMenu: 'OPTIONAL',    supplementation: 'OPTIONAL'    },
  'clientProfile.base.perfil':                 { training: 'REQUIRED',    nutritionTargets: 'RECOMMENDED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'REQUIRED'   },

  // ── clientProfile.entrenamiento ───────────────────────────────────────────
  'clientProfile.entrenamiento.nivel':                   { training: 'REQUIRED',    nutritionTargets: 'RECOMMENDED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'RECOMMENDED'},
  'clientProfile.entrenamiento.dias_semana':             { training: 'REQUIRED',    nutritionTargets: 'RECOMMENDED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.entrenamiento.duracion_sesion_min':     { training: 'RECOMMENDED', nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.entrenamiento.objetivo_mesociclo':      { training: 'REQUIRED',    nutritionTargets: 'REQUIRED',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'RECOMMENDED'},
  'clientProfile.entrenamiento.lesiones':                { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.entrenamiento.semana_actual_mesociclo': { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},

  // ── clientProfile.biomecanica ─────────────────────────────────────────────
  'clientProfile.biomecanica.biotipo':          { training: 'RECOMMENDED', nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.movilidad':        { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.patrones_fuertes': { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.patrones_debiles': { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.asimetrias':       { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.biomecanica.dolor_actual':     { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},

  // ── clientProfile.prioridades ─────────────────────────────────────────────
  'clientProfile.prioridades.grupos_prioritarios': { training: 'REQUIRED',    nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.prioridades.enfoque_actual':      { training: 'REQUIRED',    nutritionTargets: 'RECOMMENDED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.prioridades.objetivo_corto':      { training: 'RECOMMENDED', nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'OPTIONAL'   },

  // ── clientProfile.preferencias ────────────────────────────────────────────
  'clientProfile.preferencias.ejercicios_favoritos': { training: 'OPTIONAL',     nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.preferencias.ejercicios_evitar':    { training: 'RECOMMENDED',  nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.preferencias.alimentos_favoritos':  { training: 'NOT_REQUIRED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'RECOMMENDED', supplementation: 'NOT_REQUIRED'},
  'clientProfile.preferencias.alimentos_evitar':     { training: 'NOT_REQUIRED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'RECOMMENDED', supplementation: 'NOT_REQUIRED'},

  // ── clientProfile.nutricion ───────────────────────────────────────────────
  'clientProfile.nutricion.actividad_pasos_dia':        { training: 'NOT_REQUIRED',nutritionTargets: 'RECOMMENDED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'clientProfile.nutricion.objetivo_calorico':           { training: 'NOT_REQUIRED',nutritionTargets: 'RECOMMENDED', nutritionMenu: 'REQUIRED',    supplementation: 'NOT_REQUIRED'},
  'clientProfile.nutricion.num_comidas':                 { training: 'NOT_REQUIRED',nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'REQUIRED',    supplementation: 'NOT_REQUIRED'},
  'clientProfile.nutricion.restricciones_alimentarias':  { training: 'NOT_REQUIRED',nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'REQUIRED',    supplementation: 'OPTIONAL'   },

  // ── clientProfile.suplementacion ──────────────────────────────────────────
  'clientProfile.suplementacion.objetivo_primario_supp':    { training: 'NOT_REQUIRED',nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'RECOMMENDED'},
  'clientProfile.suplementacion.restricciones_suplementos': { training: 'NOT_REQUIRED',nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'RECOMMENDED'},

  // ── coachEvaluation ───────────────────────────────────────────────────────
  'coachEvaluation.photoAnalysis':       { training: 'OPTIONAL',    nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.biomechanics':        { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.muscles':             { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.exercisePreferences': { training: 'OPTIONAL',    nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.finalPriorities':     { training: 'REQUIRED',    nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'coachEvaluation.assumptions':         { training: 'OPTIONAL',    nutritionTargets: 'OPTIONAL',    nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},

  // ── contexto temporal / histórico ─────────────────────────────────────────
  'engineState':  { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'previousPlan': { training: 'OPTIONAL',    nutritionTargets: 'OPTIONAL',    nutritionMenu: 'OPTIONAL',    supplementation: 'NOT_REQUIRED'},
  'trainingLogs': { training: 'RECOMMENDED', nutritionTargets: 'NOT_REQUIRED',nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
  'checkins':     { training: 'RECOMMENDED', nutritionTargets: 'RECOMMENDED', nutritionMenu: 'NOT_REQUIRED',supplementation: 'NOT_REQUIRED'},
};

// ─── Belt Squat — PENDING_CANONICAL_CATALOG_UPDATE ────────────────────────────
// Actualmente solo aparece en regex keyword de auditFractionalVolume() ~línea 620.
// NO está en _EXERCISE_CANONICAL_METADATA (42 entradas).
// Pendiente de agregar en fase posterior con estos valores:
var BELT_SQUAT_PENDING = {
  status:            'PENDING_CANONICAL_CATALOG_UPDATE',
  name:              'Belt Squat',
  primaryMuscles:    ['cuadriceps'],
  secondaryMuscles:  ['gluteos'],
  stabilizers:       ['abdomen', 'erectores'],
  movementPattern:   'sentadilla_maquina',
  resistanceProfile: 'BP',
  longLengthBias:    true,
  stability:         'high',
  nivel_medio_default: 'fundamental',
  fractional: { cuadriceps: 1.0, gluteos: 0.5, stabilizers: 0 }
};

// ─── vdsen-coach-evaluation-v1 ────────────────────────────────────────────────
// muscles[] formato actual: array de strings con nombre canónico del músculo.
// Ventajas: simple, sin overhead, compatible con _EXERCISE_CANONICAL_METADATA keys.
// Inconvenientes: no incluye lateralidad, no distingue cabezas.
// Para identificación inequívoca → usar los mismos keys de primaryMuscles del catálogo.
// Ejemplo: ['cuadriceps', 'gluteos', 'hamstrings']
// Migración pendiente si se requiere lateralidad o cabezas → reportar antes de cambiar.

/**
 * Validates a coach evaluation object (vdsen-coach-evaluation-v1).
 * Kept strictly SEPARATE from clientProfile — never merge these objects.
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

// ─── vdsen-generation-request-v1 ─────────────────────────────────────────────

// ── Enums ────────────────────────────────────────────────────────────────────
// NOTA sobre módulos no solicitados: cuando no se requiere un módulo,
// NO inventar estado nuevo en moduleStatus. En su lugar usar
// options.requestedModules[] en el request. El módulo ausente de
// moduleStatus se interpreta como no solicitado/no ejecutado.

var VALID_MODES    = ['new_plan', 'update_plan', 'audit_plan'];
var VALID_OUTPUT   = ['json', 'txt', 'pdf', 'all'];
var VALID_PROFILES = ['natural', 'PED'];

/**
 * Validates a generation request (vdsen-generation-request-v1).
 * @param {object} req
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateGenerationRequest(req) {
  var errors   = [];
  var warnings = [];

  if (!req || typeof req !== 'object') {
    return { valid: false, errors: ['request must be a non-null object'], warnings: [] };
  }

  if (req.schema !== 'vdsen-generation-request-v1') {
    errors.push('schema must be "vdsen-generation-request-v1"');
  }

  if (!req.requestId) {
    warnings.push('requestId is recommended for traceability');
  }

  // mode — congelado: new_plan | update_plan | audit_plan
  if (!req.mode) {
    errors.push('mode is required');
  } else if (VALID_MODES.indexOf(req.mode) === -1) {
    errors.push('mode must be one of: ' + VALID_MODES.join(', '));
  }

  // outputMode — congelado: json | txt | pdf | all
  if (req.outputMode !== undefined && VALID_OUTPUT.indexOf(req.outputMode) === -1) {
    errors.push('outputMode must be one of: ' + VALID_OUTPUT.join(', '));
  }

  // clientProfile
  if (!req.clientProfile || typeof req.clientProfile !== 'object') {
    errors.push('clientProfile is required and must be an object');
  } else {
    var cp   = req.clientProfile;
    var base = cp.base || {};

    if (!base.perfil) {
      errors.push('clientProfile.base.perfil is required');
    } else if (VALID_PROFILES.indexOf(base.perfil) === -1) {
      errors.push('clientProfile.base.perfil must be "natural" or "PED"');
    }

    if (base.perfil === 'PED' && (!cp.farmacologia || typeof cp.farmacologia !== 'object')) {
      warnings.push('clientProfile.farmacologia is recommended when perfil=PED');
    }

    var ent = cp.entrenamiento || {};
    if (!ent.nivel)              errors.push('clientProfile.entrenamiento.nivel is required');
    if (!ent.objetivo_mesociclo) errors.push('clientProfile.entrenamiento.objetivo_mesociclo is required');
    if (!ent.dias_semana) {
      errors.push('clientProfile.entrenamiento.dias_semana is required');
    } else if (typeof ent.dias_semana !== 'number' || ent.dias_semana < 1 || ent.dias_semana > 7) {
      errors.push('clientProfile.entrenamiento.dias_semana must be a number 1-7');
    }

    var prio = cp.prioridades || {};
    if (!prio.grupos_prioritarios || !Array.isArray(prio.grupos_prioritarios) || prio.grupos_prioritarios.length === 0) {
      errors.push('clientProfile.prioridades.grupos_prioritarios is required (non-empty array)');
    }
    if (!prio.enfoque_actual) errors.push('clientProfile.prioridades.enfoque_actual is required');

    if (!base.sexo)    warnings.push('clientProfile.base.sexo is recommended');
    if (!base.edad)    warnings.push('clientProfile.base.edad is recommended');
    if (!base.peso_kg) warnings.push('clientProfile.base.peso_kg is recommended');
    if (!base.talla_cm)warnings.push('clientProfile.base.talla_cm is recommended for nutritionTargets');
  }

  if (req.coachEvaluation !== undefined) {
    validateCoachEvaluation(req.coachEvaluation).errors.forEach(function(e) { errors.push(e); });
  } else {
    warnings.push('coachEvaluation is recommended; finalPriorities used by training module');
  }

  if (req.restrictions    !== undefined && typeof req.restrictions    !== 'object') errors.push('restrictions must be an object when present');
  if (req.musclePriorities!== undefined && !Array.isArray(req.musclePriorities))   errors.push('musclePriorities must be an array when present');
  if (req.equipment       !== undefined && !Array.isArray(req.equipment))           errors.push('equipment must be an array when present');
  if (req.options         !== undefined && typeof req.options         !== 'object') errors.push('options must be an object when present');

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

// ─── vdsen-generation-response-v1 ────────────────────────────────────────────

var VALID_STATUSES     = ['VALID', 'NEEDS_INPUT', 'NEEDS_COACH_REVIEW', 'INVALID', 'ERROR'];
// Módulos no solicitados: ausentes de moduleStatus (no usar un 5.º valor).
var VALID_MOD_STATUSES = ['READY', 'NEEDS_INPUT', 'NEEDS_COACH_REVIEW', 'INVALID'];

// Campos raíz permitidos en la respuesta (fuente de verdad).
// No introducir campos raíz adicionales sin reportar primero.
var ALLOWED_RESPONSE_ROOT = [
  'schema', 'requestId', 'status', 'moduleStatus', 'model',
  'generatedAt', 'plan', 'audit', 'decisionTrace',
  'missingInputs', 'warnings', 'errors', 'documents'
];

// Campos prohibidos dentro de plan — plan es la fuente de verdad fisiológica,
// no debe contener metadatos de respuesta ni de motor.
var FORBIDDEN_PLAN_FIELDS = [
  'audit', 'decisionTrace', 'targets', 'moduleStatus',
  'warnings', 'errors', 'model', 'requestId', 'generatedAt', 'documents'
];

/**
 * Validates a generation response (vdsen-generation-response-v1).
 * @param {object} resp
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateGenerationResponse(resp) {
  var errors   = [];
  var warnings = [];

  if (!resp || typeof resp !== 'object') {
    return { valid: false, errors: ['response must be a non-null object'], warnings: [] };
  }

  if (resp.schema !== 'vdsen-generation-response-v1') {
    errors.push('schema must be "vdsen-generation-response-v1"');
  }

  if (!resp.status) {
    errors.push('status is required');
  } else if (VALID_STATUSES.indexOf(resp.status) === -1) {
    errors.push('status must be one of: ' + VALID_STATUSES.join(', '));
  }

  if (!resp.requestId)   warnings.push('requestId should echo the original request id');
  if (!resp.generatedAt) warnings.push('generatedAt timestamp is recommended');

  // plan — requerido cuando status=VALID; permitido (null/absent) en otros estados
  if (resp.status === 'VALID') {
    if (!resp.plan || typeof resp.plan !== 'object') {
      errors.push('plan is required when status=VALID');
    } else {
      if (resp.plan.schema !== 'vdsen-plan-v2') {
        errors.push('plan.schema must be "vdsen-plan-v2"');
      }
      // plan no debe contener metadatos de respuesta
      FORBIDDEN_PLAN_FIELDS.forEach(function(f) {
        if (Object.prototype.hasOwnProperty.call(resp.plan, f)) {
          errors.push('plan must not contain field "' + f + '" (response/engine metadata)');
        }
      });
    }
  }

  // missingInputs — requerido cuando status=NEEDS_INPUT
  if (resp.status === 'NEEDS_INPUT') {
    if (!Array.isArray(resp.missingInputs) || resp.missingInputs.length === 0) {
      errors.push('missingInputs (non-empty array) is required when status=NEEDS_INPUT');
    }
  }

  // moduleStatus
  if (resp.moduleStatus !== undefined) {
    if (typeof resp.moduleStatus !== 'object') {
      errors.push('moduleStatus must be an object when present');
    } else {
      var modules = ['training', 'nutritionTargets', 'nutritionMenu', 'supplementation'];
      modules.forEach(function(m) {
        var val = resp.moduleStatus[m];
        if (val !== undefined && val !== null && VALID_MOD_STATUSES.indexOf(val) === -1) {
          errors.push('moduleStatus.' + m + ' must be one of: ' + VALID_MOD_STATUSES.join(', '));
        }
      });
    }
  } else {
    warnings.push('moduleStatus is recommended for per-module tracking');
  }

  // errors array — requerido cuando status=ERROR o INVALID
  if ((resp.status === 'ERROR' || resp.status === 'INVALID') && !Array.isArray(resp.errors)) {
    errors.push('errors array is required when status=ERROR or INVALID');
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  MODULE_CRITICALITY:           MODULE_CRITICALITY,
  BELT_SQUAT_PENDING:           BELT_SQUAT_PENDING,
  VALID_MODES:                  VALID_MODES,
  VALID_OUTPUT:                 VALID_OUTPUT,
  VALID_MOD_STATUSES:           VALID_MOD_STATUSES,
  ALLOWED_RESPONSE_ROOT:        ALLOWED_RESPONSE_ROOT,
  FORBIDDEN_PLAN_FIELDS:        FORBIDDEN_PLAN_FIELDS,
  validateCoachEvaluation:      validateCoachEvaluation,
  validateGenerationRequest:    validateGenerationRequest,
  validateGenerationResponse:   validateGenerationResponse,
};
