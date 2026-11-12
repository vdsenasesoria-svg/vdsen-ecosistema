'use strict';
/**
 * T289 — Generator guardrails. Verifies buildGenerationRequest exposes
 * snapshot.evidenceQuality additively as `evidenceQuality`, and that the
 * embedded Motor prompt documents it with the mandatory guardrails: no
 * STALE evidence presented as current fact, CONFLICTING evidence forces
 * conservative/review behavior, UNRESOLVED evidence is never fabricated,
 * LEGACY evidence never overrides current identity-safe evidence, no
 * independent freshness recomputation, no confident redesign from
 * PARTIAL/STALE, and safety still wins with new valid safety evidence.
 *
 * Run: node tests/t289-generator-evidence-quality-guardrails.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ── Wiring ───────────────────────────────────────────────────────────────
ok(COACH.includes('var evidenceQuality           = snapshot.evidenceQuality;'), 'buildGenerationRequest sources evidenceQuality from the canonical snapshot');
ok(COACH.includes('evidenceQuality:   evidenceQuality,'), 'evidenceQuality is attached to the generation request object');

// ── Functional: build a real request and confirm evidenceQuality flows
// through end to end. ───────────────────────────────────────────────────
function runBuildRequest(windowStub, params) {
  const scriptOpenIdx  = COACH.lastIndexOf('\n<script>\n', COACH.indexOf('  function _mapLogs(logsDoc) {'));
  const scriptCloseIdx = COACH.indexOf('\n</script>', COACH.indexOf('  function buildGenerationRequest(params) {'));
  const outer = COACH.slice(scriptOpenIdx + '\n<script>\n'.length, scriptCloseIdx);
  windowStub = windowStub || {};
  new Function('window', outer)(windowStub);
  return windowStub.VDSEN_BUILD.buildGenerationRequest(params);
}

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}
const enumSrc = extractFunction(COACH, 'var EVIDENCE_QUALITY = {').replace(/^var EVIDENCE_QUALITY = /, '');
const classifySrc = extractFunction(COACH, 'function _classifyEvidenceQuality(input)');
const evidenceWindow = new Function('var EVIDENCE_QUALITY = ' + enumSrc + ';\n' + classifySrc + ';\nreturn { classify: _classifyEvidenceQuality, STATUS: EVIDENCE_QUALITY };')();

{
  const result = runBuildRequest({ VDSEN_EVIDENCE: evidenceWindow }, {
    clientId: 'client-1', coachId: 'coach-1',
    clientDoc: { activePlanId: 'plan-A' }, planDoc: { days: [] }, logsDoc: { entries: {}, currentWeek: 1 }, fichaDoc: null
  });
  ok(result.rawRequest.evidenceQuality && result.rawRequest.evidenceQuality.overall === 'UNRESOLVED',
    'a sparse client (no check-in, no progression evidence) produces a request whose evidenceQuality.overall is honestly UNRESOLVED, not silently omitted or defaulted to VALID');
  ok(result.rawRequest.evidenceQuality.recovery.status === 'UNRESOLVED' && result.rawRequest.evidenceQuality.progression.status === 'UNRESOLVED',
    'per-domain statuses flow through to the request unchanged from the snapshot');
}

// ── Motor prompt guardrails ─────────────────────────────────────────────
const m = COACH.match(/const _MOTOR_PROMPT_EMBEDDED = "(.*?)";\n/s);
const motorPrompt = eval(m[0].replace('const _MOTOR_PROMPT_EMBEDDED = ', ''));

ok(motorPrompt.includes('CONTEXTO DE CALIDAD DE EVIDENCIA (evidenceQuality)'), 'Motor prompt documents the evidenceQuality context field');
ok(motorPrompt.includes('evidencia STALE nunca se presenta como hecho actual'), 'Motor prompt forbids presenting STALE evidence as current fact');
ok(motorPrompt.includes('Evidencia CONFLICTING exige comportamiento conservador/de revision, nunca una conclusion confiada'), 'Motor prompt forces conservative/review behavior on CONFLICTING evidence');
ok(motorPrompt.includes('Evidencia UNRESOLVED nunca se rellena ni se inventa'), 'Motor prompt forbids fabricating UNRESOLVED evidence');
ok(motorPrompt.includes('Evidencia LEGACY (por ejemplo progresion sin PID) nunca reemplaza ni se mezcla con evidencia PID-exacta vigente'), 'Motor prompt forbids legacy evidence overriding current identity-safe evidence');
ok(motorPrompt.includes('NUNCA recalcules tu propia version de frescura/antigüedad a partir de timestamps crudos'), 'Motor prompt forbids independently recomputing freshness from raw timestamps');
ok(motorPrompt.includes('overall` PARTIAL/STALE/UNRESOLVED/CONFLICTING NUNCA justifica un rediseño confiado del plan'), 'Motor prompt forbids a confident redesign from PARTIAL/STALE/UNRESOLVED/CONFLICTING evidence');
ok(motorPrompt.includes('un signo de dolor real reportado esta semana sigue siendo prioritario aunque otros dominios esten STALE/UNRESOLVED'), 'Motor prompt confirms safety still wins even when other evidence quality is low');

console.log('');
console.log('T289 — Generator evidence-quality guardrails: ' + pass + ' assertions PASSED');
