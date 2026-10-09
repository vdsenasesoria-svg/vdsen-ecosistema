/* VDSEN Coach — mount the "Foto del ejercicio" section into the EXISTING visual metadata editor.
 *
 * Kept separate from vdsen-coach.html so the integration is reviewable and testable on its own. It is
 * loaded as a classic script, so it reads the current exercise through a re-exported accessor
 * (window.VDSEN_VISUAL_EDITOR_CTX) rather than reaching into module scope.
 *
 * The Save interception happens in the CAPTURE phase: when a photo is staged the photo section runs the
 * controller and the original editor save is stopped, so ONE Firestore write publishes both the image and
 * the editor's metadata. When nothing is staged, mount() returns a handle whose persist() answers
 * { handled:false } and the editor save runs untouched.
 */
(function (root) {
  'use strict';

  function mount(opts) {
    var env = opts.env;
    var overlay = opts.overlay;
    var saveBtn = opts.saveBtn;
    var statusEl = opts.statusEl;
    var ctx = opts.ctx;
    var controller = opts.controller;
    var paths = opts.paths;

    var section = root.VDSEN_COACH_IMAGE_UI.createPhotoSection({
      env: env,
      controllerApi: controller,
      pathsApi: paths,
      getContext: function () {
        var c = ctx.current();
        return {
          coachUid: c.coachUid,
          coachId: c.coachId,
          exerciseId: c.exerciseId,
          exercise: c.exercise,
        };
      },
      generation: { token: function () { return ctx.token(); } },
    });

    var handle = section.attach(overlay, saveBtn);

    function buildMetadata() {
      return root.VDSEN_VISUAL_METADATA_EDITOR.buildPatch({
        gym: opts.read('vm-gym'),
        equipment: opts.read('vm-equipment'),
        assetRef: opts.read('vm-asset'),
        imageUrl: opts.read('vm-image'),
        technicalObjective: opts.read('vm-objective'),
        setup: opts.read('vm-setup'),
        execution: opts.read('vm-execution'),
        instructions: opts.read('vm-instructions'),
        commonErrors: opts.read('vm-errors'),
        variants: opts.read('vm-variants'),
      });
    }

    // Capture phase: runs BEFORE the editor's own onclick, and only stops it when it actually handled the
    // save. A metadata-only save therefore keeps the exact behaviour it had before this feature existed.
    saveBtn.addEventListener('click', function (ev) {
      var metadata;
      try { metadata = buildMetadata(); }
      catch (e) {
        if (statusEl) statusEl.textContent = e.message || 'No se pudo guardar';
        ev.stopPropagation();
        ev.preventDefault();
        return;
      }
      saveBtn.disabled = true;
      var restore = function () { saveBtn.disabled = false; };
      Promise.resolve(handle.persist(metadata)).then(function (out) {
        if (!out || out.handled !== true) { restore(); return; }
        ev.stopPropagation();
        ev.preventDefault();
        if (out.ok) {
          if (root.showToast) root.showToast(out.message || 'Imagen actualizada', false);
          // `cleanup === 'PENDING'` is NOT a failure: Firestore already points at the new object and the
          // only residue is an orphaned old object. Reported, never escalated.
          section.destroy();
          if (opts.onDone) opts.onDone(out);
        } else {
          restore();
          if (statusEl) statusEl.textContent = out.message || 'No se pudo guardar la imagen';
        }
      }, function () {
        restore();
        if (statusEl) statusEl.textContent = 'No se pudo guardar la imagen';
      });
    }, true);

    return { section: section, persist: handle.persist, destroy: section.destroy };
  }

  root.VDSEN_COACH_IMAGE_MOUNT = { mount: mount };
  if (typeof module === 'object' && module.exports) module.exports = root.VDSEN_COACH_IMAGE_MOUNT;
})(typeof window !== 'undefined' ? window : globalThis);
