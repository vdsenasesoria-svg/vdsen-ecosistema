'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const COACH = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');
const PHOTO_SECTION_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'coach-image-upload', 'photo-section.js'), 'utf8');

const paths = require('../assets/coach-image-upload/paths.js');
const controllerMod = require('../assets/coach-image-upload/controller.js');
const uiMod = require('../assets/coach-image-upload/photo-section.js');
const mountMod = require('../assets/coach-image-upload/mount.js');

function extractFn(src, sig) {
  const idx = src.indexOf(sig);
  assert.ok(idx !== -1, 'Missing signature: ' + sig);
  const open = src.indexOf('{', idx);
  let depth = 0, inSq = false, inDq = false, inTpl = false, esc = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && (inSq || inDq || inTpl)) { esc = true; continue; }
    if (ch === "'" && !inDq && !inTpl) inSq = !inSq;
    else if (ch === '"' && !inSq && !inTpl) inDq = !inDq;
    else if (ch === '`' && !inSq && !inDq) inTpl = !inTpl;
    else if (!inSq && !inDq) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return src.slice(idx, i + 1);
      }
    }
  }
  throw new Error('Unbalanced braces for ' + sig);
}

function makeFakeDom() {
  const byId = new Map();
  let htmlSnapshots = [];

  function parseAttrs(raw) {
    const attrs = {};
    const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
    let m;
    while ((m = re.exec(raw))) {
      attrs[m[1]] = m[2] !== undefined ? m[2] : '';
    }
    return attrs;
  }

  function makeEl(tag, attrs = {}) {
    const listeners = new Map();
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: attrs.id || '',
      attributes: attrs,
      style: { cssText: attrs.style || '', display: '' },
      children: [],
      parentNode: null,
      textContent: '',
      value: '',
      files: [],
      disabled: false,
      onclick: null,
      onchange: null,
      get firstChild() { return el.children[0] || null; },
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        if (child.id) byId.set(child.id, child);
        return child;
      },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      insertBefore(newNode, refNode) {
        newNode.parentNode = el;
        const i = el.children.indexOf(refNode);
        if (i >= 0) el.children.splice(i, 0, newNode);
        else el.children.push(newNode);
        if (newNode.id) byId.set(newNode.id, newNode);
        return newNode;
      },
      querySelector(sel) {
        if (sel.startsWith('#')) return byId.get(sel.slice(1)) || null;
        return null;
      },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k); },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        let stopped = false;
        const e = Object.assign({
          preventDefault() {},
          stopImmediatePropagation() { stopped = true; },
          stopPropagation() { stopped = true; },
        }, ev || {});
        for (const fn of listeners.get(e.type) || []) {
          fn(e);
          if (stopped) break;
        }
        if (!stopped && e.type === 'click' && typeof el.onclick === 'function') {
          el.onclick(e);
        }
        return !stopped;
      },
      click() {
        el.dispatchEvent({ type: 'click' });
      },
      set innerHTML(val) {
        const html = String(val || '');
        htmlSnapshots.push(html);
        el.children = [];
        const tagRe = /<(div|button|input|span)\b([^>]*)>(?:([^<]*)<\/\1>)?/gi;
        let m;
        while ((m = tagRe.exec(html))) {
          const parsed = parseAttrs(m[2]);
          const child = makeEl(m[1], parsed);
          if (m[3]) child.textContent = m[3];
          el.appendChild(child);
        }
      },
      get innerHTML() { return ''; },
    };
    if (el.id) byId.set(el.id, el);
    return el;
  }

  let seq = 0;
  const doc = {
    createElement: (tag) => makeEl(tag),
  };
  const env = {
    document: doc,
    URL: {
      createObjectURL: () => 'blob:fake-' + (++seq),
      revokeObjectURL: () => {},
    },
  };
  return { env, makeEl, byId, getHtmlSnapshots: () => htmlSnapshots };
}

test('photo-section exposes 44px mobile camera + gallery inputs, full-width flex card, and exact prepared identity', async () => {
  const { env, makeEl, byId, getHtmlSnapshots } = makeFakeDom();
  const rootMount = makeEl('div');
  const saveRow = makeEl('div');
  const saveBtn = makeEl('button', { id: 'planPhotoSaveBtn' });
  saveRow.appendChild(saveBtn);
  rootMount.appendChild(saveRow);

  const calls = { prepare: [], savePrepared: [], removeImage: [], states: [] };
  const fakeBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
  let preparedObj = null;

  const controllerApi = {
    async prepare(file, ctx) {
      calls.prepare.push({ file, ctx });
      preparedObj = {
        ok: true,
        blob: fakeBlob,
        type: 'image/jpeg',
        bytes: 42 * 1024,
        width: 1200,
        height: 900,
        quality: 0.85,
        attempts: 1,
        token: ctx.token,
        coachUid: ctx.coachUid,
        exerciseId: ctx.exerciseId,
      };
      return preparedObj;
    },
    async savePrepared(prep, input) {
      calls.savePrepared.push({ prep, input });
      return {
        ok: true,
        url: 'https://storage.example.invalid/exercise-media/coach1/exDoc1/image-0123456789abcdef',
        path: 'exercise-media/coach1/exDoc1/image-0123456789abcdef',
        replaced: false,
        cleanup: 'NOT_NEEDED',
      };
    },
    async removeImage(input) {
      calls.removeImage.push(input);
      return {
        ok: true,
        cleanup: 'DELETED',
        removedPath: input.currentPath || null,
      };
    },
  };

  let exDoc = { id: 'exDoc1', coachId: 'coach1', imageUrl: '', assetRef: '' };
  const section = uiMod.createPhotoSection({
    env,
    controllerApi,
    pathsApi: paths,
    getContext: () => ({ coachUid: 'coach1', coachId: 'coach1', exerciseId: 'exDoc1', exercise: exDoc }),
    generation: { token: () => '1:coach1:exDoc1' },
    onStateChange: (s) => calls.states.push(s),
  });

  const handle = section.attach(rootMount, saveBtn);
  const box = byId.get('vm-photo-section');
  assert.ok(box, '#vm-photo-section created');
  assert.match(box.style.cssText, /flex:\s*1 0 100%/);
  assert.match(box.style.cssText, /width:\s*100%/);

  const cameraBtn = byId.get('vm-photo-camera-btn');
  const cameraInput = byId.get('vm-photo-camera');
  const pickBtn = byId.get('vm-photo-pick');
  const galleryInput = byId.get('vm-photo-file');
  assert.ok(cameraBtn && cameraInput && pickBtn && galleryInput, 'Camera + gallery buttons and inputs exist');
  assert.equal(cameraBtn.textContent, 'Tomar foto');
  assert.match(cameraBtn.attributes.style, /min-height:\s*44px/);
  assert.equal(cameraInput.attributes.capture, 'environment');
  assert.equal(cameraInput.attributes.accept, 'image/jpeg,image/png,image/webp');
  assert.match(pickBtn.attributes.style, /min-height:\s*44px/);
  assert.equal(galleryInput.attributes.accept, 'image/jpeg,image/png,image/webp');
  assert.equal(galleryInput.hasAttribute('capture'), false, 'Gallery input must NOT force camera capture');

  // Trigger camera pick and verify exact prepared object reference reaches savePrepared
  let cameraInputClicked = false;
  const origClick = cameraInput.click;
  cameraInput.click = () => { cameraInputClicked = true; origClick(); };
  cameraBtn.click();
  assert.equal(cameraInputClicked, true, 'Camera button opens #vm-photo-camera');

  const rawCameraFile = { name: 'camera.jpg', type: 'image/jpeg', size: 120000 };
  cameraInput.files = [rawCameraFile];
  await cameraInput.onchange();

  assert.equal(handle.hasPendingChange(), true);
  assert.equal(cameraInput.value, '', 'Camera input resets after selection so re-pick works');
  assert.equal(byId.get('vm-photo-source').textContent, 'Foto nueva sin guardar');
  const previewChildren = byId.get('vm-photo-preview').children;
  assert.equal(previewChildren.length, 1);
  assert.equal(previewChildren[0].tagName, 'IMG');
  assert.match(previewChildren[0].src, /^blob:fake-/);

  const out = await handle.persist({});
  assert.equal(out.handled, true);
  assert.equal(out.ok, true);
  assert.equal(out.path, 'exercise-media/coach1/exDoc1/image-0123456789abcdef');
  assert.match(out.url, /^https:\/\/storage\.example\.invalid\//);
  assert.equal(calls.savePrepared.length, 1);
  assert.strictEqual(calls.savePrepared[0].prep, preparedObj, 'savePrepared receives exact prepared object');

  // Stage removal and verify return payload + controller contract
  exDoc = {
    id: 'exDoc1',
    coachId: 'coach1',
    imageUrl: out.url,
    assetRef: out.path,
  };
  byId.get('vm-photo-remove').click();
  assert.equal(handle.hasPendingChange(), true);
  assert.equal(byId.get('vm-photo-source').textContent, 'La foto se eliminará al guardar');
  const remOut = await handle.persist({});
  assert.equal(remOut.handled, true);
  assert.equal(remOut.ok, true);
  assert.equal(remOut.removed, true);
  assert.equal(remOut.removedPath, out.path);
  assert.equal(calls.removeImage.length, 1);
  assert.equal(calls.states.some(s => s.staged === true), true);
  assert.equal(calls.states.some(s => s.removeStaged === true), true);
  assert.ok(!/on\w+=|blob:fake-/.test(getHtmlSnapshots().join('\n')), 'No image URL ever enters innerHTML');
  assert.equal(/\.stack\b/.test(PHOTO_SECTION_SRC), false, 'photo-section.js never inspects .stack');
});

test('mount with empty buildMetadata preserves catalog metadata and writes only imageUrl + assetRef', async () => {
  const { env, makeEl, byId } = makeFakeDom();
  globalThis.VDSEN_COACH_IMAGE_UI = uiMod;
  const rootMount = makeEl('div');
  const row = makeEl('div');
  const saveBtn = makeEl('button', { id: 'planPhotoSaveBtn' });
  const statusEl = makeEl('span', { id: 'planPhotoStatus' });
  row.appendChild(saveBtn);
  row.appendChild(statusEl);
  rootMount.appendChild(row);

  const published = [];
  const uploaded = [];
  const jpegBytes = new Uint8Array(256);
  jpegBytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  jpegBytes[jpegBytes.length - 2] = 0xff;
  jpegBytes[jpegBytes.length - 1] = 0xd9;
  const validJpeg = new Blob([jpegBytes], { type: 'image/jpeg' });
  const controller = controllerMod.createController({
    process: async () => ({ ok: true, blob: validJpeg, type: 'image/jpeg', width: 900, height: 675, quality: 0.88, attempts: 1 }),
    upload: async (path, blob, type) => { uploaded.push({ path, bytes: blob.size, type }); },
    getDownloadUrl: async (path) => 'https://cdn.example.invalid/' + path,
    deleteObject: async () => {},
    publish: async (docId, patch) => { published.push({ docId, patch }); },
    isCurrent: (tok) => tok === '2:coachA:exCatalogDoc',
  });

  const ctx = {
    current: () => ({
      coachUid: 'coachA',
      coachId: 'coachA',
      exerciseId: 'exCatalogDoc',
      documentId: 'exCatalogDoc',
      exercise: { id: 'exCatalogDoc', coachId: 'coachA', equipment: 'Barra', instructions: 'Mantener escápula' },
    }),
    token: () => '2:coachA:exCatalogDoc',
  };

  let donePayload = null;
  let intercepted = 0;
  let resolveStaged = null;
  let resolveDone = null;
  const stagedReady = new Promise((r) => { resolveStaged = r; });
  const doneReady = new Promise((r) => { resolveDone = r; });
  const stateEvents = [];
  mountMod.mount({
    env,
    overlay: rootMount,
    saveBtn,
    statusEl,
    ctx,
    controller,
    paths,
    buildMetadata: () => ({}),
    read: () => { throw new Error('Should not read metadata inputs when buildMetadata is supplied'); },
    onStateChange: (s) => {
      stateEvents.push(s);
      if (s && s.staged) resolveStaged(s);
    },
    onIntercept: () => { intercepted++; },
    onDone: (out) => { donePayload = out; resolveDone(out); },
  });

  const cameraInput = byId.get('vm-photo-camera');
  cameraInput.files = [new Blob([jpegBytes], { type: 'image/jpeg' })];
  cameraInput.onchange();
  await stagedReady;

  saveBtn.dispatchEvent({ type: 'click' });
  await doneReady;

  assert.equal(stateEvents.some(s => s && s.staged === true), true);
  assert.equal(statusEl.textContent, '', 'Expected clean status, got: ' + statusEl.textContent);
  assert.equal(intercepted, 1);
  assert.equal(uploaded.length, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].docId, 'exCatalogDoc');
  assert.deepEqual(Object.keys(published[0].patch).sort(), ['assetRef', 'imageUrl']);
  assert.equal(paths.isManagedPathFor(published[0].patch.assetRef, 'coachA', 'exCatalogDoc'), true);
  assert.equal(donePayload && donePayload.ok, true);
  assert.equal(donePayload && donePayload.path, published[0].patch.assetRef);
});

test('VM: _resolvePlanExerciseCatalogMatch enforces coach ownership, ID/site precedence, and static collision override', () => {
  const fnNorm = extractFn(COACH, 'function _normalizeCoachExKey(value)');
  const fnGym = extractFn(COACH, 'function _coachGymMatches(entryGym, clientGym)');
  const fnResolve = extractFn(COACH, 'function _resolvePlanExerciseCatalogMatch(planExercise, allExercises, coachUid, clientGym, visualCatalog)');
  const ctx = { window: {} };
  vm.runInNewContext([fnNorm, fnGym, fnResolve].join('\n'), ctx);
  const resolveMatch = ctx._resolvePlanExerciseCatalogMatch;

  const catalog = [
    { id: 'otherCoachEx', coachId: 'coachB', name: 'Press Banca', gym: '' },
    { id: 'exById', coachId: 'coachA', exerciseId: 'ex-id-1', name: 'Remo Barra', gym: '' },
    { id: 'exGeneric', coachId: 'coachA', name: 'Press Banca', gym: '' },
    { id: 'exSite', coachId: 'coachA', name: 'Press Banca', gym: 'Smart Fit San Diego' },
    { id: 'exStaticGeneric', coachId: 'coachA', name: 'Jalon al Pecho', gym: '' },
    { id: 'exDup1', coachId: 'coachA', name: 'Sentadilla Libre', gym: '' },
    { id: 'exDup2', coachId: 'coachA', name: 'Sentadilla Libre', gym: '' },
  ];
  const visualCatalog = {
    gyms: {
      sanDiego: {
        gym: 'Smart Fit San Diego',
        aliases: ['San Diego'],
        entries: [{ name: 'Jalon al Pecho', imageStatus: 'pending_license' }],
      },
    },
  };

  // 1. Other coach exercises are ignored even if exact name
  const foreignOnly = resolveMatch({ exerciseName: 'Press Banca' }, [catalog[0]], 'coachA', '', visualCatalog);
  assert.equal(foreignOnly.match, null);
  assert.equal(foreignOnly.needsCreate, true);
  assert.equal(foreignOnly.source, 'missing');
  assert.deepEqual(JSON.parse(JSON.stringify(foreignOnly.createSpec)), { name: 'Press Banca', exerciseId: null, gym: '' });

  // 2. exerciseId priority
  const byId = resolveMatch({ exerciseId: 'ex-id-1', exerciseName: 'Nombre Viejo' }, catalog, 'coachA', 'San Diego', visualCatalog);
  assert.equal(byId.source, 'exerciseId');
  assert.equal(byId.match.id, 'exById');
  assert.equal(byId.needsCreate, false);

  // 3. Site-specific entry wins over generic for compatible gym alias ("San Diego" <-> "Smart Fit San Diego")
  const siteWin = resolveMatch({ exerciseName: 'Press Banca' }, catalog, 'coachA', 'San Diego', visualCatalog);
  assert.equal(siteWin.source, 'firestore_site');
  assert.equal(siteWin.match.id, 'exSite');

  // 4. Static visual catalog collision creates site override so client site_catalog doesn't shadow Coach photo
  const siteOverride = resolveMatch({ exerciseName: 'Jalon al Pecho' }, catalog, 'coachA', 'Smart Fit San Diego', visualCatalog);
  assert.equal(siteOverride.source, 'site_catalog_override');
  assert.equal(siteOverride.match, null);
  assert.equal(siteOverride.needsCreate, true);
  assert.equal(siteOverride.targetGym, 'Smart Fit San Diego');
  assert.equal(siteOverride.genericFallback.id, 'exStaticGeneric');

  // 5. Generic fallback when no site match and no static collision
  const genericHit = resolveMatch({ exerciseName: 'Press Banca' }, [catalog[2]], 'coachA', 'Bugambilias', visualCatalog);
  assert.equal(genericHit.source, 'firestore_coach');
  assert.equal(genericHit.match.id, 'exGeneric');

  // 6. Ambiguous duplicates flagged
  const ambig = resolveMatch({ exerciseName: 'Sentadilla Libre' }, catalog, 'coachA', '', visualCatalog);
  assert.equal(ambig.ambiguous, true);
  assert.equal(ambig.match.id, 'exDup1');

  // 7. Uncataloged exercise returns createSpec without touching plan
  const uncataloged = resolveMatch({ exerciseName: 'Curl Martillo' }, catalog, 'coachA', '', visualCatalog);
  assert.equal(uncataloged.source, 'missing');
  assert.equal(uncataloged.needsCreate, true);
  assert.deepEqual(JSON.parse(JSON.stringify(uncataloged.createSpec)), { name: 'Curl Martillo', exerciseId: null, gym: '' });
});

test('vdsen-coach.html preserves gate, visual-only scope, lifecycle cleanup, Escape ordering, and PR #259 menu contracts', () => {
  assert.match(COACH, /var COACH_IMAGE_UPLOAD_ENABLED = false;/, 'Production gate remains false until storage.rules release');
  assert.equal(/window\.__vdsen[A-Za-z]*\s*=/.test(COACH), false, 'DEBUG-01: no window.__vdsen* global');

  const openFn = extractFn(COACH, 'async function _openPlanExercisePhoto(dayIdx, exIdx)');
  assert.match(openFn, /match\.coachId !== uidAtStart/, 'Enforces Coach ownership check');
  assert.match(openFn, /buildMetadata:\s*function\s*\(\)\s*\{\s*return\s*\{\s*\};\s*\}/, 'Preserves catalog text fields on plan photo save');
  assert.match(openFn, /addDoc\(collection\(db,\s*'exercises'\)/, 'Uncataloged exercises auto-create only in exercises collection');
  assert.equal(/\b(plans|logs|clients)\b[\s\S]{0,60}(updateDoc|setDoc|addDoc)/.test(openFn), false, 'Never mutates plans, logs, or clients');

  const renderPlanFn = extractFn(COACH, 'function _renderClientTabPlan(cont)');
  assert.match(renderPlanFn, /vdsen-plan-ex-row/, 'Renders active-plan exercise rows');
  assert.match(renderPlanFn, /vdsen-ex-thumb/, 'Renders inline exercise thumbnail slot');
  assert.match(renderPlanFn, /vdsen-ex-photo-btn[\s\S]*window\._openPlanExercisePhoto/, 'Renders exercise photo button');
  assert.match(renderPlanFn, /_hydratePlanExercisePhotoThumbs\(cont\)/, 'Hydrates thumbnails immediately');
  assert.match(renderPlanFn, /_ensureSecondaryLoaded\('catalogo'\)/, 'Lazy-loads catalog metadata if not yet fetched');

  const parkFn = extractFn(COACH, 'function _parkCoachShell()');
  assert.match(parkFn, /_closePlanExercisePhoto\(\)/, 'Logout parks/closes plan exercise photo modal');
  assert.match(parkFn, /window\._vdsenMenu\.destroyHost\(\)/, 'PR #259 menu host cleanup preserved');

  const escIdx = COACH.indexOf("if (ev.key !== 'Escape') return;");
  const escBlock = COACH.slice(escIdx, escIdx + 800);
  const vdsenPos = escBlock.indexOf('window._vdsenMenu.isOpen()');
  const photoPos = escBlock.indexOf('planExercisePhotoModal');
  const clientPos = escBlock.indexOf('closeClientModal()');
  assert.ok(vdsenPos > -1 && photoPos > vdsenPos && clientPos > photoPos,
    'Escape closes _vdsenMenu, then #planExercisePhotoModal, before #clientModal inside 800 chars');
});
