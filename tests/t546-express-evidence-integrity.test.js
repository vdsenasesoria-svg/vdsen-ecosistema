// T546 A: Express mode must never fabricate observed evidence. PRESCRIBED VALUES ARE NEVER OBSERVED VALUES.
// Traced fabrication sites (vdsen-cliente.html, before this ticket):
//   markExpressDone          rirLast default (hidden xrir_val preset to the prescribed RIR, else 2) -> rir_real on EVERY synthetic set;
//                            ics||8 and pump||1 on every set; `rir` (prescribed slot) overwritten with the observed value
//   markExpressSSDone / ssCompleteLastRound   the same, with the previous week's observed RIR / default 2 as the preselection
//   _buildExCard (express block) / superset form   hidden RIR input rendered with the suggestion as its VALUE
// Contract: a suggestion may be shown, stored evidence needs an explicit athlete action; the last standard set carries the only
// observed RIR/ICS/Pump; earlier Express sets are "marked done" and carry none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const POLICY = require('../assets/progression-magnitude-policy.js');

function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let d = 0, q = null, esc = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const c = src[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
const HELPERS = ['_expressObs', '_isExpressLog', '_expressSetEntries', '_expressRecord', '_expressPrescribedRir'];
function harness({ rir = '', ics = '', pump = '', carga = '60', reps = '8', sets = '3', ej } = {}) {
  const mk = v => { const cls = new Set(); return { value: v, classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, remove(c) { cls.delete(c); }, add(c) { cls.add(c); }, has: c => cls.has(c) }, setAttribute() {}, style: {}, dataset: {} }; };
  const els = { xcarga_0_0: mk(carga), xreps_0_0: mk(reps), xsets_0_0: mk(sets), xrir_val_0_0: mk(rir), xics_0_0: mk(ics), xpump_val_0_0: mk(pump), xrirpre_0_0: mk('') };
  for (let r = 0; r <= 4; r++) els['xrir_0_0_' + r] = mk('');
  for (let p = 1; p <= 3; p++) els['xpump_0_0_' + p] = mk('');
  const ctx = {
    console, Date, JSON, Math, parseInt, parseFloat, isFinite, String, Number, Array, Object, isNaN,
    document: { getElementById: id => els[id] || null }, window: {},
    LOGS: {}, CURRENT_WEEK: 1, REAL_WEEK: 1, _EJERCICIOS_DIA: [ej],
    getExUnit: () => 'KG', _lbwTrack() {}, _recordExerciseHistoryAndPR() {}, saveLogs() {}, startRestTimer() {}, showToast() {},
    _getCatalogData: () => null, _refreshExPanelOnly() {}, _withOverlayRest: x => x,
  };
  vm.createContext(ctx);
  const names = ['_coachRIR', 'getAdjustedRIR', 'expressSetRIR', 'expressSetPump', 'markExpressDone', 'markExpressSSDone'].concat(HELPERS.filter(n => client.includes('function ' + n + '(')));
  vm.runInContext(names.map(n => fnSrc(client, n)).join('\n') + '\nthis.f = { expressSetRIR, expressSetPump, markExpressDone };', ctx);
  return { ctx, els, f: ctx.f };
}
const PLAN_EX = () => ({ exerciseName: 'Press Convergente Inclinado', prescriptionExerciseId: 'pid-1', exerciseId: 'ex-1',
  sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 8, rirTarget: 3, load: 0, restSeconds: 150 })) });
const setsOf = ctx => [0, 1, 2].map(s => ctx.LOGS['log_1_0_0_s' + s]);

test('T546.A untouched RIR / ICS / Pump: nothing observed is persisted (RIR not fabricated, ICS not 8, Pump not 1)', () => {
  const { ctx, f } = harness({ ej: PLAN_EX() });
  f.markExpressDone(0, 0);
  const rec = ctx.LOGS['exexpress_1_0_0'];
  assert.ok(rec && rec.done === true, 'the exercise is registered');
  assert.ok(rec.rir_last === null || rec.rir_last === undefined, 'no observed RIR on the express record: ' + rec.rir_last);
  assert.ok(rec.ics == null && rec.pump == null);
  for (const [i, s] of setsOf(ctx).entries()) {
    assert.ok(s && s.done === true, 'set ' + i + ' is marked done');
    assert.ok(!('rir_real' in s) || s.rir_real == null, 'set ' + i + ' has no observed RIR: ' + s.rir_real);
    assert.ok(!('ics' in s) || s.ics == null, 'set ' + i + ' has no ICS (was 8): ' + s.ics);
    assert.ok(!('pump' in s) || s.pump == null, 'set ' + i + ' has no Pump (was 1): ' + s.pump);
  }
});

test('T546.B an explicit RIR tap persists exactly that value on the final standard set', () => {
  const { ctx, f } = harness({ ej: PLAN_EX() });
  f.expressSetRIR('0_0', 2);
  f.markExpressDone(0, 0);
  const last = setsOf(ctx)[2];
  assert.equal(last.rir_real, 2);
  assert.equal(ctx.LOGS['exexpress_1_0_0'].rir_last, 2);
});

test('T546.C the final RIR is NOT copied to the earlier Express sets', () => {
  const { ctx, f } = harness({ ej: PLAN_EX() });
  f.expressSetRIR('0_0', 1);
  f.markExpressDone(0, 0);
  const [s0, s1, s2] = setsOf(ctx);
  assert.ok(!('rir_real' in s0) || s0.rir_real == null, 'S1 carries no observed RIR: ' + s0.rir_real);
  assert.ok(!('rir_real' in s1) || s1.rir_real == null, 'S2 carries no observed RIR: ' + s1.rir_real);
  assert.equal(s2.rir_real, 1);
});

test('T546.D/E ICS: untouched = absent; touched = the exact value, on the final set only', () => {
  const a = harness({ ej: PLAN_EX() }); a.f.markExpressDone(0, 0);
  assert.ok(setsOf(a.ctx).every(s => s.ics == null));
  const b = harness({ ej: PLAN_EX(), ics: '9' }); b.f.markExpressDone(0, 0);
  const [s0, s1, s2] = setsOf(b.ctx);
  assert.equal(s2.ics, 9); assert.ok(s0.ics == null && s1.ics == null);
  assert.equal(b.ctx.LOGS['exexpress_1_0_0'].ics, 9);
});

test('T546.F/G Pump: untouched = absent; touched = the exact value, on the final set only', () => {
  const a = harness({ ej: PLAN_EX() }); a.f.markExpressDone(0, 0);
  assert.ok(setsOf(a.ctx).every(s => s.pump == null));
  const b = harness({ ej: PLAN_EX() }); b.f.expressSetPump('0_0', 3); b.f.markExpressDone(0, 0);
  const [s0, s1, s2] = setsOf(b.ctx);
  assert.equal(s2.pump, 3); assert.ok(s0.pump == null && s1.pump == null);
  assert.equal(b.ctx.LOGS['exexpress_1_0_0'].pump, 3);
});

test('T546.H the prescription is untouched and the prescribed RIR stays in the prescribed slot (never overwritten by an observation)', () => {
  const ej = PLAN_EX(); const before = JSON.stringify(ej);
  const { ctx, f } = harness({ ej });
  f.expressSetRIR('0_0', 0); f.markExpressDone(0, 0);
  assert.equal(JSON.stringify(ctx._EJERCICIOS_DIA[0]), before, 'plan exercise unchanged');
  for (const s of setsOf(ctx)) assert.equal(s.rir, 3, 'prescribed RIR 3 is kept in `rir`, observed 0 lives only in `rir_real`');
  assert.equal(setsOf(ctx)[2].rir_real, 0);
  for (const s of setsOf(ctx)) { assert.equal(s.prescriptionExerciseId, 'pid-1'); assert.equal(s.exerciseId, 'ex-1'); }
});

test('T546.I the form renders the suggestion only as a visual state: hidden observed-RIR inputs start EMPTY (express and superset)', () => {
  assert.ok(client.includes('<input type="hidden" id="xrir_val_\'+_expK+\'" value="">'), 'express: observed RIR starts empty');
  assert.ok(client.includes('<input type="hidden" id="xrir_val_\'+_ssk+\'" value="">'), 'superset: observed RIR starts empty');
  assert.ok(!/value="'\+_exPfRIR\+'"/.test(client), 'the suggestion is not the input value any more');
  assert.ok(!/value="'\+_ssRIRinit\+'"/.test(client));
  assert.ok(client.includes("class=\"rirb'+(sel?' on pre':'')+'\""), 'the superset suggestion is dashed too');
});

test('T546.J no fabricated defaults remain in any Express writer', () => {
  for (const n of ['markExpressDone', 'markExpressSSDone', 'ssCompleteLastRound']) {
    const s = fnSrc(client, n);
    assert.ok(!/ics\s*\|\|\s*8/.test(s), n + ': no ICS default');
    assert.ok(!/pump\s*\|\|\s*1/.test(s), n + ': no Pump default');
    assert.ok(!/:\s*2\s*\)\s*:\s*2/.test(s), n + ': no RIR default 2');
    assert.ok(!/rir_real\s*:\s*rirLast/.test(s), n + ': no fan-out of a single RIR onto every set');
  }
});

test('T546.K representative set: the LAST standard set carries the evidence; earlier Express sets never substitute; missing RIR stays missing', () => {
  const run = rirTap => {
    const { ctx, f } = harness({ ej: PLAN_EX() });
    if (rirTap !== null) f.expressSetRIR('0_0', rirTap);
    f.markExpressDone(0, 0);
    const entries = JSON.parse(JSON.stringify(ctx.LOGS));
    const exposures = POLICY.extractExposures(entries, 'pid-1', { planId: 'p', clientId: 'c' });
    const res = POLICY.evaluate({ prescriptionExerciseId: 'pid-1', planId: 'p', clientId: 'c', exposures, context: {}, plan: {},
      prescription: { prescriptionExerciseId: 'pid-1', sets: PLAN_EX().sets } });
    return { exposures, res };
  };
  const a = run(2);
  assert.equal(a.res.comparableExposureCount, 1, 'the explicit final set makes the exposure comparable');
  assert.equal(a.res.evidence.setIndex, 2, 'representative = last standard working set');
  assert.equal(a.res.evidence.workingSetCount, 1, 'earlier Express sets are excluded, nothing substituted');
  assert.equal(a.res.evidence.rirObserved, 2);
  assert.equal(a.res.evidence.rirPrescribed, 3, 'prescribed RIR comes from the prescription, not from the observation');
  const b = run(null);
  assert.equal(b.res.evidence.setIndex, 2);
  assert.equal(b.res.evidence.rirObserved, null, 'no explicit RIR => no observed RIR (missing evidence stays missing)');
  assert.equal(b.res.numericApplyAllowed, false); assert.equal(b.res.applied, false);
});

test('T546.L superset express: no fabricated RIR / ICS / Pump either (markExpressSSDone)', () => {
  const ej0 = PLAN_EX(), ej1 = Object.assign(PLAN_EX(), { exerciseName: 'Curl', prescriptionExerciseId: 'pid-2' });
  const { ctx, els } = harness({ ej: ej0 });
  ctx._EJERCICIOS_DIA = [ej0, ej1];
  const mk = v => ({ value: v, classList: { toggle() {}, remove() {}, add() {} }, setAttribute() {}, style: {} });
  Object.assign(els, { xrir_val_ss_0_0: mk(''), xics_ss_0_0: mk(''), xpump_val_ss_0_0: mk(''), xss_carga_0_0: mk('60'), xss_reps_0_0: mk('8'), xss_carga_0_1: mk('20'), xss_reps_0_1: mk('10') });
  vm.runInContext('markExpressSSDone(0,[0,1])', ctx);
  for (const idx of [0, 1]) for (let s = 0; s < 3; s++) {
    const e = ctx.LOGS['log_1_' + 0 + '_' + idx + '_s' + s];
    assert.ok(e && e.done === true);
    assert.ok(e.rir_real == null && e.ics == null && e.pump == null, 'member ' + idx + ' set ' + s + ' has no fabricated observation');
  }
});
