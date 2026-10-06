/* VDSEN — Coach exercise image: validation, local processing (decode -> resize -> re-encode), staging controller with race protection, Storage naming.
 * Pure of Firebase: the Coach app does the upload (Firebase Storage, Option A). Browser APIs are injected through `env`, so everything here is unit-testable in Node.
 *   validateImageFile  -> MIME allow-list (JPEG/PNG/WebP only, SVG/HTML/anything else refused), size limit, magic-byte sniff (a renamed SVG/HTML is refused)
 *   decodeImage / resizeImage / encodeImage -> orientation-correct decode, max long edge 1600 px (never upscaled), progressive quality, re-encode strips metadata (EXIF/GPS)
 *   createController   -> stage / preview / discard with an operation token (a late result can never replace a newer selection), releases blobs and object URLs
 *   storage naming     -> exercise-media/{coachId}/{exerciseId}/image-<16 hex>; Firestore keeps only { imageUrl (https), assetRef (that path) } -- never image bytes
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_EXERCISE_IMAGE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LIMITS = { sourceBytes: 15 * 1024 * 1024, maxEdge: 1600, targetBytes: 350 * 1024, hardBytes: 480 * 1024 };
  var ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  var MSG = {
    unsupported: 'Formato no admitido. Usa una foto JPEG, PNG o WebP.',
    tooLarge: 'La imagen es demasiado grande. Intenta con otra foto.',
    process: 'No se pudo procesar esta imagen.',
    empty: 'No se pudo procesar esta imagen.'
  };

  // Magic bytes of the three accepted containers (a file's declared type is never trusted on its own).
  function sniff(head) {
    var b = head || [];
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
  }
  function fail(code, message) { return { ok: false, code: code, message: message }; }

  // env.readHead(file) -> array of the first bytes. -> { ok:true, mime } | { ok:false, code, message }
  async function validateImageFile(file, env, limits) {
    limits = limits || LIMITS;
    if (!file || typeof file !== 'object') return fail('EMPTY', MSG.empty);
    var declared = String(file.type || '').toLowerCase();
    if (!ALLOWED[declared]) return fail('UNSUPPORTED_TYPE', MSG.unsupported);                  // SVG, HTML, GIF, PDF... never reach the decoder
    if (!(file.size > 0)) return fail('EMPTY', MSG.empty);
    if (file.size > limits.sourceBytes) return fail('TOO_LARGE', MSG.tooLarge);
    var head; try { head = await env.readHead(file); } catch (e) { return fail('MALFORMED', MSG.process); }
    var real = sniff(head);
    if (!real) return fail('MALFORMED', MSG.process);                                        // renamed SVG/HTML/text, truncated or corrupt header
    if (real !== declared) return fail('MIME_MISMATCH', MSG.unsupported);
    return { ok: true, mime: real };
  }

  // Never upscale; preserve aspect ratio; round to whole pixels (>= 1).
  function fitSize(width, height, maxEdge) {
    var long = Math.max(width, height), scale = long > maxEdge ? maxEdge / long : 1;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale: scale };
  }

  // env.decode(file) -> { width, height, hasAlpha(), draw(ctx, w, h), close() } (orientation already applied)
  async function decodeImage(file, env) {
    var d = await env.decode(file);
    if (!d || !(d.width > 0) || !(d.height > 0)) throw new Error('DECODE_FAILED');
    return d;
  }
  // Draws the decoded image scaled into a fresh canvas and releases the source bitmap immediately.
  function resizeImage(decoded, env, maxEdge) {
    var size = fitSize(decoded.width, decoded.height, maxEdge), c = env.createCanvas(size.width, size.height);
    decoded.draw(c.getContext('2d'), size.width, size.height);
    return { canvas: c, width: size.width, height: size.height, scale: size.scale };
  }
  // Progressive encoding: JPEG for photos, WebP only when real transparency exists; stop at the first result under the target, shrink the canvas if quality alone is not enough.
  async function encodeImage(canvas, env, opts) {
    var mime = opts.hasAlpha && env.supportsWebp ? 'image/webp' : 'image/jpeg', best = null;
    var qualities = [0.85, 0.75, 0.65, 0.55, 0.45], w = canvas.width, h = canvas.height, c = canvas, round;
    for (round = 0; round < 4; round++) {
      for (var i = 0; i < qualities.length; i++) {
        var blob = await env.encode(c, mime, qualities[i]);
        if (!blob || !blob.size) throw new Error('ENCODE_FAILED');
        if (!best || blob.size < best.blob.size) best = { blob: blob, mime: blob.type || mime, width: w, height: h };
        if (blob.size <= opts.targetBytes) return { blob: blob, mime: blob.type || mime, width: w, height: h, bytes: blob.size };
      }
      if (best.blob.size <= opts.targetBytes) break;
      w = Math.max(1, Math.round(w * 0.8)); h = Math.max(1, Math.round(h * 0.8));          // 80 % per round
      var smaller = env.createCanvas(w, h); smaller.getContext('2d').drawImage(c, 0, 0, w, h); c = smaller;
    }
    if (best.blob.size > opts.hardBytes) { var e = new Error('TOO_LARGE'); e.code = 'TOO_LARGE'; throw e; }
    return { blob: best.blob, mime: best.mime, width: best.width, height: best.height, bytes: best.blob.size };
  }
  async function processImage(file, env, limits) {
    limits = limits || LIMITS;
    var decoded = null;
    try {
      decoded = await decodeImage(file, env);
      var alpha = false; try { alpha = !!decoded.hasAlpha(); } catch (e) { alpha = false; }
      var r = resizeImage(decoded, env, limits.maxEdge);
      decoded.close && decoded.close(); decoded = null;                                       // release the full-resolution bitmap before encoding
      var out = await encodeImage(r.canvas, env, { targetBytes: limits.targetBytes, hardBytes: limits.hardBytes, hasAlpha: alpha });
      return { ok: true, blob: out.blob, mime: out.mime, width: out.width, height: out.height, bytes: out.bytes, scaled: r.scale < 1 };
    } catch (e) {
      return e && (e.code === 'TOO_LARGE' || e.message === 'TOO_LARGE') ? fail('TOO_LARGE', MSG.tooLarge) : fail('PROCESS_FAILED', MSG.process);
    } finally { if (decoded && decoded.close) { try { decoded.close(); } catch (e) { /* ignore */ } } }
  }

  // Staging controller: holds ONE processed image until the form is saved. Every public change bumps `op`, so a slower earlier operation can never win.
  function createController(env, opts) {
    opts = opts || {};
    var limits = opts.limits || LIMITS, op = 0, state = blank();
    function blank() { return { status: 'idle', previewUrl: null, blob: null, mime: null, bytes: 0, width: 0, height: 0, message: '', code: null }; }
    function emit() { if (typeof opts.onChange === 'function') opts.onChange(snapshot()); }
    function snapshot() { return { status: state.status, previewUrl: state.previewUrl, mime: state.mime, bytes: state.bytes, width: state.width, height: state.height, message: state.message, code: state.code, hasImage: !!state.blob }; }
    function release() {
      if (state.previewUrl) { try { env.url.revoke(state.previewUrl); } catch (e) { /* ignore */ } }
      state = blank();
    }
    async function stage(file) {
      var token = ++op;
      release(); state.status = 'processing'; state.message = 'Procesando imagen...'; emit();
      var v = await validateImageFile(file, env, limits);
      if (token !== op) return { stale: true };
      if (!v.ok) { state = Object.assign(blank(), { status: 'error', message: v.message, code: v.code }); emit(); return v; }
      var r = await processImage(file, env, limits);
      if (token !== op) { if (r && r.blob) r.blob = null; return { stale: true }; }          // a newer selection / invalidate happened meanwhile: drop this result
      if (!r.ok) { state = Object.assign(blank(), { status: 'error', message: r.message, code: r.code }); emit(); return r; }
      state = { status: 'ready', previewUrl: env.url.create(r.blob), blob: r.blob, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height, message: 'Foto lista', code: null };
      emit(); return { ok: true, token: token };
    }
    return {
      stage: stage,
      get token() { return op; },
      state: snapshot,
      getStaged: function () { return state.blob ? { blob: state.blob, mime: state.mime, bytes: state.bytes, width: state.width, height: state.height } : null; },
      // discard(): user cancelled / removed the staged photo. invalidate(): context changed (client/exercise switch, modal close, logout, coach switch). Both release everything.
      discard: function () { op++; release(); emit(); },
      invalidate: function () { op++; release(); emit(); }
    };
  }

  // ---- Storage naming (path is the canonical reference kept in exercises/{id}.assetRef)
  var NAME_RE = /^image-[a-f0-9]{16}$/;
  function randomHex(bytes, cryptoObj) {
    var a = new Uint8Array(bytes), c = cryptoObj || (typeof crypto !== 'undefined' ? crypto : null);
    if (!c || !c.getRandomValues) throw new Error('NO_CRYPTO');
    c.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function safeId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id); }
  function storagePath(coachId, exerciseId, hex) {
    if (!safeId(coachId) || !safeId(exerciseId)) throw new Error('BAD_ID');
    var name = 'image-' + (hex || randomHex(8)); if (!NAME_RE.test(name)) throw new Error('BAD_NAME');
    return 'exercise-media/' + coachId + '/' + exerciseId + '/' + name;
  }
  // true only for an object of THIS coach and THIS exercise (never delete or trust anything else)
  function isOwnStoragePath(ref, coachId, exerciseId) {
    if (typeof ref !== 'string' || !safeId(coachId) || !safeId(exerciseId)) return false;
    var p = ref.split('/');
    return p.length === 4 && p[0] === 'exercise-media' && p[1] === coachId && p[2] === exerciseId && NAME_RE.test(p[3]);
  }
  function isStoragePath(ref) { return typeof ref === 'string' && /^exercise-media\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/image-[a-f0-9]{16}$/.test(ref); }

  // ---- real browser environment
  function browserEnv(win) {
    win = win || (typeof window !== 'undefined' ? window : null);
    var doc = win.document;
    function canvasFactory(w, h) {
      if (typeof win.OffscreenCanvas === 'function') { try { var o = new win.OffscreenCanvas(w, h); o.convertToBlob && (o.toBlobCompat = true); return wrapOffscreen(o); } catch (e) { /* fall back */ } }
      var c = doc.createElement('canvas'); c.width = w; c.height = h; return c;
    }
    function wrapOffscreen(o) { return { get width() { return o.width; }, get height() { return o.height; }, getContext: function (t) { return o.getContext(t); }, _off: o }; }
    return {
      supportsWebp: (function () { try { var c = doc.createElement('canvas'); c.width = c.height = 1; return c.toDataURL('image/webp').indexOf('data:image/webp') === 0; } catch (e) { return false; } })(),
      readHead: async function (file) { return Array.from(new Uint8Array(await file.slice(0, 16).arrayBuffer())); },
      decode: async function (file) {
        var bmp = null, img = null, url = null, w, h;
        if (typeof win.createImageBitmap === 'function') { bmp = await win.createImageBitmap(file, { imageOrientation: 'from-image' }); w = bmp.width; h = bmp.height; }
        else { url = win.URL.createObjectURL(file); img = new win.Image(); await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = url; }); w = img.naturalWidth; h = img.naturalHeight; }
        var src = bmp || img;
        return {
          width: w, height: h,
          hasAlpha: function () { try { var c = canvasFactory(32, 32), x = c.getContext('2d'); x.drawImage(src, 0, 0, 32, 32); var d = x.getImageData(0, 0, 32, 32).data; for (var i = 3; i < d.length; i += 4) if (d[i] < 250) return true; } catch (e) { /* no alpha info */ } return false; },
          draw: function (ctx, cw, ch) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(src, 0, 0, cw, ch); },   // white backing so JPEG never gets a black background
          close: function () { if (bmp && bmp.close) bmp.close(); if (url) { win.URL.revokeObjectURL(url); url = null; } img = null; bmp = null; }
        };
      },
      createCanvas: canvasFactory,
      encode: function (canvas, mime, q) {
        if (canvas._off) return canvas._off.convertToBlob({ type: mime, quality: q });
        return new Promise(function (res) { canvas.toBlob(res, mime, q); });
      },
      url: { create: function (b) { return win.URL.createObjectURL(b); }, revoke: function (u) { win.URL.revokeObjectURL(u); } }
    };
  }

  return { LIMITS: LIMITS, ALLOWED: ALLOWED, MSG: MSG, sniff: sniff, validateImageFile: validateImageFile, fitSize: fitSize, decodeImage: decodeImage, resizeImage: resizeImage, encodeImage: encodeImage,
    processImage: processImage, createController: createController, storagePath: storagePath, isOwnStoragePath: isOwnStoragePath, isStoragePath: isStoragePath, randomHex: randomHex, browserEnv: browserEnv };
});
