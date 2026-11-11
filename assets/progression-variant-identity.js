/* T758: VDSEN Autonomous Progression — Prescription & Execution Identity for Original and Authorized Substitutions.
 * Pure. No I/O, no Firestore, no DOM, no clocks.
 * Decouples the plan prescription slot (Prescription Identity) from the specific exercise executed (Execution Identity).
 * Ensures original exercises and authorized substitutions maintain separate, stable, non-transferable progression histories.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_VARIANT_IDENTITY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function normalizeToken(str) {
    if (!str || typeof str !== 'string') return '';
    return str.toLowerCase().trim().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function isAuthorizedAlternative(variantName, alternatives, originalName) {
    if (!variantName || typeof variantName !== 'string') return false;
    var vNorm = normalizeToken(variantName);
    if (!vNorm) return false;
    if (originalName && vNorm === normalizeToken(originalName)) return true;
    if (!Array.isArray(alternatives) || !alternatives.length) return false;
    return alternatives.some(function(alt) {
      var altStr = typeof alt === 'string' ? alt : (alt && (alt.exerciseName || alt.nombre || alt.name || alt.exerciseId)) || '';
      return normalizeToken(altStr) === vNorm;
    });
  }

  function deriveExecutionId(prescriptionExerciseId, variantName, alternatives, originalName) {
    if (!prescriptionExerciseId) return null;
    if (!variantName || (originalName && normalizeToken(variantName) === normalizeToken(originalName))) {
      return String(prescriptionExerciseId);
    }
    var token = normalizeToken(variantName);
    if (!token) return String(prescriptionExerciseId);
    var authorized = isAuthorizedAlternative(variantName, alternatives, originalName);
    return String(prescriptionExerciseId) + (authorized ? ':var:' : ':unauth:') + token;
  }

  function parseExecutionId(id) {
    if (!id || typeof id !== 'string') {
      return { prescriptionExerciseId: null, isVariant: false, isAuthorized: false, variantToken: null };
    }
    if (id.indexOf(':var:') !== -1) {
      var pVar = id.split(':var:');
      return { prescriptionExerciseId: pVar[0], isVariant: true, isAuthorized: true, variantToken: pVar[1] };
    }
    if (id.indexOf(':unauth:') !== -1) {
      var pUnauth = id.split(':unauth:');
      return { prescriptionExerciseId: pUnauth[0], isVariant: true, isAuthorized: false, variantToken: pUnauth[1] };
    }
    return { prescriptionExerciseId: id, isVariant: false, isAuthorized: true, variantToken: null };
  }

  function entryMatchesTarget(entry, targetId) {
    if (!entry || !targetId) return false;
    var parsed = parseExecutionId(targetId);
    if (!parsed.prescriptionExerciseId) return false;

    // Explicit executionExerciseId match always takes precedence
    if (entry.executionExerciseId && entry.executionExerciseId === targetId) return true;

    if (!parsed.isVariant) {
      // Matching original exercise
      if (entry.executionExerciseId && entry.executionExerciseId !== targetId) return false;
      if (entry.substitutedFrom) return false; // Substituted entry cannot match original
      return entry.prescriptionExerciseId === parsed.prescriptionExerciseId;
    }

    // Matching a variant: targetId is pid:var:token or pid:unauth:token
    var entrySubPid = entry.substitutedFrom && (entry.substitutedFrom.prescriptionExerciseId || entry.substitutedFrom.pid);
    if (entrySubPid !== parsed.prescriptionExerciseId && entry.prescriptionExerciseId !== parsed.prescriptionExerciseId) {
      return false;
    }

    var entryName = entry.exerciseNameSnapshot || entry.nombre || (entry.substitutedFrom && entry.substitutedFrom.exerciseName);
    return normalizeToken(entryName) === parsed.variantToken;
  }

  return {
    normalizeToken: normalizeToken,
    isAuthorizedAlternative: isAuthorizedAlternative,
    deriveExecutionId: deriveExecutionId,
    parseExecutionId: parseExecutionId,
    entryMatchesTarget: entryMatchesTarget
  };
});
