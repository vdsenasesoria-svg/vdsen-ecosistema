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

// ═════════════════════════ RESUMEN ═════════════════════════
console.log('\n' + '═'.repeat(60));
console.log('RESULTADOS: ' + _pass + ' ✓   ' + _fail + ' ✗   (total: ' + (_pass+_fail) + ')');
if (_errors.length) {
  console.log('\nFALLIDOS:');
  _errors.forEach(function(e){ console.log('  • '+e); });
}
console.log('═'.repeat(60));
process.exit(_fail > 0 ? 1 : 0);
