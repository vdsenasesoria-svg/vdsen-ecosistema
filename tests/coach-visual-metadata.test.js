'use strict';
// Visual metadata editor — assetRef validation.
//
// This is the integration point that made uploads impossible before: assetRef was routed through
// mediaUrl(), which does not accept `exercise-media/...`, so saving an uploaded image threw. These cases
// pin the three accepted shapes and prove the change did NOT broaden into arbitrary paths.
const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../assets/exercise-visual-metadata-editor.js');
const COACH_A = 'coachA000000000000000001';

test('assetRef accepts a canonical managed Storage path', () => {
  const p = 'exercise-media/' + COACH_A + '/exA/image-' + 'a'.repeat(16);
  assert.equal(M.assetRef(p), p);
  assert.equal(M.isStorageRef(p), true);
});

test('assetRef accepts a legacy assets/ reference and an empty value', () => {
  assert.equal(M.assetRef('assets/img/foto.png'), 'assets/img/foto.png');
  assert.equal(M.assetRef(''), '');
  assert.equal(M.assetRef(null), '');
});

test('assetRef REJECTS arbitrary paths, traversal and free-form strings', () => {
  const bad = [
    'otra-carpeta/x/image-aaaaaaaaaaaaaaaa',
    'exercise-media/../evil/exA/image-aaaaaaaaaaaaaaaa',
    'exercise-media/' + COACH_A + '/exA/notimage.png',
    'exercise-media/' + COACH_A + '/exA/image-ZZZZ',
    '/etc/passwd',
    'https://cdn.example.com/a.jpg',   // an external URL belongs in imageUrl, not assetRef
    'javascript:alert(1)',
  ];
  for (const v of bad) {
    assert.throws(() => M.assetRef(v), /no es válida|debe ser un objeto gestionado/, 'should reject: ' + v);
  }
});

test('imageUrl keeps its strict HTTPS / asset rule and still rejects a Storage path', () => {
  assert.equal(M.mediaUrl('https://cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
  assert.equal(M.mediaUrl('assets/img/a.png'), 'assets/img/a.png');
  assert.equal(M.mediaUrl(''), '');
  assert.throws(() => M.mediaUrl('http://insecure.example.com/a.jpg'), /URL HTTPS|asset local/);
  assert.throws(() => M.mediaUrl('exercise-media/' + COACH_A + '/exA/image-aaaaaaaaaaaaaaaa'), /URL HTTPS|asset local/);
});

test('buildPatch persists an uploaded image end to end', () => {
  const p = 'exercise-media/' + COACH_A + '/exA/image-' + 'b'.repeat(16);
  const patch = M.buildPatch({
    gym: 'San Diego', equipment: 'Mancuernas', assetRef: p, imageUrl: 'https://firebasestorage.example/o/x?token=1',
    instructions: 'i', setup: 's', execution: 'e', technicalObjective: 'o', commonErrors: 'a\nb', variants: '[]',
  });
  assert.equal(patch.assetRef, p);
  assert.match(patch.imageUrl, /^https:\/\//);
});

test('buildPatch still refuses HTML in free text', () => {
  assert.throws(() => M.buildPatch({ gym: '<script>x</script>' }), /no admite HTML/);
});
