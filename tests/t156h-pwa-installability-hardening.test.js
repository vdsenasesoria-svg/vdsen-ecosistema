'use strict';
/**
 * T156 — PWA installability hardening.
 *
 * Scope: manifest.json, sw.js, the SW registration in vdsen-cliente.html,
 * start_url/scope/display, icon declarations, and the T155 install CTA
 * (regression only). Coach untouched (it has no manifest/SW at all).
 *
 * Audit (10-point checklist from the ticket):
 *  1. manifest valid JSON with all required installability fields — OK.
 *  2. start_url "/cliente" — matches the vercel.json rewrite
 *     ({source:"/cliente", destination:"/vdsen-cliente.html"}), no 404.
 *  3. scope — was NOT declared, so it relied on each browser's own default-
 *     scope computation (spec default = the start_url's directory, which
 *     for "/cliente" resolves to "/" — correct, but implicit and historically
 *     inconsistent across non-Chromium implementations). FIX: declared
 *     explicitly as "scope": "/", matching both the real routes this app
 *     serves from and the service worker's own default registration scope
 *     (registered at '/sw.js' with no options -> scope "/"). Zero risk,
 *     purely additive, removes reliance on implicit browser behavior.
 *  4. display: "standalone" — OK, unchanged.
 *  5. theme_color / background_color — both "#0a0a0a", valid hex, matches
 *     the <meta name="theme-color"> tag in <head> — OK, unchanged.
 *  6. icon declaration — the manifest's only icon is a `data:image/svg+xml`
 *     URI (not a hosted file). This is spec-legal (manifest icon `src` may
 *     be a data URL) and satisfies Chrome's declared-size checks, but is a
 *     DOCUMENTED reliability risk: some Android/Chrome versions do not
 *     reliably rasterize a data-URI SVG into the actual home-screen icon
 *     bitmap (the install prompt can still fire, but the resulting icon may
 *     render as a generic/blank placeholder on some OEM launchers/older
 *     WebView builds). Per the ticket's explicit instruction, this is
 *     REPORTED, NOT fixed — a real fix needs new binary PNG assets (192px +
 *     512px, ideally a maskable variant), which this ticket forbids
 *     inventing. No repo asset exists to reuse (verified: no .png/.ico/
 *     .jpg/.webp files anywhere in the repo, no favicon/apple-touch-icon
 *     references). Left for a follow-up ticket once real assets are
 *     supplied.
 *  7. service worker registration — 'navigator.serviceWorker.register(\'/sw.js\')'
 *     with no explicit scope option -> default scope "/", consistent with
 *     the manifest's now-explicit "/" scope — OK, unchanged.
 *  8. start_url route does not 404 — confirmed via the vercel.json rewrite
 *     — OK, unchanged.
 *  9. standalone opens Client, not Coach — start_url is "/cliente"
 *     (Coach has no manifest/SW/start_url at all) — OK, unchanged.
 *  10. SW update pattern — versioned CACHE name + activate-time cleanup of
 *     stale caches + skipWaiting/clients.claim is the standard safe
 *     pattern; no broken-load scenario found — OK, unchanged.
 *
 * Net: 1 real, safe hardening fix applied (explicit scope). The SVG-icon
 * reliability limitation is a documented finding, not a code change (blocked
 * by the "no new binary assets" constraint). No other bug found.
 *
 * Run: node tests/t156h-pwa-installability-hardening.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT   = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const COACH    = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const SW       = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const VERCEL   = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const MANIFEST_RAW = fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Item 1 — manifest parses as valid JSON with required installability fields.
// ─────────────────────────────────────────────────────────────────────────────

let MANIFEST;
assert.doesNotThrow(() => { MANIFEST = JSON.parse(MANIFEST_RAW); }, 'T156-H Item1: manifest.json must parse as valid JSON');
assert.ok(MANIFEST.name && MANIFEST.short_name, 'T156-H Item1: manifest must declare name and short_name');
assert.ok(Array.isArray(MANIFEST.icons) && MANIFEST.icons.length > 0, 'T156-H Item1: manifest must declare at least one icon');

console.log('manifest.json parses and has required installability fields — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Item 2 & 8 — start_url is "/cliente" and the route is real (vercel.json
// rewrite exists, not a 404).
// ─────────────────────────────────────────────────────────────────────────────

assert.strictEqual(MANIFEST.start_url, '/cliente', 'T156-H Item2: start_url must remain "/cliente"');
const clienteRewrite = (VERCEL.rewrites || []).find(r => r.source === '/cliente');
assert.ok(clienteRewrite, 'T156-H Item8: vercel.json must have a rewrite for "/cliente" (start_url must not 404)');
assert.strictEqual(clienteRewrite.destination, '/vdsen-cliente.html', 'T156-H Item8: "/cliente" must rewrite to vdsen-cliente.html');

console.log('start_url "/cliente" is a real, non-404 route (vercel.json rewrite confirmed) — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Item 9 — standalone opens Client, not Coach (Coach has no PWA surface).
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(!/rel="manifest"/.test(COACH), 'T156-H Item9: vdsen-coach.html must not link a manifest (no competing installable surface)');
assert.ok(!/serviceWorker\.register/.test(COACH), 'T156-H Item9: vdsen-coach.html must not register a service worker');
assert.notStrictEqual(MANIFEST.start_url, '/coach', 'T156-H Item9: start_url must never point at Coach');

console.log('Only Client is installable; start_url never resolves to Coach — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Item 3 (FIX) — scope is now explicit, "/", matching the SW's own default
// registration scope and covering the real start_url route.
// ─────────────────────────────────────────────────────────────────────────────

assert.strictEqual(MANIFEST.scope, '/', 'T156-H Item3 FIX: manifest must now declare an explicit scope of "/" (was implicit/browser-computed before)');
assert.ok(
  MANIFEST.start_url.startsWith(MANIFEST.scope) || MANIFEST.scope === '/',
  'T156-H Item3: start_url must fall within the declared scope'
);

console.log('scope is now explicit ("/") and covers start_url — OK (hardening fix applied)');

// ─────────────────────────────────────────────────────────────────────────────
// Item 4 & 5 — display/theme/background unchanged and valid.
// ─────────────────────────────────────────────────────────────────────────────

assert.strictEqual(MANIFEST.display, 'standalone', 'T156-H Item4: display must remain "standalone"');
assert.ok(/^#[0-9a-fA-F]{6}$/.test(MANIFEST.theme_color), 'T156-H Item5: theme_color must be a valid 6-digit hex color');
assert.ok(/^#[0-9a-fA-F]{6}$/.test(MANIFEST.background_color), 'T156-H Item5: background_color must be a valid 6-digit hex color');
assert.ok(
  CLIENT.includes(`<meta name="theme-color" content="${MANIFEST.theme_color}">`),
  'T156-H Item5: the <meta theme-color> tag must match manifest.theme_color'
);

console.log('display/theme_color/background_color valid and consistent with <head> meta tag — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Item 6 — icon format finding: documented, not fixed (no binary assets
// available or invented). Confirmed no PNG/ICO/JPG/WEBP asset exists in the
// repo to reuse, so per the ticket's own instruction this is reported only.
// ─────────────────────────────────────────────────────────────────────────────

assert.strictEqual(MANIFEST.icons.length, 1, 'T156-H Item6: still exactly one icon (no new asset invented)');
assert.ok(MANIFEST.icons[0].src.startsWith('data:image/svg+xml'), 'T156-H Item6: the icon remains a data-URI SVG (unchanged — no binary asset available to replace it)');

const repoRoot = path.join(__dirname, '..');
const binaryIconFiles = fs.readdirSync(repoRoot).filter(f => /\.(png|ico|jpe?g|webp)$/i.test(f));
assert.strictEqual(binaryIconFiles.length, 0, 'T156-H Item6: confirms no existing binary icon asset was available to reuse (finding is reported, not silently fixed with an invented asset)');

console.log('Icon format limitation confirmed and left as a documented finding (no binary assets to reuse or invent) — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Item 7 — SW registration path/scope.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(CLIENT.includes("navigator.serviceWorker.register('/sw.js')"), 'T156-H Item7: SW must register at the root-scoped path "/sw.js" (unchanged)');
assert.ok(
  !/register\('\/sw\.js',\s*\{\s*scope:/.test(CLIENT),
  'T156-H Item7: registration must not pass a narrower explicit scope option that would conflict with the manifest\'s "/" scope'
);

console.log('Service worker registered at root path, scope consistent with manifest — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Item 10 — SW update pattern is the standard safe one (versioned cache,
// stale-cache cleanup on activate, skipWaiting + clients.claim).
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(/const CACHE = 'vdsen-v\d+';/.test(SW), 'T156-H Item10: SW must use a versioned cache name');
assert.ok(/self\.skipWaiting\(\)/.test(SW), 'T156-H Item10: install handler must call skipWaiting()');
assert.ok(/keys\.filter\(k => k !== CACHE\)\.map\(k => caches\.delete\(k\)\)/.test(SW), 'T156-H Item10: activate handler must delete stale caches');
assert.ok(/self\.clients\.claim\(\)/.test(SW), 'T156-H Item10: activate handler must call clients.claim()');

console.log('Service worker update pattern (versioned cache + cleanup + claim) intact — OK');

// ─────────────────────────────────────────────────────────────────────────────
// T155 regression — install CTA still hidden in standalone, all T155 wiring
// untouched by this hardening pass.
// ─────────────────────────────────────────────────────────────────────────────

const updateUiFn = extractFunction(CLIENT, 'window._updatePwaInstallUI = function()');
assert.ok(updateUiFn, 'T156-H regression: _updatePwaInstallUI (T155) must still exist');
assert.ok(
  /if \(_pwaIsStandalone\(\) \|\| window\._pwaInstalled\) \{ row\.style\.display = 'none'; return; \}/.test(updateUiFn),
  'T156-H regression: the T155 CTA must still hide itself when already standalone or installed'
);
assert.ok(CLIENT.includes('📲 INSTALAR VDSEN'), 'T156-H regression: the T155 install button must still exist unchanged');
assert.ok(CLIENT.includes("window.addEventListener('beforeinstallprompt'"), 'T156-H regression: the T155 beforeinstallprompt capture must still exist unchanged');

console.log('T155 install CTA (standalone-hides / button / event capture) unchanged — OK');

console.log('');
console.log('T156 — PWA installability hardening: ALL ASSERTIONS PASSED');
