/* T491: pure equipment load resolver -- converts a DESIRED canonical load into a PHYSICALLY REALIZABLE load.
 *
 * Not a progression rule: it never decides a magnitude, only how a desired load maps onto the loads an
 * implement can actually be set to. It is deterministic, side-effect free and NOT wired into any
 * operational path (numericApplyAllowed is always false).
 *
 * An increment is only ever known from explicit, sourced metadata:
 *   { kind: 'STEP', step, min?, max?, unit, source }                  selectorized stack / plate-loaded machine
 *   { kind: 'PLATE_LOADED_BAR', barWeight, smallestPlate, max?, unit, source }   barbell / trap bar (2 plates)
 *   { kind: 'AVAILABLE_LOADS', loads: [..], unit, source }            dumbbells / fixed implements
 * source must be one of EXERCISE_METADATA | GYM_METADATA | COACH_CONFIGURED. The equipment TYPE alone
 * (machine, barbell, free_weight, ...) never establishes an increment. Unknown -> UNRESOLVED_EQUIPMENT_INCREMENT.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_EQUIPMENT_RESOLVER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var STATES = Object.freeze({
    RESOLVED: 'RESOLVED',
    UNRESOLVED_EQUIPMENT_INCREMENT: 'UNRESOLVED_EQUIPMENT_INCREMENT',
    UNRESOLVED_EQUIPMENT_IDENTITY: 'UNRESOLVED_EQUIPMENT_IDENTITY',
    DIRECTION_NOT_REALIZABLE: 'DIRECTION_NOT_REALIZABLE',
    OUT_OF_RANGE: 'OUT_OF_RANGE',
    UNIT_MISMATCH: 'UNIT_MISMATCH',
    INVALID_INPUT: 'INVALID_INPUT'
  });
  var SOURCES = Object.freeze({ EXERCISE_METADATA: true, GYM_METADATA: true, COACH_CONFIGURED: true });
  var MODES = Object.freeze({ NEAREST: 'NEAREST', FLOOR: 'FLOOR', CEIL: 'CEIL' });
  // Authored increment data lives here (or is supplied by the caller): gymId -> equipmentId -> metadata.
  // Nothing is authored yet, so every lookup is unresolved by design.
  var INCREMENT_METADATA = Object.freeze({});

  function _num(v) {
    if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function _clean(n) { return Math.round(n * 1e6) / 1e6; }
  function _result(input, extra) {
    var eq = input && input.equipment || {};
    return Object.assign({
      requestedLoad: _num(input && input.desiredLoad), currentLoad: _num(input && input.currentLoad),
      realizableLoad: null, delta: null, roundingReason: null,
      equipmentId: eq.equipmentId || null, equipmentType: eq.equipmentType || null, gymId: eq.gymId || null,
      unit: input && input.unit || null, incrementSource: null, incrementScope: eq.incrementScope || null, incrementRevision: null, incrementConfiguredAt: null, incrementKind: null, resolutionState: STATES.UNRESOLVED_EQUIPMENT_INCREMENT,
      reasons: [], numericApplyAllowed: false, applied: false
    }, extra || {});
  }

  function lookupIncrement(table, gymId, equipmentId) {
    var t = table || INCREMENT_METADATA;
    return (gymId && equipmentId && t[gymId] && t[gymId][equipmentId]) || null;
  }

  // Validates metadata and returns the realizable grid description, or the reason it is unusable.
  function describeGrid(meta, unit) {
    if (!meta || typeof meta !== 'object' || !SOURCES[meta.source]) return { ok: false, reason: 'INCREMENT_SOURCE_MISSING' };
    if (String(meta.unit || '').toUpperCase() !== String(unit || '').toUpperCase()) return { ok: false, reason: 'UNIT_MISMATCH' };
    if (meta.kind === 'STEP') {
      var step = _num(meta.step), min = meta.min === undefined ? 0 : _num(meta.min), max = meta.max === undefined ? null : _num(meta.max);
      if (!(step > 0) || min === null || (max !== null && max < min)) return { ok: false, reason: 'INVALID_INCREMENT_METADATA' };
      return { ok: true, kind: 'STEP', origin: min, step: step, max: max };
    }
    if (meta.kind === 'PLATE_LOADED_BAR') {
      var bar = _num(meta.barWeight), plate = _num(meta.smallestPlate), pmax = meta.max === undefined ? null : _num(meta.max);
      if (!(bar >= 0) || !(plate > 0) || (pmax !== null && pmax < bar)) return { ok: false, reason: 'INVALID_INCREMENT_METADATA' };
      return { ok: true, kind: 'PLATE_LOADED_BAR', origin: bar, step: _clean(2 * plate), max: pmax };
    }
    if (meta.kind === 'AVAILABLE_LOADS') {
      var loads = Array.isArray(meta.loads) ? meta.loads.map(_num) : [];
      if (!loads.length || loads.some(function(l) { return l === null || l < 0; })) return { ok: false, reason: 'INVALID_INCREMENT_METADATA' };
      var sorted = loads.slice().sort(function(a, b) { return a - b; })
        .filter(function(l, i, a) { return i === 0 || l !== a[i - 1]; });
      return { ok: true, kind: 'AVAILABLE_LOADS', loads: sorted };
    }
    return { ok: false, reason: 'INVALID_INCREMENT_METADATA' };
  }

  // Candidate loads bracketing `desired`: { below, above } (either may be null when out of range).
  function _bracket(grid, desired) {
    if (grid.kind === 'AVAILABLE_LOADS') {
      var below = null, above = null;
      grid.loads.forEach(function(l) { if (l <= desired) below = l; });
      for (var i = grid.loads.length - 1; i >= 0; i--) if (grid.loads[i] >= desired) above = grid.loads[i];
      return { below: below, above: above };
    }
    if (desired < grid.origin) return { below: null, above: grid.origin };
    var k = Math.floor(_clean((desired - grid.origin) / grid.step));
    var lo = _clean(grid.origin + k * grid.step), hi = lo === desired ? lo : _clean(grid.origin + (k + 1) * grid.step);
    if (grid.max !== null) { if (lo > grid.max) lo = null; if (hi > grid.max) hi = null; }
    return { below: lo, above: hi };
  }

  function resolveLoad(input) {
    input = input || {};
    var current = _num(input.currentLoad), desired = _num(input.desiredLoad), dir = input.direction;
    if (current === null || desired === null || current < 0 || desired <= 0 || (dir !== 'UP' && dir !== 'DOWN'))
      return _result(input, { resolutionState: STATES.INVALID_INPUT, reasons: ['INVALID_INPUT'] });
    if ((dir === 'UP' && desired < current) || (dir === 'DOWN' && desired > current))
      return _result(input, { resolutionState: STATES.INVALID_INPUT, reasons: ['DIRECTION_CONTRADICTS_TARGET'] });
    var eq = input.equipment || {};
    var meta = lookupIncrement(input.incrementMetadata, eq.gymId, eq.equipmentId);
    if (!meta && input.equipment && input.equipment.loadIncrement) meta = input.equipment.loadIncrement;
    if (!meta && !eq.equipmentId) return _result(input, { resolutionState: STATES.UNRESOLVED_EQUIPMENT_IDENTITY, reasons: ['UNRESOLVED_EQUIPMENT_IDENTITY'] });
    if (!meta) return _result(input, { reasons: ['UNRESOLVED_EQUIPMENT_INCREMENT'] });
    var grid = describeGrid(meta, input.unit);
    if (!grid.ok) {
      var state = grid.reason === 'UNIT_MISMATCH' ? STATES.UNIT_MISMATCH : STATES.UNRESOLVED_EQUIPMENT_INCREMENT;
      return _result(input, { resolutionState: state, reasons: [grid.reason] });
    }
    var mode = MODES[input.roundingMode] || MODES.NEAREST, defaulted = !MODES[input.roundingMode];
    var b = _bracket(grid, desired), chosen, reason;
    if (b.below === null && b.above === null) {
      return _result(input, { resolutionState: STATES.OUT_OF_RANGE, incrementSource: meta.source, reasons: ['ABOVE_EQUIPMENT_MAXIMUM'] });
    }
    // T511: beyond either end of the grid the load is OUT_OF_RANGE, never silently clamped -- except an overshoot of at most
    // half a step on a stepped grid (ordinary nearest rounding). Lists of available loads have no such tolerance.
    if (b.below === null || b.above === null) {
      var overshoot = b.above === null ? _clean(desired - b.below) : _clean(b.above - desired);
      var tol = grid.kind === 'AVAILABLE_LOADS' ? 0 : _clean(grid.step / 2);
      if (overshoot > tol) return _result(input, { resolutionState: STATES.OUT_OF_RANGE, incrementSource: meta.source,
        reasons: [b.above === null ? 'ABOVE_EQUIPMENT_MAXIMUM' : 'BELOW_EQUIPMENT_MINIMUM'] });
    }
    if (b.below !== null && b.above !== null && b.below === b.above) { chosen = b.below; reason = 'EXACT'; }
    else if (mode === MODES.FLOOR) { chosen = b.below; reason = 'FLOOR'; }
    else if (mode === MODES.CEIL) { chosen = b.above; reason = 'CEIL'; }
    else if (b.below === null) { chosen = b.above; reason = 'NEAREST_ONLY_ABOVE'; }
    else if (b.above === null) { chosen = b.below; reason = 'NEAREST_ONLY_BELOW'; }
    else {
      var dl = _clean(desired - b.below), dh = _clean(b.above - desired);
      if (dl < dh) { chosen = b.below; reason = 'NEAREST_BELOW'; }
      else if (dh < dl) { chosen = b.above; reason = 'NEAREST_ABOVE'; }
      else { chosen = Math.abs(b.below - current) <= Math.abs(b.above - current) ? b.below : b.above; reason = 'NEAREST_TIE_TOWARD_CURRENT'; }
    }
    if (chosen === null || chosen === undefined) {
      return _result(input, { resolutionState: STATES.OUT_OF_RANGE, incrementSource: meta.source, reasons: [dir === 'UP' ? 'ABOVE_EQUIPMENT_MAXIMUM' : 'BELOW_EQUIPMENT_MINIMUM'] });
    }
    var delta = _clean(chosen - current);
    var res = _result(input, { realizableLoad: chosen, delta: delta, roundingReason: reason, incrementSource: meta.source,
      incrementRevision: _num(meta.revision), incrementConfiguredAt: typeof meta.configuredAt === 'string' ? meta.configuredAt : null, incrementKind: meta.kind,
      roundingModeDefaulted: defaulted, resolutionState: STATES.RESOLVED });
    if ((dir === 'UP' && delta <= 0) || (dir === 'DOWN' && delta >= 0)) {
      res.resolutionState = STATES.DIRECTION_NOT_REALIZABLE;
      res.reasons.push(delta === 0 ? 'NO_REALIZABLE_MOVE' : 'REALIZABLE_LOAD_MOVES_OPPOSITE');
    }
    return res;
  }

  // T503: realizable-load resolution for a canonical shadow magnitude decision (LOAD candidate only).
  // current = candidate.previousValue, desired = candidate.rawCandidate, direction/unit from the decision.
  // Returns null when the decision has no LOAD candidate. Pure; never applies anything.
  function resolveForCandidate(input) {
    input = input || {};
    var m = input.magnitude || {}, cands = Array.isArray(m.candidates) ? m.candidates : [];
    var c = cands.filter(function(d) { return d && d.dimension === 'LOAD'; })[0];
    if (!c) return null;
    return resolveLoad({ currentLoad: c.previousValue, desiredLoad: c.rawCandidate, direction: m.direction,
      unit: m.evidence && m.evidence.unit, equipment: input.equipment, roundingMode: input.roundingMode });
  }

  // T502: strict Coach configuration input -> sourced metadata (or null to clear). Configuration data only:
  // nothing is defaulted, the equipment type never fills a value, the source is always COACH_CONFIGURED.
  var CONFIG_KINDS = { STEP: true, PLATE_LOADED_BAR: true, AVAILABLE_LOADS: true };
  var CONFIG_MAX_LOAD = 2000;
  function _cfgNum(v, label, required) {
    if (v === undefined || v === null || String(v).trim() === '') {
      if (required) throw new Error('Incremento de carga: falta ' + label + '.');
      return null;
    }
    var n = typeof v === 'number' ? v : (/^\s*\d+([.,]\d+)?\s*$/.test(String(v)) ? Number(String(v).trim().replace(',', '.')) : NaN);
    if (!Number.isFinite(n) || n < 0 || n > CONFIG_MAX_LOAD) throw new Error('Incremento de carga: ' + label + ' no es un valor válido.');
    return n;
  }
  function normalizeLoadIncrementInput(input) {
    if (!input || typeof input !== 'object') return null;
    var kind = String(input.kind === undefined || input.kind === null ? '' : input.kind).trim();
    if (kind === '' || kind === 'NONE') return null;
    if (!CONFIG_KINDS[kind]) throw new Error('Incremento de carga: tipo desconocido.');
    var unit = String(input.unit || '').trim().toUpperCase();
    if (unit !== 'KG' && unit !== 'LB') throw new Error('Incremento de carga: la unidad debe ser KG o LB.');
    var meta = { kind: kind };
    if (kind === 'STEP') {
      meta.step = _cfgNum(input.step, 'el paso', true);
      var min = _cfgNum(input.min, 'el mínimo', false), max = _cfgNum(input.max, 'el máximo', false);
      if (min !== null) meta.min = min;
      if (max !== null) meta.max = max;
    } else if (kind === 'PLATE_LOADED_BAR') {
      meta.barWeight = _cfgNum(input.barWeight, 'el peso de la barra', true);
      meta.smallestPlate = _cfgNum(input.smallestPlate, 'el disco más pequeño', true);
      var pmax = _cfgNum(input.max, 'el máximo', false);
      if (pmax !== null) meta.max = pmax;
    } else {
      var raw = Array.isArray(input.loads) ? input.loads : String(input.loads === undefined || input.loads === null ? '' : input.loads).split(/[\s;]+/).filter(Boolean);
      if (!raw.length) throw new Error('Incremento de carga: indica al menos una carga disponible.');
      meta.loads = raw.map(function(l) { return _cfgNum(l, 'una carga disponible', true); });
      meta.loads = meta.loads.slice().sort(function(a, b) { return a - b; }).filter(function(l, i, a) { return i === 0 || l !== a[i - 1]; });
    }
    meta.unit = unit;
    meta.source = 'COACH_CONFIGURED';
    var grid = describeGrid(meta, unit);
    if (!grid.ok) throw new Error('Incremento de carga: configuración inválida (' + grid.reason + ').');
    return meta;
  }

  // Extracts the equipment reference from an exercise-catalog entry (no increment is inferred from it).
  function equipmentRefFromCatalogEntry(entry) {
    entry = entry || {};
    return { equipmentId: entry.equipmentId || null, equipmentType: entry.equipmentType || null,
      gymId: entry.gymId || null, equipmentLabel: entry.equipment || entry.equipmentName || null,
      loadIncrement: entry.loadIncrement || null };
  }

  return { STATES: STATES, MODES: MODES, SOURCES: Object.keys(SOURCES), INCREMENT_METADATA: INCREMENT_METADATA,
    lookupIncrement: lookupIncrement, describeGrid: describeGrid, resolveLoad: resolveLoad,
    equipmentRefFromCatalogEntry: equipmentRefFromCatalogEntry, normalizeLoadIncrementInput: normalizeLoadIncrementInput,
    resolveForCandidate: resolveForCandidate };
});
