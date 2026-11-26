'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const live = require('../scripts/release/app-live.cjs');

const s = { production_project: 'prj_x', vercel_team: 'team_x' };
const ID = 'dpl_HUA2tvx1RiYjkP2Egt6QjKrtQX2q';
const err402 = async () => { throw new Error('API POST /v1/projects/x/rollback/y failed: HTTP 402'); };

test('T880 revertApp: HTTP 402 falls back to the lane promote path for the exact target', async () => {
  let promoted = null;
  const r = await live.revertApp(s, ID, { post: err402, promote: async (_s, id) => { promoted = id; return id; }, awaitApp: async () => true });
  assert.equal(r, ID);
  assert.equal(promoted, ID);
});

test('T880 revertApp: non-402 errors fail closed without fallback', async () => {
  let called = false;
  await assert.rejects(live.revertApp(s, ID, {
    post: async () => { throw new Error('API POST x failed: HTTP 500'); },
    promote: async () => { called = true; },
    awaitApp: async () => true,
  }), /HTTP 500/);
  assert.equal(called, false);
});

test('T880 revertApp: promote failure or no alias convergence throws', async () => {
  await assert.rejects(live.revertApp(s, ID, { post: err402, promote: async () => { throw new Error('promote failed'); }, awaitApp: async () => true }), /promote failed/);
  await assert.rejects(live.revertApp(s, ID, { post: err402, promote: async () => ID, awaitApp: async () => false }), /did not converge/);
});
