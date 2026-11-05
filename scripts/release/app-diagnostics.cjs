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

  // The preflight's contract depends on specific FIELD NAMES existing. Report which do, as
  // booleans/names only: field names are not secret, values are never printed.
  const shape = await deploymentShape(s, token, base, team, project);

  const lines = ['## App lane read diagnostics', '', '| read | status | ms | detail |', '|---|---|---|---|'];
  for (const r of results) lines.push('| ' + r.label + ' | ' + r.status + ' | ' + r.ms + ' | ' + String(r.detail).replace(/\|/g, '/') + ' |');
  lines.push('', '### contract fields present on a production deployment', '', '| field | value |', '|---|---|');
  for (const [k, v] of Object.entries(shape)) lines.push('| ' + k + ' | ' + String(v).slice(0, 240) + ' |');
  lines.push('', 'No token, variable value or response body is printed. Candidate: ' + (process.env.APP_RUNTIME_SHA || '(none)'));
  const summary = lines.join('\n');

  fs.mkdirSync('release-output', { recursive: true });
  fs.writeFileSync('release-output/app-diagnostics.json', JSON.stringify({ sdk_version: sdkVersion, results, shape }, null, 2) + '\n');
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); } catch (e) {}
  console.log(summary);
}

// Reports, as booleans plus field NAMES, which fields the lane's contract requires. Never
// prints a value.
async function deploymentShape(s, token, base, team, project) {
  const out = {};
  const names = (o) => Object.keys(o || {}).filter((k) => !/token|secret|key|env|value/i.test(k));
  try {
    const r = await fetch(base + '/v7/deployments?projectId=' + project + '&target=production&limit=5' + team,
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
    const o = await r.json();
    const list = o.deployments || [];
    out['v7 count'] = list.length;
    const d = list[0] || {};
    out['id present'] = d.id !== undefined;
    out['uid present'] = d.uid !== undefined;
    out['projectId present'] = d.projectId !== undefined;
    out['projectId === ours'] = d.projectId === s.production_project;
    out['target present'] = d.target !== undefined;
    out['target === production'] = d.target === 'production';
    out['readyState present'] = d.readyState !== undefined;
    out['readyState === READY'] = d.readyState === 'READY';
    out['created present'] = d.created !== undefined;
    out['meta is object'] = !!d.meta && typeof d.meta === 'object';
    out['meta.githubCommitSha present'] = !!(d.meta && d.meta.githubCommitSha);
    out['meta keys'] = d.meta ? names(d.meta).join(' ') : '(no meta)';
    out['field names'] = names(d).join(' ');
  } catch (e) { out.error = e.message.slice(0, 90); }

  try {
    const r = await fetch(base + '/v13/deployments/' + encodeURIComponent(s.production_deployment) + '?teamId=' + encodeURIComponent(s.vercel_team),
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    out['v13 meta.githubCommitSha present'] = !!(d.meta && d.meta.githubCommitSha);
    out['v13 readyState'] = d.readyState;
    out['v13 projectId === ours'] = d.projectId === s.production_project;
    out['v13 meta keys'] = d.meta ? names(d.meta).join(' ') : '(no meta)';
    out['v13 field names'] = names(d).slice(0, 30).join(' ');
  } catch (e) { out.v13_error = e.message.slice(0, 90); }
  return out;
}

if (require.main === module) {
  diagnose().catch((e) => { console.error('DIAGNOSE FAILED: ' + e.message); process.exitCode = 1; });
}
module.exports = { diagnose, probe };
