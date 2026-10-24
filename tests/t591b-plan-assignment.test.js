'use strict';
// T591-B: plan assignment is atomic and idempotent, the previous plan becomes historical explicitly, the Generator's rirByWeek is preserved, and an unsaved import is protected.
// The REAL functions of vdsen-coach.html run in a vm against an in-memory Firestore with transactions (all-or-nothing commit, injectable failures).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { coachSandbox, jsonTabImport } = require('./helpers/coach-plan-import.js');
const { coach, fnSrc, S, planObjFor, harness, base, newPlans } = require('./helpers/coach-assign-harness.js');

test('T591B-1 replacing a plan is ONE atomic commit: new plan + activePlanId + the previous plan marked historical (never deleted) + a single backup', async () => {
  const h = harness(base()); h.ctx.window._importedPlan = planObjFor();
  assert.equal(await h.ctx.saveImportedPlan('cl1'), true);
  const np = newPlans(h); assert.equal(np.length, 1); const id = np[0].split('/')[1];
  assert.equal(h.st.data['clients/cl1'].activePlanId, id, 'authority: activePlanId points to the new plan');
  assert.equal(h.st.data[np[0]].status, 'active'); assert.equal(h.st.data[np[0]].clientId, 'cl1'); assert.equal(h.st.data[np[0]].coachId, 'c1');
  const old = h.st.data['plans/p0']; assert.equal(old.status, 'superseded'); assert.equal(old.supersededBy, id); assert.ok(old.supersededAt); assert.deepEqual(old.days, [{ label: 'viejo', exercises: [] }], 'history intact'); assert.equal(old.updatedAt, '2026-09-01T00:00:00.000Z', 'prescription revision stamp untouched');
  assert.ok(h.st.data['plans_backup/p0__replaced_by__' + id], 'backup of the outgoing plan (one per replacement, id = outgoing + replaced_by + new)'); assert.equal(h.st.log.commits, 1, 'one transaction');
  assert.equal(h.confirms.length, 1, 'the replacement was confirmed');
  const exs = h.st.data[np[0]].days[0].exercises; assert.ok(exs.every((e) => e.prescriptionExerciseId), 'PIDs stamped'); assert.equal(exs[1].exerciseType, 'cardio'); assert.equal(exs[1].sets.length, 0);
});

test('T591B-2 a failure before commit writes NOTHING (no orphan, client and old plan untouched); the retry reuses the same plan id and creates exactly one plan', async () => {
  const h = harness(base()); const po = planObjFor(); h.ctx.window._importedPlan = po;
  h.st.hooks.failCommit = Object.assign(new Error('network down'), { code: 'unavailable' });
  assert.equal(await h.ctx.saveImportedPlan('cl1'), false);
  assert.equal(newPlans(h).length, 0, 'no orphan plan document'); assert.equal(h.st.data['clients/cl1'].activePlanId, 'p0'); assert.equal(h.st.data['plans/p0'].status, 'active', 'old plan still active: nothing changed');
  assert.ok(h.toasts.some((t) => t.e && /No se pudo confirmar.*reintenta.*NO se duplicará/i.test(t.m)), 'explicit, honest failure message (it may or may not have been saved; the retry is safe)');
  h.st.hooks.failCommit = null; assert.equal(await h.ctx.saveImportedPlan('cl1'), true);
  assert.equal(newPlans(h).length, 1, 'exactly one plan after the retry'); assert.equal(h.st.data['clients/cl1'].activePlanId, newPlans(h)[0].split('/')[1]);
});

test('T591B-3 idempotent retry when the commit succeeded but the acknowledgement was lost: no duplicate plan, no second backup, no second replacement question', async () => {
  const h = harness(base()); h.ctx.window._importedPlan = planObjFor();
  h.st.hooks.failCommit = Object.assign(new Error('ack lost'), { code: 'deadline-exceeded' }); h.st.hooks.applyThenFail = true;
  assert.equal(await h.ctx.saveImportedPlan('cl1'), false, 'the caller saw an error');
  const first = newPlans(h); assert.equal(first.length, 1, 'but the server did commit');
  h.st.hooks.failCommit = null; h.st.hooks.applyThenFail = false; h.confirms.length = 0;
  assert.equal(await h.ctx.saveImportedPlan('cl1'), true, 'the retry succeeds');
  assert.deepEqual(newPlans(h), first, 'the SAME plan, no second document'); assert.equal(h.confirms.length, 0, 'no "replace the active plan" question for a plan that is already the active one');
  assert.equal(Object.keys(h.st.data).filter((k) => k.startsWith('plans_backup/')).length, 1, 'a single backup'); assert.ok(h.toasts.some((t) => /ya estaba asignado/.test(t.m)));
});

test('T591B-4 contention: if the client\'s active plan changes while the Coach is confirming, the transaction aborts and nothing is written', async () => {
  const h = harness(base()); h.ctx.window._importedPlan = planObjFor();
  h.st.hooks.beforeConfirm = async () => { h.st.data['clients/cl1'].activePlanId = 'pOther'; h.st.data['plans/pOther'] = { coachId: 'c1', clientId: 'cl1', status: 'active' }; };
  assert.equal(await h.ctx.saveImportedPlan('cl1'), false);
  assert.equal(newPlans(h).length, 0); assert.equal(h.st.data['clients/cl1'].activePlanId, 'pOther', 'the concurrent change is respected, not overwritten'); assert.equal(h.st.data['plans/p0'].status, 'active');
  assert.ok(h.toasts.some((t) => t.e && /cambió mientras confirmabas.*NO se guardó nada/.test(t.m)));
});

test('T591B-5 a double click creates one plan; a client of another coach and a missing client write nothing; a first plan needs no confirmation or backup', async () => {
  const h = harness(base()); h.ctx.window._importedPlan = planObjFor();
  const [a, b] = await Promise.all([h.ctx.saveImportedPlan('cl1'), h.ctx.saveImportedPlan('cl1')]);
  assert.deepEqual([a, b].sort(), [false, true]); assert.equal(newPlans(h).length, 1);
  const foreign = harness({ 'clients/cl1': { coachId: 'OTHER', activePlanId: null } }); foreign.ctx.window._importedPlan = planObjFor();
  assert.equal(await foreign.ctx.saveImportedPlan('cl1'), false); assert.equal(newPlans(foreign).length, 0); assert.ok(foreign.toasts.some((t) => /permiso/.test(t.m)));
  const missing = harness({}); missing.ctx.window._importedPlan = planObjFor(); assert.equal(await missing.ctx.saveImportedPlan('nope'), false); assert.equal(newPlans(missing).length, 0);
  const first = harness({ 'clients/cl1': { coachId: 'c1' } }); first.ctx.window._importedPlan = planObjFor();
  assert.equal(await first.ctx.saveImportedPlan('cl1'), true); assert.equal(first.confirms.length, 0); assert.equal(Object.keys(first.st.data).filter((k) => k.startsWith('plans_backup/')).length, 0);
  assert.equal(first.st.data['clients/cl1'].activePlanId, newPlans(first)[0].split('/')[1]);
});

test('T591B-6 rirByWeek: the Generator\'s explicit valid scheme is preserved and its source recorded; absent or invalid => the Coach default (and the invalid one is reported)', async () => {
  const gen = { 1: 3, 2: 2, 3: 1, 4: 4 };   // deliberately NOT the Coach default (3,2,... 0 peak, deload)
  const h = harness(base()); h.ctx.window._importedPlan = planObjFor({ rirByWeek: gen });
  await h.ctx.saveImportedPlan('cl1'); const doc = h.st.data[newPlans(h)[0]];
  assert.deepEqual(doc.rirByWeek, { 1: 3, 2: 2, 3: 1, 4: 4 }, 'the Generator scheme is NOT replaced'); assert.equal(doc.rirByWeekSource, 'generator');
  const d = harness(base()); d.ctx.window._importedPlan = planObjFor(); await d.ctx.saveImportedPlan('cl1'); const dd = d.st.data[newPlans(d)[0]];
  assert.equal(dd.rirByWeekSource, 'coach-default'); assert.deepEqual(dd.rirByWeek, { 1: 3, 2: 1, 3: 0, 4: 3 });
  const norm = h.ctx._normRirByWeek;
  assert.equal(norm({ 1: 3, 2: 2 }, 4), null, 'weeks missing'); assert.equal(norm({ 1: 3, 2: 2, 3: 1, 4: 9 }, 4), null, 'out of range'); assert.equal(norm([3, 2, 1, 0], 4), null, 'array'); assert.equal(norm({ 1: 'x', 2: 1, 3: 1, 4: 1 }, 4), null);
  assert.deepEqual(JSON.parse(JSON.stringify(norm({ '1': '3', '2': 2, '3': 1, '4': 0 }, 4))), { 1: 3, 2: 2, 3: 1, 4: 0 }, 'string keys / numeric strings accepted');
  // importer: root and training-block positions are both read; an invalid one is reported and dropped
  const t = (extra, where) => { const block = { weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'd', exercises: [{ exerciseName: 'Press', sets: S(3) }] }] }; if (where === 'block') block.rirByWeek = extra; const o = where === 'block' ? { entrenamiento: block } : Object.assign({ entrenamiento: block }, { rirByWeek: extra }); return jsonTabImport(o); };
  assert.deepEqual(t(gen, 'root').plan.rirByWeek, { 1: 3, 2: 2, 3: 1, 4: 4 }); assert.deepEqual(t(gen, 'block').plan.rirByWeek, { 1: 3, 2: 2, 3: 1, 4: 4 }, 'entrenamiento.rirByWeek (as the server normalizer reads it)');
  const bad = t({ 1: 3 }, 'root'); assert.equal(bad.plan.rirByWeek, undefined); assert.ok(bad.warnings.some((w) => /rirByWeek del Generador inválido o incompleto/.test(w)));
});

test('T591B-7 _supersedePlan surfaces a failure (never silent) and never deletes; only an active plan changes status', async () => {
  const h = harness(base()); const ok = await h.ctx._supersedePlan('p0', 'pNew'); assert.equal(ok, true); assert.equal(h.st.data['plans/p0'].status, 'superseded');
  h.st.data['plans/pApproved'] = { coachId: 'c1', clientId: 'cl1', status: 'draft_approved' }; await h.ctx._supersedePlan('pApproved', 'pNew'); assert.equal(h.st.data['plans/pApproved'].status, 'draft_approved', 'an approved draft keeps its status'); assert.equal(h.st.data['plans/pApproved'].supersededBy, 'pNew');
  const bad = harness(base()); bad.st.updateDoc = undefined; const ctx2 = bad.ctx; ctx2.updateDoc = async () => { throw Object.assign(new Error('x'), { code: 'permission-denied' }); };
  assert.equal(await ctx2._supersedePlan('p0', 'pNew'), false); assert.ok(bad.toasts.some((t) => t.e && /no se pudo marcar el anterior como histórico/.test(t.m)), 'visible warning');
  assert.equal(await h.ctx._supersedePlan('pForeign', 'pNew'), true, 'a missing plan is a no-op'); assert.ok(!/deleteDoc\(doc\(db, ?["']plans["'], ?(prevPlanId2|prevId|prevPlanId)\)/.test(coach), 'no replacement path deletes the outgoing plan any more (the explicit Coach "Eliminar plan" action is a different feature)');
});

test('T591B-8 changing client with an UNSAVED import asks first: Cancel keeps preview and client, Confirm discards; the selector is locked while asking and while saving', async () => {
  const sel = { value: 'A', dataset: {}, disabled: false, options: [], innerHTML: '', appendChild() {}, onchange: null };
  const els = { planClientSelect: sel, planBuilder: { innerHTML: 'builder' }, parsedPlanPreview: { innerHTML: 'preview' }, autoGenStatus: { innerHTML: 'x' } };
  let resolveAsk, asks = 0; const toasts = [];
  const ctx = coachSandbox('sel', { currentCoach: { uid: 'c1' }, document: { getElementById: (id) => els[id] || null, createElement: () => ({}) }, _readCoachClientsInFlight: async () => ({ forEach() {} }), showToast: (m) => toasts.push(m),
    _askConfirm: () => { asks++; return new Promise((r) => { resolveAsk = r; }); } });
  vm.runInContext('let _savingImportedPlan = false;\n' + fnSrc('loadClientsSelect') + '\nthis.loadClientsSelect = loadClientsSelect; this.setSaving = (v) => { _savingImportedPlan = v; };', ctx);
  await ctx.loadClientsSelect(); assert.equal(typeof sel.onchange, 'function'); sel.value = 'A'; sel.dataset.prev = 'A';
  ctx.window._importedPlan = { days: [1] };
  sel.value = 'B'; const p = sel.onchange.call(sel);                    // Coach picks client B with an unsaved preview
  assert.equal(sel.disabled, true, 'locked while the question is open (fast repeated changes cannot interleave)'); assert.equal(asks, 1);
  sel.value = 'C'; await sel.onchange.call(sel); sel.value = 'D'; await sel.onchange.call(sel);   // repeated / programmatic changes while asking (a disabled select does not stop a script)
  assert.equal(asks, 1, 'no second question is opened'); assert.equal(sel.value, 'B', 'the selector snaps back to the change being decided');
  resolveAsk(false); await p;                                           // Cancel
  assert.equal(sel.value, 'A', 'Cancel restores the previously selected client'); assert.ok(ctx.window._importedPlan, 'and keeps the preview'); assert.equal(els.parsedPlanPreview.innerHTML, 'preview'); assert.equal(sel.disabled, false);
  sel.value = 'B'; const p2 = sel.onchange.call(sel); resolveAsk(true); await p2;   // Confirm
  assert.equal(sel.value, 'B'); assert.equal(sel.dataset.prev, 'B'); assert.equal(ctx.window._importedPlan, null, 'context discarded'); assert.equal(els.planBuilder.innerHTML, ''); assert.equal(els.parsedPlanPreview.innerHTML, '', 'the preview is cleared too');
  ctx.window._importedPlan = { days: [1] }; ctx.setSaving(true); sel.value = 'C'; await sel.onchange.call(sel);
  assert.equal(sel.value, 'B', 'while a save is in flight the selection cannot change'); assert.ok(ctx.window._importedPlan); assert.ok(toasts.some((m) => /se está guardando/.test(m)));
  ctx.setSaving(false); ctx.window._importedPlan = null; asks = 0; sel.value = 'C'; await sel.onchange.call(sel); assert.equal(asks, 0, 'no question when there is nothing unsaved'); assert.equal(sel.dataset.prev, 'C');
});

test('T591B-9 every Coach week-length edit records that the RIR scheme became a Coach decision; the update-plan import records a Generator scheme', () => {
  assert.equal((coach.match(/rirByWeekSource: 'coach-edit'/g) || []).length, 4, 'the four duration editors');
  assert.match(coach, /\.\.\.\(obj\.rirByWeek \? \{ rirByWeekSource: 'generator' \} : \{\}\)/);
  assert.match(coach, /rirByWeekSource: _r \? 'generator' : 'coach-default'/, 'AI draft path');
});
