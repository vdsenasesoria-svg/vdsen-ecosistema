'use strict';
// T845: Reproduce and verify fix for _refreshLogsFromFirestore permission-denied when
// Firebase Auth currentUser is null or switched to a different UID on the same origin,
// and ensure onAuthStateChanged clears USER when signed out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT_HTML = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, 'Missing function: ' + signature);
  let depth = 0, started = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('Unterminated function: ' + signature);
}

function loadRefreshLogs(authCurrentUser) {
  const fnSrc = extractFunction(CLIENT_HTML, 'async function _refreshLogsFromFirestore(');
  let getDocCalls = 0;
  const toasts = [];
  const sandbox = {
    USER: { uid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1' },
    ACTIVE_PLAN_ID: 'D5fVjlS3NysTD6Yg2ZpW',
    _logsWriteInFlight: 0,
    FB: {
      auth: { currentUser: authCurrentUser },
      db: {},
      doc: (_db, col, id) => ({ path: col + '/' + id }),
      getDoc: async () => {
        getDocCalls++;
        const err = new Error('Missing or insufficient permissions.');
        err.code = 'permission-denied';
        throw err;
      }
    },
    showToast: (msg, isErr) => { toasts.push({ msg, isErr: !!isErr }); },
    console: { warn: () => {} }
  };
  vm.runInNewContext(fnSrc + '\nthis._refreshLogsFromFirestore = _refreshLogsFromFirestore;', sandbox);
  return {
    run: () => sandbox._refreshLogsFromFirestore('visibilitychange'),
    getDocCalls: () => getDocCalls,
    toasts
  };
}

test('T845.1 _refreshLogsFromFirestore aborts BEFORE calling Firestore when FB.auth.currentUser is null', async () => {
  const h = loadRefreshLogs(null);
  await h.run();
  assert.equal(h.getDocCalls(), 0, 'Must not call FB.getDoc when auth.currentUser is null');
  assert.ok(h.toasts.some((t) => t.isErr && /sesi[oó]n/i.test(t.msg)), 'Should inform user that session changed/expired');
});

test('T845.2 _refreshLogsFromFirestore aborts BEFORE calling Firestore when FB.auth.currentUser.uid !== USER.uid', async () => {
  const h = loadRefreshLogs({ uid: 'other-uid-on-same-origin' });
  await h.run();
  assert.equal(h.getDocCalls(), 0, 'Must not call FB.getDoc when auth.currentUser.uid mismatches USER.uid');
  assert.ok(h.toasts.some((t) => t.isErr && /sesi[oó]n/i.test(t.msg)), 'Should inform user of session mismatch');
});

test('T845.3 onAuthStateChanged sign-out branch clears USER = null to prevent stale memory identity', () => {
  const idx = CLIENT_HTML.indexOf('FB.onAuthStateChanged(FB.auth, async (user) => {');
  assert.ok(idx > 0, 'onAuthStateChanged block not found');
  const block = CLIENT_HTML.slice(idx, idx + 1200);
  const elseIdx = block.indexOf('} else {');
  assert.ok(elseIdx > 0, 'onAuthStateChanged else branch not found');
  const elseBlock = block.slice(elseIdx, elseIdx + 260);
  assert.match(elseBlock, /\bUSER\s*=\s*null\b/, 'onAuthStateChanged else branch must clear USER = null');
});
