'use strict';
// Read-only: does the deployment the preflight resolves actually exist, and can it be promoted?
// Reports field NAMES / booleans only - never a token or a value.
const path = require('node:path');
const { json } = require(path.resolve('scripts/release/lib.cjs'));
const s = json('.release/vdsen-client.json');
const token = process.env.VERCEL_TOKEN;
if (!token) { console.log('no token'); process.exit(1); }
const base = 'https://api.vercel.com';
const team = '&teamId=' + encodeURIComponent(s.vercel_team);
const project = encodeURIComponent(s.production_project);

const CANDIDATE_SHA = 'c3e78380d3a076e643a1957203c093260851210e';

(async () => {
  const names = (o) => Object.keys(o || {}).filter((k) => !/token|secret|key|env|value/i.test(k));

  // 1. the candidate deployment the preflight resolved
  const r1 = await fetch(base + '/v7/deployments?projectId=' + project + '&limit=60' + team, { headers: { Authorization: 'Bearer ' + token } });
  const list = (await r1.json()).deployments || [];
  const bySha = list.filter((d) => d.meta && d.meta.githubCommitSha === CANDIDATE_SHA);
  console.log('list status   : ' + r1.status);
  console.log('candidate SHA deployments found: ' + bySha.length);
  for (const d of bySha.slice(0, 4)) {
    console.log('  id=' + String(d.uid || d.id).slice(0, 30) +
      '  target=' + String(d.target) +
      '  readyState=' + String(d.readyState) +
      '  state=' + String(d.state) +
      '  ready=' + String(d.ready) +
      '  isRollbackCandidate=' + String(d.isRollbackCandidate) +
      '  aliasAssigned=' + String(d.aliasAssigned));
    console.log('    field names: ' + names(d).join(' '));
  }

  // 2. the deployment the workflow actually tried to promote
  const TRIED = 'dpl_9rCu3FswEnseDvcgpf6FbrjzuJJS';
  const r2 = await fetch(base + '/v13/deployments/' + encodeURIComponent(TRIED) + '?teamId=' + encodeURIComponent(s.vercel_team), { headers: { Authorization: 'Bearer ' + token } });
  console.log('');
  console.log('GET /v13/deployments/<tried> status: ' + r2.status);
  if (r2.ok) {
    const d = await r2.json();
    console.log('  target=' + String(d.target) + '  readyState=' + String(d.readyState) + '  state=' + String(d.state) + '  ready=' + String(d.ready));
    console.log('  projectId===ours: ' + (d.projectId === s.production_project));
    console.log('  meta.githubCommitSha===candidate: ' + (d.meta && d.meta.githubCommitSha === CANDIDATE_SHA));
    console.log('  meta.githubCommitRef: ' + String(d.meta && d.meta.githubCommitRef));
  }

  // 3. Is the candidate perhaps ALREADY a production deployment?
  const prod = list.filter((d) => d.target === 'production');
  console.log('');
  console.log('production deployments in list: ' + prod.length);
  if (prod[0]) console.log('  newest production id=' + String(prod[0].uid || prod[0].id).slice(0, 30) + '  sha matches candidate: ' + (prod[0].meta && prod[0].meta.githubCommitSha === CANDIDATE_SHA));
})();
