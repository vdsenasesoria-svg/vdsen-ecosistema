/* T758: VDSEN Autonomous Progression — Prescription & Execution Identity for Original and Authorized Substitutions.
 * Pure. No I/O, no Firestore, no DOM, no clocks.
 * Decouples the plan prescription slot (Prescription Identity) from the specific exercise executed (Execution Identity).
 * Ensures original exercises and authorized substitutions maintain separate, stable, non-transferable progression histories.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.VDSEN_VARIANT_IDENTITY = api;
    root.progressionVariantIdentity = api;
  }
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

  function findPrescribedExercise(plan, prescriptionExerciseId) {
    if (!plan || !prescriptionExerciseId) return null;
    var found = null;
    (Array.isArray(plan.days) ? plan.days : []).forEach(function(day) {
      (Array.isArray(day.exercises) ? day.exercises : []).forEach(function(ex) {
        if (!found && ex && ex.prescriptionExerciseId === prescriptionExerciseId) {
          found = { exercise: ex, dayIndex: day.dayIndex };
        }
      });
    });
    return found;
  }

  function matchAlternative(alt, candidateTokenOrId) {
    if (!alt || !candidateTokenOrId) return false;
    var candNorm = normalizeToken(String(candidateTokenOrId));
    if (typeof alt === 'object' && alt !== null) {
      if (alt.exerciseId && (String(alt.exerciseId) === String(candidateTokenOrId) || normalizeToken(String(alt.exerciseId)) === candNorm)) return true;
      var altName = alt.exerciseName || alt.nombre || alt.name || '';
      if (altName && normalizeToken(altName) === candNorm) return true;
      return false;
    }
    if (typeof alt === 'string') {
      return normalizeToken(alt) === candNorm;
    }
    return false;
  }

  function validateExecutionAuthorization(plan, prescriptionExerciseId, executionExerciseId) {
    if (!plan || typeof plan !== 'object') {
      return { ok: false, reason: 'PLAN_MISSING', isAuthorized: false };
    }
    if (!prescriptionExerciseId || typeof prescriptionExerciseId !== 'string') {
      return { ok: false, reason: 'PID_MISSING', isAuthorized: false };
    }
    var slot = findPrescribedExercise(plan, prescriptionExerciseId);
    if (!slot || !slot.exercise) {
      return { ok: false, reason: 'PID_NOT_IN_PLAN', isAuthorized: false };
    }
    var ex = slot.exercise;
    var targetId = executionExerciseId || prescriptionExerciseId;
    var parsed = parseExecutionId(targetId);

    if (parsed.prescriptionExerciseId !== prescriptionExerciseId) {
      return { ok: false, reason: 'SLOT_PID_MISMATCH', isAuthorized: false };
    }

    if (!parsed.isVariant) {
      return { ok: true, isVariant: false, isAuthorized: true, exercise: ex };
    }

    if (parsed.isAuthorized === false) {
      return { ok: false, reason: 'UNAUTHORIZED_ALTERNATIVE', isVariant: true, isAuthorized: false };
    }

    var alts = Array.isArray(ex.alternatives) ? ex.alternatives : [];
    if (!alts.length) {
      return { ok: false, reason: 'NO_ALTERNATIVES_CONFIGURED', isVariant: true, isAuthorized: false };
    }

    var matchedAlt = null;
    for (var i = 0; i < alts.length; i++) {
      if (matchAlternative(alts[i], parsed.variantToken)) {
        matchedAlt = alts[i];
        break;
      }
    }

    if (!matchedAlt) {
      return { ok: false, reason: 'UNAUTHORIZED_ALTERNATIVE', isVariant: true, isAuthorized: false };
    }

    return {
      ok: true,
      isVariant: true,
      isAuthorized: true,
      exercise: ex,
      matchedAlternative: matchedAlt
    };
  }

  return {
    normalizeToken: normalizeToken,
    isAuthorizedAlternative: isAuthorizedAlternative,
    deriveExecutionId: deriveExecutionId,
    parseExecutionId: parseExecutionId,
    entryMatchesTarget: entryMatchesTarget,
    findPrescribedExercise: findPrescribedExercise,
    matchAlternative: matchAlternative,
    validateExecutionAuthorization: validateExecutionAuthorization
  };
});
