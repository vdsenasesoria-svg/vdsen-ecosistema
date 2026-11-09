'use strict';
// Dedicated STOP, consistency auditing, and recovery procedures for VDSEN numeric pilot.
// Implements safe disarming of fences against partial failure, post-readback confirmation,
// audit of in-flight applications vs overlays, and immutable closing evidence.
// Distinguishes STOP from rollback: halts new writes without erasing legitimate athlete history.
// Uses prioritized sequential writes (NOT atomic) with failure-tolerant continuation and post-readback.
// Preserves coach fields: updates ONLY autoApplyCanary.enabled, never touching clientIds, PIDs or profiles.
// STOP operates independently of window validity: works with expired, invalid, or absent window.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../../api/_numericPilotContract');

function digest(content) {
  return crypto.createHash('sha256').update(typeof content === 'string' ? content : JSON.stringify(content)).digest('hex');
}

/**
 * Executes a prioritized sequential STOP with failure-tolerant continuation and post-verification.
 * Disarms releaseControl/numericPilot first (hard numeric gate), then releaseControl/autonomousProgression,
 * then coaches/{coachId}.autoApplyCanary (updating ONLY autoApplyCanary.enabled via specific field path).
 * Operates independently of window validity: succeeds whether window is active, expired, invalid, or absent.
 * If any step fails or readback cannot confirm full deactivation, returns status: 'STOP_INCOMPLETE'.
 * @param {object} opts
 * @param {string} [opts.reason] - Reason for stopping
 * @param {string} [opts.operationId] - Active operation identifier
 * @param {string} [opts.coachId] - Coach UID
 * @param {object} [opts.window] - Optional window object (may be null, undefined, or expired)
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

  // Step 1: Disarm Primary Numeric Pilot Gate (hard blocker in _autonomousProgression.js)
  try {
    const numRes = await io.writeFence('releaseControl/numericPilot', {
      enabled: false,
      stoppedAt: isoNow,
      stoppedOperation: operationId,
      stopReason: reason
    }, { merge: true, mask: ['enabled', 'stoppedAt', 'stoppedOperation', 'stopReason'] });
    writeAttempts.push({ fence: 'numericPilot', path: 'releaseControl/numericPilot', success: !!numRes });
  } catch (err) {
    writeAttempts.push({ fence: 'numericPilot', path: 'releaseControl/numericPilot', success: false, error: err.message });
    errors.push('Failed to disarm releaseControl/numericPilot: ' + err.message);
  }

  // Step 2: Disarm Global Progression Release Fence (Do NOT overwrite clientIds)
  try {
    const relRes = await io.writeFence('releaseControl/autonomousProgression', {
      enabled: false,
      expiresAt: isoNow
    }, { merge: true, mask: ['enabled', 'expiresAt'] });
    writeAttempts.push({ fence: 'autonomousProgression', path: 'releaseControl/autonomousProgression', success: !!relRes });
  } catch (err) {
    writeAttempts.push({ fence: 'autonomousProgression', path: 'releaseControl/autonomousProgression', success: false, error: err.message });
    errors.push('Failed to disarm releaseControl/autonomousProgression: ' + err.message);
  }

  // Step 3: Disarm Coach Canary Fence (Update ONLY autoApplyCanary.enabled; preserve clientIds, PIDs, and all coach fields)
  try {
    const coachRes = await io.writeFence('coaches/' + coachId, {
      'autoApplyCanary.enabled': false
    }, { merge: true, mask: ['autoApplyCanary.enabled'], fieldPath: 'autoApplyCanary.enabled' });
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

  // Step 5: Durable Ledger Transition (recordStop)
  let ledgerStopped = false;
  let ledgerResult = null;
  let ledgerError = null;

  if (io && typeof io.recordStop === 'function') {
    try {
      ledgerResult = await io.recordStop(operationId, { reason, coachId });
      ledgerStopped = !!(ledgerResult && ledgerResult.success);
      if (!ledgerStopped && ledgerResult && ledgerResult.error) {
        ledgerError = ledgerResult.error;
        errors.push('Failed to record STOP in durable ledger: ' + (ledgerResult.message || ledgerResult.error));
      }
      writeAttempts.push({ fence: 'operationsLedger', path: 'releaseControl/numericPilot/operations/' + operationId, success: ledgerStopped, result: ledgerResult, error: ledgerError });
    } catch (err) {
      ledgerError = err.message;
      writeAttempts.push({ fence: 'operationsLedger', path: 'releaseControl/numericPilot/operations/' + operationId, success: false, error: err.message });
      errors.push('Failed to record STOP in durable ledger: ' + err.message);
    }
  } else {
    // Insecure fallback eliminated per T704/T705: executeStop requires an adapter with concurrency guarantees (io.recordStop).
    ledgerStopped = false;
    ledgerError = 'ADAPTER_MISSING_RECORD_STOP: recordStop adapter with concurrency guarantees is required to transition durable ledger.';
    writeAttempts.push({ fence: 'operationsLedger', path: 'releaseControl/numericPilot/operations/' + operationId, success: false, error: ledgerError });
    errors.push('Failed to record STOP in durable ledger: ' + ledgerError);
  }

  const allFencesConfirmedDisabled = numericStopped && releaseStopped && coachStopped && (readbackErrors.length === 0);
  const fencesDisarmed = allFencesConfirmedDisabled && (errors.filter(e => !e.toLowerCase().includes('durable ledger')).length === 0);
  const allDisarmed = fencesDisarmed && ledgerStopped;
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
    windowProvided: !!opts.window,
    allDisarmed: allDisarmed,
    fencesDisarmed: fencesDisarmed,
    ledgerStopped: ledgerStopped,
    ledgerResult: ledgerResult,
    ledgerError: ledgerError,
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
    coachFieldsPreserved: true,
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

/**
 * T708: Revokes authorization for an individual client without halting the rest of the cohort.
 * - Disarms the client's window in releaseControl/numericPilot (or marks it enabled: false).
 * - Removes the client from releaseControl/autonomousProgression.clientIds (retaining the other cohort clients).
 * - Removes the client from coaches/{coachId}.autoApplyCanary.clientIds (retaining other athletes of that coach).
 * - Marks the client's operation as STOPPED in the durable ledger.
 * - Verifies via readback that the target client is decommissioned while global fences remain operational.
 *
 * @param {object} opts
 * @param {string} opts.clientId - Target client UID to revoke
 * @param {string} opts.operationId - Active operation ID for this client
 * @param {string} opts.coachId - Coach UID
 * @param {string} [opts.reason] - Revocation reason
 * @param {number} [opts.now] - Epoch millis
 * @param {object} io - I/O adapter for Firestore operations
 * @returns {Promise<object>} Revocation report
 */
async function executeClientRevocation(opts, io) {
  opts = opts || {};
  const clientId = opts.clientId;
  const operationId = opts.operationId;
  const coachId = opts.coachId || 'unknown-coach';
  const reason = opts.reason || 'INDIVIDUAL_CLIENT_REVOCATION';
  const now = opts.now || Date.now();
  const isoNow = new Date(now).toISOString().replace('.000Z', 'Z');

  assert.ok(clientId, 'clientId is required for individual revocation.');
  assert.ok(operationId, 'operationId is required for individual revocation.');
  assert.ok(io && typeof io.writeFence === 'function', 'I/O adapter with writeFence is required.');
  assert.ok(io && typeof io.readFence === 'function', 'I/O adapter with readFence is required.');

  const writeAttempts = [];
  const errors = [];

  // Step 1: Disarm client's window in releaseControl/numericPilot
  let numericClientStopped = false;
  try {
    const numDoc = await io.readFence('releaseControl/numericPilot');
    if (numDoc) {
      if (numDoc.windows && typeof numDoc.windows === 'object' && numDoc.windows[clientId]) {
        const updatedWindows = { ...numDoc.windows };
        updatedWindows[clientId] = {
          ...updatedWindows[clientId],
          enabled: false,
          revokedAt: isoNow,
          revokeReason: reason
        };
        await io.writeFence('releaseControl/numericPilot', {
          windows: updatedWindows
        }, { merge: true });
        writeAttempts.push({ fence: 'numericPilot.windows', path: 'releaseControl/numericPilot', success: true });
      } else if (numDoc.uid === clientId) {
        // Single-client fence
        await io.writeFence('releaseControl/numericPilot', {
          enabled: false,
          stoppedAt: isoNow,
          stoppedOperation: operationId,
          stopReason: reason
        }, { merge: true });
        writeAttempts.push({ fence: 'numericPilot', path: 'releaseControl/numericPilot', success: true });
      }
    }
  } catch (err) {
    writeAttempts.push({ fence: 'numericPilot', success: false, error: err.message });
    errors.push('Failed to revoke client in numericPilot fence: ' + err.message);
  }

  // Step 2: Remove clientId from releaseControl/autonomousProgression (keeping remaining clients!)
  let releaseClientRemoved = false;
  try {
    const relDoc = await io.readFence('releaseControl/autonomousProgression');
    if (relDoc && Array.isArray(relDoc.clientIds)) {
      const remainingIds = relDoc.clientIds.filter(id => id !== clientId);
      await io.writeFence('releaseControl/autonomousProgression', {
        clientIds: remainingIds
      }, { merge: true });
      writeAttempts.push({ fence: 'autonomousProgression', remainingCount: remainingIds.length, success: true });
    }
  } catch (err) {
    writeAttempts.push({ fence: 'autonomousProgression', success: false, error: err.message });
    errors.push('Failed to remove client from release fence: ' + err.message);
  }

  // Step 3: Remove clientId from coaches/{coachId}.autoApplyCanary (keeping other athletes of that coach!)
  let coachClientRemoved = false;
  try {
    const coachDoc = await io.readFence('coaches/' + coachId);
    if (coachDoc && coachDoc.autoApplyCanary && Array.isArray(coachDoc.autoApplyCanary.clientIds)) {
      const remainingCoachIds = coachDoc.autoApplyCanary.clientIds.filter(id => id !== clientId);
      await io.writeFence('coaches/' + coachId, {
        'autoApplyCanary.clientIds': remainingCoachIds
      }, { merge: true });
      writeAttempts.push({ fence: 'coachCanary', remainingCount: remainingCoachIds.length, success: true });
    }
  } catch (err) {
    writeAttempts.push({ fence: 'coachCanary', success: false, error: err.message });
    errors.push('Failed to remove client from coach canary: ' + err.message);
  }

  // Step 4: Transition durable ledger for this specific operationId
  let ledgerStopped = false;
  let ledgerResult = null;
  let ledgerError = null;

  if (io && typeof io.recordStop === 'function') {
    try {
      ledgerResult = await io.recordStop(operationId, { reason, coachId, clientId, actor: 'individual-revocation' });
      ledgerStopped = !!(ledgerResult && ledgerResult.success);
      if (!ledgerStopped && ledgerResult && ledgerResult.error) {
        ledgerError = ledgerResult.error;
        errors.push('Failed to record STOP in durable ledger: ' + (ledgerResult.message || ledgerResult.error));
      }
      writeAttempts.push({ fence: 'operationsLedger', path: 'releaseControl/numericPilot/operations/' + operationId, success: ledgerStopped });
    } catch (err) {
      ledgerError = err.message;
      errors.push('Failed to record STOP in durable ledger: ' + err.message);
    }
  } else {
    ledgerStopped = false;
    ledgerError = 'ADAPTER_MISSING_RECORD_STOP';
    errors.push('Failed to record STOP in durable ledger: ' + ledgerError);
  }

  // Step 5: Readback verification
  let readbackErrors = [];
  try {
    const numDocPost = await io.readFence('releaseControl/numericPilot');
    if (numDocPost) {
      if (numDocPost.windows && numDocPost.windows[clientId]) {
        numericClientStopped = numDocPost.windows[clientId].enabled === false;
      } else if (numDocPost.uid === clientId) {
        numericClientStopped = numDocPost.enabled === false;
      } else {
        numericClientStopped = true;
      }
    } else {
      numericClientStopped = true;
    }
  } catch (err) {
    readbackErrors.push('Readback numericPilot failed: ' + err.message);
  }

  try {
    const relDocPost = await io.readFence('releaseControl/autonomousProgression');
    releaseClientRemoved = !relDocPost || !Array.isArray(relDocPost.clientIds) || relDocPost.clientIds.indexOf(clientId) < 0;
  } catch (err) {
    readbackErrors.push('Readback releaseControl failed: ' + err.message);
  }

  try {
    const coachDocPost = await io.readFence('coaches/' + coachId);
    coachClientRemoved = !coachDocPost || !coachDocPost.autoApplyCanary ||
      !Array.isArray(coachDocPost.autoApplyCanary.clientIds) || coachDocPost.autoApplyCanary.clientIds.indexOf(clientId) < 0;
  } catch (err) {
    readbackErrors.push('Readback coachCanary failed: ' + err.message);
  }

  const allScopedDisabled = numericClientStopped && releaseClientRemoved && coachClientRemoved && (readbackErrors.length === 0);
  const success = allScopedDisabled && ledgerStopped;

  return {
    schema: 'vdsen-client-revocation-v1',
    status: success ? 'REVOCATION_CONFIRMED' : 'REVOCATION_INCOMPLETE',
    clientId: clientId,
    operationId: operationId,
    coachId: coachId,
    revokedAt: isoNow,
    reason: reason,
    success: success,
    fencesScopedDisarmed: allScopedDisabled,
    ledgerStopped: ledgerStopped,
    ledgerResult: ledgerResult,
    ledgerError: ledgerError,
    writeAttempts: writeAttempts,
    readback: {
      numericClientDisabled: numericClientStopped,
      releaseClientRemoved: releaseClientRemoved,
      coachClientRemoved: coachClientRemoved,
      readbackComplete: readbackErrors.length === 0
    },
    errors: errors.concat(readbackErrors)
  };
}

module.exports = {
  executeStop,
  executeClientRevocation,
  auditMesoConsistency,
  assertFreshAuthorizationRequired,
  digest
};
