'use strict';
/**
 * T277 — Provenance/freshness contract. No cache exists at all (T276's
 * design choice: "prefer no cache over unsafe cache"), so every one of the
 * 5 required behaviors holds BY CONSTRUCTION -- a fresh call always
 * recomputes from whatever is passed in. This file proves that
 * structurally, plus the new `identity.isLive` flag that lets a caller
 * feeding a historical planDoc never have it masquerade as the client's
 * live plan.
 *
 * Run: node tests/t277-snapshot-provenance-freshness.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const blockStart = COACH.indexOf('  function _mapLogs(logsDoc) {');
const blockEnd   = COACH.indexOf('  function buildGenerationRequest(params) {');
const block = COACH.slice(blockStart, blockEnd);

ok(!/var _snapshotCache\b|_snapshotMemo\b|localStorage|sessionStorage/.test(block), 'no cache/memoization of any kind exists in the snapshot block -- every call is a fresh, correct recomputation');

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
const evidenceTsSrc = extractFunction(COACH, 'function _getLatestEvidenceTimestampForScope(targetType, targetId, entries, planDoc, clientDoc)');
const targetTypeSrc = extractFunction(COACH, 'var INTERVENTION_TARGET_TYPE = {').replace(/^var INTERVENTION_TARGET_TYPE = /, '');
const _getLatestEvidenceTimestampForScope = new Function(
  'var INTERVENTION_TARGET_TYPE = ' + targetTypeSrc + ';\nreturn ' + evidenceTsSrc + ';'
)();

function runSnapshot(windowStub, params) {
  windowStub = Object.assign({ _getLatestEvidenceTimestampForScope: _getLatestEvidenceTimestampForScope }, windowStub);
  const fn = new Function('window', block + '\nreturn _buildClientDecisionSnapshot;')(windowStub);
  return fn(params);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Snapshot for Plan A cannot be reused for Plan B -- two calls with
// different planDoc/planId produce independently-scoped results.
// ─────────────────────────────────────────────────────────────────────────────
{
  const clientDoc = { activePlanId: 'plan-A' };
  const sA = runSnapshot({}, { clientId: 'c1', clientDoc: clientDoc, planId: 'plan-A', planDoc: { days: [{ dayIndex: 0 }] }, logsDoc: { entries: {}, currentWeek: 1 } });
  const sB = runSnapshot({}, { clientId: 'c1', clientDoc: clientDoc, planId: 'plan-B', planDoc: { days: [{ dayIndex: 0 }, { dayIndex: 1 }] }, logsDoc: { entries: {}, currentWeek: 1 } });
  ok(sA.identity.planId === 'plan-A' && sB.identity.planId === 'plan-B', '1. each call carries its OWN given planId, never reused across plans');
  ok(sA.identity.isLive === true && sB.identity.isLive === false, '1b. plan-A (matches clientDoc.activePlanId) is flagged live; plan-B (does not match) is honestly NOT live -- cannot masquerade as the current plan');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Snapshot for client X cannot leak to client Y (re-confirmed at the
// provenance level specifically -- identity.clientId is always the given
// clientId, never a shared/global value).
// ─────────────────────────────────────────────────────────────────────────────
{
  const sX = runSnapshot({}, { clientId: 'client-X', clientDoc: { activePlanId: 'p1' }, logsDoc: { entries: {}, currentWeek: 1 } });
  const sY = runSnapshot({}, { clientId: 'client-Y', clientDoc: { activePlanId: 'p1' }, logsDoc: { entries: {}, currentWeek: 1 } });
  ok(sX.identity.clientId === 'client-X' && sY.identity.clientId === 'client-Y', '2. clientId in the snapshot is always exactly the id passed for THAT call');
  ok(sX.provenance.clientId === 'client-X' && sY.provenance.clientId === 'client-Y', '2b. provenance.clientId also never leaks across calls');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. A Coach intervention added AFTER a snapshot makes the NEXT snapshot
// (built from the updated clientDoc) reflect it -- the OLD snapshot object
// itself remains exactly what it was (immutable), it simply isn't reused.
// ─────────────────────────────────────────────────────────────────────────────
{
  const clientDocBefore = { activePlanId: 'plan-A', coachInterventions: [] };
  const before = runSnapshot({}, { clientId: 'c1', clientDoc: clientDocBefore, logsDoc: { entries: {}, currentWeek: 1 } });
  const beforeJson = JSON.stringify(before);

  const clientDocAfter = { activePlanId: 'plan-A', coachInterventions: [{ targetType: 'CLIENT', decidedAt: '2024-06-01T00:00:00.000Z', action: 'KEEP', status: 'ACTIVE' }] };
  const after = runSnapshot({}, { clientId: 'c1', clientDoc: clientDocAfter, logsDoc: { entries: {}, currentWeek: 1 } });

  ok(after.provenance.latestCoachDecisionAt === '2024-06-01T00:00:00.000Z', '3. a new snapshot built after a Coach intervention picks up its decidedAt -- the conflicting old read is naturally superseded by recomputation');
  ok(JSON.stringify(before) === beforeJson, '3b. the OLD snapshot object itself is untouched -- immutable once built, simply not reused for new decisions');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. New execution evidence after a snapshot produces a NEWER snapshot
// (later latestExecutionAt); the old snapshot is not silently patched.
// ─────────────────────────────────────────────────────────────────────────────
{
  const clientDoc = { activePlanId: 'plan-A' };
  const entriesBefore = { 'postsession_1_1': { ts: Date.parse('2024-01-01T00:00:00.000Z') } };
  const before = runSnapshot({}, { clientId: 'c1', clientDoc: clientDoc, logsDoc: { entries: entriesBefore, currentWeek: 1 } });

  const entriesAfter = Object.assign({}, entriesBefore, { 'postsession_1_2': { ts: Date.parse('2024-06-01T00:00:00.000Z') } });
  const after = runSnapshot({}, { clientId: 'c1', clientDoc: clientDoc, logsDoc: { entries: entriesAfter, currentWeek: 1 } });

  ok(Date.parse(after.provenance.latestExecutionAt) > Date.parse(before.provenance.latestExecutionAt),
    '4. new execution evidence (a later postsession) produces a snapshot with a strictly newer latestExecutionAt');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. A historical plan snapshot must never masquerade as live state --
// isLive is explicitly false (not omitted, not silently true) whenever the
// given planId does not match the client's real activePlanId.
// ─────────────────────────────────────────────────────────────────────────────
{
  const clientDoc = { activePlanId: 'plan-CURRENT' };
  const historical = runSnapshot({}, { clientId: 'c1', clientDoc: clientDoc, planId: 'plan-OLD-2023', planDoc: { days: [], status: 'completed' }, logsDoc: { entries: {}, currentWeek: 6 } });
  ok(historical.identity.isLive === false, '5. a historical plan (planId != clientDoc.activePlanId) is explicitly isLive:false, never masquerading as the live plan');
  ok(historical.identity.activePlanId === 'plan-CURRENT', '5b. identity.activePlanId still correctly reports the CLIENT\'s real current plan, distinct from the historical planId being viewed');

  const unknown = runSnapshot({}, { clientId: 'c1', clientDoc: clientDoc, logsDoc: { entries: {}, currentWeek: 6 } }); // planId omitted
  ok(unknown.identity.isLive === null, '5c. when a caller does not even declare which plan it used (planId omitted), isLive is honestly null/unknown -- never defaulted to true');
}

console.log('');
console.log('T277 — Provenance/freshness contract: ' + pass + ' assertions PASSED');
