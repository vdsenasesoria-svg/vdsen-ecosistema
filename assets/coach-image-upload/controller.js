/* VDSEN coach exercise image — upload controller.
 *
 * SAFE REPLACEMENT SEMANTICS. The order below is the whole point of this module and must not be
 * reordered:
 *
 *   initial:     validate -> upload NEW -> publish reference to Firestore -> success
 *   replacement: validate -> upload NEW -> publish OLD->NEW -> ONLY THEN delete OLD
 *
 * Consequences, by construction:
 *   upload fails            -> Firestore untouched, OLD object untouched
 *   publish fails           -> Firestore still OLD, OLD object untouched, NEW orphan cleaned up
 *   OLD delete fails        -> Firestore points NEW and NEW is valid; OLD becomes cleanup debt and the
 *                              operation still succeeds, because the user-visible result is correct
 *
 * Never: delete OLD first, overwrite an existing path, or publish a reference before its upload
 * completed. storage.rules independently refuses to overwrite an existing object (`resource == null`),
 * so the versioned path is enforced even if this module is wrong.
 */
(function (root, factory) {
  var api = factory(
    (typeof require === 'function' ? require('./validate.js') : (root && root.VDSEN_IMG_VALIDATE)),
    (typeof require === 'function' ? require('./paths.js') : (root && root.VDSEN_IMG_PATHS))
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_IMG_CONTROLLER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (V, P) {
  'use strict';

  var CODES = {
    INVALID: 'IMAGE_INVALID', UPLOAD_FAILED: 'IMAGE_UPLOAD_FAILED', PUBLISH_FAILED: 'IMAGE_PUBLISH_FAILED',
    STALE: 'IMAGE_OPERATION_STALE', OK: 'OK',
  };
  var MESSAGES = {
    INVALID: 'La imagen no es válida.',
    UPLOAD_FAILED: 'No se pudo subir la imagen. Intentá de nuevo.',
    PUBLISH_FAILED: 'No se pudo guardar la imagen en el ejercicio. La imagen anterior sigue activa.',
    STALE: 'La sesión cambió durante la operación. No se guardó nada.',
  };

  /* deps = {
   *   upload(path, file, contentType) -> Promise          (uploads the object)
   *   deleteObject(path)             -> Promise           (removes an object)
   *   publish(exerciseId, ref)       -> Promise           (writes the Firestore reference)
   *   isCurrent(token)               -> boolean           (session/operation still valid)
   *   onCleanupFailure?(path, err)   -> void              (records orphan debt; never throws upward)
   * }
   */
  function createController(deps) {
    // Every async step re-checks the token before it may change anything user-visible. A logout or a
    // coach switch invalidates the token, so a late upload can never publish into the next session.
    function guard(token) {
      if (deps.isCurrent && !deps.isCurrent(token)) {
        var e = new Error(MESSAGES.STALE); e.code = CODES.STALE; e.stale = true; throw e;
      }
    }

    // Best-effort removal of a just-created object. A failure here must NOT turn a correct state into a
    // reported failure: it is recorded as cleanup debt and the original outcome stands.
    async function safeDelete(path) {
      try { await deps.deleteObject(path); return true; }
      catch (err) { try { if (deps.onCleanupFailure) deps.onCleanupFailure(path, err); } catch (e) {} return false; }
    }

    function failed(code, message, extra) {
      return Object.assign({ ok: false, code: code, message: message }, extra || {});
    }

    // currentPath: the canonical object path already referenced by the exercise, or '' / null when the
    // exercise has no managed image. Legacy external URLs are NOT managed paths and are never deleted.
    async function saveImage(input) {
      var token = input.token;
      var coachUid = input.coachUid;
      var exerciseId = input.exerciseId;
      var file = input.file;
      var currentPath = input.currentPath || '';

      var check = V.validate(file);
      if (!check.ok) return failed(CODES.INVALID, check.message);

      try { guard(token); } catch (e) { return failed(CODES.STALE, MESSAGES.STALE); }

      var oldPath = P.isManagedPathFor(currentPath, coachUid, exerciseId) ? currentPath : '';
      // A NEW path is generated for every save, so a replacement never targets the existing object.
      var newPath;
      try { newPath = P.newPath(coachUid, exerciseId); } catch (e) { return failed(CODES.UPLOAD_FAILED, MESSAGES.UPLOAD_FAILED); }
      if (oldPath && newPath === oldPath) return failed(CODES.UPLOAD_FAILED, MESSAGES.UPLOAD_FAILED);

      // 1. upload the NEW object. Nothing in Firestore is touched yet.
      try { guard(token); await deps.upload(newPath, file, check.contentType); }
      catch (e) {
        if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
        return failed(CODES.UPLOAD_FAILED, MESSAGES.UPLOAD_FAILED);
      }

      // 2. publish the reference. On failure the previous reference must remain authoritative.
      try {
        guard(token);
        await deps.publish(exerciseId, newPath);
      } catch (e) {
        await safeDelete(newPath);                       // remove the orphan we just created
        if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
        return failed(CODES.PUBLISH_FAILED, MESSAGES.PUBLISH_FAILED);
      }

      // 3. ONLY NOW may the previous object be removed. A failure here is cleanup debt, not a failure of
      // the user's operation: Firestore already points at NEW and NEW exists.
      var cleanup = 'NOT_NEEDED';
      if (oldPath) cleanup = (await safeDelete(oldPath)) ? 'DELETED' : 'PENDING';

      return {
        ok: true, code: CODES.OK, path: newPath, previousPath: oldPath || null,
        replaced: !!oldPath, cleanup: cleanup,
        // Surfaced so the caller can log it; it never changes the success verdict.
        warning: cleanup === 'PENDING' ? 'La imagen anterior no se pudo borrar; queda pendiente de limpieza.' : '',
      };
    }

    return { saveImage: saveImage, CODES: CODES, MESSAGES: MESSAGES };
  }

  return { createController: createController, CODES: CODES, MESSAGES: MESSAGES };
});
