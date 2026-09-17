'use strict';
/**
 * T141-H — Product workflow improvement: wire up the unreachable
 * Generate -> Preview -> Activate flow.
 *
 * Friction found: the coach's stated ideal workflow is
 *   cliente -> Plan -> editar -> guardar -> Generar -> Preview -> Activar
 * A full, tested, deployed implementation of exactly this flow already
 * existed in vdsen-coach.html — vdsenAIPreview() posts to the real
 * /api/vdsen-generate serverless endpoint (api/vdsen-generate.js, with its
 * own passing test suite), then _vdsenAIShowPreview() renders a review
 * modal with a review-gate and a deliberate two-step "Guardar borrador
 * aprobado" / "Activar plan" panel (_vdsenSaveDraftClick /
 * _vdsenActivatePlanClick). None of it was reachable: `vdsenAIPreview` had
 * no call site anywhere in the HTML — no button, no onclick, nothing. Every
 * actually-clickable "Generar" button (autoGenBtn -> autoGeneratePlan(),
 * and the in-modal Ficha-tab button -> _autoGenerateForModal()) bypasses
 * review entirely and calls saveImportedPlan() directly, which saves AND
 * activates the plan immediately — a coach had no way to see the AI's
 * output before it went live to the client.
 *
 * Fix (purely additive, zero behavior change to existing buttons): added a
 * second button next to the existing "Generar plan automático" button in
 * the same Plan section, wired to the existing vdsenAIPreview() function
 * and reading the same #planClientSelect dropdown it already expects. No
 * new function, no new endpoint, no architecture change — every piece this
 * button calls already existed, tested, and worked; it just had no door in.
 *
 * Run: node tests/t141h-wire-vdsen-preview-flow.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// The preview button now exists and is wired to the existing function.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /id="vdsenPreviewBtn"[^>]*onclick="vdsenAIPreview\(\)"/.test(COACH),
  'T141-H: a button with id="vdsenPreviewBtn" calling vdsenAIPreview() must exist'
);

assert.ok(
  COACH.includes('id="vdsenPreviewStatus"'),
  'T141-H: the vdsenPreviewStatus status element vdsenAIPreview() writes into must exist'
);

console.log('Preview trigger button and status element now exist — OK');

// ─────────────────────────────────────────────────────────────────────────────
// The button lives in the same Plan section as the existing generate button,
// so it shares #planClientSelect (vdsenAIPreview reads clientId from there).
// ─────────────────────────────────────────────────────────────────────────────

const crearPlanIdx = COACH.indexOf('id="crearPlan"');
const autoGenBtnIdx = COACH.indexOf('id="autoGenBtn"');
const previewBtnIdx = COACH.indexOf('id="vdsenPreviewBtn"');
assert.ok(crearPlanIdx !== -1 && autoGenBtnIdx !== -1 && previewBtnIdx !== -1,
  'T141-H prerequisite: crearPlan section, autoGenBtn and vdsenPreviewBtn must all exist');
assert.ok(
  crearPlanIdx < autoGenBtnIdx && autoGenBtnIdx < previewBtnIdx && previewBtnIdx - crearPlanIdx < 3000,
  'T141-H: vdsenPreviewBtn must live in the same Plan section as autoGenBtn, close enough to ' +
  'share the same #planClientSelect dropdown'
);

console.log('Preview button placed in the same Plan section as the existing generate button — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guard: the existing instant-generate button and its behavior
// are completely untouched — this is a purely additive change.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /id="autoGenBtn" onclick="autoGeneratePlan\(\)"/.test(COACH),
  'T141-H regression: autoGenBtn must still call autoGeneratePlan() unchanged'
);
assert.ok(
  COACH.includes('async function autoGeneratePlan()'),
  'T141-H regression: autoGeneratePlan must still exist unchanged'
);
assert.ok(
  COACH.includes('async function vdsenAIPreview()') && COACH.includes('window.vdsenAIPreview = vdsenAIPreview'),
  'T141-H regression: vdsenAIPreview function and its window export must be unchanged'
);

console.log('Existing autoGenBtn / autoGeneratePlan untouched — OK (purely additive change)');

console.log('');
console.log('T141-H — wire up Generate -> Preview -> Activate flow: ALL ASSERTIONS PASSED');
