'use strict';
// Preload (node -r) that swaps the Firebase SDK modules used by tests/client-export-emulator.cjs for a rules-EMULATING in-memory fake
// (the fixture's makeIo, which mirrors firestore.rules). This is a DRY RUN of the harness code only -- it is NOT the real Firestore Emulator
// and proves nothing about the real rules; it keeps the harness + firestore-io.js adapter from rotting where the emulator JAR is unavailable.
const Module = require('node:module');
const fx = require('./client-export-fixture.js');
const store = {};
const split = p => { const s = p.split('/'); return { col: s.slice(0, -1).join('/'), id: s[s.length - 1] }; };
const clone = v => JSON.parse(JSON.stringify(v));
const snap = (id, data) => ({ id, exists: () => data !== null, data: () => data === null ? undefined : clone(data) });
const fakes = {
  'firebase/app': { initializeApp: () => ({}), deleteApp: async () => {} },
  'firebase-admin/app': { initializeApp: () => ({}), deleteApp: async () => {} },
  'firebase-admin/firestore': { getFirestore: () => ({ doc: p => ({ set: async data => { const { col, id } = split(p); (store[col] = store[col] || {})[id] = clone(data); } }) }) },
  'firebase/firestore': {
    getFirestore: () => ({ uid: null }),
    connectFirestoreEmulator: (db, host, port, opts) => { db.uid = opts.mockUserToken.sub; },
    doc: (db, col, id) => ({ kind: 'doc', db, col, id }),
    collection: (db, ...path) => ({ kind: 'col', db, path: path.join('/'), segs: path }),
    where: (f, o, v) => ({ f, o, v }),
    query: (col, ...wheres) => ({ kind: 'query', col, wheres }),
    getDoc: async ref => { const r = await fx.makeIo(store, ref.db.uid).getDoc(ref.col, ref.id); return snap(ref.id, r ? r.data : null); },
    getDocs: async q => {
      const col = q.kind === 'query' ? q.col : q, io = fx.makeIo(store, col.db.uid);
      const rows = col.segs.length > 1 ? await io.listSub(col.segs[0], col.segs[1], col.segs[2]) : await io.query(col.path, (q.wheres || []).map(w => [w.f, w.o, w.v]));
      return { size: rows.length, docs: rows.map(r => snap(r.id, r.data)) };
    }
  }
};
const orig = Module._load;
Module._load = function(request, parent, isMain) { return fakes[request] || orig.apply(this, arguments); };
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:0';
process.env.CE_RULES_ENFORCED = '1';
process.env.GCLOUD_PROJECT = 'demo-vdsen-export';
