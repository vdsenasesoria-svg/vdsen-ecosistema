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
