/* VDSEN Coach — "Foto del ejercicio" section for the EXISTING visual metadata editor.
 *
 * AUGMENTS the editor, it does not fork it. The editor already has correct Save semantics (one updateDoc
 * with the metadata patch) and identity guards; this module adds a photo area and intercepts Save in the
 * CAPTURE phase. When a photo is staged the controller performs ONE Firestore write carrying both the image
 * fields and the editor's own metadata, and the original handler is stopped so a second racing updateDoc
 * cannot drop the image fields. When nothing is staged it returns { handled:false } and the editor save runs
 * exactly as before.
 *
 * PROCESS ONCE: the preview is the blob returned by prepare(), and savePrepared uploads THAT SAME blob. The
 * raw File is never previewed and never uploaded.
 */
(function (root) {
  'use strict';

  var ORIGIN = {
    UPLOADED: 'Foto subida',
    EXTERNAL: 'URL externa',
    ASSET: 'Asset local',
    NONE: 'Sin foto',
    STAGED: 'Foto nueva sin guardar',
    PENDING_REMOVE: 'La foto se eliminará al guardar',
  };
  var MESSAGES = {
    STORAGE_UNAVAILABLE: 'No se pudo iniciar el almacenamiento de imágenes.',
    INVALID: 'La imagen no es válida.',
    PROCESSING: 'Procesando imagen…',
    READY: 'Foto lista',
    UPLOADING: 'Subiendo…',
    SAVING: 'Guardando…',
    FAILED: 'No se pudo guardar la imagen.',
    CONTEXT: 'El editor cambió; vuelve a abrirlo.',
  };

  function createPhotoSection(deps) {
    /* deps = { env, controllerApi, pathsApi, getContext, generation } */
    var staged = null;
    var removeStaged = false;
    var previewUrl = null;     // THIS module creates it, so THIS module revokes it
    var gen = 0;
    var els = {};

    function revokePreview() {
      if (previewUrl) { try { deps.env.URL.revokeObjectURL(previewUrl); } catch (e) {} previewUrl = null; }
    }

    // Drops any staged photo and its preview URL. Called on every lifecycle boundary.
    function invalidate() {
      gen++;
      staged = null;
      removeStaged = false;
      revokePreview();
    }

    // The managed object currently referenced, if any. assetRef is canonical, but historical rows may
    // carry the path in imageUrl, so both are inspected.
    function currentManagedPath() {
      var ctx = deps.getContext();
      var ex = (ctx && ctx.exercise) || {};
      if (deps.pathsApi.isManagedPathFor(ex.assetRef, ctx.coachUid, ctx.exerciseId)) return ex.assetRef;
      if (deps.pathsApi.isManagedPathFor(ex.imageUrl, ctx.coachUid, ctx.exerciseId)) return ex.imageUrl;
      return '';
    }

    // ORIGIN IS DERIVED FROM THE ORIGINAL PERSISTED VALUES, not from whatever is in the inputs.
    function originLabel() {
      if (removeStaged) return ORIGIN.PENDING_REMOVE;
      if (staged) return ORIGIN.STAGED;
      var ex = (deps.getContext().exercise) || {};
      if (currentManagedPath()) return ORIGIN.UPLOADED;
      if (ex.imageUrl && /^https:\/\//i.test(ex.imageUrl)) return ORIGIN.EXTERNAL;
      if (ex.assetRef && /^assets\//i.test(ex.assetRef)) return ORIGIN.ASSET;
      return ORIGIN.NONE;
    }

    function persistedPreviewSrc() {
      var ex = (deps.getContext().exercise) || {};
      if (ex.imageUrl && /^https:\/\//i.test(ex.imageUrl)) return ex.imageUrl;
      return '';
    }

    function setStatus(text) {
      if (els.status) els.status.textContent = text || '';
    }

    function render() {
      if (!els.root) return;
      var src = previewUrl || persistedPreviewSrc();
      if (els.origin) els.origin.textContent = originLabel();
      if (els.preview) {
        els.preview.innerHTML = src
          ? '<img src="' + src + '" alt="Foto del ejercicio" style="max-width:100%;max-height:170px;border-radius:6px;border:1px solid #444;display:block">'
          : '<div style="color:#777;font-size:12px;border:1px dashed #444;border-radius:6px;padding:12px;text-align:center">Sin foto</div>';
      }
      if (els.meta) {
        els.meta.textContent = staged
          ? staged.width + '×' + staged.height + ' · ' + (staged.bytes / 1024).toFixed(0) + ' KiB (procesada)'
          : '';
      }
      var ex = deps.getContext().exercise || {};
      var hasAny = !!(currentManagedPath() || persistedPreviewSrc() || ex.assetRef);
      if (els.pick) els.pick.textContent = (staged || hasAny) ? 'Cambiar foto' : 'Subir foto';
      if (els.discard) els.discard.style.display = (staged || removeStaged) ? '' : 'none';
      if (els.remove) els.remove.style.display = (hasAny && !removeStaged) ? '' : 'none';
    }

    async function onFileChosen(file) {
      if (!file) return;
      var ctx = deps.getContext();
      if (!ctx || !ctx.coachUid || !ctx.exerciseId) { setStatus(MESSAGES.CONTEXT); return; }
      var myGen = ++gen;
      removeStaged = false;
      revokePreview();
      staged = null;
      if (els.pick) els.pick.disabled = true;
      setStatus(MESSAGES.PROCESSING);
      try {
        var token = deps.generation.token();
        var prep = await deps.controllerApi.prepare(file, { token: token, coachUid: ctx.coachUid, exerciseId: ctx.exerciseId });
        if (myGen !== gen) return;   // a superseded selection must never replace the current one
        if (!prep.ok) { staged = null; setStatus(prep.message || MESSAGES.INVALID); return; }
        staged = { blob: prep.blob, type: prep.type, bytes: prep.bytes, width: prep.width, height: prep.height, token: prep.token };
        previewUrl = deps.env.URL.createObjectURL(prep.blob);
        setStatus(MESSAGES.READY);
      } catch (e) {
        if (myGen === gen) { staged = null; revokePreview(); setStatus(MESSAGES.INVALID); }
      } finally {
        if (els.pick) els.pick.disabled = false;
        if (myGen === gen) render();
      }
    }

    function discard() {
      invalidate();
      setStatus('');
      render();
    }

    function stageRemoval() {
      invalidate();
      removeStaged = true;
      setStatus('La foto se eliminará al guardar.');
      render();
    }

    /* Called from the capture-phase Save handler.
     *   { handled:false }             nothing staged -> the original editor save must run
     *   { handled:true, ok, message } the controller ran (or failed) and owns the write
     */
    async function persist(metadata) {
      var ctx = deps.getContext();
      if (!ctx || !ctx.coachUid || !ctx.exerciseId || !ctx.exercise) return { handled: true, ok: false, message: MESSAGES.CONTEXT };
      if (ctx.coachId !== ctx.coachUid) return { handled: true, ok: false, message: MESSAGES.CONTEXT };
      if (!removeStaged && !staged) return { handled: false };

      var token = deps.generation.token();
      try {
        if (removeStaged) {
          setStatus(MESSAGES.UPLOADING);
          var rr = await deps.controllerApi.removeImage({
            token: token, coachUid: ctx.coachUid, exerciseId: ctx.exerciseId,
            currentPath: currentManagedPath(), metadata: metadata,
          });
          if (!rr.ok) return { handled: true, ok: false, message: rr.message };
          return { handled: true, ok: true, message: 'Foto eliminada', cleanup: rr.cleanup };
        }
        setStatus(MESSAGES.UPLOADING);
        var r = await deps.controllerApi.savePrepared(staged, {
          token: token, coachUid: ctx.coachUid, exerciseId: ctx.exerciseId,
          currentPath: currentManagedPath(), metadata: metadata,
        });
        if (!r.ok) return { handled: true, ok: false, message: r.message };
        setStatus(MESSAGES.SAVING);
        // A PENDING old-object cleanup is NOT a failure: Firestore already points at the new object.
        return { handled: true, ok: true, message: r.warning || 'Imagen actualizada', cleanup: r.cleanup };
      } catch (e) {
        // Includes the Storage-unavailable case, so the coach gets a friendly message instead of a raw
        // getProvider exception, and the rest of the editor stays usable.
        var msg = (e && e.message === 'adapter-unavailable') ? MESSAGES.STORAGE_UNAVAILABLE : MESSAGES.FAILED;
        return { handled: true, ok: false, message: msg };
      }
    }

    function attach(overlay, saveBtn) {
      var box = deps.env.document.createElement('div');
      box.id = 'vm-photo-section';
      box.style.cssText = 'margin:14px 0;padding:12px;border:1px solid #444;border-radius:8px;background:#101010';
      box.innerHTML =
        '<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#9ab;margin-bottom:8px">Foto del ejercicio</div>' +
        '<div id="vm-photo-preview"></div>' +
        '<div id="vm-photo-source" style="margin-top:8px;font-size:12px;color:#c8a54a"></div>' +
        '<div id="vm-photo-meta" style="font-size:11px;color:#888;min-height:14px"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
          '<button type="button" id="vm-photo-pick" class="btn-secondary">Subir foto</button>' +
          '<button type="button" id="vm-photo-discard" class="btn-secondary" style="display:none">Descartar selección</button>' +
          '<button type="button" id="vm-photo-remove" class="btn-secondary" style="display:none">Eliminar foto</button>' +
        '</div>' +
        '<input type="file" id="vm-photo-file" accept="image/jpeg,image/png,image/webp" style="display:none">' +
        '<div id="vm-photo-status" style="font-size:12px;min-height:16px;margin-top:6px" aria-live="polite"></div>';
      saveBtn.parentNode.insertBefore(box, saveBtn);

      els = {
        root: box,
        preview: box.querySelector('#vm-photo-preview'),
        origin: box.querySelector('#vm-photo-source'),
        meta: box.querySelector('#vm-photo-meta'),
        pick: box.querySelector('#vm-photo-pick'),
        discard: box.querySelector('#vm-photo-discard'),
        remove: box.querySelector('#vm-photo-remove'),
        file: box.querySelector('#vm-photo-file'),
        status: box.querySelector('#vm-photo-status'),
      };

      els.pick.onclick = function () { els.file.click(); };
      els.file.onchange = function () {
        var f = els.file.files && els.file.files[0];
        els.file.value = '';   // cleared so choosing the SAME file twice still fires a change event
        onFileChosen(f);
      };
      els.discard.onclick = discard;
      els.remove.onclick = stageRemoval;

      render();
      return { persist: persist, invalidate: invalidate, destroy: destroy, originLabel: originLabel };
    }

    function destroy() {
      invalidate();
      if (els.root && els.root.parentNode) els.root.parentNode.removeChild(els.root);
      els = {};
    }

    return { attach: attach, invalidate: invalidate, destroy: destroy, ORIGIN: ORIGIN };
  }

  root.VDSEN_COACH_IMAGE_UI = { createPhotoSection: createPhotoSection, ORIGIN: ORIGIN, MESSAGES: MESSAGES };
  if (typeof module === 'object' && module.exports) module.exports = root.VDSEN_COACH_IMAGE_UI;
})(typeof window !== 'undefined' ? window : globalThis);
