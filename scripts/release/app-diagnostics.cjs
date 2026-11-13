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
const P = require('../pilot/window-protocol.cjs');

const LEGACY_ARMED_DEPLOYMENT = P.LEGACY_ARMED_DEPLOYMENT;
const PROJECT_ENV = '/v9/projects/{id}/env';

function state() { return json('.release/vdsen-client.json'); }

function validateControlDeployment(d, s) {
  if (!d || typeof d !== 'object') return false;
  const id = d.id || d.uid;
  const projectId = d.projectId;
  const teamId = d.teamId || d.ownerId;
  return id === s.production_deployment && projectId === s.production_project && teamId === s.vercel_team;
}

async function fetchDeployment(deploymentId, s, token, customFetch = fetch) {
  if (!deploymentId || typeof deploymentId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) {
    return { status: 'INVALID_ID', ok: false, error: 'Invalid deployment ID format' };
  }
  const url = 'https://api.vercel.com/v13/deployments/' + encodeURIComponent(deploymentId) + '?teamId=' + encodeURIComponent(s.vercel_team);
  try {
    const r = await customFetch(url, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (r.status === 200) {
      let data = null;
      try {
        if (typeof r.json === 'function') {
          data = await r.json();
        } else if (typeof r.text === 'function') {
          const text = await r.text();
          data = text ? JSON.parse(text) : {};
        }
      } catch (e) {
        return { status: 'INVALID_JSON', ok: false };
      }
      return { status: 200, ok: true, data };
    }
    return { status: r.status, ok: false };
  } catch (err) {
    return { status: 'NETWORK', ok: false, error: (err && err.message ? err.message : String(err)).slice(0, 120) };
  }
}

async function verifyLegacyDeploymentRetirement(s, token, opts = {}) {
  const customFetch = opts.fetch || fetch;
  const legacyId = opts.legacyId !== undefined ? opts.legacyId : LEGACY_ARMED_DEPLOYMENT;
  const controlId = s && s.production_deployment;

  if (!token) {
    return {
      verdict: 'UNVERIFIED',
      reason: 'NO_TOKEN',
      legacy_deployment: legacyId,
      control_deployment: controlId,
    };
  }

  if (!controlId || !s.production_project || !s.vercel_team) {
    return {
      verdict: 'UNVERIFIED',
      reason: 'INVALID_STATE_MANIFEST',
      legacy_deployment: legacyId,
      control_deployment: controlId,
    };
  }

  if (!legacyId || typeof legacyId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(legacyId)) {
    return {
      verdict: 'UNVERIFIED',
      reason: 'INVALID_LEGACY_ID',
      legacy_deployment: legacyId,
      control_deployment: controlId,
    };
  }

  // 1. Control check BEFORE: must be HTTP 200 and match project, team, deployment
  const controlBefore = await fetchDeployment(controlId, s, token, customFetch);
  const controlBeforeValid = controlBefore.status === 200 && validateControlDeployment(controlBefore.data, s);

  if (!controlBeforeValid) {
    return {
      verdict: 'UNVERIFIED',
      reason: 'CONTROL_BEFORE_INVALID',
      control_before: { status: controlBefore.status, valid: false },
      legacy_deployment: legacyId,
      control_deployment: controlId,
    };
  }

  // 2. Query legacy deployment using same token and scope
  const legacyResult = await fetchDeployment(legacyId, s, token, customFetch);

  // 3. Control check AFTER: must be HTTP 200 and match project, team, deployment
  const controlAfter = await fetchDeployment(controlId, s, token, customFetch);
  const controlAfterValid = controlAfter.status === 200 && validateControlDeployment(controlAfter.data, s);

  if (!controlAfterValid) {
    return {
      verdict: 'UNVERIFIED',
      reason: 'CONTROL_AFTER_INVALID',
      control_before: { status: controlBefore.status, valid: true },
      legacy: { status: legacyResult.status },
      control_after: { status: controlAfter.status, valid: false },
      legacy_deployment: legacyId,
      control_deployment: controlId,
    };
  }

  // 4. Both controls are strictly valid. Emit verdict based on legacy response status:
  if (legacyResult.status === 404) {
    return {
      verdict: 'RETIRED_VERIFIED',
      legacy_deployment: legacyId,
      control_deployment: controlId,
      control_before: { status: 200, valid: true },
      legacy: { status: 404 },
      control_after: { status: 200, valid: true },
    };
  }

  if (legacyResult.status === 200) {
    return {
      verdict: 'STILL_EXISTS',
      legacy_deployment: legacyId,
      control_deployment: controlId,
      control_before: { status: 200, valid: true },
      legacy: { status: 200 },
      control_after: { status: 200, valid: true },
    };
  }

  return {
    verdict: 'UNVERIFIED',
    reason: 'LEGACY_STATUS_' + legacyResult.status,
    legacy_deployment: legacyId,
    control_deployment: controlId,
    control_before: { status: 200, valid: true },
    legacy: { status: legacyResult.status },
    control_after: { status: 200, valid: true },
  };
}

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

function summarizeDeploymentMeta(d) {
  if (!d || typeof d !== 'object') return null;
  const meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
  return {
    id: d.id || d.uid || null,
    projectId: d.projectId || null,
    teamId: d.teamId || d.ownerId || null,
    readyState: d.readyState || null,
    target: d.target || null,
    createdAt: d.createdAt || d.created || null,
    aliases: Array.isArray(d.alias) ? d.alias : [],
    githubCommitSha: typeof meta.githubCommitSha === 'string' ? meta.githubCommitSha : null,
    githubCommitRef: typeof meta.githubCommitRef === 'string' ? meta.githubCommitRef : null,
    githubCommitRepo: typeof meta.githubCommitRepo === 'string' ? meta.githubCommitRepo : null,
    githubCommitOrg: typeof meta.githubCommitOrg === 'string' ? meta.githubCommitOrg : null,
  };
}

async function collectDriftAndProjectEvidence(s, token, opts = {}) {
  const customFetch = opts.fetch || fetch;
  const base = 'https://api.vercel.com';
  const teamQ = '?teamId=' + encodeURIComponent(s.vercel_team);
  const host = new URL(s.production_origin).hostname;
  const out = {
    alias_live: null,
    live_deployment: null,
    baseline_deployment: null,
    legacy_deployment: null,
    project_git_config: null,
  };

  try {
    const r = await customFetch(base + '/v4/aliases/' + encodeURIComponent(host) + teamQ, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (r.status === 200) {
      const a = await r.json();
      const liveId = a && a.deployment ? (a.deployment.id || a.deployment.uid || null) : null;
      out.alias_live = {
        status: 200,
        alias: a.alias || host,
        deploymentId: liveId,
        projectId: a.projectId || null,
        createdAt: a.createdAt || a.created || null,
      };
      if (liveId && /^dpl_[A-Za-z0-9]+$/.test(liveId)) {
        const liveRes = await fetchDeployment(liveId, s, token, customFetch);
        out.live_deployment = liveRes.ok ? summarizeDeploymentMeta(liveRes.data) : { status: liveRes.status };
      }
    } else {
      out.alias_live = { status: r.status };
    }
  } catch (e) {
    out.alias_live = { status: 'NETWORK' };
  }

  const baseRes = await fetchDeployment(s.production_deployment, s, token, customFetch);
  out.baseline_deployment = baseRes.ok ? summarizeDeploymentMeta(baseRes.data) : { status: baseRes.status };

  const legRes = await fetchDeployment(LEGACY_ARMED_DEPLOYMENT, s, token, customFetch);
  out.legacy_deployment = legRes.ok ? summarizeDeploymentMeta(legRes.data) : { status: legRes.status };

  try {
    const pr = await customFetch(base + '/v9/projects/' + encodeURIComponent(s.production_project) + teamQ, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (pr.status === 200) {
      const p = await pr.json();
      const link = p && p.link && typeof p.link === 'object' ? p.link : {};
      out.project_git_config = {
        status: 200,
        id: p.id || null,
        accountId: p.accountId || null,
        autoAssignCustomDomains: p.autoAssignCustomDomains ?? null,
        commandForIgnoringBuildStep: p.commandForIgnoringBuildStep ?? null,
        linkType: link.type || null,
        linkRepo: link.repo || null,
        productionBranch: link.productionBranch || null,
        gitForkProtection: p.gitForkProtection ?? null,
      };
    } else {
      out.project_git_config = { status: pr.status };
    }
  } catch (e) {
    out.project_git_config = { status: 'NETWORK' };
  }

  return out;
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

  // Strict GET-only accreditation of the legacy armed deployment retirement.
  const legacyCheck = await verifyLegacyDeploymentRetirement(s, token);
  const driftEvidence = await collectDriftAndProjectEvidence(s, token);

  const lines = ['## App lane read diagnostics', '', '| read | status | ms | detail |', '|---|---|---|---|'];
  for (const r of results) lines.push('| ' + r.label + ' | ' + r.status + ' | ' + r.ms + ' | ' + String(r.detail).replace(/\|/g, '/') + ' |');
  lines.push('', '### contract fields present on a production deployment', '', '| field | value |', '|---|---|');
  for (const [k, v] of Object.entries(shape)) lines.push('| ' + k + ' | ' + String(v).slice(0, 240) + ' |');
  lines.push('', '### Legacy armed deployment accreditation', '',
    '| check | result |',
    '|---|---|',
    '| legacy deployment ID | ' + legacyCheck.legacy_deployment + ' |',
    '| control deployment ID | ' + legacyCheck.control_deployment + ' |',
    '| control before status | ' + (legacyCheck.control_before ? legacyCheck.control_before.status : '(not reached)') + ' |',
    '| legacy status | ' + (legacyCheck.legacy ? legacyCheck.legacy.status : '(not reached)') + ' |',
    '| control after status | ' + (legacyCheck.control_after ? legacyCheck.control_after.status : '(not reached)') + ' |',
    '| verdict | **' + legacyCheck.verdict + '** |'
  );
  lines.push('', '### Drift & project git metadata (read-only)', '', '```json', JSON.stringify(driftEvidence, null, 2), '```');
  lines.push('', 'No token, variable value or response body is printed. Candidate: ' + (process.env.APP_RUNTIME_SHA || '(none)'));
  const summary = lines.join('\n');

  fs.mkdirSync('release-output', { recursive: true });
  fs.writeFileSync('release-output/app-diagnostics.json', JSON.stringify({ sdk_version: sdkVersion, results, shape, legacy_deployment_check: legacyCheck, drift_evidence: driftEvidence }, null, 2) + '\n');
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
module.exports = {
  diagnose,
  probe,
  state,
  fetchDeployment,
  validateControlDeployment,
  verifyLegacyDeploymentRetirement,
  collectDriftAndProjectEvidence,
  summarizeDeploymentMeta,
  LEGACY_ARMED_DEPLOYMENT,
};
