'use strict';
/**
 * T142-H — Preview flow clarity: instant-activate vs. preview button must be
 * unambiguous at a glance, not just in a caption sentence a coach may skim.
 *
 * Friction found (introduced by T141-H's own new button): "🤖 Generar plan
 * automático" (btn-primary, visually prominent) and "🔬 Generar con VDSEN AI
 * — Preview" (btn-secondary) sit side by side, both labeled "Generar ...
 * VDSEN". The only place that explained the instant-activate button silently
 * saves AND activates the plan (with NO confirmation dialog at all for a
 * client's first plan — saveImportedPlan only confirms when replacing an
 * existing activePlanId) was a small muted caption sentence below the
 * button row — easy to skim past under real work pressure. This is exactly
 * the "acción primaria no clara" / "activación accidental" friction: a coach
 * could click the visually prominent instant button expecting the safer
 * preview behavior.
 *
 * Fix: a small glanceable inline badge next to EACH button — a red "⚡ ACTIVA
 * AL INSTANTE — sin preview" badge next to the instant button, and a green
 * "✓ RECOMENDADO — revisas antes de activar" badge next to the preview
 * button. Purely additive markup; no id/onclick/logic changed on either
 * button, no change to autoGeneratePlan/vdsenAIPreview/saveImportedPlan.
 *
 * Run: node tests/t142h-preview-flow-clarity.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Both buttons now carry a glanceable badge distinguishing their behavior.
// ─────────────────────────────────────────────────────────────────────────────

const autoGenIdx    = COACH.indexOf('id="autoGenBtn"');
const instantBadgeIdx = COACH.indexOf('id="autoGenInstantBadge"');
const previewBtnIdx  = COACH.indexOf('id="vdsenPreviewBtn"');
const recBadgeIdx    = COACH.indexOf('id="vdsenPreviewRecommendedBadge"');

assert.ok(autoGenIdx !== -1 && instantBadgeIdx !== -1 && previewBtnIdx !== -1 && recBadgeIdx !== -1,
  'T142-H prerequisite: both buttons and both new badges must exist');

assert.ok(
  autoGenIdx < instantBadgeIdx && instantBadgeIdx < previewBtnIdx,
  'T142-H: the instant-activate badge must sit right after autoGenBtn, before the preview button'
);
assert.ok(
  previewBtnIdx < recBadgeIdx,
  'T142-H: the recommended badge must sit right after vdsenPreviewBtn'
);

// Badge text must be unambiguous without relying on the caption below.
assert.ok(
  /ACTIVA AL INSTANTE/.test(COACH.slice(instantBadgeIdx, instantBadgeIdx + 400)),
  'T142-H: the instant-activate badge text must clearly say it activates immediately'
);
assert.ok(
  /RECOMENDADO/.test(COACH.slice(recBadgeIdx, recBadgeIdx + 400)),
  'T142-H: the preview button badge must mark it as the recommended default'
);

console.log('Both generate buttons now carry a glanceable behavior badge — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — this is a label-only change: no button id/onclick moved,
// no logic function touched, Preview still does not auto-activate anything.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /id="autoGenBtn" onclick="autoGeneratePlan\(\)"/.test(COACH),
  'T142-H regression: autoGenBtn onclick unchanged'
);
assert.ok(
  /id="vdsenPreviewBtn" onclick="vdsenAIPreview\(\)"/.test(COACH),
  'T142-H regression: vdsenPreviewBtn onclick unchanged'
);
assert.ok(
  COACH.includes('async function autoGeneratePlan()') &&
  COACH.includes('async function vdsenAIPreview()') &&
  COACH.includes('async function saveImportedPlan(clientIdArg)'),
  'T142-H regression: autoGeneratePlan/vdsenAIPreview/saveImportedPlan all still exist unmodified in signature'
);

// Preview flow still: no auto-activation. _vdsenAIShowPreview only ever shows
// the modal with the draft badge; activation requires the separate D.2 click.
const showPreviewFnIdx = COACH.indexOf('function _vdsenAIShowPreview(resp, req, clientId)');
assert.ok(showPreviewFnIdx !== -1, 'T142-H prerequisite: _vdsenAIShowPreview must exist');
assert.ok(
  COACH.includes("BORRADOR — NO APLICADO"),
  'T142-H regression: preview modal must still show the "not applied yet" draft badge on open'
);
assert.ok(
  COACH.includes('window._vdsenSaveDraftClick') && COACH.includes('window._vdsenActivatePlanClick'),
  'T142-H regression: Guardar borrador and Activar plan remain two distinct, separate actions'
);
// Activate button must still be hidden until a draft has been explicitly saved.
const d2PanelHtmlIdx = COACH.indexOf('id="vdsenPreview_activateBtn"');
assert.ok(d2PanelHtmlIdx !== -1, 'T142-H prerequisite: vdsenPreview_activateBtn must exist');
assert.ok(
  /id="vdsenPreview_activateBtn"[\s\S]{0,80}style="display:none;/.test(COACH),
  'T142-H regression: the Activar plan button must still be hidden by default until a draft is saved'
);

console.log('Preview/Guardar borrador/Activar plan remain unchanged and non-auto-activating — OK');

console.log('');
console.log('T142-H — preview flow clarity: ALL ASSERTIONS PASSED');
