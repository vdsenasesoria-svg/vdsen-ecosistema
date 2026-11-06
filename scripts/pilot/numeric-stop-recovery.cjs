'use strict';
// Dedicated STOP, consistency auditing, and recovery procedures for VDSEN numeric pilot.
// Implements safe disarming of fences against partial failure, post-readback confirmation,
// audit of in-flight applications vs overlays, and immutable closing evidence.
// Distinguishes STOP from rollback: halts new writes without erasing legitimate athlete history.
// Uses prioritized sequential writes (NOT atomic) with failure-tolerant continuation and post-readback.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../../api/_numericPilotContract');

function digest(content) {
  return crypto.createHash('sha256').update(typeof content === 'string' ? content : JSON.stringify(content)).digest('hex');
}

/**
 * Executes a prioritized sequential STOP with failure-tolerant continuation and post-verification.
 * Disarms releaseControl/numericPilot first (hard numeric gate), then releaseControl/autonomousProgression,
 * then coaches/{coachId}.autoApplyCanary (merging autoApplyCanary without touching other coach fields).
 * If any step fails or readback cannot confirm full deactivation, returns status: 'STOP_INCOMPLETE'.
 * @param {object} opts
 * @param {string} [opts.reason] - Reason for stopping
 * @param {string} [opts.operationId] - Active operation identifier
 * @param {string} [opts.coachId] - Coach UID
 * @param {number} [opts.now] - Epoch millis
 * @param {object} io - I/O adapter for Firestore operations
 * @returns {Promise<object>} STOP execution report
 */
async function executeStop(opts, io) {
  opts = opts || {};
  assert.ok(io && typeof io.writeFence === 'function', 'I/O adapter with writeFence is required.');
  assert.ok(io && typeof io.readFence === 'function', 'I/O adapter with readFence is required.');

  const now = opts.now || Date.now();
  const isoNow = new Date(now).toISOString().replace('.000Z', 'Z');
  const coachId = opts.coachId || 'unknown-coach';
  const operationId = opts.operationId || 'MANUAL_STOP_' + now;
  const reason = opts.reason || 'OPERATIONAL_STOP_REQUESTED';

  const writeAttempts = [];
  const errors = [];

  // Step 1: Disarm Primary Numeric Pilot Gate (hard blocker for _autonomousProgression.js)
  try {
    const numRes = await io.writeFence('releaseControl/numericPilot', {
      enabled: false,
      stoppedAt: isoNow,
      stoppedOperation: operationId,
      stopReason: reason
    }, { merge: true });
    writeAttempts.push({ fence: 'numericPilot', path: 'releaseControl/numericPilot', success: !!numRes });
  } catch (err) {
    writeAttempts.push({ fence: 'numericPilot', path: 'releaseControl/numericPilot', success: false, error: err.message });
    errors.push('Failed to disarm releaseControl/numericPilot: ' + err.message);
  }

  // Step 2: Disarm Global Progression Release Fence
  try {
    const relRes = await io.writeFence('releaseControl/autonomousProgression', {
      enabled: false,
      expiresAt: isoNow,
      clientIds: [C.UID]
    }, { merge: true });
    writeAttempts.push({ fence: 'autonomousProgression', path: 'releaseControl/autonomousProgression', success: !!relRes });
  } catch (err) {
    writeAttempts.push({ fence: 'autonomousProgression', path: 'releaseControl/autonomousProgression', success: false, error: err.message });
    errors.push('Failed to disarm releaseControl/autonomousProgression: ' + err.message);
  }

  // Step 3: Disarm Coach Canary Fence (Merge only autoApplyCanary; never overwrite coach profile or unrelated fields)
  try {
    const coachRes = await io.writeFence('coaches/' + coachId, {
      autoApplyCanary: {
        enabled: false,
        clientIds: [C.UID],
        prescriptionExerciseIds: [C.PID]
      }
    }, { merge: true, mask: ['autoApplyCanary'] });
    writeAttempts.push({ fence: 'coachCanary', path: 'coaches/' + coachId, success: !!coachRes });
  } catch (err) {
    writeAttempts.push({ fence: 'coachCanary', path: 'coaches/' + coachId, success: false, error: err.message });
    errors.push('Failed to disarm coaches/' + coachId + ' canary: ' + err.message);
  }

  // Step 4: Post-Verification Readback (Confirm whether all three fences are definitively disabled)
  let numericStopped = false;
  let releaseStopped = false;
  let coachStopped = false;
  let readbackErrors = [];

  try {
    const numericFence = await io.readFence('releaseControl/numericPilot');
    numericStopped = !numericFence || numericFence.enabled === false;
  } catch (err) {
    readbackErrors.push('Failed to read back releaseControl/numericPilot: ' + err.message);
  }

  try {
    const releaseFence = await io.readFence('releaseControl/autonomousProgression');
    releaseStopped = !releaseFence || releaseFence.enabled === false;
  } catch (err) {
    readbackErrors.push('Failed to read back releaseControl/autonomousProgression: ' + err.message);
  }

  try {
    const coachDoc = await io.readFence('coaches/' + coachId);
    coachStopped = !coachDoc || !coachDoc.autoApplyCanary || coachDoc.autoApplyCanary.enabled === false;
  } catch (err) {
    readbackErrors.push('Failed to read back coaches/' + coachId + ': ' + err.message);
  }

  const allFencesConfirmedDisabled = numericStopped && releaseStopped && coachStopped && (readbackErrors.length === 0);
  const allDisarmed = allFencesConfirmedDisabled && (errors.length === 0);
  const status = allDisarmed ? 'STOP_CONFIRMED' : 'STOP_INCOMPLETE';

  const report = {
    schema: 'vdsen-numeric-stop-v1',
    status: status,
    operationId: operationId,
    stoppedAt: isoNow,
    reason: reason,
    coachId: coachId,
    pilotUid: C.UID,
    pid: C.PID,
    allDisarmed: allDisarmed,
    primaryFenceDisarmed: numericStopped,
    writeAttempts: writeAttempts,
    readback: {
      numericPilotDisarmed: numericStopped,
      releaseControlDisarmed: releaseStopped,
      coachCanaryDisarmed: coachStopped,
      readbackComplete: readbackErrors.length === 0
    },
    errors: [...errors, ...readbackErrors],
    // Explicit invariants
    sportsDataPreserved: true,
    revertedAthleteRecords: 0,
    deletedDocuments: 0,
    digest: null
  };

  report.digest = digest(report);
  return report;
}

/**
 * Audits state in meso logs for consistency, detecting orphan overlays or in-flight applications.
 * Does NOT delete data. Reports classified findings.
 * @param {object} mesoData - The meso log document data (logs/{uid}/mesos/{planId})
 * @returns {object} Audit report with consistency classifications
 */
function auditMesoConsistency(mesoData) {
  mesoData = mesoData || {};
  const applications = mesoData.progressionApplications || {};
  const overlays = mesoData.nextExposureOverlays || {};
  const receipts = mesoData.consumptionReceipts || {};

  const classified = {
    legitimateApplied: [],
    legitimateConsumed: [],
    pendingHalted: [],
    orphanedOverlays: [],
    inconsistentApplications: [],
    outOfScopePids: []
  };

  // 1. Audit Applications
  for (const [key, app] of Object.entries(applications)) {
    if (!app) continue;
    const pid = app.prescriptionExerciseId;
    if (pid !== C.PID) {
      classified.outOfScopePids.push({ key, pid, state: app.state });
      continue;
    }

    if (app.state === 'PENDING') {
      classified.pendingHalted.push({ key, pid, calculatedAt: app.calculatedAt });
    } else if (app.state === 'APPLIED') {
      // Find matching overlay
      const matchingOverlay = Object.values(overlays).find(o => o && o.sourceRecordKey === key);
      if (matchingOverlay && matchingOverlay.status === 'APPLIED') {
        classified.legitimateApplied.push({ key, pid, overlayKey: matchingOverlay.key, dimension: matchingOverlay.dimension });
      } else {
        classified.inconsistentApplications.push({ key, pid, issue: 'APPLIED_RECORD_WITHOUT_APPLIED_OVERLAY' });
      }
    } else if (app.state === 'CONSUMED') {
      const receipt = receipts[key];
      classified.legitimateConsumed.push({ key, pid, hasReceipt: !!receipt });
    } else {
      classified.inconsistentApplications.push({ key, pid, issue: 'UNKNOWN_APPLICATION_STATE_' + app.state });
    }
  }

  // 2. Audit Overlays for Orphans
  for (const [key, ov] of Object.entries(overlays)) {
    if (!ov) continue;
    const sourceKey = ov.sourceRecordKey;
    const parentApp = applications[sourceKey];
    if (!parentApp) {
      classified.orphanedOverlays.push({ overlayKey: key, sourceRecordKey: sourceKey, status: ov.status });
    }
  }

  const isConsistent = classified.inconsistentApplications.length === 0 &&
                       classified.orphanedOverlays.length === 0 &&
                       classified.outOfScopePids.length === 0;

  return {
    schema: 'vdsen-numeric-audit-consistency-v1',
    isConsistent: isConsistent,
    totalApplications: Object.keys(applications).length,
    totalOverlays: Object.keys(overlays).length,
    totalReceipts: Object.keys(receipts).length,
    classified: classified,
    auditedAt: new Date().toISOString()
  };
}

/**
 * Asserts that any reactivation requires a strictly new authorization with a new operationId.
 * @param {object} priorReport - Prior execution or STOP report
 * @param {object} newWindow - Candidate new window
 */
function assertFreshAuthorizationRequired(priorReport, newWindow) {
  assert.ok(priorReport && priorReport.operationId, 'Prior report with operationId is required.');
  assert.ok(newWindow && newWindow.operationId, 'Candidate window with operationId is required.');

  if (newWindow.operationId === priorReport.operationId) {
    throw new Error('REUSE_OF_OPERATION_ID_FORBIDDEN: Each numeric activation requires a unique, newly authorized operationId.');
  }

  if (priorReport.stoppedAt && newWindow.startsAt) {
    const stopTime = Date.parse(priorReport.stoppedAt);
    const newStartTime = Date.parse(newWindow.startsAt);
    if (newStartTime < stopTime) {
      throw new Error('STALE_WINDOW_STARTS_BEFORE_PRIOR_STOP: New window startsAt must be after the prior STOP time.');
    }
  }

  return true;
}

module.exports = {
  executeStop,
  auditMesoConsistency,
  assertFreshAuthorizationRequired,
  digest
};
