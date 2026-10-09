/* T508: canonical EQUIPMENT identity. Pure and deterministic.
 *
 * Order: exact equipmentId > exact normalized canonical name/alias (gym scope first, then functional scope)
 * > UNRESOLVED (with a reason). "Normalized" means case / accents / whitespace only -- never similarity.
 * Identity is not increment metadata: this module never yields a load increment.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_EQUIPMENT_IDENTITY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var STATUS = Object.freeze({ EXPLICIT_ID: 'EXPLICIT_ID', EXERCISE_MAPPING: 'EXERCISE_MAPPING', ALIAS_MATCH: 'ALIAS_MATCH', UNRESOLVED: 'UNRESOLVED' });
  var REASONS = Object.freeze({ NO_LABEL: 'NO_LABEL', UNKNOWN_EQUIPMENT_ID: 'UNKNOWN_EQUIPMENT_ID', NO_CANONICAL_DEFINITION: 'NO_CANONICAL_DEFINITION',
    AMBIGUOUS_ALIAS: 'AMBIGUOUS_ALIAS' });

  function normalizeLabel(v) {
    return String(v === undefined || v === null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // catalog: the VDSEN_EXERCISE_VISUAL_CATALOG object. Returns an immutable-by-convention index.
  function buildIndex(catalog) {
    catalog = catalog || {};
    var byId = {}, byExerciseId = {}, gymAliases = {}, funcAliases = {}, unresolvedByLabel = {}, ambiguous = {};
    function add(item, scope, gymId) {
      byId[item.equipmentId] = { equipmentId: item.equipmentId, name: item.name, equipmentType: item.equipmentType || null, scope: scope, gymId: gymId || null,
        aliases: (item.aliases || []).slice(), exerciseIds: (item.exerciseIds || []).slice() };
      (item.exerciseIds || []).forEach(function(x) { if (byExerciseId[x] && byExerciseId[x] !== item.equipmentId) ambiguous['exercise:' + x] = true; byExerciseId[x] = item.equipmentId; });
      var table = scope === 'FUNCTIONAL' ? funcAliases : (gymAliases[gymId] = gymAliases[gymId] || {});
      [item.name].concat(item.aliases || []).forEach(function(l) {
        var k = normalizeLabel(l);
        if (table[k] && table[k] !== item.equipmentId) ambiguous[(scope === 'FUNCTIONAL' ? '' : gymId + ':') + k] = true;
        table[k] = item.equipmentId;
      });
    }
    (catalog.functionalEquipment || []).forEach(function(f) { add(f, 'FUNCTIONAL', null); });
    var seen = {};
    Object.keys(catalog.gyms || {}).forEach(function(k) {
      var g = catalog.gyms[k], gymId = g.gymId || k;
      if (seen[gymId]) return; seen[gymId] = true;
      (g.equipment || []).forEach(function(e) { add(e, 'GYM', gymId); });
      (g.unresolvedEquipment || []).forEach(function(u) { (unresolvedByLabel[gymId] = unresolvedByLabel[gymId] || {})[normalizeLabel(u.name)] = u.reason; });
    });
    return { byId: byId, byExerciseId: byExerciseId, gymAliases: gymAliases, funcAliases: funcAliases, unresolvedByLabel: unresolvedByLabel, ambiguous: ambiguous };
  }

  // T517: an implement is a LOAD_IMPLEMENT (carries the stack/plates) or an ATTACHMENT (handle, rope, strap: no load of its own).
  function _role(status, reason) { return status !== STATUS.UNRESOLVED ? 'LOAD_IMPLEMENT' : (reason === 'ATTACHMENT_NOT_LOAD_IMPLEMENT' ? 'ATTACHMENT' : 'UNKNOWN'); }

  // ref: { equipmentId?, exerciseId?, label?, gymId? } (a catalog entry works: equipmentId / exerciseId / equipment / gymId).
  function identify(index, ref) {
    ref = ref || {};
    var label = ref.label !== undefined ? ref.label : ref.equipment, gymId = ref.gymId || null;
    function ok(id, status) {
      var it = index.byId[id];
      return { status: status, equipmentId: id, canonicalName: it.name, equipmentType: it.equipmentType, scope: it.scope, gymId: it.gymId, reason: null, implementRole: 'LOAD_IMPLEMENT' };
    }
    function bad(reason) {
      return { status: STATUS.UNRESOLVED, equipmentId: null, canonicalName: null, equipmentType: null, scope: null, gymId: gymId, reason: reason, implementRole: _role(STATUS.UNRESOLVED, reason) };
    }
    if (ref.equipmentId) {
      if (index.byId[ref.equipmentId]) return ok(ref.equipmentId, STATUS.EXPLICIT_ID);
      return bad(REASONS.UNKNOWN_EQUIPMENT_ID);
    }
    // exact exerciseId -> explicit machine mapping (one machine per catalog entry; never by brand/family label)
    if (ref.exerciseId && index.byExerciseId[ref.exerciseId] && !index.ambiguous['exercise:' + ref.exerciseId]) return ok(index.byExerciseId[ref.exerciseId], STATUS.EXERCISE_MAPPING);
    var k = normalizeLabel(label);
    if (!k) return bad(REASONS.NO_LABEL);
    var gk = (gymId ? gymId + ':' : '') + k;
    if (index.ambiguous[gk] || index.ambiguous[k])
      return bad(REASONS.AMBIGUOUS_ALIAS);
    if (gymId && index.gymAliases[gymId] && index.gymAliases[gymId][k]) return ok(index.gymAliases[gymId][k], STATUS.ALIAS_MATCH);
    if (index.funcAliases[k]) return ok(index.funcAliases[k], STATUS.ALIAS_MATCH);
    var why = gymId && index.unresolvedByLabel[gymId] && index.unresolvedByLabel[gymId][k];
    return bad(why || REASONS.NO_CANONICAL_DEFINITION);
  }

  return { STATUS: STATUS, REASONS: REASONS, normalizeLabel: normalizeLabel, buildIndex: buildIndex, identify: identify };
});
