'use strict';
/**
 * T140-H — postsession_{W}_{D} field-name schema mismatch (QA-GAP-04, HIGH).
 *
 * Found by QA's coach/client contract audit (qa_t133_coach_client_contracts):
 * CLIENT's submitPostSession writes postsession_{W}_{D} entries as
 *   { eimd, articularPain: { present, pattern }, sleepHours, rpeAverage, ts }
 * but most COACH read-sites (monitor panel bitacora, weekly-stats aggregation,
 * PDF weekly report, dashboard summary badges, log-export CSV rows) still read
 * the legacy flat schema: ps.rpe, ps.sleep, ps.articular, ps.patron — fields
 * the client no longer writes. Net effect: RPE/sleep/articular-pain displays
 * across the coach dashboard silently rendered blank/"—" for real client data.
 *
 * Fix: every read site now checks the new field first, falling back to the
 * legacy flat name for any log entries that predate this fix (no migration
 * needed — this is a read-side compatibility shim, not a data rewrite).
 *
 * Run: node tests/t134h-postsession-field-schema-fix.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

// Collect every line touching a postsession field, to confirm each `.rpe`/
// `.sleep`/`.articular`/`.patron` access is now paired with a new-schema check
// on the same or an adjacent line (i.e. it's a fallback read, not a lone
// legacy read).
const lines = COACH.split('\n');
const legacyFieldRe = /\.(rpe|sleep|articular|patron)\b(?!Average|Hours|Pain)/;
const newFieldNames = ['rpeAverage', 'sleepHours', 'articularPain'];

const unguardedLegacyReads = [];
lines.forEach((line, i) => {
  if (!legacyFieldRe.test(line)) return;
  // Exclude the unrelated _extractTDSignals/_scoreTrainingDaysCandidate
  // "articular" signal — derived from pc.clientFlags.articularIssues, not
  // from a postsession entry at all.
  if (/sig\.articular|_sig\.articular/.test(line)) return;
  // A guarded read either declares the new-field check on this line, or the
  // variable it reads from was already resolved via a new-field check a few
  // lines above (window of 3 lines back covers all of this fix's patterns).
  const windowStart = Math.max(0, i - 3);
  const windowText = lines.slice(windowStart, i + 1).join('\n');
  // Exclude the ci_sem_ (CHECKIN) export row's dead `sleep` field: per the
  // documented schema, ci_sem_{W} only ever has {peso, hrv, who5} — it has
  // never had a sleep field, so `v.sleep` here is always undefined and out
  // of scope for the postsession (rpe/sleep/articular/patron) bug. Use a
  // wider back-window here since the `recordType: 'CHECKIN'` marker sits
  // ~7 lines above the field itself in that row-builder object literal.
  const checkinWindowText = lines.slice(Math.max(0, i - 10), i + 1).join('\n');
  if (/recordType:\s*'CHECKIN'/.test(checkinWindowText)) return;
  const isGuarded = newFieldNames.some(f => windowText.includes(f));
  if (!isGuarded) unguardedLegacyReads.push({ lineNo: i + 1, text: line.trim().slice(0, 160) });
});

assert.deepStrictEqual(
  unguardedLegacyReads, [],
  'T140-H: found postsession legacy-field read(s) with no new-schema fallback nearby: ' +
  JSON.stringify(unguardedLegacyReads, null, 2)
);

console.log('No unguarded legacy postsession field reads remain — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Spot-check the specific functions QA flagged, to lock in the exact fix.
// ─────────────────────────────────────────────────────────────────────────────

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

const monitorFn = extractFunction(COACH, 'loadMonitorClients');
assert.ok(monitorFn, 'loadMonitorClients must exist');
assert.ok(
  /lastPost\.rpeAverage/.test(monitorFn),
  'T140-H: loadMonitorClients bitacora badge must read rpeAverage (with legacy fallback)'
);
assert.ok(
  /post\.rpeAverage/.test(monitorFn) && /post\.sleepHours/.test(monitorFn),
  'T140-H: loadMonitorClients (_renderMonitorForWeek bitacora) must read rpeAverage/sleepHours (with legacy fallback)'
);

const monitorTabFn = extractFunction(COACH, 'async function _renderClientTabMonitor(cont)');
assert.ok(monitorTabFn, '_renderClientTabMonitor must exist');
assert.ok(
  /ps\.rpeAverage/.test(monitorTabFn) && /ps\.sleepHours/.test(monitorTabFn) && /ps\.articularPain/.test(monitorTabFn),
  'T140-H: _renderClientTabMonitor rpe/sleep chart-point reads must use the new schema (with legacy fallback)'
);
assert.ok(
  /ps\.articularPain\s*\?\s*ps\.articularPain\.present/.test(monitorTabFn),
  'T140-H: _renderClientTabMonitor last-session card must read articularPain.present (with legacy fallback to ps.articular==="si")'
);

console.log('loadMonitorClients / _renderClientTabMonitor now read the current schema — OK');

console.log('');
console.log('T140-H — postsession field schema fix: ALL ASSERTIONS PASSED');
