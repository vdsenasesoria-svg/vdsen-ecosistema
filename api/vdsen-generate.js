'use strict';

/**
 * VDSEN Generate — OpenAI Responses API proxy
 *
 * POST /api/vdsen-generate
 *   Input:  vdsen-generation-request-v1 (JSON body)
 *   Output: vdsen-generation-response-v1 (JSON response)
 *
 * Responsibilities (Claude Code layer):
 *   transport · security · request validation · response validation · error mapping
 *
 * NOT this file's job:
 *   volume · RIR · exercise selection · macro calculation · physiological logic
 *
 * NO persistence. Response is returned to caller only.
 */

var contracts    = require('./vdsen-contracts');
var validateReq  = contracts.validateGenerationRequest;
var validateResp = contracts.validateGenerationResponse;

// ─── Error codes ─────────────────────────────────────────────────────────────

var ERR = {
  OPENAI_NOT_CONFIGURED:   'OPENAI_NOT_CONFIGURED',
  OPENAI_REQUEST_FAILED:   'OPENAI_REQUEST_FAILED',
  OPENAI_TIMEOUT:          'OPENAI_TIMEOUT',
  MODEL_EMPTY_OUTPUT:      'MODEL_EMPTY_OUTPUT',
  MODEL_REFUSAL:           'MODEL_REFUSAL',
  MODEL_OUTPUT_INCOMPLETE: 'MODEL_OUTPUT_INCOMPLETE',
  MODEL_SCHEMA_MISMATCH:   'MODEL_SCHEMA_MISMATCH',
  MODEL_RESPONSE_INVALID:  'MODEL_RESPONSE_INVALID',
  REQUEST_INVALID:         'REQUEST_INVALID'
};

// ─── JSON Schema for Structured Output (OpenAI Responses API) ────────────────
// Locks down root-level fields. Nested structures (plan, decisionTrace, etc.)
// are validated by validateGenerationResponse() after extraction.

var VDSEN_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    schema:        { type: 'string' },
    requestId:     { type: 'string' },
    status:        { type: 'string', enum: ['VALID', 'NEEDS_INPUT', 'NEEDS_COACH_REVIEW', 'INVALID'] },
    moduleStatus:  {
      anyOf: [
        {
          type: 'object',
          properties: {
            training:         { anyOf: [{ type: 'string', enum: ['READY','NEEDS_INPUT','NEEDS_COACH_REVIEW','INVALID'] }, { type: 'null' }] },
            nutritionTargets: { anyOf: [{ type: 'string', enum: ['READY','NEEDS_INPUT','NEEDS_COACH_REVIEW','INVALID'] }, { type: 'null' }] },
            nutritionMenu:    { anyOf: [{ type: 'string', enum: ['READY','NEEDS_INPUT','NEEDS_COACH_REVIEW','INVALID'] }, { type: 'null' }] },
            supplementation:  { anyOf: [{ type: 'string', enum: ['READY','NEEDS_INPUT','NEEDS_COACH_REVIEW','INVALID'] }, { type: 'null' }] }
          },
          required: ['training', 'nutritionTargets', 'nutritionMenu', 'supplementation'],
          additionalProperties: false
        },
        { type: 'null' }
      ]
    },
    plan:          { anyOf: [{ type: 'object' }, { type: 'null' }] },
    audit:         { anyOf: [{ type: 'object' }, { type: 'null' }] },
    decisionTrace: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    missingInputs: { anyOf: [{ type: 'array', items: {} }, { type: 'null' }] },
    warnings:      { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    errors:        { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    documents:     { anyOf: [{ type: 'object' }, { type: 'null' }] }
  },
  required: [
    'schema', 'requestId', 'status', 'moduleStatus',
    'plan', 'decisionTrace', 'missingInputs', 'warnings', 'errors'
  ],
  additionalProperties: false
};

// ─── System prompt ────────────────────────────────────────────────────────────
// Based on VDSEN master instructions, adapted for Responses API contract.

function buildSystemPrompt() {
  return [
    'Eres Motor VDSEN, sistema experto en prescripción de entrenamiento, nutrición y suplementación científica.',
    'Basas tu trabajo en el Compendio VDSEN v3.3 (Ayrton VD, Lic. Ciencias del Deporte).',
    '',
    'ENTRADA: recibirás un objeto vdsen-generation-request-v1 en el mensaje del usuario.',
    'SALIDA:  debes devolver EXACTAMENTE un objeto vdsen-generation-response-v1 (JSON estructurado).',
    '',
    '══ REGLAS ABSOLUTAS ══',
    '',
    '1. exercisesAvoid = VETO absoluto. NUNCA incluyas un ejercicio vetado en ningún módulo.',
    '2. NO inventes datos críticos ausentes (edad, peso, nivel). Reporta NEEDS_INPUT con missingInputs.',
    '3. Para entrenamiento: load=0 siempre (el cliente registra la carga real en la app).',
    '4. Volumen fraccional por músculo objetivo. No copies estructuras de planes previos.',
    '5. Macros: proteína+carbs+grasas deben cuadrar dentro de ±3% de las calorías totales.',
    '6. Suplementación: incluye ≥3 sustituciones por ítem de protocolo.',
    '7. NO generes protocolos farmacológicos, dosis ni ciclos. Si el perfil requiere farmacología, omítela del plan.',
    '8. plan.schema DEBE ser "vdsen-plan-v2".',
    '9. Dentro del plan NUNCA incluyas: audit, decisionTrace, targets, moduleStatus, warnings, errors, model, requestId, generatedAt, documents.',
    '10. decisionTrace: documenta fuentes, confidence y reasonCodes de las decisiones principales.',
    '11. moduleStatus: reporta el estado real de cada módulo generado (READY/NEEDS_INPUT/NEEDS_COACH_REVIEW/INVALID).',
    '12. Si status=NEEDS_INPUT, missingInputs debe listar cada campo faltante con field, module e impact.',
    '13. Verifica internamente que el output es coherente antes de responder.',
    '14. outputMode indica el formato solicitado (json/txt/pdf/all). En esta versión devuelve siempre el JSON estructurado.',
    '15. nivel_medio usa el enum exacto del sistema VDSEN. variacion_vertical es un objeto con campos definidos.',
    '16. CAMPOS DE INFRAESTRUCTURA (requestId, clientId, coachId, requestedAt, attachments, schema) NO son campos de datos del cliente. NUNCA los incluyas en missingInputs — el servidor los gestiona y no son entradas del cliente.',
    '17. El nombre canónico del campo de talla es "talla_cm". Si ves "altura_cm" en los datos, trátalo como "talla_cm". NUNCA reportes "altura_cm" en missingInputs.',
    '18. CRITICIDAD de campos por módulo: un módulo pasa a NEEDS_INPUT SOLO si le falta un campo marcado como REQUIRED para ese módulo. Los campos RECOMMENDED u OPTIONAL generan aviso pero NO bloquean el módulo. Ejemplo: para suplementación, "edad" es OPTIONAL — su ausencia NO pone el módulo en NEEDS_INPUT.',
    '19. moduleStatus READY significa que tienes suficiente información para generar ese módulo (todos los REQUIRED presentes). Si un módulo puede generarse razonablemente, debe ser READY aunque falten campos RECOMMENDED u OPTIONAL.',
    '',
    'El campo requestId de tu respuesta debe coincidir exactamente con el requestId de la entrada.',
    'Los campos schema, generatedAt y model serán controlados por el servidor y pueden ser sobreescritos.'
  ].join('\n');
}

// ─── prepareModelRequest ──────────────────────────────────────────────────────
// Strips infra/identifying/contact fields before sending to model.
// Does NOT alter any physiological data.

var _INFRA_STRIP = ['requestId', 'clientId', 'coachId', 'requestedAt', 'attachments', 'schema'];
var _CONTACT_FIELDS = ['email', 'telefono', 'phone', 'contact', 'direccion', 'address', 'uid'];

function prepareModelRequest(request) {
  var payload = {};
  Object.keys(request).forEach(function(k) {
    if (_INFRA_STRIP.indexOf(k) !== -1) return;
    payload[k] = request[k];
  });

  var pharmacologyOmitted = false;

  // Remove farmacologia — not included in Phase C model call
  if (payload.clientProfile && payload.clientProfile.farmacologia) {
    payload.clientProfile = Object.assign({}, payload.clientProfile);
    delete payload.clientProfile.farmacologia;
    pharmacologyOmitted = true;
  }

  // Remove contact fields from clientProfile.base
  if (payload.clientProfile && payload.clientProfile.base) {
    var base = Object.assign({}, payload.clientProfile.base);
    _CONTACT_FIELDS.forEach(function(f) { delete base[f]; });
    payload.clientProfile = Object.assign({}, payload.clientProfile, { base: base });
  }

  // Strip gymInfo from options (infra metadata, not needed by model)
  if (payload.options) {
    var opts = Object.assign({}, payload.options);
    delete opts.gymInfo;
    payload.options = opts;
  }

  return { modelPayload: payload, pharmacologyOmitted: pharmacologyOmitted };
}

// ─── removeNullFields ─────────────────────────────────────────────────────────
// Strips null root-level keys before contract validation.
// The JSON schema requires all fields present (allows null) but the contract
// treats absent keys as "not provided" — different from null.

function removeNullFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  var out = {};
  Object.keys(obj).forEach(function(k) {
    if (obj[k] !== null) out[k] = obj[k];
  });
  return out;
}

// ─── sanitizeMissingInputs ────────────────────────────────────────────────────
// Server-side post-processing on model output's missingInputs arrays.
// Removes infra fields the model should never report, and normalizes aliases.

var _ALIAS_MAP = { 'altura_cm': 'talla_cm' };

function sanitizeMissingInputs(parsed) {
  if (!parsed || !Array.isArray(parsed.missingInputs) || parsed.missingInputs.length === 0) {
    return parsed;
  }
  var filtered = parsed.missingInputs
    .map(function(entry) {
      if (!entry || !entry.field) return entry;
      var canonical = _ALIAS_MAP[entry.field];
      if (canonical) return Object.assign({}, entry, { field: canonical });
      return entry;
    })
    .filter(function(entry) {
      return entry && entry.field && _INFRA_STRIP.indexOf(entry.field) === -1;
    });
  return Object.assign({}, parsed, { missingInputs: filtered });
}

// ─── extractModelResponse ─────────────────────────────────────────────────────
// Robust extraction from Responses API output.
// Does NOT assume a fixed output[0].content[0] shape.

function extractModelResponse(rawResponse) {
  var result = {
    text:       null,
    parsed:     null,
    refusal:    null,
    incomplete: false,
    errorCode:  null,
    usage:      null
  };

  if (!rawResponse) {
    result.errorCode = ERR.MODEL_EMPTY_OUTPUT;
    return result;
  }

  // Usage tokens (field names vary across SDK versions)
  if (rawResponse.usage) {
    var u = rawResponse.usage;
    result.usage = {
      inputTokens:  u.input_tokens  || u.prompt_tokens     || 0,
      outputTokens: u.output_tokens || u.completion_tokens || 0,
      cachedTokens: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0,
      model:        rawResponse.model || null
    };
  }

  // Top-level incomplete status
  if (rawResponse.status && rawResponse.status !== 'completed') {
    result.incomplete = true;
    result.errorCode  = ERR.MODEL_OUTPUT_INCOMPLETE;
    return result;
  }

  // Walk output array looking for message content
  var output = rawResponse.output || [];
  for (var i = 0; i < output.length; i++) {
    var item = output[i];
    if (!item || item.type !== 'message') continue;
    var content = Array.isArray(item.content) ? item.content : [];
    for (var j = 0; j < content.length; j++) {
      var block = content[j];
      if (!block) continue;
      if (block.type === 'refusal') {
        result.refusal   = block.refusal || 'Model refused to generate content.';
        result.errorCode = ERR.MODEL_REFUSAL;
        return result;
      }
      if (block.type === 'output_text' && block.text) {
        result.text = block.text;
      }
    }
    if (result.text) break;
  }

  if (!result.text) {
    result.errorCode = ERR.MODEL_EMPTY_OUTPUT;
    return result;
  }

  // Parse JSON
  try {
    result.parsed = JSON.parse(result.text);
  } catch (e) {
    result.errorCode = ERR.MODEL_SCHEMA_MISMATCH;
  }

  return result;
}

// ─── buildErrorResponse ───────────────────────────────────────────────────────

function buildErrorResponse(errorCode, requestId, details) {
  return {
    schema:      'vdsen-generation-response-v1',
    requestId:   requestId || null,
    status:      'INVALID',
    generatedAt: new Date().toISOString(),
    errorCode:   errorCode,
    errors:      [errorCode + (details ? ': ' + details : '')]
  };
}

// ─── createHandlerWithClient ──────────────────────────────────────────────────
// Injectable OpenAI client factory — enables mock testing without network calls.
// factory(apiKey) → { responses: { create: async (params) → rawResponse } }

function createHandlerWithClient(openaiClientFactory) {
  return async function handler(req, res) {
    var startMs    = Date.now();
    var requestId  = null;
    var model      = process.env.OPENAI_MODEL;

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    var body = req.body || {};
    requestId = body.requestId || null;

    // ── 1. Validate input contract ──────────────────────────────────────────
    var reqVal = validateReq(body);
    if (!reqVal.valid) {
      return res.status(400).json({
        schema:      'vdsen-generation-response-v1',
        requestId:   requestId,
        status:      'INVALID',
        errorCode:   ERR.REQUEST_INVALID,
        errors:      reqVal.errors,
        warnings:    reqVal.warnings,
        generatedAt: new Date().toISOString()
      });
    }

    // ── 2. Check API key and model ──────────────────────────────────────────
    var apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !model) {
      return res.status(500).json(buildErrorResponse(ERR.OPENAI_NOT_CONFIGURED, requestId));
    }

    // ── 3. Sanitize payload ─────────────────────────────────────────────────
    var prep             = prepareModelRequest(body);
    var modelPayload     = prep.modelPayload;
    var pharmacoOmitted  = prep.pharmacologyOmitted;

    // ── 4. Build OpenAI client ──────────────────────────────────────────────
    var client;
    try {
      client = openaiClientFactory(apiKey);
    } catch (e) {
      return res.status(500).json(buildErrorResponse(ERR.OPENAI_NOT_CONFIGURED, requestId, e.message));
    }

    // ── 5. Call Responses API ───────────────────────────────────────────────
    var rawResponse;
    try {
      rawResponse = await client.responses.create({
        model:        model,
        instructions: buildSystemPrompt(),
        input:        JSON.stringify(modelPayload),
        text: {
          format: {
            type:   'json_schema',
            name:   'vdsen_generation_response_v1',
            schema: VDSEN_RESPONSE_JSON_SCHEMA,
            strict: false
          }
        }
      });
    } catch (e) {
      var isTimeout = e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' ||
                      (e.status && e.status === 408) ||
                      /timeout|timed out/i.test(e.message);
      if (isTimeout) {
        return res.status(504).json(buildErrorResponse(ERR.OPENAI_TIMEOUT, requestId, e.message));
      }
      return res.status(502).json(buildErrorResponse(ERR.OPENAI_REQUEST_FAILED, requestId, e.message));
    }

    // ── 6. Extract structured response ──────────────────────────────────────
    var extraction = extractModelResponse(rawResponse);

    if (extraction.refusal) {
      return res.status(502).json(buildErrorResponse(ERR.MODEL_REFUSAL, requestId, extraction.refusal));
    }
    if (extraction.incomplete) {
      return res.status(502).json(buildErrorResponse(ERR.MODEL_OUTPUT_INCOMPLETE, requestId));
    }
    if (extraction.errorCode === ERR.MODEL_EMPTY_OUTPUT) {
      return res.status(502).json(buildErrorResponse(ERR.MODEL_EMPTY_OUTPUT, requestId));
    }
    if (extraction.errorCode === ERR.MODEL_SCHEMA_MISMATCH || !extraction.parsed) {
      return res.status(502).json(buildErrorResponse(ERR.MODEL_SCHEMA_MISMATCH, requestId));
    }

    var parsed = sanitizeMissingInputs(extraction.parsed);

    // ── 7. Detect requestId mismatch ────────────────────────────────────────
    if (parsed.requestId && parsed.requestId !== requestId) {
      return res.status(502).json(
        buildErrorResponse(ERR.MODEL_SCHEMA_MISMATCH, requestId, 'requestId mismatch in model output')
      );
    }

    // ── 8. Override server-controlled fields ────────────────────────────────
    // model and generatedAt are ALWAYS set server-side; never trusted from model output.
    var response = Object.assign({}, parsed, {
      schema:      'vdsen-generation-response-v1',
      requestId:   requestId,
      generatedAt: new Date().toISOString(),
      model:       model
    });

    // ── 9. Strip null root fields before contract validation ────────────────
    var cleanedResponse = removeNullFields(response);

    // ── 10. Validate response contract ──────────────────────────────────────
    var respVal = validateResp(cleanedResponse);
    if (!respVal.valid) {
      return res.status(422).json(Object.assign(
        buildErrorResponse(ERR.MODEL_RESPONSE_INVALID, requestId, 'response contract violation'),
        { contractErrors: respVal.errors, partialResponse: cleanedResponse }
      ));
    }

    // ── 11. Safe diagnostics log ─────────────────────────────────────────────
    // NEVER log: ficha, nutrition details, injuries, pharmacology, prompt, key, full response
    var latencyMs = Date.now() - startMs;
    console.log('[vdsen-generate] ' + JSON.stringify({
      requestId:           requestId,
      model:               model,
      latencyMs:           latencyMs,
      status:              cleanedResponse.status,
      validationPass:      true,
      pharmacoOmitted:     pharmacoOmitted,
      inputTokens:         extraction.usage && extraction.usage.inputTokens,
      outputTokens:        extraction.usage && extraction.usage.outputTokens,
      cachedTokens:        extraction.usage && extraction.usage.cachedTokens
    }));

    // ── 12. Return — NO persistence ─────────────────────────────────────────
    return res.status(200).json(cleanedResponse);
  };
}

// ─── Default Vercel handler ───────────────────────────────────────────────────
// openai package loaded lazily so tests don't require it to be installed.

var _defaultFactory = function(apiKey) {
  var OpenAI = require('openai');
  return new OpenAI({ apiKey: apiKey });
};

var handler = createHandlerWithClient(_defaultFactory);

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = handler;

module.exports._internal = {
  ERR:                   ERR,
  VDSEN_RESPONSE_JSON_SCHEMA: VDSEN_RESPONSE_JSON_SCHEMA,
  buildSystemPrompt:     buildSystemPrompt,
  prepareModelRequest:   prepareModelRequest,
  removeNullFields:      removeNullFields,
  extractModelResponse:  extractModelResponse,
  buildErrorResponse:    buildErrorResponse,
  sanitizeMissingInputs: sanitizeMissingInputs
};

module.exports._createHandlerWithClient = createHandlerWithClient;
