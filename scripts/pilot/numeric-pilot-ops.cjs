'use strict';
// Coordinator script for the independent VDSEN Numeric Pilot operational lane.
// Provides CLI entrypoints for preflight validation, runtime attestation, STOP execution,
// state consistency auditing, and Firestore fence capture.
// Enforces separate authorization for STOP vs Arming.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const C = require('../../api/_numericPilotContract');
const canary = require('./ayrton-canary.cjs');
const { runPreflight } = require('./numeric-preflight.cjs');
const { attestRuntime } = require('./numeric-attestation.cjs');
const { executeStop, auditMesoConsistency, assertFreshAuthorizationRequired } = require('./numeric-stop-recovery.cjs');

/**
 * Validates the execution environment for GitHub Actions workflows.
 * Separates authorization for STOP from arming/mutating actions.
 * STOP is an emergency safety disarm and is permissible even if the release switch is OFF.
 * @param {object} env - process.env
 * @param {string} [action] - The requested operational action
 */
function invocation(env, action) {
  env = env || process.env;
  action = action || env.INPUT_ACTION || 'preflight-check';

  assert.equal(env.GITHUB_ACTIONS, 'true', 'Must be executed within GitHub Actions environment.');
  assert.equal(env.GITHUB_REPOSITORY, 'vdsenasesoria-svg/vdsen-ecosistema', 'Invalid repository.');
  assert.equal(env.GITHUB_REF, 'refs/heads/codex/client-app-next', 'Must target canonical branch codex/client-app-next.');

  if (action === 'stop') {
    // STOP is an emergency safety disarm action. It does NOT require the activation release switch,
    // and is never blocked by job re-run attempts (retry after network/transient failure is permitted).
    if (env.VDSEN_NUMERIC_PILOT_STOP_ENABLED === 'false') {
      throw new Error('NUMERIC_PILOT_STOP_BLOCKED: STOP authorization explicitly revoked.');
    }
    return { authorized: true, action: 'stop' };
  }

  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'NO_JOB_RERUNS: Reruns are forbidden for numeric operations.');

  if (action === 'arm-fences') {
    throw new Error('ARM_NOT_IMPLEMENTED: Production arming is disabled. Formal owner authorization required.');
  }

  // Read-only actions (preflight-check, audit-status)
  return { authorized: true, action: action };
}

/**
 * Unflattens an object with dotted keys (e.g. {'autoApplyCanary.enabled': false})
 * into a nested object hierarchy (e.g. { autoApplyCanary: { enabled: false } })
 * for valid Firestore REST and SDK nested field paths.
 * @param {object} obj
 * @returns {object}
 */
function unflattenFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let current = result;
      for (let i = 0; i < parts.length - 1; i++) {
        current[parts[i]] = current[parts[i]] || {};
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = unflattenFields(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Creates a standard Firestore emulator I/O adapter using Firebase Admin SDK.
 * Handles nested merge masks and document reads.
 * @param {object} db - Firestore instance
 * @returns {object} I/O adapter with writeFence and readFence
 */
function createEmulatorIo(db) {
  const ledger = require('./numeric-operations-ledger.cjs');
  return {
    writeFence: async (docPath, fields, writeOpts) => {
      const docRef = db.doc(docPath);
      const nested = unflattenFields(fields);
      if (writeOpts && writeOpts.mask) {
        return docRef.set(nested, { mergeFields: writeOpts.mask });
      }
      return docRef.set(nested, { merge: true });
    },
    readFence: async (docPath) => {
      const snap = await db.doc(docPath).get();
      return snap.exists ? snap.data() : null;
    },
    recordStop: async (operationId, stopData) => {
      return ledger.recordStop(db, operationId, stopData);
    }
  };
}

/**
 * Resolves the Firestore REST base URL for the given project.
 * Targets Firestore Emulator when FIRESTORE_EMULATOR_HOST is set;
 * otherwise targets the production Google Cloud Firestore REST API.
 * @param {string} projectId
 * @returns {string}
 */
function getFirestoreRestBaseUrl(projectId) {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return 'http://' + process.env.FIRESTORE_EMULATOR_HOST + '/v1/projects/' + projectId + '/databases/(default)/documents/';
  }
  return 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/';
}

/**
 * Captures live Firestore fences via REST API using Google OAuth2 access token.
 * @param {string} projectId
 * @param {string} token
 * @param {string} coachId
 * @param {Function} [customFetcher]
 * @returns {Promise<object>} Captured fences
 */
async function fetchFencesFromRest(projectId, token, coachId, customFetcher) {
  const fetcher = customFetcher || globalThis.fetch;
  const baseUrl = getFirestoreRestBaseUrl(projectId);
  const read = async (docPath) => {
    const headers = {};
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetcher(baseUrl + docPath, { method: 'GET', headers });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('FIRESTORE_REST_ERROR_' + res.status + '_ON_' + docPath);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return canary.decDoc(json);
  };

  const [releaseControl, numericPilot, coach] = await Promise.all([
    read('releaseControl/autonomousProgression'),
    read('releaseControl/numericPilot'),
    read('coaches/' + coachId)
  ]);

  return { releaseControl, numericPilot, coach };
}

/**
 * Executes STOP using Google OAuth2 access token via Firestore REST API.
 * Uses real HTTP PATCH against Firestore Emulator or Production REST.
 * Supports nested field paths (e.g. updateMask.fieldPaths=autoApplyCanary.enabled).
 * @param {string} projectId
 * @param {string} token
 * @param {object} opts
 * @param {Function} [customFetcher]
 * @returns {Promise<object>} Stop report
 */
async function executeStopRest(projectId, token, opts, customFetcher) {
  const fetcher = customFetcher || globalThis.fetch;
  const baseUrl = getFirestoreRestBaseUrl(projectId);

  const io = {
    writeFence: async (docPath, fields, writeOpts) => {
      const encVal = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
        : Array.isArray(v) ? { arrayValue: { values: v.map(encVal) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encVal(x)])) } };

      const mask = writeOpts && writeOpts.mask ? writeOpts.mask : Object.keys(fields);
      const maskParams = mask.map(m => 'updateMask.fieldPaths=' + encodeURIComponent(m)).join('&');
      const url = baseUrl + docPath + (maskParams ? '?' + maskParams : '');
      const nested = unflattenFields(fields);
      const body = { fields: Object.fromEntries(Object.entries(nested).map(([k, v]) => [k, encVal(v)])) };
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;

      const res = await fetcher(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body)
      });
      if (res.status !== 200) {
        const errText = await res.text();
        throw new Error('WRITE_FENCE_FAILED_' + res.status + '_ON_' + docPath + ' [url=' + url + ']: ' + errText);
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return canary.decDoc(json);
    },
    readFence: async (docPath) => {
      const url = baseUrl + docPath;
      const headers = {};
      if (token) headers.authorization = 'Bearer ' + token;

      const res = await fetcher(url, {
        method: 'GET',
        headers
      });
      if (res.status === 404) return null;
      if (res.status !== 200) {
        const errText = await res.text();
        throw new Error('READ_FENCE_FAILED_' + res.status + '_ON_' + docPath + ' [url=' + url + ']: ' + errText);
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return canary.decDoc(json);
    },
    recordStop: async (operationId, stopData) => {
      const docPath = 'releaseControl/numericPilot/operations/' + operationId;
      const url = baseUrl + docPath;
      const headers = {};
      if (token) headers.authorization = 'Bearer ' + token;

      const encVal = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
        : Array.isArray(v) ? { arrayValue: { values: v.map(encVal) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encVal(x)])) } };

      const checkDurableState = async () => {
        try {
          const vRes = await fetcher(url, { method: 'GET', headers });
          if (vRes.status === 200) {
            const vText = await vRes.text();
            let vJson = null;
            try { vJson = JSON.parse(vText); } catch (_) {}
            const doc = canary.decDoc(vJson);
            if (doc && doc.operationId === operationId) {
              if (doc.status === 'STOPPED') {
                return { success: true, operationId, status: 'STOPPED', sentinel: !doc.runtimeSha, modified: false, verified: true };
              }
              if (doc.status === 'COMPLETED') {
                return { success: true, operationId, status: 'COMPLETED', modified: false, reason: 'ALREADY_COMPLETED', completedAt: doc.completedAt, resultSummary: doc.resultSummary };
              }
              if (doc.status === 'FAILED') {
                return { success: true, operationId, status: 'FAILED', modified: false, reason: 'ALREADY_FAILED', completedAt: doc.completedAt };
              }
            }
          }
        } catch (_) {}
        return null;
      };

      const isConflict = (status, text) => {
        if (status === 409 || status === 412) return true;
        if (typeof text === 'string' && (/FAILED_PRECONDITION/i.test(text) || /ALREADY_EXISTS/i.test(text) || /ABORTED/i.test(text))) return true;
        return false;
      };

      const MAX_RETRIES = 5;
      let attempt = 0;

      while (attempt < MAX_RETRIES) {
        attempt++;
        const nowIso = (stopData && stopData.now) || new Date().toISOString();

        let readRes;
        try {
          readRes = await fetcher(url, { method: 'GET', headers });
        } catch (netErr) {
          const verified = await checkDurableState();
          if (verified) return verified;
          throw new Error('READ_OPERATION_NETWORK_ERROR: ' + netErr.message);
        }

        if (readRes.status === 404) {
          const sentinelDoc = {
            schema: 'vdsen-numeric-operations-ledger-v1',
            operationId: operationId,
            status: 'STOPPED',
            stoppedAt: nowIso,
            stopReason: (stopData && stopData.reason) || 'MANUAL_STOP',
            history: [{ sequence: 1, action: 'STOPPED', at: nowIso, actor: (stopData && stopData.actor) || 'pilot-stop-rest', reason: (stopData && stopData.reason) || 'MANUAL_STOP', previousStatus: null }]
          };
          const body = { fields: Object.fromEntries(Object.entries(sentinelDoc).map(([k, v]) => [k, encVal(v)])) };
          const putUrl = url + '?currentDocument.exists=false';

          let patchRes;
          try {
            patchRes = await fetcher(putUrl, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json', ...headers },
              body: JSON.stringify(body)
            });
          } catch (writeErr) {
            const verified = await checkDurableState();
            if (verified) return verified;
            throw new Error('CREATE_STOP_SENTINEL_NETWORK_ERROR: ' + writeErr.message);
          }

          if (patchRes.status === 200) {
            return { success: true, operationId, status: 'STOPPED', sentinel: true, modified: true };
          }

          const errText = await patchRes.text().catch(() => '');
          if (isConflict(patchRes.status, errText)) {
            // Concurrent creation: retry from fresh GET
            continue;
          }

          const verified = await checkDurableState();
          if (verified) return verified;
          throw new Error('CREATE_STOP_SENTINEL_FAILED_' + patchRes.status + ': ' + errText);
        }

        if (readRes.status !== 200) {
          const errText = await readRes.text().catch(() => '');
          throw new Error('READ_OPERATION_FAILED_' + readRes.status + ': ' + errText);
        }

        const text = await readRes.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        const existing = canary.decDoc(json);
        const updateTime = json && json.updateTime;

        if (existing && existing.status === 'COMPLETED') {
          return { success: true, operationId, status: 'COMPLETED', modified: false, reason: 'ALREADY_COMPLETED', completedAt: existing.completedAt, resultSummary: existing.resultSummary };
        }
        if (existing && existing.status === 'FAILED') {
          return { success: true, operationId, status: 'FAILED', modified: false, reason: 'ALREADY_FAILED', completedAt: existing.completedAt };
        }
        if (existing && existing.status === 'STOPPED') {
          return { success: true, operationId, status: 'STOPPED', modified: false, duplicate: true, stoppedAt: existing.stoppedAt };
        }

        const history = Array.isArray(existing && existing.history) ? [...existing.history] : [];
        history.push({
          sequence: history.length + 1,
          action: 'STOPPED',
          at: nowIso,
          actor: (stopData && stopData.actor) || 'pilot-stop-rest',
          reason: (stopData && stopData.reason) || 'MANUAL_STOP',
          previousStatus: existing ? existing.status : null
        });

        const updateFields = {
          status: 'STOPPED',
          stoppedAt: nowIso,
          stopReason: (stopData && stopData.reason) || 'MANUAL_STOP',
          history: history
        };

        const mask = ['status', 'stoppedAt', 'stopReason', 'history'];
        const maskParams = mask.map(m => 'updateMask.fieldPaths=' + encodeURIComponent(m)).join('&');
        const condParam = updateTime
          ? '&currentDocument.updateTime=' + encodeURIComponent(updateTime)
          : '&currentDocument.exists=true';
        const patchUrl = url + '?' + maskParams + condParam;
        const body = { fields: Object.fromEntries(Object.entries(updateFields).map(([k, v]) => [k, encVal(v)])) };

        let patchRes;
        try {
          patchRes = await fetcher(patchUrl, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body)
          });
        } catch (writeErr) {
          const verified = await checkDurableState();
          if (verified) return verified;
          throw new Error('UPDATE_STOP_NETWORK_ERROR: ' + writeErr.message);
        }

        if (patchRes.status === 200) {
          return { success: true, operationId, status: 'STOPPED', sentinel: false, modified: true };
        }

        const patchErrText = await patchRes.text().catch(() => '');
        if (isConflict(patchRes.status, patchErrText)) {
          // Version conflict: retry from fresh GET to observe new state
          continue;
        }

        const verified = await checkDurableState();
        if (verified) return verified;
        throw new Error('UPDATE_STOP_FAILED_' + patchRes.status + ': ' + patchErrText);
      }

      const finalVerified = await checkDurableState();
      if (finalVerified) return finalVerified;
      throw new Error('STOP_RECORD_FAILED_OCC_CONTENTION_MAX_RETRIES: Document updated concurrently during all attempts.');
    }
  };

  return executeStop(opts, io);
}

/**
 * Executes a verified audit of meso consistency against Firestore or an isolated fixture.
 * Reads logs/{uid}/mesos/{planId}.
 * Emits BLOCKED on missing document, HTTP error, auth failure, or read error.
 * An empty document is NOT evidence of consistency.
 * @param {object} opts
 * @param {string} [opts.pilotUid]
 * @param {string} [opts.planId]
 * @param {string} [opts.file]
 * @param {string} [opts.token]
 * @param {string} [opts.projectId]
 * @param {object} [io]
 * @returns {Promise<object>}
 */
async function executeAuditStatus(opts, io) {
  opts = opts || {};
  const pilotUid = opts.pilotUid || C.UID;
  const planId = opts.planId || C.PLAN;
  const docPath = 'logs/' + pilotUid + '/mesos/' + planId;

  let mesoData = null;

  // 1. If explicit I/O adapter is provided
  if (io && io.readDoc) {
    try {
      mesoData = await io.readDoc(docPath);
      if (mesoData === null || mesoData === undefined) {
        return {
          schema: 'vdsen-numeric-audit-consistency-v1',
          status: 'BLOCKED',
          reason: 'MESO_DOCUMENT_NOT_FOUND',
          path: docPath,
          message: 'Meso document ' + docPath + ' was not found; missing evidence cannot pass audit.',
          isConsistent: false
        };
      }
    } catch (err) {
      return {
        schema: 'vdsen-numeric-audit-consistency-v1',
        status: 'BLOCKED',
        reason: 'MESO_READ_ERROR',
        path: docPath,
        message: 'Failed to read meso document ' + docPath + ': ' + err.message,
        isConsistent: false
      };
    }
  } else if (opts.file) {
    // 2. If reading from file
    if (!fs.existsSync(opts.file)) {
      return {
        schema: 'vdsen-numeric-audit-consistency-v1',
        status: 'BLOCKED',
        reason: 'FILE_NOT_FOUND',
        file: opts.file,
        message: 'Audit file not found: ' + opts.file,
        isConsistent: false
      };
    }
    try {
      mesoData = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    } catch (err) {
      return {
        schema: 'vdsen-numeric-audit-consistency-v1',
        status: 'BLOCKED',
        reason: 'FILE_CORRUPT',
        file: opts.file,
        message: 'Failed to parse audit file: ' + err.message,
        isConsistent: false
      };
    }
  } else if (process.env.FIRESTORE_EMULATOR_HOST || opts.db) {
    // 3. If running with Firestore Emulator
    try {
      let db = opts.db;
      if (!db) {
        const admin = require('firebase-admin');
        const app = admin.apps && admin.apps.length ? admin.apps[0] : admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow' });
        db = app.firestore ? app.firestore() : admin.firestore(app);
      }
      const snap = await db.doc(docPath).get();
      if (!snap.exists) {
        return {
          schema: 'vdsen-numeric-audit-consistency-v1',
          status: 'BLOCKED',
          reason: 'MESO_DOCUMENT_NOT_FOUND',
          path: docPath,
          message: 'Meso document ' + docPath + ' does not exist in emulator; missing evidence cannot pass audit.',
          isConsistent: false
        };
      }
      mesoData = snap.data();
    } catch (err) {
      return {
        schema: 'vdsen-numeric-audit-consistency-v1',
        status: 'BLOCKED',
        reason: 'MESO_READ_ERROR',
        path: docPath,
        message: 'Failed to read meso from emulator: ' + err.message,
        isConsistent: false
      };
    }
  } else {
    // 4. REST mode
    const token = opts.token || process.env.GOOGLE_ACCESS_TOKEN;
    const projectId = opts.projectId || process.env.GCP_PROJECT_ID || 'vdsen-ecosistema';
    if (!token) {
      return {
        schema: 'vdsen-numeric-audit-consistency-v1',
        status: 'BLOCKED',
        reason: 'NO_AUTHENTICATED_ADAPTER',
        message: 'No authenticated Firestore adapter, emulator, or file provided for audit.',
        isConsistent: false
      };
    }

    try {
      const baseUrl = getFirestoreRestBaseUrl(projectId);
      const headers = {};
      if (token) headers.authorization = 'Bearer ' + token;
      const res = await fetch(baseUrl + docPath, { method: 'GET', headers });
      if (res.status === 404) {
        return {
          schema: 'vdsen-numeric-audit-consistency-v1',
          status: 'BLOCKED',
          reason: 'MESO_DOCUMENT_NOT_FOUND',
          path: docPath,
          message: 'Meso document ' + docPath + ' does not exist in project; missing evidence cannot pass audit.',
          isConsistent: false
        };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          schema: 'vdsen-numeric-audit-consistency-v1',
          status: 'BLOCKED',
          reason: 'MESO_AUTH_FAILED',
          path: docPath,
          httpStatus: res.status,
          message: 'Authentication failed querying meso document: HTTP ' + res.status,
          isConsistent: false
        };
      }
      if (res.status !== 200) {
        return {
          schema: 'vdsen-numeric-audit-consistency-v1',
          status: 'BLOCKED',
          reason: 'MESO_FETCH_ERROR',
          path: docPath,
          httpStatus: res.status,
          message: 'Failed to fetch meso document: HTTP ' + res.status,
          isConsistent: false
        };
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      mesoData = canary.decDoc(json);
    } catch (err) {
      return {
        schema: 'vdsen-numeric-audit-consistency-v1',
        status: 'BLOCKED',
        reason: 'MESO_READ_ERROR',
        path: docPath,
        message: 'Network or adapter error reading meso document: ' + err.message,
        isConsistent: false
      };
    }
  }

  // An empty document does not constitute evidence of consistency
  if (!mesoData || typeof mesoData !== 'object' || Object.keys(mesoData).length === 0) {
    return {
      schema: 'vdsen-numeric-audit-consistency-v1',
      status: 'BLOCKED',
      reason: 'MESO_DOCUMENT_EMPTY',
      path: docPath,
      message: 'Meso document is empty; an empty document is not evidence of consistency.',
      isConsistent: false
    };
  }

  const report = auditMesoConsistency(mesoData);
  report.status = report.isConsistent ? 'AUDIT_SUCCESS' : 'AUDIT_INCONSISTENT';
  report.path = docPath;
  return report;
}

function getArg(args, name, fallback = null) {
  const i = args.indexOf(name);
  return (i !== -1 && i + 1 < args.length) ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  if (command === 'invocation') {
    const action = args[1] || process.env.INPUT_ACTION || 'preflight-check';
    const inv = invocation(process.env, action);
    console.log(JSON.stringify(inv));
    return;
  }

  if (command === 'fetch-fences') {
    const coachId = getArg(args, '--coach-id', 'coach-ayrton');
    const outFile = getArg(args, '--out', 'release-output/fences.json');
    const token = process.env.GOOGLE_ACCESS_TOKEN;
    const projectId = process.env.GCP_PROJECT_ID || 'vdsen-ecosistema';

    if (!token) {
      console.error(JSON.stringify({ status: 'BLOCKED', reason: 'GOOGLE_ACCESS_TOKEN_MISSING' }));
      process.exit(1);
    }

    try {
      const fences = await fetchFencesFromRest(projectId, token, coachId);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(fences, null, 2));
      console.log(JSON.stringify({ status: 'FENCES_CAPTURED', outFile }));
      return;
    } catch (err) {
      console.error(JSON.stringify({ status: 'BLOCKED', reason: 'FENCE_FETCH_FAILED', message: err.message }));
      process.exit(1);
    }
  }

  if (command === 'preflight') {
    const windowFile = getArg(args, '--window-file');
    const deploymentId = getArg(args, '--deployment');
    const expectedAlias = getArg(args, '--expected-alias', 'vdsen-ecosistema.vercel.app');
    const currentRunId = getArg(args, '--current-run', process.env.GITHUB_RUN_ID);
    const fencesFile = getArg(args, '--fences-file');
    const runsFile = getArg(args, '--runs-file');
    const priorFile = getArg(args, '--prior-file');
    const outFile = getArg(args, '--out');

    let windowData = null;
    if (windowFile && fs.existsSync(windowFile)) {
      windowData = JSON.parse(fs.readFileSync(windowFile, 'utf8'));
    }

    let fencesData = null;
    if (fencesFile && fs.existsSync(fencesFile)) {
      fencesData = JSON.parse(fs.readFileSync(fencesFile, 'utf8'));
    }

    let activeRuns = null;
    if (runsFile && fs.existsSync(runsFile)) {
      const parsedRuns = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
      activeRuns = Array.isArray(parsedRuns) ? parsedRuns : (parsedRuns.workflow_runs || []);
    }

    let priorOperations = null;
    let priorOperationsSourceVerified = false;
    let priorOperationsCoverageComplete = false;

    if (priorFile && fs.existsSync(priorFile)) {
      try {
        const parsedPrior = JSON.parse(fs.readFileSync(priorFile, 'utf8'));
        // Any external or local JSON file (including GitHub Actions /runs or files claiming verifiedCoverage)
        // is insufficient to attest durable uniqueness in the absence of an authoritative online or cryptographically verified ledger.
        priorOperations = Array.isArray(parsedPrior) ? parsedPrior : (Array.isArray(parsedPrior.operations) ? parsedPrior.operations : []);
        priorOperationsSourceVerified = false;
        priorOperationsCoverageComplete = false;
      } catch (_) {
        priorOperations = [];
        priorOperationsSourceVerified = false;
        priorOperationsCoverageComplete = false;
      }
    }

    let ledgerDb = null;
    let isEmulator = false;
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      try {
        const admin = require('firebase-admin');
        const app = admin.apps && admin.apps.length ? admin.apps[0] : admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow' });
        ledgerDb = app.firestore ? app.firestore() : admin.firestore(app);
        isEmulator = true;
      } catch (_) {}
    }

    const result = await runPreflight({
      window: windowData,
      deploymentId: deploymentId,
      expectedAlias: expectedAlias,
      fences: fencesData,
      activeRuns: activeRuns,
      currentRunId: currentRunId,
      priorOperations: priorOperations !== null ? priorOperations : undefined,
      priorOperationsSourceVerified: priorOperationsSourceVerified,
      priorOperationsCoverageComplete: priorOperationsCoverageComplete,
      token: process.env.GOOGLE_ACCESS_TOKEN,
      projectId: process.env.GCP_PROJECT_ID || 'vdsen-ecosistema',
      ledgerDb: ledgerDb,
      isEmulator: isEmulator,
      readOnly: true
    });

    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    }

    console.log(JSON.stringify(result, null, 2));
    if (result.decision !== 'GO') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'attest') {
    const deploymentId = getArg(args, '--deployment');
    const sha = getArg(args, '--sha');
    const opId = getArg(args, '--operation-id');
    const expectedAlias = getArg(args, '--expected-alias', 'vdsen-ecosistema.vercel.app');
    const outFile = getArg(args, '--out');

    const result = await attestRuntime({
      deploymentId,
      expectedSha: sha,
      expectedOperationId: opId,
      expectedAlias: expectedAlias
    });

    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    }

    console.log(JSON.stringify(result, null, 2));
    if (!result.attested) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'stop') {
    const coachId = getArg(args, '--coach-id', 'coach-ayrton');
    const operationId = getArg(args, '--operation-id', 'STOP_CLI_' + Date.now());
    const reason = getArg(args, '--reason', 'OPERATOR_STOP_CLI');
    const outFile = getArg(args, '--out', 'release-output/stop-evidence.json');

    // 1. Google OAuth2 token REST mode (GitHub Actions with WIF)
    const token = process.env.GOOGLE_ACCESS_TOKEN;
    const projectId = process.env.GCP_PROJECT_ID || 'vdsen-ecosistema';
    if (token) {
      const rep = await executeStopRest(projectId, token, { coachId, operationId, reason });
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(rep, null, 2));
      console.log(JSON.stringify(rep, null, 2));
      if (!rep.allDisarmed) process.exitCode = 1;
      return;
    }

    // 2. Emulator mode (Local test / synthetic runs)
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      const admin = require('firebase-admin');
      const app = admin.apps && admin.apps.length ? admin.apps[0] : admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow' });
      const db = app.firestore ? app.firestore() : admin.firestore(app);
      const io = createEmulatorIo(db);
      const rep = await executeStop({ coachId, operationId, reason }, io);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(rep, null, 2));
      console.log(JSON.stringify(rep, null, 2));
      if (!rep.allDisarmed) process.exitCode = 1;
      return;
    }

    console.error(JSON.stringify({ status: 'BLOCKED', reason: 'NO_AUTHENTICATED_ADAPTER' }));
    process.exit(1);
  }

  if (command === 'audit') {
    const file = getArg(args, '--file');
    const pilotUid = getArg(args, '--pilot-uid', C.UID);
    const planId = getArg(args, '--plan-id', C.PLAN);
    const outFile = getArg(args, '--out', 'release-output/numeric-pilot/audit-status.json');

    const rep = await executeAuditStatus({ file, pilotUid, planId });
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(rep, null, 2));
    }
    console.log(JSON.stringify(rep, null, 2));
    if (rep.status === 'BLOCKED' || !rep.isConsistent) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'help') {
    console.log('Usage: node scripts/pilot/numeric-pilot-ops.cjs <invocation|fetch-fences|preflight|attest|stop|audit>');
    return;
  }

  console.error('Unknown command: ' + command);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Operational error: ' + err.message);
    process.exit(1);
  });
}

module.exports = {
  invocation,
  fetchFencesFromRest,
  executeStopRest,
  executeAuditStatus,
  createEmulatorIo,
  getFirestoreRestBaseUrl,
  unflattenFields,
  runPreflight,
  attestRuntime,
  executeStop,
  auditMesoConsistency,
  assertFreshAuthorizationRequired
};
