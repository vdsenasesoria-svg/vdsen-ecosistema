// T554: ICS / Pump of the previous set must NEVER silently become the next set's value (untouched must stay absent). The only carry is the explicit "=" copy button.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');
test('T554.1 the live set card derives ICS and Pump ONLY from the set own saved record', () => {
  assert.ok(!/_prevSesIcs/.test(SRC), 'no previous-set ICS default');
  assert.ok(!/_prevSesPump/.test(SRC), 'no previous-set Pump default');
  assert.ok(/var _icsVal = saved\.ics \|\| '';/.test(SRC), 'ICS input value = saved.ics only');
  assert.ok(/var _initPump = saved\.pump \|\| null;/.test(SRC), 'Pump selection = saved.pump only');
});
test('T554.2 the explicit "=" copy action still exists (the only legitimate carry)', () => {
  assert.ok(/function copiarSerie\(/.test(SRC) && /onclick="copiarSerie\(/.test(SRC));
});
test('T554.3 no other previous-set default feeds the load / reps / RIR inputs of an unsaved set', () => {
  assert.ok(!/_prevSesCarga|_prevSesReps|_prevSesRir/.test(SRC.replace(/var _prevSes(Carga|Reps|Rir)\s*=[^\n]*\n/g, '')), 'the computed-but-unused previous-set load / reps / RIR defaults are not wired into any input');
});
test('T554.4 nutrition tab: the kcal fallback needs REAL numeric macros (an empty plan must not render "NaN kcal")', () => {
  assert.ok(/isFinite\(parseFloat\(prot\)\) && isFinite\(parseFloat\(carb\)\) && isFinite\(parseFloat\(gras\)\)/.test(SRC));
  assert.ok(/!isFinite\(parseFloat\(kcal\)\)\) kcal = '—';/.test(SRC));
});
