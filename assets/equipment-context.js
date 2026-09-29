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
    var id = identity.identify(index, { equipmentId: (doc && doc.equipmentId) || (entry && entry.equipmentId) || null,
      label: (doc && doc.equipment) || (entry && entry.equipment) || '', gymId: gymId });
    var meta = resolveIncrementMetadata({ exerciseOverride: doc && doc.loadIncrement || null, gymId: gymId, equipmentId: id.equipmentId, config: ctx.config });
    var equipmentId = id.equipmentId || (meta.scope === SCOPES.EXERCISE && ctx.exerciseId ? 'exercise:' + ctx.exerciseId : null);
    return { equipmentId: equipmentId, equipmentType: id.equipmentType || (doc && doc.equipmentType) || (entry && entry.equipmentType) || null, gymId: gymId,
      loadIncrement: meta.meta, incrementScope: meta.scope, incrementInvalidReason: meta.invalidReason,
      identity: { status: id.status, reason: id.reason, canonicalEquipmentId: id.equipmentId, canonicalName: id.canonicalName },
      exerciseId: ctx.exerciseId || null };
  }

  return { SCOPES: SCOPES, emptyConfig: emptyConfig, normalizeConfig: normalizeConfig, resolveIncrementMetadata: resolveIncrementMetadata,
    setEquipmentIncrement: setEquipmentIncrement, equipmentRefForExercise: equipmentRefForExercise };
});
