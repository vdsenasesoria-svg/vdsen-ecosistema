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

  // T518: provenance. Additive fields on the metadata itself: scope, configuredAt, configuredBy (when the auth context
  // provides it) and a per-item revision. Re-saving IDENTICAL values keeps the previous provenance (no phantom revisions).
  var _CORE = ['kind', 'step', 'min', 'max', 'barWeight', 'smallestPlate', 'loads', 'unit', 'source'];
  function _sameCore(a, b) { return _CORE.every(function(k) { return JSON.stringify(a && a[k]) === JSON.stringify(b && b[k]); }); }
  function stampProvenance(meta, opts) {
    opts = opts || {};
    var prev = opts.prev || null;
    if (prev && _sameCore(prev, meta)) return JSON.parse(JSON.stringify(prev));
    var out = JSON.parse(JSON.stringify(meta));
    out.scope = opts.scope;
    out.configuredAt = opts.now || new Date().toISOString();
    if (opts.uid) out.configuredBy = String(opts.uid); else delete out.configuredBy;
    out.revision = (prev && Number.isInteger(prev.revision) && prev.revision >= 0 ? prev.revision : 0) + 1;
    return out;
  }

  // Pure config mutator. scope 'SHARED' | 'GYM'. meta === null removes the entry. Returns a NEW config.
  // args.provenance = { now?, uid? } stamps scope / configuredAt / configuredBy / revision.
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
    var prev = scope === 'SHARED' ? next.shared[eqId] : (next.gyms[gymId] && next.gyms[gymId][eqId]);
    if (meta !== null && args.provenance) meta = stampProvenance(meta, { prev: prev, scope: scope === 'SHARED' ? SCOPES.SHARED_EQUIPMENT : SCOPES.GYM_EQUIPMENT, now: args.provenance.now, uid: args.provenance.uid });
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

  // ---- T518: BULK ENTRY (export template / import with preview; all-or-nothing) -------------------------------------------
  var BULK_SCHEMA = 'vdsen-equipment-increments-v1';
  var BULK_FIELDS = ['equipmentId', 'name', 'scope', 'gymId', 'kind', 'unit', 'step', 'min', 'max', 'barWeight', 'smallestPlate', 'loads'];
  var BULK_INPUT_FIELDS = ['scope', 'gymId', 'kind', 'unit', 'step', 'min', 'max', 'barWeight', 'smallestPlate', 'loads'];
  function _cell(v) { return v === undefined || v === null ? '' : String(v); }
  function _rowFromMeta(meta) {
    meta = meta || {};
    return { kind: _cell(meta.kind), unit: _cell(meta.unit), step: _cell(meta.step), min: _cell(meta.min), max: _cell(meta.max), barWeight: _cell(meta.barWeight),
      smallestPlate: _cell(meta.smallestPlate), loads: Array.isArray(meta.loads) ? meta.loads.join(' ') : '' };
  }

  // Template: one row per canonical equipment whose IDENTITY is resolved (scope SHARED) plus one row per existing gym-specific
  // configuration. Unconfigured rows are BLANK; nothing is pre-filled with example values. Unresolved identities are listed
  // separately (they can only be configured per exercise, outside the bulk path).
  function exportTemplate(input) {
    input = input || {};
    var cfg = normalizeConfig(input.config), rows = [], notBulk = [];
    buildEquipmentQueue({ catalog: input.catalog, config: cfg }).forEach(function(q) {
      if (q.identityStatus === 'UNRESOLVED') { notBulk.push({ name: q.name, reason: q.identityReason, exerciseCount: q.exerciseCount }); return; }
      rows.push(Object.assign({ equipmentId: q.equipmentId, name: q.name, scope: 'SHARED', gymId: '' }, _rowFromMeta(cfg.shared[q.equipmentId])));
      Object.keys(cfg.gyms).sort().forEach(function(g) { if (cfg.gyms[g][q.equipmentId]) rows.push(Object.assign({ equipmentId: q.equipmentId, name: q.name, scope: 'GYM', gymId: g }, _rowFromMeta(cfg.gyms[g][q.equipmentId]))); });
    });
    var format = input.format === 'csv' ? 'csv' : 'json';
    if (format === 'json') return { format: 'json', rows: rows, notConfigurableInBulk: notBulk,
      text: JSON.stringify({ schema: BULK_SCHEMA, note: 'Completa solo valores REALES del equipo. Deja en blanco lo que no sepas. kind: STEP | PLATE_LOADED_BAR | AVAILABLE_LOADS | NONE (borra).', items: rows }, null, 2) };
    var esc = function(v) { v = _cell(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return { format: 'csv', rows: rows, notConfigurableInBulk: notBulk,
      text: BULK_FIELDS.join(',') + '\n' + rows.map(function(r) { return BULK_FIELDS.map(function(f) { return esc(r[f]); }).join(','); }).join('\n') + '\n' };
  }

  function _parseCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(function(x) { return x !== ''; }) || row.length > 1) rows.push(row); row = []; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    if (q) throw new Error('CSV: comillas sin cerrar.');
    return rows;
  }

  // -> { ok, errors: [string], rows: [{line, equipmentId, scope, gymId, action}], counts, nextConfig|null }
  // ALL rows are validated; any error means nothing is applied (never a partial batch).
  function parseImport(text, opts) {
    opts = opts || {};
    var errors = [], items = [];
    var res = function() { return { ok: false, errors: errors, rows: [], counts: { added: 0, changed: 0, removed: 0, unchanged: 0, skipped: 0 }, nextConfig: null }; };
    text = String(text === undefined || text === null ? '' : text).replace(/^\uFEFF/, '').trim();
    if (!text) { errors.push('El archivo está vacío.'); return res(); }
    try {
      if (text[0] === '{' || text[0] === '[') {
        var j = JSON.parse(text), arr = Array.isArray(j) ? j : j.items;
        if (!Array.isArray(j) && j.schema !== BULK_SCHEMA) throw new Error('esquema desconocido (se esperaba ' + BULK_SCHEMA + ').');
        if (!Array.isArray(arr)) throw new Error('falta la lista "items".');
        arr.forEach(function(o, i) { items.push({ line: i + 1, data: o }); });
      } else {
        var t = _parseCsv(text); if (!t.length) throw new Error('sin filas.');
        var head = t[0].map(function(h) { return h.trim(); });
        head.forEach(function(h) { if (BULK_FIELDS.indexOf(h) < 0) errors.push('Columna desconocida "' + h + '".'); });
        if (head.indexOf('equipmentId') < 0) errors.push('Falta la columna equipmentId.');
        t.slice(1).forEach(function(r, i) { var o = {}; head.forEach(function(h, k) { o[h] = r[k] === undefined ? '' : r[k]; }); items.push({ line: i + 2, data: o }); });
      }
    } catch (e) { errors.push('No se pudo leer el archivo: ' + e.message); return res(); }
    if (errors.length) return res();
    var index = identity.buildIndex(opts.catalog), gyms = {};
    Object.keys((opts.catalog && opts.catalog.gyms) || {}).forEach(function(k) { gyms[(opts.catalog.gyms[k].gymId || k)] = true; });
    var seen = {}, work = normalizeConfig(opts.config), rows = [], counts = { added: 0, changed: 0, removed: 0, unchanged: 0, skipped: 0 };
    items.forEach(function(it) {
      var d = it.data, tag = 'Fila ' + it.line + ': ';
      if (!d || typeof d !== 'object' || Array.isArray(d)) { errors.push(tag + 'formato de fila inválido.'); return; }
      Object.keys(d).forEach(function(k) { if (BULK_FIELDS.indexOf(k) < 0) errors.push(tag + 'campo desconocido "' + k + '".'); });
      var eqId = _cell(d.equipmentId).trim();
      if (!eqId) { errors.push(tag + 'falta equipmentId.'); return; }
      if (!index.byId[eqId]) { errors.push(tag + 'equipmentId "' + eqId + '" no es un equipo canónico conocido.'); return; }
      var scope = _cell(d.scope).trim().toUpperCase() || 'SHARED', gymId = _cell(d.gymId).trim();
      if (scope !== 'SHARED' && scope !== 'GYM') { errors.push(tag + 'alcance "' + d.scope + '" inválido (SHARED o GYM).'); return; }
      if (scope === 'GYM' && !gymId) { errors.push(tag + 'alcance GYM requiere gymId.'); return; }
      if (scope === 'GYM' && !gyms[gymId]) { errors.push(tag + 'sede "' + gymId + '" desconocida.'); return; }
      if (scope === 'SHARED' && gymId) { errors.push(tag + 'alcance SHARED no admite gymId.'); return; }
      var input = {}; BULK_INPUT_FIELDS.forEach(function(f) { input[f] = _cell(d[f]).trim(); });
      var blank = !input.kind && ['unit', 'step', 'min', 'max', 'barWeight', 'smallestPlate', 'loads'].every(function(f) { return input[f] === ''; });
      if (blank) { counts.skipped++; return; }
      var meta, kind = input.kind.toUpperCase();
      if (!input.kind) { errors.push(tag + 'hay valores pero falta kind (STEP, PLATE_LOADED_BAR o AVAILABLE_LOADS).'); return; }
      try { meta = kind === 'NONE' ? null : resolver.normalizeLoadIncrementInput({ kind: kind, unit: input.unit, step: input.step, min: input.min, max: input.max, barWeight: input.barWeight, smallestPlate: input.smallestPlate, loads: input.loads }); }
      catch (e) { errors.push(tag + e.message.replace(/^Incremento de carga: /, '') + ' (' + eqId + ')'); return; }
      var key = scope + '|' + gymId + '|' + eqId, fp = JSON.stringify(meta);
      if (seen[key] !== undefined) { if (seen[key].fp !== fp) errors.push(tag + 'definición duplicada y contradictoria para ' + eqId + ' (' + scope + (gymId ? ' ' + gymId : '') + '), ver fila ' + seen[key].line + '.'); return; }
      seen[key] = { fp: fp, line: it.line };
      var prev = scope === 'SHARED' ? work.shared[eqId] : (work.gyms[gymId] && work.gyms[gymId][eqId]) || null, action;
      if (meta === null) action = prev ? 'REMOVED' : 'UNCHANGED';
      else if (!prev) action = 'ADDED';
      else action = _sameCore(prev, meta) ? 'UNCHANGED' : 'CHANGED';
      try { if (action !== 'UNCHANGED') work = setEquipmentIncrement(work, { scope: scope, gymId: gymId, equipmentId: eqId, meta: meta, provenance: { now: opts.now, uid: opts.uid } }); }
      catch (e) { errors.push(tag + e.message.replace(/^Incremento de carga: /, '')); return; }
      counts[{ ADDED: 'added', CHANGED: 'changed', REMOVED: 'removed', UNCHANGED: 'unchanged' }[action]]++;
      rows.push({ line: it.line, equipmentId: eqId, name: index.byId[eqId].name, scope: scope, gymId: gymId, action: action });
    });
    if (errors.length) return res();
    return { ok: true, errors: [], rows: rows, counts: counts, nextConfig: work };
  }

  // ---- T518: CHANGE IMPACT PREVIEW (local data only) ----------------------------------------------------------------------
  // candidates: [{ key, exerciseId, exerciseDoc?, magnitude }]  (the LOAD candidates currently visible to the Coach).
  // "READY" here is the equipment gate (RESOLVED realizable load); the other readiness gates are unaffected by metadata.
  function previewImpact(input) {
    input = input || {};
    var catalog = input.catalog, index = identity.buildIndex(catalog), cands = Array.isArray(input.candidates) ? input.candidates : [];
    function state(cfg, c) {
      var ref = equipmentRefForExercise({ catalog: catalog, index: index, exerciseId: c.exerciseId, exerciseDoc: c.exerciseDoc || null, config: cfg });
      var r = resolver.resolveForCandidate({ magnitude: c.magnitude, equipment: ref });
      return r ? { ready: r.resolutionState === 'RESOLVED', state: r.resolutionState, load: r.realizableLoad } : null;
    }
    var out = { mode: cands.length ? 'CANDIDATES' : 'CATALOG', candidates: { total: 0, blockedToReady: 0, readyToBlocked: 0, readyLoadChanged: 0, unchangedReady: 0, unchangedBlocked: 0, items: [] },
      catalog: { exercisesNewlyConfigured: 0, exercisesLosingConfiguration: 0, exercisesChangedValue: 0, exercisesUnchanged: 0, equipmentTouched: 0 } };
    cands.forEach(function(c) {
      var a = state(input.config, c), b = state(input.nextConfig, c);
      if (!a || !b) return;
      out.candidates.total++;
      var cat = !a.ready && b.ready ? 'BLOCKED_TO_READY' : a.ready && !b.ready ? 'READY_TO_BLOCKED' : a.ready && b.ready && a.load !== b.load ? 'READY_LOAD_CHANGED' : a.ready ? 'UNCHANGED_READY' : 'UNCHANGED_BLOCKED';
      out.candidates[{ BLOCKED_TO_READY: 'blockedToReady', READY_TO_BLOCKED: 'readyToBlocked', READY_LOAD_CHANGED: 'readyLoadChanged', UNCHANGED_READY: 'unchangedReady', UNCHANGED_BLOCKED: 'unchangedBlocked' }[cat]]++;
      out.candidates.items.push({ key: c.key || null, exerciseId: c.exerciseId, change: cat, before: a, after: b });
    });
    var touched = {};
    Object.keys((catalog && catalog.gyms) || {}).forEach(function(k) {
      var g = catalog.gyms[k], gymId = g.gymId || k;
      if (touched['gym:' + gymId]) return; touched['gym:' + gymId] = true;
      (g.entries || []).concat(g.legacyEntries || []).forEach(function(e) {
        var a = equipmentRefForExercise({ catalog: catalog, index: index, exerciseId: e.exerciseId, gymId: gymId, config: input.config });
        var b = equipmentRefForExercise({ catalog: catalog, index: index, exerciseId: e.exerciseId, gymId: gymId, config: input.nextConfig });
        var fa = JSON.stringify(a.loadIncrement && [a.loadIncrement.kind, a.loadIncrement.step, a.loadIncrement.min, a.loadIncrement.max, a.loadIncrement.barWeight, a.loadIncrement.smallestPlate, a.loadIncrement.loads, a.loadIncrement.unit]);
        var fb = JSON.stringify(b.loadIncrement && [b.loadIncrement.kind, b.loadIncrement.step, b.loadIncrement.min, b.loadIncrement.max, b.loadIncrement.barWeight, b.loadIncrement.smallestPlate, b.loadIncrement.loads, b.loadIncrement.unit]);
        if (fa === fb) out.catalog.exercisesUnchanged++;
        else if (!a.loadIncrement) { out.catalog.exercisesNewlyConfigured++; if (b.identity.canonicalEquipmentId) touched[b.identity.canonicalEquipmentId] = true; }
        else if (!b.loadIncrement) { out.catalog.exercisesLosingConfiguration++; if (a.identity.canonicalEquipmentId) touched[a.identity.canonicalEquipmentId] = true; }
        else { out.catalog.exercisesChangedValue++; if (b.identity.canonicalEquipmentId) touched[b.identity.canonicalEquipmentId] = true; }
      });
    });
    out.catalog.equipmentTouched = Object.keys(touched).filter(function(k) { return k.indexOf('gym:') !== 0; }).length;
    return out;
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
    QUEUE_STATUS: QUEUE_STATUS, buildEquipmentQueue: buildEquipmentQueue, stampProvenance: stampProvenance, exportTemplate: exportTemplate, parseImport: parseImport,
    previewImpact: previewImpact, BULK_SCHEMA: BULK_SCHEMA, BULK_FIELDS: BULK_FIELDS };
});
