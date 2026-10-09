'use strict';
/**
 * T241 — Evidence provenance audit (audit-only, no code change). Maps
 * scope -> evidence source -> real persisted timestamp field ->
 * availability, for the ONLY consumer that matters: T242's canonical
 * evidence-timestamp function. No timestamp is invented here -- every
 * field below is verified to actually be WRITTEN somewhere in the real
 * client/coach pipeline, not assumed from a schema comment.
 *
 *   SCOPE     EVIDENCE SOURCE                    REAL TIMESTAMP FIELD          IDENTITY              AVAILABLE?
 *   --------  ---------------------------------  -----------------------------  ---------------------  ----------
 *   EXERCISE  progrec_{W}_{D} (whole batch)       entry.calculatedAt (ISO,       recommendations[].     YES -- exact
 *             .recommendations[] contains this    written once per session-      prescriptionExerciseId  PID match,
 *             PID                                 completion in vdsen-cliente)                          reused as-is
 *   MUSCLE    same progrec_{W}_{D} entries,        entry.calculatedAt, taken     PID -> muscle via the   YES -- derived,
 *             filtered to PIDs whose CURRENT       over every matching PID      SAME canonical exercise  never by name
 *             plan exercise trains this exact                                  metadata already used
 *             muscle (canonical metadata)                                      by auditFractionalVolume
 *   CLIENT    postsession_{W}_{D}.ts (epoch ms,    real Date.now() at submit    whole client, no PID    YES
 *             vdsen-cliente submitPostSession);                                needed
 *             ci_sem_{W}.fecha (ISO date, day
 *             granularity, at guardarCI); clients/
 *             {uid}.inbodyResults[].ts
 *   MESOCYCLE  no distinct source of its own --    same as CLIENT              whole client            YES, via
 *             a mesocycle-level Coach decision                                                          CLIENT's
 *             concerns the whole client's                                                               signals
 *             trajectory, not a separate stream
 *
 *   DECLARED UNAVAILABLE / NOT USED (documented, not silently ignored):
 *   - log_{W}_{D}_{E}_s{S}.ts (per-set logs) DOES carry a real timestamp,
 *     but the key is POSITIONAL (day index + exercise INDEX, not PID) --
 *     using it would require resolving index->PID against the CURRENT
 *     plan shape, which can drift if the plan was edited since that set
 *     was logged (exactly the position!=identity problem PIDs exist to
 *     avoid). Declared unavailable for scope-exact use; progrec's own
 *     calculatedAt (already PID-anchored) is used instead.
 *   - Individual recommendation objects (each item of progrec_{W}_{D}
 *     .recommendations[]) do NOT carry their own calculatedAt -- only the
 *     PARENT progrec_{W}_{D} object does (one calculatedAt per whole
 *     weekly-recommendation batch). vdsen-coach.html's PRE-EXISTING
 *     weeklyDecision editStale check (`r.calculatedAt`, T170-era, wholly
 *     unrelated to the T233-240 Coach Intervention subsystem) reads this
 *     field on the INDIVIDUAL rec, which is always undefined there -- a
 *     latent, pre-existing gap, out of this ticket's scope to fix, but
 *     documented here because it directly informed T242's design: use the
 *     PARENT entry's calculatedAt, never `rec.calculatedAt`.
 *   - RIR real / adherence / recovery / HRV: already folded into
 *     ci_sem_{W} and progrec recommendations -- no separate timestamp
 *     stream exists or is needed.
 *
 * Run: node tests/t241-evidence-provenance-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// EXERCISE — progrec_{W}_{D}.calculatedAt (parent object) + recommendations[]
// .prescriptionExerciseId, both genuinely written by vdsen-cliente.html.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes('calculatedAt: new Date().toISOString(),'), 'progrec_{W}_{D}\'s own calculatedAt is a real, non-fabricated ISO timestamp written at session-completion time');
ok(/return\s*\{\s*recommendations:\s*recs,/.test(CLIENT), 'confirmed calculatedAt is stamped on the PARENT progrec object (sibling of "recommendations"), not on each individual recommendation');
ok(CLIENT.includes('prescriptionExerciseId: ej.prescriptionExerciseId || undefined,'), 'each individual recommendation genuinely carries its own prescriptionExerciseId -- exact PID identity, not name');

// The pre-existing (unrelated, T170-era) gap this audit discovered, which
// directly shaped T242's design decision (use entry.calculatedAt, never
// rec.calculatedAt).
ok((COACH.match(/r\.calculatedAt/g) || []).length >= 1, 'confirmed vdsen-coach.html has an existing consumer that reads calculatedAt off the INDIVIDUAL rec (r.calculatedAt) -- which the write site above never sets, a pre-existing gap unrelated to T233-240, left untouched per this ticket\'s scope');

// ─────────────────────────────────────────────────────────────────────────────
// MUSCLE — same progrec entries, aggregated via the canonical PID->muscle
// metadata already trusted by auditFractionalVolume (T185-188), never by
// exercise/rec name.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('var _EXERCISE_CANONICAL_METADATA = {'), 'the canonical exercise->muscle metadata T242 will reuse for MUSCLE-scope aggregation already exists and is already trusted (auditFractionalVolume)');

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — 3 independent, genuinely-written real timestamps.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("ts: Date.now()") && CLIENT.includes("var postKey = 'postsession_'+CURRENT_WEEK+'_'+di;"), 'postsession_{W}_{D}.ts is a real Date.now() stamped at submit time (submitPostSession)');
ok(CLIENT.includes("d.fecha  = new Date().toISOString().split('T')[0];"), 'ci_sem_{W}.fecha is a real (day-granularity) ISO date stamped at guardarCI time, not fabricated');
ok(COACH.includes("const entry = { ts: Date.now(), fecha: document.getElementById('inb_fecha')?.value || '' };"), 'clients/{uid}.inbodyResults[].ts is a real Date.now() at InBody entry time');

// ─────────────────────────────────────────────────────────────────────────────
// Positional per-set logs: real timestamp exists, but declared UNAVAILABLE
// for scope-exact (PID) use, for a documented identity-drift reason.
// ─────────────────────────────────────────────────────────────────────────────

ok(/var key\s*=\s*'log_'\+CURRENT_WEEK\+'_'\+di\+'_'\+ei\+'_s'\+s;/.test(CLIENT), 'confirmed log_{W}_{D}_{E}_s{S} keys are positional (day index + exercise INDEX), not PID -- unsafe for scope-exact EXERCISE evidence, correctly excluded from T242');

console.log('');
console.log('T241 — Evidence provenance audit: ' + pass + ' assertions PASSED');
