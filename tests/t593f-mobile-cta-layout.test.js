'use strict';
// T593-FINAL / Issue 115: on a phone the save button of a set (and of every performance card) must live in the normal flow of its card, after all fields. It used to be
// position:sticky to the bottom of the scroller, so in a card taller than the screen it floated over load / reps / RIR / quality / pump while the athlete scrolled.
// Static guard of the shipped CSS (the geometry itself is audited in a real browser by scripts/e2e-client-chain/mobile-audit.js; see docs/T593F_MOBILE_UX.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8').replace(/\r\n/g, '\n');
const css = client.split(/<style[^>]*>/).slice(1).map((b) => b.split('</style>')[0]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

// every rule (flattened across @media blocks) as { selector, body }
function rules(src) {
  const out = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(src))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}
const ALL = rules(css);
const declared = (sel, prop) => ALL.filter((r) => sel.test(r.selector)).map((r) => { const d = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;!]+)(!important)?', 'i').exec(r.body); return d ? { selector: r.selector, value: d[1].trim() } : null; }).filter(Boolean);

test('T593F-1 the save button container is never sticky / fixed / absolute (it flows with its card)', () => {
  const pos = declared(/set-actions/, 'position');
  assert.ok(pos.length >= 1, 'the rule that places it exists');
  for (const p of pos) assert.equal(p.value, 'static', p.selector + ' must be static, got ' + p.value);
  for (const sel of [/set-save-primary/, /pf-cta/, /workout-set-current/, /setpanel/]) {
    for (const p of declared(sel, 'position')) assert.ok(!/^(sticky|fixed)$/.test(p.value), p.selector + ' must not be ' + p.value);
  }
});

test('T593F-2 nothing pulls the save button over the fields (no negative margins on its container, no bottom/top offsets)', () => {
  for (const r of ALL.filter((x) => /set-actions/.test(x.selector))) {
    assert.ok(!/margin[^:]*:[^;]*-\d/.test(r.body), r.selector + ' has a negative margin: ' + r.body);
    assert.ok(!/(^|;)\s*(bottom|top)\s*:/.test(r.body), r.selector + ' has an offset: ' + r.body);
    assert.ok(!/z-index/.test(r.body), r.selector + ' sets a z-index (it would stack over the fields)');
  }
});

test('T593F-3 the save button keeps a comfortable touch target (>= 44 px) at every width', () => {
  const heights = declared(/set-save-primary/, 'min-height').map((d) => parseInt(d.value, 10));
  assert.ok(heights.length >= 1 && heights.every((h) => h >= 44), JSON.stringify(heights));
});

test('T593F-4 the viewport-height units of the app shell and modals use dynamic units (browser bars) with a vh fallback', () => {
  assert.match(css, /html,body\{height:100%;height:100dvh;overflow:hidden\}/);
  for (const [vh, dvh] of [['92vh', '92dvh'], ['88vh', '88dvh']]) assert.ok(css.includes('max-height:' + vh + ';max-height:' + dvh), vh);
  assert.ok(client.includes('max-height:85vh;max-height:85dvh;') && client.includes('max-height:72vh;max-height:72dvh;'));
  assert.ok(!/\bheight:\s*100vh\b/.test(css), 'no rigid 100vh height remains');
});

test('T593F-5 the semantics of saving are untouched: the button still calls completeSet(key,...) and the per-entry persistence of PR 114 is in place', () => {
  assert.ok(/onclick="completeSet\(/.test(client) || /completeSet\('/.test(client));
  assert.ok(/_buildMergeWrite\(/.test(client) && !/mergeFields: \['entries'/.test(client));
});

test('T593F-6 (real-phone finding) the training tab never scrolls sideways: the exercise strip has no negative horizontal margin inside the padding-less #tabEntr, which is vertical-only', () => {
  for (const d of declared(/(^|[\s,])\.xnav$/, 'margin')) {
    const parts = d.value.split(/\s+/);   // margin: top [right [bottom [left]]]
    const right = parts.length >= 2 ? parts[1] : parts[0], left = parts.length === 4 ? parts[3] : right;
    assert.ok(!/^-/.test(right) && !/^-/.test(left), d.selector + ' has a negative horizontal margin: ' + d.value);
  }
  const tab = declared(/^#tabEntr$/, 'padding').concat(declared(/^#tabEntr$/, 'overflow-x'));
  assert.ok(tab.some((d) => /^0 0 96px/.test(d.value)), '#tabEntr is padding-less sideways (so no child may bleed out of it)');
  assert.ok(tab.some((d) => d.value === 'hidden'), '#tabEntr has overflow-x:hidden');
});
