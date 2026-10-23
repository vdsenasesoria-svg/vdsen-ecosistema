// In-page audit of the Client set card on a phone viewport (local E2E only; inject after driver.js). Issue 115: the save button must sit in the flow of its card AFTER every field and never intersect
// load / reps / RIR / quality (ICS) / pump, the bottom navigation or the header, at any scroll position. Pure geometry (bounding boxes), not scrollWidth.
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const inter = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
  window.__auditCta = async function (di, ei) {
    window.selDia(di); await sleep(600); window.setEjActivo(ei); await sleep(700);
    const cur = document.querySelector('.workout-set-current'); if (!cur) return { error: 'no current set card' };
    const btn = cur.querySelector('.set-save-primary'); const sc = btn.closest('.tab-in') || document.getElementById('tabEntr');
    const navBtn = [...document.querySelectorAll('button')].find((b) => /nutrici/i.test(b.textContent) && b.offsetParent), nav = navBtn && navBtn.parentElement;   // the bottom navigation bar
    const hdr = document.querySelector('.hdr');
    const cs = getComputedStyle(btn.closest('.set-actions') || btn);
    const fields = [...cur.querySelectorAll('input,[id^=rir_btn],[id^=pump_],label,.rir-wrap,.sp-gl')].filter((e) => !btn.contains(e) && !e.contains(btn) && R(e).w > 2 && R(e).h > 2);
    const lastField = fields.reduce((m, e) => Math.max(m, R(e).b), 0);
    const out = { viewport: innerWidth + 'x' + innerHeight, position: cs.position, steps: [], navTop: nav ? Math.round(R(nav).t) : null };
    const max = sc.scrollHeight - sc.clientHeight, ys = [0, Math.round(max * 0.25), Math.round(max * 0.5), Math.round(max * 0.75), max];
    for (const y of ys) {
      sc.scrollTop = y; await sleep(250); document.getAnimations().forEach((an) => { try { an.finish(); } catch (e) { /* infinite animations cannot finish */ } });   // a background / hidden pane can leave the tab entrance animation half-way (a 5px translate): measure the settled layout
      const b = R(btn), hit = fields.filter((e) => inter(b, R(e))).map((e) => e.id || e.tagName), step = { y, btnTop: Math.round(b.t), btnBottom: Math.round(b.b), hitsFields: hit.length, hits: hit.slice(0, 4) };
      const sr = R(sc), vis = { l: Math.max(b.l, sr.l), r: Math.min(b.r, sr.r), t: Math.max(b.t, sr.t), b: Math.min(b.b, sr.b) };   // only the part inside the scroller is painted (the rest is clipped by it)
      step.coversNav = !!nav && vis.b > vis.t && inter(vis, R(nav)); step.coversHeader = !!hdr && vis.b > vis.t && inter(vis, R(hdr));
      step.btnBelowFields = b.t >= Math.max.apply(null, fields.map((e) => R(e).b)) - 1;   // the CTA is after every field in the layout
      out.steps.push(step);
    }
    out.ok = out.position === 'static' && out.steps.every((s) => s.hitsFields === 0 && !s.coversNav && !s.coversHeader && s.btnBelowFields);
    out.btnHeight = Math.round(R(btn).h); out.touchOk = R(btn).h >= 44; out.docOverflow = document.documentElement.scrollWidth > innerWidth;
    sc.scrollTop = 0; return out;
  };
})();
