/* VDSEN coach exercise image — Firebase Storage + Firestore adapter.
 *
 * The only place that talks to Firebase for this feature. Uses the normal Web SDK with the signed-in
 * Coach's own session, so every write is bound by storage.rules and firestore.rules; there is no Admin
 * SDK, no privileged server and no write outside the exercise document.
 *
 * DOWNLOAD URL MODEL (documented because it matters):
 *   getDownloadURL() returns an HTTPS URL carrying a bearer-like token. Anyone who obtains that URL can
 *   retrieve the object, so Storage Rules alone do NOT prevent access to a LEAKED download URL. The
 *   mitigation is to keep token URLs out of logs, out of debug artifacts and out of any public surface -
 *   not to claim the rules cover them. Rendering an HTTPS URL is deliberate: it keeps the existing
 *   athlete app working unchanged.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_IMG_ADAPTER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* sdk = {
   *   storage, ref, uploadBytes, getDownloadURL, deleteObject,
   *   db, doc, updateDoc
   * }
   */
  function createAdapter(sdk) {
    if (!sdk) throw new Error('sdk requerido');

    return {
      // Uploads the PROCESSED blob. `contentType` is the sniffed type, so the declared type can never
      // disagree with the bytes.
      //
      // CACHE POLICY. Object paths are immutable, so a replacement always produces a NEW path and a NEW
      // download URL - cache-busting is a structural property here, not something cacheControl provides.
      // A one-year public cache would be actively wrong: a download URL carries a bearer-like token, and
      // a long-lived shared cache keeps that tokenised response retrievable well after the object is
      // logically replaced or deleted. Storage does NOT purge caches on delete, so no comment here may
      // claim that deletion immediately invalidates a cached bearer URL.
      //
      // A bounded private cache is used instead: it keeps the athlete image reasonably warm without
      // extending a tokenised URL's life across a long shared cache.
      upload: function (path, blob, contentType) {
        var r = sdk.ref(sdk.storage, path);
        return sdk.uploadBytes(r, blob, { contentType: contentType, cacheControl: 'private, max-age=3600' });
      },

      getDownloadUrl: function (path) {
        return sdk.getDownloadURL(sdk.ref(sdk.storage, path));
      },

      deleteObject: function (path) {
        return sdk.deleteObject(sdk.ref(sdk.storage, path));
      },

      // ONLY imageUrl and assetRef are written. coachId, the exercise identity and every other field are
      // part of the document's ownership contract and must not change here; storage.rules and
      // firestore.rules both verify that ownership independently.
      publishExerciseImage: function (exerciseId, patch) {
        var clean = {};
        if (Object.prototype.hasOwnProperty.call(patch, 'imageUrl')) clean.imageUrl = patch.imageUrl;
        if (Object.prototype.hasOwnProperty.call(patch, 'assetRef')) clean.assetRef = patch.assetRef;
        return sdk.updateDoc(sdk.doc(sdk.db, 'exercises', exerciseId), clean);
      },
    };
  }

  // Convenience wiring from a modular Firebase SDK namespace object, so the Coach page does not have to
  // list every function at the call site.
  function fromModules(mods) {
    return createAdapter({
      storage: mods.storage, ref: mods.ref, uploadBytes: mods.uploadBytes,
      getDownloadURL: mods.getDownloadURL, deleteObject: mods.deleteObject,
      db: mods.db, doc: mods.doc, updateDoc: mods.updateDoc,
    });
  }

  return { createAdapter: createAdapter, fromModules: fromModules };
});
