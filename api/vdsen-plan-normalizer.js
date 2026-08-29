'use strict';

// VDSEN Plan Normalizer v1.0
// Resolves canonical vdsen-plan-v2 (entrenamiento.days) and legacy root-days formats.
// Pure structural resolution — never modifies prescriptive content (loads, reps, RIR, etc.).

var VALID_NIVEL_MEDIO = ['fundamental', 'suplementario', 'asistencia_mayor', 'asistencia_secundario'];

var ERROR_CODES = {
  PLAN_NOT_OBJECT:            'PLAN_NOT_OBJECT',
  INVALID_SCHEMA:             'INVALID_SCHEMA',
  MISSING_TRAINING:           'MISSING_TRAINING',
  EMPTY_DAYS:                 'EMPTY_DAYS',
  DAY_WITHOUT_EXERCISES:      'DAY_WITHOUT_EXERCISES',
  EXERCISE_WITHOUT_SETS:      'EXERCISE_WITHOUT_SETS',
  INVALID_NIVEL_MEDIO:        'INVALID_NIVEL_MEDIO',
  INVALID_VARIACION_VERTICAL: 'INVALID_VARIACION_VERTICAL',
  INVALID_SET:                'INVALID_SET',
  INVALID_LOAD:               'INVALID_LOAD',
  MISSING_NUTRITION:          'MISSING_NUTRITION',
  MISSING_SUPPLEMENTATION:    'MISSING_SUPPLEMENTATION'
};

var KNOWN_WRAPPERS        = ['plan', 'data', 'result', 'response', 'generation', 'output'];
var NUTRITION_ALIASES     = ['nutricion', 'nutrition'];
var SUPPLEMENTATION_ALIASES = ['suplementacion', 'supplementation'];

// Unwrap one level of container key if the object has a single recognized wrapper.
function _unwrap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  for (var i = 0; i < KNOWN_WRAPPERS.length; i++) {
    var key = KNOWN_WRAPPERS[i];
    if (Object.prototype.hasOwnProperty.call(input, key) &&
        input[key] && typeof input[key] === 'object' && !Array.isArray(input[key])) {
      return input[key];
    }
  }
  return input;
}

// Canonical: obj.entrenamiento.days  |  Legacy: obj.days
function _resolveTraining(obj) {
  if (obj.entrenamiento && typeof obj.entrenamiento === 'object' &&
      Array.isArray(obj.entrenamiento.days)) {
    return obj.entrenamiento;
  }
  if (Array.isArray(obj.days)) {
    return obj;
  }
  return null;
}

function _resolveNutrition(obj) {
  for (var i = 0; i < NUTRITION_ALIASES.length; i++) {
    var v = obj[NUTRITION_ALIASES[i]];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

function _resolveSupplementation(obj) {
  for (var i = 0; i < SUPPLEMENTATION_ALIASES.length; i++) {
    var v = obj[SUPPLEMENTATION_ALIASES[i]];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

/**
 * normalizeVdsenPlan(input)
 *
 * Accepts any vdsen plan variant (canonical, legacy root-days, wrapped).
 * Returns { ok: true, plan: {days, weeks, daysPerWeek, nutricion?, suplementacion?, ...} }
 *      or { ok: false, error: ERROR_CODE, message: string }
 *
 * The returned plan.days is the raw days array from the training block.
 * Structural field normalization (setIndex defaults etc.) is handled by
 * _normalizeTrainingPlan in the app; this function only resolves location.
 */
function normalizeVdsenPlan(input) {
  var obj = _unwrap(input);

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: ERROR_CODES.PLAN_NOT_OBJECT, message: 'El plan debe ser un objeto JSON' };
  }

  if (obj.schema !== undefined && obj.schema !== 'vdsen-plan-v2' && obj.schema !== 'vdsen-plan-v1') {
    return { ok: false, error: ERROR_CODES.INVALID_SCHEMA, message: 'Schema desconocido: ' + obj.schema };
  }

  var training = _resolveTraining(obj);
  if (!training) {
    return { ok: false, error: ERROR_CODES.MISSING_TRAINING,
             message: 'No se encontró bloque de entrenamiento (entrenamiento.days o days en raíz)' };
  }

  if (!Array.isArray(training.days) || training.days.length === 0) {
    return { ok: false, error: ERROR_CODES.EMPTY_DAYS, message: 'El plan no tiene días de entrenamiento (days vacío)' };
  }

  var weeksRaw      = training.weeks      != null ? training.weeks      : obj.weeks;
  var dpwRaw        = training.daysPerWeek != null ? training.daysPerWeek : obj.daysPerWeek;
  var normalized = {
    weeks:       parseInt(weeksRaw)  || 6,
    daysPerWeek: parseInt(dpwRaw)    || training.days.length,
    days:        training.days
  };

  // Preserve optional metadata from root (or training block for legacy root-days)
  var META_FIELDS = ['carb_cycling_y3t', 'rirByWeek', 'reverse_diet', 'distribucion_zonas_carga'];
  META_FIELDS.forEach(function(f) {
    if (obj[f] !== undefined)                         normalized[f] = obj[f];
    else if (training !== obj && training[f] !== undefined) normalized[f] = training[f];
  });

  var nutricion      = _resolveNutrition(obj);
  var suplementacion = _resolveSupplementation(obj);
  if (nutricion)       normalized.nutricion      = nutricion;
  if (suplementacion)  normalized.suplementacion = suplementacion;
  if (obj.farmacologia && typeof obj.farmacologia === 'object') normalized.farmacologia = obj.farmacologia;

  return { ok: true, plan: normalized };
}

/**
 * validateVdsenPlan(normalized)
 *
 * Validates structure of a plan object (already normalized or raw Firestore plan).
 * Returns { ok: true } or { ok: false, error: ERROR_CODE, message: string }
 *
 * Never modifies prescriptions (loads, reps, RIR, exercises).
 */
function validateVdsenPlan(normalized) {
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return { ok: false, error: ERROR_CODES.PLAN_NOT_OBJECT, message: 'El plan normalizado debe ser un objeto' };
  }

  if (!Array.isArray(normalized.days) || normalized.days.length === 0) {
    return { ok: false, error: ERROR_CODES.EMPTY_DAYS, message: 'El plan no tiene días de entrenamiento' };
  }

  for (var di = 0; di < normalized.days.length; di++) {
    var day = normalized.days[di];
    if (!day || !Array.isArray(day.exercises) || day.exercises.length === 0) {
      return { ok: false, error: ERROR_CODES.DAY_WITHOUT_EXERCISES,
               message: 'Día ' + (di + 1) + ' no tiene ejercicios' };
    }
    for (var ei = 0; ei < day.exercises.length; ei++) {
      var ex = day.exercises[ei];
      if (!Array.isArray(ex.sets) || ex.sets.length === 0) {
        return { ok: false, error: ERROR_CODES.EXERCISE_WITHOUT_SETS,
                 message: 'Ejercicio "' + (ex.exerciseName || '?') + '" no tiene series' };
      }
      if (ex.nivel_medio !== undefined && ex.nivel_medio !== null &&
          VALID_NIVEL_MEDIO.indexOf(ex.nivel_medio) === -1) {
        return { ok: false, error: ERROR_CODES.INVALID_NIVEL_MEDIO,
                 message: 'nivel_medio inválido: ' + ex.nivel_medio };
      }
      if (ex.variacion_vertical !== undefined && ex.variacion_vertical !== null) {
        if (typeof ex.variacion_vertical !== 'object' || Array.isArray(ex.variacion_vertical)) {
          return { ok: false, error: ERROR_CODES.INVALID_VARIACION_VERTICAL,
                   message: 'variacion_vertical debe ser un objeto en "' + (ex.exerciseName || '?') + '"' };
        }
      }
      for (var si = 0; si < ex.sets.length; si++) {
        var s = ex.sets[si];
        if (!s || typeof s !== 'object') {
          return { ok: false, error: ERROR_CODES.INVALID_SET,
                   message: 'Set ' + si + ' inválido en "' + (ex.exerciseName || '?') + '"' };
        }
        if (s.load !== undefined && s.load !== null && s.load !== 0 &&
            typeof s.load !== 'number') {
          return { ok: false, error: ERROR_CODES.INVALID_LOAD,
                   message: 'load debe ser número (o 0) en "' + (ex.exerciseName || '?') + '" set ' + si };
        }
      }
    }
  }

  return { ok: true };
}

module.exports = {
  normalizeVdsenPlan:  normalizeVdsenPlan,
  validateVdsenPlan:   validateVdsenPlan,
  VALID_NIVEL_MEDIO:   VALID_NIVEL_MEDIO,
  ERROR_CODES:         ERROR_CODES
};
