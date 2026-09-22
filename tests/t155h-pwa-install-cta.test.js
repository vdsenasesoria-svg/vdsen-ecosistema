'use strict';
/**
 * T155 — Client install-to-phone button (PWA).
 *
 * Scope: vdsen-cliente.html only (Coach untouched — it has no manifest/SW at
 * all). Audit found manifest.json + sw.js already registered and linked in
 * <head> (name/short_name/start_url/display:standalone/theme_color/icons all
 * present), but no beforeinstallprompt/appinstalled handling and no install
 * CTA anywhere.
 *
 * Implementation: a small, dependency-free PWA install CTA in the Perfil tab
 * (secondary zone, below the plan-PDF button, above logout — never over the
 * main training CTA, never an auto-modal):
 *   - beforeinstallprompt is captured as early as possible in the first
 *     plain <script> block in <head> (before the module/app script even
 *     parses), storing the event on window._pwaDeferredPrompt and calling
 *     e.preventDefault() so Chrome doesn't show its own mini-infobar.
 *   - window._updatePwaInstallUI() decides visibility: hidden if already
 *     standalone/installed, shown with an Android-flow description if a
 *     deferred prompt exists, shown with an iOS-flow description if
 *     iphone/ipad/ipod UA and no deferred prompt, else hidden (browser
 *     doesn't support install — no error, just no CTA).
 *   - window._pwaInstallGo() triggers the native prompt() on Android/Chrome
 *     (one-time use per captured event, matching the browser's own
 *     contract) or opens an instructions modal on iOS. No success message
 *     is ever shown on 'accepted' — only appinstalled (a real signal from
 *     the browser) hides the CTA, so dismissed/accepted look the same to
 *     the user until the OS actually confirms installation.
 *   - appinstalled sets window._pwaInstalled = true, which hides the CTA on
 *     the next render (also re-checked live if the row already exists).
 *   - manifest.json: added "512x512" to the existing scalable SVG icon's
 *     sizes list (same file, no new asset) — the minimal adjustment for
 *     Chrome's installability check, which the ticket allows when a real
 *     requirement is missing.
 *
 * Run: node tests/t155h-pwa-install-cta.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

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
// PWA support already present (audit) — regression guard that it's untouched.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(CLIENT.includes('<link rel="manifest" href="manifest.json">'), 'manifest link must remain in <head>');
assert.ok(CLIENT.includes("navigator.serviceWorker.register('/sw.js')"), 'service worker registration must remain unchanged');
assert.strictEqual(MANIFEST.display, 'standalone', 'manifest display must remain standalone');
assert.strictEqual(MANIFEST.start_url, '/cliente', 'manifest start_url must remain unchanged');

console.log('Pre-existing manifest/service-worker registration intact — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: beforeinstallprompt captured correctly (early, before module code,
// preventDefault called, stored on window).
// ─────────────────────────────────────────────────────────────────────────────

const headScriptEnd = CLIENT.indexOf('<script type="module">');
const earlyScript = CLIENT.slice(0, headScriptEnd);

assert.ok(
  /window\.addEventListener\('beforeinstallprompt', function\(e\) \{\s*e\.preventDefault\(\);\s*window\._pwaDeferredPrompt = e;/.test(earlyScript),
  'T155-H Test1: beforeinstallprompt must be captured in the early <head> script, calling preventDefault() and storing the event'
);
assert.ok(
  earlyScript.includes('window._pwaDeferredPrompt = null;') && earlyScript.includes('window._pwaInstalled = false;'),
  'T155-H Test1: initial PWA state must be declared in the early script'
);

console.log('beforeinstallprompt captured early, deferred, preventDefault called — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: appinstalled hides the CTA (sets _pwaInstalled, clears the prompt).
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /window\.addEventListener\('appinstalled', function\(\) \{\s*window\._pwaInstalled = true;\s*window\._pwaDeferredPrompt = null;/.test(earlyScript),
  'T155-H Test5: appinstalled must set _pwaInstalled=true and clear the deferred prompt'
);

console.log('appinstalled sets _pwaInstalled and clears the deferred prompt — OK');

// ─────────────────────────────────────────────────────────────────────────────
// _updatePwaInstallUI: visibility logic (Tests 2, 5, 6, 8).
// ─────────────────────────────────────────────────────────────────────────────

const updateUiFn = extractFunction(CLIENT, 'window._updatePwaInstallUI = function()');
assert.ok(updateUiFn, '_updatePwaInstallUI must exist');

assert.ok(
  /if \(_pwaIsStandalone\(\) \|\| window\._pwaInstalled\) \{ row\.style\.display = 'none'; return; \}/.test(updateUiFn),
  'T155-H Test6: _updatePwaInstallUI must hide the row when already standalone or installed'
);
assert.ok(
  /if \(window\._pwaDeferredPrompt\) \{\s*row\.style\.display = '';/.test(updateUiFn),
  'T155-H Test2: _updatePwaInstallUI must show the row when a deferred prompt exists (Android/Chrome path)'
);
assert.ok(
  /if \(_pwaIsIOS\(\)\) \{\s*row\.style\.display = '';/.test(updateUiFn),
  'T155-H Test7: _updatePwaInstallUI must show the row on iOS UA even without a deferred prompt'
);
assert.ok(
  /row\.style\.display = 'none';\s*\};?\s*$/.test(updateUiFn.trim()),
  'T155-H Test8: _updatePwaInstallUI must default to hidden when neither a deferred prompt nor iOS applies (unsupported browser — no error, no CTA)'
);
assert.ok(
  /window\._updatePwaInstallUI = function\(\) \{\s*var row = document\.getElementById\('_pwaInstallRow'\);\s*if \(!row\) return;/.test(updateUiFn),
  'T155-H Test8: _updatePwaInstallUI must no-op safely (not throw) if the row does not exist yet'
);

console.log('_updatePwaInstallUI: standalone/installed hides, Android shows, iOS shows, unsupported hides safely — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Detection helpers (standalone / iOS) — Test 6 & 7 prerequisites.
// ─────────────────────────────────────────────────────────────────────────────

const standaloneFn = extractFunction(CLIENT, 'function _pwaIsStandalone()');
assert.ok(standaloneFn, '_pwaIsStandalone must exist');
assert.ok(
  standaloneFn.includes("matchMedia('(display-mode: standalone)').matches") && standaloneFn.includes('window.navigator.standalone === true'),
  'T155-H Test6: _pwaIsStandalone must check both matchMedia display-mode and navigator.standalone (iOS Safari)'
);
assert.ok(/try \{/.test(standaloneFn), 'T155-H Test8: _pwaIsStandalone must be defensive (try/catch) against unsupported matchMedia');

const iosFn = extractFunction(CLIENT, 'function _pwaIsIOS()');
assert.ok(iosFn, '_pwaIsIOS must exist');
assert.ok(/iphone\|ipad\|ipod/i.test(iosFn), 'T155-H Test7: _pwaIsIOS must detect iPhone/iPad/iPod via user agent');

console.log('_pwaIsStandalone and _pwaIsIOS detection helpers present and defensive — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 & 4: click triggers the native prompt; dismissed/accepted never
// show a false-success message — only appinstalled (real signal) hides CTA.
// ─────────────────────────────────────────────────────────────────────────────

const installGoFn = extractFunction(CLIENT, 'window._pwaInstallGo = async function()');
assert.ok(installGoFn, '_pwaInstallGo must exist');
assert.ok(installGoFn.includes('promptEvent.prompt();'), 'T155-H Test3: _pwaInstallGo must call the native prompt() on the deferred event');
assert.ok(installGoFn.includes('await promptEvent.userChoice;'), 'T155-H Test3: _pwaInstallGo must await userChoice');
assert.ok(
  installGoFn.includes('window._pwaDeferredPrompt = null; // a captured prompt can only be used once'),
  'T155-H Test4: _pwaInstallGo must clear the deferred prompt after use (one-time use, prevents replaying a stale prompt)'
);
assert.ok(
  !/showToast|alert\(|success|✅|instalad[oa]!/i.test(installGoFn),
  'T155-H Test4: _pwaInstallGo must NOT show any success/toast message on accepted/dismissed — no false-success'
);
assert.ok(
  installGoFn.includes('_pwaShowIOSInstructions()'),
  'T155-H Test7: _pwaInstallGo must fall back to the iOS instructions modal (never call prompt() on iOS)'
);

console.log('_pwaInstallGo: native prompt on Android, one-time use, no false-success message, iOS fallback — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: iOS instructions modal shows real guidance, never claims automatic
// install and never references beforeinstallprompt/deferredPrompt.
// ─────────────────────────────────────────────────────────────────────────────

const iosModalFn = extractFunction(CLIENT, 'function _pwaShowIOSInstructions()');
assert.ok(iosModalFn, '_pwaShowIOSInstructions must exist');
assert.ok(/Compartir/.test(iosModalFn) && /Agregar a pantalla de inicio/.test(iosModalFn), 'T155-H Test7: iOS modal must show the Compartir -> Agregar a pantalla de inicio instructions');
assert.ok(!/_pwaDeferredPrompt|\.prompt\(\)/.test(iosModalFn), 'T155-H Test7: iOS modal must never reference the native beforeinstallprompt flow');
assert.ok(!/instalad[oa]\s*(con\s*)?éxito|se instaló/i.test(iosModalFn), 'T155-H: iOS modal must never claim the app was already installed');

console.log('iOS instructions modal shows real steps, no false claim of automatic install — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Wiring: CTA button exists in Perfil, in a secondary zone (below plan PDF,
// above logout — never over the main training CTA), and renderPerfil()
// re-syncs visibility on every render (covers tab-switch + state changes).
// ─────────────────────────────────────────────────────────────────────────────

const pdfBtnIdx = CLIENT.indexOf('⬇ DESCARGAR MI PLAN PDF');
const pwaRowIdx = CLIENT.indexOf('id="_pwaInstallRow"');
const logoutBtnIdx = CLIENT.indexOf('class="logout-btn" onclick="doLogout()"');
assert.ok(pdfBtnIdx !== -1 && pwaRowIdx !== -1 && logoutBtnIdx !== -1 && pdfBtnIdx < pwaRowIdx && pwaRowIdx < logoutBtnIdx,
  'T155-H: the install CTA must sit in Perfil between the plan-PDF button and the logout button (secondary zone)');

assert.ok(CLIENT.includes('📲 INSTALAR VDSEN'), 'T155-H: the button must read "Instalar VDSEN"');
assert.ok(CLIENT.includes('onclick="_pwaInstallGo()"'), 'T155-H: the button must be wired to _pwaInstallGo()');
assert.ok(CLIENT.includes('id="_pwaInstallRow" style="display:none;'), 'T155-H: the CTA row must start hidden (no default flash before state is known)');

const renderPerfilFn = extractFunction(CLIENT, 'function renderPerfil()');
assert.ok(renderPerfilFn, 'renderPerfil must exist');
assert.ok(
  /try \{\s*window\._updatePwaInstallUI\(\);\s*\} catch\(e\) \{\}\s*\}$/.test(renderPerfilFn.trim()),
  'T155-H: renderPerfil() must re-sync the install CTA visibility on every render (tab switch, profile update, etc.)'
);

console.log('Install CTA wired in Perfil (secondary zone), synced on every renderPerfil() call — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Invariant: never placed over/near the main training CTA, no auto-modal on
// load (the row starts hidden and only becomes visible via _updatePwaInstallUI,
// itself only called from renderPerfil / the two PWA event listeners).
// ─────────────────────────────────────────────────────────────────────────────

assert.strictEqual(
  (CLIENT.match(/id="_pwaInstallRow"/g) || []).length, 1,
  'T155-H: the install CTA must exist exactly once (Perfil tab only, not duplicated elsewhere)'
);
assert.ok(
  !/DOMContentLoaded[\s\S]{0,200}_pwaInstallGo\(\)|window\.onload[\s\S]{0,200}_pwaShowIOSInstructions\(\)/.test(CLIENT),
  'T155-H: no automatic install prompt/modal must fire on page load — the user must click the CTA'
);

console.log('No auto-modal on load; CTA is a single, user-initiated, secondary-zone control — OK');

// ─────────────────────────────────────────────────────────────────────────────
// manifest.json — minimal adjustment only (512 added to the existing icon).
// ─────────────────────────────────────────────────────────────────────────────

assert.strictEqual(MANIFEST.icons.length, 1, 'T155-H: manifest must still have exactly one icon entry (no new asset added)');
assert.strictEqual(MANIFEST.icons[0].sizes, '192x192 512x512', 'T155-H: the existing scalable SVG icon must now declare both 192x192 and 512x512');

console.log('manifest.json: minimal icon-sizes adjustment only, no new asset — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guard — Coach app untouched (it has no PWA support at all; the
// ticket explicitly scopes this to Client only).
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  !/beforeinstallprompt|appinstalled|_pwaInstallGo|_pwaDeferredPrompt/.test(COACH),
  'T155-H regression: vdsen-coach.html must remain untouched by this PWA install feature'
);

console.log('Coach app untouched — OK');

console.log('');
console.log('T155 — Client install-to-phone button: ALL ASSERTIONS PASSED');
