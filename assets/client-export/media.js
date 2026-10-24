/* VDSEN client export — MEDIA. VDSEN stores no Firebase Storage objects (neither app loads the Storage SDK). Media can only appear as
 *   (a) inline data: URIs inside Firestore documents  -> bundled into media/ (already in hand, nothing is downloaded), or
 *   (b) http(s) URLs                                    -> REFERENCE ONLY (never fetched; no unauthenticated/third-party requests).
 * Signed-URL query strings (token/signature-like params) are stripped so credentials never reach the archive.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_MEDIA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var DATA_RE = /^data:((?:image|video)\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;
  var MEDIA_URL_RE = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|mp4|mov|webm)$/i;
  var MEDIA_KEY_RE = /(foto|photo|imagen|image|picture|video)/i;
  var SIGNED_PARAM_RE = /(token|sig|signature|key|auth|credential|x-goog|x-amz|expires)/i;
  var EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/avif': 'avif', 'image/bmp': 'bmp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

  function decodeBase64(b64) {
    b64 = b64.replace(/\s+/g, '');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function stripUrl(u) {
    var q = u.indexOf('?'), h = u.indexOf('#'), cut = q === -1 ? h : (h === -1 ? q : Math.min(q, h));
    if (cut === -1) return { url: u, stripped: false };
    var tail = u.slice(cut), signed = SIGNED_PARAM_RE.test(tail);
    return signed ? { url: u.slice(0, cut), stripped: true } : { url: u, stripped: false };
  }

  // Walks a JSON-able tree in place (call on a private clone). Returns { files:[{path,bytes}], index:[...], status }.
  function extract(tree) {
    var files = [], index = [], seq = 0;
    function walk(v, path, parentKey) {
      if (typeof v === 'string') {
        var m = DATA_RE.exec(v);
        if (m) {
          seq++; var ext = EXT[m[1].toLowerCase()] || 'bin', name = 'media/media-' + String(seq).padStart(3, '0') + '.' + ext;
          var bytes = decodeBase64(m[2]); files.push({ path: name, bytes: bytes });
          index.push({ source_path: path, kind: 'inline_data_uri', mime: m[1].toLowerCase(), bundled: true, bundled_as: name, bytes: bytes.length });
          return '[media-file:' + name + ']';
        }
        if (/^https?:\/\//i.test(v) && (MEDIA_URL_RE.test(v.split(/[?#]/)[0]) || MEDIA_KEY_RE.test(parentKey || ''))) {
          var s = stripUrl(v);
          index.push({ source_path: path, kind: 'url_reference', url: s.url, signed_query_stripped: s.stripped, bundled: false });
          return s.url;
        }
        return v;
      }
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) v[i] = walk(v[i], path + '[' + i + ']', parentKey); return v; }
      if (v && typeof v === 'object') { Object.keys(v).forEach(function(k) { v[k] = walk(v[k], path ? path + '.' + k : k, k); }); return v; }
      return v;
    }
    var out = walk(tree, '', '');
    var bundled = index.filter(function(x) { return x.bundled; }).length, refs = index.length - bundled;
    var status = !index.length ? 'NOT_PRESENT' : (refs === 0 ? 'INCLUDED' : (bundled === 0 ? 'REFERENCES_ONLY' : 'PARTIAL'));
    return { tree: out, files: files, index: index, status: status, bundled_count: bundled, reference_only_count: refs };
  }

  return { extract: extract };
});
