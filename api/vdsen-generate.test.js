'use strict';

var G = require('./vdsen-generate');
var createHandlerWithClient = G._createHandlerWithClient;
var internal = G._internal;
var ERR      = internal.ERR;

var prepareModelRequest    = internal.prepareModelRequest;
var extractModelResponse   = internal.extractModelResponse;
var removeNullFields       = internal.removeNullFields;
var buildErrorResponse     = internal.buildErrorResponse;
var sanitizeMissingInputs  = internal.sanitizeMissingInputs;

// ─── Test harness (async) ─────────────────────────────────────────────────────

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockReq(body, method) {
  return { method: method || 'POST', body: body || {} };
}

function mockRes() {
  var r = { _status: null, _body: null };
  r.status = function(code) { r._status = code; return r; };
  r.json   = function(body)  { r._body  = body; return r; };
  return r;
}

// Wraps a plain JS object as an OpenAI Responses API response
function wrapOAI(bodyObj, opts) {
  opts = opts || {};
  return {
    id:     'resp-test',
    status: opts.status || 'completed',
    model:  opts.model  || process.env.OPENAI_MODEL || 'gpt-4o',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [opts.refusal
        ? { type: 'refusal', refusal: opts.refusal }
        : { type: 'output_text', text: JSON.stringify(bodyObj) }
      ]
    }],
    usage: { input_tokens: 100, output_tokens: 200 }
  };
}

// A mock factory that uses a creator function to produce responses
function mockFactory(createFn) {
  return function() {
    return { responses: { create: createFn } };
  };
}

// Call handler with given factory and body, return { status, body }
async function call(factory, body, method) {
  var h   = createHandlerWithClient(factory);
  var req = mockReq(body, method);
  var res = mockRes();
  await h(req, res);
  return { status: res._status, body: res._body };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

var VALID_REQUEST = {
  schema:        'vdsen-generation-request-v1',
  requestId:     'req-test-001',
  mode:          'new_plan',
  outputMode:    'json',
  clientId:      'client-test-001',
  coachId:       'coach-test-001',
  clientProfile: {
    base:          { perfil: 'natural' },
    entrenamiento: { nivel: 'intermedio', objetivo_mesociclo: 'hipertrofia', dias_semana: 4 },
    prioridades:   { grupos_prioritarios: ['pecho', 'espalda'], enfoque_actual: 'upper_lower' }
  }
};

var VALID_RESPONSE_BODY = {
  schema:       'vdsen-generation-response-v1',
  requestId:    'req-test-001',
  status:       'VALID',
  generatedAt:  '2026-08-25T00:00:00Z',
  model:        'gpt-test',
  moduleStatus: { training: 'READY', nutritionTargets: 'NEEDS_INPUT', nutritionMenu: 'NEEDS_INPUT', supplementation: 'NEEDS_INPUT' },
  plan:         { schema: 'vdsen-plan-v2', entrenamiento: {} }
};

var NEEDS_INPUT_RESPONSE_BODY = {
  schema:        'vdsen-generation-response-v1',
  requestId:     'req-test-001',
  status:        'NEEDS_INPUT',
  missingInputs: [{ field: 'clientProfile.base.edad', module: 'training', impact: 'HIGH' }]
};

var NEEDS_COACH_REVIEW_BODY = {
  schema:       'vdsen-generation-response-v1',
  requestId:    'req-test-001',
  status:       'NEEDS_COACH_REVIEW',
  moduleStatus: { training: 'NEEDS_COACH_REVIEW' },
  plan:         { schema: 'vdsen-plan-v2', entrenamiento: {} }
};

// Save / restore OPENAI_API_KEY around tests that need to toggle it
var _savedKey;
function withKey(key, fn) {
  return async function() {
    _savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = key;
    try { return await fn(); } finally { process.env.OPENAI_API_KEY = _savedKey; }
  };
}

// Set a key and model for all tests that need the provider to be called
process.env.OPENAI_API_KEY = 'test-key-fake';
process.env.OPENAI_MODEL   = 'gpt-test';

// ════════════════════════════════════════════════════════════════════════════════
// T-C01 — T-C26
// ════════════════════════════════════════════════════════════════════════════════

// T-C01: request válido → provider llamado
test('T-C01: request válido → provider llamado', async function() {
  var called = false;
  var factory = mockFactory(async function() { called = true; return wrapOAI(VALID_RESPONSE_BODY); });
  await call(factory, VALID_REQUEST);
  return called === true;
});

// T-C02: request inválido → provider NO llamado
test('T-C02: request inválido → provider NO llamado', async function() {
  var called = false;
  var factory = mockFactory(async function() { called = true; return wrapOAI(VALID_RESPONSE_BODY); });
  await call(factory, { schema: 'vdsen-generation-request-v1', mode: 'new_plan' });
  return called === false;
});

// T-C03: OPENAI_API_KEY ausente → error controlado 500
test('T-C03: OPENAI_API_KEY ausente → error controlado', withKey('', async function() {
  var factory = mockFactory(async function() { return wrapOAI(VALID_RESPONSE_BODY); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 500 && r.body.errorCode === ERR.OPENAI_NOT_CONFIGURED;
}));

// T-C04: response VALID válido → HTTP 200 + status VALID
test('T-C04: response VALID válido → 200 VALID', async function() {
  var factory = mockFactory(async function() { return wrapOAI(VALID_RESPONSE_BODY); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 200 && r.body.status === 'VALID';
});

// T-C05: NEEDS_INPUT válido → HTTP 200 + status NEEDS_INPUT
test('T-C05: NEEDS_INPUT válido → 200 NEEDS_INPUT', async function() {
  var factory = mockFactory(async function() { return wrapOAI(NEEDS_INPUT_RESPONSE_BODY); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 200 && r.body.status === 'NEEDS_INPUT';
});

// T-C06: NEEDS_COACH_REVIEW válido → HTTP 200 + status NEEDS_COACH_REVIEW
test('T-C06: NEEDS_COACH_REVIEW válido → 200', async function() {
  var factory = mockFactory(async function() { return wrapOAI(NEEDS_COACH_REVIEW_BODY); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 200 && r.body.status === 'NEEDS_COACH_REVIEW';
});

// T-C07: response schema inválido → 422, NO 200
test('T-C07: response schema inválido → 422 no 200', async function() {
  // plan with forbidden field 'audit' inside → validateGenerationResponse fails
  var badPlan = { schema: 'vdsen-plan-v2', entrenamiento: {}, audit: { note: 'x' } };
  var badBody = Object.assign({}, VALID_RESPONSE_BODY, { plan: badPlan });
  var factory = mockFactory(async function() { return wrapOAI(badBody); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 422 && r.body.errorCode === ERR.MODEL_RESPONSE_INVALID;
});

// T-C08: output vacío → 502
test('T-C08: output vacío del modelo → 502', async function() {
  var factory = mockFactory(async function() {
    return { id: 'resp', status: 'completed', output: [], usage: null };
  });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 502 && r.body.errorCode === ERR.MODEL_EMPTY_OUTPUT;
});

// T-C09: refusal del modelo → 502 MODEL_REFUSAL
test('T-C09: refusal del modelo → 502 MODEL_REFUSAL', async function() {
  var factory = mockFactory(async function() {
    return wrapOAI(null, { refusal: 'I cannot generate this content.' });
  });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 502 && r.body.errorCode === ERR.MODEL_REFUSAL;
});

// T-C10: incomplete / max output → 502 MODEL_OUTPUT_INCOMPLETE
test('T-C10: incomplete (max output) → 502 MODEL_OUTPUT_INCOMPLETE', async function() {
  var factory = mockFactory(async function() {
    return { id: 'resp', status: 'incomplete', output: [], usage: null };
  });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 502 && r.body.errorCode === ERR.MODEL_OUTPUT_INCOMPLETE;
});

// T-C11: provider timeout → 504
test('T-C11: provider timeout → 504', async function() {
  var factory = mockFactory(async function() {
    var e = new Error('Request timed out'); e.code = 'ETIMEDOUT'; throw e;
  });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 504 && r.body.errorCode === ERR.OPENAI_TIMEOUT;
});

// T-C12: provider error 500 → 502
test('T-C12: provider error 500 → 502 OPENAI_REQUEST_FAILED', async function() {
  var factory = mockFactory(async function() {
    throw new Error('Internal Server Error from provider');
  });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 502 && r.body.errorCode === ERR.OPENAI_REQUEST_FAILED;
});

// T-C13: requestId mismatch en response del modelo → 502
test('T-C13: requestId mismatch → 502', async function() {
  var mismatchBody = Object.assign({}, VALID_RESPONSE_BODY, { requestId: 'DIFFERENT-ID' });
  var factory = mockFactory(async function() { return wrapOAI(mismatchBody); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 502 && r.body.errorCode === ERR.MODEL_SCHEMA_MISMATCH;
});

// T-C14: model field normalizado server-side (no depende del modelo)
test('T-C14: model field normalizado server-side', async function() {
  var bodyWithWrongModel = Object.assign({}, VALID_RESPONSE_BODY, { model: 'gpt-invented-by-model' });
  var factory = mockFactory(async function() { return wrapOAI(bodyWithWrongModel); });
  var savedModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_MODEL = 'gpt-4o-configured';
  var r = await call(factory, VALID_REQUEST);
  process.env.OPENAI_MODEL = savedModel;
  return r.status === 200 && r.body.model === 'gpt-4o-configured';
});

// T-C15: generatedAt generado server-side, no depende del modelo
test('T-C15: generatedAt server-side', async function() {
  var modelDate = '1999-01-01T00:00:00Z';
  var bodyWithOldDate = Object.assign({}, VALID_RESPONSE_BODY, { generatedAt: modelDate });
  var factory = mockFactory(async function() { return wrapOAI(bodyWithOldDate); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 200 && r.body.generatedAt !== modelDate && /^\d{4}-\d{2}-\d{2}T/.test(r.body.generatedAt);
});

// T-C16: plan contaminado con campo audit → falla validator → 422
test('T-C16: plan contaminado con "audit" → 422', async function() {
  var contaminated = Object.assign({}, VALID_RESPONSE_BODY, {
    plan: { schema: 'vdsen-plan-v2', entrenamiento: {}, audit: { injected: true } }
  });
  var factory = mockFactory(async function() { return wrapOAI(contaminated); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 422 && r.body.errorCode === ERR.MODEL_RESPONSE_INVALID;
});

// T-C17: VALID con plan=null → falla contrato → 422
test('T-C17: status=VALID con plan=null → 422', async function() {
  var noPlanBody = Object.assign({}, VALID_RESPONSE_BODY, { plan: null });
  var factory = mockFactory(async function() { return wrapOAI(noPlanBody); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 422 && r.body.errorCode === ERR.MODEL_RESPONSE_INVALID;
});

// T-C18: NEEDS_INPUT sin missingInputs → falla contrato → 422
test('T-C18: NEEDS_INPUT sin missingInputs → 422', async function() {
  var noMissing = { schema: 'vdsen-generation-response-v1', requestId: 'req-test-001', status: 'NEEDS_INPUT' };
  var factory = mockFactory(async function() { return wrapOAI(noMissing); });
  var r = await call(factory, VALID_REQUEST);
  return r.status === 422 && r.body.errorCode === ERR.MODEL_RESPONSE_INVALID;
});

// T-C19: farmacología removida de modelPayload antes de llamar al modelo
test('T-C19: farmacología removida de modelPayload', async function() {
  var capturedPayload;
  var factory = mockFactory(async function(params) {
    capturedPayload = JSON.parse(params.input);
    return wrapOAI(VALID_RESPONSE_BODY);
  });
  var pedRequest = JSON.parse(JSON.stringify(VALID_REQUEST));
  pedRequest.clientProfile.base.perfil = 'PED';
  pedRequest.clientProfile.farmacologia = {
    compuestos_actuales: 'testosterona 300mg', objetivo_farmaco: 'masa'
  };
  await call(factory, pedRequest);
  return capturedPayload !== undefined
      && (!capturedPayload.clientProfile || !capturedPayload.clientProfile.farmacologia);
});

// T-C20: datos de contacto (email, teléfono) no enviados al modelo
test('T-C20: datos de contacto no enviados al modelo', async function() {
  var capturedPayload;
  var factory = mockFactory(async function(params) {
    capturedPayload = JSON.parse(params.input);
    return wrapOAI(VALID_RESPONSE_BODY);
  });
  var reqWithContact = JSON.parse(JSON.stringify(VALID_REQUEST));
  reqWithContact.clientProfile.base.email    = 'ayrton@test.com';
  reqWithContact.clientProfile.base.telefono = '+52 555 000 0000';
  await call(factory, reqWithContact);
  return capturedPayload !== undefined
      && !capturedPayload.clientProfile.base.email
      && !capturedPayload.clientProfile.base.telefono;
});

// T-C21: Anthropic endpoint intacto — generate-plan.js sigue exportando handler
test('T-C21: Anthropic endpoint intacto', function() {
  var src = require('fs').readFileSync(__dirname + '/generate-plan.js', 'utf8');
  return src.indexOf('export default async function handler') !== -1;
});

// T-C22: no Firestore writes en vdsen-generate.js
test('T-C22: no Firestore writes en vdsen-generate.js', function() {
  var src = require('fs').readFileSync(__dirname + '/vdsen-generate.js', 'utf8');
  return src.indexOf('addDoc') === -1
      && src.indexOf('setDoc') === -1
      && src.indexOf('updateDoc') === -1
      && src.indexOf('collection(') === -1;
});

// T-C23: outputMode=json se pasa al modelPayload
test('T-C23: outputMode=json pasa contrato', async function() {
  var capturedPayload;
  var factory = mockFactory(async function(params) {
    capturedPayload = JSON.parse(params.input);
    return wrapOAI(VALID_RESPONSE_BODY);
  });
  await call(factory, Object.assign({}, VALID_REQUEST, { outputMode: 'json' }));
  return capturedPayload && capturedPayload.outputMode === 'json';
});

// T-C24: outputMode=txt se pasa al modelPayload
test('T-C24: outputMode=txt pasa contrato', async function() {
  var capturedPayload;
  var factory = mockFactory(async function(params) {
    capturedPayload = JSON.parse(params.input);
    var respBody = Object.assign({}, VALID_RESPONSE_BODY);
    return wrapOAI(respBody);
  });
  await call(factory, Object.assign({}, VALID_REQUEST, { outputMode: 'txt' }));
  return capturedPayload && capturedPayload.outputMode === 'txt';
});

// T-C25: outputMode=pdf se pasa al modelPayload
test('T-C25: outputMode=pdf pasa contrato', async function() {
  var capturedPayload;
  var factory = mockFactory(async function(params) {
    capturedPayload = JSON.parse(params.input);
    return wrapOAI(VALID_RESPONSE_BODY);
  });
  await call(factory, Object.assign({}, VALID_REQUEST, { outputMode: 'pdf' }));
  return capturedPayload && capturedPayload.outputMode === 'pdf';
});

// T-C26: outputMode=all se pasa al modelPayload
test('T-C26: outputMode=all pasa contrato', async function() {
  var capturedPayload;
  var factory = mockFactory(async function(params) {
    capturedPayload = JSON.parse(params.input);
    return wrapOAI(VALID_RESPONSE_BODY);
  });
  await call(factory, Object.assign({}, VALID_REQUEST, { outputMode: 'all' }));
  return capturedPayload && capturedPayload.outputMode === 'all';
});

// ════════════════════════════════════════════════════════════════════════════════
// Unit tests for internal helpers
// ════════════════════════════════════════════════════════════════════════════════

test('prepareModelRequest: strips infra keys', function() {
  var prep = prepareModelRequest(Object.assign({}, VALID_REQUEST, { attachments: [] }));
  return !prep.modelPayload.requestId
      && !prep.modelPayload.clientId
      && !prep.modelPayload.coachId
      && !prep.modelPayload.schema
      && !prep.modelPayload.attachments;
});

test('prepareModelRequest: preserves mode/outputMode/clientProfile', function() {
  var prep = prepareModelRequest(VALID_REQUEST);
  return prep.modelPayload.mode === 'new_plan'
      && prep.modelPayload.outputMode === 'json'
      && prep.modelPayload.clientProfile;
});

test('prepareModelRequest: pharmacologyOmitted flag when farmacologia present', function() {
  var req = JSON.parse(JSON.stringify(VALID_REQUEST));
  req.clientProfile.farmacologia = { compuesto: 'testosterona' };
  var prep = prepareModelRequest(req);
  return prep.pharmacologyOmitted === true && !prep.modelPayload.clientProfile.farmacologia;
});

test('prepareModelRequest: pharmacologyOmitted=false when no farmacologia', function() {
  var prep = prepareModelRequest(VALID_REQUEST);
  return prep.pharmacologyOmitted === false;
});

test('extractModelResponse: parses valid output_text', function() {
  var raw = wrapOAI({ status: 'VALID', schema: 'test' });
  var ext = extractModelResponse(raw);
  return ext.parsed && ext.parsed.status === 'VALID' && !ext.errorCode;
});

test('extractModelResponse: handles refusal', function() {
  var raw = wrapOAI(null, { refusal: 'Refuse.' });
  var ext = extractModelResponse(raw);
  return ext.refusal === 'Refuse.' && ext.errorCode === ERR.MODEL_REFUSAL;
});

test('extractModelResponse: handles empty output array', function() {
  var raw = { status: 'completed', output: [], usage: null };
  var ext = extractModelResponse(raw);
  return ext.errorCode === ERR.MODEL_EMPTY_OUTPUT;
});

test('extractModelResponse: handles status=incomplete', function() {
  var raw = { status: 'incomplete', output: [] };
  var ext = extractModelResponse(raw);
  return ext.incomplete === true && ext.errorCode === ERR.MODEL_OUTPUT_INCOMPLETE;
});

test('extractModelResponse: handles invalid JSON text', function() {
  var raw = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'NOT JSON {{{' }] }]
  };
  var ext = extractModelResponse(raw);
  return ext.errorCode === ERR.MODEL_SCHEMA_MISMATCH && ext.parsed === null;
});

test('removeNullFields: removes null root keys', function() {
  var obj = { a: 1, b: null, c: 'x', d: null };
  var out = removeNullFields(obj);
  return !('b' in out) && !('d' in out) && out.a === 1 && out.c === 'x';
});

test('removeNullFields: preserves non-null values including 0/false/empty string', function() {
  var obj = { a: 0, b: false, c: '', d: null };
  var out = removeNullFields(obj);
  return out.a === 0 && out.b === false && out.c === '' && !('d' in out);
});

// ════════════════════════════════════════════════════════════════════════════════
// T-C31..T-C36: sanitizeMissingInputs
// ════════════════════════════════════════════════════════════════════════════════

// T-C31: requestId in missingInputs is stripped
test('T-C31: sanitizeMissingInputs strips requestId from missingInputs', function() {
  var input = {
    status: 'NEEDS_INPUT',
    missingInputs: [
      { field: 'requestId', module: 'training', impact: 'blocking' },
      { field: 'edad', module: 'supplementation', impact: 'low' }
    ]
  };
  var out = sanitizeMissingInputs(input);
  return out.missingInputs.length === 1 && out.missingInputs[0].field === 'edad';
});

// T-C32: clientId, coachId, schema, requestedAt, attachments all stripped
test('T-C32: sanitizeMissingInputs strips all infra fields', function() {
  var input = {
    missingInputs: [
      { field: 'clientId',    module: 'training', impact: 'high' },
      { field: 'coachId',     module: 'training', impact: 'high' },
      { field: 'schema',      module: 'training', impact: 'high' },
      { field: 'requestedAt', module: 'training', impact: 'high' },
      { field: 'attachments', module: 'training', impact: 'high' },
      { field: 'peso_kg',     module: 'nutritionTargets', impact: 'high' }
    ]
  };
  var out = sanitizeMissingInputs(input);
  return out.missingInputs.length === 1 && out.missingInputs[0].field === 'peso_kg';
});

// T-C33: altura_cm normalized to talla_cm
test('T-C33: sanitizeMissingInputs normalizes altura_cm to talla_cm', function() {
  var input = {
    missingInputs: [
      { field: 'altura_cm', module: 'nutritionTargets', impact: 'high' }
    ]
  };
  var out = sanitizeMissingInputs(input);
  return out.missingInputs.length === 1 && out.missingInputs[0].field === 'talla_cm';
});

// T-C34: non-infra fields are preserved unchanged
test('T-C34: sanitizeMissingInputs preserves non-infra fields', function() {
  var input = {
    missingInputs: [
      { field: 'peso_kg', module: 'nutritionTargets', impact: 'high' },
      { field: 'perfil',  module: 'supplementation',  impact: 'high' }
    ]
  };
  var out = sanitizeMissingInputs(input);
  return out.missingInputs.length === 2
      && out.missingInputs[0].field === 'peso_kg'
      && out.missingInputs[1].field === 'perfil';
});

// T-C35: null/missing missingInputs passed through unchanged
test('T-C35: sanitizeMissingInputs handles null/empty missingInputs', function() {
  var noArray = sanitizeMissingInputs({ status: 'READY' });
  var emptyArr = sanitizeMissingInputs({ missingInputs: [] });
  return !noArray.missingInputs
      && Array.isArray(emptyArr.missingInputs) && emptyArr.missingInputs.length === 0;
});

// T-C36: null parsed input returns null
test('T-C36: sanitizeMissingInputs returns null for null input', function() {
  return sanitizeMissingInputs(null) === null;
});

// ─── Print results ─────────────────────────────────────────────────────────────

async function runTests() {
  var passed = 0;
  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    try {
      var ok = await t.fn();
      if (ok) {
        passed++;
        console.log('✅ ' + t.name);
      } else {
        console.log('❌ ' + t.name + '\n   → returned false/falsy');
      }
    } catch (e) {
      console.log('❌ ' + t.name + '\n   → ' + e.message);
    }
  }
  console.log('\n' + passed + '/' + tests.length + ' passed');
  process.exit(passed === tests.length ? 0 : 1);
}

runTests();
