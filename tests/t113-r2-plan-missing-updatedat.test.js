/**
 * QA-R2-02: Plans created via saveManualPlan / saveImportedPlan have no updatedAt.
 *
 * The client plan listener (vdsen-cliente.html ~line 1706) guards:
 *   if (!updatedAt) return;   // plan sin timestamp → ignorar
 *   if (!FB._planLastUpdatedAt) { FB._planLastUpdatedAt = updatedAt; return; } // guardar baseline
 *
 * Consequence: when a plan doc has no updatedAt, the listener never sets the baseline.
 * The first in-place coach edit (which DOES include updatedAt) sets the baseline and
 * returns without triggering a reload.  Only the SECOND edit actually notifies the client.
 *
 * Root cause: addDoc calls in saveManualPlan and saveImportedPlan do not include updatedAt.
 */

const fs = require('fs');
const path = require('path');

const COACH   = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'),   'utf8');
const CLIENT  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

// ── Helper: extract function body by name ────────────────────────────────────
function extractFunction(source, asyncPrefix, name) {
  const re = new RegExp(`${asyncPrefix ? 'async ' : ''}function ${name}\\s*\\(`);
  const m  = re.exec(source);
  if (!m) return null;
  let depth = 0, start = null;
  for (let i = m.index; i < source.length; i++) {
    if (source[i] === '{') { if (start === null) start = i; depth++; }
    else if (source[i] === '}') { if (--depth === 0 && start !== null) return source.slice(start, i + 1); }
  }
  return null;
}

// ── Test 1: saveManualPlan uses addDoc without updatedAt ──────────────────────
test('saveManualPlan: addDoc call does not include updatedAt', () => {
  const body = extractFunction(COACH, true, 'saveManualPlan');
  expect(body).not.toBeNull();

  // Find the addDoc(...) call
  const addDocIdx = body.indexOf('addDoc(');
  expect(addDocIdx).toBeGreaterThan(-1);

  // Extract the object literal passed to addDoc
  const addDocChunk = body.slice(addDocIdx, addDocIdx + 600);

  // createdAt IS present (good)
  expect(addDocChunk).toMatch(/createdAt/);

  // updatedAt is missing from the addDoc payload (the bug)
  // This assertion FAILS, documenting the gap.
  expect(addDocChunk).toMatch(/updatedAt/); // FAILS: updatedAt not present in addDoc call
});

// ── Test 2: saveImportedPlan uses addDoc without updatedAt ────────────────────
test('saveImportedPlan: addDoc call does not include updatedAt', () => {
  const body = extractFunction(COACH, true, 'saveImportedPlan');
  expect(body).not.toBeNull();

  const addDocIdx = body.indexOf('addDoc(');
  expect(addDocIdx).toBeGreaterThan(-1);

  const addDocChunk = body.slice(addDocIdx, addDocIdx + 600);
  expect(addDocChunk).toMatch(/createdAt/);
  // This assertion FAILS, documenting the gap.
  expect(addDocChunk).toMatch(/updatedAt/); // FAILS: updatedAt not present in addDoc call
});

// ── Test 3: Client plan listener silently ignores plans without updatedAt ─────
test('client plan listener: returns immediately when updatedAt is empty', () => {
  // Verify the guard exists in the client source
  expect(CLIENT).toMatch(/if\s*\(\s*!updatedAt\s*\)\s*return/);
  // If plans have no updatedAt, the listener is permanently disabled for that plan doc.
  // Combined with the addDoc findings above, any manually-created or imported plan
  // will have its first real-time coach edit silently invisible to the client.
});

// ── Test 4: Baseline capture prevents first edit from triggering reload ───────
test('client plan listener: first edit after no-updatedAt plan sets baseline and returns', () => {
  // The baseline guard: if (!FB._planLastUpdatedAt) { FB._planLastUpdatedAt = updatedAt; return; }
  // When the plan was loaded without updatedAt, _planLastUpdatedAt was never set.
  // First edit sets _planLastUpdatedAt = new value, returns without reload.
  expect(CLIENT).toMatch(/if\s*\(\s*!FB\._planLastUpdatedAt\s*\)/);
  // This confirms the behavior is real and the first edit is always skipped
  // when the plan was initially created without updatedAt.
});
