#!/usr/bin/env node
'use strict';
// T574: HOSTED acceptance of the autonomous-progression endpoint deployed in the isolated Vercel staging project, against Firebase STAGING.
//   node scripts/t574-hosted-staging-e2e.cjs --base https://<staging deployment host> --cookie-file <file with the _vercel_jwt cookie> [--cron-secret-file <path>] [--writes]
// Phase 1 (default) performs NO Firestore writes: runtime probe, auth rejections, disarmed behaviour. Phase 2 (--writes) needs the project
// switches ON and the release allowlist/canary, and uses synthetic staging accounts only (deleted at the end). Secrets are read from files and
// never printed. Refuses any base URL that is not the staging project host.
const fs = require('node:fs'), path = require('node:path');
const H = require('./client-staging-harness.cjs');
const cfg = H.stagingConfig();
if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('base'), cookieFile = arg('cookie-file', null), cookie = cookieFile && fs.existsSync(cookieFile) ? fs.readFileSync(cookieFile, 'utf8').trim() : '', secretFile = arg('cron-secret-file', null), writes = process.argv.includes('--writes');
if (writes) throw new Error('The write phase now lives in scripts/t575-hosted-matrix.cjs (--phase on): this script performs the no-write cases only.');
if (!/^https:\/\/vdsen-ecosistema-staging-t573[a-z0-9-]*\.vercel\.app$/.test(base || '')) throw new Error('REFUSING: base must be a vdsen-ecosistema-staging-t573 deployment host');
const EP = base + '/api/autonomous-progression-trigger';
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || null }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); return !!pass; };
const call = async (method, url, headers, body) => {
  const r = await fetch(url, { method, headers: Object.assign({ cookie, 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
  return { s: r.status, j, t: t.slice(0, 120) };
};
const KEY = cfg.apiKey;
async function signUp(label) {
  const email = label + '.' + Math.random().toString(16).slice(2, 8) + '@staging-ui.invalid', password = require('node:crypto').randomBytes(12).toString('base64url') + 'aA1!';
  const r = await (await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + KEY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json();
  return { uid: r.localId, token: r.idToken };
}
(async () => {
  const out = { base: base.replace(/^https:\/\//, ''), at: new Date().toISOString(), writes };
  // --- Phase 1: no writes
  const u = await signUp('hosted-probe');
  let r = await call('GET', EP);
  check('H01 unauthenticated GET is rejected (401) - function reachable, federated runtime built', r.s === 401 && r.j && r.j.error === 'AUTH_INVALID', r.s + ' ' + JSON.stringify(r.j));
  r = await call('POST', EP, {}, { planId: 'x' });
  check('H02 POST without Bearer token -> 401', r.s === 401, r.s + ' ' + JSON.stringify(r.j));
  r = await call('POST', EP, { authorization: 'Bearer not.a.real.token' }, { planId: 'x' });
  check('H03 POST with an invalid Firebase token -> 401', r.s === 401, r.s + ' ' + JSON.stringify(r.j));
  r = await call('POST', EP + '?check=firestore', { authorization: 'Bearer ' + u.token });
  check('H04 federated credential works: read-only Firestore probe (STS + impersonation succeeded)', r.s === 200 && r.j && r.j.firestore === 'READ_OK', r.s + ' ' + JSON.stringify(r.j));
  r = await call('POST', EP, { authorization: 'Bearer ' + u.token }, { planId: 'no-such-plan' });
  check('H05 valid token, switches OFF => 202 DISARMED (zero writes)', (r.s === 202 && r.j && r.j.status === 'DISARMED') || (r.s === 200 && r.j && ['OUT_OF_ALLOWLIST', 'PLAN_MISMATCH'].includes(r.j.status)), r.s + ' ' + JSON.stringify(r.j));
  r = await call('POST', EP, { authorization: 'Bearer ' + u.token }, {});
  check('H06 valid token, malformed body -> 400 or 202 (no write)', r.s === 400 || r.s === 202, r.s + ' ' + JSON.stringify(r.j));
  r = await call('DELETE', EP);
  check('H07 unsupported method rejected', r.s === 405, String(r.s));
  if (secretFile && fs.existsSync(secretFile)) {
    const sec = fs.readFileSync(secretFile, 'utf8').trim();
    r = await call('GET', EP, { authorization: 'Bearer wrong' }); check('H08 cron with a wrong secret -> 401', r.s === 401, String(r.s));
    r = await call('GET', EP + '?check=firestore', { authorization: 'Bearer ' + sec }); check('H09 cron-secret probe reads Firestore', r.s === 200 && r.j && r.j.firestore === 'READ_OK', r.s + ' ' + JSON.stringify(r.j));
  } else out.cronSecret = 'NOT_AVAILABLE (CRON_SECRET unknown to the operator)';
  // delete the probe user
  await fetch('https://identitytoolkit.googleapis.com/v1/accounts:delete?key=' + KEY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: u.token }) });
  out.results = results; out.pass = results.filter(x => x.pass).length; out.fail = results.filter(x => !x.pass).length;
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 't574-hosted-staging-results.json'), JSON.stringify(out, null, 2));
  console.log('PASS ' + out.pass + ' FAIL ' + out.fail);
  process.exit(out.fail ? 1 : 0);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
