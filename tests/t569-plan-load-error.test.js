'use strict';
// T569 — Client Training: a failed plan load must not strand the client on the loading screen.
//
// WHY THIS TEST EXISTS (found by reading the code, then confirmed in the DOM)
// `FB.onAuthStateChanged` showed the loading screen and then `await loadPlan(user)` with no
// try/catch, and `loadPlan` awaits `getDoc` for the plan without wrapping it either. There is no
// global unhandledrejection handler. The loading screen (`#scrLoading`) contains only a spinner
// and the text "CARGANDO TU PLAN" — no timeout, no error, no retry. So any failed read left the
// client permanently on the loading screen with no way out.
//
// This test proves the recovery path BEHAVES, by extracting and executing it against a DOM
// double, and pins the entry-point contract that nothing may bypass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CLIENT = fs.readFileSync('vdsen-cliente.html', 'utf8');

function extract(name) {
  const start = CLIENT.indexOf(name);
  assert.ok(start > -1, 'no se encontro ' + name);
  let i = CLIENT.indexOf('{', start), depth = 0;
  for (let j = i; j < CLIENT.length; j++) {
    if (CLIENT[j] === '{') depth++;
    else if (CLIENT[j] === '}') { depth--; if (depth === 0) return CLIENT.slice(start, j + 1); }
  }
  throw new Error('llaves desbalanceadas en ' + name);
}

const SRC = extract('function showPlanLoadError(');

test('T569-1 the auth entry point no longer lets a failed load escape', () => {
  // The catch must wrap the await, at the single point of entry. The gap tolerates an
  // explanatory comment between the branch and the try, and CRLF checkouts.
  assert.ok(/if \(user && user\.email\)[\s\S]{0,900}?try \{\s*\r?\n\s*await loadPlan\(user\);[\s\S]{0,400}?catch \(_loadErr\)/.test(CLIENT),
    'loadPlan debe estar dentro de try/catch en el entry point');
  assert.ok(/_loadErr[\s\S]{0,300}?showPlanLoadError\(user\)/.test(CLIENT), 'el catch debe ofrecer recuperacion');
});

test('T569-2 the error state is rendered as a real, accessible surface', () => {
  const dom = buildDom();
  run(SRC, dom, { online: true });
  const wrap = dom.byId('planLoadError');
  assert.ok(wrap, 'debe crearse el contenedor de error');
  assert.equal(wrap.className, 'screen on', 'usa el patron de pantalla existente');
  assert.equal(wrap.getAttribute('role'), 'alertdialog', 'es anunciado a lectores de pantalla');
  assert.equal(wrap.getAttribute('aria-labelledby'), 'pleTitle', 'tiene titulo asociado');
  assert.ok(/NO PUDIMOS CARGAR TU PLAN/.test(wrap.innerHTML), 'titulo claro cuando hay red');
});

test('T569-3 offline is reported honestly, without claiming the plan was lost', () => {
  const dom = buildDom();
  run(SRC, dom, { online: false });
  const html = dom.byId('planLoadError').innerHTML;
  assert.ok(/SIN CONEXIÓN/.test(html), 'dice SIN CONEXION');
  assert.ok(/ya está guardado/.test(html), 'tranquiliza: el plan sigue guardado');
  assert.ok(!/se perdió|perdido|borrado/i.test(html), 'no afirma perdida de datos');
});

test('T569-4 there is a real retry, and it calls loadPlan again', () => {
  const dom = buildDom();
  run(SRC, dom, { online: true });
  const btn = dom.byId('pleRetry');
  assert.ok(btn, 'debe existir el boton de reintento');
  // The label lives in the template the helper writes; this DOM double does not parse HTML.
  assert.ok(/id="pleRetry"[\s\S]{0,140}?>Reintentar</.test(SRC), 'la plantilla trae la etiqueta Reintentar');
  assert.ok(dom.listeners['pleRetry'] && dom.listeners['pleRetry'].click, 'el boton tiene handler');
  // and the handler must actually attempt the load again
  assert.ok(/await loadPlan\(u\)/.test(SRC), 'el reintento vuelve a cargar el plan');
});

test('T569-5 a failing retry re-renders the error instead of hanging', () => {
  const dom = buildDom();
  run(SRC, dom, { online: true, failRetry: true });
  return dom.listeners['pleRetry'].click().then(() => {
    assert.ok(dom.byId('planLoadError'), 'tras un reintento fallido sigue habiendo salida');
    assert.ok(dom.created.length >= 2, 'se volvio a construir el estado de error');
  });
});

test('T569-6 the retry button disables itself while retrying', () => {
  // Same in-flight lesson as T568: a second tap must not start a second load.
  const dom = buildDom();
  run(SRC, dom, { online: true, failRetry: true });
  const btn = dom.byId('pleRetry');
  const p = dom.listeners['pleRetry'].click();
  assert.equal(btn.disabled, true, 'se deshabilita durante el reintento');
  assert.ok(/REINTENTANDO/.test(btn.textContent), 'y lo comunica');
  return p;
});

test('T569-7 the recovery helper is exposed for the harnesses', () => {
  assert.ok(/window\.showPlanLoadError = showPlanLoadError;/.test(CLIENT), 'expuesto');
});

test('T569-8 the change does not alter plan data or the success path', () => {
  // UI-only: the error path must not write logs, touch the plan, or change onboarding routing.
  assert.ok(!/setDoc|updateDoc|LOGS\[|PLAN =/.test(SRC), 'el camino de error no escribe datos');
  assert.ok(/showScreen\('scrLoading'\)/.test(CLIENT), 'la pantalla de carga sigue existiendo para el camino bueno');
  for (const fn of ['renderPlanRoto', 'renderEspera', 'showScreen']) {
    assert.ok(CLIENT.includes(fn), 'no se rompio el ruteo existente: ' + fn);
  }
});

test('T569-9 NUMERIC_APPLY_ENABLED sigue en false', () => {
  for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false, m);
  }
});

// ── DOM double ───────────────────────────────────────────────────────────────────────────────

function buildDom() {
  const nodes = {};
  const listeners = {};
  const created = [];
  const mk = (id) => {
    const n = {
      id, className: '', innerHTML: '', textContent: '', disabled: false,
      style: { cssText: '' }, _attrs: {},
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      remove() { delete nodes[id]; },
      addEventListener(ev, fn) { (listeners[id] = listeners[id] || {})[ev] = fn; },
    };
    nodes[id] = n;
    return n;
  };
  const doc = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => { const n = mk('__tmp'); created.push(n); return n; },
    body: { appendChild: (n) => { n._appended = true; if (n.id) nodes[n.id] = n; } },
  };
  return {
    doc, listeners, created, byId: (id) => nodes[id] || null,
    // The helper looks up buttons it just wrote into innerHTML; model that by creating them.
    seed: (ids) => ids.forEach((i) => mk(i)),
  };
}

function run(src, dom, opts) {
  const sandbox = {
    document: dom.doc,
    console: { warn: () => {} },
    navigator: { onLine: opts.online !== false },
    USER: { uid: 'u1' },
    showScreen: () => {},
    loadPlan: async () => { if (opts.failRetry) throw new Error('still failing'); },
  };
  // innerHTML writes create the retry button in the real DOM; mirror that here.
  const origAppend = dom.doc.body.appendChild;
  dom.doc.body.appendChild = (n) => { origAppend(n); if (/pleRetry/.test(n.innerHTML)) dom.seed(['pleRetry']); };
  const factory = new Function('sandbox', `
    const document = sandbox.document, console = sandbox.console, navigator = sandbox.navigator;
    const USER = sandbox.USER, showScreen = sandbox.showScreen, loadPlan = sandbox.loadPlan;
    ${src}
    return { showPlanLoadError };
  `);
  return factory(sandbox).showPlanLoadError(sandbox.USER);
}
