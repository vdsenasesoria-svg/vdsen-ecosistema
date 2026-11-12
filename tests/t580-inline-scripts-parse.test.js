'use strict';
// T580 (P1): a single syntax error in an inline <script> kills the WHOLE page (empty UI, no handlers). The unit/emulator gates never parsed the
// served HTML, so a broken string literal in vdsen-coach.html (PR #77) reached production in release T579. Every inline script of every served
// HTML page must now at least PARSE (node --check on a temp file; module scripts as .mjs, classic as .js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PAGES = ['vdsen-coach.html', 'vdsen-cliente.html', 'ficha-publica.html'].filter((f) => fs.existsSync(path.join(ROOT, f)));

function inlineScripts(html) {
  const out = []; const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;                                            // external script
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;   // json / templates are not JavaScript
    if (!m[2].trim()) continue;
    out.push({ module: /^module$/i.test(type), code: m[2], offset: html.slice(0, m.index).split('\n').length });
  }
  return out;
}
function parseProblem(code, isModule) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t580-'));
  const f = path.join(dir, 'inline' + (isModule ? '.mjs' : '.js'));
  fs.writeFileSync(f, code);
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r.status === 0 ? null : (r.stderr || '').split('\n').filter(Boolean).slice(0, 4).join(' | ');
}

for (const page of PAGES) {
  test('T580 every inline <script> of ' + page + ' parses (a syntax error would blank the whole page)', () => {
    const scripts = inlineScripts(fs.readFileSync(path.join(ROOT, page), 'utf8'));
    assert.ok(scripts.length > 0, 'the page has inline scripts');
    const problems = [];
    scripts.forEach((s, i) => { const p = parseProblem(s.code, s.module); if (p) problems.push('script #' + (i + 1) + (s.module ? ' (module)' : '') + ' starting at HTML line ' + s.offset + ': ' + p); });
    assert.deepEqual(problems, []);
  });
}

test('T580 the detector itself works: a string literal broken across lines is reported, a valid script is not', () => {
  assert.ok(parseProblem("var a = 'x\ny';", false), 'raw newline inside a quoted string must fail');
  assert.equal(parseProblem("var a = 'x\\ny'; export {};", true), null);
  const html = '<script>var ok=1;</script><script type="module">import {a} from "https://x/y.js"; var b=1</script><script type="application/json">{"a":1}</script><script src="x.js"></script>';
  assert.equal(inlineScripts(html).length, 2, 'only inline JavaScript is checked');
});
