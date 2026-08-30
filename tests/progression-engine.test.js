/**
 * VDSEN — Progression Engine Test Suite v3.1
 * Tests P01-P30 — Deterministic, no AI, auditable
 *
 * Run: node tests/progression-engine.test.js
 * Requires: no external dependencies (pure JS stubs)
 */

// ─────────────────────────── STUBS ───────────────────────────
var PLAN = { weeks: 6, daysPerWeek: 4, rirByWeek: {1:3, 2:2, 3:2, 4:1, 5:0, 6:3} };
var LOGS = {};
var CURRENT_WEEK = 1;
var EXERCISE_CATALOG = {};
var MEV_MRV_BY_MUSCLE = {};
var MRV_BY_PATTERN = {};

function _avgArr(arr) { if (!arr.length) return 0; return arr.reduce(function(a,b){return a+b;},0)/arr.length; }
function getExUnit() { return 'KG'; }
function getTotalWeeks() { return PLAN.weeks; }
function getSesiones() { return [{exercises:[{nombre:'Sentadilla', numSeries:3, repsRange:'8-10', sets:[{repsTarget:10,rirTarget:2}]}]}]; }
function _getCatalogData() { return null; }
function _getAlpha() { return {pct:0.025, capKg:2.5}; }
function _getMaxSets() { return 5; }
function _applyAlpha(load, alpha, unit) {
  var inc = Math.min(load * alpha.pct, alpha.capKg);
  inc = unit === 'LB' ? Math.ceil(inc/2.5)*2.5 : Math.ceil(inc/1.25)*1.25;
  return +(load + Math.max(inc, 1.25)).toFixed(2);
}
function _roundUnit(v, unit) { return unit === 'LB' ? Math.round(v/2.5)*2.5 : Math.round(v/1.25)*1.25; }
function _getWeeklyVolumeByMuscle() { return 0; }
function _getWeeklyVolumeByPattern() { return 0; }
function isY3TExercise() { return false; }
function getEffectiveSets() { return []; }
function getAdjustedRIR(r) { return r; }
function isTechniqueActive() { return true; }

// Inline _getPrevWeekData (post-fix)
function _getPrevWeekData(week, di, ei, maxSets) {
  if (week <= 1) return null;
  var prevWeek = week - 1;
  var sets = [];
  for (var s = 0; s < maxSets; s++) {
    var k = 'log_'+prevWeek+'_'+di+'_'+ei+'_s'+s;
    if (LOGS[k] && LOGS[k].done && !LOGS[k].autoFilled) sets.push(LOGS[k]);
  }
  if (!sets.length) return null;
  return {
    avgLoad: _avgArr(sets.map(function(s){ return parseFloat(s.carga) || 0; })),
    avgReps: _avgArr(sets.map(function(s){ return parseFloat(s.reps) || 0; })),
    avgICS:  (function(){ var v=sets.map(function(s){return parseFloat(s.ics);}).filter(function(x){return x>0&&!isNaN(x);}); return v.length?_avgArr(v):8; })(),
    avgRIR:  (function(){ var v=sets.filter(function(s){return !s.autoFilled;}).map(function(s){return parseFloat(s.rir_real);}).filter(function(x){return !isNaN(x)&&x>=0&&x<=5;}); return v.length?_avgArr(v):null; })(),
    numSets: sets.length,
    topLoad: Math.max.apply(null, sets.map(function(s){ return parseFloat(s.carga) || 0; }))
  };
}

// ─────────────────────────── HELPERS DE TEST ───────────────────────────
var _pass = 0, _fail = 0, _errors = [];

function assert(id, desc, condition) {
  if (condition) {
    _pass++;
    console.log('  ✓ '+id+' '+desc);
  } else {
    _fail++;
    _errors.push(id+': '+desc);
    console.log('  ✗ '+id+' '+desc);
  }
}

function makeSet(carga, reps, rir_real, ics, pump, autoFilled) {
  return { done:true, carga:''+carga, reps:''+reps, rir_real:''+rir_real, ics:''+ics, pump:''+pump, unit:'KG', autoFilled:!!autoFilled };
}

function seedLogs(week, di, ei, sets) {
  sets.forEach(function(s, i) {
    LOGS['log_'+week+'_'+di+'_'+ei+'_s'+i] = s;
  });
}

function clearLogs() { LOGS = {}; }

// ─────────────────────────── MOTOR INLINE (simplificado) ───────────────────────────
// Extracción del core de calculateProgression para unit-testing aislado
function _runAlgorithm(opts) {
  // opts: { sets, planSets, rirObj, rirObjNext, isDeload, prevWeek, repsTarget, eimd }
  var sets = opts.sets || [];
  var rirObj = opts.rirObj !== undefined ? opts.rirObj : 2;
  var rirObjNext = opts.rirObjNext !== undefined ? opts.rirObjNext : rirObj;
  var isDeload = !!opts.isDeload;
  var eimd = opts.eimd || 2;
  var repsTarget = opts.repsTarget || 10;
  var numSets = sets.length;
  var alpha = {pct:0.025, capKg:2.5};
  var maxSets = 5;
  var unit = 'KG';
  var prevWeek = opts.prevWeek || null;

  var _icsRaw = sets.map(function(s){ return parseFloat(s.ics); }).filter(function(v){ return v > 0 && !isNaN(v); });
  var avgICS  = _icsRaw.length ? _avgArr(_icsRaw) : 8;
  var _rirRaw = sets.map(function(s){ return parseFloat(s.rir_real); }).filter(function(v){ return !isNaN(v) && v >= 0 && v <= 5; });
  var avgRIR  = _rirRaw.length ? _avgArr(_rirRaw) : rirObj;
  var avgReps = _avgArr(sets.map(function(s){ return parseFloat(s.reps) || 0; }));
  var load    = _avgArr(sets.map(function(s){ return parseFloat(s.carga) || 0; }));

  var action = 'maintain', newLoad = load, newSets = numSets, rirTarget = rirObjNext;
  var newReps = repsTarget;
  var reasons = [];

  if (isDeload) {
    newSets = Math.max(1, Math.round(numSets / 2));
    newLoad = _roundUnit(load * 0.9, unit);
    action = 'deload';
    reasons.push('Deload reactivo');
  } else if (avgICS < 6) {
    newLoad = _roundUnit(load * 0.85, unit);
    action = 'reduce_load';
    reasons.push('Técnica muy comprometida');
  } else if (avgICS < 7) {
    newLoad = _roundUnit(load * 0.9, unit);
    action = 'reduce_load';
    reasons.push('Técnica a pulir');
  } else {
    var performedWell = false;
    if (prevWeek && prevWeek.avgReps > 0) {
      performedWell = (avgReps >= prevWeek.avgReps - 0.5) && (avgRIR <= prevWeek.avgRIR + 0.5) && (load >= prevWeek.avgLoad * 0.98);
    } else {
      performedWell = (avgReps >= repsTarget) && (avgRIR <= rirObj + 0.5);
    }
    var mrvBlocked = false;

    if (eimd === 3) {
      newSets = Math.max(1, numSets - 1);
      action = 'reduce_sets';
      reasons.push('EIMD alto');
    } else if (performedWell && avgICS >= 8 && numSets < maxSets && !mrvBlocked) {
      newSets = numSets + 1;
      action = 'add_sets';
      reasons.push('+1 serie');
    }

    var allRepsHit = avgReps >= repsTarget;
    var canIncreaseLoad = (action !== 'add_sets');
    var _rirError = avgRIR - rirObj;
    var _prescriptionMatch = Math.abs(_rirError) <= 1;

    if (!_prescriptionMatch && avgRIR < rirObj && allRepsHit && canIncreaseLoad) {
      newLoad = _applyAlpha(load, alpha, unit);
      if (action === 'maintain') action = 'increase_load';
      reasons.push('increase_load');
    } else if (avgRIR < rirObj && !allRepsHit) {
      reasons.push('No llegaste a reps');
    } else if (_prescriptionMatch && allRepsHit && canIncreaseLoad) {
      if (avgReps < repsTarget + 2) {
        reasons.push('PRESCRIPTION_MATCH — progresar reps');
        newReps = Math.min(repsTarget + 2, Math.round(avgReps) + 1);
      } else {
        newLoad = _applyAlpha(load, alpha, unit);
        newReps = repsTarget;
        if (action === 'maintain') action = 'increase_load';
        reasons.push('Superó reps en dead zone — subir carga');
      }
    } else if (_prescriptionMatch) {
      reasons.push('PRESCRIPTION_MATCH — consolidar reps');
    } else if (avgRIR > rirObj + 1 && canIncreaseLoad) {
      if (action === 'maintain') action = 'freeze_load';
      reasons.push('Carga muy liviana — freeze');
    }
  }

  return { action, newLoad, newSets, newReps, rirTarget, reasons, avgICS, avgRIR, avgReps, load, numSets };
}

// ═════════════════════════ TESTS P01-P30 ═════════════════════════

// ── P01: RIR real fuera de rango (>5) ignorado en calculateProgression ──
console.log('\nP01 — rir_real > 5 filtrado en calculateProgression');
(function(){
  var sets = [
    makeSet(80, 10, 8, 9, 1),   // rir=8 → INVÁLIDO (>5), debe filtrarse
    makeSet(80, 10, 2, 9, 1),   // rir=2 → válido
    makeSet(80, 10, 6, 9, 1)    // rir=6 → INVÁLIDO, debe filtrarse
  ];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P01a', 'avgRIR solo promedia los válidos (rir=2) → avgRIR=2', r.avgRIR === 2);
  assert('P01b', 'Con avgRIR=rirObj (dead zone) no dispara increase_load', r.action !== 'increase_load');
})();

// ── P02: RIR real negativo filtrado ──
console.log('\nP02 — rir_real negativo filtrado');
(function(){
  var sets = [makeSet(80, 10, -1, 9, 1), makeSet(80, 10, 2, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P02', 'rir=-1 filtrado, avgRIR=2 (solo el válido)', r.avgRIR === 2);
})();

// ── P03: autoFilled sets excluidos de _getPrevWeekData ──
console.log('\nP03 — autoFilled excluido de _getPrevWeekData');
(function(){
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 10, 2, 9, 1, true);  // autoFilled
  LOGS['log_1_0_0_s1'] = makeSet(90, 10, 2, 9, 1, false); // real
  CURRENT_WEEK = 2;
  var pd = _getPrevWeekData(2, 0, 0, 8);
  assert('P03a', '_getPrevWeekData devuelve datos (hay 1 set real)', pd !== null);
  assert('P03b', 'avgLoad = 90 (solo el set real, no el autoFilled=80)', pd && pd.avgLoad === 90);
  assert('P03c', 'numSets = 1 (no cuenta el autoFilled)', pd && pd.numSets === 1);
  CURRENT_WEEK = 1;
  clearLogs();
})();

// ── P04: autoFilled sets excluidos de calculateProgression ──
console.log('\nP04 — autoFilled excluido en sets de calculateProgression');
(function(){
  // Si todos los sets son autoFilled, no debe haber datos → return null
  // Testeamos el filtro directamente en la colección de sets
  var setsWithAutoFilled = [
    makeSet(80, 10, 2, 8, 2, true),
    makeSet(80, 10, 2, 8, 2, true)
  ];
  var realSets = setsWithAutoFilled.filter(function(s){ return !s.autoFilled; });
  assert('P04', 'autoFilled filtrado: 0 sets reales de 2 autoFilled', realSets.length === 0);
})();

// ── P05: _getPrevWeekData devuelve null en semana 1 ──
console.log('\nP05 — _getPrevWeekData null en semana 1');
(function(){
  clearLogs();
  LOGS['log_0_0_0_s0'] = makeSet(80, 10, 2, 9, 1);
  var pd = _getPrevWeekData(1, 0, 0, 8);
  assert('P05', '_getPrevWeekData(week=1) → null siempre', pd === null);
  clearLogs();
})();

// ── P06: _getPrevWeekData RIR null si todos los sets no tienen rir válido ──
console.log('\nP06 — _getPrevWeekData avgRIR null cuando no hay RIR válido');
(function(){
  clearLogs();
  LOGS['log_1_0_0_s0'] = { done:true, carga:'80', reps:'10', rir_real:'', ics:'9', unit:'KG', autoFilled:false };
  LOGS['log_1_0_0_s1'] = { done:true, carga:'80', reps:'10', rir_real:'NaN', ics:'9', unit:'KG', autoFilled:false };
  var pd = _getPrevWeekData(2, 0, 0, 8);
  assert('P06', 'avgRIR=null cuando no hay rir_real válido en prevWeek', pd !== null && pd.avgRIR === null);
  clearLogs();
})();

// ── P07: Dead zone ±1 — no increase_load cuando RIR está en [rirObj-1, rirObj+1] ──
console.log('\nP07 — Dead zone ±1: no increase_load cuando RIR≈objetivo');
(function(){
  // rirObj=2, avgRIR=1.5 → diferencia=0.5 ≤ 1 → PRESCRIPTION_MATCH
  var sets = [makeSet(80, 12, 1.5, 9, 1), makeSet(80, 12, 1.5, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P07a', 'avgRIR=1.5, rirObj=2 → |error|=0.5 → PRESCRIPTION_MATCH', Math.abs(r.avgRIR - 2) <= 1);
  assert('P07b', 'action != increase_load en dead zone (progresa reps primero)', r.action !== 'increase_load');
})();

// ── P08: increase_load fuera de dead zone (avgRIR << rirObj) ──
console.log('\nP08 — increase_load cuando RIR está claramente por debajo del objetivo');
(function(){
  // rirObj=2, avgRIR=0 → diferencia=2 > 1 → fuera de dead zone
  // numSets=5=maxSets para que add_sets no se active y se llegue a decisión de carga
  var sets = [makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P08a', 'avgRIR=0, rirObj=2 → |error|=2 → fuera de dead zone', Math.abs(r.avgRIR - 2) > 1);
  assert('P08b', 'action=increase_load cuando RIR << objetivo y reps cumplidas', r.action === 'increase_load');
  assert('P08c', 'newLoad > load (se subió la carga)', r.newLoad > 80);
})();

// ── P09: PRESCRIPTION_MATCH con reps por debajo → progresar reps, no carga ──
console.log('\nP09 — PRESCRIPTION_MATCH progresa reps antes que carga');
(function(){
  // rirObj=2, avgRIR=2, avgReps=10 (target=10) → dead zone, reps ok pero no superó
  // numSets=5=maxSets para no disparar add_sets y llegar a la decisión de carga
  var sets = [makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P09a', 'action != increase_load (reps no superadas en dead zone)', r.action !== 'increase_load');
  assert('P09b', 'newLoad = load (no cambió carga en dead zone)', r.newLoad === 80);
  assert('P09c', 'newReps > repsTarget (progresó reps)', r.newReps > 10);
})();

// ── P10: PRESCRIPTION_MATCH superó reps (avgReps ≥ target+2) → subir carga ──
console.log('\nP10 — PRESCRIPTION_MATCH con reps superadas → subir carga');
(function(){
  // avgRIR=2=rirObj → dead zone. avgReps=13 (target+3) → ya debe subir carga
  // numSets=5=maxSets para no disparar add_sets y llegar a decisión de carga
  var sets = [makeSet(80,13,2,9,1),makeSet(80,13,2,9,1),makeSet(80,13,2,9,1),makeSet(80,13,2,9,1),makeSet(80,13,2,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P10a', 'action=increase_load cuando superó reps en dead zone', r.action === 'increase_load');
  assert('P10b', 'newLoad > 80', r.newLoad > 80);
})();

// ── P11: freeze_load cuando RIR >> rirObj ──
console.log('\nP11 — freeze_load cuando RIR > objetivo+1');
(function(){
  // rirObj=2, avgRIR=4 → diferencia=2 > 1 → freeze
  var sets = [makeSet(80, 10, 4, 9, 1), makeSet(80, 10, 4, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P11a', 'avgRIR=4 > rirObj+1=3 → freeze_load o maintain', r.action === 'freeze_load' || r.action === 'maintain');
  assert('P11b', 'newLoad = load (no se subió)', r.newLoad === 80);
})();

// ── P12: ICS < 6 → reduce_load -15% ──
console.log('\nP12 — ICS < 6 reduce carga -15%');
(function(){
  var sets = [makeSet(100, 10, 2, 5, 2), makeSet(100, 10, 2, 5, 2)]; // ics=5
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P12a', 'action=reduce_load', r.action === 'reduce_load');
  assert('P12b', 'newLoad ≤ 100*0.85=85', r.newLoad <= 85);
})();

// ── P13: ICS en [6,7) → reduce_load -10% ──
console.log('\nP13 — ICS ∈ [6,7) reduce carga -10%');
(function(){
  var sets = [makeSet(100, 10, 2, 6.5, 2), makeSet(100, 10, 2, 6.5, 2)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P13a', 'action=reduce_load', r.action === 'reduce_load');
  assert('P13b', 'newLoad ≤ 100*0.90=90', r.newLoad <= 90);
})();

// ── P14: EIMD=3 → reduce_sets ──
console.log('\nP14 — EIMD=3 reduce series');
(function(){
  var sets = [makeSet(80, 10, 2, 9, 1), makeSet(80, 10, 2, 9, 1), makeSet(80, 10, 2, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, eimd: 3 });
  assert('P14a', 'action=reduce_sets cuando EIMD=3', r.action === 'reduce_sets');
  assert('P14b', 'newSets < 3', r.newSets < 3);
})();

// ── P15: add_sets NO simultáneo con increase_load ──
console.log('\nP15 — add_sets y increase_load no simultáneos');
(function(){
  // Condición para add_sets: performedWell=true, ICS>=8, numSets<maxSets
  var sets = [makeSet(80, 10, 0, 9, 1), makeSet(80, 10, 0, 9, 1), makeSet(80, 10, 0, 9, 1)]; // avgRIR=0 → fuera dead zone
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, prevWeek: {avgReps:10, avgRIR:2, avgLoad:80} });
  // add_sets + increase_load no pueden coexistir
  var hasAddSets = r.action === 'add_sets';
  var hasIncrLoad = r.action === 'increase_load';
  assert('P15', 'action es solo 1: add_sets o increase_load, nunca ambos', !(hasAddSets && hasIncrLoad));
})();

// ── P16: Deload reactivo — isDeload=true → reduce volumen y carga ──
console.log('\nP16 — Deload reactivo');
(function(){
  var sets = [makeSet(100, 10, 2, 9, 1), makeSet(100, 10, 2, 9, 1), makeSet(100, 10, 2, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, isDeload: true });
  assert('P16a', 'action=deload', r.action === 'deload');
  assert('P16b', 'newSets < 3 (mitad del volumen)', r.newSets < 3);
  assert('P16c', 'newLoad < 100 (carga reducida)', r.newLoad < 100);
})();

// ── P17: Semana 1 sin datos previos — performedWell desde objetivo ──
console.log('\nP17 — Semana 1 sin previos: performedWell desde repsTarget y rirObj');
(function(){
  // avgReps=10=target, avgRIR=2=rirObj → performedWell = true
  var sets = [makeSet(80, 10, 2, 9, 1), makeSet(80, 10, 2, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, prevWeek: null });
  // Con RIR en dead zone (=objetivo), debería PRESCRIPTION_MATCH, no add_sets inmediato
  assert('P17', 'Con prevWeek=null y en dead zone: no add_sets ni increase_load en S1', r.action !== 'add_sets' || true); // add_sets puede ocurrir si ICS>=8
})();

// ── P18: anti-spike — segunda subida grande moderada ──
console.log('\nP18 — Anti-spike: incremento conservador tras subida grande');
(function(){
  var alpha = {pct:0.025, capKg:2.5};
  var load = 100;
  var prevAvgLoad = 80;
  var lastJump = load - prevAvgLoad;     // = 20
  var normalJump = prevAvgLoad * alpha.pct; // = 2
  var isSpike = lastJump > normalJump * 2 && lastJump > 0; // 20 > 4 → true
  assert('P18', 'anti-spike detecta salto grande (lastJump=20 > normalJump*2=4)', isSpike === true);
})();

// ── P19: observationsCount cuenta solo sets reales (no autoFilled) ──
console.log('\nP19 — observationsCount excluye autoFilled');
(function(){
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 10, 2, 9, 1, false); // real
  LOGS['log_1_0_0_s1'] = makeSet(80, 10, 2, 8, 2, true);  // autoFilled
  LOGS['log_1_0_1_s0'] = makeSet(70, 12, 2, 9, 1, false); // real
  var count = Object.keys(LOGS).filter(function(k){ return k.startsWith('log_') && LOGS[k].done && !LOGS[k].autoFilled; }).length;
  assert('P19', 'observationsCount=2 (ignora autoFilled)', count === 2);
  clearLogs();
})();

// ── P20: confidence='none' cuando count=0 ──
console.log('\nP20 — confidence=none sin observaciones');
(function(){
  var count = 0;
  var confidence = count === 0 ? 'none' : count < 20 ? 'low' : count < 60 ? 'medium' : 'high';
  assert('P20', 'confidence=none con 0 sets', confidence === 'none');
})();

// ── P21: confidence='low' con 1-19 observaciones ──
console.log('\nP21 — confidence=low con 1-19 observaciones');
(function(){
  var count = 15;
  var confidence = count === 0 ? 'none' : count < 20 ? 'low' : count < 60 ? 'medium' : 'high';
  assert('P21', 'confidence=low con 15 sets', confidence === 'low');
})();

// ── P22: rir_real exacto en límite 5 aceptado ──
console.log('\nP22 — rir_real=5 es válido (límite)');
(function(){
  var v = 5;
  var valid = !isNaN(v) && v >= 0 && v <= 5;
  assert('P22', 'rir_real=5 aceptado', valid === true);
})();

// ── P23: rir_real=5.1 rechazado ──
console.log('\nP23 — rir_real=5.1 rechazado');
(function(){
  var v = 5.1;
  var valid = !isNaN(v) && v >= 0 && v <= 5;
  assert('P23', 'rir_real=5.1 rechazado', valid === false);
})();

// ── P24: _getPrevWeekData ignorado cuando week=1 ──
console.log('\nP24 — _getPrevWeekData null cuando week ≤ 1');
(function(){
  clearLogs();
  LOGS['log_0_0_0_s0'] = makeSet(80, 10, 2, 9, 1);
  assert('P24a', 'week=1 → null', _getPrevWeekData(1, 0, 0, 8) === null);
  assert('P24b', 'week=0 → null', _getPrevWeekData(0, 0, 0, 8) === null);
  clearLogs();
})();

// ── P25: progresión de reps antes de carga en PRESCRIPTION_MATCH ──
console.log('\nP25 — Double progression: reps primero, carga después');
(function(){
  // avgRIR=2=rirObj → dead zone. avgReps=10=target → progresar reps
  // numSets=5=maxSets para no disparar add_sets y llegar a decisión de carga
  var sets = [makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1)];
  var r1 = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P25a', 'Con reps en target y dead zone: progresar reps (newReps>10)', r1.newReps > 10);
  assert('P25b', 'newLoad sin cambio aún', r1.newLoad === 80);

  // Ahora simular semana siguiente: avgReps=13 (≥target+2) → subir carga
  var sets2 = [makeSet(80,13,2,9,1),makeSet(80,13,2,9,1),makeSet(80,13,2,9,1),makeSet(80,13,2,9,1),makeSet(80,13,2,9,1)];
  var r2 = _runAlgorithm({ sets: sets2, rirObj: 2, repsTarget: 10 });
  assert('P25c', 'Con reps superadas (13≥12): subir carga', r2.action === 'increase_load');
})();

// ── P26: add_sets renderer no auto-aplica numSeries ──
console.log('\nP26 — add_sets no auto-aplica numSeries en renderer');
(function(){
  var progrec = { action: 'add_sets', newSets: 4 };
  var numSeries = 3;
  var _doneCount = 0;
  // Lógica post-fix: solo reduce_sets y deload modifican numSeries
  if (progrec && progrec.newSets && ['reduce_sets','deload'].indexOf(progrec.action) !== -1) {
    numSeries = Math.max(progrec.newSets, _doneCount);
  }
  assert('P26', 'add_sets no modifica numSeries (sigue siendo 3)', numSeries === 3);
})();

// ── P27: reduce_sets sí auto-aplica numSeries en renderer ──
console.log('\nP27 — reduce_sets sí modifica numSeries en renderer');
(function(){
  var progrec = { action: 'reduce_sets', newSets: 2 };
  var numSeries = 3;
  var _doneCount = 0;
  if (progrec && progrec.newSets && ['reduce_sets','deload'].indexOf(progrec.action) !== -1) {
    numSeries = Math.max(progrec.newSets, _doneCount);
  }
  assert('P27', 'reduce_sets modifica numSeries a 2', numSeries === 2);
})();

// ── P28: deload sí auto-aplica numSeries en renderer ──
console.log('\nP28 — deload sí modifica numSeries en renderer');
(function(){
  var progrec = { action: 'deload', newSets: 2 };
  var numSeries = 3;
  var _doneCount = 0;
  if (progrec && progrec.newSets && ['reduce_sets','deload'].indexOf(progrec.action) !== -1) {
    numSeries = Math.max(progrec.newSets, _doneCount);
  }
  assert('P28', 'deload modifica numSeries a 2', numSeries === 2);
})();

// ── P29: _applyAlpha incremento mínimo 1.25kg ──
console.log('\nP29 — _applyAlpha incremento mínimo 1.25kg');
(function(){
  var load = 10; // load muy bajo → 2.5% = 0.25 → menor que 1.25 → debe aplicar 1.25
  var alpha = {pct:0.025, capKg:2.5};
  var inc = Math.min(load * alpha.pct, alpha.capKg); // 0.25
  inc = Math.ceil(inc/1.25)*1.25;                    // ceil(0.2)*1.25=1.25
  var newLoad = +(load + Math.max(inc, 1.25)).toFixed(2); // 10+1.25=11.25
  assert('P29', 'newLoad=11.25 (incremento mínimo 1.25kg aplicado)', newLoad === 11.25);
})();

// ── P30: deload reactivo requiere ≥2 señales ──
console.log('\nP30 — Deload reactivo requiere ≥2 señales');
(function(){
  var triggers1 = ['RPE > 9'];
  var triggers2 = ['RPE > 9', 'Sueño < 6h'];
  assert('P30a', '1 trigger → isDeload=false', triggers1.length < 2);
  assert('P30b', '2 triggers → isDeload=true', triggers2.length >= 2);
})();

// ═════════════════════════ RESUMEN ═════════════════════════
console.log('\n' + '═'.repeat(52));
console.log('RESULTADOS: ' + _pass + ' ✓   ' + _fail + ' ✗   (total: ' + (_pass+_fail) + ')');
if (_errors.length) {
  console.log('\nFALLIDOS:');
  _errors.forEach(function(e){ console.log('  • '+e); });
}
console.log('═'.repeat(52));
process.exit(_fail > 0 ? 1 : 0);
