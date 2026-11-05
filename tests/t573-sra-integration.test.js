'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sra = require('../assets/sra-context.js');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const coach = fs.readFileSync('vdsen-coach.html', 'utf8');
function extract(src, decl) {
  const start = src.indexOf(decl), brace = src.indexOf('{', start); assert.ok(start >= 0);
  let depth = 0;
  for (let i = brace; i < src.length; i++) { depth += (src[i] === '{') - (src[i] === '}'); if (!depth) return src.slice(start, i + 1); }
  throw Error('unbalanced ' + decl);
}
const plan = { days: [{ exercises: [{ prescriptionExerciseId: 'p1', exerciseName: 'Squat', sets: [{}, {}, {}, {}, {}, {}, {}, {}] }] }] };
function evidence(concern = false) {
  const entries = {};
  for (let w = 1; w <= 6; w++) {
    entries['progrec_' + w + '_0'] = { deloadTriggers: concern && w % 2 ? ['existing-trigger'] : [], recommendations: [{ prescriptionExerciseId: 'p1', action: 'increase_load' }] };
    for (let i = 0; i < (w % 2 ? 8 : 4); i++) entries['log_' + w + '_0_0_s' + i] = { done: true, prescriptionExerciseId: 'p1', carga: 40, reps: 8 };
  }
  return entries;
}
function context(entries = evidence(), extra = {}) { return sra.buildContext({ clientId: 'c1', prescriptionExerciseId: 'p1', entries, planDoc: plan, ...extra }); }
function firewall() {
  const box = { USER: { uid: 'c1' }, ACTIVE_PLAN_ID: 'plan1', _sraPersisted: { version: 0, entries: {} } };
  vm.createContext(box); vm.runInContext(extract(client, 'function _acceptSraPersisted('), box);
  return box;
}
test('S01 stable real execution remains MONITOR', () => { const t = context(); assert.equal(t.sraSignal, 'RECOVERY_MONITOR'); assert.equal(t.reviewRequired, false); assert.equal(t.classification, 'MONITOR'); });
test('S02 existing recovery concerns require review', () => { const t = context(evidence(true)); assert.equal(t.sraSignal, 'RECOVERY_REVIEW'); assert.equal(t.reviewRequired, true); });
test('S03 favorable progression plus concern does not authorize an increase', () => { const t = context(evidence(true)); assert.equal(t.progressionSignal, 'increase_load'); assert.equal(t.finalRecommendation, 'REVIEW_REQUIRED'); });
test('S04 conservative progression is preserved alongside SRA', () => { const t = context(evidence(true), { progressionSignal: 'reduce_load', recommendation: 'reduce_load' }); assert.equal(t.progressionSignal, 'reduce_load'); assert.equal(t.finalRecommendation, 'REVIEW_REQUIRED'); });
test('S05 RULE classification remains explicit', () => { assert.equal(context(evidence(), { ruleOrRange: 'RULE' }).ruleOrRange, 'RULE'); });
test('S06 RANGE and HEURISTIC stay distinct', () => { for (const ruleOrRange of ['RANGE', 'HEURISTIC']) assert.equal(context(evidence(), { ruleOrRange }).ruleOrRange, ruleOrRange); });
test('S07 one exposure fails closed', () => { const e = evidence(); for (const k of Object.keys(e)) if (!/^log_1_|^progrec_1_/.test(k)) delete e[k]; assert.equal(context(e).dataStatus, 'INSUFFICIENT_DATA'); });
test('S08 absent/malformed recovery is unknown, never stable', () => { for (const missing of [null, {}]) { const e = evidence(); for (const k of Object.keys(e)) if (/^progrec_/.test(k)) e[k] = missing; assert.equal(context(e).sraSignal, 'INSUFFICIENT_DATA'); } });
test('S09 session volume is MONITOR_ONLY and inputs remain identical', () => { const e = evidence(), before = JSON.stringify({ e, plan }); const t = context(e); assert.equal(t.sessionVolume, 'MONITOR_ONLY'); assert.equal(t.numericApplyEnabled, false); assert.equal(t.mutation, 'NONE'); assert.equal(JSON.stringify({ e, plan }), before); });
test('S10 complete trace renders escaped evidence with separate signals', () => { const t = context(evidence(true), { progressionSignal: '<script>bad</script>' }); const html = sra.renderTrace(t, 'coach'); for (const k of ['clientId', 'prescriptionExerciseId', 'inputEvidence', 'evidenceWindow', 'classification', 'ruleOrRange', 'progressionSignal', 'sraSignal', 'agreementState', 'finalRecommendation', 'reason', 'reviewRequired', 'dataStatus', 'mutation']) assert.ok(k in t, k); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(html.includes('6 semanas persistidas')); });
test('S11 names and positions never substitute for PID', () => { const e = evidence(); for (const k of Object.keys(e)) if (/^log_/.test(k)) { delete e[k].prescriptionExerciseId; e[k].exerciseName = 'Squat'; } assert.equal(context(e).dataStatus, 'INSUFFICIENT_DATA'); assert.equal(context(e, { prescriptionExerciseId: null }).mutation, 'NONE'); });
test('S12 client and plan identities fence snapshots', () => { const b = firewall(); assert.equal(b._acceptSraPersisted('other', 'plan1', evidence(), 10), false); assert.equal(b._acceptSraPersisted('c1', 'other', evidence(), 10), false); assert.equal(context(evidence(), { clientId: null }).dataStatus, 'INSUFFICIENT_DATA'); assert.equal(context(evidence(), { prescriptionExerciseId: 'unknown' }).dataStatus, 'INSUFFICIENT_DATA'); });
test('S13 pending and failed evidence excluded, no estimates from history', () => { for (const flag of ['pending', 'failed', 'rollback', 'stale', 'autoFilled']) { const e = evidence(); for (const k of Object.keys(e)) if (/^log_/.test(k)) e[k][flag] = true; assert.equal(context(e).dataStatus, 'INSUFFICIENT_DATA', flag); } assert.equal(sra.computeRecoverySensitivity({}, plan, { byPrescriptionExerciseId: { p1: { history: [{ week: 1, setCompletionRate: 1 }] } } }).pattern, 'INSUFFICIENT_DATA'); });
test('S14 stale authority rejected and mutable/rollback state cannot leak', () => { const b = firewall(), e = evidence(); assert.equal(b._acceptSraPersisted('c1', 'plan1', e, 20), true); e.log_1_0_0_s0.autoFilled = true; assert.equal(b._sraPersisted.entries.log_1_0_0_s0.autoFilled, undefined); assert.equal(b._acceptSraPersisted('c1', 'plan1', {}, 19), false); assert.ok(Object.keys(b._sraPersisted.entries).length > 0); });
test('S15 duplicate clicks and repeated rendering do not append evidence', () => { const e = evidence(), first = context(e); e.log_1_0_0_s0 = { ...e.log_1_0_0_s0 }; assert.deepEqual(context(e), first); sra.renderTrace(first); sra.renderTrace(first); assert.deepEqual(context(e), first); });
test('S16 real Client and Coach consumers use the single read-only engine', () => { const b = firewall(); Object.assign(b, { window: { VDSEN_SRA: sra }, PLAN: plan, getSesiones: () => plan.days }); b._acceptSraPersisted('c1', 'plan1', evidence(true), 1); vm.runInContext(extract(client, 'function _renderClientSra('), b); const html = b._renderClientSra(); assert.ok(html.includes('Revisión Coach requerida')); assert.ok(html.includes('increase_load')); assert.ok(coach.includes("html += window.VDSEN_SRA.renderTrace(trace, 'coach')")); assert.equal((coach.match(/function _computeRecoverySensitivity/g) || []).length, 1); assert.ok(extract(coach, 'function _computeRecoverySensitivity(').includes('return window.VDSEN_SRA.computeRecoverySensitivity')); });
