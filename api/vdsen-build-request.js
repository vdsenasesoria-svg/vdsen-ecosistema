'use strict';

/**
 * VDSEN Generation Request Adapter — buildGenerationRequest()
 *
 * Converts real VDSEN/Firebase data into vdsen-generation-request-v1.
 * Principle: READ → NORMALIZE → MAP → VALIDATE → RETURN.
 * Does NOT prescribe, decide, recalculate, or invent missing information.
 *
 * Data sources (confirmed by code audit of vdsen-coach.html):
 *   fichas_onboarding/{clientId}  → { schemaVersion, data:{...INTAKE_SCHEMA fields...},
 *                                      fotometria:{...}, updatedAt, updatedBy }
 *   clients/{clientId}            → { activePlanId, coachId, displayName, email, ... }
 *   plans/{activePlanId}          → { weeks, daysPerWeek, days:[...], coachId, clientId, ... }
 *   logs/{clientId}               → { entries: {
 *                                       log_W_D_E_sS, done_W_D, postsession_W_D,
 *                                       progrec_W_D, ci_sem_W, engine_state
 *                                     }, currentWeek }
 *
 * Firestore layout is NOT modified by this file.
 */

var contracts = require('./vdsen-contracts');
var validateGenerationRequest = contracts.validateGenerationRequest;
var MODULE_CRITICALITY        = contracts.MODULE_CRITICALITY;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _uuid() {
  // Simple time-based unique id — no sensitive data encoded.
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function _present(v) {
  // True when a value meaningfully exists (not null/undefined/""/[]).
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function _pick(obj, keys) {
  // Return object with only present keys.
  var out = {};
  keys.forEach(function(k) {
    if (_present(obj[k])) out[k] = obj[k];
  });
  return out;
}

// ─── CLIENT PROFILE mapping ───────────────────────────────────────────────────
// Source: fichas_onboarding/{clientId}.data (flat object, INTAKE_SCHEMA fields)
// collectIntake() in coach flattens all section fields into one object.

function _mapClientProfile(fichaData, clientDoc) {
  var fd = fichaData || {};

  // base
  var base = _pick(fd, ['nombre', 'sexo', 'edad', 'peso_kg', 'talla_cm', 'porcentaje_grasa', 'perfil']);
  // perfil may also be stored at fd.base.perfil in legacy vdsen-ficha-v2 format
  if (!base.perfil && fd.base && _present(fd.base.perfil)) base.perfil = fd.base.perfil;
  // normalize: default to 'natural' only when stored value is not present
  // (not invented — this is what the UI default shows per INTAKE_SCHEMA)
  // We preserve absence explicitly for the validator to catch.

  // entrenamiento
  var ent = _pick(fd, ['nivel','dias_semana','duracion_sesion_min','gimnasio',
                        'objetivo_mesociclo','lesiones','semana_actual_mesociclo',
                        'gimnasio_otro_maquinas']);

  // biomecanica — client-stated, NOT coach evaluation
  var bio = _pick(fd, ['biotipo','movilidad','patrones_fuertes','patrones_debiles',
                        'asimetrias','postura','dolor_actual']);

  // prioridades
  var prio = {};
  // grupos_prioritarios: INTAKE_SCHEMA stores this as textarea (string).
  // Normalize string → array here (READ+NORMALIZE, not invention).
  var _normGroups = function(v) {
    if (!_present(v)) return null;
    if (Array.isArray(v)) return v.filter(Boolean).map(function(x){ return String(x).trim(); });
    if (typeof v === 'string') return v.split(/[,\n]/).map(function(x){ return x.trim(); }).filter(Boolean);
    return null;
  };
  var _gp = _normGroups(fd.grupos_prioritarios);
  if (_gp && _gp.length) prio.grupos_prioritarios = _gp;
  if (_present(fd.enfoque_actual))  prio.enfoque_actual  = fd.enfoque_actual;
  if (_present(fd.objetivo_corto))  prio.objetivo_corto  = fd.objetivo_corto;
  if (_present(fd.evento_objetivo)) prio.evento_objetivo = fd.evento_objetivo;
  // Also check nested prioridades object (legacy vdsen-ficha-v2 format)
  if (fd.prioridades && typeof fd.prioridades === 'object') {
    if (!_present(prio.grupos_prioritarios)) {
      var _gp2 = _normGroups(fd.prioridades.grupos_prioritarios);
      if (_gp2 && _gp2.length) prio.grupos_prioritarios = _gp2;
    }
    if (!_present(prio.enfoque_actual)  && _present(fd.prioridades.enfoque_actual))  prio.enfoque_actual  = fd.prioridades.enfoque_actual;
    if (!_present(prio.objetivo_corto)  && _present(fd.prioridades.objetivo_corto))  prio.objetivo_corto  = fd.prioridades.objetivo_corto;
    if (!_present(prio.evento_objetivo) && _present(fd.prioridades.evento_objetivo)) prio.evento_objetivo = fd.prioridades.evento_objetivo;
  }

  // preferencias
  var pref = _pick(fd, ['ejercicios_favoritos','ejercicios_evitar',
                          'estilo_entreno','alimentos_favoritos',
                          'alimentos_evitar','disponibilidad']);

  // nutricion
  var nut = _pick(fd, ['actividad_pasos_dia','objetivo_calorico','magnitud_ajuste_pct',
                         'num_comidas','horarios_comidas','restricciones_alimentarias',
                         'restriccion_otra','alimentos_disponibles','fase_ciclo_menstrual']);

  // suplementacion
  var supp = _pick(fd, ['restricciones_suplementos','objetivo_primario_supp']);

  // farmacologia — only when perfil === 'PED'
  var farmaco = null;
  if (base.perfil === 'PED') {
    var farmacFields = [
      'experiencia_peds','objetivo_farmaco','timeline_semanas','compuestos_actuales',
      'dosis_semana_mg','bio_hct','bio_alt','bio_ast','bio_col_total','bio_hdl','bio_ldl',
      'bio_trigliceridos','bio_e2','bio_lh','bio_fsh','bio_psa','bio_pa_sistolica',
      'bio_pa_diastolica','bio_fc_reposo','bio_tsh','bio_glucosa','bio_creat',
      'bio_cistatina_c','bio_te_ratio','bio_prolactina','bio_nt_probnp',
      'ecocardiograma_disponible','ecg_disponible','score_agatston','limitaciones',
      'estado_hormonal_femenino'
    ];
    var farmacoData = _pick(fd, farmacFields);
    if (Object.keys(farmacoData).length > 0) farmaco = farmacoData;
  }

  var profile = {};
  if (Object.keys(base).length)  profile.base          = base;
  if (Object.keys(ent).length)   profile.entrenamiento  = ent;
  if (Object.keys(bio).length)   profile.biomecanica    = bio;
  if (Object.keys(prio).length)  profile.prioridades    = prio;
  if (Object.keys(pref).length)  profile.preferencias   = pref;
  if (Object.keys(nut).length)   profile.nutricion      = nut;
  if (Object.keys(supp).length)  profile.suplementacion = supp;
  if (farmaco)                   profile.farmacologia   = farmaco;

  return profile;
}

// ─── COACH EVALUATION mapping ────────────────────────────────────────────────
// Source: fichas_onboarding/{clientId} top-level fields (not .data)
// GAP: there is no dedicated coachEvaluation Firestore path yet.
// fotometria is stored at fichas_onboarding/{clientId}.fotometria (set by coach).
// Biomechanics in .data is CLIENT-STATED, not a coach technical assessment.

function _mapCoachEvaluation(fichaDoc, fd) {
  // fichaDoc = fichas_onboarding/{clientId} full document (not .data)
  // fd       = fichaDoc.data (client ficha fields)
  var gaps = [];
  var ev   = {};

  // fotometria → photoAnalysis (coach-set, stored separately from data)
  if (fichaDoc && _present(fichaDoc.fotometria)) {
    ev.photoAnalysis = fichaDoc.fotometria;
  } else {
    gaps.push('photoAnalysis: no fotometria in fichas_onboarding');
  }

  gaps.push('biomechanics: no coach-sourced biomechanical assessment found in Firestore');
  gaps.push('muscles: no coach muscle assessment found in Firestore');
  gaps.push('exercisePreferencesCoach: no coach exercise preferences stored in Firestore');
  gaps.push('assumptions: no coach assumptions stored in Firestore');

  // finalPriorities: REQUIRED by contract. No dedicated coach Firestore path exists yet.
  // Bridge from grupos_prioritarios (coach-reviewed client data) as a placeholder.
  // If grupos_prioritarios is absent, null out coachEvaluation entirely so the
  // validator emits a warning (absent) rather than an error (present but invalid).
  // Mirrors the flat + nested normalization from _mapClientProfile.
  var _gpRaw = (fd && fd.grupos_prioritarios)
             || (fd && fd.prioridades && fd.prioridades.grupos_prioritarios);
  var grupPri = null;
  if (_gpRaw) {
    if (Array.isArray(_gpRaw)) {
      grupPri = _gpRaw.filter(Boolean).map(function(x){ return String(x).trim(); }).filter(Boolean);
    } else if (typeof _gpRaw === 'string') {
      grupPri = _gpRaw.split(/[,\n]/).map(function(x){ return x.trim(); }).filter(Boolean);
    }
  }
  if (grupPri && grupPri.length > 0) {
    ev.finalPriorities = grupPri;
    gaps.push('finalPriorities: bridged from grupos_prioritarios (no dedicated coach path yet)');
  } else {
    gaps.push('finalPriorities: no source available — coachEvaluation nulled to avoid hard error');
    return { coachEvaluation: null, gaps: gaps };
  }

  return { coachEvaluation: ev, gaps: gaps };
}

// ─── RESTRICTIONS mapping ─────────────────────────────────────────────────────
// Sources:
//   fd.preferencias.ejercicios_evitar (primary — from INTAKE_SCHEMA preferencias)
//   fd.biomecanica.ejercicios_evitar  (alias — also checked in buildPrescriptionContext)
//   fd.ejercicios_evitar              (flat alias — legacy)
//   fd.entrenamiento.lesiones         → injuries (text field)
//   fd.biomecanica.dolor_actual       → pain (text field)
//   fd.biomecanica.patrones_dolor     → movementsAvoid (motor pattern avoidance)
//
// CRITICAL: ejercicios_evitar is preserved textually without filtering by catalog.

function _mapRestrictions(fd) {
  fd = fd || {};

  var exercisesAvoid = [];
  // All three aliased paths — same logic as buildPrescriptionContext line 4071-4073
  var rawEvitar = (fd.preferencias && (fd.preferencias.ejercicios_evitar || fd.preferencias.ejerciciosEvitar)) ||
                  (fd.biomecanica  && (fd.biomecanica.ejercicios_evitar  || fd.biomecanica.ejerciciosEvitar))  ||
                  fd.ejercicios_evitar;

  if (Array.isArray(rawEvitar)) {
    exercisesAvoid = rawEvitar.filter(Boolean).map(function(e) { return String(e).trim(); });
  } else if (typeof rawEvitar === 'string' && rawEvitar.trim()) {
    // Textarea may be a free-text string — preserve it as one element.
    exercisesAvoid = [rawEvitar.trim()];
  }
  // No filtering by catalog. An unrecognized exercise is still a veto.

  var injuries = [];
  if (_present(fd.lesiones)) injuries.push(String(fd.lesiones).trim());
  if (_present(fd.entrenamiento && fd.entrenamiento.lesiones)) injuries.push(String(fd.entrenamiento.lesiones).trim());

  var pain = [];
  if (fd.biomecanica && _present(fd.biomecanica.dolor_actual)) {
    pain.push(String(fd.biomecanica.dolor_actual).trim());
  }

  var movementsAvoid = [];
  if (fd.biomecanica && _present(fd.biomecanica.patrones_dolor)) {
    var pp = fd.biomecanica.patrones_dolor;
    if (Array.isArray(pp)) movementsAvoid = pp.map(String);
    else if (typeof pp === 'string') movementsAvoid = [pp];
  }

  return {
    injuries:            injuries,
    pain:                pain,
    exercisesAvoid:      exercisesAvoid,
    movementsAvoid:      movementsAvoid,
    medicalRestrictions: []
  };
}

// ─── MUSCLE PRIORITIES mapping ────────────────────────────────────────────────
// Source: fd.prioridades.grupos_prioritarios (client-stated)
// NOT recalculated or derived by this adapter.
// If coachEvaluation.finalPriorities existed, it would take precedence — but
// since it doesn't exist yet (GAP), we surface client-stated priorities only.

function _mapMusclePriorities(fd) {
  fd = fd || {};
  var sources = [];

  var clientPrio = null;
  var rawPrio = (fd.prioridades && fd.prioridades.grupos_prioritarios) || fd.grupos_prioritarios;
  if (_present(rawPrio)) {
    // May be a textarea string or an array
    if (Array.isArray(rawPrio)) {
      clientPrio = rawPrio.filter(Boolean).map(function(x){ return String(x).trim(); });
    } else if (typeof rawPrio === 'string') {
      // Split by comma or newline
      clientPrio = rawPrio.split(/[,\n]/).map(function(x){ return x.trim(); }).filter(Boolean);
    }
    if (clientPrio && clientPrio.length) sources.push({ source: 'client_stated', muscles: clientPrio });
  }

  return { musclePriorities: sources, _gaps: clientPrio ? [] : ['musclePriorities: no client-stated priorities found'] };
}

// ─── EQUIPMENT mapping ───────────────────────────────────────────────────────
// Source: fd.gimnasio (select: "San Diego"|"Bugambilias"|"otro")
//         fd.gimnasio_otro_maquinas (textarea, shown when gimnasio="otro")
// GAP: no machine inventory stored in Firestore. Only gym name is known.
//
// Contract note: vdsen-generation-request-v1 defines equipment as array?.
// When only gym name is known (no machine list), we set equipment=null
// to avoid a type mismatch. Gym metadata is placed in options.gymInfo.
// This is documented here and in the FASE B report as a known limitation.
// A future phase can build equipment[] from gym inventory data.

function _mapEquipment(fd) {
  fd = fd || {};
  var gymName = fd.gimnasio || null;
  var customMachines = (gymName === 'otro' && _present(fd.gimnasio_otro_maquinas))
    ? fd.gimnasio_otro_maquinas
    : null;

  // When machine inventory is known as free text, wrap in array of strings.
  // When only gym name known, equipment is null (no array to provide).
  var equipmentArray = null;
  if (customMachines) {
    // Parse free text into individual items
    equipmentArray = customMachines.split(/[,\n]/).map(function(x){ return x.trim(); }).filter(Boolean);
  }

  return {
    // equipment: null when inventory unknown; array when available
    equipment: equipmentArray,
    // gymInfo placed in options so it's not lost
    gymInfo: gymName ? { gymName: gymName } : null,
    _equipmentDataCompleteness: gymName ? (customMachines ? 'custom_text' : 'gym_name_only') : 'unknown'
  };
}

// ─── PREVIOUS PLAN mapping ───────────────────────────────────────────────────
// Source: plans/{activePlanId} via clients/{clientId}.activePlanId
// For mode=new_plan: may be null.
// For mode=update_plan/audit_plan: planDoc should be provided.
// Does NOT modify activePlanId.

function _mapPreviousPlan(planDoc) {
  if (!planDoc) return null;
  // Return original plan object as-is. No transformation.
  return planDoc;
}

// ─── TRAINING LOGS mapping ───────────────────────────────────────────────────
// Source: logs/{clientId}.entries
// Keys: log_W_D_E_sS | done_W_D | postsession_W_D | progrec_W_D | ci_sem_W | engine_state
//
// Strategy (phase B): structural adapter only, no IA summarization.
// Window: all available data is mapped; size reporting is included.
// Splitting into trainingLogs + checkins + engineState as separate blocks.

function _mapLogs(logsDoc) {
  var result = {
    trainingLogs:  null,
    checkins:      null,
    engineState:   null,
    _diagnostics:  {}
  };

  if (!logsDoc || !logsDoc.entries) {
    result._diagnostics.logsAvailable = false;
    return result;
  }

  var entries = logsDoc.entries;
  var currentWeek = logsDoc.currentWeek || null;

  // Separate entries by type
  var setLogs      = {};
  var sessionDone  = {};
  var postSessions = {};
  var progrecs     = {};
  var ciSemanas    = {};
  var engineState  = null;

  Object.keys(entries).forEach(function(k) {
    var v = entries[k];
    if (k === 'engine_state') {
      engineState = v;
    } else if (/^log_\d+_\d+_\d+_s\d+$/.test(k)) {
      setLogs[k] = v;
    } else if (/^done_\d+_\d+$/.test(k)) {
      sessionDone[k] = v;
    } else if (/^postsession_\d+_\d+$/.test(k)) {
      postSessions[k] = v;
    } else if (/^progrec_\d+_\d+$/.test(k)) {
      progrecs[k] = v;
    } else if (/^ci_sem_\d+$/.test(k)) {
      ciSemanas[k] = v;
    }
  });

  var setCount  = Object.keys(setLogs).length;
  var ciCount   = Object.keys(ciSemanas).length;
  var postCount = Object.keys(postSessions).length;

  // trainingLogs block
  if (setCount > 0 || postCount > 0) {
    result.trainingLogs = {
      currentWeek:  currentWeek,
      setLogs:      setLogs,
      sessionDone:  sessionDone,
      postSessions: postSessions,
      progrecs:     progrecs
    };
  }

  // checkins block (weekly check-ins)
  if (ciCount > 0) {
    result.checkins = {
      weeksTracked: ciCount,
      ciByWeek:     ciSemanas
    };
  }

  // engineState block
  result.engineState = engineState || null;

  // diagnostics
  result._diagnostics = {
    logsAvailable:  true,
    setCount:       setCount,
    ciCount:        ciCount,
    postCount:      postCount,
    currentWeek:    currentWeek,
    sizeWarning:    setCount > 500 ? 'LARGE_LOG_SET_count_' + setCount : null
  };

  return result;
}

// ─── NUTRITION CONTEXT mapping ────────────────────────────────────────────────
// Source: fichas_onboarding/{clientId}.data nutrition fields
// Does NOT generate calories or calculate TDEE.

function _mapNutritionContext(fd) {
  fd = fd || {};
  var ctx = _pick(fd, [
    'objetivo_calorico', 'magnitud_ajuste_pct', 'num_comidas', 'horarios_comidas',
    'restricciones_alimentarias', 'restriccion_otra', 'alimentos_disponibles',
    'alimentos_favoritos', 'alimentos_evitar', 'actividad_pasos_dia', 'fase_ciclo_menstrual'
  ]);
  return Object.keys(ctx).length ? ctx : null;
}

// ─── SUPPLEMENT CONTEXT mapping ──────────────────────────────────────────────
// Source: fichas_onboarding/{clientId}.data suplementacion fields

function _mapSupplementContext(fd) {
  fd = fd || {};
  var ctx = _pick(fd, ['restricciones_suplementos', 'objetivo_primario_supp']);
  return Object.keys(ctx).length ? ctx : null;
}

// ─── SUMMARY / PREVIEW (sanitized) ───────────────────────────────────────────
// Shows what fields exist, their sizes, validation result, module criticality gaps.
// Does NOT print sensitive personal data, medical data, or photos.

function summarizeGenerationRequest(req, validationResult) {
  var summary = {
    schema:     req.schema,
    requestId:  req.requestId,
    mode:       req.mode,
    outputMode: req.outputMode,
    clientId:   req.clientId,
    coachId:    req.coachId,
    fields: {},
    missingRequired:      [],
    missingRecommended:   [],
    validationErrors:     (validationResult && validationResult.errors)   || [],
    validationWarnings:   (validationResult && validationResult.warnings) || [],
    modulesCriticalityGaps: []
  };

  // Report field presence/size without printing values
  function _fieldSummary(obj, prefix) {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(function(k) {
      var v = obj[k];
      var key = prefix ? prefix + '.' + k : k;
      if (Array.isArray(v)) {
        summary.fields[key] = 'array[' + v.length + ']';
      } else if (v && typeof v === 'object') {
        summary.fields[key] = 'object{' + Object.keys(v).length + '}';
      } else if (typeof v === 'string') {
        summary.fields[key] = 'string[' + v.length + ']';
      } else {
        summary.fields[key] = typeof v;
      }
    });
  }

  _fieldSummary(req.clientProfile,    'clientProfile');
  _fieldSummary(req.coachEvaluation,  'coachEvaluation');
  _fieldSummary(req.restrictions,     'restrictions');
  _fieldSummary(req.nutritionContext,  'nutritionContext');
  _fieldSummary(req.supplementContext, 'supplementContext');
  if (req.trainingLogs)  summary.fields['trainingLogs']  = 'present';
  if (req.checkins)      summary.fields['checkins']      = 'present';
  if (req.engineState)   summary.fields['engineState']   = 'present';
  if (req.previousPlan)  summary.fields['previousPlan']  = 'present';

  // MODULE_CRITICALITY gap scan for REQUIRED fields
  var modules = ['training', 'nutritionTargets', 'nutritionMenu', 'supplementation'];
  Object.keys(MODULE_CRITICALITY).forEach(function(fieldKey) {
    var crit = MODULE_CRITICALITY[fieldKey];
    modules.forEach(function(mod) {
      if (crit[mod] === 'REQUIRED' && !summary.fields[fieldKey]) {
        summary.modulesCriticalityGaps.push({ field: fieldKey, module: mod, level: 'REQUIRED' });
        if (summary.missingRequired.indexOf(fieldKey) === -1) summary.missingRequired.push(fieldKey);
      } else if (crit[mod] === 'RECOMMENDED' && !summary.fields[fieldKey]) {
        if (summary.missingRecommended.indexOf(fieldKey) === -1) summary.missingRecommended.push(fieldKey);
      }
    });
  });

  return summary;
}

// ─── buildGenerationRequest ───────────────────────────────────────────────────
/**
 * Builds a vdsen-generation-request-v1 from VDSEN Firebase data.
 *
 * @param {object} params
 * @param {string}  params.clientId      - Firebase UID of the client
 * @param {string}  params.coachId       - Firebase UID of the coach
 * @param {object}  params.fichaDoc      - fichas_onboarding/{clientId} full document
 *                                         (fichaDoc.data = INTAKE fields; fichaDoc.fotometria = photos)
 * @param {object}  [params.clientDoc]   - clients/{clientId} document
 * @param {object}  [params.planDoc]     - plans/{activePlanId} document (null for new_plan)
 * @param {object}  [params.logsDoc]     - logs/{clientId} document
 * @param {string}  [params.mode]        - "new_plan"|"update_plan"|"audit_plan" (default: "new_plan")
 * @param {string}  [params.outputMode]  - "json"|"txt"|"pdf"|"all" (default: "json")
 * @param {object}  [params.options]     - additional options passed through
 *
 * @returns {{ request: object|null, validation: object, diagnostics: object }}
 */
function buildGenerationRequest(params) {
  params = params || {};

  var clientId   = params.clientId   || null;
  var coachId    = params.coachId    || null;
  var fichaDoc   = params.fichaDoc   || null;
  var clientDoc  = params.clientDoc  || null;
  var planDoc    = params.planDoc    || null;
  var logsDoc    = params.logsDoc    || null;
  var mode       = params.mode       || 'new_plan';
  var outputMode = params.outputMode || 'json';
  var options    = params.options    || {};

  var fd = (fichaDoc && fichaDoc.data) ? fichaDoc.data : {};

  var diagnostics = {
    fichaPresent:        !!(fichaDoc && fichaDoc.data && Object.keys(fichaDoc.data).length > 0),
    clientDocPresent:    !!clientDoc,
    planDocPresent:      !!planDoc,
    logsDocPresent:      !!(logsDoc && logsDoc.entries),
    coachEvaluationGaps: [],
    equipmentCompleteness: null
  };

  // ── clientProfile ──────────────────────────────────────────────────────────
  var clientProfile = _mapClientProfile(fd, clientDoc);

  // ── coachEvaluation ────────────────────────────────────────────────────────
  var ceResult = _mapCoachEvaluation(fichaDoc, fd);
  diagnostics.coachEvaluationGaps = ceResult.gaps;
  // coachEvaluation is null when no coach data exists — let validator surface it.
  var coachEvaluation = ceResult.coachEvaluation;

  // ── restrictions ───────────────────────────────────────────────────────────
  var restrictions = _mapRestrictions(fd);

  // ── musclePriorities ───────────────────────────────────────────────────────
  var mpResult = _mapMusclePriorities(fd);
  var musclePriorities = mpResult.musclePriorities;
  if (mpResult._gaps.length) diagnostics.musclePriorityGaps = mpResult._gaps;

  // ── equipment ──────────────────────────────────────────────────────────────
  var eqResult = _mapEquipment(fd);
  var equipment = eqResult.equipment;
  diagnostics.equipmentCompleteness = eqResult._equipmentDataCompleteness;

  // ── previousPlan ───────────────────────────────────────────────────────────
  var previousPlan = _mapPreviousPlan(planDoc);

  // ── logs, checkins, engineState ────────────────────────────────────────────
  var logsResult  = _mapLogs(logsDoc);
  diagnostics.logsDiagnostics = logsResult._diagnostics;

  // ── nutrition / supplement context ─────────────────────────────────────────
  var nutritionContext  = _mapNutritionContext(fd);
  var supplementContext = _mapSupplementContext(fd);

  // ── assemble request ───────────────────────────────────────────────────────
  // coachEvaluation: omit key entirely when null so validator emits warning
  // (not error) — absent is treated as "not provided yet", null as invalid.
  // equipment: null when no array available (gym metadata → options.gymInfo).
  var request = {
    schema:      'vdsen-generation-request-v1',
    requestId:   _uuid(),
    clientId:    clientId,
    coachId:     coachId,
    requestedAt: new Date().toISOString(),
    mode:        mode,
    outputMode:  outputMode,

    clientProfile:     clientProfile,
    restrictions:      restrictions,
    musclePriorities:  musclePriorities,
    nutritionContext:  nutritionContext,
    supplementContext: supplementContext,
    previousPlan:      previousPlan,
    trainingLogs:      logsResult.trainingLogs,
    checkins:          logsResult.checkins,
    engineState:       logsResult.engineState,
    attachments:       [],  // multimodal upload not yet implemented (Phase B stub)
    options:           Object.assign({}, options, eqResult.gymInfo ? { gymInfo: eqResult.gymInfo } : {})
  };
  // Conditionally include coachEvaluation only when non-null
  // (null → key absent → contract emits warning, not error)
  if (coachEvaluation !== null) request.coachEvaluation = coachEvaluation;
  // equipment: omit key when null (no inventory known) → no array type error
  // gym metadata is preserved in options.gymInfo
  if (equipment !== null) request.equipment = equipment;

  // ── validation ─────────────────────────────────────────────────────────────
  var validation = validateGenerationRequest(request);

  // If invalid, do NOT proceed to generation (caller must handle).
  return {
    request:     validation.valid ? request : null,
    rawRequest:  request,  // always available for diagnostics/preview
    validation:  validation,
    diagnostics: diagnostics
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  buildGenerationRequest:      buildGenerationRequest,
  summarizeGenerationRequest:  summarizeGenerationRequest,
  // expose individual mappers for granular testing
  _mapClientProfile:    _mapClientProfile,
  _mapCoachEvaluation:  _mapCoachEvaluation,
  _mapRestrictions:     _mapRestrictions,
  _mapMusclePriorities: _mapMusclePriorities,
  _mapEquipment:        _mapEquipment,
  _mapPreviousPlan:     _mapPreviousPlan,
  _mapLogs:             _mapLogs,
  _mapNutritionContext: _mapNutritionContext,
  _mapSupplementContext:_mapSupplementContext,
};
