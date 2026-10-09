'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a, b) {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

const whatsNew = client.slice(
  client.indexOf("var _WN_VERSION"),
  client.indexOf('window.showWhatsNew = showWhatsNew;')
);

ok(whatsNew.includes("var _WN_VERSION = 'vdsen_wn_v7'"), 'Novedades uses a new once-per-version dismissal key');
ok(whatsNew.includes("var _WN_DATE = 'Sep 2026'"), 'Novedades identifies the current Sep 2026 release');
const entries = whatsNew.match(/\{ icon: /g) || [];
ok(entries.length >= 4 && entries.length <= 6, 'Novedades contains four to six focused updates');
ok(whatsNew.includes('cuando está disponible') && whatsNew.includes('Si tu plan incluye instrucciones'), 'technique guidance is explicitly conditional on plan data');
ok(whatsNew.includes('completa solo los campos que correspondan'), 'optional check-in data is not presented as universally required');
ok(!/Competitive Physique|farmacolog|dosis|ciclos|stacks/i.test(whatsNew), 'Novedades does not overpromise optional competitive or pharmacology modules');

ok(client.includes('--accent:#C6FF00') && client.includes('--accent-fill:#C6FF00') && client.includes('--on-accent:#0A0A0A'), 'dark theme and brand-fill lime remain canonical');
ok(client.includes('--accent:#245500 !important') && client.includes('--accent-rgb:198,255,0'), 'light mode separates readable accent text from the canonical lime tint');
ok(client.includes('--mt2:#666') && client.includes('--blue:#075F9C') && client.includes('--rir:#7A3E00'), 'light-mode secondary and semantic foregrounds use readable values');
ok(contrast('C6FF00', '0A0A0A') >= 4.5, 'off-black on acid-lime CTA fill exceeds WCAG AA contrast');
ok(contrast('245500', 'F0F0EC') >= 4.5, 'light-mode accent text exceeds WCAG AA contrast');
ok(contrast('666666', 'FFFFFF') >= 4.5, 'light-mode muted text exceeds WCAG AA contrast on cards');

ok(!client.includes('background:var(--accent);'), 'accent text token is never reused as a CTA or badge fill');
ok(client.includes('background:var(--accent-fill);color:var(--on-accent)'), 'primary actions use lime fill with off-black semantic text');
ok(/\.wkc\.future \.wkc-n\{[^}]*color:var\(--mt\)/.test(client) && /\.wkc\.view \.wkc-n\{[^}]*color:var\(--tx\)/.test(client) && !/\.wkc[^{]*\{[^}]*color:rgba/.test(client), 'week selector avoids white-on-white and translucent future labels (T542: token-only .wkc cells)');
ok(!client.includes('color:#C4FF00;background:rgba(196,255,0,.1)'), 'light surfaces no longer use neon lime as foreground text');

console.log('\nT449 — Client release notes + light contrast: ' + pass + ' assertions PASSED.');
