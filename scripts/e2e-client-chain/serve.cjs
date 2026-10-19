// LOCAL-ONLY E2E server: serves the REAL Client (vdsen-cliente.html from the worktree in argv[2]) wired to the LOCAL Firebase Auth + Firestore EMULATORS, and exposes the REAL
// production handler of /api/autonomous-progression-trigger (api/autonomous-progression-trigger.js makeHandler) backed by the Admin SDK against the same emulators.
// Nothing remote is contacted (demo project; apiKey is a placeholder). The file on disk is never modified; every patch is in memory.
//   node scripts/e2e-client-chain/serve.cjs [worktree] [port]   (needs the Firebase Auth + Firestore emulators on 9099 / 8085, project demo-vdsen-client-e2e)
const AUTH_PORT = 9099, FS_PORT = 8085, PROJECT = 'demo-vdsen-client-e2e';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + FS_PORT; process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:' + AUTH_PORT; process.env.GCLOUD_PROJECT = PROJECT;
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..')), PORT = Number(process.argv[3] || 5199), GS = 'https://www.gstatic.com/firebasejs/10.12.0/';
const admin = require(path.join(root, 'node_modules', 'firebase-admin'));
const app = admin.initializeApp({ projectId: PROJECT }, 'client-e2e-server');
const db = admin.firestore(app), auth = admin.auth(app);
const trigger = require(path.join(root, 'api', 'autonomous-progression-trigger.js'));
const calls = [];
// E2E_ENABLED=0 -> the executor is DISARMED (202, zero writes); E2E_NUMERIC=0 -> materialize only (PENDING), never apply. Default: both ON (this is a local emulator, never production).
const handler = trigger.makeHandler({ db, verifyIdToken: (t) => auth.verifyIdToken(t), enabled: process.env.E2E_ENABLED !== '0', numericApplyEnabled: process.env.E2E_NUMERIC !== '0' });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const MOD = new RegExp('<script type="module">([\\s\\S]*?)<' + '/script>');
const CFG = /const firebaseConfig = \{[\s\S]*?\};/;
const readBody = (q) => new Promise((resolve) => { let d = ''; q.on('data', (c) => d += c); q.on('end', () => resolve(d)); });

http.createServer(async (q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/api/autonomous-progression-trigger') {
    const raw = await readBody(q); let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) { /* handler rejects */ }
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { calls.push({ at: new Date().toISOString(), method: q.method, status: this.code, body: o }); r.writeHead(this.code, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); } };
    try { return await handler({ method: q.method, headers: q.headers, body, query: {} }, res); } catch (e) { r.writeHead(500); return r.end('{"error":"E2E_SERVER_ERROR"}'); }
  }
  if (p === '/__driver.js') { r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return r.end(fs.readFileSync(path.join(__dirname, 'driver.js'))); }
  if (p === '/__trigger-log') { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify(calls)); }
  if (p === '/__creds') { const who = new URL(q.url, 'http://x').searchParams.get('who'); const all = JSON.parse(fs.readFileSync(path.join(require('os').tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8')); r.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return r.end(JSON.stringify(who ? all.who[who] : { coachUid: all.coachUid, names: Object.keys(all.who) })); }   // synthetic emulator credentials only
  if (p.startsWith('/gs/')) {
    try { const u = await fetch(GS + p.slice(4)); let b = Buffer.from(await u.arrayBuffer()); b = Buffer.from(b.toString('utf8').split(GS).join('/gs/')); r.writeHead(u.status, { 'content-type': 'text/javascript' }); return r.end(b); }
    catch (e) { r.writeHead(502); return r.end('proxy err'); }
  }
  if (p === '/' || p === '/vdsen-cliente.html') {
    let html = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
    if (!CFG.test(html)) throw new Error('config block not found');
    html = html.replace(CFG, () => 'const firebaseConfig = { apiKey: "demo-key", authDomain: "' + PROJECT + '.firebaseapp.com", projectId: "' + PROJECT + '", storageBucket: "' + PROJECT + '.appspot.com", messagingSenderId: "0", appId: "1:0:web:0" };');
    html = html.split(GS).join('/gs/');
    html = html.replace(MOD, (m, code) => {
      let c = code.split("'/gs/").join("'http://localhost:" + PORT + "/gs/").split('"/gs/').join('"http://localhost:' + PORT + '/gs/');
      c = c.replace('import { getAuth,', 'import { connectAuthEmulator, getAuth,').replace('import { initializeFirestore,', 'import { connectFirestoreEmulator, initializeFirestore,');
      c = c.replace('const auth = getAuth(app);', 'const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:' + AUTH_PORT + '", { disableWarnings: true });');
      c = c.replace('const db = initializeFirestore(app, { localCache: persistentLocalCache() });', 'const db = initializeFirestore(app, { localCache: persistentLocalCache() }); connectFirestoreEmulator(db, "127.0.0.1", ' + FS_PORT + ');');
      if (!/connectAuthEmulator\(auth/.test(c) || !/connectFirestoreEmulator\(db/.test(c)) throw new Error('emulator patch not applied');
      return '<script type="text/plain" id="clientModuleSrc">' + c.replace(/<\/script>/gi, '<\\/script>') + '</' + 'script>';
    });
    r.writeHead(200, { 'content-type': types['.html'], 'cache-control': 'no-store' }); return r.end(html);
  }
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
}).listen(PORT, 'localhost', () => console.log('ready ' + PORT));
