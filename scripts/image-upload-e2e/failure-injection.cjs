'use strict';
// VDSEN Image Upload v2 — failure injection F01-F12 + deterministic POST_COMMIT_UI_ISOLATION.
//
// WHY BARRIERS: lifecycle races must be proven at an EXACT pipeline point. The doubles pause at
//   uploadBytes:before       nothing committed yet (pre-commit interruption)
//   uploadBytes:after        Storage object committed, promise held
//   getDownloadURL:after     object + URL ready, publish not reached yet
//   updateDoc:after          Firestore committed, promise held = post-publish / pre-UI-settlement
// and the harness performs logout / coach switch WHILE the pipeline is paused, then releases it.
// No race is ever proven with sleep timing. See stubs/barriers.js.
//
// Asserts SURVIVING STATE, not toast text: Firestore, Storage inventory, DOM, active coach,
// busy state, preview, and network counters.
//
// Usage: node scripts/image-upload-e2e/failure-injection.cjs   (server + CDP browser must be up)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:8789';
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const COACH_A = 'coach.alfa@harness.invalid';
const COACH_B = 'coach.beta@harness.invalid';
const DOC = 'exA1';
const LOGICAL = 'logicalExercise999';
const DOC_PATH = 'exercises/' + DOC;

const results = [];
const rec = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log('  ' + (ok ? 'OK  ' : 'FALLA') + ' ' + String(id).padEnd(6) + ' ' + String(detail).slice(0, 160));
};

(async () => {
  const info = await (await fetch(CDP + '/json/version')).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  let id = 0; const pending = new Map(); let sessionId = null; const errs = []; const requests = [];
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; errs.push(String((d.exception && d.exception.description) || d.text).split('\n')[0].slice(0, 160)); }
    if (m.method === 'Network.requestWillBeSent') { requests.push(m.params.request.url); }
    if (m.id && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); }
  };
  const send = (method, params = {}) => {
    const i = ++id; const msg = { id: i, method, params }; if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 120000); });
  };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 300);
    return r.result.value;
  };
  const j = async (expr) => { const v = await ev(expr); try { return JSON.parse(v); } catch { return { __raw: v }; } };

  const ti = await send('Target.getTargets');
  const pg = ti.targetInfos.find((t) => t.type === 'page');
  const at = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  sessionId = at.sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');


  console.log('=== IMAGE UPLOAD FAILURE INJECTION + BARRIERS ===');

  // INVARIANTE DEL HARNESS — duplicate detection.
  // The harness must DETECT duplication, never silently "fix" it by deleting one overlay and
  // continuing. Normal states allow at most ONE live visual editor, ONE photo section, ONE
  // image mount. After a completed session transition the previous coach must leave 0.
  const census = async () => j(`JSON.stringify({
    editors: document.querySelectorAll('#visualMetadataEditor').length,
    sections: document.querySelectorAll('#vm-photo-section').length,
    mounts: (window.__VDSEN_IMG_MOUNT_COUNT__!=null ? window.__VDSEN_IMG_MOUNT_COUNT__ : (window.VDSEN_COACH_IMAGE_MOUNT&&window.VDSEN_COACH_IMAGE_MOUNT.activeCount!=null ? window.VDSEN_COACH_IMAGE_MOUNT.activeCount : -1)),
    login: !!document.getElementById('loginEmail'),
    catalog: !!document.getElementById('exerciseCatalog'),
    auth: window.__VDSEN_HARNESS_AUTH__ ? window.__VDSEN_HARNESS_AUTH__.current() : '?'
  })`);
  const requireSingleEditor = async (tag) => {
    const c = await census();
    const ok = c.editors <= 1 && c.sections <= 1;
    rec('INV-' + tag, ok, 'ACTIVE_VISUAL_EDITOR_COUNT=' + c.editors + ' ACTIVE_PHOTO_SECTION_COUNT=' + c.sections + ' MOUNTS=' + c.mounts);
    return c;
  };

  const load = async () => {
    errs.length = 0;
    await send('Page.navigate', { url: BASE + '/coach' });
    for (let i = 0; i < 40; i++) { await sleep(600); if ((await ev('document.readyState')) === 'complete') break; }
    await sleep(4000);
    await ev(`(function(){
      window.__TOASTS__ = [];
      var t = window.showToast;
      window.showToast = function(m, e){ window.__TOASTS__.push(String(m)); return t ? t(m, e) : undefined; };
      return 'ok';
    })()`);
  };
  const signIn = async (email) => {
    await ev("window.__VDSEN_HARNESS_AUTH__.signIn('" + email + "')");
    for (let i = 0; i < 40; i++) { await sleep(500); if ((await ev('!!document.getElementById("exerciseCatalog")')) === true && (await ev('!!document.getElementById("loginEmail")')) === false) break; }
    await sleep(600);
  };
  // Real product flow for a session change: logout first, then login (the same sequence the Coach
  // integration suites use). Logout parks the shell, which DESTROYS the photo mount, so the staged
  // photo UI cannot survive into the next session. A direct signIn(B) over a still-live A session
  // would SKIP the logout transition, so EVERY coach switch in this harness MUST route through here.
  // SESSION TRANSITIONS — two variants, never mixed:
  //   switchToClean(email):  release inherited barriers FIRST (the barrier must belong to the pipeline
  //                          being measured), then logout → wait login → login → REQUIRE barriers idle.
  //                          Used BETWEEN scenarios and for any clean-context hop (A->B setup, B->A setup).
  //   switchInFlight(email): logout → wait login → login, WITHOUT touching barriers: the pipeline is
  //                          deliberately paused and the barrier belongs to the HELD PIPELINE, not to the
  //                          login. Releasing here would unblock the settlement BEFORE the measurement.
  // A direct signIn(B) over a still-live A session is an invalid transition and is never used.
  const switchToClean = async (email) => {
    await releaseAll();
    await ev('window.__VDSEN_HARNESS_AUTH__.signOut()');
    await waitFor('!!document.getElementById("loginEmail")', 8000);
    await signIn(email);
    const idle = await waitFor('window.__HARNESS_BARRIERS__.waiting()===0', 5000);
    if (!idle) rec('BARRIER-HEREDADA', false, 'barrera heredada tras session switch limpio (waiting=' + (await waiting()) + ')');
  };
  const switchInFlight = async (email) => {
    await ev('window.__VDSEN_HARNESS_AUTH__.signOut()');
    await waitFor('!!document.getElementById("loginEmail")', 8000);
    await signIn(email);
  };
  const signedOut = async () => (await ev('!!document.getElementById("loginEmail")')) === true;

  // OBSERVABLE ISOLATION INVARIANTS. The harness never silently deletes a leftover overlay: it
  // counts the live pieces FIRST. A normal state has at most ONE of each. After a completed session
  // transition the previous coach's ACTIVE image pipeline (photo section + file mount) must be 0.
  // The editor overlay itself is parked/restored by the shell, so it is counted and reported, never
  // force-hidden.
  const counts = () => j(`JSON.stringify({
    editor: document.querySelectorAll('#visualMetadataEditor').length,
    section: document.querySelectorAll('#vm-photo-section').length,
    mount: document.querySelectorAll('#vm-photo-file').length
  })`);

  // Opens exactly the editor for THIS scenario. It does NOT delete any prior overlay: duplicate
  // detection belongs to reset()/teardown, and hiding a real leak here would defeat the whole test.
  // EXPLICIT PRE/POST GATE: measure FIRST and detect duplication (ACTIVE_EDITOR_COUNT>1). Scenarios
  // that require a clean start assert counts() BEFORE calling this; F09/F10/PC (isolation proof)
  // deliberately observe the real parked/restored overlay and must NOT pre-clean before measuring.
  const openEditor = async (ex) => {
    const pre = await counts();
    if (pre.editor > 1) rec('ACTIVE_EDITOR_DUPLICATES', false, 'overlays duplicados antes de abrir (editor=' + pre.editor + ')');
    await ev('window.openVisualMetadataEditor(' + JSON.stringify(ex || { id: DOC, exerciseId: LOGICAL, name: 'Sentinel' }) + ')');
    await sleep(800);
    const post = await counts();
    if (post.editor > 1) rec('ACTIVE_EDITOR_DUPLICATES', false, 'overlays duplicados tras abrir (editor=' + post.editor + ')');
    if (post.section > 1) rec('ACTIVE_PHOTO_SECTION_DUPLICATES', false, 'secciones de foto duplicadas (section=' + post.section + ')');
  };
  const stageImage = async (w, h) => {
    await ev(`(async function(){
      var c=document.createElement('canvas'); c.width=${w}; c.height=${h};
      var ctx=c.getContext('2d'); var im=ctx.createImageData(${w},${h});
      for(var i=0;i<im.data.length;i+=4){ im.data[i]=(i*7)&255; im.data[i+1]=(i*13)&255; im.data[i+2]=(i*29)&255; im.data[i+3]=255; }
      ctx.putImageData(im,0,0);
      var b=await new Promise(function(r){ c.toBlob(r,'image/jpeg',0.9); });
      var f=new File([b],'t.jpg',{type:'image/jpeg'});
      var inp=document.getElementById('vm-photo-file'); var dt=new DataTransfer(); dt.items.add(f); inp.files=dt.files;
      inp.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    for (let i = 0; i < 60; i++) { await sleep(400); if (/Foto lista/.test(String(await ev(`(document.getElementById('vm-photo-status')||{}).textContent||''`)))) return true; }
    return false;
  };
  const waitFor = async (expr, timeoutMs = 10000, every = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await ev(expr);
      if (v === true) return true;
      await sleep(every);
    }
    return false;
  };
  const waiting = async () => Number(await ev('(window.__HARNESS_BARRIERS__?window.__HARNESS_BARRIERS__.waiting():0)')) || 0;
  const arm = (op, phase) => ev("window.__HARNESS_BARRIERS__.arm('" + op + "','" + phase + "')");
  const release = (op) => ev("window.__HARNESS_BARRIERS__.release('" + op + "')");
  const releaseAll = () => ev('window.__HARNESS_BARRIERS__.releaseAll()');
  const clickSave = () => ev('document.getElementById("visualMetaSave").click()');
  const status = async () => String(await ev(`(document.getElementById('visualMetaStatus')||{}).textContent||''`));
  const photoStatus = async () => String(await ev(`(document.getElementById('vm-photo-status')||{}).textContent||''`));

  // Full surviving-state snapshot: Storage, Firestore, DOM, coach, busy, preview, toasts.
  // Includes OBSERVABLE ISOLATION COUNTS (editorCount / sectionCount / mountCount) so scenarios can
  // assert the image pipeline was destroyed and NO duplicate overlay was ever created.
  const snap = () => j(`JSON.stringify({
    objs: (window.__HARNESS_STORAGE__?window.__HARNESS_STORAGE__.list():[]),
    doc: (window.__HARNESS_FIRESTORE__?window.__HARNESS_FIRESTORE__.docs()['${DOC_PATH}']:null)||{},
    writes: (window.__HARNESS_FIRESTORE__?window.__HARNESS_FIRESTORE__.writes():[]).filter(function(w){return w.op!=='read';}),
    reads: (window.__HARNESS_FIRESTORE__?window.__HARNESS_FIRESTORE__.writes():[]).filter(function(w){return w.op==='read';}),
    editor: !!document.getElementById('visualMetadataEditor'),
    editorCount: document.querySelectorAll('#visualMetadataEditor').length,
    section: !!document.getElementById('vm-photo-section'),
    sectionCount: document.querySelectorAll('#vm-photo-section').length,
    mountCount: document.querySelectorAll('#vm-photo-file').length,
    saveDisabled: (!!document.getElementById('vm-photo-section')) ? !!(document.getElementById('visualMetaSave')||{}).disabled : false,
    auth: window.__VDSEN_HARNESS_AUTH__?window.__VDSEN_HARNESS_AUTH__.current():'?',
    login: !!document.getElementById('loginEmail'),
    toasts: window.__TOASTS__||[],
    status: (document.getElementById('visualMetaStatus')||{}).textContent||'',
    photo: (document.getElementById('vm-photo-status')||{}).textContent||'',
    photoSource: (document.getElementById('vm-photo-source')||{}).textContent||'',
    catalog: (document.getElementById('exerciseCatalog')||{innerHTML:''}).innerHTML
  })`);

  // Sanctioned BETWEEN-ROW teardown. Two responsibilities, in this order:
  //   1) guarantee the next row starts from a KNOWN-CLEAN image pipeline (editor=0 / section=0 / mount=0)
  //      by removing any overlay a PREVIOUS row parked (via the shell stash after a logout/switch);
  //   2) clear every in-memory double (Storage, Firestore doc+writes, toasts, barriers).
  // It deliberately does NOT reload the page: F01–F11 stay signed in as Coach A across rows (they
  // call reset() then openEditor() with no re-login), so a reload would drop currentCoach and the
  // photo section would never mount. Isolation is ALWAYS measured WITHIN each scenario (never hidden
  // here); this only removes leftovers BETWEEN rows, after that measurement has already been recorded.
  const reset = async (tag) => {
    // GATES EXPLICITOS DE FILA NORMAL (aprobado): medir ANTES de limpiar, afirmar el estado
    // esperado (<=1 de cada pieza), y DESPUES limpiar el teardown para iniciar la fila desde cero.
    // F09/F10/PC (isolation proof) NUNCA llaman reset() antes de medir: su aislamiento se observa
    // dentro del escenario; el teardown corre SOLO despues de registrar las assertions.
    const pre = await counts();
    if (pre.editor > 1) rec((tag || 'RESET') + '-DUP-EDITOR-PRE', false, 'overlays duplicados ANTES del teardown (editor=' + pre.editor + ')');
    if (pre.section > 1) rec((tag || 'RESET') + '-DUP-SECTION-PRE', false, 'secciones de foto duplicadas ANTES del teardown (section=' + pre.section + ')');
    if (pre.mount > 1) rec((tag || 'RESET') + '-DUP-MOUNT-PRE', false, 'mounts duplicados ANTES del teardown (mount=' + pre.mount + ')');
    // BUG 2: the barrier must belong to the pipeline being measured. Report (never hide) an
    // inherited pause BEFORE resetting, then release it, then REQUIRE idle after the reset.
    const preW = await waiting();
    if (preW !== 0) rec((tag || 'RESET') + '-BARRIER-PRE', false, 'barrera heredada ANTES del reset (waiting=' + preW + ')');
    await releaseAll();
    await ev(`(function(){
      document.querySelectorAll('#visualMetadataEditor').forEach(function(el){ el.remove(); });
      // The shell parks the WHOLE body into window._vdsenShellStash on logout and restores it on the
      // next login, so an editor overlay still open during a session transition is captured INSIDE
      // that stash. Clearing only the live DOM lets it reappear — and duplicate — on the next login
      // (symptom: overlays=2,3 -> getElementById hits an inert Save and cascades failures). Isolation
      // (photo section + file mount) is measured WITHIN each scenario BEFORE this teardown; here we
      // only guarantee every row starts from editor=0 in BOTH the live DOM and the parked stash.
      try {
        var _stash = window._vdsenShellStash;
        if (_stash && _stash.querySelectorAll) _stash.querySelectorAll('#visualMetadataEditor').forEach(function(el){ el.remove(); });
      } catch (e) {}
      window.__HARNESS_STORAGE__.reset();
      var F = window.__HARNESS_FIRESTORE__;
      if (F) { F.resetWrites(); F.failNextUpdateDoc = null; }
      if (window.__VDSEN_HARNESS_DB__) { window.__VDSEN_HARNESS_DB__.docs = {}; window.__VDSEN_HARNESS_DB__.writes = 0; }
      window.__TOASTS__ = [];
      if (window.__HARNESS_BARRIERS__) window.__HARNESS_BARRIERS__.reset();
      return 'ok';
    })()`);
    const postW = await waiting();
    if (postW !== 0) rec((tag || 'RESET') + '-BARRIER-POST', false, 'barrera NO liberada por el reset (waiting=' + postW + ')');
  };
  const closeEditor = async () => {
    await ev('if (document.getElementById("visualMetaClose")) document.getElementById("visualMetaClose").click()');
    await sleep(500);
  };


  // ------------------------------------------------------------------ setup
  await load();
  await signIn(COACH_A);
  rec('I00', (await ev('!!document.getElementById("exerciseCatalog")')) === true, 'Coach A login + catalogo');

  // ================================================================ F01 — upload failure
  console.log('--- F01 upload failure ---');
  await reset();
  await openEditor();
  rec('F01s0', await stageImage(1400, 1000), 'imagen staged');
  await ev("window.__HARNESS_STORAGE__.failNext = { op: 'upload' }");
  await clickSave();
  const f01wait = await waitFor('String((document.getElementById("visualMetaStatus")||{}).textContent||"").indexOf("No se pudo subir")>=0', 8000);
  const f01 = await snap();
  rec('F01a', f01wait, 'mensaje de error de subida mostrado: "' + f01.status.slice(0, 60) + '"');
  rec('F01b', f01.objs.length === 0, 'Storage intacto tras fallo de upload (' + f01.objs.length + ' objetos)');
  rec('F01c', f01.writes.filter(w => w.path === DOC_PATH).length === 0, 'Firestore NO escrito en el ejercicio');
  rec('F01d', f01.editor === true && f01.saveDisabled === false, 'editor abierto y busy liberado');
  rec('F01e', f01.toasts.length === 0, 'sin toast de exito: ' + JSON.stringify(f01.toasts));
  await closeEditor();

  // ================================================================ F02 — getDownloadURL failure
  console.log('--- F02 URL failure ---');
  await reset();
  await openEditor();
  rec('F02s0', await stageImage(1400, 1000), 'imagen staged');
  await ev("window.__HARNESS_STORAGE__.failNext = { op: 'url' }");
  await clickSave();
  const f02wait = await waitFor('String((document.getElementById("visualMetaStatus")||{}).textContent||"").indexOf("No se pudo obtener el enlace")>=0', 8000);
  const f02 = await snap();
  rec('F02a', f02wait, 'mensaje de fallo de URL mostrado');
  rec('F02b', f02.objs.length === 0, 'objeto NUEVO limpio tras fallo de URL (' + f02.objs.length + ')');
  rec('F02c', f02.writes.filter(w => w.path === DOC_PATH).length === 0, 'Firestore NO escrito');
  rec('F02d', f02.editor === true && f02.saveDisabled === false, 'editor abierto y busy liberado');
  await closeEditor();

  // ================================================================ F11 — double click (single flight)
  console.log('--- F11 double click ---');
  await reset();
  await openEditor();
  rec('F11s0', await stageImage(1400, 1000), 'imagen staged');
  await arm('uploadBytes', 'before');
  await clickSave();
  await waitFor('window.__HARNESS_BARRIERS__.waiting()===1', 5000);
  await clickSave();   // second click while the first is paused mid-upload
  await sleep(600);
  await release('uploadBytes');
  await waitFor('!document.getElementById("visualMetadataEditor") && !(document.getElementById("visualMetaSave")||{}).disabled', 8000);
  const f11 = await snap();
  rec('F11a', f11.objs.length === 1, 'exactamente 1 objeto tras doble click (' + f11.objs.length + ')');
  const f11pub = f11.writes.filter(w => w.path === DOC_PATH && w.op === 'update').length;
  rec('F11b', f11pub === 1, 'exactamente 1 publicacion Firestore (' + f11pub + ')');
  rec('F11c', f11.objs[0] ? /^exercise-media\/coachA000000000000000001\/exA1\/image-[a-f0-9]{16}$/.test(f11.objs[0].path) : false, 'ruta DOCUMENT-id: ' + (f11.objs[0] ? f11.objs[0].path : 'ninguna'));
  rec('F11d', f11.editor === false && f11.saveDisabled === false, 'una sola operacion: editor cerrado, busy liberado');
  await closeEditor();

  // ================================================================ F03/F04 — replacement failures with OLD present
  console.log('--- seed OLD + F03 publish failure + F04 old-delete failure ---');
  await reset();
  await openEditor();
  rec('SEEDs0', await stageImage(1500, 1100), 'imagen staged para OLD');
  await clickSave();
  await waitFor('!document.getElementById("visualMetadataEditor")', 8000);
  const seeded = await snap();
  const oldPath = seeded.objs[0] ? seeded.objs[0].path : null;
  rec('SEED', seeded.objs.length === 1 && !!oldPath, 'OLD creado: ' + (oldPath || 'NINGUNO'));

  // F03: publish fails during replacement -> OLD survives in Storage AND in Firestore, NEW cleaned.
  await openEditor({ id: DOC, exerciseId: LOGICAL, name: 'Sentinel', assetRef: oldPath, imageUrl: 'https://example.invalid/prev.jpg' });
  rec('F03s0', await stageImage(1500, 1100), 'imagen staged para reemplazo');
  await ev("window.__HARNESS_FIRESTORE__.failNextUpdateDoc = 'permission-denied'");
  await clickSave();
  const f03wait = await waitFor('String((document.getElementById("visualMetaStatus")||{}).textContent||"").indexOf("No se pudo guardar la imagen")>=0', 8000);
  const f03 = await snap();
  rec('F03a', f03wait, 'mensaje de fallo de publicacion mostrado');
  rec('F03b', f03.objs.length === 1 && f03.objs[0].path === oldPath, 'OLD sigue en Storage y NUEVO limpio (' + f03.objs.map(o => o.path.split('/')[3]).join(',') + ')');
  rec('F03c', (f03.doc.assetRef || '') === oldPath, 'Firestore sigue apuntando a OLD (' + (f03.doc.assetRef || 'vacio') + ')');
  rec('F03d', f03.editor === true && f03.saveDisabled === false, 'editor abierto y busy liberado');
  await closeEditor();

  // F04: old-delete fails during replacement -> operation SUCCEEDS, NEW committed, OLD = cleanup debt.
  await openEditor({ id: DOC, exerciseId: LOGICAL, name: 'Sentinel', assetRef: oldPath, imageUrl: 'https://example.invalid/prev.jpg' });
  rec('F04s0', await stageImage(1500, 1100), 'imagen staged para reemplazo');
  await ev("window.__HARNESS_STORAGE__.failNext = { op: 'delete' }");
  await clickSave();
  await waitFor('window.__TOASTS__.length>0', 8000);
  const f04 = await snap();
  const newPath = f04.objs.find(o => o.path !== oldPath);
  rec('F04a', f04.objs.length === 2 && !!newPath, 'NUEVO committeado y OLD como deuda de limpieza (' + f04.objs.length + ' objetos)');
  rec('F04b', (f04.doc.assetRef || '') === (newPath ? newPath.path : ''), 'Firestore apunta a NUEVO');
  rec('F04c', f04.toasts.length >= 1 && /actualizada/i.test(f04.toasts.join(' ')), 'operacion reportada EXITO: ' + JSON.stringify(f04.toasts));
  rec('F04d', f04.editor === false, 'editor cerrado');
  rec('F04e', (f04.doc.imageUrl || '').startsWith('https://'), 'imageUrl HTTPS preservada');
  await closeEditor();

  // ================================================================ F05 — stale after prepare (session changed before save)
  console.log('--- F05 stale after prepare ---');
  await reset();
  await signIn(COACH_A);
  await openEditor();
  rec('F05s0', await stageImage(1400, 1000), 'imagen staged (prepare completado)');
  const f05pre = await snap();
  await switchToClean(COACH_B);   // real flow: logout parks the shell (photo mount destroyed) + login as B
  await sleep(800);
  const f05 = await snap();
  rec('F05a', f05.objs.length === 0 && f05pre.objs.length === 0, 'cero objetos tras cambiar de sesion con imagen staged');
  rec('F05b', (f05.doc.assetRef || '') === '' , 'Firestore sin publicacion (' + (f05.doc.assetRef || 'vacio') + ')');
  // The photo section and its staged preview are owned by the image feature and MUST be gone.
  // The editor overlay itself is parked/restored by the shell by design (the real UI cannot reach
  // logout while the full-screen overlay is open), so it is not part of this contract.
  rec('F05c', f05.section === false, 'seccion de foto (staged) destruida en la sesion de B');
  rec('F05d', f05.toasts.length === 0, 'cero toasts tras el cambio: ' + JSON.stringify(f05.toasts));
  rec('F05e', f05.auth === 'coachB000000000000000002', 'sesion activa = Coach B');

  // ================================================================ F06 — stale AFTER upload committed (barrier)
  console.log('--- F06 stale after upload ---');
  await reset();
  await switchToClean(COACH_A);   // real transition: F05 left the session on Coach B
  await openEditor();
  rec('F06s0', await stageImage(1400, 1000), 'imagen staged');
  await arm('uploadBytes', 'after');
  await clickSave();
  const f06paused = await waitFor('window.__HARNESS_BARRIERS__.waiting()===1', 6000);
  const f06mid = await snap();
  rec('F06a', f06paused && f06mid.objs.length === 1 && f06mid.saveDisabled === true, 'pausa POST-upload: objeto committeado, save en vuelo');
  await switchInFlight(COACH_B);   // pipeline pausado: NO tocar barreras antes de medir
  await sleep(800);
  await release('uploadBytes');
  await sleep(1800);
  const f06 = await snap();
  rec('F06b', f06.objs.length === 0, 'objeto NUEVO limpiado tras stale (' + f06.objs.length + ')');
  rec('F06c', (f06.doc.assetRef || '') === '', 'Firestore sin publicacion');
  rec('F06d', f06.toasts.length === 0 && f06.sectionCount === 0 && f06.mountCount === 0 && f06.editorCount <= 1, 'cero toasts tardios, pipeline de foto de A destruido (sec=' + f06.sectionCount + ' mount=' + f06.mountCount + ' overlays=' + f06.editorCount + ')');
  rec('F06e', f06.saveDisabled === false, 'sin busy atascado');

  // ================================================================ F07 — stale AFTER URL (barrier)
  console.log('--- F07 stale after URL ---');
  await reset();
  await switchToClean(COACH_A);   // real transition: F06 left the session on Coach B
  await openEditor();
  rec('F07s0', await stageImage(1400, 1000), 'imagen staged');
  await arm('getDownloadURL', 'after');
  await clickSave();
  const f07paused = await waitFor('window.__HARNESS_BARRIERS__.waiting()===1', 6000);
  const f07mid = await snap();
  rec('F07a', f07paused && f07mid.objs.length === 1, 'pausa POST-URL: objeto y URL listos, publish no alcanzado');
  await switchInFlight(COACH_B);
  await sleep(800);
  await release('getDownloadURL');
  await sleep(1800);
  const f07 = await snap();
  rec('F07b', f07.objs.length === 0, 'objeto NUEMO limpiado tras stale (' + f07.objs.length + ')');
  rec('F07c', (f07.doc.assetRef || '') === '', 'Firestore sin publicacion');
  rec('F07d', f07.toasts.length === 0 && f07.sectionCount === 0 && f07.mountCount === 0 && f07.editorCount <= 1, 'cero toasts tardios, pipeline de foto de A destruido (sec=' + f07.sectionCount + ' mount=' + f07.mountCount + ' overlays=' + f07.editorCount + ')');
  rec('F07e', f07.saveDisabled === false, 'sin busy atascado');

  // ================================================================ F08 — old prepared generation cannot publish
  console.log('--- F08 old prepared generation ---');
  await reset();
  await switchToClean(COACH_A);   // real transition: F07 left the session on Coach B
  await openEditor();
  rec('F08s0', await stageImage(1400, 1000), 'imagen staged en generacion 1');
  await closeEditor();   // _visualSeq++ invalidates the prepared generation
  await openEditor();
  const f08open = await snap();
  rec('F08a', f08open.section === true && /Sin foto/.test(f08open.photoSource || ''), 'al reabrir: generacion nueva, staged antiguo descartado ("' + (f08open.photoSource || '').slice(0, 40) + '")');
  await ev(`(function(){
    window.__H = { original: 0 };
    var b = document.getElementById('visualMetaSave');
    var orig = b.onclick;
    b.onclick = function(ev){ window.__H.original++; return orig ? orig.call(this, ev) : undefined; };
  })()`);
  await clickSave();
  await waitFor('!document.getElementById("visualMetadataEditor")', 8000);
  const f08 = await snap();
  rec('F08b', f08.objs.length === 0, 'la generacion vieja NO publico objeto (' + f08.objs.length + ')');
  rec('F08c', (await ev('window.__H.original')) === 1, 'Save de metadata normal (handler original = ' + (await ev('window.__H.original')) + ')');
  await closeEditor();

  // ================================================================ F09 — logout in flight (BOTH phases)
  console.log('--- F09 logout in flight (pre-commit) ---');
  await reset();
  await switchToClean(COACH_A);   // real transition: F08 left its editor shut but the session dirty
  await openEditor();
  rec('F09as0', await stageImage(1400, 1000), 'imagen staged');
  await arm('uploadBytes', 'before');
  await clickSave();
  const f09aPaused = await waitFor('window.__HARNESS_BARRIERS__.waiting()===1', 6000);
  const f09aMid = await snap();
  rec('F09a0', f09aPaused && f09aMid.objs.length === 0 && f09aMid.saveDisabled === true, 'pausa PRE-commit: nada committeado, save en vuelo');
  await ev('window.__VDSEN_HARNESS_AUTH__.signOut()');
  await waitFor('!!document.getElementById("loginEmail")', 8000);
  await release('uploadBytes');
  await sleep(2000);
  const f09a = await snap();
  rec('F09a1', f09a.login === true && f09a.auth === null, 'sesion cerrada se mantiene (auth=' + JSON.stringify(f09a.auth) + ')');
  rec('F09a2', f09a.objs.length === 0, 'sin objeto sobreviviente tras logout pre-commit (' + f09a.objs.length + ')');
  rec('F09a3', (f09a.doc.assetRef || '') === '', 'Firestore sin publicacion');
  rec('F09a4', f09a.toasts.length === 0 && f09a.editor === false, 'cero toasts tardios, sin editor');
  rec('F09a5', f09a.saveDisabled === false, 'sin busy atascado');

  console.log('--- F09 logout in flight (post-commit, pre-UI settlement) ---');
  await reset();
  await switchToClean(COACH_A);   // real transition: F09a left the session logged out
  await openEditor();
  rec('F09bs0', await stageImage(1400, 1000), 'imagen staged');
  await arm('updateDoc', 'after');
  await clickSave();
  const f09bPaused = await waitFor('window.__HARNESS_BARRIERS__.waiting()===1', 8000);
  const f09bMid = await snap();
  rec('F09b0', f09bPaused && !!f09bMid.doc.assetRef && f09bMid.objs.length === 1, 'pausa POST-commit: Firestore y Storage committeados, settlement en pausa');
  await ev('window.__VDSEN_HARNESS_AUTH__.signOut()');
  await waitFor('!!document.getElementById("loginEmail")', 8000);
  await sleep(400);
  const f09bPre = await snap();
  await release('updateDoc');
  await sleep(2000);
  const f09b = await snap();
  rec('F09b1', (f09b.doc.assetRef || '') !== '' && (f09b.doc.assetRef === f09bMid.doc.assetRef), 'Firestore committeado SOBREVIVE al logout');
  rec('F09b2', f09b.objs.length === 1 && f09b.objs[0].path === f09bMid.objs[0].path, 'objeto NUEVO sobrevive al logout');
  rec('F09b3', f09b.toasts.length - f09bPre.toasts.length === 0, 'late toast = ' + (f09b.toasts.length - f09bPre.toasts.length));
  const f09bReads = f09b.reads.length - f09bPre.reads.length;
  rec('F09b4', f09bReads === 0, 'stale onDone / catalog reload = ' + f09bReads);
  rec('F09b5', f09b.login === true && f09b.editor === false, 'pantalla de login sin restos del editor de A');

  // ================================================================ F10 — coach switch in flight (BOTH phases)
  console.log('--- F10 coach switch in flight (pre-commit) ---');
  await reset();
  await switchToClean(COACH_A);   // real transition: F09b left the session logged out
  await openEditor();
  rec('F10as0', await stageImage(1400, 1000), 'imagen staged');
  await arm('uploadBytes', 'before');
  await clickSave();
  const f10aPaused = await waitFor('window.__HARNESS_BARRIERS__.waiting()===1', 6000);
  rec('F10a0', f10aPaused, 'pausa PRE-commit');
  await switchInFlight(COACH_B);
  await sleep(500);
  await release('uploadBytes');
  await sleep(2000);
  const f10a = await snap();
  rec('F10a1', f10a.auth === 'coachB000000000000000002', 'Coach B activo');
  rec('F10a2', f10a.objs.length === 0 && (f10a.doc.assetRef || '') === '', 'sin commit pre-commit tras el cambio');
  rec('F10a3', f10a.toasts.length === 0 && f10a.sectionCount === 0 && f10a.mountCount === 0 && f10a.editorCount <= 1, 'cero toasts, pipeline de foto de A destruido (sec=' + f10a.sectionCount + ' mount=' + f10a.mountCount + ' overlays=' + f10a.editorCount + ')');
  rec('F10a4', f10a.saveDisabled === false, 'sin busy atascado');

  // --------------------------------- F10b / PC01-PC06 — POST_COMMIT_UI_ISOLATION (deterministic)
  console.log('--- F10b/PC post-commit UI isolation (barrier: updateDoc after) ---');
  await reset();
  await switchToClean(COACH_A);   // real transition: F10a left the session on Coach B
  await openEditor();
  rec('PCs0', await stageImage(1400, 1000), 'imagen staged');
  await arm('updateDoc', 'after');
  await clickSave();
  const pcPaused = await waitFor('window.__HARNESS_BARRIERS__.waiting()===1', 8000);
  const pcMid = await snap();
  rec('PC00', pcPaused && !!pcMid.doc.assetRef && pcMid.objs.length === 1 && pcMid.editor === true,
    'pausa POST-commit / PRE-settlement: Firestore=' + (pcMid.doc.assetRef ? 'commit' : 'FALTA') + ' Storage=' + pcMid.objs.length + ' objetos');

  await switchInFlight(COACH_B);   // real logout+login WHILE the settlement is paused (no pre-clean)
  await sleep(1200);
  const pcB1 = await snap();   // Coach B fully rendered, settlement still paused
  rec('PC01', pcB1.auth === 'coachB000000000000000002' && pcB1.sectionCount === 0 && pcB1.mountCount === 0 && pcB1.editorCount <= 1,
    'Coach B renderizado con el settlement aun pausado, pipeline de foto de A destruido (sec=' + pcB1.sectionCount + ' mount=' + pcB1.mountCount + ' overlays=' + pcB1.editorCount + ')');

  await release('updateDoc');
  await sleep(2500);
  const pcB2 = await snap();   // after releasing the late settlement

  // 1) committed Firestore state survives
  rec('PC02', (pcB2.doc.assetRef || '') !== '' && pcB2.doc.assetRef === pcMid.doc.assetRef,
    'POST_COMMIT_UI_ISOLATION: Firestore committeado sobrevive (' + (pcB2.doc.assetRef || 'vacio') + ')');
  // 2) NEW object survives
  rec('PC03', pcB2.objs.length === 1 && pcB2.objs[0].path === pcMid.objs[0].path,
    'objeto NUEVO sobrevive, sin rollback (' + pcB2.objs.length + ' objetos)');
  // 3) late toast = 0
  const lateToasts = pcB2.toasts.length - pcB1.toasts.length;
  rec('PC04', lateToasts === 0, 'late toast = ' + lateToasts + ' (esperado 0)');
  // 4+5) stale onDone = 0 and stale catalog reload = 0 (measured as zero reads after release)
  const lateReads = pcB2.reads.length - pcB1.reads.length;
  rec('PC05', lateReads === 0, 'stale onDone / catalog reload = ' + lateReads + ' (esperado 0)');
  // 6) A's image pipeline must not mutate Coach B after settlement. The shell intentionally parks
  // the metadata overlay across session changes, so its presence is not evidence of a stale update;
  // assert the image-owned nodes and their counts instead of comparing unrelated catalog HTML.
  rec('PC06', pcB2.editorCount === pcB1.editorCount && pcB2.sectionCount === 0 && pcB2.mountCount === 0,
    'settlement tardio no agrega UI de foto a Coach B (editor ' + pcB1.editorCount + '→' + pcB2.editorCount + ', seccion=' + pcB2.sectionCount + ', mount=' + pcB2.mountCount + ')');
  rec('PC07', pcB2.toasts.filter(t => /actualizada/i.test(t)).length <= 1, 'el exito solo se informa en su propia sesion: ' + JSON.stringify(pcB2.toasts));

  // ================================================================ F12 — Storage unavailable (fresh page, cold adapter cache)
  console.log('--- F12 storage unavailable ---');
  // The factory is memoized by the product. Reload before replacing it so this scenario exercises
  // the documented cold-start failure path rather than a previously cached working adapter.
  await load();
  await signIn(COACH_A);
  await reset('F12');
  await ev(`(function(){
    if (!window.VDSEN_IMG_ADAPTER) return 'sin adapter';
    window.__ORIG_CREATE_ADAPTER__ = window.VDSEN_IMG_ADAPTER.createAdapter;
    window.VDSEN_IMG_ADAPTER.createAdapter = function(){ throw new Error('storage-unavailable'); };
    return 'instalado';
  })()`);
  await openEditor();
  const f12open = await snap();
  const f12msg = String(await ev(`(document.getElementById('visualMetaStatus')||{}).textContent||''`));
  rec('F12a', /No se pudo iniciar el almacenamiento/.test(f12msg), 'mensaje de Storage no disponible: "' + f12msg + '"');
  rec('F12b', f12open.section === false && f12open.editor === true, 'editor ABRE igual, seccion de foto ausente');
  // The metadata fields must remain fully usable through the ORIGINAL save path.
  await ev(`(function(){
    // vm-gym is a select, so use a real canonical option; assigning an unknown string makes the
    // browser clear its value and would test an invalid form state instead of metadata persistence.
    var e = document.getElementById('vm-gym'); if (e) { e.value = 'Smart Fit San Diego'; e.dispatchEvent(new Event('input',{bubbles:true})); }
    window.__H = { original: 0 };
    var b = document.getElementById('visualMetaSave'); var orig = b.onclick;
    b.onclick = function(ev){ window.__H.original++; return orig ? orig.call(this, ev) : undefined; };
  })()`);
  await clickSave();
  const f12saved = await waitFor('!document.getElementById("visualMetadataEditor")', 8000);
  const f12 = await snap();
  rec('F12c', f12saved && (await ev('window.__H.original')) === 1, 'metadata se guarda por el camino original sin Storage');
  rec('F12d', f12.objs.length === 0 && (f12.doc.gym || '') === 'Smart Fit San Diego', 'Firestore de metadata escrito, cero objetos: ' + (f12.doc.gym || ''));
  await ev('if (window.__ORIG_CREATE_ADAPTER__) { window.VDSEN_IMG_ADAPTER.createAdapter = window.__ORIG_CREATE_ADAPTER__; delete window.__ORIG_CREATE_ADAPTER__; }');

  // ================================================================ network + product exceptions audit
  console.log('--- auditoria de red ---');
  const prod = requests.filter(u => /vdsen-ecosistema|firebaseio|googleapis\.com\/v1\/projects\/vdsen-ecosistema|storage\.googleapis/.test(u) && !/127\.0\.0\.1|localhost/.test(u));
  rec('NET1', prod.length === 0, 'contacto con red de produccion = ' + prod.length);
  rec('NET2', errs.length === 0, 'excepciones de producto = ' + errs.length + (errs.length ? '  ' + errs[0] : ''));

  console.log('');
  const bad = results.filter(r => !r.ok);
  console.log('  ' + (results.length - bad.length) + '/' + results.length + ' filas OK  [failure-injection]');
  console.log('  FAILURE_INJECTION=' + (bad.length ? 'FAIL' : 'PASS'));
  if (bad.length) bad.forEach(b => console.log('    falla ' + b.id + ': ' + String(b.detail).slice(0, 140)));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('  FATAL ' + (e && e.stack || e)); process.exit(2); });
