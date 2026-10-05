/* VDSEN client export — COLLECTION. Reads only Firestore documents the signed-in Coach can already read under firestore.rules.
 *
 * `io` is an injected, read-only adapter (the Coach app wires it to the Firestore web SDK; tests wire it to fixtures):
 *   io.getDoc(collection, id)            -> { id, data } | null
 *   io.query(collection, [[f,'==',v]..]) -> [{ id, data }]
 *   io.listSub(collection, id, sub)      -> [{ id, data }]
 * No Admin credentials, no endpoint, no write. Clients are addressed by clientId; plans/backups by (coachId == uid AND clientId == id).
 * Sources (authoritative, from firestore.rules + app writers): clients/{id}, plans (coachId+clientId), plans_backup (coachId+clientId),
 * logs/{id}, logs/{id}/mesos/{planId}, fichas_onboarding/{id}, fichas_renovacion/{id}, fichas_publicas (coachId + clientUid).
 * Permission errors are FATAL (an incomplete export must never look complete); other read errors become warnings.
 */
(function(root, factory) {
  var api = factory(
    typeof require === 'function' && typeof module === 'object' ? require('./util.js') : root.VDSEN_CE_UTIL,
    typeof require === 'function' && typeof module === 'object' ? require('./security.js') : root.VDSEN_CE_SECURITY);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_COLLECT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(U, S) {
  'use strict';

  function warn(list, code, section, detail, extra) {
    var w = { code: code, section: section, detail: detail || null };
    if (extra) Object.keys(extra).forEach(function(k) { w[k] = extra[k]; });
    list.push(w);
  }

  async function collect(io, opts) {
    var clientId = opts && opts.clientId, coachUid = opts && opts.coachUid;
    S.validateIds(clientId, coachUid);
    var warnings = [], sections = {};

    // 1) OWNERSHIP GATE — before anything else is read.
    var clientDoc;
    try { clientDoc = await io.getDoc('clients', clientId); }
    catch (e) { throw S.isPermissionError(e) ? S.ExportError('PERMISSION_DENIED', 'clients') : e; }
    S.authorizeClient(clientDoc, clientId, coachUid);

    async function guarded(section, fn, fallback) {
      try { var r = await fn(); sections[section] = { status: 'ok' }; return r; }
      catch (e) {
        if (S.isPermissionError(e)) throw S.ExportError('PERMISSION_DENIED', section);
        sections[section] = { status: 'failed' };
        warn(warnings, 'SECTION_READ_FAILED', section, String(e && e.code || e && e.message || 'error').slice(0, 120));
        return fallback;
      }
    }
    // Defensive re-check of every record, even when the query already filtered (adapters can be wrong; rules only guard per-doc reads).
    function ownedOnly(docs, section, allowMissingClientId) {
      var kept = [];
      (docs || []).forEach(function(d) {
        var verdict = S.recordOwnership(d && d.data, clientId, coachUid, { allowMissingClientId: !!allowMissingClientId });
        if (verdict === 'OK') kept.push(d);
        else if (verdict === 'LEGACY_NO_CLIENT_ID') { kept.push(d); warn(warnings, 'LEGACY_RECORD_WITHOUT_CLIENT_ID', section, d.id, { id: d.id }); }
        else warn(warnings, 'FOREIGN_RECORD_DROPPED', section, verdict);   // never echo the foreign record's id
      });
      return kept;
    }

    var activePlanId = typeof clientDoc.data.activePlanId === 'string' && clientDoc.data.activePlanId ? clientDoc.data.activePlanId : null;

    var logsDoc = await guarded('logs', function() { return io.getDoc('logs', clientId); }, null);
    if (logsDoc && logsDoc.id !== clientId) { warn(warnings, 'FOREIGN_RECORD_DROPPED', 'logs', 'id-mismatch'); logsDoc = null; }
    var mesos = await guarded('logs_mesos', function() { return io.listSub('logs', clientId, 'mesos'); }, []);
    mesos = (mesos || []).filter(function(d) {
      var okId = d && typeof d.id === 'string' && d.id && U.isObj(d.data);
      if (!okId) warn(warnings, 'MALFORMED_RECORD_SKIPPED', 'logs_mesos', d && d.id || null);
      return okId;
    });

    var plans = ownedOnly(await guarded('plans', function() {
      return io.query('plans', [['coachId', '==', coachUid], ['clientId', '==', clientId]]);
    }, []), 'plans', false);
    // Plans reached through THIS client's own subtree (active plan, mesocycle snapshots) even if the query missed them.
    var have = {}; plans.forEach(function(p) { have[p.id] = true; });
    var extraIds = [];
    if (activePlanId) extraIds.push(activePlanId);
    mesos.forEach(function(m) { extraIds.push(m.id); });
    if (logsDoc && U.isObj(logsDoc.data) && typeof logsDoc.data.planId === 'string' && logsDoc.data.planId) extraIds.push(logsDoc.data.planId);
    var seenExtra = {};
    for (var i = 0; i < extraIds.length; i++) {
      var pid = extraIds[i];
      if (have[pid] || seenExtra[pid]) continue;
      seenExtra[pid] = true;
      var pd = await guarded('plans_by_reference', function() { return io.getDoc('plans', pid); }, null);
      if (!pd) { warn(warnings, 'REFERENCED_PLAN_NOT_FOUND', 'plans', pid, { id: pid }); continue; }
      var kept = ownedOnly([pd], 'plans', true);
      if (kept.length) { plans.push(kept[0]); have[pid] = true; }
    }

    var backups = ownedOnly(await guarded('plans_backup', function() {
      return io.query('plans_backup', [['coachId', '==', coachUid], ['clientId', '==', clientId]]);
    }, []), 'plans_backup', false);

    var ficha = await guarded('fichas_onboarding', function() { return io.getDoc('fichas_onboarding', clientId); }, null);
    if (ficha && ficha.id !== clientId) { warn(warnings, 'FOREIGN_RECORD_DROPPED', 'fichas_onboarding', 'id-mismatch'); ficha = null; }
    var renov = await guarded('fichas_renovacion', function() { return io.getDoc('fichas_renovacion', clientId); }, null);
    if (renov && renov.id !== clientId) { warn(warnings, 'FOREIGN_RECORD_DROPPED', 'fichas_renovacion', 'id-mismatch'); renov = null; }

    var publicForms = await guarded('fichas_publicas', function() {
      return io.query('fichas_publicas', [['coachId', '==', coachUid], ['clientUid', '==', clientId]]);
    }, []);
    publicForms = (publicForms || []).filter(function(d) {
      var ok = d && U.isObj(d.data) && d.data.coachId === coachUid && d.data.clientUid === clientId;
      if (!ok) warn(warnings, 'FOREIGN_RECORD_DROPPED', 'fichas_publicas', 'owner-mismatch');
      return ok;
    });

    return {
      client_id: clientId, coach_id: coachUid, active_plan_id: activePlanId,
      client: clientDoc, logs: logsDoc, mesos: mesos, plans: plans, plans_backup: backups,
      ficha_onboarding: ficha, ficha_renovacion: renov, fichas_publicas: publicForms,
      sections: sections, warnings: warnings
    };
  }

  return { collect: collect };
});
