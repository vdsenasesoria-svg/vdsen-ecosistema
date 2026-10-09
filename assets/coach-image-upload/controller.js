/* VDSEN coach exercise image — upload controller.
 *
 * SAFE REPLACEMENT SEMANTICS. The order below is the whole point of this module and must not be
 * reordered:
 *
 *   initial:     validate source -> process -> validate blob -> upload NEW -> URL -> publish -> success
 *   replacement: ... -> upload NEW -> URL -> publish OLD->NEW -> ONLY THEN delete OLD
 *
 * Consequences, by construction:
 *   source invalid          -> no Storage write, no Firestore write
 *   processing fails        -> no Storage write, no Firestore write
 *   upload fails            -> Firestore untouched, OLD object untouched
 *   URL retrieval fails     -> NEW object cleaned up, Firestore untouched
 *   publish fails           -> Firestore still OLD, OLD object untouched, NEW orphan cleaned up
 *   OLD delete fails        -> Firestore points NEW and NEW is valid; OLD becomes cleanup debt and the
 *                              operation still SUCCEEDS, because the user-visible result is correct
 *   token goes stale        -> nothing is published into the next session; any NEW object is cleaned up
 *
 * Never: delete OLD first, overwrite an existing path, or publish a reference before its upload
 * completed. storage.rules independently refuses to overwrite an existing object (`resource == null`),
 * so the immutable versioned path holds even if this module is wrong.
 *
 * SINGLE FLIGHT: the controller carries its own `busy`. A second save while one is running is refused
 * with IMAGE_SAVE_IN_PROGRESS and produces ZERO side effects - the UI disabling its button is a
 * convenience, never the guarantee.
 */
(function (root, factory) {
  var V = (typeof require === 'function') ? require('./validate.js') : (root && root.VDSEN_IMG_VALIDATE);
  var P = (typeof require === 'function') ? require('./paths.js') : (root && root.VDSEN_IMG_PATHS);
  var api = factory(V, P);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_IMG_CONTROLLER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (V, P) {
  'use strict';

  var CODES = {
    INVALID: 'IMAGE_INVALID', PROCESS_FAILED: 'IMAGE_PROCESS_FAILED',
    UPLOAD_FAILED: 'IMAGE_UPLOAD_FAILED', URL_FAILED: 'IMAGE_URL_FAILED',
    PUBLISH_FAILED: 'IMAGE_PUBLISH_FAILED', STALE: 'IMAGE_OPERATION_STALE',
    BUSY: 'IMAGE_SAVE_IN_PROGRESS', NO_PROCESSOR: 'IMAGE_PROCESSOR_UNAVAILABLE', OK: 'OK',
  };
  var MESSAGES = {
    INVALID: 'La imagen no es válida.',
    PROCESS_FAILED: 'No se pudo procesar la imagen.',
    UPLOAD_FAILED: 'No se pudo subir la imagen. Intentá de nuevo.',
    URL_FAILED: 'No se pudo obtener el enlace de la imagen.',
    PUBLISH_FAILED: 'No se pudo guardar la imagen en el ejercicio. La imagen anterior sigue activa.',
    STALE: 'La sesión cambió durante la operación. No se guardó nada.',
    BUSY: 'Ya hay una imagen guardándose.',
    NO_PROCESSOR: 'El procesador de imagen no está disponible.',
  };

  // The existing product schema. NOT a third field: `imageUrl` is the renderable HTTPS reference and
  // `assetRef` is the canonical managed object path. Historical values may also be `assets/...`.
  var FIELD_URL = 'imageUrl';
  var FIELD_REF = 'assetRef';

  /* deps = {
   *   process(file)                 -> Promise<{ok, blob, type}>            (optional; skipped if absent)
   *   upload(path, blob, type)      -> Promise
   *   getDownloadUrl(path)          -> Promise<string>
   *   deleteObject(path)            -> Promise
   *   publish(exerciseId, patch)    -> Promise     patch = { imageUrl, assetRef }
   *   isCurrent(token)              -> boolean
   *   onCleanupFailure?(path, err)  -> void
   * }
   */
  function createController(deps) {
    var busy = false;

    function guard(token) {
      if (deps.isCurrent && !deps.isCurrent(token)) {
        var e = new Error(MESSAGES.STALE); e.code = CODES.STALE; e.stale = true; throw e;
      }
    }

    // Best-effort removal of a just-created object. A failure here must NOT turn a correct state into a
    // reported failure: it becomes cleanup debt and the original outcome stands.
    async function safeDelete(path) {
      try { await deps.deleteObject(path); return true; }
      catch (err) { try { if (deps.onCleanupFailure) deps.onCleanupFailure(path, err); } catch (e) {} return false; }
    }

    function failed(code, message, extra) {
      return Object.assign({ ok: false, code: code, message: message }, extra || {});
    }

    /* input = {
     *   token, coachUid, exerciseId, file,
     *   currentUrl?, currentPath?   (existing values; currentPath is only deleted when it is managed)
     * }
     */
    async function saveImage(input) {
      if (busy) return failed(CODES.BUSY, MESSAGES.BUSY);
      busy = true;
      try {
        var token = input.token;
        var coachUid = input.coachUid;
        var exerciseId = input.exerciseId;
        var currentPath = input.currentPath || '';

        // 0. The processor is not optional. Without it the ORIGINAL file would be uploaded, which
        //    means no EXIF/GPS strip, no resize, no size reduction and a contentType that was merely
        //    declared. Refusing here is the only safe behaviour, and it must be visible - never a
        //    silent fallback to the source bytes.
        if (typeof deps.process !== 'function') return failed(CODES.NO_PROCESSOR, MESSAGES.NO_PROCESSOR);

        // 1. cheap source validation (size + declared type)
        var cheap = V.validateSourceFile(input.file);
        if (!cheap.ok) return failed(CODES.INVALID, cheap.message);

        try { guard(token); } catch (e) { return failed(CODES.STALE, MESSAGES.STALE); }

        // 2. process (decode -> resize -> re-encode). The byte-level validation and the metadata strip
        //    happen here too, so nothing outside this module ever sees the original bytes.
        var source = await V.validateSource(input.file);
        if (!source.ok) return failed(CODES.INVALID, source.message);
        try { guard(token); } catch (e) { return failed(CODES.STALE, MESSAGES.STALE); }
        // The real content decision (magic bytes) happens here and the re-encode follows, so the
        // original bytes never reach Storage.
        var processed;
        try { processed = await deps.process(input.file); }
        catch (e) { return failed(CODES.PROCESS_FAILED, MESSAGES.PROCESS_FAILED); }
        if (!processed || !processed.ok) return failed(CODES.PROCESS_FAILED, (processed && processed.message) || MESSAGES.PROCESS_FAILED);
        var pv = V.validateProcessedBlob(processed.blob, processed.type);
        if (!pv.ok) return failed(pv.code === 'TOO_BIG_PROCESSED' ? CODES.PROCESS_FAILED : CODES.INVALID, pv.message);
        if (!processed.blob) return failed(CODES.PROCESS_FAILED, MESSAGES.PROCESS_FAILED);

        try { guard(token); } catch (e) { return failed(CODES.STALE, MESSAGES.STALE); }

        var oldPath = P.isManagedPathFor(currentPath, coachUid, exerciseId) ? currentPath : '';
        var newPath;
        try { newPath = P.newPath(coachUid, exerciseId); }
        catch (e) { return failed(CODES.UPLOAD_FAILED, e && e.code === 'NO_CRYPTO' ? 'No hay generador seguro disponible.' : MESSAGES.UPLOAD_FAILED); }
        if (oldPath && newPath === oldPath) return failed(CODES.UPLOAD_FAILED, MESSAGES.UPLOAD_FAILED);

        // 3. upload the NEW object. Nothing in Firestore is touched yet.
        // Always the PROCESSED output. The original source file must never be uploaded.
        var blob = processed.blob;
        var contentType = processed.type;
        try { guard(token); await deps.upload(newPath, blob, contentType); }
        catch (e) {
          if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
          return failed(CODES.UPLOAD_FAILED, MESSAGES.UPLOAD_FAILED);
        }

        // 4. the renderable URL. If this fails the NEW object is an orphan and must be removed.
        var url;
        try { guard(token); url = await deps.getDownloadUrl(newPath); }
        catch (e) {
          await safeDelete(newPath);
          if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
          return failed(CODES.URL_FAILED, MESSAGES.URL_FAILED);
        }
        if (!url) { await safeDelete(newPath); return failed(CODES.URL_FAILED, MESSAGES.URL_FAILED); }

        // 5. publish. On failure the previous reference must remain authoritative.
        try {
          guard(token);
          var patch = {}; patch[FIELD_URL] = url; patch[FIELD_REF] = newPath;
          await deps.publish(exerciseId, patch);
        } catch (e) {
          await safeDelete(newPath);
          if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
          return failed(CODES.PUBLISH_FAILED, MESSAGES.PUBLISH_FAILED);
        }

        // 6. ONLY NOW may the previous object be removed. A failure here is cleanup debt, not a failure of
        //    the user's operation: Firestore already points at NEW and NEW exists.
        var cleanup = 'NOT_NEEDED';
        if (oldPath) cleanup = (await safeDelete(oldPath)) ? 'DELETED' : 'PENDING';

        return {
          ok: true, code: CODES.OK, path: newPath, url: url, previousPath: oldPath || null,
          replaced: !!oldPath, cleanup: cleanup, bytes: blob && blob.size,
          warning: cleanup === 'PENDING' ? 'La imagen anterior no se pudo borrar; queda pendiente de limpieza.' : '',
        };
      } finally {
        // Must reset on EVERY path: success, validation failure, upload failure, URL failure, publish
        // failure, stale token, cleanup failure and an unexpected dependency exception alike. A stuck
        // busy flag would make the feature permanently unusable until a reload.
        busy = false;
      }
    }

    /* removeImage(input) -> { ok, code, cleanup }
     *
     * Conservative: Firestore is cleared FIRST and only then is the managed object deleted. So if the
     * delete fails the exercise correctly shows no image and the old object is merely cleanup debt -
     * the reverse order would leave a reference pointing at nothing.
     * A legacy external URL or an `assets/...` path is never Storage-deleted.
     */
    async function removeImage(input) {
      if (busy) return failed(CODES.BUSY, MESSAGES.BUSY);
      busy = true;
      try {
        var token = input.token;
        try { guard(token); } catch (e) { return failed(CODES.STALE, MESSAGES.STALE); }

        var managed = P.isManagedPathFor(input.currentPath, input.coachUid, input.exerciseId) ? input.currentPath : '';
        var patch = {}; patch[FIELD_URL] = ''; patch[FIELD_REF] = '';
        try { guard(token); await deps.publish(input.exerciseId, patch); }
        catch (e) {
          if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
          return failed(CODES.PUBLISH_FAILED, MESSAGES.PUBLISH_FAILED);
        }
        var cleanup = 'NOT_NEEDED';
        if (managed) cleanup = (await safeDelete(managed)) ? 'DELETED' : 'PENDING';
        return { ok: true, code: CODES.OK, cleanup: cleanup, removedPath: managed || null };
      } finally {
        busy = false;
      }
    }

    return {
      saveImage: saveImage, removeImage: removeImage,
      get busy() { return busy; },
      CODES: CODES, MESSAGES: MESSAGES,
    };
  }

  return { createController: createController, CODES: CODES, MESSAGES: MESSAGES, FIELD_URL: FIELD_URL, FIELD_REF: FIELD_REF };
});
