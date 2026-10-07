'use strict';
// Read-only diagnostics for the app release lane.
//
// Reports the HTTP status of EACH read the preflight performs, so a failure identifies itself
// instead of surfacing as a bare "API GET failed: HTTP 400".
//
// Safety: it never prints a token, a variable VALUE, or a response body. Only the operation
// name, the HTTP status, and a short shape summary (counts / field names).
const fs = require('node:fs');
const { json, git } = require('./lib.cjs');

const PROJECT_ENV = '/v9/projects/{id}/env';

function state() { return json('.release/vdsen-client.json'); }

async function probe(label, url, token) {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    let shape = '';
    if (r.ok) {
      try {
        const t = await r.text();
        const o = t ? JSON.parse(t) : {};
        // Field NAMES and counts only. Never values.
        shape = 'keys=' + Object.keys(o).slice(0, 6).join(',');
        const list = o.deployments || o.envs || o.domains;
        if (Array.isArray(list)) {
          shape += ' count=' + list.length;
          const first = list[0] || {};
          shape += ' itemKeys=' + Object.keys(first).filter((k) => !/token|secret|key|value|private/i.test(k)).slice(0, 8).join(',');
        }
      } catch (e) { shape = 'body-not-json'; }
    } else {
      // Read a bounded slice of the error to identify the parameter problem, then redact.
      try {
        const t = (await r.text()).slice(0, 400);
        shape = 'error=' + t.replace(/[A-Za-z0-9_-]{20,}/g, '<redacted>').replace(/\s+/g, ' ').slice(0, 200);
      } catch (e) { shape = 'error-unreadable'; }
    }
    return { label, status: r.status, ok: r.ok, ms: Date.now() - started, detail: shape };
  } catch (e) {
    return { label, status: 'NETWORK', ok: false, ms: Date.now() - started, detail: e.message.slice(0, 120) };
  }
}

async function diagnose() {
  const s = state();
  const token = process.env.VERCEL_TOKEN;
  if (!token) { console.log('DIAGNOSE: no VERCEL_TOKEN available'); process.exitCode = 1; return; }
  const team = '&teamId=' + encodeURIComponent(s.vercel_team);
  const project = encodeURIComponent(s.production_project);
  const base = 'https://api.vercel.com';
  const sdkVersion = process.env.VERCEL_SDK_VERSION || '';

  const probes = [
    ['list deployments (v7, project)', base + '/v7/deployments?projectId=' + project + '&limit=100' + team],
    ['list deployments (v7, target=production)', base + '/v7/deployments?projectId=' + project + '&target=production&limit=100' + team],
    ['project env (v9, no decrypt)', base + '/v9/projects/' + project + '/env' + '?teamId=' + encodeURIComponent(s.vercel_team)],
    ['project env (v9, decrypt=false)', base + '/v9/projects/' + project + '/env?decrypt=false' + team],
    ['project env (v10)', base + '/v10/projects/' + project + '/env' + '?teamId=' + encodeURIComponent(s.vercel_team)],
    ['project domains (v9)', base + '/v9/projects/' + project + '/domains' + '?teamId=' + encodeURIComponent(s.vercel_team)],
    ['project (v9)', base + '/v9/projects/' + project + '?teamId=' + encodeURIComponent(s.vercel_team)],
    ['get deployment (v13)', base + '/v13/deployments/' + encodeURIComponent(s.production_deployment) + '?teamId=' + encodeURIComponent(s.vercel_team)],
    ['alias by hostname (v4)', base + '/v4/aliases/' + encodeURIComponent(new URL(s.production_origin).hostname) + '?teamId=' + encodeURIComponent(s.vercel_team)],
  ];

  const results = [];
  for (const [label, url] of probes) results.push(await probe(label, url, token));

  const lines = ['## App lane read diagnostics', '', '| read | status | ms | detail |', '|---|---|---|---|'];
  for (const r of results) lines.push('| ' + r.label + ' | ' + r.status + ' | ' + r.ms + ' | ' + String(r.detail).replace(/\|/g, '/') + ' |');
  lines.push('', 'No token, variable value or response body is printed. Candidate: ' + (process.env.APP_RUNTIME_SHA || '(none)'));
  const summary = lines.join('\n');

  fs.mkdirSync('release-output', { recursive: true });
  fs.writeFileSync('release-output/app-diagnostics.json', JSON.stringify({ sdk_version: sdkVersion, results }, null, 2) + '\n');
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); } catch (e) {}
  console.log(summary);
}

if (require.main === module) {
  diagnose().catch((e) => { console.error('DIAGNOSE FAILED: ' + e.message); process.exitCode = 1; });
}
module.exports = { diagnose, probe };
