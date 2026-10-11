// In-memory Firestore double for the VDSEN Image Upload harness. Never touches the network.
//
// HARNESS SURFACE (generated copy only):
//   window.__HARNESS_FIRESTORE__   writes log + failure injection
//   window.__HARNESS_BARRIERS__    deterministic pause/release (see barriers.js)
//     arm('updateDoc','before')    pauses BEFORE the write commits
//     arm('updateDoc','after')     write IS committed, promise resolution held
//                                  (= post-publish / pre-UI-settlement pause)
import { gate, install } from './barriers.js';

const FIX = () => (typeof window !== 'undefined' && window.__VDSEN_FIXTURE__) || { client: { uid: 'x', data: {} }, plans: {}, logs: { root: { entries: {} }, mesos: {} }, exercises: [], fichas_onboarding: {} };
const store = () => {
  if (!window.__VDSEN_HARNESS_DB__) {
    let saved = null;
    try { saved = JSON.parse(window.localStorage.getItem('__VDSEN_HARNESS_DB__') || 'null'); } catch (e) { saved = null; }
    window.__VDSEN_HARNESS_DB__ = saved || { writes: 0, docs: {} };
  }
  return window.__VDSEN_HARNESS_DB__;
};
const persist = () => { try { window.localStorage.setItem('__VDSEN_HARNESS_DB__', JSON.stringify(store())); } catch (e) { /* ignore */ } };

const norm = (args) => {
  const parts = args.filter((a) => a !== undefined && a !== null && typeof a !== 'object').map(String);
  return parts.filter((p) => p !== '[object Object]').join('/');
};

function inspection() {
  if (typeof window === 'undefined') return null;
  if (!window.__HARNESS_FIRESTORE__) {
    window.__HARNESS_FIRESTORE__ = {
      _writes: [],
      writes: () => window.__HARNESS_FIRESTORE__._writes.slice(),
      resetWrites: () => { window.__HARNESS_FIRESTORE__._writes = []; },
      // Test-only: set to an error code to fail the NEXT updateDoc before it writes.
      failNextUpdateDoc: null,
      docs: () => JSON.parse(JSON.stringify(store().docs)),
    };
  }
  return window.__HARNESS_FIRESTORE__;
}
if (typeof window !== 'undefined') { inspection(); install(window); }

function logWrite(op, path) {
  const f = inspection();
  if (f) f._writes.push({ op, path, at: Date.now() });
}

export function initializeFirestore() { return { __db: true }; }
export function getFirestore() { return { __db: true }; }
export function persistentLocalCache() { return {}; }
export function doc(...args) { return { __type: 'doc', __path: norm(args) }; }
export function collection(...args) { return { __type: 'collection', __path: norm(args) }; }
export function query(ref, ...clauses) { return { __type: 'query', __path: ref && ref.__path, __clauses: clauses }; }
export function where(field, op, value) { return { __type: 'where', field, op, value }; }
export function orderBy(field, dir) { return { __type: 'order', field, dir }; }
export function limit(n) { return { __type: 'limit', n }; }

function lookup(path) {
  const f = FIX();
  const c = f.client || {};
  const p = path.split('/');
  if (p[0] === 'coaches') { const d = (f.coaches || {})[p[1]]; return d ? { kind: 'exists', data: d } : { kind: 'missing' }; }
  if (p[0] === 'clients' && c.uid && p[1] === c.uid) return { kind: 'exists', data: c.data || {} };
  if (p[0] === 'clients') { const d = (f.clients || {})[p[1]]; return d ? { kind: 'exists', data: d } : { kind: 'missing' }; }
  if (p[0] === 'plans') { const d = (f.plans || {})[p[1]]; return d ? { kind: 'exists', data: d } : { kind: 'missing' }; }
  if (p[0] === 'logs' && p[1] === c.uid && p[2] === 'mesos') { const d = ((f.logs || {}).mesos || {})[p[3]]; return d ? { kind: 'exists', data: d } : { kind: 'missing' }; }
  if (p[0] === 'logs' && p[1] === c.uid) return { kind: 'exists', data: (f.logs || {}).root || { entries: {} } };
  if (p[0] === 'logs') { const d = (f.logs_by_id || {})[p[1]]; return d ? { kind: 'exists', data: d } : { kind: 'missing' }; }
  if (p[0] === 'fichas_onboarding') { const d = (f.fichas_onboarding || {})[p[1]]; return d ? { kind: 'exists', data: d } : { kind: 'missing' }; }
  if (p[0] === 'phone_index' || p[0] === 'expedientes') return { kind: 'missing' };
  const inmem = store().docs[path];
  if (inmem) return { kind: 'exists', data: inmem };
  return { kind: 'missing' };
}

function snap(path, res) {
  return {
    id: path.split('/').pop(),
    ref: { __type: 'doc', __path: path },
    exists: () => res.kind === 'exists',
    data: () => (res.kind === 'exists' ? res.data : undefined),
    get: (f) => (res.kind === 'exists' ? res.data[f] : undefined),
  };
}

export async function getDoc(ref) { return snap(ref.__path, lookup(ref.__path)); }
export async function getDocs(q) {
  const f = FIX();
  const base = (q && q.__path) || '';
  // Read log: lets the PC rows prove that a stale settlement performs ZERO catalog reloads.
  const fr = inspection();
  if (fr) fr._writes.push({ op: 'read', path: base, at: Date.now() });
  let rows = [];
  const p = base.split('/');
  if (p[0] === 'exercises') rows = (f.exercises || []).map((d, i) => ({ id: d.exerciseId || d.id || 'ex' + i, data: d }));
  if (p[0] === 'clients') rows = Object.entries(f.clients || {}).map(([id, data]) => ({ id, data }));
  if (p[0] === 'logs') rows = Object.entries(f.logs_by_id || {}).map(([id, data]) => ({ id, data }));
  const clauses = (q && q.__clauses) || [];
  for (const c of clauses) {
    if (c && c.__type === 'where') {
      rows = rows.filter((r) => {
        const v = r.data[c.field];
        if (c.op === '==') return v === c.value;
        return true;
      });
    }
  }
  return {
    size: rows.length,
    empty: rows.length === 0,
    forEach: (fn) => rows.forEach((r) => fn(snap(base + '/' + r.id, { kind: 'exists', data: r.data }))),
    docs: rows.map((r) => snap(base + '/' + r.id, { kind: 'exists', data: r.data })),
  };
}

export async function setDoc(ref, data, opts) {
  await gate('setDoc', 'before');
  store().writes++;
  const prev = opts && opts.merge ? (store().docs[ref.__path] || {}) : {};
  store().docs[ref.__path] = Object.assign({}, prev, data);
  persist();
  logWrite('set', ref.__path);
  await gate('setDoc', 'after');
  return undefined;
}
export async function updateDoc(ref, data) {
  await gate('updateDoc', 'before');
  const f = inspection();
  if (f && f.failNextUpdateDoc) {
    const code = f.failNextUpdateDoc;
    f.failNextUpdateDoc = null;
    throw Object.assign(new Error('updateDoc inyectado'), { code: code });
  }
  store().writes++;
  store().docs[ref.__path] = Object.assign({}, store().docs[ref.__path] || {}, data);
  persist();
  logWrite('update', ref.__path);
  // Post-commit / pre-UI-settlement pause: the state below IS already durable in the harness, but
  // the caller's promise has not resolved, so no UI settlement can have run yet.
  await gate('updateDoc', 'after');
  return undefined;
}
export async function addDoc() { store().writes++; persist(); logWrite('add', '(auto)'); return { id: 'harness-added' }; }

export function onSnapshot(ref, cb) {
  // one immediate emission with the current value, then a no-op unsubscribe
  Promise.resolve().then(() => {
    try {
      if (ref && ref.__type === 'doc') cb(snap(ref.__path, lookup(ref.__path)));
      else cb({ forEach: () => {}, docs: [], size: 0 });
    } catch (e) { /* harness: ignore */ }
  });
  return () => {};
}

export async function runTransaction(_db, fn) {
  const tx = {
    get: (ref) => getDoc(ref),
    set: (ref, data, opts) => setDoc(ref, data, opts),
    update: (ref, data) => updateDoc(ref, data),
  };
  return fn(tx);
}

// Required by the coach app. A missing named export stops the whole module from loading.
export async function deleteDoc(ref) {
  const s = store();
  delete s.docs[ref && ref.__path];
  s.writes++;
  persist();
  logWrite('delete', (ref && ref.__path) || '');
  return undefined;
}
export function serverTimestamp() { return new Date().toISOString(); }
export const deleteField = () => ({ __harness: 'deleteField' });

export default { initializeFirestore, persistentLocalCache, doc, collection, query, where, orderBy, limit, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, onSnapshot, runTransaction, serverTimestamp, deleteField };
