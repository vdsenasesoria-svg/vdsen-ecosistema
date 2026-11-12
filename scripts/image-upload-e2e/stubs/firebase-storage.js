// Firebase Storage SDK double for the VDSEN Image Upload harness.
//
// The real Storage SDK cannot run against a fake `app` from the app double (getStorage reads
// app._providers), so Storage is swapped like every other Firebase module. Objects live in memory and
// are visible to the acceptance harness, which is what lets the tests assert SURVIVING STATE (what
// exists after a failure) rather than merely that an error was shown.
//
// Harness surface (generated copy only):
//   window.__HARNESS_STORAGE__   inventory + failure injection (failNext)
//   window.__HARNESS_BARRIERS__  deterministic pause/release (see barriers.js)
//     arm('uploadBytes','before')  pauses BEFORE the object is stored
//     arm('uploadBytes','after')   object IS stored, resolution held
//     (same two phases for getDownloadURL and deleteObject)
import { gate, install } from './barriers.js';

const OBJECTS = new Map();   // path -> { size, contentType, cacheControl, blob }
// IMPORTANT: the product imports these functions as ESM bindings, so failure injection and barriers
// must live INSIDE the module functions. A wrapper installed on window would never be reached by the
// binding the adapter captured at import time.
const INJECT = { failNext: null };   // { op: 'upload' | 'delete' | 'url' }

function maybeFail(op) {
  const f = INJECT.failNext;
  if (f && f.op === op) {
    INJECT.failNext = null;
    throw Object.assign(new Error(op + ' inyectado'), { code: 'storage/injected' });
  }
}

export function getStorage(app, bucketUrl) {
  if (!app) throw new Error('getStorage: app requerido');
  return { __kind: 'harness-storage', app, bucket: bucketUrl || 'harness-local.appspot.com' };
}

export function ref(storage, path) {
  if (!storage) throw new Error('ref: storage requerido');
  return { __kind: 'harness-ref', storage, path: String(path || '') };
}

export async function uploadBytes(r, blob, metadata) {
  maybeFail('upload');
  await gate('uploadBytes', 'before');
  const md = metadata || {};
  const size = blob && typeof blob.size === 'number' ? blob.size : 0;
  if (!size) throw Object.assign(new Error('uploadBytes: blob vacío'), { code: 'storage/invalid-argument' });
  OBJECTS.set(r.path, { size, contentType: md.contentType || (blob && blob.type) || '', cacheControl: md.cacheControl || '', blob });
  await gate('uploadBytes', 'after');
  return { ref: r, metadata: { size, contentType: md.contentType || '' } };
}

export async function getDownloadURL(r) {
  maybeFail('url');
  await gate('getDownloadURL', 'before');
  const o = OBJECTS.get(r.path);
  if (!o) throw Object.assign(new Error('object-not-found'), { code: 'storage/object-not-found' });
  await gate('getDownloadURL', 'after');
  return 'https://harness-storage.invalid/' + r.path.replace(/\//g, '%2F') + '?token=harness';
}

export async function deleteObject(r) {
  maybeFail('delete');
  await gate('deleteObject', 'before');
  const o = OBJECTS.get(r.path);
  if (!o) throw Object.assign(new Error('object-not-found'), { code: 'storage/object-not-found' });
  OBJECTS.delete(r.path);
  await gate('deleteObject', 'after');
  return undefined;
}

// --- harness inspection surface -------------------------------------------------
// Only exists in the generated test copy; nothing in the product references it.
if (typeof window !== 'undefined') {
  install(window);
  window.__HARNESS_STORAGE__ = {
    list: () => Array.from(OBJECTS.entries()).map(([path, o]) => ({ path, size: o.size, contentType: o.contentType })),
    has: (path) => OBJECTS.has(path),
    size: (path) => (OBJECTS.has(path) ? OBJECTS.get(path).size : -1),
    count: () => OBJECTS.size,
    reset: () => OBJECTS.clear(),
    // Test-only failure injection, so failure rows can assert real surviving state.
    // MUST read/write the SAME `INJECT` object the module functions consult (maybeFail), or the
    // harness sets a property that uploadBytes never sees and the injected failure is silently
    // ignored. A getter/setter that mirrored a separate object is exactly that bug.
    get failNext() { return INJECT.failNext; },
    set failNext(v) { INJECT.failNext = v; },
    get INJECT() { return INJECT; },
    get OBJECTS() { return OBJECTS; },
    // Callable aliases so harness code can drive the module bindings directly.
    uploadBytes,
    deleteObject,
    getDownloadURL,
  };
}
