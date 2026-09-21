'use strict';

var A = require('./vdsen-auth');
var extractBearerToken       = A.extractBearerToken;
var authenticateCoachRequest = A.authenticateCoachRequest;
var ERR = A.ERR;

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var ALWAYS_OK_DEPS = {
  verifyIdToken:     function(token) { return Promise.resolve({ uid: 'coach-abc' }); },
  isAuthorizedCoach: function(uid)   { return Promise.resolve(true); }
};

// ─── extractBearerToken ─────────────────────────────────────────────────────

test('extractBearerToken: extracts token from well-formed header', function() {
  return extractBearerToken('Bearer abc.def.ghi') === 'abc.def.ghi';
});

test('extractBearerToken: null for missing header', function() {
  return extractBearerToken(null) === null && extractBearerToken(undefined) === null;
});

test('extractBearerToken: null for empty string', function() {
  return extractBearerToken('') === null;
});

test('extractBearerToken: null for wrong scheme (Basic)', function() {
  return extractBearerToken('Basic dXNlcjpwYXNz') === null;
});

test('extractBearerToken: null for "Bearer" with no token', function() {
  return extractBearerToken('Bearer') === null && extractBearerToken('Bearer ') === null;
});

test('extractBearerToken: null for non-string input', function() {
  return extractBearerToken(12345) === null && extractBearerToken({}) === null;
});

test('extractBearerToken: case-sensitive scheme ("bearer" lowercase rejected)', function() {
  return extractBearerToken('bearer abc.def.ghi') === null;
});

// ─── authenticateCoachRequest ───────────────────────────────────────────────

test('authenticateCoachRequest: missing header → 401 AUTH_MISSING', async function() {
  var r = await authenticateCoachRequest(null, ALWAYS_OK_DEPS);
  return r.ok === false && r.status === 401 && r.errorCode === ERR.AUTH_MISSING;
});

test('authenticateCoachRequest: empty-string header → 401 AUTH_MISSING', async function() {
  var r = await authenticateCoachRequest('   ', ALWAYS_OK_DEPS);
  return r.ok === false && r.status === 401 && r.errorCode === ERR.AUTH_MISSING;
});

test('authenticateCoachRequest: malformed header → 401 AUTH_MALFORMED', async function() {
  var r = await authenticateCoachRequest('Basic xyz', ALWAYS_OK_DEPS);
  return r.ok === false && r.status === 401 && r.errorCode === ERR.AUTH_MALFORMED;
});

test('authenticateCoachRequest: verifyIdToken throws → 401 AUTH_INVALID', async function() {
  var deps = { verifyIdToken: function() { return Promise.reject(new Error('bad sig')); } };
  var r = await authenticateCoachRequest('Bearer sometoken', deps);
  return r.ok === false && r.status === 401 && r.errorCode === ERR.AUTH_INVALID;
});

test('authenticateCoachRequest: verifyIdToken resolves with no uid → 401 AUTH_INVALID', async function() {
  var deps = { verifyIdToken: function() { return Promise.resolve({}); } };
  var r = await authenticateCoachRequest('Bearer sometoken', deps);
  return r.ok === false && r.status === 401 && r.errorCode === ERR.AUTH_INVALID;
});

test('authenticateCoachRequest: valid token + authorized coach → ok:true with uid', async function() {
  var r = await authenticateCoachRequest('Bearer sometoken', ALWAYS_OK_DEPS);
  return r.ok === true && r.uid === 'coach-abc';
});

test('authenticateCoachRequest: valid token + isAuthorizedCoach=false → 403 AUTH_FORBIDDEN', async function() {
  var deps = {
    verifyIdToken:     function() { return Promise.resolve({ uid: 'stranger' }); },
    isAuthorizedCoach: function() { return Promise.resolve(false); }
  };
  var r = await authenticateCoachRequest('Bearer sometoken', deps);
  return r.ok === false && r.status === 403 && r.errorCode === ERR.AUTH_FORBIDDEN;
});

test('authenticateCoachRequest: isAuthorizedCoach throwing fails closed (never ok:true)', async function() {
  var deps = {
    verifyIdToken:     function() { return Promise.resolve({ uid: 'coach-abc' }); },
    isAuthorizedCoach: function() { return Promise.reject(new Error('Firestore down')); }
  };
  var r = await authenticateCoachRequest('Bearer sometoken', deps);
  return r.ok === false;
});

test('authenticateCoachRequest: no isAuthorizedCoach provided → authentication-only (ok:true on valid token)', async function() {
  var deps = { verifyIdToken: function() { return Promise.resolve({ uid: 'coach-abc' }); } };
  var r = await authenticateCoachRequest('Bearer sometoken', deps);
  return r.ok === true && r.uid === 'coach-abc';
});

test('authenticateCoachRequest: never echoes the raw token in its result object', async function() {
  var secretToken = 'super-secret-token-value';
  var r = await authenticateCoachRequest('Bearer ' + secretToken, ALWAYS_OK_DEPS);
  return JSON.stringify(r).indexOf(secretToken) === -1;
});

test('authenticateCoachRequest: body-supplied identity is irrelevant — only the injected verifier decides uid', async function() {
  // Simulates a caller trying to "forge" identity via extra deps fields; the
  // function signature doesn't even accept a body/uid argument, so there is
  // no code path by which anything but deps.verifyIdToken's own resolution
  // can produce the returned uid.
  var deps = {
    verifyIdToken:     function() { return Promise.resolve({ uid: 'real-verified-uid' }); },
    isAuthorizedCoach: function() { return Promise.resolve(true); },
    uid: 'attacker-supplied-uid' // not a real param this function reads
  };
  var r = await authenticateCoachRequest('Bearer sometoken', deps);
  return r.uid === 'real-verified-uid';
});

// ─── Run ─────────────────────────────────────────────────────────────────────

async function runTests() {
  var passed = 0;
  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    try {
      var ok = await t.fn();
      if (ok) { passed++; console.log('✅ ' + t.name); }
      else { console.log('❌ ' + t.name + '\n   → returned false/falsy'); }
    } catch (e) {
      console.log('❌ ' + t.name + '\n   → ' + e.message);
    }
  }
  console.log('\n' + passed + '/' + tests.length + ' passed');
  process.exit(passed === tests.length ? 0 : 1);
}

runTests();
