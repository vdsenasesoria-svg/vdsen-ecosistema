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

  // Automatic call sends Coach Bearer token to /api/plan-activation-sync and updates UI
  const res = await sandbox._syncPlanEngineAfterActivation('client_01', 'plan_new_01');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/plan-activation-sync');
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer coach-jwt-token');
  assert.equal(res.status, 'RENEWED_VERIFIED');
  assert.match(statusHtml, /Motor integrado y autorizado/);
  assert.match(statusHtml, /cohort-01/);
});
