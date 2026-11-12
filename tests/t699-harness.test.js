'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyntheticTrigger } = require('./helpers/t699-synthetic-executor');

test('isolated trigger composition preserves authentication and uses verified identity', async () => {
  const calls = [];
  const executor = { async processProgression(input) { calls.push(input); return { status: 'NO_CHANGE', created: [], applied: [], consumed: [] }; } };
  const handler = createSyntheticTrigger(executor, {}).makeHandler({ enabled: true, numericApplyEnabled: true,
    verifyIdToken: async token => { if (token !== 'accepted') throw Error('invalid'); return { uid: 'verified-synthetic' }; }, log() {} });
  const response = () => ({ status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; }, setHeader() {} });
  for (const header of [undefined, 'Bearer rejected']) {
    const res = response(); await handler({ method: 'POST', headers: { authorization: header }, body: { planId: 'plan', clientId: 'forged' } }, res);
    assert.equal(res.code, 401); assert.equal(calls.length, 0);
  }
  const res = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer accepted' }, body: { planId: 'plan', clientId: 'forged' } }, res);
  assert.equal(res.code, 200); assert.equal(calls.length, 1);
  assert.equal(calls[0].clientId, 'verified-synthetic'); assert.equal(calls[0].planId, 'plan');
});
