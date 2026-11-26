'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const live = require('../scripts/release/app-live.cjs');

const s = { production_project: 'prj_x', vercel_team: 'team_x' };
const ID = 'dpl_HUA2tvx1RiYjkP2Egt6QjKrtQX2q';

test('T880 revertApp: HTTP 402 falls back to vercel promote of the exact target', async () => {
  let promoted = null;
  const r = await live.revertApp(s, ID, {
    post: async () => { throw new Error('API POST /v1/projects/x/rollback/y failed: HTTP 402'); },
    promoteViaCli: async (_s, id) => { promoted = id; return { ok: true, deploymentId: id }; },
    awaitApp: async () => true,
  });
  assert.equal(r, ID);
  assert.equal(promoted, ID);
});

test('T880 revertApp: non-402 errors fail closed without fallback', async () => {
  let called = false;
  await assert.rejects(live.revertApp(s, ID, {
    post: async () => { throw new Error('API POST x failed: HTTP 500'); },
    promoteViaCli: async () => { called = true; return { ok: true, deploymentId: ID }; },
    awaitApp: async () => true,
  }), /HTTP 500/);
  assert.equal(called, false);
});

test('T880 revertApp: fallback failure or no alias convergence all throw', async () => {
  const post = async () => { throw new Error('failed: HTTP 402'); };
  await assert.rejects(live.revertApp(s, ID, { post, promoteViaCli: async () => ({ ok: false, detail: 'nope' }), awaitApp: async () => true }), /fallback via vercel promote failed/);
  await assert.rejects(live.revertApp(s, ID, { post, promoteViaCli: async () => ({ ok: true, deploymentId: ID }), awaitApp: async () => false }), /did not converge/);
});
