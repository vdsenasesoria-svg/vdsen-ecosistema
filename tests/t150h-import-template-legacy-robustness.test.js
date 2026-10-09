'use strict';
/**
 * T150 — Import/template legacy robustness.
 *
 * Scope: parse/import plan, saveImportedPlan, template apply/save, legacy
 * normalization, exercise IDs/notes/nutrition fields.
 *
 * Bug 1 (identity loss): parsePlanFromJSON's per-exercise normEx object was
 * built explicitly field-by-field and never copied ex.prescriptionExerciseId
 * from the input JSON. _stampPrescriptionIds (called downstream by
 * saveImportedPlan) preserves an existing ID and only mints a new one when
 * missing — but since normEx never carried the field through, EVERY
 * JSON-paste import got entirely fresh IDs, even when re-importing a
 * previously-exported plan doc that already had stable IDs. This silently
 * severed progression-history continuity (client-side _getPrevWeekData/
 * _getExposures match by prescriptionExerciseId) for exercises the coach
 * didn't actually intend to change identity for.
 *
 * Bug 2 (silent-accept of malformed data): _applyTemplateToClient mapped
 * template.days[].exercises through _parseTemplateExercise (for legacy
 * string-format entries) with no filter afterward. parsePlanFromJSON already
 * filters out exercises with an empty name or no sets — _applyTemplateToClient
 * did not, so a malformed custom-template string (empty line, unparsable
 * format) produced a silently-accepted exercise with an empty name in the
 * saved plan instead of being dropped.
 *
 * Fixes:
 *   1. normEx now copies prescriptionExerciseId from the input exercise when
 *      present (conditionally, so absent stays absent — _stampPrescriptionIds
 *      still mints one when there is none, unchanged for brand-new imports).
 *   2. _applyTemplateToClient now filters exercises with no name/no sets,
 *      and drops days left with zero exercises — same bar parsePlanFromJSON
 *      already applies.
 *
 * Run: node tests/t150h-import-template-legacy-robustness.test.js
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
// Bug 1 fix — parsePlanFromJSON preserves an existing prescriptionExerciseId.
// ─────────────────────────────────────────────────────────────────────────────

const parsePlanFn = extractFunction(COACH, 'function parsePlanFromJSON()');
assert.ok(parsePlanFn, 'parsePlanFromJSON must exist');

assert.ok(
  /\.\.\.\(ex\.prescriptionExerciseId \? \{ prescriptionExerciseId: String\(ex\.prescriptionExerciseId\) \} : \{\}\)/.test(parsePlanFn),
  'T150-H Bug1: parsePlanFromJSON must conditionally copy ex.prescriptionExerciseId into normEx when present'
);

// Regression: coachNote/techniqueNote/supersetGroup preservation (QA-GAP-01
// fix from an earlier round) must remain intact alongside this new field.
assert.ok(
  /coachNote: String\(ex\.coachNote \|\| ''\)\.trim\(\)/.test(parsePlanFn),
  'T150-H regression: coachNote preservation (prior fix) must remain unchanged'
);

console.log('parsePlanFromJSON preserves a pre-existing prescriptionExerciseId — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2 fix — _applyTemplateToClient filters malformed exercises/empty days.
// ─────────────────────────────────────────────────────────────────────────────

const applyTemplateFn = extractFunction(COACH, 'async function _applyTemplateToClient(template, clientId, closeModal)');
assert.ok(applyTemplateFn, '_applyTemplateToClient must exist');

assert.ok(
  /\.filter\(function\(e\) \{ return e && e\.exerciseName && e\.exerciseName\.trim\(\)\.length > 1 && Array\.isArray\(e\.sets\) && e\.sets\.length > 0; \}\)/.test(applyTemplateFn),
  'T150-H Bug2: _applyTemplateToClient must filter out exercises with no name or no sets'
);
assert.ok(
  /\}\)\.filter\(function\(d\) \{ return d\.exercises\.length > 0; \}\);/.test(applyTemplateFn),
  'T150-H Bug2: _applyTemplateToClient must drop days left with zero exercises after filtering'
);

console.log('_applyTemplateToClient filters malformed exercises and empty days — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — _restampPrescriptionIds (new IDs for templates, no
// identity inheritance — a DIFFERENT, intentional contract from
// parsePlanFromJSON) and the existing backup/error-handling remain intact.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  applyTemplateFn.includes('days = _restampPrescriptionIds(days);'),
  'T150-H regression: _applyTemplateToClient must still use _restampPrescriptionIds (templates never inherit identity)'
);
assert.ok(
  applyTemplateFn.includes('await backupPlanIfExists(clientId);'),
  'T150-H regression: the T138-H outgoing-plan backup must remain'
);
assert.ok(
  /catch\(e\) \{[\s\S]*?showToast\('Error al aplicar plantilla/.test(applyTemplateFn),
  'T150-H regression: template-apply error handling must remain (no silent Firestore failure)'
);

const stampFn = extractFunction(COACH, 'function _stampPrescriptionIds(days)');
assert.ok(stampFn, '_stampPrescriptionIds must exist');
assert.ok(
  /if \(id && !seen\[id\]\) \{ seen\[id\] = true; return ex; \}/.test(stampFn),
  'T150-H regression: _stampPrescriptionIds must still preserve an existing, non-duplicate ID unchanged'
);

console.log('_restampPrescriptionIds contract, backup, and error handling all unchanged — OK');

console.log('');
console.log('T150 — Import/template legacy robustness: ALL ASSERTIONS PASSED');
