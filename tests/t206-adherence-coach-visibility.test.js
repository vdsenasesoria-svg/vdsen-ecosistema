'use strict';
/**
 * T206 — Compact, exceptions-first Coach visibility for the adherence layer.
 *
 * Extends the EXISTING T177-179 weekly decision card (no new giant
 * dashboard, no second card) with:
 *   - this week's real executionRate (T202, sessionAdherence), highlighted
 *     when it's the reason confidence is limited (<60%)
 *   - the names of any exercise this week classified LOW/NONE execution
 *     fidelity (T203), reusing lastRec.recommendations' setMetrics --
 *     exceptions-first, only rendered when there IS an exception.
 *
 * No recalculated logic: reuses _wsSessionAdherence (already computed for
 * the classify() call, T202) and _classifyExerciseExecutionFidelity (T203).
 *
 * Run: node tests/t206-adherence-coach-visibility.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: reuses the real T202/T203 functions, no second engine.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('const _wsSessionAdherence = _computeSessionAdherenceSummary(entries, currentWeek);'), 'the weekly card computes sessionAdherence via the real T202 function, not a reimplementation');
ok(COACH.includes('const f = _classifyExerciseExecutionFidelity(r.setMetrics.setCompletionRate); return f === \'LOW\' || f === \'NONE\';'), 'low-fidelity exercises are found via the real T203 classifier, not a new threshold');
ok(COACH.includes('sessionAdherence: _wsSessionAdherence'), 'sessionAdherence is passed into _classifyWeeklyStatus so the ADHERENCE_LIMITED gate (T205c) sees the same data the card displays');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: exceptions-first — the low-fidelity line only renders when
// there IS an exception; no giant new table/dashboard.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('${_wsLowFidelityNames.length ? `<div class="text-xs mt-1" style="color:#FF8844"><span style="font-weight:700">Ejecución baja:</span>'), 'low-fidelity exercises render as a small conditional line inside the SAME weekly card, not a separate dashboard');
ok(!/<table[^>]*>[\s\S]{0,80}Ejecución baja/.test(COACH), 'the execution-fidelity exception is not rendered as a giant table');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: the executionRate badge highlights when it's below the same
// 0.6 threshold the ADHERENCE_LIMITED gate itself uses (T205c) -- visually
// consistent with why the status badge reads ADHERENCE_LIMITED.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("_wsExecRate < 0.6 ? ' style=\"color:#FF8844\"' : ''"), 'the executionRate badge is highlighted using the SAME 0.6 threshold as the ADHERENCE_LIMITED gate, not an independently invented number');
ok(COACH.includes('ejecución real ${Math.round(_wsExecRate*100)}%'), 'the real weekly execution rate is shown as a plain percentage, not a fabricated score');

console.log('');
console.log('T206 — Adherence Coach visibility: ' + pass + ' assertions PASSED');
