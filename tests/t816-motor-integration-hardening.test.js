'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const eff = require('../assets/progression-effective-prescription.js');
const vi = require('../assets/progression-variant-identity.js');

const ROOT = path.join(__dirname, '..');
const CLIENT_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-cliente.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  let depth = 0, inBody = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; inBody = true; }
    else if (ch === '}') { depth--; if (inBody && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unterminated function ' + name);
}

test('T816.1 describeProgression isolates variant records from original exercise records', () => {
  const clientId = 'ath-t816';
  const planId = 'plan-t816';
  const pid = 'pid-press';
  const variantExecId = vi.deriveExecutionId(pid, 'Press con mancuernas', [{ exerciseId: 'ex-db', nombre: 'Press con mancuernas' }], 'Press con barra');
  assert.ok(variantExecId && variantExecId !== pid);

  const plan = {
    id: planId,
    clientId,
    weeks: 6,
    updatedAt: '2026-11-01T10:00:00.000Z',
    days: [{
      dayIndex: 0,
      exercises: [{
        prescriptionExerciseId: pid,
        nombre: 'Press con barra',
        sets: [{ setIndex: 0, load: 80, repsTarget: 8, rirTarget: 2 }],
        alternatives: [{ exerciseId: 'ex-db', nombre: 'Press con mancuernas' }]
      }]
    }]
  };

  // Overlay + record exist ONLY for the authorized variant, NOT for the original exercise.
  const variantOvlKey = 'ovl_rec-var-1';
  const records = {
    'rec-var-1': {
      key: 'rec-var-1',
      clientId,
      planId,
      prescriptionExerciseId: pid,
      executionExerciseId: variantExecId,
      action: 'increase_load',
      dimension: 'LOAD',
      state: 'APPLIED',
      createdAt: '2026-11-10T10:00:05.000Z',
      lifecycle: { overlayKey: variantOvlKey },
      source: { week: 2, dayIndex: 0, calculatedAt: '2026-11-10T10:00:00.000Z' },
      nextExposure: { week: 3, dayIndex: 0 },
      magnitude: {
        ruleId: 'A',
        eligible: true,
        candidates: [{ dimension: 'LOAD', previousLoad: 30, finalCandidate: 32.5 }]
      }
    }
  };
  const overlays = {
    [variantOvlKey]: {
      schema: eff.OVERLAY_SCHEMA,
      key: variantOvlKey,
      sourceRecordKey: 'rec-var-1',
      clientId,
      planId,
      prescriptionExerciseId: pid,
      executionExerciseId: variantExecId,
      target: { week: 3, dayIndex: 0 },
      dimension: 'LOAD',
      previousValue: 30,
      appliedValue: 32.5,
      unit: 'KG',
      status: 'APPLIED',
      ruleId: 'A',
      presentation: { text: '32.5 KG' }
    }
  };

  // Querying for the variant shows APPLIED + variant recordKey + previousLoad 30
  const varView = eff.describeProgression({
    clientId, planId, activePlanId: planId, pid, executionExerciseId: variantExecId,
    week: 3, dayIndex: 0, records, overlays, interventions: [], plan, entries: {},
    baseSets: plan.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(varView.state, 'APPLIED');
  assert.equal(varView.applied, true);
  assert.equal(varView.recordKey, 'rec-var-1');
  assert.equal(varView.hasAppliedLoad, true);

  // Querying for the ORIGINAL exercise (no executionExerciseId or executionExerciseId === pid) must NOT leak variant recordKey/previousLoad/ruleId
  const origView = eff.describeProgression({
    clientId, planId, activePlanId: planId, pid, executionExerciseId: pid,
    week: 3, dayIndex: 0, records, overlays, interventions: [], plan, entries: {},
    baseSets: plan.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(origView.applied, false);
  assert.equal(origView.state, 'NO_AUTHORIZED_ADJUSTMENT');
  assert.equal(origView.recordKey, null);
  assert.equal(origView.ruleId, null);
  assert.equal(origView.previousLoad, null);
});

test('T816.2 _seriesAuthority in vdsen-cliente.html preserves authority for authorized substitutions and denies unauthorized ones', () => {
  const clientId = 'ath-t816';
  const planId = 'plan-t816';
  const pid = 'pid-press';
  const altName = 'Press con mancuernas';
  const variantExecId = vi.deriveExecutionId(pid, altName, [{ exerciseId: 'ex-db', nombre: altName }], 'Press con barra');
  const unauthExecId = vi.deriveExecutionId(pid, 'Flexiones libres', [{ exerciseId: 'ex-db', nombre: altName }], 'Press con barra');

  const planDoc = {
    id: planId,
    clientId,
    weeks: 6,
    updatedAt: '2026-11-01T10:00:00.000Z',
    days: [{
      dayIndex: 0,
      exercises: [{
        prescriptionExerciseId: pid,
        nombre: 'Press con barra',
        sets: [{ setIndex: 0, load: 80, repsTarget: 8, rirTarget: 2 }],
        alternatives: [{ exerciseId: 'ex-db', nombre: altName }]
      }]
    }]
  };

  const ctx = vm.createContext({
    USER: { uid: clientId },
    ACTIVE_PLAN_ID: planId,
    CURRENT_WEEK: 3,
    LOGS: {
      exsub_3_0_0: { nombre: altName }
    },
    LIFECYCLE_STATE: {
      uid: clientId,
      planId,
      planDoc,
      interventions: [],
      records: {
        'rec-var-1': {
          key: 'rec-var-1',
          clientId,
          planId,
          prescriptionExerciseId: pid,
          executionExerciseId: variantExecId,
          action: 'increase_load',
          dimension: 'LOAD',
          state: 'APPLIED',
          createdAt: '2026-11-10T10:00:05.000Z',
          lifecycle: { overlayKey: 'ovl_rec-var-1' },
          source: { week: 2, dayIndex: 0, calculatedAt: '2026-11-10T10:00:00.000Z' },
          nextExposure: { week: 3, dayIndex: 0 },
          magnitude: { ruleId: 'A', eligible: true, candidates: [{ dimension: 'LOAD', previousLoad: 30, finalCandidate: 32.5 }] }
        }
      },
      overlays: {
        'ovl_rec-var-1': {
          schema: eff.OVERLAY_SCHEMA,
          key: 'ovl_rec-var-1',
          sourceRecordKey: 'rec-var-1',
          clientId,
          planId,
          prescriptionExerciseId: pid,
          executionExerciseId: variantExecId,
          target: { week: 3, dayIndex: 0 },
          dimension: 'LOAD',
          previousValue: 30,
          appliedValue: 32.5,
          unit: 'KG',
          status: 'APPLIED',
          ruleId: 'A',
          presentation: { text: '32.5 KG' }
        }
      }
    },
    isY3TExercise: () => false,
    window: { VDSEN_EFFECTIVE_PRESCRIPTION: eff, VDSEN_VARIANT_IDENTITY: vi }
  });

  vm.runInContext(extractFn(CLIENT_HTML, '_seriesAuthority'), ctx);

  // Authorized substitution MUST return APPLIED authority with hasAppliedLoad = true
  const authView = ctx._seriesAuthority(planDoc.days[0].exercises[0], 0, 0, 'KG', variantExecId);
  assert.ok(authView, 'authorized substitution must not suppress _seriesAuthority');
  assert.equal(authView.state, 'APPLIED');
  assert.equal(authView.applied, true);
  assert.equal(authView.hasAppliedLoad, true);
  assert.equal(authView.recordKey, 'rec-var-1');

  // Unauthorized substitution MUST still return null
  ctx.LOGS.exsub_3_0_0 = { nombre: 'Flexiones libres' };
  const unauthView = ctx._seriesAuthority(planDoc.days[0].exercises[0], 0, 0, 'KG', unauthExecId);
  assert.equal(unauthView, null);
});

test('T816.3 _buildExCard forwards non-unauthorized executionExerciseId to _seriesAuthority', () => {
  const buildCardSrc = extractFn(CLIENT_HTML, '_buildExCard');
  assert.match(buildCardSrc, /_seriesAuthority\s*\(\s*ej\s*,\s*di\s*,\s*ei\s*,\s*unit\s*,\s*_isUnauthSub\s*\?\s*null\s*:\s*_execId\s*\)/);
});
