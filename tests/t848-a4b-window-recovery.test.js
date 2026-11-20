'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require('../scripts/pilot/ayrton-window.cjs');
const C = require('../scripts/pilot/ayrton-canary.cjs');
const { executeWindowAction, AUTHORIZED_PID } = require('../scripts/pilot/ayrton-window-ops.cjs');

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const OP_ID = 'op-t848-recovery-check';
const RUNTIME_SHA = 'af2629a8e6f9f4473bd583005d5ed2a5f2be9d5f';
const OFF_BASELINE = 'dpl_4H91D85NYxvq4FSaJRvtdzRH3bcT';
const STAGE1_DEPLOYMENT = 'dpl_7voyJqHZSo1vY2rb8dawPwCbWfRK';
const FUTURE_EXP = new Date(Date.now() + 2 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PAST_EXP = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');

function sampleWindow(overrides = {}) {
  return {
    schema: 'vdsen-ayrton-window-v1',
    mode: 'STAGE1_SHADOW',
    pid: AUTHORIZED_PID,
    uid: UID,
    coachId: COACH,
    planId: PLAN,
    runtimeSha: RUNTIME_SHA,
    deployment: STAGE1_DEPLOYMENT,
    expiresAt: FUTURE_EXP,
    operationId: OP_ID,
    ...overrides,
  };
}

function validProbePayload(w = sampleWindow()) {
  return {
    schema: 'vdsen-progression-runtime-v1',
    processingEnabled: true,
    numericApplyEnabled: false,
    cronConfigured: false,
    runtimeSha: w.runtimeSha,
    pilotWindow: {
      uidHash: sha256(w.uid),
      planHash: sha256(w.planId),
      expiresAt: w.expiresAt,
      operationId: w.operationId,
    },
  };
}

function makeMockStore() {
  const enc = x => typeof x === 'string' ? { stringValue: x }
    : typeof x === 'boolean' ? { booleanValue: x }
    : Array.isArray(x) ? { arrayValue: { values: x.map(enc) } }
    : { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, enc(v)])) } };
  let ver = 1;
  const docs = {
    ['clients/' + UID]: { updateTime: '2026-11-20T00:00:00Z', data: { coachId: COACH, activePlanId: PLAN } },
    ['plans/' + PLAN]: { updateTime: '2026-11-20T00:00:00Z', data: { days: [{ exercises: [{ prescriptionExerciseId: AUTHORIZED_PID }] }] } },
    ['coaches/' + COACH]: { updateTime: '2026-11-10T02:34:33.063708Z', data: { autoApplyCanary: { enabled: false, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] } } },
    [C.RELEASE_PATH]: { updateTime: '2026-11-10T02:34:33.063708Z', data: { schema: C.RELEASE_SCHEMA, enabled: false, clientIds: [UID], expiresAt: PAST_EXP } },
  };
  let commits = 0;
  const http = async (method, p, _tok, body) => {
    if (method === 'GET') {
      const d = docs[p];
      if (!d) return { status: 404, body: {} };
      return { status: 200, body: { updateTime: d.updateTime, fields: Object.fromEntries(Object.entries(d.data).map(([k, v]) => [k, enc(v)])) } };
    }
    if (method === 'COMMIT') {
      commits++;
      for (const wr of body.writes) {
        const docPath = wr.update.name.split('/documents/')[1];
        const decoded = C.decDoc(wr.update);
        docs[docPath] = { updateTime: `2026-11-20T12:00:0${ver++}Z`, data: { ...(docs[docPath] ? docs[docPath].data : {}), ...decoded } };
      }
      return { status: 200, body: {} };
    }
    return { status: 400, body: {} };
  };
  return { docs, http, getCommits: () => commits };
}

test('T848.1 ENABLE root cause: per-deployment Vercel SSO redirect falls back safely to verified production alias with before+after alias pinning', async () => {
  const w = sampleWindow();
  const d = {
    id: STAGE1_DEPLOYMENT,
    url: 'vdsen-ecosistema-c15610jp2-vdsenasesoria-svgs-projects.vercel.app',
    projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
    teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
    readyState: 'READY',
    target: 'production',
    meta: { githubCommitSha: RUNTIME_SHA },
  };
  const calls = [];
  let aliasChecks = 0;
  const res = await W.runtimeEvidence(w, {
    assertLegacyRetired: async () => true,
    oidcToken: 'eyJ.secret-oidc-token-never-log.sig',
    deployment: async () => d,
    currentApp: async () => { aliasChecks++; return STAGE1_DEPLOYMENT; },
    fetch: async (url, init) => {
      calls.push({ host: new URL(url).hostname, redirect: init.redirect });
      if (new URL(url).hostname === d.url) {
        const err = new TypeError('fetch failed');
        err.cause = new Error('unexpected redirect');
        throw err;
      }
      assert.equal(new URL(url).hostname, 'vdsen-ecosistema.vercel.app');
      assert.equal(init.redirect, 'error');
      return { status: 200, json: async () => validProbePayload(w) };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].host, d.url);
  assert.equal(calls[1].host, 'vdsen-ecosistema.vercel.app');
  assert.ok(aliasChecks >= 2, 'must verify live alias BEFORE and AFTER probing production origin');
  assert.equal(res.probeTarget, 'production_alias');
  assert.equal(res.flags.numericApplyEnabled, false);
});

test('T848.2 Production alias probe MUST fail closed if alias does not match staged deployment or if alias itself redirects', async () => {
  const w = sampleWindow();
  const d = {
    id: STAGE1_DEPLOYMENT,
    url: 'vdsen-ecosistema-c15610jp2-vdsenasesoria-svgs-projects.vercel.app',
    projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
    teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
    readyState: 'READY',
    target: 'production',
    meta: { githubCommitSha: RUNTIME_SHA },
  };
  let aliasProbed = false;
  await assert.rejects(() => W.runtimeEvidence(w, {
    assertLegacyRetired: async () => true,
    oidcToken: 'eyJ.secret-oidc-token-never-log.sig',
    deployment: async () => d,
    currentApp: async () => OFF_BASELINE,
    fetch: async url => {
      if (new URL(url).hostname === d.url) {
        const err = new TypeError('fetch failed');
        err.cause = new Error('unexpected redirect');
        throw err;
      }
      aliasProbed = true;
      return { status: 200, json: async () => validProbePayload(w) };
    },
  }), /ALIAS_CHANGED/);
  assert.equal(aliasProbed, false, 'must never probe production alias when alias points to another deployment');

  await assert.rejects(() => W.runtimeEvidence(w, {
    assertLegacyRetired: async () => true,
    oidcToken: 'eyJ.secret-oidc-token-never-log.sig',
    deployment: async () => d,
    currentApp: async () => STAGE1_DEPLOYMENT,
    fetch: async () => {
      const err = new TypeError('fetch failed');
      err.cause = new Error('unexpected redirect');
      throw err;
    },
  }), /RUNTIME_PROBE_REDIRECT_BLOCKED/);
});

test('T848.3 Diagnostic fidelity: STOP HTTP 403 IAM rejection produces specific error code, stage, HTTP status, NOT_APPLIED and zero secret leaks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't848-stop-403-'));
  const file = path.join(tmpDir, 'win.json');
  fs.writeFileSync(file, JSON.stringify(sampleWindow()));
  const store = makeMockStore();
  const secretToken = 'ya29.super-secret-gcp-token-never-leak';
  try {
    let caught;
    try {
      await W.main(['--window', file, '--mode', 'stop', '--confirm'], {
        token: () => secretToken,
        operationId: OP_ID,
        http: async (m, p, tok, body) => (m === 'COMMIT' ? { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'Missing datastore.entities.update' } } } : store.http(m, p, tok, body)),
        log() {},
      });
    } catch (e) { caught = e; }
    assert.ok(caught, 'must fail closed on HTTP 403');
    assert.match(caught.message, /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);
    assert.match(caught.message, /FIRESTORE_COMMIT_PERMISSION_DENIED/);
    assert.equal(caught.windowError.code, 'FIRESTORE_COMMIT_PERMISSION_DENIED');
    assert.equal(caught.windowError.stage, 'FIRESTORE_COMMIT');
    assert.equal(caught.windowError.httpStatus, 403);
    assert.equal(caught.windowError.commitOutcome, 'NOT_APPLIED');
    assert.equal(caught.windowError.retryAllowed, false);

    const evidenceText = fs.readFileSync(file + '.evidence.json', 'utf8');
    assert.ok(!evidenceText.includes(secretToken), 'evidence must never leak token');
    const evidence = JSON.parse(evidenceText);
    assert.equal(evidence.failure.code, 'FIRESTORE_COMMIT_PERMISSION_DENIED');
    assert.equal(evidence.failure.stage, 'FIRESTORE_COMMIT');
    assert.equal(evidence.failure.httpStatus, 403);
    assert.equal(evidence.failure.commitOutcome, 'NOT_APPLIED');
    assert.equal(evidence.steps.at(-1).step, 'STOPPED_FAIL_CLOSED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T848.4 Diagnostic fidelity: ENABLE pre-commit probe failure reports RUNTIME_PROBE_BEFORE without writing Firestore; uncertain 503 reports UNCERTAIN without retry', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't848-diag-'));
  const file = path.join(tmpDir, 'win.json');
  fs.writeFileSync(file, JSON.stringify(sampleWindow()));
  const store = makeMockStore();
  try {
    // 4a: Probe HTTP 503 before commit -> zero commits, stage RUNTIME_PROBE_BEFORE
    let errProbe;
    try {
      await W.main(['--window', file, '--mode', 'enable', '--confirm'], {
        token: () => 'tok-never-leak',
        operationId: OP_ID,
        http: store.http,
        runtimeEvidence: async () => {
          const e = new Error('RUNTIME_PROBE_HTTP_503');
          e.windowCode = 'RUNTIME_PROBE_HTTP_503';
          e.httpStatus = 503;
          throw e;
        },
        log() {},
      });
    } catch (e) { errProbe = e; }
    assert.ok(errProbe);
    assert.equal(store.getCommits(), 0);
    assert.equal(errProbe.windowError.code, 'RUNTIME_PROBE_HTTP_503');
    assert.equal(errProbe.windowError.stage, 'RUNTIME_PROBE_BEFORE');
    assert.equal(errProbe.windowError.httpStatus, 503);
    assert.equal(errProbe.windowError.commitOutcome, 'NOT_APPLIED');

    // 4b: Commit HTTP 503 -> UNCERTAIN, no retry, readback recorded
    let commitAttempts = 0;
    let errUncertain;
    try {
      await W.main(['--window', file, '--mode', 'stop', '--confirm'], {
        token: () => 'tok-never-leak',
        operationId: OP_ID,
        http: async (m, p, tok, body) => {
          if (m === 'COMMIT') { commitAttempts++; return { status: 503, body: {} }; }
          return store.http(m, p, tok, body);
        },
        log() {},
      });
    } catch (e) { errUncertain = e; }
    assert.ok(errUncertain);
    assert.equal(commitAttempts, 1, 'never retry uncertain commits');
    assert.equal(errUncertain.windowError.code, 'FIRESTORE_COMMIT_UNCERTAIN_HTTP_503');
    assert.equal(errUncertain.windowError.stage, 'FIRESTORE_COMMIT');
    assert.equal(errUncertain.windowError.httpStatus, 503);
    assert.equal(errUncertain.windowError.commitOutcome, 'UNCERTAIN');
    const ev = JSON.parse(fs.readFileSync(file + '.evidence.json', 'utf8'));
    assert.equal(ev.steps.at(-1).step, 'STOPPED_VERIFY_OR_COMMIT_UNCERTAIN');
    assert.equal(ev.failure.code, 'FIRESTORE_COMMIT_UNCERTAIN_HTTP_503');
    assert.ok(ev.steps.some(s => s.step === 'FENCES_AFTER'), 'must record reconciliation readback');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T848.5 STOP remains independent of AYRTON_WINDOW_RELEASE_ENABLED=false and succeeds without runtime probe', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't848-stop-indep-'));
  const windowFile = path.join(tmpDir, 'win.json');
  const store = makeMockStore();
  store.docs[C.RELEASE_PATH].data.enabled = true;
  store.docs['coaches/' + COACH].data.autoApplyCanary.enabled = true;
  try {
    const res = await executeWindowAction('STOP', {
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
        GITHUB_REF: 'refs/heads/codex/client-app-next',
        GITHUB_WORKFLOW_REF: 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-ayrton-window.yml@refs/heads/codex/client-app-next',
        GITHUB_RUN_ATTEMPT: '1',
        AYRTON_WINDOW_RELEASE_ENABLED: 'false',
        INPUT_ARM_RUN_ID: '44668638994',
        INPUT_UID: UID,
        INPUT_COACH: COACH,
        INPUT_PLAN: PLAN,
        INPUT_PID: AUTHORIZED_PID,
        INPUT_RUNTIME: RUNTIME_SHA,
        INPUT_EXPIRY: FUTURE_EXP,
        INPUT_OPERATION: OP_ID,
        GOOGLE_ACCESS_TOKEN: 'mock-wif-token',
      },
      state: { runtime_sha: RUNTIME_SHA, production_deployment: OFF_BASELINE },
      windowFile,
      gh: () => JSON.stringify({ path: '.github/workflows/vdsen-ayrton-runtime.yml', head_branch: 'codex/client-app-next', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }),
      report: {
        schema: 'vdsen-ayrton-runtime-release-v1',
        operationId: OP_ID,
        runtimeSha: RUNTIME_SHA,
        mode: 'STAGE1_SHADOW',
        pid: AUTHORIZED_PID,
        baseline: { runtimeSha: RUNTIME_SHA, deployment: OFF_BASELINE },
        staged: { id: STAGE1_DEPLOYMENT, url: 'vdsen-ecosistema-c15610jp2-vdsenasesoria-svgs-projects.vercel.app' },
        window: sampleWindow(),
        fencesAfter: { releaseEnabled: false, coachEnabled: false },
        status: 'RUNTIME_READY_FENCES_CLOSED_NOT_ACTIVATED',
      },
      currentApp: async () => STAGE1_DEPLOYMENT,
      deployment: async (_s, id) => ({ id, projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8', target: 'production', readyState: 'READY', meta: { githubCommitSha: RUNTIME_SHA } }),
      runtimeEvidence: async () => { throw new Error('RUNTIME_PROBE_MUST_NOT_RUN_ON_STOP'); },
      http: store.http,
    });
    assert.equal(res.readback.releaseEnabled, false);
    assert.equal(res.readback.coachEnabled, false);
    assert.equal(res.readback.revocationVerified, true);
    assert.equal(store.docs[C.RELEASE_PATH].data.enabled, false);
    assert.equal(store.docs['coaches/' + COACH].data.autoApplyCanary.enabled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
