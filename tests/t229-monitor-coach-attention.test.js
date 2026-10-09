'use strict';
/**
 * T229 — Monitor drill-down: COACH ATTENTION card. Combines T226's
 * priority + T227's reason/action from the SAME already-computed signals
 * (attnState, weeklyStatus, prescriptionEffectiveness) -- exceptions-
 * first: renders nothing at all when priority is ON_TRACK, and never
 * repeats the exercise/body-comp detail already shown in the T206/T215/
 * T223 cards.
 *
 * Run: node tests/t229-monitor-coach-attention.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: reuses the real T226/T227 functions and the already-computed
// _wsStatusForAdaptive (T177), no second engine.
// ─────────────────────────────────────────────────────────────────────────────

// T279: this card no longer independently calls _rankClientPriority/
// _computeInterventionReasonAction/_computeClientAttentionState/
// window.VDSEN_OUTCOME -- it sources priority/primaryReason/action/
// supportingReasons from the ONE shared _monitorSnapshot.coachSupervision
// (T276), whose OWN implementation (_computeCoachSupervisionForRequest)
// still calls the exact same real T226/T227 functions verbatim over the
// SAME real currentWeek Generator uses -- closing the Monitor/Generator
// duplication (and the week-divergence bug) T275's audit found.
ok(COACH.includes('const _priority229 = _monitorSnapshot.coachSupervision.priority;'), 'sources priority from the shared snapshot\'s coachSupervision');
ok(COACH.includes('action: _monitorSnapshot.coachSupervision.action,') && COACH.includes('supportingReasons: _monitorSnapshot.coachSupervision.supportingReasons'), 'sources action/supportingReasons from the same shared coachSupervision');
ok(COACH.includes('var attn = window._computeClientAttentionState(entries, planDoc, currentWeek);'), 'the underlying computation (inside _computeCoachSupervisionForRequest) still calls the real _computeClientAttentionState verbatim, unchanged');
ok(COACH.includes('var priority = window._rankClientPriority(attn.state, weeklyStatus, effectivenessOverall);'), 'the underlying computation still calls the real T226 _rankClientPriority verbatim, unchanged');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: exceptions-first -- nothing rendered for ON_TRACK, no giant
// panel, and the block is gated on the active plan being present.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("if (_priority229 !== 'ON_TRACK') {"), 'the whole card is skipped entirely when priority is ON_TRACK -- nothing shown for a client who needs no attention');
ok(!/<table[^>]*>[\s\S]{0,80}Atención del Coach/.test(COACH), 'the Coach Attention card is not rendered as a giant table');
ok(COACH.includes('if (p && _monitorSnapshot && _monitorSnapshot.coachSupervision) {\n      const _priority229'),
  'the whole block is gated on the active plan (p) being present and the shared snapshot having a real coachSupervision (FIXED for T279\'s snapshot routing)');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: shows priority, primary reason, supporting reasons, and
// suggested review action -- the exact shape the ticket asks for.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('<span style="font-weight:700">Motivo:</span> ${_escH(_REASON_LABEL229[_reasonAction229.primaryReason]'), 'shows the primary reason');
ok(COACH.includes('${_reasonAction229.supportingReasons.length ?'), 'shows supporting reasons only when present');
ok(COACH.includes('<span style="font-weight:700">Revisión sugerida:</span> ${_escH(_ACTION_LABEL229[_reasonAction229.action]'), 'shows the suggested review action');

// ─────────────────────────────────────────────────────────────────────────────
// Never edits the plan, never gives medical/treatment advice, and never
// duplicates the exercise-level "Atención" list already shown by T223.
// ─────────────────────────────────────────────────────────────────────────────

const t229CardSrc = COACH.slice(COACH.indexOf('// ── T229 — Monitor drill-down'), COACH.indexOf('// ── Gráfica de tendencia de peso'));
ok(!t229CardSrc.includes('updateDoc') && !t229CardSrc.includes('setDoc'), 'the T229 card never writes to Firestore -- pure decision support');
ok(!t229CardSrc.includes('_outcomeAttentionNames'), 'does not repeat the exercise-name list already shown in the T223 card above it');

console.log('');
console.log('T229 — Monitor Coach Attention drill-down: ' + pass + ' assertions PASSED');
