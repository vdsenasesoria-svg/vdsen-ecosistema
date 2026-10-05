'use strict';
// Synthetic LARGE history for one client (no real data): `mesos` mesocycles x `weeks` x `days` x `exs` exercises x `sets` sets.
const fx = require('./client-export-fixture.js');
function buildLarge(o) {
  const db = { coaches: { [fx.COACH_A]: {} }, clients: {}, plans: {}, plans_backup: {}, logs: {}, fichas_onboarding: {}, fichas_renovacion: {}, fichas_publicas: {}, ['logs/' + fx.A1 + '/mesos']: {} };
  db.clients[fx.A1] = { coachId: fx.COACH_A, displayName: 'Cliente Grande Ñ', activePlanId: 'M' + o.mesos, coachNote: 'nota larga '.repeat(50) };
  let total = 0, t0 = Date.parse('2024-01-01T08:00:00Z');
  for (let m = 1; m <= o.mesos; m++) {
    const id = 'M' + m, days = [];
    for (let d = 0; d < o.days; d++) days.push({ dayIndex: d, label: 'Día ' + (d + 1), exercises: Array.from({ length: o.exs }, (_, e) => ({ exerciseName: 'Ejercicio ' + e, prescriptionExerciseId: id + '-' + d + '-' + e, sets: Array.from({ length: o.sets }, (_, s) => ({ setIndex: s, repsTarget: 8, rirTarget: 2 })) })) });
    db.plans[id] = { coachId: fx.COACH_A, clientId: fx.A1, weeks: o.weeks, daysPerWeek: o.days, days, createdAt: new Date(t0 + m * 1e9).toISOString(), status: m === o.mesos ? 'active' : 'completed' };
    const entries = {};
    for (let w = 1; w <= o.weeks; w++) for (let d = 0; d < o.days; d++) {
      entries['done_' + w + '_' + d] = true; entries['postsession_' + w + '_' + d] = { eimd: 2, sleep: 7, rpe: 8, ts: t0 + total };
      for (let e = 0; e < o.exs; e++) for (let s = 0; s < o.sets; s++) {
        entries['log_' + w + '_' + d + '_' + e + '_s' + s] = { carga: 40 + w + e, reps: 8, unit: 'kg', done: true, rir: 2, rir_real: 1, ics: 8, pump: 2, ts: new Date(t0 + (total++) * 60000).toISOString() };
      }
      if (d === 0) entries['ci_sem_' + w] = { peso: 70 + w / 10, hrv: 50, who5: 60, fecha: new Date(t0 + total * 60000).toISOString() };
    }
    if (m === o.mesos) db.logs[fx.A1] = { planId: id, currentWeek: o.weeks, updatedAt: t0 + 1e10, entries };
    else db['logs/' + fx.A1 + '/mesos'][id] = { planId: id, currentWeek: o.weeks, updatedAt: t0 + m, entries };
  }
  return { db, sets: total };
}
module.exports = { buildLarge };
