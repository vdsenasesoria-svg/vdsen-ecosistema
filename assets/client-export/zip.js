/* VDSEN client export — ZIP writer (STORE, no compression, no dependency). Enough for a handful of JSON/CSV/media files; deterministic bytes
 * for identical input (fixed DOS time derived from the export timestamp). UTF-8 names (general-purpose flag bit 11). No ZIP64: refuses > 4 GiB. */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_ZIP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var TABLE = (function() { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { var c = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }
  function dosDateTime(d) {
    var y = Math.max(1980, d.getUTCFullYear());
    return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
  }
  function safePath(p) {
    if (typeof p !== 'string' || !p || p.charAt(0) === '/' || p.indexOf('\\') !== -1 || p.split('/').some(function(s) { return s === '' || s === '.' || s === '..'; })) throw new Error('ZIP_BAD_PATH');
    return p;
  }

  // entries: [{ path, content: string | Uint8Array }] -> Uint8Array
  function build(entries, when) {
    var dt = dosDateTime(when instanceof Date ? when : new Date(0));
    var seen = {}, parts = [], central = [], offset = 0;
    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    entries.forEach(function(e) {
      var path = safePath(e.path); if (seen[path]) throw new Error('ZIP_DUPLICATE_PATH'); seen[path] = 1;
      var name = utf8(path), data = typeof e.content === 'string' ? utf8(e.content) : e.content, crc = crc32(data);
      var local = [0x50, 0x4b, 0x03, 0x04].concat(u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      var head = new Uint8Array(local.length + name.length); head.set(local, 0); head.set(name, local.length);
      parts.push(head, data);
      var cd = [0x50, 0x4b, 0x01, 0x02].concat(u16(20), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date), u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      var ch = new Uint8Array(cd.length + name.length); ch.set(cd, 0); ch.set(name, cd.length); central.push(ch);
      offset += head.length + data.length;
      if (offset > 0xFFFFFFFF) throw new Error('ZIP_TOO_LARGE');
    });
    var cdSize = central.reduce(function(a, c) { return a + c.length; }, 0);
    var end = new Uint8Array([0x50, 0x4b, 0x05, 0x06].concat(u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdSize), u32(offset), u16(0)));
    var total = offset + cdSize + end.length, out = new Uint8Array(total), pos = 0;
    parts.concat(central, [end]).forEach(function(p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  return { build: build, crc32: crc32, utf8: utf8 };
});
