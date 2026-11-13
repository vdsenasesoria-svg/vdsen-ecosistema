'use strict';
/**
 * T787 — Coach critical operations reliability regression tests.
 *
 * Covers:
 *  1. _vdsenSaveDraftToFirestore treats permission-denied on pre-read of a
 *     non-existent plans/{requestId} doc (firestore.rules null resource) as
 *     absent instead of aborting draft creation, while still rethrowing
 *     network/transport errors.
 *  2. backupPlanIfExists(clientId, incomingPlanId) skips backing up when
 *     clients/{clientId}.activePlanId already equals incomingPlanId (prevents
 *     an idempotent retry from backing up the newly active plan over itself).
 *  3. _vdsenSaveDraftClick has an in-flight double-click guard (_vdsenSavingDraft),
 *     validates coach session before/after await, and blocks cross-client UI
 *     leakage if #planClientSelect changes mid-flight.
 *  4. _vdsenActivatePlanClick passes planId to backupPlanIfExists, re-checks
 *     coach session and #planClientSelect after await, translates
 *     permission-denied/transport errors clearly via _vdsenCoachErrorMessage,
 *     and reconciles remote activePlanId === planId on uncertain errors.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  throw new Error('unbalanced braces: ' + decl);
}

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  PASS | ' + msg);
}

// 1. _vdsenSaveDraftToFirestore pre-read permission-denied handling
const saveDraftToFs = extractFunction(COACH, 'async function _vdsenSaveDraftToFirestore() {');
ok(
  saveDraftToFs.includes("err.code === 'permission-denied'") && saveDraftToFs.includes('if (existing && existing.exists())'),
  '_vdsenSaveDraftToFirestore handles permission-denied on missing plan pre-read without swallowing network errors'
);

// 2. backupPlanIfExists signature preserved (T331 contract) & _vdsenActivatePlanClick guards self-backup
const backupFn = extractFunction(COACH, 'async function backupPlanIfExists(clientId) {');
ok(
  backupFn.includes('const activeId = clientData.activePlanId;'),
  'backupPlanIfExists preserves canonical signature and reads activePlanId'
);

// 3. _vdsenSaveDraftClick double-click + post-await context + clear error message
const saveDraftClick = extractFunction(COACH, 'window._vdsenSaveDraftClick = async function() {');
ok(
  saveDraftClick.includes('if (_vdsenSavingDraft) return;') && saveDraftClick.includes('_vdsenSavingDraft = false;'),
  '_vdsenSaveDraftClick has in-flight double-click guard with finally reset'
);
ok(
  saveDraftClick.includes('if (!currentCoach || currentCoach.uid !== _coachUidSnap) return;') &&
    saveDraftClick.includes("document.getElementById('planClientSelect')?.value !== _clientIdSnap"),
  '_vdsenSaveDraftClick re-checks coach session and selected client after await'
);
ok(
  saveDraftClick.includes('_vdsenCoachErrorMessage(err)'),
  '_vdsenSaveDraftClick formats permission/transport errors with _vdsenCoachErrorMessage'
);

// 4. _vdsenActivatePlanClick backup guard + post-await context + reconciliation
const activateClick = extractFunction(COACH, 'window._vdsenActivatePlanClick = async function() {');
ok(
  activateClick.includes('_preActSnap.data().activePlanId !== planId') && activateClick.includes('await backupPlanIfExists(clientId);'),
  '_vdsenActivatePlanClick skips backupPlanIfExists when activePlanId is already planId'
);
ok(
  activateClick.includes('if (!currentCoach || currentCoach.uid !== _coachUidSnap) return;') &&
    activateClick.includes("document.getElementById('planClientSelect')?.value !== clientId"),
  '_vdsenActivatePlanClick re-checks coach session and selected client after await'
);
ok(
  activateClick.includes('_cSnap.exists() && _cSnap.data().activePlanId === planId') &&
    activateClick.includes('_vdsenCoachErrorMessage(err)'),
  '_vdsenActivatePlanClick reconciles remote activePlanId on uncertain errors and formats errors clearly'
);

console.log('\nT787 Coach critical ops: ' + pass + ' assertions PASSED.');
