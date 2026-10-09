// T534: the Coach audit shows the full lifecycle compactly (exercise, PID, source/target exposure, before -> after, rule, equipment, timestamps,
// Coach action) and never offers an "apply" CTA. Reconciliation and revert go through the consumer transactions only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('./helpers/lifecycle-fixture.js');
const { makeStore } = require('./helpers/fake-firestore.js');
const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function fn(name, kind = 'function') {
  const st = coach.indexOf('  ' + kind + ' ' + name + '('); assert.ok(st >= 0, name);
  let d = 0, q = null, e = false;
  for (let i = coach.indexOf('{', st); i < coach.length; i++) { const c = coach[i];
    if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; } if (c === '{') d++; if (c === '}' && --d === 0) return coach.slice(st, i + 1); }
}
const ctx = { console, window: {} }; vm.createContext(ctx);
const esc = coach.indexOf('  function _escH(s) {'); vm.runInContext(coach.slice(esc, coach.indexOf('\n  }\n', esc) + 4), ctx);
vm.runInContext(coach.slice(coach.indexOf('  var _REVIEW_BRANCH = {'), coach.indexOf('  function _moduloDCanonicalView(')), ctx);
vm.runInContext(coach.slice(coach.indexOf('  var _LIFECYCLE_LABEL ='), coach.indexOf('  function _lifecycleLines(')), ctx);
['_lifecycleLines', '_dryRunLine', '_shadowAuditLines', '_renderShadowMagnitude', '_renderShadowAutoFeed'].forEach(n => vm.runInContext(fn(n), ctx));

const sc = F.scenario();
const view = (state) => { const a = F.applied(sc, { state });
  const rec = Object.assign({}, a.record, { lifecycle: Object.assign({}, a.record.lifecycle, { target: a.overlay.target,
    change: { dimension: a.overlay.dimension, previousValue: a.overlay.previousValue, appliedValue: a.overlay.appliedValue, unit: a.overlay.unit, ruleId: 'A' },
    equipment: { equipmentId: a.overlay.equipmentId, roundingReason: a.overlay.roundingReason, source: 'COACH_CONFIGURED', scope: 'SHARED', revision: 1 },
    ...(state === 'CONSUMED' ? { consumedAt: '2026-09-30T09:00:00.000Z' } : {}),
    ...(state === 'OVERRIDDEN' ? { overriddenAt: '2026-09-28T03:00:00.000Z', intervention: { id: 'iv', action: 'REDUCE_SETS', decidedAt: '2026-09-28T02:59:00.000Z' } } : {}),
    ...(state === 'REVERTED' ? { revertedAt: '2026-09-28T05:00:00.000Z' } : {}),
    ...(state === 'STALE' ? { staleAt: '2026-09-29T00:00:00.000Z', staleReason: 'PLAN_CHANGED' } : {}) }) });
  return ctx._renderShadowAutoFeed(F.shadowOn.summarize({ [rec.key]: rec }, 'p')); };

test('T534.1 every lifecycle state has its own label; APPLIED offers only "Revertir aplicación" (no apply CTA anywhere)', () => {
  const labels = { APPLIED: 'APLICADA', CONSUMED: 'CONSUMIDA', OVERRIDDEN: 'SUPERADA POR COACH', REVERTED: 'REVERTIDA', STALE: 'OBSOLETA' };
  for (const [st, l] of Object.entries(labels)) assert.ok(view(st).includes(l), st);
  const applied = view('APPLIED');
  assert.ok(applied.includes('data-shadow-action="REVERT_APPLIED"') && applied.includes('Revertir aplicación'));
  for (const st of ['CONSUMED', 'OVERRIDDEN', 'REVERTED', 'STALE']) assert.ok(!view(st).includes('REVERT_APPLIED'), st + ' cannot be reverted');
  assert.ok(!/Aplicar autom/i.test(coach.replace(/\/\/.*$/gm, '')) && !/data-shadow-action="APPLY/.test(coach), 'no apply CTA');
});

test('T534.2 the lifecycle lines show target exposure, before -> after, rule, equipment and timestamps', () => {
  const h = view('APPLIED');
  assert.ok(h.includes('Sem 2 · Día 1') && h.includes('carga 100 → 102.5 kg') && h.includes('regla A'));
  assert.ok(h.includes('Equipo functional-dumbbells · fuente COACH_CONFIGURED'));
  assert.ok(h.includes('aplicada 2026-09-28 01:00'));
  assert.ok(h.includes('pid-1') && h.includes('Sem 1 · Día 3'), 'PID + source exposure come from the existing audit lines');
});

test('T534.3 Coach action and reasons are visible: override, consume, revert, stale', () => {
  assert.ok(view('OVERRIDDEN').includes('Decisión del Coach: REDUCE_SETS'));
  assert.ok(view('CONSUMED').includes('consumida 2026-09-30 09:00'));
  assert.ok(view('REVERTED').includes('revertida 2026-09-28 05:00'));
  assert.ok(view('STALE').includes('Motivo: PLAN_CHANGED'));
});

test('T534.4 no internals: the feed never prints overlay keys, revisions of the overlay or raw enum blobs', () => {
  const h = view('APPLIED'); assert.ok(!/ovl_|"overlay|\[object|undefined|null/.test(h.replace(/data-shadow-revision="\d+"/g, '')));
});

test('T534.5 PENDING items keep their previous presentation (review / candidate / dry-run lines untouched by the lifecycle lines)', () => {
  const rec = sc.rec, h = ctx._renderShadowAutoFeed(F.shadowOn.summarize({ [rec.key]: rec }, 'p'));
  assert.ok(h.includes('PENDIENTE') && h.includes('KEEP_ORIGINAL') && !h.includes('REVERT_APPLIED') && !h.includes('Sem 2 · Día 1 · carga'));
});

test('T534.6 reconciliation runs ONLY when the summary counts an APPLIED record (flag off => never), and only through the consumer transactions', () => {
  assert.ok(/autoSummary\.counts && autoSummary\.counts\.APPLIED > 0/.test(coach));
  const rec = fn('_reconcileAppliedOverlays', 'async function');
  assert.ok(/cons\.overrideOverlayTransaction/.test(rec) && /cons\.staleOverlayTransaction/.test(rec) && !/tx\.set\(|setDoc|updateDoc/.test(rec));
  const rev = fn('_onRevertApplied', 'async function');
  assert.ok(/cons\.revertOverlayTransaction/.test(rev) && !/tx\.set\(|setDoc|updateDoc/.test(rev));
  assert.ok(!coach.includes('applyOverlayTransaction') && !coach.includes('recordConsumptionReceiptTransaction'), 'the Coach never applies (T537: the athlete alone writes receipts; the Coach only turns a valid receipt into CONSUMED)');
  assert.ok(/cons\.consumeOverlayTransaction/.test(rec));
  assert.ok(coach.includes('assets/progression-effective-prescription.js'));
});

test('T534.7 reconcile (Coach path, flag-on sandbox): a Coach decision after APPLIED -> OVERRIDDEN; plan replacement -> STALE; the Monitor summary follows', async () => {
  const REFS = { meso: 'logs/c/mesos/p', root: 'logs/c', plan: 'plans/p', client: 'clients/c' };
  const mk = async (over) => { const a = F.applied(sc); const s = makeStore({ [REFS.meso]: { planId: 'p', entries: a.entries, progressionApplications: a.records, nextExposureOverlays: a.overlays },
    [REFS.plan]: sc.plan, [REFS.client]: Object.assign({ activePlanId: 'p', coachInterventions: [] }, over), [REFS.root]: { planId: 'p' } }); return { a, s }; };
  const run = ({ a, s }) => { const cons = F.on.consumer, input = { recordKey: a.record.key, clientId: 'c', now: '2026-09-29T00:00:00.000Z', actorId: 'k' };
    return s.run(async tx => { const o = await cons.overrideOverlayTransaction(tx, REFS, input, {}); return o.written ? o : cons.staleOverlayTransaction(tx, REFS, input, {}); }); };
  const x = await mk({ coachInterventions: [{ id: 'iv', targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', action: 'KEEP', decidedAt: '2026-09-28T03:00:00.000Z' }] });
  const r1 = await run(x); assert.equal(r1.record.state, 'OVERRIDDEN'); assert.equal(r1.summary.counts.OVERRIDDEN, 1); assert.equal(x.s.get(REFS.root).progressionApplicationSummary.counts.OVERRIDDEN, 1);
  const y = await mk({ activePlanId: 'p-new' });
  const r2 = await run(y); assert.equal(r2.record.state, 'STALE');
  const z = await mk({}); const r3 = await run(z); assert.equal(r3.written, false, 'a healthy overlay is left alone');
});
