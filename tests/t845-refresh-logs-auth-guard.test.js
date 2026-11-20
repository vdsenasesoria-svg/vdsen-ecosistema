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

function loadRefreshLogs(authCurrentUser, opts) {
  opts = opts || {};
  const fnSrc = extractFunction(CLIENT_HTML, 'async function _refreshLogsFromFirestore(');
  let getDocCalls = 0;
  const toasts = [];
  const sandbox = {
    USER: { uid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1' },
    ACTIVE_PLAN_ID: 'D5fVjlS3NysTD6Yg2ZpW',
    REAL_WEEK: 1,
    CURRENT_WEEK: 1,
    LOGS: {},
    _logsWriteInFlight: 0,
    _saveLogsTimer: null,
    _logsAuthorityUpdatedAt: 0,
    _remoteWeekSeen: 1,
    _rootLogUnbound: false,
    _isLegacyUnboundLog: () => false,
    _selectLogAuthority: (_local, remote) => remote,
    _remoteHasNews: () => false,
    _adoptRemoteLogs: () => {},
    _rebuildLogsByWeek: () => {},
    _rebuildLoadedHistoryReferences: () => {},
    _acceptSraPersisted: () => {},
    renderEntrenamiento: () => {},
    renderResumen: () => {},
    FB: {
      auth: { currentUser: authCurrentUser },
      db: {},
      doc: (_db, col, id) => ({ path: col + '/' + id }),
      getDoc: async () => {
        getDocCalls++;
        if (opts.succeed === true) {
          return {
            exists: () => true,
            data: () => ({ planId: 'D5fVjlS3NysTD6Yg2ZpW', currentWeek: 2, entries: {}, updatedAt: Date.now() }),
            metadata: { hasPendingWrites: false, fromCache: false }
          };
        }
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
    toasts,
    sandbox
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

test('T845.4 permission-denied with matching auth.currentUser.uid stays neutral and does NOT claim session changed/expired', async () => {
  const h = loadRefreshLogs({ uid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1' }, { succeed: false });
  await h.run();
  assert.equal(h.getDocCalls(), 1, 'Matching UID must attempt the normal Firestore read');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].isErr, true);
  assert.match(h.toasts[0].msg, /permisos|denegada/i, 'Error message must classify as permission/sync denial');
  assert.doesNotMatch(h.toasts[0].msg, /sesi[oó]n cambi[oó]|expir[oó]/i, 'Must NOT attribute permission-denied to session change/expiry when UID matches');
});

test('T845.5 Valid matching session preserves normal _refreshLogsFromFirestore sync behavior', async () => {
  const h = loadRefreshLogs({ uid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1' }, { succeed: true });
  await h.run();
  assert.equal(h.getDocCalls(), 1, 'Valid matching session must read logs/{uid}');
  assert.equal(h.toasts.length, 0, 'Successful sync must not show error toast');
  assert.equal(h.sandbox.REAL_WEEK, 2, 'Successful sync must adopt newer week from Firestore');
});
