'use strict';
/**
 * T267 — Nutrition data/adherence contract map (audit-only).
 *
 * Maps every current nutrition-related source to determine: does VDSEN
 * already collect REAL nutrition adherence data, or would T268 have to
 * fabricate one? Per the ticket's Critical Product Rule: if no reliable
 * adherence data exists, do NOT invent it -- classify INSUFFICIENT_DATA
 * and document the gap instead.
 *
 * FINDING: real nutrition adherence data ALREADY EXISTS.
 *
 * SOURCE: logs/{uid}.entries['nutrilog_YYYY-MM-DD']
 *   WRITER: client (vdsen-cliente.html guardarNutriLog/nutriLogSet)
 *   READER: client only (buildNutriAdherenceWidget/renderNutricion) --
 *           NEVER read by the coach app or any engine today.
 *   SHAPE: { kcal, prot, carb, gras, fecha, ts } -- self-reported ACTUAL
 *          daily macros, one doc key per day, not inferred from anything.
 *   TIME SCOPE: daily, real self-report (comparable directly against the
 *          active nutritionRaw target).
 *   RELIABILITY: real execution evidence (not derived from bodyweight or
 *          any proxy) -- self-reported, so day-count matters for confidence,
 *          but the underlying values are not fabricated.
 *   OUTCOME RELEVANCE: none directly -- this is EXECUTION, not outcome.
 *   ADHERENCE RELEVANCE: HIGH -- this IS the real nutrition adherence
 *          signal, currently uncollected/unused by any classifier.
 *
 * SOURCE: clients/{uid}.inbodyResults[] + clients/{uid}.objetivo_calorico
 *   WRITER: coach (_inbodySave / ficha form)
 *   READER: coach; window.VDSEN_OUTCOME.computeBodyCompositionResponse
 *          (T220, _classifyBodyCompositionResponse) -- ALREADY a full
 *          deterministic body-composition response classifier reusable
 *          verbatim for T269.
 *   SHAPE: { ts, peso, smm, pbf } array; objetivo_calorico is one of
 *          'déficit'/'mantenimiento'/'superávit'.
 *   TIME SCOPE: periodic (whenever an InBody test is logged).
 *   RELIABILITY: device-measured, method-consistency-gated (T220 already
 *          refuses to mix inbody with fotometria as if equivalent).
 *   OUTCOME RELEVANCE: HIGH -- the body-composition outcome source.
 *   ADHERENCE RELEVANCE: NONE -- must never be used to infer adherence
 *          (Core Principle: "Bodyweight outcome != adherence").
 *
 * SOURCE: window.VDSEN_ADHERENCE (T202-204)
 *   Computes TRAINING SESSION adherence (sets executed vs prescribed).
 *   Textually similar name, but a CONCEPTUALLY DIFFERENT signal from
 *   nutrition adherence -- must not be conflated or reused as a nutrition
 *   proxy.
 *
 * SOURCE: logs/{uid}.entries['ci_sem_{W}'].peso
 *   Weekly self-reported bodyweight -- a real, LIGHTER-weight outcome
 *   timeline point, but explicitly NOT an adherence signal per the Core
 *   Principle above, and not currently fed into T220's classifier (which
 *   only reads inbodyResults, deliberately, per its own T217 comment).
 *
 * CONCLUSION: T268 must build/reuse a deterministic classifier reading
 * nutrilog_* vs nutritionRaw targets (real evidence, no new schema, no
 * new collection -- reuses the existing logs/{uid} doc), NOT fabricate
 * one and NOT unconditionally return INSUFFICIENT_DATA. T269 reuses T220
 * (_classifyBodyCompositionResponse/_computeOutcomeConfidence) directly
 * rather than building a second outcome engine.
 *
 * Run: node tests/t267-nutrition-adherence-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// nutrilog_* exists, is written by the client with real per-day macros...
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("var k = 'nutrilog_'+_todayKey();") && CLIENT.includes('function guardarNutriLog()'),
  'client writes a real per-day nutrilog_{date} entry to LOGS (guardarNutriLog) -- not fabricated, not a placeholder');
ok(CLIENT.includes("['nl_kcal','nl_prot','nl_carb','nl_gras'].forEach"),
  'nutrilog captures kcal/prot/carb/gras -- directly comparable against nutritionRaw targets (same units)');

// ─────────────────────────────────────────────────────────────────────────────
// ...but is NEVER read by the coach app or any engine today -- confirmed
// absent from vdsen-coach.html entirely.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("k.indexOf('nutrilog_') === 0"), 'nutrilog_* is now read by T268/T271 (_computeNutritionDecisionForRequest) -- the real data found unused here was wired in additively, not a new capture point (FIXED by T268/T271)');

// ─────────────────────────────────────────────────────────────────────────────
// T220's body-composition response classifier already exists and is
// reusable verbatim for T269 -- confirms "reuse T220" is literal, not
// aspirational.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('function _classifyBodyCompositionResponse(inbodyResults, objetivoCalorico)'),
  'T220 _classifyBodyCompositionResponse already exists, reading inbodyResults[]/objetivoCalorico -- directly reusable by T269, no second outcome engine needed');
ok(COACH.includes('function _computeOutcomeConfidence(measurements, options)'),
  'T220 _computeOutcomeConfidence (evidence-confidence gate: method-mixing + time-horizon) already exists -- reusable generically for nutrition adherence/response confidence too');

// ─────────────────────────────────────────────────────────────────────────────
// VDSEN_ADHERENCE is training-session adherence, a DIFFERENT signal from
// nutrition adherence -- must not be conflated by T268.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('window.VDSEN_ADHERENCE') && COACH.includes('computeSessionSummary') && COACH.includes('computeMuscleAdherence'),
  'window.VDSEN_ADHERENCE (T202-204) computes TRAINING session/muscle execution adherence -- a textually-similar but conceptually distinct signal from nutrition adherence, must not be reused as a nutrition proxy');

// ─────────────────────────────────────────────────────────────────────────────
// The Core Principle rule ("bodyweight outcome != adherence") is already
// respected structurally: T220 never receives ci_sem weekly weight as an
// adherence input anywhere in the existing pipeline.
// ─────────────────────────────────────────────────────────────────────────────

ok(!/_classifyBodyCompositionResponse\([^)]*ci_sem/.test(COACH) && !/_classifyBodyCompositionResponse\([^)]*\.peso\b(?!.*inbodyResults)/.test(COACH),
  'T220 body-composition response is never called with ci_sem/{W}.peso as if it were adherence evidence -- confirms the Core Principle rule already holds structurally in the existing code');

console.log('');
console.log('T267 — Nutrition adherence/outcome contract map: ' + pass + ' assertions PASSED');
console.log('CONCLUSION: real nutrition adherence data EXISTS (nutrilog_*) -- T268 must classify from it, not fabricate/skip.');
