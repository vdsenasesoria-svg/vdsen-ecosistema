// T542: lightweight UI contract for the client redesign (design system v3). Not pixel-perfect: structure, hooks, tokens, safety anchors.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const ds3 = html.slice(html.indexOf('<style id="vdsen-ds3">'), html.indexOf('</style>', html.indexOf('<style id="vdsen-ds3">')));
const bodyStart = html.indexOf('<body>');

test('T542.1 required screens, tabs and critical hooks exist', () => {
  for (const id of ['scrLogin', 'scrLoading', 'scrOnboarding', 'scrApp', 'tabResumen', 'tabEntr', 'tabNutr', 'tabCheckin', 'tabPerfil', 'liEmail', 'liPass', 'liErr', 'offlineBanner', 'hdName', 'hdGoal', 'hdWeek', 'toast'])
    assert.ok(html.includes('id="' + id + '"'), id);
  for (const id of ['exNav', 'exPanel', 'restTimerOverlay', 'timerPill', 'restTimerNum', 'restRing', 'restLastSet'])
    assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(/onclick="doLogin\(\)"/.test(html) && /function doLogin\(/.test(html));
});
test('T542.2 navigation contract: five tabs wired through goTab, aria-current on the active one', () => {
  for (let i = 0; i < 5; i++) assert.ok(new RegExp('<button class="nb[^"]*" id="nb' + i + '" onclick="goTab\\(' + i + '\\)"').test(html), 'nb' + i);
  assert.ok(/var TABS\s*=\s*\['tabResumen','tabEntr','tabNutr','tabCheckin','tabPerfil'\]|TABS\s*=\s*\[/.test(html));
  assert.ok(html.includes("b.setAttribute('aria-current', 'page')"));
});
test('T542.3 navigation icons are inline SVG (currentColor), never emoji', () => {
  const nav = html.slice(html.indexOf('<nav class="bnav"'), html.indexOf('</nav>', html.indexOf('<nav class="bnav"')));
  assert.equal((nav.match(/<svg class="ico"/g) || []).length, 5);
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(nav), 'no emoji in the bottom nav');
  const header = html.slice(html.indexOf('<header class="hdr">'), html.indexOf('</header>'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(header), 'no emoji in the header');
  assert.ok(/<symbol id="i-target"/.test(html) && /<symbol id="i-dumbbell"/.test(html));
});
test('T542.4 production Firebase config is unchanged and staging never appears in the client', () => {
  assert.ok(html.includes('projectId: "vdsen-ecosistema"'));
  assert.ok(html.includes('appId: "1:1066774387899:web:77e7f3570636b71bf61d9e"'));
  assert.ok(html.includes('authDomain: "vdsen-ecosistema.firebaseapp.com"'));
  assert.ok(!/staging/i.test(html.slice(html.indexOf('const firebaseConfig'), html.indexOf('const firebaseConfig') + 400)));
  assert.ok(!html.includes('firebase-staging') && !html.includes('vdsen-ecosistema-staging'));
  assert.equal((html.match(/const firebaseConfig = \{/g) || []).length, 1);
});
test('T542.5 NUMERIC_APPLY_ENABLED is still false and the client lifecycle gate is intact', () => {
  assert.ok(/var NUMERIC_APPLY_ENABLED = false;/.test(fs.readFileSync(path.join(root, 'assets/progression-effective-prescription.js'), 'utf8')));
  assert.ok(html.includes('e.NUMERIC_APPLY_ENABLED === true'));
});
test('T542.6 prescription and execution are labelled distinctly (prescribed RIR is not observed RIR)', () => {
  assert.ok(html.includes('<span>PRESCRIPCIÓN</span><span>COACH</span>'));
  assert.ok(html.includes('OBJETIVO COACH'));
  assert.ok(html.includes('REGISTRO · SERIE'));
  assert.ok(html.includes('RIR REAL · ÚLTIMA SERIE'));
  assert.ok(html.includes('id="xrir_val_'), 'observed RIR keeps its own field');
  assert.ok(/rir_real/.test(html), 'observed RIR evidence field name unchanged');
});
test('T542.7 design tokens exist: roles, spacing, radii, touch targets, icon size, motion, focus, semantic states', () => {
  for (const t of ['--font-display', '--font-body', '--font-num', '--sp-1', '--sp-4', '--r-1', '--fs-micro', '--fs-display', '--tap:44px', '--tap-lg:56px', '--ico', '--ease', '--dur-1', '--focus-ring', '--plate', '--rule',
    '--st-live', '--st-done', '--st-partial', '--st-review', '--st-stale', '--st-auto', '--st-offline', '--st-sync', '--st-error'])
    assert.ok(ds3.includes(t), t);
  assert.ok(ds3.includes(':root.light-mode{'), 'light mode tokens');
  assert.ok(ds3.includes('prefers-reduced-motion:reduce'), 'reduced motion respected');
  assert.ok(/button:focus-visible/.test(ds3), 'focus-visible styling');
});
test('T542.8 fonts: two families in one request, no third typeface, canonical palette intact', () => {
  assert.equal((html.match(/fonts\.googleapis\.com\/css2/g) || []).length, 1);
  assert.ok(!/Courier Prime/.test(html));
  assert.ok(html.includes('family=Big+Shoulders+Display') && html.includes('family=Inter'));
  assert.ok(html.includes('--bg:#0A0A0A') && html.includes('--accent:#C6FF00') && html.includes('--accent-fill:#C6FF00'));
});
test('T542.9 no static overflow anti-patterns in the v3 layer', () => {
  assert.ok(!/overflow-x\s*:\s*scroll/.test(ds3), 'no forced horizontal scroll');
  assert.ok(!/(^|[;{\s])width\s*:\s*(4|5|6|7|8|9)\d\d px/.test(ds3.replace(/\s+/g, ' ')), 'no fixed widths >= 400px');
  assert.ok(!/100vw/.test(ds3), 'no 100vw (scrollbar overflow)');
  assert.ok(!/backdrop-filter/.test(ds3), 'no glass blur in the v3 layer');
});
test('T542.10 controls: 44px touch targets and named icon-only buttons', () => {
  assert.ok(/\.btn\{[^}]*min-height:var\(--tap\)/.test(ds3));
  assert.ok(/\.nb\{min-height:56px/.test(ds3));
  assert.ok(html.includes('aria-label="Opciones del ejercicio"'));
  assert.ok(html.includes('aria-label="Mostrar u ocultar contraseña"'));
  assert.ok(/id="liErr" role="alert"/.test(html), 'login errors are announced');
});
test('T542.11 rest timer keeps lifecycle hooks and uses tokenized state (no inline glow colors)', () => {
  const upd = html.slice(html.indexOf('function updateTimerDisplay()'), html.indexOf('function minimizeTimer()'));
  assert.ok(!/textShadow|rgba\(/.test(upd));
  assert.ok(/data-state/.test(upd));
  for (const fn of ['startRestTimer', 'stopRestTimer', 'minimizeTimer', 'maximizeTimer', 'resetRestTimer', 'adjustRestTimer']) assert.ok(new RegExp('function ' + fn + '\\(').test(html), fn);
  assert.ok(html.includes("localStorage.setItem('vdsen_restEnd'"));
});
test('T542.12 service worker: no new local asset is required by the redesign (icons/fonts are inline / already cached)', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(/CACHE = 'vdsen-v\d+'/.test(sw));
  const localImgs = (html.slice(bodyStart).match(/<img[^>]+src="(assets\/[^"]+)"/g) || []).map(m => m.match(/src="([^"]+)"/)[1]);
  for (const src of new Set(localImgs.filter(x => !x.startsWith('assets/exercises/')))) assert.ok(sw.includes('/' + src), 'precached: ' + src);
  assert.ok(sw.includes('/assets/vdsen-logo-official.jpg'));
});
test('T542.13 post-session check-in keeps its field ids and uses accessible radio semantics (no emoji, no inline state colors)', () => {
  const m = html.slice(html.indexOf('<div id="postSessionModal"'), html.indexOf('<!-- Overlay sustitución de ejercicio -->'));
  for (const id of ['psEimd', 'psArticular', 'psArticularPatternSel', 'psSueno', 'psRpe', 'psRpeVal', 'psRpeLabel', 'eimd1', 'eimd2', 'eimd3', 'artSiBtn', 'artNoBtn', 'psSuenoGrid']) assert.ok(m.includes('id="' + id + '"'), id);
  assert.ok(/role="dialog" aria-modal="true"/.test(m) && /role="radiogroup"/.test(m) && /aria-checked/.test(m));
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(m), 'no emoji in the check-in');
  assert.ok(!/style="[^"]*(color|background):/.test(m.replace(/style="display:none"/g, '')), 'selection state is class-based');
  for (const fn of ['selectEimd', 'psSuenoSel', 'psArticularSel', 'submitPostSession', 'closePostSessionModal']) assert.ok(new RegExp('function ' + fn + '\\(').test(html), fn);
});
test('T542.14 express RIR / pump selection is class-driven in every producer (single and superset)', () => {
  assert.ok(/function expressSetRIR\([\s\S]*classList\.toggle\('on'/.test(html));
  const producers = html.match(/onclick="expressSetRIR\(/g) || [];
  assert.ok(producers.length >= 2);
  const inlineRir = html.match(/id="xrir_'\+[^"]*"[^>]*style="/g) || [];
  assert.equal(inlineRir.length, 0, 'no RIR button keeps inline selection styles');
});
