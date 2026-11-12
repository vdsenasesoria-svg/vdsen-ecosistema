/* VDSEN client export — shared pure helpers (no I/O, no DOM, no Firestore). */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_UTIL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // Finite number or null. Numeric strings ("82.5") are accepted because legacy logs stored loads as text.
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') { var n = Number(v.replace(',', '.')); return isFinite(n) ? n : null; }
    return null;
  }

  var MIN_PLAUSIBLE_MS = 946684800000; // 2000-01-01

  // Firestore Timestamp-like ({seconds,nanoseconds} / toMillis / toDate), Date, epoch ms, ISO string -> epoch ms or null.
  function toMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) && v >= MIN_PLAUSIBLE_MS ? v : null; // epoch ms only; smaller numbers are not dates
    if (v instanceof Date) { var t = v.getTime(); return isFinite(t) ? t : null; }
    if (typeof v === 'string') { var p = Date.parse(v); return isFinite(p) ? p : (/^\d{10,}$/.test(v) ? Number(v) : null); }
    if (typeof v === 'object') {
      if (typeof v.toMillis === 'function') { try { return toMs(v.toMillis()); } catch (e) { return null; } }
      if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
      if (typeof v._seconds === 'number') return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
    }
    return null;
  }
  function toIso(v) { var ms = toMs(v); return ms === null ? null : new Date(ms).toISOString(); }

  // Deterministic comparison: null/undefined last; numbers numerically; everything else as strings.
  function cmp(a, b) {
    var an = a === null || a === undefined, bn = b === null || b === undefined;
    if (an || bn) return an && bn ? 0 : (an ? 1 : -1);
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : (a > b ? 1 : 0);
    a = String(a); b = String(b);
    return a < b ? -1 : (a > b ? 1 : 0);
  }
  // Stable multi-key sort (returns a new array). keyFn returns an array of comparable keys.
  function sortBy(arr, keyFn) {
    return arr.map(function(x, i) { return { x: x, i: i, k: keyFn(x) }; }).sort(function(p, q) {
      for (var j = 0; j < p.k.length; j++) { var c = cmp(p.k[j], q.k[j]); if (c) return c; }
      return p.i - q.i;
    }).map(function(p) { return p.x; });
  }

  function round(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    var f = Math.pow(10, d === undefined ? 2 : d); return Math.round(n * f) / f;
  }
  function mean(a) { return a.length ? a.reduce(function(s, x) { return s + x; }, 0) / a.length : null; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function localDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  // File-name fragment: accents folded, [A-Za-z0-9] kept, everything else -> '-'.
  function safeName(name, fallback) {
    var s = String(name === null || name === undefined ? '' : name);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    s = s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    return s || fallback || 'cliente';
  }

  return { isObj: isObj, num: num, toMs: toMs, toIso: toIso, cmp: cmp, sortBy: sortBy, round: round, mean: mean, pad2: pad2, localDate: localDate, safeName: safeName };
});
