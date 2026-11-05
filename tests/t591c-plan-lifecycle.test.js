'use strict';
// T591-C: ALL six routes that replace a client's active plan (import, manual, template x2, duplicate x2) go through ONE transactional, idempotent assignment:
// new plan + clients.activePlanId + backup of the outgoing plan + its historical retirement commit together or not at all; a retry (double click, lost acknowledgement,
// app reload) never creates a second plan or a second backup; a concurrent change aborts the operation without writing; nothing is ever deleted.
// The REAL functions of vdsen-coach.html run in a vm against an in-memory Firestore with transactions and injectable failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const { coach, S, planObjFor, makeStore, harness, base, newPlans, backups } = require('./helpers/coach-assign-harness.js');

const TEMPLATE = { name: 'Fuerza 4d', weeks: 4, days: [{ label: 'D1', exercises: [{ exerciseName: 'Press', sets: S(3) }, { exerciseName: 'Remo', sets: S(3) }] }] };
const MANUAL = () => ({ weeks: 4, days: [{ dayIndex: 0, label: 'Día 1', exercises: [{ exerciseName: 'Press', sets: S(3) }] }] });
const withSource = () => Object.assign(base(), {
  'clients/cl2': { coachId: 'c1', displayName: 'Otro', activePlanId: 's1' },
  'plans/s1': { coachId: 'c1', clientId: 'cl2', status: 'active', weeks: 4, rirByWeek: { 1: 3, 2: 2, 3: 1, 4: 4 }, rirByWeekSource: 'generator', updatedAt: '2026-09-02T00:00:00.000Z', createdAt: '2026-09-02T00:00:00.000Z',
    days: [{ dayIndex: 0, label: 'Fuente', exercises: [{ exerciseName: 'Press', prescriptionExerciseId: 'SRC-PID-1', sets: S(3) }, { exerciseName: 'Cinta', exerciseType: 'cardio', duracionMin: 30, prescriptionExerciseId: 'SRC-PID-2', sets: [] }] }] }
});
// the six routes, each driven through its real entry point
const ROUTES = [
  { name: 'import', init: base, run: async (h) => { h.ctx.window._importedPlan = h.__plan || (h.__plan = planObjFor()); return h.ctx.saveImportedPlan('cl1'); } },
  { name: 'manual', init: base, run: async (h) => { h.ctx.setManualPlan(h.__plan || (h.__plan = MANUAL())); h.opts.selected = 'cl1'; return h.ctx.saveManualPlan(); } },
  { name: 'template-client', init: base, run: async (h) => h.ctx._applyTemplateToClient(TEMPLATE, 'cl1', null) },
  { name: 'template-assign', init: base, run: async (h) => { h.ctx.BUILTIN_TEMPLATES[0] = TEMPLATE; h.opts.pick = 'cl1'; return h.ctx.applyTemplate(0, 'builtin'); } },
  { name: 'duplicate', init: withSource, run: async (h) => { h.opts.pick = 'cl1'; return h.ctx.duplicatePlan('cl1', 'p0'); } },
  { name: 'duplicate-to-client', init: withSource, run: async (h) => { h.ctx.__dom['#_dupTarget'] = { value: 'cl1' }; h.ctx.__dom['#_dupOk'] = {}; await h.ctx.duplicatePlanToClient('s1'); const ok = h.ctx.__dom['#_dupOk'].onclick; return ok ? ok() : undefined; } }   // no dialog = the target is not selectable (not one of the coach clients)
];
function mk(route, extra) {
  const opts = Object.assign({}, extra || {}); const h = harness(route.init(), opts); h.opts = opts; return h;
}
const journalKeys = (h) => { try { return Object.keys(JSON.parse(h.ls.vdsen_assign_journal_v1 || '{}')); } catch (e) { return ['<corrupt>']; } };

for (const route of ROUTES) {
  test(`T591C-1 [${route.name}] replacing the active plan is ONE atomic commit: new plan + pointer + backup + historical retirement, nothing deleted`, async () => {
    const h = mk(route); await route.run(h);
    const np = newPlans(h); assert.equal(np.length, 1, 'exactly one new plan'); const id = np[0].split('/')[1], clientId = 'cl1';
    assert.equal(h.st.data['clients/cl1'].activePlanId, id, 'authority: activePlanId points to the new plan');
    const doc = h.st.data[np[0]]; assert.equal(doc.status, 'active'); assert.equal(doc.clientId, clientId); assert.equal(doc.coachId, 'c1');
    assert.ok(typeof doc.createdAt === 'string' && doc.createdAt === doc.updatedAt, 'createdAt / updatedAt: one ISO event'); assert.ok(!('supersededAt' in doc) && !('supersededBy' in doc) && !('id' in doc), 'a new plan is never born historical');
    assert.ok(doc.days[0].exercises.every((e) => e.prescriptionExerciseId), 'every exercise carries a PID');
    const old = h.st.data['plans/p0']; assert.equal(old.status, 'superseded'); assert.equal(old.supersededBy, id); assert.ok(old.supersededAt, 'retired explicitly'); assert.equal(old.updatedAt, '2026-09-01T00:00:00.000Z', 'prescription revision stamp untouched');
    if (route.name !== 'duplicate') assert.deepEqual(old.days, [{ label: 'viejo', exercises: [] }], 'history intact');
    assert.deepEqual(backups(h), ['plans_backup/p0__replaced_by__' + id], 'one backup, one per replacement'); assert.equal(h.st.data[backups(h)[0]].originalPlanId, 'p0');
    assert.equal(h.st.log.commits, 1, 'one transaction'); assert.equal(journalKeys(h).length, 0, 'the journal is cleared after success');
    assert.ok(!/deleteDoc/.test(coach.slice(coach.indexOf('async function _assignPlanTxn'), coach.indexOf('async function _assignPlanTxn') + 3500)), 'the engine never deletes');
  });

  test(`T591C-2 [${route.name}] a failure BEFORE commit writes nothing (no orphan, client and old plan untouched) and the retry creates exactly one plan`, async () => {
    const h = mk(route); h.st.hooks.failCommit = Object.assign(new Error('network down'), { code: 'unavailable' });
    await route.run(h);
    assert.equal(newPlans(h).length, 0, 'no orphan plan'); assert.equal(h.st.data['clients/cl1'].activePlanId, 'p0'); assert.equal(h.st.data['plans/p0'].status, 'active'); assert.equal(backups(h).length, 0, 'no backup without the replacement');
    assert.ok(h.toasts.some((t) => t.e && /No se pudo confirmar.*reintenta.*NO se duplicará/i.test(t.m) || (route.name === 'duplicate-to-client' && t.e)), 'explicit, honest failure message (it may or may not have been saved; the retry is safe)');
    assert.equal(journalKeys(h).length, 1, 'the ambiguous failure keeps the attempt id so a retry can recognise a commit that did happen');
    h.st.hooks.failCommit = null; await route.run(h);
    assert.equal(newPlans(h).length, 1, 'exactly one plan after the retry'); assert.equal(h.st.data['clients/cl1'].activePlanId, newPlans(h)[0].split('/')[1]); assert.equal(backups(h).length, 1);
    assert.equal(h.st.data['plans/p0'].status, 'superseded'); assert.equal(journalKeys(h).length, 0);
  });

  test(`T591C-3 [${route.name}] commit done but acknowledgement lost: the retry creates no second plan, no second backup, no second retirement`, async () => {
    const h = mk(route); h.st.hooks.failCommit = Object.assign(new Error('ack lost'), { code: 'deadline-exceeded' }); h.st.hooks.applyThenFail = true;
    await route.run(h); const first = newPlans(h); assert.equal(first.length, 1, 'the server did commit'); const supersededAt = h.st.data['plans/p0'].supersededAt;
    h.st.hooks.failCommit = null; h.st.hooks.applyThenFail = false; h.confirms.length = 0; h.toasts.length = 0;
    await route.run(h);
    assert.deepEqual(newPlans(h), first, 'the SAME plan, no second document'); assert.equal(backups(h).length, 1, 'a single backup'); assert.equal(h.st.data['plans/p0'].supersededAt, supersededAt, 'the retirement was not rewritten');
    assert.equal(h.st.data['clients/cl1'].activePlanId, first[0].split('/')[1]); assert.equal(h.confirms.length, 0, 'no "replace the active plan" question for a plan that is already active'); assert.equal(journalKeys(h).length, 0);
  });

  test(`T591C-4 [${route.name}] retry after an APP RELOAD (new page, same browser storage) is idempotent`, async () => {
    const h1 = mk(route); h1.st.hooks.failCommit = Object.assign(new Error('page died'), { code: 'deadline-exceeded' }); h1.st.hooks.applyThenFail = true;
    await route.run(h1); const first = newPlans(h1); assert.equal(first.length, 1);
    h1.st.hooks.failCommit = null; h1.st.hooks.applyThenFail = false;
    const h2 = harness(null, { st: h1.st, ls: h1.ls, idPrefix: 'reload' }); h2.opts = {}; Object.assign(h2.opts, {});   // a fresh page: new vm, same backend, same localStorage
    const h2full = Object.assign(h2, { opts: h2.opts }); h2full.__plan = h1.__plan;
    await route.run(h2full);
    assert.deepEqual(newPlans(h1), first, 'no second plan after the reload'); assert.equal(backups(h1).length, 1); assert.equal(h1.st.data['clients/cl1'].activePlanId, first[0].split('/')[1]);
  });

  test(`T591C-5 [${route.name}] two devices: the active plan changed elsewhere while this one was working -> aborts, writes nothing, respects the other device`, async () => {
    const h = mk(route);
    let fired = false;
    h.st.hooks.beforeConfirm = async () => { if (fired) return; fired = true; h.st.data['clients/cl1'].activePlanId = 'pOther'; h.st.data['plans/pOther'] = { coachId: 'c1', clientId: 'cl1', status: 'active' }; };
    // for the routes without a confirm question the other device acts right after this device has read the previous plan id (its first strict read)
    const realGet = h.st.getDoc; let reads = 0;
    h.ctx.getDoc = async (ref) => { const out = await realGet(ref); const frozen = out.exists() ? out.data() : undefined; if (frozen !== undefined) out.data = () => JSON.parse(JSON.stringify(frozen)); if (ref.path === 'clients/cl1' && ++reads === 1 && !fired) { fired = true; h.st.data['clients/cl1'].activePlanId = 'pOther'; h.st.data['plans/pOther'] = { coachId: 'c1', clientId: 'cl1', status: 'active' }; } return out; };
    await route.run(h);
    assert.equal(newPlans(h).length, 0, 'no plan written'); assert.equal(h.st.data['clients/cl1'].activePlanId, 'pOther', 'the other device is respected, not overwritten'); assert.equal(h.st.data['plans/p0'].status, 'active', 'the old plan is untouched'); assert.equal(backups(h).length, 0);
    assert.ok(h.toasts.some((t) => t.e && /cambió mientras confirmabas.*NO se guardó nada/.test(t.m)), 'explicit conflict message');
    assert.equal(journalKeys(h).length, 0, 'a definitive failure clears the attempt');
  });

  test(`T591C-6 [${route.name}] double click / two simultaneous invocations create ONE plan and ONE backup`, async () => {
    const h = mk(route); await Promise.all([route.run(h), route.run(h)]);
    assert.equal(newPlans(h).length, 1); assert.equal(backups(h).length, 1); assert.equal(h.st.data['clients/cl1'].activePlanId, newPlans(h)[0].split('/')[1]); assert.equal(h.st.data['plans/p0'].status, 'superseded');
  });

  test(`T591C-7 [${route.name}] a client of another coach writes nothing; a first plan (no active one) needs no backup and no retirement`, async () => {
    const f = harness(route.init(), { selected: 'cl1', pick: 'cl1' }); f.opts = f; f.st.data['clients/cl1'].coachId = 'OTHER'; f.opts.selected = 'cl1';
    const fr = Object.assign(f, { opts: { selected: 'cl1', pick: 'cl1' } });
    // rebuild with the foreign owner from the start so every route sees it
    const init = route.init(); init['clients/cl1'].coachId = 'OTHER'; const foreign = harness(init, { selected: 'cl1', pick: 'cl1' }); foreign.opts = { selected: 'cl1', pick: 'cl1' };
    const fh = harness(init, foreign.opts); fh.opts = foreign.opts; await route.run(fh);
    assert.equal(newPlans(fh).length, 0); assert.equal(backups(fh).length, 0); assert.equal(fh.st.data['plans/p0'].status, 'active'); assert.ok(fh.toasts.some((t) => t.e), 'visible error'); void fr;
    const init2 = route.init(); delete init2['clients/cl1'].activePlanId; const first = harness(init2, { selected: 'cl1', pick: 'cl1' }); first.opts = { selected: 'cl1', pick: 'cl1' };
    const fh2 = harness(init2, first.opts); fh2.opts = first.opts; await route.run(fh2);
    assert.equal(newPlans(fh2).length, 1); assert.equal(backups(fh2).length, 0, 'nothing to back up'); assert.equal(fh2.st.data['plans/p0'].status, 'active', 'an unrelated old plan is not touched'); assert.equal(fh2.st.data['clients/cl1'].activePlanId, newPlans(fh2)[0].split('/')[1]);
  });
}

test('T591C-8 history is never lost: consecutive replacements keep every plan and one distinct backup per replacement; the same plan assigned twice on purpose creates two plans', async () => {
  const h = harness(base(), { selected: 'cl1' }); h.opts = { selected: 'cl1' };
  await h.ctx._applyTemplateToClient(TEMPLATE, 'cl1', null); const a = newPlans(h)[0].split('/')[1];
  await h.ctx._applyTemplateToClient(TEMPLATE, 'cl1', null);   // same template again, deliberately: a NEW plan (the first attempt completed)
  const ids = newPlans(h).map((k) => k.split('/')[1]); assert.equal(ids.length, 2, 'two plans'); const b = ids.find((x) => x !== a);
  assert.equal(h.st.data['clients/cl1'].activePlanId, b); assert.equal(h.st.data['plans/p0'].status, 'superseded'); assert.equal(h.st.data['plans/' + a].status, 'superseded'); assert.equal(h.st.data['plans/' + a].supersededBy, b); assert.equal(h.st.data['plans/' + b].status, 'active');
  assert.deepEqual(backups(h).sort(), ['plans_backup/' + a + '__replaced_by__' + b, 'plans_backup/p0__replaced_by__' + a].sort(), 'distinct backup ids: no collision between replacements');
  assert.ok(h.st.data['plans/p0'] && h.st.data['plans/' + a], 'nothing deleted');
});

test('T591C-9 duplicates keep the plan intact: explicit Generator rirByWeek + source, targets, cardio; only the PIDs are re-minted; no historical marks are inherited', async () => {
  for (const name of ['duplicate', 'duplicate-to-client']) {
    const route = ROUTES.find((r) => r.name === name); const init = withSource(); init['plans/s1'].status = 'superseded'; init['plans/s1'].supersededAt = 'x'; init['plans/s1'].supersededBy = 'y';
    const h = harness(init, { pick: 'cl2' }); h.opts = { pick: 'cl2' };
    if (name === 'duplicate') { init['clients/cl2'].activePlanId = 's1'; await h.ctx.duplicatePlan('cl2', 's1'); } else { h.ctx.__dom['#_dupTarget'] = { value: 'cl1' }; h.ctx.__dom['#_dupOk'] = {}; await h.ctx.duplicatePlanToClient('s1'); await h.ctx.__dom['#_dupOk'].onclick(); }
    void route;
    const np = newPlans(h); assert.equal(np.length, 1, name); const d = h.st.data[np[0]];
    assert.deepEqual(d.rirByWeek, { 1: 3, 2: 2, 3: 1, 4: 4 }, name + ': the Generator scheme is preserved'); assert.equal(d.rirByWeekSource, 'generator');
    assert.equal(d.status, 'active'); assert.ok(!('supersededAt' in d) && !('supersededBy' in d), 'no historical marks inherited');
    const ex = d.days[0].exercises; assert.equal(ex[0].sets.length, 3); assert.equal(ex[1].exerciseType, 'cardio'); assert.equal(ex[1].duracionMin, 30); assert.equal(ex[1].sets.length, 0, 'cardio target untouched');
    assert.ok(ex.every((e) => e.prescriptionExerciseId && !/^SRC-PID/.test(e.prescriptionExerciseId)), 'PIDs re-minted (new prescription, no history inheritance)');
    assert.equal(d.clientId, name === 'duplicate' ? 'cl2' : 'cl1');
  }
});

test('T591C-10 the attempt journal: kept on ambiguous failures, cleared on definitive ones and on success, expires, and never reuses an id that already became history', async () => {
  const h = harness(base(), {}); h.opts = {}; const key = h.ctx._assignOpKey('k', 'src', 'cl1');
  const id1 = h.ctx._assignPlanId(key); assert.equal(h.ctx._assignPlanId(key), id1, 'stable within the attempt');
  const j = JSON.parse(h.ls.vdsen_assign_journal_v1); j[key].at -= 25 * 3600 * 1000; h.ls.vdsen_assign_journal_v1 = JSON.stringify(j);
  const id2 = h.ctx._assignPlanId(key); assert.notEqual(id2, id1, 'a journal entry older than 24 h expires');
  h.ls.vdsen_assign_journal_v1 = '{not json'; const id3 = h.ctx._assignPlanId(key); assert.ok(id3, 'a corrupt journal never blocks an assignment');
  const other = harness(base(), {}); other.ls.vdsen_assign_journal_v1 = JSON.stringify({ [key]: { planId: 'foreignAttempt', at: Date.now(), coach: 'c2' } }); assert.notEqual(other.ctx._assignPlanId(key), 'foreignAttempt', 'another coach\'s attempt is ignored');
  // an id of an attempt that DID commit and was later replaced is never overwritten
  const s = harness(base(), {}); s.opts = {};
  s.st.hooks.failCommit = Object.assign(new Error('ack lost'), { code: 'deadline-exceeded' }); s.st.hooks.applyThenFail = true;
  await s.ctx._applyTemplateToClient(TEMPLATE, 'cl1', null); const first = newPlans(s)[0].split('/')[1]; s.st.hooks.failCommit = null; s.st.hooks.applyThenFail = false;
  s.st.data['clients/cl1'].activePlanId = 'pLater'; s.st.data['plans/pLater'] = { coachId: 'c1', clientId: 'cl1', status: 'active' };   // another replacement happened meanwhile
  const before = JSON.stringify(s.st.data['plans/' + first]);
  await s.ctx._applyTemplateToClient(TEMPLATE, 'cl1', null);
  assert.equal(JSON.stringify(s.st.data['plans/' + first]), before, 'the earlier committed plan is never overwritten'); assert.equal(newPlans(s).length, 2, 'the new attempt got a fresh id');
});

test('T591C-11 the routes are the engine: no loose plan creation / pointer update / delete remains in any of the six functions', () => {
  for (const fn of ['saveImportedPlan', 'saveManualPlan', '_applyTemplateToClient', 'applyTemplate', 'duplicatePlan', 'duplicatePlanToClient']) {
    const i = coach.indexOf('async function ' + fn + '('); assert.ok(i > 0, fn);
    const body = require('./helpers/coach-assign-harness.js').fnSrc(fn).split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');   // whole-line comments may mention the old calls
    assert.match(body, /_assignPlanTxn\(/, fn + ' assigns through the engine'); assert.match(body, /expectedPrevPlanId/, fn + ' states the plan it expects to replace');
    assert.doesNotMatch(body, /addDoc\(|deleteDoc\(|updateDoc\(doc\(db, ?['"]clients['"]|backupPlanIfExists\(/, fn + ': no loose write');
  }
  assert.equal((coach.match(/tx\.update\(cRef, \{ activePlanId: planId \}\)/g) || []).length, 1, 'ONE pointer-update site for all routes');
});
