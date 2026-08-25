'use strict';

var C = require('./vdsen-contracts');
var validateGenerationRequest  = C.validateGenerationRequest;
var validateCoachEvaluation    = C.validateCoachEvaluation;
var validateGenerationResponse = C.validateGenerationResponse;
var MODULE_CRITICALITY         = C.MODULE_CRITICALITY;
var BELT_SQUAT_PENDING         = C.BELT_SQUAT_PENDING;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function minimalRequest(overrides) {
  var base = {
    schema: 'vdsen-generation-request-v1',
    mode:   'new_plan',
    clientProfile: {
      base: { perfil: 'natural' },
      entrenamiento: { nivel: 'intermedio', objetivo_mesociclo: 'hipertrofia', dias_semana: 4 },
      prioridades:   { grupos_prioritarios: ['pecho', 'espalda'], enfoque_actual: 'upper_lower' }
    }
  };
  return Object.assign({}, base, overrides || {});
}

function minimalResponse(overrides) {
  return Object.assign({
    schema:      'vdsen-generation-response-v1',
    status:      'VALID',
    requestId:   'req-001',
    generatedAt: '2026-08-25T00:00:00Z',
    plan:        { schema: 'vdsen-plan-v2', entrenamiento: {} },
    moduleStatus: { training: 'READY', nutritionTargets: 'NEEDS_INPUT', nutritionMenu: 'NEEDS_INPUT', supplementation: 'NEEDS_INPUT' }
  }, overrides || {});
}

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

// ════════════════════════════════════════════════════════════════════════════
// T-A01 a T-A20 — contratos actualizados
// ════════════════════════════════════════════════════════════════════════════

// T-A01: schema incorrecto → invalid
test('T-A01: schema incorrecto → invalid', function() {
  var r = validateGenerationRequest({ schema: 'wrong', mode: 'new_plan',
    clientProfile: { base: { perfil: 'natural' },
      entrenamiento: { nivel: 'intermedio', objetivo_mesociclo: 'hipertrofia', dias_semana: 3 },
      prioridades:   { grupos_prioritarios: ['pecho'], enfoque_actual: 'x' } }
  });
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('schema') !== -1; });
});

// T-A02: request mínimo con mode=new_plan → valid
test('T-A02: request mínimo mode=new_plan → valid', function() {
  var r = validateGenerationRequest(minimalRequest());
  return r.valid === true && r.errors.length === 0;
});

// T-A03: mode=FULL (legacy eliminado) → error
test('T-A03: mode=FULL (legacy) → error', function() {
  var r = validateGenerationRequest(minimalRequest({ mode: 'FULL' }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('mode') !== -1; });
});

// T-A04: dias_semana=0 → error
test('T-A04: dias_semana=0 → error', function() {
  var req = minimalRequest();
  req.clientProfile.entrenamiento.dias_semana = 0;
  var r = validateGenerationRequest(req);
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('dias_semana') !== -1; });
});

// T-A05: grupos_prioritarios=[] → error
test('T-A05: grupos_prioritarios=[] → error', function() {
  var req = minimalRequest();
  req.clientProfile.prioridades.grupos_prioritarios = [];
  var r = validateGenerationRequest(req);
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('grupos_prioritarios') !== -1; });
});

// T-A06: perfil=PED sin farmacologia → warning (no error)
test('T-A06: perfil=PED sin farmacologia → warning no error', function() {
  var req = minimalRequest();
  req.clientProfile.base.perfil = 'PED';
  var r = validateGenerationRequest(req);
  return r.valid === true && r.warnings.some(function(w){ return w.indexOf('farmacologia') !== -1; });
});

// T-A07: sin requestId → warning no error
test('T-A07: sin requestId → warning no error', function() {
  var r = validateGenerationRequest(minimalRequest());
  return r.valid === true && r.warnings.some(function(w){ return w.indexOf('requestId') !== -1; });
});

// T-A08: outputMode=json+text (eliminado) → error
test('T-A08: outputMode="json+text" (eliminado) → error', function() {
  var r = validateGenerationRequest(minimalRequest({ outputMode: 'json+text' }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('outputMode') !== -1; });
});

// T-A09: request=null → invalid
test('T-A09: request=null → invalid', function() {
  var r = validateGenerationRequest(null);
  return r.valid === false && r.errors.length > 0;
});

// T-A10: coachEvaluation sin finalPriorities → error
test('T-A10: coachEvaluation sin finalPriorities → error', function() {
  var req = minimalRequest({ coachEvaluation: { biomechanics: {} } });
  var r = validateGenerationRequest(req);
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('finalPriorities') !== -1; });
});

// T-A11: coachEvaluation válido mínimo → valid
test('T-A11: coachEvaluation válido mínimo → valid', function() {
  var req = minimalRequest({ coachEvaluation: { finalPriorities: { pecho: 'high' } } });
  var r = validateGenerationRequest(req);
  return r.valid === true;
});

// T-A12: validateCoachEvaluation schema incorrecto → invalid
test('T-A12: validateCoachEvaluation schema incorrecto → invalid', function() {
  var r = validateCoachEvaluation({ schema: 'wrong', finalPriorities: {} });
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('schema') !== -1; });
});

// T-A13: validateCoachEvaluation muscles no array → invalid
test('T-A13: validateCoachEvaluation muscles no array → invalid', function() {
  var r = validateCoachEvaluation({ finalPriorities: {}, muscles: 'trapecio' });
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('muscles') !== -1; });
});

// T-A14: response mínimo válido (moduleStatus=READY) → valid
test('T-A14: response mínimo con READY → valid', function() {
  var r = validateGenerationResponse(minimalResponse());
  return r.valid === true && r.errors.length === 0;
});

// T-A15: status=VALID sin plan → error
test('T-A15: status=VALID sin plan → error', function() {
  var r = validateGenerationResponse(minimalResponse({ plan: undefined }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('plan') !== -1; });
});

// T-A16: plan.schema incorrecto → error
test('T-A16: plan.schema incorrecto → error', function() {
  var r = validateGenerationResponse(minimalResponse({ plan: { schema: 'old-schema' } }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('vdsen-plan-v2') !== -1; });
});

// T-A17: NEEDS_INPUT sin missingInputs → error (nombre correcto: missingInputs)
test('T-A17: NEEDS_INPUT sin missingInputs → error', function() {
  var r = validateGenerationResponse({ schema: 'vdsen-generation-response-v1', status: 'NEEDS_INPUT' });
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('missingInputs') !== -1; });
});

// T-A18: NEEDS_INPUT con missingInputs → valid (y plan puede ser null)
test('T-A18: NEEDS_INPUT con missingInputs y sin plan → valid', function() {
  var r = validateGenerationResponse({
    schema:        'vdsen-generation-response-v1',
    status:        'NEEDS_INPUT',
    missingInputs: ['clientProfile.base.peso_kg']
  });
  return r.valid === true;
});

// T-A19: MODULE_CRITICALITY — nivel REQUIRED para training
test('T-A19: MODULE_CRITICALITY nivel → REQUIRED training', function() {
  var e = MODULE_CRITICALITY['clientProfile.entrenamiento.nivel'];
  return e && e.training === 'REQUIRED';
});

// T-A20: MODULE_CRITICALITY — coachEvaluation.finalPriorities REQUIRED para training
test('T-A20: MODULE_CRITICALITY coachEvaluation.finalPriorities → REQUIRED training', function() {
  var e = MODULE_CRITICALITY['coachEvaluation.finalPriorities'];
  return e && e.training === 'REQUIRED';
});

// ════════════════════════════════════════════════════════════════════════════
// T-A21 a T-A34 — nuevos contratos y edge cases
// ════════════════════════════════════════════════════════════════════════════

// T-A21: mode=update_plan → valid
test('T-A21: mode=update_plan → valid', function() {
  var r = validateGenerationRequest(minimalRequest({ mode: 'update_plan' }));
  return r.valid === true;
});

// T-A22: mode=audit_plan → valid
test('T-A22: mode=audit_plan → valid', function() {
  var r = validateGenerationRequest(minimalRequest({ mode: 'audit_plan' }));
  return r.valid === true;
});

// T-A23: outputMode=txt → valid
test('T-A23: outputMode=txt → valid', function() {
  var r = validateGenerationRequest(minimalRequest({ outputMode: 'txt' }));
  return r.valid === true;
});

// T-A24: outputMode=pdf → valid
test('T-A24: outputMode=pdf → valid', function() {
  var r = validateGenerationRequest(minimalRequest({ outputMode: 'pdf' }));
  return r.valid === true;
});

// T-A25: outputMode=all → valid
test('T-A25: outputMode=all → valid', function() {
  var r = validateGenerationRequest(minimalRequest({ outputMode: 'all' }));
  return r.valid === true;
});

// T-A26: moduleStatus NEEDS_INPUT → valid
test('T-A26: moduleStatus.training=NEEDS_INPUT → valid', function() {
  var r = validateGenerationResponse(minimalResponse({
    moduleStatus: { training: 'NEEDS_INPUT', nutritionTargets: 'NEEDS_INPUT' }
  }));
  return r.valid === true;
});

// T-A27: moduleStatus NEEDS_COACH_REVIEW → valid
test('T-A27: moduleStatus.training=NEEDS_COACH_REVIEW → valid', function() {
  var r = validateGenerationResponse(minimalResponse({
    moduleStatus: { training: 'NEEDS_COACH_REVIEW' }
  }));
  return r.valid === true;
});

// T-A28: moduleStatus INVALID → valid
test('T-A28: moduleStatus.training=INVALID → valid', function() {
  var r = validateGenerationResponse(minimalResponse({
    moduleStatus: { training: 'INVALID' }
  }));
  return r.valid === true;
});

// T-A29: moduleStatus OK (eliminado) → error
test('T-A29: moduleStatus.training=OK (eliminado) → error', function() {
  var r = validateGenerationResponse(minimalResponse({
    moduleStatus: { training: 'OK' }
  }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('training') !== -1; });
});

// T-A30: moduleStatus PARTIAL (eliminado) → error
test('T-A30: moduleStatus.training=PARTIAL (eliminado) → error', function() {
  var r = validateGenerationResponse(minimalResponse({
    moduleStatus: { training: 'PARTIAL' }
  }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('training') !== -1; });
});

// T-A31: missingFields (nombre antiguo) no satisface contrato — missingInputs requerido
test('T-A31: missingFields no satisface NEEDS_INPUT — missingInputs requerido', function() {
  var r = validateGenerationResponse({
    schema:        'vdsen-generation-response-v1',
    status:        'NEEDS_INPUT',
    missingFields: ['clientProfile.base.peso_kg']  // nombre antiguo, ignorado
  });
  // debe fallar porque missingInputs está ausente
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('missingInputs') !== -1; });
});

// T-A32: NEEDS_INPUT con plan presente también es valid
test('T-A32: NEEDS_INPUT con plan presente → valid', function() {
  var r = validateGenerationResponse({
    schema:        'vdsen-generation-response-v1',
    status:        'NEEDS_INPUT',
    missingInputs: ['clientProfile.base.peso_kg'],
    plan:          { schema: 'vdsen-plan-v2', entrenamiento: {} }
  });
  return r.valid === true;
});

// T-A33: plan con campo prohibido (audit) → error
test('T-A33: plan con campo prohibido "audit" → error', function() {
  var r = validateGenerationResponse(minimalResponse({
    plan: { schema: 'vdsen-plan-v2', entrenamiento: {}, audit: { note: 'x' } }
  }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('audit') !== -1; });
});

// T-A34: Belt Squat pendiente documentado correctamente
test('T-A34: BELT_SQUAT_PENDING documentado con status=PENDING_CANONICAL_CATALOG_UPDATE', function() {
  return BELT_SQUAT_PENDING.status        === 'PENDING_CANONICAL_CATALOG_UPDATE'
      && BELT_SQUAT_PENDING.movementPattern === 'sentadilla_maquina'
      && BELT_SQUAT_PENDING.longLengthBias  === true
      && BELT_SQUAT_PENDING.fractional.cuadriceps === 1.0
      && Array.isArray(BELT_SQUAT_PENDING.primaryMuscles)
      && BELT_SQUAT_PENDING.primaryMuscles[0] === 'cuadriceps';
});

// ─── Print results ─────────────────────────────────────────────────────────────
var passed = 0;
tests.forEach(function(t) {
  var icon = t.passed ? '✅' : '❌';
  console.log(icon + ' ' + t.name);
  if (!t.passed) console.log('   → ' + t.message);
  if (t.passed) passed++;
});
console.log('\n' + passed + '/' + tests.length + ' passed');
process.exit(passed === tests.length ? 0 : 1);
