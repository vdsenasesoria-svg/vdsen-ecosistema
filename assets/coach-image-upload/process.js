/* VDSEN coach exercise image — processing pipeline.
 *
 * DECODE -> RESIZE -> RE-ENCODE. The re-encode is what guarantees EXIF/GPS and any other embedded
 * metadata cannot reach Storage: the bytes are reconstructed through a canvas, so only pixels survive.
 *
 * Everything platform-specific is INJECTED (`env`), which keeps the dimension maths, the quality ladder
 * and the give-up rule pure and unit-testable in Node without a browser.
 *
 *   env.decode(file)                        -> { width, height, source }   (ImageBitmap or Image)
 *   env.createCanvas(width, height)         -> canvas-like
 *   env.encode(canvas, type, quality)       -> Promise<Blob>
 *   env.release?(source)                    -> void   (revoke URLs / close ImageBitmap)
 *
 * TARGETS
 *   long edge  <= 1600 px, NEVER upscaled
 *   aim        <= 350 KiB
 *   hard cap   <= 480 KiB   (below the 512 KiB storage.rules ceiling on purpose)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_IMG_PROCESS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_LONG_EDGE = 1600;
  // Descending quality. Falls back to reducing dimensions only after the ladder is exhausted.
  var QUALITY_LADDER = [0.85, 0.75, 0.65, 0.55, 0.45];
  // Progressive dimension reductions applied when quality alone cannot reach the target.
  var SCALE_LADDER = [1, 0.85, 0.7, 0.6, 0.5];
  var TARGET_BYTES = 350 * 1024;
  var HARD_CAP_BYTES = 480 * 1024;

  var MESSAGES = {
    DECODE_FAILED: 'No se pudo leer la imagen. Probá con otro archivo.',
    ENCODE_FAILED: 'No se pudo preparar la imagen.',
    TOO_BIG: 'No se pudo reducir la imagen lo suficiente. Probá con otra foto.',
  };

  /* fitWithin(width, height, maxEdge) -> { width, height, scaled }
   * Pure. Never upscales: an image already inside maxEdge keeps its exact dimensions. */
  function fitWithin(width, height, maxEdge) {
    var w = Math.max(1, Math.round(width));
    var h = Math.max(1, Math.round(height));
    var longest = Math.max(w, h);
    if (!(longest > maxEdge)) return { width: w, height: h, scaled: false };
    var ratio = maxEdge / longest;
    return {
      width: Math.max(1, Math.round(w * ratio)),
      height: Math.max(1, Math.round(h * ratio)),
      scaled: true,
    };
  }

  // JPEG has no alpha, so a transparent PNG/WebP would otherwise composite onto black.
  function needsFlatten(type) { return type === 'image/jpeg'; }

  /* pickType(sourceType) -> output MIME
   * Transparency can only survive in PNG/WebP, so those stay WebP; everything else becomes JPEG, which
   * is the smallest for ordinary photographs. */
  function pickType(sourceType, hasAlpha) {
    var t = String(sourceType || '').toLowerCase();
    if (hasAlpha && (t === 'image/png' || t === 'image/webp')) return 'image/webp';
    return 'image/jpeg';
  }

  function canvasBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode')); }, canvas.__type, canvas.__quality);
        return;
      }
      if (typeof canvas.convertToBlob === 'function') {   // OffscreenCanvas
        canvas.convertToBlob({ type: canvas.__type, quality: canvas.__quality }).then(resolve, reject);
        return;
      }
      reject(new Error('encode'));
    });
  }

  function defaultEncode(env, canvas, type, quality) {
    if (env.encode) return Promise.resolve(env.encode(canvas, type, quality));
    canvas.__type = type; canvas.__quality = quality;
    return canvasBlob(canvas);
  }

  /* processImage(file, env) -> { ok, blob, type, width, height, bytes, attempts, quality }
   *
   * Tries the quality ladder at each scale level, and stops at the first result that fits the TARGET.
   * If nothing reaches the target it still returns the smallest result that fits the HARD CAP, because a
   * usable image under the cap is better than a failure; only a result above the hard cap is an error.
   */
  async function processImage(file, env) {
    var decoded;
    try { decoded = await env.decode(file); }
    catch (e) { return { ok: false, code: 'DECODE_FAILED', message: MESSAGES.DECODE_FAILED }; }
    if (!decoded || !(decoded.width > 0) || !(decoded.height > 0)) {
      if (env.release) { try { env.release(decoded && decoded.source); } catch (e) {} }
      return { ok: false, code: 'DECODE_FAILED', message: MESSAGES.DECODE_FAILED };
    }

    var type = pickType(file && file.type, decoded.hasAlpha);
    var base = fitWithin(decoded.width, decoded.height, MAX_LONG_EDGE);
    var attempts = 0;
    var best = null;

    try {
      for (var si = 0; si < SCALE_LADDER.length; si++) {
        var scale = SCALE_LADDER[si];
        var w = Math.max(1, Math.round(base.width * scale));
        var h = Math.max(1, Math.round(base.height * scale));
        // Once the image is already small, extra scale steps would only re-encode needlessly.
        // Stop re-encoding once shrinking no longer changes the dimensions, otherwise the same size
        // would be encoded once per ladder step.
        if (si > 0 && best && w === best.width && h === best.height) break;

        var canvas;
        try { canvas = env.createCanvas(w, h); } catch (e) { break; }
        var ctx = canvas.getContext('2d');
        if (needsFlatten(type)) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(decoded.source, 0, 0, w, h);

        for (var qi = 0; qi < QUALITY_LADDER.length; qi++) {
          var quality = QUALITY_LADDER[qi];
          var blob;
          attempts++;
          try { blob = await defaultEncode(env, canvas, type, quality); }
          catch (e) { continue; }
          if (!blob || !(blob.size > 0)) continue;

          if (!best || blob.size < best.blob.size) {
            best = { blob: blob, type: type, width: w, height: h, quality: quality };
          }
          if (blob.size <= TARGET_BYTES) {
            return { ok: true, code: 'OK', blob: blob, type: type, width: w, height: h, bytes: blob.size, attempts: attempts, quality: quality, atTarget: true };
          }
        }
        // Nothing at this scale met the target; a smaller scale is the next lever.
      }
    } finally {
      // Always release the decoded source: an ImageBitmap holds real memory and a preview URL leaks.
      if (env.release) { try { env.release(decoded.source); } catch (e) {} }
    }

    if (!best) return { ok: false, code: 'ENCODE_FAILED', message: MESSAGES.ENCODE_FAILED };
    if (best.blob.size > HARD_CAP_BYTES) return { ok: false, code: 'TOO_BIG', message: MESSAGES.TOO_BIG, bytes: best.blob.size };
    return { ok: true, code: 'OK', blob: best.blob, type: best.type, width: best.width, height: best.height, bytes: best.blob.size, attempts: attempts, quality: best.quality, atTarget: best.blob.size <= TARGET_BYTES };
  }

  /* --- Decode contract ------------------------------------------------------ */

  // ONE normalisation contract at MODULE scope, so every decode path can reach it. These used to be
  // nested inside browserEnv, which made decodeWithImg (module scope) throw ReferenceError on the
  // <img> fallback.

  // PNG and WebP can carry an alpha channel and JPEG never does. Treating PNG/WebP as opaque would
  // silently flatten a transparent logo onto white, so they stay on the lossless-ish path. A full
  // pixel scan is deliberately NOT done: it is expensive and this heuristic errs on the safe side.
  function alphaFor(file) {
    var t = String((file && file.type) || '').toLowerCase();
    return t === 'image/png' || t === 'image/webp';
  }

  function normaliseFromBitmap(bitmap, file) {
    return { width: bitmap.width, height: bitmap.height, source: bitmap, hasAlpha: alphaFor(file) };
  }

  function normaliseFromImg(img, file) {
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      source: img,
      hasAlpha: alphaFor(file),
    };
  }

  /* --- Browser environment -------------------------------------------------- */

  // createImageBitmap with orientation support when the browser offers it, else an <img> + object URL.
  // EVERY path returns the same normalised shape so processImage can rely on it:
  //   { width, height, source, hasAlpha }
  function browserEnv(win) {
    var w = win || (typeof window !== 'undefined' ? window : null);
    if (!w) throw new Error('no-window');

    function release(source) {
      if (!source) return;
      try { if (typeof source.close === 'function') source.close(); } catch (e) {}
      try { if (source.__url) w.URL.revokeObjectURL(source.__url); } catch (e) {}
    }



    return {
      release: release,
      alphaFor: alphaFor,
      decode: function (file) {
        if (typeof w.createImageBitmap === 'function') {
          // imageOrientation:'from-image' applies EXIF rotation, so a portrait photo is not sideways
          // after the re-encode strips that EXIF. Not every browser accepts the option, hence the retry
          // without it. Both resolutions are then NORMALISED, which is the part that was missing.
          return w.createImageBitmap(file, { imageOrientation: 'from-image' })
            .then(function (b) { return normaliseFromBitmap(b, file); })
            .catch(function () {
              return w.createImageBitmap(file)
                .then(function (b) { return normaliseFromBitmap(b, file); })
                .catch(function () { return decodeWithImg(w, file); });
            });
        }
        return decodeWithImg(w, file);
      },
      createCanvas: function (cw, ch) {
        if (typeof w.OffscreenCanvas === 'function') return new w.OffscreenCanvas(cw, ch);
        var c = w.document.createElement('canvas');
        c.width = cw; c.height = ch;
        return c;
      },
    };
  }

  function decodeWithImg(w, file) {
    return new Promise(function (resolve, reject) {
      var url = w.URL.createObjectURL(file);
      var img = new w.Image();
      img.onload = function () {
        // The URL stays attached to the source so release() can revoke it after the draw.
        img.__url = url;
        resolve(normaliseFromImg(img, file));
      };
      img.onerror = function () { try { w.URL.revokeObjectURL(url); } catch (e) {} reject(new Error('decode')); };
      img.src = url;
    });
  }

  return {
    processImage: processImage,
    fitWithin: fitWithin,
    pickType: pickType,
    browserEnv: browserEnv,
    MAX_LONG_EDGE: MAX_LONG_EDGE,
    QUALITY_LADDER: QUALITY_LADDER,
    SCALE_LADDER: SCALE_LADDER,
    TARGET_BYTES: TARGET_BYTES,
    HARD_CAP_BYTES: HARD_CAP_BYTES,
    MESSAGES: MESSAGES,
  };
});
