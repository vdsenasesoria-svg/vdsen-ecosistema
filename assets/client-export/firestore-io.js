/* VDSEN client export — read-only Firestore adapter for collect.js, built from the Firestore web SDK functions the host app already imported
 * (so it runs with the signed-in Coach's own session and is therefore bound by firestore.rules; no Admin SDK, no extra endpoint).
 * Only getDoc/getDocs are ever called. Query shapes are equality filters on coachId + clientId/clientUid (never on a display name). */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_FIRESTORE_IO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // sdk: { db, doc, getDoc, getDocs, collection, query, where }
  function create(sdk) {
    var rows = function(snap) { return snap.docs.map(function(d) { return { id: d.id, data: d.data() }; }); };
    return {
      getDoc: async function(col, id) { var s = await sdk.getDoc(sdk.doc(sdk.db, col, id)); return s.exists() ? { id: s.id, data: s.data() } : null; },
      query: async function(col, conds) {
        var base = sdk.collection(sdk.db, col);
        var parts = conds.map(function(c) { return sdk.where(c[0], c[1], c[2]); });
        return rows(await sdk.getDocs(sdk.query.apply(null, [base].concat(parts))));
      },
      listSub: async function(col, id, sub) { return rows(await sdk.getDocs(sdk.collection(sdk.db, col, id, sub))); }
    };
  }
  return { create: create };
});
