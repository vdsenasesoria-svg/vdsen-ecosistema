'use strict';
// VDSEN Image Upload v2 — local fixture server (OFFLINE: no Firebase, no production data).
// Serves the REAL vdsen-coach.html from this repo from a synthetic origin, swaps the Firebase SDK for
// local doubles backed by a synthetic fixture, and exposes a harness auth handle for sign-in/out.
//
//   node scripts/image-upload-e2e/server.cjs [--port 8789] [--fixture image-upload]
//
// The real vdsen-coach.html is NEVER modified on disk: it is transformed in memory. Everything the
// harness adds (fixture boot, doubles, barrier handles) exists only in the bytes this server generates.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('port', 8789);
const FIXTURE = arg('fixture', 'image-upload');
const ROOT = path.resolve(__dirname, '..', '..');
const STUBS = path.join(__dirname, 'stubs');
const CACHE = path.join(os.tmpdir(), 'vdsen-image-upload-harness-cache');
fs.mkdirSync(CACHE, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.rules': 'text/plain', '.webp': 'image/webp' };
const PROXY_HOSTS = /gstatic\.com|googleapis\.com|tailwindcss\.com|cdnjs\.cloudflare\.com|jsdelivr\.net|unpkg\.com|fonts\.gstatic\.com/;
const STUB_BASE = '/__stub__';

async function proxy(url) {
  const key = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex'));
  const meta = key + '.json';
  if (fs.existsSync(key) && fs.existsSync(meta)) return { body: fs.readFileSync(key), headers: JSON.parse(fs.readFileSync(meta, 'utf8')) };
  const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const headers = { 'content-type': r.headers.get('content-type') || 'application/octet-stream' };
  if (r.ok) { fs.writeFileSync(key, buf); fs.writeFileSync(meta, JSON.stringify(headers)); }
  return { body: buf, headers, status: r.status };
}

function transformHtml(html) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', FIXTURE + '.json'), 'utf8'));
  let out = html;
  // 1) point the SDK imports at the local doubles (static import AND dynamic import() forms)
  for (const mod of ['app', 'auth', 'firestore', 'storage']) {
    const re = new RegExp('https://www\\.gstatic\\.com/firebasejs/[^/]+/firebase-' + mod + '\\.js', 'g');
    out = out.replace(re, STUB_BASE + '/firebase-' + mod + '.js');
  }
  // 2) replace the real firebaseConfig with a clearly synthetic one
  const cfgRe = /const firebaseConfig = \{[\s\S]*?\};/;
  if (!cfgRe.test(out)) throw new Error('harness: firebaseConfig anchor missing');
  out = out.replace(cfgRe, `const firebaseConfig = {
  apiKey: "HARNESS-NO-NETWORK", authDomain: "harness.invalid", projectId: "harness-local",
  storageBucket: "harness.invalid", messagingSenderId: "0", appId: "harness", measurementId: "G-0" };`);
  // 3) inject the synthetic dataset + a banner so a human can tell it is not production
  const boot = `<script>window.__VDSEN_HARNESS__=true;window.__VDSEN_FIXTURE__=${JSON.stringify(fixture).replace(/</g, '\\u003c')};</script>`;
  out = out.replace(/<head([^>]*)>/i, (m) => m + boot);
  return out;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (u.pathname.startsWith(STUB_BASE)) {
      const f = path.join(STUBS, path.normalize(u.pathname.replace(STUB_BASE + '/', '')).replace(/^(\.\.[\/\\])+/, ''));
      if (!f.startsWith(STUBS) || !fs.existsSync(f)) { res.writeHead(404); return res.end('no stub'); }
      // no-store: the doubles are edited while iterating, and a cached copy makes the browser run an
      // older export surface and report a missing named export that actually exists.
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(f));
    }
    if (u.pathname === '/' || u.pathname === '/coach') {
      const html = transformHtml(fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (PROXY_HOSTS.test(u.hostname) || /^https?:/.test(req.url)) {
      const target = /^https?:/.test(req.url) ? req.url : u.href;
      const p = await proxy(target);
      res.writeHead(p.status || 200, p.headers);
      return res.end(p.body);
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(f));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('harness error: ' + e.message);
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('[image-upload-e2e] server on http://127.0.0.1:' + PORT + '  fixture=' + FIXTURE + '  root=' + ROOT));
