'use strict';
/**
 * VDSEN — T699 Phase P0.4 Durable Operations Ledger
 *
 * Provides transactional, atomic reservation and lifecycle auditing of numeric operations
 * against the authoritative path: releaseControl/numericPilot/operations/{operationId}
 *
 * Guarantees:
 * - Precondition of non-existence: atomic rejection of duplicate operationId.
 * - Single-operation bounds: prevents concurrent or replay execution of operationId.
 * - Structured audit: inmutable history log of RESERVED -> COMPLETED / FAILED / STOPPED.
 * - Zero secrets: sanitized evidence recovery.
 *
 * NOTE: Operates strictly against Firebase Emulator or accredited project. Never touch production.
 */

const C = require('../../api/_numericPilotContract');

const LEDGER_SCHEMA = 'vdsen-numeric-operations-ledger-v1';
const OPERATIONS_COLLECTION = 'releaseControl/numericPilot/operations';

function validateOperationData(data) {
  if (!data || typeof data !== 'object') throw new Error('INVALID_OPERATION_DATA: Payload must be an object');
  const { operationId, uid, planId, pid, runtimeSha, deploymentId, runId, window, scope } = data;

  if (!operationId || !/^[A-Za-z0-9-]{8,80}$/.test(operationId)) {
    throw new Error('INVALID_OPERATION_DATA: operationId must be 8-80 alphanumeric/hyphen characters');
  }
  if (!uid || typeof uid !== 'string') throw new Error('INVALID_OPERATION_DATA: uid is required');
  if (uid !== C.UID) throw new Error('UNAUTHORIZED_IDENTIFIER: UID mismatch with numeric pilot contract');
  if (!planId || typeof planId !== 'string') throw new Error('INVALID_OPERATION_DATA: planId is required');
  if (planId !== C.PLAN) throw new Error('UNAUTHORIZED_IDENTIFIER: Plan mismatch with numeric pilot contract');
  if (!pid || typeof pid !== 'string') throw new Error('INVALID_OPERATION_DATA: pid is required');
  if (pid !== C.PID) throw new Error('UNAUTHORIZED_IDENTIFIER: PID mismatch with numeric pilot contract');
  if (!runtimeSha || !/^[a-f0-9]{40}$/.test(runtimeSha)) {
    throw new Error('INVALID_OPERATION_DATA: runtimeSha must be a valid 40-character hex string');
  }
  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new Error('INVALID_OPERATION_DATA: deploymentId is required');
  }
  if (runId === undefined || runId === null) {
    throw new Error('INVALID_OPERATION_DATA: runId is required');
  }
  if (!window || typeof window !== 'object') {
    throw new Error('INVALID_OPERATION_DATA: window is required');
  }
  if (!scope || typeof scope !== 'object' || scope.enabled !== true) {
    throw new Error('INVALID_OPERATION_DATA: scope must be enabled');
  }
  return true;
}

/**
 * Atomically reserves an operationId in Firestore.
 * Rejects with OPERATION_ALREADY_EXISTS if operationId was previously reserved.
 */
async function reserveOperation(db, opData, opts = {}) {
  validateOperationData(opData);
  const nowIso = opts.now || new Date().toISOString();
  const opRef = db.doc(`${OPERATIONS_COLLECTION}/${opData.operationId}`);
  const releaseRef = db.doc('releaseControl/numericPilot');

  return await db.runTransaction(async (tx) => {
    // 1. Verify pilot release gate is active unless explicitly bypassed for testing
    if (opts.bypassReleaseGate !== true) {
      const releaseSnap = await tx.get(releaseRef);
      if (!releaseSnap.exists || releaseSnap.data().enabled !== true) {
        throw new Error('RELEASE_CONTROL_DISARMED: Numeric pilot release control is not enabled');
      }
    }

    // 2. Precondition check: operation must not exist
    const opSnap = await tx.get(opRef);
    if (opSnap.exists) {
      const existing = opSnap.data();
      const err = new Error(`OPERATION_ALREADY_EXISTS: Operation ID "${opData.operationId}" was already reserved at ${existing.reservedAt}`);
      err.code = 'OPERATION_ALREADY_EXISTS';
      err.existingStatus = existing.status;
      throw err;
    }

    // 3. Check window validity at reservation time
    const parsedNow = Date.parse(nowIso);
    if (!C.windowValid(opData.window, parsedNow)) {
      throw new Error('WINDOW_EXPIRED: Authorization window is expired or invalid at reservation time');
    }

    const reservationDoc = {
      schema: LEDGER_SCHEMA,
      contractVersion: opData.window.schema || 'vdsen-numeric-pilot-v1',
      operationId: opData.operationId,
      uid: opData.uid,
      planId: opData.planId,
      pid: opData.pid,
      runtimeSha: opData.runtimeSha,
      deploymentId: opData.deploymentId,
      runId: String(opData.runId),
      window: opData.window,
      scope: opData.scope,
      status: 'RESERVED',
      reservedAt: nowIso,
      history: [
        {
          action: 'RESERVED',
          at: nowIso,
          actor: opts.actor || 'pilot-runner',
          runId: String(opData.runId),
          deploymentId: opData.deploymentId
        }
      ]
    };

    tx.set(opRef, reservationDoc);
    return {
      success: true,
      operationId: opData.operationId,
      status: 'RESERVED',
      reservedAt: nowIso
    };
  });
}

/**
 * Reads an operation from the durable ledger.
 */
async function verifyOperation(db, operationId) {
  if (!operationId) throw new Error('operationId is required');
  const snap = await db.doc(`${OPERATIONS_COLLECTION}/${operationId}`).get();
  if (!snap.exists) {
    return { exists: false, operation: null, status: 'NOT_FOUND' };
  }
  const data = snap.data();
  return { exists: true, operation: data, status: data.status };
}

/**
 * Atomically updates operation status to COMPLETED or FAILED.
 */
async function recordResult(db, operationId, resultData = {}, opts = {}) {
  const opRef = db.doc(`${OPERATIONS_COLLECTION}/${operationId}`);
  const nowIso = opts.now || new Date().toISOString();

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    if (!snap.exists) {
      throw new Error(`OPERATION_NOT_FOUND: Operation "${operationId}" does not exist in ledger`);
    }
    const data = snap.data();
    if (data.status === 'STOPPED') {
      throw new Error(`OPERATION_ALREADY_STOPPED: Operation "${operationId}" was marked STOPPED and cannot be completed`);
    }
    if (data.status === 'COMPLETED') {
      throw new Error(`OPERATION_ALREADY_COMPLETED: Operation "${operationId}" is already completed`);
    }

    const nextStatus = resultData.success ? 'COMPLETED' : 'FAILED';
    const history = Array.isArray(data.history) ? [...data.history] : [];
    history.push({
      action: nextStatus,
      at: nowIso,
      actor: opts.actor || 'pilot-runner',
      summary: resultData.summary || null
    });

    const updatePayload = {
      status: nextStatus,
      completedAt: nowIso,
      resultSummary: resultData.summary || null,
      history: history
    };

    tx.update(opRef, updatePayload);
    return { success: true, operationId, status: nextStatus, completedAt: nowIso };
  });
}

/**
 * Atomically marks an operation as STOPPED.
 */
async function recordStop(db, operationId, stopData = {}, opts = {}) {
  const opRef = db.doc(`${OPERATIONS_COLLECTION}/${operationId}`);
  const nowIso = opts.now || new Date().toISOString();

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    if (!snap.exists) {
      // If operation doc didn't exist yet, create a sentinel STOPPED record
      const stopDoc = {
        schema: LEDGER_SCHEMA,
        operationId: operationId,
        status: 'STOPPED',
        stoppedAt: nowIso,
        stopReason: stopData.reason || 'MANUAL_STOP',
        history: [{ action: 'STOPPED', at: nowIso, actor: opts.actor || 'pilot-stop', reason: stopData.reason }]
      };
      tx.set(opRef, stopDoc);
      return { success: true, operationId, status: 'STOPPED', sentinel: true };
    }

    const data = snap.data();
    const history = Array.isArray(data.history) ? [...data.history] : [];
    history.push({
      action: 'STOPPED',
      at: nowIso,
      actor: opts.actor || 'pilot-stop',
      reason: stopData.reason || 'MANUAL_STOP'
    });

    tx.update(opRef, {
      status: 'STOPPED',
      stoppedAt: nowIso,
      stopReason: stopData.reason || 'MANUAL_STOP',
      history: history
    });

    return { success: true, operationId, status: 'STOPPED', sentinel: false };
  });
}

/**
 * Returns audit trail of an operation.
 */
async function auditRetries(db, operationId) {
  const { exists, operation } = await verifyOperation(db, operationId);
  if (!exists) return [];
  return operation.history || [];
}

/**
 * Returns sanitized, structured evidence of an operation.
 */
async function recoverEvidence(db, operationId) {
  const { exists, operation } = await verifyOperation(db, operationId);
  if (!exists) return null;

  // Sanitize: remove any potential token or sensitive field
  const { operationId: id, status, reservedAt, completedAt, stoppedAt, runtimeSha, deploymentId, runId, history, resultSummary } = operation;
  return {
    operationId: id,
    status,
    reservedAt,
    completedAt: completedAt || null,
    stoppedAt: stoppedAt || null,
    runtimeSha,
    deploymentId,
    runId,
    history: history || [],
    resultSummary: resultSummary || null
  };
}

/**
 * Lists durable operations from the collection.
 */
async function fetchDurableOperations(db, opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : 100;
  let q = db.collection(OPERATIONS_COLLECTION).limit(limit);
  const snap = await q.get();

  return snap.docs.map(doc => {
    const d = doc.data();
    return {
      operationId: d.operationId || doc.id,
      status: d.status,
      reservedAt: d.reservedAt,
      runId: d.runId,
      runtimeSha: d.runtimeSha
    };
  });
}

module.exports = {
  LEDGER_SCHEMA,
  OPERATIONS_COLLECTION,
  validateOperationData,
  reserveOperation,
  verifyOperation,
  recordResult,
  recordStop,
  auditRetries,
  recoverEvidence,
  fetchDurableOperations
};
