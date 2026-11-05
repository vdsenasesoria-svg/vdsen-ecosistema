// In-page driver for the REAL Client UI (local E2E only). Every action is a real DOM interaction with the Client's own controls (inputs, RIR/pump buttons, "GUARDAR SERIE", "COMPLETAR", post-session modal).
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__sleep = sleep; window.__errs = window.__errs || [];
  window.addEventListener('error', (e) => window.__errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));
  const dbsClear = async () => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} try { const dbs = await indexedDB.databases(); await Promise.all(dbs.map((d) => new Promise((res) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => res(); }))); } catch (e) {} };
  // boot(who): fresh storage -> load the Client module -> real login with the synthetic credentials -> close the "novedades" modal
  window.__boot = async (who) => {
    await dbsClear();
    const src = document.getElementById('clientModuleSrc'); if (!src) throw new Error('no clientModuleSrc (reload the page first)');
    await import(URL.createObjectURL(new Blob([src.textContent], { type: 'text/javascript' }))); await sleep(2200);
    const c = await (await fetch('/__creds?who=' + who)).json();
    document.getElementById('liEmail').value = c.email; document.getElementById('liPass').value = c.password; await window.doLogin(); await sleep(4500);
    const m = document.getElementById('wnModal'); if (m) { const b = [...m.querySelectorAll('button')].find((x) => /ENTENDIDO/i.test(x.innerText)); b && b.click(); await sleep(400); }
    return { who, screen: [...document.querySelectorAll('[id^=scr]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id), errs: window.__errs.slice() };
  };
  const find = (re) => [...document.querySelectorAll('input')].find((i) => re.test(i.id));
  // logSet(di, ei, si, v): fills carga / reps / ICS, taps the RIR and pump buttons, taps "GUARDAR SERIE"
  window.__logSet = async (di, ei, si, v) => {
    window.setEjActivo(ei); await sleep(350);
    const ci = find(new RegExp('^carga_log_\\d+_' + di + '_' + ei + '_s' + si + '$')); if (!ci) throw new Error('no carga input d' + di + ' e' + ei + ' s' + si);
    const key = ci.id.replace('carga_', '');
    const set = (id, val) => { const el = document.getElementById(id); if (!el) throw new Error('missing ' + id); el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('carga_' + key, v.carga); set('reps_' + key, v.reps);
    if (v.rir !== undefined && v.rir !== null) { const rb = document.getElementById('rir_btn_' + key + '_' + v.rir); if (!rb) throw new Error('missing rir btn'); rb.click(); await sleep(120); }
    if (v.ics) set('ics_' + key, v.ics);
    if (v.pump) { const pb = document.getElementById('pump_' + key + '_' + v.pump); pb && pb.click(); await sleep(120); }
    const save = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('onclick') || '').startsWith("completeSet('" + key + "'")); if (!save) throw new Error('no save button ' + key);
    save.click(); await sleep(1100); return key;
  };
  // finish(di, post): "COMPLETAR" -> post-session modal (muscle soreness, joint pain, sleep, RPE) -> "GUARDAR Y CALCULAR PROGRESIÓN"
  window.__finish = async (di, post) => {
    post = Object.assign({ eimd: 1, articular: 'no', sleep: '8', rpe: '7' }, post || {});
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('onclick') || '').startsWith('markSessionDone(' + di + ')')); if (!b) throw new Error('no COMPLETAR button'); b.click(); await sleep(1300);
    window.selectEimd(post.eimd); await sleep(150); window.psArticularSel(post.articular); await sleep(150);
    const sb = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('onclick') || '') === "psSuenoSel(this,'" + post.sleep + "')"); sb && sb.click(); await sleep(150);
    const rpe = document.getElementById('psRpe'); if (rpe) { rpe.value = String(post.rpe); rpe.dispatchEvent(new Event('input', { bubbles: true })); rpe.dispatchEvent(new Event('change', { bubbles: true })); }
    if (post.durationMinutes !== undefined) document.getElementById('psDurationMin').value = String(post.durationMinutes);
    const go = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('onclick') || '') === 'submitPostSession()'); if (!go) throw new Error('no submit'); go.click(); await sleep(5500);
    const log = await (await fetch('/__trigger-log')).json(); return { triggerCalls: log.length, last: log[log.length - 1] && { status: log[log.length - 1].status, body: log[log.length - 1].body }, errs: window.__errs.slice() };
  };
  // session(di, specs, post): specs = [[ei, si, {carga,reps,rir,ics,pump}], ...]
  window.__session = async (di, specs, post) => { const keys = []; for (const [ei, si, v] of specs) keys.push(await window.__logSet(di, ei, si, v)); const fin = await window.__finish(di, post); return { logged: keys.length, fin }; };
  // what the athlete sees for an exercise card right now
  window.__card = (ei) => { window.setEjActivo(ei); return document.body.innerText.replace(/\s+/g, ' '); };
  window.__driverReady = true;
})();
