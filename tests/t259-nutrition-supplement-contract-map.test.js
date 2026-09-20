'use strict';
/**
 * T259 — Nutrition/supplement contract map (audit-only; grep-first).
 *
 *   FIELD               WRITER                          READER                    ACTIVE SOURCE OF TRUTH        ABSENT SEMANTICS (current, BUGGY)   EMPTY SEMANTICS   BACKUP BEHAVIOR              CLIENT BEHAVIOR
 *   ------------------  -------------------------------  ------------------------  -----------------------------  -----------------------------------  ----------------  ---------------------------  ------------------------------
 *   plans/{id}          _vdsenSaveDraftToFirestore        _vdsenActivatePlanInFirestore  plans/{activePlanId} is    ALWAYS writes a zeroed display object  same as absent    backupPlanIfExists copies    N/A -- client never reads plans/*
 *   .nutritionDisplay/   (AI-Generator preview -> draft)   (mirrors onto clients/{uid})  the source of truth,        ({calorias:0,...}) even when the      (both collapse   the OUTGOING plan doc        directly for nutrition
 *   .nutritionRaw/                                                                       clients/{uid} fields are   Generator response had NO nutricion   to a zeroed      wholesale (unaffected by
 *   .supplementDisplay/                                                                  compatibility MIRRORS      key at all -- collapses "not          object)          this bug -- see below)
 *   .supplementsRaw                                                                      only                       provided" into "explicitly empty"
 *
 *   clients/{uid}       _vdsenActivatePlanInFirestore     vdsen-cliente.html's        clients/{uid} (this is what   Same bug, one level down:            same as absent   N/A (this IS the doc        loadPlan() reads
 *   .nutritionPlan/      (mirrors FROM plans/{id},         loadPlan()                  the Client app actually       planData.nutritionRaw || {} means     collapse         backupPlanIfExists reads    clients/{uid} directly --
 *   .nutritionRaw/        UNCONDITIONALLY, || {} fallback)                             reads)                        an absent plan-doc field silently                       FROM, to preserve the      whatever is here IS what
 *   .supplementPlan/                                                                                                 OVERWRITES a previously valid                           outgoing state)             renders
 *   .supplementsRaw
 *
 *   clients/{uid}       loadPlanFromPastedAnalysis (10155),  N/A (write-only paths)  clients/{uid}, written        `if (nutrition) {...}` -- a         genuinely       N/A (these paths don't      N/A
 *   (import paths,       auto-generate-import (8814/13526),                          DIRECTLY, bypassing the       CORRECT, already-conditional        distinguishable  go through
 *   ALREADY CORRECT)     compendio-classify (15880/15883)                            plans/{id} mirror entirely    write -- absence is already          from absent      _vdsenActivatePlanInFirestore
 *                                                                                                                   correctly preserved here             here either      at all for nutrition/suppl
 *
 * KEY FINDING (the ONLY real bug, isolated to ONE pipeline): the AI-
 * Generator Preview -> Draft -> Activate path collapses "Generator
 * response had no nutricion/suplementacion key" into "write an explicit
 * zeroed/empty object", at BOTH the draft-save step (unconditional
 * nutritionDisplay/nutritionRaw write) AND the activation step
 * (unconditional `|| {}` mirror). Every OTHER write path already uses the
 * correct `if (present) {...}` conditional-inclusion pattern and is NOT
 * a bug. This is a single, coherent 2-function fix (T261), not a
 * systemic rewrite.
 *
 * Run: node tests/t259-nutrition-supplement-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// The buggy pipeline, confirmed present at baseline (T259 documents the
// CURRENT state before T261's fix -- this test intentionally captures the
// bug pattern so T261's fix has a concrete before/after to diff against).
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("const nutr     = plan.nutricion     || {};") && COACH.includes("const suppl    = plan.suplementacion || {};"),
  'confirmed: _vdsenSaveDraftToFirestore collapses an ABSENT nutricion/suplementacion key into an empty object at parse time, losing the presence signal before the draftDoc is even built');
ok(COACH.includes('nutritionRaw:    nutr,') && COACH.includes('supplementsRaw:    suppl,'),
  'confirmed: the draft plan doc always gets nutritionRaw/supplementsRaw fields (never genuinely absent), even for a training-only generation');
ok(COACH.includes('nutritionPlan:  planData.nutritionDisplay || {},') && COACH.includes('supplementPlan: planData.supplementDisplay || {},'),
  'confirmed: activation unconditionally mirrors plan-doc nutrition/supplement fields onto clients/{uid} with an || {} fallback -- an absent OR zeroed plan-doc field both silently overwrite the client\'s existing valid data');

// ─────────────────────────────────────────────────────────────────────────────
// The already-correct import paths (confirmed NOT buggy -- must not be
// "fixed" a second time or given a different policy).
// ─────────────────────────────────────────────────────────────────────────────

ok((COACH.match(/if \(nutrition\) \{ (?:clientUpdates|upd)\.nutritionPlan = _nutritionJsonToPlan\(nutrition\); (?:clientUpdates|upd)\.nutritionRaw = nutrition; saved\.push\('nutrición'\); \}/g) || []).length === 3,
  'confirmed: exactly 3 import-path call sites already use the correct conditional `if (nutrition) {...}` pattern -- these are the reference/model for T261\'s fix, not additional bugs');
ok(COACH.includes("'nutritionRaw.comidas':   deleteField(),"), 'confirmed an existing precedent for explicit field removal already exists (deleteField()) elsewhere in the codebase -- T260/T261 can reuse this idiom, no new mechanism needed');

console.log('');
console.log('T259 — Nutrition/supplement contract map: ' + pass + ' assertions PASSED');
