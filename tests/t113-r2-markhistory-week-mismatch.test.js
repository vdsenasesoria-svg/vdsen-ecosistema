/**
 * QA-R2-01: markSessionDoneFromHistory uses REAL_WEEK for done_/postsession_/progrec_
 * while log entries are written under CURRENT_WEEK.
 *
 * When CURRENT_WEEK < REAL_WEEK (user is reviewing a past week) and the user clicks
 * "Copiar sem. anterior", the function fills log entries for the past week but
 * marks done_ / postsession_ / progrec_ for REAL_WEEK (the active week), which is
 * incorrect. This can silently mark the wrong week as complete and trigger
 * premature auto-advancement.
 *
 * This is a STATIC analysis test — it verifies the source code contains the mismatch.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'vdsen-cliente.html'),
  'utf8'
);

// ── Helper: extract a function's body by scanning for balanced braces ────────
function extractFunctionBody(source, funcName) {
  const sigRe = new RegExp(`async function ${funcName}\\s*\\(`);
  const sigMatch = sigRe.exec(source);
  if (!sigMatch) return null;

  let depth = 0;
  let start = null;
  for (let i = sigMatch.index; i < source.length; i++) {
    if (source[i] === '{') {
      if (start === null) start = i;
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0 && start !== null) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ── Test 1: markSessionDoneFromHistory writes log entries with CURRENT_WEEK ──
test('markSessionDoneFromHistory: log entry keys use CURRENT_WEEK', () => {
  const body = extractFunctionBody(SOURCE, 'markSessionDoneFromHistory');
  expect(body).not.toBeNull();
  // Should contain CURRENT_WEEK in log_ key construction
  expect(body).toMatch(/['"`]log_['"`]\s*\+\s*CURRENT_WEEK/);
});

// ── Test 2: markSessionDoneFromHistory writes done_ key with REAL_WEEK ────────
test('markSessionDoneFromHistory: done_ key uses REAL_WEEK (mismatch vs log entries)', () => {
  const body = extractFunctionBody(SOURCE, 'markSessionDoneFromHistory');
  expect(body).not.toBeNull();
  // done_ key uses REAL_WEEK — mismatches the CURRENT_WEEK used for log entries
  expect(body).toMatch(/['"`]done_['"`]\s*\+\s*REAL_WEEK/);
});

// ── Test 3: verify the mismatch — both CURRENT_WEEK and REAL_WEEK appear ─────
test('markSessionDoneFromHistory: contains both CURRENT_WEEK and REAL_WEEK (potential mismatch)', () => {
  const body = extractFunctionBody(SOURCE, 'markSessionDoneFromHistory');
  expect(body).not.toBeNull();
  const hasCurrent = /CURRENT_WEEK/.test(body);
  const hasReal    = /REAL_WEEK/.test(body);
  // If both appear, the function may write to inconsistent week keys.
  // Expected: all writes should use the SAME week variable.
  if (hasCurrent && hasReal) {
    // Describe the mismatch to help the fixer
    const logKeyLine   = body.match(/['"`]log_['"`]\s*\+\s*(CURRENT_WEEK|REAL_WEEK)/)?.[1] ?? 'not found';
    const doneKeyLine  = body.match(/['"`]done_['"`]\s*\+\s*(CURRENT_WEEK|REAL_WEEK)/)?.[1] ?? 'not found';
    const postKeyLine  = body.match(/['"`]postsession_['"`]\s*\+\s*(CURRENT_WEEK|REAL_WEEK)/)?.[1] ?? 'not found';
    const progRecLine  = body.match(/['"`]progrec_['"`]\s*\+\s*(CURRENT_WEEK|REAL_WEEK)/)?.[1] ?? 'not found';
    // Document the mismatch as a failing assertion
    expect({
      logEntries: logKeyLine,
      doneKey:    doneKeyLine,
      postsession: postKeyLine,
      progrec:    progRecLine,
    }).toEqual({
      // All should use the same variable. Currently done_/postsession_/progrec_ use REAL_WEEK
      // while log entries use CURRENT_WEEK. Fix: use CURRENT_WEEK throughout, OR add a
      // guard that prevents this function from being called when CURRENT_WEEK < REAL_WEEK.
      logEntries:  'CURRENT_WEEK',
      doneKey:     'CURRENT_WEEK', // <-- FAILS: actual is REAL_WEEK
      postsession: 'CURRENT_WEEK', // <-- FAILS: actual is REAL_WEEK
      progrec:     'CURRENT_WEEK', // <-- FAILS: actual is REAL_WEEK
    });
  }
});

// ── Test 4: "Copiar sem. anterior" button lacks past-week guard ───────────────
test('"Copiar sem. anterior" button has no CURRENT_WEEK === REAL_WEEK guard', () => {
  // The button should only be available when the user is on the active week.
  // Current code: shown when CURRENT_WEEK > 1 (no check that CURRENT_WEEK === REAL_WEEK)
  // Line where button is rendered — check it does NOT already include the guard.
  const historyBtnIdx = SOURCE.indexOf('markSessionDoneFromHistory');
  expect(historyBtnIdx).toBeGreaterThan(-1);

  // Grab surrounding context (500 chars before the button onclick)
  const context = SOURCE.slice(Math.max(0, historyBtnIdx - 300), historyBtnIdx + 100);

  // The skip button (line 6712) DOES have CURRENT_WEEK === REAL_WEEK guard.
  // The history button should have it too but currently does NOT.
  const hasRealWeekGuard = /CURRENT_WEEK\s*===\s*REAL_WEEK/.test(context);
  // This assertion documents the missing guard (expected: true, actual: false)
  expect(hasRealWeekGuard).toBe(true); // FAILS: guard is missing
});
