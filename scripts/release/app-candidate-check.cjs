'use strict';
// READ-ONLY diagnostic: is the candidate the release lane would resolve for APP_RUNTIME_SHA the
// deployment we think it is, and is it eligible?
//
// There is deliberately NO second implementation of candidate resolution here. This file calls the
// same app-live.cjs functions (listDeploymentPages -> selectCandidate -> assertCandidate) that the
// release preflight uses, so the diagnostic and the release always judge the SAME deployment.
// No SHA or deployment id is hard-coded: the only input is APP_RUNTIME_SHA, validated as an exact
// 40-hex commit. Only GET requests are issued. Output is names / booleans / counts: never a token,
// a response body or an environment value.
const path = require('node:path');
const live = require(path.resolve('scripts/release/app-live.cjs'));
const { json } = require(path.resolve('scripts/release/lib.cjs'));

const SAFE_ERROR = /^API GET \S+ failed: HTTP (\d{3})$/;
const category = (error) => {
  const m = String(error && error.message || '');
  const h = SAFE_ERROR.exec(m);
  if (h) return 'HTTP_' + h[1];
  if (/incomplete/i.test(m)) return 'INCOMPLETE_RESPONSE';
  if (/credential/i.test(m)) return 'NO_CREDENTIAL';
  return 'ERROR';
};

async function check(s, runtime) {
  const r = { runtime_sha: runtime, resolution: 'ERROR', matches: 0, list_pages: 0, list_truncated: false, error: 'NONE', eligible: false, checks: {} };
  let sel;
  try {
    const listed = await live.listDeploymentPages(s);
    r.list_pages = listed.pages; r.list_truncated = listed.truncated;
    sel = live.selectCandidate(listed.deployments, runtime, s);
  } catch (error) { r.error = category(error); return r; }
  r.resolution = sel.status; r.matches = sel.matches;
  if (sel.status !== 'OK') { r.error = r.list_truncated && sel.status === 'NOT_FOUND' ? 'LIST_TRUNCATED' : sel.status; return r; }
  // Authoritative per-deployment read: the list entry is never trusted for eligibility.
  let d;
  try { d = live.normalizeDeployment(await live.deployment(s, sel.candidate.id)); } catch (error) { r.error = category(error); return r; }
  r.checks = {
    id_matches_list: d.id === sel.candidate.id || d.uid === sel.candidate.id,
    project_matches: d.projectId === s.production_project,
    sha_matches: d.meta?.githubCommitSha === runtime,
    git_ref_present: d.meta?.githubCommitRef !== undefined,
    target: String(d.target ?? 'preview'),
    ready_state: String(d.readyState || d.ready),
    state: String(d.state),
    is_rollback_candidate: d.isRollbackCandidate === true,
    alias_assigned: d.aliasAssigned === undefined ? null : Boolean(d.aliasAssigned),
  };
  try {
    live.assertCandidate(live.normalizeDeployment({ ...d }), { runtime, project: s.production_project, team: s.vercel_team });
    r.eligible = r.checks.id_matches_list; r.error = r.eligible ? 'NONE' : 'ID_MISMATCH';
  } catch { r.error = 'NOT_ELIGIBLE'; }
  return r;
}

function lines(r) {
  const out = ['candidate runtime_sha : ' + r.runtime_sha,
    'resolution            : ' + r.resolution + '  matches=' + r.matches + '  pages=' + r.list_pages + '  truncated=' + r.list_truncated];
  for (const [k, v] of Object.entries(r.checks)) out.push('  ' + k + '=' + String(v));
  out.push('eligible              : ' + r.eligible + '  error=' + r.error);
  return out;
}

async function main() {
  const s = json('.release/vdsen-client.json');
  if (!process.env.VERCEL_TOKEN) { console.log('no credential'); return 1; }
  let runtime;
  try { runtime = live.assertExplicitRuntime(process.env.APP_RUNTIME_SHA); }
  catch { console.log('APP_RUNTIME_SHA must be an exact 40-char commit SHA'); return 1; }
  const r = await check(s, runtime);
  for (const l of lines(r)) console.log(l);
  return r.eligible ? 0 : 1;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }).catch(() => { console.log('candidate check failed; details withheld'); process.exitCode = 1; });
module.exports = { check, lines, category };
