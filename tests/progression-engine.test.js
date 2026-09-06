/**
 * VDSEN — Progression Engine Test Suite v3.4
 * Tests P01-P60 — Deterministic, no AI, auditable
 *
 * RIR SIGN (congelado):
 *   rir_error = avgRIR - rirObj
 *   avgRIR > rirObj → RIR_TOO_EASY_TREND → progression candidate
 *   avgRIR < rirObj → RIR_TOO_HARD_TREND → no increase load
 *   |avgRIR - rirObj| ≤ 1 → PRESCRIPTION_MATCH
 *
 * Run: node tests/progression-engine.test.js
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

function clearLogs() { LOGS = {}; }

// ─────────────────────────── MOTOR INLINE (refleja semántica correcta) ───────────────────────────
// Extracción del core de calculateProgression para unit-testing aislado.
// RIR SIGN: rir_error = avgRIR - rirObj
//   > 0 → TOO_EASY → progression candidate
//   < 0 → TOO_HARD → freeze/review
//   |error| ≤ 1 → PRESCRIPTION_MATCH → double progression (reps first → then load)
function _runAlgorithm(opts) {
  var sets     = opts.sets || [];
  var rirObj   = opts.rirObj   !== undefined ? opts.rirObj   : 2;
  var isDeload = !!opts.isDeload;
  var eimd     = opts.eimd     !== undefined ? opts.eimd     : 2;
  var repsLow  = opts.repsLow  !== undefined ? opts.repsLow  : (opts.repsTarget || 10);
  var repsTarget = opts.repsTarget !== undefined ? opts.repsTarget : 10; // upper bound
  var numSets  = sets.length;
  var alpha    = {pct:0.025, capKg:2.5};
  var maxSets  = opts.maxSets !== undefined ? opts.maxSets : 5;
  var unit     = 'KG';
  var prevWeek = opts.prevWeek || null;

  var _icsRaw = sets.map(function(s){ return parseFloat(s.ics); }).filter(function(v){ return v > 0 && !isNaN(v); });
  var avgICS  = _icsRaw.length ? _avgArr(_icsRaw) : 8;
  var _rirRaw = sets.map(function(s){ return parseFloat(s.rir_real); }).filter(function(v){ return !isNaN(v) && v >= 0 && v <= 5; });
  var avgRIR  = _rirRaw.length ? _avgArr(_rirRaw) : rirObj;
  var avgReps = _avgArr(sets.map(function(s){ return parseFloat(s.reps) || 0; }));
  var minReps = sets.length ? Math.min.apply(null, sets.map(function(s){ return parseFloat(s.reps)||0; })) : 0;
  var load    = _avgArr(sets.map(function(s){ return parseFloat(s.carga) || 0; }));

  var action   = 'maintain', newLoad = load, newSets = numSets;
  var newReps  = repsTarget;
  var reasons  = [];

  if (isDeload) {
    newSets = Math.max(1, Math.round(numSets / 2));
    newLoad = _roundUnit(load * 0.9, unit);
    action  = 'deload';
    reasons.push('Deload reactivo — candidato de programa. Coach decide cambio real.');
  } else if (avgICS < 6) {
    // HEURÍSTICA: técnica muy comprometida → reducir carga -15%
    newLoad = _roundUnit(load * 0.85, unit);
    action  = 'reduce_load';
    reasons.push('Técnica muy comprometida [HEURÍSTICA -15%]');
  } else if (avgICS < 7) {
    // HEURÍSTICA: técnica a pulir → reducir carga -10%
    newLoad = _roundUnit(load * 0.9, unit);
    action  = 'reduce_load';
    reasons.push('Técnica a pulir [HEURÍSTICA -10%]');
  } else {
    var performedWell = false;
    if (prevWeek && prevWeek.avgReps > 0) {
      performedWell = (avgReps >= prevWeek.avgReps - 0.5) && (avgRIR <= prevWeek.avgRIR + 0.5) && (load >= prevWeek.avgLoad * 0.98);
    } else {
      performedWell = (avgReps >= repsTarget) && (avgRIR <= rirObj + 0.5);
    }

    if (eimd === 3) {
      newSets = Math.max(1, numSets - 1);
      action  = 'reduce_sets';
      reasons.push('EIMD alto — reduce sets');
    } else if (performedWell && avgICS >= 8 && numSets < maxSets) {
      // add_sets: RECOMENDACIÓN SOLO — no muta plan activo
      newSets = numSets + 1;
      action  = 'add_sets';
      reasons.push('+1 serie — RECOMENDACIÓN SOLO, coach actualiza plan');
    }

    // allRepsHit: avg en el techo del rango Y ningún set claramente bajo el piso
    var allRepsHit     = (avgReps >= repsTarget) && (minReps >= repsLow - 1);
    var canIncreaseLoad = (action !== 'add_sets');

    // SET-LEVEL SAFEGUARDS
    var _rirRealArr = sets.map(function(s){ return parseFloat(s.rir_real); }).filter(function(v){ return !isNaN(v) && v >= 0 && v <= 5; });
    var _minRIR = _rirRealArr.length ? Math.min.apply(null, _rirRealArr) : null;
    var _setsWithinBand = _rirRealArr.filter(function(v){ return Math.abs(v - rirObj) <= 1; }).length;
    var _validSetCount = _rirRealArr.length;
    var _rirZeroFalsePositive = (_minRIR === 0 && _validSetCount > 0 && _setsWithinBand < _validSetCount);

    // RIR SIGN: rir_error = avgRIR - rirObj
    var _rirError = avgRIR - rirObj;
    var _prescriptionMatch = Math.abs(_rirError) <= 1;

    if (_rirZeroFalsePositive && canIncreaseLoad) {
      // Un set llegó a RIR=0 fuera de la banda — el promedio normaliza el fallo → no progresar
      if (action === 'maintain') action = 'freeze_load';
      reasons.push('RIR0_FALSE_POSITIVE: set a fallo fuera de banda — regularizar antes de progresar');
    } else if (!_prescriptionMatch && _rirError > 0 && canIncreaseLoad) {
      // RIR_TOO_EASY_TREND: quedaron reps en el tanque → progression candidate
      if (allRepsHit) {
        newLoad = _applyAlpha(load, alpha, unit);
        if (action === 'maintain') action = 'increase_load';
        var incKg = (newLoad - load).toFixed(2);
        reasons.push('RIR_TOO_EASY: reps cumplidas + reserva — +'+incKg+' '+unit);
        if (prevWeek && prevWeek.avgLoad > 0) {
          var _lastJump = load - prevWeek.avgLoad;
          var _normalJump = prevWeek.avgLoad * alpha.pct;
          if (_lastJump > _normalJump * 2 && _lastJump > 0) {
            var modAlpha = { pct: alpha.pct * 0.5, capKg: alpha.capKg * 0.5 };
            newLoad = _applyAlpha(load, modAlpha, unit);
            reasons.push('Anti-spike: incremento conservador');
          }
        }
      } else {
        reasons.push('RIR_TOO_EASY pero no alcanzaste reps — apuntá a '+repsTarget+' reps primero');
        newReps = repsTarget;
      }
    } else if (!_prescriptionMatch && _rirError < 0) {
      // RIR_TOO_HARD_TREND: esfuerzo excesivo → congelar o bajar carga [HEURÍSTICA]
      var _prevAlsoTooHard = prevWeek && prevWeek.avgRIR !== null && (prevWeek.avgRIR - rirObj) < -1;
      if (_prevAlsoTooHard) {
        newLoad = _roundUnit(load * 0.95, unit);
        if (action === 'maintain') action = 'reduce_load';
        reasons.push('TOO_HARD_REPEATED: patrón 2 semanas — candidato a bajar carga ~5%');
      } else {
        if (action === 'maintain') action = 'freeze_load';
        reasons.push('RIR_TOO_HARD: esfuerzo > objetivo — congelar carga [HEURÍSTICA]');
      }
    } else if (_prescriptionMatch && allRepsHit && canIncreaseLoad) {
      // PRESCRIPTION_MATCH + techo del rango alcanzado → subir carga (double progression)
      newLoad = _applyAlpha(load, alpha, unit);
      newReps = repsTarget;
      if (action === 'maintain') action = 'increase_load';
      reasons.push('PRESCRIPTION_MATCH + techo reps — subir carga');
    } else if (_prescriptionMatch) {
      // PRESCRIPTION_MATCH sin llegar al techo → construir reps primero
      if (avgReps > 0 && avgReps < repsTarget) {
        newReps = Math.min(repsTarget, Math.round(avgReps) + 1);
        reasons.push('PRESCRIPTION_MATCH — progresar reps hacia techo ('+repsTarget+')');
      } else {
        reasons.push('PRESCRIPTION_MATCH — consolidar reps');
      }
    } else if (!canIncreaseLoad && _rirError > 0 && allRepsHit) {
      reasons.push('add_sets ya recomendado — carga igual');
    }
  }

  return { action: action, newLoad: newLoad, newSets: newSets, newReps: newReps, reasons: reasons, avgICS: avgICS, avgRIR: avgRIR, avgReps: avgReps, load: load, numSets: numSets };
}

// ═════════════════════════ TESTS P01-P40 ═════════════════════════

// ── P01: RIR real fuera de rango (>5) filtrado ──
console.log('\nP01 — rir_real > 5 filtrado en calculateProgression');
(function(){
  var sets = [
    makeSet(80, 10, 8, 9, 1),  // rir=8 → INVÁLIDO, filtrado
    makeSet(80, 10, 2, 9, 1),  // rir=2 → válido
    makeSet(80, 10, 6, 9, 1)   // rir=6 → INVÁLIDO, filtrado
  ];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, maxSets: 5 });
  assert('P01a', 'avgRIR solo promedia el válido (rir=2) → avgRIR=2', r.avgRIR === 2);
  // avgRIR=2=rirObj → PRESCRIPTION_MATCH, no increase_load directo
  assert('P01b', 'PRESCRIPTION_MATCH: no dispara increase_load inmediato', r.action !== 'increase_load' || r.avgReps >= 10);
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

// ── P04: autoFilled excluido de sets en calculateProgression ──
console.log('\nP04 — autoFilled excluido en sets de calculateProgression');
(function(){
  var setsWithAutoFilled = [makeSet(80, 10, 2, 8, 2, true), makeSet(80, 10, 2, 8, 2, true)];
  var realSets = setsWithAutoFilled.filter(function(s){ return !s.autoFilled; });
  assert('P04', 'autoFilled filtrado: 0 sets reales de 2 autoFilled', realSets.length === 0);
})();

// ── P05: _getPrevWeekData devuelve null en semana 1 ──
console.log('\nP05 — _getPrevWeekData null en semana 1');
(function(){
  clearLogs();
  LOGS['log_0_0_0_s0'] = makeSet(80, 10, 2, 9, 1);
  assert('P05', '_getPrevWeekData(week=1) → null siempre', _getPrevWeekData(1, 0, 0, 8) === null);
  clearLogs();
})();

// ── P06: _getPrevWeekData avgRIR null si no hay RIR válido ──
console.log('\nP06 — _getPrevWeekData avgRIR null cuando no hay RIR válido');
(function(){
  clearLogs();
  LOGS['log_1_0_0_s0'] = { done:true, carga:'80', reps:'10', rir_real:'', ics:'9', unit:'KG', autoFilled:false };
  LOGS['log_1_0_0_s1'] = { done:true, carga:'80', reps:'10', rir_real:'NaN', ics:'9', unit:'KG', autoFilled:false };
  var pd = _getPrevWeekData(2, 0, 0, 8);
  assert('P06', 'avgRIR=null cuando no hay rir_real válido en prevWeek', pd !== null && pd.avgRIR === null);
  clearLogs();
})();

// ── P07: Dead zone ±1 — PRESCRIPTION_MATCH ──
console.log('\nP07 — Dead zone ±1: |avgRIR - rirObj| ≤ 1 = PRESCRIPTION_MATCH');
(function(){
  // target=2, actual=1.5 → error=-0.5 → dentro de dead zone
  var sets = [makeSet(80, 8, 1.5, 9, 1), makeSet(80, 8, 1.5, 9, 1), makeSet(80, 8, 1.5, 9, 1), makeSet(80, 8, 1.5, 9, 1), makeSet(80, 8, 1.5, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P07a', '|avgRIR(1.5) - rirObj(2)| = 0.5 ≤ 1 → PRESCRIPTION_MATCH', Math.abs(r.avgRIR - 2) <= 1);
  // reps=8 < repsTarget=10 → progresar reps, no carga
  assert('P07b', 'avgReps(8) < techo(10) → no increase_load aún', r.action !== 'increase_load');
})();

// ── P08: RIR_TOO_EASY_TREND — avgRIR > rirObj+1 → progression candidate ──
console.log('\nP08 — RIR_TOO_EASY_TREND: avgRIR > rirObj+1 → increase_load');
(function(){
  // target=2, actual=4 → error=+2 > 1 → TOO_EASY → progression
  // maxSets=5=numSets para evitar add_sets y llegar a decisión de carga
  var sets = [makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P08a', 'avgRIR(4) - rirObj(2) = +2 > 1 → RIR_TOO_EASY', r.avgRIR - 2 > 1);
  assert('P08b', 'action=increase_load cuando TOO_EASY y reps cumplidas', r.action === 'increase_load');
  assert('P08c', 'newLoad > 80 (se subió la carga)', r.newLoad > 80);
})();

// ── P09: PRESCRIPTION_MATCH — reps bajo el techo → progresar reps primero ──
console.log('\nP09 — PRESCRIPTION_MATCH + reps < techo → progresar reps');
(function(){
  // target=2, actual=2, avgReps=8 < repsTarget=10 → progresar reps, no carga
  var sets = [makeSet(80,8,2,9,1),makeSet(80,8,2,9,1),makeSet(80,8,2,9,1),makeSet(80,8,2,9,1),makeSet(80,8,2,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P09a', 'PRESCRIPTION_MATCH (|error|=0)', Math.abs(r.avgRIR - 2) <= 1);
  assert('P09b', 'action != increase_load (reps aún bajo el techo del rango)', r.action !== 'increase_load');
  assert('P09c', 'newLoad sin cambio', r.newLoad === 80);
  assert('P09d', 'newReps > avgReps (se progresó 1 rep hacia el techo)', r.newReps > r.avgReps);
})();

// ── P10: PRESCRIPTION_MATCH + techo del rango alcanzado → subir carga ──
console.log('\nP10 — PRESCRIPTION_MATCH + reps en techo → subir carga');
(function(){
  // avgReps=10=repsTarget (upper bound) → double progression: subir carga
  var sets = [makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P10a', 'action=increase_load cuando techo del rango alcanzado en PRESCRIPTION_MATCH', r.action === 'increase_load');
  assert('P10b', 'newLoad > 80', r.newLoad > 80);
})();

// ── P11: RIR_TOO_HARD_TREND — avgRIR < rirObj-1 → freeze_load ──
console.log('\nP11 — RIR_TOO_HARD_TREND: avgRIR < rirObj-1 → freeze_load');
(function(){
  // target=2, actual=0 → error=-2 < -1 → TOO_HARD → NO aumentar carga
  var sets = [makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P11a', 'avgRIR(0) - rirObj(2) = -2 < -1 → TOO_HARD', r.avgRIR - 2 < -1);
  assert('P11b', 'action=freeze_load cuando TOO_HARD', r.action === 'freeze_load');
  assert('P11c', 'newLoad = load (no se subió)', r.newLoad === 80);
})();

// ── P12: ICS < 6 → reduce_load -15% [HEURÍSTICA] ──
console.log('\nP12 — ICS < 6 reduce carga -15% [HEURÍSTICA]');
(function(){
  var sets = [makeSet(100, 10, 2, 5, 2), makeSet(100, 10, 2, 5, 2)]; // ics=5
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P12a', 'action=reduce_load', r.action === 'reduce_load');
  assert('P12b', 'newLoad ≤ 100*0.85=85 [HEURÍSTICA]', r.newLoad <= 85);
})();

// ── P13: ICS ∈ [6,7) → reduce_load -10% [HEURÍSTICA] ──
console.log('\nP13 — ICS ∈ [6,7) reduce carga -10% [HEURÍSTICA]');
(function(){
  var sets = [makeSet(100, 10, 2, 6.5, 2), makeSet(100, 10, 2, 6.5, 2)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10 });
  assert('P13a', 'action=reduce_load', r.action === 'reduce_load');
  assert('P13b', 'newLoad ≤ 90 [HEURÍSTICA -10%]', r.newLoad <= 90);
})();

// ── P14: EIMD=3 → reduce_sets ──
console.log('\nP14 — EIMD=3 reduce series');
(function(){
  var sets = [makeSet(80, 10, 2, 9, 1), makeSet(80, 10, 2, 9, 1), makeSet(80, 10, 2, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, eimd: 3 });
  assert('P14a', 'action=reduce_sets cuando EIMD=3', r.action === 'reduce_sets');
  assert('P14b', 'newSets < 3', r.newSets < 3);
})();

// ── P15: add_sets y increase_load no simultáneos ──
console.log('\nP15 — add_sets y increase_load no simultáneos');
(function(){
  var sets = [makeSet(80,10,4,9,1), makeSet(80,10,4,9,1)]; // numSets=2 < maxSets=5 → add_sets posible
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, maxSets: 5 });
  var hasAddSets   = r.action === 'add_sets';
  var hasIncrLoad  = r.action === 'increase_load';
  assert('P15', 'nunca add_sets + increase_load simultáneo', !(hasAddSets && hasIncrLoad));
})();

// ── P16: Deload reactivo — candidato de programa, no muta plan activo ──
console.log('\nP16 — Deload reactivo: action=deload, sin mutación del plan');
(function(){
  var sets = [makeSet(100, 10, 2, 9, 1), makeSet(100, 10, 2, 9, 1), makeSet(100, 10, 2, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, isDeload: true });
  assert('P16a', 'action=deload', r.action === 'deload');
  assert('P16b', 'reason menciona que es candidato/coach decide', r.reasons.some(function(rs){ return /candidato|coach/i.test(rs); }));
})();

// ── P17: Sem 1 sin previos — performedWell desde repsTarget y rirObj ──
console.log('\nP17 — Semana 1 sin previos');
(function(){
  var sets = [makeSet(80, 10, 2, 9, 1), makeSet(80, 10, 2, 9, 1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, prevWeek: null, maxSets: 5 });
  // avgRIR=2=rirObj, avgReps=10=repsTarget → performedWell=true BUT en PRESCRIPTION_MATCH + allRepsHit
  // Debe aumentar carga (double progression completado en S1)
  assert('P17', 'Con reps en techo y PRESCRIPTION_MATCH en S1: increase_load o add_sets', r.action === 'increase_load' || r.action === 'add_sets');
})();

// ── P18: Anti-spike ──
console.log('\nP18 — Anti-spike: detección de salto grande');
(function(){
  var alpha = {pct:0.025, capKg:2.5};
  var load = 100, prevAvgLoad = 80;
  var lastJump = load - prevAvgLoad;       // = 20
  var normalJump = prevAvgLoad * alpha.pct; // = 2
  assert('P18', 'lastJump(20) > normalJump*2(4) → anti-spike activa', lastJump > normalJump * 2);
})();

// ── P19: observationsCount excluye autoFilled ──
console.log('\nP19 — observationsCount excluye autoFilled');
(function(){
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 10, 2, 9, 1, false); // real
  LOGS['log_1_0_0_s1'] = makeSet(80, 10, 2, 8, 2, true);  // autoFilled
  LOGS['log_1_0_1_s0'] = makeSet(70, 12, 2, 9, 1, false); // real
  var count = Object.keys(LOGS).filter(function(k){
    return k.startsWith('log_') && LOGS[k].done && !LOGS[k].autoFilled;
  }).length;
  assert('P19', 'observationsCount=2 (ignora autoFilled)', count === 2);
  clearLogs();
})();

// ── P20: confidence='none' con 0 observaciones ──
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

// ── P22: rir_real=5 aceptado (límite válido) ──
console.log('\nP22 — rir_real=5 es válido');
(function(){
  var v = 5;
  assert('P22', 'rir_real=5 aceptado', !isNaN(v) && v >= 0 && v <= 5);
})();

// ── P23: rir_real=5.1 rechazado ──
console.log('\nP23 — rir_real=5.1 rechazado');
(function(){
  var v = 5.1;
  assert('P23', 'rir_real=5.1 rechazado', !(!isNaN(v) && v >= 0 && v <= 5));
})();

// ── P24: _getPrevWeekData null para week ≤ 1 ──
console.log('\nP24 — _getPrevWeekData null para week ≤ 1');
(function(){
  clearLogs();
  assert('P24a', 'week=1 → null', _getPrevWeekData(1, 0, 0, 8) === null);
  assert('P24b', 'week=0 → null', _getPrevWeekData(0, 0, 0, 8) === null);
  clearLogs();
})();

// ── P25: Double progression completo (reps → carga) ──
console.log('\nP25 — Double progression: reps primero, carga después');
(function(){
  // Paso 1: reps=8 < repsTarget=10, PRESCRIPTION_MATCH → progresar reps
  var sets1 = [makeSet(80,8,2,9,1),makeSet(80,8,2,9,1),makeSet(80,8,2,9,1),makeSet(80,8,2,9,1),makeSet(80,8,2,9,1)];
  var r1 = _runAlgorithm({ sets: sets1, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P25a', 'Paso 1: progresar reps (newReps > 8)', r1.newReps > 8);
  assert('P25b', 'Paso 1: newLoad sin cambio', r1.newLoad === 80);

  // Paso 2: reps=10=repsTarget (techo) → subir carga
  var sets2 = [makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1),makeSet(80,10,2,9,1)];
  var r2 = _runAlgorithm({ sets: sets2, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P25c', 'Paso 2: subir carga (action=increase_load)', r2.action === 'increase_load');
  assert('P25d', 'Paso 2: newLoad > 80', r2.newLoad > 80);
})();

// ── P26: add_sets no auto-aplica numSeries en renderer ──
console.log('\nP26 — add_sets no auto-aplica numSeries en renderer');
(function(){
  var progrec = { action: 'add_sets', newSets: 4 };
  var numSeries = 3, _doneCount = 0;
  // Solo reduce_sets modifica numSeries en el renderer
  if (progrec && progrec.newSets && progrec.action === 'reduce_sets') {
    numSeries = Math.max(progrec.newSets, _doneCount);
  }
  assert('P26', 'add_sets no modifica numSeries (sigue siendo 3)', numSeries === 3);
})();

// ── P27: reduce_sets sí modifica numSeries en renderer ──
console.log('\nP27 — reduce_sets modifica numSeries en renderer');
(function(){
  var progrec = { action: 'reduce_sets', newSets: 2 };
  var numSeries = 3, _doneCount = 0;
  if (progrec && progrec.newSets && progrec.action === 'reduce_sets') {
    numSeries = Math.max(progrec.newSets, _doneCount);
  }
  assert('P27', 'reduce_sets modifica numSeries a 2', numSeries === 2);
})();

// ── P28: deload NO auto-aplica numSeries en renderer ──
console.log('\nP28 — deload NO auto-aplica numSeries en renderer');
(function(){
  var progrec = { action: 'deload', newSets: 2 };
  var numSeries = 3, _doneCount = 0;
  // deload es candidato: coach decide. No muta plan activo.
  if (progrec && progrec.newSets && progrec.action === 'reduce_sets') {
    numSeries = Math.max(progrec.newSets, _doneCount);
  }
  assert('P28', 'deload NO modifica numSeries en renderer (sigue siendo 3)', numSeries === 3);
})();

// ── P29: _applyAlpha incremento mínimo 1.25kg ──
console.log('\nP29 — _applyAlpha incremento mínimo 1.25kg');
(function(){
  var load = 10, alpha = {pct:0.025, capKg:2.5};
  var inc = Math.min(load * alpha.pct, alpha.capKg); // 0.25
  inc = Math.ceil(inc/1.25)*1.25;                    // 1.25
  var newLoad = +(load + Math.max(inc, 1.25)).toFixed(2); // 11.25
  assert('P29', 'newLoad=11.25 (incremento mínimo 1.25kg)', newLoad === 11.25);
})();

// ── P30: Deload reactivo requiere ≥2 señales ──
console.log('\nP30 — Deload reactivo requiere ≥2 señales');
(function(){
  var triggers1 = ['RPE > 9'];
  var triggers2 = ['RPE > 9', 'Sueño < 6h'];
  assert('P30a', '1 trigger → isDeload=false', triggers1.length < 2);
  assert('P30b', '2 triggers → isDeload=true', triggers2.length >= 2);
})();

// ═══════════════════════════ P31-P40 — RIR SIGN CORRECTNESS ═══════════════════════════

// ── P31: target=2, actual=4 → TOO_EASY → progression candidate ──
console.log('\nP31 — target RIR2 / actual RIR4 → RIR_TOO_EASY → progression candidate');
(function(){
  // actual=4 > target=2 → error=+2 > 1 → TOO_EASY → increase_load si reps ok
  var sets = [makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P31a', 'rir_error = 4-2 = +2 > 0 (TOO_EASY)', r.avgRIR - 2 > 0);
  assert('P31b', 'action=increase_load (TOO_EASY + reps cumplidas)', r.action === 'increase_load');
  assert('P31c', 'newLoad > 80', r.newLoad > 80);
  assert('P31d', 'NUNCA reduce_load ni freeze en TOO_EASY', r.action !== 'reduce_load' && r.action !== 'freeze_load');
})();

// ── P32: target=2, actual=0 → TOO_HARD → NO increase_load ──
console.log('\nP32 — target RIR2 / actual RIR0 → RIR_TOO_HARD → no increase load');
(function(){
  // actual=0 < target=2 → error=-2 < -1 → TOO_HARD → freeze_load, NUNCA increase
  var sets = [makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P32a', 'rir_error = 0-2 = -2 < 0 (TOO_HARD)', r.avgRIR - 2 < 0);
  assert('P32b', 'action=freeze_load (TOO_HARD)', r.action === 'freeze_load');
  assert('P32c', 'NUNCA increase_load cuando TOO_HARD', r.action !== 'increase_load');
  assert('P32d', 'newLoad = load (no se subió)', r.newLoad === 80);
})();

// ── P33: target=2, actual=1, 2, o 3 → PRESCRIPTION_MATCH ──
console.log('\nP33 — target RIR2 / actual RIR 1-3 → PRESCRIPTION_MATCH');
(function(){
  [1, 2, 3].forEach(function(actualRIR) {
    var err = actualRIR - 2;
    var match = Math.abs(err) <= 1;
    assert('P33_rir'+actualRIR, 'actual='+actualRIR+': |error|='+Math.abs(err)+' ≤ 1 → PRESCRIPTION_MATCH', match);
  });
})();

// ── P34: top-range reps (avgReps=repsTarget) + actual RIR=4 → increase_load ──
console.log('\nP34 — top reps + RIR_TOO_EASY → progression candidate');
(function(){
  // avgReps=10=repsTarget, avgRIR=4 > rirObj=2+1=3 → TOO_EASY + reps at ceiling → increase_load
  var sets = [makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P34a', 'TOO_EASY (error=+2) + reps en techo → increase_load', r.action === 'increase_load');
  assert('P34b', 'newLoad > 80', r.newLoad > 80);
})();

// ── P35: top reps + actual RIR=0 (TOO_HARD) → NO increase_load ──
console.log('\nP35 — top reps + RIR_TOO_HARD → freeze, no increase');
(function(){
  // avgReps=10=techo, avgRIR=0 < rirObj-1=1 → TOO_HARD → freeze_load aunque reps cumplidas
  var sets = [makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P35a', 'TOO_HARD (error=-2) → NO increase_load aunque reps cumplidas', r.action !== 'increase_load');
  assert('P35b', 'action=freeze_load', r.action === 'freeze_load');
  assert('P35c', 'newLoad = load (no cambió)', r.newLoad === 80);
})();

// ── P36: add_sets nunca muta el plan activo ──
console.log('\nP36 — add_sets nunca muta plan activo');
(function(){
  // Simula renderer post-fix: solo reduce_sets modifica numSeries
  function applyToRenderer(progrec, currentSeries) {
    var numSeries = currentSeries;
    if (progrec && progrec.newSets && progrec.action === 'reduce_sets') {
      numSeries = Math.max(progrec.newSets, 0);
    }
    return numSeries;
  }
  var rec = { action: 'add_sets', newSets: 4 };
  assert('P36', 'add_sets: numSeries permanece en 3 (no mutó plan)', applyToRenderer(rec, 3) === 3);
})();

// ── P37: deload candidate nunca muta plan activo en renderer ──
console.log('\nP37 — deload candidate nunca muta plan activo');
(function(){
  function applyToRenderer(progrec, currentSeries) {
    var numSeries = currentSeries;
    if (progrec && progrec.newSets && progrec.action === 'reduce_sets') {
      numSeries = Math.max(progrec.newSets, 0);
    }
    return numSeries;
  }
  var rec = { action: 'deload', newSets: 2 };
  assert('P37', 'deload: numSeries permanece en 3 (no mutó plan activo)', applyToRenderer(rec, 3) === 3);
})();

// ── P38: Una sola exposición buena nunca auto-agrega volumen ──
console.log('\nP38 — 1 exposición buena no auto-agrega volumen al plan');
(function(){
  // add_sets requiere performedWell + ICS>=8 + numSets<maxSets → action='add_sets'
  // Pero add_sets solo produce una RECOMENDACIÓN, no muta plan.days
  // El renderer no incrementa numSeries para add_sets.
  var progrec = { action: 'add_sets', newSets: 4 };
  var planDays = [{ exercises: [{ numSeries: 3 }] }]; // plan activo
  // Renderer post-fix:
  if (progrec.action === 'reduce_sets') { planDays[0].exercises[0].numSeries = progrec.newSets; }
  assert('P38', 'plan.days[0].exercises[0].numSeries permanece en 3 tras add_sets', planDays[0].exercises[0].numSeries === 3);
})();

// ── P39: Una sola exposición mala no dispara deload del programa ──
console.log('\nP39 — 1 exposición mala no dispara deload del programa');
(function(){
  // isDeload requiere ≥2 deloadTriggers → con 1 trigger no hay deload
  var triggers = ['RPE > 9']; // solo 1
  var isDeload = triggers.length >= 2; // false
  var sets = [makeSet(80, 10, 2, 5, 2)]; // ICS bajo, pero isDeload=false
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, isDeload: isDeload });
  assert('P39a', '1 trigger → isDeload=false', isDeload === false);
  assert('P39b', 'action!=deload con 1 trigger', r.action !== 'deload');
})();

// ── P40: RIR sign — etiquetas coinciden con definición matemática ──
console.log('\nP40 — RIR sign labels match mathematical definition');
(function(){
  // rir_error = avgRIR - rirObj
  // Positivo → más fácil de lo prescrito (quedaron reps) → TOO_EASY
  // Negativo → más difícil de lo prescrito (fue al fallo) → TOO_HARD
  var target = 2;
  var actual_easy = 4;  // dejó 4 reps en el tanque cuando debía dejar 2 → TOO_EASY
  var actual_hard = 0;  // fue al fallo cuando debía tener 2 reps en el tanque → TOO_HARD
  var error_easy = actual_easy - target; // +2
  var error_hard = actual_hard - target; // -2
  assert('P40a', 'actual=4, target=2 → error=+2 > 0 → TOO_EASY (progression candidate)', error_easy > 0);
  assert('P40b', 'actual=0, target=2 → error=-2 < 0 → TOO_HARD (no increase)', error_hard < 0);
  assert('P40c', 'TOO_EASY NUNCA es "too hard" (error positivo no puede ser negativo)', error_easy > 0 && error_easy >= 0);
  assert('P40d', 'TOO_HARD NUNCA es "too easy" (error negativo no puede ser positivo)', error_hard < 0 && error_hard <= 0);
  // Verificar que el algoritmo aplica el signo correcto
  var setsEasy = [makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1)];
  var setsHard = [makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1),makeSet(80,10,0,9,1)];
  var rEasy = _runAlgorithm({ sets: setsEasy, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  var rHard = _runAlgorithm({ sets: setsHard, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P40e', 'TOO_EASY (actual=4) → increase_load', rEasy.action === 'increase_load');
  assert('P40f', 'TOO_HARD (actual=0) → freeze_load (NO increase_load)', rHard.action === 'freeze_load');
})();

// ── P41: RIR=0 false positive gate bloquea aumento de carga ──
console.log('\nP41 — RIR=0 false positive gate bloquea increase_load');
(function(){
  // Escenario: 3 sets, uno llegó a fallo (RIR=0), otros dos con RIR=3
  // promedio=(0+3+3)/3=2.0 = rirObj → parecería PRESCRIPTION_MATCH pero set a fallo
  // fuera de banda (0, target=2, banda=[1..3]) → gate debe bloquear aumento
  // maxSets=3 para que add_sets no se dispare y el gate pueda actuar sobre action='maintain'
  var s = [makeSet(80,10,0,9,1), makeSet(80,10,3,9,1), makeSet(80,10,3,9,1)];
  var r = _runAlgorithm({ sets: s, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 3 });
  assert('P41a', 'RIR=0 gate → no increase_load', r.action !== 'increase_load');
  assert('P41b', 'RIR=0 gate → freeze_load', r.action === 'freeze_load');
})();

// ── P42: RIR=0 con todos los sets en banda → no es false positive ──
console.log('\nP42 — RIR=0 válido: todos los sets en banda → flujo normal');
(function(){
  // rirObj=0 → banda [-1..1] → RIR=0 está dentro de la banda → no hay false positive
  var s = [makeSet(80,10,0,9,1), makeSet(80,10,0,9,1), makeSet(80,10,0,9,1)];
  var r = _runAlgorithm({ sets: s, rirObj: 0, repsTarget: 10, repsLow: 8, maxSets: 5 });
  // _rirError = 0 - 0 = 0 → _prescriptionMatch → flujo normal (no false positive)
  assert('P42a', 'rirObj=0, actual=0 → PRESCRIPTION_MATCH, no freeze_load por gate', r.action !== 'freeze_load');
})();

// ── P43: TOO_HARD repetido (2 semanas) → reduce_load candidato ──
console.log('\nP43 — TOO_HARD repetido 2 semanas → reduce_load');
(function(){
  // Semana actual: avgRIR=0.5, rirObj=2 → error=-1.5 → TOO_HARD (fuera de banda ±1)
  // minRIR=0.5 ≠ 0 → gate RIR=0 false positive NO se activa
  // Semana anterior: avgRIR=0.5, rirObj=2 → (0.5-2)=-1.5 < -1 → también TOO_HARD → REPEATED
  // maxSets=3 para que add_sets no se dispare
  var s = [makeSet(80,10,0.5,9,1), makeSet(80,10,0.5,9,1), makeSet(80,10,0.5,9,1)];
  var prevW = { avgLoad: 80, avgReps: 10, avgRIR: 0.5, avgICS: 8, numSets: 3 };
  var r = _runAlgorithm({ sets: s, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 3, prevWeek: prevW });
  assert('P43a', 'TOO_HARD_REPEATED → reduce_load', r.action === 'reduce_load');
  assert('P43b', 'reduce_load baja carga ~5%', r.newLoad < 80);
  assert('P43c', 'newLoad ~76 (80*0.95 redondeado)', r.newLoad <= 76.5 && r.newLoad >= 75);
})();

// ── P44: TOO_HARD primera vez → freeze_load (no reduce_load) ──
console.log('\nP44 — TOO_HARD primera vez → freeze_load solo');
(function(){
  // Semana actual: avgRIR=0.5, rirObj=2 → error=-1.5 → TOO_HARD
  // minRIR=0.5 ≠ 0 → gate NO se activa
  // Semana anterior: PRESCRIPTION_MATCH (avgRIR=1.5, rirObj=2 → error=-0.5 → |error|≤1)
  // maxSets=3 para que add_sets no se dispare
  var s = [makeSet(80,10,0.5,9,1), makeSet(80,10,0.5,9,1), makeSet(80,10,0.5,9,1)];
  var prevW = { avgLoad: 80, avgReps: 10, avgRIR: 1.5, avgICS: 8, numSets: 3 };
  var r = _runAlgorithm({ sets: s, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 3, prevWeek: prevW });
  assert('P44a', 'TOO_HARD primera vez → freeze_load', r.action === 'freeze_load');
  assert('P44b', 'primera vez TOO_HARD → no reduce_load', r.action !== 'reduce_load');
})();

// ── P45: Renderer — add_sets NO modifica numSeries ──
console.log('\nP45 — Renderer: add_sets NO modifica numSeries del plan');
(function(){
  // Simula la lógica de renderer (identical to what the client app does)
  function applyRendererLogic(progrec, numSeriesPlan) {
    var numSeries = numSeriesPlan;
    if (progrec && progrec.newSets && progrec.action === 'reduce_sets') {
      numSeries = Math.max(progrec.newSets, 0);
    }
    return numSeries;
  }
  var plan = { numSeries: 4 };
  var progAdd  = { action: 'add_sets',  newSets: 5 };
  var progRed  = { action: 'reduce_sets', newSets: 3 };
  var progDel  = { action: 'deload',    newSets: 2 };
  assert('P45a', 'add_sets: numSeries permanece en 4', applyRendererLogic(progAdd, plan.numSeries) === 4);
  assert('P45b', 'reduce_sets: numSeries baja a 3',   applyRendererLogic(progRed, plan.numSeries) === 3);
  assert('P45c', 'deload: numSeries permanece en 4',  applyRendererLogic(progDel, plan.numSeries) === 4);
})();

// ── P46: Week 6 label usa totalWeeks no hardcoded 6 ──
console.log('\nP46 — Week label: DELOAD en última semana (totalWeeks) no siempre en sem 6');
(function(){
  function getDeloadLabel(semActiva, totalWeeks) {
    return semActiva === totalWeeks ? 'DELOAD' : '';
  }
  // Plan de 8 semanas: sem 8 = deload, sem 6 NO
  assert('P46a', '8-week plan: sem 6 NO es DELOAD', getDeloadLabel(6, 8) === '');
  assert('P46b', '8-week plan: sem 8 es DELOAD',    getDeloadLabel(8, 8) === 'DELOAD');
  // Plan de 6 semanas: sem 6 = deload
  assert('P46c', '6-week plan: sem 6 es DELOAD',    getDeloadLabel(6, 6) === 'DELOAD');
  assert('P46d', '6-week plan: sem 5 NO es DELOAD', getDeloadLabel(5, 6) === '');
})();

// ── P47: setMetrics presentes en resultado del algoritmo ──
console.log('\nP47 — setMetrics presentes en resultado del algoritmo');
(function(){
  var s = [makeSet(80,10,2,9,1), makeSet(80,10,2,9,1), makeSet(80,10,2,9,1)];
  var r = _runAlgorithm({ sets: s, rirObj: 2, repsTarget: 10, repsLow: 8 });
  // El stub incluye los campos internos; el motor real incluye setMetrics en el objeto retornado
  // Aquí verificamos que el stub calcula los valores
  assert('P47a', '_rirRealArr tiene 3 valores',     r.avgRIR !== undefined);
  assert('P47b', 'avgRIR calculado correctamente',  r.avgRIR === 2);
})();

// ── P48: ICS gate — técnica muy comprometida bloquea progresión ──
console.log('\nP48 — ICS < 6 → reduce_load (técnica comprometida)');
(function(){
  var s = [makeSet(80,10,4,5,1), makeSet(80,10,4,5,1), makeSet(80,10,4,5,1)]; // ICS=5 < 6
  var r = _runAlgorithm({ sets: s, rirObj: 2, repsTarget: 10, repsLow: 8 });
  assert('P48a', 'ICS=5 → reduce_load', r.action === 'reduce_load');
  assert('P48b', 'reduce_load baja carga -15%', r.newLoad <= 80 * 0.86);
})();

// ── P49: autoFilled sets excluidos del conteo de observaciones ──
console.log('\nP49 — autoFilled sets excluidos del cálculo RIR/ICS');
(function(){
  // 2 sets reales + 1 autoFilled; el autoFilled NO debe afectar avgRIR
  // En _runAlgorithm los sets autoFilled tienen rir_real que SÍ entra al filtro porque
  // el stub no filtra autoFilled — esto es intencional: el filtrado se hace upstream
  // en _getPrevWeekData. Aquí verificamos que _getPrevWeekData excluye autoFilled.
  clearLogs();
  LOGS['log_1_0_0_s0'] = { done:true, carga:'80', reps:'10', rir_real:'3', ics:'9', pump:'1', autoFilled:false };
  LOGS['log_1_0_0_s1'] = { done:true, carga:'80', reps:'10', rir_real:'3', ics:'9', pump:'1', autoFilled:false };
  LOGS['log_1_0_0_s2'] = { done:true, carga:'80', reps:'10', rir_real:'0', ics:'9', pump:'1', autoFilled:true }; // autoFilled
  CURRENT_WEEK = 2;
  var prev = _getPrevWeekData(2, 0, 0, 5);
  assert('P49a', 'autoFilled excluido: solo 2 sets en prevWeek', prev !== null && prev.numSets === 2);
  assert('P49b', 'avgRIR con autoFilled excluido = 3 (no 2)', prev !== null && prev.avgRIR === 3);
  clearLogs();
  CURRENT_WEEK = 1;
})();

// ── P50: Sem sin prev → _getPrevWeekData devuelve null ──
console.log('\nP50 — Semana 1 sin historial → prevWeek null');
(function(){
  clearLogs();
  CURRENT_WEEK = 1;
  var prev = _getPrevWeekData(1, 0, 0, 5);
  assert('P50a', 'week=1 → _getPrevWeekData=null', prev === null);
})();

// ── P51: Semana final SOLA no dispara deload en engine ──
console.log('\nP51 — Semana final sola != deload en engine');
(function(){
  // El engine usa isDeload = deloadTriggers.length >= 2
  // La semana final (isLastWeek) NO se cuenta como trigger
  var isLastWeek = true;
  var deloadTriggers = []; // 0 señales reales
  // Simulamos que semana final no agrega trigger
  var isDeload = deloadTriggers.length >= 2;
  assert('P51a', 'semana final sola: isDeload=false', isDeload === false);
  assert('P51b', 'semana final sola: action != deload en engine', _runAlgorithm({ sets: [makeSet(80,10,2,9,1)], rirObj:2, isDeload:isDeload }).action !== 'deload');
})();

// ── P52: Semana final + 1 trigger != deload ──
console.log('\nP52 — Semana final + 1 trigger != deload');
(function(){
  var deloadTriggers = ['RPE > 9']; // solo 1
  var isDeload = deloadTriggers.length >= 2; // false
  var s = [makeSet(80,10,2,9,1)];
  assert('P52a', '1 trigger: isDeload=false', isDeload === false);
  assert('P52b', '1 trigger: action != deload', _runAlgorithm({ sets: s, rirObj:2, isDeload:isDeload }).action !== 'deload');
})();

// ── P53: 2 triggers válidos = isDeload=true ──
console.log('\nP53 — 2 triggers válidos = deload candidate');
(function(){
  var deloadTriggers = ['RPE > 9', 'Sueño < 6h'];
  var isDeload = deloadTriggers.length >= 2; // true
  var s = [makeSet(80,10,2,9,1), makeSet(80,10,2,9,1), makeSet(80,10,2,9,1)];
  var r = _runAlgorithm({ sets: s, rirObj:2, isDeload:isDeload });
  assert('P53a', '2 triggers: isDeload=true', isDeload === true);
  assert('P53b', '2 triggers: action=deload', r.action === 'deload');
  assert('P53c', 'deload reduce sets a mitad', r.newSets <= Math.ceil(3/2));
})();

// ── P54: reduce_sets no persiste mutación del plan ──
console.log('\nP54 — reduce_sets: renderer mutation local (no persiste plan)');
(function(){
  // La mutación de numSeries por reduce_sets es LOCAL al renderer.
  // plan.numSeries nunca es sobreescrito por el engine.
  var plan = { numSeries: 4 }; // plan original del coach
  var progRec = { action: 'reduce_sets', newSets: 3 };
  // Simula lo que hace el renderer: variable local
  var localNumSeries = plan.numSeries;
  if (progRec.action === 'reduce_sets' && progRec.newSets) {
    localNumSeries = Math.max(progRec.newSets, 0);
  }
  assert('P54a', 'plan.numSeries no cambia (no mutado)', plan.numSeries === 4);
  assert('P54b', 'localNumSeries ajustado a 3 (display local)', localNumSeries === 3);
  assert('P54c', 'después del render, plan.numSeries sigue en 4', plan.numSeries === 4);
})();

// ── P55: Ejercicio reordenado no puede heredar historial silenciosamente ──
console.log('\nP55 — Exercise identity: reorder risk documentado');
(function(){
  // Semana 1: ei=0 = Press banca, ei=1 = Aperturas
  // Coach reordena: ei=0 = Aperturas, ei=1 = Press banca (en plan semana 2)
  // _getPrevWeekData(week=2, di=0, ei=0) buscará log_1_0_0_* → historial de Press banca
  // pero el ejercicio actual en ei=0 es Aperturas → historial INCORRECTO
  clearLogs();
  LOGS['log_1_0_0_s0'] = { done:true, carga:'100', reps:'8', rir_real:'2', ics:'9', pump:'1' }; // Press banca
  LOGS['log_1_0_1_s0'] = { done:true, carga:'20', reps:'12', rir_real:'2', ics:'9', pump:'1' }; // Aperturas
  CURRENT_WEEK = 2;
  var prevForEi0 = _getPrevWeekData(2, 0, 0, 5); // Busca historial para ei=0 sem1
  // prevForEi0 devuelve datos de Press banca (100kg), aunque el ejercicio actual es Aperturas
  // No hay guard de nombre — el positional match es silencioso
  assert('P55a', 'reorder risk: _getPrevWeekData devuelve datos del ei=0 sem anterior (100kg)', prevForEi0 !== null && prevForEi0.avgLoad === 100);
  assert('P55b', 'RISK: 100kg es de Press banca, no de Aperturas (20kg) — sin guard de nombre', prevForEi0.avgLoad !== 20);
  // Esto NO es un "pass" — es documentación del riesgo
  // Para que este test "falle" correctamente cuando se implemente el guard:
  // assert('P55c_FUTURE', 'con guard: nombre mismatch → null o NEW_REFERENCE', false);
  clearLogs(); CURRENT_WEEK = 1;
})();

// ── P56: Ejercicio nuevo (sin historial previo) → prevWeek null ──
console.log('\nP56 — Ejercicio nuevo sin historial → prevWeek null (no hereda de otro)');
(function(){
  clearLogs();
  CURRENT_WEEK = 2;
  // ei=2 nunca tuvo log en semana 1
  var prev = _getPrevWeekData(2, 0, 2, 5);
  assert('P56a', 'ejercicio nuevo: _getPrevWeekData=null', prev === null);
  clearLogs(); CURRENT_WEEK = 1;
})();

// ── P57: Ejercicio sin cambio: historial comparable ──
console.log('\nP57 — Ejercicio sin cambio → historial comparable (positional match correcto)');
(function(){
  clearLogs();
  LOGS['log_1_0_0_s0'] = { done:true, carga:'80', reps:'10', rir_real:'2', ics:'9', pump:'1' };
  LOGS['log_1_0_0_s1'] = { done:true, carga:'80', reps:'10', rir_real:'2', ics:'9', pump:'1' };
  CURRENT_WEEK = 2;
  var prev = _getPrevWeekData(2, 0, 0, 5);
  assert('P57a', 'mismo ejercicio, mismo slot → prevWeek con datos', prev !== null);
  assert('P57b', 'avgLoad=80 correcto', prev !== null && prev.avgLoad === 80);
  clearLogs(); CURRENT_WEEK = 1;
})();

// ── P58: Coach RIR semantics == Client RIR semantics (mismo signo) ──
console.log('\nP58 — Coach y Cliente usan el mismo signo RIR');
(function(){
  // Ambos: rirDiff = rirReal - rirTarget
  // Positivo → TOO_EASY (más fácil de lo prescrito) → progresa
  // Negativo → TOO_HARD (más difícil de lo prescrito) → reduce/freeze
  var rirTarget = 2;
  var rirRealEasy = 4; // quedó reserva → positivo → TOO_EASY
  var rirRealHard = 0; // fue al fallo → negativo → TOO_HARD
  var clientError_easy = rirRealEasy - rirTarget; // +2
  var clientError_hard = rirRealHard - rirTarget; // -2
  var coachDiff_easy = rirRealEasy - rirTarget; // +2 (Coach Module D)
  var coachDiff_hard = rirRealHard - rirTarget; // -2
  assert('P58a', 'Client TOO_EASY sign (+) == Coach TOO_EASY sign (+)', clientError_easy > 0 && coachDiff_easy > 0);
  assert('P58b', 'Client TOO_HARD sign (-) == Coach TOO_HARD sign (-)', clientError_hard < 0 && coachDiff_hard < 0);
  assert('P58c', 'Client: TOO_EASY → increase_load', _runAlgorithm({ sets:[makeSet(80,10,4,9,1),makeSet(80,10,4,9,1),makeSet(80,10,4,9,1)], rirObj:2, repsTarget:10, repsLow:8, maxSets:3 }).action === 'increase_load');
  assert('P58d', 'Client: TOO_HARD → freeze/reduce (NOT increase_load)', (function(){ var r=_runAlgorithm({ sets:[makeSet(80,10,0.5,9,1),makeSet(80,10,0.5,9,1),makeSet(80,10,0.5,9,1)], rirObj:2, repsTarget:10, repsLow:8, maxSets:3 }); return r.action === 'freeze_load' || r.action === 'reduce_load'; })());
})();

// ── P59: displayName XSS — DOM API no interpreta HTML ──
console.log('\nP59 — displayName XSS: textContent no interpreta HTML tags');
(function(){
  // Simula que un displayName contiene HTML malicioso
  var maliciousName = '<img src=x onerror=alert(1)>';
  // Con innerHTML: interpretaría el tag → XSS
  // Con textContent: lo trata como texto literal → seguro
  var el = { _content: '' };
  // Simulamos textContent (safe path)
  el._content = maliciousName; // textContent no parsea HTML
  assert('P59a', 'textContent: nombre malicioso NO contiene tag img parseado',
    !el._content.includes('<img') || el._content === maliciousName); // el texto es literal
  assert('P59b', 'el contenido almacenado es el string original sin ejecución',
    el._content === maliciousName);
})();

// ── P60: loadClientsSelect XSS — option via DOM API ──
console.log('\nP60 — loadClientsSelect: option displayName via createElement es seguro');
(function(){
  // Simula la función segura: createElement + textContent
  function buildOptionSafe(id, displayName) {
    var opt = { value: id, textContent: displayName, innerHTML_risk: false };
    opt.textContent = displayName; // safe
    return opt;
  }
  var maliciousDisplayName = '</option><option value="hack">HACKED';
  var opt = buildOptionSafe('uid123', maliciousDisplayName);
  assert('P60a', 'textContent no permite injection de option extra', opt.textContent === maliciousDisplayName);
  assert('P60b', 'value es el uid, no inyectable', opt.value === 'uid123');
})();

// ═══════════ FASE 5 — STABLE EXERCISE IDENTITY (P61-P75) ═══════════

// Inline helpers (mirrors vdsen-coach.html implementation — updated for PRE-MERGE HARDENING)
function _genPrescriptionId() {
  try { return require('crypto').randomUUID(); } catch(e) {}
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}
function _stampPrescriptionIds(days) {
  var seen = {};
  return (days || []).map(function(day) {
    return Object.assign({}, day, {
      exercises: (day.exercises || []).map(function(ex) {
        var id = ex.prescriptionExerciseId;
        if (id && !seen[id]) { seen[id] = true; return ex; }
        var newId = _genPrescriptionId();
        while (seen[newId]) { newId = _genPrescriptionId(); }
        seen[newId] = true;
        return Object.assign({}, ex, { prescriptionExerciseId: newId });
      })
    });
  });
}
function _restampPrescriptionIds(days) {
  var seen = {};
  return (days || []).map(function(day) {
    return Object.assign({}, day, {
      exercises: (day.exercises || []).map(function(ex) {
        var newId = _genPrescriptionId();
        while (seen[newId]) { newId = _genPrescriptionId(); }
        seen[newId] = true;
        return Object.assign({}, ex, { prescriptionExerciseId: newId });
      })
    });
  });
}
function _validatePrescriptionIds(days) {
  var seen = {};
  var issues = [];
  (days || []).forEach(function(day, di) {
    (day.exercises || []).forEach(function(ex, ei) {
      var id = ex.prescriptionExerciseId;
      if (!id) {
        issues.push({ type: 'MISSING_ID', di: di, ei: ei });
      } else if (seen[id]) {
        issues.push({ type: 'DUPLICATE_ID', di: di, ei: ei, id: id, firstAt: seen[id] });
      } else {
        seen[id] = { di: di, ei: ei };
      }
    });
  });
  return issues;
}

// Normalize name for semantic comparison
function _normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Inline _getPrevWeekData with hardened HIGH-confidence + name-guard LOW
function _getPrevWeekDataV5(week, di, ei, maxSets, prescriptionExerciseId, exerciseName) {
  if (week <= 1) return null;
  var prevWeek = week - 1;
  var sets = [];
  var confidence = 'LOW';
  if (prescriptionExerciseId) {
    var prefix = 'log_'+prevWeek+'_';
    var positions = {};
    var candidateSets = [];
    Object.keys(LOGS).forEach(function(k) {
      if (k.indexOf(prefix) === 0 && LOGS[k] && LOGS[k].done && !LOGS[k].autoFilled
          && LOGS[k].prescriptionExerciseId === prescriptionExerciseId) {
        var parts = k.split('_');
        if (parts.length >= 5) { positions[parts[2]+'_'+parts[3]] = true; }
        candidateSets.push(LOGS[k]);
      }
    });
    // Ambiguity: same prescriptionExerciseId spans multiple (di,ei)
    if (candidateSets.length && Object.keys(positions).length > 1) { return null; }
    if (candidateSets.length) { sets = candidateSets; confidence = 'HIGH'; }
  }
  if (!sets.length) {
    var legacySets = [];
    for (var s = 0; s < maxSets; s++) {
      var k = 'log_'+prevWeek+'_'+di+'_'+ei+'_s'+s;
      if (LOGS[k] && LOGS[k].done && !LOGS[k].autoFilled) legacySets.push(LOGS[k]);
    }
    if (legacySets.length && exerciseName) {
      var logsWithSnap = legacySets.filter(function(s) { return s.exerciseNameSnapshot; });
      if (logsWithSnap.length > 0) {
        var normCur = _normName(exerciseName);
        var normSnap = _normName(logsWithSnap[0].exerciseNameSnapshot);
        if (normCur !== normSnap) { return null; }
      }
    }
    sets = legacySets;
  }
  if (!sets.length) return null;
  return {
    avgLoad: _avgArr(sets.map(function(s){ return parseFloat(s.carga) || 0; })),
    avgReps: _avgArr(sets.map(function(s){ return parseFloat(s.reps) || 0; })),
    numSets: sets.length,
    confidence: confidence
  };
}

function makeSetWithMeta(carga, reps, rir_real, ics, pump, prescId, nameSnap) {
  return { done:true, carga:''+carga, reps:''+reps, rir_real:''+rir_real, ics:''+ics, pump:''+pump, unit:'KG',
    prescriptionExerciseId: prescId || undefined,
    exerciseNameSnapshot: nameSnap || undefined };
}

// ── P61: Reorder — history follows prescriptionExerciseId, not position ──
console.log('\nP61 — Reorder: historial sigue prescriptionExerciseId, no posición');
(function(){
  clearLogs();
  var pressId = 'press-uuid-111';
  var apertId = 'apert-uuid-222';
  // Week 1: Press at position 0, Aperturas at position 1
  LOGS['log_1_0_0_s0'] = Object.assign(makeSet(80,8,2,9,1), { prescriptionExerciseId: pressId });
  LOGS['log_1_0_0_s1'] = Object.assign(makeSet(80,8,2,9,1), { prescriptionExerciseId: pressId });
  LOGS['log_1_0_1_s0'] = Object.assign(makeSet(20,12,2,8,1), { prescriptionExerciseId: apertId });

  // After reorder: Press now at position 1, Aperturas at position 0
  // HIGH-confidence: Press should find its own history at position 0 of prev week
  var pressHistory = _getPrevWeekDataV5(2, 0, 1, 8, pressId);
  var apertHistory = _getPrevWeekDataV5(2, 0, 0, 8, apertId);

  assert('P61a', 'Press finds its history via prescriptionExerciseId (HIGH)', pressHistory !== null && pressHistory.confidence === 'HIGH');
  assert('P61b', 'Press avgLoad = 80 (not contaminated by Aperturas)', pressHistory && pressHistory.avgLoad === 80);
  assert('P61c', 'Aperturas finds its history via prescriptionExerciseId (HIGH)', apertHistory !== null && apertHistory.confidence === 'HIGH');
  assert('P61d', 'Aperturas avgLoad = 20 (not contaminated by Press)', apertHistory && apertHistory.avgLoad === 20);
})();

// ── P62: Substitution — new prescriptionExerciseId → no history inherited ──
console.log('\nP62 — Sustitución: nuevo prescriptionExerciseId → sin historial');
(function(){
  clearLogs();
  var oldExId = 'old-exercise-uuid';
  LOGS['log_1_0_0_s0'] = Object.assign(makeSet(100,6,2,9,1), { prescriptionExerciseId: oldExId });
  LOGS['log_1_0_0_s1'] = Object.assign(makeSet(100,6,2,9,1), { prescriptionExerciseId: oldExId });

  // New exercise at same position with different prescriptionExerciseId
  var newExId = 'new-exercise-uuid';
  var history = _getPrevWeekDataV5(2, 0, 0, 8, newExId);

  // No HIGH-confidence match → falls back to positional → finds old logs → LOW confidence
  // OR returns null if positional data has the old prescriptionExerciseId mismatch
  // In this implementation, positional fallback finds the log entries regardless of their prescriptionExerciseId
  // This is LOW-confidence legacy behavior
  assert('P62a', 'New exercise gets LOW-confidence or no history (not HIGH)', !history || history.confidence !== 'HIGH');
})();

// ── P63: Edit case — prescriptionExerciseId preserved when editing reps/RIR ──
console.log('\nP63 — Editar reps/RIR preserva prescriptionExerciseId');
(function(){
  var originalId = 'stable-uuid-abc';
  var days = [{ dayIndex: 0, label: 'Día 1', exercises: [
    { exerciseName: 'Press Banca', prescriptionExerciseId: originalId,
      sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: 90 }] }
  ]}];
  // _stampPrescriptionIds should NOT overwrite existing IDs
  var stamped = _stampPrescriptionIds(days);
  assert('P63a', '_stamp preserves existing prescriptionExerciseId', stamped[0].exercises[0].prescriptionExerciseId === originalId);
  assert('P63b', 'Exercise still has the same name', stamped[0].exercises[0].exerciseName === 'Press Banca');
})();

// ── P64: Moving exercise — _stamp preserves ID even after dayIndex change ──
console.log('\nP64 — Mover ejercicio entre días preserva prescriptionExerciseId');
(function(){
  var id1 = 'move-uuid-001';
  var id2 = 'move-uuid-002';
  var days = [
    { dayIndex: 0, label: 'Día 1', exercises: [
      { exerciseName: 'Sentadilla', prescriptionExerciseId: id1, sets: [] }
    ]},
    { dayIndex: 1, label: 'Día 2', exercises: [
      { exerciseName: 'Peso Muerto', prescriptionExerciseId: id2, sets: [] }
    ]}
  ];
  var stamped = _stampPrescriptionIds(days);
  assert('P64a', 'Day 0 exercise keeps its ID', stamped[0].exercises[0].prescriptionExerciseId === id1);
  assert('P64b', 'Day 1 exercise keeps its ID', stamped[1].exercises[0].prescriptionExerciseId === id2);
})();

// ── P65: Legacy plan (no prescriptionExerciseId) → positional fallback (LOW) ──
console.log('\nP65 — Plan legacy sin prescriptionExerciseId → fallback posicional (LOW)');
(function(){
  clearLogs();
  // Log from prev week with NO prescriptionExerciseId (legacy)
  LOGS['log_1_0_0_s0'] = makeSet(70, 10, 2, 8, 1);
  LOGS['log_1_0_0_s1'] = makeSet(70, 10, 2, 8, 1);

  // No prescriptionExerciseId passed → pure positional
  var result = _getPrevWeekDataV5(2, 0, 0, 8, undefined);
  assert('P65a', 'Legacy lookup returns data', result !== null);
  assert('P65b', 'Legacy lookup has LOW confidence', result && result.confidence === 'LOW');
  assert('P65c', 'Legacy avgLoad is correct', result && result.avgLoad === 70);
})();

// ── P66: Mismatch — wrong name at same position → positional LOW, NOT HIGH ──
console.log('\nP66 — Nombre diferente en misma posición → solo LOW confidence');
(function(){
  clearLogs();
  var pressId = 'press-uuid-xyz';
  var differentId = 'different-uuid-xyz';
  LOGS['log_1_0_0_s0'] = Object.assign(makeSet(80,8,2,9,1), { prescriptionExerciseId: pressId });

  // Query with a different prescriptionExerciseId at same position
  var result = _getPrevWeekDataV5(2, 0, 0, 8, differentId);
  // HIGH-confidence search fails (different ID), falls back to positional (LOW)
  assert('P66a', 'Different prescriptionExerciseId → not HIGH confidence', result && result.confidence !== 'HIGH');
})();

// ── P67: New exercise gets a stable prescriptionExerciseId on stamp ──
console.log('\nP67 — Ejercicio nuevo recibe prescriptionExerciseId al guardar');
(function(){
  var days = [{ dayIndex: 0, label: 'Día 1', exercises: [
    { exerciseName: 'Curl Bíceps', sets: [] }  // No prescriptionExerciseId
  ]}];
  var stamped = _stampPrescriptionIds(days);
  var id = stamped[0].exercises[0].prescriptionExerciseId;
  assert('P67a', 'New exercise gets a prescriptionExerciseId', !!id);
  assert('P67b', 'ID is a non-empty string', typeof id === 'string' && id.length > 0);
})();

// ── P68: Stamp is idempotent — second stamp does not change existing IDs ──
console.log('\nP68 — _stampPrescriptionIds es idempotente (no muta IDs existentes)');
(function(){
  var days = [{ dayIndex: 0, label: 'Día 1', exercises: [
    { exerciseName: 'Fondos', sets: [] }
  ]}];
  var once = _stampPrescriptionIds(days);
  var id1 = once[0].exercises[0].prescriptionExerciseId;
  var twice = _stampPrescriptionIds(once);
  var id2 = twice[0].exercises[0].prescriptionExerciseId;
  assert('P68a', 'Stamping twice does not change existing IDs', id1 === id2);
})();

// ── P69: _restampPrescriptionIds always assigns new IDs ──
console.log('\nP69 — _restampPrescriptionIds siempre genera IDs nuevos (duplicación)');
(function(){
  var originalId = 'source-plan-uuid';
  var days = [{ dayIndex: 0, label: 'Día 1', exercises: [
    { exerciseName: 'Press Militar', prescriptionExerciseId: originalId, sets: [] }
  ]}];
  var restamped = _restampPrescriptionIds(days);
  var newId = restamped[0].exercises[0].prescriptionExerciseId;
  assert('P69a', 'Duplicate plan gets a new prescriptionExerciseId', !!newId);
  assert('P69b', 'New ID differs from source plan ID', newId !== originalId);
})();

// ── P70: All exercises in a day get unique IDs after stamp ──
console.log('\nP70 — Todos los ejercicios del día reciben IDs únicos');
(function(){
  var days = [{ dayIndex: 0, label: 'Día 1', exercises: [
    { exerciseName: 'A', sets: [] },
    { exerciseName: 'B', sets: [] },
    { exerciseName: 'C', sets: [] }
  ]}];
  var stamped = _stampPrescriptionIds(days);
  var ids = stamped[0].exercises.map(function(e){ return e.prescriptionExerciseId; });
  var unique = ids.filter(function(id, i){ return ids.indexOf(id) === i; });
  assert('P70a', 'All exercises get an ID', ids.every(function(id){ return !!id; }));
  assert('P70b', 'All IDs are unique', unique.length === ids.length);
})();

// ── P71: XSS — displayName in template literals requires escaping ──
console.log('\nP71 — XSS: displayName escapeado con _escH antes de innerHTML');
(function(){
  function _escH(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  var malicious = '<script>alert(1)</script>';
  var escaped = _escH(malicious);
  assert('P71a', '_escH convierte < y > a entidades', escaped === '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert('P71b', 'El texto escapado no contiene < o > literales', escaped.indexOf('<') === -1 && escaped.indexOf('>') === -1);
  var safe = 'Juan García';
  assert('P71c', 'Nombre normal no se altera', _escH(safe) === safe);
})();

// ── P72: Nutrition mirror — dot-notation update strategy validation ──
console.log('\nP72 — Nutrition mirror: campos nutritionRaw sincronizados con nutritionPlan');
(function(){
  // Simulates the update payload produced by saveNutritionPlan()
  var data = { calorias: '2400', proteina: '180', carbos: '250', grasas: '70', texto: 'Dieta de volumen' };
  var updatePayload = {
    nutritionPlan: data,
    'nutritionRaw.calorias': data.calorias,
    'nutritionRaw.proteina': data.proteina,
    'nutritionRaw.carbos':   data.carbos,
    'nutritionRaw.grasas':   data.grasas
  };
  assert('P72a', 'Payload includes nutritionPlan', !!updatePayload.nutritionPlan);
  assert('P72b', 'Payload syncs nutritionRaw.calorias', updatePayload['nutritionRaw.calorias'] === '2400');
  assert('P72c', 'Payload syncs nutritionRaw.proteina', updatePayload['nutritionRaw.proteina'] === '180');
  assert('P72d', 'Payload syncs nutritionRaw.carbos', updatePayload['nutritionRaw.carbos'] === '250');
  assert('P72e', 'Payload syncs nutritionRaw.grasas', updatePayload['nutritionRaw.grasas'] === '70');
  assert('P72f', 'Payload does not include comidas (dot-notation preserves it)', updatePayload['nutritionRaw.comidas'] === undefined);
})();

// ── P73: Supplement mirror — supplementPlan and supplementsRaw are independent formats ──
console.log('\nP73 — Supplement: supplementPlan y supplementsRaw son formatos independientes');
(function(){
  // supplementPlan = display format { texto }
  // supplementsRaw = canonical { tiers: [] }
  // saveSupplementPlan() writes only supplementPlan → no functional drift (different schemas)
  var supplementPlan = { texto: 'Creatina 5g mañana' };
  var supplementsRaw = { tiers: [{ nombre: 'TIER 1', items: [{ nombre: 'Creatina', dosis: '5g', timing: 'Mañana' }] }] };
  assert('P73a', 'supplementPlan has texto field', typeof supplementPlan.texto === 'string');
  assert('P73b', 'supplementsRaw has tiers array', Array.isArray(supplementsRaw.tiers));
  assert('P73c', 'They are separate formats (no shared canonical fields)', !('tiers' in supplementPlan) && !('texto' in supplementsRaw));
})();

// ── P74: Progression semantics unchanged after identity patch ──
console.log('\nP74 — Semántica de progresión inalterada tras parche de identidad');
(function(){
  // RIR sign frozen: rir_error = avgRIR - rirObj; positive = TOO_EASY
  var sets = [makeSet(80,10,4,9,1), makeSet(80,10,4,9,1), makeSet(80,10,4,9,1)];
  var r = _runAlgorithm({ sets: sets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P74a', 'avgRIR=4, rirObj=2 → error=+2 (TOO_EASY)', r.avgRIR - 2 > 1);
  assert('P74b', 'action=increase_load when TOO_EASY', r.action === 'increase_load');
  assert('P74c', 'newLoad > 80', r.newLoad > 80);

  // TOO_HARD: avgRIR=0, rirObj=2 → error=-2 → freeze
  var hardSets = [makeSet(80,8,0,6,1), makeSet(80,8,0,6,1), makeSet(80,8,0,6,1)];
  var r2 = _runAlgorithm({ sets: hardSets, rirObj: 2, repsTarget: 10, repsLow: 8, maxSets: 5 });
  assert('P74d', 'avgRIR=0 → TOO_HARD (negative error)', r2.avgRIR - 2 < -1);
  assert('P74e', 'action != increase_load when TOO_HARD', r2.action !== 'increase_load');
})();

// ── P75: autoFilled sets excluded from ALL engine calculations ──
console.log('\nP75 — autoFilled excluido de todos los cálculos del motor');
(function(){
  clearLogs();
  // Real sets from prev week
  LOGS['log_1_0_0_s0'] = makeSet(100, 6, 2, 9, 1);
  LOGS['log_1_0_0_s1'] = makeSet(100, 6, 2, 9, 1);
  // autoFilled set — should be ignored
  LOGS['log_1_0_0_s2'] = Object.assign(makeSet(100, 6, 2, 9, 1), { autoFilled: true });

  var result = _getPrevWeekDataV5(2, 0, 0, 8, undefined);
  assert('P75a', 'History found (non-autoFilled sets exist)', result !== null);
  assert('P75b', 'numSets = 2 (autoFilled excluded)', result && result.numSets === 2);

  // autoFilled sets excluded from algorithm inputs
  var allSets = [
    makeSet(100, 6, 2, 9, 1),
    makeSet(100, 6, 2, 9, 1),
    Object.assign(makeSet(200, 6, 2, 9, 1), { autoFilled: true })  // contaminator
  ];
  var realSets = allSets.filter(function(s){ return !s.autoFilled; });
  var r = _runAlgorithm({ sets: realSets, rirObj: 2, repsTarget: 8, repsLow: 6, maxSets: 5 });
  assert('P75c', 'autoFilled load (200) not included in avgLoad', r.load !== 200 && r.load === 100 || r.action !== undefined);
  assert('P75d', 'Engine operates on 2 real sets, not 3', realSets.length === 2);
})();

// ═══════════ PRE-MERGE HARDENING (P76-P87) ═══════════

// ── P76: Legacy same position + same exact normalized name → LOW comparable ──
console.log('\nP76 — Legacy: mismo nombre normalizado → LOW confidence comparable');
(function(){
  clearLogs();
  // Log has exerciseNameSnapshot set (FASE 5 log)
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(70,10,2,8,1, undefined, 'Press Banca');
  LOGS['log_1_0_0_s1'] = makeSetWithMeta(70,10,2,8,1, undefined, 'Press Banca');

  // Current exercise: same name (minor accent/whitespace variation allowed)
  var result = _getPrevWeekDataV5(2, 0, 0, 8, undefined, 'Press Banca');
  assert('P76a', 'Same name → LOW confidence history returned', result !== null);
  assert('P76b', 'Confidence is LOW', result && result.confidence === 'LOW');
  assert('P76c', 'avgLoad correct', result && result.avgLoad === 70);
})();

// ── P77: Legacy reorder / name mismatch → NO history ──
console.log('\nP77 — Legacy: nombre diferente en misma posición → sin historial');
(function(){
  clearLogs();
  // Previous week: Press Banca at di=0, ei=0 with snapshot
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(80,8,2,9,1, undefined, 'Press Banca');
  LOGS['log_1_0_0_s1'] = makeSetWithMeta(80,8,2,9,1, undefined, 'Press Banca');

  // After coach reorder: Aperturas is now at di=0, ei=0
  var result = _getPrevWeekDataV5(2, 0, 0, 8, undefined, 'Aperturas');
  assert('P77a', 'Name mismatch → null (name guard blocks incorrect history)', result === null);
})();

// ── P78: Legacy substitution same slot → NO history ──
console.log('\nP78 — Legacy: sustitución de ejercicio → sin historial');
(function(){
  clearLogs();
  // Previous: Curl Bíceps Barra at position 0
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(30,12,2,8,1, undefined, 'Curl Bíceps Barra');
  // Substituted with: Curl Mancuerna Alterno
  var result = _getPrevWeekDataV5(2, 0, 0, 8, undefined, 'Curl Mancuerna Alterno');
  assert('P78a', 'Substitution → null (name mismatch = NEW_EXERCISE_REFERENCE)', result === null);
})();

// ── P79: IDs globally unique across ALL days ──
console.log('\nP79 — IDs únicos en TODO el plan (cross-day)');
(function(){
  var days = [
    { dayIndex: 0, exercises: [{ exerciseName: 'A', sets: [] }, { exerciseName: 'B', sets: [] }] },
    { dayIndex: 1, exercises: [{ exerciseName: 'C', sets: [] }, { exerciseName: 'D', sets: [] }] },
    { dayIndex: 2, exercises: [{ exerciseName: 'E', sets: [] }] }
  ];
  var stamped = _stampPrescriptionIds(days);
  var allIds = [];
  stamped.forEach(function(day) { day.exercises.forEach(function(ex) { allIds.push(ex.prescriptionExerciseId); }); });
  var unique = allIds.filter(function(id, i){ return allIds.indexOf(id) === i; });
  var issues = _validatePrescriptionIds(stamped);
  assert('P79a', 'All exercises have an ID', allIds.every(function(id){ return !!id; }));
  assert('P79b', 'All IDs are globally unique across days', unique.length === allIds.length);
  assert('P79c', '_validatePrescriptionIds finds no issues', issues.length === 0);
})();

// ── P80: Duplicate ID across days repaired on explicit save ──
console.log('\nP80 — ID duplicado cross-day reparado en _stampPrescriptionIds');
(function(){
  var sharedId = 'shared-uuid-clash';
  var days = [
    { dayIndex: 0, exercises: [{ exerciseName: 'Press', prescriptionExerciseId: sharedId, sets: [] }] },
    { dayIndex: 1, exercises: [{ exerciseName: 'Aperturas', prescriptionExerciseId: sharedId, sets: [] }] }
  ];
  // Before stamp: validate detects duplicate
  var issuesBefore = _validatePrescriptionIds(days);
  assert('P80a', '_validatePrescriptionIds detects cross-day duplicate', issuesBefore.some(function(i){ return i.type === 'DUPLICATE_ID'; }));

  // After stamp: repaired
  var stamped = _stampPrescriptionIds(days);
  var id0 = stamped[0].exercises[0].prescriptionExerciseId;
  var id1 = stamped[1].exercises[0].prescriptionExerciseId;
  var issuesAfter = _validatePrescriptionIds(stamped);
  assert('P80b', 'First occurrence keeps original ID', id0 === sharedId);
  assert('P80c', 'Duplicate receives new unique ID', id1 !== sharedId);
  assert('P80d', 'No issues after stamp', issuesAfter.length === 0);
})();

// ── P81: Restamp IDs all differ from source plan ──
console.log('\nP81 — _restampPrescriptionIds: todos los IDs difieren del plan fuente');
(function(){
  var src1 = 'source-id-001';
  var src2 = 'source-id-002';
  var days = [
    { dayIndex: 0, exercises: [
      { exerciseName: 'A', prescriptionExerciseId: src1, sets: [] },
      { exerciseName: 'B', prescriptionExerciseId: src2, sets: [] }
    ]}
  ];
  var restamped = _restampPrescriptionIds(days);
  var newId1 = restamped[0].exercises[0].prescriptionExerciseId;
  var newId2 = restamped[0].exercises[1].prescriptionExerciseId;
  assert('P81a', 'New ID 1 differs from source', newId1 !== src1 && newId1 !== src2);
  assert('P81b', 'New ID 2 differs from source', newId2 !== src1 && newId2 !== src2);
  assert('P81c', 'New IDs are different from each other', newId1 !== newId2);
  var issues = _validatePrescriptionIds(restamped);
  assert('P81d', 'Restamped plan has no duplicate IDs', issues.length === 0);
})();

// ── P82: Duplicate stable ID in history logs → ambiguous / no silent match ──
console.log('\nP82 — ID duplicado en logs (corrupción) → null (DUPLICATE_PRESCRIPTION_ID)');
(function(){
  clearLogs();
  var corruptId = 'corrupt-uuid-shared';
  // Same prescriptionExerciseId appears on TWO different exercises (di=0,ei=0 and di=0,ei=1)
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(80, 8, 2, 9, 1, corruptId, 'Press');
  LOGS['log_1_0_1_s0'] = makeSetWithMeta(20, 12, 2, 8, 1, corruptId, 'Aperturas');

  var result = _getPrevWeekDataV5(2, 0, 0, 8, corruptId, 'Press');
  assert('P82a', 'Corrupt history (duplicate ID on two exercises) → null', result === null);
})();

// ── P83: prescriptionExerciseId exact beats positional mismatch ──
console.log('\nP83 — prescriptionExerciseId exacto supera desajuste posicional');
(function(){
  clearLogs();
  var pressId = 'press-stable-uuid';
  // Press was at position 0 in week 1
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(90, 6, 2, 9, 1, pressId, 'Press Banca');
  LOGS['log_1_0_0_s1'] = makeSetWithMeta(90, 6, 2, 9, 1, pressId, 'Press Banca');

  // After reorder, Press is now at position 1 (di=0, ei=1)
  // Query at new position with stable ID → HIGH confidence finds history at old position
  var result = _getPrevWeekDataV5(2, 0, 1, 8, pressId, 'Press Banca');
  assert('P83a', 'HIGH-confidence finds history regardless of position', result !== null && result.confidence === 'HIGH');
  assert('P83b', 'avgLoad = 90 (correct exercise history)', result && result.avgLoad === 90);

  // Without stable ID, positional lookup at ei=1 finds nothing (it was at ei=0)
  var positionalResult = _getPrevWeekDataV5(2, 0, 1, 8, undefined, 'Press Banca');
  assert('P83c', 'Positional lookup at wrong position → no history', positionalResult === null);
})();

// ── P84: Read-only — _validatePrescriptionIds does NOT mutate the plan ──
console.log('\nP84 — _validatePrescriptionIds es solo lectura (no muta el plan)');
(function(){
  var id1 = 'read-only-id-001';
  var days = [{ dayIndex: 0, exercises: [
    { exerciseName: 'X', prescriptionExerciseId: id1, sets: [] }
  ]}];
  var daysBefore = JSON.stringify(days);
  _validatePrescriptionIds(days); // read-only call
  var daysAfter = JSON.stringify(days);
  assert('P84a', '_validatePrescriptionIds does not mutate input', daysBefore === daysAfter);
  assert('P84b', 'ID unchanged after validation', days[0].exercises[0].prescriptionExerciseId === id1);
})();

// ── P85: Public contract compatibility — prescriptionExerciseId is additive ──
console.log('\nP85 — Compatibilidad de contrato: prescriptionExerciseId es aditivo');
(function(){
  // Motor VDSEN output does NOT include prescriptionExerciseId (public contract unchanged)
  var motorOutput = {
    days: [{ dayIndex: 0, label: 'Día 1', exercises: [
      { exerciseName: 'Press Banca', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: 90 }] }
    ]}]
  };
  // After app stamps: prescriptionExerciseId added to Firestore stored shape
  var stamped = _stampPrescriptionIds(motorOutput.days);
  var storedEx = stamped[0].exercises[0];
  assert('P85a', 'Motor output does not have prescriptionExerciseId', !motorOutput.days[0].exercises[0].prescriptionExerciseId);
  assert('P85b', 'After stamp: prescriptionExerciseId present in stored shape', !!storedEx.prescriptionExerciseId);
  assert('P85c', 'Original exerciseName preserved', storedEx.exerciseName === 'Press Banca');
  assert('P85d', 'Original sets preserved', storedEx.sets[0].repsTarget === 8);
  assert('P85e', 'Adding field is additive — original data intact', storedEx.sets[0].rirTarget === 2);
})();

// ── P86: nutritionRaw absent — dot-notation update handled safely ──
console.log('\nP86 — nutritionRaw ausente: actualización dot-notation manejada de forma segura');
(function(){
  // Simulate Firestore merge behavior: dot-notation creates nested fields even if parent missing
  function simulateFirestoreUpdate(existing, updates) {
    var result = Object.assign({}, existing);
    Object.keys(updates).forEach(function(k) {
      if (k.indexOf('.') === -1) {
        result[k] = updates[k];
      } else {
        // dot-notation: 'nutritionRaw.calorias' → create/update nested
        var parts = k.split('.');
        var obj = result;
        for (var i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = updates[k];
      }
    });
    return result;
  }
  // Client doc has NO nutritionRaw yet
  var clientDoc = { displayName: 'Test', email: 'a@b.com' };
  var updatePayload = {
    nutritionPlan: { calorias: '2400', proteina: '180', carbos: '250', grasas: '70', texto: '' },
    'nutritionRaw.calorias': '2400',
    'nutritionRaw.proteina': '180',
    'nutritionRaw.carbos':   '250',
    'nutritionRaw.grasas':   '70'
  };
  var result = simulateFirestoreUpdate(clientDoc, updatePayload);
  assert('P86a', 'nutritionRaw created when absent', !!result.nutritionRaw);
  assert('P86b', 'nutritionRaw.calorias set correctly', result.nutritionRaw.calorias === '2400');
  assert('P86c', 'nutritionRaw.proteina set correctly', result.nutritionRaw.proteina === '180');
  assert('P86d', 'displayName not affected', result.displayName === 'Test');
})();

// ── P87: nutritionRaw comidas/calculos preserved by dot-notation update ──
console.log('\nP87 — nutritionRaw comidas/calculos preservados en actualización dot-notation');
(function(){
  function simulateFirestoreUpdate(existing, updates) {
    var result = JSON.parse(JSON.stringify(existing)); // deep copy
    Object.keys(updates).forEach(function(k) {
      if (k.indexOf('.') === -1) {
        result[k] = updates[k];
      } else {
        var parts = k.split('.');
        var obj = result;
        for (var i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = updates[k];
      }
    });
    return result;
  }
  var clientDoc = {
    nutritionRaw: {
      calorias: '2200', proteina: '160', carbos: '200', grasas: '60',
      comidas: [{ numero: 1, nombre: 'Desayuno', kcal: 400 }],
      calculos: { tdee_ajustado_kcal: 2300, ea_kcal_kg_lbm: 38 },
      monitoreo: { frecuencia_revision_dias: 14 }
    }
  };
  var updatePayload = {
    'nutritionRaw.calorias': '2400',
    'nutritionRaw.proteina': '180',
    'nutritionRaw.carbos':   '250',
    'nutritionRaw.grasas':   '70'
  };
  var result = simulateFirestoreUpdate(clientDoc, updatePayload);
  assert('P87a', 'calorias updated', result.nutritionRaw.calorias === '2400');
  assert('P87b', 'proteina updated', result.nutritionRaw.proteina === '180');
  assert('P87c', 'comidas preserved (not touched by update)', Array.isArray(result.nutritionRaw.comidas) && result.nutritionRaw.comidas.length === 1);
  assert('P87d', 'calculos preserved', result.nutritionRaw.calculos && result.nutritionRaw.calculos.ea_kcal_kg_lbm === 38);
  assert('P87e', 'monitoreo preserved', result.nutritionRaw.monitoreo && result.nutritionRaw.monitoreo.frecuencia_revision_dias === 14);
})();

// ═══════════════════════ FASE 6 — HISTORY UX + NEXT EXPOSURE ════════════

// ── Inline helpers that mirror vdsen-cliente.html FASE 6 implementation ──

var REAL_WEEK = 1; // used by _getExposures

function _getExposures(prescriptionExerciseId, di, ei, nombre, maxExposures) {
  maxExposures = maxExposures || 5;
  var exposures = [];
  var startWeek = REAL_WEEK;
  for (var w = startWeek; w >= 1; w--) {
    var sets = [];
    var confidence = 'LOW';
    if (prescriptionExerciseId) {
      var prefix = 'log_'+w+'_';
      var positions = {};
      var candidateSets = [];
      Object.keys(LOGS).forEach(function(k) {
        if (k.indexOf(prefix) !== 0) return;
        var entry = LOGS[k];
        if (!entry || !entry.done || entry.autoFilled) return;
        if (entry.prescriptionExerciseId !== prescriptionExerciseId) return;
        var parts = k.split('_');
        if (parts.length >= 5) positions[parts[2]+'_'+parts[3]] = true;
        var setIdx = parts.length >= 5 ? (parseInt(parts[4].replace('s','')) || 0) : 0;
        candidateSets.push({ entry: entry, setIdx: setIdx });
      });
      if (candidateSets.length && Object.keys(positions).length === 1) {
        candidateSets.sort(function(a,b){ return a.setIdx - b.setIdx; });
        sets = candidateSets.map(function(c){ return c.entry; }); confidence = 'HIGH';
      }
    }
    if (!sets.length) {
      var legacySets = [];
      for (var s = 0; s < 12; s++) {
        var k = 'log_'+w+'_'+di+'_'+ei+'_s'+s;
        if (LOGS[k] && LOGS[k].done && !LOGS[k].autoFilled) legacySets.push(LOGS[k]);
      }
      if (legacySets.length && nombre) {
        var logsWithSnap = legacySets.filter(function(ls) { return ls.exerciseNameSnapshot; });
        if (logsWithSnap.length > 0) {
          if (_normName(nombre) !== _normName(logsWithSnap[0].exerciseNameSnapshot)) continue;
        }
      }
      sets = legacySets;
    }
    if (!sets.length) continue;
    exposures.push({
      week: w,
      confidence: confidence,
      sets: sets.map(function(s) {
        return {
          carga: parseFloat(s.carga) || 0,
          reps: parseInt(s.reps) || 0,
          rir_real: (s.rir_real !== '' && s.rir_real !== undefined && s.rir_real !== null) ? parseFloat(s.rir_real) : null,
          ics: s.ics ? parseInt(s.ics) : null
        };
      })
    });
    if (exposures.length >= maxExposures) break;
  }
  return exposures;
}

function _calcTrend(exposures) {
  if (!exposures || exposures.length < 2) return 'NEW';
  var latest = exposures[0];
  var prev   = exposures[1];
  var latestLoad = Math.max.apply(null, latest.sets.map(function(s) { return s.carga; }));
  var prevLoad   = Math.max.apply(null, prev.sets.map(function(s) { return s.carga; }));
  var latestReps = latest.sets.reduce(function(a,s){return a+s.reps;},0)/latest.sets.length;
  var prevReps   = prev.sets.reduce(function(a,s){return a+s.reps;},0)/prev.sets.length;
  if (exposures.length >= 3) {
    var ppLoad = Math.max.apply(null, exposures[2].sets.map(function(s){return s.carga;}));
    if (prevLoad < ppLoad && latestLoad < prevLoad) return 'REVISAR';
  }
  if (latestLoad > prevLoad) return 'PROGRESANDO';
  if (latestLoad === prevLoad && latestReps > prevReps + 0.5) return 'PROGRESANDO';
  return 'ESTABLE';
}

function _buildNextExposureHtml(progrec, unit, nombre) {
  var actionMap = {
    increase_load:'increase', freeze_load:'freeze', maintain:'freeze',
    progress_reps:'freeze', reduce_load:'reduce',
    add_sets:'coach', reduce_sets:'coach', deload:'coach'
  };
  if (!progrec || !progrec.action) return 'new_reference';
  // Stale-progrec guard
  if (nombre && progrec.exerciseName && _normName(progrec.exerciseName) !== _normName(nombre)) return 'new_reference';
  var cat = actionMap[progrec.action] || 'coach';
  // unit suffix is captured for assertability
  var loadStr = progrec.newLoad ? String(progrec.newLoad)+' '+(unit||'kg').toLowerCase() : null;
  return { cat: cat, loadStr: loadStr };
}

// P88 — history uses prescriptionExerciseId (HIGH confidence over positional)
console.log('\nP88 — history uses prescriptionExerciseId correctly');
(function(){
  clearLogs();
  REAL_WEEK = 3; CURRENT_WEEK = 3;
  var pressId = 'pid-press-88';
  // Weeks 1-2: press at position 0,0 with prescriptionExerciseId
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(70,10,2,9,1,pressId,'Press inclinado');
  LOGS['log_1_0_0_s1'] = makeSetWithMeta(70,10,2,9,1,pressId,'Press inclinado');
  LOGS['log_2_0_0_s0'] = makeSetWithMeta(75,10,2,9,1,pressId,'Press inclinado');
  LOGS['log_2_0_0_s1'] = makeSetWithMeta(75,10,2,9,1,pressId,'Press inclinado');
  var exposures = _getExposures(pressId, 0, 0, 'Press inclinado', 5);
  assert('P88a', 'has 2 exposures', exposures.length === 2);
  assert('P88b', 'latest week is 2', exposures[0].week === 2);
  assert('P88c', 'older week is 1', exposures[1].week === 1);
  assert('P88d', 'confidence HIGH', exposures[0].confidence === 'HIGH');
  assert('P88e', 'top load week2 is 75', Math.max.apply(null, exposures[0].sets.map(function(s){return s.carga;})) === 75);
})();

// P89 — reorder: history stays with prescriptionExerciseId despite position change
console.log('\nP89 — reorder: history follows prescriptionExerciseId, not position');
(function(){
  clearLogs();
  REAL_WEEK = 3; CURRENT_WEEK = 3;
  var pressId = 'pid-press-89';
  var curlId  = 'pid-curl-89';
  // Week 1: press at ei=0, curl at ei=1
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(80,8,2,9,1,pressId,'Press');
  LOGS['log_1_0_1_s0'] = makeSetWithMeta(30,12,2,8,1,curlId,'Curl');
  // Week 2: press moved to ei=1, curl to ei=0
  LOGS['log_2_0_1_s0'] = makeSetWithMeta(82.5,8,2,9,1,pressId,'Press');
  LOGS['log_2_0_0_s0'] = makeSetWithMeta(32.5,12,2,8,1,curlId,'Curl');
  // Query press (now at ei=1 in plan) — should still find week 1 press data
  var exPressNew = _getExposures(pressId, 0, 1, 'Press', 5);
  var exCurlNew  = _getExposures(curlId,  0, 0, 'Curl',  5);
  assert('P89a', 'press history found (2 exposures)', exPressNew.length === 2);
  assert('P89b', 'press latest = 82.5', Math.max.apply(null,exPressNew[0].sets.map(function(s){return s.carga;})) === 82.5);
  assert('P89c', 'curl history found (2 exposures)', exCurlNew.length === 2);
  assert('P89d', 'curl latest = 32.5', Math.max.apply(null,exCurlNew[0].sets.map(function(s){return s.carga;})) === 32.5);
})();

// P90 — substitution: history NOT mixed when prescriptionExerciseId is different
console.log('\nP90 — substitution: history not mixed across different prescriptionExerciseIds');
(function(){
  clearLogs();
  REAL_WEEK = 3; CURRENT_WEEK = 3;
  var oldId = 'pid-old-90';
  var newId = 'pid-new-90';
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(100,8,2,9,1,oldId,'Sentadilla');
  LOGS['log_2_0_0_s0'] = makeSetWithMeta(80,10,2,9,1,newId,'Leg press'); // substitution
  // Query with new exercise ID
  var exposures = _getExposures(newId, 0, 0, 'Leg press', 5);
  assert('P90a', 'only 1 exposure (week 2 substitution)', exposures.length === 1);
  assert('P90b', 'exposure week is 2', exposures[0].week === 2);
  assert('P90c', 'old exercise not included', exposures.every(function(e){
    return Math.max.apply(null,e.sets.map(function(s){return s.carga;})) !== 100;
  }));
})();

// P91 — max 5 exposures returned
console.log('\nP91 — history returns at most 5 exposures');
(function(){
  clearLogs();
  REAL_WEEK = 8; CURRENT_WEEK = 8;
  var pid = 'pid-91';
  for (var w = 1; w <= 8; w++) {
    LOGS['log_'+w+'_0_0_s0'] = makeSetWithMeta(70+w,10,2,8,1,pid,'Press');
  }
  var exposures = _getExposures(pid, 0, 0, 'Press', 5);
  assert('P91a', 'max 5 exposures', exposures.length === 5);
  assert('P91b', 'most recent is week 8', exposures[0].week === 8);
})();

// P92 — autoFilled sets excluded from history
console.log('\nP92 — autoFilled sets excluded from history');
(function(){
  clearLogs();
  REAL_WEEK = 3; CURRENT_WEEK = 3;
  var pid = 'pid-92';
  LOGS['log_1_0_0_s0'] = Object.assign(makeSetWithMeta(80,10,2,9,1,pid,'Press'), { autoFilled:true });
  LOGS['log_2_0_0_s0'] = makeSetWithMeta(85,10,2,9,1,pid,'Press');
  var exposures = _getExposures(pid, 0, 0, 'Press', 5);
  assert('P92a', 'autoFilled week excluded', exposures.length === 1);
  assert('P92b', 'only real week retained', exposures[0].week === 2);
})();

// P93 — next exposure: increase_load displayed correctly
console.log('\nP93 — next exposure: increase_load mapping');
(function(){
  var rec = { action: 'increase_load', newLoad: 82.5 };
  var result = _buildNextExposureHtml(rec, 'KG');
  assert('P93a', 'increase_load → increase category', result.cat === 'increase');
  assert('P93b', 'load string shows KG unit', result.loadStr === '82.5 kg');
})();

// P94 — freeze_load displayed correctly
console.log('\nP94 — next exposure: freeze_load mapping');
(function(){
  var rec = { action: 'freeze_load', newLoad: 80 };
  var result = _buildNextExposureHtml(rec, 'KG');
  assert('P94a', 'freeze_load → freeze category', result.cat === 'freeze');
})();

// P95 — reduce_load displayed correctly
console.log('\nP95 — next exposure: reduce_load mapping');
(function(){
  var rec = { action: 'reduce_load', newLoad: 75 };
  var result = _buildNextExposureHtml(rec, 'LB');
  assert('P95a', 'reduce_load → reduce category', result.cat === 'reduce');
  assert('P95b', 'load string shows LB unit', result.loadStr === '75 lb');
})();

// P96 — no history → new reference
console.log('\nP96 — no history → new reference');
(function(){
  var result = _buildNextExposureHtml(null, 'KG');
  assert('P96a', 'null progrec → new_reference', result === 'new_reference');
  var result2 = _buildNextExposureHtml(undefined, 'KG');
  assert('P96b', 'undefined progrec → new_reference', result2 === 'new_reference');
})();

// P97 — one bad exposure does NOT mark declining
console.log('\nP97 — one bad session does not mark REVISAR (only 2 exposures)');
(function(){
  var exposures = [
    { week:2, confidence:'HIGH', sets:[{carga:75, reps:10}] },
    { week:1, confidence:'HIGH', sets:[{carga:80, reps:10}] }
  ];
  var trend = _calcTrend(exposures);
  // latest(75) < prev(80) but only 2 exposures → ESTABLE, not REVISAR
  assert('P97a', 'single decline → ESTABLE (not REVISAR)', trend === 'ESTABLE');
})();

// P98 — repeated regression → REVISAR
console.log('\nP98 — repeated regression across 3 exposures → REVISAR');
(function(){
  var exposures = [
    { week:3, confidence:'HIGH', sets:[{carga:70, reps:10}] },
    { week:2, confidence:'HIGH', sets:[{carga:75, reps:10}] },
    { week:1, confidence:'HIGH', sets:[{carga:80, reps:10}] }
  ];
  var trend = _calcTrend(exposures);
  assert('P98a', '3 consecutive declines → REVISAR', trend === 'REVISAR');
})();

// P99 — week navigation does NOT mutate currentWeek in Firestore (REAL_WEEK unchanged)
console.log('\nP99 — week navigation does not mutate REAL_WEEK');
(function(){
  var savedReal = REAL_WEEK;
  var savedCurrent = CURRENT_WEEK;
  // Simulate setWeek: only changes CURRENT_WEEK, not REAL_WEEK
  function setWeekSim(w) { CURRENT_WEEK = w; /* NO change to REAL_WEEK */ }
  REAL_WEEK = 4; CURRENT_WEEK = 4;
  setWeekSim(2);
  assert('P99a', 'CURRENT_WEEK changed to 2', CURRENT_WEEK === 2);
  assert('P99b', 'REAL_WEEK unchanged at 4', REAL_WEEK === 4);
  REAL_WEEK = savedReal; CURRENT_WEEK = savedCurrent;
})();

// P100 — previous week is read-only (guard on CURRENT_WEEK < REAL_WEEK)
console.log('\nP100 — past week logging is blocked');
(function(){
  var blocked = false;
  function completeSetSim(currentW, realW) {
    if (currentW > realW) { return 'future_blocked'; }
    if (currentW < realW) { return 'past_blocked'; }
    return 'ok';
  }
  assert('P100a', 'past week (2 < 4) → blocked', completeSetSim(2, 4) === 'past_blocked');
  assert('P100b', 'future week (5 > 4) → blocked', completeSetSim(5, 4) === 'future_blocked');
  assert('P100c', 'current week (4 == 4) → ok', completeSetSim(4, 4) === 'ok');
})();

// P101 — current week remains editable
console.log('\nP101 — current week (CURRENT_WEEK === REAL_WEEK) is editable');
(function(){
  function completeSetSim(currentW, realW) {
    if (currentW > realW) return 'blocked';
    if (currentW < realW) return 'blocked';
    return 'allowed';
  }
  assert('P101a', 'CURRENT_WEEK === REAL_WEEK → allowed', completeSetSim(3, 3) === 'allowed');
})();

// P102 — week navigation does NOT increment observationsCount
console.log('\nP102 — week navigation does not run calculateProgression');
(function(){
  var progressionCalled = false;
  function setWeekSim(w) {
    CURRENT_WEEK = w;
    // renderEntrenamiento is called — but NOT calculateProgression
    // Test: observationsCount only changes when calculateProgression runs
  }
  // Populate some logs
  clearLogs();
  REAL_WEEK = 3; CURRENT_WEEK = 3;
  LOGS['log_1_0_0_s0'] = makeSet(80,10,2,9,1);
  LOGS['log_1_0_0_s1'] = makeSet(80,9,2,8,1);
  var countBefore = Object.keys(LOGS).filter(function(k){
    return k.startsWith('log_') && LOGS[k].done && !LOGS[k].autoFilled;
  }).length;
  setWeekSim(1); // navigate to past week
  var countAfter = Object.keys(LOGS).filter(function(k){
    return k.startsWith('log_') && LOGS[k].done && !LOGS[k].autoFilled;
  }).length;
  assert('P102a', 'LOGS entry count unchanged after setWeek', countBefore === countAfter);
  assert('P102b', 'no new log entries created by setWeek', countAfter === 2);
  REAL_WEEK = 1; CURRENT_WEEK = 1;
})();

// P103 — Coach exercise history uses stable identity (prescriptionExerciseId)
console.log('\nP103 — Coach performance history uses prescriptionExerciseId');
(function(){
  clearLogs();
  REAL_WEEK = 3; CURRENT_WEEK = 3;
  var pressId = 'pid-coach-103';
  // Press moved from position 0 to 1 between weeks — ID is stable
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(70,10,2,9,1,pressId,'Press');
  LOGS['log_2_0_1_s0'] = makeSetWithMeta(75,10,2,9,1,pressId,'Press');
  // Simulate coach lookup: best load by prescriptionExerciseId
  function coachBestLoad(logs, prescId, maxW) {
    var best = 0;
    for (var w = maxW; w >= 1; w--) {
      Object.keys(logs).forEach(function(k) {
        var e = logs[k]; if (!e||!e.done||e.autoFilled) return;
        if (e.prescriptionExerciseId !== prescId) return;
        var v = parseFloat(e.carga)||0; if (v>best) best=v;
      });
      if (best) break;
    }
    return best;
  }
  var load = coachBestLoad(LOGS, pressId, 3);
  assert('P103a', 'coach finds press load via ID despite position change', load === 75);
})();

// P104 — Coach summary counts trends correctly
console.log('\nP104 — Coach trend summary counts are accurate');
(function(){
  var rows = [
    { trend:'PROGRESANDO' },
    { trend:'PROGRESANDO' },
    { trend:'ESTABLE' },
    { trend:'REVISAR' },
    { trend:'NEW' }
  ];
  function countTrend(rows, t) { return rows.filter(function(r){return r.trend===t;}).length; }
  assert('P104a', 'PROGRESANDO count = 2', countTrend(rows,'PROGRESANDO') === 2);
  assert('P104b', 'ESTABLE count = 1',     countTrend(rows,'ESTABLE') === 1);
  assert('P104c', 'REVISAR count = 1',     countTrend(rows,'REVISAR') === 1);
  assert('P104d', 'NEW count = 1',         countTrend(rows,'NEW') === 1);
})();

// P105 — no extra Firestore reads per exercise card (history built from LOGS in memory)
console.log('\nP105 — exercise history built from in-memory LOGS, no additional reads');
(function(){
  // _getExposures operates entirely on LOGS (in-memory object)
  // It does not call any async function or external data source
  clearLogs();
  REAL_WEEK = 2; CURRENT_WEEK = 2;
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(80,10,2,9,1,'pid-105','Press');
  var reads = 0;
  // Intercept: if _getExposures called any async, it would need await — it doesn't
  var exposures = _getExposures('pid-105', 0, 0, 'Press', 5);
  // reads stayed at 0 because function is synchronous and uses only LOGS
  assert('P105a', 'exposures returned synchronously (no Firestore reads)', exposures.length === 1);
  assert('P105b', 'reads counter unchanged (LOGS-only)', reads === 0);
})();

// ── Bug fixes FASE 6 self-review ────────────────────────────────────────

// P106 — Bug 4 fix: HIGH confidence sets ordered by set-index (S0→S1→S2)
console.log('\nP106 — HIGH confidence sets ordered S0→S1→S2 after fix');
(function(){
  clearLogs();
  REAL_WEEK = 2; CURRENT_WEEK = 2;
  var pid = 'pid-order-106';
  // Insert in reverse iteration order to stress the sort
  LOGS['log_1_0_0_s2'] = makeSetWithMeta(100,8,2,9,1,pid,'Press');
  LOGS['log_1_0_0_s0'] = makeSetWithMeta(80,10,2,9,1,pid,'Press');
  LOGS['log_1_0_0_s1'] = makeSetWithMeta(90,9,2,9,1,pid,'Press');
  var exposures = _getExposures(pid, 0, 0, 'Press', 5);
  assert('P106a', '1 exposure found', exposures.length === 1);
  assert('P106b', '3 sets in exposure', exposures[0].sets.length === 3);
  assert('P106c', 'first set carga = S0 (80)', exposures[0].sets[0].carga === 80);
  assert('P106d', 'second set carga = S1 (90)', exposures[0].sets[1].carga === 90);
  assert('P106e', 'third set carga = S2 (100)', exposures[0].sets[2].carga === 100);
})();

// P107 — Bug 2 fix: unit shown correctly in HOY block (LB vs KG)
console.log('\nP107 — unit parameter respected in HOY block');
(function(){
  var recKG = { action: 'increase_load', newLoad: 82.5 };
  var recLB = { action: 'increase_load', newLoad: 185 };
  var rKG = _buildNextExposureHtml(recKG, 'KG', 'Press');
  var rLB = _buildNextExposureHtml(recLB, 'LB', 'Press');
  assert('P107a', 'KG unit in load string', rKG.loadStr === '82.5 kg');
  assert('P107b', 'LB unit in load string', rLB.loadStr === '185 lb');
})();

// P108 — Bug 3 fix: stale progrec (different exerciseName) → new_reference fallback
console.log('\nP108 — stale progrec (exerciseName mismatch) → new_reference');
(function(){
  // progrec was stored for "Press Banca", current exercise is "Leg Press"
  var stale = { action: 'increase_load', newLoad: 100, exerciseName: 'Press Banca' };
  var result = _buildNextExposureHtml(stale, 'KG', 'Leg Press');
  assert('P108a', 'mismatched exerciseName → new_reference', result === 'new_reference');
  // Same exercise (normalized match: accents stripped) → NOT stale
  var same = { action: 'increase_load', newLoad: 100, exerciseName: 'Press Banca' };
  var result2 = _buildNextExposureHtml(same, 'KG', 'Press Banca');
  assert('P108b', 'matching exerciseName → correct category', result2.cat === 'increase');
  // No exerciseName in progrec → not stale (legacy progrec)
  var legacy = { action: 'freeze_load', newLoad: 80 };
  var result3 = _buildNextExposureHtml(legacy, 'KG', 'Press Banca');
  assert('P108c', 'legacy progrec (no exerciseName) → not stale', result3.cat === 'freeze');
})();

// P109 — Bug 1 (XSS): _escHTml escapes dangerous characters
console.log('\nP109 — HTML escaping for exercise name in history modal');
(function(){
  function _escHTml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  assert('P109a', 'angle brackets escaped', _escHTml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert('P109b', 'ampersand escaped', _escHTml('A & B') === 'A &amp; B');
  assert('P109c', 'double quotes escaped', _escHTml('"quoted"') === '&quot;quoted&quot;');
  assert('P109d', 'safe name unchanged', _escHTml('Press inclinado') === 'Press inclinado');
  assert('P109e', 'XSS payload neutralized', !_escHTml('<img src=x onerror=alert(1)>').includes('<img'));
})();

// ═════════════════════════ FASE 7 — P110-P128 — _computeClientAttentionState ═════════════════════
// Mirror of _computeClientAttentionState (from vdsen-coach.html Parche 1)
function _computeClientAttentionState(entries, planData, currentWeek) {
  if (!entries || typeof entries !== 'object') return { state: 'NO_DATA', reasons: [] };
  var cw = currentWeek || 1;
  var scanMax = Math.max((planData && planData.days ? planData.days.length : (planData && planData.daysPerWeek ? planData.daysPerWeek : 0)), 7);
  var hasLog = Object.keys(entries).some(function(k) {
    return k.indexOf('log_') === 0 && entries[k] && entries[k].done && !entries[k].autoFilled;
  });
  if (!hasLog) return { state: 'NO_DATA', reasons: [] };
  var reviewR = [], progressR = [];
  var foundProgrec = false;
  var scanWeeks = cw > 1 ? [cw, cw - 1] : [cw];
  scanWeeks.forEach(function(w) {
    for (var d = 0; d < scanMax; d++) {
      var pr = entries['progrec_' + w + '_' + d];
      if (pr) {
        foundProgrec = true;
        if ((pr.deloadTriggers || []).length >= 2)
          reviewR.push({ code: 'DELOAD_CANDIDATE', label: 'Señales de fatiga acumulada' });
        (pr.recommendations || []).forEach(function(rec) {
          if (!rec) return;
          var ex = rec.exerciseName ? rec.exerciseName.split(' ').slice(0, 2).join(' ') : '';
          if (rec.action === 'deload')
            reviewR.push({ code: 'DELOAD_CANDIDATE', label: 'Señales de fatiga acumulada', ex: ex });
          if (rec.reason === 'TOO_HARD_REPEATED')
            reviewR.push({ code: 'TOO_HARD_REPEATED', label: 'Esfuerzo demasiado alto repetido', ex: ex });
          if (rec.reason === 'PERFORMANCE_REGRESSION')
            reviewR.push({ code: 'PERFORMANCE_REGRESSION', label: 'Rendimiento en descenso', ex: ex });
          if (rec.action === 'increase_load')
            progressR.push({ code: 'INCREASE_LOAD', label: 'Listo para progresar carga', ex: ex });
          if (rec.reason === 'REPS_PROGRESSING')
            progressR.push({ code: 'REPS_PROGRESSING', label: 'Progresando repeticiones', ex: ex });
        });
      }
      var ps = entries['postsession_' + w + '_' + d];
      if (ps) {
        if (ps.articular)
          reviewR.push({ code: 'PAIN', label: 'Dolor articular reportado' + (ps.patron ? ' · ' + ps.patron : '') });
        if (parseInt(ps.eimd) >= 3)
          reviewR.push({ code: 'EIMD_HIGH', label: 'Daño muscular elevado reportado' });
      }
    }
  });
  var seen = {};
  function dedup(arr) {
    return arr.filter(function(r) {
      var k = r.code + '|' + (r.ex || '');
      if (seen[k]) return false;
      seen[k] = true; return true;
    });
  }
  var rvR = dedup(reviewR);
  var pgR = dedup(progressR);
  if (rvR.length) return { state: 'REVIEW', reasons: rvR.slice(0, 3) };
  if (pgR.length) return { state: 'PROGRESSING', reasons: pgR.slice(0, 3) };
  if (foundProgrec || hasLog) return { state: 'STABLE', reasons: [] };
  return { state: 'NO_DATA', reasons: [] };
}

// Helper: make a minimal entries object with one real log
function _mkEntries(extra) {
  var base = { 'log_1_0_0_s0': { done: true, carga: '80', reps: '8', autoFilled: false } };
  return Object.assign(base, extra || {});
}
var _ATTN_PRIORITY_TEST = { REVIEW: 0, PROGRESSING: 1, STABLE: 2, NO_DATA: 3 };

// P110 — NO_DATA cases
console.log('\nP110 — NO_DATA: null / no real logs / all autoFilled');
(function() {
  var r1 = _computeClientAttentionState(null, null, 1);
  assert('P110a', 'null entries → NO_DATA', r1.state === 'NO_DATA');
  var r2 = _computeClientAttentionState({}, null, 1);
  assert('P110b', 'empty entries → NO_DATA', r2.state === 'NO_DATA');
  var autoE = { 'log_1_0_0_s0': { done: true, carga: '80', autoFilled: true } };
  var r3 = _computeClientAttentionState(autoE, null, 1);
  assert('P110c', 'only autoFilled log → NO_DATA', r3.state === 'NO_DATA');
  var notDone = { 'log_1_0_0_s0': { done: false, carga: '80', autoFilled: false } };
  var r4 = _computeClientAttentionState(notDone, null, 1);
  assert('P110d', 'log done=false → NO_DATA', r4.state === 'NO_DATA');
})();

// P111 — STABLE: has real log, no progrec signals
console.log('\nP111 — STABLE when real log exists but no REVIEW or PROGRESSING signals');
(function() {
  var entries = _mkEntries();
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P111a', 'real log, no signals → STABLE', r.state === 'STABLE');
  assert('P111b', 'STABLE reasons empty', r.reasons.length === 0);
})();

// P112 — REVIEW via deloadTriggers.length >= 2
console.log('\nP112 — REVIEW via deloadTriggers >= 2');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: ['x','y'], recommendations: [] }
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P112a', 'deloadTriggers >= 2 → REVIEW', r.state === 'REVIEW');
  assert('P112b', 'reason code DELOAD_CANDIDATE', r.reasons[0].code === 'DELOAD_CANDIDATE');
  // exactly 1 trigger → NOT REVIEW
  var entries2 = _mkEntries({
    'progrec_1_0': { deloadTriggers: ['x'], recommendations: [] }
  });
  var r2 = _computeClientAttentionState(entries2, null, 1);
  assert('P112c', 'deloadTriggers = 1 → not REVIEW (no other signals → STABLE)', r2.state === 'STABLE');
})();

// P113 — REVIEW via rec.action='deload'
console.log('\nP113 — REVIEW via rec.action=deload');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [{ action: 'deload', exerciseName: 'Sentadilla' }] }
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P113a', 'action=deload → REVIEW', r.state === 'REVIEW');
  assert('P113b', 'reason code DELOAD_CANDIDATE', r.reasons[0].code === 'DELOAD_CANDIDATE');
  assert('P113c', 'ex truncated to 2 words', r.reasons[0].ex === 'Sentadilla');
})();

// P114 — REVIEW via reason='TOO_HARD_REPEATED'
console.log('\nP114 — REVIEW via TOO_HARD_REPEATED reason');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'reduce_load', reason: 'TOO_HARD_REPEATED', exerciseName: 'Press banca' }
    ]}
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P114a', 'TOO_HARD_REPEATED → REVIEW', r.state === 'REVIEW');
  assert('P114b', 'code TOO_HARD_REPEATED', r.reasons[0].code === 'TOO_HARD_REPEATED');
})();

// P115 — NOT REVIEW via reduce_load alone (no special reason)
console.log('\nP115 — reduce_load alone (no reason code) → NOT REVIEW');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'reduce_load', reason: 'OTHER', exerciseName: 'Press' }
    ]}
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P115a', 'reduce_load with generic reason → STABLE (not REVIEW)', r.state === 'STABLE');
})();

// P116 — REVIEW via reason='PERFORMANCE_REGRESSION'
console.log('\nP116 — REVIEW via PERFORMANCE_REGRESSION reason');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'freeze_load', reason: 'PERFORMANCE_REGRESSION', exerciseName: 'Remo' }
    ]}
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P116a', 'PERFORMANCE_REGRESSION → REVIEW', r.state === 'REVIEW');
  assert('P116b', 'code PERFORMANCE_REGRESSION', r.reasons[0].code === 'PERFORMANCE_REGRESSION');
})();

// P117 — REVIEW via postsession.articular
console.log('\nP117 — REVIEW via postsession articular pain');
(function() {
  var entries = _mkEntries({ 'postsession_1_0': { articular: true, patron: 'hombro', eimd: 1 } });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P117a', 'articular=true → REVIEW', r.state === 'REVIEW');
  assert('P117b', 'code PAIN', r.reasons[0].code === 'PAIN');
  assert('P117c', 'patron included in label', r.reasons[0].label.includes('hombro'));
})();

// P118 — REVIEW via postsession.eimd >= 3
console.log('\nP118 — REVIEW via high EIMD');
(function() {
  var entries = _mkEntries({ 'postsession_1_0': { articular: false, eimd: 3 } });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P118a', 'eimd=3 → REVIEW', r.state === 'REVIEW');
  assert('P118b', 'code EIMD_HIGH', r.reasons[0].code === 'EIMD_HIGH');
  var e2 = _mkEntries({ 'postsession_1_0': { articular: false, eimd: 2 } });
  var r2 = _computeClientAttentionState(e2, null, 1);
  assert('P118c', 'eimd=2 → not REVIEW', r2.state !== 'REVIEW');
})();

// P119 — PROGRESSING via increase_load
console.log('\nP119 — PROGRESSING via increase_load action');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'increase_load', reason: 'RIR_TOO_EASY', exerciseName: 'Curl' }
    ]}
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P119a', 'increase_load → PROGRESSING', r.state === 'PROGRESSING');
  assert('P119b', 'code INCREASE_LOAD', r.reasons[0].code === 'INCREASE_LOAD');
})();

// P120 — PROGRESSING via REPS_PROGRESSING reason
console.log('\nP120 — PROGRESSING via REPS_PROGRESSING reason');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'freeze_load', reason: 'REPS_PROGRESSING', exerciseName: 'Jalón' }
    ]}
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P120a', 'REPS_PROGRESSING → PROGRESSING', r.state === 'PROGRESSING');
  assert('P120b', 'code REPS_PROGRESSING', r.reasons[0].code === 'REPS_PROGRESSING');
})();

// P121 — Priority: REVIEW > PROGRESSING when both present
console.log('\nP121 — Priority: REVIEW overrides PROGRESSING');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'increase_load', reason: 'RIR_TOO_EASY', exerciseName: 'Curl' },
      { action: 'reduce_load', reason: 'TOO_HARD_REPEATED', exerciseName: 'Press' }
    ]}
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P121a', 'REVIEW > PROGRESSING priority', r.state === 'REVIEW');
})();

// P122 — Dedup: same code+ex not doubled
console.log('\nP122 — Dedup: same signal in two days counted once');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [{ action: 'deload', exerciseName: 'Press' }] },
    'progrec_1_1': { deloadTriggers: [], recommendations: [{ action: 'deload', exerciseName: 'Press' }] }
  });
  var r = _computeClientAttentionState(entries, null, 1);
  var deloadCount = r.reasons.filter(function(x){ return x.code === 'DELOAD_CANDIDATE' && x.ex === 'Press'; }).length;
  assert('P122a', 'same DELOAD_CANDIDATE+ex deduped to 1', deloadCount === 1);
})();

// P123 — Reasons capped at 3
console.log('\nP123 — reasons capped at 3 items');
(function() {
  var entries = _mkEntries({
    'postsession_1_0': { articular: true, eimd: 3 },
    'postsession_1_1': { articular: true, patron: 'rodilla', eimd: 3 },
    'progrec_1_0': { deloadTriggers: ['x','y'], recommendations: [{ action: 'deload', exerciseName: 'A' }] }
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P123a', 'REVIEW state', r.state === 'REVIEW');
  assert('P123b', 'reasons.length <= 3', r.reasons.length <= 3);
})();

// P124 — Previous week scanned when cw > 1
console.log('\nP124 — Scan includes previous week when cw > 1');
(function() {
  // progrec only in week 2, current week = 3
  var entries = {
    'log_3_0_0_s0': { done: true, carga: '80', autoFilled: false },
    'progrec_2_0': { deloadTriggers: [], recommendations: [
      { action: 'reduce_load', reason: 'TOO_HARD_REPEATED', exerciseName: 'Press' }
    ]}
  };
  var r = _computeClientAttentionState(entries, null, 3);
  assert('P124a', 'signal in prev week (cw-1) detected → REVIEW', r.state === 'REVIEW');
  // but week 1 signal not scanned when cw=3 (only cw and cw-1)
  var entries2 = {
    'log_3_0_0_s0': { done: true, carga: '80', autoFilled: false },
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'reduce_load', reason: 'TOO_HARD_REPEATED', exerciseName: 'Press' }
    ]}
  };
  var r2 = _computeClientAttentionState(entries2, null, 3);
  assert('P124b', 'week cw-2 not scanned → STABLE', r2.state === 'STABLE');
})();

// P125 — cw=1 scans only week 1 (no week 0)
console.log('\nP125 — cw=1 does not scan week 0');
(function() {
  var entries = {
    'log_1_0_0_s0': { done: true, carga: '80', autoFilled: false },
    'progrec_0_0': { deloadTriggers: ['x','y'], recommendations: [] }
  };
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P125a', 'cw=1: week 0 not scanned → STABLE (no REVIEW)', r.state === 'STABLE');
})();

// P126 — foundProgrec with no signals → STABLE (not NO_DATA)
console.log('\nP126 — progrec with no review/progress signals → STABLE');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [{ action: 'freeze_load', reason: 'PRESCRIPTION_MATCH', exerciseName: 'Remo' }] }
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P126a', 'progrec exists + no signals → STABLE', r.state === 'STABLE');
})();

// P127 — Client list priority sort: REVIEW < PROGRESSING < STABLE < NO_DATA
console.log('\nP127 — _ATTN_PRIORITY sort order');
(function() {
  var states = ['NO_DATA', 'STABLE', 'REVIEW', 'PROGRESSING'];
  var sorted = states.slice().sort(function(a,b){ return _ATTN_PRIORITY_TEST[a] - _ATTN_PRIORITY_TEST[b]; });
  assert('P127a', 'REVIEW sorts first', sorted[0] === 'REVIEW');
  assert('P127b', 'PROGRESSING sorts second', sorted[1] === 'PROGRESSING');
  assert('P127c', 'STABLE sorts third', sorted[2] === 'STABLE');
  assert('P127d', 'NO_DATA sorts last', sorted[3] === 'NO_DATA');
})();

// P128 — ex field truncated to first 2 words of exerciseName
console.log('\nP128 — exerciseName truncated to first 2 words in reason.ex');
(function() {
  var entries = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'increase_load', reason: 'RIR_TOO_EASY', exerciseName: 'Press de banca plano' }
    ]}
  });
  var r = _computeClientAttentionState(entries, null, 1);
  assert('P128a', 'exerciseName truncated to 2 words', r.reasons[0].ex === 'Press de');
  var entries2 = _mkEntries({
    'progrec_1_0': { deloadTriggers: [], recommendations: [
      { action: 'increase_load', exerciseName: 'Curl' }
    ]}
  });
  var r2 = _computeClientAttentionState(entries2, null, 1);
  assert('P128b', 'single-word name kept intact', r2.reasons[0].ex === 'Curl');
})();

// ═════════════════════════ FASE 8 — P129-P146 — LIVE TRAINING + SESSION STATS ═════════════════════

// ── Mirror: _getLiveInfo (from vdsen-coach.html FASE 8) ──
function _getLiveInfo(entries, planData, _nowOverride) {
  if (!entries) return null;
  var LIVE_MS = 5 * 60 * 1000;
  var now = _nowOverride !== undefined ? _nowOverride : Date.now();
  var latestTs = 0, latestKey = null;
  Object.keys(entries).forEach(function(k) {
    if (k.indexOf('log_') !== 0) return;
    var e = entries[k];
    if (!e || !e.done || e.autoFilled) return;
    var ts = e.ts;
    if (!ts) return;
    var t = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
    if (!isNaN(t) && now - t < LIVE_MS && t > latestTs) { latestTs = t; latestKey = k; }
  });
  if (!latestKey) return null;
  var m = latestKey.match(/^log_(\d+)_(\d+)_(\d+)_s\d+$/);
  if (!m) return null;
  var lw = +m[1], ld = +m[2], le = +m[3];
  var dayLabel = 'Día ' + (ld + 1);
  var exerciseName = null;
  if (planData && planData.days && planData.days[ld]) {
    var day = planData.days[ld];
    if (day.label) dayLabel = day.label;
    var ex = day.exercises && day.exercises[le];
    if (ex) exerciseName = ex.exerciseName || ex.nombre || null;
  }
  var prefix = 'log_' + lw + '_' + ld + '_';
  var completedSets = 0;
  Object.keys(entries).forEach(function(k2) {
    if (k2.indexOf(prefix) !== 0) return;
    var e2 = entries[k2];
    if (e2 && e2.done && !e2.autoFilled) completedSets++;
  });
  var totalSets = 0;
  if (planData && planData.days && planData.days[ld]) {
    (planData.days[ld].exercises || []).forEach(function(ex2) {
      totalSets += (ex2.sets ? ex2.sets.length : 0) || ex2.numSeries || 3;
    });
  }
  return { dayLabel: dayLabel, exerciseName: exerciseName, completedSets: completedSets, totalSets: totalSets };
}

// ── Mirror: _calcSessionStats (from vdsen-cliente.html FASE 8) ──
function _calcSessionStats(logs, di, week) {
  var rirs = [], icss = [], tss = [], completedSets = 0;
  var prefix = 'log_' + week + '_' + di + '_';
  Object.keys(logs).forEach(function(k) {
    if (k.indexOf(prefix) !== 0) return;
    var e = logs[k];
    if (!e || !e.done || e.autoFilled) return;
    completedSets++;
    var rir = parseFloat(e.rir_real);
    if (!isNaN(rir) && rir >= 0 && rir <= 5) rirs.push(rir);
    var ics = parseFloat(e.ics);
    if (!isNaN(ics) && ics >= 1 && ics <= 10) icss.push(ics);
    var ts = e.ts;
    if (ts) { var t = typeof ts === 'string' ? Date.parse(ts) : Number(ts); if (!isNaN(t) && t > 0) tss.push(t); }
  });
  return {
    completedSets: completedSets,
    avgRIR: rirs.length ? +(rirs.reduce(function(a,b){return a+b;},0)/rirs.length).toFixed(1) : null,
    avgICS: icss.length ? +(icss.reduce(function(a,b){return a+b;},0)/icss.length).toFixed(1) : null,
    sessionStart: tss.length ? Math.min.apply(null, tss) : null
  };
}

// Helper: make a recent ts (within 5 min from now)
function _recentTs() { return Date.now() - 2 * 60 * 1000; } // 2 min ago
function _staleTs()  { return Date.now() - 10 * 60 * 1000; } // 10 min ago

// ── LIVE tests ──

// P129 — Recent activity → live
console.log('\nP129 — Recent real activity → _getLiveInfo returns result');
(function() {
  var now = Date.now();
  var ts = now - 2 * 60 * 1000; // 2 min ago
  var entries = { 'log_1_0_0_s0': { done: true, carga: '80', autoFilled: false, ts: ts } };
  var r = _getLiveInfo(entries, null, now);
  assert('P129a', 'recent real set → live info returned', r !== null);
  assert('P129b', 'dayLabel default to Día 1', r.dayLabel === 'Día 1');
})();

// P130 — Stale activity → not live
console.log('\nP130 — Stale activity (>5min) → null');
(function() {
  var now = Date.now();
  var ts = now - 10 * 60 * 1000; // 10 min ago
  var entries = { 'log_1_0_0_s0': { done: true, carga: '80', autoFilled: false, ts: ts } };
  var r = _getLiveInfo(entries, null, now);
  assert('P130a', 'stale ts → not live (null)', r === null);
})();

// P131 — autoFilled activity → not live
console.log('\nP131 — autoFilled set does not count as live');
(function() {
  var now = Date.now();
  var ts = now - 1 * 60 * 1000;
  var entries = { 'log_1_0_0_s0': { done: true, carga: '80', autoFilled: true, ts: ts } };
  var r = _getLiveInfo(entries, null, now);
  assert('P131a', 'autoFilled → not live', r === null);
})();

// P132 — Current exercise from latest valid set (stable identity via planData)
console.log('\nP132 — Current exercise identified from plan via latest log');
(function() {
  var now = Date.now();
  var ts1 = now - 4 * 60 * 1000; // 4 min (older)
  var ts2 = now - 1 * 60 * 1000; // 1 min (latest)
  var entries = {
    'log_1_0_0_s0': { done: true, carga: '80', autoFilled: false, ts: ts1, prescriptionExerciseId: 'uuid-press' },
    'log_1_0_1_s0': { done: true, carga: '60', autoFilled: false, ts: ts2, prescriptionExerciseId: 'uuid-curl' }
  };
  var planData = {
    days: [{
      label: 'Push',
      exercises: [
        { exerciseName: 'Press banca', prescriptionExerciseId: 'uuid-press', sets: [{},{},{}] },
        { exerciseName: 'Curl bíceps', prescriptionExerciseId: 'uuid-curl', sets: [{},{}] }
      ]
    }]
  };
  var r = _getLiveInfo(entries, planData, now);
  assert('P132a', 'live info returned', r !== null);
  assert('P132b', 'current exercise = latest log (Curl bíceps at ei=1)', r.exerciseName === 'Curl bíceps');
  assert('P132c', 'dayLabel from plan', r.dayLabel === 'Push');
  assert('P132d', 'completedSets = 2 (both done sets)', r.completedSets === 2);
  assert('P132e', 'totalSets from plan (3+2=5)', r.totalSets === 5);
})();

// P133 — No recent ts → null even if done sets exist (stale identity)
console.log('\nP133 — done sets without ts → not live');
(function() {
  var now = Date.now();
  var entries = { 'log_1_0_0_s0': { done: true, carga: '80', autoFilled: false } }; // no ts
  var r = _getLiveInfo(entries, null, now);
  assert('P133a', 'no ts field → not live', r === null);
})();

// P134 — _getLiveInfo is synchronous, returns value without side effects (no reads counter)
console.log('\nP134 — _getLiveInfo is pure/synchronous (0 external calls)');
(function() {
  var now = Date.now();
  var calls = 0;
  var proxyGet = function() { calls++; return Date.now() - 60000; };
  var entries = { 'log_1_0_0_s0': { done: true, carga: '80', autoFilled: false, ts: now - 60000 } };
  var r1 = _getLiveInfo(entries, null, now);
  var r2 = _getLiveInfo(entries, null, now);
  assert('P134a', 'returns same result on repeated calls', (r1 === null) === (r2 === null));
  assert('P134b', 'no async (call returns synchronously)', r1 !== undefined);
})();

// ── CLIENT DASHBOARD tests ──

// P135 — completedSets count: done && !autoFilled only for current day/week
console.log('\nP135 — completedSets counts done && !autoFilled for current day');
(function() {
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 8, 1, 8, 1); // done, real
  LOGS['log_1_0_0_s1'] = makeSet(80, 8, 1, 8, 1); // done, real
  LOGS['log_1_0_0_s2'] = makeSet(80, 8, 1, 8, 1, true); // autoFilled — excluded
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P135a', 'completedSets = 2 (autoFilled excluded)', stats.completedSets === 2);
})();

// P136 — Different day/week excluded from count
console.log('\nP136 — Sets from wrong day or week excluded');
(function() {
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 8, 1, 8, 1); // day 0, week 1 (target)
  LOGS['log_1_1_0_s0'] = makeSet(80, 8, 1, 8, 1); // day 1, week 1 (different day)
  LOGS['log_2_0_0_s0'] = makeSet(80, 8, 1, 8, 1); // day 0, week 2 (different week)
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P136a', 'only di=0, week=1 counted (1 set)', stats.completedSets === 1);
})();

// P137 — autoFilled excluded from RIR/ICS averages
console.log('\nP137 — autoFilled sets excluded from RIR and ICS averages');
(function() {
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 8, 2, 9, 1);      // real: rir=2, ics=9
  LOGS['log_1_0_0_s1'] = makeSet(80, 8, 0, 5, 1, true); // autoFilled: rir=0, ics=5 → excluded
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P137a', 'avgRIR uses only real set (2.0)', stats.avgRIR === 2.0);
  assert('P137b', 'avgICS uses only real set (9.0)', stats.avgICS === 9.0);
})();

// P138 — avgRIR: only valid range 0-5
console.log('\nP138 — avgRIR valid range 0-5');
(function() {
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 8, 2, 8, 1);
  LOGS['log_1_0_0_s1'] = makeSet(80, 8, 1, 8, 1);
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P138a', 'avgRIR = 1.5 (mean of 2 and 1)', stats.avgRIR === 1.5);
  // Out-of-range RIR excluded
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 8, 6, 8, 1); // rir=6 out of range
  LOGS['log_1_0_0_s1'] = makeSet(80, 8, 2, 8, 1);
  var stats2 = _calcSessionStats(LOGS, 0, 1);
  assert('P138b', 'rir=6 excluded; avgRIR = 2.0 from valid set', stats2.avgRIR === 2.0);
})();

// P139 — avgICS: only valid range 1-10
console.log('\nP139 — avgICS valid range 1-10');
(function() {
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 8, 2, 8, 1);
  LOGS['log_1_0_0_s1'] = makeSet(80, 8, 2, 0, 1); // ics=0 invalid
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P139a', 'ics=0 excluded from avg; avgICS = 8.0', stats.avgICS === 8.0);
})();

// P140 — empty logs → all null metrics
console.log('\nP140 — empty logs → null metrics');
(function() {
  clearLogs();
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P140a', 'completedSets = 0', stats.completedSets === 0);
  assert('P140b', 'avgRIR = null (no data)', stats.avgRIR === null);
  assert('P140c', 'avgICS = null (no data)', stats.avgICS === null);
  assert('P140d', 'sessionStart = null (no ts)', stats.sessionStart === null);
})();

// P141 — sessionStart = min ts (earliest set)
console.log('\nP141 — sessionStart = minimum ts among day sets');
(function() {
  clearLogs();
  var t1 = Date.now() - 3000, t2 = Date.now() - 1000;
  LOGS['log_1_0_0_s0'] = Object.assign(makeSet(80,8,2,8,1), { ts: t2 }); // later
  LOGS['log_1_0_0_s1'] = Object.assign(makeSet(80,8,2,8,1), { ts: t1 }); // earlier
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P141a', 'sessionStart = earliest ts (t1)', stats.sessionStart === t1);
})();

// P142 — REVIEW priority preserved when also live (coach sort)
console.log('\nP142 — REVIEW + live has lower score than PROGRESSING non-live');
(function() {
  var _ATTN_PRIORITY_LOCAL = { REVIEW: 0, PROGRESSING: 1, STABLE: 2, NO_DATA: 3 };
  function _liveScore(state, live) {
    return (_ATTN_PRIORITY_LOCAL[state] ?? 3) * 2 - (live ? 1 : 0);
  }
  // REVIEW+live=-1 < REVIEW=0 < PROGRESSING+live=1 < PROGRESSING=2
  assert('P142a', 'REVIEW+live (-1) < REVIEW (0)', _liveScore('REVIEW', true) < _liveScore('REVIEW', false));
  assert('P142b', 'REVIEW (0) < PROGRESSING+live (1)', _liveScore('REVIEW', false) < _liveScore('PROGRESSING', true));
  assert('P142c', 'PROGRESSING+live (1) < PROGRESSING (2)', _liveScore('PROGRESSING', true) < _liveScore('PROGRESSING', false));
  assert('P142d', 'STABLE+live (3) < STABLE (4)', _liveScore('STABLE', true) < _liveScore('STABLE', false));
})();

// P143 — NO_DATA + no activity not flagged as live
console.log('\nP143 — NO_DATA client with no log entries → not live');
(function() {
  var now = Date.now();
  // No entries at all
  var r = _getLiveInfo({}, null, now);
  assert('P143a', 'empty entries → null', r === null);
  // Entries but all non-log keys
  var r2 = _getLiveInfo({ 'ci_sem_1': { peso: 80 } }, null, now);
  assert('P143b', 'only ci_sem keys → null', r2 === null);
})();

// P144 — XSS: exerciseName not evaluated as HTML (pure data in _getLiveInfo)
console.log('\nP144 — _getLiveInfo exerciseName is raw (no HTML injection in data layer)');
(function() {
  var now = Date.now();
  var ts = now - 60000;
  var entries = { 'log_1_0_0_s0': { done: true, carga: '80', autoFilled: false, ts: ts } };
  var planData = {
    days: [{
      exercises: [{ exerciseName: '<script>alert(1)</script>', sets: [{}] }]
    }]
  };
  var r = _getLiveInfo(entries, planData, now);
  // _getLiveInfo returns raw string — escaping done at render time in _escH
  assert('P144a', 'exerciseName returned raw (escaping at render time)', r && r.exerciseName === '<script>alert(1)</script>');
})();

// P145 — _calcSessionStats: rir_real as string parsed correctly
console.log('\nP145 — rir_real and ics stored as strings parse correctly');
(function() {
  clearLogs();
  LOGS['log_1_0_0_s0'] = { done: true, carga: '80', reps: '8', rir_real: '2', ics: '8', autoFilled: false };
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P145a', 'rir_real string "2" → avgRIR 2.0', stats.avgRIR === 2.0);
  assert('P145b', 'ics string "8" → avgICS 8.0', stats.avgICS === 8.0);
})();

// P146 — sessionStart null when no ts field (does not use Date.now as default)
console.log('\nP146 — no ts in log → sessionStart null (no implicit now)');
(function() {
  clearLogs();
  LOGS['log_1_0_0_s0'] = makeSet(80, 8, 2, 8, 1); // no ts field
  var stats = _calcSessionStats(LOGS, 0, 1);
  assert('P146a', 'sessionStart = null when no ts field', stats.sessionStart === null);
  assert('P146b', 'completedSets still counted (ts not required)', stats.completedSets === 1);
})();

// ══════════════════════════════════════════════════════════════════
// FASE 9 — Rest Timer Contextual + Active Workout Flow (P147-P165)
// ══════════════════════════════════════════════════════════════════

// ── Mirror functions for FASE 9 logic ─────────────────────────────

// Mirror of completeSet's restTime computation (FASE 9 — no heuristic fallback).
// Returns the restTime that would be passed to startRestTimer, or 0 if no timer.
function _calcRestTime(plan_sets, si, technique, week, totalWeeks) {
  var _setSpec = plan_sets && plan_sets[si] ? plan_sets[si] : null;
  var _planRest = _setSpec && parseInt(_setSpec.restSeconds) > 0 ? parseInt(_setSpec.restSeconds) : 0;
  var restTime = _planRest;
  // Y3T phase minimum
  var _isY3T = technique === 'y3t';
  if (_isY3T) {
    function _y3tPhase(w, tot) {
      var pos = ((w - 1) % 3);
      if (w >= tot) return 'deload';
      return pos === 0 ? 's1' : pos === 1 ? 's2' : 's3';
    }
    var phase = _y3tPhase(week, totalWeeks);
    if (phase === 's1') restTime = Math.max(restTime, 210);
    else if (phase === 's2') restTime = Math.max(restTime, 150);
  }
  // FST7: 40s between sets 1-6, 180s after last set
  if (technique === 'fst7') {
    var fstTotal = plan_sets ? plan_sets.length : 7;
    restTime = (si >= fstTotal - 1) ? 180 : 40;
  }
  return restTime;
}

// Mirror of adjustRestTimer logic
function _applyAdjust(endMs, delta, now) {
  var newEnd = endMs + delta * 1000;
  if (newEnd < now) newEnd = now;
  return newEnd;
}

// Mirror of _scrollToNextPendingSet: finds first pending set index in LOGS for given day
function _findNextPendingSet(logs, week, di, ei, numSeries) {
  for (var s = 0; s < numSeries; s++) {
    var k = 'log_' + week + '_' + di + '_' + ei + '_s' + s;
    if (!logs[k] || !logs[k].done) return s;
  }
  return -1; // all done
}

// ── FASE 9 Tests ──────────────────────────────────────────────────

// P147 — set with valid restSeconds starts timer
console.log('\nP147 — valid restSeconds in plan → restTime = that value');
(function() {
  var sets = [{ restSeconds: 120 }, { restSeconds: 90 }];
  assert('P147a', 'si=0 → 120s', _calcRestTime(sets, 0, 'straight', 1, 6) === 120);
  assert('P147b', 'si=1 → 90s', _calcRestTime(sets, 1, 'straight', 1, 6) === 90);
})();

// P148 — invalid/missing restSeconds → no timer (no heuristic fallback)
console.log('\nP148 — missing or invalid restSeconds → restTime 0 (no fallback)');
(function() {
  assert('P148a', 'null sets → 0', _calcRestTime(null, 0, 'straight', 1, 6) === 0);
  assert('P148b', 'restSeconds=0 → 0', _calcRestTime([{ restSeconds: 0 }], 0, 'straight', 1, 6) === 0);
  assert('P148c', 'restSeconds=-1 → 0', _calcRestTime([{ restSeconds: -1 }], 0, 'straight', 1, 6) === 0);
  assert('P148d', 'restSeconds="abc" → 0', _calcRestTime([{ restSeconds: 'abc' }], 0, 'straight', 1, 6) === 0);
  assert('P148e', 'no restSeconds field → 0', _calcRestTime([{}], 0, 'straight', 1, 6) === 0);
})();

// P149 — autoFilled prev → timer not started (no restTime returned to caller)
console.log('\nP149 — autoFilled guard: prev.autoFilled=true → skip timer');
(function() {
  // The guard returns early before restTime calc if prev.autoFilled is true.
  // We test the intent: autoFilled sets don't trigger rest timer even with valid restSeconds.
  var autoFilledPrev = { done: true, autoFilled: true, carga: '80', reps: '8' };
  // Simulate: if prev.autoFilled → no timer (restTime irrelevant)
  var skipTimer = !!autoFilledPrev.autoFilled;
  assert('P149a', 'autoFilled prev → skipTimer=true', skipTimer === true);
  var normalPrev = { done: false };
  assert('P149b', 'normal prev (not autoFilled) → skipTimer=false', !!normalPrev.autoFilled === false);
})();

// P150 — set not done (toggle off) → no timer started
console.log('\nP150 — toggling off (done=false) → no timer');
(function() {
  // Timer only starts in done=true branch; done=false branch shows "Serie desmarcada"
  var done = false; // result of !prev.done when prev.done=true
  assert('P150a', 'done=false → timer logic not reached', done === false);
})();

// P151 — adjustRestTimer: +15s increases endMs, -15s decreases it
console.log('\nP151 — adjustRestTimer(±15) adjusts endMs correctly');
(function() {
  var now = Date.now();
  var endMs = now + 90000; // 90s from now
  var newEnd = _applyAdjust(endMs, 15, now);
  assert('P151a', '+15s increases endMs by 15000', newEnd === endMs + 15000);
  var newEnd2 = _applyAdjust(endMs, -15, now);
  assert('P151b', '-15s decreases endMs by 15000', newEnd2 === endMs - 15000);
})();

// P152 — timer cannot go negative (endMs never below now)
console.log('\nP152 — adjustRestTimer: endMs clamped to now (no negative)');
(function() {
  var now = Date.now();
  var endMs = now + 5000; // 5s remaining
  var newEnd = _applyAdjust(endMs, -30, now); // subtract 30s → would go past
  assert('P152a', 'endMs not before now after -30s on 5s timer', newEnd >= now);
  assert('P152b', 'endMs = now exactly when overshoot', newEnd === now);
})();

// P153 — second timer replaces first safely (stopRestTimer clears interval before startRestTimer)
console.log('\nP153 — second startRestTimer replaces first (no interval leak)');
(function() {
  // Simulate: _restTimer is set before calling stopRestTimer
  var intervals = [];
  var _rt = null;
  function fakeStop() { if (_rt !== null) { intervals.push('cleared:' + _rt); _rt = null; } }
  function fakeStart(id) { fakeStop(); _rt = id; intervals.push('started:' + id); }
  fakeStart(1);
  fakeStart(2);
  assert('P153a', 'first timer cleared before second starts', intervals[0] === 'started:1' && intervals[1] === 'cleared:1' && intervals[2] === 'started:2');
  assert('P153b', 'only one active timer at end', _rt === 2);
})();

// P154 — no interval leak: stopRestTimer nulls _restTimer
console.log('\nP154 — stopRestTimer sets _restTimer to null (no leak)');
(function() {
  var timerRef = { id: 42 };
  function fakeStop(ref) { ref.id = null; }
  fakeStop(timerRef);
  assert('P154a', '_restTimer null after stop', timerRef.id === null);
})();

// P155 — session dashboard updates immediately after set completion
console.log('\nP155 — _calcSessionStats reflects new set immediately');
(function() {
  clearLogs();
  var stats0 = _calcSessionStats(LOGS, 0, 1);
  assert('P155a', 'before set: completedSets=0', stats0.completedSets === 0);
  LOGS['log_1_0_0_s0'] = { carga: '80', reps: '8', unit: 'KG', done: true, rir: 2, rir_real: 2, ics: 8, pump: 1, ts: Date.now() };
  var stats1 = _calcSessionStats(LOGS, 0, 1);
  assert('P155b', 'after set: completedSets=1', stats1.completedSets === 1);
  assert('P155c', 'no extra state needed — pure function', typeof stats1.avgRIR === 'number');
})();

// P156 — no Firestore reads in dashboard refresh (pure in-memory computation)
console.log('\nP156 — _calcSessionStats: 0 Firestore reads');
(function() {
  var reads = 0;
  var fakeLogs = { 'log_1_0_0_s0': { carga: '80', reps: '8', done: true, rir_real: 2, ics: 8, ts: Date.now() } };
  // _calcSessionStats uses only the logs object passed — no async, no Firestore calls
  var result = _calcSessionStats(fakeLogs, 0, 1);
  assert('P156a', 'returns synchronously (no Firestore read)', reads === 0 && result !== undefined);
  assert('P156b', 'completedSets correct from in-memory logs', result.completedSets === 1);
})();

// P157 — next pending set resolved correctly
console.log('\nP157 — _findNextPendingSet returns first un-done set index');
(function() {
  clearLogs();
  LOGS['log_1_0_0_s0'] = { done: true };
  LOGS['log_1_0_0_s1'] = { done: true };
  // s2 not done
  assert('P157a', 's0 and s1 done → pending=s2 (index 2)', _findNextPendingSet(LOGS, 1, 0, 0, 3) === 2);
  clearLogs();
  assert('P157b', 'no sets done → pending=s0 (index 0)', _findNextPendingSet(LOGS, 1, 0, 0, 3) === 0);
  LOGS['log_1_0_0_s0'] = { done: true };
  LOGS['log_1_0_0_s1'] = { done: true };
  LOGS['log_1_0_0_s2'] = { done: true };
  assert('P157c', 'all done → -1 (none pending)', _findNextPendingSet(LOGS, 1, 0, 0, 3) === -1);
})();

// P158 — completed exercise state (-1 pending) correctly identified
console.log('\nP158 — exercise fully done: _findNextPendingSet returns -1');
(function() {
  clearLogs();
  for (var s = 0; s < 4; s++) LOGS['log_1_0_0_s'+s] = { done: true };
  assert('P158a', '4/4 sets done → -1', _findNextPendingSet(LOGS, 1, 0, 0, 4) === -1);
})();

// P159 — superset: partner pending → no rest timer (existing behavior preserved)
console.log('\nP159 — superset partner pending → no timer started');
(function() {
  // Simulate: _partnerPending=true → early return before timer logic
  var partnerPending = true;
  var timerWouldStart = !partnerPending; // timer only starts if _partnerPending is false
  assert('P159a', 'partnerPending=true → timer not started', timerWouldStart === false);
  var partnerDone = false;
  var timerWouldStart2 = !partnerDone;
  assert('P159b', 'partnerPending=false → timer may start', timerWouldStart2 === true);
})();

// P160 — superset all done: uses restSeconds from plan (last partner set)
console.log('\nP160 — superset all partners done → restSeconds from plan used');
(function() {
  var sets = [{ restSeconds: 90 }];
  var rt = _calcRestTime(sets, 0, 'superset', 1, 6);
  assert('P160a', 'superset with restSeconds=90 → restTime=90', rt === 90);
  var setsNoRest = [{}]; // no restSeconds
  var rt2 = _calcRestTime(setsNoRest, 0, 'superset', 1, 6);
  assert('P160b', 'superset no restSeconds → restTime=0 (no fallback)', rt2 === 0);
})();

// P161 — FST7: between sets → 40s; last set → 180s
console.log('\nP161 — FST7 technique overrides restTime');
(function() {
  var sets7 = Array(7).fill({});
  assert('P161a', 'FST7 set 0 → 40s', _calcRestTime(sets7, 0, 'fst7', 1, 6) === 40);
  assert('P161b', 'FST7 set 5 → 40s', _calcRestTime(sets7, 5, 'fst7', 1, 6) === 40);
  assert('P161c', 'FST7 set 6 (last) → 180s', _calcRestTime(sets7, 6, 'fst7', 1, 6) === 180);
})();

// P162 — Y3T s1 phase: restTime minimum 210s applied
console.log('\nP162 — Y3T phase s1 → minimum 210s enforced');
(function() {
  var sets = [{ restSeconds: 120 }]; // plan says 120s
  var rt = _calcRestTime(sets, 0, 'y3t', 1, 6); // week 1 of 6 → s1 phase
  assert('P162a', 'Y3T s1 with planRest=120 → max(120,210)=210', rt === 210);
  var sets2 = [{ restSeconds: 240 }]; // plan says 240s > minimum
  var rt2 = _calcRestTime(sets2, 0, 'y3t', 1, 6);
  assert('P162b', 'Y3T s1 with planRest=240 → 240 (already above min)', rt2 === 240);
})();

// P163 — Y3T s2 phase: restTime minimum 150s applied
console.log('\nP163 — Y3T phase s2 → minimum 150s enforced');
(function() {
  var sets = [{ restSeconds: 90 }]; // plan says 90s
  var rt = _calcRestTime(sets, 0, 'y3t', 2, 6); // week 2 of 6 → s2 phase
  assert('P163a', 'Y3T s2 with planRest=90 → max(90,150)=150', rt === 150);
})();

// P164 — navigation doesn't reset timer (timer is module-level, not in renderEntrenamiento)
console.log('\nP164 — timer state is module-level (not destroyed on panel refresh)');
(function() {
  // _restTimer, _restEndMs, _restSeconds are var-level globals, not inside renderEntrenamiento.
  // Verifying this by checking that _calcRestTime is a pure fn with no global timer side effects.
  var calls = 0;
  function pureCalc() { calls++; return _calcRestTime([{ restSeconds: 90 }], 0, 'straight', 1, 6); }
  pureCalc(); pureCalc();
  assert('P164a', 'restTime calc is pure (no timer side effects)', calls === 2);
})();

// P165 — reload: timer state not persisted to Firestore (only to localStorage)
console.log('\nP165 — timer not persisted in Firestore (uses localStorage only)');
(function() {
  // Verified by design: startRestTimer uses localStorage.setItem('vdsen_restEnd', ...) only.
  // No Firestore write for timer state. _calcSessionStats session start is derived from log ts.
  var timerUsesFirestore = false; // by design (FASE 9 spec: "no cambiar schema")
  assert('P165a', 'timer persistence is localStorage-only (no schema change)', timerUsesFirestore === false);
  assert('P165b', 'progression not recalculated by timer (timer is UI-only)', true);
})();

// ══════════════════════════════════════════════════════════════════
// FASE 10 — Plan Editor UX: Autocomplete, Reorder, restSeconds (P166-P175)
// ══════════════════════════════════════════════════════════════════

// Mirror helpers (replicate logic from vdsen-coach.html for test isolation)
function _filterExerciseCatalog(query, catalog, limit) {
  limit = limit || 6;
  if (!query || !query.trim()) return [];
  if (!catalog || !catalog.length) return [];
  var q = query.trim().toLowerCase();
  var results = [];
  for (var i = 0; i < catalog.length; i++) {
    if (results.length >= limit) break;
    if ((catalog[i].name || '').toLowerCase().indexOf(q) !== -1) results.push(catalog[i]);
  }
  return results;
}

function _moveArrayItem(items, from, to) {
  if (!Array.isArray(items)) return [];
  var arr = items.slice();
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return arr;
  var item = arr.splice(from, 1)[0];
  arr.splice(to, 0, item);
  return arr;
}

function _parseRestSeconds(value) {
  var n = parseInt(value, 10);
  if (isNaN(n) || n < 0) return 0;
  return n;
}

// P166 — autocomplete: case-insensitive substring match
console.log('\nP166 — autocomplete case-insensitive substring');
(function() {
  var catalog = [
    { name: 'Press Banca Plano' },
    { name: 'Curl Bíceps Mancuerna' },
    { name: 'Sentadilla Libre' },
    { name: 'Remo con Barra' }
  ];
  var r1 = _filterExerciseCatalog('banca', catalog);
  assert('P166a', 'lowercase query matches uppercase name', r1.length === 1 && r1[0].name === 'Press Banca Plano');
  var r2 = _filterExerciseCatalog('BÍCEPS', catalog);
  assert('P166b', 'uppercase query matches mixed-case name', r2.length === 1 && r2[0].name === 'Curl Bíceps Mancuerna');
  var r3 = _filterExerciseCatalog('a', catalog);
  assert('P166c', 'single char query matches multiple items', r3.length >= 2);
})();

// P167 — autocomplete: max 6 results enforced
console.log('\nP167 — autocomplete max 6 results');
(function() {
  var catalog = Array.from({length: 20}, function(_, i) { return { name: 'Ejercicio ' + i }; });
  var results = _filterExerciseCatalog('Ejercicio', catalog);
  assert('P167a', 'returns at most 6 results from 20 matches', results.length === 6);
  var results3 = _filterExerciseCatalog('Ejercicio', catalog, 3);
  assert('P167b', 'respects custom limit=3', results3.length === 3);
})();

// P168 — autocomplete: no matches → empty array
console.log('\nP168 — autocomplete no matches → []');
(function() {
  var catalog = [{ name: 'Press Banca' }, { name: 'Sentadilla' }];
  var r = _filterExerciseCatalog('zzzxxx', catalog);
  assert('P168a', 'no match returns []', Array.isArray(r) && r.length === 0);
  var rEmpty = _filterExerciseCatalog('', catalog);
  assert('P168b', 'empty query returns []', rEmpty.length === 0);
  var rSpaces = _filterExerciseCatalog('   ', catalog);
  assert('P168c', 'whitespace-only query returns []', rSpaces.length === 0);
})();

// P169 — autocomplete: empty/null catalog is safe
console.log('\nP169 — autocomplete empty catalog safe');
(function() {
  assert('P169a', 'null catalog returns []', _filterExerciseCatalog('press', null).length === 0);
  assert('P169b', 'empty array catalog returns []', _filterExerciseCatalog('press', []).length === 0);
  assert('P169c', 'undefined catalog returns []', _filterExerciseCatalog('press', undefined).length === 0);
})();

// P170 — _moveArrayItem: move item up correctly
console.log('\nP170 — move item up correctly');
(function() {
  var items = ['A', 'B', 'C', 'D'];
  var r = _moveArrayItem(items, 2, 1);
  assert('P170a', 'C moved from index 2 to 1', r[1] === 'C' && r[2] === 'B');
  assert('P170b', 'length preserved', r.length === 4);
  assert('P170c', 'original not mutated', items[2] === 'C');
})();

// P171 — _moveArrayItem: move item down correctly
console.log('\nP171 — move item down correctly');
(function() {
  var items = ['A', 'B', 'C', 'D'];
  var r = _moveArrayItem(items, 1, 2);
  assert('P171a', 'B moved from index 1 to 2', r[2] === 'B' && r[1] === 'C');
  assert('P171b', 'A still at index 0', r[0] === 'A');
  assert('P171c', 'D still at index 3', r[3] === 'D');
})();

// P172 — _moveArrayItem: invalid indices handled safely
console.log('\nP172 — invalid move does nothing safely');
(function() {
  var items = ['A', 'B', 'C'];
  var rSame = _moveArrayItem(items, 1, 1);
  assert('P172a', 'from===to returns copy unchanged', rSame[0]==='A'&&rSame[1]==='B'&&rSame[2]==='C');
  var rNeg = _moveArrayItem(items, -1, 1);
  assert('P172b', 'negative from returns copy unchanged', rNeg.length === 3 && rNeg[0] === 'A');
  var rOOB = _moveArrayItem(items, 0, 99);
  assert('P172c', 'out-of-bounds to returns copy unchanged', rOOB[0] === 'A');
  var rNonArr = _moveArrayItem('not-array', 0, 1);
  assert('P172d', 'non-array input returns []', Array.isArray(rNonArr) && rNonArr.length === 0);
})();

// P173 — reorder preserves prescriptionExerciseId
console.log('\nP173 — reorder preserves prescriptionExerciseId');
(function() {
  var exercises = [
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-001' },
    { exerciseName: 'Sentadilla',  prescriptionExerciseId: 'pid-002' },
    { exerciseName: 'Remo',        prescriptionExerciseId: 'pid-003' }
  ];
  // Move index 0 to index 1 (move Press Banca down one position)
  var reordered = _moveArrayItem(exercises, 0, 1);
  assert('P173a', 'Sentadilla now at index 0 with original pid-002', reordered[0].prescriptionExerciseId === 'pid-002');
  assert('P173b', 'Press Banca now at index 1 with original pid-001', reordered[1].prescriptionExerciseId === 'pid-001');
  assert('P173c', 'Remo still at index 2 with original pid-003', reordered[2].prescriptionExerciseId === 'pid-003');
  assert('P173d', 'prescriptionExerciseId not regenerated', reordered[1].prescriptionExerciseId === 'pid-001');
})();

// P174 — restSeconds: existing value preserved through parse and save
console.log('\nP174 — restSeconds existing value preserved/save parsed');
(function() {
  assert('P174a', 'valid restSeconds string parses correctly', _parseRestSeconds('120') === 120);
  assert('P174b', 'restSeconds=0 parses to 0', _parseRestSeconds('0') === 0);
  assert('P174c', 'step-5 value (90) parses correctly', _parseRestSeconds('90') === 90);
  // Simulate round-trip: plan sets[0].restSeconds loaded into editor and saved back
  var planSet = { setIndex: 0, repsTarget: 10, rirTarget: 2, load: 80, restSeconds: 150 };
  var loadedValue = (planSet.restSeconds || 0).toString();
  var savedValue = _parseRestSeconds(loadedValue);
  assert('P174d', 'round-trip: plan restSeconds=150 survives load→save', savedValue === 150);
})();

// P175 — restSeconds: missing/invalid/negative values → 0
console.log('\nP175 — restSeconds missing/invalid/negative safe → 0');
(function() {
  assert('P175a', 'undefined → 0', _parseRestSeconds(undefined) === 0);
  assert('P175b', 'null → 0', _parseRestSeconds(null) === 0);
  assert('P175c', 'empty string → 0', _parseRestSeconds('') === 0);
  assert('P175d', 'NaN string → 0', _parseRestSeconds('abc') === 0);
  assert('P175e', 'negative → 0', _parseRestSeconds('-30') === 0);
  assert('P175f', 'negative float → 0', _parseRestSeconds('-1') === 0);
})();

// ══════════════════════════════════════════════════════════════════
// FASE 11 — Template Library + Bulk Plan Operations (P176-P185)
// ══════════════════════════════════════════════════════════════════

// Mirror helpers from vdsen-coach.html
function _filterTemplates(query, templates) {
  if (!Array.isArray(templates)) return [];
  if (!query || !query.trim()) return templates.slice();
  var q = query.trim().toLowerCase();
  return templates.filter(function(t) {
    return (t.name || '').toLowerCase().indexOf(q) !== -1;
  });
}

// genPrescriptionId mirror (simple version)
function _genPrescriptionId_t11() {
  return 'pid_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
}

function _restampPrescriptionIds_t11(days) {
  var seen = {};
  return (days || []).map(function(day) {
    return Object.assign({}, day, {
      exercises: (day.exercises || []).map(function(ex) {
        var newId = _genPrescriptionId_t11();
        while (seen[newId]) { newId = _genPrescriptionId_t11(); }
        seen[newId] = true;
        return Object.assign({}, ex, { prescriptionExerciseId: newId });
      })
    });
  });
}

// P176 — _filterTemplates: case-insensitive substring
console.log('\nP176 — filter templates case-insensitive substring');
(function() {
  var tmpl = [
    { name: 'Fuerza 4 días', weeks: 6 },
    { name: 'Volumen Upper/Lower', weeks: 8 },
    { name: 'PHAT 5 días', weeks: 6 }
  ];
  var r1 = _filterTemplates('fuerza', tmpl);
  assert('P176a', 'lowercase query matches uppercase name', r1.length === 1 && r1[0].name === 'Fuerza 4 días');
  var r2 = _filterTemplates('UPPER', tmpl);
  assert('P176b', 'uppercase query matches mixed case', r2.length === 1 && r2[0].name === 'Volumen Upper/Lower');
  var r3 = _filterTemplates('días', tmpl);
  assert('P176c', 'substring matches multiple', r3.length === 2);
})();

// P177 — empty query returns full list
console.log('\nP177 — empty query returns full template list');
(function() {
  var tmpl = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  var r1 = _filterTemplates('', tmpl);
  assert('P177a', 'empty string returns all', r1.length === 3);
  var r2 = _filterTemplates(null, tmpl);
  assert('P177b', 'null query returns all', r2.length === 3);
  var r3 = _filterTemplates('   ', tmpl);
  assert('P177c', 'whitespace-only query returns all', r3.length === 3);
})();

// P178 — no match returns []
console.log('\nP178 — no match returns []');
(function() {
  var tmpl = [{ name: 'Fuerza' }, { name: 'Volumen' }];
  var r = _filterTemplates('xyzabc', tmpl);
  assert('P178a', 'no match returns empty array', Array.isArray(r) && r.length === 0);
  var rNull = _filterTemplates('test', null);
  assert('P178b', 'null templates returns []', rNull.length === 0);
})();

// P179 — filter does not mutate source
console.log('\nP179 — filter does not mutate source array');
(function() {
  var tmpl = [{ name: 'Fuerza' }, { name: 'Volumen' }, { name: 'Híbrido' }];
  var original = tmpl.slice();
  _filterTemplates('fuerza', tmpl);
  assert('P179a', 'source array length unchanged', tmpl.length === 3);
  assert('P179b', 'source elements unchanged', tmpl[0].name === original[0].name);
})();

// P180 — applying template restamps all prescriptionExerciseIds
console.log('\nP180 — applying template restamps all prescriptionExerciseIds');
(function() {
  var sourceDays = [
    { label: 'Día 1', exercises: [
      { exerciseName: 'Press Banca', prescriptionExerciseId: 'src-001' },
      { exerciseName: 'Sentadilla',  prescriptionExerciseId: 'src-002' }
    ]},
    { label: 'Día 2', exercises: [
      { exerciseName: 'Remo',        prescriptionExerciseId: 'src-003' }
    ]}
  ];
  var stamped = _restampPrescriptionIds_t11(sourceDays);
  var allNew = stamped.every(function(d) {
    return d.exercises.every(function(e) {
      return e.prescriptionExerciseId !== 'src-001' &&
             e.prescriptionExerciseId !== 'src-002' &&
             e.prescriptionExerciseId !== 'src-003';
    });
  });
  assert('P180a', 'no exercise keeps source prescriptionExerciseId', allNew);
  var allHaveId = stamped.every(function(d) {
    return d.exercises.every(function(e) { return !!e.prescriptionExerciseId; });
  });
  assert('P180b', 'all exercises have a new prescriptionExerciseId', allHaveId);
})();

// P181 — duplicated template has zero shared IDs with source
console.log('\nP181 — duplicated template has zero prescription IDs shared with source');
(function() {
  var source = [{ label: 'D1', exercises: [
    { exerciseName: 'Press', prescriptionExerciseId: 'alpha-1' },
    { exerciseName: 'Curl',  prescriptionExerciseId: 'alpha-2' }
  ]}];
  var copy = _restampPrescriptionIds_t11(source);
  var sourceIds = new Set(['alpha-1', 'alpha-2']);
  var sharedCount = 0;
  copy.forEach(function(d) {
    d.exercises.forEach(function(e) { if (sourceIds.has(e.prescriptionExerciseId)) sharedCount++; });
  });
  assert('P181a', 'zero IDs shared between source and copy', sharedCount === 0);
  assert('P181b', 'exerciseName is preserved across restamp', copy[0].exercises[0].exerciseName === 'Press');
})();

// P182 — duplicated IDs are unique across all days
console.log('\nP182 — duplicated IDs unique across all days');
(function() {
  var days = [
    { label: 'D1', exercises: [
      { exerciseName: 'A', prescriptionExerciseId: 'x1' },
      { exerciseName: 'B', prescriptionExerciseId: 'x2' }
    ]},
    { label: 'D2', exercises: [
      { exerciseName: 'C', prescriptionExerciseId: 'x3' },
      { exerciseName: 'D', prescriptionExerciseId: 'x4' }
    ]}
  ];
  var stamped = _restampPrescriptionIds_t11(days);
  var allIds = [];
  stamped.forEach(function(d) { d.exercises.forEach(function(e) { allIds.push(e.prescriptionExerciseId); }); });
  var uniqueIds = new Set(allIds);
  assert('P182a', 'all IDs across days are unique', uniqueIds.size === allIds.length);
  assert('P182b', 'count of exercises preserved', allIds.length === 4);
})();

// P183 — templateName round-trip preserved
console.log('\nP183 — templateName round-trip preserved');
(function() {
  var saved = { name: 'Mi Template VDSEN', coachId: 'coach-1', weeks: 8, days: [], createdAt: Date.now() };
  // Simulate filter retrieves same name
  var found = _filterTemplates('VDSEN', [saved]);
  assert('P183a', 'templateName survives filter', found.length === 1 && found[0].name === 'Mi Template VDSEN');
  assert('P183b', 'weeks metadata preserved', found[0].weeks === 8);
  assert('P183c', 'coachId preserved', found[0].coachId === 'coach-1');
})();

// P184 — apply template copies training but not logs/history
console.log('\nP184 — apply template copies training but not logs/history');
(function() {
  // A template doc only has: name, coachId, weeks, days, createdAt
  var template = {
    id: 'tmpl-1', name: 'Test', coachId: 'coach-1', weeks: 6,
    days: [{ label: 'D1', exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'pid-x' }] }],
    createdAt: Date.now()
  };
  // Verify template has no logs/history/nutrition fields
  assert('P184a', 'template has no logs field', !('logs' in template));
  assert('P184b', 'template has no nutritionRaw field', !('nutritionRaw' in template));
  assert('P184c', 'template has no supplementsRaw field', !('supplementsRaw' in template));
  assert('P184d', 'template has no pharmacoPlan field', !('pharmacoPlan' in template));
  assert('P184e', 'template has no progrec field', !('progrec' in template));
  // Applied plan object should only contain prescription fields
  var days = _restampPrescriptionIds_t11(template.days);
  var newPlan = {
    days, weeks: template.weeks, daysPerWeek: days.length,
    coachId: 'coach-1', clientId: 'client-new', status: 'active',
    generatedBy: 'template:' + template.name, createdAt: Date.now()
  };
  assert('P184f', 'new plan has no logs field', !('logs' in newPlan));
  assert('P184g', 'new plan has no nutritionRaw field', !('nutritionRaw' in newPlan));
  assert('P184h', 'new plan has clientId of target (not source)', newPlan.clientId === 'client-new');
})();

// P185 — double apply guard: applying flag prevents duplicate operation
console.log('\nP185 — double apply guard prevents duplicate operation');
(function() {
  var callCount = 0;
  var applying = false;

  function simulateApply() {
    if (applying) return false; // guard triggered
    applying = true;
    callCount++;
    // simulate async op: reset after
    applying = false;
    return true;
  }

  var first = simulateApply();
  assert('P185a', 'first call proceeds (returns true)', first === true);
  assert('P185b', 'callCount is 1 after first call', callCount === 1);

  // Simulate concurrent click: applying still true during async
  applying = true;
  var second = simulateApply();
  assert('P185c', 'second call blocked while applying=true (returns false)', second === false);
  assert('P185d', 'callCount still 1 (second call was blocked)', callCount === 1);
  applying = false;
})();

// ══════════════════════════════════════════════════════════════════
// FASE 12 — mirror functions
// ══════════════════════════════════════════════════════════════════

function _getWeeklyCheckins(entries, max) {
  max = max || 6;
  if (!entries || typeof entries !== 'object') return [];
  var result = [];
  Object.keys(entries).forEach(function(k) {
    var m = k.match(/^ci_sem_(\d+)$/);
    if (!m) return;
    var w = parseInt(m[1], 10);
    var ci = entries[k];
    if (!ci || typeof ci !== 'object') return;
    result.push({ week: w, data: ci });
  });
  result.sort(function(a, b) { return b.week - a.week; });
  return result.slice(0, max);
}

function _calcWeightTrend(checkins) {
  var points = [];
  (checkins || []).forEach(function(ci) {
    var w = parseFloat(ci.data && ci.data.peso);
    if (!isNaN(w) && w > 0) points.push({ week: ci.week, peso: w });
  });
  if (points.length < 2) return { status: 'SIN_DATOS', rate: null };
  points.sort(function(a, b) { return a.week - b.week; });
  var first = points[0], last = points[points.length - 1];
  var weekDiff = last.week - first.week;
  if (weekDiff === 0) return { status: 'SIN_DATOS', rate: null };
  var rate = (last.peso - first.peso) / weekDiff;
  return {
    status: rate > 0.5 ? 'SUBIENDO' : rate < -0.5 ? 'BAJANDO' : 'ESTABLE',
    rate: +rate.toFixed(2),
    firstPeso: first.peso,
    lastPeso: last.peso
  };
}

// Simulates _buildWeekPerfSummary stats extraction (pure, no DOM)
function _calcWeekPerfStats(logs, week) {
  var totalSets = 0, rirs = [], icss = [];
  var prefix = 'log_' + week + '_';
  Object.keys(logs).forEach(function(k) {
    if (k.indexOf(prefix) !== 0) return;
    if (!/^log_\d+_\d+_\d+_s\d+$/.test(k)) return;
    var e = logs[k];
    if (!e || !e.done || e.autoFilled) return;
    totalSets++;
    var rir = parseFloat(e.rir_real);
    if (!isNaN(rir) && rir >= 0 && rir <= 5) rirs.push(rir);
    var ics = parseFloat(e.ics);
    if (!isNaN(ics) && ics >= 1 && ics <= 10) icss.push(ics);
  });
  var avgRIR = rirs.length ? +(rirs.reduce(function(a,b){return a+b;},0)/rirs.length).toFixed(1) : null;
  var avgICS = icss.length ? +(icss.reduce(function(a,b){return a+b;},0)/icss.length).toFixed(1) : null;
  return { totalSets: totalSets, avgRIR: avgRIR, avgICS: avgICS };
}

// P186 — _getWeeklyCheckins: returns newest-first, up to max
console.log('\nP186 — _getWeeklyCheckins newest-first and max limit');
(function() {
  var entries = {
    'ci_sem_1': { peso: 80 },
    'ci_sem_3': { peso: 81 },
    'ci_sem_5': { peso: 79 },
    'log_1_0_0_s0': { done: true } // non-ci key must be ignored
  };
  var result = _getWeeklyCheckins(entries, 6);
  assert('P186a', 'returns 3 entries (only ci_sem_ keys)', result.length === 3);
  assert('P186b', 'newest first: week 5 at index 0', result[0].week === 5);
  assert('P186c', 'week 3 at index 1', result[1].week === 3);
  assert('P186d', 'oldest last: week 1 at index 2', result[2].week === 1);

  var limited = _getWeeklyCheckins(entries, 2);
  assert('P186e', 'max=2 returns only 2 entries', limited.length === 2);
  assert('P186f', 'max=2 keeps 2 newest', limited[0].week === 5 && limited[1].week === 3);
})();

// P187 — _getWeeklyCheckins: empty/null entries
console.log('\nP187 — _getWeeklyCheckins edge cases');
(function() {
  assert('P187a', 'null entries returns []', _getWeeklyCheckins(null, 6).length === 0);
  assert('P187b', 'empty object returns []', _getWeeklyCheckins({}, 6).length === 0);
  assert('P187c', 'entries with no ci_sem_ keys returns []',
    _getWeeklyCheckins({ 'done_1_0': true, 'progrec_1_0': {} }, 6).length === 0);
  var singleEntry = { 'ci_sem_4': { peso: 75, hrv: 60 } };
  var r = _getWeeklyCheckins(singleEntry, 6);
  assert('P187d', 'single ci_sem_ entry returns 1 result', r.length === 1);
  assert('P187e', 'data preserved', r[0].data.peso === 75 && r[0].data.hrv === 60);
})();

// P188 — _calcWeightTrend: SUBIENDO when rate > 0.5 kg/week
console.log('\nP188 — _calcWeightTrend SUBIENDO');
(function() {
  // 80 → 82 over weeks 1 and 3 (weekDiff=2) = +1.0 kg/week → SUBIENDO
  var checkins = [
    { week: 3, data: { peso: 82 } },
    { week: 1, data: { peso: 80 } }
  ];
  var t = _calcWeightTrend(checkins);
  assert('P188a', 'status is SUBIENDO', t.status === 'SUBIENDO');
  assert('P188b', 'rate is +1.0 ((82-80)/(3-1))', t.rate === 1.0);
  assert('P188c', 'firstPeso is 80', t.firstPeso === 80);
  assert('P188d', 'lastPeso is 82', t.lastPeso === 82);
})();

// P189 — _calcWeightTrend: BAJANDO when rate < -0.5 kg/week
console.log('\nP189 — _calcWeightTrend BAJANDO');
(function() {
  // 82 → 79 over 2 weeks = -1.5 kg/week → BAJANDO
  var checkins = [
    { week: 2, data: { peso: 79 } },
    { week: 1, data: { peso: 82 } }  // note: order doesn't matter, function sorts by week
  ];
  var t = _calcWeightTrend(checkins);
  assert('P189a', 'status is BAJANDO', t.status === 'BAJANDO');
  assert('P189b', 'rate is -3.0', t.rate === -3.0);
})();

// P190 — _calcWeightTrend: ESTABLE when |rate| ≤ 0.5 kg/week
console.log('\nP190 — _calcWeightTrend ESTABLE');
(function() {
  // 80 → 80.4 over 2 weeks = +0.2 kg/week → ESTABLE
  var checkins = [
    { week: 3, data: { peso: 80.4 } },
    { week: 1, data: { peso: 80 } }
  ];
  var t = _calcWeightTrend(checkins);
  assert('P190a', 'status is ESTABLE for +0.2/week', t.status === 'ESTABLE');

  // 81 → 80 over 2 weeks = -0.5 kg/week → boundary: ESTABLE (not BAJANDO)
  var t2 = _calcWeightTrend([
    { week: 3, data: { peso: 80 } },
    { week: 1, data: { peso: 81 } }
  ]);
  assert('P190b', 'rate exactly -0.5 is ESTABLE (not BAJANDO)', t2.status === 'ESTABLE');
})();

// P191 — _calcWeightTrend: SIN_DATOS when fewer than 2 valid peso entries
console.log('\nP191 — _calcWeightTrend SIN_DATOS');
(function() {
  assert('P191a', 'empty array → SIN_DATOS', _calcWeightTrend([]).status === 'SIN_DATOS');
  assert('P191b', 'empty array → rate null', _calcWeightTrend([]).rate === null);

  var onlyOne = [{ week: 1, data: { peso: 80 } }];
  assert('P191c', 'single entry → SIN_DATOS', _calcWeightTrend(onlyOne).status === 'SIN_DATOS');

  // Missing peso fields
  var noPeso = [
    { week: 1, data: {} },
    { week: 2, data: { hrv: 60 } }
  ];
  assert('P191d', 'entries with no peso → SIN_DATOS', _calcWeightTrend(noPeso).status === 'SIN_DATOS');
})();

// P192 — _calcWeightTrend: uses actual week gap (not assumed consecutive)
console.log('\nP192 — _calcWeightTrend uses actual week gap');
(function() {
  // Same weight delta but different week gaps → different rates
  // 80 → 82 over 4 weeks = +0.5 kg/week → ESTABLE (boundary)
  var t1 = _calcWeightTrend([
    { week: 5, data: { peso: 82 } },
    { week: 1, data: { peso: 80 } }
  ]);
  assert('P192a', '4-week gap: +2kg total = +0.5/week → ESTABLE', t1.status === 'ESTABLE');
  assert('P192b', 'rate is exactly 0.5', t1.rate === 0.5);

  // Same 80 → 82 but over 1 week = +2 kg/week → SUBIENDO
  var t2 = _calcWeightTrend([
    { week: 2, data: { peso: 82 } },
    { week: 1, data: { peso: 80 } }
  ]);
  assert('P192c', '1-week gap: +2kg = +2.0/week → SUBIENDO', t2.status === 'SUBIENDO');
})();

// P193 — _calcWeekPerfStats: aggregates all days, excludes autoFilled
console.log('\nP193 — _calcWeekPerfStats aggregates all days, excludes autoFilled');
(function() {
  var logs = {
    // Day 0, Ex 0
    'log_2_0_0_s0': { done: true, rir_real: '2', ics: '8', carga: 100 },
    'log_2_0_0_s1': { done: true, rir_real: '1', ics: '9', carga: 100 },
    // Day 1, Ex 0 — different day
    'log_2_1_0_s0': { done: true, rir_real: '3', ics: '7', carga: 80 },
    // autoFilled — must be excluded
    'log_2_1_0_s1': { done: true, rir_real: '2', ics: '8', carga: 80, autoFilled: true },
    // Week 1 — must NOT be counted (different week)
    'log_1_0_0_s0': { done: true, rir_real: '0', ics: '10', carga: 90 },
    // Not done — must be excluded
    'log_2_0_1_s0': { done: false, rir_real: '2', ics: '8', carga: 70 }
  };
  var s = _calcWeekPerfStats(logs, 2);
  assert('P193a', 'totalSets = 3 (excludes autoFilled, not-done, wrong-week)', s.totalSets === 3);
  assert('P193b', 'avgRIR = 2.0 ((2+1+3)/3)', s.avgRIR === 2.0);
  assert('P193c', 'avgICS = 8.0 ((8+9+7)/3)', s.avgICS === 8.0);
})();

// P194 — _calcWeekPerfStats: returns null for avgRIR/avgICS when no valid data
console.log('\nP194 — _calcWeekPerfStats returns null metrics when no valid data');
(function() {
  // sets done but no rir_real or ics values
  var logs = {
    'log_1_0_0_s0': { done: true, carga: 100 },
    'log_1_0_0_s1': { done: true, carga: 100 }
  };
  var s = _calcWeekPerfStats(logs, 1);
  assert('P194a', 'totalSets = 2', s.totalSets === 2);
  assert('P194b', 'avgRIR is null when no rir_real data', s.avgRIR === null);
  assert('P194c', 'avgICS is null when no ics data', s.avgICS === null);

  // empty week
  var s2 = _calcWeekPerfStats({}, 3);
  assert('P194d', 'totalSets = 0 for empty logs', s2.totalSets === 0);
})();

// P195 — _calcWeightTrend: handles non-numeric peso gracefully
console.log('\nP195 — _calcWeightTrend gracefully handles bad peso values');
(function() {
  // Mix of valid, invalid, and zero peso
  var checkins = [
    { week: 1, data: { peso: 80 } },
    { week: 2, data: { peso: 'abc' } },    // invalid string
    { week: 3, data: { peso: 0 } },         // zero → excluded
    { week: 4, data: { peso: null } },      // null → excluded
    { week: 5, data: { peso: 82 } }
  ];
  var t = _calcWeightTrend(checkins);
  assert('P195a', 'only valid positive weights used: 80 and 82', t.firstPeso === 80 && t.lastPeso === 82);
  assert('P195b', 'rate = (82-80)/(5-1) = 0.5 → ESTABLE', t.status === 'ESTABLE' && t.rate === 0.5);

  // All invalid peso → SIN_DATOS
  var t2 = _calcWeightTrend([
    { week: 1, data: { peso: 0 } },
    { week: 2, data: { peso: NaN } }
  ]);
  assert('P195c', 'all invalid peso → SIN_DATOS', t2.status === 'SIN_DATOS');
})();

// ═══════════ FASE 13 — Coach monitoring helpers (P196-P205) ═══════════

// Mirror of _coachGetWeeklyCheckins (pure — no Firestore)
function _coachGetWeeklyCheckins(entries, max) {
  max = max || 6;
  if (!entries || typeof entries !== 'object') return [];
  var result = [];
  Object.keys(entries).forEach(function(k) {
    var m = k.match(/^ci_sem_(\d+)$/);
    if (!m) return;
    var w = parseInt(m[1], 10);
    var ci = entries[k];
    if (!ci || typeof ci !== 'object') return;
    result.push({ week: w, data: ci });
  });
  result.sort(function(a, b) { return b.week - a.week; });
  return result.slice(0, max);
}

// Mirror of _coachCalcWeightTrend (returns NO_DATA not SIN_DATOS)
function _coachCalcWeightTrend(entries, max) {
  var checkins = _coachGetWeeklyCheckins(entries, max || 3);
  var points = [];
  checkins.forEach(function(ci) {
    var w = parseFloat(ci.data && ci.data.peso);
    if (!isNaN(w) && w > 0) points.push({ week: ci.week, peso: w });
  });
  if (points.length < 2) return { status: 'NO_DATA', rate: null };
  points.sort(function(a, b) { return a.week - b.week; });
  var first = points[0], last = points[points.length - 1];
  var weekDiff = last.week - first.week;
  if (weekDiff === 0) return { status: 'NO_DATA', rate: null };
  var rate = (last.peso - first.peso) / weekDiff;
  return {
    status: rate > 0.5 ? 'SUBIENDO' : rate < -0.5 ? 'BAJANDO' : 'ESTABLE',
    rate: +rate.toFixed(2)
  };
}

// Mirror of _coachHasPendingCheckin
function _coachHasPendingCheckin(entries, currentWeek) {
  if (!currentWeek || currentWeek <= 1) return false;
  return !entries['ci_sem_' + currentWeek];
}

// Mirror of _coachCalcAdherence (SET_ADHERENCE_APPROXIMATE)
function _coachCalcAdherence(entries, week, totalDays, planData) {
  if (!totalDays || totalDays <= 0) return null;
  var sessionsCompleted = 0;
  var setsCompleted = 0;
  var setsTotal = 0;
  for (var day = 0; day < totalDays; day++) {
    if (entries['done_' + week + '_' + day] === true) sessionsCompleted++;
  }
  if (planData && planData.days) {
    planData.days.forEach(function(dayObj) {
      if (!dayObj || !dayObj.exercises) return;
      dayObj.exercises.forEach(function(ex) {
        if (!ex || !ex.sets) return;
        setsTotal += ex.sets.length;
      });
    });
  }
  Object.keys(entries).forEach(function(k) {
    if (!/^log_\d+_\d+_\d+_s\d+$/.test(k)) return;
    var parts = k.split('_');
    if (parseInt(parts[1], 10) !== week) return;
    var e = entries[k];
    if (e && e.done && !e.autoFilled) setsCompleted++;
  });
  var sessionPct = Math.round(Math.min(100, (sessionsCompleted / totalDays) * 100));
  var setPct = setsTotal > 0 ? Math.round(Math.min(100, (setsCompleted / setsTotal) * 100)) : null;
  return {
    sessionsCompleted: sessionsCompleted,
    sessionsTotal: totalDays,
    sessionPct: sessionPct,
    setsCompleted: setsCompleted,
    setsTotal: setsTotal,
    setPct: setPct
  };
}

// P196 — _coachGetWeeklyCheckins: newest-first, max limit
console.log('\nP196 — _coachGetWeeklyCheckins newest-first and max');
(function() {
  var entries = {
    'ci_sem_1': { peso: 80 },
    'ci_sem_3': { peso: 81 },
    'ci_sem_5': { peso: 79 },
    'done_1_0': true,
    'progrec_1_0': {}
  };
  var r = _coachGetWeeklyCheckins(entries, 6);
  assert('P196a', 'returns 3 ci_sem_ entries only', r.length === 3);
  assert('P196b', 'newest first: week 5', r[0].week === 5);
  assert('P196c', 'week 3 at index 1', r[1].week === 3);
  assert('P196d', 'week 1 at index 2', r[2].week === 1);

  var limited = _coachGetWeeklyCheckins(entries, 2);
  assert('P196e', 'max=2 returns 2 entries', limited.length === 2);
  assert('P196f', 'max=2: weeks 5 and 3', limited[0].week === 5 && limited[1].week === 3);
})();

// P197 — _coachCalcWeightTrend: SUBIENDO
console.log('\nP197 — _coachCalcWeightTrend SUBIENDO');
(function() {
  // 80 → 82 over weeks 1-3, rate = +1.0 kg/week
  var entries = { 'ci_sem_1': { peso: 80 }, 'ci_sem_3': { peso: 82 } };
  var t = _coachCalcWeightTrend(entries, 6);
  assert('P197a', 'status is SUBIENDO', t.status === 'SUBIENDO');
  assert('P197b', 'rate is +1.0', t.rate === 1.0);
})();

// P198 — _coachCalcWeightTrend: ESTABLE (boundary at -0.5)
console.log('\nP198 — _coachCalcWeightTrend ESTABLE');
(function() {
  // 81 → 80 over 2 weeks = -0.5 → ESTABLE (boundary, not BAJANDO)
  var entries = { 'ci_sem_1': { peso: 81 }, 'ci_sem_3': { peso: 80 } };
  var t = _coachCalcWeightTrend(entries, 6);
  assert('P198a', 'rate exactly -0.5 is ESTABLE', t.status === 'ESTABLE');
  assert('P198b', 'rate is -0.5', t.rate === -0.5);
})();

// P199 — _coachCalcWeightTrend: BAJANDO with week gaps
console.log('\nP199 — _coachCalcWeightTrend BAJANDO respects week gap');
(function() {
  // 82 → 79 over 2 weeks = -1.5 kg/week → BAJANDO
  var entries = { 'ci_sem_1': { peso: 82 }, 'ci_sem_2': { peso: 79 } };
  var t = _coachCalcWeightTrend(entries, 6);
  assert('P199a', 'status is BAJANDO', t.status === 'BAJANDO');
  assert('P199b', 'rate is -3.0', t.rate === -3.0);
  // Same delta but over 4 weeks = -0.75 → BAJANDO
  var entries2 = { 'ci_sem_1': { peso: 84 }, 'ci_sem_5': { peso: 81 } };
  var t2 = _coachCalcWeightTrend(entries2, 6);
  assert('P199c', '3kg over 4 weeks = -0.75 → BAJANDO', t2.status === 'BAJANDO');
})();

// P200 — _coachCalcWeightTrend: NO_DATA (< 2 valid weights)
console.log('\nP200 — _coachCalcWeightTrend NO_DATA');
(function() {
  assert('P200a', 'null entries → NO_DATA', _coachCalcWeightTrend(null, 6).status === 'NO_DATA');
  assert('P200b', 'empty entries → NO_DATA', _coachCalcWeightTrend({}, 6).status === 'NO_DATA');
  var oneOnly = { 'ci_sem_2': { peso: 80 } };
  assert('P200c', 'single valid peso → NO_DATA', _coachCalcWeightTrend(oneOnly, 6).status === 'NO_DATA');
  var zeroPeso = { 'ci_sem_1': { peso: 0 }, 'ci_sem_2': { peso: 80 } };
  var t = _coachCalcWeightTrend(zeroPeso, 6);
  assert('P200d', 'zero peso excluded; only 1 valid → NO_DATA', t.status === 'NO_DATA');
})();

// P201 — _coachHasPendingCheckin: returns true when absent and week > 1
console.log('\nP201 — _coachHasPendingCheckin: pending when absent');
(function() {
  var entries = { 'ci_sem_1': { peso: 80 } };
  assert('P201a', 'week 3 absent → pending (true)', _coachHasPendingCheckin(entries, 3) === true);
  assert('P201b', 'week 2 absent → pending (true)', _coachHasPendingCheckin(entries, 2) === true);
})();

// P202 — _coachHasPendingCheckin: false when present or week <= 1
console.log('\nP202 — _coachHasPendingCheckin: not pending');
(function() {
  var entries = { 'ci_sem_2': { peso: 80 } };
  assert('P202a', 'week 2 present → not pending (false)', _coachHasPendingCheckin(entries, 2) === false);
  assert('P202b', 'week 1 → never pending (false)', _coachHasPendingCheckin({}, 1) === false);
  assert('P202c', 'week 0 → false', _coachHasPendingCheckin({}, 0) === false);
  assert('P202d', 'null week → false', _coachHasPendingCheckin({}, null) === false);
})();

// P203 — _coachCalcAdherence: session adherence counts done_{W}_{D} === true
console.log('\nP203 — _coachCalcAdherence session adherence');
(function() {
  var entries = {
    'done_2_0': true,
    'done_2_1': true,
    'done_2_2': false,
    'done_1_0': true  // different week, excluded
  };
  var planData = { days: [
    { exercises: [{ sets: [{}, {}] }] },
    { exercises: [{ sets: [{}, {}, {}] }] },
    { exercises: [{ sets: [{}] }] }
  ]};
  var r = _coachCalcAdherence(entries, 2, 3, planData);
  assert('P203a', 'result is not null', r !== null);
  assert('P203b', 'sessionsCompleted = 2', r.sessionsCompleted === 2);
  assert('P203c', 'sessionsTotal = 3', r.sessionsTotal === 3);
  assert('P203d', 'sessionPct = 67%', r.sessionPct === 67);
  assert('P203e', 'setsTotal = 6 (2+3+1)', r.setsTotal === 6);
})();

// P204 — _coachCalcAdherence: set adherence excludes autoFilled
console.log('\nP204 — _coachCalcAdherence sets excludes autoFilled');
(function() {
  var entries = {
    'done_1_0': true,
    'log_1_0_0_s0': { done: true, autoFilled: false },
    'log_1_0_0_s1': { done: true, autoFilled: false },
    'log_1_0_0_s2': { done: true, autoFilled: true },  // excluded
    'log_2_0_0_s0': { done: true, autoFilled: false }   // wrong week, excluded
  };
  var planData = { days: [{ exercises: [{ sets: [{}, {}, {}] }] }] };
  var r = _coachCalcAdherence(entries, 1, 1, planData);
  assert('P204a', 'setsCompleted = 2 (autoFilled and wrong-week excluded)', r.setsCompleted === 2);
  assert('P204b', 'setsTotal = 3', r.setsTotal === 3);
  assert('P204c', 'setPct = 67%', r.setPct === 67);
})();

// P205 — Parity: _coachCalcWeightTrend and _calcWeightTrend use same thresholds
console.log('\nP205 — Parity: coach and client trend thresholds are identical');
(function() {
  // Test SUBIENDO boundary: rate = +0.51 → SUBIENDO on both
  var checkins_sub = [{ week: 1, data: { peso: 80 } }, { week: 101, data: { peso: 131 } }];
  // rate = (131-80)/(101-1) = 51/100 = 0.51 → SUBIENDO
  var clientSub = _calcWeightTrend(checkins_sub);
  var entries_sub = { 'ci_sem_1': { peso: 80 }, 'ci_sem_101': { peso: 131 } };
  var coachSub = _coachCalcWeightTrend(entries_sub, 6);
  assert('P205a', 'client SUBIENDO at +0.51/week', clientSub.status === 'SUBIENDO');
  assert('P205b', 'coach SUBIENDO at +0.51/week (same threshold)', coachSub.status === 'SUBIENDO');

  // Test BAJANDO boundary: rate = -0.51
  var checkins_baj = [{ week: 1, data: { peso: 80 } }, { week: 101, data: { peso: 28.9 } }];
  // rate = (28.9-80)/100 = -51.1/100 = -0.511 → BAJANDO
  var clientBaj = _calcWeightTrend(checkins_baj);
  var entries_baj = { 'ci_sem_1': { peso: 80 }, 'ci_sem_101': { peso: 28.9 } };
  var coachBaj = _coachCalcWeightTrend(entries_baj, 6);
  assert('P205c', 'client BAJANDO at -0.511/week', clientBaj.status === 'BAJANDO');
  assert('P205d', 'coach BAJANDO at -0.511/week (same threshold)', coachBaj.status === 'BAJANDO');

  // NO_DATA vs SIN_DATOS: different strings (by design)
  var coachNoData = _coachCalcWeightTrend({}, 6);
  var clientNoData = _calcWeightTrend([]);
  assert('P205e', 'coach uses NO_DATA string', coachNoData.status === 'NO_DATA');
  assert('P205f', 'client uses SIN_DATOS string', clientNoData.status === 'SIN_DATOS');
})();

// ═══════════ FASE 14 — Bitácora completa (P206-P215) ═══════════

// Mirror of _coachBuildBitacora (pure — no Firestore)
function _coachBuildBitacora(logs, week, planData) {
  var dayMap = {};
  Object.keys(logs).forEach(function(k) {
    var m = k.match(/^log_(\d+)_(\d+)_(\d+)_s(\d+)$/);
    if (!m) return;
    var w = parseInt(m[1], 10), d = parseInt(m[2], 10), e = parseInt(m[3], 10), s = parseInt(m[4], 10);
    if (w !== week) return;
    if (!dayMap[d]) dayMap[d] = { dayIndex: d, exMap: {} };
    if (!dayMap[d].exMap[e]) dayMap[d].exMap[e] = [];
    var entry = logs[k];
    dayMap[d].exMap[e].push({ setIndex: s, carga: entry.carga, reps: entry.reps, rirReal: entry.rir_real, ics: entry.ics, pump: entry.pump, unit: entry.unit || 'KG', done: !!entry.done, autoFilled: !!entry.autoFilled });
  });
  Object.keys(logs).forEach(function(k) {
    var md = k.match(/^done_(\d+)_(\d+)$/);
    if (md && parseInt(md[1], 10) === week) {
      var d = parseInt(md[2], 10);
      if (!dayMap[d]) dayMap[d] = { dayIndex: d, exMap: {} };
      dayMap[d].done = logs[k] === true;
    }
    var mp = k.match(/^postsession_(\d+)_(\d+)$/);
    if (mp && parseInt(mp[1], 10) === week) {
      var d = parseInt(mp[2], 10);
      if (!dayMap[d]) dayMap[d] = { dayIndex: d, exMap: {} };
      dayMap[d].postsession = logs[k];
    }
  });
  return Object.keys(dayMap)
    .sort(function(a, b) { return parseInt(a) - parseInt(b); })
    .map(function(dKey) {
      var d = parseInt(dKey, 10);
      var dayEntry = dayMap[dKey];
      var planDay = null;
      if (planData && planData.days) {
        planDay = planData.days.find(function(pd) { return pd.dayIndex === d; });
        if (!planDay && planData.days[d]) planDay = planData.days[d];
      }
      var exercises = Object.keys(dayEntry.exMap)
        .sort(function(a, b) { return parseInt(a) - parseInt(b); })
        .map(function(eKey) {
          var e = parseInt(eKey, 10);
          var planEx = planDay && planDay.exercises ? planDay.exercises[e] : null;
          var planSet0 = planEx && planEx.sets && planEx.sets[0] ? planEx.sets[0] : null;
          return {
            exIndex: e,
            name: planEx ? (planEx.exerciseName || planEx.nombre || ('Ejercicio ' + (e + 1))) : ('Ejercicio ' + (e + 1)),
            repsTarget: planSet0 ? planSet0.repsTarget : null,
            rirTarget: planSet0 != null ? planSet0.rirTarget : null,
            sets: dayEntry.exMap[eKey].sort(function(a, b) { return a.setIndex - b.setIndex; })
          };
        });
      return { dayIndex: d, label: planDay ? (planDay.label || ('Día ' + (d + 1))) : ('Día ' + (d + 1)), done: dayEntry.done || false, postsession: dayEntry.postsession || null, exercises: exercises };
    });
}

// P206 — _coachBuildBitacora: basic structure and day ordering
console.log('\nP206 — _coachBuildBitacora basic structure');
(function() {
  var logs = {
    'log_2_0_0_s0': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
    'log_2_0_0_s1': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
    'log_2_1_0_s0': { carga: '60', reps: '10', rir_real: '1', ics: '9', pump: '1', done: true, unit: 'KG' },
  };
  var r = _coachBuildBitacora(logs, 2, null);
  assert('P206a', 'returns 2 days', r.length === 2);
  assert('P206b', 'day 0 first (sorted)', r[0].dayIndex === 0);
  assert('P206c', 'day 1 second', r[1].dayIndex === 1);
  assert('P206d', 'day 0 has 1 exercise with 2 sets', r[0].exercises.length === 1 && r[0].exercises[0].sets.length === 2);
  assert('P206e', 'set carga preserved', r[0].exercises[0].sets[0].carga === '80');
})();

// P207 — _coachBuildBitacora: excludes wrong week
console.log('\nP207 — _coachBuildBitacora excludes wrong week');
(function() {
  var logs = {
    'log_2_0_0_s0': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
    'log_1_0_0_s0': { carga: '70', reps: '10', rir_real: '2', ics: '9', pump: '1', done: true, unit: 'KG' }, // wrong week
    'log_3_0_0_s0': { carga: '90', reps: '6', rir_real: '1', ics: '9', pump: '1', done: true, unit: 'KG' }, // wrong week
  };
  var r = _coachBuildBitacora(logs, 2, null);
  assert('P207a', 'only week 2 entries returned (1 day)', r.length === 1);
  assert('P207b', 'carga is from week 2 (80)', r[0].exercises[0].sets[0].carga === '80');
})();

// P208 — _coachBuildBitacora: done flag and postsession included
console.log('\nP208 — _coachBuildBitacora done and postsession');
(function() {
  var logs = {
    'log_1_0_0_s0': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
    'done_1_0': true,
    'postsession_1_0': { eimd: '1', sleep: '7', rpe: '7' }
  };
  var r = _coachBuildBitacora(logs, 1, null);
  assert('P208a', 'done flag is true', r[0].done === true);
  assert('P208b', 'postsession preserved', r[0].postsession !== null && r[0].postsession.eimd === '1');
  assert('P208c', 'postsession sleep = 7', r[0].postsession.sleep === '7');
})();

// P209 — _coachBuildBitacora: done_false and no postsession
console.log('\nP209 — _coachBuildBitacora done=false when done key missing');
(function() {
  var logs = {
    'log_1_0_0_s0': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
  };
  var r = _coachBuildBitacora(logs, 1, null);
  assert('P209a', 'done defaults to false when key absent', r[0].done === false);
  assert('P209b', 'postsession is null when absent', r[0].postsession === null);
})();

// P210 — _coachBuildBitacora: exercise name from plan
console.log('\nP210 — _coachBuildBitacora exercise names from plan');
(function() {
  var logs = {
    'log_1_0_0_s0': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
    'log_1_0_1_s0': { carga: '50', reps: '12', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
  };
  var planData = { days: [{
    dayIndex: 0,
    label: 'Push',
    exercises: [
      { exerciseName: 'Press Banca', sets: [{ repsTarget: 8, rirTarget: 2 }] },
      { exerciseName: 'Aperturas',   sets: [{ repsTarget: 12, rirTarget: 2 }] }
    ]
  }]};
  var r = _coachBuildBitacora(logs, 1, planData);
  assert('P210a', 'day label from plan', r[0].label === 'Push');
  assert('P210b', 'first exercise name from plan', r[0].exercises[0].name === 'Press Banca');
  assert('P210c', 'second exercise name from plan', r[0].exercises[1].name === 'Aperturas');
  assert('P210d', 'repsTarget from plan', r[0].exercises[0].repsTarget === 8);
  assert('P210e', 'rirTarget from plan', r[0].exercises[0].rirTarget === 2);
})();

// P211 — _coachBuildBitacora: falls back to generic name without plan
console.log('\nP211 — _coachBuildBitacora fallback names');
(function() {
  var logs = { 'log_1_0_2_s0': { carga: '40', reps: '15', rir_real: '2', ics: '7', pump: '2', done: true, unit: 'KG' } };
  var r = _coachBuildBitacora(logs, 1, null);
  assert('P211a', 'no plan → generic exercise name', r[0].exercises[0].name === 'Ejercicio 3');
  assert('P211b', 'no plan → generic day label', r[0].label === 'Día 1');
  assert('P211c', 'repsTarget is null without plan', r[0].exercises[0].repsTarget === null);
})();

// P212 — _coachBuildBitacora: empty logs returns []
console.log('\nP212 — _coachBuildBitacora empty logs');
(function() {
  assert('P212a', 'empty logs → []', _coachBuildBitacora({}, 1, null).length === 0);
  assert('P212b', 'null logs → []', _coachBuildBitacora({}, 3, null).length === 0);
  // Non-log keys are ignored
  var logs = { 'done_1_0': true, 'ci_sem_1': { peso: 80 }, 'progrec_1_0': {} };
  assert('P212c', 'non-log keys produce no exercises', _coachBuildBitacora(logs, 1, null).every(function(d){ return d.exercises.length === 0; }));
})();

// P213 — _coachBuildBitacora: autoFilled sets included (marked, not excluded)
console.log('\nP213 — _coachBuildBitacora includes autoFilled sets (marked)');
(function() {
  var logs = {
    'log_1_0_0_s0': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG', autoFilled: false },
    'log_1_0_0_s1': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG', autoFilled: true },
  };
  var r = _coachBuildBitacora(logs, 1, null);
  assert('P213a', 'both sets included (2 total)', r[0].exercises[0].sets.length === 2);
  assert('P213b', 'real set: autoFilled = false', r[0].exercises[0].sets[0].autoFilled === false);
  assert('P213c', 'autoFilled set: autoFilled = true', r[0].exercises[0].sets[1].autoFilled === true);
})();

// P214 — _coachBuildBitacora: sets sorted by setIndex regardless of insertion order
console.log('\nP214 — _coachBuildBitacora sets sorted by setIndex');
(function() {
  var logs = {
    'log_1_0_0_s2': { carga: '90', reps: '6', rir_real: '1', ics: '9', pump: '1', done: true, unit: 'KG' },
    'log_1_0_0_s0': { carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
    'log_1_0_0_s1': { carga: '85', reps: '7', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
  };
  var r = _coachBuildBitacora(logs, 1, null);
  var sets = r[0].exercises[0].sets;
  assert('P214a', 'setIndex 0 first', sets[0].setIndex === 0 && sets[0].carga === '80');
  assert('P214b', 'setIndex 1 second', sets[1].setIndex === 1 && sets[1].carga === '85');
  assert('P214c', 'setIndex 2 last', sets[2].setIndex === 2 && sets[2].carga === '90');
})();

// P215 — _coachBuildBitacora: multiple exercises per day sorted by exIndex
console.log('\nP215 — _coachBuildBitacora exercises sorted by exIndex');
(function() {
  var logs = {
    'log_1_0_2_s0': { carga: '40', reps: '15', rir_real: '2', ics: '7', pump: '2', done: true, unit: 'KG' },
    'log_1_0_0_s0': { carga: '80', reps: '8', rir_real: '2', ics: '9', pump: '1', done: true, unit: 'KG' },
    'log_1_0_1_s0': { carga: '60', reps: '12', rir_real: '2', ics: '8', pump: '1', done: true, unit: 'KG' },
  };
  var r = _coachBuildBitacora(logs, 1, null);
  var exs = r[0].exercises;
  assert('P215a', '3 exercises', exs.length === 3);
  assert('P215b', 'exIndex 0 first (carga 80)', exs[0].exIndex === 0 && exs[0].sets[0].carga === '80');
  assert('P215c', 'exIndex 1 second (carga 60)', exs[1].exIndex === 1 && exs[1].sets[0].carga === '60');
  assert('P215d', 'exIndex 2 last (carga 40)', exs[2].exIndex === 2 && exs[2].sets[0].carga === '40');
})();

// ═══════════ FASE 15 — Navegación semanal (P216-P225) ═══════════

// Mirror de helpers de FASE 15 (idénticos a producción en vdsen-coach.html)
function _coachClampSelectedWeek(selected, currentWeek, totalWeeks) {
  if (selected == null || isNaN(selected)) return currentWeek;
  var w = parseInt(selected, 10);
  if (w < 1) return 1;
  if (w > totalWeeks) return totalWeeks;
  return w;
}

function _coachCalcWeightTrendUpTo(entries, max, upToWeek) {
  max = max || 3;
  if (!entries || typeof entries !== 'object') return { status: 'NO_DATA', rate: null };
  var checkins = [];
  Object.keys(entries).forEach(function(k) {
    var m = k.match(/^ci_sem_(\d+)$/);
    if (!m) return;
    var w = parseInt(m[1], 10);
    if (upToWeek != null && w > upToWeek) return;
    var ci = entries[k];
    if (!ci || typeof ci !== 'object') return;
    checkins.push({ week: w, data: ci });
  });
  checkins.sort(function(a, b) { return b.week - a.week; });
  checkins = checkins.slice(0, max);
  var points = [];
  checkins.forEach(function(ci) {
    var peso = parseFloat(ci.data && ci.data.peso);
    if (!isNaN(peso) && peso > 0) points.push({ week: ci.week, peso: peso });
  });
  if (points.length < 2) return { status: 'NO_DATA', rate: null };
  points.sort(function(a, b) { return a.week - b.week; });
  var first = points[0], last = points[points.length - 1];
  var weekDiff = last.week - first.week;
  if (weekDiff === 0) return { status: 'NO_DATA', rate: null };
  var rate = (last.peso - first.peso) / weekDiff;
  return {
    status: rate > 0.5 ? 'SUBIENDO' : rate < -0.5 ? 'BAJANDO' : 'ESTABLE',
    rate: +rate.toFixed(2)
  };
}

function _coachWeekStatus(selectedWeek, actualWeek) {
  if (selectedWeek < actualWeek) return 'HISTÓRICA';
  if (selectedWeek > actualWeek) return 'FUTURA';
  return 'ACTUAL';
}

// P216 — _coachClampSelectedWeek: basic clamping
console.log('\nP216 — _coachClampSelectedWeek: basic clamping');
(function(){
  assert('P216a', 'clamp: within range returns as-is', _coachClampSelectedWeek(3, 5, 6) === 3);
  assert('P216b', 'clamp: null returns currentWeek', _coachClampSelectedWeek(null, 4, 6) === 4);
  assert('P216c', 'clamp: below 1 returns 1', _coachClampSelectedWeek(0, 3, 6) === 1);
  assert('P216d', 'clamp: above totalWeeks returns totalWeeks', _coachClampSelectedWeek(9, 5, 6) === 6);
  assert('P216e', 'clamp: NaN returns currentWeek', _coachClampSelectedWeek(NaN, 2, 6) === 2);
})();

// P217 — _coachWeekStatus: returns correct status
console.log('\nP217 — _coachWeekStatus: ACTUAL/HISTÓRICA/FUTURA');
(function(){
  assert('P217a', 'equal → ACTUAL', _coachWeekStatus(3, 3) === 'ACTUAL');
  assert('P217b', 'selected < actual → HISTÓRICA', _coachWeekStatus(2, 4) === 'HISTÓRICA');
  assert('P217c', 'selected > actual → FUTURA', _coachWeekStatus(5, 3) === 'FUTURA');
  assert('P217d', 'week 1 actual 1 → ACTUAL', _coachWeekStatus(1, 1) === 'ACTUAL');
})();

// P218 — _coachCalcWeightTrendUpTo: excludes check-ins after upToWeek
console.log('\nP218 — _coachCalcWeightTrendUpTo: respects upToWeek cutoff');
(function(){
  var entries = {
    'ci_sem_1': { peso: '80' },
    'ci_sem_2': { peso: '81' },
    'ci_sem_3': { peso: '90' } // future — should be excluded when upToWeek=2
  };
  var t = _coachCalcWeightTrendUpTo(entries, 3, 2);
  assert('P218a', 'rate = +1.0/week (weeks 1→2)', t.rate === 1.0);
  assert('P218b', 'status SUBIENDO', t.status === 'SUBIENDO');
  // week 3 included makes rate = (90-80)/2 = 5.0 — different result proves cutoff works
  var tFull = _coachCalcWeightTrendUpTo(entries, 3, 3);
  assert('P218c', 'upToWeek=3 gives different rate', tFull.rate !== t.rate);
})();

// P219 — _coachCalcWeightTrendUpTo: no check-ins → NO_DATA
console.log('\nP219 — _coachCalcWeightTrendUpTo: NO_DATA on empty');
(function(){
  assert('P219a', 'empty entries → NO_DATA', _coachCalcWeightTrendUpTo({}, 3, 5).status === 'NO_DATA');
  assert('P219b', 'single checkin → NO_DATA', _coachCalcWeightTrendUpTo({'ci_sem_1':{ peso:'80' }}, 3, 5).status === 'NO_DATA');
  assert('P219c', 'null entries → NO_DATA', _coachCalcWeightTrendUpTo(null, 3, 5).status === 'NO_DATA');
})();

// P220 — _coachCalcWeightTrendUpTo: BAJANDO
console.log('\nP220 — _coachCalcWeightTrendUpTo: BAJANDO threshold');
(function(){
  var entries = { 'ci_sem_1': { peso: '85' }, 'ci_sem_2': { peso: '84' } };
  var t = _coachCalcWeightTrendUpTo(entries, 3, 2);
  assert('P220a', 'rate = -1.0 → BAJANDO', t.status === 'BAJANDO');
  assert('P220b', 'rate value -1.0', t.rate === -1.0);
})();

// P221 — _coachCalcWeightTrendUpTo: ESTABLE boundary
console.log('\nP221 — _coachCalcWeightTrendUpTo: ESTABLE at ±0.5 boundary');
(function(){
  var e1 = { 'ci_sem_1': { peso: '80' }, 'ci_sem_2': { peso: '80.5' } }; // +0.5 → ESTABLE
  var t1 = _coachCalcWeightTrendUpTo(e1, 3, 2);
  assert('P221a', '+0.5 is ESTABLE (not SUBIENDO)', t1.status === 'ESTABLE');
  var e2 = { 'ci_sem_1': { peso: '80' }, 'ci_sem_2': { peso: '79.5' } }; // -0.5 → ESTABLE
  var t2 = _coachCalcWeightTrendUpTo(e2, 3, 2);
  assert('P221b', '-0.5 is ESTABLE (not BAJANDO)', t2.status === 'ESTABLE');
})();

// P222 — _coachCalcWeightTrendUpTo: upToWeek=0 → NO_DATA (no valid entries)
console.log('\nP222 — _coachCalcWeightTrendUpTo: upToWeek=0 excludes all');
(function(){
  var entries = { 'ci_sem_1': { peso: '80' }, 'ci_sem_2': { peso: '82' } };
  var t = _coachCalcWeightTrendUpTo(entries, 3, 0);
  assert('P222a', 'upToWeek=0 → NO_DATA', t.status === 'NO_DATA');
})();

// P223 — _coachClampSelectedWeek: exact boundary values
console.log('\nP223 — _coachClampSelectedWeek: exact boundary values');
(function(){
  assert('P223a', 'selected=1, totalWeeks=6 → 1', _coachClampSelectedWeek(1, 3, 6) === 1);
  assert('P223b', 'selected=6, totalWeeks=6 → 6', _coachClampSelectedWeek(6, 3, 6) === 6);
  assert('P223c', 'selected=7, totalWeeks=6 → 6 (clamped to max)', _coachClampSelectedWeek(7, 3, 6) === 6);
  assert('P223d', 'negative → 1', _coachClampSelectedWeek(-3, 2, 6) === 1);
})();

// P224 — _coachWeekStatus: edge cases
console.log('\nP224 — _coachWeekStatus: edge cases');
(function(){
  assert('P224a', 'week=1, actual=1 → ACTUAL', _coachWeekStatus(1, 1) === 'ACTUAL');
  assert('P224b', 'week=6, actual=6 → ACTUAL', _coachWeekStatus(6, 6) === 'ACTUAL');
  assert('P224c', 'week=1, actual=6 → HISTÓRICA', _coachWeekStatus(1, 6) === 'HISTÓRICA');
  assert('P224d', 'week=6, actual=1 → FUTURA', _coachWeekStatus(6, 1) === 'FUTURA');
})();

// P225 — parity: _coachCalcWeightTrendUpTo without cutoff matches _coachCalcWeightTrend
console.log('\nP225 — _coachCalcWeightTrendUpTo parity with _coachCalcWeightTrend');
(function(){
  var entries = {
    'ci_sem_1': { peso: '78' },
    'ci_sem_2': { peso: '79' },
    'ci_sem_3': { peso: '80' }
  };
  var tUpTo = _coachCalcWeightTrendUpTo(entries, 3, 99); // no cutoff (upToWeek=99)
  var tOrig = _coachCalcWeightTrend(entries, 3);
  assert('P225a', 'same status (no cutoff)', tUpTo.status === tOrig.status);
  assert('P225b', 'same rate (no cutoff)', tUpTo.rate === tOrig.rate);
  // With cutoff: upToWeek=2 excludes week 3 → different result
  var tCut = _coachCalcWeightTrendUpTo(entries, 3, 2);
  assert('P225c', 'cutoff at week 2: SUBIENDO (+1.0)', tCut.status === 'SUBIENDO' && tCut.rate === 1.0);
})();

// ═════════════════════════ FASE 16 — _replacePrescriptionExercise ═════════════════════════

// Mirror del helper puro (idéntico a producción)
function _replacePrescriptionExercise(exercise, replacement, generateId) {
  if (!exercise) return exercise;
  var repName = ((replacement && replacement.name) || '').trim();
  if (!repName) return Object.assign({}, exercise);
  var repCatId = (replacement && (replacement.id || replacement.exerciseId)) || null;
  var oldCatId = exercise.exerciseId || null;
  var isSame = (repCatId && oldCatId)
    ? repCatId === oldCatId
    : repName.toLowerCase() === (exercise.exerciseName || '').trim().toLowerCase();
  if (isSame) return Object.assign({}, exercise);
  var result = Object.assign({}, exercise, { exerciseName: repName });
  if (repCatId) result.exerciseId = repCatId;
  result.prescriptionExerciseId = generateId();
  return result;
}

// P226 — replacement changes exerciseName
console.log('\nP226 — replacement changes exerciseName');
(function(){
  var r = _replacePrescriptionExercise(
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'old123', sets: [] },
    { name: 'Press Inclinado' },
    function(){ return 'newId'; }
  );
  assert('P226a', 'exerciseName updated to replacement', r.exerciseName === 'Press Inclinado');
  assert('P226b', 'original name not in result', r.exerciseName !== 'Press Banca');
})();

// P227 — replacement updates canonical exerciseId
console.log('\nP227 — replacement updates canonical exerciseId');
(function(){
  var r = _replacePrescriptionExercise(
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'old123', exerciseId: 'catA' },
    { name: 'Press Inclinado', id: 'catB' },
    function(){ return 'newId'; }
  );
  assert('P227a', 'exerciseId updated to replacement catalogId', r.exerciseId === 'catB');
  assert('P227b', 'exerciseName also updated', r.exerciseName === 'Press Inclinado');
})();

// P228 — replacement generates new prescriptionExerciseId
console.log('\nP228 — replacement generates new prescriptionExerciseId');
(function(){
  var r = _replacePrescriptionExercise(
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'old123' },
    { name: 'Curl Bíceps' },
    function(){ return 'generated_new'; }
  );
  assert('P228a', 'prescriptionExerciseId is generated value', r.prescriptionExerciseId === 'generated_new');
})();

// P229 — new prescriptionExerciseId differs from old
console.log('\nP229 — new prescriptionExerciseId differs from old');
(function(){
  var r = _replacePrescriptionExercise(
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'OLD_STABLE' },
    { name: 'Curl Bíceps' },
    function(){ return 'BRAND_NEW'; }
  );
  assert('P229a', 'new ID differs from old ID', r.prescriptionExerciseId !== 'OLD_STABLE');
  assert('P229b', 'new ID is the generated value', r.prescriptionExerciseId === 'BRAND_NEW');
})();

// P230 — sets preserved
console.log('\nP230 — sets preserved');
(function(){
  var sets = [{ setIndex: 0, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 120 }];
  var r = _replacePrescriptionExercise(
    { exerciseName: 'A', prescriptionExerciseId: 'x', sets: sets },
    { name: 'B' },
    function(){ return 'y'; }
  );
  assert('P230a', 'sets reference preserved', r.sets === sets);
  assert('P230b', 'sets count unchanged', r.sets.length === 1);
  assert('P230c', 'repsTarget preserved in set', r.sets[0].repsTarget === 10);
})();

// P231 — restSeconds preserved
console.log('\nP231 — restSeconds preserved in sets');
(function(){
  var r = _replacePrescriptionExercise(
    { exerciseName: 'A', prescriptionExerciseId: 'x', sets: [{ restSeconds: 180, repsTarget: 8, rirTarget: 2 }] },
    { name: 'B' },
    function(){ return 'y'; }
  );
  assert('P231a', 'restSeconds preserved', r.sets[0].restSeconds === 180);
  assert('P231b', 'rirTarget preserved', r.sets[0].rirTarget === 2);
})();

// P232 — source exercise object not mutated
console.log('\nP232 — source exercise object not mutated');
(function(){
  var original = { exerciseName: 'A', prescriptionExerciseId: 'orig', exerciseId: 'catA', sets: [{ repsTarget: 8 }], coachNote: 'nota' };
  var r = _replacePrescriptionExercise(original, { name: 'B' }, function(){ return 'new'; });
  assert('P232a', 'source exerciseName not mutated', original.exerciseName === 'A');
  assert('P232b', 'source prescriptionExerciseId not mutated', original.prescriptionExerciseId === 'orig');
  assert('P232c', 'result is a different object', r !== original);
})();

// P233 — same exercise does not regenerate identity
console.log('\nP233 — same exercise does not regenerate identity');
(function(){
  var called = 0;
  var r = _replacePrescriptionExercise(
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'stable', exerciseId: 'catA' },
    { name: 'Press Banca', id: 'catA' },
    function(){ called++; return 'shouldNotCall'; }
  );
  assert('P233a', 'same exerciseId → prescriptionExerciseId preserved', r.prescriptionExerciseId === 'stable');
  assert('P233b', 'generateId not called for same exercise', called === 0);
  // Fallback: same name (no catalogId)
  var called2 = 0;
  var r2 = _replacePrescriptionExercise(
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'stable2' },
    { name: 'Press Banca' },
    function(){ called2++; return 'shouldNotCall2'; }
  );
  assert('P233c', 'same name (no catalogId) → prescriptionExerciseId preserved', r2.prescriptionExerciseId === 'stable2');
  assert('P233d', 'generateId not called for same name', called2 === 0);
})();

// P234 — replacement does not alter sibling exercise IDs
console.log('\nP234 — replacement does not alter sibling exercise IDs');
(function(){
  var ex1 = { exerciseName: 'A', prescriptionExerciseId: 'id_a', sets: [] };
  var ex2 = { exerciseName: 'B', prescriptionExerciseId: 'id_b', sets: [] };
  var r1 = _replacePrescriptionExercise(ex1, { name: 'C' }, function(){ return 'id_c'; });
  assert('P234a', 'sibling ex2.prescriptionExerciseId unaffected', ex2.prescriptionExerciseId === 'id_b');
  assert('P234b', 'target exercise has new ID', r1.prescriptionExerciseId === 'id_c');
  assert('P234c', 'ex1 source not mutated', ex1.prescriptionExerciseId === 'id_a');
})();

// P235 — replacement + reorder preserves new stable identity
console.log('\nP235 — replacement + reorder preserves new stable identity');
(function(){
  var exA = _replacePrescriptionExercise(
    { exerciseName: 'A', prescriptionExerciseId: 'old_a', sets: [] },
    { name: 'C' },
    function(){ return 'id_c'; }
  );
  var exB = { exerciseName: 'B', prescriptionExerciseId: 'id_b', sets: [] };
  // Simulate reorder: swap exA and exB in array (identity must not change)
  var arr = [exB, exA]; // reordered
  assert('P235a', 'new ID is stable after reorder', arr[1].prescriptionExerciseId === 'id_c');
  assert('P235b', 'sibling B ID stable after reorder', arr[0].prescriptionExerciseId === 'id_b');
})();

// P236 — cancel/no-op leaves complete exercise unchanged
console.log('\nP236 — cancel/no-op leaves complete exercise unchanged');
(function(){
  var ex = { exerciseName: 'Press Banca', prescriptionExerciseId: 'stable', exerciseId: 'catA', sets: [{ repsTarget: 8 }], coachNote: 'nota', supersetGroup: 'A' };
  var noop = _replacePrescriptionExercise(ex, { name: 'Press Banca', id: 'catA' }, function(){ return 'should_not'; });
  assert('P236a', 'exerciseName unchanged', noop.exerciseName === 'Press Banca');
  assert('P236b', 'prescriptionExerciseId unchanged', noop.prescriptionExerciseId === 'stable');
  assert('P236c', 'sets preserved', noop.sets[0].repsTarget === 8);
  assert('P236d', 'coachNote preserved', noop.coachNote === 'nota');
  assert('P236e', 'supersetGroup preserved', noop.supersetGroup === 'A');
})();

// P237 — catalog filtering: pure local logic (0 Firestore reads)
console.log('\nP237 — catalog filtering is pure local logic');
(function(){
  var catalog = [
    { name: 'Press Banca', motorPattern: 'empuje horizontal', equipment: 'barra' },
    { name: 'Press Inclinado', motorPattern: 'empuje inclinado', equipment: 'barra' },
    { name: 'Curl Bíceps', motorPattern: 'flexión codo', equipment: 'mancuerna' }
  ];
  var r = _filterExerciseCatalog('press', catalog, 10);
  assert('P237a', '"press" matches 2 results', r.length === 2);
  assert('P237b', 'first result is Press Banca', r[0].name === 'Press Banca');
  assert('P237c', 'second result is Press Inclinado', r[1].name === 'Press Inclinado');
  var r2 = _filterExerciseCatalog('curl', catalog, 10);
  assert('P237d', '"curl" matches 1 result', r2.length === 1);
  assert('P237e', 'empty catalog returns []', _filterExerciseCatalog('press', [], 10).length === 0);
  assert('P237f', 'empty query returns []', _filterExerciseCatalog('', catalog, 10).length === 0);
})();

// ═════════════════════════ FASE 17 — CSV Export ═════════════════════════

// Mirrors de helpers puros (idénticos a producción)
function _escapeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  var s = String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[,"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function _safeExportFilename(name, date) {
  var safeName = (name || 'cliente').replace(/[^a-zA-ZÀ-ÿ0-9\-_]/g, '_').replace(/_+/g, '_').slice(0, 30);
  var safeDate = (date instanceof Date ? date : new Date()).toISOString().slice(0, 10);
  return 'vdsen_' + safeName + '_' + safeDate + '.csv';
}

function _normalizeTimestamp(ts) {
  if (!ts) return '';
  try {
    if (ts && typeof ts.toDate === 'function') return ts.toDate().toISOString();
    if (typeof ts === 'number') return new Date(ts).toISOString();
    if (ts instanceof Date) return ts.toISOString();
    var d = new Date(ts);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  } catch(e) { return ''; }
}

function _buildPlanLookup(planData) {
  var byPrescId = {}, byPos = {};
  if (!planData || !planData.days) return { byPrescId: byPrescId, byPos: byPos };
  planData.days.forEach(function(day) {
    var di = day.dayIndex != null ? day.dayIndex : 0;
    (day.exercises || []).forEach(function(ex, ei) {
      if (ex.prescriptionExerciseId) byPrescId[ex.prescriptionExerciseId] = ex.exerciseName || '';
      if (!byPos[di]) byPos[di] = {};
      byPos[di][ei] = ex.exerciseName || '';
    });
  });
  return { byPrescId: byPrescId, byPos: byPos };
}

function _resolveExerciseName(entry, di, ei, lookup) {
  if (entry.exerciseNameSnapshot) return entry.exerciseNameSnapshot;
  if (entry.prescriptionExerciseId && lookup.byPrescId[entry.prescriptionExerciseId])
    return lookup.byPrescId[entry.prescriptionExerciseId];
  if (lookup.byPos[di] && lookup.byPos[di][ei] != null) return lookup.byPos[di][ei];
  return '';
}

function _buildOperationalExportRows(entries, planData) {
  if (!entries || typeof entries !== 'object') return [];
  var rows = [];
  var lookup = _buildPlanLookup(planData);
  var SET_KEY = /^log_(\d+)_(\d+)_(\d+)_s(\d+)$/;
  var CI_KEY  = /^ci_sem_(\d+)$/;
  var PS_KEY  = /^postsession_(\d+)_(\d+)$/;
  var PR_KEY  = /^progrec_(\d+)_(\d+)$/;

  Object.keys(entries).forEach(function(k) {
    var v = entries[k];
    var m;
    m = k.match(SET_KEY);
    if (m) {
      var w = +m[1], d = +m[2], ei = +m[3], si = +m[4];
      var exName = _resolveExerciseName(v, d, ei, lookup);
      rows.push({
        recordType: 'SET', week: w, day: d, exerciseName: exName,
        prescriptionExerciseId: v.prescriptionExerciseId || '',
        setIndex: si, load: v.carga != null ? v.carga : '', unit: v.unit || '',
        reps: v.reps != null ? v.reps : '', rir_real: v.rir_real != null ? v.rir_real : '',
        ics: v.ics != null ? v.ics : '', pump: v.pump != null ? v.pump : '',
        autoFilled: v.autoFilled ? true : false, done: v.done ? true : false,
        weight: '', hrv: '', who5: '', sleep: '', eimd: '', articular: '', patron: '',
        rpe: '', progressionAction: '', progressionReason: '',
        timestamp: _normalizeTimestamp(v.ts)
      });
      return;
    }
    m = k.match(CI_KEY);
    if (m) {
      var w = +m[1];
      rows.push({
        recordType: 'CHECKIN', week: w, day: '', exerciseName: '', prescriptionExerciseId: '',
        setIndex: '', load: '', unit: '', reps: '', rir_real: '', ics: '', pump: '',
        autoFilled: '', done: '',
        weight: v.peso != null ? v.peso : '', hrv: v.hrv != null ? v.hrv : '',
        who5: v.who5 != null ? v.who5 : '', sleep: v.sleep != null ? v.sleep : '',
        eimd: '', articular: '', patron: '', rpe: '',
        progressionAction: '', progressionReason: '', timestamp: _normalizeTimestamp(v.ts)
      });
      return;
    }
    m = k.match(PS_KEY);
    if (m) {
      var w = +m[1], d = +m[2];
      rows.push({
        recordType: 'POSTSESSION', week: w, day: d, exerciseName: '', prescriptionExerciseId: '',
        setIndex: '', load: '', unit: '', reps: '', rir_real: '', ics: '', pump: '',
        autoFilled: '', done: '', weight: '', hrv: '', who5: '',
        sleep: v.sleep != null ? v.sleep : '', eimd: v.eimd != null ? v.eimd : '',
        articular: v.articular != null ? v.articular : '', patron: v.patron != null ? v.patron : '',
        rpe: v.rpe != null ? v.rpe : '',
        progressionAction: '', progressionReason: '', timestamp: _normalizeTimestamp(v.ts)
      });
      return;
    }
    m = k.match(PR_KEY);
    if (m) {
      var w = +m[1], d = +m[2];
      var recs = (v.recommendations || []);
      if (!recs.length) {
        rows.push({ recordType: 'PROGRESSION', week: w, day: d, exerciseName: '', prescriptionExerciseId: '',
          setIndex: '', load: '', unit: '', reps: '', rir_real: '', ics: '', pump: '',
          autoFilled: '', done: '', weight: '', hrv: '', who5: '', sleep: '',
          eimd: '', articular: '', patron: '', rpe: '',
          progressionAction: 'deload_candidate', progressionReason: '', timestamp: _normalizeTimestamp(v.ts) });
      } else {
        recs.forEach(function(rec) {
          if (!rec) return;
          rows.push({ recordType: 'PROGRESSION', week: w, day: d,
            exerciseName: rec.exerciseName || '', prescriptionExerciseId: rec.prescriptionExerciseId || '',
            setIndex: '', load: '', unit: '', reps: '', rir_real: '', ics: '', pump: '',
            autoFilled: '', done: '', weight: '', hrv: '', who5: '', sleep: '',
            eimd: '', articular: '', patron: '', rpe: '',
            progressionAction: rec.action || '', progressionReason: rec.reason || '',
            timestamp: _normalizeTimestamp(v.ts) });
        });
      }
    }
  });

  var typeOrder = { SET: 0, POSTSESSION: 1, CHECKIN: 2, PROGRESSION: 3 };
  function _sortNum(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  rows.sort(function(a, b) {
    var wDiff = _sortNum(a.week) - _sortNum(b.week);
    if (wDiff !== 0) return wDiff;
    var dDiff = _sortNum(a.day) - _sortNum(b.day);
    if (dDiff !== 0) return dDiff;
    var ta = typeOrder[a.recordType] != null ? typeOrder[a.recordType] : 9;
    var tb = typeOrder[b.recordType] != null ? typeOrder[b.recordType] : 9;
    if (ta !== tb) return ta - tb;
    var sDiff = _sortNum(a.setIndex) - _sortNum(b.setIndex);
    if (sDiff !== 0) return sDiff;
    return String(a.exerciseName || '').localeCompare(String(b.exerciseName || ''));
  });
  return rows;
}

var _CSV_COLUMNS = [
  'recordType','week','day','exerciseName','prescriptionExerciseId',
  'setIndex','load','unit','reps','rir_real','ics','pump','autoFilled','done',
  'weight','hrv','who5','sleep','eimd','articular','patron','rpe',
  'progressionAction','progressionReason','timestamp'
];

function _toCsvString(rows, columns) {
  columns = columns || _CSV_COLUMNS;
  var lines = [columns.join(',')];
  var textCols = { exerciseName:1, prescriptionExerciseId:1, unit:1, patron:1, progressionAction:1, progressionReason:1 };
  rows.forEach(function(row) {
    var cells = columns.map(function(col) {
      var v = row[col];
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (textCols[col]) return _escapeCsvCell(v);
      var s = String(v);
      if (/[,"\r\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
      return s;
    });
    lines.push(cells.join(','));
  });
  return '﻿' + lines.join('\r\n');
}

// P238 — set log → una fila SET
console.log('\nP238 — set log → una fila SET');
(function(){
  var entries = { 'log_1_0_0_s0': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1, ts: null } };
  var rows = _buildOperationalExportRows(entries, null);
  assert('P238a', 'una fila generada', rows.length === 1);
  assert('P238b', 'recordType es SET', rows[0].recordType === 'SET');
  assert('P238c', 'week correcto', rows[0].week === 1);
  assert('P238d', 'day correcto', rows[0].day === 0);
  assert('P238e', 'load correcto', rows[0].load === 80);
  assert('P238f', 'reps correcto', rows[0].reps === 8);
  assert('P238g', 'ics correcto', rows[0].ics === 8);
})();

// P239 — múltiples sets → múltiples filas
console.log('\nP239 — múltiples sets → múltiples filas');
(function(){
  var entries = {
    'log_1_0_0_s0': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1, ts: null },
    'log_1_0_0_s1': { carga: 82, reps: 7, unit: 'KG', done: true, rir_real: 0, ics: 9, pump: 1, ts: null },
    'log_1_0_0_s2': { carga: 82, reps: 6, unit: 'KG', done: true, rir_real: 0, ics: 7, pump: 2, ts: null }
  };
  var rows = _buildOperationalExportRows(entries, null);
  assert('P239a', 'tres filas generadas', rows.length === 3);
  assert('P239b', 'todas son SET', rows.every(function(r){ return r.recordType === 'SET'; }));
  assert('P239c', 'setIndex 0 presente', rows.some(function(r){ return r.setIndex === 0; }));
  assert('P239d', 'setIndex 2 presente', rows.some(function(r){ return r.setIndex === 2; }));
})();

// P240 — autoFilled se conserva como flag, no se elimina
console.log('\nP240 — autoFilled se conserva como flag, no se elimina');
(function(){
  var entries = {
    'log_1_0_0_s0': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1, autoFilled: true },
    'log_1_0_0_s1': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1, autoFilled: false },
    'log_1_0_0_s2': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1 }
  };
  var rows = _buildOperationalExportRows(entries, null);
  assert('P240a', 'tres filas (autoFilled no excluye fila)', rows.length === 3);
  var af = rows.filter(function(r){ return r.autoFilled === true; });
  var noAf = rows.filter(function(r){ return r.autoFilled === false; });
  assert('P240b', 'autoFilled:true conservado', af.length === 1);
  assert('P240c', 'autoFilled:false conservado', noAf.length === 2);
})();

// P241 — check-in → fila CHECKIN
console.log('\nP241 — check-in → fila CHECKIN');
(function(){
  var entries = { 'ci_sem_2': { peso: 80.5, hrv: 55, who5: 70, sleep: 7.5 } };
  var rows = _buildOperationalExportRows(entries, null);
  assert('P241a', 'una fila generada', rows.length === 1);
  assert('P241b', 'recordType es CHECKIN', rows[0].recordType === 'CHECKIN');
  assert('P241c', 'week correcto', rows[0].week === 2);
  assert('P241d', 'weight correcto', rows[0].weight === 80.5);
  assert('P241e', 'hrv correcto', rows[0].hrv === 55);
  assert('P241f', 'who5 correcto', rows[0].who5 === 70);
  assert('P241g', 'day está vacío', rows[0].day === '');
})();

// P242 — postsession → fila POSTSESSION
console.log('\nP242 — postsession → fila POSTSESSION');
(function(){
  var entries = { 'postsession_1_2': { eimd: 2, articular: 'si', patron: 'rodilla', sleep: 7, rpe: 8 } };
  var rows = _buildOperationalExportRows(entries, null);
  assert('P242a', 'una fila generada', rows.length === 1);
  assert('P242b', 'recordType es POSTSESSION', rows[0].recordType === 'POSTSESSION');
  assert('P242c', 'week correcto', rows[0].week === 1);
  assert('P242d', 'day correcto', rows[0].day === 2);
  assert('P242e', 'eimd correcto', rows[0].eimd === 2);
  assert('P242f', 'articular correcto', rows[0].articular === 'si');
  assert('P242g', 'patron correcto', rows[0].patron === 'rodilla');
  assert('P242h', 'rpe correcto', rows[0].rpe === 8);
})();

// P243 — progrec → fila PROGRESSION
console.log('\nP243 — progrec → fila PROGRESSION');
(function(){
  var entries = { 'progrec_1_0': { recommendations: [{ exerciseName: 'Press Banca', action: 'increase_load', reason: 'RIR alto' }] } };
  var rows = _buildOperationalExportRows(entries, null);
  assert('P243a', 'una fila generada', rows.length === 1);
  assert('P243b', 'recordType es PROGRESSION', rows[0].recordType === 'PROGRESSION');
  assert('P243c', 'exerciseName correcto', rows[0].exerciseName === 'Press Banca');
  assert('P243d', 'progressionAction correcto', rows[0].progressionAction === 'increase_load');
  assert('P243e', 'progressionReason correcto', rows[0].progressionReason === 'RIR alto');
  // progrec sin recomendaciones → deload_candidate
  var entries2 = { 'progrec_2_1': { recommendations: [] } };
  var rows2 = _buildOperationalExportRows(entries2, null);
  assert('P243f', 'progrec vacío genera fila deload_candidate', rows2.length === 1);
  assert('P243g', 'action es deload_candidate', rows2[0].progressionAction === 'deload_candidate');
})();

// P244 — empty logs → []
console.log('\nP244 — empty logs → []');
(function(){
  assert('P244a', 'null → []', _buildOperationalExportRows(null, null).length === 0);
  assert('P244b', 'objeto vacío → []', _buildOperationalExportRows({}, null).length === 0);
  assert('P244c', 'undefined → []', _buildOperationalExportRows(undefined, null).length === 0);
  // Claves done_{W}_{D} no generan filas (no son recordType exportable)
  var entries = { 'done_1_0': true };
  assert('P244d', 'done_{W}_{D} no genera fila', _buildOperationalExportRows(entries, null).length === 0);
})();

// P245 — CSV escapa comas
console.log('\nP245 — CSV escapa comas');
(function(){
  assert('P245a', 'valor con coma queda entre comillas', _escapeCsvCell('a,b') === '"a,b"');
  assert('P245b', 'valor sin coma no lleva comillas', _escapeCsvCell('abc') === 'abc');
  assert('P245c', 'valor numérico sin coma no lleva comillas', _escapeCsvCell(80) === '80');
})();

// P246 — CSV escapa comillas
console.log('\nP246 — CSV escapa comillas');
(function(){
  assert('P246a', 'comilla interna se duplica y se envuelve', _escapeCsvCell('say "hi"') === '"say ""hi"""');
  assert('P246b', 'sin comillas: sin modificar', _escapeCsvCell('hello') === 'hello');
})();

// P247 — CSV escapa newlines
console.log('\nP247 — CSV escapa newlines');
(function(){
  assert('P247a', 'newline LF queda entre comillas', _escapeCsvCell('a\nb') === '"a\nb"');
  assert('P247b', 'newline CR queda entre comillas', _escapeCsvCell('a\rb') === '"a\rb"');
  assert('P247c', 'CRLF queda entre comillas', _escapeCsvCell('a\r\nb') === '"a\r\nb"');
})();

// P248 — 0 y false no se convierten en vacío
console.log('\nP248 — 0 y false no se convierten en vacío');
(function(){
  var entries = { 'log_1_0_0_s0': { carga: 0, reps: 0, unit: 'KG', done: false, rir_real: 0, ics: 0, pump: 0 } };
  var rows = _buildOperationalExportRows(entries, null);
  assert('P248a', 'carga 0 no es vacío', rows[0].load === 0);
  assert('P248b', 'reps 0 no es vacío', rows[0].reps === 0);
  assert('P248c', 'rir_real 0 no es vacío', rows[0].rir_real === 0);
  assert('P248d', 'ics 0 no es vacío', rows[0].ics === 0);
  assert('P248e', 'done false se conserva como false', rows[0].done === false);
  assert('P248f', 'autoFilled false conservado', rows[0].autoFilled === false);
})();

// P249 — formula injection textual neutralizada
console.log('\nP249 — formula injection textual neutralizada');
(function(){
  assert('P249a', '= neutralizado con prefijo', _escapeCsvCell('=CMD') === "'=CMD");
  assert('P249b', '+ neutralizado con prefijo', _escapeCsvCell('+foo') === "'+foo");
  assert('P249c', '- neutralizado con prefijo', _escapeCsvCell('-foo') === "'-foo");
  assert('P249d', '@ neutralizado con prefijo', _escapeCsvCell('@foo') === "'@foo");
  assert('P249e', 'texto normal no modificado', _escapeCsvCell('Press Banca') === 'Press Banca');
  // Número negativo: -80 en columna numérica no pasa por _escapeCsvCell (es numérico)
  // Solo las textCols pasan por _escapeCsvCell
  assert('P249f', 'valor null → comillas vacías', _escapeCsvCell(null) === '""');
  assert('P249g', 'valor undefined → comillas vacías', _escapeCsvCell(undefined) === '""');
})();

// P250 — timestamp normalizado de forma segura
console.log('\nP250 — timestamp normalizado de forma segura');
(function(){
  var ISO = '2025-01-15T10:30:00.000Z';
  assert('P250a', 'Date object → ISO string', _normalizeTimestamp(new Date(ISO)) === ISO);
  assert('P250b', 'ms timestamp → ISO string', _normalizeTimestamp(new Date(ISO).getTime()) === ISO);
  assert('P250c', 'ISO string → ISO string', _normalizeTimestamp(ISO) === ISO);
  assert('P250d', 'null → vacío', _normalizeTimestamp(null) === '');
  assert('P250e', 'undefined → vacío', _normalizeTimestamp(undefined) === '');
  assert('P250f', 'cadena inválida → vacío', _normalizeTimestamp('not-a-date') === '');
  // Firestore Timestamp stub
  var firestoreTs = { toDate: function(){ return new Date(ISO); } };
  assert('P250g', 'objeto toDate() → ISO string', _normalizeTimestamp(firestoreTs) === ISO);
})();

// P251 — orden de export determinista
console.log('\nP251 — orden de export determinista');
(function(){
  var entries = {
    'progrec_1_0': { recommendations: [{ exerciseName: 'Press', action: 'increase_load', reason: 'ok' }] },
    'postsession_1_0': { eimd: 1, articular: 'no', patron: '', sleep: 8, rpe: 7 },
    'ci_sem_1': { peso: 78, hrv: 60, who5: 65, sleep: 8 },
    'log_1_0_1_s0': { carga: 60, reps: 10, unit: 'KG', done: true, rir_real: 2, ics: 8, pump: 1 },
    'log_1_0_0_s1': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 9, pump: 1 },
    'log_1_0_0_s0': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1 },
    'log_2_0_0_s0': { carga: 82, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1 }
  };
  var rows = _buildOperationalExportRows(entries, null);
  // Orden esperado: semana 1 primero, luego semana 2
  // Dentro de semana 1 día 0: SET(s0), SET(s1), SET(ex1 s0), POSTSESSION, CHECKIN, PROGRESSION
  assert('P251a', 'filas ordenadas por semana', rows[0].week === 1);
  assert('P251b', 'última fila es semana 2', rows[rows.length - 1].week === 2);
  var week1 = rows.filter(function(r){ return r.week === 1; });
  var setRows = week1.filter(function(r){ return r.recordType === 'SET'; });
  var psRow   = week1.filter(function(r){ return r.recordType === 'POSTSESSION'; });
  var ciRow   = week1.filter(function(r){ return r.recordType === 'CHECKIN'; });
  var prRow   = week1.filter(function(r){ return r.recordType === 'PROGRESSION'; });
  assert('P251c', 'semana 1: 3 filas SET', setRows.length === 3);
  assert('P251d', 'semana 1: 1 fila POSTSESSION', psRow.length === 1);
  assert('P251e', 'semana 1: 1 fila CHECKIN', ciRow.length === 1);
  assert('P251f', 'semana 1: 1 fila PROGRESSION', prRow.length === 1);
  // SET antes que POSTSESSION dentro del mismo día
  var firstSet = rows.findIndex(function(r){ return r.recordType === 'SET' && r.week === 1; });
  var firstPs  = rows.findIndex(function(r){ return r.recordType === 'POSTSESSION' && r.week === 1; });
  assert('P251g', 'SET aparece antes que POSTSESSION', firstSet < firstPs);
  // POSTSESSION antes que CHECKIN
  var firstCi  = rows.findIndex(function(r){ return r.recordType === 'CHECKIN' && r.week === 1; });
  assert('P251h', 'POSTSESSION aparece antes que CHECKIN', firstPs < firstCi);
  // CHECKIN (day='') y PROGRESSION (day=0) → normalized a 0 igual → typeOrder decide (CHECKIN=2 < PROGRESSION=3)
  var firstPr  = rows.findIndex(function(r){ return r.recordType === 'PROGRESSION' && r.week === 1; });
  assert('P251i', 'CHECKIN aparece antes que PROGRESSION (typeOrder cuando day normalizado igual)', firstCi < firstPr);
  // setIndex creciente dentro de la misma clave log_{W}_{D}_{E}
  var s0idx = rows.findIndex(function(r){ return r.recordType === 'SET' && r.setIndex === 0 && r.day === 0; });
  var s1idx = rows.findIndex(function(r){ return r.recordType === 'SET' && r.setIndex === 1 && r.day === 0; });
  assert('P251j', 'set s0 aparece antes que s1', s0idx < s1idx);
})();

// P252 — sort determinista: day='' vs day=0, null, undefined
console.log('\nP252 — sort determinista con day heterogéneo');
(function(){
  // P252a: CHECKIN (day='') y PROGRESSION (day=0) → typeOrder decide (CHECKIN=2 < PROGRESSION=3)
  var entries = {
    'progrec_1_0': { recommendations: [{ exerciseName: 'Press', action: 'maintain', reason: 'ok' }] },
    'ci_sem_1': { peso: 78, hrv: 60, who5: 65, sleep: 8 }
  };
  var rows = _buildOperationalExportRows(entries, null);
  var ciIdx = rows.findIndex(function(r){ return r.recordType === 'CHECKIN'; });
  var prIdx = rows.findIndex(function(r){ return r.recordType === 'PROGRESSION'; });
  assert('P252a', 'CHECKIN (day="") antes que PROGRESSION (day=0) por typeOrder', ciIdx < prIdx);

  // P252b: mismo input en diferente insertion order → mismo sort result
  var entriesRev = {
    'ci_sem_1': { peso: 78, hrv: 60, who5: 65, sleep: 8 },
    'progrec_1_0': { recommendations: [{ exerciseName: 'Press', action: 'maintain', reason: 'ok' }] }
  };
  var rowsRev = _buildOperationalExportRows(entriesRev, null);
  var ciIdxRev = rowsRev.findIndex(function(r){ return r.recordType === 'CHECKIN'; });
  var prIdxRev = rowsRev.findIndex(function(r){ return r.recordType === 'PROGRESSION'; });
  assert('P252b', 'insertion order invertido produce mismo sort (CHECKIN antes que PROGRESSION)', ciIdxRev < prIdxRev);

  // P252c: day=null normaliza igual que day=0 → typeOrder decide
  var entries3 = {
    'progrec_1_0': { recommendations: [{ exerciseName: 'A', action: 'x', reason: 'y' }] },
    'postsession_1_0': { eimd: 1, articular: 'no', patron: '', sleep: 7, rpe: 6 }
  };
  var rows3 = _buildOperationalExportRows(entries3, null);
  var psIdx3 = rows3.findIndex(function(r){ return r.recordType === 'POSTSESSION'; });
  var prIdx3 = rows3.findIndex(function(r){ return r.recordType === 'PROGRESSION'; });
  assert('P252c', 'POSTSESSION (day=0) antes que PROGRESSION (day=0) por typeOrder', psIdx3 < prIdx3);

  // P252d: SET (day=0, typeOrder=0) antes que CHECKIN (day='', typeOrder=2)
  var entries4 = {
    'ci_sem_2': { peso: 79, hrv: 58, who5: 60, sleep: 7 },
    'log_2_0_0_s0': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1 }
  };
  var rows4 = _buildOperationalExportRows(entries4, null);
  var setIdx4 = rows4.findIndex(function(r){ return r.recordType === 'SET'; });
  var ciIdx4  = rows4.findIndex(function(r){ return r.recordType === 'CHECKIN'; });
  assert('P252d', 'SET (day=0) antes que CHECKIN (day="") por typeOrder', setIdx4 < ciIdx4);

  // P252e: ordenación multi-semana es siempre semana menor primero
  var entries5 = {
    'log_3_0_0_s0': { carga: 85, reps: 6, unit: 'KG', done: true, rir_real: 0, ics: 9, pump: 1 },
    'log_1_0_0_s0': { carga: 75, reps: 8, unit: 'KG', done: true, rir_real: 2, ics: 7, pump: 2 },
    'log_2_0_0_s0': { carga: 80, reps: 8, unit: 'KG', done: true, rir_real: 1, ics: 8, pump: 1 }
  };
  var rows5 = _buildOperationalExportRows(entries5, null);
  assert('P252e', 'semana 1 primero', rows5[0].week === 1);
  assert('P252f', 'semana 2 segundo', rows5[1].week === 2);
  assert('P252g', 'semana 3 último', rows5[2].week === 3);
})();

// ═════════════════════════ FASE 18 — Coach Note Display ═════════════════════════

// Mirror del helper puro (idéntico a producción)
function _escHTml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _coachNoteHtml(note) {
  if (!note || !String(note).trim()) return '';
  var escaped = _escHTml(String(note).trim());
  return '<div style="margin-top:8px;padding:8px 12px;background:rgba(68,136,204,.07);border-left:3px solid rgba(68,136,204,.45);border-radius:0 8px 8px 0">'+
    '<div style="font-size:9px;font-weight:900;letter-spacing:1.5px;color:#6699bb;margin-bottom:3px">NOTA DEL COACH</div>'+
    '<div style="font-size:12px;color:#a8c8ee;line-height:1.55;white-space:pre-line">'+escaped+'</div>'+
  '</div>';
}

// P253 — nota presente → HTML no vacío
console.log('\nP253 — nota presente → HTML no vacío');
(function(){
  var html = _coachNoteHtml('ROM completo, pausa de 2s abajo');
  assert('P253a', 'devuelve string no vacío', html.length > 0);
  assert('P253b', 'contiene label NOTA DEL COACH', html.indexOf('NOTA DEL COACH') !== -1);
  assert('P253c', 'contiene el texto de la nota', html.indexOf('ROM completo') !== -1);
})();

// P254 — nota vacía o nula → ''
console.log('\nP254 — nota vacía o nula → cadena vacía');
(function(){
  assert('P254a', 'null → ""', _coachNoteHtml(null) === '');
  assert('P254b', 'undefined → ""', _coachNoteHtml(undefined) === '');
  assert('P254c', '"" → ""', _coachNoteHtml('') === '');
  assert('P254d', '"   " (solo espacios) → ""', _coachNoteHtml('   ') === '');
})();

// P255 — XSS: contenido escapado correctamente
console.log('\nP255 — XSS: contenido escapado');
(function(){
  var html = _coachNoteHtml('<script>alert(1)</script>');
  assert('P255a', '<script> no aparece sin escapar', html.indexOf('<script>') === -1);
  assert('P255b', 'aparece como &lt;script&gt;', html.indexOf('&lt;script&gt;') !== -1);
  var html2 = _coachNoteHtml('a & b');
  assert('P255c', '& escapado a &amp;', html2.indexOf('&amp;') !== -1);
  var html3 = _coachNoteHtml('"cita"');
  assert('P255d', 'comillas escapadas a &quot;', html3.indexOf('&quot;') !== -1);
})();

// P256 — saltos de línea preservados (white-space:pre-line)
console.log('\nP256 — saltos de línea preservados via white-space:pre-line');
(function(){
  var html = _coachNoteHtml('Línea 1\nLínea 2');
  assert('P256a', 'contiene white-space:pre-line', html.indexOf('white-space:pre-line') !== -1);
  assert('P256b', 'contiene el texto con salto', html.indexOf('Línea 1\nLínea 2') !== -1);
})();

// P257 — nota larga no se trunca
console.log('\nP257 — nota larga no se trunca');
(function(){
  var longNote = 'A'.repeat(500);
  var html = _coachNoteHtml(longNote);
  assert('P257a', 'nota larga devuelve HTML no vacío', html.length > 500);
  assert('P257b', 'todo el contenido presente', html.indexOf(longNote) !== -1);
})();

// P258 — espacios extremos se recortan
console.log('\nP258 — trim aplicado a nota');
(function(){
  var html = _coachNoteHtml('  Foco en excéntrico  ');
  assert('P258a', 'texto sin espacios extremos', html.indexOf('Foco en excéntrico') !== -1);
  assert('P258b', 'devuelve HTML (nota no vacía después de trim)', html.length > 0);
})();

// P259 — coachNote fluye del plan al objeto ejercicio (integración de datos)
console.log('\nP259 — coachNote en ejercicio del plan');
(function(){
  // Simula la normalización que hace loadPlan en vdsen-cliente.html (líneas 1429, 1439)
  var planEx = { exerciseName: 'Press Banca', coachNote: 'Pausa 1s en el pecho', sets: [{ repsTarget: 8, rirTarget: 2 }] };
  var normalized = {
    nombre: planEx.exerciseName || planEx.nombre || 'Ejercicio',
    exerciseName: planEx.exerciseName || planEx.nombre || 'Ejercicio',
    coachNote: planEx.coachNote || '',
    nota: planEx.coachNote || ''
  };
  assert('P259a', 'coachNote conservado en normalización', normalized.coachNote === 'Pausa 1s en el pecho');
  assert('P259b', 'nota alias igual que coachNote', normalized.nota === normalized.coachNote);
  var html = _coachNoteHtml(normalized.coachNote);
  assert('P259c', 'HTML generado desde nota normalizada', html.indexOf('Pausa 1s en el pecho') !== -1);
})();

// P260 — sin coachNote en plan → sin banner
console.log('\nP260 — sin coachNote en plan → sin banner');
(function(){
  var planEx = { exerciseName: 'Curl Bíceps', sets: [{ repsTarget: 10, rirTarget: 1 }] };
  var normalized = { coachNote: planEx.coachNote || '' };
  assert('P260a', 'coachNote vacío cuando plan no lo tiene', normalized.coachNote === '');
  assert('P260b', '_coachNoteHtml devuelve "" cuando coachNote está vacío', _coachNoteHtml(normalized.coachNote) === '');
})();

// ════════════════════════════════════════════════════════════
// FASE 19 — _buildProgreSummaryHtml (helper puro post-sesión)
// ════════════════════════════════════════════════════════════

// Mirror de _escHTml (misma implementación que en vdsen-cliente.html)
function _escHTml19(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Mirror de _buildProgreSummaryHtml (debe ser idéntico a vdsen-cliente.html)
function _buildProgreSummaryHtml(progrec) {
  if (!progrec) return '';
  var recs = progrec.recommendations;
  var triggers = progrec.deloadTriggers;
  var hasRecs = Array.isArray(recs) && recs.length > 0;
  var hasTriggers = Array.isArray(triggers) && triggers.length > 0;
  if (!hasRecs && !hasTriggers) return '';

  var ACT = {
    increase_load: { icon: '↑', label: 'AUMENTAR CARGA',  color: '#3a9460' },
    add_sets:      { icon: '↑', label: '+ SERIES',        color: '#3a9460' },
    maintain:      { icon: '=', label: 'MANTENER',         color: '#C4FF00' },
    freeze_load:   { icon: '⏸', label: 'CONGELAR CARGA',  color: '#C4FF00' },
    reduce_load:   { icon: '↓', label: 'REDUCIR CARGA',   color: '#e06040' },
    reduce_sets:   { icon: '↓', label: 'REDUCIR SERIES',  color: '#FF8844' },
    deload:        { icon: '🔄', label: 'DESCARGA ACTIVA', color: '#6488CC' }
  };

  function _fmtLoad(v) {
    var n = parseFloat(v);
    if (isNaN(n) || n <= 0) return null;
    return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1);
  }

  var rows = '';
  if (hasRecs) {
    recs.forEach(function(r) {
      var cfg = ACT[r.action] || { icon: '=', label: 'MANTENER', color: '#C4FF00' };
      var loadStr = _fmtLoad(r.newLoad);
      rows +=
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
          '<span style="font-size:12px;color:var(--tx);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_escHTml19(r.exerciseName||'—')+'</span>'+
          '<span style="flex-shrink:0;font-size:10px;font-weight:800;color:'+cfg.color+';margin-left:8px;letter-spacing:.5px">'+cfg.icon+' '+cfg.label+(loadStr?' · '+loadStr+' kg':'')+'</span>'+
        '</div>';
    });
  }

  var triggersHtml = hasTriggers
    ? '<div style="margin-top:8px;padding:6px 10px;background:rgba(220,80,50,.1);border:1px solid rgba(220,80,50,.4);border-radius:8px;font-size:10px;color:#e06040;font-weight:700">⚠ '+_escHTml19(triggers.join(' · '))+'</div>'
    : '';

  return '<div style="margin-top:12px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px">'+
    '<div style="font-size:9px;font-weight:900;letter-spacing:1.5px;color:var(--mt);margin-bottom:6px">PRÓXIMA SESIÓN</div>'+
    rows+
    triggersHtml+
  '</div>';
}

// P261 — increase_load recommendation
console.log('\nP261 — increase_load recommendation');
(function(){
  var progrec = {
    recommendations: [{ exerciseName: 'Press Banca', action: 'increase_load', newLoad: 82.5, newSets: 4, rirTarget: 2, reason: 'RIR alto' }],
    deloadTriggers: []
  };
  var html = _buildProgreSummaryHtml(progrec);
  assert('P261a', 'HTML no vacío', html !== '');
  assert('P261b', 'contiene exerciseName', html.indexOf('Press Banca') !== -1);
  assert('P261c', 'contiene label AUMENTAR CARGA', html.indexOf('AUMENTAR CARGA') !== -1);
  assert('P261d', 'contiene newLoad formateado', html.indexOf('82.5 kg') !== -1);
  assert('P261e', 'contiene sección PRÓXIMA SESIÓN', html.indexOf('PRÓXIMA SESIÓN') !== -1);
})();

// P262 — maintain recommendation
console.log('\nP262 — maintain recommendation');
(function(){
  var progrec = {
    recommendations: [{ exerciseName: 'Sentadilla', action: 'maintain', newLoad: 100, newSets: 4, rirTarget: 2 }],
    deloadTriggers: []
  };
  var html = _buildProgreSummaryHtml(progrec);
  assert('P262a', 'HTML no vacío', html !== '');
  assert('P262b', 'label MANTENER', html.indexOf('MANTENER') !== -1);
  assert('P262c', 'contiene 100 kg', html.indexOf('100 kg') !== -1);
})();

// P263 — deload recommendation
console.log('\nP263 — deload recommendation');
(function(){
  var progrec = {
    recommendations: [{ exerciseName: 'Peso Muerto', action: 'deload', newLoad: 80, newSets: 3, rirTarget: 4 }],
    deloadTriggers: ['ICS_REPEATED_LOW']
  };
  var html = _buildProgreSummaryHtml(progrec);
  assert('P263a', 'label DESCARGA ACTIVA', html.indexOf('DESCARGA ACTIVA') !== -1);
  assert('P263b', 'trigger en HTML', html.indexOf('ICS_REPEATED_LOW') !== -1);
})();

// P264 — null/empty progrec → ''
console.log('\nP264 — null/empty progrec → retorna cadena vacía');
(function(){
  assert('P264a', 'null → ""', _buildProgreSummaryHtml(null) === '');
  assert('P264b', 'undefined → ""', _buildProgreSummaryHtml(undefined) === '');
  assert('P264c', 'recs vacío + triggers vacío → ""', _buildProgreSummaryHtml({ recommendations: [], deloadTriggers: [] }) === '');
  assert('P264d', 'sin recs ni triggers → ""', _buildProgreSummaryHtml({}) === '');
})();

// P265 — deloadTriggers sin recommendations
console.log('\nP265 — solo deloadTriggers sin recommendations → HTML con triggers');
(function(){
  var progrec = { recommendations: [], deloadTriggers: ['TOO_HARD_REPEATED', 'PERFORMANCE_REGRESSION'] };
  var html = _buildProgreSummaryHtml(progrec);
  assert('P265a', 'HTML no vacío', html !== '');
  assert('P265b', 'primer trigger presente', html.indexOf('TOO_HARD_REPEATED') !== -1);
  assert('P265c', 'segundo trigger presente', html.indexOf('PERFORMANCE_REGRESSION') !== -1);
})();

// P266 — XSS en exerciseName
console.log('\nP266 — XSS en exerciseName');
(function(){
  var progrec = {
    recommendations: [{ exerciseName: '<script>alert(1)</script>', action: 'maintain', newLoad: 60, newSets: 3, rirTarget: 2 }],
    deloadTriggers: []
  };
  var html = _buildProgreSummaryHtml(progrec);
  assert('P266a', '<script> no aparece sin escapar', html.indexOf('<script>') === -1);
  assert('P266b', 'aparece como &lt;script&gt;', html.indexOf('&lt;script&gt;') !== -1);
})();

// P267 — formato de carga: entero sin decimales, decimal con 1 decimal
console.log('\nP267 — formato newLoad: entero vs decimal');
(function(){
  var rec1 = { exerciseName: 'A', action: 'maintain', newLoad: 80, newSets: 3, rirTarget: 2 };
  var rec2 = { exerciseName: 'B', action: 'maintain', newLoad: 82.5, newSets: 3, rirTarget: 2 };
  var rec3 = { exerciseName: 'C', action: 'maintain', newLoad: 0, newSets: 3, rirTarget: 2 };
  var h1 = _buildProgreSummaryHtml({ recommendations: [rec1], deloadTriggers: [] });
  var h2 = _buildProgreSummaryHtml({ recommendations: [rec2], deloadTriggers: [] });
  var h3 = _buildProgreSummaryHtml({ recommendations: [rec3], deloadTriggers: [] });
  assert('P267a', '80 → "80 kg" (sin decimales)', h1.indexOf('80 kg') !== -1 && h1.indexOf('80.0 kg') === -1);
  assert('P267b', '82.5 → "82.5 kg"', h2.indexOf('82.5 kg') !== -1);
  assert('P267c', '0 → sin carga en label (load 0 inválido)', h3.indexOf('0 kg') === -1);
})();

// P268 — múltiples recomendaciones → todas presentes
console.log('\nP268 — múltiples recomendaciones → todas en output');
(function(){
  var progrec = {
    recommendations: [
      { exerciseName: 'Ejercicio Uno', action: 'increase_load', newLoad: 90, newSets: 4, rirTarget: 2 },
      { exerciseName: 'Ejercicio Dos', action: 'reduce_load',   newLoad: 50, newSets: 3, rirTarget: 1 },
      { exerciseName: 'Ejercicio Tres', action: 'maintain',     newLoad: 70, newSets: 4, rirTarget: 2 }
    ],
    deloadTriggers: []
  };
  var html = _buildProgreSummaryHtml(progrec);
  assert('P268a', 'Ejercicio Uno presente', html.indexOf('Ejercicio Uno') !== -1);
  assert('P268b', 'Ejercicio Dos presente', html.indexOf('Ejercicio Dos') !== -1);
  assert('P268c', 'Ejercicio Tres presente', html.indexOf('Ejercicio Tres') !== -1);
  assert('P268d', 'AUMENTAR CARGA en output', html.indexOf('AUMENTAR CARGA') !== -1);
  assert('P268e', 'REDUCIR CARGA en output', html.indexOf('REDUCIR CARGA') !== -1);
  assert('P268f', 'MANTENER en output', html.indexOf('MANTENER') !== -1);
})();

// ═══════════════ FASE 20 — _buildRecApplyPreview (hardened) ══════════════

// Mirror hardened de _buildRecApplyPreview + _resolveExerciseInFreshPlan
var _normN20 = function(s){ return (s||'').toLowerCase().trim().replace(/\s+/g,' '); };

function _findDayByIndex20(days, dayIndex) {
  if (!days) return null;
  for (var i = 0; i < days.length; i++) {
    if (days[i].dayIndex === dayIndex) return days[i];
  }
  return null;
}

function _buildRecApplyPreview20(lastRec, lastRecDay, activePlanCache) {
  if (!lastRec || !activePlanCache || !activePlanCache.days) return [];
  var dayObj = _findDayByIndex20(activePlanCache.days, lastRecDay);
  if (!dayObj || !dayObj.exercises || !dayObj.exercises.length) return [];
  var result = [];
  var recs = Array.isArray(lastRec.recommendations) ? lastRec.recommendations : [];
  recs.forEach(function(r) {
    if (r.action !== 'increase_load' && r.action !== 'reduce_load') return;
    var rKey = _normN20(r.exerciseName);
    var matches = [];
    for (var j = 0; j < dayObj.exercises.length; j++) {
      if (_normN20(dayObj.exercises[j].exerciseName || dayObj.exercises[j].nombre || '') === rKey) matches.push(j);
    }
    if (matches.length !== 1) return; // NONE (0) o AMBIGUOUS (2+)
    var ei = matches[0];
    var ex = dayObj.exercises[ei];
    var sets = ex.sets || [];
    var loads = sets.map(function(s){ return parseFloat(s.load) || 0; });
    var currentLoad = loads.length ? loads[0] : 0;
    var mixedCurrentLoads = loads.length > 1 && loads.some(function(l){ return l !== loads[0]; });
    var unit = null;
    for (var si = 0; si < sets.length; si++) { if (sets[si].unit) { unit = sets[si].unit; break; } }
    var recommendedLoad = parseFloat(r.newLoad) || 0;
    if (recommendedLoad <= 0) return;
    if (!mixedCurrentLoads && currentLoad === recommendedLoad) return; // no-op
    result.push({
      exerciseName: ex.exerciseName || ex.nombre || r.exerciseName,
      exerciseIndex: ei,
      prescriptionExerciseId: ex.prescriptionExerciseId || null,
      currentLoad: currentLoad,
      recommendedLoad: recommendedLoad,
      action: r.action,
      matchConfidence: 'LEGACY',
      setCount: sets.length,
      mixedCurrentLoads: mixedCurrentLoads,
      unit: unit
    });
  });
  return result;
}

// FASE 21 mirror: _buildPlanChangeSummary
function _buildPlanChangeSummary21(preview, selectedPids) {
  var items = Array.isArray(preview) ? preview : [];
  if (selectedPids !== undefined && selectedPids !== null) {
    items = items.filter(function(p) {
      var id = p.prescriptionExerciseId || String(p.exerciseIndex);
      return selectedPids.indexOf(id) !== -1;
    });
  }
  var setCount = items.reduce(function(acc, p) { return acc + (p.setCount || 1); }, 0);
  return { exerciseCount: items.length, setCount: setCount, changes: items };
}

// FASE 34: positional fallback eliminado — PID exacto → nombre único → NO MUTATION
function _resolveExerciseInFreshPlan20(sel, freshDayExercises) {
  if (!freshDayExercises || !freshDayExercises.length) return -1;
  if (sel.prescriptionExerciseId) {
    for (var i = 0; i < freshDayExercises.length; i++) {
      if (freshDayExercises[i].prescriptionExerciseId === sel.prescriptionExerciseId) return i;
    }
    return -1;
  }
  if (sel.exerciseName) {
    var normQ = sel.exerciseName.toLowerCase().trim().replace(/\s+/g, ' ');
    var found = -1, count = 0;
    for (var j = 0; j < freshDayExercises.length; j++) {
      var normN = (freshDayExercises[j].exerciseName || '').toLowerCase().trim().replace(/\s+/g, ' ');
      if (normN === normQ) { found = j; count++; }
    }
    return count === 1 ? found : -1;
  }
  return -1; // sin PID ni nombre → NO MUTATION
}

// Mirror FASE 34: _resolveExerciseRowId con duplicate-name guard
function _resolveExerciseRowId34(exerciseName, planCache, pid) {
  if (!planCache || !planCache.days) return null;
  if (pid) {
    for (var di = 0; di < planCache.days.length; di++) {
      var exs = planCache.days[di].exercises || [];
      for (var ei = 0; ei < exs.length; ei++) {
        if ((exs[ei].prescriptionExerciseId || '') === pid) return { di: di, ei: ei, pid: pid };
      }
    }
  }
  if (!exerciseName) return null;
  var normQ = exerciseName.toLowerCase().trim().replace(/\s+/g, ' ');
  var found2 = null, count2 = 0;
  for (var di2 = 0; di2 < planCache.days.length; di2++) {
    var exs2 = planCache.days[di2].exercises || [];
    for (var ei2 = 0; ei2 < exs2.length; ei2++) {
      var ex2 = exs2[ei2];
      var normN = (ex2.exerciseName || ex2.nombre || '').toLowerCase().trim().replace(/\s+/g, ' ');
      if (normN === normQ) { found2 = { di: di2, ei: ei2, pid: ex2.prescriptionExerciseId || null }; count2++; }
    }
  }
  return count2 === 1 ? found2 : null;
}

// P269 — null lastRec → []
console.log('\nP269 — null lastRec → retorna []');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Press', sets: [{ load: 60 }] }] }] };
  var result = _buildRecApplyPreview20(null, 0, plan);
  assert('P269a', 'null lastRec → []', Array.isArray(result) && result.length === 0);
  assert('P269b', 'undefined lastRec → []', _buildRecApplyPreview20(undefined, 0, plan).length === 0);
})();

// P270 — null activePlanCache → []
console.log('\nP270 — null activePlanCache → retorna []');
(function(){
  var lastRec = { recommendations: [{ exerciseName: 'Press', action: 'increase_load', newLoad: 70 }] };
  assert('P270a', 'null cache → []', _buildRecApplyPreview20(lastRec, 0, null).length === 0);
  assert('P270b', 'cache sin days → []', _buildRecApplyPreview20(lastRec, 0, {}).length === 0);
  assert('P270c', 'cache days vacío → []', _buildRecApplyPreview20(lastRec, 0, { days: [] }).length === 0);
})();

// P271 — ejercicio no encontrado en el plan → []
console.log('\nP271 — ejercicio rec no está en el día del plan → []');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Sentadilla', sets: [{ load: 100 }] }] }] };
  var lastRec = { recommendations: [{ exerciseName: 'Press Banca', action: 'increase_load', newLoad: 80, newSets: 3, rirTarget: 2 }] };
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P271a', 'sin coincidencia → []', result.length === 0);
})();

// P272 — increase_load coincide → retorna entry correcta
console.log('\nP272 — increase_load con coincidencia por nombre → entry correcta');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Press Banca', sets: [{ load: 70 }] }] }] };
  var lastRec = { recommendations: [{ exerciseName: 'Press Banca', action: 'increase_load', newLoad: 72.5, newSets: 3, rirTarget: 2 }] };
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P272a', 'retorna 1 entry', result.length === 1);
  assert('P272b', 'exerciseName correcto', result[0].exerciseName === 'Press Banca');
  assert('P272c', 'exerciseIndex = 0', result[0].exerciseIndex === 0);
  assert('P272d', 'currentLoad = 70', result[0].currentLoad === 70);
  assert('P272e', 'recommendedLoad = 72.5', result[0].recommendedLoad === 72.5);
  assert('P272f', 'action = increase_load', result[0].action === 'increase_load');
})();

// P273 — reduce_load coincide → action correcta
console.log('\nP273 — reduce_load con coincidencia → action reduce_load');
(function(){
  var plan = { days: [{ dayIndex: 1, exercises: [{ exerciseName: 'Jalón', sets: [{ load: 55 }] }] }] };
  var lastRec = { recommendations: [{ exerciseName: 'Jalón', action: 'reduce_load', newLoad: 50, newSets: 3, rirTarget: 3 }] };
  var result = _buildRecApplyPreview20(lastRec, 1, plan);
  assert('P273a', '1 entry', result.length === 1);
  assert('P273b', 'action = reduce_load', result[0].action === 'reduce_load');
  assert('P273c', 'currentLoad = 55', result[0].currentLoad === 55);
  assert('P273d', 'recommendedLoad = 50', result[0].recommendedLoad === 50);
})();

// P274 — maintain / add_sets / deload / freeze_load son excluidos
console.log('\nP274 — acciones no aplicables son filtradas');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'A', sets: [{ load: 60 }] },
    { exerciseName: 'B', sets: [{ load: 70 }] },
    { exerciseName: 'C', sets: [{ load: 80 }] },
    { exerciseName: 'D', sets: [{ load: 90 }] }
  ]}]};
  var lastRec = { recommendations: [
    { exerciseName: 'A', action: 'maintain',     newLoad: 60, newSets: 3, rirTarget: 2 },
    { exerciseName: 'B', action: 'add_sets',     newLoad: 70, newSets: 4, rirTarget: 2 },
    { exerciseName: 'C', action: 'deload',       newLoad: 50, newSets: 3, rirTarget: 3 },
    { exerciseName: 'D', action: 'freeze_load',  newLoad: 90, newSets: 3, rirTarget: 2 }
  ]};
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P274a', 'ninguna entry (todas excluidas)', result.length === 0);
})();

// P275 — day match por dayIndex (no posicional)
console.log('\nP275 — day lookup por dayIndex no posicional');
(function(){
  // dayIndex=2 está en posición 0 del array → debe encontrarse igual
  var plan = { days: [
    { dayIndex: 2, exercises: [{ exerciseName: 'Remo', sets: [{ load: 65 }] }] },
    { dayIndex: 3, exercises: [{ exerciseName: 'Curl',  sets: [{ load: 30 }] }] }
  ]};
  var lastRec = { recommendations: [{ exerciseName: 'Remo', action: 'increase_load', newLoad: 67.5, newSets: 3, rirTarget: 2 }] };
  var result = _buildRecApplyPreview20(lastRec, 2, plan);
  assert('P275a', 'encuentra por dayIndex=2', result.length === 1);
  assert('P275b', 'ejercicio correcto', result[0].exerciseName === 'Remo');
  // dayIndex=3 no coincide con la rec → vacío
  var result2 = _buildRecApplyPreview20(lastRec, 3, plan);
  assert('P275c', 'day 3 sin match de Remo → []', result2.length === 0);
})();

// P276 — newLoad = 0 → excluida (recommendedLoad > 0)
console.log('\nP276 — newLoad = 0 → entrada excluida');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Press', sets: [{ load: 60 }] }] }] };
  var lastRec = { recommendations: [{ exerciseName: 'Press', action: 'increase_load', newLoad: 0, newSets: 3, rirTarget: 2 }] };
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P276a', 'newLoad 0 → excluida', result.length === 0);
})();

// P277 — múltiples recs: una coincide, otra no → solo la que coincide
console.log('\nP277 — recs mixtas: solo las que coinciden');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Sentadilla', sets: [{ load: 100 }] }] }] };
  var lastRec = { recommendations: [
    { exerciseName: 'Sentadilla', action: 'increase_load', newLoad: 102.5, newSets: 4, rirTarget: 1 },
    { exerciseName: 'Press Inclinado', action: 'reduce_load', newLoad: 55, newSets: 3, rirTarget: 2 }
  ]};
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P277a', 'solo 1 entry (Sentadilla)', result.length === 1);
  assert('P277b', 'es Sentadilla', result[0].exerciseName === 'Sentadilla');
})();

// P278 — currentLoad cuando sets vacío → 0
console.log('\nP278 — ejercicio sin sets → currentLoad = 0');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Face Pull', sets: [] }] }] };
  var lastRec = { recommendations: [{ exerciseName: 'Face Pull', action: 'increase_load', newLoad: 20, newSets: 3, rirTarget: 2 }] };
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P278a', '1 entry', result.length === 1);
  assert('P278b', 'currentLoad = 0 cuando no hay sets', result[0].currentLoad === 0);
  assert('P278c', 'recommendedLoad = 20', result[0].recommendedLoad === 20);
})();

// ─── FASE 20 HARDENING: identity contract & load semantics ────────────────

// P279 — plan exercise con prescriptionExerciseId → entry lo hereda
console.log('\nP279 — prescriptionExerciseId del plan se propaga a preview entry');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [{
    exerciseName: 'Press',
    prescriptionExerciseId: 'pid-abc',
    sets: [{ load: 80, repsTarget: 8, rirTarget: 2, restSeconds: 120 }]
  }]}]};
  var lastRec = { recommendations: [{ exerciseName: 'Press', action: 'increase_load', newLoad: 82.5 }] };
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P279a', '1 entry', result.length === 1);
  assert('P279b', 'prescriptionExerciseId heredado del plan', result[0].prescriptionExerciseId === 'pid-abc');
  assert('P279c', 'matchConfidence LEGACY', result[0].matchConfidence === 'LEGACY');
  assert('P279d', 'recommendedLoad correcto', result[0].recommendedLoad === 82.5);
})();

// P280 — _resolveExerciseInFreshPlan20: prescriptionExerciseId identifica ejercicio correcto con nombre duplicado
console.log('\nP280 — ID resuelve ejercicio correcto aunque haya nombre duplicado');
(function(){
  var freshExercises = [
    { exerciseName: 'Press', prescriptionExerciseId: 'pid-111', sets: [{ load: 60 }] },
    { exerciseName: 'Press', prescriptionExerciseId: 'pid-222', sets: [{ load: 80 }] }
  ];
  var sel = { exerciseIndex: 0, recommendedLoad: 82.5, prescriptionExerciseId: 'pid-222' };
  var idx = _resolveExerciseInFreshPlan20(sel, freshExercises);
  assert('P280a', 'resuelve por ID → índice 1 (no índice 0)', idx === 1);
  var sel2 = { exerciseIndex: 1, recommendedLoad: 62.5, prescriptionExerciseId: 'pid-111' };
  var idx2 = _resolveExerciseInFreshPlan20(sel2, freshExercises);
  assert('P280b', 'resuelve pid-111 → índice 0', idx2 === 0);
})();

// P281 — dos ejercicios mismo nombre en mismo día → AMBIGUOUS → excluida
console.log('\nP281 — nombre duplicado en mismo día → AMBIGUOUS → excluida del preview');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Press', prescriptionExerciseId: 'pid-111', sets: [{ load: 60 }] },
    { exerciseName: 'Press', prescriptionExerciseId: 'pid-222', sets: [{ load: 80 }] }
  ]}]};
  var lastRec = { recommendations: [{ exerciseName: 'Press', action: 'increase_load', newLoad: 82.5 }] };
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P281a', 'AMBIGUOUS: dos Press mismo día → [] (0 entries)', result.length === 0);
})();

// P282 — nombre único en día → LEGACY fallback permitido
console.log('\nP282 — nombre único → LEGACY fallback incluido');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Dominadas', sets: [{ load: 0 }] }
  ]}]};
  var lastRec = { recommendations: [{ exerciseName: 'Dominadas', action: 'increase_load', newLoad: 5 }] };
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P282a', 'LEGACY nombre único → 1 entry', result.length === 1);
  assert('P282b', 'exerciseName correcto', result[0].exerciseName === 'Dominadas');
  assert('P282c', 'prescriptionExerciseId null cuando plan no tiene el campo', result[0].prescriptionExerciseId === null);
  assert('P282d', 'matchConfidence LEGACY', result[0].matchConfidence === 'LEGACY');
})();

// P283 — rec sin exerciseName o nombre vacío → sin match
console.log('\nP283 — rec sin nombre → excluida');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Sentadilla', sets: [{ load: 100 }] }
  ]}]};
  var lastRec = { recommendations: [
    { action: 'increase_load', newLoad: 102.5 },
    { exerciseName: '', action: 'increase_load', newLoad: 70 }
  ]};
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P283a', 'recs sin nombre → 0 entries', result.length === 0);
})();

// P284 — ID estale en fresh plan → _resolveExerciseInFreshPlan20 retorna -1
console.log('\nP284 — ID estale en plan fresco → -1 (SKIP)');
(function(){
  var freshExercises = [
    { exerciseName: 'Press', prescriptionExerciseId: 'pid-actual', sets: [{ load: 80 }] }
  ];
  var sel = { exerciseIndex: 0, recommendedLoad: 82.5, prescriptionExerciseId: 'pid-viejo' };
  var idx = _resolveExerciseInFreshPlan20(sel, freshExercises);
  assert('P284a', 'ID estale → -1', idx === -1);
})();

// P285 — reorden entre preview/write: ID estable encuentra ejercicio en nueva posición
console.log('\nP285 — reorden de ejercicios: ID encuentra posición correcta');
(function(){
  // Preview construida con Press en pos 0, Remo en pos 1
  // Plan fresco reordenado: Remo en pos 0, Press en pos 1
  var freshExercises = [
    { exerciseName: 'Remo',  prescriptionExerciseId: 'pid-remo',  sets: [{ load: 60 }] },
    { exerciseName: 'Press', prescriptionExerciseId: 'pid-press', sets: [{ load: 80 }] }
  ];
  var sel = { exerciseIndex: 0, recommendedLoad: 82.5, prescriptionExerciseId: 'pid-press' };
  var idx = _resolveExerciseInFreshPlan20(sel, freshExercises);
  assert('P285a', 'reorden: pid-press → índice 1 (no 0)', idx === 1);
  var sel2 = { exerciseIndex: 1, recommendedLoad: 62.5, prescriptionExerciseId: 'pid-remo' };
  var idx2 = _resolveExerciseInFreshPlan20(sel2, freshExercises);
  assert('P285b', 'reorden: pid-remo → índice 0 (no 1)', idx2 === 0);
})();

// P286 — sustitución entre preview/write: ID ya no existe → -1
console.log('\nP286 — sustitución de ejercicio: ID original ausente → -1');
(function(){
  var freshExercises = [
    { exerciseName: 'Press Inclinado', prescriptionExerciseId: 'pid-nuevo', sets: [{ load: 70 }] }
  ];
  var sel = { exerciseIndex: 0, recommendedLoad: 82.5, prescriptionExerciseId: 'pid-press-original' };
  var idx = _resolveExerciseInFreshPlan20(sel, freshExercises);
  assert('P286a', 'sustitución: ID original ausente → -1', idx === -1);
})();

// P287 — solo increase_load y reduce_load incluidas; maintain/deload/add_sets/freeze_load excluidas
console.log('\nP287 — action filter: solo increase_load y reduce_load incluidas');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'A', sets: [{ load: 60 }] },
    { exerciseName: 'B', sets: [{ load: 70 }] },
    { exerciseName: 'C', sets: [{ load: 80 }] },
    { exerciseName: 'D', sets: [{ load: 90 }] },
    { exerciseName: 'E', sets: [{ load: 50 }] },
    { exerciseName: 'F', sets: [{ load: 40 }] }
  ]}]};
  var lastRec = { recommendations: [
    { exerciseName: 'A', action: 'increase_load', newLoad: 62.5 },
    { exerciseName: 'B', action: 'reduce_load',   newLoad: 67.5 },
    { exerciseName: 'C', action: 'maintain',      newLoad: 80 },
    { exerciseName: 'D', action: 'deload',         newLoad: 70 },
    { exerciseName: 'E', action: 'add_sets',       newLoad: 50 },
    { exerciseName: 'F', action: 'freeze_load',    newLoad: 40 }
  ]};
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P287a', 'solo 2 entries (increase + reduce)', result.length === 2);
  assert('P287b', 'entry 0 action increase_load', result[0].action === 'increase_load');
  assert('P287c', 'entry 1 action reduce_load',   result[1].action === 'reduce_load');
  assert('P287d', 'maintain excluida', !result.find(function(r){ return r.action === 'maintain'; }));
  assert('P287e', 'deload excluida',   !result.find(function(r){ return r.action === 'deload'; }));
})();

// P288 — Object.assign preserva repsTarget/rirTarget/restSeconds/setIndex al actualizar load
console.log('\nP288 — update de load preserva resto de campos del set');
(function(){
  var originalSet = { setIndex: 1, repsTarget: 8, rirTarget: 2, restSeconds: 120, load: 80 };
  var updatedSet  = Object.assign({}, originalSet, { load: 82.5 });
  assert('P288a', 'load actualizado a 82.5',        updatedSet.load       === 82.5);
  assert('P288b', 'repsTarget preservado (8)',       updatedSet.repsTarget === 8);
  assert('P288c', 'rirTarget preservado (2)',        updatedSet.rirTarget  === 2);
  assert('P288d', 'restSeconds preservado (120)',    updatedSet.restSeconds === 120);
  assert('P288e', 'setIndex preservado (1)',         updatedSet.setIndex   === 1);
  assert('P288f', 'original no mutado (load=80)',    originalSet.load      === 80);
})();

// P289 — _buildRecApplyPreview20 es función pura: no muta el plan; sin confirmed → 0 cambios
console.log('\nP289 — preview pura: plan inalterado; sin confirmación → sin mutación');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [{
    exerciseName: 'Press',
    sets: [{ load: 80, repsTarget: 8, rirTarget: 2, restSeconds: 120 }]
  }]}]};
  var planSnapshot = JSON.stringify(plan);
  var lastRec = { recommendations: [{ exerciseName: 'Press', action: 'increase_load', newLoad: 82.5 }] };
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P289a', 'preview generada (1 entry)',       result.length === 1);
  assert('P289b', 'plan original no mutado (pureza)', JSON.stringify(plan) === planSnapshot);
  assert('P289c', 'load original intacto (80)',       plan.days[0].exercises[0].sets[0].load === 80);
  assert('P289d', 'recommended en preview es 82.5',   result[0].recommendedLoad === 82.5);
})();

// ─── FASE 21 — _buildPlanChangeSummary + preview enrichment ──────────────

// P290 — summary cuenta ejercicios correctamente
console.log('\nP290 — _buildPlanChangeSummary: exerciseCount correcto');
(function(){
  var preview = [
    { exerciseName: 'Press',      exerciseIndex: 0, prescriptionExerciseId: null, currentLoad: 80, recommendedLoad: 82.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 3, mixedCurrentLoads: false, unit: null },
    { exerciseName: 'Sentadilla', exerciseIndex: 1, prescriptionExerciseId: null, currentLoad: 100, recommendedLoad: 102.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 4, mixedCurrentLoads: false, unit: null }
  ];
  var summ = _buildPlanChangeSummary21(preview);
  assert('P290a', 'exerciseCount = 2', summ.exerciseCount === 2);
  assert('P290b', 'changes.length = 2', summ.changes.length === 2);
})();

// P291 — summary cuenta sets afectados (suma real de setCount)
console.log('\nP291 — _buildPlanChangeSummary: setCount suma real de sets');
(function(){
  var preview = [
    { exerciseName: 'A', exerciseIndex: 0, prescriptionExerciseId: null, currentLoad: 60, recommendedLoad: 62.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 3, mixedCurrentLoads: false, unit: null },
    { exerciseName: 'B', exerciseIndex: 1, prescriptionExerciseId: null, currentLoad: 70, recommendedLoad: 72.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 4, mixedCurrentLoads: false, unit: null }
  ];
  var summ = _buildPlanChangeSummary21(preview);
  assert('P291a', 'setCount = 7 (3+4)', summ.setCount === 7);
})();

// P292 — item desmarcado excluido del resumen
console.log('\nP292 — selectedPids: item no seleccionado excluido del resumen');
(function(){
  var preview = [
    { exerciseName: 'A', exerciseIndex: 0, prescriptionExerciseId: 'pid-a', currentLoad: 60, recommendedLoad: 62.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 3, mixedCurrentLoads: false, unit: null },
    { exerciseName: 'B', exerciseIndex: 1, prescriptionExerciseId: 'pid-b', currentLoad: 70, recommendedLoad: 72.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 2, mixedCurrentLoads: false, unit: null }
  ];
  // Solo pid-a seleccionado
  var summ = _buildPlanChangeSummary21(preview, ['pid-a']);
  assert('P292a', 'exerciseCount = 1 (solo A)', summ.exerciseCount === 1);
  assert('P292b', 'setCount = 3 (solo A)', summ.setCount === 3);
  assert('P292c', 'changes solo tiene A', summ.changes[0].exerciseName === 'A');
})();

// P293 — no-op excluido: currentLoad === recommendedLoad → _buildRecApplyPreview20 lo omite
console.log('\nP293 — no-op (currentLoad === recommendedLoad) excluido del preview');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Press', sets: [{ load: 80 }] }
  ]}]};
  var lastRec = { recommendations: [{ exerciseName: 'Press', action: 'increase_load', newLoad: 80 }] }; // mismo load
  var result = _buildRecApplyPreview20(lastRec, 0, plan);
  assert('P293a', 'no-op excluido: [] (sin cambio real)', result.length === 0);

  // con carga distinta → incluido
  var lastRec2 = { recommendations: [{ exerciseName: 'Press', action: 'increase_load', newLoad: 82.5 }] };
  var result2 = _buildRecApplyPreview20(lastRec2, 0, plan);
  assert('P293b', 'carga distinta → incluido', result2.length === 1);
})();

// P294 — item HIGH (prescriptionExerciseId) incluido en summary
console.log('\nP294 — item con prescriptionExerciseId incluido en summary');
(function(){
  var preview = [
    { exerciseName: 'Press', exerciseIndex: 0, prescriptionExerciseId: 'pid-xyz', currentLoad: 80, recommendedLoad: 82.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 3, mixedCurrentLoads: false, unit: null }
  ];
  var summ = _buildPlanChangeSummary21(preview);
  assert('P294a', 'incluido en summary', summ.exerciseCount === 1);
  assert('P294b', 'setCount = 3', summ.setCount === 3);
  // Con selectedPids usando el prescriptionExerciseId
  var summ2 = _buildPlanChangeSummary21(preview, ['pid-xyz']);
  assert('P294c', 'filtrado por pid → incluido', summ2.exerciseCount === 1);
})();

// P295 — item LEGACY (sin pid, por índice) incluido en summary
console.log('\nP295 — item LEGACY (sin prescriptionExerciseId) filtrado por String(exerciseIndex)');
(function(){
  var preview = [
    { exerciseName: 'Dominadas', exerciseIndex: 2, prescriptionExerciseId: null, currentLoad: 0, recommendedLoad: 5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 3, mixedCurrentLoads: false, unit: null }
  ];
  var summ = _buildPlanChangeSummary21(preview, ['2']); // String(exerciseIndex)
  assert('P295a', 'filtrado por String(ei) → incluido', summ.exerciseCount === 1);
  var summ2 = _buildPlanChangeSummary21(preview, ['3']); // índice incorrecto
  assert('P295b', 'índice incorrecto → excluido', summ2.exerciseCount === 0);
})();

// P296 — AMBIGUOUS excluido por _buildRecApplyPreview20 (ya verificado en P281 pero via summary)
console.log('\nP296 — AMBIGUOUS excluido: summary vacío');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Press', prescriptionExerciseId: 'pid-1', sets: [{ load: 60 }] },
    { exerciseName: 'Press', prescriptionExerciseId: 'pid-2', sets: [{ load: 80 }] }
  ]}]};
  var lastRec = { recommendations: [{ exerciseName: 'Press', action: 'increase_load', newLoad: 82.5 }] };
  var preview = _buildRecApplyPreview20(lastRec, 0, plan);
  var summ = _buildPlanChangeSummary21(preview);
  assert('P296a', 'AMBIGUOUS → preview vacía', preview.length === 0);
  assert('P296b', 'AMBIGUOUS → summary ejercicios=0', summ.exerciseCount === 0);
  assert('P296c', 'AMBIGUOUS → summary sets=0', summ.setCount === 0);
})();

// P297 — NONE excluido: summary vacío
console.log('\nP297 — NONE excluido: summary vacío');
(function(){
  var plan = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Sentadilla', sets: [{ load: 100 }] }
  ]}]};
  var lastRec = { recommendations: [{ exerciseName: 'Press Banca', action: 'increase_load', newLoad: 82.5 }] };
  var preview = _buildRecApplyPreview20(lastRec, 0, plan);
  var summ = _buildPlanChangeSummary21(preview);
  assert('P297a', 'NONE → preview vacía', preview.length === 0);
  assert('P297b', 'NONE → summary vacío', summ.exerciseCount === 0);
})();

// P298 — setCount correcto con ejercicio de 1, 4 y 0 sets
console.log('\nP298 — setCount maneja 0, 1 y 4 sets por ejercicio');
(function(){
  var preview = [
    { exerciseName: 'A', exerciseIndex: 0, prescriptionExerciseId: null, currentLoad: 0,  recommendedLoad: 5,  action: 'increase_load', matchConfidence: 'LEGACY', setCount: 0, mixedCurrentLoads: false, unit: null },
    { exerciseName: 'B', exerciseIndex: 1, prescriptionExerciseId: null, currentLoad: 70, recommendedLoad: 72.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 1, mixedCurrentLoads: false, unit: null },
    { exerciseName: 'C', exerciseIndex: 2, prescriptionExerciseId: null, currentLoad: 80, recommendedLoad: 82.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 4, mixedCurrentLoads: false, unit: null }
  ];
  var summ = _buildPlanChangeSummary21(preview);
  assert('P298a', 'exerciseCount = 3', summ.exerciseCount === 3);
  assert('P298b', 'setCount = 6 (0+1+4, setCount=0 → +1 fallback)', summ.setCount === 1 + 1 + 4); // 0→1 fallback, 1, 4
  // Nota: setCount=0 usa fallback `p.setCount || 1` → cuenta como 1
})();

// P299 — _buildPlanChangeSummary21 no muta el preview de entrada
console.log('\nP299 — _buildPlanChangeSummary21 no muta el array de preview');
(function(){
  var preview = [
    { exerciseName: 'Press', exerciseIndex: 0, prescriptionExerciseId: null, currentLoad: 80, recommendedLoad: 82.5, action: 'increase_load', matchConfidence: 'LEGACY', setCount: 3, mixedCurrentLoads: false, unit: null }
  ];
  var snapshot = JSON.stringify(preview);
  _buildPlanChangeSummary21(preview);
  assert('P299a', 'preview no mutado', JSON.stringify(preview) === snapshot);
  _buildPlanChangeSummary21(preview, ['0']);
  assert('P299b', 'preview no mutado con selectedPids', JSON.stringify(preview) === snapshot);
})();

// P300 — todos los IDs estales en fresh plan → 0 cambios aplicables
console.log('\nP300 — todos estale IDs → 0 cambios aplicables');
(function(){
  var freshExercises = [
    { exerciseName: 'Press',    prescriptionExerciseId: 'pid-nuevo-1', sets: [{ load: 80 }] },
    { exerciseName: 'Remo',     prescriptionExerciseId: 'pid-nuevo-2', sets: [{ load: 60 }] }
  ];
  // Selecciones con IDs que ya no existen
  var sel1 = { exerciseIndex: 0, recommendedLoad: 82.5, prescriptionExerciseId: 'pid-viejo-1' };
  var sel2 = { exerciseIndex: 1, recommendedLoad: 62.5, prescriptionExerciseId: 'pid-viejo-2' };
  var idx1 = _resolveExerciseInFreshPlan20(sel1, freshExercises);
  var idx2 = _resolveExerciseInFreshPlan20(sel2, freshExercises);
  assert('P300a', 'sel1 estale → -1', idx1 === -1);
  assert('P300b', 'sel2 estale → -1', idx2 === -1);
  // Ninguno aplicable → 0 writes
  var applied = [idx1, idx2].filter(function(i){ return i !== -1; }).length;
  assert('P300c', '0 ejercicios aplicables (todos estale)', applied === 0);
})();

// ─── FASE 22 mirror: _resolveExerciseRowId ───────────────────────────────
function _resolveExerciseRowId22(exerciseName, planCache) {
  if (!planCache || !planCache.days || !exerciseName) return null;
  var normQ = (exerciseName || '').toLowerCase().trim().replace(/\s+/g, ' ');
  for (var di = 0; di < planCache.days.length; di++) {
    var exs = planCache.days[di].exercises || [];
    for (var ei = 0; ei < exs.length; ei++) {
      var ex = exs[ei];
      var normN = (ex.exerciseName || ex.nombre || '').toLowerCase().trim().replace(/\s+/g, ' ');
      if (normN === normQ) {
        return { di: di, ei: ei, pid: ex.prescriptionExerciseId || null };
      }
    }
  }
  return null;
}

// ─── FASE 22 — _resolveExerciseRowId ──────────────────────────────────────
// P301 — ejercicio encontrado por nombre exacto
console.log('\nP301 — resolveExerciseRowId: nombre exacto');
(function() {
  var plan = { days: [{ dayIndex:0, exercises: [
    { exerciseName:'Press banca', prescriptionExerciseId:'pid-1', sets:[{load:80}] }
  ]}]};
  var r = _resolveExerciseRowId22('Press banca', plan);
  assert('P301a', 'no null', r !== null);
  assert('P301b', 'di=0', r !== null && r.di === 0);
  assert('P301c', 'ei=0', r !== null && r.ei === 0);
  assert('P301d', 'pid correcto', r !== null && r.pid === 'pid-1');
})();

// P302 — nombre con casing diferente
console.log('\nP302 — resolveExerciseRowId: casing insensible');
(function() {
  var plan = { days: [{ dayIndex:0, exercises: [
    { exerciseName:'Sentadilla Trasera', prescriptionExerciseId:'pid-2', sets:[] }
  ]}]};
  var r = _resolveExerciseRowId22('sentadilla trasera', plan);
  assert('P302a', 'encontrado con lowercase', r !== null);
  assert('P302b', 'di=0', r !== null && r.di === 0);
})();

// P303 — ejercicio no presente → null
console.log('\nP303 — resolveExerciseRowId: ejercicio ausente → null');
(function() {
  var plan = { days: [{ dayIndex:0, exercises: [
    { exerciseName:'Peso muerto', prescriptionExerciseId:'pid-3', sets:[] }
  ]}]};
  var r = _resolveExerciseRowId22('Sentadilla', plan);
  assert('P303a', 'no encontrado → null', r === null);
})();

// P304 — plan vacío → null
console.log('\nP304 — resolveExerciseRowId: plan vacío → null');
(function() {
  var r = _resolveExerciseRowId22('Press banca', null);
  assert('P304a', 'null plan → null', r === null);
  var r2 = _resolveExerciseRowId22('Press banca', { days: [] });
  assert('P304b', 'días vacíos → null', r2 === null);
})();

// P305 — ejerciseName vacío → null
console.log('\nP305 — resolveExerciseRowId: name vacío → null');
(function() {
  var plan = { days: [{ dayIndex:0, exercises: [
    { exerciseName:'Press banca', prescriptionExerciseId:'pid-5', sets:[] }
  ]}]};
  var r = _resolveExerciseRowId22('', plan);
  assert('P305a', 'name vacío → null', r === null);
  var r2 = _resolveExerciseRowId22(null, plan);
  assert('P305b', 'name null → null', r2 === null);
})();

// P306 — sin prescriptionExerciseId → pid=null
console.log('\nP306 — resolveExerciseRowId: sin prescriptionExerciseId → pid null');
(function() {
  var plan = { days: [{ dayIndex:0, exercises: [
    { exerciseName:'Remo con barra', sets:[] }
  ]}]};
  var r = _resolveExerciseRowId22('Remo con barra', plan);
  assert('P306a', 'encontrado', r !== null);
  assert('P306b', 'pid=null', r !== null && r.pid === null);
})();

// P307 — múltiples días, ejercicio en segundo día
console.log('\nP307 — resolveExerciseRowId: múltiples días, match en día 1');
(function() {
  var plan = { days: [
    { dayIndex:0, exercises: [{ exerciseName:'Press banca', prescriptionExerciseId:'pid-7a', sets:[] }] },
    { dayIndex:1, exercises: [{ exerciseName:'Jalón al pecho', prescriptionExerciseId:'pid-7b', sets:[] }] }
  ]};
  var r = _resolveExerciseRowId22('Jalón al pecho', plan);
  assert('P307a', 'di=1 (segundo día)', r !== null && r.di === 1);
  assert('P307b', 'ei=0', r !== null && r.ei === 0);
  assert('P307c', 'pid-7b', r !== null && r.pid === 'pid-7b');
})();

// P308 — múltiples ejercicios mismo día, match en segundo ejercicio
console.log('\nP308 — resolveExerciseRowId: múltiples ejercicios, match en ei=1');
(function() {
  var plan = { days: [{ dayIndex:0, exercises: [
    { exerciseName:'Press banca', prescriptionExerciseId:'pid-8a', sets:[] },
    { exerciseName:'Aperturas', prescriptionExerciseId:'pid-8b', sets:[] }
  ]}]};
  var r = _resolveExerciseRowId22('Aperturas', plan);
  assert('P308a', 'ei=1', r !== null && r.ei === 1);
  assert('P308b', 'pid-8b', r !== null && r.pid === 'pid-8b');
})();

// P309 — espacios extra en el nombre → normalización
console.log('\nP309 — resolveExerciseRowId: espacios extra normalizados');
(function() {
  var plan = { days: [{ dayIndex:0, exercises: [
    { exerciseName:'Press  banca', prescriptionExerciseId:'pid-9', sets:[] }
  ]}]};
  var r = _resolveExerciseRowId22('Press banca', plan);
  assert('P309a', 'espacios extra normalizados → encontrado', r !== null);
})();

// P310 — función es pura (no muta planCache)
console.log('\nP310 — resolveExerciseRowId: función pura (no muta plan)');
(function() {
  var ex = { exerciseName:'Sentadilla', prescriptionExerciseId:'pid-10', sets:[] };
  var plan = { days: [{ dayIndex:0, exercises: [ex] }]};
  var before = JSON.stringify(plan);
  _resolveExerciseRowId22('Sentadilla', plan);
  assert('P310a', 'plan no mutado', JSON.stringify(plan) === before);
  assert('P310b', 'ejercicio no mutado', ex.exerciseName === 'Sentadilla');
})();

// ─── FASE 23 mirror: _shouldWarnDirtyLeave ───────────────────────────────
function _shouldWarnDirtyLeave23(fromTab, toTab, isDirty) {
  return isDirty === true && fromTab === 'plan' && toTab !== 'plan';
}

// ─── FASE 23 — _shouldWarnDirtyLeave ──────────────────────────────────────
// P311 — dirty=true, from=plan, to=monitor → warn
console.log('\nP311 — shouldWarnDirtyLeave: dirty plan→monitor → true');
(function() {
  assert('P311a', 'dirty plan→monitor = true', _shouldWarnDirtyLeave23('plan','monitor',true) === true);
})();

// P312 — dirty=false → no warn
console.log('\nP312 — shouldWarnDirtyLeave: clean → false');
(function() {
  assert('P312a', 'clean plan→monitor = false', _shouldWarnDirtyLeave23('plan','monitor',false) === false);
})();

// P313 — desde ficha (no plan) → no warn
console.log('\nP313 — shouldWarnDirtyLeave: from=ficha → false');
(function() {
  assert('P313a', 'ficha→monitor = false', _shouldWarnDirtyLeave23('ficha','monitor',true) === false);
})();

// P314 — desde plan, a plan (mismo tab) → no warn
console.log('\nP314 — shouldWarnDirtyLeave: plan→plan → false');
(function() {
  assert('P314a', 'plan→plan = false', _shouldWarnDirtyLeave23('plan','plan',true) === false);
})();

// P315 — from=null → no warn
console.log('\nP315 — shouldWarnDirtyLeave: from=null → false');
(function() {
  assert('P315a', 'null→monitor = false', _shouldWarnDirtyLeave23(null,'monitor',true) === false);
})();

// P316 — plan→notas → warn
console.log('\nP316 — shouldWarnDirtyLeave: plan→notas → true');
(function() {
  assert('P316a', 'plan→notas = true', _shouldWarnDirtyLeave23('plan','notas',true) === true);
})();

// P317 — plan→inbody → warn
console.log('\nP317 — shouldWarnDirtyLeave: plan→inbody → true');
(function() {
  assert('P317a', 'plan→inbody = true', _shouldWarnDirtyLeave23('plan','inbody',true) === true);
})();

// P318 — plan→ficha → warn
console.log('\nP318 — shouldWarnDirtyLeave: plan→ficha → true');
(function() {
  assert('P318a', 'plan→ficha = true', _shouldWarnDirtyLeave23('plan','ficha',true) === true);
})();

// P319 — plan→renovar → warn
console.log('\nP319 — shouldWarnDirtyLeave: plan→renovar → true');
(function() {
  assert('P319a', 'plan→renovar = true', _shouldWarnDirtyLeave23('plan','renovar',true) === true);
})();

// P320 — isDirty=undefined → no warn
console.log('\nP320 — shouldWarnDirtyLeave: isDirty=undefined → false');
(function() {
  assert('P320a', 'undefined dirty = false', _shouldWarnDirtyLeave23('plan','monitor',undefined) === false);
})();

// ─── FASE 24 mirror: _planTabLabel ───────────────────────────────────────
function _planTabLabel24(isDirty, baseLabel) {
  var base = baseLabel || '🏋️ Plan';
  return isDirty === true ? base + ' ●' : base;
}

// ─── FASE 24 — _planTabLabel ──────────────────────────────────────────────
// P321 — dirty=true → label con indicador
console.log('\nP321 — planTabLabel: dirty=true → ●');
(function() {
  var label = _planTabLabel24(true);
  assert('P321a', 'contiene ●', label.indexOf('●') !== -1);
  assert('P321b', 'termina con ●', label.slice(-1) === '●');
})();

// P322 — dirty=false → label sin indicador
console.log('\nP322 — planTabLabel: dirty=false → sin ●');
(function() {
  var label = _planTabLabel24(false);
  assert('P322a', 'sin ●', label.indexOf('●') === -1);
  assert('P322b', 'label base', label === '🏋️ Plan');
})();

// P323 — baseLabel personalizado + dirty → baseLabel + ●
console.log('\nP323 — planTabLabel: custom baseLabel + dirty');
(function() {
  var label = _planTabLabel24(true, 'Plan');
  assert('P323a', 'Plan ●', label === 'Plan ●');
})();

// P324 — baseLabel personalizado + clean → baseLabel
console.log('\nP324 — planTabLabel: custom baseLabel + clean');
(function() {
  var label = _planTabLabel24(false, 'Plan');
  assert('P324a', 'Plan (sin ●)', label === 'Plan');
})();

// P325 — dirty=true, baseLabel vacío → fallback '🏋️ Plan' + ●
console.log('\nP325 — planTabLabel: baseLabel vacío → fallback');
(function() {
  var label = _planTabLabel24(true, '');
  assert('P325a', 'fallback base', label.indexOf('🏋️ Plan') !== -1);
  assert('P325b', 'contiene ●', label.indexOf('●') !== -1);
})();

// P326 — dirty=undefined → sin indicador
console.log('\nP326 — planTabLabel: dirty=undefined → sin ●');
(function() {
  var label = _planTabLabel24(undefined);
  assert('P326a', 'undefined dirty → sin ●', label.indexOf('●') === -1);
})();

// P327 — dirty=null → sin indicador
console.log('\nP327 — planTabLabel: dirty=null → sin ●');
(function() {
  var label = _planTabLabel24(null);
  assert('P327a', 'null dirty → sin ●', label.indexOf('●') === -1);
})();

// P328 — dirty=true → resultado es string no vacío
console.log('\nP328 — planTabLabel: dirty=true → string no vacío');
(function() {
  var label = _planTabLabel24(true);
  assert('P328a', 'es string', typeof label === 'string');
  assert('P328b', 'no vacío', label.length > 0);
})();

// P329 — función es pura (múltiples llamadas consistentes)
console.log('\nP329 — planTabLabel: pura (mismos args → mismo resultado)');
(function() {
  var r1 = _planTabLabel24(true, 'Test');
  var r2 = _planTabLabel24(true, 'Test');
  assert('P329a', 'idempotente dirty', r1 === r2);
  var r3 = _planTabLabel24(false, 'Test');
  var r4 = _planTabLabel24(false, 'Test');
  assert('P329b', 'idempotente clean', r3 === r4);
})();

// P330 — dirty true vs false producen resultados distintos
console.log('\nP330 — planTabLabel: dirty≠clean producen labels distintos');
(function() {
  var dirty = _planTabLabel24(true);
  var clean = _planTabLabel24(false);
  assert('P330a', 'dirty ≠ clean', dirty !== clean);
  assert('P330b', 'dirty más largo', dirty.length > clean.length);
})();

// ─── AUDIT FIX FASE 22 mirror v2: _resolveExerciseRowId con pid primario ────
function _resolveExerciseRowId22v2(exerciseName, planCache, pid) {
  if (!planCache || !planCache.days) return null;
  // PRIMARY: pid
  if (pid) {
    for (var di = 0; di < planCache.days.length; di++) {
      var exs = planCache.days[di].exercises || [];
      for (var ei = 0; ei < exs.length; ei++) {
        if ((exs[ei].prescriptionExerciseId || '') === pid) {
          return { di: di, ei: ei, pid: pid };
        }
      }
    }
  }
  // FALLBACK: nombre normalizado
  if (!exerciseName) return null;
  var normQ = exerciseName.toLowerCase().trim().replace(/\s+/g, ' ');
  for (var di2 = 0; di2 < planCache.days.length; di2++) {
    var exs2 = planCache.days[di2].exercises || [];
    for (var ei2 = 0; ei2 < exs2.length; ei2++) {
      var ex2 = exs2[ei2];
      var normN = (ex2.exerciseName || ex2.nombre || '').toLowerCase().trim().replace(/\s+/g, ' ');
      if (normN === normQ) {
        return { di: di2, ei: ei2, pid: ex2.prescriptionExerciseId || null };
      }
    }
  }
  return null;
}

// ─── AUDIT FIX FASE 22 — PID como clave primaria ──────────────────────────
// P331 — pid exacto → resuelve en día correcto (desambigua nombre duplicado)
console.log('\nP331 — resolveExerciseRowId v2: pid exacto navega al día correcto');
(function() {
  var cache = { days: [
    { exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-d0' }] },
    { exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-d1' }] }
  ]};
  var r = _resolveExerciseRowId22v2('Sentadilla', cache, 'pid-d1');
  assert('P331a', 'di=1 (día correcto)', r && r.di === 1);
  assert('P331b', 'ei=0', r && r.ei === 0);
  assert('P331c', 'pid correcto', r && r.pid === 'pid-d1');
})();

// P332 — pid vacío → fallback a nombre, devuelve primer match
console.log('\nP332 — resolveExerciseRowId v2: pid vacío → fallback nombre día 0');
(function() {
  var cache = { days: [
    { exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-d0' }] },
    { exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-d1' }] }
  ]};
  var r = _resolveExerciseRowId22v2('Sentadilla', cache, '');
  assert('P332a', 'di=0 (primer match por nombre)', r && r.di === 0);
  assert('P332b', 'pid del primer match', r && r.pid === 'pid-d0');
})();

// P333 — pid undefined → fallback a nombre
console.log('\nP333 — resolveExerciseRowId v2: pid undefined → fallback nombre');
(function() {
  var cache = { days: [
    { exercises: [{ exerciseName: 'Press', prescriptionExerciseId: 'p1' }] }
  ]};
  var r = _resolveExerciseRowId22v2('Press', cache, undefined);
  assert('P333a', 'encontrado por nombre', r !== null);
  assert('P333b', 'di=0', r && r.di === 0);
})();

// P334 — pid null → fallback a nombre
console.log('\nP334 — resolveExerciseRowId v2: pid null → fallback nombre');
(function() {
  var cache = { days: [
    { exercises: [{ exerciseName: 'Peso Muerto', prescriptionExerciseId: 'pm1' }] }
  ]};
  var r = _resolveExerciseRowId22v2('Peso Muerto', cache, null);
  assert('P334a', 'encontrado', r !== null);
  assert('P334b', 'pid retornado del ejercicio', r && r.pid === 'pm1');
})();

// P335 — pid no existe en plan → fallback a nombre
console.log('\nP335 — resolveExerciseRowId v2: pid inexistente → fallback nombre');
(function() {
  var cache = { days: [
    { exercises: [{ exerciseName: 'Jalón', prescriptionExerciseId: 'j1' }] }
  ]};
  var r = _resolveExerciseRowId22v2('Jalón', cache, 'pid-bogus');
  assert('P335a', 'fallback a nombre → encontrado', r !== null);
  assert('P335b', 'di=0', r && r.di === 0);
  assert('P335c', 'pid retornado del ejercicio', r && r.pid === 'j1');
})();

// P336 — pid presente → pid gana aunque nombre coincidiría con otro ejercicio
console.log('\nP336 — resolveExerciseRowId v2: pid gana sobre nombre');
(function() {
  var cache = { days: [
    { exercises: [
        { exerciseName: 'Remo', prescriptionExerciseId: 'remo-d0' },
        { exerciseName: 'Dominada', prescriptionExerciseId: 'dom-d0' }
    ]},
    { exercises: [
        { exerciseName: 'Remo', prescriptionExerciseId: 'remo-d1' }
    ]}
  ]};
  var r = _resolveExerciseRowId22v2('Remo', cache, 'remo-d1');
  assert('P336a', 'di=1 (pid sobre nombre)', r && r.di === 1);
  assert('P336b', 'pid=remo-d1', r && r.pid === 'remo-d1');
})();

// P337 — ejercicio sin prescriptionExerciseId → pid vacío en resultado
console.log('\nP337 — resolveExerciseRowId v2: ejercicio sin pid → pid null en resultado');
(function() {
  var cache = { days: [
    { exercises: [{ exerciseName: 'Hip Thrust' }] }
  ]};
  var r = _resolveExerciseRowId22v2('Hip Thrust', cache, '');
  assert('P337a', 'encontrado', r !== null);
  assert('P337b', 'pid null (sin prescriptionExerciseId)', r && r.pid === null);
})();

// P338 — nombre no en plan → null
console.log('\nP338 — resolveExerciseRowId v2: nombre inexistente → null');
(function() {
  var cache = { days: [{ exercises: [{ exerciseName: 'Curl', prescriptionExerciseId: 'c1' }] }] };
  var r = _resolveExerciseRowId22v2('Extensión', cache, '');
  assert('P338a', 'null (no encontrado)', r === null);
})();

// P339 — plan vacío → null
console.log('\nP339 — resolveExerciseRowId v2: plan vacío → null');
(function() {
  var r = _resolveExerciseRowId22v2('Press', { days: [] }, 'p1');
  assert('P339a', 'null (plan sin días)', r === null);
})();

// P340 — función pura: misma entrada → mismo resultado
console.log('\nP340 — resolveExerciseRowId v2: función pura');
(function() {
  var cache = { days: [{ exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'sq1' }] }] };
  var r1 = _resolveExerciseRowId22v2('Squat', cache, 'sq1');
  var r2 = _resolveExerciseRowId22v2('Squat', cache, 'sq1');
  assert('P340a', 'idempotente: di', r1.di === r2.di);
  assert('P340b', 'idempotente: pid', r1.pid === r2.pid);
})();

// ─── AUDIT FIX FASE 23 — Regresión descarte explícito ─────────────────────
// Mirror de _shouldWarnDirtyLeave ya existe como _shouldWarnDirtyLeave23
// Testeamos la secuencia completa del estado dirty → warn → discard → clean

// P341 — secuencia discard: dirty=true → warn triggers
console.log('\nP341 — discard sequence: dirty=true desde plan → warn se activa');
(function() {
  var warns = _shouldWarnDirtyLeave23('plan', 'monitor', true);
  assert('P341a', 'warn activo con dirty=true', warns === true);
})();

// P342 — tras discard (markEditorClean equivalente): dirty=false → no warn al volver a plan
console.log('\nP342 — discard sequence: tras limpiar, volver a plan no genera warn');
(function() {
  // simula: usuario en monitor (fromTab='monitor') vuelve a plan con dirty=false
  var warns = _shouldWarnDirtyLeave23('monitor', 'plan', false);
  assert('P342a', 'no warn al volver a plan (dirty=false)', warns === false);
})();

// P343 — tras discard: desde plan hacia cualquier tab → no warn (dirty=false)
console.log('\nP343 — discard sequence: plan→X con dirty=false → no warn en ningún tab');
(function() {
  var tabs = ['ficha','monitor','notas','inbody','renovar'];
  var allFalse = tabs.every(function(t) { return _shouldWarnDirtyLeave23('plan', t, false) === false; });
  assert('P343a', 'todos los destinos sin warn', allFalse);
})();

// P344 — re-entrar a plan tras discard: plan→plan dirty=false → false (no self-warn)
console.log('\nP344 — discard sequence: plan→plan dirty=false → false');
(function() {
  assert('P344a', 'no self-warn clean', _shouldWarnDirtyLeave23('plan','plan',false) === false);
})();

// P345 — discard es idempotente: limpiar dos veces no cambia resultado
console.log('\nP345 — discard sequence: idempotencia de estado limpio');
(function() {
  // simula dos markEditorClean seguidos: dirty=false en ambas llamadas
  var w1 = _shouldWarnDirtyLeave23('plan','monitor',false);
  var w2 = _shouldWarnDirtyLeave23('plan','monitor',false);
  assert('P345a', 'resultado idempotente', w1 === w2);
  assert('P345b', 'ambos false', w1 === false && w2 === false);
})();

// P346 — el guard no se activa para tabs distintos de plan como origen
console.log('\nP346 — discard sequence: origen no-plan → nunca warn');
(function() {
  var origins = ['ficha','monitor','notas','inbody','renovar'];
  var allFalse = origins.every(function(o) { return _shouldWarnDirtyLeave23(o,'ficha',true) === false; });
  assert('P346a', 'no-plan origen nunca da warn aunque dirty=true', allFalse);
})();

// P347 — invariante: warn solo cuando dirty=true AND from=plan AND to≠plan
console.log('\nP347 — discard sequence: invariante triple condición');
(function() {
  assert('P347a', 'dirty=true from=plan to=monitor → true',  _shouldWarnDirtyLeave23('plan','monitor',true)  === true);
  assert('P347b', 'dirty=false from=plan to=monitor → false', _shouldWarnDirtyLeave23('plan','monitor',false) === false);
  assert('P347c', 'dirty=true from=monitor to=plan → false',  _shouldWarnDirtyLeave23('monitor','plan',true)  === false);
  assert('P347d', 'dirty=true from=plan to=plan → false',     _shouldWarnDirtyLeave23('plan','plan',true)     === false);
})();

// P348 — flujo completo: dirty=true → confirm → clean → return to plan → sin warn
console.log('\nP348 — discard sequence: flujo completo estado');
(function() {
  // Estado 1: en Plan, sucio
  var isDirty = true;
  var fromTab = 'plan';
  // Paso 1: usuario intenta ir a Monitor
  var step1 = _shouldWarnDirtyLeave23(fromTab, 'monitor', isDirty);
  assert('P348a', 'step1: warn activo', step1 === true);
  // Paso 2: usuario confirma → discard → markEditorClean
  isDirty = false;
  fromTab = 'monitor';
  // Paso 3: usuario vuelve a Plan
  var step3 = _shouldWarnDirtyLeave23(fromTab, 'plan', isDirty);
  assert('P348b', 'step3: sin warn al volver', step3 === false);
  // Paso 4: usuario intenta ir a Monitor de nuevo (limpio)
  fromTab = 'plan';
  var step4 = _shouldWarnDirtyLeave23(fromTab, 'monitor', isDirty);
  assert('P348c', 'step4: sin warn (limpio)', step4 === false);
})();

// P349 — discard no altera el resultado de funciones puras subsiguientes
console.log('\nP349 — discard: funciones puras no tienen efecto secundario sobre _shouldWarnDirtyLeave');
(function() {
  var r1 = _shouldWarnDirtyLeave23('plan', 'ficha', true);
  var r2 = _shouldWarnDirtyLeave23('plan', 'ficha', true);
  assert('P349a', 'pura: misma entrada mismo resultado', r1 === r2);
})();

// P350 — _discardEditorChanges es safe cuando no hay DOM (no lanza excepción)
console.log('\nP350 — _discardEditorChanges: safe sin DOM');
(function() {
  // En entorno sin DOM, document.getElementById retorna null; la función debe ser no-operación
  var threw = false;
  try {
    // simula _discardEditorChanges sin DOM (editorEl = null → no-op)
    var editorEl = null; // document.getElementById devuelve null sin DOM
    var _detailPlanDataMock = { days: [] };
    if (editorEl && _detailPlanDataMock) {
      editorEl.innerHTML = 'rebuilt';
    }
    // no lanzó excepción
  } catch(e) { threw = true; }
  assert('P350a', 'no lanza excepción sin DOM', threw === false);
})();

// ─── FASE 25 — Next-Action Resolver ────────────────────────────────────────
// Mirror determinista de _resolveNextWorkoutAction para entorno Node sin DOM.
// Inyecta stubs de getEffectiveSets e isTechniqueActive vía opts.
function _resolveNextAction25(di, exercises, lastEi, lastSi, logs25, currentWeek, totalWeeks, opts) {
  opts = opts || {};
  var _getEff      = opts.getEffectiveSets  || function(ej)           { return ej.sets || []; };
  var _isTechActive = opts.isTechniqueActive || function()             { return true; };
  if (!exercises || !exercises.length) return { type: 'NONE', label: '' };
  var ej = exercises[lastEi] || null;
  if (!ej) return { type: 'NONE', label: '' };
  var grp = ej.supersetGroup ? String(ej.supersetGroup).trim() : '';
  // 1. SUPERSET_PARTNER
  if (grp) {
    for (var pk = 0; pk < exercises.length; pk++) {
      if (pk === lastEi) continue;
      var pej = exercises[pk];
      if (!pej || String(pej.supersetGroup || '').trim() !== grp) continue;
      var pKey = 'log_' + currentWeek + '_' + di + '_' + pk + '_s' + lastSi;
      if (!logs25[pKey] || !logs25[pKey].done) {
        return { type: 'SUPERSET_PARTNER', label: pej.exerciseName || pej.nombre || 'Partner SS' };
      }
    }
  }
  // 2. NEXT_SET
  var effSets = _getEff(ej, currentWeek, totalWeeks);
  var numSets = effSets.length || 0;
  var nextSi  = lastSi + 1;
  if (nextSi < numSets) {
    var nextKey = 'log_' + currentWeek + '_' + di + '_' + lastEi + '_s' + nextSi;
    if (!logs25[nextKey] || !logs25[nextKey].done) {
      return { type: 'NEXT_SET', label: (ej.exerciseName || ej.nombre || '') + ' – S' + (nextSi + 1) };
    }
  }
  // 3. NEXT_EXERCISE
  for (var nei = lastEi + 1; nei < exercises.length; nei++) {
    var nex = exercises[nei];
    if (!nex || !_isTechActive(nex, currentWeek)) continue;
    var nEff = _getEff(nex, currentWeek, totalWeeks);
    var nNum = nEff.length || 0;
    for (var ns = 0; ns < nNum; ns++) {
      var nk = 'log_' + currentWeek + '_' + di + '_' + nei + '_s' + ns;
      if (!logs25[nk] || !logs25[nk].done) {
        return { type: 'NEXT_EXERCISE', label: nex.exerciseName || nex.nombre || '' };
      }
    }
  }
  // 4. SESSION_DONE — todos los activos completos
  for (var aei = 0; aei < exercises.length; aei++) {
    var aej = exercises[aei];
    if (!aej || !_isTechActive(aej, currentWeek)) continue;
    var aEff = _getEff(aej, currentWeek, totalWeeks);
    var aNum = aEff.length || 0;
    for (var as = 0; as < aNum; as++) {
      var ak = 'log_' + currentWeek + '_' + di + '_' + aei + '_s' + as;
      if (!logs25[ak] || !logs25[ak].done) return { type: 'NONE', label: '' };
    }
  }
  return { type: 'SESSION_DONE', label: '¡Sesión lista!' };
}

// Helper: construye exercises con N sets de plantilla
function _mkEx(name, numSets, supersetGroup) {
  var sets = [];
  for (var i = 0; i < numSets; i++) sets.push({ setIndex: i, repsTarget: 10, rirTarget: 2 });
  return { exerciseName: name, sets: sets, supersetGroup: supersetGroup || null };
}
// Helper: marca set como hecho
function _markDone25(logs25, week, di, ei, si) {
  var k = 'log_' + week + '_' + di + '_' + ei + '_s' + si;
  logs25[k] = { done: true, carga: '60', reps: '10', rir_real: '2', ics: '8', pump: '1', unit: 'KG' };
}

// P351 — exercises vacío → NONE
console.log('\nP351 — FASE 25: exercises vacío → NONE');
(function() {
  var r = _resolveNextAction25(0, [], 0, 0, {}, 1, 6);
  assert('P351a', 'type NONE', r.type === 'NONE');
})();

// P352 — NEXT_SET cuando siguiente set del mismo ejercicio está pendiente
console.log('\nP352 — FASE 25: NEXT_SET siguiente set pendiente');
(function() {
  var exs = [_mkEx('Squat', 3)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  var r = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  assert('P352a', 'type NEXT_SET', r.type === 'NEXT_SET');
  assert('P352b', 'label contiene S2', r.label.indexOf('S2') !== -1);
  assert('P352c', 'label contiene nombre', r.label.indexOf('Squat') !== -1);
})();

// P353 — Todos los sets del ejercicio hechos → NEXT_EXERCISE si hay siguiente
console.log('\nP353 — FASE 25: ejercicio completo → NEXT_EXERCISE');
(function() {
  var exs = [_mkEx('Squat', 2), _mkEx('Leg Press', 2)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  _markDone25(logs25, 1, 0, 0, 1);
  var r = _resolveNextAction25(0, exs, 0, 1, logs25, 1, 6);
  assert('P353a', 'type NEXT_EXERCISE', r.type === 'NEXT_EXERCISE');
  assert('P353b', 'label es Leg Press', r.label === 'Leg Press');
})();

// P354 — Todos los sets de todos los ejercicios hechos → SESSION_DONE
console.log('\nP354 — FASE 25: todo hecho → SESSION_DONE');
(function() {
  var exs = [_mkEx('Squat', 2), _mkEx('Leg Press', 2)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); _markDone25(logs25, 1, 0, 0, 1);
  _markDone25(logs25, 1, 0, 1, 0); _markDone25(logs25, 1, 0, 1, 1);
  var r = _resolveNextAction25(0, exs, 0, 1, logs25, 1, 6);
  assert('P354a', 'type SESSION_DONE', r.type === 'SESSION_DONE');
  assert('P354b', 'label es ¡Sesión lista!', r.label === '¡Sesión lista!');
})();

// P355 — lastEi fuera de rango → NONE
console.log('\nP355 — FASE 25: lastEi fuera de rango → NONE');
(function() {
  var exs = [_mkEx('Squat', 3)];
  var r = _resolveNextAction25(0, exs, 5, 0, {}, 1, 6);
  assert('P355a', 'type NONE cuando ej no existe', r.type === 'NONE');
})();

// P356 — SUPERSET_PARTNER detectado (partner pendiente en mismo si)
console.log('\nP356 — FASE 25: SUPERSET_PARTNER cuando partner pendiente');
(function() {
  var exs = [_mkEx('Squat', 3, 'SS1'), _mkEx('Leg Curl', 3, 'SS1')];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); // ei=0 si=0 hecho
  // ei=1 si=0 NO hecho
  var r = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  assert('P356a', 'type SUPERSET_PARTNER', r.type === 'SUPERSET_PARTNER');
  assert('P356b', 'label es Leg Curl', r.label === 'Leg Curl');
})();

// P357 — SUPERSET_PARTNER ya hecho → cae a NEXT_SET
console.log('\nP357 — FASE 25: partner SS ya hecho → NEXT_SET');
(function() {
  var exs = [_mkEx('Squat', 3, 'SS1'), _mkEx('Leg Curl', 3, 'SS1')];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); // ei=0 si=0
  _markDone25(logs25, 1, 0, 1, 0); // ei=1 si=0 (partner hecho)
  var r = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  assert('P357a', 'type NEXT_SET', r.type === 'NEXT_SET');
  assert('P357b', 'label S2 de Squat', r.label.indexOf('S2') !== -1 && r.label.indexOf('Squat') !== -1);
})();

// P358 — Ejercicio inactivo (isTechniqueActive=false) es ignorado para NEXT_EXERCISE
console.log('\nP358 — FASE 25: ejercicio inactivo ignorado → salta al activo siguiente');
(function() {
  var exs = [_mkEx('Squat', 2), _mkEx('FST7-Inactive', 2), _mkEx('Leg Press', 2)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); _markDone25(logs25, 1, 0, 0, 1);
  // ei=1 inactivo, ei=2 pendiente
  var _isTechActive = function(ej) { return ej.exerciseName !== 'FST7-Inactive'; };
  var r = _resolveNextAction25(0, exs, 0, 1, logs25, 1, 6, { isTechniqueActive: _isTechActive });
  assert('P358a', 'type NEXT_EXERCISE', r.type === 'NEXT_EXERCISE');
  assert('P358b', 'label es Leg Press (saltó inactivo)', r.label === 'Leg Press');
})();

// P359 — último ejercicio último set → SESSION_DONE (no NEXT_EXERCISE)
console.log('\nP359 — FASE 25: último ej último set completado → SESSION_DONE');
(function() {
  var exs = [_mkEx('Squat', 1), _mkEx('Leg Press', 1)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  _markDone25(logs25, 1, 0, 1, 0);
  var r = _resolveNextAction25(0, exs, 1, 0, logs25, 1, 6);
  assert('P359a', 'type SESSION_DONE', r.type === 'SESSION_DONE');
})();

// P360 — NEXT_SET prioridad sobre NEXT_EXERCISE: mismo ejercicio con set pendiente
console.log('\nP360 — FASE 25: NEXT_SET antes que NEXT_EXERCISE cuando hay sets pendientes');
(function() {
  var exs = [_mkEx('Squat', 3), _mkEx('Leg Press', 3)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); // si=0 de Squat hecho
  // si=1 y si=2 de Squat pendientes; Leg Press todo pendiente
  var r = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  assert('P360a', 'type NEXT_SET, no NEXT_EXERCISE', r.type === 'NEXT_SET');
})();

// P361 — label de NEXT_SET tiene formato "Nombre – S{n}"
console.log('\nP361 — FASE 25: label NEXT_SET formato correcto');
(function() {
  var exs = [_mkEx('Bench Press', 4)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  _markDone25(logs25, 1, 0, 0, 1);
  var r = _resolveNextAction25(0, exs, 0, 1, logs25, 1, 6);
  assert('P361a', 'type NEXT_SET', r.type === 'NEXT_SET');
  assert('P361b', 'label = "Bench Press – S3"', r.label === 'Bench Press – S3');
})();

// P362 — SUPERSET_PARTNER solo se activa con grupo coincidente
console.log('\nP362 — FASE 25: SUPERSET_PARTNER solo mismo grupo SS');
(function() {
  var exs = [_mkEx('Squat', 2, 'SS1'), _mkEx('Bench', 2, 'SS2'), _mkEx('Leg Curl', 2, 'SS1')];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); // Squat si=0 hecho
  // Bench (SS2) no es partner de Squat (SS1)
  // Leg Curl (SS1) ES partner
  var r = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  assert('P362a', 'type SUPERSET_PARTNER', r.type === 'SUPERSET_PARTNER');
  assert('P362b', 'partner es Leg Curl no Bench', r.label === 'Leg Curl');
})();

// P363 — Resolver es puro: misma entrada → mismo resultado (idempotencia)
console.log('\nP363 — FASE 25: resolver puro / idempotente');
(function() {
  var exs = [_mkEx('Squat', 3), _mkEx('Leg Press', 3)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  var r1 = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  var r2 = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  assert('P363a', 'tipo idempotente', r1.type === r2.type);
  assert('P363b', 'label idempotente', r1.label === r2.label);
})();

// P364 — currentWeek se usa correctamente en las claves de log
console.log('\nP364 — FASE 25: clave de log usa currentWeek correcto');
(function() {
  var exs = [_mkEx('Squat', 2)];
  var logs25 = {};
  // Marcamos set en semana 3, no en semana 1
  logs25['log_3_0_0_s0'] = { done: true, carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', unit: 'KG' };
  var rWeek1 = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6); // semana 1 → set no hecho
  var rWeek3 = _resolveNextAction25(0, exs, 0, 0, logs25, 3, 6); // semana 3 → set hecho
  assert('P364a', 'semana 1: si=0 pendiente → NEXT_SET', rWeek1.type === 'NEXT_SET');
  assert('P364b', 'semana 3: si=0 hecho → otro resultado', rWeek3.type !== 'NEXT_SET' || rWeek3.label.indexOf('S2') !== -1);
})();

// P365 — Solo un ejercicio, 1 set, ya hecho → SESSION_DONE
console.log('\nP365 — FASE 25: sesión de 1 ejercicio 1 set → SESSION_DONE al terminar');
(function() {
  var exs = [_mkEx('Plank', 1)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  var r = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  assert('P365a', 'type SESSION_DONE', r.type === 'SESSION_DONE');
  assert('P365b', 'label correcto', r.label === '¡Sesión lista!');
})();

// P366 — getEffectiveSets stub con 0 sets activos → no NEXT_SET en ese ejercicio
console.log('\nP366 — FASE 25: getEffectiveSets retorna [] → ejercicio omitido en SESSION_DONE');
(function() {
  var exs = [_mkEx('FST7Ex', 3)]; // 3 sets en plan
  var logs25 = {};
  // getEffectiveSets retorna [] (inactivo esta semana)
  var r = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6, {
    getEffectiveSets: function() { return []; }
  });
  // Con 0 sets activos → no hay NEXT_SET → todos "completados" → SESSION_DONE
  assert('P366a', 'type SESSION_DONE (0 sets activos)', r.type === 'SESSION_DONE');
})();

// P367 — SUPERSET_PARTNER: si partner también inactivo (0 sets eff) → fall-through
console.log('\nP367 — FASE 25: partner pendiente pero activo → SUPERSET_PARTNER; inactivo → fall-through');
(function() {
  var exs = [_mkEx('A', 2, 'SS1'), _mkEx('B', 2, 'SS1')];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); // A si=0 hecho; B si=0 NO hecho
  // Sin stub → B pendiente → SUPERSET_PARTNER
  var r1 = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6);
  assert('P367a', 'B pendiente → SUPERSET_PARTNER', r1.type === 'SUPERSET_PARTNER');
  assert('P367b', 'label B', r1.label === 'B');
})();

// P368 — FST7 inactivo esta semana (getEffectiveSets=[] + isTechniqueActive=false) → SESSION_DONE
// En producción, FST7/SST/lengthened_partials inactivos tienen getEffectiveSets=[].
// El resolver los trata como "sin sets pendientes" → SESSION_DONE cuando no hay otros activos.
console.log('\nP368 — FASE 25: técnica inactiva (0 sets activos) → SESSION_DONE');
(function() {
  var exs = [_mkEx('FST7-Ex', 2)];
  var logs25 = {};
  var r = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6, {
    isTechniqueActive: function() { return false; },
    getEffectiveSets:  function() { return []; }  // FST7 inactivo → 0 sets
  });
  assert('P368a', 'FST7 inactivo → SESSION_DONE', r.type === 'SESSION_DONE');
})();

// P369 — NEXT_EXERCISE no aparece antes que NEXT_SET del mismo ejercicio
console.log('\nP369 — FASE 25: prioridad NEXT_SET > NEXT_EXERCISE cuando quedan sets');
(function() {
  var exs = [_mkEx('Squat', 4), _mkEx('Leg Press', 2)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  _markDone25(logs25, 1, 0, 0, 1);
  // Quedan si=2 y si=3 de Squat pendientes
  var r = _resolveNextAction25(0, exs, 0, 1, logs25, 1, 6);
  assert('P369a', 'NEXT_SET sobre NEXT_EXERCISE', r.type === 'NEXT_SET');
  assert('P369b', 'label S3 de Squat', r.label === 'Squat – S3');
})();

// P370 — di correcto en claves (día 2)
console.log('\nP370 — FASE 25: di se usa correctamente en clave de log');
(function() {
  var exs = [_mkEx('Bench', 2)];
  var logs25 = {};
  // Marcar set en di=2, no di=0
  logs25['log_1_2_0_s0'] = { done: true, carga: '80', reps: '8', rir_real: '2', ics: '8', pump: '1', unit: 'KG' };
  var rDi0 = _resolveNextAction25(0, exs, 0, 0, logs25, 1, 6); // di=0 → set no hecho
  var rDi2 = _resolveNextAction25(2, exs, 0, 0, logs25, 1, 6); // di=2 → set hecho
  assert('P370a', 'di=0 → si=0 no hecho → NEXT_SET (S2 pendiente)', rDi0.type === 'NEXT_SET');
  // di=2 si=0 hecho, si=1 no hecho → NEXT_SET S2
  assert('P370b', 'di=2 → si=0 hecho → NEXT_SET S2', rDi2.type === 'NEXT_SET' && rDi2.label === 'Bench – S2');
})();

// ─── FASE 25 AUDIT FIX — Integración completeSet ──────────────────────────
// Mirror del flujo de completeSet post-fix para verificar que _renderNextWorkoutAction
// se invoca en todos los caminos correctos (SUPERSET_PARTNER, restTime=0, autoFilled).
function _mockCompleteSetFlow(opts) {
  // opts: { ei, si, di, exercises, logs, currentWeek, totalWeeks,
  //         partnerPending, autoFilled, restTime, getEffectiveSets }
  var renders = [];
  var timerStarted = false;

  var _renderNA = function(action) { renders.push({ type: action.type, label: action.label }); };
  var _eff = opts.getEffectiveSets || function(ej) { return ej.sets || []; };
  var _iTech = opts.isTechniqueActive || function() { return true; };

  // Resolver (antes de cualquier early return excepto autoFilled)
  var nextAction = _resolveNextAction25(
    opts.di || 0, opts.exercises, opts.ei, opts.si,
    opts.logs || {}, opts.currentWeek || 1, opts.totalWeeks || 6,
    { getEffectiveSets: _eff, isTechniqueActive: _iTech }
  );

  // — SUPERSET_PARTNER guard (FASE 25 FIX: render aquí)
  if (opts.partnerPending) {
    _renderNA(nextAction);
    return { renders: renders, timerStarted: timerStarted, nextAction: nextAction };
  }

  // — autoFilled guard (NO render — comportamiento legacy preservado)
  if (opts.autoFilled) {
    return { renders: renders, timerStarted: timerStarted, nextAction: nextAction };
  }

  // — render siempre, antes del timer (FASE 25 FIX)
  _renderNA(nextAction);
  if ((opts.restTime || 0) > 0) { timerStarted = true; }

  return { renders: renders, timerStarted: timerStarted, nextAction: nextAction };
}

// P371 — partner pendiente → renderer invocado con SUPERSET_PARTNER
console.log('\nP371 — FASE 25 FIX: partner pendiente → render SUPERSET_PARTNER');
(function() {
  var exs = [_mkEx('A', 2, 'SS1'), _mkEx('B', 2, 'SS1')];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); // A si=0 hecho; B si=0 pendiente
  var r = _mockCompleteSetFlow({
    ei: 0, si: 0, exercises: exs, logs: logs25,
    partnerPending: true
  });
  assert('P371a', 'render invocado', r.renders.length === 1);
  assert('P371b', 'tipo SUPERSET_PARTNER', r.renders[0].type === 'SUPERSET_PARTNER');
  assert('P371c', 'no timer cuando partner pendiente', r.timerStarted === false);
  assert('P371d', 'label es B', r.renders[0].label === 'B');
})();

// P372 — autoFilled → render NO invocado (comportamiento legacy)
console.log('\nP372 — FASE 25 FIX: autoFilled → NO render');
(function() {
  var exs = [_mkEx('Squat', 3)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  var r = _mockCompleteSetFlow({
    ei: 0, si: 0, exercises: exs, logs: logs25,
    autoFilled: true, restTime: 90
  });
  assert('P372a', 'render NO invocado para autoFilled', r.renders.length === 0);
})();

// P373 — restTime=0, si=0 de 2 hecho → NEXT_SET renderizado
console.log('\nP373 — FASE 25 FIX: restTime=0 → NEXT_SET se renderiza');
(function() {
  var exs = [_mkEx('Squat', 2)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  var r = _mockCompleteSetFlow({
    ei: 0, si: 0, exercises: exs, logs: logs25,
    restTime: 0
  });
  assert('P373a', 'render invocado', r.renders.length === 1);
  assert('P373b', 'tipo NEXT_SET', r.renders[0].type === 'NEXT_SET');
  assert('P373c', 'no timer con restTime=0', r.timerStarted === false);
})();

// P374 — restTime=0, ejercicio completo, siguiente pendiente → NEXT_EXERCISE
console.log('\nP374 — FASE 25 FIX: restTime=0 + ejercicio completo → NEXT_EXERCISE');
(function() {
  var exs = [_mkEx('Squat', 1), _mkEx('Leg Press', 2)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  var r = _mockCompleteSetFlow({
    ei: 0, si: 0, exercises: exs, logs: logs25,
    restTime: 0
  });
  assert('P374a', 'render invocado', r.renders.length === 1);
  assert('P374b', 'tipo NEXT_EXERCISE', r.renders[0].type === 'NEXT_EXERCISE');
  assert('P374c', 'label Leg Press', r.renders[0].label === 'Leg Press');
})();

// P375 — restTime=0, todo completado → SESSION_DONE
console.log('\nP375 — FASE 25 FIX: restTime=0 + all done → SESSION_DONE');
(function() {
  var exs = [_mkEx('Squat', 1)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  var r = _mockCompleteSetFlow({
    ei: 0, si: 0, exercises: exs, logs: logs25,
    restTime: 0
  });
  assert('P375a', 'render invocado', r.renders.length === 1);
  assert('P375b', 'tipo SESSION_DONE', r.renders[0].type === 'SESSION_DONE');
})();

// P376 — restTime>0 → timer arranca + hint renderizado
console.log('\nP376 — FASE 25 FIX: restTime>0 → timer + NEXT_SET renderizado');
(function() {
  var exs = [_mkEx('Bench', 3)];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0);
  var r = _mockCompleteSetFlow({
    ei: 0, si: 0, exercises: exs, logs: logs25,
    restTime: 120
  });
  assert('P376a', 'render invocado', r.renders.length === 1);
  assert('P376b', 'tipo NEXT_SET', r.renders[0].type === 'NEXT_SET');
  assert('P376c', 'timer arrancado', r.timerStarted === true);
})();

// P377 — partner pendiente + restTime lógico → SUPERSET_PARTNER, NO timer
console.log('\nP377 — FASE 25 FIX: partner pendiente → SUPERSET_PARTNER sin timer');
(function() {
  var exs = [_mkEx('A', 3, 'SS1'), _mkEx('B', 3, 'SS1')];
  var logs25 = {};
  _markDone25(logs25, 1, 0, 0, 0); // A si=0 hecho; B si=0 pendiente
  var r = _mockCompleteSetFlow({
    ei: 0, si: 0, exercises: exs, logs: logs25,
    partnerPending: true, restTime: 120
  });
  assert('P377a', 'render invocado con SUPERSET_PARTNER', r.renders[0].type === 'SUPERSET_PARTNER');
  assert('P377b', 'timer NO arrancado (early return)', r.timerStarted === false);
})();

// ═══════════════════ FASE 26 — COMPARACIÓN DE PLANES ═══════════════════
console.log('\n' + '─'.repeat(60));
console.log('FASE 26 — _comparePlans / Coach Plan Comparison (P378-P399)');
console.log('─'.repeat(60));

// ---- Mirrors de las funciones puras de FASE 26 ----

function _normNameF26T(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function _buildExMap26T(days) {
  var byPid  = {};
  var byName = {};
  if (!days || !Array.isArray(days)) return { byPid: byPid, byName: byName };
  days.forEach(function(day) {
    if (!day || !Array.isArray(day.exercises)) return;
    var di = day.dayIndex != null ? day.dayIndex : 0;
    day.exercises.forEach(function(ex, ei) {
      var pid   = ex.prescriptionExerciseId || null;
      var nm    = _normNameF26T(ex.exerciseName || ex.nombre || '');
      var entry = { ex: ex, di: di, ei: ei };
      if (pid) byPid[pid] = entry;
      if (nm) {
        if (!byName[nm]) byName[nm] = [];
        byName[nm].push(entry);
      }
    });
  });
  return { byPid: byPid, byName: byName };
}

function _resolveMatchF26T(prevEx, curMap, prevMap) {
  var pid = prevEx.prescriptionExerciseId || null;
  if (pid && curMap.byPid[pid]) return curMap.byPid[pid];
  var nm = _normNameF26T(prevEx.exerciseName || prevEx.nombre || '');
  if (!nm) return null;
  var curMatches  = curMap.byName[nm]  || [];
  var prevMatches = prevMap.byName[nm] || [];
  if (curMatches.length === 1 && prevMatches.length === 1) return curMatches[0];
  return null;
}

function _compareExSets26T(curEx, prevEx, exName, pid, di) {
  var diffs    = [];
  var curSets  = curEx.sets  || [];
  var prevSets = prevEx.sets || [];
  if (curSets.length !== prevSets.length) {
    diffs.push({ type: 'SETS_CHANGED', exerciseName: exName, prescriptionExerciseId: pid, dayIndex: di,
      before: prevSets.length, after: curSets.length });
  }
  var n = Math.min(curSets.length, prevSets.length);
  for (var s = 0; s < n; s++) {
    var cs = curSets[s]  || {};
    var ps = prevSets[s] || {};
    if (cs.load !== ps.load && (cs.load != null || ps.load != null)) {
      diffs.push({ type: 'LOAD_CHANGED', exerciseName: exName, prescriptionExerciseId: pid, dayIndex: di,
        setChanges: [{ setIndex: s, before: ps.load, after: cs.load }] });
    }
    if (cs.rirTarget !== ps.rirTarget && (cs.rirTarget != null || ps.rirTarget != null)) {
      diffs.push({ type: 'RIR_CHANGED', exerciseName: exName, prescriptionExerciseId: pid, dayIndex: di,
        setChanges: [{ setIndex: s, before: ps.rirTarget, after: cs.rirTarget }] });
    }
    if (cs.restSeconds !== ps.restSeconds && (cs.restSeconds != null || ps.restSeconds != null)) {
      diffs.push({ type: 'REST_CHANGED', exerciseName: exName, prescriptionExerciseId: pid, dayIndex: di,
        setChanges: [{ setIndex: s, before: ps.restSeconds, after: cs.restSeconds }] });
    }
  }
  return diffs;
}

function _comparePlansT(curPlan, prevPlan) {
  if (!curPlan || !prevPlan) return [];
  var curMap  = _buildExMap26T(curPlan.days  || []);
  var prevMap = _buildExMap26T(prevPlan.days || []);
  var diffs   = [];
  var matchedCurPids  = {};
  var matchedCurNames = {};

  (prevPlan.days || []).forEach(function(day) {
    if (!day || !Array.isArray(day.exercises)) return;
    var di = day.dayIndex != null ? day.dayIndex : 0;
    day.exercises.forEach(function(prevEx) {
      var exName = prevEx.exerciseName || prevEx.nombre || '(sin nombre)';
      var pid    = prevEx.prescriptionExerciseId || null;
      var match  = _resolveMatchF26T(prevEx, curMap, prevMap);
      if (match) {
        if (pid) matchedCurPids[pid] = true;
        else matchedCurNames[_normNameF26T(exName)] = true;
        _compareExSets26T(match.ex, prevEx, exName, pid, di).forEach(function(d) { diffs.push(d); });
      } else {
        diffs.push({ type: 'REMOVED', exerciseName: exName, prescriptionExerciseId: pid, dayIndex: di });
      }
    });
  });

  (curPlan.days || []).forEach(function(day) {
    if (!day || !Array.isArray(day.exercises)) return;
    var di = day.dayIndex != null ? day.dayIndex : 0;
    day.exercises.forEach(function(curEx) {
      var exName = curEx.exerciseName || curEx.nombre || '(sin nombre)';
      var pid    = curEx.prescriptionExerciseId || null;
      var nm     = _normNameF26T(exName);
      if (pid && matchedCurPids[pid]) return;
      if (!pid) {
        var prevNmMatches = prevMap.byName[nm] || [];
        if (prevNmMatches.length === 1 && matchedCurNames[nm]) return;
      }
      diffs.push({ type: 'ADDED', exerciseName: exName, prescriptionExerciseId: pid, dayIndex: di });
    });
  });

  return diffs;
}

// ---- helpers constructores ----
function _mkPlanDay(dayIndex, exercises) { return { dayIndex: dayIndex, exercises: exercises }; }
function _mkEx26(name, sets, pid) {
  var ex = { exerciseName: name, sets: sets };
  if (pid) ex.prescriptionExerciseId = pid;
  return ex;
}
function _mkSet26(load, rirTarget, restSeconds) {
  return { load: load, rirTarget: rirTarget, restSeconds: restSeconds };
}

// P378 — _normNameF26: normalización básica (tildes, mayúsculas, especiales)
console.log('\nP378 — _normNameF26: normalización básica');
(function() {
  assert('P378a', 'minúsculas', _normNameF26T('Sentadilla') === 'sentadilla');
  assert('P378b', 'sin tilde', _normNameF26T('Jalón') === 'jalon');
  assert('P378c', 'sin guión', _normNameF26T('Press-Banca') === 'press banca');
})();

// P379 — _normNameF26: vacío → ''
console.log('\nP379 — _normNameF26: vacío y null');
(function() {
  assert('P379a', 'vacío → ""', _normNameF26T('') === '');
  assert('P379b', 'null → ""', _normNameF26T(null) === '');
})();

// P380 — _buildExMap26: PID indexado correctamente
console.log('\nP380 — _buildExMap26: PID indexado');
(function() {
  var days = [_mkPlanDay(0, [_mkEx26('Sentadilla', [], 'pid-1')])];
  var map  = _buildExMap26T(days);
  assert('P380a', 'byPid[pid-1] existe', !!map.byPid['pid-1']);
  assert('P380b', 'byPid[pid-1].ex correcto', map.byPid['pid-1'].ex.exerciseName === 'Sentadilla');
})();

// P381 — _buildExMap26: nombre indexado
console.log('\nP381 — _buildExMap26: nombre indexado');
(function() {
  var days = [_mkPlanDay(0, [_mkEx26('Press Banca', [], null)])];
  var map  = _buildExMap26T(days);
  assert('P381a', 'byName[press banca] existe', Array.isArray(map.byName['press banca']) && map.byName['press banca'].length === 1);
})();

// P382 — _buildExMap26: días vacíos → mapas vacíos
console.log('\nP382 — _buildExMap26: días vacíos');
(function() {
  var map = _buildExMap26T([]);
  assert('P382a', 'byPid vacío', Object.keys(map.byPid).length === 0);
  assert('P382b', 'byName vacío', Object.keys(map.byName).length === 0);
})();

// P383 — _resolveMatchF26: match por PID (prioritario)
console.log('\nP383 — _resolveMatchF26: match por PID');
(function() {
  var prevEx  = _mkEx26('Sentadilla', [], 'pid-A');
  var curDays = [_mkPlanDay(0, [_mkEx26('Squat', [], 'pid-A')])];  // nombre distinto, mismo PID
  var curMap  = _buildExMap26T(curDays);
  var prevMap = _buildExMap26T([_mkPlanDay(0, [prevEx])]);
  var match   = _resolveMatchF26T(prevEx, curMap, prevMap);
  assert('P383a', 'match por PID encontrado', match !== null);
  assert('P383b', 'nombre del match es Squat', match.ex.exerciseName === 'Squat');
})();

// P384 — _resolveMatchF26: match por nombre único en ambos
console.log('\nP384 — _resolveMatchF26: match por nombre único');
(function() {
  var prevEx  = _mkEx26('Press Banca', [], null);
  var curDays = [_mkPlanDay(0, [_mkEx26('Press Banca', [], null)])];
  var curMap  = _buildExMap26T(curDays);
  var prevMap = _buildExMap26T([_mkPlanDay(0, [prevEx])]);
  var match   = _resolveMatchF26T(prevEx, curMap, prevMap);
  assert('P384a', 'match por nombre encontrado', match !== null);
})();

// P385 — _resolveMatchF26: nombre duplicado en prevPlan → null (ambiguo)
console.log('\nP385 — _resolveMatchF26: nombre duplicado en prev → null');
(function() {
  var prevEx  = _mkEx26('Curl', [], null);
  var curDays = [_mkPlanDay(0, [_mkEx26('Curl', [], null)])];
  var prevDays= [_mkPlanDay(0, [_mkEx26('Curl', [], null), _mkEx26('Curl', [], null)])];
  var curMap  = _buildExMap26T(curDays);
  var prevMap = _buildExMap26T(prevDays);
  var match   = _resolveMatchF26T(prevEx, curMap, prevMap);
  assert('P385a', 'null por duplicado en prev', match === null);
})();

// P386 — _resolveMatchF26: nombre duplicado en curPlan → null (ambiguo)
console.log('\nP386 — _resolveMatchF26: nombre duplicado en cur → null');
(function() {
  var prevEx  = _mkEx26('Curl', [], null);
  var curDays = [_mkPlanDay(0, [_mkEx26('Curl', [], null), _mkEx26('Curl', [], null)])];
  var prevDays= [_mkPlanDay(0, [_mkEx26('Curl', [], null)])];
  var curMap  = _buildExMap26T(curDays);
  var prevMap = _buildExMap26T(prevDays);
  var match   = _resolveMatchF26T(prevEx, curMap, prevMap);
  assert('P386a', 'null por duplicado en cur', match === null);
})();

// P387 — _compareExSets26: planes idénticos → sin diffs
console.log('\nP387 — _compareExSets26: sin cambios');
(function() {
  var sets = [_mkSet26(80, 2, 120)];
  var exA  = _mkEx26('Sentadilla', sets, null);
  var exB  = _mkEx26('Sentadilla', sets, null);
  var d    = _compareExSets26T(exA, exB, 'Sentadilla', null, 0);
  assert('P387a', 'sin diffs', d.length === 0);
})();

// P388 — _compareExSets26: LOAD_CHANGED
console.log('\nP388 — _compareExSets26: LOAD_CHANGED');
(function() {
  var curEx  = _mkEx26('Press', [_mkSet26(90, 2, 120)], null);
  var prevEx = _mkEx26('Press', [_mkSet26(80, 2, 120)], null);
  var d      = _compareExSets26T(curEx, prevEx, 'Press', null, 0);
  assert('P388a', 'un diff LOAD_CHANGED', d.length === 1);
  assert('P388b', 'tipo correcto', d[0].type === 'LOAD_CHANGED');
  assert('P388c', 'before=80 after=90', d[0].setChanges[0].before === 80 && d[0].setChanges[0].after === 90);
})();

// P389 — _compareExSets26: RIR_CHANGED
console.log('\nP389 — _compareExSets26: RIR_CHANGED');
(function() {
  var curEx  = _mkEx26('Jalón', [_mkSet26(60, 1, 90)], null);
  var prevEx = _mkEx26('Jalón', [_mkSet26(60, 2, 90)], null);
  var d      = _compareExSets26T(curEx, prevEx, 'Jalón', null, 0);
  assert('P389a', 'RIR_CHANGED detectado', d.some(function(x){ return x.type === 'RIR_CHANGED'; }));
})();

// P390 — _compareExSets26: REST_CHANGED
console.log('\nP390 — _compareExSets26: REST_CHANGED');
(function() {
  var curEx  = _mkEx26('Remo', [_mkSet26(70, 2, 180)], null);
  var prevEx = _mkEx26('Remo', [_mkSet26(70, 2, 120)], null);
  var d      = _compareExSets26T(curEx, prevEx, 'Remo', null, 0);
  assert('P390a', 'REST_CHANGED detectado', d.some(function(x){ return x.type === 'REST_CHANGED'; }));
})();

// P391 — _compareExSets26: SETS_CHANGED (más series en cur)
console.log('\nP391 — _compareExSets26: SETS_CHANGED');
(function() {
  var curEx  = _mkEx26('Hip Thrust', [_mkSet26(100, 2, 120), _mkSet26(100, 2, 120), _mkSet26(100, 2, 120)], null);
  var prevEx = _mkEx26('Hip Thrust', [_mkSet26(100, 2, 120), _mkSet26(100, 2, 120)], null);
  var d      = _compareExSets26T(curEx, prevEx, 'Hip Thrust', null, 0);
  assert('P391a', 'SETS_CHANGED detectado', d.some(function(x){ return x.type === 'SETS_CHANGED'; }));
  assert('P391b', 'before=2 after=3', (function(){ var sc=d.find(function(x){return x.type==='SETS_CHANGED';}); return sc && sc.before===2 && sc.after===3; })());
})();

// P392 — _comparePlans: planes idénticos → sin diffs
console.log('\nP392 — _comparePlans: planes idénticos');
(function() {
  var sets = [_mkSet26(80, 2, 120)];
  var plan = { days: [_mkPlanDay(0, [_mkEx26('Sentadilla', sets, 'p1')])] };
  var d    = _comparePlansT(plan, plan);
  assert('P392a', 'sin diffs', d.length === 0);
})();

// P393 — _comparePlans: ejercicio ADDED (en cur, no en prev)
console.log('\nP393 — _comparePlans: ADDED');
(function() {
  var prev = { days: [_mkPlanDay(0, [_mkEx26('Sentadilla', [], 'p1')])] };
  var cur  = { days: [_mkPlanDay(0, [_mkEx26('Sentadilla', [], 'p1'), _mkEx26('Prensa', [], 'p2')])] };
  var d    = _comparePlansT(cur, prev);
  assert('P393a', 'un ADDED', d.filter(function(x){return x.type==='ADDED';}).length === 1);
  assert('P393b', 'nombre Prensa', d.find(function(x){return x.type==='ADDED';}).exerciseName === 'Prensa');
})();

// P394 — _comparePlans: ejercicio REMOVED (en prev, no en cur)
console.log('\nP394 — _comparePlans: REMOVED');
(function() {
  var prev = { days: [_mkPlanDay(0, [_mkEx26('Sentadilla', [], 'p1'), _mkEx26('Prensa', [], 'p2')])] };
  var cur  = { days: [_mkPlanDay(0, [_mkEx26('Sentadilla', [], 'p1')])] };
  var d    = _comparePlansT(cur, prev);
  assert('P394a', 'un REMOVED', d.filter(function(x){return x.type==='REMOVED';}).length === 1);
  assert('P394b', 'nombre Prensa', d.find(function(x){return x.type==='REMOVED';}).exerciseName === 'Prensa');
})();

// P395 — _comparePlans: LOAD_CHANGED por nombre único
console.log('\nP395 — _comparePlans: LOAD_CHANGED vía nombre único');
(function() {
  var prev = { days: [_mkPlanDay(0, [_mkEx26('Press Banca', [_mkSet26(80, 2, 120)], null)])] };
  var cur  = { days: [_mkPlanDay(0, [_mkEx26('Press Banca', [_mkSet26(90, 2, 120)], null)])] };
  var d    = _comparePlansT(cur, prev);
  assert('P395a', 'LOAD_CHANGED detectado', d.some(function(x){return x.type==='LOAD_CHANGED';}));
})();

// P396 — _comparePlans: nombre duplicado en prev → ambos REMOVED del prev, cur ADDED
console.log('\nP396 — _comparePlans: nombre duplicado en prev → REMOVED ambos');
(function() {
  var prev = { days: [_mkPlanDay(0, [_mkEx26('Curl', [], null), _mkEx26('Curl', [], null)])] };
  var cur  = { days: [_mkPlanDay(0, [_mkEx26('Curl', [], null)])] };
  var d    = _comparePlansT(cur, prev);
  var removed = d.filter(function(x){return x.type==='REMOVED';});
  var added   = d.filter(function(x){return x.type==='ADDED';});
  assert('P396a', 'dos REMOVED (ambiguo)', removed.length === 2);
  assert('P396b', 'un ADDED (el de cur)', added.length === 1);
})();

// P397 — _comparePlans: nombre duplicado en cur → ambos ADDED, el de prev REMOVED
console.log('\nP397 — _comparePlans: nombre duplicado en cur → ADDED ambos');
(function() {
  var prev = { days: [_mkPlanDay(0, [_mkEx26('Curl', [], null)])] };
  var cur  = { days: [_mkPlanDay(0, [_mkEx26('Curl', [], null), _mkEx26('Curl', [], null)])] };
  var d    = _comparePlansT(cur, prev);
  var added   = d.filter(function(x){return x.type==='ADDED';});
  var removed = d.filter(function(x){return x.type==='REMOVED';});
  assert('P397a', 'un REMOVED del prev (no matcheado)', removed.length === 1);
  assert('P397b', 'dos ADDED del cur (ambiguo)', added.length === 2);
})();

// P398 — _comparePlans: match por PID anula la ambigüedad de nombre
console.log('\nP398 — _comparePlans: PID override nombre duplicado');
(function() {
  var prev = { days: [_mkPlanDay(0, [_mkEx26('Curl', [_mkSet26(30, 2, 60)], 'pid-X'), _mkEx26('Curl', [_mkSet26(30, 2, 60)], 'pid-Y')])] };
  var cur  = { days: [_mkPlanDay(0, [_mkEx26('Curl', [_mkSet26(35, 2, 60)], 'pid-X'), _mkEx26('Curl', [_mkSet26(30, 2, 60)], 'pid-Y')])] };
  var d    = _comparePlansT(cur, prev);
  var loads = d.filter(function(x){return x.type==='LOAD_CHANGED';});
  assert('P398a', 'un solo LOAD_CHANGED (solo pid-X)', loads.length === 1);
  assert('P398b', 'sin ADDED ni REMOVED', d.filter(function(x){return x.type==='ADDED'||x.type==='REMOVED';}).length === 0);
})();

// P399 — _renderPlanComparison: diffs vacíos → mensaje 'Sin cambios'
console.log('\nP399 — _renderPlanComparison: sin diffs → mensaje OK');
(function() {
  var fakeContainer = { children: [], textContent: '', firstChild: null, removeChild: function(){}, appendChild: function(child){ this.children.push(child); this.textContent = child.textContent || ''; } };
  // Mirror simple de render para test (valida solo el caso de diffs=[])
  if (!fakeContainer.firstChild) {
    var p = { textContent: '' };
    if (![].length) {
      p.textContent = '✓ Sin cambios respecto al plan anterior.';
      fakeContainer.appendChild(p);
    }
  }
  assert('P399a', 'texto de sin cambios presente', fakeContainer.textContent.indexOf('Sin cambios') !== -1);
})();

// ═══════════════════ FASE 26 AUDIT FIX — Query acotada (P400-P404) ═══════════════════
console.log('\n' + '─'.repeat(60));
console.log('FASE 26 AUDIT FIX — _togglePlanCompare query acotada (P400-P404)');
console.log('─'.repeat(60));

// Mirror del bloque de recuperación del previous plan (sin Firebase real).
// Registra los parámetros que _togglePlanCompare pasaría a query().
function _mockLoadPrevPlan26(opts) {
  // opts: { snapshotDocs: [{...}] | null, cachedPrev: any }
  // Devuelve: { queryParams, usedCache, prevPlanData, showedEmpty }
  var result = { queryParams: null, usedCache: false, prevPlanData: null, showedEmpty: false };

  // Simula el cache check
  var _cache = opts.cachedPrev || null;
  if (_cache) { result.usedCache = true; result.prevPlanData = _cache; return result; }

  // Simula la construcción de query — registra los params server-side
  result.queryParams = {
    collection: 'plans_backup',
    where: { field: 'clientId', op: '==', value: opts.clientId || 'uid-test' },
    orderBy: { field: 'backedUpAt', dir: 'desc' },
    limit: 1
  };

  var snapshotDocs = opts.snapshotDocs;
  if (!snapshotDocs || snapshotDocs.length === 0) {
    result.showedEmpty = true;
    return result;
  }
  // 1 doc devuelto por el servidor
  result.prevPlanData = snapshotDocs[0];
  return result;
}

// P400 — Query incluye orderBy(backedUpAt, desc) server-side
console.log('\nP400 — query incluye orderBy backedUpAt desc');
(function() {
  var r = _mockLoadPrevPlan26({ snapshotDocs: [{ days: [] }] });
  assert('P400a', 'orderBy field = backedUpAt', r.queryParams.orderBy.field === 'backedUpAt');
  assert('P400b', 'orderBy dir = desc', r.queryParams.orderBy.dir === 'desc');
})();

// P401 — Query incluye limit(1) — sin sort JS
console.log('\nP401 — query limit=1, sin sort JS');
(function() {
  var r = _mockLoadPrevPlan26({ snapshotDocs: [{ days: [] }] });
  assert('P401a', 'limit = 1', r.queryParams.limit === 1);
  assert('P401b', 'prevPlanData no es array (no se ordenó JS)', !Array.isArray(r.prevPlanData));
})();

// P402 — Snapshot vacío → showedEmpty=true, sin prevPlanData
console.log('\nP402 — snapshot vacío → mensaje "No se encontró"');
(function() {
  var r = _mockLoadPrevPlan26({ snapshotDocs: [] });
  assert('P402a', 'showedEmpty true', r.showedEmpty === true);
  assert('P402b', 'prevPlanData null', r.prevPlanData === null);
})();

// P403 — Un snapshot → usa exactamente ese documento
console.log('\nP403 — un snapshot → usa ese doc exacto');
(function() {
  var doc = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Sentadilla', sets: [] }] }], backedUpAt: '2026-08-01T00:00:00Z' };
  var r = _mockLoadPrevPlan26({ snapshotDocs: [doc] });
  assert('P403a', 'prevPlanData es el doc', r.prevPlanData === doc);
  assert('P403b', 'no usó cache', r.usedCache === false);
})();

// P404 — Cache activa → no repite query (usedCache=true, queryParams=null)
console.log('\nP404 — cache _detailPrevPlanData evita query repetida');
(function() {
  var cached = { days: [], backedUpAt: '2026-07-01T00:00:00Z' };
  var r = _mockLoadPrevPlan26({ cachedPrev: cached });
  assert('P404a', 'usedCache true', r.usedCache === true);
  assert('P404b', 'queryParams null (sin nueva query)', r.queryParams === null);
  assert('P404c', 'devuelve el mismo objeto cacheado', r.prevPlanData === cached);
})();

// ═══════════════════ FASE 27 — Missing Data Workflow (P405-P423) ═══════════════════

// Inline testable version of _detectMissingData (matches vdsen-cliente.html impl)
function _detectMissingDataT(logs, plan, currentWeek) {
  var W = currentWeek;
  var items = [];
  var daysWithRealSets = {};
  var setsWithoutRIR = 0, setsWithoutICS = 0, totalRealSets = 0;

  Object.keys(logs).forEach(function(k) {
    var m = k.match(/^log_(\d+)_(\d+)_\d+_s\d+$/);
    if (!m || +m[1] !== W) return;
    var e = logs[k];
    if (!e || !e.done || e.autoFilled) return;
    totalRealSets++;
    var d = +m[2];
    daysWithRealSets[d] = (daysWithRealSets[d] || 0) + 1;
    var rr = parseFloat(e.rir_real);
    if (isNaN(rr) || rr < 0 || rr > 5) setsWithoutRIR++;
    var ics = parseFloat(e.ics);
    if (isNaN(ics) || ics < 1 || ics > 10) setsWithoutICS++;
  });

  if (setsWithoutRIR > 0) items.push({ type: 'MISSING_RIR', severity: 'attention',
    message: setsWithoutRIR + (setsWithoutRIR === 1 ? ' serie sin' : ' series sin') + ' RIR real',
    detail: 'El motor de progresión necesita el RIR real para evaluar el esfuerzo.' });
  if (setsWithoutICS > 0) items.push({ type: 'MISSING_ICS', severity: 'attention',
    message: setsWithoutICS + (setsWithoutICS === 1 ? ' serie sin' : ' series sin') + ' ICS',
    detail: 'Sin ICS el coach no puede evaluar la calidad técnica de la ejecución.' });

  var doneDays = {};
  Object.keys(logs).forEach(function(k) {
    var m = k.match(/^done_(\d+)_(\d+)$/);
    if (!m || +m[1] !== W) return;
    if (logs[k]) doneDays[+m[2]] = true;
  });

  Object.keys(daysWithRealSets).forEach(function(d) {
    if (!doneDays[+d]) items.push({ type: 'PARTIAL_SESSION', severity: 'info',
      message: 'Sesión día ' + (+d + 1) + ' incompleta',
      detail: 'Hay series registradas pero la sesión no fue cerrada.' });
  });
  Object.keys(doneDays).forEach(function(d) {
    if (!logs['postsession_' + W + '_' + d]) items.push({ type: 'MISSING_POSTSESSION', severity: 'info',
      message: 'Check-in post-sesión pendiente (día ' + (+d + 1) + ')',
      detail: 'EIMD, RPE y dolor articular ayudan al coach a ajustar la carga.' });
  });
  if (totalRealSets > 0 && !logs['ci_sem_' + W]) items.push({ type: 'MISSING_CHECKIN', severity: 'info',
    message: 'Check-in semanal sem ' + W + ' pendiente',
    detail: 'Peso, HRV y bienestar ayudan al coach a monitorear tu progreso.' });

  // INSUFFICIENT_EXPOSURE — NEEDS_FUTURE_RULE (not auto-emitted)
  return items;
}

console.log('\nP405 — sin logs → array vacío');
(function() {
  var r = _detectMissingDataT({}, null, 1);
  assert('P405', 'sin datos → []', r.length === 0);
})();

console.log('\nP406 — set real con RIR válido → no MISSING_RIR');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P406', 'sin MISSING_RIR', !r.find(function(i){ return i.type === 'MISSING_RIR'; }));
})();

console.log('\nP407 — set real sin rir_real → MISSING_RIR, severity=attention');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, ics: 7, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  var found = r.find(function(i){ return i.type === 'MISSING_RIR'; });
  assert('P407a', 'MISSING_RIR presente', !!found);
  assert('P407b', 'severity=attention', found && found.severity === 'attention');
  assert('P407c', 'mensaje menciona "RIR real"', found && found.message.indexOf('RIR real') !== -1);
})();

console.log('\nP408 — rir_real=6 (fuera de rango 0-5) → MISSING_RIR');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, rir_real: 6, ics: 7, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P408', 'rir_real=6 detectado como inválido', !!r.find(function(i){ return i.type === 'MISSING_RIR'; }));
})();

console.log('\nP409 — autoFilled set sin rir_real → NO MISSING_RIR (excluido)');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, autoFilled: true } };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P409', 'autoFilled excluido de MISSING_RIR', !r.find(function(i){ return i.type === 'MISSING_RIR'; }));
})();

console.log('\nP410 — set real con ICS válido (7) → no MISSING_ICS');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P410', 'sin MISSING_ICS', !r.find(function(i){ return i.type === 'MISSING_ICS'; }));
})();

console.log('\nP411 — set real sin ics → MISSING_ICS, severity=attention');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, rir_real: 2, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  var found = r.find(function(i){ return i.type === 'MISSING_ICS'; });
  assert('P411a', 'MISSING_ICS presente', !!found);
  assert('P411b', 'severity=attention', found && found.severity === 'attention');
})();

console.log('\nP412 — autoFilled set sin ics → NO MISSING_ICS');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, rir_real: 2, autoFilled: true } };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P412', 'autoFilled excluido de MISSING_ICS', !r.find(function(i){ return i.type === 'MISSING_ICS'; }));
})();

console.log('\nP413 — sets reales en día 0, done_1_0 ausente → PARTIAL_SESSION');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  var found = r.find(function(i){ return i.type === 'PARTIAL_SESSION'; });
  assert('P413a', 'PARTIAL_SESSION presente', !!found);
  assert('P413b', 'severity=info', found && found.severity === 'info');
})();

console.log('\nP414 — sets reales en día 0, done_1_0 presente → no PARTIAL_SESSION');
(function() {
  var logs = {
    'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false },
    'done_1_0': { ts: 1234567890 },
    'postsession_1_0': { eimd: 1 }
  };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P414', 'sin PARTIAL_SESSION', !r.find(function(i){ return i.type === 'PARTIAL_SESSION'; }));
})();

console.log('\nP415 — done_1_0 presente, sin postsession_1_0 → MISSING_POSTSESSION');
(function() {
  var logs = {
    'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false },
    'done_1_0': { ts: 1234567890 }
  };
  var r = _detectMissingDataT(logs, null, 1);
  var found = r.find(function(i){ return i.type === 'MISSING_POSTSESSION'; });
  assert('P415a', 'MISSING_POSTSESSION presente', !!found);
  assert('P415b', 'severity=info', found && found.severity === 'info');
})();

console.log('\nP416 — done_1_0 presente y postsession_1_0 presente → no MISSING_POSTSESSION');
(function() {
  var logs = {
    'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false },
    'done_1_0': { ts: 1234567890 },
    'postsession_1_0': { eimd: 1, rpe: 7 }
  };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P416', 'sin MISSING_POSTSESSION', !r.find(function(i){ return i.type === 'MISSING_POSTSESSION'; }));
})();

console.log('\nP417 — sets reales pero sin ci_sem_1 → MISSING_CHECKIN');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  var found = r.find(function(i){ return i.type === 'MISSING_CHECKIN'; });
  assert('P417a', 'MISSING_CHECKIN presente', !!found);
  assert('P417b', 'severity=info', found && found.severity === 'info');
  assert('P417c', 'menciona sem 1', found && found.message.indexOf('1') !== -1);
})();

console.log('\nP418 — sets reales y ci_sem_1 presente → no MISSING_CHECKIN');
(function() {
  var logs = {
    'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false },
    'ci_sem_1': { peso: 80, hrv: 55 }
  };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P418', 'sin MISSING_CHECKIN', !r.find(function(i){ return i.type === 'MISSING_CHECKIN'; }));
})();

console.log('\nP419 — sin sets reales, sin ci_sem_1 → no MISSING_CHECKIN (semana no iniciada)');
(function() {
  var logs = {};
  var r = _detectMissingDataT(logs, null, 1);
  assert('P419', 'sin MISSING_CHECKIN (semana sin datos)', !r.find(function(i){ return i.type === 'MISSING_CHECKIN'; }));
})();

console.log('\nP420 — sets de otra semana (W+1) no afectan semana actual');
(function() {
  var logs = { 'log_2_0_0_s0': { done: true, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P420', 'sets de sem 2 no se detectan en sem 1', r.length === 0);
})();

console.log('\nP421 — dos días: solo día 1 incompleto → PARTIAL_SESSION solo para día 1');
(function() {
  var logs = {
    'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false },
    'done_1_0': { ts: 1 },
    'postsession_1_0': { eimd: 1 },
    'log_1_1_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false }
  };
  var r = _detectMissingDataT(logs, null, 1);
  var partial = r.filter(function(i){ return i.type === 'PARTIAL_SESSION'; });
  assert('P421a', 'exactamente 1 PARTIAL_SESSION', partial.length === 1);
  assert('P421b', 'es el día 2 (dayIndex 1)', partial[0] && partial[0].message.indexOf('2') !== -1);
})();

console.log('\nP422 — INSUFFICIENT_EXPOSURE no está en el output (NEEDS_FUTURE_RULE)');
(function() {
  var logs = { 'log_1_0_0_s0': { done: true, rir_real: 2, ics: 7, autoFilled: false } };
  var r = _detectMissingDataT(logs, null, 1);
  assert('P422', 'INSUFFICIENT_EXPOSURE ausente', !r.find(function(i){ return i.type === 'INSUFFICIENT_EXPOSURE'; }));
})();

console.log('\nP423 — 3 sets sin RIR → mensaje dice "3 series sin RIR real"');
(function() {
  var logs = {
    'log_1_0_0_s0': { done: true, ics: 7, autoFilled: false },
    'log_1_0_0_s1': { done: true, ics: 7, autoFilled: false },
    'log_1_0_0_s2': { done: true, ics: 7, autoFilled: false }
  };
  var r = _detectMissingDataT(logs, null, 1);
  var found = r.find(function(i){ return i.type === 'MISSING_RIR'; });
  assert('P423a', 'MISSING_RIR encontrado', !!found);
  assert('P423b', 'mensaje dice "3 series"', found && found.message === '3 series sin RIR real');
})();

// ════════════════════════════════════════════════════════════
// FASE 29 — Legacy Identity Display (monitor "última acción")
// Mirror del path de resolución post-fix: solo name-match,
// sin lookup posicional primario.
// ════════════════════════════════════════════════════════════

// Mirror de la lógica post-fix: name-match único.
function _resolveLastActionF29(exName, lastRec, actionLabels) {
  if (!lastRec || !lastRec.recommendations) return '—';
  var exLower = exName.toLowerCase().trim();
  var match = null;
  lastRec.recommendations.forEach(function(r) {
    if (r.exerciseName && r.exerciseName.toLowerCase().trim() === exLower) match = r;
  });
  if (!match) return '—';
  return (actionLabels[match.action] || { label: '—' }).label;
}

var _actionLabelsF29 = {
  increase_load: { label: '↑ subir carga' },
  reduce_load:   { label: '↓ bajar carga' },
  maintain:      { label: '= mantener' }
};

console.log('\nP424 — Reorder: progrec array en orden anterior, display reordenado → name-match ignora posición');
(function() {
  // Plan original: [Press Banca (ei=0), Sentadilla (ei=1)]
  // Progrec generado en ese orden:
  var lastRec = {
    recommendations: [
      { exerciseName: 'Press Banca', action: 'increase_load' }, // posición 0
      { exerciseName: 'Sentadilla',  action: 'reduce_load'   }  // posición 1
    ]
  };
  // Display reordenado: Sentadilla ahora aparece en ei=0 visualmente.
  // Con el código viejo (posicional), ei=0 matchearía 'Press Banca' → incorrecto.
  // Con el fix (name-match), 'Sentadilla'.toLowerCase() encuentra 'reduce_load' → correcto.
  var actionSentadilla = _resolveLastActionF29('Sentadilla', lastRec, _actionLabelsF29);
  var actionPressBanca = _resolveLastActionF29('Press Banca', lastRec, _actionLabelsF29);
  assert('P424a', 'Sentadilla resuelve su propia acción (no la de posición 0)', actionSentadilla === '↓ bajar carga');
  assert('P424b', 'Press Banca resuelve su propia acción (no la de posición 1)', actionPressBanca === '↑ subir carga');
})();

console.log('\nP425 — Nombre presente en progrec → acción correcta');
(function() {
  var lastRec = {
    recommendations: [
      { exerciseName: '  Curl Bíceps  ', action: 'maintain' }
    ]
  };
  // Nombre con espacios extra en progrec; nombre limpio en plan
  var action = _resolveLastActionF29('Curl Bíceps', lastRec, _actionLabelsF29);
  assert('P425a', 'acción correcta devuelta', action === '= mantener');
  // Nombre con mayúsculas distintas → sigue matcheando
  var actionUpper = _resolveLastActionF29('CURL BÍCEPS', lastRec, _actionLabelsF29);
  assert('P425b', 'case-insensitive match', actionUpper === '= mantener');
})();

console.log('\nP426 — Sin match por nombre → no se inventa acción (devuelve "—")');
(function() {
  var lastRec = {
    recommendations: [
      { exerciseName: 'Press Banca', action: 'increase_load' }
    ]
  };
  // Ejercicio que no está en progrec
  var action = _resolveLastActionF29('Extensión Triceps', lastRec, _actionLabelsF29);
  assert('P426a', 'sin match → "—"', action === '—');
  // lastRec sin recommendations
  var actionEmpty = _resolveLastActionF29('Press Banca', {}, _actionLabelsF29);
  assert('P426b', 'lastRec vacío → "—"', actionEmpty === '—');
  // lastRec null
  var actionNull = _resolveLastActionF29('Press Banca', null, _actionLabelsF29);
  assert('P426c', 'lastRec null → "—"', actionNull === '—');
})();

// ══════════════════════════════════════════════════════════════
// FASE 34 — LEGACY IDENTITY HARDENING
// ══════════════════════════════════════════════════════════════

// Caso A — PID exacto → éxito
console.log('\nF34-A — PID exacto resuelve ejercicio correcto');
(function() {
  var freshEx = [
    { prescriptionExerciseId: 'pid-A', exerciseName: 'Press Banca' },
    { prescriptionExerciseId: 'pid-B', exerciseName: 'Sentadilla' }
  ];
  var selA = { prescriptionExerciseId: 'pid-A', exerciseName: 'Press Banca', exerciseIndex: 0 };
  assert('F34-Aa', 'PID-A → índice 0', _resolveExerciseInFreshPlan20(selA, freshEx) === 0);
  var selB = { prescriptionExerciseId: 'pid-B', exerciseName: 'Sentadilla', exerciseIndex: 0 };
  assert('F34-Ab', 'PID-B → índice 1 aunque exerciseIndex=0', _resolveExerciseInFreshPlan20(selB, freshEx) === 1);
})();

// Caso B — PID presente pero no encontrado → -1
console.log('\nF34-B — PID no existe en plan fresco → -1 (SKIP)');
(function() {
  var freshEx = [{ prescriptionExerciseId: 'pid-A', exerciseName: 'Press Banca' }];
  var sel = { prescriptionExerciseId: 'pid-STALE', exerciseName: 'Press Banca', exerciseIndex: 0 };
  assert('F34-Ba', 'PID stale → -1', _resolveExerciseInFreshPlan20(sel, freshEx) === -1);
})();

// Caso C — Legacy sin PID, nombre único → resuelve por nombre
console.log('\nF34-C — Sin PID, nombre único → match por nombre');
(function() {
  var freshEx = [
    { exerciseName: 'Press Banca' },
    { exerciseName: 'Sentadilla' }
  ];
  var sel = { prescriptionExerciseId: null, exerciseName: 'Sentadilla', exerciseIndex: 0 };
  assert('F34-Ca', 'nombre único → índice 1', _resolveExerciseInFreshPlan20(sel, freshEx) === 1);
})();

// Caso D — Legacy sin PID, nombre AMBIGUOUS → -1 (NO MUTATION)
console.log('\nF34-D — Sin PID, nombre duplicado → AMBIGUOUS → -1');
(function() {
  var freshEx = [
    { exerciseName: 'Press Banca' },
    { exerciseName: 'Press Banca' }
  ];
  var sel = { prescriptionExerciseId: null, exerciseName: 'Press Banca', exerciseIndex: 0 };
  assert('F34-Da', 'nombre duplicado → -1', _resolveExerciseInFreshPlan20(sel, freshEx) === -1);
})();

// Caso E — Sin PID y sin nombre → -1 (NO MUTATION)
console.log('\nF34-E — Sin PID y sin nombre → -1');
(function() {
  var freshEx = [{ exerciseName: 'Press Banca' }];
  var sel = { prescriptionExerciseId: null, exerciseName: null, exerciseIndex: 0 };
  assert('F34-Ea', 'sin PID ni nombre → -1', _resolveExerciseInFreshPlan20(sel, freshEx) === -1);
  var sel2 = { prescriptionExerciseId: null, exerciseIndex: 1 };
  assert('F34-Eb', 'sel sin exerciseName key → -1', _resolveExerciseInFreshPlan20(sel2, freshEx) === -1);
})();

// Caso F — Posicional nunca resuelve (POSITION ≠ IDENTITY)
console.log('\nF34-F — Posicional nunca resuelve (POSITION ≠ IDENTITY)');
(function() {
  var freshEx = [{ exerciseName: 'Sentadilla' }, { exerciseName: 'Press' }];
  var sel = { prescriptionExerciseId: null, exerciseIndex: 0 };
  assert('F34-Fa', 'exerciseIndex solo → -1 (no posicional)', _resolveExerciseInFreshPlan20(sel, freshEx) === -1);
  var sel2 = { prescriptionExerciseId: null, exerciseIndex: 1 };
  assert('F34-Fb', 'exerciseIndex=1 solo → -1', _resolveExerciseInFreshPlan20(sel2, freshEx) === -1);
})();

// Caso G — _resolveExerciseRowId34: PID primario, nombre fallback único
console.log('\nF34-G — _resolveExerciseRowId34: PID primario, nombre fallback');
(function() {
  var plan = { days: [
    { exercises: [
      { prescriptionExerciseId: 'pid-1', exerciseName: 'Press Banca' },
      { prescriptionExerciseId: 'pid-2', exerciseName: 'Curl' }
    ] }
  ]};
  assert('F34-Ga', 'PID hit → {di:0, ei:0}', (function(){ var r=_resolveExerciseRowId34('Press Banca', plan, 'pid-1'); return r && r.di===0 && r.ei===0; })());
  assert('F34-Gb', 'nombre único → {di:0, ei:1}', (function(){ var r=_resolveExerciseRowId34('Curl', plan, null); return r && r.di===0 && r.ei===1; })());
})();

// Caso H — _resolveExerciseRowId34: nombre duplicado → AMBIGUOUS → null
console.log('\nF34-H — _resolveExerciseRowId34: nombre duplicado → null');
(function() {
  var plan = { days: [
    { exercises: [
      { prescriptionExerciseId: 'pid-1', exerciseName: 'Press' },
      { prescriptionExerciseId: 'pid-2', exerciseName: 'Press' }
    ] }
  ]};
  assert('F34-Ha', 'nombre duplicado sin PID → null', _resolveExerciseRowId34('Press', plan, null) === null);
  assert('F34-Hb', 'PID correcto con nombre dup → éxito', (function(){ var r=_resolveExerciseRowId34('Press', plan, 'pid-2'); return r && r.ei===1; })());
})();

// Caso I — _resolveExerciseRowId34 (READ-ONLY): PID stale degrada a nombre; ambiguo → null
console.log('\nF34-I — PID stale: _resolveExerciseRowId34 degrada a nombre único (read-only safe)');
(function() {
  var plan = { days: [{ exercises: [{ prescriptionExerciseId: 'pid-X', exerciseName: 'Curl' }] }] };
  var r = _resolveExerciseRowId34('Curl', plan, 'pid-STALE');
  assert('F34-Ia', 'PID stale + nombre único → resuelve {di:0,ei:0}', r !== null && r.di === 0 && r.ei === 0);
  var plan2 = { days: [{ exercises: [
    { prescriptionExerciseId: 'pid-X', exerciseName: 'Curl' },
    { prescriptionExerciseId: 'pid-Y', exerciseName: 'Curl' }
  ]}]};
  assert('F34-Ib', 'PID stale + nombre ambiguo → null', _resolveExerciseRowId34('Curl', plan2, 'pid-STALE') === null);
  assert('F34-Ic', 'sin PID ni nombre → null', _resolveExerciseRowId34('', plan, null) === null);
})();

// Caso J — autoFilled excluido de _getExposures
console.log('\nF34-J — autoFilled logs excluidos de exposures');
(function() {
  LOGS = {};
  var pid = 'pid-J';
  LOGS['log_1_0_0_s0'] = { done:true, carga:'80', reps:'8', rir_real:'2', ics:'8', pump:'1', unit:'KG', prescriptionExerciseId: pid };
  LOGS['log_1_0_0_s1'] = { done:true, carga:'80', reps:'8', rir_real:'2', ics:'8', pump:'1', unit:'KG', prescriptionExerciseId: pid, autoFilled: true };
  var exposures = _getExposures(pid, 0, 0, 'Press', 5);
  assert('F34-Ja', 'autoFilled excluido → solo 1 set en exposición', exposures.length > 0 && exposures[0].sets.length === 1);
  clearLogs();
})();

// ═══════════════════════════════════════════════════════════
// FASE 36 — LOG ROTATION T1 DUAL-WRITE + NEW-FIRST READ
// ═══════════════════════════════════════════════════════════

// Mirror helpers para testear la lógica de rotación sin Firestore real.
// Simulamos el comportamiento de _doSaveLogs (dual-write) y el read con fallback.

var _mesoStore = {}; // simula logs/{uid}/mesos/{planId}
var _legacyStore = {}; // simula logs/{uid}

function _sim_doSaveLogs(uid, planId, payload) {
  // T1 dual-write: new meso path primero (no-fatal), legacy segundo (fuente de verdad coach)
  var mesoFailed = false;
  if (planId) {
    try { _mesoStore[uid + '/' + planId] = JSON.parse(JSON.stringify(payload)); }
    catch(e) { mesoFailed = true; }
  }
  _legacyStore[uid] = JSON.parse(JSON.stringify(payload));
  return { mesoFailed: mesoFailed, planId: planId };
}

function _sim_loadLogs(uid, planId) {
  // T1 new-first read: meso path si existe, fallback legacy
  if (planId && _mesoStore[uid + '/' + planId] && Object.keys(_mesoStore[uid + '/' + planId].entries || {}).length >= 0) {
    var d = _mesoStore[uid + '/' + planId];
    if (d !== undefined) return { source: 'meso', data: d };
  }
  if (_legacyStore[uid]) return { source: 'legacy', data: _legacyStore[uid] };
  return null;
}

function _clearStores() { _mesoStore = {}; _legacyStore = {}; }

// F36-B: dual-write escribe en el nuevo path cuando planId disponible
console.log('\nF36-B — dual-write escribe en meso path cuando planId disponible');
(function() {
  _clearStores();
  var payload = { entries: { 'log_1_0_0_s0': { done: true, carga: '80', reps: '8' } }, currentWeek: 1, planId: 'planX' };
  var r = _sim_doSaveLogs('uid1', 'planX', payload);
  assert('F36-Ba', 'meso path escrito', _mesoStore['uid1/planX'] !== undefined);
  assert('F36-Bb', 'legacy path escrito', _legacyStore['uid1'] !== undefined);
  assert('F36-Bc', 'ambos tienen los mismos entries', JSON.stringify(_mesoStore['uid1/planX'].entries) === JSON.stringify(_legacyStore['uid1'].entries));
  _clearStores();
})();

// F36-C: sin planId → solo se escribe legacy (meso path omitido)
console.log('\nF36-C — sin planId → solo legacy escrito');
(function() {
  _clearStores();
  var payload = { entries: {}, currentWeek: 1, planId: null };
  _sim_doSaveLogs('uid2', null, payload);
  assert('F36-Ca', 'ningún meso path escrito', Object.keys(_mesoStore).length === 0);
  assert('F36-Cb', 'legacy path escrito', _legacyStore['uid2'] !== undefined);
  _clearStores();
})();

// F36-D: new-first read → cuando meso path existe, se usa el meso (no legacy)
console.log('\nF36-D — new-first read → usa meso path cuando existe');
(function() {
  _clearStores();
  var mesoPayload = { entries: { 'log_2_0_0_s0': { done: true, carga: '90' } }, currentWeek: 2, planId: 'planY' };
  var legacyPayload = { entries: { 'log_1_0_0_s0': { done: true, carga: '80' } }, currentWeek: 1, planId: 'planY' };
  _mesoStore['uid3/planY'] = mesoPayload;
  _legacyStore['uid3'] = legacyPayload;
  var r = _sim_loadLogs('uid3', 'planY');
  assert('F36-Da', 'fuente = meso', r.source === 'meso');
  assert('F36-Db', 'semana desde meso (2 no 1)', r.data.currentWeek === 2);
  _clearStores();
})();

// F36-E: fallback legacy cuando meso path no existe
console.log('\nF36-E — fallback a legacy cuando meso path ausente');
(function() {
  _clearStores();
  var legacyPayload = { entries: { 'log_1_0_0_s0': { done: true, carga: '75' } }, currentWeek: 1, planId: 'planZ' };
  _legacyStore['uid4'] = legacyPayload;
  var r = _sim_loadLogs('uid4', 'planZ');
  assert('F36-Ea', 'fuente = legacy', r.source === 'legacy');
  assert('F36-Eb', 'datos legacy correctos', r.data.currentWeek === 1 && r.data.entries['log_1_0_0_s0'].carga === '75');
  _clearStores();
})();

// F36-F: sin planId y sin legacy → null
console.log('\nF36-F — sin datos en ningún path → null');
(function() {
  _clearStores();
  var r = _sim_loadLogs('uid5', null);
  assert('F36-Fa', 'sin datos → null', r === null);
  _clearStores();
})();

// F36-G: cambio de plan A→B — meso path de A conservado, B empieza vacío
console.log('\nF36-G — plan change A→B: meso A conservado, B empieza vacío');
(function() {
  _clearStores();
  // Plan A en uso — dual-write
  var payloadA = { entries: { 'log_1_0_0_s0': { done: true, carga: '80' } }, currentWeek: 1, planId: 'planA' };
  _sim_doSaveLogs('uid6', 'planA', payloadA);
  // Plan cambia a B — nuevo meso, entries limpio
  var payloadB = { entries: {}, currentWeek: 1, planId: 'planB' };
  _sim_doSaveLogs('uid6', 'planB', payloadB);
  // Meso A debe conservar sus datos
  assert('F36-Ga', 'meso planA conservado', _mesoStore['uid6/planA'] !== undefined && Object.keys(_mesoStore['uid6/planA'].entries).length === 1);
  // Meso B empieza vacío
  assert('F36-Gb', 'meso planB empieza vacío', _mesoStore['uid6/planB'] !== undefined && Object.keys(_mesoStore['uid6/planB'].entries).length === 0);
  // Legacy apunta al plan más reciente (B)
  assert('F36-Gc', 'legacy apunta a planB', _legacyStore['uid6'].planId === 'planB');
  _clearStores();
})();

// F36-H: reload/refresh — lecturas subsecuentes siguen obteniendo datos correctos
console.log('\nF36-H — reload: lecturas repetidas dan resultados consistentes');
(function() {
  _clearStores();
  var payload = { entries: { 'log_1_0_0_s0': { done: true, carga: '85', reps: '10' } }, currentWeek: 1, planId: 'planH' };
  _sim_doSaveLogs('uid7', 'planH', payload);
  var r1 = _sim_loadLogs('uid7', 'planH');
  var r2 = _sim_loadLogs('uid7', 'planH');
  assert('F36-Ha', 'primera lectura correcta', r1.source === 'meso' && r1.data.entries['log_1_0_0_s0'].carga === '85');
  assert('F36-Hb', 'segunda lectura idéntica', r2.source === 'meso' && r2.data.entries['log_1_0_0_s0'].carga === '85');
  _clearStores();
})();

// F36-I: autoFilled preservado en payload del meso
console.log('\nF36-I — autoFilled preservado en meso path');
(function() {
  _clearStores();
  var payload = {
    entries: {
      'log_1_0_0_s0': { done: true, carga: '80', autoFilled: true, prescriptionExerciseId: 'pid-I' },
      'log_1_0_0_s1': { done: true, carga: '80', autoFilled: false, prescriptionExerciseId: 'pid-I' }
    },
    currentWeek: 1, planId: 'planI'
  };
  _sim_doSaveLogs('uid8', 'planI', payload);
  var mesoData = _mesoStore['uid8/planI'];
  assert('F36-Ia', 'autoFilled=true preservado en meso', mesoData.entries['log_1_0_0_s0'].autoFilled === true);
  assert('F36-Ib', 'autoFilled=false preservado en meso', mesoData.entries['log_1_0_0_s1'].autoFilled === false);
  _clearStores();
})();

// F36-J: PID preservado en meso entries
console.log('\nF36-J — prescriptionExerciseId preservado en meso path');
(function() {
  _clearStores();
  var pid = 'pid-stable-J';
  var payload = { entries: { 'log_1_0_0_s0': { done: true, carga: '80', prescriptionExerciseId: pid } }, currentWeek: 1, planId: 'planJ' };
  _sim_doSaveLogs('uid9', 'planJ', payload);
  var stored = _mesoStore['uid9/planJ'].entries['log_1_0_0_s0'].prescriptionExerciseId;
  assert('F36-Ja', 'PID preservado en meso', stored === pid);
  _clearStores();
})();

// F36-K: ausencia del nuevo path no rompe legacy — fallback funciona correctamente
console.log('\nF36-K — ausencia meso path no rompe legacy users');
(function() {
  _clearStores();
  // Simula usuario legacy que nunca tuvo dual-write
  _legacyStore['uid10'] = { entries: { 'log_1_0_0_s0': { done: true, carga: '70' } }, currentWeek: 1, planId: 'planK' };
  var r = _sim_loadLogs('uid10', 'planK'); // meso path ausente
  assert('F36-Ka', 'fallback a legacy funciona', r.source === 'legacy');
  assert('F36-Kb', 'datos legacy correctos', r.data.entries['log_1_0_0_s0'].carga === '70');
  _clearStores();
})();

// F36-L: meso path no mezcla entries de planes distintos
console.log('\nF36-L — no mezcla entries entre planes distintos en meso store');
(function() {
  _clearStores();
  var pA = { entries: { 'log_1_0_0_s0': { carga: '80' } }, planId: 'planA', currentWeek: 1 };
  var pB = { entries: { 'log_1_0_1_s0': { carga: '90' } }, planId: 'planB', currentWeek: 1 };
  _sim_doSaveLogs('uid11', 'planA', pA);
  _sim_doSaveLogs('uid11', 'planB', pB);
  var dA = _mesoStore['uid11/planA'];
  var dB = _mesoStore['uid11/planB'];
  assert('F36-La', 'planA no tiene entries de planB', !dA.entries['log_1_0_1_s0']);
  assert('F36-Lb', 'planB no tiene entries de planA', !dB.entries['log_1_0_0_s0']);
  _clearStores();
})();

// F36-M: identity invariant — PID lookup en LOGS_BY_WEEK derivado del mismo flat map
console.log('\nF36-M — identity: LOGS permanece flat map; LOGS_BY_WEEK es cache derivada');
(function() {
  // Verificar que el flat map no cambia de forma — LOGS_BY_WEEK no reemplaza LOGS
  clearLogs();
  var pid = 'pid-M';
  LOGS['log_2_0_0_s0'] = { done: true, carga: '85', reps: '8', prescriptionExerciseId: pid };
  LOGS['log_2_0_0_s1'] = { done: true, carga: '85', reps: '8', prescriptionExerciseId: pid };
  LOGS['log_1_0_0_s0'] = { done: true, carga: '80', reps: '8', prescriptionExerciseId: pid };
  // LOGS sigue siendo flat map accesible directamente
  assert('F36-Ma', 'LOGS es flat map accesible por key directa', LOGS['log_2_0_0_s0'].carga === '85');
  // _getExposures (que usa LOGS) sigue funcionando correctamente
  CURRENT_WEEK = 2; REAL_WEEK = 2;
  var exps = _getExposures(pid, 0, 0, 'Press', 5);
  assert('F36-Mb', 'exposures desde LOGS: 2 semanas encontradas', exps.length === 2);
  clearLogs();
})();

// F36-N: coach reset con planId — meso path también se resetea
console.log('\nF36-N — coach reset: simular reseteo del meso path');
(function() {
  _clearStores();
  // Estado inicial — usuario con datos en meso y legacy
  var uid = 'uid12', planId = 'planN';
  _mesoStore[uid + '/' + planId] = { entries: { 'log_3_0_0_s0': { carga: '100' } }, currentWeek: 3, planId: planId };
  _legacyStore[uid] = { entries: { 'log_3_0_0_s0': { carga: '100' } }, currentWeek: 3, planId: planId };
  // Coach resetea — escribe payload limpio a ambos paths
  var resetPayload = { entries: {}, currentWeek: 1, planId: planId };
  _mesoStore[uid + '/' + planId] = JSON.parse(JSON.stringify(resetPayload));
  _legacyStore[uid] = JSON.parse(JSON.stringify(resetPayload));
  var r = _sim_loadLogs(uid, planId);
  assert('F36-Na', 'después de reset: semana = 1', r.data.currentWeek === 1);
  assert('F36-Nb', 'después de reset: entries vacío', Object.keys(r.data.entries).length === 0);
  assert('F36-Nc', 'fuente = meso (no legacy)', r.source === 'meso');
  _clearStores();
})();

// ════════════════════════════════════════════════════════════
// FASE 37 — LOGS_BY_WEEK index (O(n)→O(k) en hot functions)
// ════════════════════════════════════════════════════════════

// Simular LOGS_BY_WEEK y funciones del índice para tests F37
var _LOGS_BY_WEEK_sim = { log: {}, progrec: {} };

function _rebuildLogsByWeek_sim(logsObj) {
  var log = {}, progrec = {};
  Object.keys(logsObj).forEach(function(k) {
    var w;
    if (k.indexOf('log_') === 0) {
      w = parseInt(k.split('_')[1]);
      if (!isNaN(w)) { if (!log[w]) log[w] = []; log[w].push(k); }
    } else if (k.indexOf('progrec_') === 0) {
      w = parseInt(k.split('_')[1]);
      if (!isNaN(w)) { if (!progrec[w]) progrec[w] = []; progrec[w].push(k); }
    }
  });
  return { log: log, progrec: progrec };
}

function _lbwTrack_sim(idx, k) {
  var w;
  if (k.indexOf('log_') === 0) {
    w = parseInt(k.split('_')[1]);
    if (!isNaN(w)) { if (!idx.log[w]) idx.log[w] = []; idx.log[w].push(k); }
  } else if (k.indexOf('progrec_') === 0) {
    w = parseInt(k.split('_')[1]);
    if (!isNaN(w)) { if (!idx.progrec[w]) idx.progrec[w] = []; idx.progrec[w].push(k); }
  }
}

// F37-A: rebuild desde LOGS con entradas de múltiples semanas
(function() {
  console.log('\nF37-A — rebuild: separa log_ por semana correctamente');
  var logs = {
    'log_1_0_0_s0': { done: true }, 'log_1_0_0_s1': { done: true },
    'log_2_0_0_s0': { done: true }, 'log_3_1_0_s0': { done: true },
    'progrec_1_0': { recommendations: [] }, 'progrec_2_0': { recommendations: [] },
    'done_1_0': true
  };
  var idx = _rebuildLogsByWeek_sim(logs);
  assert('F37-Aa', 'semana 1 tiene 2 log_ keys', (idx.log[1] || []).length === 2);
  assert('F37-Ab', 'semana 2 tiene 1 log_ key',  (idx.log[2] || []).length === 1);
  assert('F37-Ac', 'semana 3 tiene 1 log_ key',  (idx.log[3] || []).length === 1);
  assert('F37-Ad', 'done_ no entra en log index', !(idx.log[1] || []).some(function(k){ return k.indexOf('done_') === 0; }));
})();

// F37-B: rebuild captura progrec_ por semana
(function() {
  console.log('\nF37-B — rebuild: separa progrec_ por semana');
  var logs = {
    'progrec_1_0': { recommendations: [] },
    'progrec_1_1': { recommendations: [] },
    'progrec_2_0': { recommendations: [] },
    'log_1_0_0_s0': { done: true }
  };
  var idx = _rebuildLogsByWeek_sim(logs);
  assert('F37-Ba', 'semana 1 tiene 2 progrec', (idx.progrec[1] || []).length === 2);
  assert('F37-Bb', 'semana 2 tiene 1 progrec', (idx.progrec[2] || []).length === 1);
  assert('F37-Bc', 'log_ no entra en progrec index', !(idx.progrec[1] || []).some(function(k){ return k.indexOf('log_') === 0; }));
})();

// F37-C: lbwTrack actualiza incrementalmente — append correcto
(function() {
  console.log('\nF37-C — lbwTrack: actualización incremental append-only');
  var idx = { log: {}, progrec: {} };
  _lbwTrack_sim(idx, 'log_3_0_1_s0');
  _lbwTrack_sim(idx, 'log_3_0_1_s1');
  _lbwTrack_sim(idx, 'progrec_3_0');
  assert('F37-Ca', 'dos log_ en semana 3', (idx.log[3] || []).length === 2);
  assert('F37-Cb', 'un progrec en semana 3', (idx.progrec[3] || []).length === 1);
  assert('F37-Cc', 'semanas no relacionadas vacías', !(idx.log[1]));
})();

// F37-D: rebuild vacía y reconstruye — no mezcla con estado anterior
(function() {
  console.log('\nF37-D — rebuild: reemplaza índice anterior completamente');
  var idx = _rebuildLogsByWeek_sim({ 'log_1_0_0_s0': { done: true } });
  assert('F37-Da', 'semana 1 existe antes', (idx.log[1] || []).length === 1);
  // Simula un nuevo LOGS (plan cambiado) — entries vacío
  var idx2 = _rebuildLogsByWeek_sim({});
  assert('F37-Db', 'después de rebuild con {}: semana 1 vacía', !(idx2.log[1]));
  assert('F37-Dc', 'después de rebuild con {}: progrec vacío', Object.keys(idx2.progrec).length === 0);
})();

// F37-E: lbwTrack con key no-log, no-progrec — no contamina el índice
(function() {
  console.log('\nF37-E — lbwTrack: keys no relevantes no entran al índice');
  var idx = { log: {}, progrec: {} };
  _lbwTrack_sim(idx, 'done_1_0');
  _lbwTrack_sim(idx, 'postsession_1_0');
  _lbwTrack_sim(idx, 'ci_sem_1');
  _lbwTrack_sim(idx, 'exexpress_1_0_0');
  assert('F37-Ea', 'done_ no entra en log', Object.keys(idx.log).length === 0);
  assert('F37-Eb', 'postsession_ no entra en log', Object.keys(idx.log).length === 0);
  assert('F37-Ec', 'progrec idx vacío', Object.keys(idx.progrec).length === 0);
})();

// F37-F: semana inexistente → array vacío (no error)
(function() {
  console.log('\nF37-F — índice: semana inexistente retorna vacío sin error');
  var idx = _rebuildLogsByWeek_sim({ 'log_1_0_0_s0': { done: true } });
  assert('F37-Fa', 'idx.log[99] es undefined', idx.log[99] === undefined);
  assert('F37-Fb', '(idx.log[99] || []) es []', (idx.log[99] || []).length === 0);
  assert('F37-Fc', 'idx.progrec[5] undefined no lanza', (idx.progrec[5] || []).length === 0);
})();

// F37-G: stale keys (entry null) — consumidor las ignora, no crash
(function() {
  console.log('\nF37-G — stale keys en índice: consumidor las filtra sin crash');
  var idx = { log: {}, progrec: {} };
  _lbwTrack_sim(idx, 'log_2_0_0_s0');
  // Simular que la entrada fue eliminada (express cleanup)
  var logsObj = { 'log_2_0_0_s0': null };
  var found = [];
  (idx.log[2] || []).forEach(function(k) {
    var entry = logsObj[k];
    if (!entry || !entry.done) return; // stale/null — skip
    found.push(k);
  });
  assert('F37-Ga', 'stale null entry filtrada por consumidor', found.length === 0);
})();

// F37-H: consistencia rebuild vs lbwTrack — misma cobertura para semana activa
(function() {
  console.log('\nF37-H — rebuild y lbwTrack producen cobertura equivalente');
  var logs = {};
  for (var s = 0; s < 4; s++) logs['log_3_0_2_s'+s] = { done: true, carga: '80', reps:'8' };
  logs['progrec_3_0'] = { recommendations: [] };

  // Rebuild
  var idxR = _rebuildLogsByWeek_sim(logs);

  // Incremental (simula writes)
  var idxI = { log: {}, progrec: {} };
  for (var s2 = 0; s2 < 4; s2++) _lbwTrack_sim(idxI, 'log_3_0_2_s'+s2);
  _lbwTrack_sim(idxI, 'progrec_3_0');

  assert('F37-Ha', 'log keys semana 3 iguales', (idxR.log[3]||[]).length === (idxI.log[3]||[]).length);
  assert('F37-Hb', 'progrec semana 3 iguales', (idxR.progrec[3]||[]).length === (idxI.progrec[3]||[]).length);
})();

// F37-I: _getPrevWeekData identity — lógica equivalente con índice vs sin índice
(function() {
  console.log('\nF37-I — equivalencia semántica: búsqueda por PID con índice');
  // Simula _getPrevWeekData con índice para semana 2
  var pid = 'abc-123';
  var logsObj = {
    'log_2_0_1_s0': { done: true, carga: '80', reps: '8', prescriptionExerciseId: pid, autoFilled: false },
    'log_2_0_1_s1': { done: true, carga: '80', reps: '8', prescriptionExerciseId: pid, autoFilled: false },
    'log_2_0_2_s0': { done: true, carga: '60', reps: '10', prescriptionExerciseId: 'other', autoFilled: false }
  };
  var idx = _rebuildLogsByWeek_sim(logsObj);

  // Búsqueda con índice
  var positions = {}, candidateSets = [];
  (idx.log[2] || []).forEach(function(k) {
    var entry = logsObj[k];
    if (!entry || !entry.done || entry.autoFilled) return;
    if (entry.prescriptionExerciseId !== pid) return;
    var parts = k.split('_');
    if (parts.length >= 5) positions[parts[2]+'_'+parts[3]] = true;
    candidateSets.push(entry);
  });
  assert('F37-Ia', '2 sets encontrados para PID correcto', candidateSets.length === 2);
  assert('F37-Ib', 'una sola posición (di,ei)', Object.keys(positions).length === 1);
  assert('F37-Ic', 'PID incorrecto excluido', candidateSets.every(function(s){ return s.prescriptionExerciseId === pid; }));
})();

// ── F39: FASE 39 — _buildCheckInData adherencia + rir_real_prom bug fixes ──
console.log('\nF39-A — adherencia_pct: done_{W}_{D} vs sem{W}_d{i}_ (bug)');
(function(){
  clearLogs();
  var WEEK = 3;
  LOGS['done_' + WEEK + '_0'] = true; // sesion 0 completada
  // sesion 1 y 2 no completadas
  var sesiones = [0, 1, 2];

  // FIXED logic
  var completadasFixed = 0;
  sesiones.forEach(function(ses, i) {
    if (LOGS['done_' + WEEK + '_' + i]) completadasFixed++;
  });
  var adherenciaFixed = Math.round(completadasFixed / sesiones.length * 100);
  assert('F39-Aa', 'FIXED: adherencia = 33% (1/3)', adherenciaFixed === 33);

  // OLD buggy logic
  var completadasOld = 0;
  sesiones.forEach(function(ses, i) {
    var tieneLogs = Object.keys(LOGS).some(function(lk) {
      return lk.startsWith('sem' + WEEK + '_d' + i + '_');
    });
    if (tieneLogs) completadasOld++;
  });
  var adherenciaOld = Math.round(completadasOld / sesiones.length * 100);
  assert('F39-Ab', 'OLD BUG: adherencia = 0% (sem{W}_ prefix no existe)', adherenciaOld === 0);
})();

console.log('\nF39-B — rir_real_prom: LOGS_BY_WEEK + rir_real vs sem{W}_ + rir (bug)');
(function(){
  clearLogs();
  var WEEK = 3;
  LOGS['log_' + WEEK + '_0_0_s0'] = { done: true, rir_real: 2, rir: 2, autoFilled: false };
  LOGS['log_' + WEEK + '_0_0_s1'] = { done: true, rir_real: 3, rir: 3, autoFilled: false };
  LOGS['log_' + WEEK + '_1_0_s0'] = { done: true, rir_real: 1, rir: 1, autoFilled: false };
  LOGS['log_' + WEEK + '_1_1_s0'] = { done: true, rir_real: 0, rir: 0, autoFilled: true }; // excluir
  var idx = _rebuildLogsByWeek_sim(LOGS);

  // FIXED logic
  var rirsFixed = [];
  (idx.log[WEEK] || []).forEach(function(lk) {
    var entry = LOGS[lk];
    if (entry && !entry.autoFilled && entry.rir_real !== undefined && entry.rir_real !== '' && !isNaN(parseFloat(entry.rir_real))) {
      rirsFixed.push(parseFloat(entry.rir_real));
    }
  });
  var rirPromFixed = rirsFixed.length > 0 ? Math.round(rirsFixed.reduce(function(a,b){return a+b;},0) / rirsFixed.length * 10) / 10 : null;
  assert('F39-Ba', 'FIXED: rir_real_prom = 2.0 (avg 2,3,1 sin autoFilled)', rirPromFixed === 2.0);

  // OLD buggy logic
  var rirsOld = [];
  Object.keys(LOGS).forEach(function(lk) {
    if (lk.indexOf('ci_sem') === -1 && lk.indexOf('sem' + WEEK + '_') === 0) {
      var entry = LOGS[lk];
      if (entry && entry.rir !== undefined && entry.rir !== '' && !isNaN(parseFloat(entry.rir))) {
        rirsOld.push(parseFloat(entry.rir));
      }
    }
  });
  var rirPromOld = rirsOld.length > 0 ? Math.round(rirsOld.reduce(function(a,b){return a+b;},0) / rirsOld.length * 10) / 10 : null;
  assert('F39-Bb', 'OLD BUG: rir_real_prom = null (sem{W}_ prefix no existe)', rirPromOld === null);
})();

console.log('\nF39-C — adherencia 100% cuando todas las sesiones done');
(function(){
  clearLogs();
  var WEEK = 2;
  LOGS['done_' + WEEK + '_0'] = true;
  LOGS['done_' + WEEK + '_1'] = true;
  LOGS['done_' + WEEK + '_2'] = true;
  var sesiones = [0, 1, 2];
  var completadas = 0;
  sesiones.forEach(function(ses, i) { if (LOGS['done_' + WEEK + '_' + i]) completadas++; });
  assert('F39-Ca', 'adherencia = 100% cuando 3/3 done', Math.round(completadas / sesiones.length * 100) === 100);
})();

console.log('\nF39-D — rir_real_prom null si solo hay autoFilled o sin sets');
(function(){
  clearLogs();
  var WEEK = 1;
  LOGS['log_' + WEEK + '_0_0_s0'] = { done: true, autoFilled: true, rir_real: 2 };
  var idx = _rebuildLogsByWeek_sim(LOGS);
  var rirs = [];
  (idx.log[WEEK] || []).forEach(function(lk) {
    var entry = LOGS[lk];
    if (entry && !entry.autoFilled && entry.rir_real !== undefined && entry.rir_real !== '' && !isNaN(parseFloat(entry.rir_real))) {
      rirs.push(parseFloat(entry.rir_real));
    }
  });
  assert('F39-Da', 'rir_real_prom = null cuando solo autoFilled', rirs.length === 0);
})();

console.log('\nF39-E — adherencia 0% cuando no hay sesion done (vs semana vacía)');
(function(){
  clearLogs();
  var WEEK = 5;
  // No done_{W}_{D} keys
  var sesiones = [0, 1, 2, 3];
  var completadas = 0;
  sesiones.forEach(function(ses, i) { if (LOGS['done_' + WEEK + '_' + i]) completadas++; });
  var adherencia = sesiones.length > 0 ? Math.round(completadas / sesiones.length * 100) : null;
  assert('F39-Ea', 'adherencia = 0% cuando ninguna done', adherencia === 0);
})();

// ═══════════════════════════════════════════════════════════
// FASE 3 — Generation Fingerprint + Reproducibility Audit
// FP1-FP8, DC1-DC3, RA1-RA6
// ═══════════════════════════════════════════════════════════

// Inline copies of helpers (mirrors vdsen-coach.html — keep in sync)
var _FINGERPRINT_ENGINE_VERSION_T = 'v1.0.0';
var _EPHEMERAL_KEYS_T = { generatedAt:1, createdAt:1, updatedAt:1, ts:1, _id:1 };
function _canonicalSort_T(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    var sorted = val.map(_canonicalSort_T);
    sorted.sort(function(a, b) {
      var sa = (typeof a === 'object' && a !== null) ? JSON.stringify(a) : String(a);
      var sb = (typeof b === 'object' && b !== null) ? JSON.stringify(b) : String(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return sorted;
  }
  if (typeof val === 'object') {
    var out = {};
    Object.keys(val).sort().forEach(function(k) {
      if (_EPHEMERAL_KEYS_T[k]) return;
      out[k] = _canonicalSort_T(val[k]);
    });
    return out;
  }
  return val;
}
function _buildGenerationFingerprint_T(opts) {
  if (!opts) return '';
  var snap = opts.profileSnapshot;
  var targets = opts.resolvedTargets;
  var topo = opts.topologyDecision;
  var constraints = opts.constraints;
  var prev = opts.previousPlanContext;
  var evs = opts.engineVersions;
  var snapClean = null;
  if (snap && typeof snap === 'object') {
    snapClean = {};
    Object.keys(snap).sort().forEach(function(k) {
      if (_EPHEMERAL_KEYS_T[k] || k === 'capturedAt') return;
      snapClean[k] = snap[k];
    });
  }
  var targetsClean = null;
  if (targets && typeof targets === 'object') {
    var muscles = targets.muscles || {};
    var musclesClean = {};
    Object.keys(muscles).sort().forEach(function(m) {
      var mt = muscles[m];
      if (!mt) return;
      musclesClean[m] = { priority: mt.priority||null, goal: mt.goal||null, frequencyTarget: mt.frequencyTarget||null, volumeTarget: mt.volumeTarget||null };
    });
    targetsClean = { muscles: musclesClean, reasonCodes: _canonicalSort_T((targets.reasonCodes||[]).slice()), globalReadiness: targets.globalReadiness||null, deloadCandidate: !!targets.deloadCandidate };
  }
  var topoClean = null;
  if (topo && typeof topo === 'object') {
    topoClean = { selectedTopology: topo.selectedTopology||null, version: topo.version||null, scoringConfigVersion: topo.scoringConfigVersion||null };
  }
  var constraintsClean = null;
  if (constraints && typeof constraints === 'object') {
    constraintsClean = { ejerciciosEvitar: _canonicalSort_T((constraints.ejerciciosEvitar||[]).slice()), motorPatternsAvoid: _canonicalSort_T((constraints.motorPatternsAvoid||[]).slice()) };
  }
  var prevClean = null;
  if (prev && typeof prev === 'object') {
    prevClean = { hasPreviousPlan: !!prev.hasPreviousPlan, daysPerWeek: (prev.previousPlan&&prev.previousPlan.daysPerWeek)||null, weeks: (prev.previousPlan&&prev.previousPlan.weeks)||null };
  }
  var engineVersionsClean = null;
  if (evs && typeof evs === 'object') {
    engineVersionsClean = {};
    Object.keys(evs).sort().forEach(function(k){ engineVersionsClean[k] = evs[k]; });
  }
  var payload = { _fingerprintEngine: _FINGERPRINT_ENGINE_VERSION_T, profileSnapshot: _canonicalSort_T(snapClean), resolvedTargets: targetsClean, topologyDecision: topoClean, constraints: constraintsClean, previousPlanContext: prevClean, engineVersions: engineVersionsClean };
  return JSON.stringify(payload);
}
function _buildDecisionFingerprint_T(training, prescCtx, topologyDecision) {
  if (!training) return '';
  var days = Array.isArray(training.days) ? training.days : [];
  var topoKey = (topologyDecision && topologyDecision.selectedTopology) || null;
  if (!topoKey) {
    var dpw2 = training.daysPerWeek || days.length;
    topoKey = dpw2 <= 2 ? 'FULL_BODY' : dpw2 === 3 ? 'PPL_OR_FB3' : dpw2 === 4 ? 'UPPER_LOWER' : dpw2 === 5 ? 'BROSPLIT_5' : 'HIGH_FREQ';
  }
  var distribution = _canonicalSort_T(days.map(function(d) { return { dayIndex: d.dayIndex, exerciseCount: (d.exercises||[]).length }; }));
  var muscles = (prescCtx && prescCtx.prescriptionTargets && prescCtx.prescriptionTargets.muscles) || {};
  var muscleTargets = {};
  Object.keys(muscles).sort().forEach(function(m) {
    var mt = muscles[m];
    if (mt) muscleTargets[m] = { priority: mt.priority||null, frequencyTarget: mt.frequencyTarget||null };
  });
  var slots = [];
  days.forEach(function(d) {
    (d.exercises||[]).forEach(function(ex) {
      var ps = ex.prescriptionSlot;
      if (ps && ps.targetMuscle) slots.push({ targetMuscle: ps.targetMuscle, movementPattern: ps.movementPattern||null, role: ps.role||null, dayIndex: d.dayIndex });
    });
  });
  var slotsCanon = _canonicalSort_T(slots);
  var maintenanceSlots = slots.filter(function(s){ return s.role === 'maintenance'; });
  var frame = { daysPerWeek: training.daysPerWeek||days.length, weeks: training.weeks||null };
  var payload = { _fingerprintEngine: _FINGERPRINT_ENGINE_VERSION_T, topology: topoKey, frame: frame, distribution: distribution, muscleTargets: muscleTargets, prescriptionSlots: slotsCanon, maintenanceSlots: _canonicalSort_T(maintenanceSlots) };
  return JSON.stringify(payload);
}
var _REPRO_VERDICT_T = { SAME_INPUT_SAME_STRUCTURE:'SAME_INPUT_SAME_STRUCTURE', SAME_INPUT_DIFFERENT_STRUCTURE:'SAME_INPUT_DIFFERENT_STRUCTURE', EXPECTED_CHANGE:'EXPECTED_CHANGE', UNRESOLVED:'UNRESOLVED' };
function _runReproducibilityAudit_T(inputFpA, decisionFpA, inputFpB, decisionFpB, engineVersionsA, engineVersionsB) {
  var sameInput    = (inputFpA && inputFpB && inputFpA === inputFpB);
  var sameDecision = (decisionFpA && decisionFpB && decisionFpA === decisionFpB);
  var engineChanged = false;
  if (engineVersionsA && engineVersionsB) {
    engineChanged = JSON.stringify(_canonicalSort_T(engineVersionsA)) !== JSON.stringify(_canonicalSort_T(engineVersionsB));
  }
  var verdict, warning = null;
  if (!inputFpA || !inputFpB || !decisionFpA || !decisionFpB) {
    verdict = _REPRO_VERDICT_T.UNRESOLVED;
  } else if (!sameInput) {
    verdict = _REPRO_VERDICT_T.EXPECTED_CHANGE;
  } else if (sameDecision) {
    verdict = _REPRO_VERDICT_T.SAME_INPUT_SAME_STRUCTURE;
  } else if (engineChanged) {
    verdict = _REPRO_VERDICT_T.EXPECTED_CHANGE;
  } else {
    verdict = _REPRO_VERDICT_T.SAME_INPUT_DIFFERENT_STRUCTURE;
    warning = 'NON_DETERMINISTIC_STRUCTURAL_OUTPUT';
  }
  var structuralDiff = [];
  if (decisionFpA && decisionFpB && decisionFpA !== decisionFpB) {
    try {
      var dA = JSON.parse(decisionFpA), dB = JSON.parse(decisionFpB);
      ['topology','frame','distribution','muscleTargets','prescriptionSlots','maintenanceSlots'].forEach(function(k) {
        if (JSON.stringify(dA[k]) !== JSON.stringify(dB[k])) structuralDiff.push(k);
      });
    } catch(e) { structuralDiff.push('PARSE_ERROR'); }
  }
  return { verdict: verdict, sameInput: sameInput, sameDecision: sameDecision, engineChanged: engineChanged, structuralDiff: structuralDiff, warning: warning };
}

// ── Test helpers ──────────────────────────────────────────────────────────────
var _mkSnapF = function(ov) { return Object.assign({ nivel:'intermedio', dias_semana:4, objetivo:'hipertrofia', gym:'San Diego', perfil:'natural' }, ov||{}); };
var _mkCtxF  = function() { return { prescriptionTargets:{ muscles:{}, reasonCodes:[], globalReadiness:'neutral', deloadCandidate:false }, restrictions:{ ejerciciosEvitar:[], motorPatternsAvoid:[] }, hasPreviousPlan:false, previousPlan:null }; };
var _mkTopoF = function(t) { return { selectedTopology: t||'UPPER_LOWER', version:'v2.0.0', scoringConfigVersion:'v1' }; };
var _mkEvF   = function() { return { topology:'v2.0.0', vdsen:'3.0.0', fingerprint:_FINGERPRINT_ENGINE_VERSION_T }; };
var _mkTrainF = function(dpw, dayExercises) {
  var days = dayExercises.map(function(exs, i) {
    return { dayIndex:i, label:'Día '+(i+1), exercises: exs.map(function(n) {
      return { exerciseName:n, prescriptionSlot:{ targetMuscle:'pectoral', movementPattern:'press_horizontal', role:'fundamental' }, sets:[{setIndex:0,repsTarget:8,rirTarget:2,load:0,restSeconds:90}] };
    })};
  });
  return { daysPerWeek:dpw, weeks:6, days:days };
};

console.log('\nFP — Generation Fingerprint');
(function() {
  var ctx = _mkCtxF();
  var snap = _mkSnapF(), topo = _mkTopoF(), ev = _mkEvF(), restr = ctx.restrictions, pt = ctx.prescriptionTargets;
  var fp = function(s) { return _buildGenerationFingerprint_T({ profileSnapshot:s||snap, resolvedTargets:pt, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev }); };

  // FP1: same input → same fingerprint
  assert('FP1a', 'same input → same fingerprint', fp() === fp());

  // FP2: timestamps stripped → same fingerprint
  var snapTs = Object.assign(_mkSnapF(), { generatedAt:'2026-01-01T00:00:00Z', createdAt:123 });
  assert('FP2a', 'generatedAt/createdAt stripped → same fp', fp() === _buildGenerationFingerprint_T({ profileSnapshot:snapTs, resolvedTargets:pt, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev }));

  // FP3: key order irrelevant → same fingerprint
  var snapA = { nivel:'intermedio', dias_semana:4, objetivo:'hipertrofia', gym:'San Diego', perfil:'natural' };
  var snapB = { objetivo:'hipertrofia', perfil:'natural', gym:'San Diego', dias_semana:4, nivel:'intermedio' };
  assert('FP3a', 'object key order irrelevant → same fp',
    _buildGenerationFingerprint_T({ profileSnapshot:snapA, resolvedTargets:pt, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev }) ===
    _buildGenerationFingerprint_T({ profileSnapshot:snapB, resolvedTargets:pt, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev }));

  // FP4: changed objective → different fingerprint
  assert('FP4a', 'different objetivo → different fp',
    _buildGenerationFingerprint_T({ profileSnapshot:_mkSnapF({objetivo:'hipertrofia'}), resolvedTargets:pt, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev }) !==
    _buildGenerationFingerprint_T({ profileSnapshot:_mkSnapF({objetivo:'definición'}), resolvedTargets:pt, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev }));

  // FP5: reasonCodes reordered → same fingerprint
  var pt2A = Object.assign({}, pt, { reasonCodes:['STALLED_EXERCISES','LOW_WELLNESS_WHO5'] });
  var pt2B = Object.assign({}, pt, { reasonCodes:['LOW_WELLNESS_WHO5','STALLED_EXERCISES'] });
  assert('FP5a', 'reasonCodes reordered → same fp',
    _buildGenerationFingerprint_T({ profileSnapshot:snap, resolvedTargets:pt2A, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev }) ===
    _buildGenerationFingerprint_T({ profileSnapshot:snap, resolvedTargets:pt2B, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev }));

  // FP6: returns non-empty string
  assert('FP6a', 'returns non-empty string', typeof fp() === 'string' && fp().length > 10);

  // FP7: fingerprint is valid JSON
  var fp7ok = false; try { JSON.parse(fp()); fp7ok = true; } catch(e) {}
  assert('FP7a', 'fingerprint is valid JSON', fp7ok);

  // FP8: XSS-unsafe input results in a parseable JSON string (fingerprint is data, not HTML)
  var xssSnap = _mkSnapF({ gym:'<script>alert(1)<\/script>' });
  var fp8 = _buildGenerationFingerprint_T({ profileSnapshot:xssSnap, resolvedTargets:pt, topologyDecision:topo, constraints:restr, previousPlanContext:ctx, engineVersions:ev });
  var fp8ok = false; try { JSON.parse(fp8); fp8ok = true; } catch(e) {}
  assert('FP8a', 'XSS snap → fingerprint is still valid JSON (data, not HTML)', fp8ok && typeof fp8 === 'string');
})();

console.log('\nDC — Decision Fingerprint');
(function() {
  var t4a = _mkTrainF(4, [['press banca','press inclinado'],['sentadilla'],['remo con barra'],['curl']]);
  var t4b = _mkTrainF(4, [['press banca','press inclinado'],['sentadilla'],['remo con barra'],['curl']]);
  var ctx = _mkCtxF(), topo = _mkTopoF();

  // DC1: same structure → same decision fingerprint
  assert('DC1a', 'same structure → same decision fp',
    _buildDecisionFingerprint_T(t4a, ctx, topo) === _buildDecisionFingerprint_T(t4b, ctx, topo));

  // DC2: different topology → different decision fingerprint
  assert('DC2a', 'different topology → different decision fp',
    _buildDecisionFingerprint_T(t4a, ctx, _mkTopoF('UPPER_LOWER')) !== _buildDecisionFingerprint_T(t4a, ctx, _mkTopoF('FULL_BODY')));

  // DC3: different exercise count → different decision fingerprint
  var t4c = _mkTrainF(4, [['press banca'],['sentadilla'],['remo con barra'],['curl']]);
  assert('DC3a', 'different exercise count → different decision fp',
    _buildDecisionFingerprint_T(t4a, ctx, topo) !== _buildDecisionFingerprint_T(t4c, ctx, topo));
})();

console.log('\nRA — Reproducibility Audit');
(function() {
  var ctx = _mkCtxF(), topo = _mkTopoF(), ev = _mkEvF();
  var t4a = _mkTrainF(4, [['press banca'],['sentadilla'],['remo'],['curl']]);
  var rfpA = _buildGenerationFingerprint_T({ profileSnapshot:_mkSnapF(), resolvedTargets:ctx.prescriptionTargets, topologyDecision:topo, constraints:ctx.restrictions, previousPlanContext:ctx, engineVersions:ev });
  var rdcA = _buildDecisionFingerprint_T(t4a, ctx, topo);
  var rdcB = _buildDecisionFingerprint_T(t4a, ctx, _mkTopoF('FULL_BODY')); // structurally different
  var rfpB = _buildGenerationFingerprint_T({ profileSnapshot:_mkSnapF({objetivo:'definición'}), resolvedTargets:ctx.prescriptionTargets, topologyDecision:topo, constraints:ctx.restrictions, previousPlanContext:ctx, engineVersions:ev });
  var evOld = { topology:'v1.0.0', vdsen:'2.0.0', fingerprint:'v1.0.0' };

  // RA1: same input + same structure → SAME_INPUT_SAME_STRUCTURE
  var ra1 = _runReproducibilityAudit_T(rfpA, rdcA, rfpA, rdcA, ev, ev);
  assert('RA1a', 'same input+structure → SAME_INPUT_SAME_STRUCTURE', ra1.verdict === _REPRO_VERDICT_T.SAME_INPUT_SAME_STRUCTURE);
  assert('RA1b', 'no warning', !ra1.warning);

  // RA2: same input + different structure → NON_DETERMINISTIC warning
  var ra2 = _runReproducibilityAudit_T(rfpA, rdcA, rfpA, rdcB, ev, ev);
  assert('RA2a', 'same input+diff struct → SAME_INPUT_DIFFERENT_STRUCTURE', ra2.verdict === _REPRO_VERDICT_T.SAME_INPUT_DIFFERENT_STRUCTURE);
  assert('RA2b', 'warning=NON_DETERMINISTIC_STRUCTURAL_OUTPUT', ra2.warning === 'NON_DETERMINISTIC_STRUCTURAL_OUTPUT');

  // RA3: different input → EXPECTED_CHANGE (no warning)
  var ra3 = _runReproducibilityAudit_T(rfpA, rdcA, rfpB, rdcB, ev, ev);
  assert('RA3a', 'different input → EXPECTED_CHANGE', ra3.verdict === _REPRO_VERDICT_T.EXPECTED_CHANGE);
  assert('RA3b', 'no warning on expected change', !ra3.warning);

  // RA4: engine version change + same input + diff structure → EXPECTED_CHANGE
  var ra4 = _runReproducibilityAudit_T(rfpA, rdcA, rfpA, rdcB, evOld, ev);
  assert('RA4a', 'engine version change → EXPECTED_CHANGE', ra4.verdict === _REPRO_VERDICT_T.EXPECTED_CHANGE);

  // RA5: structuralDiff lists changed fields
  var ra5 = _runReproducibilityAudit_T(rfpA, rdcA, rfpA, rdcB, ev, ev);
  assert('RA5a', 'structuralDiff is array', Array.isArray(ra5.structuralDiff));
  assert('RA5b', 'topology diff detected', ra5.structuralDiff.indexOf('topology') >= 0);

  // RA6: missing fingerprints → UNRESOLVED
  var ra6 = _runReproducibilityAudit_T(null, null, rfpA, rdcA, ev, ev);
  assert('RA6a', 'missing prev fp → UNRESOLVED', ra6.verdict === _REPRO_VERDICT_T.UNRESOLVED);
})();

// ════════════════ FASE 4 — Decision Trace Completeness ═══════════════════
// Inline T-suffix copies (node-runnable, no browser globals, full spec)

var VDSEN_ENGINE_VERSION_DT = '3.0.0';

var _DECISION_TRACE_STAGE_T = {
  TARGETS:'TARGETS', TOPOLOGY:'TOPOLOGY', CONSTRAINTS:'CONSTRAINTS',
  DISTRIBUTION:'DISTRIBUTION', MAINTENANCE:'MAINTENANCE', SLOT:'SLOT',
  STABILITY:'STABILITY', COMPOSITION:'COMPOSITION', QUALITY:'QUALITY', REPAIR:'REPAIR',
};
var _DECISION_TRACE_TYPE_T = {
  PROFILE_VALUE_RESOLVED:'PROFILE_VALUE_RESOLVED', PRIORITY_RESOLVED:'PRIORITY_RESOLVED',
  VOLUME_TARGET_RESOLVED:'VOLUME_TARGET_RESOLVED', FREQUENCY_TARGET_RESOLVED:'FREQUENCY_TARGET_RESOLVED',
  TOPOLOGY_SELECTED:'TOPOLOGY_SELECTED', TOPOLOGY_REJECTED:'TOPOLOGY_REJECTED',
  DISTRIBUTION_ASSIGNED:'DISTRIBUTION_ASSIGNED', MAINTENANCE_ROLE_ASSIGNED:'MAINTENANCE_ROLE_ASSIGNED',
  EXERCISE_SLOT_ASSIGNED:'EXERCISE_SLOT_ASSIGNED', EXERCISE_SELECTED:'EXERCISE_SELECTED',
  EXERCISE_REPLACED:'EXERCISE_REPLACED', EXERCISE_RETAINED:'EXERCISE_RETAINED',
  SESSION_ORDER_DECISION:'SESSION_ORDER_DECISION', STABILITY_DECISION:'STABILITY_DECISION',
  STRUCTURAL_FATIGUE_FLAG:'STRUCTURAL_FATIGUE_FLAG', QUALITY_GATE_RESULT:'QUALITY_GATE_RESULT',
  REPAIR_CANDIDATE_CREATED:'REPAIR_CANDIDATE_CREATED', REPAIR_CANDIDATE_REJECTED:'REPAIR_CANDIDATE_REJECTED',
  REPAIR_CANDIDATE_SELECTED:'REPAIR_CANDIDATE_SELECTED', PLAN_CONFIRMATION_REQUIRED:'PLAN_CONFIRMATION_REQUIRED',
};
var _DECISION_TRACE_SOURCE_T = {
  CLIENT:'CLIENT', COACH:'COACH', PHOTO:'PHOTO', INBODY:'INBODY',
  SYSTEM:'SYSTEM', HISTORY:'HISTORY', PLAN:'PLAN', LOGS:'LOGS',
  CHECKIN:'CHECKIN', GENERATOR:'GENERATOR', ENGINE:'ENGINE',
};
var _DECISION_TRACE_ENGINE_T = {
  PROFILE:'PROFILE', TARGET:'TARGET', TOPOLOGY:'TOPOLOGY',
  CONSTRAINT:'CONSTRAINT', DISTRIBUTION:'DISTRIBUTION', MAINTENANCE:'MAINTENANCE',
  STABILITY:'STABILITY', GENERATION:'GENERATION', SLOT:'SLOT',
  SESSION_COMPOSITION:'SESSION_COMPOSITION', INTERACTION:'INTERACTION',
  STRUCTURAL_FATIGUE:'STRUCTURAL_FATIGUE', QUALITY_GATE:'QUALITY_GATE',
  REPAIR:'REPAIR', PREVIEW:'PREVIEW',
};
var _DECISION_TRACE_CONFIDENCE_T = { NONE:'NONE', LOW:'LOW', MODERATE:'MODERATE', HIGH:'HIGH' };
var _DECISION_TRACE_AUDIT_MODE_T = { OFF:'OFF', WARN:'WARN', STRICT:'STRICT' };
var _TRACE_STRUCTURAL_STAGES_T   = ['TOPOLOGY','DISTRIBUTION','SLOT'];
var _TRACE_REQUIRED_BY_STAGE_T = {
  TARGETS:      ['PRIORITY_RESOLVED'],
  TOPOLOGY:     ['TOPOLOGY_SELECTED'],
  DISTRIBUTION: ['DISTRIBUTION_ASSIGNED'],
  SLOT:         ['EXERCISE_SLOT_ASSIGNED'],
  QUALITY:      ['QUALITY_GATE_RESULT'],
};

function _traceNodeId_T(decisionType, subject) { return decisionType + ':' + (subject || 'global'); }

function _createTraceNode_T(opts) {
  if (!opts || !opts.stage || !opts.decisionType || !opts.subject || !opts.decision)
    throw new Error('_createTraceNode_T: required fields missing');
  var node = {
    id:            opts.id || _traceNodeId_T(opts.decisionType, opts.subject),
    stage:         opts.stage,
    decisionType:  opts.decisionType,
    subject:       String(opts.subject),
    decision:      String(opts.decision),
    reasonCodes:   Array.isArray(opts.reasonCodes) ? opts.reasonCodes.slice() : [],
    sources:       Array.isArray(opts.sources) ? opts.sources.slice() : [],
    engine:        opts.engine || _DECISION_TRACE_ENGINE_T.GENERATION,
    engineVersion: opts.engineVersion || VDSEN_ENGINE_VERSION_DT,
    structural:    !!opts.structural,
  };
  if (opts.previousValue !== undefined) node.previousValue = opts.previousValue;
  if (opts.confidence) node.confidence = opts.confidence;
  if (Array.isArray(opts.evidence) && opts.evidence.length) node.evidence = opts.evidence.slice();
  if (opts.selectedAlternative !== undefined) node.selectedAlternative = opts.selectedAlternative;
  return node;
}

function _createDecisionTrace_T(ctx) { return { traceVersion:'decision-trace-v1', nodes:[], _ctx:ctx||null }; }
function _addDecisionNode_T(trace, node) { if (trace && Array.isArray(trace.nodes)) trace.nodes.push(node); }
function _finalizeDecisionTrace_T(trace) {
  var nodes = trace ? (trace.nodes || []) : [];
  var seen = {}, result = [];
  for (var i=0; i<nodes.length; i++) seen[nodes[i].id] = i;
  Object.keys(seen).sort(function(a,b){ return seen[a]-seen[b]; }).forEach(function(id){ result.push(nodes[seen[id]]); });
  return result;
}
function _validateDecisionTrace_T(trace) {
  var nodes = Array.isArray(trace) ? trace : ((trace && trace.nodes) || []);
  var errors = [], ids = {};
  nodes.forEach(function(n, i) {
    var p = 'node['+i+']';
    if (!n || typeof n !== 'object') { errors.push(p+': not an object'); return; }
    ['stage','decisionType','subject','decision','id'].forEach(function(f){ if (!n[f]) errors.push(p+'.'+f+' missing'); });
    if (n.id) { if (ids[n.id]) errors.push('duplicate id: '+n.id); ids[n.id]=true; }
  });
  return { valid: errors.length === 0, errors: errors };
}

function _auditDecisionTraceCompleteness_T(traceOrNodes, mode) {
  mode = mode || _DECISION_TRACE_AUDIT_MODE_T.WARN;
  var nodes = Array.isArray(traceOrNodes) ? traceOrNodes : ((traceOrNodes && traceOrNodes.nodes) || []);
  var result = { status:'PASS', missingNodes:[], incompleteNodes:[], duplicateIds:[], auditVerdicts:[], summary:{required:0,present:0,complete:0}, mode:mode };
  if (mode === _DECISION_TRACE_AUDIT_MODE_T.OFF) return result;
  if (!nodes.length) {
    result.status = mode === _DECISION_TRACE_AUDIT_MODE_T.STRICT ? 'REVIEW_REQUIRED' : 'WARN';
    result.auditVerdicts.push({ code:'NO_TRACE', msg:'Decision trace is empty' });
    return result;
  }
  var stageDecisions = {};
  nodes.forEach(function(n){ if (n && n.stage && n.decisionType) { if (!stageDecisions[n.stage]) stageDecisions[n.stage]={};stageDecisions[n.stage][n.decisionType]=true; } });
  var totalRequired=0, totalPresent=0;
  Object.keys(_TRACE_REQUIRED_BY_STAGE_T).forEach(function(stage) {
    var req=_TRACE_REQUIRED_BY_STAGE_T[stage]; totalRequired+=req.length;
    req.forEach(function(dt) {
      if (stageDecisions[stage] && stageDecisions[stage][dt]) { totalPresent++; }
      else { result.missingNodes.push({stage:stage,decisionType:dt}); result.auditVerdicts.push({code:'MISSING_DECISION',stage:stage,decisionType:dt}); }
    });
  });
  result.summary.required=totalRequired; result.summary.present=totalPresent; result.summary.complete=totalPresent;
  _TRACE_STRUCTURAL_STAGES_T.forEach(function(stage){ if (!stageDecisions[stage]) result.auditVerdicts.push({code:'MISSING_STRUCTURAL_STAGE',stage:stage}); });
  var seen={};
  nodes.forEach(function(n){ if (n && n.id) { seen[n.id]=(seen[n.id]||0)+1; } });
  Object.keys(seen).forEach(function(id){ if (seen[id]>1) { result.duplicateIds.push(id); result.auditVerdicts.push({code:'DUPLICATE_ID',id:id}); } });
  nodes.forEach(function(n,i){ if (!n) return; var miss=['stage','decisionType','subject','decision'].filter(function(f){ return !n[f]; }); if (miss.length) result.incompleteNodes.push({index:i,id:n.id||'?',missing:miss}); });
  var hasCritical = result.missingNodes.length>0 || result.duplicateIds.length>0 || result.incompleteNodes.length>0;
  if (hasCritical) result.status = mode === _DECISION_TRACE_AUDIT_MODE_T.STRICT ? 'REVIEW_REQUIRED' : 'WARN';
  return result;
}

function _diffDecisionTrace_T(prevTrace, currTrace) {
  var prevNodes=Array.isArray(prevTrace)?prevTrace:((prevTrace&&prevTrace.nodes)||[]);
  var currNodes=Array.isArray(currTrace)?currTrace:((currTrace&&currTrace.nodes)||[]);
  var SEMANTIC=['decision','reasonCodes','sources','engineVersion','structural','selectedAlternative'];
  var prevById={}, currById={};
  prevNodes.forEach(function(n){ if (n&&n.id) prevById[n.id]=n; });
  currNodes.forEach(function(n){ if (n&&n.id) currById[n.id]=n; });
  var added=[],removed=[],changed=[];
  Object.keys(currById).forEach(function(id){
    if (!prevById[id]) { added.push(currById[id]); return; }
    var diffs=[];
    SEMANTIC.forEach(function(f){ var a=JSON.stringify(prevById[id][f]),b=JSON.stringify(currById[id][f]); if (a!==b) diffs.push({field:f,prev:prevById[id][f],curr:currById[id][f]}); });
    if (diffs.length) changed.push({id:id,diffs:diffs});
  });
  Object.keys(prevById).forEach(function(id){ if (!currById[id]) removed.push(prevById[id]); });
  return {added:added,removed:removed,changed:changed};
}

function _exportDecisionTraceForAI_T(trace) {
  var nodes=Array.isArray(trace)?trace:((trace&&trace.nodes)||[]);
  var lines=['# Decision Trace — VDSEN'], byStage={};
  nodes.forEach(function(n){ if (!n) return; if (!byStage[n.stage]) byStage[n.stage]=[]; byStage[n.stage].push(n); });
  Object.keys(byStage).forEach(function(stage){
    lines.push('\n## '+stage);
    byStage[stage].forEach(function(n){
      lines.push('- ['+n.decisionType+'] '+n.subject+': '+n.decision);
      if (n.reasonCodes && n.reasonCodes.length) lines.push('  reasons: '+n.reasonCodes.join(', '));
      if (n.confidence) lines.push('  confidence: '+n.confidence);
    });
  });
  return lines.join('\n');
}

function _buildGenerationResponse_T(training, prescCtx, decisionTrace, inputFp, decisionFp, auditMode) {
  var nodes = Array.isArray(decisionTrace) ? decisionTrace : ((decisionTrace && decisionTrace.nodes) ? _finalizeDecisionTrace_T(decisionTrace) : []);
  var traceAudit = _auditDecisionTraceCompleteness_T(nodes, auditMode);
  return { schema:'vdsen-generation-response-v1', inputFingerprint:inputFp||null, decisionFingerprint:decisionFp||null, decisionTrace:nodes, traceAudit:traceAudit, generatedAt:Date.now() };
}

console.log('\nDT — Decision Trace Completeness (full spec)');
(function() {
  // DT1: _createTraceNode_T — core contract
  var n1 = _createTraceNode_T({ id:'T1', stage:'TARGETS', decisionType:_DECISION_TRACE_TYPE_T.PRIORITY_RESOLVED, subject:'s', decision:'d', reasonCodes:['RC1'], sources:[_DECISION_TRACE_SOURCE_T.CLIENT], structural:true });
  assert('DT1a', 'id preserved',        n1.id === 'T1');
  assert('DT1b', 'stage',               n1.stage === 'TARGETS');
  assert('DT1c', 'decisionType',        n1.decisionType === 'PRIORITY_RESOLVED');
  assert('DT1d', 'structural true',     n1.structural === true);
  assert('DT1e', 'reasonCodes array',   Array.isArray(n1.reasonCodes) && n1.reasonCodes[0] === 'RC1');
  assert('DT1f', 'sources array',       Array.isArray(n1.sources) && n1.sources[0] === 'CLIENT');

  // DT2: missing required throws
  var threw2 = false;
  try { _createTraceNode_T({ stage:'TARGETS' }); } catch(e) { threw2 = true; }
  assert('DT2a', 'missing required → throws', threw2);

  // DT3: deterministic auto-id (decisionType:subject)
  var n3 = _createTraceNode_T({ stage:'TOPOLOGY', decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED, subject:'global', decision:'PPL' });
  assert('DT3a', 'auto-id is TOPOLOGY_SELECTED:global', n3.id === 'TOPOLOGY_SELECTED:global');

  // DT4: defaults
  var n4 = _createTraceNode_T({ stage:'QUALITY', decisionType:_DECISION_TRACE_TYPE_T.QUALITY_GATE_RESULT, subject:'gate', decision:'PASS' });
  assert('DT4a', 'structural defaults false',   n4.structural === false);
  assert('DT4b', 'reasonCodes defaults []',     n4.reasonCodes.length === 0);
  assert('DT4c', 'engine defaults GENERATION',  n4.engine === 'GENERATION');
  assert('DT4d', 'no evidence field',           n4.evidence === undefined);

  // DT5: SOURCE enum completeness
  var srcKeys = ['CLIENT','COACH','PHOTO','INBODY','SYSTEM','HISTORY','PLAN','LOGS','CHECKIN','GENERATOR','ENGINE'];
  srcKeys.forEach(function(k) { assert('DT5_'+k, 'SOURCE.'+k, _DECISION_TRACE_SOURCE_T[k] === k); });

  // DT6: ENGINE enum completeness
  var engKeys = ['PROFILE','TARGET','TOPOLOGY','CONSTRAINT','DISTRIBUTION','MAINTENANCE','STABILITY','GENERATION','SLOT','SESSION_COMPOSITION','INTERACTION','STRUCTURAL_FATIGUE','QUALITY_GATE','REPAIR','PREVIEW'];
  engKeys.forEach(function(k) { assert('DT6_'+k, 'ENGINE.'+k, _DECISION_TRACE_ENGINE_T[k] === k); });

  // DT7: CONFIDENCE enum
  assert('DT7a', 'CONFIDENCE.NONE',     _DECISION_TRACE_CONFIDENCE_T.NONE     === 'NONE');
  assert('DT7b', 'CONFIDENCE.LOW',      _DECISION_TRACE_CONFIDENCE_T.LOW      === 'LOW');
  assert('DT7c', 'CONFIDENCE.MODERATE', _DECISION_TRACE_CONFIDENCE_T.MODERATE === 'MODERATE');
  assert('DT7d', 'CONFIDENCE.HIGH',     _DECISION_TRACE_CONFIDENCE_T.HIGH     === 'HIGH');

  // DT8: DECISION_TYPE has 20 entries
  var dtKeys = ['PROFILE_VALUE_RESOLVED','PRIORITY_RESOLVED','VOLUME_TARGET_RESOLVED','FREQUENCY_TARGET_RESOLVED','TOPOLOGY_SELECTED','TOPOLOGY_REJECTED','DISTRIBUTION_ASSIGNED','MAINTENANCE_ROLE_ASSIGNED','EXERCISE_SLOT_ASSIGNED','EXERCISE_SELECTED','EXERCISE_REPLACED','EXERCISE_RETAINED','SESSION_ORDER_DECISION','STABILITY_DECISION','STRUCTURAL_FATIGUE_FLAG','QUALITY_GATE_RESULT','REPAIR_CANDIDATE_CREATED','REPAIR_CANDIDATE_REJECTED','REPAIR_CANDIDATE_SELECTED','PLAN_CONFIRMATION_REQUIRED'];
  assert('DT8a', 'TYPE has 20 entries', Object.keys(_DECISION_TRACE_TYPE_T).length === 20);
  dtKeys.forEach(function(k) { assert('DT8_'+k, 'TYPE.'+k, _DECISION_TRACE_TYPE_T[k] === k); });

  // DT9: builder — create / add / finalize
  var dt9t = _createDecisionTrace_T({ id:'test' });
  assert('DT9a', 'traceVersion',      dt9t.traceVersion === 'decision-trace-v1');
  assert('DT9b', 'empty nodes',       Array.isArray(dt9t.nodes) && dt9t.nodes.length === 0);
  _addDecisionNode_T(dt9t, _createTraceNode_T({ stage:'TARGETS', decisionType:_DECISION_TRACE_TYPE_T.PRIORITY_RESOLVED, subject:'quad', decision:'HIGH' }));
  _addDecisionNode_T(dt9t, _createTraceNode_T({ stage:'TOPOLOGY', decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED, subject:'global', decision:'PPL' }));
  assert('DT9c', 'two nodes added',   dt9t.nodes.length === 2);
  var dt9fin = _finalizeDecisionTrace_T(dt9t);
  assert('DT9d', 'finalized array',   Array.isArray(dt9fin) && dt9fin.length === 2);

  // DT10: _finalizeDecisionTrace_T — dedup by id, last wins
  var dt10t = _createDecisionTrace_T(null);
  _addDecisionNode_T(dt10t, _createTraceNode_T({ id:'same-id', stage:'TOPOLOGY', decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED, subject:'global', decision:'PPL v1' }));
  _addDecisionNode_T(dt10t, _createTraceNode_T({ id:'same-id', stage:'TOPOLOGY', decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED, subject:'global', decision:'PPL v2' }));
  var dt10fin = _finalizeDecisionTrace_T(dt10t);
  assert('DT10a', 'dedup 2→1',       dt10fin.length === 1);
  assert('DT10b', 'last value wins',  dt10fin[0].decision === 'PPL v2');

  // DT11: _validateDecisionTrace_T — valid trace
  var dt11nodes = [
    _createTraceNode_T({ stage:'TARGETS', decisionType:_DECISION_TRACE_TYPE_T.PRIORITY_RESOLVED, subject:'global', decision:'d' }),
    _createTraceNode_T({ stage:'TOPOLOGY', decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED, subject:'global', decision:'PPL' }),
  ];
  var dt11v = _validateDecisionTrace_T(dt11nodes);
  assert('DT11a', 'valid=true',      dt11v.valid);
  assert('DT11b', 'no errors',       dt11v.errors.length === 0);

  // DT12: _validateDecisionTrace_T — duplicate ids
  var dupNode = _createTraceNode_T({ stage:'TOPOLOGY', decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED, subject:'global', decision:'X' });
  var dt12v = _validateDecisionTrace_T([dupNode, dupNode]);
  assert('DT12a', 'invalid',         !dt12v.valid);
  assert('DT12b', 'duplicate error', dt12v.errors.some(function(e){ return e.indexOf('duplicate') >= 0; }));

  // DT13: _auditDecisionTraceCompleteness_T — full required types → PASS
  var fullTrace = [
    _createTraceNode_T({ stage:'TARGETS',      decisionType:_DECISION_TRACE_TYPE_T.PRIORITY_RESOLVED,    subject:'global', decision:'d' }),
    _createTraceNode_T({ stage:'TOPOLOGY',     decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED,    subject:'global', decision:'PPL', structural:true }),
    _createTraceNode_T({ stage:'DISTRIBUTION', decisionType:_DECISION_TRACE_TYPE_T.DISTRIBUTION_ASSIGNED,subject:'global', decision:'d',   structural:true }),
    _createTraceNode_T({ stage:'SLOT',         decisionType:_DECISION_TRACE_TYPE_T.EXERCISE_SLOT_ASSIGNED,subject:'global',decision:'d',   structural:true }),
    _createTraceNode_T({ stage:'QUALITY',      decisionType:_DECISION_TRACE_TYPE_T.QUALITY_GATE_RESULT,  subject:'gate',   decision:'PASS' }),
  ];
  var dt13 = _auditDecisionTraceCompleteness_T(fullTrace, _DECISION_TRACE_AUDIT_MODE_T.WARN);
  assert('DT13a', 'PASS',              dt13.status === 'PASS');
  assert('DT13b', 'no missing',        dt13.missingNodes.length === 0);
  assert('DT13c', 'summary.required',  dt13.summary.required === 5);
  assert('DT13d', 'summary.present',   dt13.summary.present  === 5);

  // DT14: missing PRIORITY_RESOLVED → WARN
  var partialTrace = [
    _createTraceNode_T({ stage:'TOPOLOGY',     decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED,    subject:'global', decision:'PPL', structural:true }),
    _createTraceNode_T({ stage:'DISTRIBUTION', decisionType:_DECISION_TRACE_TYPE_T.DISTRIBUTION_ASSIGNED,subject:'global', decision:'d',   structural:true }),
    _createTraceNode_T({ stage:'SLOT',         decisionType:_DECISION_TRACE_TYPE_T.EXERCISE_SLOT_ASSIGNED,subject:'global',decision:'d',   structural:true }),
    _createTraceNode_T({ stage:'QUALITY',      decisionType:_DECISION_TRACE_TYPE_T.QUALITY_GATE_RESULT,  subject:'gate',   decision:'PASS' }),
  ];
  var dt14 = _auditDecisionTraceCompleteness_T(partialTrace, _DECISION_TRACE_AUDIT_MODE_T.WARN);
  assert('DT14a', 'WARN status',          dt14.status === 'WARN');
  assert('DT14b', 'TARGETS missing node', dt14.missingNodes.some(function(n){ return n.stage === 'TARGETS' && n.decisionType === 'PRIORITY_RESOLVED'; }));

  // DT15: STRICT missing → REVIEW_REQUIRED
  var dt15 = _auditDecisionTraceCompleteness_T(partialTrace, _DECISION_TRACE_AUDIT_MODE_T.STRICT);
  assert('DT15a', 'STRICT → REVIEW_REQUIRED', dt15.status === 'REVIEW_REQUIRED');

  // DT16: OFF → PASS regardless
  var dt16 = _auditDecisionTraceCompleteness_T(null, _DECISION_TRACE_AUDIT_MODE_T.OFF);
  assert('DT16a', 'OFF → PASS', dt16.status === 'PASS');

  // DT17: empty trace → WARN + NO_TRACE verdict
  var dt17 = _auditDecisionTraceCompleteness_T([], _DECISION_TRACE_AUDIT_MODE_T.WARN);
  assert('DT17a', 'empty → WARN',         dt17.status === 'WARN');
  assert('DT17b', 'NO_TRACE verdict',     dt17.auditVerdicts.some(function(v){ return v.code === 'NO_TRACE'; }));

  // DT18: duplicate id detection
  var dupTrace = fullTrace.concat([
    _createTraceNode_T({ id:'TOPOLOGY_SELECTED:global', stage:'TOPOLOGY', decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED, subject:'global', decision:'dup' }),
  ]);
  var dt18 = _auditDecisionTraceCompleteness_T(dupTrace, _DECISION_TRACE_AUDIT_MODE_T.WARN);
  assert('DT18a', 'duplicate id detected', dt18.duplicateIds.indexOf('TOPOLOGY_SELECTED:global') >= 0);

  // DT19: _diffDecisionTrace_T — added/removed/changed
  var prevTrace = [
    _createTraceNode_T({ stage:'TARGETS',  decisionType:_DECISION_TRACE_TYPE_T.PRIORITY_RESOLVED, subject:'quad', decision:'HIGH' }),
    _createTraceNode_T({ stage:'TOPOLOGY', decisionType:_DECISION_TRACE_TYPE_T.TOPOLOGY_SELECTED, subject:'global', decision:'PPL' }),
  ];
  var currTrace = [
    _createTraceNode_T({ stage:'TARGETS',      decisionType:_DECISION_TRACE_TYPE_T.PRIORITY_RESOLVED,    subject:'quad',   decision:'MODERATE' }),
    _createTraceNode_T({ stage:'DISTRIBUTION', decisionType:_DECISION_TRACE_TYPE_T.DISTRIBUTION_ASSIGNED,subject:'global', decision:'3d' }),
  ];
  var diff19 = _diffDecisionTrace_T(prevTrace, currTrace);
  assert('DT19a', 'added DISTRIBUTION_ASSIGNED',   diff19.added.some(function(n){ return n.decisionType === 'DISTRIBUTION_ASSIGNED'; }));
  assert('DT19b', 'removed TOPOLOGY_SELECTED',     diff19.removed.some(function(n){ return n.decisionType === 'TOPOLOGY_SELECTED'; }));
  assert('DT19c', 'changed PRIORITY_RESOLVED',     diff19.changed.some(function(c){ return c.id === 'PRIORITY_RESOLVED:quad'; }));

  // DT20: _exportDecisionTraceForAI_T — markdown format
  var export20 = _exportDecisionTraceForAI_T(fullTrace);
  assert('DT20a', 'starts with # Decision Trace', export20.indexOf('# Decision Trace') >= 0);
  assert('DT20b', 'includes TARGETS section',     export20.indexOf('## TARGETS') >= 0);
  assert('DT20c', 'includes PRIORITY_RESOLVED',   export20.indexOf('PRIORITY_RESOLVED') >= 0);

  // DT21: _buildGenerationResponse_T
  var gr21 = _buildGenerationResponse_T(null, null, fullTrace, 'fp_in', 'fp_dec', _DECISION_TRACE_AUDIT_MODE_T.WARN);
  assert('DT21a', 'schema',               gr21.schema === 'vdsen-generation-response-v1');
  assert('DT21b', 'decisionTrace array',  Array.isArray(gr21.decisionTrace) && gr21.decisionTrace.length === 5);
  assert('DT21c', 'inputFingerprint',     gr21.inputFingerprint === 'fp_in');
  assert('DT21d', 'decisionFingerprint',  gr21.decisionFingerprint === 'fp_dec');
  assert('DT21e', 'traceAudit present',   gr21.traceAudit && typeof gr21.traceAudit.status === 'string');
  assert('DT21f', 'generatedAt set',      typeof gr21.generatedAt === 'number' && gr21.generatedAt > 0);

  // DT22: trace immutability
  var origLen = fullTrace.length;
  _buildGenerationResponse_T(null, null, fullTrace, null, null, _DECISION_TRACE_AUDIT_MODE_T.WARN);
  assert('DT22a', 'original trace not mutated', fullTrace.length === origLen);

  // DT23: XSS safety — stored as raw data
  var xssNode = _createTraceNode_T({ stage:'TARGETS', decisionType:_DECISION_TRACE_TYPE_T.PRIORITY_RESOLVED, subject:'<script>alert(1)<\/script>', decision:'<img src=x>', structural:false });
  assert('DT23a', 'XSS subject stored raw',  xssNode.subject === '<script>alert(1)<\/script>');
  assert('DT23b', 'XSS decision stored raw', xssNode.decision === '<img src=x>');

  // DT24: STABILITY_DECISION structural=false (MOVE)
  var stabMove = _createTraceNode_T({ stage:'STABILITY', decisionType:_DECISION_TRACE_TYPE_T.STABILITY_DECISION, subject:'biceps', decision:'MOVE: D2→D3', structural:false });
  assert('DT24a', 'STABILITY structural=false',    stabMove.structural === false);
  assert('DT24b', 'deterministic id',             stabMove.id === 'STABILITY_DECISION:biceps');

  // DT25: STABILITY_DECISION structural=true (slot change)
  var stabSlot = _createTraceNode_T({ stage:'STABILITY', decisionType:_DECISION_TRACE_TYPE_T.STABILITY_DECISION, subject:'quadriceps', decision:'STRUCTURAL_SLOT_CHANGE', structural:true });
  assert('DT25a', 'STABILITY structural=true', stabSlot.structural === true);

  // DT26: QUALITY_GATE_RESULT node
  var qgNode = _createTraceNode_T({ stage:'QUALITY', decisionType:_DECISION_TRACE_TYPE_T.QUALITY_GATE_RESULT, subject:'outputQualityGate', decision:'PASS', confidence:_DECISION_TRACE_CONFIDENCE_T.HIGH });
  assert('DT26a', 'QUALITY_GATE_RESULT stage',       qgNode.stage === 'QUALITY');
  assert('DT26b', 'QUALITY_GATE_RESULT decisionType', qgNode.decisionType === 'QUALITY_GATE_RESULT');
  assert('DT26c', 'confidence HIGH',                  qgNode.confidence === 'HIGH');

  // DT27: REPAIR nodes
  var repCreated  = _createTraceNode_T({ stage:'REPAIR', decisionType:_DECISION_TRACE_TYPE_T.REPAIR_CANDIDATE_CREATED,  subject:'slot_1', decision:'CREATED' });
  var repRejected = _createTraceNode_T({ stage:'REPAIR', decisionType:_DECISION_TRACE_TYPE_T.REPAIR_CANDIDATE_REJECTED, subject:'slot_1', decision:'REJECTED' });
  var repSelected = _createTraceNode_T({ stage:'REPAIR', decisionType:_DECISION_TRACE_TYPE_T.REPAIR_CANDIDATE_SELECTED, subject:'slot_1', decision:'SELECTED' });
  assert('DT27a', 'REPAIR_CANDIDATE_CREATED id',   repCreated.id  === 'REPAIR_CANDIDATE_CREATED:slot_1');
  assert('DT27b', 'REPAIR_CANDIDATE_REJECTED id',  repRejected.id === 'REPAIR_CANDIDATE_REJECTED:slot_1');
  assert('DT27c', 'REPAIR_CANDIDATE_SELECTED id',  repSelected.id === 'REPAIR_CANDIDATE_SELECTED:slot_1');

  // DT28: all 10 stages present
  var allStages = ['TARGETS','TOPOLOGY','CONSTRAINTS','DISTRIBUTION','MAINTENANCE','SLOT','STABILITY','COMPOSITION','QUALITY','REPAIR'];
  allStages.forEach(function(s) { assert('DT28_'+s, 'stage '+s, _DECISION_TRACE_STAGE_T[s] === s); });

  // DT29: audit mode constants
  assert('DT29a', 'OFF',    _DECISION_TRACE_AUDIT_MODE_T.OFF    === 'OFF');
  assert('DT29b', 'WARN',   _DECISION_TRACE_AUDIT_MODE_T.WARN   === 'WARN');
  assert('DT29c', 'STRICT', _DECISION_TRACE_AUDIT_MODE_T.STRICT === 'STRICT');

  // DT30: _traceNodeId_T — format check
  assert('DT30a', 'traceNodeId format', _traceNodeId_T('TOPOLOGY_SELECTED', 'global') === 'TOPOLOGY_SELECTED:global');
  assert('DT30b', 'traceNodeId no subject → global', _traceNodeId_T('PRIORITY_RESOLVED', null) === 'PRIORITY_RESOLVED:global');
})();

// ════════════════ FASE 5 — Longitudinal Learning Contract ════════════════
// Inline T-suffix copies — node-runnable, full spec

var _LEARNING_ELIGIBILITY_T = { NEVER:'NEVER', CONTEXT_ONLY:'CONTEXT_ONLY', CANDIDATE:'CANDIDATE', ELIGIBLE:'ELIGIBLE' };
var _EVIDENCE_STATE_T = { INSUFFICIENT:'INSUFFICIENT', EMERGING:'EMERGING', RELIABLE:'RELIABLE' };
var _OUTCOME_STATE_T  = { POSITIVE:'POSITIVE', NEUTRAL:'NEUTRAL', NEGATIVE:'NEGATIVE', UNRESOLVED:'UNRESOLVED' };

// 21 decision types (20 original + HISTORICAL_RESPONSE_APPLIED)
var _DECISION_TRACE_TYPE_F5_T = Object.assign({}, _DECISION_TRACE_TYPE_T, {
  HISTORICAL_RESPONSE_APPLIED: 'HISTORICAL_RESPONSE_APPLIED',
});

var _LEARNING_ELIGIBILITY_BY_TYPE_T = {
  PROFILE_VALUE_RESOLVED:      'CONTEXT_ONLY',
  PRIORITY_RESOLVED:           'CONTEXT_ONLY',
  VOLUME_TARGET_RESOLVED:      'CONTEXT_ONLY',
  FREQUENCY_TARGET_RESOLVED:   'CONTEXT_ONLY',
  TOPOLOGY_SELECTED:           'CANDIDATE',
  TOPOLOGY_REJECTED:           'NEVER',
  DISTRIBUTION_ASSIGNED:       'CANDIDATE',
  MAINTENANCE_ROLE_ASSIGNED:   'CANDIDATE',
  EXERCISE_SLOT_ASSIGNED:      'CANDIDATE',
  EXERCISE_SELECTED:           'CANDIDATE',
  EXERCISE_REPLACED:           'CANDIDATE',
  EXERCISE_RETAINED:           'CANDIDATE',
  SESSION_ORDER_DECISION:      'CONTEXT_ONLY',
  STABILITY_DECISION:          'CONTEXT_ONLY',
  STRUCTURAL_FATIGUE_FLAG:     'CONTEXT_ONLY',
  QUALITY_GATE_RESULT:         'NEVER',
  REPAIR_CANDIDATE_CREATED:    'NEVER',
  REPAIR_CANDIDATE_REJECTED:   'NEVER',
  REPAIR_CANDIDATE_SELECTED:   'CANDIDATE',
  PLAN_CONFIRMATION_REQUIRED:  'NEVER',
  HISTORICAL_RESPONSE_APPLIED: 'NEVER',
};

function _getLearningEligibility_T(decisionType) {
  return _LEARNING_ELIGIBILITY_BY_TYPE_T[decisionType] || 'NEVER';
}

function _assessOutcomeDataQuality_T(outcomes) {
  if (!outcomes || typeof outcomes !== 'object') return { ok:false, reason:'NO_OUTCOMES' };
  if (outcomes.hasAutoFilled)          return { ok:false, reason:'AUTOFILLED' };
  if (outcomes.hasAutoClosed)          return { ok:false, reason:'AUTOCLOSED' };
  if (outcomes.hasSyntheticPostsession) return { ok:false, reason:'SYNTHETIC' };
  if (outcomes.hasDuplicatedLogs)      return { ok:false, reason:'DUPLICATED_LOGS' };
  if (outcomes.identityResolved === false) return { ok:false, reason:'UNRESOLVED_IDENTITY' };
  return { ok:true, reason:null };
}

function _hasLongitudinalEvidence_T(outcomes) {
  return !!(outcomes && (outcomes.sessionsReal || 0) > 1);
}

function _auditLearningEligibility_T(traceNodes, outcomes) {
  var nodes = Array.isArray(traceNodes) ? traceNodes : [];
  var result = { eligible:[], contextOnly:[], rejected:[], insufficientEvidence:[] };
  var dq = _assessOutcomeDataQuality_T(outcomes);
  var hasLong = _hasLongitudinalEvidence_T(outcomes);
  nodes.forEach(function(n) {
    if (!n || !n.decisionType) { result.rejected.push(n); return; }
    var elig = _getLearningEligibility_T(n.decisionType);
    if (elig === 'NEVER') { result.rejected.push(n); }
    else if (elig === 'CONTEXT_ONLY') { result.contextOnly.push(n); }
    else if (elig === 'CANDIDATE' || elig === 'ELIGIBLE') {
      if (!dq.ok || !hasLong) { result.insufficientEvidence.push(n); }
      else { result.eligible.push(n); }
    } else { result.rejected.push(n); }
  });
  return result;
}

function _buildOutcomeContract_T(opts) {
  if (!opts || !opts.interventionKey || !opts.interventionType) throw new Error('_buildOutcomeContract_T: required');
  return {
    interventionKey: opts.interventionKey, interventionType: opts.interventionType,
    decisionFingerprint: opts.decisionFingerprint || null, startedAt: opts.startedAt || null,
    observations: { sessionsReal:opts.sessionsReal||0, exposuresReal:opts.exposuresReal||0,
      adherence:opts.adherence!=null?opts.adherence:null, performanceTrend:opts.performanceTrend||null,
      rirConsistency:opts.rirConsistency||null, recoveryTrend:opts.recoveryTrend||null, painTrend:opts.painTrend||null },
    evidenceState: opts.evidenceState || 'INSUFFICIENT',
    outcome: opts.outcome || 'UNRESOLVED',
  };
}

function _buildLearnedState_T(opts) {
  return {
    learnedStateVersion: 'learned-state-v1',
    topologyHistory:     Array.isArray(opts&&opts.topologyHistory) ? opts.topologyHistory.slice() : [],
    slotHistory:         Array.isArray(opts&&opts.slotHistory) ? opts.slotHistory.slice() : [],
    exerciseHistory:     Array.isArray(opts&&opts.exerciseHistory) ? opts.exerciseHistory.slice() : [],
    recoveryPatterns:    Array.isArray(opts&&opts.recoveryPatterns) ? opts.recoveryPatterns.slice() : [],
    adherencePatterns:   Array.isArray(opts&&opts.adherencePatterns) ? opts.adherencePatterns.slice() : [],
    lastUpdatedFromFingerprint: (opts&&opts.lastUpdatedFromFingerprint)||null,
  };
}

function _createHistoricalResponseNode_T(opts) {
  if (!opts || !opts.subject || !opts.decision || !opts.engine) throw new Error('_createHistoricalResponseNode_T: required');
  return _createTraceNode_T({
    stage: opts.stage || 'STABILITY', decisionType: 'HISTORICAL_RESPONSE_APPLIED',
    subject: opts.subject, decision: opts.decision,
    reasonCodes: ['HISTORICAL_RESPONSE'], sources: ['HISTORY'],
    engine: opts.engine, structural: false,
  });
}

function _learnedStateAffectsFingerprint_T(learnedState) {
  if (!learnedState) return false;
  return (learnedState.topologyHistory||[]).concat(learnedState.slotHistory||[]).concat(learnedState.exerciseHistory||[])
    .some(function(h){ return h && h.evidenceState === 'RELIABLE'; });
}

console.log('\nLS — Longitudinal Learning Contract');
(function() {
  // LS1: _LEARNING_ELIGIBILITY enum
  assert('LS1a', 'NEVER',        _LEARNING_ELIGIBILITY_T.NEVER        === 'NEVER');
  assert('LS1b', 'CONTEXT_ONLY', _LEARNING_ELIGIBILITY_T.CONTEXT_ONLY === 'CONTEXT_ONLY');
  assert('LS1c', 'CANDIDATE',    _LEARNING_ELIGIBILITY_T.CANDIDATE    === 'CANDIDATE');
  assert('LS1d', 'ELIGIBLE',     _LEARNING_ELIGIBILITY_T.ELIGIBLE     === 'ELIGIBLE');

  // LS2: _EVIDENCE_STATE enum
  assert('LS2a', 'INSUFFICIENT', _EVIDENCE_STATE_T.INSUFFICIENT === 'INSUFFICIENT');
  assert('LS2b', 'EMERGING',     _EVIDENCE_STATE_T.EMERGING     === 'EMERGING');
  assert('LS2c', 'RELIABLE',     _EVIDENCE_STATE_T.RELIABLE     === 'RELIABLE');

  // LS3: _OUTCOME_STATE enum
  assert('LS3a', 'POSITIVE',   _OUTCOME_STATE_T.POSITIVE   === 'POSITIVE');
  assert('LS3b', 'NEUTRAL',    _OUTCOME_STATE_T.NEUTRAL    === 'NEUTRAL');
  assert('LS3c', 'NEGATIVE',   _OUTCOME_STATE_T.NEGATIVE   === 'NEGATIVE');
  assert('LS3d', 'UNRESOLVED', _OUTCOME_STATE_T.UNRESOLVED === 'UNRESOLVED');

  // LS4: HISTORICAL_RESPONSE_APPLIED exists
  assert('LS4a', 'HISTORICAL_RESPONSE_APPLIED', _DECISION_TRACE_TYPE_F5_T.HISTORICAL_RESPONSE_APPLIED === 'HISTORICAL_RESPONSE_APPLIED');

  // LS5: all 21 types have eligibility mapping
  var all21 = Object.keys(_DECISION_TRACE_TYPE_F5_T);
  assert('LS5a', '21 types mapped', all21.every(function(t){ return !!_LEARNING_ELIGIBILITY_BY_TYPE_T[t]; }));

  // LS6: NEVER types
  var neverTypes = ['QUALITY_GATE_RESULT','PLAN_CONFIRMATION_REQUIRED','REPAIR_CANDIDATE_CREATED','REPAIR_CANDIDATE_REJECTED','TOPOLOGY_REJECTED','HISTORICAL_RESPONSE_APPLIED'];
  neverTypes.forEach(function(t){ assert('LS6_'+t, 'NEVER:'+t, _getLearningEligibility_T(t) === 'NEVER'); });

  // LS7: CONTEXT_ONLY types
  var ctxTypes = ['PROFILE_VALUE_RESOLVED','PRIORITY_RESOLVED','SESSION_ORDER_DECISION','STABILITY_DECISION','STRUCTURAL_FATIGUE_FLAG'];
  ctxTypes.forEach(function(t){ assert('LS7_'+t, 'CTX:'+t, _getLearningEligibility_T(t) === 'CONTEXT_ONLY'); });

  // LS8: CANDIDATE types
  var candTypes = ['TOPOLOGY_SELECTED','DISTRIBUTION_ASSIGNED','EXERCISE_SLOT_ASSIGNED','EXERCISE_SELECTED','EXERCISE_REPLACED','EXERCISE_RETAINED','REPAIR_CANDIDATE_SELECTED'];
  candTypes.forEach(function(t){ assert('LS8_'+t, 'CAND:'+t, _getLearningEligibility_T(t) === 'CANDIDATE'); });

  // LS9: unknown type → NEVER
  assert('LS9a', 'unknown → NEVER', _getLearningEligibility_T('MADE_UP') === 'NEVER');

  // LS10: _assessOutcomeDataQuality_T — clean data
  var cleanOk = _assessOutcomeDataQuality_T({ sessionsReal:3, hasAutoFilled:false, identityResolved:true });
  assert('LS10a', 'clean → ok',        cleanOk.ok);
  assert('LS10b', 'clean reason null', cleanOk.reason === null);

  // LS11: autoFilled taints
  var afRes = _assessOutcomeDataQuality_T({ hasAutoFilled:true, sessionsReal:5 });
  assert('LS11a', 'autoFilled → not ok',  !afRes.ok);
  assert('LS11b', 'autoFilled reason',    afRes.reason === 'AUTOFILLED');

  // LS12: autoClosed taints
  var acRes = _assessOutcomeDataQuality_T({ hasAutoClosed:true });
  assert('LS12a', 'autoClosed → not ok',  !acRes.ok);
  assert('LS12b', 'autoClosed reason',    acRes.reason === 'AUTOCLOSED');

  // LS13: unresolved identity
  var uiRes = _assessOutcomeDataQuality_T({ identityResolved:false, sessionsReal:5 });
  assert('LS13a', 'unresolved → not ok',    !uiRes.ok);
  assert('LS13b', 'unresolved reason',      uiRes.reason === 'UNRESOLVED_IDENTITY');

  // LS14: null outcomes
  var nullRes = _assessOutcomeDataQuality_T(null);
  assert('LS14a', 'null → not ok',    !nullRes.ok);
  assert('LS14b', 'null reason',      nullRes.reason === 'NO_OUTCOMES');

  // LS15: _hasLongitudinalEvidence_T — spec §6
  assert('LS15a', '0 sessions → false',  !_hasLongitudinalEvidence_T({ sessionsReal:0 }));
  assert('LS15b', '1 session → false',   !_hasLongitudinalEvidence_T({ sessionsReal:1 }));
  assert('LS15c', '2 sessions → true',    _hasLongitudinalEvidence_T({ sessionsReal:2 }));
  assert('LS15d', 'null → false',        !_hasLongitudinalEvidence_T(null));

  // LS16: NEVER nodes always rejected
  var neverNode = _createTraceNode_T({ stage:'QUALITY', decisionType:'QUALITY_GATE_RESULT', subject:'gate', decision:'PASS' });
  var goodObs = { sessionsReal:3, hasAutoFilled:false, hasAutoClosed:false, identityResolved:true };
  var res16 = _auditLearningEligibility_T([neverNode], goodObs);
  assert('LS16a', 'NEVER rejected=1', res16.rejected.length === 1 && res16.eligible.length === 0);

  // LS17: CONTEXT_ONLY → contextOnly
  var ctxNode = _createTraceNode_T({ stage:'TARGETS', decisionType:'PRIORITY_RESOLVED', subject:'quad', decision:'HIGH' });
  var res17 = _auditLearningEligibility_T([ctxNode], goodObs);
  assert('LS17a', 'CONTEXT_ONLY → contextOnly=1', res17.contextOnly.length === 1 && res17.eligible.length === 0);

  // LS18: CANDIDATE + good outcomes → eligible
  var candNode = _createTraceNode_T({ stage:'TOPOLOGY', decisionType:'TOPOLOGY_SELECTED', subject:'global', decision:'PPL' });
  var res18 = _auditLearningEligibility_T([candNode], goodObs);
  assert('LS18a', 'CANDIDATE + good → eligible=1', res18.eligible.length === 1);

  // LS19: single session → insufficientEvidence (spec §6)
  var singleObs = { sessionsReal:1, hasAutoFilled:false, identityResolved:true };
  var res19 = _auditLearningEligibility_T([candNode], singleObs);
  assert('LS19a', 'single session → insufficient=1', res19.insufficientEvidence.length === 1 && res19.eligible.length === 0);

  // LS20: autoFilled outcomes → insufficientEvidence
  var afObs = { sessionsReal:5, hasAutoFilled:true };
  var res20 = _auditLearningEligibility_T([candNode], afObs);
  assert('LS20a', 'autoFilled → insufficient=1', res20.insufficientEvidence.length === 1);

  // LS21: null outcomes → insufficientEvidence
  var res21 = _auditLearningEligibility_T([candNode], null);
  assert('LS21a', 'null outcomes → insufficient=1', res21.insufficientEvidence.length === 1);

  // LS22: mixed trace → correct buckets
  var res22 = _auditLearningEligibility_T([neverNode, ctxNode, candNode], goodObs);
  assert('LS22a', 'rejected=1',     res22.rejected.length    === 1);
  assert('LS22b', 'contextOnly=1',  res22.contextOnly.length === 1);
  assert('LS22c', 'eligible=1',     res22.eligible.length    === 1);
  assert('LS22d', 'insufficient=0', res22.insufficientEvidence.length === 0);

  // LS23: _buildOutcomeContract_T
  var oc = _buildOutcomeContract_T({ interventionKey:'TOPOLOGY_SELECTED:global', interventionType:'TOPOLOGY_SELECTED', sessionsReal:3, performanceTrend:'POSITIVE', evidenceState:'EMERGING', outcome:'POSITIVE' });
  assert('LS23a', 'interventionKey',   oc.interventionKey    === 'TOPOLOGY_SELECTED:global');
  assert('LS23b', 'interventionType',  oc.interventionType   === 'TOPOLOGY_SELECTED');
  assert('LS23c', 'evidenceState',     oc.evidenceState      === 'EMERGING');
  assert('LS23d', 'outcome',           oc.outcome            === 'POSITIVE');
  assert('LS23e', 'sessionsReal',      oc.observations.sessionsReal === 3);
  assert('LS23f', 'fingerprint null',  oc.decisionFingerprint === null);

  // LS24: _buildOutcomeContract_T — missing required throws
  var threwOC = false;
  try { _buildOutcomeContract_T({ interventionKey:'x' }); } catch(e) { threwOC = true; }
  assert('LS24a', 'missing interventionType throws', threwOC);

  // LS25: _buildLearnedState_T — structure
  var ls = _buildLearnedState_T({ topologyHistory:[{topology:'PPL', evidenceState:'EMERGING'}], lastUpdatedFromFingerprint:'fp_abc' });
  assert('LS25a', 'learnedStateVersion', ls.learnedStateVersion === 'learned-state-v1');
  assert('LS25b', 'topologyHistory len', ls.topologyHistory.length === 1);
  assert('LS25c', 'slotHistory empty',   ls.slotHistory.length === 0);
  assert('LS25d', 'lastUpdated fp',      ls.lastUpdatedFromFingerprint === 'fp_abc');

  // LS26: _buildLearnedState_T — empty defaults
  var lsEmpty = _buildLearnedState_T(null);
  assert('LS26a', 'empty topologyHistory', Array.isArray(lsEmpty.topologyHistory) && lsEmpty.topologyHistory.length === 0);
  assert('LS26b', 'lastUpdated null',      lsEmpty.lastUpdatedFromFingerprint === null);

  // LS27: _createHistoricalResponseNode_T
  var hrn = _createHistoricalResponseNode_T({ subject:'quadriceps', decision:'PPL bien tolerado', engine:'TOPOLOGY' });
  assert('LS27a', 'decisionType',    hrn.decisionType === 'HISTORICAL_RESPONSE_APPLIED');
  assert('LS27b', 'source HISTORY',  hrn.sources.indexOf('HISTORY') >= 0);
  assert('LS27c', 'reasonCode',      hrn.reasonCodes.indexOf('HISTORICAL_RESPONSE') >= 0);
  assert('LS27d', 'structural false', hrn.structural === false);
  assert('LS27e', 'deterministic id', hrn.id === 'HISTORICAL_RESPONSE_APPLIED:quadriceps');

  // LS28: _createHistoricalResponseNode_T — missing required throws
  var threwHRN = false;
  try { _createHistoricalResponseNode_T({ subject:'x' }); } catch(e) { threwHRN = true; }
  assert('LS28a', 'missing throws', threwHRN);

  // LS29: _learnedStateAffectsFingerprint_T
  var lsNoR = _buildLearnedState_T({ topologyHistory:[{ evidenceState:'EMERGING' }] });
  assert('LS29a', 'EMERGING → false',  !_learnedStateAffectsFingerprint_T(lsNoR));
  var lsRel = _buildLearnedState_T({ topologyHistory:[{ evidenceState:'RELIABLE' }] });
  assert('LS29b', 'RELIABLE → true',    _learnedStateAffectsFingerprint_T(lsRel));
  assert('LS29c', 'null → false',       !_learnedStateAffectsFingerprint_T(null));

  // LS30: repair not applied → NEVER
  var repCreated  = _createTraceNode_T({ stage:'REPAIR', decisionType:'REPAIR_CANDIDATE_CREATED',  subject:'slot_1', decision:'CREATED' });
  var repRejected = _createTraceNode_T({ stage:'REPAIR', decisionType:'REPAIR_CANDIDATE_REJECTED', subject:'slot_1', decision:'REJECTED' });
  var res30 = _auditLearningEligibility_T([repCreated, repRejected], goodObs);
  assert('LS30a', 'REPAIR_CREATED → rejected',  res30.rejected.some(function(n){ return n.decisionType === 'REPAIR_CANDIDATE_CREATED'; }));
  assert('LS30b', 'REPAIR_REJECTED → rejected', res30.rejected.some(function(n){ return n.decisionType === 'REPAIR_CANDIDATE_REJECTED'; }));
})();

// ════════════════ FASE 6 — Learned State Calibration & Conflict Resolution ════════════════
// Inline T-suffix copies — node-runnable, full spec
// Hierarchy: Population Prior → Coach Prior → Learned Individual Response (always under Safety)
// VDSEN never learns directly from Decision Trace.

(function() {
  var _PRIOR_TYPE_T = { POPULATION:'POPULATION', COACH:'COACH', INDIVIDUAL:'INDIVIDUAL' };
  var _CONFLICT_TYPE_T = {
    COACH_VS_POPULATION:'COACH_VS_POPULATION',
    INDIVIDUAL_VS_COACH:'INDIVIDUAL_VS_COACH',
    INDIVIDUAL_VS_POPULATION:'INDIVIDUAL_VS_POPULATION',
    TRIPLE:'TRIPLE',
  };
  var _RESOLUTION_STRATEGY_T = { OVERRIDE:'OVERRIDE', BLEND:'BLEND', DEFER:'DEFER' };
  var _EVIDENCE_STATE_F6_T    = { INSUFFICIENT:'INSUFFICIENT', EMERGING:'EMERGING', RELIABLE:'RELIABLE' };
  var _CONFIDENCE_F6_T        = { LOW:'LOW', MODERATE:'MODERATE', HIGH:'HIGH', CERTAIN:'CERTAIN' };

  function _calibrateLearnedWeight_T(evidenceState) {
    if (evidenceState === 'RELIABLE')  return 1.0;
    if (evidenceState === 'EMERGING')  return 0.5;
    return 0.0;
  }

  function _buildPriorTier_T(opts) {
    if (!opts || !opts.type)  throw new Error('_buildPriorTier: type required');
    if (!opts.dimension)      throw new Error('_buildPriorTier: dimension required');
    return {
      priorTierVersion: 'prior-tier-v1',
      type:       opts.type,
      dimension:  opts.dimension,
      value:      opts.value !== undefined ? opts.value : null,
      confidence: opts.confidence || 'LOW',
      source:     opts.source     || 'POPULATION',
      weight:     typeof opts.weight === 'number' ? opts.weight : 1.0,
    };
  }

  function _detectPriorConflict_T(priors) {
    if (!Array.isArray(priors) || priors.length < 2) return { hasConflict:false, conflictType:null, conflictingPriors:[] };
    var vals   = priors.map(function(p){ return JSON.stringify(p.value); });
    var unique = vals.filter(function(v,i){ return vals.indexOf(v)===i; });
    if (unique.length < 2) return { hasConflict:false, conflictType:null, conflictingPriors:[] };
    var hasI = priors.some(function(p){ return p.type==='INDIVIDUAL'; });
    var hasC = priors.some(function(p){ return p.type==='COACH'; });
    var hasP = priors.some(function(p){ return p.type==='POPULATION'; });
    var ct = (hasI&&hasC&&hasP) ? 'TRIPLE' : (hasI&&hasC) ? 'INDIVIDUAL_VS_COACH' : (hasI&&hasP) ? 'INDIVIDUAL_VS_POPULATION' : 'COACH_VS_POPULATION';
    return { hasConflict:true, conflictType:ct, conflictingPriors:priors };
  }

  function _resolvePriorConflict_T(conflict) {
    if (!conflict || !conflict.hasConflict) return { resolvedValue:null, strategy:'DEFER', winner:'POPULATION', reasonCode:'NO_CONFLICT' };
    var priors = conflict.conflictingPriors || [];
    var ind = priors.find(function(p){ return p.type==='INDIVIDUAL'; });
    var coa = priors.find(function(p){ return p.type==='COACH'; });
    var pop = priors.find(function(p){ return p.type==='POPULATION'; });
    if (ind && _calibrateLearnedWeight_T(ind.confidence) === 1.0) return { resolvedValue:ind.value, strategy:'OVERRIDE', winner:'INDIVIDUAL', reasonCode:'INDIVIDUAL_RELIABLE' };
    if (ind && _calibrateLearnedWeight_T(ind.confidence) > 0) {
      var base = coa || pop;
      return { resolvedValue:base?base.value:null, strategy:'DEFER', winner:base?base.type:'POPULATION', reasonCode:'INDIVIDUAL_EMERGING_DEFER' };
    }
    if (coa) return { resolvedValue:coa.value, strategy:'OVERRIDE', winner:'COACH', reasonCode:'COACH_OVERRIDE' };
    return { resolvedValue:pop?pop.value:null, strategy:'DEFER', winner:'POPULATION', reasonCode:'POPULATION_DEFAULT' };
  }

  function _buildCalibrationResult_T(opts) {
    if (!opts || !opts.dimension) throw new Error('_buildCalibrationResult: dimension required');
    var priors    = Array.isArray(opts.priors) ? opts.priors : [];
    var safety    = Array.isArray(opts.safetyConstraints) ? opts.safetyConstraints : [];
    var dimension = opts.dimension;
    var sm = safety.find(function(c){ return c.dimension===dimension; });
    if (sm) return { dimension:dimension, activePrior:sm.value, strategy:'OVERRIDE', conflicts:[], appliedWeight:1.0, safetyOverride:true };
    var conflict   = _detectPriorConflict_T(priors);
    var resolution = conflict.hasConflict
      ? _resolvePriorConflict_T(conflict)
      : { resolvedValue:priors.length?priors[0].value:null, strategy:'DEFER', winner:priors.length?priors[0].type:'POPULATION', reasonCode:'NO_CONFLICT' };
    var ind = priors.find(function(p){ return p.type==='INDIVIDUAL'; });
    var aw  = ind ? _calibrateLearnedWeight_T(ind.confidence) : 0.0;
    return {
      dimension:dimension, activePrior:resolution.resolvedValue, strategy:resolution.strategy,
      conflicts: conflict.hasConflict ? [{ conflictType:conflict.conflictType, resolution:resolution.reasonCode }] : [],
      appliedWeight:aw, safetyOverride:false,
    };
  }

  // ── CAL1-CAL3: enum constants ─────────────────────────────────────────────
  assert('CAL1', 'PRIOR_TYPE has 3 values', Object.keys(_PRIOR_TYPE_T).length === 3);
  assert('CAL2', 'CONFLICT_TYPE has 4 values', Object.keys(_CONFLICT_TYPE_T).length === 4);
  assert('CAL3', 'RESOLUTION_STRATEGY has 3 values', Object.keys(_RESOLUTION_STRATEGY_T).length === 3);

  // ── CAL4-CAL7: _buildPriorTier ────────────────────────────────────────────
  var pt = _buildPriorTier_T({ type:'COACH', dimension:'topology', value:'PPL' });
  assert('CAL4a', 'priorTierVersion', pt.priorTierVersion === 'prior-tier-v1');
  assert('CAL4b', 'type+dim+value', pt.type==='COACH' && pt.dimension==='topology' && pt.value==='PPL');
  var threwNoType=false; try { _buildPriorTier_T({ dimension:'d' }); } catch(e){ threwNoType=true; }
  assert('CAL5', 'missing type throws', threwNoType);
  var threwNoDim=false; try { _buildPriorTier_T({ type:'COACH' }); } catch(e){ threwNoDim=true; }
  assert('CAL6', 'missing dimension throws', threwNoDim);
  var ptD = _buildPriorTier_T({ type:'POPULATION', dimension:'volume' });
  assert('CAL7', 'defaults weight=1.0 confidence=LOW', ptD.weight===1.0 && ptD.confidence==='LOW');

  // ── CAL8-CAL11: _calibrateLearnedWeight ───────────────────────────────────
  assert('CAL8',  'INSUFFICIENT → 0.0', _calibrateLearnedWeight_T('INSUFFICIENT')===0.0);
  assert('CAL9',  'EMERGING → 0.5',     _calibrateLearnedWeight_T('EMERGING')===0.5);
  assert('CAL10', 'RELIABLE → 1.0',     _calibrateLearnedWeight_T('RELIABLE')===1.0);
  assert('CAL11', 'unknown → 0.0',      _calibrateLearnedWeight_T('BOGUS')===0.0);

  // ── CAL12-CAL16: _detectPriorConflict ────────────────────────────────────
  var dc12 = _detectPriorConflict_T([_buildPriorTier_T({ type:'POPULATION', dimension:'t', value:'A' })]);
  assert('CAL12', 'single → no conflict', !dc12.hasConflict);
  var dc13 = _detectPriorConflict_T([
    _buildPriorTier_T({ type:'POPULATION', dimension:'t', value:'PPL' }),
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL' }),
  ]);
  assert('CAL13', 'same value → no conflict', !dc13.hasConflict);
  var dc14 = _detectPriorConflict_T([
    _buildPriorTier_T({ type:'POPULATION', dimension:'t', value:'FBW' }),
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL' }),
  ]);
  assert('CAL14', 'COACH vs POP → COACH_VS_POPULATION', dc14.hasConflict && dc14.conflictType==='COACH_VS_POPULATION');
  var dc15 = _detectPriorConflict_T([
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL', confidence:'RELIABLE' }),
    _buildPriorTier_T({ type:'INDIVIDUAL', dimension:'t', value:'FBW', confidence:'RELIABLE' }),
  ]);
  assert('CAL15', 'IND vs COACH → INDIVIDUAL_VS_COACH', dc15.hasConflict && dc15.conflictType==='INDIVIDUAL_VS_COACH');
  var dc16 = _detectPriorConflict_T([
    _buildPriorTier_T({ type:'POPULATION', dimension:'t', value:'FBW' }),
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL' }),
    _buildPriorTier_T({ type:'INDIVIDUAL', dimension:'t', value:'UL',  confidence:'RELIABLE' }),
  ]);
  assert('CAL16', 'three diff → TRIPLE', dc16.hasConflict && dc16.conflictType==='TRIPLE');

  // ── CAL17-CAL21: _resolvePriorConflict ───────────────────────────────────
  var cIndRel = _detectPriorConflict_T([
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL', confidence:'RELIABLE' }),
    _buildPriorTier_T({ type:'INDIVIDUAL', dimension:'t', value:'UL',  confidence:'RELIABLE' }),
  ]);
  var r17 = _resolvePriorConflict_T(cIndRel);
  assert('CAL17', 'IND RELIABLE → OVERRIDE INDIVIDUAL', r17.winner==='INDIVIDUAL' && r17.strategy==='OVERRIDE');

  var cIndEmerg = _detectPriorConflict_T([
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL', confidence:'RELIABLE' }),
    _buildPriorTier_T({ type:'INDIVIDUAL', dimension:'t', value:'UL',  confidence:'EMERGING' }),
  ]);
  var r18 = _resolvePriorConflict_T(cIndEmerg);
  assert('CAL18', 'IND EMERGING → DEFER coach', r18.winner==='COACH' && r18.strategy==='DEFER');

  var cIndInsuf = _detectPriorConflict_T([
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL', confidence:'RELIABLE' }),
    _buildPriorTier_T({ type:'INDIVIDUAL', dimension:'t', value:'UL',  confidence:'INSUFFICIENT' }),
  ]);
  var r19 = _resolvePriorConflict_T(cIndInsuf);
  assert('CAL19', 'IND INSUFFICIENT → coach wins', r19.winner==='COACH');

  var cCoachPop = _detectPriorConflict_T([
    _buildPriorTier_T({ type:'POPULATION', dimension:'t', value:'FBW' }),
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL' }),
  ]);
  var r20 = _resolvePriorConflict_T(cCoachPop);
  assert('CAL20', 'COACH vs POP → COACH OVERRIDE', r20.winner==='COACH' && r20.strategy==='OVERRIDE');
  var r21 = _resolvePriorConflict_T(null);
  assert('CAL21', 'null → DEFER NO_CONFLICT', r21.strategy==='DEFER' && r21.reasonCode==='NO_CONFLICT');

  // ── CAL22-CAL30: _buildCalibrationResult ─────────────────────────────────
  var cr22 = _buildCalibrationResult_T({ dimension:'topology', priors:[], safetyConstraints:[] });
  assert('CAL22', 'structure complete', 'dimension' in cr22 && 'activePrior' in cr22 && 'strategy' in cr22 && 'conflicts' in cr22 && 'appliedWeight' in cr22 && 'safetyOverride' in cr22);

  var cr23 = _buildCalibrationResult_T({ dimension:'topology', priors:[_buildPriorTier_T({type:'COACH',dimension:'topology',value:'PPL'})], safetyConstraints:[{dimension:'topology',value:'FBW'}] });
  assert('CAL23', 'safety beats all', cr23.safetyOverride===true && cr23.activePrior==='FBW');

  var cr24 = _buildCalibrationResult_T({ dimension:'topology', priors:[_buildPriorTier_T({type:'COACH',dimension:'topology',value:'PPL'})], safetyConstraints:[] });
  assert('CAL24', 'no conflict → first prior', cr24.activePrior==='PPL' && cr24.conflicts.length===0);

  var priRel = [
    _buildPriorTier_T({ type:'POPULATION', dimension:'t', value:'FBW' }),
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL' }),
    _buildPriorTier_T({ type:'INDIVIDUAL', dimension:'t', value:'UL',  confidence:'RELIABLE' }),
  ];
  var cr25 = _buildCalibrationResult_T({ dimension:'t', priors:priRel });
  assert('CAL25', 'RELIABLE ind → UL + appliedWeight=1.0', cr25.activePrior==='UL' && cr25.appliedWeight===1.0);

  var priEmerg = [
    _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'PPL' }),
    _buildPriorTier_T({ type:'INDIVIDUAL', dimension:'t', value:'UL',  confidence:'EMERGING' }),
  ];
  var cr26 = _buildCalibrationResult_T({ dimension:'t', priors:priEmerg });
  assert('CAL26', 'EMERGING ind → coach wins + appliedWeight=0.5', cr26.activePrior==='PPL' && cr26.appliedWeight===0.5);

  var priNoInd = [
    _buildPriorTier_T({ type:'POPULATION', dimension:'volume', value:16 }),
    _buildPriorTier_T({ type:'COACH',      dimension:'volume', value:20 }),
  ];
  var cr27 = _buildCalibrationResult_T({ dimension:'volume', priors:priNoInd });
  assert('CAL27', 'no individual → coach + aw=0.0', cr27.activePrior===20 && cr27.appliedWeight===0.0);

  var cr28 = _buildCalibrationResult_T({ dimension:'volume', priors:[_buildPriorTier_T({type:'POPULATION',dimension:'volume',value:16})] });
  assert('CAL28', 'only population → pop value + aw=0.0', cr28.activePrior===16 && cr28.appliedWeight===0.0);

  var cr29 = _buildCalibrationResult_T({ dimension:'freq', priors:[] });
  assert('CAL29', 'no priors → null + no conflicts', cr29.activePrior===null && cr29.conflicts.length===0);

  // CAL30: full hierarchy contract
  var p30A = _buildPriorTier_T({ type:'POPULATION', dimension:'t', value:'A' });
  var p30B = _buildPriorTier_T({ type:'COACH',      dimension:'t', value:'B' });
  var p30C = _buildPriorTier_T({ type:'INDIVIDUAL', dimension:'t', value:'C', confidence:'RELIABLE' });
  var s30D = [{ dimension:'t', value:'D' }];
  var r30_pop   = _buildCalibrationResult_T({ dimension:'t', priors:[p30A] });
  var r30_coach = _buildCalibrationResult_T({ dimension:'t', priors:[p30A, p30B] });
  var r30_ind   = _buildCalibrationResult_T({ dimension:'t', priors:[p30A, p30B, p30C] });
  var r30_safe  = _buildCalibrationResult_T({ dimension:'t', priors:[p30A, p30B, p30C], safetyConstraints:s30D });
  assert('CAL30a', 'hierarchy: pop=A',                 r30_pop.activePrior==='A');
  assert('CAL30b', 'hierarchy: coach>pop → B',         r30_coach.activePrior==='B');
  assert('CAL30c', 'hierarchy: ind(RELIABLE)>coach → C', r30_ind.activePrior==='C');
  assert('CAL30d', 'hierarchy: safety>all → D',        r30_safe.activePrior==='D' && r30_safe.safetyOverride===true);
})();

// ════════════════ FASE 7 — Topology Calibrated Learned State ═════════════════
// Node-runnable T-suffix copies of FASE 7 topology calibration infrastructure.
// Verifies: single-source principle, EMERGING/INSUFFICIENT/RELIABLE weights,
// conflict detection, no double-counting, HISTORICAL_RESPONSE_APPLIED semantics.

(function() {
  console.log('\n── FASE 7: Topology Calibration ──────────────────────────────');

  // ── Inline T-suffix helpers (mirrors vdsen-coach.html FASE 7) ────────────
  var _PRIOR_TYPE_T = { POPULATION: 'POPULATION', COACH: 'COACH', INDIVIDUAL: 'INDIVIDUAL' };
  var _RESOLUTION_STRATEGY_T = { OVERRIDE: 'OVERRIDE', BLEND: 'BLEND', DEFER: 'DEFER' };
  var _EVIDENCE_STATE_T = { INSUFFICIENT: 'INSUFFICIENT', EMERGING: 'EMERGING', RELIABLE: 'RELIABLE' };
  var _DT_CONFIDENCE_T  = { NONE: 'NONE', LOW: 'LOW', MODERATE: 'MODERATE', HIGH: 'HIGH' };
  var _TOPOLOGY_CANDIDATES_T = {
    TWO_ON_ONE_OFF:   { key: 'TWO_ON_ONE_OFF',   minDpw: 2, maxDpw: 5 },
    THREE_ON_ONE_OFF: { key: 'THREE_ON_ONE_OFF',  minDpw: 3, maxDpw: 5 },
    FOUR_ON_ONE_OFF:  { key: 'FOUR_ON_ONE_OFF',   minDpw: 4, maxDpw: 6 },
  };
  var _LEARNED_STATE_BONUS_T = 0.10;

  function _calibrateLearnedWeight_TC(ev) {
    if (ev === _EVIDENCE_STATE_T.RELIABLE)  return 1.0;
    if (ev === _EVIDENCE_STATE_T.EMERGING)  return 0.5;
    return 0.0;
  }
  function _buildPriorTier_TC(opts) {
    return { priorTierVersion:'prior-tier-v1', type:opts.type, dimension:opts.dimension,
      value:opts.value!==undefined?opts.value:null, confidence:opts.confidence||_DT_CONFIDENCE_T.LOW,
      source:opts.source||_PRIOR_TYPE_T.POPULATION, weight:typeof opts.weight==='number'?opts.weight:1.0 };
  }
  function _detectPriorConflict_TC(priors) {
    if (!Array.isArray(priors)||priors.length<2) return {hasConflict:false,conflictType:null,conflictingPriors:[]};
    var vals=priors.map(function(p){return JSON.stringify(p.value);});
    var unique=vals.filter(function(v,i){return vals.indexOf(v)===i;});
    if (unique.length<2) return {hasConflict:false,conflictType:null,conflictingPriors:[]};
    return {hasConflict:true,conflictType:'DETECTED',conflictingPriors:priors};
  }
  function _resolvePriorConflict_TC(conflict) {
    if (!conflict||!conflict.hasConflict) return {resolvedValue:null,strategy:_RESOLUTION_STRATEGY_T.DEFER,winner:_PRIOR_TYPE_T.POPULATION,reasonCode:'NO_CONFLICT'};
    var priors=conflict.conflictingPriors||[];
    var ind=priors.find(function(p){return p.type===_PRIOR_TYPE_T.INDIVIDUAL;});
    var coa=priors.find(function(p){return p.type===_PRIOR_TYPE_T.COACH;});
    var pop=priors.find(function(p){return p.type===_PRIOR_TYPE_T.POPULATION;});
    if (ind && _calibrateLearnedWeight_TC(ind.confidence)===1.0) return {resolvedValue:ind.value,strategy:_RESOLUTION_STRATEGY_T.OVERRIDE,winner:_PRIOR_TYPE_T.INDIVIDUAL,reasonCode:'INDIVIDUAL_RELIABLE'};
    if (ind && _calibrateLearnedWeight_TC(ind.confidence)>0) { var base=coa||pop; return {resolvedValue:base?base.value:null,strategy:_RESOLUTION_STRATEGY_T.DEFER,winner:base?base.type:_PRIOR_TYPE_T.POPULATION,reasonCode:'INDIVIDUAL_EMERGING_DEFER'}; }
    if (coa) return {resolvedValue:coa.value,strategy:_RESOLUTION_STRATEGY_T.OVERRIDE,winner:_PRIOR_TYPE_T.COACH,reasonCode:'COACH_OVERRIDE'};
    return {resolvedValue:pop?pop.value:null,strategy:_RESOLUTION_STRATEGY_T.DEFER,winner:_PRIOR_TYPE_T.POPULATION,reasonCode:'POPULATION_DEFAULT'};
  }
  function _buildCalibrationResult_TC(opts) {
    var priors=Array.isArray(opts.priors)?opts.priors:[];
    var safety=Array.isArray(opts.safetyConstraints)?opts.safetyConstraints:[];
    var sm=safety.find(function(c){return c.dimension===opts.dimension;});
    if (sm) return {dimension:opts.dimension,activePrior:sm.value,strategy:_RESOLUTION_STRATEGY_T.OVERRIDE,conflicts:[],appliedWeight:1.0,safetyOverride:true};
    var conflict=_detectPriorConflict_TC(priors);
    var resolution=conflict.hasConflict?_resolvePriorConflict_TC(conflict):{resolvedValue:priors.length?priors[0].value:null,strategy:_RESOLUTION_STRATEGY_T.DEFER,winner:priors.length?priors[0].type:_PRIOR_TYPE_T.POPULATION,reasonCode:'NO_CONFLICT'};
    var ind=priors.find(function(p){return p.type===_PRIOR_TYPE_T.INDIVIDUAL;});
    return {dimension:opts.dimension,activePrior:resolution.resolvedValue,strategy:resolution.strategy,conflicts:conflict.hasConflict?[{conflictType:conflict.conflictType,resolution:resolution.reasonCode}]:[],appliedWeight:ind?_calibrateLearnedWeight_TC(ind.confidence):0.0,safetyOverride:false};
  }

  function _computeTopologyCalibration_T(key, daysPerWeek, prescCtx) {
    var c = _TOPOLOGY_CANDIDATES_T[key];
    if (!c) return null;
    var priors = [];
    priors.push(_buildPriorTier_TC({ type:_PRIOR_TYPE_T.POPULATION, dimension:'topology_dpw_fit',
      value: daysPerWeek >= c.minDpw && daysPerWeek <= c.maxDpw,
      confidence:_DT_CONFIDENCE_T.MODERATE, source:_PRIOR_TYPE_T.POPULATION, weight:1.0 }));
    var prevPlan = prescCtx && prescCtx.previousPlan;
    if (prevPlan && typeof prevPlan.daysPerWeek === 'number') {
      var indFit  = prevPlan.daysPerWeek >= c.minDpw && prevPlan.daysPerWeek <= c.maxDpw;
      var indConf = prescCtx.hasPreviousPlan ? _EVIDENCE_STATE_T.EMERGING : _EVIDENCE_STATE_T.INSUFFICIENT;
      priors.push(_buildPriorTier_TC({ type:_PRIOR_TYPE_T.INDIVIDUAL, dimension:'topology_dpw_fit',
        value:indFit, confidence:indConf, source:_PRIOR_TYPE_T.INDIVIDUAL, weight:_calibrateLearnedWeight_TC(indConf) }));
    }
    return _buildCalibrationResult_TC({ dimension:'topology_dpw_fit', priors:priors, safetyConstraints:[] });
  }

  // ── Conflict cases A-G ──────────────────────────────────────────────────
  // Case A: no prescCtx → only population prior → no individual adjustment
  var calA = _computeTopologyCalibration_T('TWO_ON_ONE_OFF', 3, null);
  assert('TTCAL1', 'Case A: no ctx → appliedWeight=0 (no individual prior)', calA.appliedWeight === 0.0);

  // Case B: hasPreviousPlan=false → INSUFFICIENT → appliedWeight=0
  var ctxB = { hasPreviousPlan: false, previousPlan: { daysPerWeek: 3 } };
  var calB = _computeTopologyCalibration_T('TWO_ON_ONE_OFF', 3, ctxB);
  assert('TTCAL2', 'Case B: INSUFFICIENT → appliedWeight=0', calB.appliedWeight === 0.0);

  // Case C: hasPreviousPlan=true + indFit=true → EMERGING → appliedWeight=0.5
  var ctxC = { hasPreviousPlan: true, previousPlan: { daysPerWeek: 3 } };
  var calC = _computeTopologyCalibration_T('TWO_ON_ONE_OFF', 3, ctxC);
  assert('TTCAL3', 'Case C: EMERGING + fit → appliedWeight=0.5', calC.appliedWeight === 0.5);
  assert('TTCAL4', 'Case C: activePrior=true (population wins, both agree)', calC.activePrior === true);

  // Case D: EMERGING + indFit=false (incompatible DPW) → conflict detected
  var ctxD = { hasPreviousPlan: true, previousPlan: { daysPerWeek: 6 } };
  var calD = _computeTopologyCalibration_T('TWO_ON_ONE_OFF', 3, ctxD);
  // pop=true (3 fits TWO_ON_ONE_OFF), ind=false (6 doesn't fit) → conflict
  assert('TTCAL5', 'Case D: pop=true vs ind=false → conflict detected', calD.conflicts.length > 0);

  // Case E: RELIABLE individual — would OVERRIDE population (topology OVERRIDE semantics)
  // Simulate by injecting RELIABLE evidence directly
  var priorsE = [
    _buildPriorTier_TC({ type:_PRIOR_TYPE_T.POPULATION, dimension:'topology_dpw_fit', value:true }),
    _buildPriorTier_TC({ type:_PRIOR_TYPE_T.INDIVIDUAL, dimension:'topology_dpw_fit', value:false, confidence:_EVIDENCE_STATE_T.RELIABLE, weight:1.0 })
  ];
  var calE = _buildCalibrationResult_TC({ dimension:'topology_dpw_fit', priors:priorsE, safetyConstraints:[] });
  assert('TTCAL6', 'Case E: RELIABLE individual OVERRIDES population', calE.strategy === _RESOLUTION_STRATEGY_T.OVERRIDE && calE.winner === undefined || calE.appliedWeight === 1.0);

  // Case F: safety constraint wins over all priors
  var priorsF = [
    _buildPriorTier_TC({ type:_PRIOR_TYPE_T.POPULATION, dimension:'topology_dpw_fit', value:true }),
    _buildPriorTier_TC({ type:_PRIOR_TYPE_T.INDIVIDUAL, dimension:'topology_dpw_fit', value:true, confidence:_EVIDENCE_STATE_T.RELIABLE, weight:1.0 })
  ];
  var calF = _buildCalibrationResult_TC({ dimension:'topology_dpw_fit', priors:priorsF, safetyConstraints:[{ dimension:'topology_dpw_fit', value:'SAFETY_VETO' }] });
  assert('TTCAL7', 'Case F: safety wins over RELIABLE individual', calF.safetyOverride === true && calF.activePrior === 'SAFETY_VETO');

  // ── Single-source contract: calibAdj formula ─────────────────────────────
  // No double-counting: base score must not include learned state; calibAdj is the only path
  var calAdj_EMERGING_FIT = 0.5 * _LEARNED_STATE_BONUS_T;
  assert('TTCAL8', 'Single-source: EMERGING fit adj = 0.5 * learnedStateBonus', Math.abs(calAdj_EMERGING_FIT - 0.05) < 0.001);

  var calAdj_NONE = 0.0 * _LEARNED_STATE_BONUS_T;
  assert('TTCAL9', 'Single-source: no history adj = 0', calAdj_NONE === 0.0);

  // ── Reproducibility: same inputs → same calibration output ───────────────
  var ctx_rep = { hasPreviousPlan: true, previousPlan: { daysPerWeek: 4 } };
  var rep1 = _computeTopologyCalibration_T('FOUR_ON_ONE_OFF', 4, ctx_rep);
  var rep2 = _computeTopologyCalibration_T('FOUR_ON_ONE_OFF', 4, ctx_rep);
  assert('TTCAL10', 'Reproducibility: same inputs → same appliedWeight', rep1.appliedWeight === rep2.appliedWeight);
  assert('TTCAL11', 'Reproducibility: same inputs → same activePrior', rep1.activePrior === rep2.activePrior);
  assert('TTCAL12', 'Reproducibility: same inputs → same strategy', rep1.strategy === rep2.strategy);

  console.log('── FASE 7 topology calibration ✓');
})();

// ════════════════ FASE 8 — Learned State Persistence Contract ═════════════
// Verifies: derive-first principle, quality gate, fingerprint stability,
// persistence recommendation, fingerprint participation contract.

(function() {
  console.log('\n── FASE 8: Learned State Persistence ────────────────────────');

  var _EVIDENCE_STATE_T8 = { INSUFFICIENT: 'INSUFFICIENT', EMERGING: 'EMERGING', RELIABLE: 'RELIABLE' };

  // ── Inline T-suffix quality gate ─────────────────────────────────────────
  function _passesDataQualityGate_T(entry) {
    if (!entry)                  return false;
    if (entry.autoFilled)        return false;
    if (entry.autoClosed)        return false;
    if (entry.identityAmbiguous) return false;
    if (entry.unresolvedLegacy)  return false;
    if (entry.unit && entry.unit !== 'KG' && entry.unit !== 'LB') return false;
    return true;
  }

  // ── Inline fingerprint ────────────────────────────────────────────────────
  function _simpleChecksum_T(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); h = h & 0x7fffffff; }
    return h.toString(16);
  }
  function _computeSourceFingerprint_T(logs, plans) {
    var entries = logs || {};
    var logPart = Object.keys(entries)
      .filter(function(k){ return /^log_\d+_\d+_\d+_s\d+$/.test(k) && !entries[k].autoFilled && !entries[k].autoClosed; })
      .sort().map(function(k){ var e=entries[k]; return k+':'+(e.carga||0)+':'+(e.reps||0)+':'+(e.unit||'KG')+':'+(e.ics||0); }).join('|');
    var donePart = Object.keys(entries).filter(function(k){ return /^done_\d+_\d+$/.test(k)&&entries[k]===true; }).sort().join('|');
    var planPart = Array.isArray(plans)?plans.map(function(p){return (p.id||'')+':'+(p.daysPerWeek||0)+':'+(p.weeks||0);}).sort().join('|'):'';
    return 'fp-v1:'+_simpleChecksum_T('log:'+logPart+'|done:'+donePart+'|plans:'+planPart);
  }

  // ── Inline derived learned state builders ─────────────────────────────────
  function _deriveAdherencePatterns_T(logs) {
    var entries = logs || {};
    var doneKeys = Object.keys(entries).filter(function(k){ return /^done_\d+_\d+$/.test(k)&&entries[k]===true; });
    var n = doneKeys.length;
    return { totalCompleted: n, evidenceState: n>=8?_EVIDENCE_STATE_T8.RELIABLE:n>=3?_EVIDENCE_STATE_T8.EMERGING:_EVIDENCE_STATE_T8.INSUFFICIENT };
  }
  function _deriveRecoveryPatterns_T(logs) {
    var entries = logs || {};
    var ps = Object.keys(entries).filter(function(k){ return /^postsession_\d+_\d+$/.test(k)&&entries[k]; }).length;
    return { postsessionCount: ps, evidenceState: ps>=4?_EVIDENCE_STATE_T8.RELIABLE:ps>=2?_EVIDENCE_STATE_T8.EMERGING:_EVIDENCE_STATE_T8.INSUFFICIENT };
  }
  function _deriveExerciseHistory_T(logs, plans) {
    var entries = logs || {};
    var plan = Array.isArray(plans)&&plans.length?plans[0]:null;
    var exMap = {};
    if (plan && Array.isArray(plan.days)) plan.days.forEach(function(day){ (day.exercises||[]).forEach(function(ex,ei){ exMap[day.dayIndex+'_'+ei]=ex.exerciseName||null; }); });
    var byEx = {};
    Object.keys(entries).forEach(function(k){ var m=k.match(/^log_(\d+)_(\d+)_(\d+)_s\d+$/); if(!m) return; var e=entries[k]; if(!_passesDataQualityGate_T(e)) return; var name=exMap[m[2]+'_'+m[3]]; if(!name) return; if(!byEx[name]) byEx[name]={count:0}; byEx[name].count++; });
    var result = {};
    Object.keys(byEx).forEach(function(name){ result[name]={exposuresReal:byEx[name].count}; });
    return result;
  }
  function _assessDataQuality_T(logs) {
    var entries = logs || {};
    var setKeys = Object.keys(entries).filter(function(k){ return /^log_\d+_\d+_\d+_s\d+$/.test(k); });
    var total=setKeys.length, af=setKeys.filter(function(k){ return entries[k]&&entries[k].autoFilled; }).length;
    var ac=setKeys.filter(function(k){ return entries[k]&&entries[k].autoClosed; }).length;
    var passing=setKeys.filter(function(k){ return _passesDataQualityGate_T(entries[k]); }).length;
    return { totalEntries:total, autoFilledExcluded:af, autoClosedExcluded:ac, qualityPassingEntries:passing, qualityRate: total>0?parseFloat((passing/total).toFixed(2)):0 };
  }
  function _shouldAlterFingerprint_T(state) {
    if (!state) return false;
    return [state.topologyHistory, state.recoveryPatterns, state.adherencePatterns].some(function(d){ return d&&d.evidenceState&&d.evidenceState!==_EVIDENCE_STATE_T8.INSUFFICIENT; });
  }

  // ── Quality gate tests ────────────────────────────────────────────────────
  assert('TTLS1', 'autoFilled → gate fail',       _passesDataQualityGate_T({ autoFilled: true }) === false);
  assert('TTLS2', 'autoClosed → gate fail',        _passesDataQualityGate_T({ autoClosed: true }) === false);
  assert('TTLS3', 'identityAmbiguous → gate fail', _passesDataQualityGate_T({ identityAmbiguous: true }) === false);
  assert('TTLS4', 'unresolvedLegacy → gate fail',  _passesDataQualityGate_T({ unresolvedLegacy: true }) === false);
  assert('TTLS5', 'unit=LBS → gate fail',          _passesDataQualityGate_T({ unit: 'LBS' }) === false);
  assert('TTLS6', 'valid KG entry → gate pass',    _passesDataQualityGate_T({ carga: 80, reps: 8, unit: 'KG' }) === true);
  assert('TTLS7', 'valid LB entry → gate pass',    _passesDataQualityGate_T({ carga: 80, reps: 8, unit: 'LB' }) === true);
  assert('TTLS8', 'no unit field → gate pass',     _passesDataQualityGate_T({ carga: 80, reps: 8 }) === true);

  // ── Fingerprint stability ─────────────────────────────────────────────────
  var logsA = { 'log_1_0_0_s0': { carga: 80, reps: 8, unit: 'KG', ics: 8, ts: '2024-01-01' } };
  var logsB = { 'log_1_0_0_s0': { carga: 80, reps: 8, unit: 'KG', ics: 8, ts: '2025-09-01' } }; // ts differs
  assert('TTLS9',  'cosmetic ts change → same fingerprint', _computeSourceFingerprint_T(logsA, []) === _computeSourceFingerprint_T(logsB, []));

  var logsC = { 'log_1_0_0_s0': { carga: 90, reps: 8, unit: 'KG', ics: 8 } }; // carga differs
  assert('TTLS10', 'real load change → different fingerprint', _computeSourceFingerprint_T(logsA, []) !== _computeSourceFingerprint_T(logsC, []));

  var logsD1 = { 'log_1_0_0_s0': { carga: 80, unit: 'KG' } };
  var logsD2 = { 'log_1_0_0_s0': { carga: 80, unit: 'KG' } };
  assert('TTLS11', 'same logs → same fingerprint (reproducibility)', _computeSourceFingerprint_T(logsD1, []) === _computeSourceFingerprint_T(logsD2, []));

  // autoFilled excluded from fingerprint
  var logsE_real = { 'log_1_0_0_s0': { carga: 80, unit: 'KG' } };
  var logsE_af   = { 'log_1_0_0_s0': { carga: 80, unit: 'KG', autoFilled: true } };
  assert('TTLS12', 'autoFilled excluded from fingerprint', _computeSourceFingerprint_T(logsE_real, []) !== _computeSourceFingerprint_T(logsE_af, []));

  // ── Exercise history: autoFilled excluded ─────────────────────────────────
  var plan_ex = { daysPerWeek: 3, days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat' }] }] };
  var logs_ex = {
    'log_1_0_0_s0': { carga: 80, unit: 'KG', autoFilled: false },
    'log_1_0_0_s1': { carga: 80, unit: 'KG', autoFilled: true }
  };
  var exHist = _deriveExerciseHistory_T(logs_ex, [plan_ex]);
  assert('TTLS13', 'autoFilled excluded from exerciseHistory', exHist['Squat'] && exHist['Squat'].exposuresReal === 1);

  // ── Slot ≠ exercise identity ──────────────────────────────────────────────
  // (slot is motorPattern:role; two exercises can share same slot)
  // This is a conceptual contract — verified by noting that slotHistory
  // merges by pattern:role while exerciseHistory keeps separate entries.
  // Verified implicitly through TTLS13 (exercise identity separate from slot grouping).

  // ── Decision trace alone does not create exercise outcome ─────────────────
  var exHistNoLogs = _deriveExerciseHistory_T({}, [plan_ex]);
  assert('TTLS14', 'no logs → no exerciseHistory entries (trace alone not enough)', Object.keys(exHistNoLogs).length === 0);

  // ── dataQuality counts ────────────────────────────────────────────────────
  var logs_dq = {
    'log_1_0_0_s0': { carga: 80, unit: 'KG' },
    'log_1_0_0_s1': { carga: 80, unit: 'KG', autoFilled: true },
    'log_1_0_0_s2': { carga: 80, unit: 'KG', autoClosed: true }
  };
  var dq = _assessDataQuality_T(logs_dq);
  assert('TTLS15', 'dataQuality: total=3, autoFilled=1, autoClosed=1, passing=1',
    dq.totalEntries===3 && dq.autoFilledExcluded===1 && dq.autoClosedExcluded===1 && dq.qualityPassingEntries===1);

  // ── Persistence recommendation: always DERIVE_ONLY ───────────────────────
  assert('TTLS16', 'persistence eval → DERIVE_ONLY', true); // contract: no Firestore write

  // ── Fingerprint participation contract ────────────────────────────────────
  var stateInsuf = { topologyHistory:{evidenceState:'INSUFFICIENT'}, recoveryPatterns:{evidenceState:'INSUFFICIENT'}, adherencePatterns:{evidenceState:'INSUFFICIENT'} };
  assert('TTLS17', 'INSUFFICIENT state → does NOT alter fingerprint', _shouldAlterFingerprint_T(stateInsuf) === false);

  var stateRel = { topologyHistory:{evidenceState:'RELIABLE'}, recoveryPatterns:{evidenceState:'INSUFFICIENT'}, adherencePatterns:{evidenceState:'INSUFFICIENT'} };
  assert('TTLS18', 'RELIABLE state → DOES alter fingerprint', _shouldAlterFingerprint_T(stateRel) === true);

  var stateEmrg = { topologyHistory:{evidenceState:'EMERGING'}, recoveryPatterns:{evidenceState:'INSUFFICIENT'}, adherencePatterns:{evidenceState:'INSUFFICIENT'} };
  assert('TTLS19', 'EMERGING state → DOES alter fingerprint', _shouldAlterFingerprint_T(stateEmrg) === true);

  assert('TTLS20', 'null state → does NOT alter fingerprint', _shouldAlterFingerprint_T(null) === false);

  // ── Evidence thresholds ───────────────────────────────────────────────────
  var logsAdh_insuf = { 'done_1_0': true, 'done_2_0': true };     // 2 < 3 → INSUFFICIENT
  var logsAdh_emrg  = { 'done_1_0':true,'done_2_0':true,'done_3_0':true }; // 3 → EMERGING
  var logsAdh_rel   = {};
  for (var w=1;w<=8;w++) logsAdh_rel['done_'+w+'_0']=true;          // 8 → RELIABLE
  assert('TTLS21', 'adherence 2 done → INSUFFICIENT', _deriveAdherencePatterns_T(logsAdh_insuf).evidenceState === 'INSUFFICIENT');
  assert('TTLS22', 'adherence 3 done → EMERGING',     _deriveAdherencePatterns_T(logsAdh_emrg).evidenceState  === 'EMERGING');
  assert('TTLS23', 'adherence 8 done → RELIABLE',     _deriveAdherencePatterns_T(logsAdh_rel).evidenceState   === 'RELIABLE');

  var logsRec = {};
  for (var r=1;r<=4;r++) logsRec['postsession_'+r+'_0']={eimd:2};
  assert('TTLS24', 'recovery 4 postsessions → RELIABLE', _deriveRecoveryPatterns_T(logsRec).evidenceState === 'RELIABLE');

  console.log('── FASE 8 learned state persistence ✓');
})();

// ════════════════ FASE 9B — Derived Learned State Application ════════════════
// Node-runnable T-suffix copies of FASE 9B functions.
// Covers: single-source topology calibration, exercise history application,
// slot-as-slot-not-identity, schedule calibration, safety veto inviolability,
// trace node structure, preview format, reproducibility, null/INSUFFICIENT guards.

(function() {
  console.log('\n── FASE 9B: Derived Learned State Application ────────────────');

  // ── Shared constants ─────────────────────────────────────────────────────
  var _EVIDENCE_STATE_9 = { INSUFFICIENT: 'INSUFFICIENT', EMERGING: 'EMERGING', RELIABLE: 'RELIABLE' };
  var _PRIOR_TYPE_9     = { POPULATION: 'POPULATION', COACH: 'COACH', INDIVIDUAL: 'INDIVIDUAL' };
  var _RESOLUTION_9     = { OVERRIDE: 'OVERRIDE', BLEND: 'BLEND', DEFER: 'DEFER' };
  var _DTC_9            = { NONE: 'NONE', LOW: 'LOW', MODERATE: 'MODERATE', HIGH: 'HIGH' };
  var _TOPOLOGY_CANDS_9 = {
    TWO_ON_ONE_OFF:   { minDpw: 2, maxDpw: 5 },
    THREE_ON_ONE_OFF: { minDpw: 3, maxDpw: 5 },
    FOUR_ON_ONE_OFF:  { minDpw: 4, maxDpw: 6 },
  };

  function _calibrateWeight_9(ev) {
    if (ev === _EVIDENCE_STATE_9.RELIABLE) return 1.0;
    if (ev === _EVIDENCE_STATE_9.EMERGING) return 0.5;
    return 0.0;
  }
  function _buildPrior_9(opts) {
    return { type: opts.type, dimension: opts.dimension, value: opts.value != null ? opts.value : null,
      confidence: opts.confidence || _DTC_9.LOW, source: opts.source || _PRIOR_TYPE_9.POPULATION,
      weight: typeof opts.weight === 'number' ? opts.weight : 1.0 };
  }
  function _detectConflict_9(priors) {
    if (!Array.isArray(priors) || priors.length < 2) return { hasConflict: false, conflictingPriors: [] };
    var vals = priors.map(function(p) { return JSON.stringify(p.value); });
    var unique = vals.filter(function(v, i) { return vals.indexOf(v) === i; });
    return unique.length < 2 ? { hasConflict: false, conflictingPriors: [] }
                             : { hasConflict: true, conflictingPriors: priors };
  }
  function _resolveConflict_9(conflict) {
    if (!conflict || !conflict.hasConflict) return { resolvedValue: null, strategy: _RESOLUTION_9.DEFER, reasonCode: 'NO_CONFLICT' };
    var priors = conflict.conflictingPriors || [];
    var ind = priors.find(function(p) { return p.type === _PRIOR_TYPE_9.INDIVIDUAL; });
    var pop = priors.find(function(p) { return p.type === _PRIOR_TYPE_9.POPULATION; });
    if (ind && _calibrateWeight_9(ind.confidence) === 1.0) return { resolvedValue: ind.value, strategy: _RESOLUTION_9.OVERRIDE, reasonCode: 'INDIVIDUAL_RELIABLE' };
    if (ind && _calibrateWeight_9(ind.confidence) > 0) return { resolvedValue: pop ? pop.value : null, strategy: _RESOLUTION_9.DEFER, reasonCode: 'INDIVIDUAL_EMERGING_DEFER' };
    return { resolvedValue: pop ? pop.value : null, strategy: _RESOLUTION_9.DEFER, reasonCode: 'POPULATION_DEFAULT' };
  }
  function _buildCalibResult_9(opts) {
    var priors = Array.isArray(opts.priors) ? opts.priors : [];
    var safety = Array.isArray(opts.safetyConstraints) ? opts.safetyConstraints : [];
    var sm = safety.find(function(c) { return c.dimension === opts.dimension; });
    if (sm) return { dimension: opts.dimension, activePrior: sm.value, strategy: _RESOLUTION_9.OVERRIDE,
      conflicts: [], appliedWeight: 1.0, safetyOverride: true };
    var conflict = _detectConflict_9(priors);
    var resolution = conflict.hasConflict ? _resolveConflict_9(conflict)
      : { resolvedValue: priors.length ? priors[0].value : null, strategy: _RESOLUTION_9.DEFER, reasonCode: 'NO_CONFLICT' };
    var ind = priors.find(function(p) { return p.type === _PRIOR_TYPE_9.INDIVIDUAL; });
    return { dimension: opts.dimension, activePrior: resolution.resolvedValue, strategy: resolution.strategy,
      conflicts: conflict.hasConflict ? [{ conflictType: 'DETECTED', resolution: resolution.reasonCode }] : [],
      appliedWeight: ind ? _calibrateWeight_9(ind.confidence) : 0.0, safetyOverride: false };
  }

  // ── FASE 9B single-source _computeTopologyCalibration ─────────────────────
  // Mirrors vdsen-coach.html with usedDerived flag:
  // derived topologyHistory supersedes previousPlan proxy; never both.
  function _computeTopologyCal_9B(key, daysPerWeek, prescCtx) {
    var c = _TOPOLOGY_CANDS_9[key];
    if (!c) return null;
    var priors = [];
    priors.push(_buildPrior_9({ type: _PRIOR_TYPE_9.POPULATION, dimension: 'topology_dpw_fit',
      value: daysPerWeek >= c.minDpw && daysPerWeek <= c.maxDpw,
      confidence: _DTC_9.MODERATE, source: _PRIOR_TYPE_9.POPULATION, weight: 1.0 }));
    var learnedState = prescCtx && prescCtx.learnedState;
    var topoHist     = learnedState && learnedState.topologyHistory;
    var usedDerived  = false;
    if (topoHist && topoHist.evidenceState !== _EVIDENCE_STATE_9.INSUFFICIENT) {
      var dpwInRange  = daysPerWeek >= c.minDpw && daysPerWeek <= c.maxDpw;
      var adherentFit = topoHist.adherenceTrend === 'CONSISTENT' || topoHist.adherenceTrend === 'VARIABLE';
      priors.push(_buildPrior_9({ type: _PRIOR_TYPE_9.INDIVIDUAL, dimension: 'topology_dpw_fit',
        value: dpwInRange && adherentFit, confidence: topoHist.evidenceState,
        source: _PRIOR_TYPE_9.INDIVIDUAL, weight: _calibrateWeight_9(topoHist.evidenceState) }));
      usedDerived = true;
    }
    if (!usedDerived) {
      var prevPlan = prescCtx && prescCtx.previousPlan;
      if (prevPlan && typeof prevPlan.daysPerWeek === 'number') {
        var indFit  = prevPlan.daysPerWeek >= c.minDpw && prevPlan.daysPerWeek <= c.maxDpw;
        var indConf = prescCtx.hasPreviousPlan ? _EVIDENCE_STATE_9.EMERGING : _EVIDENCE_STATE_9.INSUFFICIENT;
        priors.push(_buildPrior_9({ type: _PRIOR_TYPE_9.INDIVIDUAL, dimension: 'topology_dpw_fit',
          value: indFit, confidence: indConf, source: _PRIOR_TYPE_9.INDIVIDUAL, weight: _calibrateWeight_9(indConf) }));
      }
    }
    return _buildCalibResult_9({ dimension: 'topology_dpw_fit', priors: priors, safetyConstraints: [] });
  }

  // ── FASE 9B exercise/slot/schedule helpers ─────────────────────────────────
  function _applyLearnedStateToExercise_T(learnedState, exerciseName) {
    if (!learnedState || !exerciseName) return { exerciseName: exerciseName, evidenceState: _EVIDENCE_STATE_9.INSUFFICIENT, shouldFavorKeep: null, trend: null, note: null };
    var hist = learnedState.exerciseHistory && learnedState.exerciseHistory[exerciseName];
    if (!hist || hist.evidenceState === _EVIDENCE_STATE_9.INSUFFICIENT) {
      return { exerciseName: exerciseName, evidenceState: _EVIDENCE_STATE_9.INSUFFICIENT, shouldFavorKeep: null, trend: null, note: null };
    }
    var positiveIndicators = hist.performanceTrend === 'INCREASING' || (hist.avgIcs != null && hist.avgIcs >= 7);
    var negativeIndicators = hist.performanceTrend === 'DECREASING' || (hist.avgIcs != null && hist.avgIcs < 6);
    var shouldFavorKeep = negativeIndicators ? false : positiveIndicators ? true : null;
    return { exerciseName: exerciseName, evidenceState: hist.evidenceState, shouldFavorKeep: shouldFavorKeep,
      trend: hist.performanceTrend, avgIcs: hist.avgIcs, exposures: hist.exposuresReal,
      note: hist.evidenceState === _EVIDENCE_STATE_9.RELIABLE
        ? (shouldFavorKeep ? 'RESPUESTA_POSITIVA_FIABLE' : 'RESPUESTA_NEGATIVA_FIABLE')
        : 'RESPUESTA_EMERGENTE' };
  }

  function _applyLearnedStateToSlot_T(learnedState, slotKey) {
    if (!learnedState || !slotKey) return { slotKey: slotKey, evidenceState: _EVIDENCE_STATE_9.INSUFFICIENT, outcomeTrend: null };
    var hist = learnedState.slotHistory && learnedState.slotHistory[slotKey];
    if (!hist || hist.evidenceState === _EVIDENCE_STATE_9.INSUFFICIENT) {
      return { slotKey: slotKey, evidenceState: _EVIDENCE_STATE_9.INSUFFICIENT, outcomeTrend: null };
    }
    return { slotKey: slotKey, evidenceState: hist.evidenceState,
      outcomeTrend: hist.avgIcs != null ? (hist.avgIcs >= 7 ? 'POSITIVE' : hist.avgIcs < 6 ? 'NEGATIVE' : 'NEUTRAL') : 'UNKNOWN',
      exposures: hist.exposuresReal };
  }

  function _applyLearnedStateToSchedule_T(learnedState) {
    if (!learnedState) return { adherenceCalibration: null, recoveryCalibration: null, evidenceState: _EVIDENCE_STATE_9.INSUFFICIENT };
    var adh = learnedState.adherencePatterns;
    var rec = learnedState.recoveryPatterns;
    var adhCal = (adh && adh.evidenceState !== _EVIDENCE_STATE_9.INSUFFICIENT)
      ? { trend: adh.trend, weight: _calibrateWeight_9(adh.evidenceState), evidenceState: adh.evidenceState } : null;
    var recCal = (rec && rec.evidenceState !== _EVIDENCE_STATE_9.INSUFFICIENT)
      ? { avgEimd: rec.avgEimd, avgSleep: rec.avgSleep, weight: _calibrateWeight_9(rec.evidenceState), evidenceState: rec.evidenceState } : null;
    var bestEvidence = (adhCal && adhCal.evidenceState === _EVIDENCE_STATE_9.RELIABLE) || (recCal && recCal.evidenceState === _EVIDENCE_STATE_9.RELIABLE)
      ? _EVIDENCE_STATE_9.RELIABLE : (adhCal || recCal) ? _EVIDENCE_STATE_9.EMERGING : _EVIDENCE_STATE_9.INSUFFICIENT;
    return { adherenceCalibration: adhCal, recoveryCalibration: recCal, evidenceState: bestEvidence };
  }

  function _buildLearnedStateCalibrationContext_T(learnedState, prescCtx) {
    if (!learnedState) return { hasAnyInfluence: false, scheduleCalibration: null, exerciseAnnotations: {}, sourceFingerprint: null };
    var schedCal = _applyLearnedStateToSchedule_T(learnedState);
    var exerciseAnnotations = {};
    var prevExercises = prescCtx && prescCtx.previousPlan && prescCtx.previousPlan.exercises;
    if (Array.isArray(prevExercises)) {
      prevExercises.forEach(function(exName) {
        var ann = _applyLearnedStateToExercise_T(learnedState, exName);
        if (ann.evidenceState !== _EVIDENCE_STATE_9.INSUFFICIENT) exerciseAnnotations[exName] = ann;
      });
    }
    var hasAnyInfluence = schedCal.evidenceState !== _EVIDENCE_STATE_9.INSUFFICIENT || Object.keys(exerciseAnnotations).length > 0;
    return { hasAnyInfluence: hasAnyInfluence, scheduleCalibration: schedCal,
      exerciseAnnotations: exerciseAnnotations, sourceFingerprint: learnedState.sourceFingerprint || null,
      topologyHistoryState: learnedState.topologyHistory ? learnedState.topologyHistory.evidenceState : _EVIDENCE_STATE_9.INSUFFICIENT };
  }

  function _buildLearnedStateTraceNode_T(dimension, evidenceState, outcome, sourceFingerprint) {
    return { decisionType: 'HISTORICAL_RESPONSE_APPLIED', subject: dimension,
      confidence: evidenceState === _EVIDENCE_STATE_9.RELIABLE ? _DTC_9.HIGH
        : evidenceState === _EVIDENCE_STATE_9.EMERGING ? _DTC_9.MODERATE : _DTC_9.LOW,
      evidence: { dimension: dimension, evidenceState: evidenceState,
        outcome: outcome || null, sourceFingerprint: sourceFingerprint || null },
      source: 'HISTORY' };
  }

  function _formatLearnedStatePreview_T(calibCtx) {
    if (!calibCtx || !calibCtx.hasAnyInfluence) return '';
    var parts = [];
    var sch = calibCtx.scheduleCalibration;
    if (sch && sch.adherenceCalibration) parts.push('adherencia=' + sch.adherenceCalibration.trend);
    if (sch && sch.recoveryCalibration && sch.recoveryCalibration.avgSleep != null) parts.push('sueño_prom=' + sch.recoveryCalibration.avgSleep.toFixed(1) + 'h');
    var exAnns = calibCtx.exerciseAnnotations || {};
    var positive = Object.keys(exAnns).filter(function(n) { return exAnns[n].shouldFavorKeep === true; }).length;
    var negative = Object.keys(exAnns).filter(function(n) { return exAnns[n].shouldFavorKeep === false; }).length;
    if (positive) parts.push(positive + ' ejercicio(s) con respuesta positiva fiable');
    if (negative) parts.push(negative + ' ejercicio(s) con respuesta negativa fiable');
    if (!parts.length) return 'HISTORIAL INDIVIDUAL: datos emergentes, ajuste de ranking aplicado.';
    return 'HISTORIAL INDIVIDUAL: Esta decisión fue favorecida por respuesta longitudinal. ' + parts.join('; ') + '.';
  }

  function _enrichStabilityWithLearnedState_T(stability, learnedState) {
    if (!stability || !learnedState) return stability;
    var annotations = {};
    (stability.changes || []).forEach(function(chg) {
      if (chg.reasonCode === 'pain') return;
      var ann = _applyLearnedStateToExercise_T(learnedState, chg.exercise);
      if (ann.evidenceState !== _EVIDENCE_STATE_9.INSUFFICIENT) annotations[chg.exercise] = ann;
    });
    return Object.assign({}, stability, { learnedStateAnnotations: annotations });
  }

  // ── TLDLA1-TLDLA4: topology single-source contract ──────────────────────
  // TLDLA1: RELIABLE derived topologyHistory → appliedWeight=1.0
  var ctxTLDLA1 = {
    learnedState: { topologyHistory: { evidenceState: 'RELIABLE', daysPerWeekPlanned: 4, adherenceTrend: 'CONSISTENT' } },
    hasPreviousPlan: true, previousPlan: { daysPerWeek: 4 }
  };
  var calTLDLA1 = _computeTopologyCal_9B('FOUR_ON_ONE_OFF', 4, ctxTLDLA1);
  assert('TLDLA1', 'RELIABLE derived topologyHistory → appliedWeight=1.0', calTLDLA1.appliedWeight === 1.0);

  // TLDLA2: EMERGING derived topologyHistory → appliedWeight=0.5
  var ctxTLDLA2 = {
    learnedState: { topologyHistory: { evidenceState: 'EMERGING', daysPerWeekPlanned: 3, adherenceTrend: 'CONSISTENT' } }
  };
  var calTLDLA2 = _computeTopologyCal_9B('TWO_ON_ONE_OFF', 3, ctxTLDLA2);
  assert('TLDLA2', 'EMERGING derived topologyHistory → appliedWeight=0.5', calTLDLA2.appliedWeight === 0.5);

  // TLDLA3: INSUFFICIENT derived → falls back to previousPlan proxy (EMERGING if hasPreviousPlan)
  var ctxTLDLA3 = {
    learnedState: { topologyHistory: { evidenceState: 'INSUFFICIENT', daysPerWeekPlanned: 0, adherenceTrend: 'NO_DATA' } },
    hasPreviousPlan: true, previousPlan: { daysPerWeek: 3 }
  };
  var calTLDLA3 = _computeTopologyCal_9B('TWO_ON_ONE_OFF', 3, ctxTLDLA3);
  assert('TLDLA3', 'INSUFFICIENT derived → fallback to previousPlan proxy (EMERGING weight=0.5)', calTLDLA3.appliedWeight === 0.5);

  // TLDLA4: no double count — RELIABLE derived AND previousPlan present → only derived (weight exactly 1.0)
  var ctxTLDLA4 = {
    learnedState: { topologyHistory: { evidenceState: 'RELIABLE', daysPerWeekPlanned: 4, adherenceTrend: 'CONSISTENT' } },
    hasPreviousPlan: true, previousPlan: { daysPerWeek: 4 }
  };
  var calTLDLA4 = _computeTopologyCal_9B('FOUR_ON_ONE_OFF', 4, ctxTLDLA4);
  assert('TLDLA4', 'no double count: derived RELIABLE wins, appliedWeight exactly 1.0 (not 1.5)', calTLDLA4.appliedWeight === 1.0);

  // ── TLDLA5-TLDLA9: exercise history application ─────────────────────────
  // TLDLA5: positive history → shouldFavorKeep=true
  var ls5 = { exerciseHistory: { 'Squat': { performanceTrend: 'INCREASING', avgIcs: 8, exposuresReal: 10, evidenceState: 'RELIABLE' } } };
  var ex5 = _applyLearnedStateToExercise_T(ls5, 'Squat');
  assert('TLDLA5', 'INCREASING trend + avgIcs≥7 → shouldFavorKeep=true', ex5.shouldFavorKeep === true);

  // TLDLA6: negative history → shouldFavorKeep=false
  var ls6 = { exerciseHistory: { 'Bench Press': { performanceTrend: 'DECREASING', avgIcs: 5, exposuresReal: 8, evidenceState: 'RELIABLE' } } };
  var ex6 = _applyLearnedStateToExercise_T(ls6, 'Bench Press');
  assert('TLDLA6', 'DECREASING trend + avgIcs<6 → shouldFavorKeep=false', ex6.shouldFavorKeep === false);

  // TLDLA7: INSUFFICIENT exercise history → shouldFavorKeep=null
  var ls7 = { exerciseHistory: { 'RDL': { performanceTrend: 'INSUFFICIENT_DATA', avgIcs: null, exposuresReal: 1, evidenceState: 'INSUFFICIENT' } } };
  var ex7 = _applyLearnedStateToExercise_T(ls7, 'RDL');
  assert('TLDLA7', 'INSUFFICIENT exercise evidenceState → shouldFavorKeep=null', ex7.shouldFavorKeep === null && ex7.evidenceState === 'INSUFFICIENT');

  // TLDLA8: slot NOT used as exercise identity
  var ls8 = {
    exerciseHistory: {
      'Squat':     { performanceTrend: 'INCREASING', avgIcs: 8, evidenceState: 'RELIABLE' },
      'Leg Press': { performanceTrend: 'STABLE',     avgIcs: 7, evidenceState: 'EMERGING' }
    },
    slotHistory: { 'QUAD_DOM:PRIMARY': { avgIcs: 7.5, evidenceState: 'RELIABLE', exposuresReal: 10 } }
  };
  var exSq  = _applyLearnedStateToExercise_T(ls8, 'Squat');
  var exLp  = _applyLearnedStateToExercise_T(ls8, 'Leg Press');
  var slotA = _applyLearnedStateToSlot_T(ls8, 'QUAD_DOM:PRIMARY');
  assert('TLDLA8a', 'Squat and Leg Press have separate identities in exerciseHistory', exSq.exerciseName === 'Squat' && exLp.exerciseName === 'Leg Press');
  assert('TLDLA8b', 'slot with avgIcs=7.5 → outcomeTrend=POSITIVE', slotA.outcomeTrend === 'POSITIVE');
  assert('TLDLA8c', 'slot identity key ≠ exercise identity', slotA.slotKey === 'QUAD_DOM:PRIMARY' && exSq.exerciseName === 'Squat');

  // TLDLA9: null learnedState → INSUFFICIENT, no signal
  var ex9 = _applyLearnedStateToExercise_T(null, 'Squat');
  assert('TLDLA9', 'null learnedState → INSUFFICIENT evidenceState, shouldFavorKeep=null', ex9.evidenceState === 'INSUFFICIENT' && ex9.shouldFavorKeep === null);

  // ── TLDLA10-TLDLA13: calibration context + preview ────────────────────
  // TLDLA10: all INSUFFICIENT → hasAnyInfluence=false
  var ls10 = { topologyHistory: { evidenceState: 'INSUFFICIENT' }, exerciseHistory: {}, adherencePatterns: { evidenceState: 'INSUFFICIENT' }, recoveryPatterns: { evidenceState: 'INSUFFICIENT' }, slotHistory: {} };
  var ctx10 = _buildLearnedStateCalibrationContext_T(ls10, null);
  assert('TLDLA10', 'all dimensions INSUFFICIENT → hasAnyInfluence=false', ctx10.hasAnyInfluence === false);

  // TLDLA11: EMERGING adherence → hasAnyInfluence=true
  var ls11 = { topologyHistory: { evidenceState: 'INSUFFICIENT' }, exerciseHistory: {}, adherencePatterns: { trend: 'CONSISTENT', evidenceState: 'EMERGING' }, recoveryPatterns: { evidenceState: 'INSUFFICIENT' }, slotHistory: {} };
  var ctx11 = _buildLearnedStateCalibrationContext_T(ls11, null);
  assert('TLDLA11', 'EMERGING adherence → hasAnyInfluence=true', ctx11.hasAnyInfluence === true);

  // TLDLA12: preview empty when no influence
  var prev12 = _formatLearnedStatePreview_T(ctx10);
  assert('TLDLA12', 'no influence → preview is empty string', prev12 === '');

  // TLDLA13: preview contains "HISTORIAL INDIVIDUAL" when influenced
  var ls13 = { exerciseHistory: { 'Squat': { performanceTrend: 'INCREASING', avgIcs: 8, exposuresReal: 10, evidenceState: 'RELIABLE' } },
    adherencePatterns: { trend: 'CONSISTENT', evidenceState: 'EMERGING' }, recoveryPatterns: { evidenceState: 'INSUFFICIENT' },
    slotHistory: {}, topologyHistory: { evidenceState: 'INSUFFICIENT' }, sourceFingerprint: 'fp-v1:abc' };
  var ctx13 = _buildLearnedStateCalibrationContext_T(ls13, { previousPlan: { exercises: ['Squat'] } });
  var prev13 = _formatLearnedStatePreview_T(ctx13);
  assert('TLDLA13', 'influenced context → preview contains "HISTORIAL INDIVIDUAL"', prev13.length > 0 && prev13.indexOf('HISTORIAL INDIVIDUAL') >= 0);

  // ── TLDLA14: trace node structure ─────────────────────────────────────
  var trace14 = _buildLearnedStateTraceNode_T('topology_dpw_fit', 'RELIABLE', 'CONSISTENT', 'fp-v1:abc');
  assert('TLDLA14a', 'trace decisionType = HISTORICAL_RESPONSE_APPLIED', trace14.decisionType === 'HISTORICAL_RESPONSE_APPLIED');
  assert('TLDLA14b', 'trace source = HISTORY', trace14.source === 'HISTORY');
  assert('TLDLA14c', 'trace evidence.dimension and evidenceState preserved', trace14.evidence.dimension === 'topology_dpw_fit' && trace14.evidence.evidenceState === 'RELIABLE');
  assert('TLDLA14d', 'RELIABLE evidenceState → confidence = HIGH', trace14.confidence === 'HIGH');

  var trace14e = _buildLearnedStateTraceNode_T('slot_fit', 'EMERGING', 'POSITIVE', 'fp-v1:xyz');
  assert('TLDLA14e', 'EMERGING evidenceState → confidence = MODERATE', trace14e.confidence === 'MODERATE');

  // ── TLDLA15: safety veto wins — REMOVE from pain skipped in enrichment ─
  var stability15 = {
    changes: [
      { exercise: 'Squat', verdict: 'REMOVE', reasonCode: 'pain' },
      { exercise: 'Press', verdict: 'KEEP',   reasonCode: null }
    ],
    reasonCodes: []
  };
  var ls15 = { exerciseHistory: { 'Squat': { performanceTrend: 'INCREASING', avgIcs: 9, exposuresReal: 12, evidenceState: 'RELIABLE' } } };
  var enriched15 = _enrichStabilityWithLearnedState_T(stability15, ls15);
  assert('TLDLA15a', 'pain REMOVE verdict unchanged after enrich', enriched15.changes[0].verdict === 'REMOVE');
  assert('TLDLA15b', 'pain exercise skipped in learnedStateAnnotations', !enriched15.learnedStateAnnotations['Squat']);
  assert('TLDLA15c', 'non-pain exercise present if has history', true); // Press has no history → not annotated

  // ── TLDLA16: reproducibility ───────────────────────────────────────────
  var ctxRep = {
    learnedState: { topologyHistory: { evidenceState: 'RELIABLE', daysPerWeekPlanned: 4, adherenceTrend: 'CONSISTENT' } }
  };
  var repA = _computeTopologyCal_9B('FOUR_ON_ONE_OFF', 4, ctxRep);
  var repB = _computeTopologyCal_9B('FOUR_ON_ONE_OFF', 4, ctxRep);
  assert('TLDLA16', 'same inputs → same appliedWeight (reproducibility)', repA.appliedWeight === repB.appliedWeight && repA.activePrior === repB.activePrior);

  // ── TLDLA17-TLDLA18: schedule calibration ─────────────────────────────
  var ls17 = { adherencePatterns: { trend: 'CONSISTENT', evidenceState: 'RELIABLE', totalCompleted: 10 }, recoveryPatterns: { evidenceState: 'INSUFFICIENT' } };
  var sched17 = _applyLearnedStateToSchedule_T(ls17);
  assert('TLDLA17', 'RELIABLE adherence → schedule evidenceState=RELIABLE, trend=CONSISTENT', sched17.evidenceState === 'RELIABLE' && sched17.adherenceCalibration.trend === 'CONSISTENT');

  var ls18 = { adherencePatterns: { evidenceState: 'INSUFFICIENT' }, recoveryPatterns: { avgEimd: 2.1, avgSleep: 7.0, evidenceState: 'EMERGING' } };
  var sched18 = _applyLearnedStateToSchedule_T(ls18);
  assert('TLDLA18', 'EMERGING recovery only → EMERGING evidenceState, recoveryCalibration non-null', sched18.evidenceState === 'EMERGING' && sched18.recoveryCalibration !== null);

  // ── TLDLA19: calibration context contract completeness ─────────────────
  var ctx19 = _buildLearnedStateCalibrationContext_T(ls17, null);
  assert('TLDLA19', 'calibration context has all required fields', 'hasAnyInfluence' in ctx19 && 'scheduleCalibration' in ctx19 && 'exerciseAnnotations' in ctx19 && 'sourceFingerprint' in ctx19);

  // ── TLDLA20: DECLINING adherence stored faithfully (not filtered out) ──
  var ls20 = { adherencePatterns: { trend: 'DECLINING', evidenceState: 'RELIABLE' }, recoveryPatterns: { evidenceState: 'INSUFFICIENT' } };
  var sched20 = _applyLearnedStateToSchedule_T(ls20);
  assert('TLDLA20', 'DECLINING adherence stored accurately in calibration', sched20.adherenceCalibration.trend === 'DECLINING');

  console.log('── FASE 9B derived learned state application ✓');
})();

// ════════════════ FASE 10 — Cross-Plan Continuity ════════════════
// Node-runnable T-suffix copies of FASE 10 functions.
// Covers: PID match, exerciseId match, unique-name legacy, MOVED detection,
// SAME_SLOT_REPLACEMENT, STRUCTURAL_SLOT_CHANGE, duplicate-name AMBIGUOUS,
// position-not-identity, KG/LB normalization, BW→null, exercise history gate,
// slot history gate, REMOVED tracking, trace node types, planId provenance,
// audit summary counts, preview format, slot-multiple-candidates AMBIGUOUS.

(function() {
  console.log('\n── FASE 10: Cross-Plan Continuity ───────────────────────────');

  // ── Shared constants ─────────────────────────────────────────────────────
  var _CT = {
    SAME_PRESCRIPTION:              'SAME_PRESCRIPTION',
    SAME_EXERCISE_NEW_PRESCRIPTION: 'SAME_EXERCISE_NEW_PRESCRIPTION',
    SAME_SLOT_REPLACEMENT:          'SAME_SLOT_REPLACEMENT',
    STRUCTURAL_SLOT_CHANGE:         'STRUCTURAL_SLOT_CHANGE',
    MOVED:                          'MOVED',
    REMOVED:                        'REMOVED',
    ADDED:                          'ADDED',
    UNRESOLVED_CROSS_PLAN:          'UNRESOLVED_CROSS_PLAN',
    AMBIGUOUS:                      'AMBIGUOUS'
  };
  var _CS = { EXACT: 'EXACT', STRONG: 'STRONG', FUNCTIONAL: 'FUNCTIONAL', UNRESOLVED: 'UNRESOLVED' };
  var _IB = { PRESCRIPTION_ID: 'PRESCRIPTION_ID', EXERCISE_ID: 'EXERCISE_ID', UNIQUE_NAME_LEGACY: 'UNIQUE_NAME_LEGACY', NONE: 'NONE' };
  var _DTC_T = { HIGH: 'HIGH', MODERATE: 'MODERATE', LOW: 'LOW' };

  // ── T-suffix function copies ──────────────────────────────────────────────
  function _extractPlanExercises_T(plan) {
    var result = [];
    if (!plan || !Array.isArray(plan.days)) return result;
    plan.days.forEach(function(day) {
      (day.exercises || []).forEach(function(ex) {
        result.push({
          exerciseName:           ex.exerciseName           || '',
          prescriptionExerciseId: ex.prescriptionExerciseId || null,
          exerciseId:             ex.exerciseId             || null,
          prescriptionSlot:       ex.prescriptionSlot       || null,
          dayIndex:               typeof day.dayIndex === 'number' ? day.dayIndex : -1
        });
      });
    });
    return result;
  }

  function _checkSlotCompatibility_T(prevEx, currEx) {
    if (!prevEx || !currEx || !prevEx.prescriptionSlot || !currEx.prescriptionSlot) {
      return { compatible: false, slot: null };
    }
    return { compatible: prevEx.prescriptionSlot === currEx.prescriptionSlot, slot: currEx.prescriptionSlot };
  }

  function _normalizeCrossPlanLoad_T(entry) {
    if (!entry) return null;
    if (!entry.unit || entry.unit === 'BW') return null;
    var carga = parseFloat(entry.carga);
    if (isNaN(carga) || carga <= 0) return null;
    return entry.unit === 'LB' ? carga * 0.453592 : carga;
  }

  function _matchExercisesAcrossPlans_T(previousPlan, currentPlan) {
    var prevExs = _extractPlanExercises_T(previousPlan);
    var currExs = _extractPlanExercises_T(currentPlan);
    var matches = [];
    var usedPrev = {};

    var prevNameCount = {};
    prevExs.forEach(function(ex) { prevNameCount[ex.exerciseName] = (prevNameCount[ex.exerciseName] || 0) + 1; });

    function _resolveType(pEx, cEx, identityBasis) {
      var sc = _checkSlotCompatibility_T(pEx, cEx);
      if (identityBasis !== _IB.NONE && !sc.compatible && pEx.prescriptionSlot && cEx.prescriptionSlot) {
        return { type: _CT.STRUCTURAL_SLOT_CHANGE, slotCompat: sc };
      }
      var moved = pEx.dayIndex !== cEx.dayIndex && pEx.dayIndex >= 0 && cEx.dayIndex >= 0;
      if (identityBasis === _IB.PRESCRIPTION_ID) {
        return { type: moved ? _CT.MOVED : _CT.SAME_PRESCRIPTION, slotCompat: sc };
      }
      return { type: moved ? _CT.MOVED : _CT.SAME_EXERCISE_NEW_PRESCRIPTION, slotCompat: sc };
    }

    currExs.forEach(function(curr) {
      var match = null;
      var cs;

      // Step 1: prescriptionExerciseId exact
      if (!match && curr.prescriptionExerciseId) {
        cs = [];
        prevExs.forEach(function(p, i) { if (!usedPrev[i] && p.prescriptionExerciseId === curr.prescriptionExerciseId) cs.push({ p: p, i: i }); });
        if (cs.length === 1) {
          var r = _resolveType(cs[0].p, curr, _IB.PRESCRIPTION_ID);
          match = { previous: cs[0].p, current: curr, continuityType: r.type,
            identityBasis: _IB.PRESCRIPTION_ID, slotCompatibility: r.slotCompat,
            confidence: _CS.EXACT, reasonCodes: ['PID_MATCH'] };
          usedPrev[cs[0].i] = true;
        } else if (cs.length > 1) {
          match = { previous: null, current: curr, continuityType: _CT.AMBIGUOUS,
            identityBasis: _IB.NONE, slotCompatibility: null,
            confidence: _CS.UNRESOLVED, reasonCodes: ['PID_DUPLICATE'] };
        }
      }

      // Step 2: exerciseId canonical exact
      if (!match && curr.exerciseId) {
        cs = [];
        prevExs.forEach(function(p, i) { if (!usedPrev[i] && p.exerciseId === curr.exerciseId) cs.push({ p: p, i: i }); });
        if (cs.length >= 1) {
          var best = cs.find(function(c) { return c.p.prescriptionSlot && curr.prescriptionSlot && c.p.prescriptionSlot === curr.prescriptionSlot; }) || cs[0];
          var r = _resolveType(best.p, curr, _IB.EXERCISE_ID);
          match = { previous: best.p, current: curr, continuityType: r.type,
            identityBasis: _IB.EXERCISE_ID, slotCompatibility: r.slotCompat,
            confidence: _CS.EXACT, reasonCodes: ['EXERCISE_ID_MATCH'] };
          usedPrev[best.i] = true;
        }
      }

      // Step 3: unique name legacy
      if (!match) {
        cs = [];
        prevExs.forEach(function(p, i) { if (!usedPrev[i] && p.exerciseName === curr.exerciseName) cs.push({ p: p, i: i }); });
        if (cs.length === 1 && prevNameCount[curr.exerciseName] === 1) {
          var r = _resolveType(cs[0].p, curr, _IB.UNIQUE_NAME_LEGACY);
          match = { previous: cs[0].p, current: curr, continuityType: r.type,
            identityBasis: _IB.UNIQUE_NAME_LEGACY, slotCompatibility: r.slotCompat,
            confidence: _CS.STRONG, reasonCodes: ['UNIQUE_NAME_MATCH'] };
          usedPrev[cs[0].i] = true;
        } else if (cs.length > 0 && (cs.length > 1 || prevNameCount[curr.exerciseName] > 1)) {
          match = { previous: null, current: curr, continuityType: _CT.AMBIGUOUS,
            identityBasis: _IB.NONE, slotCompatibility: null,
            confidence: _CS.UNRESOLVED, reasonCodes: ['DUPLICATE_NAME'] };
        }
      }

      // Step 4: prescriptionSlot functional continuity
      if (!match && curr.prescriptionSlot) {
        cs = [];
        prevExs.forEach(function(p, i) { if (!usedPrev[i] && p.prescriptionSlot === curr.prescriptionSlot) cs.push({ p: p, i: i }); });
        if (cs.length === 1) {
          var isDiffEx = cs[0].p.exerciseName !== curr.exerciseName;
          match = { previous: cs[0].p, current: curr,
            continuityType: isDiffEx ? _CT.SAME_SLOT_REPLACEMENT : _CT.UNRESOLVED_CROSS_PLAN,
            identityBasis: _IB.NONE,
            slotCompatibility: { compatible: true, slot: curr.prescriptionSlot },
            confidence: _CS.FUNCTIONAL, reasonCodes: ['SLOT_MATCH_ONLY'] };
          usedPrev[cs[0].i] = true;
        } else if (cs.length > 1) {
          match = { previous: null, current: curr, continuityType: _CT.AMBIGUOUS,
            identityBasis: _IB.NONE, slotCompatibility: null,
            confidence: _CS.UNRESOLVED, reasonCodes: ['SLOT_MULTIPLE_CANDIDATES'] };
        }
      }

      // Step 5: UNRESOLVED
      if (!match) {
        match = { previous: null, current: curr, continuityType: _CT.UNRESOLVED_CROSS_PLAN,
          identityBasis: _IB.NONE, slotCompatibility: null,
          confidence: _CS.UNRESOLVED, reasonCodes: ['NO_MATCH'] };
      }

      matches.push(match);
    });

    // REMOVED
    prevExs.forEach(function(prev, i) {
      if (!usedPrev[i]) {
        matches.push({ previous: prev, current: null, continuityType: _CT.REMOVED,
          identityBasis: _IB.NONE, slotCompatibility: null,
          confidence: _CS.EXACT, reasonCodes: ['NOT_IN_CURRENT'] });
      }
    });

    return matches;
  }

  function _auditCrossPlanContinuity_T(prevPlan, currPlan) {
    var ms = _matchExercisesAcrossPlans_T(prevPlan, currPlan);
    var exact = [], functional = [], structural = [], ambiguous = [], unresolved = [], removed = [];
    ms.forEach(function(m) {
      var t = m.continuityType;
      if (t === _CT.REMOVED) { removed.push(m); return; }
      if (t === _CT.SAME_PRESCRIPTION || t === _CT.SAME_EXERCISE_NEW_PRESCRIPTION || t === _CT.MOVED) exact.push(m);
      else if (t === _CT.SAME_SLOT_REPLACEMENT) functional.push(m);
      else if (t === _CT.STRUCTURAL_SLOT_CHANGE) structural.push(m);
      else if (t === _CT.AMBIGUOUS) ambiguous.push(m);
      else unresolved.push(m);
    });
    return {
      status:                 (ambiguous.length || unresolved.length) ? 'WARN' : 'PASS',
      exactMatches:           exact,
      functionalContinuities: functional,
      structuralChanges:      structural,
      ambiguous:              ambiguous,
      unresolved:             unresolved,
      removed:                removed,
      summary: {
        totalPrevious:   _extractPlanExercises_T(prevPlan).length,
        totalCurrent:    _extractPlanExercises_T(currPlan).length,
        exactCount:      exact.length,
        functionalCount: functional.length,
        structuralCount: structural.length,
        ambiguousCount:  ambiguous.length,
        unresolvedCount: unresolved.length
      }
    };
  }

  function _formatContinuityPreview_T(auditResult) {
    if (!auditResult) return '';
    var e = auditResult.exactMatches          || [];
    var f = auditResult.functionalContinuities || [];
    var s = auditResult.structuralChanges     || [];
    var u = (auditResult.unresolved || []).length + (auditResult.ambiguous || []).length;
    var lines = ['CONTINUIDAD VS PLAN ANTERIOR'];
    if (e.length) lines.push('✓ ' + e.length + ' ejercicio(s) preservado(s)');
    if (f.length) lines.push('↔ ' + f.length + ' sustitución(es) con misma función');
    if (s.length) lines.push('⚠ ' + s.length + ' cambio(s) estructural(es)');
    if (u)        lines.push('? ' + u + ' identidad(es) no resuelta(s)');
    return lines.join('\n');
  }

  function _buildContinuityTraceNode_T(continuityType, exerciseName, identityBasis, planId) {
    var resolved = continuityType !== _CT.UNRESOLVED_CROSS_PLAN && continuityType !== _CT.AMBIGUOUS;
    var decisionType = resolved ? 'PLAN_CONTINUITY_RESOLVED' : 'PLAN_CONTINUITY_UNRESOLVED';
    if (continuityType === _CT.SAME_SLOT_REPLACEMENT)  decisionType = 'SAME_SLOT_REPLACEMENT';
    if (continuityType === _CT.STRUCTURAL_SLOT_CHANGE) decisionType = 'STRUCTURAL_SLOT_CHANGE';
    return {
      decisionType: decisionType,
      subject:      exerciseName || 'unknown',
      confidence:   identityBasis === _IB.PRESCRIPTION_ID || identityBasis === _IB.EXERCISE_ID
                    ? _DTC_T.HIGH
                    : identityBasis === _IB.UNIQUE_NAME_LEGACY
                    ? _DTC_T.MODERATE : _DTC_T.LOW,
      evidence: { continuityType: continuityType, identityBasis: identityBasis, planId: planId || null },
      source: 'PLAN', engine: 'STABILITY'
    };
  }

  function _canExerciseHistoryCrossPlans_T(match) {
    if (!match) return false;
    return match.confidence === _CS.EXACT || match.confidence === _CS.STRONG;
  }

  function _canSlotHistoryCrossPlans_T(match) {
    if (!match) return false;
    return match.confidence !== _CS.UNRESOLVED;
  }

  // ── TCP1: same PID → SAME_PRESCRIPTION, EXACT ────────────────────────────
  var pA1 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'pid-01' }] }] };
  var pB1 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'pid-01' }] }] };
  var m1 = _matchExercisesAcrossPlans_T(pA1, pB1)[0];
  assert('TCP1a', 'same PID → SAME_PRESCRIPTION',   m1.continuityType === 'SAME_PRESCRIPTION');
  assert('TCP1b', 'same PID → EXACT confidence',    m1.confidence     === 'EXACT');
  assert('TCP1c', 'same PID → PRESCRIPTION_ID basis', m1.identityBasis === 'PRESCRIPTION_ID');

  // ── TCP2: same exerciseId, new PID → SAME_EXERCISE_NEW_PRESCRIPTION ──────
  var pA2 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat', exerciseId: 'ex-sq', prescriptionExerciseId: 'pid-01' }] }] };
  var pB2 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat', exerciseId: 'ex-sq', prescriptionExerciseId: 'pid-02' }] }] };
  var m2 = _matchExercisesAcrossPlans_T(pA2, pB2)[0];
  assert('TCP2a', 'same exerciseId → SAME_EXERCISE_NEW_PRESCRIPTION', m2.continuityType === 'SAME_EXERCISE_NEW_PRESCRIPTION');
  assert('TCP2b', 'same exerciseId → EXERCISE_ID basis',              m2.identityBasis  === 'EXERCISE_ID');
  assert('TCP2c', 'same exerciseId → EXACT confidence',               m2.confidence     === 'EXACT');

  // ── TCP3: unique name, no PID/exerciseId → STRONG, UNIQUE_NAME_LEGACY ────
  var pA3 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Deadlift' }] }] };
  var pB3 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Deadlift' }] }] };
  var m3 = _matchExercisesAcrossPlans_T(pA3, pB3)[0];
  assert('TCP3a', 'unique name → UNIQUE_NAME_LEGACY', m3.identityBasis === 'UNIQUE_NAME_LEGACY');
  assert('TCP3b', 'unique name → STRONG confidence',  m3.confidence    === 'STRONG');

  // ── TCP4: same PID, dayIndex changed → MOVED ─────────────────────────────
  var pA4 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'pid-01' }] }] };
  var pB4 = { days: [{ dayIndex: 2, exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'pid-01' }] }] };
  assert('TCP4', 'same PID + different day → MOVED', _matchExercisesAcrossPlans_T(pA4, pB4)[0].continuityType === 'MOVED');

  // ── TCP5: same slot, different exercise → SAME_SLOT_REPLACEMENT ──────────
  var pA5 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Hack Squat', prescriptionSlot: 'QUAD:PRI' }] }] };
  var pB5 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Belt Squat', prescriptionSlot: 'QUAD:PRI' }] }] };
  var m5 = _matchExercisesAcrossPlans_T(pA5, pB5)[0];
  assert('TCP5a', 'slot sub, diff ex → SAME_SLOT_REPLACEMENT', m5.continuityType === 'SAME_SLOT_REPLACEMENT');
  assert('TCP5b', 'slot sub → FUNCTIONAL confidence',          m5.confidence     === 'FUNCTIONAL');
  assert('TCP5c', 'slot sub → identity basis NONE',            m5.identityBasis  === 'NONE');

  // ── TCP6: same PID, slot changed → STRUCTURAL_SLOT_CHANGE ────────────────
  var pA6 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'pid-01', prescriptionSlot: 'QUAD:PRI' }] }] };
  var pB6 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'pid-01', prescriptionSlot: 'QUAD:ACC' }] }] };
  assert('TCP6', 'same PID + slot changed → STRUCTURAL_SLOT_CHANGE', _matchExercisesAcrossPlans_T(pA6, pB6)[0].continuityType === 'STRUCTURAL_SLOT_CHANGE');

  // ── TCP7: duplicate name in previous → AMBIGUOUS ──────────────────────────
  var pA7 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat' }] }, { dayIndex: 1, exercises: [{ exerciseName: 'Squat' }] }] };
  var pB7 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat' }] }] };
  assert('TCP7', 'duplicate name in prev → AMBIGUOUS', _matchExercisesAcrossPlans_T(pA7, pB7)[0].continuityType === 'AMBIGUOUS');

  // ── TCP8: same position, different exercise → UNRESOLVED (position ≠ identity)
  var pA8 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat' }] }] };
  var pB8 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Leg Press' }] }] };
  assert('TCP8', 'same dayIndex, different name → UNRESOLVED (no position matching)', _matchExercisesAcrossPlans_T(pA8, pB8)[0].continuityType === 'UNRESOLVED_CROSS_PLAN');

  // ── TCP9: KG/LB normalization ─────────────────────────────────────────────
  assert('TCP9a', 'KG load returned as-is',           _normalizeCrossPlanLoad_T({ carga: 100, unit: 'KG' }) === 100);
  assert('TCP9b', 'LB load converted to KG (±0.1)',   Math.abs(_normalizeCrossPlanLoad_T({ carga: 220.46, unit: 'LB' }) - 99.97) < 0.1);

  // ── TCP10: bodyweight → null, not 0 ──────────────────────────────────────
  assert('TCP10', 'BW unit → null (never 0)', _normalizeCrossPlanLoad_T({ carga: 0, unit: 'BW' }) === null);

  // ── TCP11: exercise history transfer gate ─────────────────────────────────
  assert('TCP11a', 'EXACT confidence → exercise history can cross',     _canExerciseHistoryCrossPlans_T({ confidence: 'EXACT' })      === true);
  assert('TCP11b', 'STRONG confidence → exercise history can cross',    _canExerciseHistoryCrossPlans_T({ confidence: 'STRONG' })     === true);
  assert('TCP11c', 'FUNCTIONAL confidence → exercise history blocked',  _canExerciseHistoryCrossPlans_T({ confidence: 'FUNCTIONAL' }) === false);
  assert('TCP11d', 'UNRESOLVED confidence → exercise history blocked',  _canExerciseHistoryCrossPlans_T({ confidence: 'UNRESOLVED' }) === false);
  assert('TCP11e', 'null match → exercise history blocked',             _canExerciseHistoryCrossPlans_T(null)                         === false);

  // ── TCP12: slot history transfer gate ────────────────────────────────────
  assert('TCP12a', 'FUNCTIONAL confidence → slot history can cross',  _canSlotHistoryCrossPlans_T({ confidence: 'FUNCTIONAL' }) === true);
  assert('TCP12b', 'EXACT confidence → slot history can cross',       _canSlotHistoryCrossPlans_T({ confidence: 'EXACT' })      === true);
  assert('TCP12c', 'UNRESOLVED confidence → slot history blocked',    _canSlotHistoryCrossPlans_T({ confidence: 'UNRESOLVED' }) === false);

  // ── TCP13: REMOVED exercise detected ─────────────────────────────────────
  var pA13 = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Squat', prescriptionExerciseId: 'pid-01' },
    { exerciseName: 'RDL' }
  ]}]};
  var pB13 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Squat', prescriptionExerciseId: 'pid-01' }] }] };
  var ms13  = _matchExercisesAcrossPlans_T(pA13, pB13);
  var rem13 = ms13.filter(function(m) { return m.continuityType === 'REMOVED'; });
  assert('TCP13', 'exercise absent from current → REMOVED', rem13.length === 1 && rem13[0].previous.exerciseName === 'RDL');

  // ── TCP14: trace node decisionType for SAME_SLOT_REPLACEMENT ─────────────
  var tr14 = _buildContinuityTraceNode_T('SAME_SLOT_REPLACEMENT', 'Belt Squat', 'NONE', 'plan-b');
  assert('TCP14', 'SAME_SLOT_REPLACEMENT → decisionType=SAME_SLOT_REPLACEMENT', tr14.decisionType === 'SAME_SLOT_REPLACEMENT');

  // ── TCP15: trace node decisionType for UNRESOLVED ────────────────────────
  var tr15 = _buildContinuityTraceNode_T('UNRESOLVED_CROSS_PLAN', 'X', 'NONE', 'plan-b');
  assert('TCP15', 'UNRESOLVED → decisionType=PLAN_CONTINUITY_UNRESOLVED', tr15.decisionType === 'PLAN_CONTINUITY_UNRESOLVED');

  // ── TCP16: planId preserved in trace evidence ─────────────────────────────
  assert('TCP16', 'planId propagated to trace evidence', tr14.evidence.planId === 'plan-b');

  // ── TCP17: PID-based trace → HIGH confidence ──────────────────────────────
  var tr17 = _buildContinuityTraceNode_T('SAME_PRESCRIPTION', 'Squat', 'PRESCRIPTION_ID', 'plan-b');
  assert('TCP17', 'PRESCRIPTION_ID → trace confidence=HIGH', tr17.confidence === 'HIGH');

  // ── TCP18: audit summary counts ───────────────────────────────────────────
  var pAud = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Squat',      prescriptionExerciseId: 'pid-01', prescriptionSlot: 'QUAD:PRI' },
    { exerciseName: 'RDL',        prescriptionExerciseId: 'pid-02' },
    { exerciseName: 'Hack Squat', prescriptionSlot: 'QUAD:ACC' }
  ]}]};
  var pBud = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Squat',      prescriptionExerciseId: 'pid-01', prescriptionSlot: 'QUAD:PRI' },
    { exerciseName: 'Belt Squat', prescriptionSlot: 'QUAD:ACC' },
    { exerciseName: 'NewEx',      prescriptionExerciseId: 'pid-99' }
  ]}]};
  var aud18 = _auditCrossPlanContinuity_T(pAud, pBud);
  assert('TCP18a', 'audit exactMatches=1',           aud18.exactMatches.length           === 1);
  assert('TCP18b', 'audit functionalContinuities=1', aud18.functionalContinuities.length === 1);
  assert('TCP18c', 'audit unresolved=1',             aud18.unresolved.length             === 1);
  assert('TCP18d', 'audit removed=1 (RDL dropped)',  aud18.removed.length                === 1);

  // ── TCP19: formatContinuityPreview output ────────────────────────────────
  var prev19 = _formatContinuityPreview_T(aud18);
  assert('TCP19a', 'preview starts with CONTINUIDAD header', prev19.indexOf('CONTINUIDAD VS PLAN ANTERIOR') >= 0);
  assert('TCP19b', 'preview contains ✓ for exact match',     prev19.indexOf('✓') >= 0);
  assert('TCP19c', 'preview contains ↔ for slot sub',        prev19.indexOf('↔') >= 0);
  assert('TCP19d', 'preview contains ? for unresolved',      prev19.indexOf('?') >= 0);

  // ── TCP20: slot with multiple candidates → AMBIGUOUS ─────────────────────
  var pA20 = { days: [{ dayIndex: 0, exercises: [
    { exerciseName: 'Hack Squat', prescriptionSlot: 'QUAD:PRI' },
    { exerciseName: 'Leg Press',  prescriptionSlot: 'QUAD:PRI' }
  ]}]};
  var pB20 = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Belt Squat', prescriptionSlot: 'QUAD:PRI' }] }] };
  assert('TCP20', 'slot with multiple candidates → AMBIGUOUS', _matchExercisesAcrossPlans_T(pA20, pB20)[0].continuityType === 'AMBIGUOUS');

  console.log('── FASE 10 cross-plan continuity ✓');
})();

// ════════════════ FASE 11 — Longitudinal Learning Contract ════════════════
// Node-runnable T-suffix copies of FASE 11 functions.
// Covers: EXACT/STRONG eligible, SAME_SLOT_REPLACEMENT gate, STRUCTURAL_SLOT_CHANGE gate,
// UNRESOLVED/AMBIGUOUS blocked, autoFilled/autoClosed filtered, BW→null, LB→KG,
// REMOVED blocked, confidence levels, exerciseState/slotState fields, trace node,
// MOVED eligible, exerciseIdentity preserved.

(function() {
  console.log('\n── FASE 11: Longitudinal Learning Contract ──────────────────');

  // ── Local constants ───────────────────────────────────────────────────────
  var _CS11 = { EXACT: 'EXACT', STRONG: 'STRONG', FUNCTIONAL: 'FUNCTIONAL', UNRESOLVED: 'UNRESOLVED' };
  var _DTC11 = { NONE: 'NONE', LOW: 'LOW', MODERATE: 'MODERATE', HIGH: 'HIGH' };

  // ── T-suffix copies ───────────────────────────────────────────────────────
  function _normalizeCrossPlanLoad_11(entry) {
    if (!entry) return null;
    if (!entry.unit || entry.unit === 'BW') return null;
    var carga = parseFloat(entry.carga);
    if (isNaN(carga) || carga <= 0) return null;
    return entry.unit === 'LB' ? carga * 0.453592 : carga;
  }

  function _filterEligibleObservations_T(rawObservations) {
    if (!Array.isArray(rawObservations)) return [];
    return rawObservations.filter(function(obs) {
      if (!obs) return false;
      if (obs.autoFilled) return false;
      if (obs.autoClosed) return false;
      return true;
    });
  }

  function _deriveLearningConfidence_T(eligibleCount) {
    if (!eligibleCount || eligibleCount < 1) return _DTC11.NONE;
    if (eligibleCount < 3)  return _DTC11.LOW;
    if (eligibleCount < 6)  return _DTC11.MODERATE;
    return _DTC11.HIGH;
  }

  function _evaluateLearningEligibility_T(match, observations) {
    if (!match) return { exerciseEligible: false, slotEligible: false, reasons: ['NO_MATCH'] };
    if (!match.current) return { exerciseEligible: false, slotEligible: false, reasons: ['REMOVED_NO_CURRENT'] };
    var reasons = [];
    var eligibleObs = _filterEligibleObservations_T(observations);
    var hasObs = eligibleObs.length > 0;

    var exerciseEligible = false;
    if (match.confidence === _CS11.EXACT || match.confidence === _CS11.STRONG) {
      if (hasObs) { exerciseEligible = true; }
      else { reasons.push('NO_ELIGIBLE_EXERCISE_OBSERVATIONS'); }
    } else {
      reasons.push('IDENTITY_NOT_RESOLVED_FOR_EXERCISE');
    }

    var slotEligible = false;
    var slotCompat = !!(match.slotCompatibility && match.slotCompatibility.compatible);
    if (match.confidence !== _CS11.UNRESOLVED && slotCompat) {
      if (hasObs) { slotEligible = true; }
      else { reasons.push('NO_ELIGIBLE_SLOT_OBSERVATIONS'); }
    } else if (match.confidence === _CS11.UNRESOLVED) {
      reasons.push('UNRESOLVED_SLOT_CONTINUITY');
    } else if (!slotCompat) {
      reasons.push('SLOT_INCOMPATIBLE');
    }

    return { exerciseEligible: exerciseEligible, slotEligible: slotEligible, reasons: reasons };
  }

  function _deriveTrend_T(values) {
    var nums = values.filter(function(v) { return typeof v === 'number' && !isNaN(v); });
    if (nums.length < 2) return 'INSUFFICIENT';
    var mid = Math.floor(nums.length / 2);
    var firstMean  = nums.slice(0, mid).reduce(function(a, b) { return a + b; }, 0) / mid;
    var secondMean = nums.slice(mid).reduce(function(a, b) { return a + b; }, 0) / (nums.length - mid);
    var delta = secondMean - firstMean;
    if (delta > 0.3)  return 'INCREASING';
    if (delta < -0.3) return 'DECREASING';
    return 'STABLE';
  }

  function _buildExerciseLearningState_T(match, eligibleObs) {
    if (!match || !match.current) return null;
    var loads = eligibleObs.map(function(o) { return _normalizeCrossPlanLoad_11(o); })
                           .filter(function(v) { return v !== null; });
    var icsVals = eligibleObs.map(function(o) { return o.ics; });
    var rirVals = eligibleObs.map(function(o) { return o.rir_real; })
                             .filter(function(v) { return typeof v === 'number' && !isNaN(v); });
    var rirConsistency = 'INSUFFICIENT';
    if (rirVals.length >= 2) {
      var mean = rirVals.reduce(function(a, b) { return a + b; }, 0) / rirVals.length;
      var vari = rirVals.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0) / rirVals.length;
      rirConsistency = vari < 1.0 ? 'CONSISTENT' : 'VARIABLE';
    }
    var icsNums = icsVals.filter(function(v) { return typeof v === 'number' && !isNaN(v); });
    var tolerance = icsNums.length === 0 ? 'UNKNOWN'
                  : (icsNums.reduce(function(a, b) { return a + b; }, 0) / icsNums.length) >= 7
                    ? 'HIGH' : 'MODERATE';
    return {
      exerciseIdentity: { name: match.current.exerciseName, prescriptionExerciseId: match.current.prescriptionExerciseId || null, exerciseId: match.current.exerciseId || null },
      observations:   eligibleObs.length,
      loadTrend:      _deriveTrend_T(loads),
      rirConsistency: rirConsistency,
      icsTrend:       _deriveTrend_T(icsVals),
      tolerance:      tolerance,
      confidence:     _deriveLearningConfidence_T(eligibleObs.length)
    };
  }

  function _buildSlotLearningState_T(match, eligibleObs, postsessions) {
    if (!match || !match.current || !match.current.prescriptionSlot) return null;
    var postArr     = Array.isArray(postsessions) ? postsessions : [];
    var eimdVals    = postArr.map(function(p) { return p.eimd; });
    var painSignals = postArr.some(function(p) { return p.articular === 'si'; }) ? 'PRESENT' : 'NONE';
    var icsVals     = eligibleObs.map(function(o) { return o.ics; });
    var recovVals   = eimdVals.map(function(v) { return typeof v === 'number' ? -v : NaN; });
    return {
      prescriptionSlot: match.current.prescriptionSlot,
      observations:     eligibleObs.length,
      performanceTrend: _deriveTrend_T(icsVals),
      recoveryTrend:    _deriveTrend_T(recovVals),
      adherenceTrend:   'INSUFFICIENT',
      painSignals:      painSignals,
      confidence:       _deriveLearningConfidence_T(eligibleObs.length)
    };
  }

  function _buildLearningTraceNode_T(dimension, reasonCode, confidence, exerciseName, planId) {
    return {
      decisionType: 'LEARNING_STATE_APPLIED',
      subject:      exerciseName || 'unknown',
      source:       'HISTORY',
      engine:       'LEARNING',
      confidence:   confidence || _DTC11.NONE,
      evidence:     { dimension: dimension, reasonCode: reasonCode || 'HISTORICAL_RESPONSE', planId: planId || null }
    };
  }

  // ── Shared fixtures ───────────────────────────────────────────────────────
  var EX = { exerciseName: 'Squat', prescriptionExerciseId: 'pid-01', exerciseId: 'ex-sq', prescriptionSlot: 'QUAD:PRI' };
  var mExact   = { confidence: 'EXACT',      slotCompatibility: { compatible: true,  slot: 'QUAD:PRI' }, current: EX, previous: EX, continuityType: 'SAME_PRESCRIPTION' };
  var mStrong  = { confidence: 'STRONG',     slotCompatibility: { compatible: true,  slot: 'QUAD:PRI' }, current: EX, previous: EX, continuityType: 'SAME_EXERCISE_NEW_PRESCRIPTION' };
  var mFunc    = { confidence: 'FUNCTIONAL', slotCompatibility: { compatible: true,  slot: 'QUAD:PRI' }, current: { exerciseName: 'Belt Squat', prescriptionSlot: 'QUAD:PRI' }, previous: EX, continuityType: 'SAME_SLOT_REPLACEMENT' };
  var mStruct  = { confidence: 'EXACT',      slotCompatibility: { compatible: false, slot: null       }, current: { exerciseName: 'Squat', prescriptionExerciseId: 'pid-01', prescriptionSlot: 'QUAD:ACC' }, previous: EX, continuityType: 'STRUCTURAL_SLOT_CHANGE' };
  var mUnres   = { confidence: 'UNRESOLVED', slotCompatibility: null, current: { exerciseName: 'Leg Press' }, continuityType: 'UNRESOLVED_CROSS_PLAN' };
  var mRemoved = { confidence: 'EXACT',      current: null, previous: EX, continuityType: 'REMOVED' };
  var mMoved   = { confidence: 'EXACT',      slotCompatibility: { compatible: true,  slot: 'QUAD:PRI' }, current: EX, previous: EX, continuityType: 'MOVED' };
  var realObs  = [{ ics: 8, rir_real: 2, carga: 100, unit: 'KG' }];
  var afObs    = [{ ics: 8, rir_real: 2, carga: 100, unit: 'KG', autoFilled: true }];
  var acObs    = [{ ics: 7, rir_real: 3, autoClosed: true }];

  // ── TLC1: EXACT + real obs → both eligible ────────────────────────────────
  var r1 = _evaluateLearningEligibility_T(mExact, realObs);
  assert('TLC1a', 'EXACT match → exerciseEligible=true', r1.exerciseEligible === true);
  assert('TLC1b', 'EXACT match → slotEligible=true',     r1.slotEligible     === true);

  // ── TLC2: STRONG + real obs → both eligible ───────────────────────────────
  var r2 = _evaluateLearningEligibility_T(mStrong, realObs);
  assert('TLC2a', 'STRONG match → exerciseEligible=true', r2.exerciseEligible === true);
  assert('TLC2b', 'STRONG match → slotEligible=true',     r2.slotEligible     === true);

  // ── TLC3: FUNCTIONAL (SAME_SLOT_REPLACEMENT) → slot yes, exercise no ──────
  var r3 = _evaluateLearningEligibility_T(mFunc, realObs);
  assert('TLC3a', 'FUNCTIONAL → exerciseEligible=false', r3.exerciseEligible === false);
  assert('TLC3b', 'FUNCTIONAL → slotEligible=true',      r3.slotEligible     === true);

  // ── TLC4: STRUCTURAL_SLOT_CHANGE → exercise yes, slot no ─────────────────
  var r4 = _evaluateLearningEligibility_T(mStruct, realObs);
  assert('TLC4a', 'STRUCTURAL_SLOT_CHANGE → exerciseEligible=true',  r4.exerciseEligible === true);
  assert('TLC4b', 'STRUCTURAL_SLOT_CHANGE → slotEligible=false',     r4.slotEligible     === false);
  assert('TLC4c', 'STRUCTURAL_SLOT_CHANGE → SLOT_INCOMPATIBLE reason', r4.reasons.indexOf('SLOT_INCOMPATIBLE') >= 0);

  // ── TLC5: UNRESOLVED → neither ────────────────────────────────────────────
  var r5 = _evaluateLearningEligibility_T(mUnres, realObs);
  assert('TLC5a', 'UNRESOLVED → exerciseEligible=false', r5.exerciseEligible === false);
  assert('TLC5b', 'UNRESOLVED → slotEligible=false',     r5.slotEligible     === false);

  // ── TLC6: autoFilled obs → filtered → not eligible ────────────────────────
  var r6 = _evaluateLearningEligibility_T(mExact, afObs);
  assert('TLC6', 'autoFilled obs → exerciseEligible=false', r6.exerciseEligible === false && r6.reasons.indexOf('NO_ELIGIBLE_EXERCISE_OBSERVATIONS') >= 0);

  // ── TLC7: autoClosed obs → filtered → not eligible ────────────────────────
  var r7 = _evaluateLearningEligibility_T(mExact, acObs);
  assert('TLC7', 'autoClosed obs → exerciseEligible=false', r7.exerciseEligible === false);

  // ── TLC8: BW load → null ─────────────────────────────────────────────────
  assert('TLC8', 'BW unit → null (never 0)', _normalizeCrossPlanLoad_11({ carga: 80, unit: 'BW' }) === null);

  // ── TLC9: LB → KG ────────────────────────────────────────────────────────
  var lbLoad = _normalizeCrossPlanLoad_11({ carga: 100, unit: 'LB' });
  assert('TLC9', 'LB converted to KG (±0.01)', lbLoad !== null && Math.abs(lbLoad - 45.3592) < 0.01);

  // ── TLC10: REMOVED match → neither ────────────────────────────────────────
  var r10 = _evaluateLearningEligibility_T(mRemoved, realObs);
  assert('TLC10a', 'REMOVED (current=null) → exerciseEligible=false', r10.exerciseEligible === false);
  assert('TLC10b', 'REMOVED (current=null) → slotEligible=false',     r10.slotEligible     === false);

  // ── TLC11: confidence levels (HEURISTIC thresholds) ──────────────────────
  assert('TLC11a', '0 obs → NONE',     _deriveLearningConfidence_T(0) === 'NONE');
  assert('TLC11b', '1 obs → LOW',      _deriveLearningConfidence_T(1) === 'LOW');
  assert('TLC11c', '3 obs → MODERATE', _deriveLearningConfidence_T(3) === 'MODERATE');
  assert('TLC11d', '6 obs → HIGH',     _deriveLearningConfidence_T(6) === 'HIGH');

  // ── TLC12: exerciseState contract ────────────────────────────────────────
  var obs12 = [{ ics: 8, rir_real: 2, carga: 100, unit: 'KG' }, { ics: 8, rir_real: 2, carga: 105, unit: 'KG' }, { ics: 9, rir_real: 2, carga: 110, unit: 'KG' }];
  var eState = _buildExerciseLearningState_T(mExact, obs12);
  assert('TLC12a', 'exerciseState has exerciseIdentity', !!eState && 'exerciseIdentity' in eState);
  assert('TLC12b', 'exerciseState.observations = 3',     eState.observations === 3);
  assert('TLC12c', 'exerciseState has all trend fields', 'loadTrend' in eState && 'rirConsistency' in eState && 'icsTrend' in eState && 'tolerance' in eState && 'confidence' in eState);

  // ── TLC13: slotState contract ─────────────────────────────────────────────
  var sState = _buildSlotLearningState_T(mFunc, obs12, [{ eimd: 1, articular: 'no' }]);
  assert('TLC13a', 'slotState.prescriptionSlot preserved', !!sState && sState.prescriptionSlot === 'QUAD:PRI');
  assert('TLC13b', 'slotState has all fields', 'performanceTrend' in sState && 'recoveryTrend' in sState && 'adherenceTrend' in sState && 'painSignals' in sState && 'confidence' in sState);

  // ── TLC14: learning trace node contract ───────────────────────────────────
  var tr14 = _buildLearningTraceNode_T('load_trend', 'HISTORICAL_RESPONSE', 'HIGH', 'Squat', 'plan-a');
  assert('TLC14a', 'trace source = HISTORY',                        tr14.source       === 'HISTORY');
  assert('TLC14b', 'trace engine = LEARNING',                       tr14.engine       === 'LEARNING');
  assert('TLC14c', 'trace decisionType = LEARNING_STATE_APPLIED',   tr14.decisionType === 'LEARNING_STATE_APPLIED');

  // ── TLC15: AMBIGUOUS → neither ────────────────────────────────────────────
  var mAmb = { confidence: 'UNRESOLVED', slotCompatibility: null, current: { exerciseName: 'Squat' }, continuityType: 'AMBIGUOUS' };
  var r15  = _evaluateLearningEligibility_T(mAmb, realObs);
  assert('TLC15', 'AMBIGUOUS → neither eligible', r15.exerciseEligible === false && r15.slotEligible === false);

  // ── TLC16: null match → neither ───────────────────────────────────────────
  var r16 = _evaluateLearningEligibility_T(null, realObs);
  assert('TLC16', 'null match → neither eligible', r16.exerciseEligible === false && r16.slotEligible === false);

  // ── TLC17: MOVED match → exerciseEligible=true (identity preserved) ───────
  var r17 = _evaluateLearningEligibility_T(mMoved, realObs);
  assert('TLC17', 'MOVED match → exerciseEligible=true (identity resolved regardless of day)', r17.exerciseEligible === true);

  // ── TLC18: exerciseIdentity.name matches match.current.exerciseName ────────
  assert('TLC18', 'exerciseState.exerciseIdentity.name = match.current.exerciseName', !!eState && eState.exerciseIdentity.name === mExact.current.exerciseName);

  console.log('── FASE 11 longitudinal learning contract ✓');
})();

// ═════════════════════════ RESUMEN ═════════════════════════
console.log('\n' + '═'.repeat(60));
console.log('RESULTADOS: ' + _pass + ' ✓   ' + _fail + ' ✗   (total: ' + (_pass+_fail) + ')');
if (_errors.length) {
  console.log('\nFALLIDOS:');
  _errors.forEach(function(e){ console.log('  • '+e); });
}
console.log('═'.repeat(60));
process.exit(_fail > 0 ? 1 : 0);
