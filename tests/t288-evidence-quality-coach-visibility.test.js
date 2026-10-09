'use strict';
/**
 * T288 — Coach visibility for the T284-287 evidence-quality layer.
 * Verifies the compact "Estado de evidencia" card: sourced entirely from
 * _monitorSnapshot.evidenceQuality (no second engine), hidden entirely
 * when overall is VALID, exceptions-first (only non-VALID domains
 * listed), never a giant permanent diagnostics panel.
 *
 * Run: node tests/t288-evidence-quality-coach-visibility.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractBlock(src, marker) {
  const idx = src.indexOf(marker);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceStart, i + 1); }
  }
  return null;
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const block = extractBlock(COACH, "if (_monitorSnapshot && _monitorSnapshot.evidenceQuality && _monitorSnapshot.evidenceQuality.overall !== 'VALID') {\n      const _eq288");
ok(block, 'the T288 evidence-status card block extracts cleanly');
ok(block.includes('_monitorSnapshot.evidenceQuality'), 'sourced entirely from the shared snapshot\'s evidenceQuality -- no second engine');
ok(!/getDoc\(|await /.test(block), 'the render block performs no Firestore reads of its own');

function runBlock(evidenceQuality) {
  const escH = function(s) { return String(s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const _monitorSnapshot = { evidenceQuality: evidenceQuality };
  let html = '';
  const fn = new Function('_escH', '_monitorSnapshot', 'html',
    "if (_monitorSnapshot && _monitorSnapshot.evidenceQuality && _monitorSnapshot.evidenceQuality.overall !== 'VALID') " + block + "\nreturn html;"
  );
  return fn(escH, _monitorSnapshot, html);
}

const ALL_VALID = {
  overall: 'VALID',
  execution: { status: 'VALID', reason: 'ok' }, recovery: { status: 'VALID', reason: 'ok' },
  progression: { status: 'VALID', reason: 'ok' }, nutrition: { status: 'VALID', reason: 'ok' },
  bodyComposition: { status: 'VALID', reason: 'ok' }, coachIntervention: { status: 'VALID', reason: 'ok' }
};

// ─────────────────────────────────────────────────────────────────────────────
// Hidden entirely when everything is VALID -- no permanent panel.
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = runBlock(ALL_VALID);
  ok(out === '', 'CASE K: all sources VALID -> zero output, no evidence-warning UI at all');
}

// ─────────────────────────────────────────────────────────────────────────────
// Exceptions-first: only the non-VALID domains are listed.
// ─────────────────────────────────────────────────────────────────────────────
{
  const eq = Object.assign({}, ALL_VALID, {
    overall: 'PARTIAL',
    recovery: { status: 'STALE', reason: 'scope_mismatch' },
    nutrition: { status: 'PARTIAL', reason: 'incomplete', completeness: 1 / 3 },
    bodyComposition: { status: 'CONFLICTING', reason: 'conflict_flag' }
  });
  const out = runBlock(eq);
  ok(out.includes('PARCIAL'), 'overall PARTIAL is shown with a Spanish label');
  ok(out.includes('Check-in semanal') && out.includes('una semana anterior'), 'recovery STALE surfaces as "Check-in semanal: ...de una semana anterior"');
  ok(out.includes('Adherencia nutricional') && out.includes('incompleto') && out.includes('33%'), 'nutrition PARTIAL surfaces with its real completeness percentage');
  ok(out.includes('Composición corporal') && out.includes('inconsistentes'), 'bodyComposition CONFLICTING surfaces as measurement inconsistency');
  ok(!out.includes('Ejecución de entrenamiento') && !out.includes('Progresión de ejercicios') && !out.includes('Intervención del coach'),
    'exceptions-first: the still-VALID domains (execution/progression/coachIntervention) are never listed -- no giant diagnostics panel');
}

// ─────────────────────────────────────────────────────────────────────────────
// A single non-VALID domain still renders (overall reflects the worst,
// per T286's rollup) -- the card isn't gated on multiple problems existing.
// ─────────────────────────────────────────────────────────────────────────────
{
  const eq = Object.assign({}, ALL_VALID, { overall: 'UNRESOLVED', progression: { status: 'UNRESOLVED', reason: 'missing_value' } });
  const out = runBlock(eq);
  ok(out.includes('DATOS INSUFICIENTES') && out.includes('Progresión de ejercicios') && out.includes('sin datos registrados'),
    'a single UNRESOLVED domain (progression) renders correctly on its own');
}

console.log('');
console.log('T288 — Evidence quality coach visibility: ' + pass + ' assertions PASSED');
