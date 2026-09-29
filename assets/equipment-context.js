/* T509: equipment CONTEXT -- identity + increment metadata precedence. Pure and deterministic.
 *
 * Increment metadata is primarily a property of EQUIPMENT (+ GYM). Precedence for one exercise:
 *   1. explicit exercise override   (exercises/{id}.loadIncrement)
 *   2. gym-specific equipment       (coaches/{uid}.equipmentIncrements.gyms[gymId][equipmentId])
 *   3. shared canonical equipment   (coaches/{uid}.equipmentIncrements.shared[equipmentId])
 *   4. unresolved
 * The highest level that is PRESENT wins; if it is invalid the result is unresolved with that reason (it never
 * silently falls through to a lower level). Nothing is defaulted from the equipment type or label.
 */
(function(root, factory) {
  var deps = {};
  if (typeof module === 'object' && module.exports) {
    deps.identity = require('./equipment-identity.js'); deps.resolver = require('./progression-equipment-resolver.js');
  } else { deps.identity = root && root.VDSEN_EQUIPMENT_IDENTITY; deps.resolver = root && root.VDSEN_EQUIPMENT_RESOLVER; }
  var api = factory(deps.identity, deps.resolver);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_EQUIPMENT_CONTEXT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(identity, resolver) {
  'use strict';

  var SCOPES = Object.freeze({ EXERCISE: 'EXERCISE', GYM_EQUIPMENT: 'GYM_EQUIPMENT', SHARED_EQUIPMENT: 'SHARED_EQUIPMENT' });
  function _has(o, k) { return o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null && o[k] !== undefined; }
  function _validate(meta) {
    if (!meta || typeof meta !== 'object') return 'INVALID_INCREMENT_METADATA';
    var g = resolver.describeGrid(meta, meta.unit);
    return g.ok ? null : g.reason;
  }

  function emptyConfig() { return { shared: {}, gyms: {} }; }
  // Defensive copy of whatever is stored on the coach doc; drops malformed branches.
  function normalizeConfig(raw) {
    var out = emptyConfig();
    if (!raw || typeof raw !== 'object') return out;
    if (raw.shared && typeof raw.shared === 'object') Object.keys(raw.shared).forEach(function(id) { if (raw.shared[id] && typeof raw.shared[id] === 'object') out.shared[id] = JSON.parse(JSON.stringify(raw.shared[id])); });
    if (raw.gyms && typeof raw.gyms === 'object') Object.keys(raw.gyms).forEach(function(g) {
      if (!raw.gyms[g] || typeof raw.gyms[g] !== 'object') return;
      out.gyms[g] = {};
      Object.keys(raw.gyms[g]).forEach(function(id) { if (raw.gyms[g][id] && typeof raw.gyms[g][id] === 'object') out.gyms[g][id] = JSON.parse(JSON.stringify(raw.gyms[g][id])); });
    });
    return out;
  }

  // -> { meta, scope, invalidReason }
  function resolveIncrementMetadata(input) {
    input = input || {};
    var cfg = normalizeConfig(input.config), eqId = input.equipmentId || null, gymId = input.gymId || null;
    var levels = [];
    if (input.exerciseOverride) levels.push([SCOPES.EXERCISE, input.exerciseOverride]);
    if (eqId && gymId && _has(cfg.gyms[gymId], eqId)) levels.push([SCOPES.GYM_EQUIPMENT, cfg.gyms[gymId][eqId]]);
    if (eqId && _has(cfg.shared, eqId)) levels.push([SCOPES.SHARED_EQUIPMENT, cfg.shared[eqId]]);
    if (!levels.length) return { meta: null, scope: null, invalidReason: null };
    var top = levels[0], bad = _validate(top[1]);
    return bad ? { meta: null, scope: top[0], invalidReason: bad } : { meta: top[1], scope: top[0], invalidReason: null };
  }

  // Pure config mutator. scope 'SHARED' | 'GYM'. meta === null removes the entry. Returns a NEW config.
  function setEquipmentIncrement(config, args) {
    args = args || {};
    var scope = args.scope, eqId = String(args.equipmentId || '').trim(), gymId = String(args.gymId || '').trim();
    if (!eqId) throw new Error('Incremento de carga: falta el equipo.');
    if (scope !== 'SHARED' && scope !== 'GYM') throw new Error('Incremento de carga: alcance desconocido.');
    if (scope === 'GYM' && !gymId) throw new Error('Incremento de carga: falta la sede.');
    var meta = args.meta;
    if (meta !== null) {
      if (_validate(meta) || meta.source !== 'COACH_CONFIGURED') throw new Error('Incremento de carga: configuración inválida.');
    }
    var next = normalizeConfig(config);
    if (scope === 'SHARED') { if (meta === null) delete next.shared[eqId]; else next.shared[eqId] = meta; }
    else {
      next.gyms[gymId] = next.gyms[gymId] || {};
      if (meta === null) { delete next.gyms[gymId][eqId]; if (!Object.keys(next.gyms[gymId]).length) delete next.gyms[gymId]; } else next.gyms[gymId][eqId] = meta;
    }
    return next;
  }

  function _entryByExerciseId(catalog, exerciseId) {
    var found = null;
    Object.keys((catalog && catalog.gyms) || {}).forEach(function(k) {
      var g = catalog.gyms[k];
      (g.entries || []).concat(g.legacyEntries || []).forEach(function(e) { if (!found && e.exerciseId === exerciseId) found = { entry: e, gymId: g.gymId || k }; });
    });
    return found;
  }

  // Equipment reference for ONE plan exercise, by exact exerciseId only (never by exercise name).
  // ctx: { catalog, index?, exerciseId, exerciseDoc?, gymId?, config? }
  function equipmentRefForExercise(ctx) {
    ctx = ctx || {};
    var index = ctx.index || identity.buildIndex(ctx.catalog);
    var doc = ctx.exerciseDoc || null, hit = ctx.exerciseId ? _entryByExerciseId(ctx.catalog, String(ctx.exerciseId)) : null;
    var entry = hit && hit.entry, gymId = ctx.gymId || (doc && doc.gymId) || (hit && hit.gymId) || null;
    var id = identity.identify(index, { equipmentId: (doc && doc.equipmentId) || (entry && entry.equipmentId) || null, exerciseId: ctx.exerciseId ? String(ctx.exerciseId) : null,
      label: (doc && doc.equipment) || (entry && entry.equipment) || '', gymId: gymId });
    var meta = resolveIncrementMetadata({ exerciseOverride: doc && doc.loadIncrement || null, gymId: gymId, equipmentId: id.equipmentId, config: ctx.config });
    var equipmentId = id.equipmentId || (meta.scope === SCOPES.EXERCISE && ctx.exerciseId ? 'exercise:' + ctx.exerciseId : null);
    return { equipmentId: equipmentId, equipmentType: id.equipmentType || (doc && doc.equipmentType) || (entry && entry.equipmentType) || null, gymId: gymId,
      loadIncrement: meta.meta, incrementScope: meta.scope, incrementInvalidReason: meta.invalidReason,
      identity: { status: id.status, reason: id.reason, canonicalEquipmentId: id.equipmentId, canonicalName: id.canonicalName },
      exerciseId: ctx.exerciseId || null };
  }

  var QUEUE_STATUS = Object.freeze({ IDENTITY_UNRESOLVED: 'IDENTITY_UNRESOLVED', INCREMENT_INVALID: 'INCREMENT_INVALID', INCREMENT_UNRESOLVED: 'INCREMENT_UNRESOLVED',
    UNIT_MISMATCH: 'UNIT_MISMATCH', READY: 'READY' });

  // T510: compact readiness queue -- which equipment blocks canonical LOAD candidates.
  // input: { catalog, config?, exerciseOverrides? {exerciseId: loadIncrement}, candidates? [{ equipmentId|null, exerciseId?, unit }] }
  function buildEquipmentQueue(input) {
    input = input || {};
    var catalog = input.catalog || {}, cfg = normalizeConfig(input.config), overrides = input.exerciseOverrides || {}, candidates = Array.isArray(input.candidates) ? input.candidates : [];
    var index = identity.buildIndex(catalog), rows = {}, seenGyms = {};
    function rowFor(key, base) { return rows[key] || (rows[key] = Object.assign({ aliases: {}, exerciseIds: [] }, base)); }
    Object.keys(catalog.gyms || {}).forEach(function(k) {
      var g = catalog.gyms[k], gymId = g.gymId || k;
      if (seenGyms[gymId]) return; seenGyms[gymId] = true;
      (g.entries || []).concat(g.legacyEntries || []).forEach(function(e) {
        var id = identity.identify(index, { equipmentId: e.equipmentId, exerciseId: e.exerciseId, label: e.equipment, gymId: gymId });
        var key = id.equipmentId ? id.equipmentId : 'unresolved|' + gymId + '|' + identity.normalizeLabel(e.equipment);
        var r = rowFor(key, { key: key, equipmentId: id.equipmentId, name: id.canonicalName || e.equipment, equipmentType: id.equipmentType || e.equipmentType || null,
          gymId: gymId, identityStatus: id.status, identityReason: id.reason, implementRole: id.implementRole });
        r.aliases[e.equipment] = true; r.exerciseIds.push(e.exerciseId);
      });
    });
    (catalog.functionalEquipment || []).forEach(function(f) {
      if (!Object.keys(rows).some(function(k) { return rows[k].equipmentId === f.equipmentId; }))
        rowFor(f.equipmentId, { key: f.equipmentId, equipmentId: f.equipmentId, name: f.name, equipmentType: f.equipmentType || null, gymId: null, identityStatus: 'EXPLICIT_ID', identityReason: null }).aliases[f.name] = true;
    });
    var out = Object.keys(rows).map(function(k) {
      var r = rows[k], resolved = r.identityStatus !== 'UNRESOLVED';
      var meta = resolved ? resolveIncrementMetadata({ gymId: r.gymId, equipmentId: r.equipmentId, config: cfg }) : { meta: null, scope: null, invalidReason: null };
      var mine = candidates.filter(function(c) { return resolved ? c.equipmentId === r.equipmentId : (!c.equipmentId && r.exerciseIds.indexOf(c.exerciseId) >= 0); });
      var overrideCount = r.exerciseIds.filter(function(id) { return !!overrides[id]; }).length;
      var incState = !resolved ? 'NOT_APPLICABLE' : meta.invalidReason ? 'INVALID' : meta.meta ? 'CONFIGURED' : 'NONE';
      var unitMismatch = meta.meta && mine.some(function(c) { return c.unit && String(c.unit).toUpperCase() !== String(meta.meta.unit).toUpperCase(); });
      var status = !resolved ? QUEUE_STATUS.IDENTITY_UNRESOLVED : incState === 'INVALID' ? QUEUE_STATUS.INCREMENT_INVALID : incState === 'NONE' ? QUEUE_STATUS.INCREMENT_UNRESOLVED
        : unitMismatch ? QUEUE_STATUS.UNIT_MISMATCH : QUEUE_STATUS.READY;
      var missing = [];
      if (!resolved && r.implementRole === 'ATTACHMENT') missing.push('accesorio sin carga propia: la carga se configura en el implemento de polea utilizado (el repositorio no lo vincula)');
      else if (!resolved) missing.push('identidad canónica (' + (r.identityReason || 'NO_CANONICAL_DEFINITION') + '): solo configurable por ejercicio');
      else if (incState === 'NONE') missing.push('incremento explícito (STEP: paso · PLATE_LOADED_BAR: barra + disco mínimo · AVAILABLE_LOADS: cargas) y unidad');
      else if (incState === 'INVALID') missing.push('corregir incremento inválido (' + meta.invalidReason + ')');
      else if (unitMismatch) missing.push('unidad del incremento (' + meta.meta.unit + ') distinta a la de la evidencia');
      return { key: r.key, equipmentId: r.equipmentId, name: r.name, equipmentType: r.equipmentType, gymId: r.gymId, aliases: Object.keys(r.aliases).sort(),
        identityStatus: r.identityStatus, identityReason: r.identityReason, implementRole: r.implementRole || 'LOAD_IMPLEMENT', exerciseCount: r.exerciseIds.length, exerciseOverrideCount: overrideCount,
        incrementState: incState, incrementScope: meta.scope, incrementSource: meta.meta ? meta.meta.source : null, incrementUnit: meta.meta ? meta.meta.unit : null,
        candidatesAffected: mine.length, status: status, blocker: status === QUEUE_STATUS.READY ? null : status, missing: missing };
    });
    return out.sort(function(a, b) { return b.candidatesAffected - a.candidatesAffected || b.exerciseCount - a.exerciseCount || a.name.localeCompare(b.name) || String(a.key).localeCompare(String(b.key)); });
  }

  return { SCOPES: SCOPES, emptyConfig: emptyConfig, normalizeConfig: normalizeConfig, resolveIncrementMetadata: resolveIncrementMetadata,
    setEquipmentIncrement: setEquipmentIncrement, equipmentRefForExercise: equipmentRefForExercise,
    QUEUE_STATUS: QUEUE_STATUS, buildEquipmentQueue: buildEquipmentQueue };
});
