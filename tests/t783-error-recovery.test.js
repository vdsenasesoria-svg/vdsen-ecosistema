'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT_HTML = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function extractFn(src, sig) {
  const start = src.indexOf(sig);
  assert.ok(start >= 0, 'Missing signature: ' + sig);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('Unclosed function: ' + sig);
}

test('T783-1: showPlanLoadError distinguishes permission-denied/unauthenticated and renders logout escape', () => {
  const fnSrc = extractFn(CLIENT_HTML, 'function showPlanLoadError(');
  const appended = [];
  const byId = new Map();
  function makeEl(id, html) {
    const listeners = {};
    const el = {
      id,
      innerHTML: html || '',
      textContent: '',
      disabled: false,
      style: {},
      setAttribute() {},
      remove() { byId.delete(id); },
      addEventListener(ev, fn) { listeners[ev] = fn; },
      _listeners: listeners
    };
    return el;
  }
  const box = {
    USER: { uid: 'u1' },
    navigator: { onLine: true },
    console: { warn() {} },
    showScreen() {},
    async doLogout() { box._loggedOut = true; },
    async loadPlan() {},
    document: {
      getElementById(id) {
        if (byId.has(id)) return byId.get(id);
        for (const w of appended) {
          if (w.innerHTML && w.innerHTML.includes('id="' + id + '"')) {
            const sub = makeEl(id);
            byId.set(id, sub);
            return sub;
          }
        }
        return null;
      },
      createElement() { return makeEl(''); },
      body: { appendChild(el) { byId.set(el.id, el); appended.push(el); } }
    }
  };
  vm.createContext(box);
  vm.runInContext(fnSrc, box);

  box.showPlanLoadError(box.USER, { code: 'permission-denied' });
  const permWrap = appended[appended.length - 1];
  assert.match(permWrap.innerHTML, /SIN PERMISOS DE ACCESO/);
  assert.match(permWrap.innerHTML, /id="pleRetry"/);
  assert.match(permWrap.innerHTML, /id="pleLogout"/);

  box.showPlanLoadError(box.USER, { code: 'unauthenticated' });
  const authWrap = appended[appended.length - 1];
  assert.match(authWrap.innerHTML, /SESIÓN INVÁLIDA/);
});

test('T783-2: loadPlan catch routes authenticated failures to showPlanLoadError instead of raw scrLogin', () => {
  assert.match(
    CLIENT_HTML,
    /catch\(e\)\s*\{[\s\S]{0,200}FB\.auth\.currentUser[\s\S]{0,120}showPlanLoadError\(user,\s*e\)/
  );
});

test('T783-3: doLogout resets _syncPending and _fbWriteOrQueue ignores late rejection after account switch', async () => {
  const queueSrc = extractFn(CLIENT_HTML, 'function _fbWriteOrQueue(');
  const failedSrc = extractFn(CLIENT_HTML, 'function _deferredWriteFailed(');
  const badgeSrc = extractFn(CLIENT_HTML, 'function _showSaveErrBadge(');
  const logoutSrc = extractFn(CLIENT_HTML, 'async function doLogout(');

  const toasts = [];
  const badges = [];
  const byId = {};
  const box = {
    USER: { uid: 'userA' },
    FB: { auth: {}, signOut: async () => {} },
    PLAN: {}, LOGS: {}, _SET_DRAFTS: {}, _sraPersisted: {}, _sraSaveGeneration: 0,
    _logsAuthorityUpdatedAt: 0, ACTIVE_PLAN_ID: 'p1', LOGS_BY_WEEK: {},
    DIA_ACTIVO: 0, EJ_ACTIVO: 0, _EJERCICIOS_DIA: [], _weeksExpanded: false,
    CALIB_VOLUMETRICA: null, _preSelState: {}, _postSessionDi: null,
    _saveLogsTimer: null, _ciAutoSaveTimer: null, window: {},
    EXERCISE_UNITS: {}, EXERCISE_HISTORY: {}, EXERCISE_CATALOG: {},
    EXERCISE_CATALOG_BY_ID: {}, EXERCISE_CATALOG_ENTRIES: [],
    PRESCRIPTION_EXERCISE_CATALOG_BY_ID: {}, AMBIGUOUS_PRESCRIPTION_EXERCISE_IDS: {},
    ACTIVE_GYM_ID: '', ACTIVE_GYM_NAME: '', CLIENT_ADVANCED: null,
    REAL_WEEK: 1, CURRENT_WEEK: 1, MENU_CUSTOM: {},
    _WRITE_GRACE_MS: 5000, _syncPending: 0, _authSessionGen: 0,
    navigator: { onLine: false },
    localStorage: { removeItem() {} },
    _clearLiveListeners() {}, _resetLogsConcurrencyState() {},
    _renderSyncBadge() { badges.push(box._syncPending); },
    showToast(m) { toasts.push(m); },
    _doSaveLogs() {},
    document: {
      getElementById(id) { return byId[id] || null; },
      createElement() { return { id: '', style: {}, addEventListener() {} }; },
      body: { appendChild(el) { byId[el.id] = el; } }
    },
    setTimeout, clearTimeout
  };
  vm.createContext(box);
  vm.runInContext([badgeSrc, failedSrc, queueSrc, logoutSrc].join('\n'), box);

  let rejA;
  const pA = new Promise((_, r) => { rejA = r; });
  const queued = await box._fbWriteOrQueue(pA);
  assert.equal(queued.state, 'queued');
  assert.equal(box._syncPending, 1);

  await box.doLogout();
  assert.equal(box._syncPending, 0);
  assert.equal(box._authSessionGen, 1);

  // User B signs in; A's deferred write rejects late -> must NOT toast or show badge to B
  box.USER = { uid: 'userB' };
  rejA(Object.assign(new Error('permission-denied'), { code: 'permission-denied' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(toasts.length, 0);
  assert.equal(byId.saveErrBadge, undefined);

  // Same user B deferred write fails -> MUST create and show #saveErrBadge
  let rejB;
  const pB = new Promise((_, r) => { rejB = r; });
  await box._fbWriteOrQueue(pB);
  rejB(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(toasts.length, 1);
  assert.ok(byId.saveErrBadge && byId.saveErrBadge.style.display === 'block');
});
