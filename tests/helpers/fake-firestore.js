// Test-only in-memory transactional store with the same read-then-write contract as Firestore transactions.
// Writes are buffered and applied ONLY when the whole transaction body succeeds (atomic commit); `deny(ref)` makes commit throw.
const clone = v => structuredClone(v);
function merge(dst, src) {   // Firestore set(..., {merge:true}): maps merge recursively; arrays / scalars replace
  const out = Object.assign({}, dst || {});
  for (const k of Object.keys(src)) out[k] = src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? merge(out[k], src[k]) : clone(src[k]);
  return out;
}
function makeStore(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, clone(v)]));
  const log = [];
  const denied = new Set();
  const store = {
    docs, log, deny: ref => denied.add(ref),
    get: ref => docs.has(ref) ? clone(docs.get(ref)) : undefined,
    async run(fn) {
      const writes = [];
      const tx = { get: async ref => ({ exists: () => docs.has(ref), data: () => clone(docs.get(ref)) }),
        set: (ref, value, opts) => { writes.push([ref, value, opts]); } };
      const result = await fn(tx);
      for (const [ref] of writes) if (denied.has(ref)) throw Object.assign(new Error('permission-denied ' + ref), { code: 'permission-denied' });
      for (const [ref, value, opts] of writes) { docs.set(ref, opts && opts.merge ? merge(docs.get(ref), value) : clone(value)); log.push(ref); }
      return result;
    }
  };
  return store;
}
module.exports = { makeStore };
