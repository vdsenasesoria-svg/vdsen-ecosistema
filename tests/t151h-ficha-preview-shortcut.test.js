'use strict';
/**
 * T151 — Coach prescription workflow efficiency.
 *
 * Scope: UI/handlers of cliente -> Plan -> editar -> guardar -> generar ->
 * preview -> activar.
 *
 * Friction found: the client-detail modal's Ficha tab has its own instant-
 * generate button (_autoGenerateForModal, "GENERAR PLAN COMPLETO"), fully
 * self-contained within the modal. The safer Preview flow (vdsenPreviewBtn,
 * wired in T141-H) only exists in the standalone "Plan" section
 * (#crearPlan), with its own separate #planClientSelect dropdown. A coach
 * reviewing a client's ficha who wanted the reviewed path instead of instant
 * activation had to: close the client modal, manually navigate to the Plan
 * section, and re-select the same client from scratch in a different
 * dropdown — repeated manual action and lost context for what should be a
 * one-click alternative sitting right next to the button they were already
 * looking at.
 *
 * Fix: added a small "Generar con Preview" button directly below the
 * existing instant-generate button in the Ficha tab, wired to a new
 * _previewFromFicha(clientId) helper that: closes the client modal
 * (respecting the existing dirty-editor confirm gate via closeClientModal,
 * so unsaved plan edits are never silently discarded), navigates to the
 * Plan section, pre-selects the client in #planClientSelect, and calls the
 * existing, unmodified vdsenAIPreview(). No new generation logic, no new
 * endpoint, no change to autoGeneratePlan/_autoGenerateForModal/
 * vdsenAIPreview themselves — purely a navigation shortcut reusing existing
 * pieces.
 *
 * Run: node tests/t151h-ficha-preview-shortcut.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

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

// ─────────────────────────────────────────────────────────────────────────────
// Fix: the new button and helper exist, wired correctly.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /onclick="_previewFromFicha\('\$\{clientId\}'\)"/.test(COACH),
  'T151-H: a button calling _previewFromFicha(clientId) must exist in the Ficha tab'
);

const fichaGenBtnIdx    = COACH.indexOf('id="_fichaGenBtn_${clientId}"');
const previewShortcutIdx = COACH.indexOf("onclick=\"_previewFromFicha('${clientId}')\"");
// T173 — Preview is now the primary/first CTA in this modal too (product
// decision: progression-first canonical path leads); the instant-generate
// button now appears right after it, not before.
assert.ok(fichaGenBtnIdx !== -1 && previewShortcutIdx !== -1 && previewShortcutIdx < fichaGenBtnIdx,
  'T151-H/T173: the instant-generate button must appear right after the Preview shortcut button in the Ficha tab');

const previewFromFichaFn = extractFunction(COACH, 'window._previewFromFicha = async function(clientId)');
assert.ok(previewFromFichaFn, '_previewFromFicha must exist');

assert.ok(
  previewFromFichaFn.includes('await closeClientModal();'),
  'T151-H: _previewFromFicha must close the client modal via closeClientModal() (respects the dirty-editor guard)'
);
assert.ok(
  /if \(modalEl && modalEl\.style\.display !== 'none'\) return;/.test(previewFromFichaFn),
  'T151-H: _previewFromFicha must abort if the modal did not actually close (coach declined to discard unsaved changes)'
);
assert.ok(
  previewFromFichaFn.includes("showSection('crearPlan');"),
  'T151-H: _previewFromFicha must navigate to the standalone Plan section'
);
assert.ok(
  /sel\.value = clientId;/.test(previewFromFichaFn),
  'T151-H: _previewFromFicha must pre-select the client in #planClientSelect'
);
assert.ok(
  previewFromFichaFn.trim().endsWith('vdsenAIPreview();\n  };') || /vdsenAIPreview\(\);\s*\};?\s*$/.test(previewFromFichaFn),
  'T151-H: _previewFromFicha must call vdsenAIPreview() as its final step, after modal-close/navigate/pre-select'
);

console.log('_previewFromFicha shortcut exists, wired correctly, respects the dirty-editor guard — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — no changes to the generation functions themselves, the
// existing instant-generate button, or vdsenAIPreview's own behavior.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /id="_fichaGenBtn_\$\{clientId\}" onclick="_autoGenerateForModal\('\$\{clientId\}'\)"/.test(COACH),
  'T151-H regression: the existing instant-generate button must be unchanged'
);
assert.ok(
  COACH.includes('async function _autoGenerateForModal(clientId)') &&
  COACH.includes('async function vdsenAIPreview()') &&
  COACH.includes('async function closeClientModal()'),
  'T151-H regression: _autoGenerateForModal, vdsenAIPreview, and closeClientModal must all still exist unmodified in signature'
);

console.log('Existing instant-generate button and underlying functions unchanged — OK');

console.log('');
console.log('T151 — Coach prescription workflow efficiency: ALL ASSERTIONS PASSED');
