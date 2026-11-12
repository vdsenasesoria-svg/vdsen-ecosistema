'use strict';
// T556: detailed mode (one form per set) and the rest timer are ON by default unless the athlete turns them off in Perfil; the header says COACH AYRTON next to VDSEN.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name) { const i = SRC.indexOf('function ' + name + '('); assert.ok(i > -1, name); let d = 0; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}' && --d === 0) return SRC.slice(i, k + 1); } }
function sandbox(store) { const ctx = { localStorage: { getItem: k => (k in store ? store[k] : null) } }; vm.createContext(ctx); vm.runInContext(fnSrc('isExpressDisabled') + '\n' + fnSrc('isRestTimerDisabled') + '\nthis.e=isExpressDisabled;this.t=isRestTimerDisabled;', ctx); return ctx; }
test('T556.1 detailed mode is the default: unset -> per-set forms; only an explicit "0" (turned off in Perfil) brings Express back', () => {
  assert.equal(sandbox({}).e(), true, 'default = detailed (Express disabled)'); assert.equal(sandbox({ vdsen_express_off: '1' }).e(), true); assert.equal(sandbox({ vdsen_express_off: '0' }).e(), false);
});
test('T556.2 the rest timer is active by default; only an explicit "1" (turned off in Perfil) disables it', () => {
  assert.equal(sandbox({}).t(), false); assert.equal(sandbox({ vdsen_timer_off: '0' }).t(), false); assert.equal(sandbox({ vdsen_timer_off: '1' }).t(), true);
});
test('T556.3 the Perfil switches still turn them off / on (settings are the only way to change the default)', () => {
  assert.ok(/function setExpressDisabled\(off\)/.test(SRC) && /function setRestTimerDisabled\(off\)/.test(SRC));
  assert.ok(/Modo detallado/.test(SRC) && /Temporizador de descanso/.test(SRC));
});
test('T556.4 the header shows COACH AYRTON beside the VDSEN wordmark (and keeps PERFORMANCE SYSTEM)', () => {
  assert.ok(/<div class="brand-line"><span class="brand-word">VDSEN<i><\/i><\/span><span class="brand-coach">COACH AYRTON<\/span><\/div><span class="brand-sub">Performance System<\/span>/.test(SRC));
  assert.ok(/\.brand-coach\{[^}]*white-space:nowrap/.test(SRC));
});
