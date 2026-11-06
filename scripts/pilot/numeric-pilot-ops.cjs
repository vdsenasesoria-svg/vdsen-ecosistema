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
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'NO_JOB_RERUNS: Reruns are forbidden for numeric operations.');

  if (action === 'stop') {
    // STOP is an emergency safety disarm action. It does NOT require the activation release switch.
    // It requires that STOP is not explicitly blocked by operator.
    if (env.VDSEN_NUMERIC_PILOT_STOP_ENABLED === 'false') {
      throw new Error('NUMERIC_PILOT_STOP_BLOCKED: STOP authorization explicitly revoked.');
    }
    return { authorized: true, action: 'stop' };
  }

  if (action === 'arm-fences') {
    throw new Error('ARM_NOT_IMPLEMENTED: Production arming is disabled. Formal owner authorization required.');
  }

  // Read-only actions (preflight-check, audit-status)
  return { authorized: true, action: action };
}

/**
 * Captures live Firestore fences via REST API using Google OAuth2 access token.
 * @param {string} projectId
 * @param {string} token
 * @param {string} coachId
 * @returns {Promise<object>} Captured fences
 */
async function fetchFencesFromRest(projectId, token, coachId) {
  const read = async (docPath) => {
    const res = await canary.http('GET', 'projects/' + projectId + '/databases/(default)/documents/' + docPath, token);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('FIRESTORE_REST_ERROR_' + res.status + '_ON_' + docPath);
    return canary.decDoc(res.body);
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
 * @param {string} projectId
 * @param {string} token
 * @param {object} opts
 * @returns {Promise<object>} Stop report
 */
async function executeStopRest(projectId, token, opts) {
  const io = {
    writeFence: async (docPath, fields, writeOpts) => {
      // Use Firestore patch or documents:commit with preconditions
      const encVal = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
        : Array.isArray(v) ? { arrayValue: { values: v.map(encVal) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encVal(x)])) } };

      const mask = writeOpts && writeOpts.mask ? writeOpts.mask : Object.keys(fields);
      const maskParams = mask.map(m => 'updateMask.fieldPaths=' + encodeURIComponent(m)).join('&');
      const url = 'projects/' + projectId + '/databases/(default)/documents/' + docPath + (maskParams ? '?' + maskParams : '');
      const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encVal(v)])) };
      const res = await canary.http('PATCH', url, token, body);
      if (res.status !== 200) throw new Error('WRITE_FENCE_FAILED_' + res.status + '_ON_' + docPath);
      return canary.decDoc(res.body);
    },
    readFence: async (docPath) => {
      const res = await canary.http('GET', 'projects/' + projectId + '/databases/(default)/documents/' + docPath, token);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error('READ_FENCE_FAILED_' + res.status + '_ON_' + docPath);
      return canary.decDoc(res.body);
    }
  };

  return executeStop(opts, io);
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
    const coachId = args[args.indexOf('--coach-id') + 1] || 'coach-ayrton';
    const outFile = args[args.indexOf('--out') + 1] || 'release-output/fences.json';
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
    const windowFile = args[args.indexOf('--window-file') + 1];
    const deploymentId = args[args.indexOf('--deployment') + 1] || null;
    const expectedAlias = args[args.indexOf('--expected-alias') + 1] || 'vdsen-ecosistema.vercel.app';
    const currentRunId = args[args.indexOf('--current-run') + 1] || process.env.GITHUB_RUN_ID || null;
    const fencesFile = args[args.indexOf('--fences-file') + 1];
    const runsFile = args[args.indexOf('--runs-file') + 1];
    const priorFile = args[args.indexOf('--prior-file') + 1];
    const outFile = args[args.indexOf('--out') + 1];

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
    if (priorFile && fs.existsSync(priorFile)) {
      const parsedPrior = JSON.parse(fs.readFileSync(priorFile, 'utf8'));
      if (Array.isArray(parsedPrior)) {
        priorOperations = parsedPrior;
        priorOperationsSourceVerified = true;
      } else if (parsedPrior && Array.isArray(parsedPrior.workflow_runs)) {
        priorOperations = parsedPrior.workflow_runs.map(r => {
          const title = r.display_title || r.name || '';
          const opMatch = title.match(/([a-zA-Z0-9_-]{8,80})/);
          return {
            operationId: opMatch ? opMatch[1] : title,
            runId: String(r.id),
            runtimeSha: r.head_sha,
            status: r.status,
            conclusion: r.conclusion,
            date: r.created_at || r.updated_at,
            scope: 'numeric-pilot'
          };
        });
        priorOperationsSourceVerified = true;
      }
    }

    const result = await runPreflight({
      window: windowData,
      deploymentId: deploymentId,
      expectedAlias: expectedAlias,
      fences: fencesData,
      activeRuns: activeRuns,
      currentRunId: currentRunId,
      priorOperations: priorOperations,
      priorOperationsSourceVerified: priorOperationsSourceVerified,
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
    const deploymentId = args[args.indexOf('--deployment') + 1];
    const sha = args[args.indexOf('--sha') + 1];
    const opId = args[args.indexOf('--operation-id') + 1];
    const expectedAlias = args[args.indexOf('--expected-alias') + 1] || 'vdsen-ecosistema.vercel.app';
    const outFile = args[args.indexOf('--out') + 1];

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
    const coachId = args[args.indexOf('--coach-id') + 1] || 'coach-ayrton';
    const operationId = args[args.indexOf('--operation-id') + 1] || 'STOP_CLI_' + Date.now();
    const reason = args[args.indexOf('--reason') + 1] || 'OPERATOR_STOP_CLI';
    const outFile = args[args.indexOf('--out') + 1] || 'release-output/stop-evidence.json';

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
      const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow' });
      const db = admin.firestore(app);
      const io = {
        writeFence: async (docPath, fields, opts) => {
          return db.doc(docPath).set(fields, opts || { merge: true });
        },
        readFence: async (docPath) => {
          const snap = await db.doc(docPath).get();
          return snap.exists ? snap.data() : null;
        }
      };
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
    const file = args[args.indexOf('--file') + 1];
    const pilotUid = args[args.indexOf('--pilot-uid') + 1] || C.UID;
    const planId = args[args.indexOf('--plan-id') + 1] || C.PLAN;
    const outFile = args[args.indexOf('--out') + 1] || 'release-output/numeric-pilot/audit-status.json';

    let mesoData = null;
    if (file && fs.existsSync(file)) {
      mesoData = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      const token = process.env.GOOGLE_ACCESS_TOKEN;
      const projectId = process.env.GCP_PROJECT_ID || 'vdsen-ecosistema';
      if (token) {
        try {
          const docPath = 'users/' + pilotUid + '/mesos/' + planId;
          const res = await canary.http('GET', 'projects/' + projectId + '/databases/(default)/documents/' + docPath, token);
          if (res.status === 200) {
            mesoData = canary.decDoc(res.body);
          } else {
            console.warn('Could not read meso document ' + docPath + ': HTTP ' + res.status);
            mesoData = {};
          }
        } catch (e) {
          console.warn('Meso read error: ' + e.message);
          mesoData = {};
        }
      } else {
        mesoData = {};
      }
    }

    const rep = auditMesoConsistency(mesoData);
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(rep, null, 2));
    }
    console.log(JSON.stringify(rep, null, 2));
    if (!rep.isConsistent) process.exitCode = 1;
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
  runPreflight,
  attestRuntime,
  executeStop,
  auditMesoConsistency,
  assertFreshAuthorizationRequired
};
