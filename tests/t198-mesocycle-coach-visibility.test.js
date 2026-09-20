'use strict';
/**
 * T198 — Coach visibility for the mesocycle transition decision.
 *
 * One compact, exceptions-first card in _renderClientTabMonitor: shows the
 * action badge, names of exercises needing REVIEW prominently, and
 * preserved (MANTENER) exercises collapsed into a <details> — same pattern
 * already established by T163/T179/T189. Reuses window.VDSEN_MESOCYCLE.decide
 * (T193-197) and window.VDSEN_BUILD._mapExerciseProgressionHistory
 * (T160/166) entirely — no recalculated logic, no plan mutation.
 *
 * Run: node tests/t198-mesocycle-coach-visibility.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: calls the real T193-197 decision function, no recomputation.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('const _mesoDecision = window.VDSEN_MESOCYCLE.decide({'), '_renderClientTabMonitor calls the real window.VDSEN_MESOCYCLE.decide (T193-197), no second engine');
ok(COACH.includes('const _mesoProgHist = window.VDSEN_BUILD._mapExerciseProgressionHistory(_mesoProgrecs);'), 'reuses the real progressionHistory mapper (T160/166), not a reimplementation');
ok(COACH.includes("isCheckpointWeek: currentWeek >= _mesoTotalWeeks"), 'week count is passed through as isCheckpointWeek (a tie-break input), not used to derive the verdict directly here');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: exceptions-first — REVIEW exercises shown prominently, PRESERVE
// (MANTENER) ones collapsed, matching the established pattern.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("REVISAR:</span> ${_mesoReviewNames.map(n => _escH(n)).join(', ')}"), 'exercises needing review are named prominently in the card');
ok(COACH.includes('<details class="mt-1"><summary class="text-xs text-[#666] cursor-pointer">Ver') && COACH.includes('ejercicio${_mesoPreserveNames.length !== 1'), 'preserved (MANTENER) exercises collapse into a <details> summary, visually secondary');
ok(!/<table[^>]*>[\s\S]{0,80}Decisión de mesociclo/.test(COACH), 'the mesocycle decision block is not rendered as a giant table — one compact card');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: only real PIDs from the active plan are named (no fabricated
// exercise names) — pid -> name lookup sourced from the plan itself.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('if (ex.prescriptionExerciseId) _mesoPidNames[ex.prescriptionExerciseId] = ex.exerciseName || ex.prescriptionExerciseId;'), 'exercise names are looked up from the real active plan\'s PIDs, never invented');

console.log('');
console.log('T198 — Mesocycle Coach visibility: ' + pass + ' assertions PASSED');
