'use strict';
/**
 * T215 — Coach visibility for the T210-213 longitudinal learned-state
 * layer. One compact card in _renderClientTabMonitor: reuses
 * window.VDSEN_LEARNED and the SAME progressionHistory already built for
 * the T198 mesocycle card -- no recalculated logic, no plan mutation.
 * NONE-confidence items are never shown; item lists collapse into a
 * <details> beyond a few entries, matching the mesocycle card's own
 * preserved-exercises pattern (no giant dashboard).
 *
 * Run: node tests/t215-learned-state-coach-visibility.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: reuses the real T210-213 functions, no second engine.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('const _learnedProgHist = window.VDSEN_BUILD._mapExerciseProgressionHistory(_learnedProgrecs);'), 'reuses the real progressionHistory mapper (T160/166), not a reimplementation');
ok(COACH.includes('const _learnedVolTolerance = window.VDSEN_LEARNED.computeVolumeTolerance(p, _learnedProgHist, []);'), 'calls the real T211 volume tolerance function');
ok(COACH.includes('const _learnedExTolerance  = window.VDSEN_LEARNED.computeExerciseTolerance(p, _learnedProgHist);'), 'calls the real T212 exercise tolerance function');
ok(COACH.includes('const _learnedRecovery     = window.VDSEN_LEARNED.computeRecoverySensitivity(entries, p, _learnedProgHist);'), 'calls the real T213 recovery sensitivity function');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: NONE-confidence items are filtered out at every level.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes(".filter(m => _learnedVolTolerance[m].confidence !== 'none')"), 'muscle tolerance lines exclude confidence:none entries');
ok(COACH.includes(".filter(pid => _learnedExTolerance[pid].confidence !== 'none')"), 'exercise tolerance lines exclude confidence:none entries');
ok(COACH.includes("_learnedRecovery.confidence !== 'none'"), 'the recovery line is hidden entirely when confidence is none');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: compact -- collapses beyond a few items, not a giant table,
// and renders nothing at all when there is nothing useful to say.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('const _learnedHasAnything = _learnedMuscleLines.length || _learnedExLines.length || _learnedRecoveryLine;') && COACH.includes('if (_learnedHasAnything) {'),
  'the whole card is skipped when nothing has real confidence -- never an empty "Estado aprendido" shell');
ok(COACH.includes("Ver ${_learnedMuscleLines.length - 3} músculo(s) más") && COACH.includes("Ver ${_learnedExLines.length - 3} ejercicio(s) más"),
  'muscle and exercise lists collapse into <details> beyond 3 visible items each, not one giant list');
ok(!/<table[^>]*>[\s\S]{0,80}Estado aprendido/.test(COACH), 'the learned-state card is not rendered as a giant table');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: exercise names looked up from the real active plan's PIDs,
// never invented; the card is gated on the active plan being present.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('if (ex.prescriptionExerciseId) _learnedPidNames[ex.prescriptionExerciseId] = ex.exerciseName || ex.prescriptionExerciseId;'), "exercise names come from the plan's real PIDs, never fabricated");
ok(COACH.includes("if (p && typeof window.VDSEN_LEARNED !== 'undefined' && typeof window.VDSEN_BUILD !== 'undefined') {"), 'the whole block is gated on the active plan (p) being present, mirroring the T198/T200 guard');

console.log('');
console.log('T215 — Learned-state Coach visibility: ' + pass + ' assertions PASSED');
