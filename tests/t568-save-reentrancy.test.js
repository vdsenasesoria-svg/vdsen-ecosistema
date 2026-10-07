'use strict';
// T568 — Client Training: the save action must not accept a second tap while the first is
// still in flight, and the client must be able to SEE that it is saving.
//
// WHY (measured with the real app in a mobile viewport, not inferred)
// `completeSet` is async: it awaits `_doSaveLogs`, which performs dual writes. Measured before
// the fix, tapping GUARDAR SERIE twice in quick succession left `disabled=false` and the second
// tap entered the function while the first write was still in flight. The client also received
// no signal at all that the tap was being processed — no disabled state, no label change.
// The data survived that run only because the success path re-renders and advances the active
// set; the protection therefore rested on a race rather than a guarantee.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CLIENT = fs.readFileSync('vdsen-cliente.html', 'utf8');

function extract(name) {
  const start = CLIENT.indexOf(name);
  assert.ok(start > -1, 'no se encontro ' + name);
  let i = CLIENT.indexOf('{', start), depth = 0;
  for (let j = i; j < CLIENT.length; j++) {
    if (CLIENT[j] === '{') depth++;
    else if (CLIENT[j] === '}') { depth--; if (depth === 0) return CLIENT.slice(start, j + 1); }
  }
  throw new Error('llaves desbalanceadas en ' + name);
}

const SRC = extract('async function completeSet(');

// A DOM double with just enough shape for the reentrancy guard: a row that owns a save button.
function build(opts = {}) {
  const classes = new Set();
  const attrs = {};
  const btn = {
    disabled: !!opts.disabled,
    textContent: '✓ GUARDAR SERIE 1',
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
  const row = { querySelector: (sel) => (/completeSet/.test(sel) ? btn : null) };
  const doc = { getElementById: (id) => (id === 'setrow_log_1_0_0_s0' ? row : null) };
  return { btn, attrs, doc };
}

test('T568-1 an in-flight save disables the button and shows progress', () => {
  // Assert on the guard block directly: it must run before any async work.
  const guard = SRC.slice(SRC.indexOf('var _saveBtn'), SRC.indexOf('unit = getExUnit'));
  assert.ok(/_saveBtn\.disabled = true/.test(guard), 'debe deshabilitar el boton');
  assert.ok(/_saveBtn\.setAttribute\('aria-busy', 'true'\)/.test(guard), 'debe marcar aria-busy');
  assert.ok(/_saveBtn\.textContent = 'GUARDANDO…'/.test(guard), 'debe mostrar GUARDANDO');
  assert.ok(/button\[onclick\*="completeSet"\]/.test(guard), 'localiza el boton por su onclick');
  assert.ok(/_row \? _row\.querySelector/.test(guard), 'acotado a la fila de esta serie');
});

test('T568-2 a second tap while saving is refused', () => {
  assert.ok(/if \(_saveBtn && _saveBtn\.disabled\) return;/.test(SRC), 'guard de reentrada');
  // and the guard must come BEFORE the button is disabled, so it reads the pre-tap state
  const gi = SRC.indexOf('if (_saveBtn && _saveBtn.disabled) return;');
  const di = SRC.indexOf('_saveBtn.disabled = true');
  assert.ok(gi > -1 && di > -1 && gi < di, 'el guard se evalua antes de deshabilitar');
});

test('T568-3 the guard runs before the async write, not after', () => {
  const ai = SRC.indexOf('await _doSaveLogs()');
  const gi = SRC.indexOf('if (_saveBtn && _saveBtn.disabled) return;');
  assert.ok(ai > -1 && gi > -1, 'ambos existen');
  assert.ok(gi < ai, 'el guard precede al await: si no, el segundo toque ya entro');
});

test('T568-4 a FAILED save restores the button so the client can retry', () => {
  // On failure there is no re-render to rebuild the button, so leaving it disabled would strand
  // the client with no way to retry.
  const failBranch = SRC.slice(SRC.indexOf('if (_setSaved === false)'), SRC.indexOf('return false;', SRC.indexOf('if (_setSaved === false)')));
  assert.ok(/_saveBtn\.disabled = false/.test(failBranch), 'debe rehabilitar en el fallo');
  assert.ok(/_saveBtn\.removeAttribute\('aria-busy'\)/.test(failBranch), 'debe limpiar aria-busy');
  assert.ok(/GUARDAR /.test(failBranch), 'debe restaurar la etiqueta');
  assert.ok(/NO SE GUARDÓ/.test(failBranch), 'y sigue avisando del fallo');
});

test('T568-5 the failure message is still surfaced', () => {
  assert.ok(/showToast\('⚠ NO SE GUARDÓ — revisa conexión y reintenta', true\)/.test(CLIENT), 'el cliente debe saber que fallo');
});

test('T568-6 success feedback still exists (no regression)', () => {
  assert.ok(/showToast\('Serie ✓ — descansando'\)/.test(CLIENT), 'confirmacion de exito intacta');
});

test('T568-7 the guard is defensive: a missing button must not break saving', () => {
  // The guard must be able to fail closed to "no guard" rather than throw, otherwise a layout
  // change would break the core action.
  assert.ok(/try \{[\s\S]{0,200}?_saveBtn = _row \? _row\.querySelector[\s\S]{0,80}?catch \(_e\) \{ _saveBtn = null; \}/.test(SRC),
    'la busqueda del boton esta protegida');
  assert.ok(/if \(_saveBtn\) \{/.test(SRC), 'el feedback solo se aplica si el boton existe');
});

test('T568-8 the change does not touch the data contract', () => {
  // UI only: no new field, no changed key, no extra write.
  const guard = SRC.slice(SRC.indexOf('var _saveBtn'), SRC.indexOf('unit = getExUnit'));
  assert.ok(!/setDoc|updateDoc|LOGS\[/.test(guard), 'el guard no escribe datos');
  assert.ok(!/prescriptionExerciseId|rir_real|ics|pump/.test(guard), 'no toca campos del log');
});

test('T568-9 NUMERIC_APPLY_ENABLED sigue en false', () => {
  for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false, m);
  }
});
