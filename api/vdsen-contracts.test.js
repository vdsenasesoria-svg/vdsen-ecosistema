'use strict';

var C = require('./vdsen-contracts');
var validateGenerationRequest  = C.validateGenerationRequest;
var validateCoachEvaluation    = C.validateCoachEvaluation;
var validateGenerationResponse = C.validateGenerationResponse;
var MODULE_CRITICALITY         = C.MODULE_CRITICALITY;

// ─── Minimal valid fixtures ──────────────────────────────────────────────────

function minimalRequest(overrides) {
  var base = {
    schema: 'vdsen-generation-request-v1',
    mode:   'FULL',
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
    schema:     'vdsen-generation-response-v1',
    status:     'VALID',
    requestId:  'req-001',
    generatedAt:'2026-08-25T00:00:00Z',
    plan:       { schema: 'vdsen-plan-v2', entrenamiento: {} },
    moduleStatus: { training: 'OK', nutritionTargets: 'SKIPPED', nutritionMenu: 'SKIPPED', supplementation: 'SKIPPED' }
  }, overrides || {});
}

// ─── Test harness ────────────────────────────────────────────────────────────

var tests = [];
function test(name, fn) {
  try {
    var ok = fn();
    tests.push({ name: name, passed: !!ok, message: ok ? '' : 'returned false/falsy' });
  } catch(e) {
    tests.push({ name: name, passed: false, message: e.message });
  }
}

// ─── T-A01: schema field wrong → invalid ────────────────────────────────────
test('T-A01: schema incorrecto → invalid', function() {
  var r = validateGenerationRequest({ schema: 'wrong', mode: 'FULL',
    clientProfile: { base: { perfil: 'natural' },
      entrenamiento: { nivel: 'intermedio', objetivo_mesociclo: 'hipertrofia', dias_semana: 3 },
      prioridades:   { grupos_prioritarios: ['pecho'], enfoque_actual: 'x' } }
  });
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('schema') !== -1; });
});

// ─── T-A02: minimal valid request → valid ────────────────────────────────────
test('T-A02: request mínimo válido → valid', function() {
  var r = validateGenerationRequest(minimalRequest());
  return r.valid === true && r.errors.length === 0;
});

// ─── T-A03: mode inválido → error ────────────────────────────────────────────
test('T-A03: mode inválido → error', function() {
  var r = validateGenerationRequest(minimalRequest({ mode: 'EVERYTHING' }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('mode') !== -1; });
});

// ─── T-A04: dias_semana fuera de rango → error ───────────────────────────────
test('T-A04: dias_semana=0 → error', function() {
  var req = minimalRequest();
  req.clientProfile.entrenamiento.dias_semana = 0;
  var r = validateGenerationRequest(req);
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('dias_semana') !== -1; });
});

// ─── T-A05: grupos_prioritarios vacío → error ────────────────────────────────
test('T-A05: grupos_prioritarios=[] → error', function() {
  var req = minimalRequest();
  req.clientProfile.prioridades.grupos_prioritarios = [];
  var r = validateGenerationRequest(req);
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('grupos_prioritarios') !== -1; });
});

// ─── T-A06: perfil PED → advertencia farmacologia ausente ────────────────────
test('T-A06: perfil=PED sin farmacologia → warning', function() {
  var req = minimalRequest();
  req.clientProfile.base.perfil = 'PED';
  var r = validateGenerationRequest(req);
  // valid can still be true (farmacologia is RECOMMENDED not REQUIRED)
  return r.valid === true && r.warnings.some(function(w){ return w.indexOf('farmacologia') !== -1; });
});

// ─── T-A07: sin requestId → warning (no error) ───────────────────────────────
test('T-A07: sin requestId → warning no error', function() {
  var r = validateGenerationRequest(minimalRequest());
  return r.valid === true && r.warnings.some(function(w){ return w.indexOf('requestId') !== -1; });
});

// ─── T-A08: outputMode inválido → error ──────────────────────────────────────
test('T-A08: outputMode inválido → error', function() {
  var r = validateGenerationRequest(minimalRequest({ outputMode: 'xml' }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('outputMode') !== -1; });
});

// ─── T-A09: request nulo → invalid ───────────────────────────────────────────
test('T-A09: request=null → invalid', function() {
  var r = validateGenerationRequest(null);
  return r.valid === false && r.errors.length > 0;
});

// ─── T-A10: coachEvaluation sin finalPriorities → error ──────────────────────
test('T-A10: coachEvaluation sin finalPriorities → error', function() {
  var req = minimalRequest({ coachEvaluation: { biomechanics: {} } });
  var r = validateGenerationRequest(req);
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('finalPriorities') !== -1; });
});

// ─── T-A11: coachEvaluation válido mínimo → no error en ce ───────────────────
test('T-A11: coachEvaluation válido → sin errores de ce', function() {
  var req = minimalRequest({ coachEvaluation: { finalPriorities: { pecho: 'high', espalda: 'medium' } } });
  var r = validateGenerationRequest(req);
  return r.valid === true;
});

// ─── T-A12: validateCoachEvaluation — schema incorrecto ──────────────────────
test('T-A12: validateCoachEvaluation schema incorrecto → invalid', function() {
  var r = validateCoachEvaluation({ schema: 'wrong', finalPriorities: {} });
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('schema') !== -1; });
});

// ─── T-A13: validateCoachEvaluation — muscles no array ───────────────────────
test('T-A13: validateCoachEvaluation muscles no array → invalid', function() {
  var r = validateCoachEvaluation({ finalPriorities: {}, muscles: 'trapecio' });
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('muscles') !== -1; });
});

// ─── T-A14: validateGenerationResponse — mínimo válido ───────────────────────
test('T-A14: response mínimo válido → valid', function() {
  var r = validateGenerationResponse(minimalResponse());
  return r.valid === true && r.errors.length === 0;
});

// ─── T-A15: response VALID sin plan → error ──────────────────────────────────
test('T-A15: status=VALID sin plan → error', function() {
  var r = validateGenerationResponse(minimalResponse({ plan: undefined }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('plan') !== -1; });
});

// ─── T-A16: response VALID con plan.schema incorrecto → error ────────────────
test('T-A16: plan.schema incorrecto → error', function() {
  var r = validateGenerationResponse(minimalResponse({ plan: { schema: 'old-schema' } }));
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('vdsen-plan-v2') !== -1; });
});

// ─── T-A17: response NEEDS_INPUT sin missingFields → error ───────────────────
test('T-A17: NEEDS_INPUT sin missingFields → error', function() {
  var r = validateGenerationResponse({ schema: 'vdsen-generation-response-v1', status: 'NEEDS_INPUT' });
  return r.valid === false && r.errors.some(function(e){ return e.indexOf('missingFields') !== -1; });
});

// ─── T-A18: response NEEDS_INPUT con missingFields → valid ───────────────────
test('T-A18: NEEDS_INPUT con missingFields → valid', function() {
  var r = validateGenerationResponse({
    schema:        'vdsen-generation-response-v1',
    status:        'NEEDS_INPUT',
    missingFields: ['clientProfile.base.peso_kg']
  });
  return r.valid === true;
});

// ─── T-A19: MODULE_CRITICALITY — campos REQUIRED en training ─────────────────
test('T-A19: MODULE_CRITICALITY — nivel REQUIRED para training', function() {
  var entry = MODULE_CRITICALITY['clientProfile.entrenamiento.nivel'];
  return entry && entry.training === 'REQUIRED';
});

// ─── T-A20: MODULE_CRITICALITY — separación clientProfile vs coachEvaluation ─
test('T-A20: MODULE_CRITICALITY — coachEvaluation.finalPriorities REQUIRED para training', function() {
  var entry = MODULE_CRITICALITY['coachEvaluation.finalPriorities'];
  return entry && entry.training === 'REQUIRED';
});

// ─── Print results ────────────────────────────────────────────────────────────
var passed = 0;
tests.forEach(function(t) {
  var icon = t.passed ? '✅' : '❌';
  console.log(icon + ' ' + t.name);
  if (!t.passed) console.log('   → ' + t.message);
  if (t.passed) passed++;
});
console.log('\n' + passed + '/' + tests.length + ' passed');
process.exit(passed === tests.length ? 0 : 1);
