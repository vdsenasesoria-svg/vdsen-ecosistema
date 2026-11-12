'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertAuthorizedMainSha, REVIEWED_MAIN_SHAS } = require('../scripts/pilot/ayrton-runtime.cjs');

test('T776-M1: current real main SHA (post-PR171) and historical baseline are authorized', () => {
  const currentMain = 'eee34ea6442381ef7af086d08f149445f347efb6';
  const historicalMain = 'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c';
  assert.equal(assertAuthorizedMainSha(currentMain), currentMain);
  assert.equal(assertAuthorizedMainSha(historicalMain), historicalMain);
  assert.ok(REVIEWED_MAIN_SHAS.includes(currentMain));
  assert.ok(REVIEWED_MAIN_SHAS.includes(historicalMain));
});

test('T776-M2: malformed, empty or keyword main SHAs are rejected fail-closed', () => {
  for (const bad of ['', null, undefined, 'latest', 'HEAD', 'main', 'eee34ea', 'eee34ea6442381ef7af086d08f149445f347efbZ']) {
    assert.throws(
      () => assertAuthorizedMainSha(bad),
      /INVALID_MAIN_SHA/,
      `expected INVALID_MAIN_SHA for: ${bad}`
    );
  }
});

test('T776-M3: foreign or unreviewed 40-character hex SHA is rejected fail-closed', () => {
  const foreignSha = '0000000000000000000000000000000000000001';
  assert.throws(
    () => assertAuthorizedMainSha(foreignSha),
    /UNAUTHORIZED_MAIN_SHA/,
    'must reject unreviewed 40-char hex SHA'
  );
});

test('T776-M4: expectedEnv matching main succeeds; mismatch or invalid env fails-closed', () => {
  const currentMain = 'eee34ea6442381ef7af086d08f149445f347efb6';
  // Matching env
  assert.equal(assertAuthorizedMainSha(currentMain, currentMain), currentMain);

  // Mismatched env
  const otherSha = '1111111111111111111111111111111111111111';
  assert.throws(
    () => assertAuthorizedMainSha(currentMain, otherSha),
    /MAIN_SHA_MISMATCH/
  );

  // Malformed env
  assert.throws(
    () => assertAuthorizedMainSha(currentMain, 'bad-env-sha'),
    /INVALID_EXPECTED_MAIN_SHA/
  );
});

test('T776-M5: extensibility allows incorporating new reviewed main SHA while keeping unauthorized SHAs blocked', () => {
  const futureReviewedSha = '2222222222222222222222222222222222222222';
  const foreignSha = '9999999999999999999999999999999999999999';

  // Before adding to extraReviewed: rejected
  assert.throws(() => assertAuthorizedMainSha(futureReviewedSha), /UNAUTHORIZED_MAIN_SHA/);

  // With extraReviewed: accepted
  assert.equal(assertAuthorizedMainSha(futureReviewedSha, undefined, [futureReviewedSha]), futureReviewedSha);

  // Foreign SHA is still rejected even when extraReviewed has entries
  assert.throws(() => assertAuthorizedMainSha(foreignSha, undefined, [futureReviewedSha]), /UNAUTHORIZED_MAIN_SHA/);
});

test('T776-M6: REVIEWED_MAIN_SHAS entries are all immutable 40-character hex strings', () => {
  assert.ok(Array.isArray(REVIEWED_MAIN_SHAS));
  assert.ok(REVIEWED_MAIN_SHAS.length >= 2);
  for (const sha of REVIEWED_MAIN_SHAS) {
    assert.match(sha, /^[a-f0-9]{40}$/);
  }
});
