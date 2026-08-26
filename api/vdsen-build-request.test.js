'use strict';

var B = require('./vdsen-build-request');
var buildGenerationRequest     = B.buildGenerationRequest;
var summarizeGenerationRequest = B.summarizeGenerationRequest;
var _mapClientProfile    = B._mapClientProfile;
var _mapCoachEvaluation  = B._mapCoachEvaluation;
var _mapRestrictions     = B._mapRestrictions;
var _mapMusclePriorities = B._mapMusclePriorities;
var _mapEquipment        = B._mapEquipment;
var _mapLogs             = B._mapLogs;

// ─── Fixture: Ayrton ─────────────────────────────────────────────────────────
// IMPORTANT: Only fields that would realistically exist in fichas_onboarding.
// Missing fields are left absent — the adapter must NOT invent them.
// Fields marked GAP_NOT_IN_FICHA are currently not stored in Firestore.

var FIXTURE_AYRTON_FICHA_DATA = {
  // base — partial data (no edad, no talla_cm provided)
  nombre:           'Ayrton',
  sexo:             'H',
  // edad:          GAP_NOT_IN_FICHA
  peso_kg:          82,
  // talla_cm:      GAP_NOT_IN_FICHA
  porcentaje_grasa: 14.5,
  perfil:           'natural',

  // entrenamiento
  nivel:                    'intermedio',
  dias_semana:              4,
  duracion_sesion_min:      75,
  gimnasio:                 'San Diego',
  objetivo_mesociclo:       'hipertrofia',
  lesiones:                 'molestia leve en hombro derecho',
  semana_actual_mesociclo:  3,

  // biomecanica
  biotipo:           'torso largo, fémures medios',
  movilidad:         'dorsiflexión limitada tobillo izquierdo',
  patrones_fuertes:  ['Empuje', 'Bisagra'],
  patrones_debiles:  ['Halar'],
  asimetrias:        'escápula derecha ligeramente alada',
  dolor_actual:      'molestia anterior hombro derecho en press',

  // prioridades
  grupos_prioritarios: 'espalda, hombros, brazos',
  enfoque_actual:      'hipertrofia',
  objetivo_corto:      'mejorar ancho de espalda y definición de hombros',

  // preferencias
  ejercicios_favoritos: 'peso muerto, jalón al pecho, curl en máquina',
  ejercicios_evitar:    'press tras nuca, mariposa pec-deck con peso excesivo',
  estilo_entreno:       ['series rectas', 'biseries / superseries'],
  alimentos_favoritos:  'pollo, arroz, huevos, aguacate',
  alimentos_evitar:     'lácteos en exceso',

  // nutricion
  actividad_pasos_dia:      9000,
  objetivo_calorico:        'superávit',
  magnitud_ajuste_pct:      8,
  num_comidas:              4,
  horarios_comidas:         '08:00 / 12:30 / 17:00 / 21:00',
  restricciones_alimentarias: ['ninguna'],
  // restriccion_otra:       GAP_NOT_IN_FICHA (not selected)

  // suplementacion
  restricciones_suplementos: 'ninguna',
  objetivo_primario_supp:    'rendimiento'
};

var FIXTURE_AYRTON_FICHA_DOC = {
  schemaVersion: '1.1',
  data:          FIXTURE_AYRTON_FICHA_DATA,
  fotometria:    null,  // coach hasn't uploaded photos yet
  updatedAt:     1724630000000,
  updatedBy:     'client'
};

var FIXTURE_AYRTON_CLIENT_DOC = {
  coachId:      'coach-uid-test',
  displayName:  'Ayrton',
  email:        'ayrton@test.com',
  activePlanId: 'plan-test-001'
};

var FIXTURE_PLAN_DOC = {
  weeks:       6,
  daysPerWeek: 4,
  days: [
    { dayIndex: 0, label: 'Pecho/Tríceps', exercises: [
      { exerciseName: 'Press Banca', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, load: 80 }] }
    ]},
    { dayIndex: 1, label: 'Espalda/Bíceps', exercises: [
      { exerciseName: 'Peso Muerto', sets: [{ setIndex: 0, repsTarget: 6, rirTarget: 2, load: 100 }] }
    ]}
  ],
  coachId:   'coach-uid-test',
  clientId:  'client-uid-ayrton',
  schema:    'vdsen-plan-v2'
};

var FIXTURE_LOGS_DOC = {
  currentWeek: 3,
  entries: {
    'engine_state': {
      globalAction:    'volume_up',
      deloadTriggered: false,
      exerciseSummary: [
        { exerciseName: 'Peso Muerto', action: 'increase_load' },
        { exerciseName: 'Press Banca', action: 'maintain'      }
      ]
    },
    'ci_sem_1': { peso: 81.5, hrv: 62, who5: 68 },
    'ci_sem_2': { peso: 82.0, hrv: 65, who5: 72 },
    'log_1_0_0_s0': { carga: 80, reps: 8, rir: 2, done: true, ics: 8, pump: 1 },
    'log_1_0_0_s1': { carga: 80, reps: 7, rir: 2, done: true, ics: 7, pump: 2 },
    'done_1_0': true,
    'postsession_1_0': { eimd: 1, articular: false, sleep: 7.5, rpe: 7 },
    'progrec_1_0': { weekNum: 1, recommendations: [
      { exerciseName: 'Press Banca', action: 'maintain', newLoad: 80 }
    ]}
  }
};

// ─── Test harness ─────────────────────────────────────────────────────────────

var tests = [];
function test(name, fn) {
  try {
    var ok = fn();
    tests.push({ name: name, passed: !!ok, message: ok ? '' : 'returned false/falsy' });
  } catch(e) {
    tests.push({ name: name, passed: false, message: e.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// T-B01 — T-B30: Fase B Adapter Tests
// ════════════════════════════════════════════════════════════════════════════════

// T-B01: build new_plan request has valid structure
test('T-B01: buildGenerationRequest produce rawRequest con schema correcto', function() {
  var r = buildGenerationRequest({
    clientId: 'ayrton-uid', coachId: 'coach-uid-test',
    fichaDoc: FIXTURE_AYRTON_FICHA_DOC, clientDoc: FIXTURE_AYRTON_CLIENT_DOC,
    planDoc: FIXTURE_PLAN_DOC, logsDoc: FIXTURE_LOGS_DOC, mode: 'new_plan'
  });
  return r.rawRequest && r.rawRequest.schema === 'vdsen-generation-request-v1';
});

// T-B02: schema is exactly vdsen-generation-request-v1
test('T-B02: rawRequest.schema === "vdsen-generation-request-v1"', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  return r.rawRequest.schema === 'vdsen-generation-request-v1';
});

// T-B03: mode is preserved
test('T-B03: mode preservado en rawRequest', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'update_plan' });
  return r.rawRequest.mode === 'update_plan';
});

// T-B04: outputMode is preserved
test('T-B04: outputMode preservado', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan', outputMode: 'pdf' });
  return r.rawRequest.outputMode === 'pdf';
});

// T-B05: clientProfile is mapped from ficha data
test('T-B05: clientProfile mapeado — perfil, peso_kg, nivel, dias_semana', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  var cp = r.rawRequest.clientProfile;
  return cp && cp.base && cp.base.perfil === 'natural'
      && cp.base.peso_kg === 82
      && cp.entrenamiento && cp.entrenamiento.nivel === 'intermedio'
      && cp.entrenamiento.dias_semana === 4;
});

// T-B06: exercisesAvoid is preserved intact (no catalog filtering)
test('T-B06: exercisesAvoid preservado íntegro sin filtrado', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  var avoid = r.rawRequest.restrictions && r.rawRequest.restrictions.exercisesAvoid;
  // Fixture has a text string that should be preserved
  return Array.isArray(avoid) && avoid.length > 0
      && avoid.some(function(e){ return /press tras nuca|mariposa/i.test(e); });
});

// T-B07: coachEvaluation is separate from clientProfile (verified with a fichaDoc that has fotometria)
test('T-B07: coachEvaluation no es parte de clientProfile', function() {
  var fichaWithPhoto = {
    schemaVersion: '1.1',
    data: FIXTURE_AYRTON_FICHA_DATA,
    fotometria: { front: 'base64photo' },
    updatedAt: 1724630000000,
    updatedBy: 'coach'
  };
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: fichaWithPhoto, mode: 'new_plan' });
  var rq = r.rawRequest;
  // coachEvaluation is a top-level key, NOT nested inside clientProfile
  return !rq.clientProfile.coachEvaluation && 'coachEvaluation' in rq;
});

// T-B08: coachEvaluation absent when neither fotometria nor grupos_prioritarios exist
test('T-B08: coachEvaluation ausente cuando no hay datos de coach', function() {
  // Fixture with no fotometria AND no grupos_prioritarios → coachEvaluation must be absent
  var fichaEmpty = {
    schemaVersion: '1.1',
    data: { perfil: 'natural', nivel: 'intermedio', dias_semana: 4,
            objetivo_mesociclo: 'hipertrofia', enfoque_actual: 'hipertrofia' },
    fotometria: null,
  };
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: fichaEmpty, mode: 'new_plan' });
  // coachEvaluation key must be absent (not null) so contract emits a warning, not an error
  return !('coachEvaluation' in r.rawRequest);
});

// T-B09: musclePriorities are not recalculated — only client-stated
test('T-B09: musclePriorities solo declaradas por cliente, no recalculadas', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  var mp = r.rawRequest.musclePriorities;
  // Should be an array of {source, muscles} objects
  return Array.isArray(mp)
      && mp.every(function(p){ return p.source && Array.isArray(p.muscles); });
});

// T-B10: equipment key is absent when only gym name is known (no machine inventory)
test('T-B10: equipment con solo gymName no inventa available[]', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  // When only gym name known: equipment key absent from rawRequest (not null, not array)
  // gym metadata is preserved in options.gymInfo
  return !('equipment' in r.rawRequest)
      && r.rawRequest.options
      && r.rawRequest.options.gymInfo
      && r.rawRequest.options.gymInfo.gymName === 'San Diego';
});

// T-B11: previousPlan is null for new_plan when no plan provided
test('T-B11: previousPlan null para new_plan sin planDoc', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan', planDoc: null });
  return r.rawRequest.previousPlan === null;
});

// T-B12: previousPlan recovered when planDoc provided (for update_plan)
test('T-B12: previousPlan mapeado cuando planDoc existe', function() {
  var r = buildGenerationRequest({
    clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC,
    mode: 'update_plan', planDoc: FIXTURE_PLAN_DOC
  });
  return r.rawRequest.previousPlan && r.rawRequest.previousPlan.weeks === 6;
});

// T-B13: training logs are mapped (setLogs present)
test('T-B13: trainingLogs mapeados desde logs/{uid}', function() {
  var r = buildGenerationRequest({
    clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC,
    mode: 'new_plan', logsDoc: FIXTURE_LOGS_DOC
  });
  var tl = r.rawRequest.trainingLogs;
  return tl && tl.setLogs && Object.keys(tl.setLogs).length > 0;
});

// T-B14: checkins are a separate block from trainingLogs
test('T-B14: checkins separados de trainingLogs', function() {
  var r = buildGenerationRequest({
    clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC,
    mode: 'new_plan', logsDoc: FIXTURE_LOGS_DOC
  });
  var ci = r.rawRequest.checkins;
  return ci && ci.weeksTracked === 2 && ci.ciByWeek && ci.ciByWeek['ci_sem_1'];
});

// T-B15: engineState is a separate block
test('T-B15: engineState separado de trainingLogs', function() {
  var r = buildGenerationRequest({
    clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC,
    mode: 'new_plan', logsDoc: FIXTURE_LOGS_DOC
  });
  return r.rawRequest.engineState && r.rawRequest.engineState.globalAction === 'volume_up';
});

// T-B16: engineState is null when logs have no engine_state
test('T-B16: engineState null cuando no existe en logs', function() {
  var logsNoEngine = { entries: { 'ci_sem_1': { peso: 80, hrv: 60, who5: 70 } } };
  var r = buildGenerationRequest({
    clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC,
    mode: 'new_plan', logsDoc: logsNoEngine
  });
  return r.rawRequest.engineState === null;
});

// T-B17: missing nutrition preferences stay absent (not filled with defaults)
test('T-B17: preferencias nutrición faltantes siguen faltando', function() {
  var fichaMinima = { schemaVersion: '1.1', data: { perfil: 'natural', nivel: 'intermedio', dias_semana: 4, objetivo_mesociclo: 'hipertrofia', grupos_prioritarios: 'pecho', enfoque_actual: 'hipertrofia' } };
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: fichaMinima, mode: 'new_plan' });
  var nc = r.rawRequest.nutritionContext;
  // No nutrition fields were in fichaMinima — nutritionContext should be null
  return nc === null;
});

// T-B18: absent allergy field is NOT transformed into "ninguna"
test('T-B18: restricciones_alimentarias ausente no se convierte en "ninguna"', function() {
  var fichaNoRestrictions = {
    schemaVersion: '1.1',
    data: {
      perfil: 'natural', nivel: 'intermedio', dias_semana: 4,
      objetivo_mesociclo: 'hipertrofia', grupos_prioritarios: 'pecho', enfoque_actual: 'hipertrofia',
      alimentos_favoritos: 'pollo, arroz'
      // restricciones_alimentarias: absent
    }
  };
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: fichaNoRestrictions, mode: 'new_plan' });
  var nc = r.rawRequest.nutritionContext;
  return !nc || !nc.restricciones_alimentarias;
});

// T-B19: missing edad is not invented
test('T-B19: edad faltante no se inventa en clientProfile', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  // Ayrton fixture has no edad
  return !r.rawRequest.clientProfile.base || r.rawRequest.clientProfile.base.edad === undefined;
});

// T-B20: missing talla_cm is not invented
test('T-B20: talla_cm faltante no se inventa en clientProfile', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  return !r.rawRequest.clientProfile.base || r.rawRequest.clientProfile.base.talla_cm === undefined;
});

// T-B21: attachments is empty array (Phase B stub)
test('T-B21: attachments=[] cuando no hay archivos', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  return Array.isArray(r.rawRequest.attachments) && r.rawRequest.attachments.length === 0;
});

// T-B22: validateGenerationRequest is executed on the output
test('T-B22: validation ejecutada sobre el output', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  return r.validation && typeof r.validation.valid === 'boolean' && Array.isArray(r.validation.errors);
});

// T-B23: invalid request (no ficha) returns request=null
test('T-B23: request inválido (sin perfil/nivel/etc.) → request=null', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: null, mode: 'new_plan' });
  // With no ficha, clientProfile will be empty → required fields missing → validation fails
  return r.request === null && r.validation.valid === false;
});

// T-B24: requestId is generated and non-empty
test('T-B24: requestId generado y no vacío', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  var rid = r.rawRequest.requestId;
  return typeof rid === 'string' && rid.length > 0;
});

// T-B25: no farmacologia generated for natural profile
test('T-B25: sin farmacología generada para perfil natural', function() {
  var r = buildGenerationRequest({ clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC, mode: 'new_plan' });
  var cp = r.rawRequest.clientProfile;
  return !cp.farmacologia;
});

// T-B26: activePlanId is not modified — it's in clientDoc, not touched
test('T-B26: activePlanId intacto — clientDoc no modificado por adapter', function() {
  var original = JSON.parse(JSON.stringify(FIXTURE_AYRTON_CLIENT_DOC));
  buildGenerationRequest({
    clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC,
    clientDoc: FIXTURE_AYRTON_CLIENT_DOC, mode: 'new_plan'
  });
  return FIXTURE_AYRTON_CLIENT_DOC.activePlanId === original.activePlanId;
});

// T-B27: Firestore schema intact — logsDoc is NOT mutated
test('T-B27: logsDoc no mutado por adapter (Firestore schema intacto)', function() {
  var original = JSON.parse(JSON.stringify(FIXTURE_LOGS_DOC));
  buildGenerationRequest({
    clientId: 'uid', fichaDoc: FIXTURE_AYRTON_FICHA_DOC,
    logsDoc: FIXTURE_LOGS_DOC, mode: 'new_plan'
  });
  var engineIntact = JSON.stringify(FIXTURE_LOGS_DOC.entries.engine_state)
                  === JSON.stringify(original.entries.engine_state);
  return engineIntact;
});

// T-B28: Anthropic current flow is intact — adapter does NOT call fetch/API
test('T-B28: adapter no llama a fetch ni API (Anthropic flow intacto)', function() {
  // Verify buildGenerationRequest doesn't contain fetch or XMLHttpRequest
  var src = require('fs').readFileSync(__dirname + '/vdsen-build-request.js', 'utf8');
  return src.indexOf('fetch(') === -1 && src.indexOf('XMLHttpRequest') === -1
      && src.indexOf('openai') === -1 && src.indexOf('anthropic') === -1;
});

// T-B29: manual import flow is not touched — generate-plan.js still exports default
test('T-B29: generate-plan.js sigue exportando handler (importación manual intacta)', function() {
  var src = require('fs').readFileSync(__dirname + '/generate-plan.js', 'utf8');
  return src.indexOf('export default async function handler') !== -1;
});

// T-B30: VDSEN_BUILD browser adapter is present in vdsen-coach.html (FASE D.1)
test('T-B30: vdsen-build-request inyectado en vdsen-coach.html como VDSEN_BUILD', function() {
  var src = require('fs').readFileSync(require('path').join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
  return src.indexOf('window.VDSEN_BUILD') !== -1;
});

// ─── Ayrton fixture preview ───────────────────────────────────────────────────
var _ayrtonResult = buildGenerationRequest({
  clientId: 'ayrton-uid',
  coachId:  'coach-uid-test',
  fichaDoc: FIXTURE_AYRTON_FICHA_DOC,
  clientDoc: FIXTURE_AYRTON_CLIENT_DOC,
  planDoc:  FIXTURE_PLAN_DOC,
  logsDoc:  FIXTURE_LOGS_DOC,
  mode:     'new_plan',
  outputMode: 'json'
});
var _ayrtonSummary = summarizeGenerationRequest(_ayrtonResult.rawRequest, _ayrtonResult.validation);

// ─── Print results ─────────────────────────────────────────────────────────────
var passed = 0;
tests.forEach(function(t) {
  var icon = t.passed ? '✅' : '❌';
  console.log(icon + ' ' + t.name);
  if (!t.passed) console.log('   → ' + t.message);
  if (t.passed) passed++;
});
console.log('\n' + passed + '/' + tests.length + ' passed');

console.log('\n════ FIXTURE AYRTON — Preview ════');
console.log('Validation valid:', _ayrtonResult.validation.valid);
console.log('Validation errors:', JSON.stringify(_ayrtonResult.validation.errors));
console.log('Validation warnings (count):', _ayrtonResult.validation.warnings.length);
console.log('CoachEvaluation gaps:', JSON.stringify(_ayrtonResult.diagnostics.coachEvaluationGaps));
console.log('Equipment completeness:', _ayrtonResult.diagnostics.equipmentCompleteness);
console.log('LogsDiagnostics:', JSON.stringify(_ayrtonResult.diagnostics.logsDiagnostics));
console.log('Fields present:', Object.keys(_ayrtonSummary.fields).sort().join(', '));
console.log('Missing REQUIRED:', JSON.stringify(_ayrtonSummary.missingRequired));
console.log('Missing RECOMMENDED (sample):', JSON.stringify(_ayrtonSummary.missingRecommended.slice(0,5)));

process.exit(passed === tests.length ? 0 : 1);
