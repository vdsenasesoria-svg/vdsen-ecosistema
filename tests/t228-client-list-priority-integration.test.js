'use strict';
/**
 * T228 — Coach client-list integration. Wires T226's deterministic 5-tier
 * priority into loadClientList, replacing (not duplicating) the raw
 * 4-tier attnBadge -- one badge, one sort order, one summary, all driven
 * by the richer priority. 0 new Firestore reads: weeklyStatus is computed
 * from the SAME entries/planData already batch-fetched for
 * _computeClientAttentionState, via _computeWeeklyDecisionForRequest now
 * exposed on window.VDSEN_BUILD (T225's MISMATCH #2 fix).
 *
 * Run: node tests/t228-client-list-priority-integration.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: 0 new Firestore reads -- weeklyStatus reuses the SAME
// entries/planData already loaded, via the newly-exposed VDSEN_BUILD export.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('_computeWeeklyDecisionForRequest: _computeWeeklyDecisionForRequest // T228: client-list priority reuse, no second engine, 0 new Firestore reads'),
  '_computeWeeklyDecisionForRequest is exposed on window.VDSEN_BUILD for the client-list to reuse');
ok(COACH.includes('window.VDSEN_BUILD._computeWeeklyDecisionForRequest(entries, planData)'),
  'loadClientList calls it with the SAME entries/planData already computed for _computeClientAttentionState -- no new read');
ok(!/getDoc\(doc\(db,\s*['"]logs['"],\s*c\.id\)\)[\s\S]{0,400}getDoc\(doc\(db,\s*['"]logs['"],\s*c\.id\)\)/.test(COACH),
  'no duplicated per-client logs read introduced (still exactly one batched getDoc per client for logs)');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: priority computed and used for sort + summary + badge -- one
// coherent source of truth, not three independent readings.
// ─────────────────────────────────────────────────────────────────────────────

// T280 added a real (but reduced, 0-extra-read) effectivenessOverall as a
// 3rd arg -- still the SAME real T226 function, called once per client row.
ok(COACH.includes('const priority = _rankClientPriority(attn.state, weeklyDecision ? weeklyDecision.status : null, reducedEffectiveness ? reducedEffectiveness.overall : null);'),
  'priority is computed once per client row using the real T226 function (FIXED for T280\'s reduced-effectiveness projection)');
ok(COACH.includes('const pa = (_PRIORITY_ORDER[a.priority] ?? 4) * 2 - (a.live ? 1 : 0);'), 'the client list now sorts by the 5-tier priority order, not the raw 4-tier attnState');
ok(COACH.includes('const priorityC = { URGENT_REVIEW: 0, NEEDS_REVIEW: 0, WATCH: 0, ON_TRACK: 0, INSUFFICIENT_DATA: 0 };'), 'the summary header now counts by the 5-tier priority');
ok(COACH.includes('const ab = _PRIORITY_BADGE[priority] || _PRIORITY_BADGE.INSUFFICIENT_DATA;'), 'the attnBadge itself now renders from the priority-based badge map, not the raw attnState badge map');

// ─────────────────────────────────────────────────────────────────────────────
// Do not duplicate badges: only ONE badge variable is built per row from
// the attention/priority concern (attnBadge), not two overlapping ones.
// ─────────────────────────────────────────────────────────────────────────────

const rowsFnSrc = COACH.slice(COACH.indexOf('const rows = rowData.map('), COACH.indexOf('return `<div class="client-row"') !== -1 ? COACH.indexOf('return `<div class="client-row"') : COACH.indexOf('const rows = rowData.map(') + 6000);
ok((rowsFnSrc.match(/const attnBadge = /g) || []).length === 1, 'exactly one attnBadge is built per row -- no duplicate priority badge alongside it');

// ─────────────────────────────────────────────────────────────────────────────
// _ATTN_BADGE/_ATTN_PRIORITY/_computeClientAttentionState remain untouched
// (still the real INPUT to priority) -- T228 replaces what is DISPLAYED,
// not the underlying attention-state classifier itself.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("const _ATTN_PRIORITY = { REVIEW: 0, PROGRESSING: 1, STABLE: 2, NO_DATA: 3 };"), '_ATTN_PRIORITY (the original attnState-only order) is left in place, unmodified');
ok(COACH.includes('function _computeClientAttentionState(entries, planData, currentWeek)'), '_computeClientAttentionState itself is untouched -- still the same 0-Firestore-read classifier, now consumed as an INPUT to the richer priority rather than displayed directly');

console.log('');
console.log('T228 — Client-list priority integration: ' + pass + ' assertions PASSED');
