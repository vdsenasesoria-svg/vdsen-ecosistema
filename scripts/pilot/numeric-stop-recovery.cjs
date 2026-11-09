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
  const coachId = opts.coachId;
  const reason = opts.reason || 'INDIVIDUAL_CLIENT_REVOCATION';
  const now = opts.now || Date.now();
  const isoNow = new Date(now).toISOString().replace('.000Z', 'Z');

  const writeAttempts = [];
  const errors = [];
  const MAX_RETRIES = 5;

  let numericClientStopped = false;
  let releaseClientRemoved = false;
  let coachClientRemoved = false;
  let ledgerStopped = false;
  let ledgerResult = null;
  let ledgerError = null;

  if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
    errors.push('INVALID_CLIENT_ID: clientId must be a non-empty string.');
    return {
      schema: 'vdsen-client-revocation-v1',
      status: 'REVOCATION_INCOMPLETE',
      clientId: clientId || null,
      operationId: operationId || null,
      coachId: coachId || null,
      revokedAt: isoNow,
      reason: reason,
      success: false,
      fencesScopedDisarmed: false,
      ledgerStopped: false,
      ledgerResult: null,
      ledgerError: 'INVALID_CLIENT_ID',
      writeAttempts: [],
      readback: {
        numericClientDisabled: false,
        releaseClientRemoved: false,
        coachClientRemoved: false,
        readbackComplete: false
      },
      errors: errors
    };
  }

  if (!operationId || typeof operationId !== 'string' || operationId.trim() === '') {
    errors.push('INVALID_OPERATION_ID: operationId must be a non-empty string.');
    return {
      schema: 'vdsen-client-revocation-v1',
      status: 'REVOCATION_INCOMPLETE',
      clientId: clientId,
      operationId: operationId || null,
      coachId: coachId || null,
      revokedAt: isoNow,
      reason: reason,
      success: false,
      fencesScopedDisarmed: false,
      ledgerStopped: false,
      ledgerResult: null,
      ledgerError: 'INVALID_OPERATION_ID',
      writeAttempts: [],
      readback: {
        numericClientDisabled: false,
        releaseClientRemoved: false,
        coachClientRemoved: false,
        readbackComplete: false
      },
      errors: errors
    };
  }

  if (!coachId || typeof coachId !== 'string' || coachId === 'unknown-coach' || coachId.trim() === '') {
    errors.push('COACH_IDENTITY_UNACCREDITED: Valid coachId is required for individual client revocation.');
    return {
      schema: 'vdsen-client-revocation-v1',
      status: 'REVOCATION_INCOMPLETE',
      clientId: clientId,
      operationId: operationId,
      coachId: coachId || null,
      revokedAt: isoNow,
      reason: reason,
      success: false,
      fencesScopedDisarmed: false,
      ledgerStopped: false,
      ledgerResult: null,
      ledgerError: 'COACH_IDENTITY_UNACCREDITED',
      writeAttempts: [],
      readback: {
        numericClientDisabled: false,
        releaseClientRemoved: false,
        coachClientRemoved: false,
        readbackComplete: false
      },
      errors: errors
    };
  }

  assert.ok(io && typeof io.writeFence === 'function', 'I/O adapter with writeFence is required.');
  assert.ok(io && typeof io.readFence === 'function', 'I/O adapter with readFence is required.');

  // Path A: If atomic transaction runner is available, execute all fence updates atomically
  if (typeof io.runTransaction === 'function' && io.db) {
    const db = io.db;
    try {
      const txRes = await io.runTransaction(async (tx) => {
        const numRef = db.doc('releaseControl/numericPilot');
        const relRef = db.doc('releaseControl/autonomousProgression');
        const coachRef = db.doc('coaches/' + coachId);
        const opRef = db.doc('releaseControl/numericPilot/operations/' + operationId);
        const clientRef = db.doc('clients/' + clientId);

        const [numSnap, relSnap, coachSnap, opSnap, clientSnap] = await Promise.all([
          tx.get(numRef),
          tx.get(relRef),
          tx.get(coachRef),
          tx.get(opRef),
          tx.get(clientRef)
        ]);

        // 1. Authoritative window verification in releaseControl/numericPilot
        if (!numSnap.exists) {
          throw new Error('NUMERIC_PILOT_FENCE_MISSING: releaseControl/numericPilot document does not exist.');
        }
        const numData = numSnap.data() || {};
        const targetWindow = (numData.windows && typeof numData.windows === 'object' && numData.windows[clientId])
          || (numData.uid === clientId ? (numData.window || numData) : null);

        if (!targetWindow) {
          throw new Error('WINDOW_NOT_FOUND: No authorized window exists for client ' + clientId);
        }

        // Validate window UID
        if (!targetWindow.uid || typeof targetWindow.uid !== 'string' || targetWindow.uid.trim() === '') {
          throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window UID is required and must not be empty.');
        }
        if (targetWindow.uid !== clientId) {
          throw new Error('IDENTITY_MISMATCH: Window UID ' + targetWindow.uid + ' does not match clientId ' + clientId);
        }

        // 2. Authoritative operations ledger verification
        if (!opSnap.exists) {
          throw new Error('LEDGER_RECORD_MISSING: Operations ledger record does not exist for operationId ' + operationId);
        }
        const opData = opSnap.data() || {};

        // Cross-client defense & mandatory ledger UID validation (falla cerrada inmediata si la operacion pertenece a otro cliente)
        if (!opData.uid || typeof opData.uid !== 'string' || opData.uid.trim() === '') {
          throw new Error('LEDGER_IDENTITY_INCOMPLETE: Ledger UID is required and must not be empty.');
        }
        if (opData.uid !== clientId) {
          throw new Error('CROSS_CLIENT_OPERATION_DENIED: Operation ' + operationId + ' belongs to client ' + opData.uid + ', not ' + clientId);
        }

        // Validate remaining mandatory window identity fields (operationId, planId, pid, coachId)
        if (!targetWindow.operationId || typeof targetWindow.operationId !== 'string' || targetWindow.operationId.trim() === '') {
          throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window operationId is required and must not be empty.');
        }
        if (targetWindow.operationId !== operationId) {
          throw new Error('OPERATION_MISMATCH: Window operationId ' + targetWindow.operationId + ' does not match requested ' + operationId);
        }
        if (!targetWindow.planId || typeof targetWindow.planId !== 'string' || targetWindow.planId.trim() === '') {
          throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window planId is required and must not be empty.');
        }
        if (!targetWindow.pid || typeof targetWindow.pid !== 'string' || targetWindow.pid.trim() === '') {
          throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window pid is required and must not be empty.');
        }
        if (!targetWindow.coachId || typeof targetWindow.coachId !== 'string' || targetWindow.coachId.trim() === '') {
          throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window coachId is required and must not be empty.');
        }
        if (targetWindow.coachId !== coachId) {
          throw new Error('COACH_MISMATCH: Window coachId ' + targetWindow.coachId + ' does not match ' + coachId);
        }

        // Validate remaining mandatory ledger identity fields (operationId, planId, pid)
        if (!opData.operationId || typeof opData.operationId !== 'string' || opData.operationId.trim() === '') {
          throw new Error('LEDGER_IDENTITY_INCOMPLETE: Ledger operationId is required and must not be empty.');
        }
        if (opData.operationId !== operationId) {
          throw new Error('OPERATION_ID_MISMATCH: Ledger operationId ' + opData.operationId + ' does not match requested ' + operationId);
        }
        if (!opData.planId || typeof opData.planId !== 'string' || opData.planId.trim() === '') {
          throw new Error('LEDGER_IDENTITY_INCOMPLETE: Ledger planId is required and must not be empty.');
        }
        if (opData.planId !== targetWindow.planId) {
          throw new Error('PLAN_MISMATCH: Ledger planId ' + opData.planId + ' does not match window planId ' + targetWindow.planId);
        }
        if (!opData.pid || typeof opData.pid !== 'string' || opData.pid.trim() === '') {
          throw new Error('LEDGER_IDENTITY_INCOMPLETE: Ledger pid is required and must not be empty.');
        }
        if (opData.pid !== targetWindow.pid) {
          throw new Error('PID_MISMATCH: Ledger pid ' + opData.pid + ' does not match window pid ' + targetWindow.pid);
        }

        // 3. Coach relationship and provenance verification
        const ledgerCoachId = opData.coachId || (opData.window && opData.window.coachId);
        if (ledgerCoachId) {
          if (ledgerCoachId !== coachId) {
            throw new Error('COACH_MISMATCH: Ledger coachId ' + ledgerCoachId + ' does not match requested ' + coachId);
          }
        } else {
          // Backward compatibility check for legacy T699 reservations without coachId in ledger:
          // Validate whether client record in clients/{clientId} authoritatively confirms coachId
          const clientData = clientSnap && clientSnap.exists ? (clientSnap.data() || {}) : null;
          if (!clientData || clientData.coachId !== coachId) {
            throw new Error('COACH_IDENTITY_UNACCREDITED: Legacy reservation lacks coachId and client coach relationship cannot be accredited; individual revocation rejected, global STOP required.');
          }
        }

        // 4. Verify Coach document exists and canary scope includes clientId (or operation is already terminal)
        if (!coachSnap.exists) {
          throw new Error('COACH_NOT_FOUND: Coach document coaches/' + coachId + ' does not exist.');
        }
        const coachData = coachSnap.data() || {};
        const isTerminal = opData.status === 'STOPPED' || opData.status === 'COMPLETED' || opData.status === 'FAILED' || opData.status === 'EXPIRED';
        if (!isTerminal && (!coachData.autoApplyCanary || !Array.isArray(coachData.autoApplyCanary.clientIds) || !coachData.autoApplyCanary.clientIds.includes(clientId))) {
          throw new Error('CLIENT_NOT_IN_COACH_SCOPE: Client ' + clientId + ' is not in coach ' + coachId + ' canary scope.');
        }

        // 5. Update numericPilot fence
        if (numData.windows && typeof numData.windows === 'object' && numData.windows[clientId]) {
          const updatedWindows = { ...numData.windows };
          updatedWindows[clientId] = {
            ...updatedWindows[clientId],
            enabled: false,
            revokedAt: isoNow,
            revokeReason: reason
          };
          tx.set(numRef, { windows: updatedWindows }, { merge: true });
        } else if (numData.uid === clientId) {
          tx.set(numRef, { enabled: false, stoppedAt: isoNow, stoppedOperation: operationId, stopReason: reason }, { merge: true });
        }

        // 6. Update releaseControl/autonomousProgression (remove clientId while strictly preserving all other concurrent clients)
        if (relSnap.exists) {
          const relData = relSnap.data() || {};
          if (Array.isArray(relData.clientIds)) {
            const remaining = relData.clientIds.filter(id => id !== clientId);
            tx.set(relRef, { clientIds: remaining }, { merge: true });
          }
        }

        // 7. Update coaches/{coachId} (remove clientId while strictly preserving other clients)
        if (coachSnap.exists) {
          if (coachData.autoApplyCanary && Array.isArray(coachData.autoApplyCanary.clientIds)) {
            const remainingCoach = coachData.autoApplyCanary.clientIds.filter(id => id !== clientId);
            const updatedCanary = { ...coachData.autoApplyCanary, clientIds: remainingCoach };
            tx.set(coachRef, { autoApplyCanary: updatedCanary }, { merge: true });
          }
        }

        // 8. Transition ledger if active, or preserve existing terminal state idempotently without duplicate STOP events
        let opStopped = false;

        if (isTerminal) {
          // Terminal state exists: do NOT add duplicate STOP event to history
          opStopped = true;
        } else {
          // Active state (RESERVED / PENDING): transition to STOPPED
          const history = Array.isArray(opData.history) ? [...opData.history] : [];
          history.push({
            sequence: history.length + 1,
            action: 'STOPPED',
            at: isoNow,
            actor: 'individual-revocation',
            reason
          });
          tx.update(opRef, {
            status: 'STOPPED',
            stoppedAt: isoNow,
            stopReason: reason,
            history
          });
          opStopped = true;
        }

        return {
          success: true,
          opStopped,
          isTerminal,
          finalStatus: isTerminal ? opData.status : 'STOPPED'
        };
      });

      numericClientStopped = true;
      releaseClientRemoved = true;
      coachClientRemoved = true;
      ledgerStopped = !!(txRes && txRes.opStopped);
      ledgerResult = { success: ledgerStopped, operationId, status: txRes && txRes.finalStatus };
      writeAttempts.push({ fence: 'atomicTransaction', success: true });
    } catch (txErr) {
      errors.push('Atomic transaction rejected during individual revocation: ' + txErr.message);
      writeAttempts.push({ fence: 'atomicTransaction', success: false, error: txErr.message });
      return {
        schema: 'vdsen-client-revocation-v1',
        status: 'REVOCATION_INCOMPLETE',
        clientId: clientId,
        operationId: operationId,
        coachId: coachId,
        revokedAt: isoNow,
        reason: reason,
        success: false,
        fencesScopedDisarmed: false,
        ledgerStopped: false,
        ledgerResult: null,
        ledgerError: txErr.message,
        writeAttempts: writeAttempts,
        readback: {
          numericClientDisabled: false,
          releaseClientRemoved: false,
          coachClientRemoved: false,
          readbackComplete: false
        },
        errors: errors
      };
    }
  } else {
    // Path B: Fallback when atomic transaction runner is not available
    const hasOccPreconditions = (io.supportsOCC === true || typeof io.writeFenceWithPrecondition === 'function')
      && typeof io.readFenceWithVersion === 'function';

    if (!hasOccPreconditions) {
      // Insecure fallback rejected: adapter lacks atomic transactions and OCC version preconditions
      errors.push('ADAPTER_UNSUPPORTED_CONCURRENCY_GUARANTEES: Adapter lacks atomic transaction and OCC version precondition guarantees; refusing insecure writes.');
      return {
        schema: 'vdsen-client-revocation-v1',
        status: 'REVOCATION_INCOMPLETE',
        clientId: clientId,
        operationId: operationId,
        coachId: coachId,
        revokedAt: isoNow,
        reason: reason,
        success: false,
        fencesScopedDisarmed: false,
        ledgerStopped: false,
        ledgerResult: null,
        ledgerError: 'ADAPTER_UNSUPPORTED_CONCURRENCY_GUARANTEES',
        writeAttempts: [],
        readback: {
          numericClientDisabled: false,
          releaseClientRemoved: false,
          coachClientRemoved: false,
          readbackComplete: false
        },
        errors: errors
      };
    }

    // Authoritative pre-validation of all identities before attempting ANY OCC write
    let prevalidationSuccess = false;
    let initialNumDoc = null;
    let initialNumUpdateTime = null;

    try {
      const numRes = await io.readFenceWithVersion('releaseControl/numericPilot');
      initialNumDoc = numRes && numRes.doc;
      initialNumUpdateTime = numRes && numRes.updateTime;
      if (!initialNumUpdateTime) {
        throw new Error('MISSING_VERSION_PRECONDITION: numericPilot updateTime missing.');
      }
      if (!initialNumDoc) {
        throw new Error('NUMERIC_PILOT_FENCE_MISSING: releaseControl/numericPilot document missing.');
      }

      const targetWindow = (initialNumDoc.windows && typeof initialNumDoc.windows === 'object' && initialNumDoc.windows[clientId])
        || (initialNumDoc.uid === clientId ? (initialNumDoc.window || initialNumDoc) : null);
      if (!targetWindow) {
        throw new Error('WINDOW_NOT_FOUND: No authorized window exists for client ' + clientId);
      }

      // Mandatory window UID
      if (!targetWindow.uid || typeof targetWindow.uid !== 'string' || targetWindow.uid.trim() === '') {
        throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window UID is required.');
      }
      if (targetWindow.uid !== clientId) {
        throw new Error('IDENTITY_MISMATCH: Window UID ' + targetWindow.uid + ' does not match clientId ' + clientId);
      }

      // Mandatory operations ledger verification before window operation checks
      const opReadResult = await (typeof io.readFenceWithVersion === 'function'
        ? io.readFenceWithVersion('releaseControl/numericPilot/operations/' + operationId)
        : io.readFence('releaseControl/numericPilot/operations/' + operationId));
      const opData = (opReadResult && opReadResult.doc) || opReadResult;
      if (!opData) {
        throw new Error('LEDGER_RECORD_MISSING: Operations ledger record does not exist for operationId ' + operationId);
      }

      // Cross-client defense
      if (!opData.uid || typeof opData.uid !== 'string' || opData.uid.trim() === '') {
        throw new Error('LEDGER_IDENTITY_INCOMPLETE: Ledger UID is required.');
      }
      if (opData.uid !== clientId) {
        throw new Error('CROSS_CLIENT_OPERATION_DENIED: Operation ' + operationId + ' belongs to client ' + opData.uid + ', not ' + clientId);
      }

      // Mandatory remaining window identities
      if (!targetWindow.operationId || typeof targetWindow.operationId !== 'string' || targetWindow.operationId.trim() === '') {
        throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window operationId is required.');
      }
      if (targetWindow.operationId !== operationId) {
        throw new Error('OPERATION_MISMATCH: Window operationId ' + targetWindow.operationId + ' does not match requested ' + operationId);
      }
      if (!targetWindow.planId || typeof targetWindow.planId !== 'string' || targetWindow.planId.trim() === '') {
        throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window planId is required.');
      }
      if (!targetWindow.pid || typeof targetWindow.pid !== 'string' || targetWindow.pid.trim() === '') {
        throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window pid is required.');
      }
      if (!targetWindow.coachId || typeof targetWindow.coachId !== 'string' || targetWindow.coachId.trim() === '') {
        throw new Error('WINDOW_IDENTITY_INCOMPLETE: Window coachId is required.');
      }
      if (targetWindow.coachId !== coachId) {
        throw new Error('COACH_MISMATCH: Window coachId ' + targetWindow.coachId + ' does not match ' + coachId);
      }
      if (!opData.operationId || typeof opData.operationId !== 'string' || opData.operationId.trim() === '') {
        throw new Error('LEDGER_IDENTITY_INCOMPLETE: Ledger operationId is required.');
      }
      if (opData.operationId !== operationId) {
        throw new Error('OPERATION_ID_MISMATCH: Ledger operationId ' + opData.operationId + ' does not match requested ' + operationId);
      }
      if (!opData.planId || typeof opData.planId !== 'string' || opData.planId.trim() === '') {
        throw new Error('LEDGER_IDENTITY_INCOMPLETE: Ledger planId is required.');
      }
      if (opData.planId !== targetWindow.planId) {
        throw new Error('PLAN_MISMATCH: Ledger planId ' + opData.planId + ' does not match window planId ' + targetWindow.planId);
      }
      if (!opData.pid || typeof opData.pid !== 'string' || opData.pid.trim() === '') {
        throw new Error('LEDGER_IDENTITY_INCOMPLETE: Ledger pid is required.');
      }
      if (opData.pid !== targetWindow.pid) {
        throw new Error('PID_MISMATCH: Ledger pid ' + opData.pid + ' does not match window pid ' + targetWindow.pid);
      }

      // Coach identity provenance
      const ledgerCoachId = opData.coachId || (opData.window && opData.window.coachId);
      if (ledgerCoachId) {
        if (ledgerCoachId !== coachId) {
          throw new Error('COACH_MISMATCH: Ledger coachId ' + ledgerCoachId + ' does not match requested ' + coachId);
        }
      } else {
        // Legacy reservation fallback
        let clientData = null;
        try {
          const clientRes = await (typeof io.readFenceWithVersion === 'function'
            ? io.readFenceWithVersion('clients/' + clientId)
            : io.readFence('clients/' + clientId));
          clientData = (clientRes && clientRes.doc) || clientRes;
        } catch (_) {}
        if (!clientData || clientData.coachId !== coachId) {
          throw new Error('COACH_IDENTITY_UNACCREDITED: Legacy reservation lacks coachId and client coach relationship cannot be accredited; individual revocation rejected, global STOP required.');
        }
      }

      // Coach document and canary scope check
      const coachRes = await io.readFenceWithVersion('coaches/' + coachId);
      const coachDoc = coachRes && coachRes.doc;
      const isTerminal = opData.status === 'STOPPED' || opData.status === 'COMPLETED' || opData.status === 'FAILED' || opData.status === 'EXPIRED';
      if (!coachDoc || (!isTerminal && (!coachDoc.autoApplyCanary || !Array.isArray(coachDoc.autoApplyCanary.clientIds) || !coachDoc.autoApplyCanary.clientIds.includes(clientId)))) {
        throw new Error('CLIENT_NOT_IN_COACH_SCOPE: Client ' + clientId + ' is not in coach ' + coachId + ' canary scope.');
      }

      prevalidationSuccess = true;
    } catch (preErr) {
      errors.push('OCC pre-validation failed: ' + preErr.message);
      return {
        schema: 'vdsen-client-revocation-v1',
        status: 'REVOCATION_INCOMPLETE',
        clientId: clientId,
        operationId: operationId,
        coachId: coachId,
        revokedAt: isoNow,
        reason: reason,
        success: false,
        fencesScopedDisarmed: false,
        ledgerStopped: false,
        ledgerResult: null,
        ledgerError: preErr.message,
        writeAttempts: [], // Zero writes on failed authoritative pre-validation
        readback: {
          numericClientDisabled: false,
          releaseClientRemoved: false,
          coachClientRemoved: false,
          readbackComplete: false
        },
        errors: errors
      };
    }

    // OCC Loop with verified preconditions
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { doc: numDoc, updateTime: numUpdateTime } = attempt === 1
          ? { doc: initialNumDoc, updateTime: initialNumUpdateTime }
          : await io.readFenceWithVersion('releaseControl/numericPilot');
        if (!numUpdateTime) {
          throw new Error('MISSING_VERSION_PRECONDITION: numericPilot updateTime missing.');
        }
        const targetWindow = (numDoc.windows && typeof numDoc.windows === 'object' && numDoc.windows[clientId])
          || (numDoc.uid === clientId ? (numDoc.window || numDoc) : null);
        if (!targetWindow) {
          throw new Error('WINDOW_NOT_FOUND: No authorized window exists for client ' + clientId);
        }

        const updatedWindows = { ...numDoc.windows };
        updatedWindows[clientId] = {
          ...updatedWindows[clientId],
          enabled: false,
          revokedAt: isoNow,
          revokeReason: reason
        };
        await io.writeFenceWithPrecondition('releaseControl/numericPilot', { windows: updatedWindows }, { updateTime: numUpdateTime });
        writeAttempts.push({ fence: 'numericPilot.windows', attempt, success: true });
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          errors.push('OCC numericPilot failed after retries: ' + err.message);
        }
      }
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { doc: relDoc, updateTime: relUpdateTime } = await io.readFenceWithVersion('releaseControl/autonomousProgression');
        if (!relUpdateTime) {
          throw new Error('MISSING_VERSION_PRECONDITION: autonomousProgression updateTime missing.');
        }
        if (relDoc && Array.isArray(relDoc.clientIds)) {
          const remainingIds = relDoc.clientIds.filter(id => id !== clientId);
          await io.writeFenceWithPrecondition('releaseControl/autonomousProgression', { clientIds: remainingIds }, { updateTime: relUpdateTime });
        }
        writeAttempts.push({ fence: 'autonomousProgression', attempt, success: true });
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          errors.push('OCC autonomousProgression failed after retries: ' + err.message);
        }
      }
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { doc: coachDoc, updateTime: coachUpdateTime } = await io.readFenceWithVersion('coaches/' + coachId);
        if (!coachUpdateTime) {
          throw new Error('MISSING_VERSION_PRECONDITION: coach updateTime missing.');
        }
        if (coachDoc && coachDoc.autoApplyCanary && Array.isArray(coachDoc.autoApplyCanary.clientIds)) {
          const remainingCoachIds = coachDoc.autoApplyCanary.clientIds.filter(id => id !== clientId);
          await io.writeFenceWithPrecondition('coaches/' + coachId, { 'autoApplyCanary.clientIds': remainingCoachIds }, { updateTime: coachUpdateTime });
        }
        writeAttempts.push({ fence: 'coachCanary', attempt, success: true });
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          errors.push('OCC coachCanary failed after retries: ' + err.message);
        }
      }
    }

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
    }
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
        numericClientStopped = false;
      }
    } else {
      numericClientStopped = false;
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

  try {
    const opDocPost = await io.readFence('releaseControl/numericPilot/operations/' + operationId);
    if (opDocPost) {
      ledgerStopped = opDocPost.status === 'STOPPED' || opDocPost.status === 'COMPLETED' || opDocPost.status === 'FAILED';
    } else {
      ledgerStopped = false;
    }
  } catch (err) {
    readbackErrors.push('Readback operationsLedger failed: ' + err.message);
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
