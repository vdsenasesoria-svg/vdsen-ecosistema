'use strict';
// The read-only candidate diagnostic must judge exactly what the release lane judges, from the
// explicit APP_RUNTIME_SHA only. All network access is a stubbed fetch; nothing real is reachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const live = require('../scripts/release/app-live.cjs');
const diag = require('../scripts/release/app-candidate-check.cjs');

const s = JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const dep = (id, sha, extra = {}) => ({ uid: id, id, projectId: s.production_project, readyState: 'READY', state: 'READY', target: null, created: 1,
  meta: { githubCommitSha: sha, githubCommitRef: 'feature' }, ...extra });

function withApi(handler, fn) {
  const realFetch = global.fetch, prev = process.env.VERCEL_TOKEN, calls = [];
  process.env.VERCEL_TOKEN = 'unit-test-token';
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    const r = await handler(new URL(url), init);
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = realFetch; if (prev === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = prev; });
}
const listPages = pages => url => {
  if (url.pathname.startsWith('/v7/deployments')) {
    const until = url.searchParams.get('until');
    const i = until ? Number(until) : 0;
    return { status: 200, body: { deployments: pages[i], pagination: { next: i + 1 < pages.length ? String(i + 1) : null } } };
  }
  return null;
};
const detail = map => url => {
  const m = /^\/v13\/deployments\/([^/]+)$/.exec(url.pathname);
  return m ? (map[m[1]] ? { status: 200, body: map[m[1]] } : { status: 404, body: { error: { message: 'LEAK-ME' } } }) : null;
};
const router = (...hs) => async url => { for (const h of hs) { const r = h(url); if (r) return r; } return { status: 404, body: {} }; };

test('no historical candidate constants remain in the diagnostic', () => {
  const src = fs.readFileSync('scripts/release/app-candidate-check.cjs', 'utf8');
  assert.ok(!/[0-9a-f]{40}/.test(src), 'no hard-coded SHA');
  assert.ok(!/dpl_[A-Za-z0-9]{10,}/.test(src), 'no hard-coded deployment id');
  assert.ok(!/CANDIDATE_SHA|TRIED/.test(src));
  assert.ok(/APP_RUNTIME_SHA/.test(src) && /assertExplicitRuntime/.test(src));
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'|\/promote|\/rollback\//.test(src), 'read-only');
});
test('diagnostic and release lane resolve the identical candidate for the same input', async () => {
  const page = [dep('dpl_one', OTHER), dep('dpl_target', SHA), dep('dpl_prod', 'c'.repeat(40), { target: 'production' })];
  const detailMap = { dpl_target: dep('dpl_target', SHA) };
  await withApi(router(listPages([page]), detail(detailMap)), async () => {
    const lane = await live.resolveCandidate(s, SHA);
    const r = await diag.check(s, SHA);
    assert.equal(lane.id, 'dpl_target');
    assert.equal(r.resolution, 'OK'); assert.equal(r.eligible, true); assert.equal(r.checks.sha_matches, true);
  });
});
test('a different SHA changes the answer; a wrong SHA is NOT_FOUND, never a historical fallback', async () => {
  await withApi(router(listPages([[dep('dpl_target', SHA)]]), detail({ dpl_target: dep('dpl_target', SHA) })), async () => {
    const r = await diag.check(s, OTHER);
    assert.equal(r.resolution, 'NOT_FOUND'); assert.equal(r.eligible, false); assert.equal(r.error, 'NOT_FOUND');
    await assert.rejects(live.resolveCandidate(s, OTHER), /No deployment found/);
  });
});
test('pagination: a candidate on page 3 is found; the cap reports truncation instead of "missing"', async () => {
  const pages = [[dep('d1', OTHER)], [dep('d2', OTHER)], [dep('dpl_target', SHA)]];
  await withApi(router(listPages(pages), detail({ dpl_target: dep('dpl_target', SHA) })), async () => {
    assert.equal((await diag.check(s, SHA)).eligible, true);
  });
  const many = Array.from({ length: 12 }, (_, i) => [dep('d' + i, OTHER)]);
  await withApi(router(listPages(many)), async () => {
    const r = await diag.check(s, SHA);
    assert.equal(r.list_truncated, true); assert.equal(r.error, 'LIST_TRUNCATED');
  });
});
test('ambiguous exact matches fail closed in both the diagnostic and the lane', async () => {
  const page = [dep('dpl_a', SHA), dep('dpl_b', SHA)];
  await withApi(router(listPages([page]), detail({ dpl_a: dep('dpl_a', SHA), dpl_b: dep('dpl_b', SHA) })), async () => {
    const r = await diag.check(s, SHA);
    assert.equal(r.resolution, 'AMBIGUOUS'); assert.equal(r.eligible, false); assert.equal(r.matches, 2);
    await assert.rejects(live.resolveCandidate(s, SHA), /Ambiguous candidates/);
  });
});
test('foreign-project and metadata-less deployments never match', async () => {
  const page = [dep('dpl_x', SHA, { projectId: 'prj_other' }), { uid: 'dpl_nometa', id: 'dpl_nometa', projectId: s.production_project, readyState: 'READY' }];
  await withApi(router(listPages([page])), async () => assert.equal((await diag.check(s, SHA)).resolution, 'NOT_FOUND'));
});
test('incompatible metadata on the authoritative read makes the candidate ineligible', async () => {
  const cases = {
    'not READY': dep('dpl_target', SHA, { readyState: 'BUILDING', state: 'BUILDING' }),
    'already production': dep('dpl_target', SHA, { target: 'production' }),
    'sha differs': dep('dpl_target', OTHER),
    'other project': dep('dpl_target', SHA, { projectId: 'prj_other' }),
  };
  for (const [label, d] of Object.entries(cases)) {
    await withApi(router(listPages([[dep('dpl_target', SHA)]]), detail({ dpl_target: d })), async () => {
      const r = await diag.check(s, SHA);
      assert.equal(r.eligible, false, label); assert.equal(r.error, 'NOT_ELIGIBLE', label);
    });
  }
});
test('HTTP errors, missing deployment and partial list responses fail safely without leaking bodies', async () => {
  await withApi(async () => ({ status: 403, body: { error: { message: 'LEAK-ME', token: 'unit-test-token' } } }), async () => {
    const r = await diag.check(s, SHA);
    assert.equal(r.error, 'HTTP_403'); assert.equal(r.eligible, false);
    assert.ok(!JSON.stringify(r).includes('LEAK-ME') && !JSON.stringify(r).includes('unit-test-token'));
  });
  await withApi(router(listPages([[dep('dpl_target', SHA)]]), detail({})), async () => {
    const r = await diag.check(s, SHA); assert.equal(r.error, 'HTTP_404'); assert.ok(!JSON.stringify(r).includes('LEAK-ME'));
  });
  await withApi(async () => ({ status: 200, body: { pagination: {} } }), async () => {
    assert.equal((await diag.check(s, SHA)).error, 'INCOMPLETE_RESPONSE');
  });
});
test('only GET requests are issued', async () => {
  await withApi(router(listPages([[dep('dpl_target', SHA)]]), detail({ dpl_target: dep('dpl_target', SHA) })), async (calls) => {
    await diag.check(s, SHA);
    assert.ok(calls.length >= 2 && calls.every(c => c.method === 'GET'));
    assert.ok(calls.every(c => !/promote|rollback/.test(c.url)));
  });
});
