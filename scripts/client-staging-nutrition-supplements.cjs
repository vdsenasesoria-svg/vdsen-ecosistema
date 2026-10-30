'use strict';
// T557 (closure): DISPLAY smoke of the Coach-authored NUTRITION and SUPPLEMENT plans in the Client (display only: no tracking is verified or required).
// Fixtures are produced by the Coach's OWN converters (_nutritionJsonToPlan / _supplementsJsonToPlan, extracted from vdsen-coach.html), written to the AUTOMATION
// athlete's client doc by its owner Coach, then rendered by the real Client build on staging. States: populated / long text / partial / empty; 390 + 320 + light.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_TRAIN_KEEP=<creds json outside repo> node scripts/client-staging-nutrition-supplements.cjs [--shots dir] [--out file] [--only state] [--leave]
const fs = require('node:fs'), vm = require('node:vm'); const L = require('./client-staging-real-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null); const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const coachSrc = fs.readFileSync(require('node:path').join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
function fnSrc(src, name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('missing ' + name); let d = 0, q = null, esc = false; for (let k = src.indexOf('{', i); k < src.length; k++) { const c = src[k]; if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; } if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; } if (c === '"' || c === "'" || c === '`') { q = c; continue; } if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(i, k + 1); } throw new Error('unbalanced ' + name); }
const cctx = { String, Number, Array, Object, isNaN, Math }; vm.createContext(cctx); vm.runInContext(fnSrc(coachSrc, '_nutritionJsonToPlan') + '\n' + fnSrc(coachSrc, '_supplementsJsonToPlan') + '\nthis.n=_nutritionJsonToPlan;this.s=_supplementsJsonToPlan;', cctx);
const J = o => JSON.parse(JSON.stringify(o));
const meal = (n, nombre, hora, alimentos, prep, supl) => ({ numero: n, nombre, horario_sugerido: hora, alimentos, kcal: 534, macros: { proteina_g: 38, carbohidratos_g: 64, grasa_g: 14 }, preparacion: prep, suplementos_con_comida: supl || [] });
const RAW = { calorias: 2670, proteina: 190, carbos: 320, grasas: 70, calculos: { kcal_objetivo: 2670 }, metadata: { objetivo: 'Hipertrofia', fecha_creacion: '2026-09-27' },
  comidas: [
    meal(1, 'Desayuno', '07:00', [{ nombre: 'Avena en hojuelas', cantidad: '80 g' }, { nombre: 'Claras de huevo', cantidad: '250 ml' }, { nombre: 'Plátano', cantidad: '1 pieza (120 g)' }, { nombre: 'Crema de cacahuate', cantidad: '15 g' }], 'Cocer la avena con las claras a fuego bajo; el plátano al final.', [{ nombre: 'Vitamina D3', dosis: '2000 UI' }]),
    meal(2, 'Colación AM', '10:30', [{ nombre: 'Yogurt griego natural', cantidad: '200 g' }, { nombre: 'Fresas', cantidad: '120 g' }, { nombre: 'Whey Isolate', cantidad_g: 25 }]),
    meal(3, 'Comida', '14:00', [{ nombre: 'Pechuga de pollo cocida [SUST: Tilapia 180 g | Atún en agua 160 g | Pavo molido 170 g]', cantidad: '200 g' }, { nombre: 'Arroz blanco cocido', cantidad: '250 g' }, { nombre: 'Brócoli al vapor', cantidad: '150 g' }, { nombre: 'Aceite de oliva extra virgen', cantidad: '10 ml' }], 'Sazonar con sal, limón y pimienta; pesar los alimentos en cocido.'),
    meal(4, 'Pre-entreno', '17:30', [{ nombre: 'Tortilla de maíz', cantidad: '3 piezas (90 g)' }, { nombre: 'Pavo en rebanadas', cantidad: '120 g' }, { nombre: 'Miel', cantidad: '15 g' }]),
    meal(5, 'Cena', '21:00', [{ nombre: 'Filete de res magro', cantidad: '180 g' }, { nombre: 'Camote horneado', cantidad: '220 g' }, { nombre: 'Ensalada verde con pepino y jitomate', cantidad: '1 plato grande' }, { nombre: 'Aguacate', cantidad: '40 g' }], 'Hornear el camote 40 min a 200 °C.')],
  assumptions: ['Pesos en cocido salvo indicación', 'Actividad: 9 000 pasos diarios'], monitoreo: { metrica_primaria: 'Peso semanal promedio', frecuencia_revision_dias: 14, ajuste_si_no_progresa: 'Subir 150 kcal desde carbohidratos' } };
const LONGNOTE = 'Tomar siempre con una comida que contenga grasa para mejorar la absorción; si hay molestias gástricas, dividir la dosis en dos tomas (mañana y tarde) y avisar al coach en el check-in semanal para ajustar la forma o la marca del suplemento.';
const SUP = { tiers: [{ nombre: 'TIER 1 — Base', items: [{ nombre: 'Creatina monohidrato', dosis: '5 g', timing: 'Post-entreno', nota: 'Todos los días, también en descanso' }, { nombre: 'Omega-3', dosis: '2 g EPA+DHA', timing: 'Con la comida', nota: LONGNOTE }, { nombre: 'Vitamina D3', dosis: '2000 UI', timing: 'Con el desayuno' }] }, { nombre: 'PRE-ENTRENO', items: [{ nombre: 'Cafeína', dosis: '200 mg', timing: '30 min antes de entrenar', nota: 'No tomar después de las 18:00' }] }, { nombre: 'EVITAR', items: [{ nombre: 'Quemadores termogénicos', nota: 'Interfieren con el sueño' }] }] };
const STATES = {
  populated: { nutritionPlan: cctx.n(J(RAW)), supplementPlan: cctx.s(J(SUP)) },
  longtext: { nutritionPlan: (() => { const r = J(RAW); r.comidas[2].alimentos[0].nombre = 'Pechuga de pollo cocida a la plancha con ajo, limón, orégano y pimienta negra recién molida, sin piel [SUST: Tilapia a la plancha con hierbas finas 180 g | Atún en agua escurrido 160 g | Pavo molido magro 170 g]'; r.comidas[1].preparacion = 'Mezclar el yogurt con la whey hasta integrar por completo, añadir la fruta cortada en cubos pequeños y servir frío; si se prepara con anticipación guardar en un recipiente hermético en refrigeración hasta por veinticuatro horas.'; return cctx.n(r); })(), supplementPlan: (() => { const s = J(SUP); s.tiers[0].items[0].nota = LONGNOTE + ' ' + LONGNOTE; return cctx.s(s); })() },
  partial: { nutritionPlan: { calorias: '2400', proteina: '180', carbos: '260', grasas: '65', texto: '' }, supplementPlan: { texto: 'Creatina 5 g post-entreno' } },
  textonly: { nutritionPlan: { calorias: '', proteina: '', carbos: '', grasas: '', texto: 'COMIDA 1 - DESAYUNO  (07:00)\n- Avena 80 g\n- Huevos 3 piezas\n  → ~520 kcal  35P 50C 16G' }, supplementPlan: { texto: '' } },
  empty: { nutritionPlan: {}, supplementPlan: {} } };
const BAD = /\bNaN\b|\bundefined\b|\[object|\bnull\b|\[SUST:/;
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const K = JSON.parse(fs.readFileSync(process.env.VDSEN_TRAIN_KEEP, 'utf8')); if (K.project !== cfg.projectId || K.kind !== 'automation') throw new Error('REFUSING: not the automation account');
  const FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents', AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';
  const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
  const call = async (m, u, t, b) => { const r = await fetch(u, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, t ? { authorization: 'Bearer ' + t } : {}), body: b === undefined ? undefined : JSON.stringify(b) }); return r.status; };
  const T = (await (await fetch(AUTH + 'signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: K.coach.email, password: K.coach.password, returnSecureToken: true }) })).json()).idToken;
  const setState = async st => { const s = await call('PATCH', FS + '/clients/' + K.athlete.uid + '?updateMask.fieldPaths=nutritionPlan&updateMask.fieldPaths=supplementPlan', T, { fields: enc(st).mapValue.fields }); if (s !== 200) throw new Error('write ' + s); };
  const browser = await L.B.launch(); const S = async (p, n) => { if (shots) await p.screenshot({ path: shots + '/t557-' + n + '.png', fullPage: false }); };
  try {
    for (const [name, st] of Object.entries(STATES)) {
      if (arg('only', null) && arg('only', null) !== name) continue;
      await setState(st);
      for (const [W, Hh, light] of [[390, 844, false], [320, 640, false], [390, 844, true]]) {
        if (name !== 'populated' && name !== 'longtext' && (W !== 390 || light)) continue; if (name === 'longtext' && light) continue;
        const tag = name + '_' + W + (light ? 'L' : '');
        const { ctx, p, errs } = await L.openReal(browser, { W, Hh, K, expressOff: true, light });
        // ---- Nutrition tab
        await p.click('#nb2'); await p.waitForTimeout(1200); await S(p, tag + '-nutri');
        const n = await p.evaluate(() => { const t = document.getElementById('tabNutr') || document.body; const btns = [...t.querySelectorAll('button')]; const ov = [...t.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.right > innerWidth + 1)) return false; for (let x = e.parentElement; x && x !== t; x = x.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(x).overflowX)) return false; return true; }).length; return { text: t.innerText, overflowX: document.documentElement.scrollWidth > innerWidth + 1, offenders: ov, tinyBtns: btns.filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 30) && b.offsetParent; }).length }; });
        check('N_' + tag + '_NO_NAN_UNDEFINED_NULL_OR_RAW_MARKUP', !BAD.test(n.text), (n.text.match(BAD) || [''])[0]); check('N_' + tag + '_NO_HORIZONTAL_OVERFLOW', !n.overflowX && n.offenders === 0, JSON.stringify({ o: n.overflowX, off: n.offenders }));
        if (name === 'populated' || name === 'longtext') {
          const flat = t => t.toLowerCase().replace(/\s+/g, '');
          const need = ['2670', '190', '320', '70', 'DESAYUNO', 'COLACIÓN AM', 'COMIDA', 'PRE-ENTRENO', 'CENA', 'Avena en hojuelas', '80g', 'Claras de huevo', '250ml', 'Plátano', '1 pieza (120 g)', 'Tortilla de maíz', '3 piezas (90 g)', 'Arroz blanco cocido', '250g', 'Ensalada verde con pepino y jitomate', '1 plato grande', 'Filete de res magro', '180g', 'Aguacate', '40g', 'Cocer la avena', 'Hornear el camote', '~534 kcal 38P 64C 14G'];
          const miss = need.filter(x => !flat(n.text).includes(flat(x))); check('N_' + tag + '_CALORIES_MACROS_MEALS_FOODS_QUANTITIES_AND_PREP_VISIBLE', miss.length === 0, 'missing=' + miss.join('|'));
          check('N_' + tag + '_FOOD_QUANTITY_IS_NOT_MANGLED', !/Tortilla de maíz 3 piezas \(/.test(n.text) && !/\n1pieza\n/.test(n.text), '');
          check('N_' + tag + '_SUBSTITUTIONS_OFFERED_FOR_THE_AUTHORED_FOOD', /Tilapia|Atún/i.test(n.text) || (await p.evaluate(() => !!document.querySelector('[onclick*="aplicarSustInlineIdx"]'))), 'authored [SUST] options');
          check('N_' + tag + '_COACH_FACING_SUPUESTOS_AND_MONITOREO_ARE_NOT_SHOWN_TO_THE_ATHLETE_BY_DESIGN', !/Peso semanal promedio|SUPUESTOS|MONITOREO/i.test(n.text), '');
          // every control must be operable without errors: click each visible button inside the nutrition tab (skips destructive / tracking-only ones is NOT needed: nothing here is persisted by the check)
          const before = errs.length; const nb = await p.$$('#tabNutr button'); let clicked = 0; for (const b of nb.slice(0, 14)) { try { if (!(await b.isVisible())) continue; const txt = ((await b.textContent()) || '').trim(); if (/GUARDAR|REGISTRAR|ENVIAR|BORRAR|ELIMINAR/i.test(txt)) continue; await b.click({ timeout: 1500 }); clicked++; await p.waitForTimeout(150); } catch (e) { /* not clickable: not a broken control */ } }
          check('N_' + tag + '_CONTROLS_DO_NOT_ERROR', errs.length === before, 'clicked=' + clicked + ' errors=' + errs.slice(0, 2).join(' | ')); await S(p, tag + '-nutri-after');
        }
        if (name === 'empty') check('N_' + tag + '_EMPTY_STATE_IS_CLEAN', !BAD.test(n.text) && /—|Sin plan|sin plan|aún|pendiente|coach/i.test(n.text), n.text.slice(0, 120).replace(/\n/g, ' | '));
        if (name === 'partial') check('N_' + tag + '_MACROS_WITHOUT_MEALS_SHOWS_THE_MACROS', /2400/.test(n.text) && /180/.test(n.text), '');
        if (name === 'textonly') check('N_' + tag + '_MEALS_WITHOUT_ROOT_MACROS_SHOWS_THE_MEAL_AND_ITS_SUMMED_MACROS', /Avena/i.test(n.text) && /80g/.test(n.text.replace(/\s+/g, '')) && /520/.test(n.text), '');
        // ---- Supplements (Perfil "STACK PERSONALIZADO") and the nutrition-tab block
        await p.click('#nb4'); await p.waitForTimeout(900); await S(p, tag + '-perfil');
        const sp = await p.evaluate(() => { const t = document.getElementById('tabPerfil') || document.querySelector('.prof-sup') || document.body; const box = document.querySelector('.prof-sup'); return { text: (box || t).innerText, full: document.body.innerText, ov: document.documentElement.scrollWidth > innerWidth + 1 }; });
        check('S_' + tag + '_NO_NAN_UNDEFINED_NULL_TEXT', !BAD.test(sp.full), (sp.full.match(BAD) || [''])[0]); check('S_' + tag + '_NO_HORIZONTAL_OVERFLOW', !sp.ov);
        if (name === 'populated' || name === 'longtext') {
          const needS = ['Creatina monohidrato', '5 g', 'Post-entreno', 'Omega-3', '2 g EPA+DHA', 'Con la comida', 'Vitamina D3', '2000 UI', 'Con el desayuno', 'Cafeína', '200 mg', '30 min antes de entrenar', 'No tomar después de las 18:00', 'Todos los días', 'Quemadores termogénicos', 'Interfieren con el sueño'];
          const missS = needS.filter(x => !(name === 'longtext' && x === 'Todos los días') && !sp.text.toLowerCase().includes(x.toLowerCase()));   // the long-text fixture replaces that note on purpose check('S_' + tag + '_NAME_DOSE_TIMING_AND_NOTES_VISIBLE', missS.length === 0 && !/>\s*Mañana\s*</.test(sp.text), 'missing=' + missS.join('|'));
          check('S_' + tag + '_LONG_NOTE_IS_COMPLETE_AND_WRAPS', sp.text.includes('dividir la dosis en dos tomas') && !sp.ov, '');
        }
        if (name === 'empty') check('S_' + tag + '_EMPTY_STATE_SAYS_NO_SUPPLEMENTS', /Sin suplementos/i.test(sp.text), sp.text.slice(0, 80).replace(/\n/g, ' | '));
        if (name === 'partial') check('S_' + tag + '_PLAIN_TEXT_SUPPLEMENT_VISIBLE', /Creatina/i.test(sp.text), sp.text.slice(0, 80).replace(/\n/g, ' | '));
        check('NS_' + tag + '_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
      }
    }
  } catch (e) { check('HARNESS', false, String(e.stack || e.message).slice(0, 700)); }
  finally { if (!process.argv.includes('--leave')) await setState(STATES.empty).catch(() => {}); await browser.close(); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true }; if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
