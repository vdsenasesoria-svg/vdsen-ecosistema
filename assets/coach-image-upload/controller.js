/* VDSEN coach exercise image — upload controller.
 *
 * TWO-PHASE API, so the UI can preview the PROCESSED image and still process the photo exactly ONCE.
 *
 *   prepare(file, ctx)   validate source -> process -> validate blob  => a prepared image
 *   savePrepared(prep,…) upload NEW -> URL -> publish -> ONLY THEN delete OLD
 *
 * The naive alternative - process once for the preview and then hand the raw File to a save that
 * processes it again - is explicitly rejected: it would decode a multi-megabyte photo twice, and it
 * would give the UI a path to the original bytes. savePrepared uploads EXACTLY the Blob that prepare
 * produced, and it revalidates that Blob rather than trusting its origin.
 *
 * SAFE REPLACEMENT ORDER (must not be reordered):
 *   upload NEW -> get URL -> publish -> only then delete OLD
 *
 *   source invalid      -> no Storage write, no Firestore write
 *   processing fails    -> no Storage write, no Firestore write
 *   upload fails        -> Firestore untouched, OLD object untouched
 *   URL retrieval fails -> NEW object cleaned up, Firestore untouched
 *   publish fails       -> Firestore still OLD, OLD object untouched, NEW orphan cleaned up
 *   OLD delete fails    -> Firestore points NEW and NEW is valid; OLD becomes cleanup debt and the
 *                          operation still SUCCEEDS, because the user-visible result is correct
 *   token goes stale    -> nothing is published into the next session; any NEW object is cleaned up
 *
 * METADATA COHERENCE: savePrepared accepts the editor's ordinary metadata patch and merges imageUrl and
 * assetRef into it, so ONE Firestore write publishes everything. Two competing updateDoc calls would
 * race and could lose the text edits the coach is saving at the same time.
 *
 * SINGLE FLIGHT: the controller carries its own `busy`. A second save while one runs is refused with
 * IMAGE_SAVE_IN_PROGRESS and produces ZERO side effects - a disabled button is a convenience, never the
 * guarantee.
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
   *   process(file)                 -> Promise<{ ok, blob, type, width?, height? }>
   *   upload(path, blob, type)      -> Promise
   *   getDownloadUrl(path)          -> Promise<string>
   *   deleteObject(path)            -> Promise
   *   publish(exerciseId, patch)    -> Promise     patch already merged by the controller
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

    function failed(code, message, extra) {
      return Object.assign({ ok: false, code: code, message: message }, extra || {});
    }

    // Best-effort removal of a just-created object. A failure here must NOT turn a correct state into a
    // reported failure: it becomes cleanup debt and the original outcome stands.
    async function safeDelete(path) {
      try { await deps.deleteObject(path); return true; }
      catch (err) { try { if (deps.onCleanupFailure) deps.onCleanupFailure(path, err); } catch (e) {} return false; }
    }

    /* PHASE 1 of the API: validate and process, produce a Blob the caller may preview.
     * Nothing is written anywhere. The returned `blob` is the exact object savePrepared will upload.
     */
    async function prepare(file, ctx) {
      var token = ctx && ctx.token;
      if (typeof deps.process !== 'function') return failed(CODES.NO_PROCESSOR, MESSAGES.NO_PROCESSOR);

      var cheap = V.validateSourceFile(file);
      if (!cheap.ok) return failed(CODES.INVALID, cheap.message);

      try { guard(token); } catch (e) { return failed(CODES.STALE, MESSAGES.STALE); }

      // Byte-level decision (magic bytes) + re-encode. This is where EXIF/GPS is destroyed, so the
      // original bytes never leave this step.
      var source = await V.validateSource(file);
      if (!source.ok) return failed(CODES.INVALID, source.message);

      try { guard(token); } catch (e) { return failed(CODES.STALE, MESSAGES.STALE); }

      var processed;
      try { processed = await deps.process(file); }
      catch (e) { return failed(CODES.PROCESS_FAILED, MESSAGES.PROCESS_FAILED); }
      if (!processed || !processed.ok || !processed.blob) {
        return failed(CODES.PROCESS_FAILED, (processed && processed.message) || MESSAGES.PROCESS_FAILED);
      }

      // Revalidate the OUTPUT rather than trusting the processor's word for it.
      var pv = V.validateProcessedBlob(processed.blob, processed.type);
      if (!pv.ok) return failed(pv.code === 'TOO_BIG_PROCESSED' ? CODES.PROCESS_FAILED : CODES.INVALID, pv.message);

      return {
        ok: true, code: CODES.OK,
        blob: processed.blob, type: pv.type, bytes: pv.bytes,
        width: processed.width, height: processed.height,
        quality: processed.quality, attempts: processed.attempts,
        // The generation this preparation belongs to, so a late save from an old editor is refused.
        token: token,
        coachUid: ctx && ctx.coachUid, exerciseId: ctx && ctx.exerciseId,
      };
    }

    /* PHASE 2 of the API: persist a prepared image, optionally together with the editor's own metadata.
     *
     * `prepared` must come from prepare(). It is revalidated here so a caller cannot hand in an
     * arbitrary Blob, and a raw File can never reach upload.
     */
    async function savePrepared(prepared, input) {
      if (busy) return failed(CODES.BUSY, MESSAGES.BUSY);
      busy = true;
      try {
        if (!prepared || prepared.ok !== true || !prepared.blob) return failed(CODES.INVALID, MESSAGES.INVALID);

        var token = input.token;
        var coachUid = input.coachUid;
        var exerciseId = input.exerciseId;
        var currentPath = input.currentPath || '';

        // The prepared image must belong to THIS coach and THIS exercise, or it is a cross-editor mixup.
        if (prepared.coachUid !== undefined && prepared.coachUid !== coachUid) return failed(CODES.STALE, MESSAGES.STALE);
        if (prepared.exerciseId !== undefined && prepared.exerciseId !== exerciseId) return failed(CODES.STALE, MESSAGES.STALE);

        // The prepared image must belong to THIS generation. A stale prepared result from an earlier
        // editor session on the same coach and the same exercise would otherwise still pass the
        // coach/exercise checks above, so this is a genuinely separate condition and not a duplicate of
        // guard(). Checked BEFORE any byte is uploaded.
        if (prepared.token !== undefined && input.token !== undefined && prepared.token !== input.token) {
          return failed(CODES.STALE, MESSAGES.STALE);
        }

        // Revalidate the payload: never trust that it is still within the cap.
        var pv = V.validateProcessedBlob(prepared.blob, prepared.type);
        if (!pv.ok) return failed(pv.code === 'TOO_BIG_PROCESSED' ? CODES.PROCESS_FAILED : CODES.INVALID, pv.message);

        try { guard(token); } catch (e) { return failed(CODES.STALE, MESSAGES.STALE); }

        var oldPath = P.isManagedPathFor(currentPath, coachUid, exerciseId) ? currentPath : '';
        var newPath;
        try { newPath = P.newPath(coachUid, exerciseId); }
        catch (e) { return failed(CODES.UPLOAD_FAILED, e && e.code === 'NO_CRYPTO' ? 'No hay generador seguro disponible.' : MESSAGES.UPLOAD_FAILED); }
        if (oldPath && newPath === oldPath) return failed(CODES.UPLOAD_FAILED, MESSAGES.UPLOAD_FAILED);

        // 1. upload the NEW object. Nothing in Firestore is touched yet.
        try { guard(token); await deps.upload(newPath, prepared.blob, pv.type); }
        catch (e) {
          if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
          return failed(CODES.UPLOAD_FAILED, MESSAGES.UPLOAD_FAILED);
        }

        // 2. the renderable URL. If this fails the NEW object is an orphan and must be removed.
        var url;
        try { guard(token); url = await deps.getDownloadUrl(newPath); }
        catch (e) {
          await safeDelete(newPath);
          if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
          return failed(CODES.URL_FAILED, MESSAGES.URL_FAILED);
        }
        if (!url) { await safeDelete(newPath); return failed(CODES.URL_FAILED, MESSAGES.URL_FAILED); }

        // 3. ONE publish: the editor's metadata plus the image fields, so nothing races and no text edit
        //    is lost. On failure the previous reference must remain authoritative.
        try {
          guard(token);
          var patch = Object.assign({}, input.metadata || {});
          patch[FIELD_URL] = url;
          patch[FIELD_REF] = newPath;
          await deps.publish(exerciseId, patch);
        } catch (e) {
          await safeDelete(newPath);
          if (e && e.stale) return failed(CODES.STALE, MESSAGES.STALE);
          return failed(CODES.PUBLISH_FAILED, MESSAGES.PUBLISH_FAILED);
        }

        // 4. ONLY NOW may the previous object be removed. A failure here is cleanup debt, not a failure
        //    of the user's operation: Firestore already points at NEW and NEW exists.
        var cleanup = 'NOT_NEEDED';
        if (oldPath) cleanup = (await safeDelete(oldPath)) ? 'DELETED' : 'PENDING';

        return {
          ok: true, code: CODES.OK, path: newPath, url: url, previousPath: oldPath || null,
          replaced: !!oldPath, cleanup: cleanup, bytes: pv.bytes,
          warning: cleanup === 'PENDING' ? 'La imagen anterior no se pudo borrar; queda pendiente de limpieza.' : '',
        };
      } finally {
        // Must reset on EVERY path: success, validation failure, upload failure, URL failure, publish
        // failure, stale token, cleanup failure and an unexpected dependency exception alike. A stuck
        // busy flag would make the feature unusable until a reload.
        busy = false;
      }
    }

    /* Convenience for callers that genuinely have only a File and no preview step: prepare + save in one
     * call. The UI uses the two-phase API instead so the photo is processed exactly once. */
    async function saveImage(input) {
      var prep = await prepare(input.file, input);
      if (!prep.ok) return prep;
      return savePrepared(prep, input);
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
        var patch = Object.assign({}, input.metadata || {});
        patch[FIELD_URL] = ''; patch[FIELD_REF] = '';
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
      prepare: prepare, savePrepared: savePrepared, saveImage: saveImage, removeImage: removeImage,
      get busy() { return busy; },
      CODES: CODES, MESSAGES: MESSAGES,
    };
  }

  return { createController: createController, CODES: CODES, MESSAGES: MESSAGES, FIELD_URL: FIELD_URL, FIELD_REF: FIELD_REF };
});
