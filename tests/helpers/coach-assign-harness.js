'use strict';
// T591-B / T591-C: the REAL plan-assignment functions of vdsen-coach.html run in a vm against an in-memory Firestore with transactions
// (all-or-nothing commit, injectable failures, a persistent journal storage that can be "reloaded").
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { coachSandbox } = require('./coach-plan-import.js');
const coach = fs.readFileSync(path.join(__dirname, '..', '..', 'vdsen-coach.html'), 'utf8');

function fnSrc(name) {
  let i = coach.indexOf('async function ' + name + '('); if (i < 0) i = coach.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let d = 0, q = null, esc = false;
  for (let k = coach.indexOf('{', i); k < coach.length; k++) {
    const c = coach[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && coach[k + 1] === '/') { k = coach.indexOf('\n', k); continue; }
    if (c === '/' && coach[k + 1] === '*') { k = coach.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return coach.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
const S = (n) => Array.from({ length: n }, (_, i) => ({ setIndex: i, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: 90 }));
const planObjFor = (extra) => Object.assign({ weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'Día 1', exercises: [
  { exerciseName: 'Press', alternatives: [], technique: 'straight', techniqueNote: '', supersetGroup: '', coachNote: '', sets: S(3) },
  { exerciseName: 'Cinta', alternatives: [], technique: 'straight', techniqueNote: '', supersetGroup: '', coachNote: '', exerciseType: 'cardio', duracionMin: 30, sets: [] }] }] }, extra || {});

// ── in-memory Firestore with transactions ─────────────────────────────────────────────────────────────
function makeStore(init) {
  const data = JSON.parse(JSON.stringify(init)); let auto = 0; const log = { commits: 0, failures: 0 };
  const store = {
    data, log, hooks: { beforeConfirm: null, failCommit: null, applyThenFail: false, setDocFail: null, beforeCommit: null },
    doc: (first, coll, id) => { if (first && first.__coll) { return { path: first.__coll + '/auto' + (++auto), id: 'auto' + auto, __coll: first.__coll }; } return { path: coll + '/' + id, id, __coll: coll }; },   // doc(collectionRef) => auto id, like the SDK
    collection: (_db, name) => ({ __coll: name }),
    getDoc: async (ref) => { const v = data[ref.path]; if (ref.__coll === 'plans_backup' && v === undefined) throw Object.assign(new Error('a missing backup reads as denied (rules: null resource)'), { code: 'permission-denied' }); return { exists: () => v !== undefined, data: () => JSON.parse(JSON.stringify(v)), ref, id: ref.id }; },
    getDocs: async () => { const rows = Object.keys(data).filter((k) => /^clients\//.test(k) && data[k].coachId === 'c1').map((k) => ({ id: k.split('/')[1], data: () => JSON.parse(JSON.stringify(data[k])) })); return { empty: !rows.length, forEach: (cb) => rows.forEach(cb) }; },
    setDoc: async (ref, v) => { if (store.hooks.setDocFail) throw store.hooks.setDocFail; data[ref.path] = JSON.parse(JSON.stringify(v)); },
    updateDoc: async (ref, v) => { if (!(ref.path in data)) throw new Error('no document to update'); Object.assign(data[ref.path], JSON.parse(JSON.stringify(v))); },
    runTransaction: async (_db, fn) => {
      const snap = JSON.parse(JSON.stringify(data)), writes = [];
      const tx = { get: async (ref) => ({ exists: () => snap[ref.path] !== undefined, data: () => JSON.parse(JSON.stringify(snap[ref.path])), ref }),
        set: (ref, v) => writes.push(['set', ref.path, v]), update: (ref, v) => { if (snap[ref.path] === undefined) throw new Error('update of a missing document'); writes.push(['update', ref.path, v]); } };
      await fn(tx);
      if (store.hooks.beforeCommit) await store.hooks.beforeCommit();
      if (store.hooks.failCommit && !store.hooks.applyThenFail) { store.log.failures++; throw store.hooks.failCommit; }
      for (const [op, p, v] of writes) { if (op === 'set') data[p] = JSON.parse(JSON.stringify(v)); else Object.assign(data[p], JSON.parse(JSON.stringify(v))); }
      store.log.commits++;
      if (store.hooks.failCommit && store.hooks.applyThenFail) { store.log.failures++; throw store.hooks.failCommit; }   // committed on the server, the acknowledgement is lost
    }
  };
  return store;
}
// opts.confirm: answer of the replace question; opts.st / opts.ls: reuse a store / journal storage (= the same backend and browser after an app reload); opts.pick: client chosen in _selectModal
function harness(init, opts) {
  opts = opts || {}; const st = opts.st || makeStore(init), toasts = [], confirms = [], ls = opts.ls || {};
  const storage = { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } };
  const nav = [];
  const ctx = coachSandbox(opts.idPrefix || 'as', { currentCoach: { uid: 'c1' }, db: {}, doc: st.doc, collection: st.collection, getDoc: st.getDoc, getDocs: st.getDocs, query: (x) => x, where: () => null, setDoc: st.setDoc, updateDoc: st.updateDoc, runTransaction: st.runTransaction,
    localStorage: storage,
    showToast: (m, e) => toasts.push({ m: String(m), e: !!e }), _askConfirm: async (m) => { confirms.push(String(m)); if (st.hooks.beforeConfirm) await st.hooks.beforeConfirm(); return opts.confirm !== false; },
    _selectModal: async () => (opts.pick ? { id: opts.pick, name: 'Destino' } : null), BUILTIN_TEMPLATES: [],
    _autoAddExercisesToCatalog() {}, markEditorClean() {}, showClientDetail: (id) => nav.push(id), loadClientList() {}, loadDashboard() {},
    document: { getElementById: (id) => (id === 'planClientSelect' ? { value: opts.selected || '' } : { innerHTML: '', value: '', disabled: false, textContent: '' }), createElement: () => ({ style: {}, remove() {}, querySelector: (s) => ctx.__dom[s] || (ctx.__dom[s] = {}), appendChild() {} }), body: { appendChild() {} } },
    __dom: {}, serverTimestamp: () => 'TS' });
  ctx.window = Object.assign(ctx.window || {}, { _importedPlan: null });
  const fns = ['rirSchemeForWeeks', '_fnv', '_journalRead', '_journalWrite', '_journalFresh', '_assignOpKey', '_assignPeekPlanId', '_assignPlanId', '_assignJournalClear', '_importSourceKey', '_readActivePlanId', '_readActivePlanIdStrict',
    '_planBackupDoc', '_assignFailMessage', '_assignPlanTxn', '_supersedePlan', '_assignErr', 'backupPlanIfExists', '_restampPrescriptionIds', '_parseTemplateExercise', 'saveImportedPlan', 'saveManualPlan', '_applyTemplateToClient', 'applyTemplate', 'duplicatePlan', 'duplicatePlanToClient'];
  vm.runInContext(["const _ASSIGN_JOURNAL = 'vdsen_assign_journal_v1';", 'let _savingImportedPlan = false; let _savingManualPlan = false; let manualPlan = null; let activeMPDay = 0;'].concat(fns.map(fnSrc)).concat([
    'this.saveImportedPlan = saveImportedPlan; this.saveManualPlan = saveManualPlan; this._applyTemplateToClient = _applyTemplateToClient; this.applyTemplate = applyTemplate; this.duplicatePlan = duplicatePlan; this.duplicatePlanToClient = duplicatePlanToClient;',
    'this._supersedePlan = _supersedePlan; this._assignPlanTxn = _assignPlanTxn; this._assignPlanId = _assignPlanId; this._assignOpKey = _assignOpKey; this._journalRead = _journalRead; this.setManualPlan = (p) => { manualPlan = p; };']).join('\n'), ctx);
  return { ctx, st, toasts, confirms, ls, nav };
}
const base = () => ({
  'clients/cl1': { coachId: 'c1', displayName: 'Cliente', activePlanId: 'p0' },
  'plans/p0': { coachId: 'c1', clientId: 'cl1', status: 'active', weeks: 4, days: [{ label: 'viejo', exercises: [] }], updatedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' }
});
const newPlans = (h) => Object.keys(h.st.data).filter((k) => /^plans\/auto/.test(k));
const backups = (h) => Object.keys(h.st.data).filter((k) => k.startsWith('plans_backup/'));

module.exports = { coach, fnSrc, S, planObjFor, makeStore, harness, base, newPlans, backups };
