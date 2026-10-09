/* VDSEN client export — NORMALIZATION. Pure: raw collected documents -> structured, sanitized, deterministically ordered model.
 * Raw source records are preserved verbatim (key-sorted, secrets removed); nothing here computes analytics (see derive.js).
 *
 * Real data model (CLAUDE.md + client app writers):
 *   logs entries keys:  log_{W}_{D}_{E}_s{S}  done_{W}_{D}  postsession_{W}_{D}  progrec_{W}_{D}  ci_sem_{W}
 *                       exnotepid_{W}_{PID}  exnote_{W}_{D}_{E}  exnote_{D}_{E}(legacy)  exsub_{W}_{D}_{E}  exskip_{W}_{D}_{E}
 *                       exseries_{W}_{D}_{E}_s{S}  exexpress_{W}_{D}_{E}  nutrilog_{YYYY-MM-DD}
 *   W = 1-based week, D = 0-based position in plan.days, E = 0-based position in day.exercises.
 */
(function(root, factory) {
  var api = factory(
    typeof require === 'function' && typeof module === 'object' ? require('./util.js') : root.VDSEN_CE_UTIL,
    typeof require === 'function' && typeof module === 'object' ? require('./security.js') : root.VDSEN_CE_SECURITY);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_NORMALIZE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(U, S) {
  'use strict';

  var RE = {
    set: /^log_(\d+)_(\d+)_(\d+)_s(\d+)$/, done: /^done_(\d+)_(\d+)$/, post: /^postsession_(\d+)_(\d+)$/, prog: /^progrec_(\d+)_(\d+)$/,
    ci: /^ci_sem_(\d+)$/, notePid: /^exnotepid_(\d+)_(.+)$/, noteW: /^exnote_(\d+)_(\d+)_(\d+)$/, noteLegacy: /^exnote_(\d+)_(\d+)$/,
    sub: /^exsub_(\d+)_(\d+)_(\d+)$/, skip: /^exskip_(\d+)_(\d+)_(\d+)$/, series: /^exseries_(\d+)_(\d+)_(\d+)_s(\d+)$/,
    express: /^exexpress_(\d+)_(\d+)_(\d+)$/, nutri: /^nutrilog_(\d{4}-\d{2}-\d{2})$/
  };
  var NOTE_KEY_RE = /^(nota|notas|note|notes|observacion|observaciones|comentario|comentarios|comment|comments|feedback|cue|cues|indicaciones)$/i;
  var BIOMECH_EXACT = ['asimetrias', 'dolor_actual', 'ejercicios_evitar', 'ejercicios_favoritos', 'lesiones', 'limitaciones', 'movilidad',
    'patrones_debiles', 'patrones_fuertes', 'postura', 'biotipo', 'biomecanica'];
  var BIOMECH_RE = /(lesion|limitac|restric|contraindic|biomec|injur|joint|articul|dolor|evitar)/i;
  var BIOMECH_NOT_RE = /(aliment|suplement|comida|dieta)/i;
  var BODY_FICHA_KEYS = ['peso_kg', 'talla_cm', 'porcentaje_grasa', 'edad', 'sexo', 'biotipo'];
  var MOVED_CLIENT_KEYS = { nutritionPlan: 'nutricion.json', nutritionRaw: 'nutricion.json', supplementPlan: 'suplementos.json', supplementsRaw: 'suplementos.json',
    pharmacoPlan: 'additional_client_data.pharmacology', inbodyResults: 'metricas_corporales.json', coachNote: 'notas.json', coachNoteUpdatedAt: 'notas.json',
    clientMessage: 'notas.json', clientMessageUpdatedAt: 'notas.json' };

  function emptyish(v) {
    if (v === null || v === undefined || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (U.isObj(v)) return Object.keys(v).length === 0;
    return false;
  }
  function pick(o, keys) { for (var i = 0; i < keys.length; i++) if (o && o[keys[i]] !== undefined && o[keys[i]] !== null && o[keys[i]] !== '') return o[keys[i]]; return null; }
  function ints(m, from) { var a = []; for (var i = from || 1; i < m.length; i++) a.push(Number(m[i])); return a; }
  function normK(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // First (top-most) occurrences of keys satisfying pred, with their path; matched subtrees are not descended into.
  function findKeys(obj, pred, base) {
    var out = [];
    (function walk(v, path) {
      if (!U.isObj(v)) { if (Array.isArray(v)) v.forEach(function(x, i) { walk(x, path + '[' + i + ']'); }); return; }
      Object.keys(v).sort().forEach(function(k) {
        var p = path ? path + '.' + k : k;
        if (pred(k, v[k])) out.push({ path: p, key: k, value: v[k] });
        else walk(v[k], p);
      });
    })(obj, base || '');
    return out;
  }

  function parseEntries(entries) {
    var b = { sets: [], done: {}, post: {}, prog: {}, ci: {}, notePid: [], noteW: [], noteLegacy: [], sub: {}, skip: {}, series: [], express: {}, nutri: [], unclassified: {} };
    Object.keys(entries || {}).sort().forEach(function(k) {
      var v = entries[k], m;
      if ((m = RE.set.exec(k))) b.sets.push({ key: k, w: +m[1], d: +m[2], e: +m[3], s: +m[4], v: v });
      else if ((m = RE.done.exec(k))) b.done[m[1] + '_' + m[2]] = { key: k, w: +m[1], d: +m[2], v: v };
      else if ((m = RE.post.exec(k))) b.post[m[1] + '_' + m[2]] = { key: k, w: +m[1], d: +m[2], v: v };
      else if ((m = RE.prog.exec(k))) b.prog[m[1] + '_' + m[2]] = { key: k, w: +m[1], d: +m[2], v: v };
      else if ((m = RE.ci.exec(k))) b.ci[m[1]] = { key: k, w: +m[1], v: v };
      else if ((m = RE.notePid.exec(k))) b.notePid.push({ key: k, w: +m[1], pid: m[2], v: v });
      else if ((m = RE.noteW.exec(k))) b.noteW.push({ key: k, w: +m[1], d: +m[2], e: +m[3], v: v });
      else if ((m = RE.noteLegacy.exec(k))) b.noteLegacy.push({ key: k, d: +m[1], e: +m[2], v: v });
      else if ((m = RE.sub.exec(k))) b.sub[m[1] + '_' + m[2] + '_' + m[3]] = { key: k, v: v };
      else if ((m = RE.skip.exec(k))) b.skip[m[1] + '_' + m[2] + '_' + m[3]] = { key: k, v: v };
      else if ((m = RE.series.exec(k))) b.series.push({ key: k, w: +m[1], d: +m[2], e: +m[3], s: +m[4], v: v });
      else if ((m = RE.express.exec(k))) b.express[m[1] + '_' + m[2] + '_' + m[3]] = { key: k, v: v };
      else if ((m = RE.nutri.exec(k))) b.nutri.push({ key: k, date: m[1], v: v });
      else b.unclassified[k] = v;
    });
    return b;
  }

  function planMeta(planDoc, planId) {
    var p = planDoc && planDoc.data || {};
    return {
      plan_id: planId || null,
      name: pick(p, ['name', 'nombre', 'title', 'label']),
      objective: pick(p, ['objective', 'objetivo', 'goal']),
      status: p.status === undefined ? null : p.status,
      weeks: U.num(p.weeks), days_per_week: U.num(p.daysPerWeek) !== null ? U.num(p.daysPerWeek) : (Array.isArray(p.days) ? p.days.length : null),
      created_at: U.toIso(p.createdAt), updated_at: U.toIso(p.updatedAt), generated_by: p.generatedBy === undefined ? null : p.generatedBy,
      days: Array.isArray(p.days) ? p.days : []
    };
  }
  function exerciseName(ex) { return ex ? pick(ex, ['exerciseName', 'nombre', 'name']) : null; }

  function setRecord(s, ctx, planDay, sub, express) {
    var v = U.isObj(s.v) ? s.v : { value: s.v };
    var ex = planDay && Array.isArray(planDay.exercises) ? planDay.exercises[s.e] : null;
    var performed = sub && U.isObj(sub.v) ? pick(sub.v, ['nombre', 'name', 'exerciseName']) : null;
    return {
      exercise_log_id: ctx.mesocycleKey + ':' + s.key, entry_key: s.key, plan_id: ctx.planId, mesocycle_id: ctx.planId, session_id: ctx.sessionId(s.w, s.d),
      week: s.w, day_index: s.d, exercise_index: s.e, set_index: s.s,
      prescription_exercise_id: ex && ex.prescriptionExerciseId !== undefined ? ex.prescriptionExerciseId : null,
      planned_exercise_name: exerciseName(ex), performed_exercise_name: performed || exerciseName(ex),
      substituted: !!performed && performed !== exerciseName(ex),
      load: U.num(v.carga), reps: U.num(v.reps), unit: v.unit === undefined ? null : v.unit, done: v.done === true,
      rir_prescribed: U.num(v.rir), rir_observed: U.num(v.rir_real), ics: U.num(v.ics), pump: U.num(v.pump),
      timestamp: U.toIso(v.ts), synthetic_express: v.express === true && v.expressFinal !== true, express_final: v.expressFinal === true,
      auto_filled: v.autoFilled === true, raw: s.v
    };
  }

  // Normalizes one mesocycle: plan + the entries chosen for it -> mesocycle record, sessions, exercise logs, recovery, notes, nutrition logs.
  function normalizeMesocycle(m, order) {
    var meta = m.meta, b = parseEntries(m.entries), days = meta.days;
    var key = m.planId || 'unbound';
    var ctx = { planId: m.planId, mesocycleKey: key, sessionId: function(w, d) { return key + ':w' + w + ':d' + d; } };
    var keys = {}; // sessions present in the evidence
    function touch(w, d) { keys[w + '_' + d] = { w: w, d: d }; }
    b.sets.forEach(function(s) { touch(s.w, s.d); });
    Object.keys(b.done).forEach(function(k) { touch(b.done[k].w, b.done[k].d); });
    Object.keys(b.post).forEach(function(k) { touch(b.post[k].w, b.post[k].d); });
    Object.keys(b.prog).forEach(function(k) { touch(b.prog[k].w, b.prog[k].d); });
    b.noteW.forEach(function(n) { touch(n.w, n.d); });
    Object.keys(b.sub).forEach(function(k) { var p = k.split('_'); touch(+p[0], +p[1]); });
    Object.keys(b.skip).forEach(function(k) { var p = k.split('_'); touch(+p[0], +p[1]); });
    Object.keys(b.express).forEach(function(k) { var p = k.split('_'); touch(+p[0], +p[1]); });

    var exerciseLogs = [], sessions = [], recovery = [], notes = [];
    var sessionList = U.sortBy(Object.keys(keys).map(function(k) { return keys[k]; }), function(x) { return [x.w, x.d]; });
    sessionList.forEach(function(sk) {
      var w = sk.w, d = sk.d, id = ctx.sessionId(w, d), wd = w + '_' + d, day = days[d] || null;
      var sets = b.sets.filter(function(s) { return s.w === w && s.d === d; });
      var recs = sets.map(function(s) {
        var ek = w + '_' + d + '_' + s.e;
        return setRecord(s, ctx, day, b.sub[ek], b.express[ek]);
      });
      recs = U.sortBy(recs, function(r) { return [r.exercise_index, r.set_index, r.entry_key]; });
      exerciseLogs = exerciseLogs.concat(recs);
      var doneMarker = b.done[wd] ? b.done[wd].v : undefined;
      var autoClosed = U.isObj(doneMarker) && doneMarker.autoClosed === true && doneMarker.skipped === true;
      var status = autoClosed ? 'AUTO_CLOSED_NO_DATA' : (doneMarker === true || (U.isObj(doneMarker) && !autoClosed) ? 'COMPLETED'
        : (recs.some(function(r) { return r.done; }) ? 'PARTIAL' : 'NO_SETS_LOGGED'));
      var exIdx = {};
      recs.forEach(function(r) { exIdx[r.exercise_index] = true; });
      Object.keys(b.sub).forEach(function(k) { var p = k.split('_'); if (+p[0] === w && +p[1] === d) exIdx[+p[2]] = true; });
      Object.keys(b.skip).forEach(function(k) { var p = k.split('_'); if (+p[0] === w && +p[1] === d) exIdx[+p[2]] = true; });
      var performed = Object.keys(exIdx).map(Number).sort(function(a, c) { return a - c; }).map(function(e) {
        var ex = day && Array.isArray(day.exercises) ? day.exercises[e] : null, ek = w + '_' + d + '_' + e;
        var mine = recs.filter(function(r) { return r.exercise_index === e; });
        var sub = b.sub[ek] ? b.sub[ek].v : null;
        return {
          exercise_index: e, prescription_exercise_id: ex && ex.prescriptionExerciseId !== undefined ? ex.prescriptionExerciseId : null,
          planned_exercise_name: exerciseName(ex), performed_exercise_name: mine.length ? mine[0].performed_exercise_name : (sub && U.isObj(sub) ? (pick(sub, ['nombre', 'name', 'exerciseName']) || exerciseName(ex)) : exerciseName(ex)),
          substitution: sub, skipped: b.skip[ek] ? b.skip[ek].v : null, express: b.express[ek] ? b.express[ek].v : null,
          set_entry_keys: mine.map(function(r) { return r.entry_key; })
        };
      });
      var plannedEx = day && Array.isArray(day.exercises) ? day.exercises.map(function(ex, e) {
        return { exercise_index: e, prescription_exercise_id: ex && ex.prescriptionExerciseId !== undefined ? ex.prescriptionExerciseId : null, exercise_name: exerciseName(ex),
          planned_sets: Array.isArray(ex && ex.sets) ? ex.sets.length : 0 };
      }) : [];
      var times = recs.map(function(r) { return U.toMs(r.timestamp); }).filter(function(x) { return x !== null; });
      var post = b.post[wd] ? b.post[wd].v : null, prog = b.prog[wd] ? b.prog[wd].v : null;
      sessions.push({
        session_id: id, plan_id: m.planId, mesocycle_id: m.planId, mesocycle_name: meta.name, week: w, day_index: d,
        day_label: day ? (pick(day, ['label', 'name', 'nombre'])) : null,
        first_logged_at: times.length ? new Date(Math.min.apply(null, times)).toISOString() : null,
        last_logged_at: times.length ? new Date(Math.max.apply(null, times)).toISOString() : null,
        completion: { status: status, done_marker: doneMarker === undefined ? null : doneMarker },
        planned_exercises: plannedEx, performed_exercises: performed, exercise_log_ids: recs.map(function(r) { return r.exercise_log_id; }),
        post_session: post, progression: prog
      });
      if (b.post[wd]) {
        var pv = b.post[wd].v;
        recovery.push({ recovery_id: key + ':' + b.post[wd].key, type: 'post_session', source: 'logs.entries.' + b.post[wd].key, timestamp: U.toIso(U.isObj(pv) ? pv.ts : null),
          plan_id: m.planId, mesocycle_id: m.planId, session_id: id, week: w, day_index: d, values: pv });
        if (U.isObj(pv)) Object.keys(pv).sort().forEach(function(f) {
          if (NOTE_KEY_RE.test(f) && typeof pv[f] === 'string' && pv[f].trim()) notes.push({ type: 'session_feedback', source: 'logs.entries.' + b.post[wd].key + '.' + f,
            timestamp: U.toIso(pv.ts), entity_id: id, plan_id: m.planId, mesocycle_id: m.planId, session_id: id, week: w, day_index: d, exercise_index: null, text: pv[f], raw_key: b.post[wd].key });
        });
      }
    });

    Object.keys(b.ci).forEach(function(k) {
      var c = b.ci[k], cv = c.v;
      recovery.push({ recovery_id: key + ':' + c.key, type: 'weekly_checkin', source: 'logs.entries.' + c.key, timestamp: U.toIso(U.isObj(cv) ? (cv.fecha || cv.ts || cv.updatedAt) : null),
        plan_id: m.planId, mesocycle_id: m.planId, session_id: null, week: c.w, day_index: null, values: cv });
      if (U.isObj(cv)) Object.keys(cv).sort().forEach(function(f) {
        if (NOTE_KEY_RE.test(f) && typeof cv[f] === 'string' && cv[f].trim()) notes.push({ type: 'checkin_note', source: 'logs.entries.' + c.key + '.' + f,
          timestamp: U.toIso(cv.fecha || cv.ts || cv.updatedAt), entity_id: key + ':w' + c.w, plan_id: m.planId, mesocycle_id: m.planId, session_id: null, week: c.w, day_index: null, exercise_index: null, text: cv[f], raw_key: c.key });
      });
    });

    function noteOf(type, n, w, d, e, text, ts, pid) {
      return { type: type, source: 'logs.entries.' + n.key, timestamp: U.toIso(ts), entity_id: pid || (w !== null && d !== null ? ctx.sessionId(w, d) + ':e' + e : null),
        plan_id: m.planId, mesocycle_id: m.planId, session_id: w !== null && d !== null ? ctx.sessionId(w, d) : null, week: w, day_index: d, exercise_index: e,
        prescription_exercise_id: pid || null, text: text, raw_key: n.key };
    }
    b.notePid.forEach(function(n) {
      var v = n.v, txt = U.isObj(v) ? v.text : (typeof v === 'string' ? v : null);
      if (typeof txt !== 'string' || !txt.trim()) return;
      var d = U.isObj(v) && U.num(v.day) !== null ? U.num(v.day) : null, e = U.isObj(v) && U.num(v.exerciseIndex) !== null ? U.num(v.exerciseIndex) : null;
      var rec = noteOf('client_exercise_note', n, n.w, d, e, txt, U.isObj(v) ? v.updatedAt : null, U.isObj(v) && v.prescriptionExerciseId ? v.prescriptionExerciseId : n.pid);
      rec.exercise_name_snapshot = U.isObj(v) ? (v.exerciseNameSnapshot === undefined ? null : v.exerciseNameSnapshot) : null;
      notes.push(rec);
    });
    b.noteW.forEach(function(n) { if (typeof n.v === 'string' && n.v.trim()) notes.push(noteOf('client_exercise_note_mirror', n, n.w, n.d, n.e, n.v, null, null)); });
    b.noteLegacy.forEach(function(n) { if (typeof n.v === 'string' && n.v.trim()) { var r = noteOf('client_exercise_note_legacy', n, null, n.d, n.e, n.v, null, null); r.entity_id = key + ':d' + n.d + ':e' + n.e; notes.push(r); } });

    // Plan-authored notes (any note-like string field inside the prescription), with their path.
    var planNotes = findKeys(m.planData || {}, function(k, v) { return NOTE_KEY_RE.test(k) && typeof v === 'string' && v.trim() !== ''; });
    planNotes.forEach(function(n) {
      notes.push({ type: 'plan_note', source: 'plans.' + (m.planId || '?') + '.' + n.path, timestamp: null, entity_id: m.planId, plan_id: m.planId, mesocycle_id: m.planId,
        session_id: null, week: null, day_index: null, exercise_index: null, text: n.value, raw_key: n.path });
    });

    var nutriLogs = U.sortBy(b.nutri, function(x) { return [x.date]; }).map(function(x) { return { date: x.date, plan_id: m.planId, entry_key: x.key, value: x.v }; });
    var unclassified = Object.keys(b.unclassified).length ? b.unclassified : null;

    var allTimes = exerciseLogs.map(function(r) { return U.toMs(r.timestamp); }).filter(function(x) { return x !== null; });
    var weeksWithData = {}; sessions.forEach(function(s) { weeksWithData[s.week] = true; });
    var mesocycle = {
      mesocycle_id: m.planId, plan_id: m.planId, order: order, name: meta.name, objective: meta.objective, status: meta.status, is_active: !!m.isActive,
      weeks: meta.weeks, days_per_week: meta.days_per_week, created_at: meta.created_at, updated_at: meta.updated_at, generated_by: meta.generated_by,
      current_week: m.currentWeek, entries_source: m.entriesSource, alternate_snapshot_present: !!m.alternateSnapshot, plan_available: !!m.planData,
      first_logged_at: allTimes.length ? new Date(Math.min.apply(null, allTimes)).toISOString() : null,
      last_logged_at: allTimes.length ? new Date(Math.max.apply(null, allTimes)).toISOString() : null,
      week_structure: days.map(function(dy, i) { return { day_index: i, day_label: pick(dy, ['label', 'name', 'nombre']), exercise_count: Array.isArray(dy && dy.exercises) ? dy.exercises.length : 0 }; }),
      session_ids: sessions.map(function(s) { return s.session_id; }), weeks_with_data: Object.keys(weeksWithData).map(Number).sort(function(a, c) { return a - c; })
    };
    return { mesocycle: mesocycle, sessions: sessions, exercise_logs: exerciseLogs, recovery: recovery, notes: notes, nutrition_logs: nutriLogs, unclassified: unclassified };
  }

  function dedupeBy(list, keyFn) { var seen = {}; return list.filter(function(x) { var k = keyFn(x); if (seen[k]) return false; seen[k] = true; return true; }); }

  function normalize(raw, opts) {
    var ctx = { redactions: [] }, warnings = raw.warnings.slice();
    var sd = function(v) { return S.sanitize(v, ctx); };
    var clientData = sd(raw.client.data), clientId = raw.client_id, coachId = raw.coach_id;
    var activePlanId = raw.active_plan_id;

    // ---- logs & plans (sanitized once; everything below reads these copies)
    var rootLogs = raw.logs ? sd(raw.logs.data) : null;
    var plansById = {};
    raw.plans.forEach(function(p) { plansById[p.id] = { id: p.id, data: sd(p.data) }; });
    var mesoDocs = {}; raw.mesos.forEach(function(d) { mesoDocs[d.id] = sd(d.data); });
    var rootPlanId = rootLogs && typeof rootLogs.planId === 'string' && rootLogs.planId ? rootLogs.planId : null;
    var rootEntries = rootLogs && U.isObj(rootLogs.entries) ? rootLogs.entries : {};

    // ---- one source of entries per mesocycle
    var ids = {}; Object.keys(plansById).forEach(function(i) { ids[i] = 1; }); Object.keys(mesoDocs).forEach(function(i) { ids[i] = 1; }); if (rootPlanId) ids[rootPlanId] = 1;
    var mesoInputs = Object.keys(ids).sort().map(function(pid) {
      var meso = mesoDocs[pid], isRoot = rootPlanId === pid;
      var cand = [];
      if (isRoot) cand.push({ src: 'logs_root', entries: rootEntries, updatedAt: U.toMs(rootLogs.updatedAt), currentWeek: U.num(rootLogs.currentWeek), prefer: 1 });
      if (meso) cand.push({ src: 'mesos_snapshot', entries: U.isObj(meso.entries) ? meso.entries : {}, updatedAt: U.toMs(meso.updatedAt), currentWeek: U.num(meso.currentWeek), prefer: 0 });
      var chosen = cand.slice().sort(function(a, c) { return U.cmp(c.updatedAt === null ? -1 : c.updatedAt, a.updatedAt === null ? -1 : a.updatedAt) || (c.prefer - a.prefer); })[0] || null;
      var pdoc = plansById[pid] || null;
      return { planId: pid, planData: pdoc ? pdoc.data : null, meta: planMeta(pdoc, pid), entries: chosen ? chosen.entries : {}, entriesSource: chosen ? chosen.src : 'none',
        currentWeek: chosen ? chosen.currentWeek : null, alternateSnapshot: cand.length > 1, isActive: pid === activePlanId };
    });
    if (rootLogs && !rootPlanId && Object.keys(rootEntries).length) {
      warnings.push({ code: 'LEGACY_LOG_UNBOUND', section: 'logs', detail: 'root log has entries but no planId; kept as an unbound mesocycle, not attributed to any plan', id: null });
      mesoInputs.push({ planId: null, planData: null, meta: planMeta(null, null), entries: rootEntries, entriesSource: 'logs_root_unbound', currentWeek: U.num(rootLogs.currentWeek), alternateSnapshot: false, isActive: false });
    }
    // Chronological mesocycle order: plan createdAt, else first evidence timestamp, else id.
    var firstTs = function(mi) {
      var best = null; Object.keys(mi.entries || {}).forEach(function(k) { var v = mi.entries[k]; var t = U.isObj(v) ? U.toMs(v.ts || v.updatedAt) : null; if (t !== null && (best === null || t < best)) best = t; });
      return best;
    };
    mesoInputs = U.sortBy(mesoInputs, function(mi) { var c = U.toMs(mi.meta.created_at); return [c !== null ? c : firstTs(mi), mi.planId || '~']; });

    var normalized = mesoInputs.map(function(mi, i) { return normalizeMesocycle(mi, i + 1); });
    var orderOf = {}; normalized.forEach(function(n) { orderOf[n.mesocycle.mesocycle_id === null ? '~' : n.mesocycle.mesocycle_id] = n.mesocycle.order; });
    var mesocycles = normalized.map(function(n) { return n.mesocycle; });
    var sessions = [].concat.apply([], normalized.map(function(n) { return n.sessions; }));
    sessions = U.sortBy(sessions, function(s) { return [orderOf[s.plan_id === null ? '~' : s.plan_id], s.week, s.day_index]; });
    var exerciseLogs = [].concat.apply([], normalized.map(function(n) { return n.exercise_logs; }));
    exerciseLogs = U.sortBy(exerciseLogs, function(r) { return [orderOf[r.plan_id === null ? '~' : r.plan_id], r.week, r.day_index, r.exercise_index, r.set_index, r.entry_key]; });
    var recovery = [].concat.apply([], normalized.map(function(n) { return n.recovery; }));
    recovery = U.sortBy(recovery, function(r) { return [U.toMs(r.timestamp), orderOf[r.plan_id === null ? '~' : r.plan_id], r.week, r.day_index === null ? -1 : r.day_index, r.type, r.recovery_id]; });
    var notes = [].concat.apply([], normalized.map(function(n) { return n.notes; }));

    // ---- client-document notes (Coach-visible)
    var cn = clientData.coachNote;
    if (typeof cn === 'string' && cn.trim()) notes.push({ type: 'coach_note', source: 'clients.coachNote', timestamp: U.toIso(clientData.coachNoteUpdatedAt), entity_id: clientId, plan_id: null, mesocycle_id: null, session_id: null, week: null, day_index: null, exercise_index: null, text: cn, raw_key: 'coachNote' });
    var cm = clientData.clientMessage;
    if (typeof cm === 'string' && cm.trim()) notes.push({ type: 'coach_message_to_client', source: 'clients.clientMessage', timestamp: U.toIso(clientData.clientMessageUpdatedAt), entity_id: clientId, plan_id: null, mesocycle_id: null, session_id: null, week: null, day_index: null, exercise_index: null, text: cm, raw_key: 'clientMessage' });
    Object.keys(clientData).sort().forEach(function(k) {
      if (k === 'coachNote' || k === 'clientMessage') return;
      if (NOTE_KEY_RE.test(k) && typeof clientData[k] === 'string' && clientData[k].trim()) notes.push({ type: 'client_record_note', source: 'clients.' + k, timestamp: null, entity_id: clientId, plan_id: null, mesocycle_id: null, session_id: null, week: null, day_index: null, exercise_index: null, text: clientData[k], raw_key: k });
    });
    notes = U.sortBy(notes, function(n) { return [U.toMs(n.timestamp), orderOf[n.plan_id === null || n.plan_id === undefined ? '~' : n.plan_id], n.week, n.day_index, n.source, n.raw_key]; })
      .map(function(n, i) { var o = { note_id: 'note-' + String(i + 1).padStart(5, '0') }; Object.keys(n).forEach(function(k) { o[k] = n[k]; }); return o; });

    // ---- fichas
    var ficha = {
      onboarding: raw.ficha_onboarding ? { id: raw.ficha_onboarding.id, document: sd(raw.ficha_onboarding.data) } : null,
      renewal: raw.ficha_renovacion ? { id: raw.ficha_renovacion.id, document: sd(raw.ficha_renovacion.data) } : null,
      public_forms: U.sortBy(raw.fichas_publicas.map(function(d) { return { id: d.id, document: sd(d.data) }; }), function(f) { return [f.id]; })
    };
    var fichaSources = [];
    if (ficha.onboarding) fichaSources.push({ src: 'fichas_onboarding', data: ficha.onboarding.document });
    if (ficha.renewal) fichaSources.push({ src: 'fichas_renovacion', data: ficha.renewal.document });
    ficha.public_forms.forEach(function(f) { fichaSources.push({ src: 'fichas_publicas.' + f.id, data: f.document }); });
    fichaSources.push({ src: 'clients', data: clientData });

    // ---- biomechanics: verbatim extraction of stored fields (no inference)
    var biomItems = [];
    fichaSources.forEach(function(fs) {
      findKeys(fs.data, function(k) {
        var n = normK(k);
        return BIOMECH_EXACT.some(function(e) { return normK(e) === n; }) || (BIOMECH_RE.test(k) && !BIOMECH_NOT_RE.test(k));
      }).forEach(function(f) { if (!emptyish(f.value)) biomItems.push({ source: fs.src, path: f.path, key: f.key, value: f.value }); });
    });
    biomItems = dedupeBy(U.sortBy(biomItems, function(x) { return [x.source, x.path]; }), function(x) { return x.source + '|' + x.path; });
    var biomechanics = { available: biomItems.length > 0, extraction: 'verbatim stored fields matched by key name; no diagnosis or inference', items: biomItems };

    // ---- body metrics (raw records; no trend here)
    var body = [];
    (Array.isArray(clientData.inbodyResults) ? clientData.inbodyResults : []).forEach(function(r, i) {
      body.push({ type: 'inbody', source: 'clients.inbodyResults[' + i + ']', timestamp: U.toIso(U.isObj(r) ? r.ts : null), plan_id: null, week: null, values: r });
    });
    recovery.filter(function(r) { return r.type === 'weekly_checkin'; }).forEach(function(r) {
      body.push({ type: 'weekly_checkin', source: r.source, timestamp: r.timestamp, plan_id: r.plan_id, week: r.week, values: U.isObj(r.values) ? { peso: r.values.peso === undefined ? null : r.values.peso, hrv: r.values.hrv === undefined ? null : r.values.hrv, who5: r.values.who5 === undefined ? null : r.values.who5 } : null });
    });
    [ficha.onboarding, ficha.renewal].forEach(function(f, idx) {
      if (!f) return;
      var src = idx === 0 ? 'fichas_onboarding' : 'fichas_renovacion', vals = {};
      findKeys(f.document, function(k) { return BODY_FICHA_KEYS.indexOf(k) !== -1; }).forEach(function(x) { vals[x.key] = x.value; });
      if (Object.keys(vals).length) body.push({ type: 'ficha_baseline', source: src, timestamp: U.toIso(raw[idx === 0 ? 'ficha_onboarding' : 'ficha_renovacion'].data && raw[idx === 0 ? 'ficha_onboarding' : 'ficha_renovacion'].data.updatedAt), plan_id: null, week: null, values: vals });
      findKeys(f.document, function(k) { return /fotometria|circunferencia|pliegue/i.test(k); }).forEach(function(x) {
        if (!emptyish(x.value)) body.push({ type: 'anthropometry', source: src + '.' + x.path, timestamp: null, plan_id: null, week: null, values: x.value });
      });
    });
    body = U.sortBy(body, function(x) { return [U.toMs(x.timestamp), x.type, x.source]; });

    // ---- client / nutrition / supplements / additional
    var profile = {}, moved = {};
    Object.keys(clientData).sort().forEach(function(k) { if (MOVED_CLIENT_KEYS[k]) moved[k] = MOVED_CLIENT_KEYS[k]; else profile[k] = clientData[k]; });
    var client = {
      client_id: clientId, coach_id: coachId, display_name: clientData.displayName === undefined ? null : clientData.displayName,
      email: clientData.email === undefined ? null : clientData.email, phone: clientData.phone === undefined ? null : clientData.phone,
      role: clientData.role === undefined ? null : clientData.role, active_plan_id: activePlanId, profile: profile, fields_moved_to_other_sections: moved
    };
    var nutriDisplay = clientData.nutritionPlan === undefined ? null : clientData.nutritionPlan, nutriRaw = clientData.nutritionRaw === undefined ? null : clientData.nutritionRaw;
    var suppDisplay = clientData.supplementPlan === undefined ? null : clientData.supplementPlan, suppRaw = clientData.supplementsRaw === undefined ? null : clientData.supplementsRaw;
    var nutriLogs = [].concat.apply([], normalized.map(function(n) { return n.nutrition_logs; }));
    nutriLogs = U.sortBy(nutriLogs, function(x) { return [x.date, x.plan_id, x.entry_key]; });
    var nutrition = { present: !(emptyish(nutriDisplay) && emptyish(nutriRaw) && !nutriLogs.length), display: nutriDisplay, raw: nutriRaw, client_daily_logs: nutriLogs };
    var supplements = { present: !(emptyish(suppDisplay) && emptyish(suppRaw)), display: suppDisplay, raw: suppRaw };

    var unclassifiedByPlan = [];
    normalized.forEach(function(n) { if (n.unclassified) unclassifiedByPlan.push({ plan_id: n.mesocycle.plan_id, entries: n.unclassified }); });
    var logsDocFields = {};
    if (rootLogs) Object.keys(rootLogs).sort().forEach(function(k) { if (k !== 'entries') logsDocFields[k] = rootLogs[k]; });
    var mesoFields = {};
    Object.keys(mesoDocs).sort().forEach(function(pid) { var f = {}; Object.keys(mesoDocs[pid]).sort().forEach(function(k) { if (k !== 'entries') f[k] = mesoDocs[pid][k]; }); mesoFields[pid] = f; });
    var additional = {
      pharmacology: clientData.pharmacoPlan === undefined ? null : clientData.pharmacoPlan,
      logs_document_fields: logsDocFields, mesos_document_fields: mesoFields, unclassified_log_entries: unclassifiedByPlan
    };

    var plans = U.sortBy(Object.keys(plansById).map(function(i) { return plansById[i]; }), function(p) { return [orderOf[p.id] === undefined ? 1e9 : orderOf[p.id], p.id]; });
    var backups = U.sortBy(raw.plans_backup.map(function(p) { return { id: p.id, data: sd(p.data) }; }), function(p) { return [U.toMs(p.data.backedUpAt), p.id]; });

    var info = function(section) { warnings.push({ code: 'SECTION_EMPTY', section: section, detail: 'no stored data for this client', severity: 'info' }); };
    if (!ficha.onboarding && !ficha.renewal && !ficha.public_forms.length) info('ficha_360');
    if (!biomechanics.available) info('biomechanics');
    if (!body.length) info('body_metrics');
    if (!plans.length) info('training.plans');
    if (!sessions.length) info('training.sessions');
    if (!recovery.length) info('recovery');
    if (!notes.length) info('notes');
    if (!nutrition.present) info('nutrition');
    if (!supplements.present) info('supplements');
    if (ctx.redactions.length) warnings.push({ code: 'SECRET_FIELDS_REDACTED', section: 'all', detail: ctx.redactions.length + ' field(s) removed by the secret denylist', paths: ctx.redactions.slice().sort() });

    return {
      client: client, ficha_360: ficha, biomechanics: biomechanics, body_metrics: body,
      training: { plans: plans, plans_backup: backups, mesocycles: mesocycles, sessions: sessions, exercise_logs: exerciseLogs, current_week: rootLogs ? U.num(rootLogs.currentWeek) : null },
      recovery: recovery, notes: notes, nutrition: nutrition, supplements: supplements, additional_client_data: additional, warnings: warnings,
      _internal: { plansById: plansById }
    };
  }

  return { normalize: normalize, parseEntries: parseEntries, findKeys: findKeys, RE: RE };
});
