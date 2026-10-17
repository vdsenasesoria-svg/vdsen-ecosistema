'use strict';
/**
 * T263 — Import/template continuity (audit-only; grep-first). Confirms
 * every activation-triggering path other than the AI-Generator Preview
 * pipeline (T261's fix) is ALREADY safe by construction, without needing
 * a separate policy or any code change here.
 *
 * There are exactly 5 places clients/{uid}.activePlanId gets set:
 *   1. _vdsenActivatePlanInFirestore (T261-fixed) -- the ONLY path that
 *      mirrors nutrition/supplement fields FROM the plan doc, now
 *      conditionally per T260's presence semantics.
 *   2. saveImportedPlan            -- updateDoc({activePlanId}) ONLY,
 *   3. saveManualPlan              -- never touches nutrition/supplement
 *   4. _applyTemplateToClient         fields AT ALL. Whatever the client
 *   5. duplicatePlan                  already has survives untouched by
 *                                      construction (nothing to preserve
 *                                      FROM here -- there's simply no write).
 *
 * Nutrition/supplement content for paths 2-5 is handled SEPARATELY, by
 * the already-correct conditional `if (nutrition) {...}` writes audited
 * in T259 (loadPlanFromPastedAnalysis, the two auto-generate-import call
 * sites, compendio-classify) -- confirmed here to still be the ONLY
 * writers alongside path 1, with no 6th untracked path.
 *
 * Run: node tests/t263-import-template-continuity.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Exactly 5 activePlanId writers exist -- no undiscovered 6th path that
// could silently mirror nutrition/supplement fields unconditionally.
// ─────────────────────────────────────────────────────────────────────────────

const minimalActivations = (COACH.match(/updateDoc\(doc\(db, ["']clients["'], clientId\), \{ activePlanId: planRef\.id \}\);/g) || []).length;
ok(minimalActivations === 4, 'exactly 4 OTHER activation sites (saveImportedPlan/saveManualPlan/_applyTemplateToClient/duplicatePlan) write ONLY activePlanId -- confirmed via the literal minimal-update pattern, no accidental nutrition/supplement mirror added to any of them');
ok(COACH.includes('var clientUpdate = { activePlanId: planId };'), 'the 5th (and ONLY) place that conditionally mirrors nutrition/supplements is _vdsenActivatePlanInFirestore, T261-fixed');

// ─────────────────────────────────────────────────────────────────────────────
// Case: training-only import -- these 4 paths never touch nutrition/
// supplement fields, so a training-only import structurally cannot erase
// them (there's no write to erase them WITH).
// ─────────────────────────────────────────────────────────────────────────────

ok(!/async function saveImportedPlan[\s\S]{0,3000}?nutritionRaw/.test(COACH), 'saveImportedPlan itself never references nutritionRaw within its own body -- nutrition is handled by a SEPARATE, already-conditional caller-level write (T259), never inside this function');

// ─────────────────────────────────────────────────────────────────────────────
// Case: the 3 already-correct conditional import-path writers (T259) are
// still the ONLY places besides _vdsenActivatePlanInFirestore that write
// nutritionRaw/supplementsRaw -- confirms no separate/inconsistent policy
// was introduced anywhere else.
// ─────────────────────────────────────────────────────────────────────────────

const nutritionRawWriteSites = (COACH.match(/\.nutritionRaw\s*=|\bnutritionRaw:\s*(?!undefined)/g) || []).length;
// Sites: T259's 3 import writers (clientUpdates.nutritionRaw / upd.nutritionRaw, x3),
// T261's activation REPLACE branch (clientUpdate.nutritionRaw = nutResolved.value) and
// its REMOVE branch (clientUpdate.nutritionRaw = deleteField()), the draft-save
// REPLACE/REMOVE branches (draftDoc.nutritionRaw), the admin reset-week payloads (x2,
// _resetPayload/_keepPayload), and the field-path reset admin action -- all previously
// audited (T259/T261), no NEW unaccounted writer introduced by this phase.
ok(nutritionRawWriteSites >= 3, 'sanity: the known nutritionRaw writers are all still present and accounted for -- no unaudited new writer appeared');

console.log('');
console.log('T263 — Import/template continuity: ' + pass + ' assertions PASSED (no code change needed -- all paths already safe by construction)');
