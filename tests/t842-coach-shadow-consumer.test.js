'use strict';
// T842: Real App Cliente logbook validation + calculateProgression + STAGE1_SHADOW motor +
// real App Coach consumer (_renderShadowAutoFeed / _renderShadowMagnitude / _shadowAuditLines /
// _dryRunLine / planApplication) across all motor-generated states, plus trigger persistence error safety.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CLIENT_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-cliente.html'), 'utf8');
const COACH_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');

const shadow = require(path.join(ROOT, 'assets/progression-auto-apply-shadow.js'));
const policy = require(path.join(ROOT, 'assets/progression-magnitude-policy.js'));
const consumer = require(path.join(ROOT, 'assets/progression-application-consumer.js'));
const effective = require(path.join(ROOT, 'assets/progression-effective-prescription.js'));
const variantIdentity = require(path.join(ROOT, 'assets/progression-variant-identity.js'));
const trigger = require(path.join(ROOT, 'api/autonomous-progression-trigger.js'));

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, 'Missing function signature: ' + signature);
  let depth = 0, started = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('Unterminated function: ' + signature);
}

function loadClientCompleteSetHarness(planExercise) {
  const fnSrc = extractFunction(CLIENT_HTML, 'async function completeSet(');
  const toasts = [];
  const domValues = {};
  let saveCalls = 0;
  let saveShouldSucceed = true;
  const sandbox = {
    LOGS: {},
    LOGS_BY_WEEK: { log: { 1: [], 2: [] } },
    EXERCISE_HISTORY: {},
    CURRENT_WEEK: 2,
    REAL_WEEK: 2,
    DIA_ACTIVO: 0,
    EJ_ACTIVO: 0,
    _EJERCICIOS_DIA: [planExercise],
    _saveLogsTimer: null,
    window: { VDSEN_VARIANT_IDENTITY: variantIdentity },
    document: {
      getElementById(id) {
        if (id.startsWith('setrow_')) {
          return {
            dataset: { exname: planExercise.exerciseName || planExercise.nombre || '' },
            querySelector: () => null
          };
        }
        if (Object.prototype.hasOwnProperty.call(domValues, id)) {
          return { value: domValues[id] };
        }
        return null;
      }
    },
    getExUnit: () => 'KG',
    _coachRIR: (ej) => (ej && ej.sets && ej.sets[0] ? ej.sets[0].rirTarget : 2),
    getAdjustedRIR: (base) => base,
    _lbwTrack: (k) => { if (!sandbox.LOGS_BY_WEEK.log[sandbox.CURRENT_WEEK]) sandbox.LOGS_BY_WEEK.log[sandbox.CURRENT_WEEK] = []; sandbox.LOGS_BY_WEEK.log[sandbox.CURRENT_WEEK].push(k); },
    _historyPidKey: (pid) => (pid ? 'pid:' + pid : null),
    _recordExerciseHistoryAndPR: () => false,
    _rebuildExerciseHistoryFromLogs: () => {},
    _doSaveLogs: async () => { saveCalls++; return saveShouldSucceed; },
    showToast: (msg, isErr) => { toasts.push({ msg, isErr: !!isErr }); },
    showPRCelebration: () => {},
    _isExerciseFullyDone: () => false,
    isTechniqueActive: () => true,
    renderEntrenamiento: () => {},
    _refreshExPanelOnly: () => {},
    startRestTimer: () => {},
    _withOverlayRest: (_w, _di, _pid, baseRest) => baseRest,
    _resolveNextWorkoutAction: () => ({ nextLabel: null }),
    _renderNextWorkoutAction: () => {},
    getTotalWeeks: () => 4,
    isY3TExercise: () => false,
    getEffectiveSets: (ej) => (ej && ej.sets) || [],
    renderResumen: () => {},
    getSesiones: () => [],
    _updateDayProgressBar: () => {},
    clearTimeout: () => {},
    setTimeout: () => 0,
    Date, Math, Number, String, Object, Array, JSON, parseFloat, parseInt, isNaN, isFinite
  };
  vm.runInNewContext(fnSrc + '\nthis.completeSet = completeSet;', sandbox);
  return {
    sandbox,
    toasts,
    setInputs(key, { carga = '', reps = '', rir = '', ics = '' }) {
      domValues['carga_' + key] = String(carga);
      domValues['reps_' + key] = String(reps);
      domValues['rir_' + key] = String(rir);
      domValues['ics_' + key] = String(ics);
    },
    getSaveCalls: () => saveCalls,
    setSaveOk: (ok) => { saveShouldSucceed = ok; }
  };
}

function loadClientCalculateProgression(plan, logs, currentWeek) {
  const deloadSrc = extractFunction(CLIENT_HTML, 'function _computeDeloadTriggers(');
  const calcSrc = extractFunction(CLIENT_HTML, 'function calculateProgression(');
  const sandbox = {
    PLAN: plan,
    LOGS: logs,
    LOGS_BY_WEEK: { log: {}, done: {}, postsession: {}, progrec: {} },
    CURRENT_WEEK: currentWeek,
    REAL_WEEK: currentWeek,
    MEV_MRV_BY_MUSCLE: {},
    MRV_BY_PATTERN: {},
    EXERCISE_CATALOG: {},
    window: { VDSEN_VARIANT_IDENTITY: variantIdentity },
    getSesiones: () => (plan.days || []).map((d) => ({
      dayIndex: d.dayIndex,
      label: d.label,
      exercises: (d.exercises || []).map((e) => ({
        nombre: e.exerciseName,
        exerciseName: e.exerciseName,
        prescriptionExerciseId: e.prescriptionExerciseId,
        exerciseId: e.exerciseId,
        alternatives: e.alternatives || [],
        numSeries: (e.sets || []).length,
        sets: e.sets || [],
        repsRange: e.repsRange && typeof e.repsRange === 'object'
          ? (e.repsRange.min + '-' + e.repsRange.max)
          : (e.repsRange || (e.sets && e.sets[0] ? String(e.sets[0].repsTarget) : '10')),
        rir: String((e.sets && e.sets[0] && e.sets[0].rirTarget !== undefined) ? e.sets[0].rirTarget : 2)
      }))
    })),
    getTotalWeeks: () => plan.weeks || 4,
    _getExType: (ej) => (ej && (ej.exerciseType === 'cardio' || ej.tipo === 'cardio') ? 'cardio' : 'strength'),
    _getCatalogData: () => null,
    getExUnit: () => 'KG',
    _avgArr: (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0),
    _getAlpha: () => ({ pct: 0.025, capKg: 2.5 }),
    _getMaxSets: (_cat, numSets) => Math.max(5, numSets + 1),
    _getPrevWeekData: (week, di, ei, maxSets) => {
      if (week <= 1) return null;
      const sets = [];
      for (let s = 0; s < maxSets; s++) {
        const k = 'log_' + (week - 1) + '_' + di + '_' + ei + '_s' + s;
        if (logs[k] && logs[k].done && !logs[k].autoFilled) sets.push(logs[k]);
      }
      if (!sets.length) return null;
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const rirs = sets.map((s) => parseFloat(s.rir_real)).filter((v) => !isNaN(v) && v >= 0 && v <= 5);
      return {
        avgLoad: avg(sets.map((s) => parseFloat(s.carga) || 0)),
        avgReps: avg(sets.map((s) => parseFloat(s.reps) || 0)),
        avgICS: 7.5,
        avgRIR: rirs.length ? avg(rirs) : null,
        numSets: sets.length,
        topLoad: Math.max(...sets.map((s) => parseFloat(s.carga) || 0))
      };
    },
    isY3TExercise: () => false,
    getEffectiveSets: (ej) => ej.sets || [],
    _roundUnit: (v, unit) => (unit === 'LB' ? Math.round(v / 2.5) * 2.5 : Math.round(v / 1.25) * 1.25),
    _applyAlpha: (load, alpha, unit) => {
      const inc = Math.min(load * alpha.pct, alpha.capKg);
      const step = unit === 'LB' ? Math.ceil(inc / 2.5) * 2.5 : Math.ceil(inc / 1.25) * 1.25;
      return +(load + Math.max(step, 1.25)).toFixed(2);
    },
    _getWeeklyVolumeByMuscle: () => 0,
    _getWeeklyVolumeByPattern: () => 0,
    _getEngineState: () => null,
    _updateEngineState: () => null,
    Date, Math, Number, String, Object, Array, JSON, parseFloat, parseInt, isNaN, isFinite
  };
  vm.runInNewContext(deloadSrc + '\n' + calcSrc + '\nthis.calculateProgression = calculateProgression;', sandbox);
  return sandbox.calculateProgression;
}

function loadRealCoachShadowConsumer() {
  const reviewStart = COACH_HTML.indexOf('var _REVIEW_BRANCH =');
  const reviewEnd = COACH_HTML.indexOf('function _reviewRequiredLines(', reviewStart);
  assert.ok(reviewStart > 0 && reviewEnd > reviewStart, 'Coach review maps missing');
  const reviewMaps = COACH_HTML.slice(reviewStart, reviewEnd);

  const labelStart = COACH_HTML.indexOf('var _LIFECYCLE_LABEL =');
  const feedEnd = COACH_HTML.indexOf('// T534: transactional reversal of an APPLIED overlay', labelStart);
  assert.ok(labelStart > 0 && feedEnd > labelStart, 'Coach shadow feed functions missing');
  const feedBlock = COACH_HTML.slice(labelStart, feedEnd);

  const sandbox = {
    window: {
      VDSEN_EFFECTIVE_PRESCRIPTION: effective,
      VDSEN_AUTO_APPLY_SHADOW: shadow,
      VDSEN_APPLICATION_CONSUMER: consumer
    },
    _escH: (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    Array, Number, String, Object, JSON, Date, Math, RegExp
  };
  vm.runInNewContext(
    reviewMaps + '\n' + feedBlock +
    '\nthis._renderShadowAutoFeed = _renderShadowAutoFeed;' +
    '\nthis._renderShadowMagnitude = _renderShadowMagnitude;' +
    '\nthis._shadowAuditLines = _shadowAuditLines;' +
    '\nthis._dryRunLine = _dryRunLine;' +
    '\nthis._lifecycleLines = _lifecycleLines;',
    sandbox
  );
  return sandbox;
}

function makePlan({ clientId = 'ath-t842', pid = 'pid-t842-press', rirTarget = 2, repsTarget = 10, repsRange = { min: 8, max: 12 }, weeks = 4 } = {}) {
  return {
    schema: 'vdsen-plan-v2',
    clientId,
    coachId: 'coach-t842',
    status: 'active',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    weeks,
    daysPerWeek: 1,
    days: [{
      dayIndex: 0,
      label: 'Día 1 - Empuje',
      exercises: [{
        prescriptionExerciseId: pid,
        exerciseName: 'Press de pecho T842',
        technique: 'straight',
        repsRange,
        sets: [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget, rirTarget, load: 0, restSeconds: 90 }))
      }]
    }]
  };
}

test('T842.U1 App Cliente completeSet validates weight, reps, RIR, ICS and persists valid working set', async () => {
  const pid = 'pid-t842-press';
  const plan = makePlan({ pid });
  const h = loadClientCompleteSetHarness(plan.days[0].exercises[0]);
  const key = 'log_2_0_0_s0';

  // Invalid weight (<= 0)
  h.setInputs(key, { carga: '0', reps: '10', rir: '3', ics: '8' });
  await h.sandbox.completeSet(key, 0, 0, 0, 'KG');
  assert.equal(h.sandbox.LOGS[key], undefined, 'Zero load must not be persisted');
  assert.ok(h.toasts.some((t) => t.isErr && /carga/i.test(t.msg)));

  // Invalid reps (<= 0)
  h.setInputs(key, { carga: '100', reps: '0', rir: '3', ics: '8' });
  await h.sandbox.completeSet(key, 0, 0, 0, 'KG');
  assert.equal(h.sandbox.LOGS[key], undefined, 'Zero reps must not be persisted');
  assert.ok(h.toasts.some((t) => t.isErr && /repeticiones/i.test(t.msg)));

  // Invalid ICS (> 10)
  h.setInputs(key, { carga: '100', reps: '10', rir: '3', ics: '12' });
  await h.sandbox.completeSet(key, 0, 0, 0, 'KG');
  assert.equal(h.sandbox.LOGS[key], undefined, 'Out-of-range ICS must not be persisted');
  assert.ok(h.toasts.some((t) => t.isErr && /ICS/i.test(t.msg)));

  // Out-of-range RIR is sanitized to empty (never fabricated) and valid set persists
  h.setInputs(key, { carga: '100', reps: '10', rir: '9', ics: '7' });
  await h.sandbox.completeSet(key, 0, 0, 0, 'KG');
  assert.equal(h.sandbox.LOGS[key].done, true);
  assert.equal(h.sandbox.LOGS[key].rir_real, '', 'Out-of-range RIR must be discarded, not fabricated');
  assert.equal(h.sandbox.LOGS[key].prescriptionExerciseId, pid);
  assert.equal(h.getSaveCalls(), 1);

  // Failed persistence rolls back in-memory set (no phantom completed set)
  const key2 = 'log_2_0_0_s1';
  h.setSaveOk(false);
  h.setInputs(key2, { carga: '100', reps: '10', rir: '4', ics: '7' });
  const resFail = await h.sandbox.completeSet(key2, 0, 0, 1, 'KG');
  assert.equal(resFail, false);
  assert.equal(h.sandbox.LOGS[key2], undefined, 'Failed write must roll back LOGS entry');
});

test('T842.U2 Real App Coach consumer renders all 5 STAGE1_SHADOW motor states cleanly with NUMERIC_APPLY_ENABLED=false', () => {
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false);
  assert.equal(policy.NUMERIC_APPLY_ENABLED, false);

  const coachUI = loadRealCoachShadowConsumer();
  const planId = 'plan-t842-coach';
  const clientId = 'ath-t842-coach';
  const pid = 'pid-t842-press';
  const plan = makePlan({ clientId, pid, rirTarget: 2, repsTarget: 10 });
  const T0 = Date.parse('2026-09-27T12:00:00.000Z');
  const calcAt = '2026-10-05T12:00:00.000Z';

  function runCoachFeedFor(entries, extraNote) {
    const out = shadow.materializeRecords({
      clientId, planId, activePlanId: planId, plan, interventions: [], entries,
      records: {}, overlays: {}, structural: true, at: calcAt, isStarted: consumer.targetStarted
    });
    const summary = shadow.summarize(out.records, planId);
    const dryRuns = {};
    for (const item of summary.items) {
      const full = out.records[item.key];
      if (!full) continue;
      dryRuns[item.key] = consumer.planApplication({
        record: full,
        context: {
          clientId, planId, activePlanId: planId, plan, entries,
          interventions: [], existingOverlays: {},
          resolveNextExposure: shadow.resolveNextExposure, now: calcAt
        }
      });
    }
    const html = coachUI._renderShadowAutoFeed(summary, dryRuns);
    assert.ok(!/undefined|NaN/.test(html), 'Coach HTML must not contain undefined/NaN (' + extraNote + '): ' + html);
    return { out, summary, dryRuns, html };
  }

  // State 1: Candidato sombra no aplicado (Rule A LOAD +2.5% -> 105)
  const eShadow = {};
  [1, 2].forEach((w) => [0, 1, 2].forEach((s) => {
    eShadow['log_' + w + '_0_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 4, ics: 7.5, prescriptionExerciseId: pid, ts: T0 + w * 1e6 + s };
  }));
  const calcProg = loadClientCalculateProgression(plan, eShadow, 2);
  const realProg = calcProg(0, { eimd: 2, articularPain: { present: false, pattern: '' }, sleepHours: 7, rpeAverage: 7 });
  assert.ok(realProg && Array.isArray(realProg.recommendations) && realProg.recommendations.length === 1);
  eShadow.progrec_2_0 = Object.assign({ calculatedAt: calcAt }, realProg);
  const s1 = runCoachFeedFor(eShadow, 'SHADOW_CANDIDATE');
  const rec1 = Object.values(s1.out.records)[0];
  assert.equal(rec1.state, 'PENDING');
  assert.equal(rec1.magnitude.eligible, true);
  assert.equal(rec1.magnitude.numericApplyAllowed, false);
  assert.match(s1.html, /CANDIDATO SHADOW · NO APLICADO/);
  assert.match(s1.html, /Candidato resuelto en shadow — no se aplica/);
  assert.match(s1.html, /prescripción original intacta/);

  // State 2: Revisión del Coach requerida (Rule C->E: RIR correct but reps incomplete across 2 comparable exposures)
  const eReview = {};
  [1, 2].forEach((w) => [0, 1, 2].forEach((s) => {
    eReview['log_' + w + '_0_0_s' + s] = { done: true, carga: '100', reps: '8', unit: 'KG', rir: 2, rir_real: 2, ics: 7.5, prescriptionExerciseId: pid, ts: T0 + w * 1e6 + s };
  }));
  eReview.progrec_2_0 = { calculatedAt: calcAt, recommendations: [{ prescriptionExerciseId: pid, exerciseName: 'Press de pecho T842', action: 'maintain', newLoad: 100, newReps: 10 }] };
  const s2 = runCoachFeedFor(eReview, 'COACH_REVIEW_REQUIRED');
  const rec2 = Object.values(s2.out.records)[0];
  assert.equal(rec2.state, 'PENDING');
  assert.ok(rec2.magnitude.coachReviewRequired && rec2.magnitude.coachReviewRequired.branch === 'C+E');
  assert.match(s2.html, /REVISIÓN DEL COACH REQUERIDA/);
  assert.match(s2.html, /sin candidato automático/);
  assert.match(s2.html, /REVISIÓN DEL COACH/);

  // State 3: Sin cambio recomendado (maintain with on-target effort -> REJECTED / NO_NUMERIC_DELTA)
  const eMaintain = {};
  [1, 2].forEach((w) => [0, 1, 2].forEach((s) => {
    eMaintain['log_' + w + '_0_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, ics: 7.5, prescriptionExerciseId: pid, ts: T0 + w * 1e6 + s };
  }));
  eMaintain.progrec_2_0 = { calculatedAt: calcAt, recommendations: [{ prescriptionExerciseId: pid, exerciseName: 'Press de pecho T842', action: 'maintain', newLoad: 100, newReps: 10 }] };
  const s3 = runCoachFeedFor(eMaintain, 'NO_CHANGE_RECOMMENDED');
  const rec3 = Object.values(s3.out.records)[0];
  assert.equal(rec3.state, 'REJECTED');
  assert.equal(rec3.reasonCode, 'NO_NUMERIC_DELTA');
  assert.match(s3.html, /RECHAZADA/);
  assert.match(s3.html, /NO_NUMERIC_DELTA/);

  // State 4: Evaluación no elegible (0 comparable exposures via autoFilled sets -> INSUFFICIENT_COMPARABLE_EXPOSURES)
  const eInelig = {};
  [0, 1, 2].forEach((s) => {
    eInelig['log_1_0_0_s' + s] = { done: true, autoFilled: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 4, ics: 7.5, prescriptionExerciseId: pid, ts: T0 + 1e6 + s };
  });
  eInelig.progrec_1_0 = { calculatedAt: calcAt, recommendations: [{ prescriptionExerciseId: pid, exerciseName: 'Press de pecho T842', action: 'increase_load', newLoad: 102.5, newReps: 10 }] };
  const s4 = runCoachFeedFor(eInelig, 'NOT_ELIGIBLE');
  const rec4 = Object.values(s4.out.records)[0];
  assert.equal(rec4.state, 'PENDING');
  assert.equal(rec4.magnitude.eligible, false);
  assert.ok(rec4.magnitude.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES'));
  assert.match(s4.html, /Sin evidencia suficiente o bloqueada/);
  assert.match(s4.html, /BLOQUEADO · evidencia/);

  // State 5: Conflicto de seguridad (articularPain) & evidencia incompleta (magnitude: null)
  const ePain = JSON.parse(JSON.stringify(eShadow));
  ePain.postsession_2_0 = { eimd: 2, articularPain: { present: true, pattern: 'shoulder' }, ts: T0 + 2e6 + 500 };
  const s5 = runCoachFeedFor(ePain, 'SAFETY_CONFLICT');
  const rec5 = Object.values(s5.out.records)[0];
  assert.equal(rec5.magnitude.eligible, false);
  assert.ok(rec5.magnitude.reasonCodes.includes('SAFETY_CONFLICT'));
  assert.match(s5.html, /conflicto de seguridad/);

  // Incomplete evidence (magnitude omitted)
  const incompleteHtml = coachUI._shadowAuditLines({
    key: rec1.key, revision: 1, state: 'PENDING', reasonCode: 'MAGNITUDE_POLICY_MISSING',
    prescriptionExerciseId: pid, source: { week: 2, dayIndex: 0 }, nextExposure: { week: 3, dayIndex: 0 },
    magnitude: null
  });
  assert.match(incompleteHtml, /Sin decisión numérica canónica todavía/);
  assert.ok(!/undefined|NaN/.test(incompleteHtml));
});

test('T842.U3 Trigger persistence failure returns safe HTTP 500 without leaking UID, token or internal details', async () => {
  const logs = [];
  const secretToken = 'eyJ-secret-synthetic-token-t842';
  const syntheticUid = 'uid-secret-t842-fail';
  const handler = trigger.makeHandler({
    db: {
      runTransaction: async () => {
        const err = new Error('Simulated Firestore write failure for ' + syntheticUid);
        err.code = 14;
        throw err;
      }
    },
    verifyIdToken: async () => ({ uid: syntheticUid }),
    enabled: true,
    numericApplyEnabled: false,
    log: (line) => logs.push(line)
  });
  let status = null, body = null;
  const headers = {};
  await handler(
    { method: 'POST', headers: { authorization: 'Bearer ' + secretToken }, body: { planId: 'plan-t842' } },
    { status(c) { status = c; return this; }, json(b) { body = b; return this; }, setHeader(k, v) { headers[k] = v; } }
  );
  assert.equal(status, 500);
  assert.deepEqual(body, { error: 'PROGRESSION_PROCESSING_FAILED' });
  assert.ok(/^[a-f0-9-]{36}$/i.test(headers['x-vdsen-progression-request-id']));
  const raw = JSON.stringify({ body, logs });
  assert.ok(!raw.includes(secretToken), 'Token must never leak');
  assert.ok(!raw.includes(syntheticUid), 'UID must never leak');
  const parsedLog = JSON.parse(logs[0]);
  assert.equal(parsedLog.errorCategory, 'UNAVAILABLE');
  assert.equal(parsedLog.numericApplyEnabled, false);
});
