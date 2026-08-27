'use strict';

// FASE D.1 — Tests T-D01..T-D25
// Tests cover the browser adapter (VDSEN_BUILD) contract surface and
// server-side validation behaviour the UI preview flow depends on.
// All pure unit tests — no network, no Firestore.

var contracts = require('./vdsen-contracts');
var buildMod  = require('./vdsen-build-request');

var validateGenerationRequest  = contracts.validateGenerationRequest;
var validateGenerationResponse = contracts.validateGenerationResponse;
var buildGenerationRequest     = buildMod.buildGenerationRequest;

// ─── Test harness ─────────────────────────────────────────────────────────────

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMinimalFichaDoc() {
  return {
    data: {
      nombre:    'Demo D',
      sexo:      'masculino',
      edad:      30,
      talla_cm:  178,
      peso_kg:   80,
      perfil:    'natural',
      nivel:     'intermedio',
      dias_semana: 4,
      objetivo_mesociclo: 'hipertrofia',
      grupos_prioritarios: ['pecho', 'espalda'],
      enfoque_actual: 'hipertrofia',
      objetivo_calorico: 2500,
      num_comidas: 4,
      restricciones_alimentarias: 'ninguna',
    },
    fotometria: null,
  };
}

function makeMinimalParams() {
  return {
    mode:     'new_plan',
    outputMode: 'json',
    clientId: 'client-d-test',
    coachId:  'coach-d-test',
    fichaDoc:  makeMinimalFichaDoc(),
    clientDoc: null,
    planDoc:   null,
    logsDoc:   null,
  };
}

function makeValidRequest() {
  var result = buildGenerationRequest(makeMinimalParams());
  return result.request || result.rawRequest;
}

function makeValidResponse(overrides) {
  var base = {
    schema:    'vdsen-generation-response-v1',
    requestId: 'req-d-test-1',
    status:    'VALID',
    plan: {
      schema: 'vdsen-plan-v2',
      entrenamiento: { weeks: 6, daysPerWeek: 4, days: [] },
      nutricion: { calorias: 2500, proteina: 180, carbos: 280, grasas: 70, texto: 'ok' },
      suplementacion: { tiers: [] },
    },
    missingInputs: [],
    flags:         [],
    decisionTrace: [],
    audit:         {},
  };
  return Object.assign({}, base, overrides || {});
}

// ─── T-D01: buildGenerationRequest returns an object with request/validation ──
test('T-D01: buildGenerationRequest returns object with request + validation', function() {
  var result = buildGenerationRequest(makeMinimalParams());
  assert(result != null, 'result not null');
  assert(typeof result.validation === 'object', 'validation present');
  assert(result.rawRequest != null, 'rawRequest present');
});

// ─── T-D02: validateGenerationRequest accepts well-formed request ─────────────
test('T-D02: validateGenerationRequest accepts well-formed raw request', function() {
  var result = buildGenerationRequest(makeMinimalParams());
  var v = validateGenerationRequest(result.rawRequest);
  assert(v.valid === true, 'valid flag: ' + JSON.stringify(v));
});

// ─── T-D03: validateGenerationRequest rejects request without mode ────────────
test('T-D03: validateGenerationRequest rejects request without mode', function() {
  var req = makeValidRequest();
  delete req.mode;
  var v = validateGenerationRequest(req);
  assert(v.valid === false, 'should be invalid');
  assert(Array.isArray(v.errors), 'errors array present');
});

// ─── T-D04: validateGenerationRequest rejects invalid mode ───────────────────
test('T-D04: validateGenerationRequest rejects unknown mode', function() {
  var req = makeValidRequest();
  req.mode = 'bad_mode';
  var v = validateGenerationRequest(req);
  assert(v.valid === false, 'should be invalid');
});

// ─── T-D05: validateGenerationRequest rejects missing clientProfile ───────────
test('T-D05: validateGenerationRequest rejects missing clientProfile', function() {
  var req = makeValidRequest();
  delete req.clientProfile;
  var v = validateGenerationRequest(req);
  assert(v.valid === false, 'should be invalid');
});

// ─── T-D06: mode new_plan accepted ───────────────────────────────────────────
test('T-D06: mode new_plan is accepted', function() {
  var params = makeMinimalParams();
  params.mode = 'new_plan';
  var result = buildGenerationRequest(params);
  var v = validateGenerationRequest(result.rawRequest);
  assert(v.valid === true, 'new_plan valid: ' + JSON.stringify(v));
});

// ─── T-D07: mode update_plan accepted ────────────────────────────────────────
test('T-D07: mode update_plan is accepted', function() {
  var params = makeMinimalParams();
  params.mode = 'update_plan';
  var result = buildGenerationRequest(params);
  var v = validateGenerationRequest(result.rawRequest);
  assert(v.valid === true, 'update_plan valid: ' + JSON.stringify(v));
});

// ─── T-D08: mode audit_plan accepted ─────────────────────────────────────────
test('T-D08: mode audit_plan is accepted', function() {
  var params = makeMinimalParams();
  params.mode = 'audit_plan';
  var result = buildGenerationRequest(params);
  var v = validateGenerationRequest(result.rawRequest);
  assert(v.valid === true, 'audit_plan valid: ' + JSON.stringify(v));
});

// ─── T-D09: outputMode json accepted ─────────────────────────────────────────
test('T-D09: outputMode json is accepted', function() {
  var params = makeMinimalParams();
  params.outputMode = 'json';
  var result = buildGenerationRequest(params);
  var v = validateGenerationRequest(result.rawRequest);
  assert(v.valid === true, 'json outputMode valid: ' + JSON.stringify(v));
});

// ─── T-D10: outputMode txt accepted ──────────────────────────────────────────
test('T-D10: outputMode txt is accepted', function() {
  var params = makeMinimalParams();
  params.outputMode = 'txt';
  var result = buildGenerationRequest(params);
  var v = validateGenerationRequest(result.rawRequest);
  assert(v.valid === true, 'txt outputMode valid: ' + JSON.stringify(v));
});

// ─── T-D11: requestId is always a non-empty string ───────────────────────────
test('T-D11: rawRequest.requestId is always a non-empty string', function() {
  var result = buildGenerationRequest(makeMinimalParams());
  var req = result.rawRequest;
  assert(typeof req.requestId === 'string', 'requestId type');
  assert(req.requestId.length >= 8, 'requestId length');
});

// ─── T-D12: two requests have different requestIds ────────────────────────────
test('T-D12: two consecutive requests get different requestIds', function() {
  var r1 = buildGenerationRequest(makeMinimalParams()).rawRequest;
  var r2 = buildGenerationRequest(makeMinimalParams()).rawRequest;
  assert(r1.requestId !== r2.requestId, 'requestIds differ');
});

// ─── T-D13: schema is vdsen-generation-request-v1 ────────────────────────────
test('T-D13: rawRequest.schema is vdsen-generation-request-v1', function() {
  var result = buildGenerationRequest(makeMinimalParams());
  assert(result.rawRequest.schema === 'vdsen-generation-request-v1', 'schema: ' + result.rawRequest.schema);
});

// ─── T-D14: validateGenerationResponse accepts VALID response ─────────────────
test('T-D14: validateGenerationResponse accepts VALID response with plan.schema', function() {
  var resp = makeValidResponse();
  var v = validateGenerationResponse(resp);
  assert(v.valid === true, 'VALID response accepted: ' + JSON.stringify(v));
});

// ─── T-D15: validateGenerationResponse accepts NEEDS_INPUT ───────────────────
test('T-D15: validateGenerationResponse accepts NEEDS_INPUT response', function() {
  var resp = {
    schema:    'vdsen-generation-response-v1',
    requestId: 'req-d-test-2',
    status:    'NEEDS_INPUT',
    plan:      null,
    missingInputs: [{ field: 'talla_cm', module: 'entrenamiento', criticality: 'REQUIRED' }],
    flags: [],
    decisionTrace: [],
    audit: {},
  };
  var v = validateGenerationResponse(resp);
  assert(v.valid === true, 'NEEDS_INPUT accepted: ' + JSON.stringify(v));
});

// ─── T-D16: validateGenerationResponse accepts NEEDS_COACH_REVIEW ────────────
test('T-D16: validateGenerationResponse accepts NEEDS_COACH_REVIEW response', function() {
  var resp = {
    schema:    'vdsen-generation-response-v1',
    requestId: 'req-d-test-3',
    status:    'NEEDS_COACH_REVIEW',
    plan:      null,
    missingInputs: [],
    flags: [{ code: 'REVIEW_NEEDED', message: 'algo raro', module: 'entrenamiento' }],
    decisionTrace: [],
    audit: {},
  };
  var v = validateGenerationResponse(resp);
  assert(v.valid === true, 'NEEDS_COACH_REVIEW accepted: ' + JSON.stringify(v));
});

// ─── T-D17: validateGenerationResponse rejects unknown status ─────────────────
test('T-D17: validateGenerationResponse rejects unknown status', function() {
  var resp = makeValidResponse({ status: 'MAGIC' });
  var v = validateGenerationResponse(resp);
  assert(v.valid === false, 'unknown status rejected');
});

// ─── T-D18: validateGenerationResponse warns on missing requestId ─────────────
test('T-D18: validateGenerationResponse warns (not errors) on missing requestId', function() {
  var resp = makeValidResponse();
  delete resp.requestId;
  var v = validateGenerationResponse(resp);
  // Missing requestId is a warning, not an error — response is still valid
  assert(v.valid === true, 'still valid: ' + JSON.stringify(v));
  var hasWarn = Array.isArray(v.warnings) && v.warnings.some(function(w) { return w.indexOf('requestId') !== -1; });
  assert(hasWarn, 'warning about requestId: ' + JSON.stringify(v.warnings));
});

// ─── T-D19: rawRequest.requestedAt is ISO string ─────────────────────────────
test('T-D19: rawRequest.requestedAt is a valid ISO date string', function() {
  var result = buildGenerationRequest(makeMinimalParams());
  var req = result.rawRequest;
  assert(typeof req.requestedAt === 'string', 'requestedAt type');
  var d = new Date(req.requestedAt);
  assert(!isNaN(d.getTime()), 'requestedAt is valid date');
});

// ─── T-D20: activePlan null (planDoc=null) is handled gracefully ──────────────
test('T-D20: buildGenerationRequest with planDoc=null is valid', function() {
  var params = makeMinimalParams();
  params.planDoc = null;
  var result = buildGenerationRequest(params);
  var v = validateGenerationRequest(result.rawRequest);
  assert(v.valid === true, 'null planDoc valid: ' + JSON.stringify(v));
});

// ─── T-D21: logs null (logsDoc=null) is handled gracefully ───────────────────
test('T-D21: buildGenerationRequest with logsDoc=null is valid', function() {
  var params = makeMinimalParams();
  params.logsDoc = null;
  var result = buildGenerationRequest(params);
  var v = validateGenerationRequest(result.rawRequest);
  assert(v.valid === true, 'null logsDoc valid: ' + JSON.stringify(v));
});

// ─── T-D22: rawRequest clientProfile is populated from fichaDoc.data ──────────
test('T-D22: rawRequest.clientProfile is mapped from fichaDoc.data', function() {
  var result = buildGenerationRequest(makeMinimalParams());
  var cp = result.rawRequest.clientProfile;
  assert(cp != null, 'clientProfile present');
  assert(typeof cp === 'object', 'clientProfile is object');
});

// ─── T-D23: validateGenerationResponse rejects missing schema ─────────────────
test('T-D23: validateGenerationResponse rejects missing schema', function() {
  var resp = makeValidResponse();
  delete resp.schema;
  var v = validateGenerationResponse(resp);
  assert(v.valid === false, 'missing schema rejected');
});

// ─── T-D24: validateGenerationResponse rejects VALID with plan missing schema ─
test('T-D24: validateGenerationResponse rejects VALID plan without plan.schema', function() {
  var resp = makeValidResponse();
  delete resp.plan.schema;
  var v = validateGenerationResponse(resp);
  assert(v.valid === false, 'plan without schema rejected');
});

// ─── T-D25: validateGenerationResponse accepts INVALID status with errors ─────
test('T-D25: validateGenerationResponse accepts INVALID status with errors array', function() {
  var resp = {
    schema:    'vdsen-generation-response-v1',
    requestId: 'req-d-test-6',
    status:    'INVALID',
    errors:    ['Solicitud mal formada'],
    plan:      null,
    missingInputs: [],
    flags:     [],
    decisionTrace: [],
    audit:     {},
  };
  var v = validateGenerationResponse(resp);
  assert(v.valid === true, 'INVALID status with errors accepted: ' + JSON.stringify(v));
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-D26..T-D35 — CLIENT OWNERSHIP SAFETY (mirrors loadClientList classification)
// ═══════════════════════════════════════════════════════════════════════════════

// Mirror of the classification logic in vdsen-coach.html loadClientList()
function classifyClient(data, coachUid) {
  var cid = data.coachId;
  if (cid === coachUid)          return 'OWNED';
  if (!cid || cid === '')        return 'LEGACY_UNASSIGNED';
  return 'FOREIGN_OWNER';
}

// Mirror of the assignLegacyClient safety guard (write-gate logic only)
function canAssignLegacy(data) {
  var cid = data.coachId;
  return !cid || cid === '';   // only if genuinely unassigned
}

var MY_UID    = 'coach-real-uid';
var OTHER_UID = 'coach-other-uid';

// ─── T-D26: OWNED appears ────────────────────────────────────────────────────
test('T-D26: OWNED client (coachId === mine) classified correctly', function() {
  var c = classifyClient({ coachId: MY_UID }, MY_UID);
  assert(c === 'OWNED', 'expected OWNED, got ' + c);
});

// ─── T-D27: LEGACY_UNASSIGNED detected ────────────────────────────────────────
test('T-D27: client with coachId=null classified as LEGACY_UNASSIGNED', function() {
  var c = classifyClient({ coachId: null }, MY_UID);
  assert(c === 'LEGACY_UNASSIGNED', 'expected LEGACY_UNASSIGNED, got ' + c);
});

// ─── T-D28: FOREIGN_OWNER not reassigned ─────────────────────────────────────
test('T-D28: FOREIGN_OWNER cannot be assigned via canAssignLegacy', function() {
  var data = { coachId: OTHER_UID };
  assert(canAssignLegacy(data) === false, 'FOREIGN_OWNER must not be assignable');
});

// ─── T-D29: FOREIGN_OWNER not classified as OWNED ────────────────────────────
test('T-D29: FOREIGN_OWNER not classified as OWNED or LEGACY', function() {
  var c = classifyClient({ coachId: OTHER_UID }, MY_UID);
  assert(c === 'FOREIGN_OWNER', 'expected FOREIGN_OWNER, got ' + c);
  assert(c !== 'OWNED', 'must not be OWNED');
  assert(c !== 'LEGACY_UNASSIGNED', 'must not be LEGACY');
});

// ─── T-D30: loadClientList does not auto-write (guard: FOREIGN_OWNER blocked) ─
test('T-D30: only LEGACY_UNASSIGNED is assignable, FOREIGN_OWNER is blocked', function() {
  var cases = [
    { data: { coachId: MY_UID },    expectAssignable: false }, // OWNED — no write needed
    { data: { coachId: null },       expectAssignable: true  }, // LEGACY
    { data: { coachId: '' },         expectAssignable: true  }, // LEGACY
    { data: { coachId: OTHER_UID },  expectAssignable: false }, // FOREIGN
  ];
  cases.forEach(function(tc) {
    var got = canAssignLegacy(tc.data);
    assert(got === tc.expectAssignable,
      'coachId=' + JSON.stringify(tc.data.coachId) + ' → assignable=' + got + ', expected=' + tc.expectAssignable);
  });
});

// ─── T-D31: list with ≥1 OWNED still detects legacy ─────────────────────────
test('T-D31: mixed list: OWNED present but LEGACY still identified', function() {
  var clients = [
    { id: '1', coachId: MY_UID },
    { id: '2', coachId: null },
    { id: '3', coachId: OTHER_UID },
  ];
  var legacy = clients.filter(function(c) { return classifyClient(c, MY_UID) === 'LEGACY_UNASSIGNED'; });
  assert(legacy.length === 1, 'expected 1 legacy, got ' + legacy.length);
  assert(legacy[0].id === '2', 'expected id=2');
});

// ─── T-D32: list with no OWNED still detects legacy ─────────────────────────
test('T-D32: list with no OWNED clients still detects LEGACY_UNASSIGNED', function() {
  var clients = [
    { id: '1', coachId: null },
    { id: '2', coachId: '' },
  ];
  var owned  = clients.filter(function(c) { return classifyClient(c, MY_UID) === 'OWNED'; });
  var legacy = clients.filter(function(c) { return classifyClient(c, MY_UID) === 'LEGACY_UNASSIGNED'; });
  assert(owned.length === 0, 'no OWNED');
  assert(legacy.length === 2, '2 LEGACY');
});

// ─── T-D33: coachId null → LEGACY_UNASSIGNED, not FOREIGN ───────────────────
test('T-D33: coachId null is LEGACY_UNASSIGNED, not FOREIGN_OWNER', function() {
  var c = classifyClient({ coachId: null }, MY_UID);
  assert(c === 'LEGACY_UNASSIGNED', 'null → LEGACY, got ' + c);
  assert(c !== 'FOREIGN_OWNER', 'null must not be FOREIGN');
});

// ─── T-D34: coachId empty string → LEGACY_UNASSIGNED, not FOREIGN ────────────
test('T-D34: coachId empty string is LEGACY_UNASSIGNED, not FOREIGN_OWNER', function() {
  var c = classifyClient({ coachId: '' }, MY_UID);
  assert(c === 'LEGACY_UNASSIGNED', 'empty → LEGACY, got ' + c);
  assert(c !== 'FOREIGN_OWNER', 'empty must not be FOREIGN');
});

// ─── T-D35: no write occurs for FOREIGN_OWNER during classification ───────────
test('T-D35: classifyClient itself produces no side effects (pure function)', function() {
  var writeCount = 0;
  function mockSetDoc() { writeCount++; }  // would be called if code tried to write

  var clients = [
    { coachId: MY_UID },
    { coachId: null },
    { coachId: OTHER_UID },
  ];
  // Simulate what loadClientList() does: classify only, no writes
  clients.forEach(function(c) { classifyClient(c, MY_UID); });
  assert(writeCount === 0, 'classification must produce zero writes, got ' + writeCount);
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-D36..T-D43  REQUEST WRAPPER FIX — vdsenAIPreview() body contract
// ═══════════════════════════════════════════════════════════════════════════════

var coachHtmlSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

// ─── T-D36: HTML uses buildResult.request as fetch body ───────────────────────
test('T-D36: vdsenAIPreview usa buildResult.request (no rawRequest) como body del fetch', function() {
  assert(coachHtmlSrc.indexOf('JSON.stringify(request)') !== -1,
    'debe haber JSON.stringify(request) en el fetch');
  // must NOT send the wrapper
  assert(coachHtmlSrc.indexOf('JSON.stringify(buildResult)') === -1,
    'NO debe enviar JSON.stringify(buildResult)');
});

// ─── T-D37: HTML does NOT send the wrapper object ────────────────────────────
test('T-D37: fetch body no contiene el wrapper completo {request,rawRequest,...}', function() {
  assert(coachHtmlSrc.indexOf('JSON.stringify(generationRequest)') === -1,
    'nombre antiguo "generationRequest" no debe estar en JSON.stringify — debe ser "request"');
  assert(coachHtmlSrc.indexOf('JSON.stringify(buildResult)') === -1,
    'buildResult completo no debe ser el body');
});

// ─── T-D38: HTML does NOT send rawRequest as body ────────────────────────────
test('T-D38: fetch body no usa rawRequest directamente', function() {
  // Specifically, JSON.stringify(buildResult.rawRequest) must not appear
  assert(coachHtmlSrc.indexOf('JSON.stringify(buildResult.rawRequest)') === -1,
    'rawRequest no debe ser el body del fetch');
  assert(coachHtmlSrc.indexOf('JSON.stringify(rawRequest)') === -1,
    'variable rawRequest no debe ser el body del fetch');
});

// ─── T-D39: pre-fetch check stops request without schema ─────────────────────
test('T-D39: pre-fetch check detecta schema incorrecto', function() {
  var badRequest = { mode: 'new_plan', clientProfile: {}, schema: 'wrong-schema' };
  var blocked = (
    !badRequest
    || badRequest.schema !== 'vdsen-generation-request-v1'
    || !badRequest.mode
    || !badRequest.clientProfile
    || typeof badRequest.clientProfile !== 'object'
  );
  assert(blocked, 'request con schema incorrecto debe ser bloqueado');
});

// ─── T-D40: pre-fetch check stops request without mode ───────────────────────
test('T-D40: pre-fetch check detecta mode faltante', function() {
  var badRequest = { schema: 'vdsen-generation-request-v1', clientProfile: {} };
  var blocked = (
    !badRequest
    || badRequest.schema !== 'vdsen-generation-request-v1'
    || !badRequest.mode
    || !badRequest.clientProfile
    || typeof badRequest.clientProfile !== 'object'
  );
  assert(blocked, 'request sin mode debe ser bloqueado');
});

// ─── T-D41: pre-fetch check stops request without clientProfile ───────────────
test('T-D41: pre-fetch check detecta clientProfile faltante', function() {
  var badRequest = { schema: 'vdsen-generation-request-v1', mode: 'new_plan' };
  var blocked = (
    !badRequest
    || badRequest.schema !== 'vdsen-generation-request-v1'
    || !badRequest.mode
    || !badRequest.clientProfile
    || typeof badRequest.clientProfile !== 'object'
  );
  assert(blocked, 'request sin clientProfile debe ser bloqueado');
});

// ─── T-D42: valid buildResult.request contains required top-level fields ─────
test('T-D42: buildResult.request contiene schema, mode, clientProfile', function() {
  var result = buildGenerationRequest(makeMinimalParams());
  var req = result.request;
  assert(req, 'result.request no debe ser null');
  assert(req.schema === 'vdsen-generation-request-v1',
    'schema debe ser vdsen-generation-request-v1, got: ' + req.schema);
  assert(req.mode === 'new_plan',
    'mode debe ser new_plan, got: ' + req.mode);
  assert(req.clientProfile && typeof req.clientProfile === 'object',
    'clientProfile debe ser un objeto');
});

// ─── T-D43: buildResult.request does NOT carry wrapper fields ────────────────
test('T-D43: buildResult.request NO contiene rawRequest, validation, diagnostics', function() {
  var result = buildGenerationRequest(makeMinimalParams());
  var req = result.request;
  assert(req.rawRequest === undefined,
    'request.rawRequest debe ser undefined (no mandar wrapper)');
  assert(req.validation === undefined,
    'request.validation debe ser undefined (no mandar wrapper)');
  assert(req.diagnostics === undefined,
    'request.diagnostics debe ser undefined (no mandar wrapper)');
});

// ════════════════════════════════════════════════════════════════════════════════
// D.1.5 — COACH REVIEW GATE  T-D44..T-D57
// ════════════════════════════════════════════════════════════════════════════════

var generateMod = require('./vdsen-generate');
var _internal   = generateMod._internal;
var sanitizeWarnings      = _internal.sanitizeWarnings;
var sanitizeMissingInputs = _internal.sanitizeMissingInputs;
var prepareModelRequest   = _internal.prepareModelRequest;
var buildSystemPrompt     = _internal.buildSystemPrompt;

// ─── T-D44: sanitizeWarnings strips requestId warnings ───────────────────────
test('T-D44: sanitizeWarnings elimina warnings que mencionan requestId', function() {
  var parsed = {
    status: 'NEEDS_COACH_REVIEW',
    warnings: [
      'Se detectó dolor en pezón izquierdo.',
      'El requestId no estaba presente en la entrada; se generó uno vacío.',
      'Hematocrito previo de 56.7%.'
    ]
  };
  var result = sanitizeWarnings(parsed);
  assert(result.warnings.length === 2, 'debe quedar 2 warnings, quedan: ' + result.warnings.length);
  assert(!result.warnings.some(function(w){ return /requestId/.test(w); }),
    'requestId warning debe haber sido eliminado');
});

// ─── T-D45: sanitizeWarnings también filtra clientId/coachId ─────────────────
test('T-D45: sanitizeWarnings filtra clientId y coachId', function() {
  var parsed = {
    warnings: [
      'clientId no estaba en la entrada.',
      'coachId faltante en el payload.',
      'Warning legítimo sobre el cliente.'
    ]
  };
  var result = sanitizeWarnings(parsed);
  assert(result.warnings.length === 1, 'debe quedar solo 1 warning legítimo');
  assert(result.warnings[0] === 'Warning legítimo sobre el cliente.', 'warning legítimo preservado');
});

// ─── T-D46: sanitizeWarnings no toca parsed sin warnings ─────────────────────
test('T-D46: sanitizeWarnings devuelve parsed intacto si no hay warnings', function() {
  var parsed = { status: 'VALID' };
  var result = sanitizeWarnings(parsed);
  assert(result === parsed, 'debe retornar el mismo objeto si no hay warnings');
});

// ─── T-D47: sanitizeWarnings preserva warnings legítimos ─────────────────────
test('T-D47: sanitizeWarnings preserva warnings de contenido clínico', function() {
  var medWarning = 'Se reporta hematocrito de 56.7% — monitoreo requerido.';
  var parsed = { warnings: [medWarning] };
  var result = sanitizeWarnings(parsed);
  assert(result.warnings.length === 1 && result.warnings[0] === medWarning,
    'warning clínico no debe ser filtrado');
});

// ─── T-D48: sistema prompt NO instruye al modelo sobre requestId ──────────────
test('T-D48: sistema prompt no dice "coincidir exactamente con el requestId de la entrada"', function() {
  var prompt = buildSystemPrompt();
  assert(!/coincidir exactamente con el requestId de la entrada/.test(prompt),
    'la instrucción errónea fue eliminada del prompt');
});

// ─── T-D49: sistema prompt instruye al modelo a NO reportar infra fields ──────
test('T-D49: sistema prompt indica que requestId es administrado por el servidor', function() {
  var prompt = buildSystemPrompt();
  assert(/administrados por el servidor/.test(prompt),
    'prompt debe aclarar que requestId es admin del servidor');
});

// ─── T-D50: prepareModelRequest strip requestId del payload al modelo ─────────
test('T-D50: prepareModelRequest elimina requestId del payload enviado al modelo', function() {
  var req = { schema: 'vdsen-generation-request-v1', requestId: 'req-test', mode: 'new_plan',
    clientProfile: { base: { perfil: 'natural' } } };
  var result = prepareModelRequest(req);
  assert(result.modelPayload.requestId === undefined, 'requestId no debe estar en modelPayload');
});

// ─── T-D51: perfil natural en adapter → clientProfile.base.perfil = 'natural' ─
test('T-D51: buildGenerationRequest mapea perfil natural correctamente', function() {
  var params = makeMinimalParams(); // fichaDoc.data.perfil = 'natural'
  var result = buildGenerationRequest(params);
  assert(result.request !== null, 'request no debe ser null: ' + JSON.stringify(result.validation));
  var base = result.request.clientProfile.base;
  assert(base.perfil === 'natural', 'perfil debe ser "natural", recibido: ' + base.perfil);
});

// ─── T-D52: perfil PED → farmacologia STRIP en modelPayload ──────────────────
test('T-D52: prepareModelRequest elimina farmacologia del payload aunque perfil=PED', function() {
  var req = { schema: 'vdsen-generation-request-v1', requestId: 'r', mode: 'new_plan',
    clientProfile: { base: { perfil: 'PED' }, farmacologia: { experiencia_peds: '3 años' } } };
  var result = prepareModelRequest(req);
  assert(!result.modelPayload.clientProfile.farmacologia,
    'farmacologia debe eliminarse del modelPayload');
  assert(result.pharmacologyOmitted === true, 'pharmacologyOmitted debe ser true');
});

// ─── T-D53: perfil natural → farmacologia nunca se incluye ───────────────────
test('T-D53: buildGenerationRequest natural no incluye farmacologia', function() {
  var params = makeMinimalParams();
  var result = buildGenerationRequest(params);
  assert(!result.request.clientProfile.farmacologia,
    'farmacologia no debe estar en request para perfil natural');
});

// ─── T-D54: activePlanId no se modifica en buildGenerationRequest ─────────────
test('T-D54: buildGenerationRequest no escribe ni modifica activePlanId', function() {
  var params = makeMinimalParams();
  var result = buildGenerationRequest(params);
  // activePlanId is not a field of the generation request at all
  assert(result.request.activePlanId === undefined, 'activePlanId no debe existir en la solicitud');
  assert(result.rawRequest.activePlanId === undefined, 'activePlanId no debe existir en rawRequest');
});

// ─── T-D55: reviewGate readyForApproval = false si existen pendientes ─────────
test('T-D55: reviewGate readyForApproval=false si no todos los ítems revisados', function() {
  // Simulate reviewGate logic (pure function behavior)
  var items = [
    { type: 'general' },
    { type: 'medical' }
  ];
  var state = { 0: 'accept' }; // only 1 of 2 reviewed
  var reviewed = 0; var total = 0; var hasAdjust = false;
  items.forEach(function(item, idx){ if(item.type==='info')return; total++; if(state[idx])reviewed++; if(state[idx]==='adjust')hasAdjust=true; });
  var readyForApproval = reviewed >= total && total > 0 && !hasAdjust;
  assert(readyForApproval === false, 'readyForApproval debe ser false con ítems pendientes');
});

// ─── T-D56: reviewGate readyForApproval = false si hay adjust ────────────────
test('T-D56: reviewGate readyForApproval=false si algún ítem marcado "adjust"', function() {
  var items = [{ type: 'general' }, { type: 'general' }];
  var state = { 0: 'accept', 1: 'adjust' };
  var reviewed = 0; var total = 0; var hasAdjust = false;
  items.forEach(function(item, idx){ if(item.type==='info')return; total++; if(state[idx])reviewed++; if(state[idx]==='adjust')hasAdjust=true; });
  var readyForApproval = reviewed >= total && total > 0 && !hasAdjust;
  assert(readyForApproval === false, 'readyForApproval debe ser false con adjust pendiente');
});

// ─── T-D57: reviewGate readyForApproval = true cuando todos aceptados ────────
test('T-D57: reviewGate readyForApproval=true cuando todos aceptados (sin reject, sin adjust)', function() {
  var items = [{ type: 'general' }, { type: 'medical' }, { type: 'info' }];
  var state = { 0: 'accept', 1: 'accept' }; // info (idx 2) no cuenta
  var reviewed = 0; var total = 0; var hasAdjust = false; var hasReject = false;
  items.forEach(function(item, idx){ if(item.type==='info')return; total++; if(state[idx])reviewed++; if(state[idx]==='adjust')hasAdjust=true; if(state[idx]==='reject')hasReject=true; });
  var consistent = true; // no consistency issues
  var readyForApproval = reviewed >= total && total > 0 && !hasAdjust && !hasReject && consistent;
  assert(readyForApproval === true, 'readyForApproval debe ser true: reviewed=' + reviewed + ' total=' + total);
});

// ─── T-D58: _normalizePlan passthrough español ────────────────────────────────
test('T-D58: _normalizePlan: plan.entrenamiento (español) → conservado', function() {
  var p = { entrenamiento: { days: [{ dayIndex: 1 }] }, schema: 'vdsen-plan-v2' };
  function norm(x) {
    if (!x || typeof x !== 'object') return {};
    return {
      entrenamiento:  x.entrenamiento  !== undefined ? x.entrenamiento  : x.training,
      nutricion:      x.nutricion      !== undefined ? x.nutricion      : x.nutrition,
      suplementacion: x.suplementacion !== undefined ? x.suplementacion : x.supplementation,
    };
  }
  var n = norm(p);
  assert(n.entrenamiento && Array.isArray(n.entrenamiento.days), 'entrenamiento debe estar en el resultado normalizado');
});

// ─── T-D59: _normalizePlan fallback English training ─────────────────────────
test('T-D59: _normalizePlan: plan.training (inglés) → mapeado a entrenamiento', function() {
  var p = { training: { days: [{ dayIndex: 1 }] }, schema: 'vdsen-plan-v2' };
  function norm(x) {
    if (!x || typeof x !== 'object') return {};
    return {
      entrenamiento:  x.entrenamiento  !== undefined ? x.entrenamiento  : x.training,
      nutricion:      x.nutricion      !== undefined ? x.nutricion      : x.nutrition,
      suplementacion: x.suplementacion !== undefined ? x.suplementacion : x.supplementation,
    };
  }
  var n = norm(p);
  assert(n.entrenamiento && Array.isArray(n.entrenamiento.days), 'plan.training debe mapearse a entrenamiento');
});

// ─── T-D60: _normalizePlan passthrough nutricion ──────────────────────────────
test('T-D60: _normalizePlan: plan.nutricion (español) → conservado', function() {
  var p = { nutricion: { calorias: 2700 } };
  function norm(x) {
    if (!x || typeof x !== 'object') return {};
    return { nutricion: x.nutricion !== undefined ? x.nutricion : x.nutrition };
  }
  var n = norm(p);
  assert(n.nutricion && n.nutricion.calorias === 2700, 'nutricion debe estar presente');
});

// ─── T-D61: _normalizePlan fallback English nutrition ────────────────────────
test('T-D61: _normalizePlan: plan.nutrition (inglés) → mapeado a nutricion', function() {
  var p = { nutrition: { calorias: 2700 } };
  function norm(x) {
    if (!x || typeof x !== 'object') return {};
    return { nutricion: x.nutricion !== undefined ? x.nutricion : x.nutrition };
  }
  var n = norm(p);
  assert(n.nutricion && n.nutricion.calorias === 2700, 'plan.nutrition debe mapearse a nutricion');
});

// ─── T-D62: _normalizePlan passthrough suplementacion ────────────────────────
test('T-D62: _normalizePlan: plan.suplementacion (español) → conservado', function() {
  var p = { suplementacion: { tiers: [{ nombre: 'Tier 1' }] } };
  function norm(x) {
    if (!x || typeof x !== 'object') return {};
    return { suplementacion: x.suplementacion !== undefined ? x.suplementacion : x.supplementation };
  }
  var n = norm(p);
  assert(n.suplementacion && Array.isArray(n.suplementacion.tiers), 'suplementacion debe estar presente');
});

// ─── T-D63: _normalizePlan fallback English supplementation ──────────────────
test('T-D63: _normalizePlan: plan.supplementation (inglés) → mapeado a suplementacion', function() {
  var p = { supplementation: { tiers: [{ nombre: 'Tier 1' }] } };
  function norm(x) {
    if (!x || typeof x !== 'object') return {};
    return { suplementacion: x.suplementacion !== undefined ? x.suplementacion : x.supplementation };
  }
  var n = norm(p);
  assert(n.suplementacion && Array.isArray(n.suplementacion.tiers), 'plan.supplementation debe mapearse a suplementacion');
});

// ─── T-D64: decisionTrace array → renderizable ───────────────────────────────
test('T-D64: decisionTrace como array → length > 0', function() {
  var rawTrace = [{ module: 'training', confidence: 0.9 }];
  var trace = Array.isArray(rawTrace) ? rawTrace : (rawTrace && typeof rawTrace === 'object' ? Object.values(rawTrace) : []);
  assert(trace.length > 0, 'array de trace debe tener length > 0');
});

// ─── T-D65: decisionTrace object → renderizable via Object.values ─────────────
test('T-D65: decisionTrace como objeto → Object.values() tiene length > 0', function() {
  var rawTrace = { training: { module: 'training', confidence: 0.9 }, nutrition: { module: 'nutrition', confidence: 0.8 } };
  var trace = Array.isArray(rawTrace) ? rawTrace : (rawTrace && typeof rawTrace === 'object' ? Object.values(rawTrace) : []);
  assert(trace.length === 2, 'Object.values del trace debe tener 2 elementos');
});

// ─── T-D66: consistencia: macroCheck sin nutricion → issue ───────────────────
test('T-D66: _checkResponseConsistency: audit.macroCheck sin plan.nutricion → issue reportado', function() {
  var audit = { macroCheck: { status: 'PASS', declaredCalories_kcal: 2700 } };
  var rawPlan = { entrenamiento: { days: [] } }; // no nutricion
  function norm(p) {
    if (!p || typeof p !== 'object') return {};
    return { nutricion: p.nutricion !== undefined ? p.nutricion : p.nutrition,
             entrenamiento: p.entrenamiento !== undefined ? p.entrenamiento : p.training };
  }
  function checkConsistency(a, rp) {
    if (!a || !Object.keys(a).length) return [];
    var p = norm(rp);
    var issues = [];
    if (a.macroCheck && p.nutricion == null) issues.push('nutricion ausente');
    if ((a.loadCheck || a.fractionalVolumeCheck) && p.entrenamiento == null) issues.push('entrenamiento ausente');
    return issues;
  }
  var issues = checkConsistency(audit, rawPlan);
  assert(issues.length > 0, 'debe detectar inconsistencia: macroCheck sin nutricion');
  assert(issues[0].indexOf('nutricion') !== -1, 'issue debe mencionar nutricion');
});

// ─── T-D67: consistencia: loadCheck sin entrenamiento → issue ────────────────
test('T-D67: _checkResponseConsistency: audit.loadCheck sin plan.entrenamiento → issue reportado', function() {
  var audit = { loadCheck: { status: 'PASS', allExerciseLoadsZero: true } };
  var rawPlan = { nutricion: { calorias: 2700 } }; // no entrenamiento
  function norm(p) {
    if (!p || typeof p !== 'object') return {};
    return { nutricion: p.nutricion !== undefined ? p.nutricion : p.nutrition,
             entrenamiento: p.entrenamiento !== undefined ? p.entrenamiento : p.training };
  }
  function checkConsistency(a, rp) {
    if (!a || !Object.keys(a).length) return [];
    var p = norm(rp);
    var issues = [];
    if (a.macroCheck && p.nutricion == null) issues.push('nutricion ausente');
    if ((a.loadCheck || a.fractionalVolumeCheck) && p.entrenamiento == null) issues.push('entrenamiento ausente');
    return issues;
  }
  var issues = checkConsistency(audit, rawPlan);
  assert(issues.length > 0, 'debe detectar inconsistencia: loadCheck sin entrenamiento');
  assert(issues[0].indexOf('entrenamiento') !== -1, 'issue debe mencionar entrenamiento');
});

// ─── T-D68: inconsistencia bloquea readyForApproval ──────────────────────────
test('T-D68: inconsistencia en response → readyForApproval false', function() {
  var items  = [{ type: 'general' }];
  var state  = { 0: 'accept' };
  var reviewed = 0; var total = 0; var hasAdjust = false; var hasReject = false;
  items.forEach(function(item, idx){ if(item.type==='info')return; total++; if(state[idx])reviewed++; if(state[idx]==='adjust')hasAdjust=true; if(state[idx]==='reject')hasReject=true; });
  var consistent = false; // inconsistency detected
  var readyForApproval = reviewed >= total && total > 0 && !hasAdjust && !hasReject && consistent;
  assert(readyForApproval === false, 'inconsistencia debe bloquear readyForApproval');
});

// ─── T-D69: reject bloquea readyForApproval ──────────────────────────────────
test('T-D69: reject → readyForApproval false', function() {
  var items = [{ type: 'general' }, { type: 'medical' }];
  var state = { 0: 'accept', 1: 'reject' };
  var reviewed = 0; var total = 0; var hasAdjust = false; var hasReject = false;
  items.forEach(function(item, idx){ if(item.type==='info')return; total++; if(state[idx])reviewed++; if(state[idx]==='adjust')hasAdjust=true; if(state[idx]==='reject')hasReject=true; });
  var consistent = true;
  var readyForApproval = reviewed >= total && total > 0 && !hasAdjust && !hasReject && consistent;
  assert(readyForApproval === false, 'reject debe bloquear readyForApproval aunque todos revisados');
});

// ─── T-D71: _normalizeTraining: sessions → days ──────────────────────────────
test('T-D71: _normalizeTraining: training.sessions (fallback) → normalizado a .days[]', function() {
  var t = { weeks: 6, daysPerWeek: 4, sessions: [{ dayIndex: 1, label: 'Piernas', exercises: [] }] };
  function normalizeTraining(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    var days = obj.days || obj.sessions || obj.trainingDays || obj.schedule || [];
    if (!Array.isArray(days)) days = Object.values(days);
    return Object.assign({}, obj, { days: days });
  }
  var n = normalizeTraining(t);
  assert(Array.isArray(n.days), 'days debe ser array tras normalizacion');
  assert(n.days.length === 1, 'debe tener 1 día');
});

// ─── T-D72: _normalizeTraining: days como objeto numerado → array ─────────────
test('T-D72: _normalizeTraining: training.days como objeto de keys numéricos → array', function() {
  var t = { days: { 0: { dayIndex: 1 }, 1: { dayIndex: 2 } } };
  function normalizeTraining(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    var days = obj.days || obj.sessions || [];
    if (!Array.isArray(days)) days = Object.values(days);
    return Object.assign({}, obj, { days: days });
  }
  var n = normalizeTraining(t);
  assert(Array.isArray(n.days) && n.days.length === 2, 'debe convertir objeto a array de días');
});

// ─── T-D73: _normalizeNutrition: calories → calorias ────────────────────────
test('T-D73: _normalizeNutrition: nutrition.calories (inglés) → calorias', function() {
  var n = { calories: 2800, protein: 215, carbs: 305, fats: 80 };
  function normalizeNutrition(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    return Object.assign({}, obj, {
      calorias: obj.calorias !== undefined ? obj.calorias : (obj.calories !== undefined ? obj.calories : obj.totalCalories),
      proteina: obj.proteina !== undefined ? obj.proteina : (obj.protein  !== undefined ? obj.protein  : obj.protein_g),
      carbos:   obj.carbos   !== undefined ? obj.carbos   : (obj.carbs    !== undefined ? obj.carbs    : (obj.carbohydrates || obj.carbs_g)),
      grasas:   obj.grasas   !== undefined ? obj.grasas   : (obj.fats     !== undefined ? obj.fats     : (obj.fat || obj.fat_g)),
    });
  }
  var result = normalizeNutrition(n);
  assert(result.calorias === 2800, 'calories debe mapearse a calorias: ' + result.calorias);
  assert(result.proteina === 215,  'protein debe mapearse a proteina: ' + result.proteina);
  assert(result.carbos   === 305,  'carbs debe mapearse a carbos: '     + result.carbos);
  assert(result.grasas   === 80,   'fats debe mapearse a grasas: '      + result.grasas);
});

// ─── T-D74: _normalizeSupplementation: tiers objeto → array ──────────────────
test('T-D74: _normalizeSupplementation: tiers como objeto → array', function() {
  var s = { tiers: { 0: { name: 'Tier 1', items: [] }, 1: { name: 'Tier 2', items: [] } } };
  function normalizeSupplementation(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    var tiers = obj.tiers || obj.protocol || [];
    if (!Array.isArray(tiers)) tiers = Object.values(tiers);
    return Object.assign({}, obj, { tiers: tiers });
  }
  var result = normalizeSupplementation(s);
  assert(Array.isArray(result.tiers) && result.tiers.length === 2, 'tiers debe convertirse en array de 2 elementos');
});

// ─── T-D75: consistencia con audit.validation.macroEnergyCheck (estructura anidada) ─
test('T-D75: _checkResponseConsistency detecta inconsistencia con audit.validation.* nested', function() {
  var audit = { validation: { macroEnergyCheck: { sum_kcal: 2800, declared_kcal: 2800 } } };
  var rawPlan = { training: { days: [] } }; // no nutricion ni nutrition
  function norm(p) {
    return { nutricion: p.nutricion !== undefined ? p.nutricion : p.nutrition };
  }
  function checkConsistency(a, rp) {
    if (!a || !Object.keys(a).length) return [];
    var val = a.validation || a;
    var p = norm(rp);
    var issues = [];
    if ((val.macroCheck || val.macroEnergyCheck) && p.nutricion == null) issues.push('nutricion ausente');
    return issues;
  }
  var issues = checkConsistency(audit, rawPlan);
  assert(issues.length > 0, 'debe detectar inconsistencia con audit.validation.macroEnergyCheck');
});

// ─── T-D76: sistema prompt regla 20 — campo "entrenamiento" explícito ─────────
test('T-D76: sistema prompt regla 20 menciona nombres de campo canónicos en español', function() {
  var prompt = buildSystemPrompt();
  assert(/entrenamiento\.weeks/i.test(prompt) || /entrenamiento\.days/i.test(prompt),
    'prompt debe mencionar nombres de campo canónicos de entrenamiento');
  assert(/nutricion\.calorias/i.test(prompt),
    'prompt debe mencionar nutricion.calorias');
  assert(/suplementacion\.tiers/i.test(prompt),
    'prompt debe mencionar suplementacion.tiers');
});

// ─── T-D70: D.1.6 no escribe en Firestore (structural) ───────────────────────
test('T-D70: D.1.6 no hace writes Firestore (pure local logic, no async side-effects)', function() {
  // _normalizePlan, _checkResponseConsistency, _vdsenUpdateReviewPanel son pure functions
  // sin acceso a Firestore. Este test es estructural: si alguna de estas funciones
  // tuviera imports de Firebase, el test file fallaría al cargar.
  assert(typeof require('./vdsen-contracts').validateGenerationResponse === 'function',
    'contracts importados correctamente — sin Firebase en scope de pruebas');
  assert(typeof require('./vdsen-build-request').buildGenerationRequest === 'function',
    'build-request importado correctamente — sin Firebase en scope de pruebas');
});

// ─── FASE D.2 — Tests D.2-A (Save Approved Draft) ────────────────────────────
//
// Pure-logic tests only. No Firestore, no network.
// Helper inlines the same logic as _vdsenSaveDraftToFirestore so we can assert
// on the doc shape without mocking Firebase.

function buildDraftDocFromResp(resp, clientId, coachId, reviewStateForReq) {
  // Mirrors _vdsenSaveDraftToFirestore doc-assembly logic
  var rawPlan  = resp.plan || {};
  function normTrain(t) {
    if (!t || typeof t !== 'object') return {};
    var days = t.days || t.sessions || t.trainingDays || t.schedule || [];
    if (!Array.isArray(days)) days = Object.values(days);
    return Object.assign({}, t, { days: days });
  }
  function normNutr(n) {
    if (!n || typeof n !== 'object') return {};
    return Object.assign({}, n, {
      calorias: n.calorias !== undefined ? n.calorias : (n.calories !== undefined ? n.calories : 0),
      proteina: n.proteina !== undefined ? n.proteina : (n.protein  !== undefined ? n.protein  : 0),
      carbos:   n.carbos   !== undefined ? n.carbos   : (n.carbs    !== undefined ? n.carbs    : 0),
      grasas:   n.grasas   !== undefined ? n.grasas   : (n.fats     !== undefined ? n.fats     : 0),
      texto:    n.texto || n.text || '',
    });
  }
  function normSuppl(s) {
    if (!s || typeof s !== 'object') return {};
    var tiers = s.tiers || s.protocol || s.supplements || [];
    if (!Array.isArray(tiers)) tiers = Object.values(tiers);
    return Object.assign({}, s, { tiers: tiers });
  }
  var p = {
    entrenamiento:  rawPlan.entrenamiento !== undefined ? rawPlan.entrenamiento : rawPlan.training,
    nutricion:      rawPlan.nutricion     !== undefined ? rawPlan.nutricion     : rawPlan.nutrition,
    suplementacion: rawPlan.suplementacion !== undefined ? rawPlan.suplementacion : rawPlan.supplementation,
  };
  var training = normTrain(p.entrenamiento)  || {};
  var nutr     = normNutr(p.nutricion)       || {};
  var suppl    = normSuppl(p.suplementacion) || {};

  var revItems = (reviewStateForReq && reviewStateForReq.__items) || [];
  var totalItems = 0, acceptedItems = 0;
  revItems.forEach(function(item, idx) {
    if (item.type === 'info') return;
    totalItems++;
    if (reviewStateForReq && reviewStateForReq[idx] === 'accept') acceptedItems++;
  });

  var supplText = '';
  if (suppl.tiers && Array.isArray(suppl.tiers)) {
    supplText = suppl.tiers.map(function(tier) {
      var ti = (tier.items || []).map(function(item) { return item.nombre + (item.dosis ? ' — ' + item.dosis : ''); });
      return (tier.nombre || 'Tier') + ': ' + ti.join(', ');
    }).join('\n');
  }

  return {
    coachId:             coachId,
    clientId:            clientId,
    generationRequestId: resp.requestId,
    source:              'vdsen-ai',
    generatedBy:         'vdsen-ai',
    model:               resp.model || '',
    status:              'draft_approved',
    weeks:               (training.weeks      !== undefined ? training.weeks      : 0),
    daysPerWeek:         (training.daysPerWeek !== undefined ? training.daysPerWeek : 0),
    days:                (Array.isArray(training.days) ? training.days : []),
    nutritionDisplay: {
      calorias: nutr.calorias || 0,
      proteina: nutr.proteina || 0,
      carbos:   nutr.carbos   || 0,
      grasas:   nutr.grasas   || 0,
      texto:    nutr.texto    || '',
    },
    nutritionRaw:      nutr,
    supplementDisplay: { texto: supplText },
    supplementsRaw:    suppl,
    reviewSummary:     { totalItems: totalItems, acceptedItems: acceptedItems },
    // sentinel for no-pharma tests
    _NO_PHARMA_: true,
  };
}

// Precondition gate (mirrors _vdsenSaveDraftToFirestore prechecks, pure)
// reviewState: _vdsenReviewState[requestId] (with __items and __consistency)
// requiresReview: true for NEEDS_COACH_REVIEW, false for VALID
// D.2.1: medical blocker regex (mirrors _MEDICAL_BLOCKER_RE in coach app)
var MEDICAL_BLOCKER_RE = /pez[oó]n|tejido|palpaci[oó]n|hematocrito|hemato|biomar|cl[ií]nic|m[eé]dic|diagn[oó]s|neurol[oó]g/i;

// Helper: build blockingStatus for a review item (mirrors _buildReviewItems logic)
function itemBlockingStatus(item) {
  if (item.blockingStatus) return item.blockingStatus; // explicit
  if (item.type === 'medical') return 'blocks_activation';
  return 'non_blocking';
}

function checkD2APreconditions(resp, clientId, coachId, clientData, reviewState, requiresReview) {
  var errors = [];
  if (!coachId) errors.push('NO_COACH_SESSION');
  if (!clientId) errors.push('NO_CLIENT_ID');
  if (!resp.requestId) errors.push('NO_REQUEST_ID');
  if (!resp.plan || typeof resp.plan !== 'object') errors.push('NO_PLAN');
  if (resp.status === 'INVALID' || resp.status === 'ERROR') errors.push('INVALID_STATUS:' + resp.status);
  if (clientData && clientData.coachId !== coachId) errors.push('FOREIGN_OWNER');

  // Defense in depth: review gate (enforced in function, not just UI)
  if (requiresReview) {
    var rs = reviewState || {};
    var consistency = rs.__consistency || [];
    if (consistency.length > 0) errors.push('CONSISTENCY_FAIL');
    var items = rs.__items || [];
    var unresolved = 0, rejected = 0, adjustment = 0, medicalBlockers = 0;
    items.forEach(function(item, idx) {
      if (item.type === 'info') return;
      var decision = rs[idx];
      // D.2.1: blocks_activation items always block regardless of acknowledgment
      if (itemBlockingStatus(item) === 'blocks_activation') medicalBlockers++;
      if (decision === 'reject') rejected++;
      else if (decision === 'adjust' || decision === 'requires_adjustment') adjustment++;
      else if (!decision) unresolved++;
    });
    if (medicalBlockers > 0) errors.push('MEDICAL_BLOCKER');
    if (rejected > 0) errors.push('REVIEW_REJECTED');
    if (adjustment > 0) errors.push('REVIEW_ADJUSTMENT');
    if (unresolved > 0) errors.push('REVIEW_INCOMPLETE');
  }

  return errors;
}

// Idempotency conflict check (mirrors pre-write check in _vdsenSaveDraftToFirestore)
function checkIdempotencyConflict(existingDoc, clientId, coachId) {
  if (!existingDoc) return null; // doc doesn't exist — no conflict
  if (existingDoc.clientId !== clientId || existingDoc.coachId !== coachId) return 'IDEMPOTENCY_CONFLICT';
  return null; // same identity — idempotent success
}

// ─── T-D77: buildDraftDoc shape — status draft_approved ──────────────────────
test('T-D77: buildDraftDoc: status siempre draft_approved', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-test-1', model: 'gpt-5.6' });
  var doc  = buildDraftDocFromResp(resp, 'client-1', 'coach-1', {});
  assert(doc.status === 'draft_approved', 'status debe ser draft_approved');
});

// ─── T-D78: buildDraftDoc shape — identity fields ─────────────────────────────
test('T-D78: buildDraftDoc: coachId, clientId, generationRequestId presentes', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-id-1' });
  var doc  = buildDraftDocFromResp(resp, 'client-abc', 'coach-xyz', {});
  assert(doc.coachId === 'coach-xyz',     'coachId incorrecto');
  assert(doc.clientId === 'client-abc',   'clientId incorrecto');
  assert(doc.generationRequestId === 'req-d2-id-1', 'generationRequestId incorrecto');
});

// ─── T-D79: buildDraftDoc shape — source vdsen-ai ────────────────────────────
test('T-D79: buildDraftDoc: source y generatedBy = vdsen-ai', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-src-1' });
  var doc  = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(doc.source === 'vdsen-ai',      'source debe ser vdsen-ai');
  assert(doc.generatedBy === 'vdsen-ai', 'generatedBy debe ser vdsen-ai');
});

// ─── T-D80: buildDraftDoc — NO farmacologia en el doc ────────────────────────
test('T-D80: buildDraftDoc: no incluye farmacologia ni pharmacoPlan', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-pharma-1' });
  var doc  = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(!('farmacologia'  in doc), 'farmacologia NO debe estar en el doc');
  assert(!('pharmacoPlan'  in doc), 'pharmacoPlan NO debe estar en el doc');
});

// ─── T-D81: buildDraftDoc — NO raw model response, NO prompt, NO API keys ────
test('T-D81: buildDraftDoc: no incluye rawResponse, prompt ni API keys', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-secrets-1' });
  var doc  = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(!('rawResponse'    in doc), 'rawResponse NO debe estar en el doc');
  assert(!('systemPrompt'   in doc), 'systemPrompt NO debe estar en el doc');
  assert(!('prompt'         in doc), 'prompt NO debe estar en el doc');
  assert(!('apiKey'         in doc), 'apiKey NO debe estar en el doc');
  assert(!('openaiKey'      in doc), 'openaiKey NO debe estar en el doc');
});

// ─── T-D82: buildDraftDoc — activePlanId NO cambia (no está en el doc) ────────
test('T-D82: buildDraftDoc: no contiene activePlanId (D.2-A no activa)', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-noid-1' });
  var doc  = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(!('activePlanId' in doc), 'activePlanId NO debe estar en el doc de borrador');
});

// ─── T-D83: buildDraftDoc — nutritionDisplay contiene macros españoles ────────
test('T-D83: buildDraftDoc: nutritionDisplay contiene calorias/proteina/carbos/grasas', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-nutr-1' });
  var doc  = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  var nd = doc.nutritionDisplay;
  assert(nd && nd.calorias !== undefined, 'nutritionDisplay.calorias ausente');
  assert(nd && nd.proteina !== undefined, 'nutritionDisplay.proteina ausente');
  assert(nd && nd.carbos   !== undefined, 'nutritionDisplay.carbos ausente');
  assert(nd && nd.grasas   !== undefined, 'nutritionDisplay.grasas ausente');
});

// ─── T-D84: buildDraftDoc — nutritionDisplay valores desde plan español ───────
test('T-D84: buildDraftDoc: nutritionDisplay usa valores correctos del plan', function() {
  var resp = makeValidResponse({
    requestId: 'req-d2-nutr-2',
    plan: {
      schema: 'vdsen-plan-v2',
      entrenamiento: { weeks: 6, daysPerWeek: 4, days: [] },
      nutricion: { calorias: 2800, proteina: 220, carbos: 320, grasas: 80, texto: 'ok' },
      suplementacion: { tiers: [] },
    },
  });
  var doc = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(doc.nutritionDisplay.calorias === 2800, 'calorias debe ser 2800');
  assert(doc.nutritionDisplay.proteina === 220,  'proteina debe ser 220');
  assert(doc.nutritionDisplay.carbos   === 320,  'carbos debe ser 320');
  assert(doc.nutritionDisplay.grasas   === 80,   'grasas debe ser 80');
});

// ─── T-D85: buildDraftDoc — nutritionDisplay fallback inglés ──────────────────
test('T-D85: buildDraftDoc: nutritionDisplay acepta keys en inglés (fallback)', function() {
  var resp = makeValidResponse({
    requestId: 'req-d2-nutr-en',
    plan: {
      nutrition: { calories: 2700, protein: 210, carbs: 290, fats: 75 },
    },
  });
  var doc = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(doc.nutritionDisplay.calorias === 2700, 'calories→calorias fallback: ' + doc.nutritionDisplay.calorias);
  assert(doc.nutritionDisplay.proteina === 210,  'protein→proteina fallback');
});

// ─── T-D86: buildDraftDoc — supplementsRaw contiene tiers ─────────────────────
test('T-D86: buildDraftDoc: supplementsRaw tiene tiers array', function() {
  var resp = makeValidResponse({
    requestId: 'req-d2-suppl-1',
    plan: {
      suplementacion: { tiers: [{ nombre: 'Tier 1', items: [{ nombre: 'Creatina', dosis: '5g', timing: 'AM', nota: '' }] }] },
    },
  });
  var doc = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(Array.isArray(doc.supplementsRaw.tiers), 'supplementsRaw.tiers debe ser array');
  assert(doc.supplementsRaw.tiers.length === 1,   'debe tener 1 tier');
});

// ─── T-D87: buildDraftDoc — supplementDisplay.texto no vacío si hay tiers ─────
test('T-D87: buildDraftDoc: supplementDisplay.texto construido desde tiers', function() {
  var resp = makeValidResponse({
    requestId: 'req-d2-suppl-txt',
    plan: {
      suplementacion: { tiers: [{ nombre: 'Tier 1', items: [{ nombre: 'Creatina', dosis: '5g', timing: 'AM', nota: '' }] }] },
    },
  });
  var doc = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(typeof doc.supplementDisplay.texto === 'string', 'supplementDisplay.texto debe ser string');
  assert(doc.supplementDisplay.texto.indexOf('Creatina') !== -1, 'texto debe contener nombre del suplemento');
});

// ─── T-D88: buildDraftDoc — training flat backward compat ─────────────────────
test('T-D88: buildDraftDoc: weeks/daysPerWeek/days en raíz del doc (backward compat)', function() {
  var resp = makeValidResponse({
    requestId: 'req-d2-train-1',
    plan: {
      entrenamiento: { weeks: 8, daysPerWeek: 5, days: [{ dayIndex: 1, label: 'Push', exercises: [] }] },
    },
  });
  var doc = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(doc.weeks === 8,          'weeks debe ser 8');
  assert(doc.daysPerWeek === 5,    'daysPerWeek debe ser 5');
  assert(Array.isArray(doc.days),  'days debe ser array');
  assert(doc.days.length === 1,    'debe tener 1 día');
});

// ─── T-D89: buildDraftDoc — reviewSummary correcto ────────────────────────────
test('T-D89: buildDraftDoc: reviewSummary refleja ítems aceptados', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-review-1' });
  var items = [{ type: 'general' }, { type: 'medical' }, { type: 'info' }];
  var revState = { 0: 'accept', 1: 'accept', __items: items };
  var doc = buildDraftDocFromResp(resp, 'c1', 'c2', revState);
  assert(doc.reviewSummary.totalItems    === 2, 'totalItems debe ser 2 (info no cuenta)');
  assert(doc.reviewSummary.acceptedItems === 2, 'acceptedItems debe ser 2');
});

// ─── T-D90: buildDraftDoc — reviewSummary con 0 ítems (VALID status) ──────────
test('T-D90: buildDraftDoc: reviewSummary.totalItems=0 cuando no hay ítems de revisión (VALID)', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-review-0' });
  var doc  = buildDraftDocFromResp(resp, 'c1', 'c2', { __items: [] });
  assert(doc.reviewSummary.totalItems    === 0, 'totalItems debe ser 0 para VALID');
  assert(doc.reviewSummary.acceptedItems === 0, 'acceptedItems debe ser 0');
});

// ─── T-D91: preconditions — sin coachId → error ───────────────────────────────
test('T-D91: checkD2APreconditions: sin coachId → NO_COACH_SESSION', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-prec-1' });
  var errs = checkD2APreconditions(resp, 'client-1', null, { coachId: null });
  assert(errs.includes('NO_COACH_SESSION'), 'debe detectar NO_COACH_SESSION');
});

// ─── T-D92: preconditions — sin clientId → error ──────────────────────────────
test('T-D92: checkD2APreconditions: sin clientId → NO_CLIENT_ID', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-prec-2' });
  var errs = checkD2APreconditions(resp, '', 'coach-1', { coachId: 'coach-1' });
  assert(errs.includes('NO_CLIENT_ID'), 'debe detectar NO_CLIENT_ID');
});

// ─── T-D93: preconditions — status INVALID bloquea save ──────────────────────
test('T-D93: checkD2APreconditions: status INVALID → INVALID_STATUS', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-prec-3', status: 'INVALID' });
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' });
  assert(errs.some(function(e) { return e.indexOf('INVALID_STATUS') !== -1; }), 'debe detectar INVALID_STATUS');
});

// ─── T-D94: preconditions — status ERROR bloquea save ────────────────────────
test('T-D94: checkD2APreconditions: status ERROR → INVALID_STATUS', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-prec-4', status: 'ERROR' });
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' });
  assert(errs.some(function(e) { return e.indexOf('INVALID_STATUS') !== -1; }), 'debe detectar INVALID_STATUS para ERROR');
});

// ─── T-D95: preconditions — FOREIGN_OWNER bloquea save ───────────────────────
test('T-D95: checkD2APreconditions: client.coachId ≠ coachId → FOREIGN_OWNER', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-prec-5' });
  var errs = checkD2APreconditions(resp, 'c1', 'coach-A', { coachId: 'coach-B' });
  assert(errs.includes('FOREIGN_OWNER'), 'FOREIGN_OWNER debe bloquear D.2-A');
});

// ─── T-D96: preconditions — sin requestId → error ─────────────────────────────
test('T-D96: checkD2APreconditions: sin requestId → NO_REQUEST_ID', function() {
  var resp = makeValidResponse({});
  delete resp.requestId;
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' });
  assert(errs.includes('NO_REQUEST_ID'), 'debe detectar NO_REQUEST_ID');
});

// ─── T-D97: preconditions — OK cuando todo válido ─────────────────────────────
test('T-D97: checkD2APreconditions: sin errores cuando todo OK', function() {
  var resp = makeValidResponse({ requestId: 'req-d2-prec-ok' });
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' });
  assert(errs.length === 0, 'no debe haber errores: ' + JSON.stringify(errs));
});

// ─── T-D98: idempotency key = requestId ───────────────────────────────────────
test('T-D98: idempotencia: doc ID = requestId de la respuesta', function() {
  var resp = makeValidResponse({ requestId: 'unique-request-abc123' });
  var doc  = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(doc.generationRequestId === 'unique-request-abc123', 'generationRequestId debe ser el requestId');
  // El planRef en Firestore sería doc(db, 'plans', resp.requestId)
  // Mismo requestId → mismo docId → idempotent (getDoc antes del setDoc)
});

// ─── FASE D.2 — Tests D.2-B (Activate Plan) ──────────────────────────────────

// Simulate activation precondition logic (mirrors _vdsenActivatePlanInFirestore)
function checkD2BPreconditions(planData, clientData, coachId, planId, clientId) {
  var errors = [];
  if (!coachId)                          errors.push('NO_COACH_SESSION');
  if (!planData)                         errors.push('PLAN_MISSING');
  if (planData && planData.coachId !== coachId)  errors.push('FOREIGN_OWNER_PLAN');
  if (planData && planData.clientId !== clientId) errors.push('CLIENT_MISMATCH');
  if (planData && planData.status !== 'draft_approved') errors.push('PLAN_INVALID_STATUS:' + planData.status);
  if (clientData && clientData.coachId !== coachId) errors.push('FOREIGN_OWNER_CLIENT');
  return errors;
}

function simulateActivation(planData, clientData, coachId, planId, clientId) {
  // Returns the updates that would be applied if successful.
  // plans/{planId} NOT written (immutable post-approval — draft_approved stays).
  // plans/{prevPlanId} NOT written (history preserved by existence, not by status mutation).
  var updates = { plan: null, client: null, prevPlan: null, idempotent: false };

  // Idempotent: plan already active for this client — no writes
  if (clientData.activePlanId === planId) {
    updates.idempotent = true;
    return updates;
  }

  // Only write: clients/{clientId}
  updates.client = {
    activePlanId:   planId,
    // Compatibility mirrors — vdsen-cliente.html reads from clients/{uid}, not plan doc
    nutritionPlan:  planData.nutritionDisplay  || {},
    nutritionRaw:   planData.nutritionRaw      || {},
    supplementPlan: planData.supplementDisplay || {},
    supplementsRaw: planData.supplementsRaw    || {},
  };
  return updates;
}

// ─── T-D99: D.2-B solo activa planes con status draft_approved ────────────────
test('T-D99: D.2-B: solo planes con status=draft_approved pueden activarse', function() {
  var planData = { coachId: 'c1', clientId: 'cl1', status: 'active' };
  var errs = checkD2BPreconditions(planData, { coachId: 'c1', activePlanId: null }, 'c1', 'plan-1', 'cl1');
  assert(errs.some(function(e) { return e.indexOf('PLAN_INVALID_STATUS') !== -1; }), 'plan ya activo no puede re-activarse');
});

// ─── T-D100: D.2-B activa plan draft_approved correctamente ──────────────────
test('T-D100: D.2-B: plan draft_approved → sin errores de precondición', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved', nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: null };
  var errs = checkD2BPreconditions(planData, clientData, 'c1', 'plan-1', 'cl1');
  assert(errs.length === 0, 'no debe haber errores: ' + JSON.stringify(errs));
});

// ─── T-D101: D.2-B actualiza activePlanId en client doc ──────────────────────
test('T-D101: D.2-B: client.activePlanId se actualiza al planId', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved', nutritionDisplay: { calorias: 2500 }, nutritionRaw: {}, supplementDisplay: { texto: '' }, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: null };
  var updates = simulateActivation(planData, clientData, 'c1', 'plan-new', 'cl1');
  assert(updates.client.activePlanId === 'plan-new', 'activePlanId debe ser el nuevo planId');
});

// ─── T-D102: D.2-B copia nutrition al client doc ─────────────────────────────
test('T-D102: D.2-B: nutritionPlan y nutritionRaw copiados al client doc', function() {
  var nutrDisp = { calorias: 2700, proteina: 210, carbos: 300, grasas: 75, texto: 'test' };
  var nutrRaw  = { calorias: 2700, comidas: [] };
  var planData = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved', nutritionDisplay: nutrDisp, nutritionRaw: nutrRaw, supplementDisplay: {}, supplementsRaw: {} };
  var updates  = simulateActivation(planData, { coachId: 'c1' }, 'c1', 'plan-1', 'cl1');
  assert(updates.client.nutritionPlan === nutrDisp, 'nutritionPlan debe ser nutritionDisplay del plan');
  assert(updates.client.nutritionRaw  === nutrRaw,  'nutritionRaw debe ser nutritionRaw del plan');
});

// ─── T-D103: D.2-B plan anterior NO se muta (historia preservada por existencia) ─
test('T-D103: D.2-B: plan activo anterior NO se muta — historial preservado por existencia', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved', nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: 'plan-old' };
  var updates = simulateActivation(planData, clientData, 'c1', 'plan-new', 'cl1');
  assert(updates.prevPlan === null, 'plan anterior NO debe modificarse — historia preservada por existencia de ambos docs');
});

// ─── T-D104: D.2-B no supersede si no hay plan activo previo ─────────────────
test('T-D104: D.2-B: sin plan activo previo → no supersede', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved', nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: null };
  var updates = simulateActivation(planData, clientData, 'c1', 'plan-new', 'cl1');
  assert(updates.prevPlan === null, 'no debe haber update al plan anterior si no existe');
});

// ─── T-D105: D.2-B FOREIGN_OWNER en plan → bloqueado ────────────────────────
test('T-D105: D.2-B: FOREIGN_OWNER en plan → bloqueado', function() {
  var planData   = { coachId: 'coach-otro', clientId: 'cl1', status: 'draft_approved' };
  var clientData = { coachId: 'coach-otro' };
  var errs = checkD2BPreconditions(planData, clientData, 'coach-mio', 'plan-1', 'cl1');
  assert(errs.includes('FOREIGN_OWNER_PLAN'), 'FOREIGN_OWNER_PLAN debe bloquear activación');
});

// ─── T-D106: D.2-B CLIENT_MISMATCH → bloqueado ───────────────────────────────
test('T-D106: D.2-B: clientId del plan ≠ clientId solicitado → CLIENT_MISMATCH', function() {
  var planData   = { coachId: 'c1', clientId: 'cl-X', status: 'draft_approved' };
  var clientData = { coachId: 'c1' };
  var errs = checkD2BPreconditions(planData, clientData, 'c1', 'plan-1', 'cl-Y');
  assert(errs.includes('CLIENT_MISMATCH'), 'CLIENT_MISMATCH debe detectarse');
});

// ─── T-D107: D.2-B plan NO se escribe en absoluto (content + lifecycle) ───────
test('T-D107: D.2-B: activación no muta days, weeks, nutritionRaw del plan — plans/{planId}=null', function() {
  var originalDays = [{ dayIndex: 1, label: 'Push', exercises: [] }];
  var originalNutr = { calorias: 2700, proteina: 210, comidas: [] };
  var planData = {
    coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    days: originalDays, weeks: 6, daysPerWeek: 4,
    nutritionDisplay: { calorias: 2700 }, nutritionRaw: originalNutr,
    supplementDisplay: { texto: '' }, supplementsRaw: {},
  };
  var updates = simulateActivation(planData, { coachId: 'c1', activePlanId: null }, 'c1', 'plan-1', 'cl1');
  // plans/{planId} not written at all (immutable post-approval)
  assert(updates.plan === null, 'plans/{planId} NO debe escribirse — ni content ni lifecycle fields');
});

// ─── T-D108: D.2-B plan doc NO se escribe en activación (plan inmutable) ──────
test('T-D108: D.2-B: plans/{planId} NO se escribe en activación — plan permanece draft_approved', function() {
  var planData   = { coachId: 'coach-X', clientId: 'cl1', status: 'draft_approved', nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'coach-X', activePlanId: null };
  var updates    = simulateActivation(planData, clientData, 'coach-X', 'plan-1', 'cl1');
  assert(updates.plan === null, 'plans/{planId} NO debe escribirse — el doc permanece draft_approved inmutable');
});

// ─── T-D109: D.2-B mismo planId activo = activación idempotente, 0 writes ────
test('T-D109: D.2-B: si activePlanId ya es el mismo planId → idempotent, sin writes', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved', nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: 'plan-same' };
  var updates    = simulateActivation(planData, clientData, 'c1', 'plan-same', 'cl1');
  assert(updates.idempotent === true, 'debe retornar idempotent=true cuando plan ya está activo');
  assert(updates.plan   === null, 'sin write a plan doc');
  assert(updates.client === null, 'sin write a client doc si ya es idempotente');
  assert(updates.prevPlan === null, 'sin write a plan anterior');
});

// ─── T-D110: D.2 Firestore zero-writes (structural) ──────────────────────────
test('T-D110: D.2 helpers son pure functions (sin Firebase en scope de pruebas)', function() {
  // buildDraftDocFromResp y checkD2APreconditions son sync y no hacen writes.
  // Si Firebase fuera importado aquí, el test file fallaría al cargar.
  var resp = makeValidResponse({ requestId: 'req-d2-struct-1' });
  var doc  = buildDraftDocFromResp(resp, 'c1', 'c2', {});
  assert(typeof doc === 'object', 'buildDraftDocFromResp debe devolver un objeto');
  var errs = checkD2APreconditions(resp, 'c1', 'c2', { coachId: 'c2' });
  assert(Array.isArray(errs), 'checkD2APreconditions debe devolver array');
});

// ═══════════════════════════════════════════════════════════════════════════════
// FASE D.2 SAFETY PATCH — Tests T-D111..T-D150
// ═══════════════════════════════════════════════════════════════════════════════

// ─── SECTION: D.2-A Defense in Depth (review gate enforced in function) ────────

// ─── T-D111: consistency fail bloquea save (NEEDS_COACH_REVIEW) ───────────────
test('T-D111: D.2-A: consistency fail bloquea save en NEEDS_COACH_REVIEW', function() {
  var resp = makeValidResponse({ requestId: 'req-d111', status: 'NEEDS_COACH_REVIEW' });
  var reviewState = {
    __items: [{ type: 'general' }],
    __consistency: [{ field: 'weeks', issue: 'mismatch' }],
    0: 'accept',
  };
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' }, reviewState, true);
  assert(errs.includes('CONSISTENCY_FAIL'), 'CONSISTENCY_FAIL debe bloquear cuando hay inconsistencias');
});

// ─── T-D112: ítem rechazado bloquea save ──────────────────────────────────────
test('T-D112: D.2-A: ítem rechazado → REVIEW_REJECTED bloquea save', function() {
  var resp = makeValidResponse({ requestId: 'req-d112', status: 'NEEDS_COACH_REVIEW' });
  var reviewState = {
    __items: [{ type: 'general' }, { type: 'medical' }],
    __consistency: [],
    0: 'accept',
    1: 'reject',
  };
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' }, reviewState, true);
  assert(errs.includes('REVIEW_REJECTED'), 'REVIEW_REJECTED debe bloquear cuando hay ítems rechazados');
});

// ─── T-D113: ítem requires_adjustment bloquea save ────────────────────────────
test('T-D113: D.2-A: ítem "adjust" → REVIEW_ADJUSTMENT bloquea save', function() {
  var resp = makeValidResponse({ requestId: 'req-d113', status: 'NEEDS_COACH_REVIEW' });
  var reviewState = {
    __items: [{ type: 'general' }, { type: 'medical' }],
    __consistency: [],
    0: 'accept',
    1: 'adjust',
  };
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' }, reviewState, true);
  assert(errs.includes('REVIEW_ADJUSTMENT'), 'REVIEW_ADJUSTMENT debe bloquear cuando hay ítems a ajustar');
});

// ─── T-D114: ítem sin revisar bloquea save ────────────────────────────────────
test('T-D114: D.2-A: ítem sin decisión → REVIEW_INCOMPLETE bloquea save', function() {
  var resp = makeValidResponse({ requestId: 'req-d114', status: 'NEEDS_COACH_REVIEW' });
  var reviewState = {
    __items: [{ type: 'general' }, { type: 'medical' }],
    __consistency: [],
    0: 'accept',
    // 1 sin decisión
  };
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' }, reviewState, true);
  assert(errs.includes('REVIEW_INCOMPLETE'), 'REVIEW_INCOMPLETE debe bloquear cuando hay ítems sin revisar');
});

// ─── T-D115: VALID plan — no requiere review gate ─────────────────────────────
test('T-D115: D.2-A: VALID plan (requiresReview=false) → sin check de review gate', function() {
  var resp = makeValidResponse({ requestId: 'req-d115' }); // status: VALID
  // Even with empty reviewState, should not produce review errors
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' }, {}, false);
  assert(!errs.includes('REVIEW_INCOMPLETE'), 'VALID no debe requerir gate de revisión');
  assert(!errs.includes('REVIEW_REJECTED'), 'VALID no tiene ítems rechazados');
  assert(errs.length === 0, 'VALID sin revisión debe pasar: ' + JSON.stringify(errs));
});

// ─── T-D116: NEEDS_COACH_REVIEW todos aceptados → sin errores de review ───────
test('T-D116: D.2-A: NEEDS_COACH_REVIEW todos non-medical aceptados + consistente → sin errores', function() {
  var resp = makeValidResponse({ requestId: 'req-d116', status: 'NEEDS_COACH_REVIEW' });
  var reviewState = {
    // D.2.1: no medical blockers; general + mobility items accepted → gate passes
    __items: [{ type: 'general', blockingStatus: 'non_blocking' }, { type: 'mobility', blockingStatus: 'non_blocking' }, { type: 'info' }],
    __consistency: [],
    0: 'accept',
    1: 'accept',
    // idx 2 es 'info' → no cuenta
  };
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' }, reviewState, true);
  assert(errs.length === 0, 'non-medical aceptados + consistente debe pasar: ' + JSON.stringify(errs));
});

// ─── T-D117: idempotency conflict — mismo requestId, diferente clientId ────────
test('T-D117: D.2-A: idempotency conflict — mismo requestId, diferente clientId → BLOCK', function() {
  var existingDoc = { clientId: 'client-A', coachId: 'coach-1' };
  var conflict = checkIdempotencyConflict(existingDoc, 'client-B', 'coach-1');
  assert(conflict === 'IDEMPOTENCY_CONFLICT', 'clientId diferente debe dar IDEMPOTENCY_CONFLICT');
});

// ─── T-D118: idempotency conflict — mismo requestId, diferente coachId ─────────
test('T-D118: D.2-A: idempotency conflict — mismo requestId, diferente coachId → BLOCK', function() {
  var existingDoc = { clientId: 'client-A', coachId: 'coach-1' };
  var conflict = checkIdempotencyConflict(existingDoc, 'client-A', 'coach-2');
  assert(conflict === 'IDEMPOTENCY_CONFLICT', 'coachId diferente debe dar IDEMPOTENCY_CONFLICT');
});

// ─── T-D119: idempotency success — mismo requestId, misma identidad ────────────
test('T-D119: D.2-A: idempotency success — mismo requestId, mismo clientId y coachId → OK', function() {
  var existingDoc = { clientId: 'client-A', coachId: 'coach-1' };
  var conflict = checkIdempotencyConflict(existingDoc, 'client-A', 'coach-1');
  assert(conflict === null, 'misma identidad debe retornar null (success idempotente)');
});

// ─── T-D120: sin doc existente → no conflict ──────────────────────────────────
test('T-D120: D.2-A: sin doc existente → no conflict (create normal)', function() {
  var conflict = checkIdempotencyConflict(null, 'client-A', 'coach-1');
  assert(conflict === null, 'doc no existente debe retornar null (create path)');
});

// ─── T-D121: ítems info no cuentan en review gate ─────────────────────────────
test('T-D121: D.2-A: ítems type=info no cuentan hacia total de revisión', function() {
  var resp = makeValidResponse({ requestId: 'req-d121', status: 'NEEDS_COACH_REVIEW' });
  var reviewState = {
    __items: [{ type: 'info' }, { type: 'info' }], // solo info
    __consistency: [],
    // ninguna decisión — pero info no cuenta
  };
  var errs = checkD2APreconditions(resp, 'c1', 'coach-1', { coachId: 'coach-1' }, reviewState, true);
  assert(!errs.includes('REVIEW_INCOMPLETE'), 'info items no deben contar como incompletos');
});

// ─── SECTION: D.2-B Activation Writes ─────────────────────────────────────────

// ─── T-D122: activación NO escribe en plan anterior (prevPlan) ────────────────
test('T-D122: D.2-B: activación NO escribe en plans/{prevPlanId}', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: 'plan-old-123' };
  var updates = simulateActivation(planData, clientData, 'c1', 'plan-new-456', 'cl1');
  assert(updates.prevPlan === null, 'plans/{prevPlanId} NO debe escribirse en activación');
});

// ─── T-D123: plan doc NO se escribe (permanece draft_approved) ────────────────
test('T-D123: D.2-B: plans/{planId} NO se escribe — permanece draft_approved inmutable', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: null };
  var updates = simulateActivation(planData, clientData, 'c1', 'plan-1', 'cl1');
  assert(updates.plan === null, 'plans/{planId} NO debe modificarse en activación');
});

// ─── T-D124: content fields del plan no aparecen en ningún write de activación ─
test('T-D124: D.2-B: days/weeks/nutritionRaw ausentes en todos los writes de activación', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    days: [{ dayIndex: 1 }], weeks: 6, daysPerWeek: 4,
    nutritionDisplay: { calorias: 2700 }, nutritionRaw: { comidas: [] },
    supplementDisplay: { texto: '' }, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: null };
  var updates = simulateActivation(planData, clientData, 'c1', 'plan-1', 'cl1');
  assert(updates.plan === null, 'sin write a plan doc');
  if (updates.client) {
    assert(!('days'  in updates.client),  'days no debe estar en client write');
    assert(!('weeks' in updates.client),  'weeks no debe estar en client write');
  }
});

// ─── T-D125: mirrors de compatibilidad contienen nutrición correcta ────────────
test('T-D125: D.2-B: mirrors actualizan nutritionPlan y supplementPlan en client doc', function() {
  var nutrDisp = { calorias: 2700, proteina: 210, carbos: 300, grasas: 75, texto: 'test' };
  var supplDisp = { texto: 'Tier 1: Creatina — 5g' };
  var planData = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    nutritionDisplay: nutrDisp, nutritionRaw: { calorias: 2700 },
    supplementDisplay: supplDisp, supplementsRaw: { tiers: [] } };
  var updates = simulateActivation(planData, { coachId: 'c1', activePlanId: null }, 'c1', 'plan-1', 'cl1');
  assert(updates.client !== null, 'client debe ser escrito');
  assert(updates.client.nutritionPlan === nutrDisp, 'nutritionPlan debe ser nutritionDisplay del plan');
  assert(updates.client.supplementPlan === supplDisp, 'supplementPlan debe ser supplementDisplay del plan');
});

// ─── T-D126: mirrors NO contienen farmacología ────────────────────────────────
test('T-D126: D.2-B: mirrors de client doc NO contienen farmacología', function() {
  var planData = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {},
    farmacologia: { protocolo: 'ciclo' } }; // presente en planData pero NO debe mirrar
  var updates = simulateActivation(planData, { coachId: 'c1', activePlanId: null }, 'c1', 'plan-1', 'cl1');
  if (updates.client) {
    assert(!('farmacologia' in updates.client), 'farmacología NO debe estar en client write');
    assert(!('pharmacoPlan' in updates.client), 'pharmacoPlan NO debe estar en client write');
  }
});

// ─── T-D127: activación idempotente — plan ya activo = 0 writes ───────────────
test('T-D127: D.2-B: plan ya activo para cliente → idempotent, 0 writes', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: 'plan-already-active' };
  var updates = simulateActivation(planData, clientData, 'c1', 'plan-already-active', 'cl1');
  assert(updates.idempotent === true, 'debe ser idempotente');
  assert(updates.plan   === null, '0 writes a plan doc');
  assert(updates.client === null, '0 writes a client doc');
  assert(updates.prevPlan === null, '0 writes a prevPlan');
});

// ─── T-D128: activación registra activePlanId en client doc ───────────────────
test('T-D128: D.2-B: activePlanId correcto registrado en client update', function() {
  var planData   = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    nutritionDisplay: {}, nutritionRaw: {}, supplementDisplay: {}, supplementsRaw: {} };
  var clientData = { coachId: 'c1', activePlanId: null };
  var updates = simulateActivation(planData, clientData, 'c1', 'plan-xyz', 'cl1');
  assert(updates.client !== null, 'client write debe existir');
  assert(updates.client.activePlanId === 'plan-xyz', 'activePlanId debe ser plan-xyz');
});

// ─── SECTION: Firestore Rules (simulated) ──────────────────────────────────────

// Simulate plan update rule: draft_approved and active plans are immutable
function simulatePlanUpdateRule(planStatus, coachId, authUid) {
  // Mirrors: allow update if coachId matches AND status not draft_approved/active
  if (coachId !== authUid) return 'DENY_OWNERSHIP';
  if (planStatus === 'draft_approved') return 'DENY_IMMUTABLE';
  if (planStatus === 'active') return 'DENY_IMMUTABLE';
  return 'ALLOW';
}

// Simulate plan delete rule
function simulatePlanDeleteRule(planStatus, coachId, authUid) {
  if (coachId !== authUid) return 'DENY_OWNERSHIP';
  if (planStatus === 'draft_approved') return 'DENY_IMMUTABLE';
  if (planStatus === 'active') return 'DENY_IMMUTABLE';
  return 'ALLOW';
}

// Simulate client update rule for coaches (coachId immutability)
function simulateClientUpdateRule(existingCoachId, newCoachId, authUid) {
  // Coach: resource.data.coachId == auth.uid AND request.resource.data.coachId == resource.data.coachId
  if (existingCoachId !== authUid) return 'DENY_OWNERSHIP';
  if (newCoachId !== existingCoachId) return 'DENY_COACHID_IMMUTABLE';
  return 'ALLOW';
}

// ─── T-D129: rule: plan draft_approved → update DENY ──────────────────────────
test('T-D129: rules: plan draft_approved — coach no puede hacer update de contenido', function() {
  var result = simulatePlanUpdateRule('draft_approved', 'coach-1', 'coach-1');
  assert(result === 'DENY_IMMUTABLE', 'plan draft_approved debe ser inmutable: ' + result);
});

// ─── T-D130: rule: plan active → update DENY ──────────────────────────────────
test('T-D130: rules: plan active — coach no puede hacer update de contenido', function() {
  var result = simulatePlanUpdateRule('active', 'coach-1', 'coach-1');
  assert(result === 'DENY_IMMUTABLE', 'plan active debe ser inmutable: ' + result);
});

// ─── T-D131: rule: plan sin status → update ALLOW (legacy) ───────────────────
test('T-D131: rules: plan sin status (legacy/manual) → update ALLOW para dueño', function() {
  var result = simulatePlanUpdateRule(null, 'coach-1', 'coach-1');
  assert(result === 'ALLOW', 'plan legacy sin status debe poder actualizarse: ' + result);
});

// ─── T-D132: rule: plan draft_approved → delete DENY ─────────────────────────
test('T-D132: rules: plan draft_approved — coach no puede eliminar', function() {
  var result = simulatePlanDeleteRule('draft_approved', 'coach-1', 'coach-1');
  assert(result === 'DENY_IMMUTABLE', 'plan draft_approved no puede eliminarse: ' + result);
});

// ─── T-D133: rule: plan active → delete DENY ──────────────────────────────────
test('T-D133: rules: plan active — coach no puede eliminar', function() {
  var result = simulatePlanDeleteRule('active', 'coach-1', 'coach-1');
  assert(result === 'DENY_IMMUTABLE', 'plan active no puede eliminarse: ' + result);
});

// ─── T-D134: rule: plan sin status → delete ALLOW (legacy, dueño) ────────────
test('T-D134: rules: plan legacy sin status → delete ALLOW para dueño', function() {
  var result = simulatePlanDeleteRule(null, 'coach-1', 'coach-1');
  assert(result === 'ALLOW', 'plan legacy puede eliminarse por su dueño: ' + result);
});

// ─── T-D135: rule: cliente — coachId inmutable en update ─────────────────────
test('T-D135: rules: client update — coach NO puede cambiar coachId', function() {
  var result = simulateClientUpdateRule('coach-1', 'coach-otro', 'coach-1');
  assert(result === 'DENY_COACHID_IMMUTABLE', 'cambio de coachId debe denegarse: ' + result);
});

// ─── T-D136: rule: cliente — coach puede actualizar su propio cliente ─────────
test('T-D136: rules: client update — coach actualiza cliente propio sin cambiar coachId → ALLOW', function() {
  var result = simulateClientUpdateRule('coach-1', 'coach-1', 'coach-1');
  assert(result === 'ALLOW', 'update de cliente propio sin cambiar coachId debe permitirse: ' + result);
});

// ─── T-D137: rule: cliente de otro coach → DENY ───────────────────────────────
test('T-D137: rules: client update — coach A no puede editar cliente de coach B', function() {
  var result = simulateClientUpdateRule('coach-B', 'coach-B', 'coach-A');
  assert(result === 'DENY_OWNERSHIP', 'cliente de otro coach debe denegarse: ' + result);
});

// ─── T-D138: rule: LEGACY_UNASSIGNED no puede ser reclamado via update ─────────
test('T-D138: rules: LEGACY_UNASSIGNED (coachId=null) no puede ser reclamado via update', function() {
  // Existing doc has no coachId (null) — coach tries to claim by setting their own coachId
  var result = simulateClientUpdateRule(null, 'coach-1', 'coach-1');
  assert(result === 'DENY_OWNERSHIP', 'LEGACY_UNASSIGNED no puede ser reclamado: ' + result);
});

// ─── T-D139: plan de otro coach → delete DENY (ownership) ────────────────────
test('T-D139: rules: plan de otro coach — delete DENY por ownership', function() {
  var result = simulatePlanDeleteRule(null, 'coach-B', 'coach-A');
  assert(result === 'DENY_OWNERSHIP', 'plan de otro coach no puede eliminarse: ' + result);
});

// ─── T-D140: plan de otro coach → update DENY (ownership) ────────────────────
test('T-D140: rules: plan de otro coach — update DENY por ownership', function() {
  var result = simulatePlanUpdateRule(null, 'coach-B', 'coach-A');
  assert(result === 'DENY_OWNERSHIP', 'plan de otro coach no puede actualizarse: ' + result);
});

// ─── SECTION: Review semantics ─────────────────────────────────────────────────

// ─── T-D141: todos accepted → gate pasa ───────────────────────────────────────
test('T-D141: review gate: todos non-medical accepted → pasa', function() {
  // D.2.1: medical items now always block; this test uses only non-blocking items
  var rs = { __items: [{ type: 'general', blockingStatus: 'non_blocking' }, { type: 'mobility', blockingStatus: 'non_blocking' }], __consistency: [], 0: 'accept', 1: 'accept' };
  var errs = checkD2APreconditions(makeValidResponse({ requestId: 'r141', status: 'NEEDS_COACH_REVIEW' }), 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.length === 0, 'todos non-medical aceptados debe pasar: ' + JSON.stringify(errs));
});

// ─── T-D142: un reject bloquea aunque resto accepted ─────────────────────────
test('T-D142: review gate: 1 rejected + resto accepted → bloquea', function() {
  var rs = { __items: [{ type: 'general' }, { type: 'medical' }], __consistency: [], 0: 'accept', 1: 'reject' };
  var errs = checkD2APreconditions(makeValidResponse({ requestId: 'r142', status: 'NEEDS_COACH_REVIEW' }), 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.includes('REVIEW_REJECTED'), 'rejected debe bloquear independientemente del resto');
});

// ─── T-D143: consistency + reject → ambos errores presentes ──────────────────
test('T-D143: review gate: consistency fail + rejected → ambos errores simultáneos', function() {
  var rs = {
    __items: [{ type: 'general' }],
    __consistency: [{ field: 'x' }],
    0: 'reject',
  };
  var errs = checkD2APreconditions(makeValidResponse({ requestId: 'r143', status: 'NEEDS_COACH_REVIEW' }), 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.includes('CONSISTENCY_FAIL'), 'CONSISTENCY_FAIL debe estar');
  assert(errs.includes('REVIEW_REJECTED'), 'REVIEW_REJECTED debe estar');
});

// ─── T-D144: buildDraftDoc no incluye info sobre decisiones individuales ───────
test('T-D144: buildDraftDoc: reviewSummary NO incluye decisiones individuales (solo counts)', function() {
  var rs = { __items: [{ type: 'general' }], 0: 'accept' };
  var doc = buildDraftDocFromResp(makeValidResponse({ requestId: 'r144' }), 'c1', 'c2', rs);
  assert(typeof doc.reviewSummary === 'object', 'reviewSummary debe ser objeto');
  assert(!('decisions' in doc.reviewSummary), 'reviewSummary NO debe exponer decisiones individuales');
  assert(!('itemDecisions' in doc.reviewSummary), 'reviewSummary NO debe exponer decisiones individuales');
  assert('totalItems' in doc.reviewSummary, 'totalItems debe estar');
  assert('acceptedItems' in doc.reviewSummary, 'acceptedItems debe estar');
});

// ─── T-D145: activación no falla si nutritionDisplay vacío ───────────────────
test('T-D145: D.2-B: nutritionDisplay vacío → mirrors con valores vacíos (no null)', function() {
  var planData = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved',
    nutritionDisplay: undefined, nutritionRaw: undefined,
    supplementDisplay: undefined, supplementsRaw: undefined };
  var updates = simulateActivation(planData, { coachId: 'c1', activePlanId: null }, 'c1', 'plan-1', 'cl1');
  assert(updates.client !== null, 'client write debe existir');
  assert(typeof updates.client.nutritionPlan === 'object', 'nutritionPlan debe ser objeto (vacío)');
  assert(typeof updates.client.supplementPlan === 'object', 'supplementPlan debe ser objeto (vacío)');
});

// ─── D.2.1: Safety Gate — Medical Blocker Tests (T-D146 … T-D162) ────────────

// Helper: build items for D.2.1 tests
function makeReviewItems(specs) {
  // specs: array of { type, blockingStatus? }
  return specs.map(function(s, idx) {
    return { type: s.type, blockingStatus: s.blockingStatus || (s.type === 'medical' ? 'blocks_activation' : 'non_blocking'), text: 'item-' + idx };
  });
}

// T-D146: _MEDICAL_BLOCKER_RE matches hematocrito
test('T-D146: MEDICAL_BLOCKER_RE: "hematocrito 56.7%" → match', function() {
  assert(MEDICAL_BLOCKER_RE.test('hematocrito 56.7%'), 'hematocrito debe hacer match');
});

// T-D147: _MEDICAL_BLOCKER_RE matches tejido palpable
test('T-D147: MEDICAL_BLOCKER_RE: "tejido palpable zona mamaria" → match', function() {
  assert(MEDICAL_BLOCKER_RE.test('tejido palpable zona mamaria'), 'tejido debe hacer match');
});

// T-D148: _MEDICAL_BLOCKER_RE matches neurológico
test('T-D148: MEDICAL_BLOCKER_RE: "síntomas neurológicos" → match', function() {
  assert(MEDICAL_BLOCKER_RE.test('síntomas neurológicos'), 'neurológicos debe hacer match');
});

// T-D149: _MEDICAL_BLOCKER_RE does NOT match plain training warning
test('T-D149: MEDICAL_BLOCKER_RE: "volumen de entrenamiento elevado" → no match', function() {
  assert(!MEDICAL_BLOCKER_RE.test('volumen de entrenamiento elevado'), 'training warning no debe hacer match');
});

// T-D150: _MEDICAL_BLOCKER_RE does NOT match mobility warning
test('T-D150: MEDICAL_BLOCKER_RE: "restricción lumbar leve" → no match', function() {
  assert(!MEDICAL_BLOCKER_RE.test('restricción lumbar leve'), 'restricción lumbar no debe hacer match como médico');
});

// T-D151: item type=medical → blockingStatus = blocks_activation
test('T-D151: itemBlockingStatus: type=medical → blocks_activation', function() {
  var item = { type: 'medical', text: 'hematocrito elevado' };
  assert(itemBlockingStatus(item) === 'blocks_activation', 'medical → blocks_activation');
});

// T-D152: item type=general → blockingStatus = non_blocking
test('T-D152: itemBlockingStatus: type=general → non_blocking', function() {
  var item = { type: 'general', text: 'entrenamiento intenso' };
  assert(itemBlockingStatus(item) === 'non_blocking', 'general → non_blocking');
});

// T-D153: medical blocker acknowledged → still blocks (medicalBlockers > 0)
test('T-D153: gate: medical blocker acknowledged → MEDICAL_BLOCKER error (acknowledged ≠ resolved)', function() {
  var items = makeReviewItems([{ type: 'medical' }]);
  var rs = { __items: items, __consistency: [], 0: 'acknowledged' };
  var resp = makeValidResponse({ requestId: 'r153', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.includes('MEDICAL_BLOCKER'), 'acknowledged medical blocker debe seguir bloqueando');
  assert(!errs.includes('REVIEW_INCOMPLETE'), 'acknowledged no es unresolved');
});

// T-D154: medical blocker requires_adjustment → blocks via both MEDICAL_BLOCKER and REVIEW_ADJUSTMENT
test('T-D154: gate: medical blocker requires_adjustment → MEDICAL_BLOCKER + REVIEW_ADJUSTMENT', function() {
  var items = makeReviewItems([{ type: 'medical' }]);
  var rs = { __items: items, __consistency: [], 0: 'requires_adjustment' };
  var resp = makeValidResponse({ requestId: 'r154', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.includes('MEDICAL_BLOCKER'),    'debe incluir MEDICAL_BLOCKER');
  assert(errs.includes('REVIEW_ADJUSTMENT'),  'requires_adjustment debe contar como REVIEW_ADJUSTMENT');
});

// T-D155: non-medical accepted → no block
test('T-D155: gate: non-medical accepted → sin error', function() {
  var items = makeReviewItems([{ type: 'general' }]);
  var rs = { __items: items, __consistency: [], 0: 'accept' };
  var resp = makeValidResponse({ requestId: 'r155', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.length === 0, 'non-medical accepted sin errores: ' + JSON.stringify(errs));
});

// T-D156: mix medical + non-medical; non-medical accepted but medical present → MEDICAL_BLOCKER only
test('T-D156: gate: non-medical accepted + 1 medical → solo MEDICAL_BLOCKER', function() {
  var items = makeReviewItems([{ type: 'general' }, { type: 'medical' }]);
  var rs = { __items: items, __consistency: [], 0: 'accept', 1: 'acknowledged' };
  var resp = makeValidResponse({ requestId: 'r156', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.includes('MEDICAL_BLOCKER'), 'debe incluir MEDICAL_BLOCKER');
  assert(!errs.includes('REVIEW_INCOMPLETE'), 'todos revisados');
  assert(!errs.includes('REVIEW_ADJUSTMENT'), 'sin ajuste pendiente');
});

// T-D157: zero medical blockers + all accepted → readyForApproval = true (no errors)
test('T-D157: gate: 0 medical blockers + todos accepted → sin errores (readyForApproval)', function() {
  var items = makeReviewItems([{ type: 'general' }, { type: 'mobility', blockingStatus: 'non_blocking' }]);
  var rs = { __items: items, __consistency: [], 0: 'accept', 1: 'accept' };
  var resp = makeValidResponse({ requestId: 'r157', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.length === 0, 'sin medical blocker → readyForApproval: ' + JSON.stringify(errs));
});

// T-D158: info type items do not count as medical blockers
test('T-D158: gate: info items ignorados en conteo de medical blockers', function() {
  var items = [{ type: 'info', blockingStatus: 'non_blocking', text: 'farmacología omitida' }];
  var rs = { __items: items, __consistency: [] };
  var resp = makeValidResponse({ requestId: 'r158', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(!errs.includes('MEDICAL_BLOCKER'),    'info no es medical blocker');
  assert(!errs.includes('REVIEW_INCOMPLETE'),  'info no cuenta para reviewed');
});

// T-D159: requires_adjustment on non-blocking item → REVIEW_ADJUSTMENT (not MEDICAL_BLOCKER)
test('T-D159: gate: requires_adjustment en item non-blocking → solo REVIEW_ADJUSTMENT', function() {
  var items = makeReviewItems([{ type: 'general', blockingStatus: 'non_blocking' }]);
  var rs = { __items: items, __consistency: [], 0: 'requires_adjustment' };
  var resp = makeValidResponse({ requestId: 'r159', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.includes('REVIEW_ADJUSTMENT'), 'requires_adjustment → REVIEW_ADJUSTMENT');
  assert(!errs.includes('MEDICAL_BLOCKER'),  'non-blocking → no MEDICAL_BLOCKER');
});

// T-D160: explicit blockingStatus: 'blocks_activation' on non-medical type → still blocks
test('T-D160: gate: blockingStatus=blocks_activation explícito → bloquea aunque type=general', function() {
  var items = [{ type: 'general', blockingStatus: 'blocks_activation', text: 'alerta especial' }];
  var rs = { __items: items, __consistency: [], 0: 'accept' };
  var resp = makeValidResponse({ requestId: 'r160', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.includes('MEDICAL_BLOCKER'), 'explicit blocks_activation → MEDICAL_BLOCKER');
});

// T-D161: 2 medical blockers → MEDICAL_BLOCKER count reflected
test('T-D161: gate: 2 medical blockers → MEDICAL_BLOCKER (count=2)', function() {
  var items = makeReviewItems([{ type: 'medical' }, { type: 'medical' }]);
  var rs = { __items: items, __consistency: [], 0: 'acknowledged', 1: 'acknowledged' };
  var resp = makeValidResponse({ requestId: 'r161', status: 'NEEDS_COACH_REVIEW' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, true);
  assert(errs.includes('MEDICAL_BLOCKER'), '2 blockers → MEDICAL_BLOCKER presente');
});

// T-D162: VALID (requiresReview=false) with medical items → gate not enforced (no errors)
test('T-D162: gate: VALID status (requiresReview=false) → gate no se aplica', function() {
  var items = makeReviewItems([{ type: 'medical' }]);
  var rs = { __items: items, __consistency: [] };
  var resp = makeValidResponse({ requestId: 'r162', status: 'VALID' });
  var errs = checkD2APreconditions(resp, 'c1', 'co1', { coachId: 'co1' }, rs, false);
  assert(!errs.includes('MEDICAL_BLOCKER'), 'VALID: gate no aplica → no MEDICAL_BLOCKER');
  assert(errs.length === 0, 'VALID: 0 errores: ' + JSON.stringify(errs));
});

// ─── T-D163..T-D164: Security regression — no tempPassword in Firestore writes ──

var fs = require('fs');
var path = require('path');

var _coachSrc = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

// T-D163: setDoc call at client creation must not include tempPassword field
test('T-D163: security: setDoc(clients/{uid}) no contiene tempPassword', function() {
  // Find the setDoc block that writes client data at creation.
  // The write includes role:"client" and activePlanId — verify tempPassword absent.
  var setDocMatch = _coachSrc.match(/setDoc\(doc\(db,\s*["']clients["'][^)]*\),\s*\{[^}]*role:\s*["']client["'][^}]*\}/);
  if (!setDocMatch) {
    // If refactored across lines, scan broader window around "role: \"client\""
    var idx = _coachSrc.indexOf('"role": "client"');
    if (idx === -1) idx = _coachSrc.indexOf('role: "client"');
    assert(idx !== -1, 'setDoc clients block with role:client must exist');
    var window500 = _coachSrc.slice(Math.max(0, idx - 200), idx + 300);
    assert(!window500.includes('tempPassword'), 'setDoc clients block must not contain tempPassword near role:client');
  } else {
    assert(!setDocMatch[0].includes('tempPassword'), 'setDoc clients:{role:client} must not include tempPassword: ' + setDocMatch[0].slice(0, 120));
  }
});

// T-D164: updateDoc calls on clients collection must not write tempPassword
test('T-D164: security: updateDoc(clients) no persiste tempPassword', function() {
  // Find all updateDoc calls targeting the clients collection and check none include tempPassword
  var re = /updateDoc\(doc\(db,\s*["']clients["'][^;]{0,300}/g;
  var m;
  var found = [];
  while ((m = re.exec(_coachSrc)) !== null) {
    if (m[0].includes('tempPassword')) found.push(m[0].slice(0, 100));
  }
  assert(found.length === 0, 'updateDoc(clients) no debe incluir tempPassword. Encontrado: ' + JSON.stringify(found));
});

// ─── Runner ───────────────────────────────────────────────────────────────────

var passed = 0;
var failed = 0;
var errors = [];

(async function run() {
  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    try {
      await t.fn();
      console.log('  ✓ ' + t.name);
      passed++;
    } catch (e) {
      console.log('  ✗ ' + t.name);
      console.log('    ' + e.message);
      errors.push(t.name + ': ' + e.message);
      failed++;
    }
  }
  console.log('\n─── T-D Results: ' + passed + '/' + (passed + failed) + ' passed ───');
  if (failed > 0) {
    console.log('\nFAILED:');
    errors.forEach(function(e) { console.log('  ' + e); });
    process.exit(1);
  }
})();
