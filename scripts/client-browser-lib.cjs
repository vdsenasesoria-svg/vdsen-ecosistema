'use strict';
// T542: shared headless-Chromium helpers for the client UI harnesses (Playwright must be resolvable, e.g. NODE_PATH=$(npm root -g)).
// The app is served from a fake https origin straight from the working tree; CDN assets (Firebase SDK, fonts) are fetched by Node so the
// sandbox proxy is honoured (run with NODE_USE_ENV_PROXY=1) and cached under the OS temp dir. Service workers are blocked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(os.tmpdir(), 'vdsen-ui-cache');
const APP = 'https://app.vdsen.test';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const STATIC = /fonts\.g|gstatic|cdnjs/;

function chromiumPath() {
  if (process.env.VDSEN_CHROMIUM) return process.env.VDSEN_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { const d = fs.readdirSync(base).filter(x => /^chromium-\d+$/.test(x)).sort().pop(); if (d) return path.join(base, d, 'chrome-linux', 'chrome'); } catch (e) { /* fall through to Playwright's default */ }
  return undefined;
}
async function launch() { return chromium.launch({ executablePath: chromiumPath() }); }

async function proxyFetch(route, cacheFile) {
  try {
    const rq = route.request(), h = Object.assign({}, rq.headers()); delete h['content-length']; delete h.host;
    const res = await fetch(rq.url(), { method: rq.method(), headers: h, body: rq.postDataBuffer() || undefined });
    const buf = Buffer.from(await res.arrayBuffer()), headers = {};
    res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) headers[k] = v; });
    headers['access-control-allow-origin'] = rq.headers().origin || '*'; headers['access-control-allow-headers'] = '*'; headers['access-control-allow-methods'] = '*';
    if (cacheFile && res.status === 200) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cacheFile, buf); fs.writeFileSync(cacheFile + '.m', JSON.stringify({ status: 200, headers })); }
    return route.fulfill({ status: res.status, headers, body: buf });
  } catch (e) { return route.abort(); }
}

async function newCtx(browser, { width = 390, height = 844, root = ROOT, transform } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await ctx.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(APP)) {
      const u = new URL(url).pathname, f = path.join(root, u === '/' ? 'vdsen-cliente.html' : u);
      if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return route.fulfill({ status: 404, body: '' });
      const ext = path.extname(f); let body = fs.readFileSync(f);
      if (transform && ext === '.html') body = Buffer.from(transform(body.toString('utf8')));
      return route.fulfill({ status: 200, contentType: MIME[ext] || 'application/octet-stream', body });
    }
    if (route.request().method() !== 'GET') return proxyFetch(route);
    const file = path.join(CACHE, crypto.createHash('sha1').update(url + (route.request().headers()['user-agent'] || '')).digest('hex'));
    if (STATIC.test(url) && fs.existsSync(file + '.m')) { const m = JSON.parse(fs.readFileSync(file + '.m')); return route.fulfill({ status: m.status, headers: m.headers, body: fs.readFileSync(file) }); }
    return proxyFetch(route, STATIC.test(url) ? file : null);
  });
  return ctx;
}
module.exports = { launch, newCtx, APP, ROOT };
