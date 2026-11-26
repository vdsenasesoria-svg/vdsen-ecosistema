'use strict';
// T878 — Mandatory VDSEN Progression Engine Integration for All New Routines.
// Covers:
//   1. All 7 Coach plan creation / import / template / duplicate / AI-draft paths
//   2. App Cliente 6-state progression display (including authorization pending/blocked)
//   3. App Coach Monitor supervision summary (APPLIED / CONSUMED / PENDING / COACH_REVIEW / STALE)
//   4. Plan-change drift detection (detectPlanChangeDrift) & fail-closed commercial boundary (25 active)
//   5. Targeted single-cohort renewal (renewDriftedCohort) without interrupting unaffected cohorts
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const COACH_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');
const CLIENT_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-cliente.html'), 'utf8');
const effective = require(path.join(ROOT, 'assets/progression-effective-prescription.js'));
const C = require(path.join(ROOT, 'api/_numericPilotContract.js'));
const ops = require(path.join(ROOT, 'scripts/pilot/numeric-cohort-ops.cjs'));

function extractFn(src, sig) {
  const start = src.indexOf(sig);
  assert.ok(start !== -1, 'Function not found: ' + sig);
  const braceStart = src.indexOf('{', start);
  let depth = 0, inStr = null, esc = false;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (ch === '\\') esc = true; else if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('Unbalanced braces for: ' + sig);
}

test('T878.1 — All 7 Coach creation/import/template/duplicate/AI-draft paths enforce ISO updatedAt, unique PIDs, and activation traceability', () => {
  const assignTxn = extractFn(COACH_HTML, 'async function _assignPlanTxn(o)');
  assert.match(assignTxn, /nowIso = new Date\(\)\.toISOString\(\)/, '_assignPlanTxn must mint ISO activation timestamp');
  assert.match(assignTxn, /tx\.set\(planRef, o\.buildPlanDoc\(planId, nowIso\)\)/, '_assignPlanTxn must write plan atomically in transaction');
  assert.match(assignTxn, /plan_activations/, '_assignPlanTxn must support authoritative plan_activations traceability');
  assert.match(assignTxn, /_initNewPlanWeekOne/, '_assignPlanTxn must initialize new plan Week 1 logbook isolation');

  // template-assign must restamp PIDs (never inherit cross-client PIDs) and include rirByWeek
  const tplAssignIdx = COACH_HTML.indexOf("kind: 'template-assign'");
  assert.ok(tplAssignIdx !== -1, 'template-assign route must exist');
  const tplAssignSlice = COACH_HTML.slice(tplAssignIdx, tplAssignIdx + 650);
  assert.match(tplAssignSlice, /_restampPrescriptionIds\(days\)/, 'template-assign must restamp unique PIDs');
  assert.match(tplAssignSlice, /rirByWeek:\s*rirSchemeForWeeks/, 'template-assign must stamp canonical rirByWeek');
  assert.match(tplAssignSlice, /updatedAt:\s*_nowIso/, 'template-assign must stamp ISO updatedAt');

  // _vdsenActivatePlanInFirestore preserves immutable plans/{planId} (T546.P) and initializes Week 1 logbook
  const aiActivate = extractFn(COACH_HTML, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');
  assert.match(aiActivate, /plan_activations/);
  assert.match(aiActivate, /_initNewPlanWeekOne/);
  assert.doesNotMatch(aiActivate, /t\.(set|update)\(planRef/);

  // Verify all 6 _assignPlanTxn kinds exist and every single one stamps createdAt + updatedAt + PIDs
  for (const kind of ['import', 'manual', 'template-client', 'duplicate', 'template-assign', 'duplicate-to-client']) {
    const idx = COACH_HTML.indexOf("kind: '" + kind + "'");
    assert.ok(idx !== -1, 'Missing _assignPlanTxn route: ' + kind);
    const slice = COACH_HTML.slice(idx, idx + 900);
    assert.match(slice, /_(re)?stamp(Import)?PrescriptionIds\(/, kind + ' must stamp unique PIDs');
    assert.match(slice, /createdAt:\s*_nowIso/, kind + ' must stamp ISO createdAt');
    assert.match(slice, /updatedAt:\s*_nowIso/, kind + ' must stamp ISO updatedAt');
  }
});

test('T878.2 — App Cliente renders all 6 required progression states clearly without breaking T599/T601', () => {
  const ruleReasonSrc = extractFn(CLIENT_HTML, 'function _ruleReason(ruleId)');
  const authHtmlSrc = extractFn(CLIENT_HTML, 'function _seriesAuthorityHtml(view, si)');
  const sandbox = {
    _escHTml: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _fmtLoadForUi: v => String(v),
  };
  vm.runInNewContext(ruleReasonSrc + '\n' + authHtmlSrc + '\nthis._seriesAuthorityHtml = _seriesAuthorityHtml;', sandbox);
  const render = sandbox._seriesAuthorityHtml;

  // 1. Sin evidencia suficiente / sin ajuste
  const hNone = render(null, 0);
  assert.match(hNone, /data-progression-state="NO_AUTHORIZED_ADJUSTMENT"/);
  assert.match(hNone, /Sin autoajuste aplicado/);

  const hInsuff = render({ state: 'BLOCKED', applied: false, reasons: ['EVIDENCE_COUNT_INSUFFICIENT'] }, 0);
  assert.match(hInsuff, /data-progression-state="BLOCKED"/);
  assert.match(hInsuff, /Faltan exposiciones comparables/);

  // 2. Evaluación pendiente
  const hPend = render({ state: 'PENDING', applied: false, reasons: [] }, 0);
  assert.match(hPend, /data-progression-state="PENDING"/);
  assert.match(hPend, /PENDIENTE/);

  // 3. Autoajuste aplicado
  const hApp = render({
    state: 'APPLIED', applied: true, ruleId: 'A', unit: 'KG',
    baseSets: [{ repsTarget: '8-10', rirTarget: 2, restSeconds: 120 }],
    result: {
      dimension: 'LOAD', previousValue: 80, appliedValue: 82.5,
      presentation: { text: 'Autoajuste VDSEN: 80 → 82.5 KG' },
      sets: [{ effective: { load: 82.5, repsTarget: '8-10', rirTarget: 2, restSeconds: 120 } }],
    },
  }, 0);
  assert.match(hApp, /data-progression-state="APPLIED"/);
  assert.match(hApp, /AUTOAJUSTE APLICADO/);
  assert.match(hApp, /80 KG → 82\.5 KG/);

  // 4. Autoajuste consumido
  const hCons = render({
    state: 'CONSUMED', applied: true, ruleId: 'A', unit: 'KG',
    baseSets: [{ repsTarget: '8-10', rirTarget: 2, restSeconds: 120 }],
    result: {
      dimension: null, carried: { LOAD: { value: 82.5, unit: 'KG' } },
      presentation: { text: 'Vigente: 82.5 KG' },
      sets: [{ effective: { load: 82.5, repsTarget: '8-10', rirTarget: 2, restSeconds: 120 } }],
    },
  }, 0);
  assert.match(hCons, /data-progression-state="CONSUMED"/);
  assert.match(hCons, /AUTOAJUSTE CONSUMIDO/);

  // 5. Revisión requerida
  const hRev = render({ state: 'COACH_REVIEW', applied: false, reasons: ['SAFETY_CONFLICT'] }, 0);
  assert.match(hRev, /data-progression-state="COACH_REVIEW"/);
  assert.match(hRev, /REVISIÓN REQUERIDA/);

  // 6. Autorización pendiente o bloqueada
  const hAuthBlocked = render({ state: 'BLOCKED', applied: false, reasons: ['NUMERIC_PILOT_NOT_AUTHORIZED'] }, 0);
  assert.match(hAuthBlocked, /data-progression-state="BLOCKED"/);
  assert.match(hAuthBlocked, /Autorización del motor pendiente o bloqueada/);
});

test('T878.3 — App Coach Monitor renders engine supervision summary with live state counts', () => {
  const shadowFeedSrc = extractFn(COACH_HTML, 'function _renderShadowAutoFeed(summary, dryRuns)');
  const sandbox = {
    _LIFECYCLE_LABEL: { APPLIED: 'APLICADA', CONSUMED: 'CONSUMIDA', PENDING: 'PENDIENTE', STALE: 'OBSOLETA', REJECTED: 'RECHAZADA' },
    _escH: s => String(s ?? ''),
    _shadowAuditLines: () => '',
    _lifecycleLines: () => '',
    _renderShadowMagnitude: () => '',
    _dryRunLine: () => '',
  };
  vm.runInNewContext(shadowFeedSrc + '\nthis._renderShadowAutoFeed = _renderShadowAutoFeed;', sandbox);
  const html = sandbox._renderShadowAutoFeed({
    autoCount: 5,
    items: [
      { key: 'v1_0000000000000001', revision: 1, state: 'APPLIED', dimension: 'LOAD', exerciseNameSnapshot: 'Press banca' },
      { key: 'v1_0000000000000002', revision: 2, state: 'CONSUMED', dimension: 'REPS', exerciseNameSnapshot: 'Remo' },
      { key: 'v1_0000000000000003', revision: 1, state: 'PENDING', dimension: 'REST', exerciseNameSnapshot: 'Sentadilla' },
      { key: 'v1_0000000000000004', revision: 1, state: 'PENDING', dimension: 'LOAD', exerciseNameSnapshot: 'Peso muerto', magnitude: { coachReviewRequired: { branch: 'SAFETY' } } },
      { key: 'v1_0000000000000005', revision: 1, state: 'STALE', reasonCode: 'PLAN_CHANGED', dimension: 'LOAD', exerciseNameSnapshot: 'Curl' },
    ],
  }, {});
  assert.match(html, /data-coach-engine-summary="true"/);
  assert.match(html, /Aplicados: 1 · Consumidos: 1 · Pendientes: 2 · Revisión Coach: 1 · Obsoletos\/Cambio de plan: 1/);
});

function makeMockRosterEnv(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t878-'));
  const activeUids = [];
  for (let i = 1; i <= 25; i++) activeUids.push('active_client_' + String(i).padStart(2, '0'));
  const inactiveUids = ['inactive_client_01', 'inactive_client_02', 'inactive_client_03', 'inactive_client_04'];
  const unconfirmedUids = ['unconfirmed_client_01', 'unconfirmed_client_02'];
  const rosterPath = path.join(tmpDir, 'roster.json');
  fs.writeFileSync(rosterPath, JSON.stringify({
    schema: 'vdsen-commercial-roster-v1',
    task: 'T876',
    firebaseProject: 'vdsen-ecosistema',
    confirmedAt: '2026-11-24T00:00:00Z',
    confirmedBy: 'owner',
    activeUids,
    inactiveUids,
  }));

  const runtimeSha = 'b6c4b86d48e473950a7ad19486c380b7b52ddc9f';
  const opId = 't876-prod-2026-11-25';
  const startsAt = '2026-11-25T00:00:00Z';
  const expiresAt = '2026-12-23T03:20:00Z';
  const coachId = 'coach_owner_1';
  const deploymentId = 'dpl_9RWRuWiqoc2objP6VYA4wPySZR89';

  const docs = new Map();
  const addDoc = (docPath, obj) => docs.set(docPath, { name: 'projects/vdsen-ecosistema/databases/(default)/documents/' + docPath, fields: ops.toFsFields(obj) });

  const clientsByCohort = [[], [], []];
  activeUids.forEach((uid, idx) => {
    const cIdx = idx < 10 ? 0 : idx < 20 ? 1 : 2;
    const isDrifted = opts.driftedUid === uid;
    const planId = isDrifted ? ('plan_v2_' + uid) : ('plan_v1_' + uid);
    const pids = isDrifted ? ['pid_' + uid + '_new_1', 'pid_' + uid + '_new_2'] : ['pid_' + uid + '_1', 'pid_' + uid + '_2'];
    const planDoc = {
      clientId: uid, coachId, status: 'active',
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: (isDrifted && opts.missingUpdatedAt) ? null : '2026-11-25T10:00:00Z',
      days: [{ dayIndex: 0, exercises: pids.map((pid, k) => ({ exerciseName: 'Ex ' + k, prescriptionExerciseId: pid })) }],
    };
    addDoc('clients/' + uid, { uid, coachId, status: 'active', activePlanId: planId });
    addDoc('plans/' + planId, planDoc);
    clientsByCohort[cIdx].push({
      uid,
      armedPlanId: 'plan_v1_' + uid,
      armedPids: ['pid_' + uid + '_1', 'pid_' + uid + '_2'],
      livePlanId: planId,
      livePids: pids,
    });
  });

  // Inactive & unconfirmed clients with active plans — must NEVER be included
  for (const uid of [...inactiveUids, ...unconfirmedUids]) {
    addDoc('clients/' + uid, { uid, coachId, status: 'active', activePlanId: 'plan_' + uid });
    addDoc('plans/plan_' + uid, {
      clientId: uid, coachId, status: 'active',
      createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-25T10:00:00Z',
      days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Ex', prescriptionExerciseId: 'pid_' + uid }] }],
    });
  }

  // Armed fences for cohort-01, cohort-02, cohort-03 reflecting v1 plans
  const coachCohorts = {};
  clientsByCohort.forEach((list, idx) => {
    const cid = 'cohort-0' + (idx + 1);
    const windows = {};
    const allPids = [];
    for (const c of list) {
      windows[c.uid] = {
        enabled: true, uid: c.uid, planId: c.armedPlanId,
        pids: c.armedPids, pidCount: c.armedPids.length,
        pidsHash: C.computePidsHash(c.armedPids),
        runtimeSha, operationId: opId, startsAt, expiresAt,
      };
      allPids.push(...c.armedPids);
    }
    addDoc('releaseControl/autonomousProgression_cohort_' + cid, {
      enabled: true, cohortId: cid, operationId: opId, startsAt, expiresAt,
      clientIds: list.map(c => c.uid),
    });
    addDoc('releaseControl/numericPilot_cohort_' + cid, {
      enabled: true, cohortId: cid, operationId: opId, runtimeSha, startsAt, expiresAt,
      windows,
    });
    coachCohorts[cid] = {
      enabled: true, cohortId: cid, operationId: opId, startsAt, expiresAt,
      clientIds: list.map(c => c.uid),
      prescriptionExerciseIds: allPids.sort(),
    };
  });
  addDoc('coaches/' + coachId, { autoApplyCanary: { enabled: true, cohorts: coachCohorts } });

  const mkRes = (status, obj) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  const writtenDocPaths = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    // Vercel deployment + alias + env checks (for preflightCohort / armCohort)
    if (u.includes('api.vercel.com/v13/deployments/')) {
      return mkRes(200, {
        id: deploymentId,
        projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
        teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
        readyState: 'READY',
        target: 'production',
        alias: ['vdsen-ecosistema.vercel.app'],
        meta: { githubCommitSha: runtimeSha },
        env: [
          'AUTONOMOUS_PROGRESSION_ENABLED',
          'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED',
          'VDSEN_NUMERIC_PILOT_ENABLED',
          'VDSEN_NUMERIC_PILOT_RUNTIME_SHA',
          'VDSEN_NUMERIC_COHORT_1', 'VDSEN_NUMERIC_COHORT_2', 'VDSEN_NUMERIC_COHORT_3',
          'VDSEN_NUMERIC_COHORT_4', 'VDSEN_NUMERIC_COHORT_5',
        ],
      });
    }
    if (u.includes('api.vercel.com/v2/aliases/')) {
      return mkRes(200, { deploymentId });
    }
    if (u.includes('api.vercel.com/v10/projects/') && u.includes('/env')) {
      return mkRes(200, {
        envs: [
          { key: 'NUMERIC_APPLY_ENABLED', target: ['production'], value: 'false' },
          { key: 'VDSEN_NUMERIC_COHORT_1', target: ['production'], value: '{}' },
        ],
      });
    }
    if (u.includes(':commit')) {
      const body = JSON.parse(init.body);
      for (const w of body.writes || []) {
        if (w.update && w.update.name) {
          const p = w.update.name.split('/documents/')[1];
          writtenDocPaths.push(p);
          if (w.updateMask && Array.isArray(w.updateMask.fieldPaths) && docs.has(p)) {
            const cur = docs.get(p);
            const existing = {};
            for (const [k, v] of Object.entries(cur.fields || {})) existing[k] = v;
            const merged = Object.assign({}, existing, w.update.fields);
            if (p === 'coaches/' + coachId && existing.autoApplyCanary && w.update.fields.autoApplyCanary) {
              const curCohorts = existing.autoApplyCanary.mapValue.fields.cohorts.mapValue.fields;
              const newCohorts = w.update.fields.autoApplyCanary.mapValue.fields.cohorts.mapValue.fields;
              merged.autoApplyCanary = {
                mapValue: {
                  fields: {
                    enabled: { booleanValue: true },
                    cohorts: { mapValue: { fields: Object.assign({}, curCohorts, newCohorts) } },
                  },
                },
              };
            }
            docs.set(p, { name: w.update.name, fields: merged });
          } else {
            docs.set(p, { name: w.update.name, fields: w.update.fields });
          }
        }
      }
      return mkRes(200, { writeResults: [] });
    }
    const marker = '/documents/';
    const rel = u.slice(u.indexOf(marker) + marker.length).split('?')[0];
    if (!rel.includes('/')) {
      const prefix = rel + '/';
      const documents = [...docs.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map(([, v]) => v);
      return mkRes(200, { documents });
    }
    if (docs.has(rel)) return mkRes(200, docs.get(rel));
    return mkRes(404, { error: { code: 404 } });
  };

  return {
    rosterPath, runtimeSha, opId, startsAt, expiresAt, coachId, deploymentId,
    fetcher, writtenDocPaths, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

test('T878.4 — detectPlanChangeDrift isolates affected cohort, blocks invalid new plans, and excludes inactive/unconfirmed clients', async () => {
  // Case A: 1 active client in cohort-01 activates a valid new routine (plan_v2)
  const env = makeMockRosterEnv({ driftedUid: 'active_client_01' });
  try {
    const rep = await ops.detectPlanChangeDrift({
      projectId: 'vdsen-ecosistema', googleToken: 'tok', coachId: env.coachId,
      expectedRuntimeSha: env.runtimeSha, fetcher: env.fetcher, commercialRosterPath: env.rosterPath,
    });
    assert.equal(rep.status, 'DRIFT_DETECTED');
    assert.equal(rep.commercialActiveCount, 25);
    assert.equal(rep.numericApplyBlockedUntilVerified, true);
    assert.deepEqual(rep.affectedCohortIds, ['cohort-01']);
    assert.deepEqual(rep.unaffectedCohortIds, ['cohort-02', 'cohort-03']);
    assert.equal(rep.driftedClients.length, 1);
    assert.equal(rep.driftedClients[0].uid, 'active_client_01');
    assert.equal(rep.driftedClients[0].armedPlanId, 'plan_v1_active_client_01');
    assert.equal(rep.driftedClients[0].livePlanId, 'plan_v2_active_client_01');
    assert.ok(rep.driftedClients[0].reasons.includes('PLAN_ID_CHANGED'));
    assert.ok(rep.driftedClients[0].reasons.includes('PIDS_HASH_CHANGED'));
    assert.equal(rep.driftedClients[0].readyForRenewal, true);
  } finally { env.cleanup(); }

  // Case B: New plan missing updatedAt -> fail closed (BLOCKED_NEW_PLAN_INVALID)
  const envBad = makeMockRosterEnv({ driftedUid: 'active_client_01', missingUpdatedAt: true });
  try {
    const rep = await ops.detectPlanChangeDrift({
      projectId: 'vdsen-ecosistema', googleToken: 'tok', coachId: envBad.coachId,
      expectedRuntimeSha: envBad.runtimeSha, fetcher: envBad.fetcher, commercialRosterPath: envBad.rosterPath,
    });
    assert.equal(rep.status, 'BLOCKED_NEW_PLAN_INVALID');
    assert.equal(rep.numericApplyBlockedUntilVerified, true);
    assert.ok(rep.blockedNewPlans.some(b => b.uid === 'active_client_01' && b.reason === 'NEW_PLAN_MISSING_UPDATED_AT'));
  } finally { envBad.cleanup(); }
});

test('T878.5 — renewDriftedCohort renews ONLY affected cohort atomically, leaves unaffected cohorts untouched, and verifies exact match', async () => {
  const env = makeMockRosterEnv({ driftedUid: 'active_client_01' });
  try {
    // Refuses to touch an unaffected cohort
    await assert.rejects(() => ops.renewDriftedCohort({
      projectId: 'vdsen-ecosistema', googleToken: 'tok', vercelToken: 'vtok',
      cohortId: 'cohort-02', deploymentId: env.deploymentId, runtimeSha: env.runtimeSha,
      operationId: 't878-renew-c2', startsAt: env.startsAt, expiresAt: env.expiresAt,
      coachId: env.coachId, runId: '999', fetcher: env.fetcher, commercialRosterPath: env.rosterPath,
    }), /COHORT_NOT_AFFECTED_BY_DRIFT/);

    // Renews ONLY cohort-01
    const res = await ops.renewDriftedCohort({
      projectId: 'vdsen-ecosistema', googleToken: 'tok', vercelToken: 'vtok',
      cohortId: 'cohort-01', deploymentId: env.deploymentId, runtimeSha: env.runtimeSha,
      operationId: 't878-renew-c1', startsAt: env.startsAt, expiresAt: env.expiresAt,
      coachId: env.coachId, runId: '1000', fetcher: env.fetcher, commercialRosterPath: env.rosterPath,
    });
    assert.equal(res.status, 'COHORT_RENEWED_VERIFIED');
    assert.equal(res.cohortId, 'cohort-01');
    assert.equal(res.exactMatch, true);
    assert.deepEqual(res.unaffectedCohortIds, ['cohort-02', 'cohort-03']);
    assert.equal(res.renewedClients.length, 1);
    assert.equal(res.renewedClients[0].newPlanId, 'plan_v2_active_client_01');

    // Verify ZERO writes touched cohort-02 or cohort-03
    assert.equal(env.writtenDocPaths.some(p => p.includes('cohort-02') || p.includes('cohort-03')), false);

    // Post-renewal drift check must now report NO_DRIFT across all 3 cohorts
    const postDrift = await ops.detectPlanChangeDrift({
      projectId: 'vdsen-ecosistema', googleToken: 'tok', coachId: env.coachId,
      expectedRuntimeSha: env.runtimeSha, fetcher: env.fetcher, commercialRosterPath: env.rosterPath,
    });
    assert.equal(postDrift.status, 'NO_DRIFT');
    assert.deepEqual(postDrift.affectedCohortIds, []);
    assert.deepEqual(postDrift.unaffectedCohortIds, ['cohort-01', 'cohort-02', 'cohort-03']);
  } finally { env.cleanup(); }
});

test('T878-JSON-01 & T878-JSON-02 — Pegar JSON preserves Coach prescription verbatim and rejects incompatible JSON without inventing data', () => {
  const parseSrc = extractFn(COACH_HTML, 'function parsePlanFromJSON()');
  const normRestSrc = extractFn(COACH_HTML, 'function _normRestSeconds(');
  const normRirSrc = extractFn(COACH_HTML, 'function _normRirByWeek(');
  const normMpSrc = extractFn(COACH_HTML, 'function _normalizeMusclePriorities(');

  let lastPreview = null, lastStatus = '';
  const dom = {
    planJsonInput: { value: '' },
    jsonPlanStatus: { set innerHTML(v) { lastStatus = v; }, get innerHTML() { return lastStatus; } },
  };
  const sandbox = {
    window: { _importedPlan: null },
    document: { getElementById: id => dom[id] || null },
    showToast: () => {},
    _escH: s => String(s ?? ''),
    _carryClassification: () => ({}),
    _perfCarryEx: () => ({}),
    _perfCarrySet: () => ({}),
    _perfHasNoSetsOk: () => false,
    _perfType: t => (['fuerza', 'cardio', 'calistenia', 'estacion', 'circuito'].includes(t) ? t : null),
    _perfEffType: e => e.exerciseType || 'fuerza',
    showParsedPreview: (p, w) => { lastPreview = { plan: p, warnings: w }; },
  };
  vm.runInNewContext(
    [normRestSrc, normRirSrc, normMpSrc, parseSrc, 'this.parsePlanFromJSON = parsePlanFromJSON;'].join('\n'),
    sandbox
  );

  // T878-JSON-01 & 02: Valid pasted JSON preserves every prescription detail verbatim
  const validJson = {
    clientId: 'client_source_A',
    weeks: 6,
    daysPerWeek: 1,
    rirByWeek: { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1, 6: 3 },
    musclePriorities: { pecho: 'ALTA' },
    days: [{
      dayIndex: 0,
      label: 'Día 1 — Empuje',
      exercises: [{
        exerciseName: 'Press Banca Barra',
        prescriptionExerciseId: 'pid-from-client-A',
        alternatives: ['Press Mancuernas'],
        technique: 'straight',
        techniqueNote: 'Pausa 1s en pecho',
        coachNote: 'Controlar excéntrica',
        sets: [
          { setIndex: 0, repsTarget: 8, rirTarget: 3, load: 80, restSeconds: 150, tempo: '3-1-1-0', setNote: 'Top set' },
          { setIndex: 1, repsTarget: 8, rirTarget: 3, load: 80, restSeconds: 150, tempo: '3-1-1-0', setNote: 'Backoff' },
        ],
      }],
    }],
  };
  dom.planJsonInput.value = JSON.stringify(validJson);
  sandbox.parsePlanFromJSON();
  assert.ok(sandbox.window._importedPlan, 'Valid JSON must produce _importedPlan');
  assert.equal(sandbox.window._importedPlan._sourceClientId, 'client_source_A');
  const parsedPlan = JSON.parse(JSON.stringify(sandbox.window._importedPlan));
  const ex = parsedPlan.days[0].exercises[0];
  assert.equal(ex.exerciseName, 'Press Banca Barra');
  assert.deepEqual(ex.alternatives, ['Press Mancuernas']);
  assert.equal(ex.techniqueNote, 'Pausa 1s en pecho');
  assert.equal(ex.coachNote, 'Controlar excéntrica');
  assert.equal(ex.sets.length, 2);
  assert.equal(ex.sets[0].load, 80);
  assert.equal(ex.sets[0].repsTarget, 8);
  assert.equal(ex.sets[0].rirTarget, 3);
  assert.equal(ex.sets[0].restSeconds, 150);
  assert.equal(ex.sets[0].tempo, '3-1-1-0');
  assert.equal(ex.sets[0].setNote, 'Top set');
  assert.deepEqual(parsedPlan.rirByWeek, { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1, 6: 3 });

  // Incompatible JSON (negative load & invalid RIR) must be rejected with specific error, clearing _importedPlan
  dom.planJsonInput.value = JSON.stringify({
    weeks: 6,
    days: [{ dayIndex: 0, label: 'Día 1', exercises: [{ exerciseName: 'Sentadilla', sets: [{ repsTarget: 8, rirTarget: 9, load: -20 }] }] }],
  });
  sandbox.parsePlanFromJSON();
  assert.equal(sandbox.window._importedPlan, null, 'Incompatible JSON must clear _importedPlan');
  assert.match(lastStatus, /JSON incompatible/);
  assert.match(lastStatus, /carga inválida/);
  assert.match(lastStatus, /RIR inválido/);
});

test('T878-JSON-04 — _stampImportPrescriptionIds never reuses another client PID while preserving same-client valid PIDs (T150-H)', () => {
  const genSrc = extractFn(COACH_HTML, 'function _genPrescriptionId()');
  const importStampSrc = extractFn(COACH_HTML, 'function _stampImportPrescriptionIds(days, prevPlanDays, isForeignSource)');
  let seq = 0;
  const sandbox = { crypto: { randomUUID: () => 'fresh-uuid-' + (++seq) } };
  vm.runInNewContext(genSrc + '\n' + importStampSrc + '\nthis._stampImportPrescriptionIds = _stampImportPrescriptionIds;', sandbox);

  const clientAPids = [{ dayIndex: 0, exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-client-A-1' }] }];

  // Case 1: Pasting Client A's JSON into Client B (Client B has different/no prev plan) -> NEVER reuses pid-client-A-1
  const forClientB = sandbox._stampImportPrescriptionIds(clientAPids, [], true);
  assert.notEqual(forClientB[0].exercises[0].prescriptionExerciseId, 'pid-client-A-1');
  assert.equal(forClientB[0].exercises[0].prescriptionExerciseId, 'fresh-uuid-1');

  // Case 2: Pasting JSON with foreign PID without clientId header into Client B -> still NEVER reuses pid-client-A-1
  const forClientBNoHeader = sandbox._stampImportPrescriptionIds(clientAPids, [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-client-B-old' }] }], false);
  assert.notEqual(forClientBNoHeader[0].exercises[0].prescriptionExerciseId, 'pid-client-A-1');

  // Case 3: Re-importing Client A's own exported JSON for Client A -> preserves valid existing PID (T150-H)
  const forClientASame = sandbox._stampImportPrescriptionIds(clientAPids, clientAPids, false);
  assert.equal(forClientASame[0].exercises[0].prescriptionExerciseId, 'pid-client-A-1');
});

test('T878-JSON-03 & T878-JSON-12 — All activation routes auto-trigger /api/plan-activation-sync and App Coach renders truthful engine states', async () => {
  // Verify automatic wiring in BOTH _assignPlanTxn (6 routes) and _vdsenActivatePlanInFirestore (AI draft route)
  const assignTxn = extractFn(COACH_HTML, 'async function _assignPlanTxn(o)');
  const aiActivate = extractFn(COACH_HTML, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');
  assert.match(assignTxn, /_syncPlanEngineAfterActivation\(o\.clientId, planId\)/);
  assert.match(aiActivate, /_syncPlanEngineAfterActivation\(clientId, planId\)/);

  // Verify _renderPlanEngineSyncStatus & _syncPlanEngineAfterActivation truthfulness
  const renderSrc = extractFn(COACH_HTML, 'function _renderPlanEngineSyncStatus(syncRes)');
  const syncSrc = extractFn(COACH_HTML, 'async function _syncPlanEngineAfterActivation(clientId, planId)');
  let statusHtml = '';
  const fetchCalls = [];
  const sandbox = {
    window: {},
    document: { getElementById: id => id === 'jsonPlanStatus' ? { set innerHTML(v) { statusHtml = v; } } : null },
    _escH: s => String(s ?? ''),
    auth: { currentUser: { getIdToken: async () => 'coach-jwt-token' } },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true, status: 200,
        json: async () => ({
          status: 'RENEWED_VERIFIED',
          engineState: 'MOTOR_INTEGRATED_AUTHORIZED',
          numericApplyAuthorized: true,
          cohortId: 'cohort-01',
          pidCount: 3,
        }),
      };
    },
  };
  vm.runInNewContext(renderSrc + '\n' + syncSrc + '\nthis._renderPlanEngineSyncStatus = _renderPlanEngineSyncStatus; this._syncPlanEngineAfterActivation = _syncPlanEngineAfterActivation;', sandbox);

  // Never claims "Motor integrado y autorizado" without server confirmation
  assert.equal(sandbox._renderPlanEngineSyncStatus({ engineState: 'MOTOR_INTEGRATED_AUTHORIZED', status: 'AUTHORIZATION_PENDING', numericApplyAuthorized: false }).label, 'Requiere intervención del Coach');
  assert.equal(sandbox._renderPlanEngineSyncStatus({ engineState: 'AUTHORIZATION_PREPARING' }).label, 'Autorización en preparación');
  assert.equal(sandbox._renderPlanEngineSyncStatus({ engineState: 'AUTHORIZATION_PENDING' }).label, 'Autorización pendiente');
  assert.equal(sandbox._renderPlanEngineSyncStatus({ engineState: 'BLOCKED_COMMERCIAL' }).label, 'Bloqueado por incompatibilidad o seguridad');
  assert.equal(sandbox._renderPlanEngineSyncStatus({ engineState: 'BLOCKED_INCOMPATIBLE' }).label, 'Bloqueado por incompatibilidad o seguridad');
  assert.equal(sandbox._renderPlanEngineSyncStatus({ engineState: 'COACH_INTERVENTION_REQUIRED' }).label, 'Requiere intervención del Coach');

  // Automatic call sends Coach Bearer token to /api/autonomous-progression-trigger?action=plan-activation-sync and updates UI
  const res = await sandbox._syncPlanEngineAfterActivation('client_01', 'plan_new_01');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/autonomous-progression-trigger?action=plan-activation-sync');
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer coach-jwt-token');
  assert.equal(res.status, 'RENEWED_VERIFIED');
  assert.match(statusHtml, /Motor integrado y autorizado/);
  assert.match(statusHtml, /cohort-01/);
});

test('T878-PROD-01 — Real production defaultHandler() wires bundled T876 roster, fails closed when switch off or shard syncer missing, and completes verified renewal + safe retry', async () => {
  const bundledRoster = JSON.parse(fs.readFileSync(path.join(ROOT, '.release/commercial-roster-t876.json'), 'utf8'));
  const ACTIVE_UID = bundledRoster.activeUids[0];
  const OTHER_COHORT_UID = bundledRoster.activeUids[10];
  const INACTIVE_UID = bundledRoster.inactiveUids[0];
  const COACH_ID = 'coach-prod-default-1';
  const SHA = 'b6c4b86d48e473950a7ad19486c380b7b52ddc9f';
  const startsAt = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresAt = new Date(Date.now() + 12 * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nowIso = new Date().toISOString();

  const store = new Map();
  const clone = v => JSON.parse(JSON.stringify(v));
  const mkRef = (p) => ({
    path: p,
    id: p.split('/').pop(),
    collection: (sub) => ({ doc: (id) => mkRef(`${p}/${sub}/${id}`) }),
    async get() { return store.has(p) ? { exists: true, id: p.split('/').pop(), data: () => clone(store.get(p)) } : { exists: false, id: p.split('/').pop(), data: () => undefined }; },
    async set(d, opts) {
      if (opts && opts.merge && store.has(p)) store.set(p, Object.assign({}, store.get(p), clone(d)));
      else store.set(p, clone(d));
    },
  });
  const fakeDb = {
    collection: (c) => ({ doc: (id) => mkRef(`${c}/${id}`) }),
    doc: (p) => mkRef(p),
    async runTransaction(fn) {
      const tx = {
        get: (r) => r.get(),
        set: (r, d, opts) => {
          if (opts && opts.merge && store.has(r.path)) store.set(r.path, Object.assign({}, store.get(r.path), clone(d)));
          else store.set(r.path, clone(d));
        },
      };
      return await fn(tx);
    },
  };

  store.set(`coaches/${COACH_ID}`, {
    uid: COACH_ID,
    autoApplyCanary: {
      enabled: true,
      cohorts: {
        'cohort-01': { enabled: true, cohortId: 'cohort-01', operationId: 'op-c1-old', startsAt, expiresAt, clientIds: [ACTIVE_UID], prescriptionExerciseIds: ['pid-old-1'] },
        'cohort-02': { enabled: true, cohortId: 'cohort-02', operationId: 'op-c2-keep', startsAt, expiresAt, clientIds: [OTHER_COHORT_UID], prescriptionExerciseIds: ['pid-c2-1'] },
      },
    },
  });
  store.set('releaseControl/autonomousProgression_cohort_cohort-01', {
    schema: 'vdsen-autonomous-release-v1', enabled: true, cohortId: 'cohort-01', operationId: 'op-c1-old', startsAt, expiresAt, clientIds: [ACTIVE_UID],
  });
  store.set('releaseControl/numericPilot_cohort_cohort-01', {
    schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', enabled: true, cohortId: 'cohort-01', operationId: 'op-c1-old', runtimeSha: SHA, startsAt, expiresAt,
    windows: { [ACTIVE_UID]: { schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', cohortId: 'cohort-01', enabled: true, uid: ACTIVE_UID, planId: 'plan-old-1', pids: ['pid-old-1'], pidCount: 1, pidsHash: C.computePidsHash(['pid-old-1']), runtimeSha: SHA, operationId: 'op-c1-old', startsAt, expiresAt } },
  });
  store.set('releaseControl/numericPilot_cohort_cohort-02', {
    schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', enabled: true, cohortId: 'cohort-02', operationId: 'op-c2-keep', runtimeSha: SHA, startsAt, expiresAt,
    windows: { [OTHER_COHORT_UID]: { schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', cohortId: 'cohort-02', enabled: true, uid: OTHER_COHORT_UID, planId: 'plan-c2-1', pids: ['pid-c2-1'], pidCount: 1, pidsHash: C.computePidsHash(['pid-c2-1']), runtimeSha: SHA, operationId: 'op-c2-keep', startsAt, expiresAt } },
  });

  store.set(`clients/${ACTIVE_UID}`, { uid: ACTIVE_UID, coachId: COACH_ID, status: 'active', activePlanId: 'plan-new-json-1' });
  store.set('plans/plan-new-json-1', {
    id: 'plan-new-json-1', clientId: ACTIVE_UID, coachId: COACH_ID, status: 'active',
    createdAt: nowIso, updatedAt: nowIso,
    days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-new-json-1', sets: [{ load: 80, repsTarget: 8, rirTarget: 2, restSeconds: 120 }] }] }],
  });
  store.set(`clients/${INACTIVE_UID}`, { uid: INACTIVE_UID, coachId: COACH_ID, status: 'active', activePlanId: 'plan-inact-1' });
  store.set('plans/plan-inact-1', {
    id: 'plan-inact-1', clientId: INACTIVE_UID, coachId: COACH_ID, status: 'active',
    createdAt: nowIso, updatedAt: nowIso,
    days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Curl', prescriptionExerciseId: 'pid-inact-1', sets: [{ load: 20, repsTarget: 10, rirTarget: 2, restSeconds: 90 }] }] }],
  });

  const adminPath = require.resolve(path.join(ROOT, 'api/_firebaseAdmin.js'));
  const fbAdminPath = (() => { try { return require.resolve('firebase-admin'); } catch (_) { return null; } })();
  const origAdminCache = require.cache[adminPath];
  const origFbCache = fbAdminPath ? require.cache[fbAdminPath] : null;
  const origFetch = globalThis.fetch;
  const savedEnv = {
    VDSEN_AUTO_COHORT_RENEWAL_ENABLED: process.env.VDSEN_AUTO_COHORT_RENEWAL_ENABLED,
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA,
    VERCEL_TOKEN: process.env.VERCEL_TOKEN,
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
    VERCEL_ORG_ID: process.env.VERCEL_ORG_ID,
  };

  const invokeDefault = async (body) => {
    let statusCode = 0, payload = null;
    const req = { method: 'POST', query: { action: 'plan-activation-sync' }, headers: { authorization: 'Bearer coach-jwt' }, body };
    const res = { setHeader() {}, status(c) { statusCode = c; return this; }, json(d) { payload = d; return this; } };
    const triggerDefault = require(path.join(ROOT, 'api/autonomous-progression-trigger.js'));
    await triggerDefault(req, res);
    return { statusCode, payload };
  };

  try {
    require.cache[adminPath] = {
      id: adminPath, filename: adminPath, loaded: true,
      exports: {
        acceptRequestOidcToken: async () => {},
        getAdminApp: () => ({ name: 'mock-app' }),
        verifyIdToken: async () => ({ uid: COACH_ID }),
        isFederatedMode: () => false,
      },
    };
    if (fbAdminPath) {
      require.cache[fbAdminPath] = {
        id: fbAdminPath, filename: fbAdminPath, loaded: true,
        exports: { firestore: () => fakeDb },
      };
    } else {
      const Module = require('node:module');
      const origLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'firebase-admin') return { firestore: () => fakeDb };
        return origLoad.apply(this, arguments);
      };
      savedEnv.__restoreLoad = () => { Module._load = origLoad; };
    }

    // 1. Cliente fuera del padrón (INACTIVE in real .release/commercial-roster-t876.json)
    delete process.env.VDSEN_AUTO_COHORT_RENEWAL_ENABLED;
    delete process.env.VERCEL_TOKEN;
    const rInact = await invokeDefault({ action: 'plan-activation-sync', clientId: INACTIVE_UID, planId: 'plan-inact-1' });
    assert.equal(rInact.statusCode, 200);
    assert.equal(rInact.payload.status, 'NOT_COMMERCIALLY_AUTHORIZED');
    assert.equal(rInact.payload.engineState, 'BLOCKED_COMMERCIAL');
    assert.equal(rInact.payload.numericApplyAuthorized, false);

    // 2. Interruptor de renovación deshabilitado -> AUTHORIZATION_PENDING
    process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA = SHA;
    const rOff = await invokeDefault({ action: 'plan-activation-sync', clientId: ACTIVE_UID, planId: 'plan-new-json-1' });
    assert.equal(rOff.statusCode, 200);
    assert.equal(rOff.payload.status, 'AUTHORIZATION_PENDING');
    assert.equal(rOff.payload.numericApplyAuthorized, false);

    // 3. Sincronizador de shards ausente (VERCEL_TOKEN missing) -> fail-closed BEFORE STOP (503)
    process.env.VDSEN_AUTO_COHORT_RENEWAL_ENABLED = 'true';
    const rNoSync = await invokeDefault({ action: 'plan-activation-sync', clientId: ACTIVE_UID, planId: 'plan-new-json-1' });
    assert.equal(rNoSync.statusCode, 503);
    assert.equal(rNoSync.payload.status, 'RENEWAL_BLOCKED_NO_SHARD_SYNC');
    assert.equal(rNoSync.payload.errorCode, 'RUNTIME_SHARD_SYNC_UNAVAILABLE');
    assert.equal(store.get('releaseControl/numericPilot_cohort_cohort-01').enabled, true, 'Missing syncer must fail closed BEFORE touching cohort-01');

    // 4. T878-A03: Fallo de deployment Vercel -> rollback del shard en proyecto + cohorte STOPPED + ledger FAILED
    process.env.VERCEL_TOKEN = 'vtok';
    process.env.VERCEL_PROJECT_ID = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
    process.env.VERCEL_ORG_ID = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
    const projectEnvState = new Map([['VDSEN_NUMERIC_COHORT_1', '[{"old":"shard"}]']]);
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/v10/projects/') && u.includes('/env')) {
        if (init.method === 'POST') {
          const b = JSON.parse(init.body);
          projectEnvState.set(b.key, b.value);
          return { ok: true, status: 200, json: async () => ({ created: { id: 'env_1', key: b.key } }) };
        }
        return { ok: true, status: 200, json: async () => ({ envs: [...projectEnvState.entries()].map(([key, value]) => ({ key, value, target: ['production'] })) }) };
      }
      if (u.includes('/v13/deployments')) {
        return { ok: false, status: 500, json: async () => ({ error: 'deploy_failed' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const rFail = await invokeDefault({ action: 'plan-activation-sync', clientId: ACTIVE_UID, planId: 'plan-new-json-1' });
    assert.equal(rFail.statusCode, 500);
    assert.equal(rFail.payload.status, 'RENEWAL_FAILED');
    assert.equal(rFail.payload.errorCode, 'VERCEL_DEPLOYMENT_CREATE_FAILED');
    assert.equal(rFail.payload.stoppedVerified, true);
    assert.equal(rFail.payload.servedDeploymentVerified, false);
    assert.equal(projectEnvState.get('VDSEN_NUMERIC_COHORT_1'), '[{"old":"shard"}]', 'T878-A03: failed deployment must roll back project env shard');
    assert.equal(store.get('releaseControl/numericPilot_cohort_cohort-01').enabled, false, 'Failed deployment must keep cohort STOPPED');
    assert.equal(store.get('releaseControl/numericPilot_cohort_cohort-02').operationId, 'op-c2-keep', 'Unaffected cohort-02 untouched');

    // 5. T878-A01: Upsert de variables sin que el deployment servido incorpore el shard -> SERVED_DEPLOYMENT_SHARD_MISMATCH + rollback
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/v10/projects/') && u.includes('/env')) {
        if (init.method === 'POST') {
          const b = JSON.parse(init.body);
          projectEnvState.set(b.key, b.value);
          return { ok: true, status: 200, json: async () => ({ created: { id: 'env_1', key: b.key } }) };
        }
        return { ok: true, status: 200, json: async () => ({ envs: [...projectEnvState.entries()].map(([key, value]) => ({ key, value, target: ['production'] })) }) };
      }
      if (u.includes('/v13/deployments')) {
        return { ok: true, status: 200, json: async () => ({ id: 'dpl_stale_01', url: 'stale-preview.vercel.app', readyState: 'READY' }) };
      }
      if (u.includes('/v2/aliases/')) {
        return { ok: true, status: 200, json: async () => ({ deploymentId: 'dpl_stale_01' }) };
      }
      if (u.includes('check=cohort-shard')) {
        // Served deployment STILL has stale digest (not matching new plan!)
        return { ok: true, status: 200, json: async () => ({ schema: 'vdsen-served-cohort-probe-v1', cohortId: 'cohort-01', runtimeSha: SHA, windowCount: 1, windowsDigest: '0'.repeat(64) }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const rStale = await invokeDefault({ action: 'plan-activation-sync', clientId: ACTIVE_UID, planId: 'plan-new-json-1' });
    assert.equal(rStale.statusCode, 500);
    assert.equal(rStale.payload.errorCode, 'SERVED_DEPLOYMENT_SHARD_MISMATCH');
    assert.equal(rStale.payload.servedDeploymentVerified, false);
    assert.equal(projectEnvState.get('VDSEN_NUMERIC_COHORT_1'), '[{"old":"shard"}]', 'T878-A01: stale served deployment must roll back project env shard');

    // 5b. T879-E: READY deployment that does NOT serve production alias -> DEPLOYMENT_NOT_SERVING_PRODUCTION_ALIAS + rollback
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/v10/projects/') && u.includes('/env')) {
        if (init.method === 'POST') {
          const b = JSON.parse(init.body);
          projectEnvState.set(b.key, b.value);
          return { ok: true, status: 200, json: async () => ({ created: { id: 'env_1', key: b.key } }) };
        }
        return { ok: true, status: 200, json: async () => ({ envs: [...projectEnvState.entries()].map(([key, value]) => ({ key, value, target: ['production'] })) }) };
      }
      if (u.includes('/v13/deployments')) {
        return { ok: true, status: 200, json: async () => ({ id: 'dpl_unaliased_01', url: 'unaliased.vercel.app', readyState: 'READY' }) };
      }
      if (u.includes('/v2/aliases/')) {
        return { ok: true, status: 200, json: async () => ({ deploymentId: 'dpl_older_live_00' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const rUnaliased = await invokeDefault({ action: 'plan-activation-sync', clientId: ACTIVE_UID, planId: 'plan-new-json-1' });
    assert.equal(rUnaliased.statusCode, 500);
    assert.equal(rUnaliased.payload.errorCode, 'DEPLOYMENT_NOT_SERVING_PRODUCTION_ALIAS');
    assert.equal(projectEnvState.get('VDSEN_NUMERIC_COHORT_1'), '[{"old":"shard"}]', 'T879-E: unaliased READY deployment must roll back project env shard');

    // 6. T878-A02: Reintento exitoso cuando el nuevo deployment servido reporta el digest exacto vía GET ?check=cohort-shard
    const planSyncMod = require(path.join(ROOT, 'api/_planActivationSync.js'));
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/v10/projects/') && u.includes('/env')) {
        if (init.method === 'POST') {
          const b = JSON.parse(init.body);
          projectEnvState.set(b.key, b.value);
          return { ok: true, status: 200, json: async () => ({ created: { id: 'env_1', key: b.key } }) };
        }
        return { ok: true, status: 200, json: async () => ({ envs: [...projectEnvState.entries()].map(([key, value]) => ({ key, value, target: ['production'] })) }) };
      }
      if (u.includes('/v13/deployments')) {
        return { ok: true, status: 200, json: async () => ({ id: 'dpl_new_verified_01', url: 'vdsen-new.vercel.app', readyState: 'READY' }) };
      }
      if (u.includes('/v2/aliases/')) {
        return { ok: true, status: 200, json: async () => ({ deploymentId: 'dpl_new_verified_01' }) };
      }
      if (u.includes('check=cohort-shard')) {
        // Real probe payload built from the newly deployed shard env!
        const servedProbe = planSyncMod.buildServedCohortProbePayload({
          VDSEN_NUMERIC_COHORT_1: projectEnvState.get('VDSEN_NUMERIC_COHORT_1'),
          VDSEN_NUMERIC_PILOT_RUNTIME_SHA: SHA,
        }, 'cohort-01');
        return { ok: true, status: 200, json: async () => servedProbe };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const rOk = await invokeDefault({ action: 'plan-activation-sync', clientId: ACTIVE_UID, planId: 'plan-new-json-1' });
    assert.equal(rOk.statusCode, 200, JSON.stringify(rOk.payload));
    assert.equal(rOk.payload.status, 'RENEWED_VERIFIED');
    assert.equal(rOk.payload.shardSyncedVerified, true);
    assert.equal(rOk.payload.servedDeploymentVerified, true);
    assert.equal(rOk.payload.deploymentId, 'dpl_new_verified_01');
    assert.equal(rOk.payload.engineState, 'MOTOR_INTEGRATED_AUTHORIZED');
    assert.equal(rOk.payload.numericApplyAuthorized, true);
    assert.equal(store.get('releaseControl/numericPilot_cohort_cohort-02').operationId, 'op-c2-keep', 'Unaffected cohort-02 untouched');

    // 7. T878-A06: Idempotencia en repetición
    const rIdem = await invokeDefault({ action: 'plan-activation-sync', clientId: ACTIVE_UID, planId: 'plan-new-json-1' });
    assert.equal(rIdem.statusCode, 200);
    assert.equal(rIdem.payload.status, 'AUTHORIZED_VERIFIED');
    assert.equal(rIdem.payload.idempotent, true);
  } finally {
    if (savedEnv.__restoreLoad) savedEnv.__restoreLoad();
    globalThis.fetch = origFetch;
    if (origAdminCache) require.cache[adminPath] = origAdminCache; else delete require.cache[adminPath];
    if (fbAdminPath) { if (origFbCache) require.cache[fbAdminPath] = origFbCache; else delete require.cache[fbAdminPath]; }
    for (const k of ['VDSEN_AUTO_COHORT_RENEWAL_ENABLED', 'VDSEN_NUMERIC_PILOT_RUNTIME_SHA', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID']) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  }
});

test('T878-PROD-02 — Fail-closed on missing or invalid commercial roster and both Pegar JSON UIs route through automatic sync', async () => {
  const planSync = require(path.join(ROOT, 'api/_planActivationSync.js'));
  const invokeSync = async (commercialRoster) => {
    let statusCode = 0, payload = null;
    const h = planSync.makeHandler({ db: {}, verifyIdToken: async () => ({ uid: 'coach-1' }), commercialRoster });
    const req = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'c1', planId: 'p1' } };
    const res = { setHeader() {}, status(c) { statusCode = c; return this; }, json(d) { payload = d; return this; } };
    await h(req, res);
    return { statusCode, payload };
  };

  // Padrón ausente
  const rMissing = await invokeSync(null);
  assert.equal(rMissing.statusCode, 500);
  assert.equal(rMissing.payload.errorCode, 'COMMERCIAL_ROSTER_MISSING');

  // Padrón inválido (schema, project, overlap)
  const rBadSchema = await invokeSync({ schema: 'wrong', activeUids: ['client_000001'] });
  assert.equal(rBadSchema.statusCode, 500);
  assert.equal(rBadSchema.payload.errorCode, 'COMMERCIAL_ROSTER_INVALID_SCHEMA');

  const rOverlap = await invokeSync({
    schema: 'vdsen-commercial-roster-v1', firebaseProject: 'vdsen-ecosistema', confirmedBy: 'owner',
    activeUids: ['client_000001'], inactiveUids: ['client_000001'],
  });
  assert.equal(rOverlap.statusCode, 500);
  assert.equal(rOverlap.payload.errorCode, 'COMMERCIAL_ROSTER_OVERLAP');

  // Verify BOTH Pegar JSON UIs route through saveImportedPlan -> _assignPlanTxn -> _syncPlanEngineAfterActivation
  const modalSubmit = extractFn(COACH_HTML, "window._submitModalImport = async function(mode, clientId)");
  assert.match(modalSubmit, /await saveImportedPlan\(clientId\)/, 'Modal Pegar JSON must invoke saveImportedPlan');
  const previewBtn = COACH_HTML.indexOf('id="saveImportedPlanBtn" onclick="saveImportedPlan()"');
  assert.ok(previewBtn !== -1, 'Main Pegar JSON preview must invoke saveImportedPlan');
});

test('T878-LOGBOOK-01 (B12/B16/B18/B19) — _logsPlanChanged never wipes active-plan logs on stale localStorage/flagSession & recovery DRY_RUN is idempotent', () => {
  // 1. Multi-device / stale localStorage protection in vdsen-cliente.html
  const fnSrc = extractFn(CLIENT_HTML, 'function _logsPlanChanged(logData, activePlanId, flagSession, localPlanId)');
  const sb = {};
  vm.runInNewContext(fnSrc + '\nthis._logsPlanChanged = _logsPlanChanged;', sb);

  const activeWithSets = {
    planId: 'plan-B',
    entries: { log_1_0_0_s0: { done: true, carga: 80, reps: 8, rir_real: 2, ics: 9, ts: 1700000000000 } },
  };
  // Stale Device 2 has localStorage='plan-A' and/or flagSession=true while Firestore ALREADY has logged sets for 'plan-B' -> MUST NOT WIPE!
  assert.equal(sb._logsPlanChanged(activeWithSets, 'plan-B', true, 'plan-A'), false);
  assert.equal(sb._logsPlanChanged(activeWithSets, 'plan-B', false, 'plan-A'), false);
  // Real plan switch (Firestore still has 'plan-A' entries, activePlanId is 'plan-B') -> still detected as true!
  assert.equal(sb._logsPlanChanged({ planId: 'plan-A', entries: { log_1_0_0_s0: { done: true } } }, 'plan-B', false, 'plan-A'), true);

  // 2. Recovery tool classification (A/B/C/D/E), mandatory DRY_RUN, and idempotent non-destructive merge
  const rec = require(path.join(ROOT, 'scripts/pilot/logbook-integrity-recovery.cjs'));
  assert.throws(() => rec.buildRecoveryPlan([], { mode: 'APPLY' }), /RECOVERY_APPLY_BLOCKED/);

  const plan = rec.buildRecoveryPlan([
    // Cat A: intact
    { uid: 'uA', activePlanId: 'pA', rootDoc: { planId: 'pA', entries: { log_1_0_0_s0: { carga: 50 } } }, mesosById: { pA: { planId: 'pA', entries: { log_1_0_0_s0: { carga: 50 } } } }, startsDocs: [] },
    // Cat C: root has logs, meso mirror missing
    { uid: 'uC', activePlanId: 'pC', rootDoc: { planId: 'pC', entries: { log_1_0_0_s0: { carga: 60 }, log_1_0_0_s1: { carga: 60 } } }, mesosById: {}, startsDocs: [] },
    // Cat E: active meso wiped with immutable starts proof and no backup
    { uid: 'uE', activePlanId: 'pE', rootDoc: { planId: 'pE', entries: {} }, mesosById: { pE: { planId: 'pE', entries: {} }, pE_old: { planId: 'pE_old', entries: { log_1_0_0_s0: { carga: 70 } } } }, startsDocs: [{ id: 'pE_1_0_0', planId: 'pE', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0' }] },
  ], { mode: 'DRY_RUN' });
  assert.equal(plan.mode, 'DRY_RUN');
  assert.equal(plan.countsByCategory.A, 1);
  assert.equal(plan.countsByCategory.C, 1);
  assert.equal(plan.countsByCategory.E, 1);
  assert.equal(plan.clients[2].prevMesosPreserved, 1);

  // T878-B16 & B19: Repeated non-destructive merge never duplicates or overwrites post-snapshot sets
  const postSnapshot = { log_2_0_0_s0: { carga: 85, reps: 8, ts: 2000 } };
  const backup = { log_1_0_0_s0: { carga: 80, reps: 8, ts: 1000 }, log_2_0_0_s0: { carga: 70, reps: 8, ts: 1500 } };
  const m1 = rec.applyNonDestructiveMerge(postSnapshot, backup);
  assert.equal(m1.deletedCount, 0);
  assert.equal(m1.overwrittenCount, 0);
  assert.equal(m1.duplicatedCount, 0);
  assert.equal(m1.merged.log_2_0_0_s0.carga, 85, 'Post-snapshot set must NEVER be overwritten by older backup');
  assert.equal(m1.merged.log_1_0_0_s0.carga, 80, 'Missing historical set restored');
  const m2 = rec.applyNonDestructiveMerge(m1.merged, backup);
  assert.equal(m2.addedKeys.length, 0, 'T878-B16: repeated recovery is 100% idempotent');
  assert.equal(m2.beforeHash, m2.afterHash);
});

test('T879-C — executeControlledCategoryCBackfill enforces authorization token, backfills idempotently, and verifies post-write SHA-256', async () => {
  const rec = require(path.join(ROOT, 'scripts/pilot/logbook-integrity-recovery.cjs'));
  const mem = new Map([
    ['logs/uC', { planId: 'pC', currentWeek: 2, entries: { log_1_0_0_s0: { carga: 60, reps: 8, ts: 1000 }, log_1_0_0_s1: { carga: 60, reps: 8, ts: 2000 } }, updatedAt: 2000 }],
  ]);
  const manifest = rec.buildRecoveryPlan([
    { uid: 'uC', activePlanId: 'pC', rootDoc: mem.get('logs/uC'), mesosById: {}, startsDocs: [] },
  ], { mode: 'DRY_RUN' });
  const io = {
    readDoc: async (p) => mem.get(p) || null,
    mergeWriteDoc: async (p, patch) => {
      const cur = mem.get(p) || { entries: {} };
      mem.set(p, {
        planId: patch.planId,
        currentWeek: patch.currentWeek,
        entries: Object.assign({}, cur.entries || {}, patch.entries || {}),
        updatedAt: patch.updatedAt,
      });
    },
  };
  await assert.rejects(() => rec.executeControlledCategoryCBackfill({ manifest, authorizationToken: 'bad', expectedAuthToken: 'owner-t879-ok', ...io }), /RECOVERY_AUTHORIZATION_REQUIRED/);
  const r1 = await rec.executeControlledCategoryCBackfill({ manifest, authorizationToken: 'owner-t879-ok', expectedAuthToken: 'owner-t879-ok', ...io });
  assert.equal(r1.clientsProcessed, 1);
  assert.equal(r1.totalEntriesBackfilled, 2);
  assert.equal(r1.deletedCount, 0);
  assert.equal(r1.overwrittenCount, 0);
  assert.equal(r1.results[0].status, 'BACKFILLED_VERIFIED');
  const r2 = await rec.executeControlledCategoryCBackfill({ manifest, authorizationToken: 'owner-t879-ok', expectedAuthToken: 'owner-t879-ok', ...io });
  assert.equal(r2.totalEntriesBackfilled, 0);
  assert.equal(r2.results[0].status, 'ALREADY_SYNCED_IDEMPOTENT');
});
