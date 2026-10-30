'use strict';
/**
 * T217 — Outcome data contract map (audit-only; grep-first per Efficiency
 * Rules). Every objective/subjective outcome data source already available
 * for a GOAL RESPONSE / PRESCRIPTION EFFECTIVENESS layer.
 *
 *   OUTCOME SOURCE                    TIME SCOPE                 WRITER                        READER                              RELIABILITY                      GOAL RELEVANCE          CLASS
 *   -------------------------------   ------------------------  ----------------------------  ----------------------------------  --------------------------------  ----------------------  -----
 *   clients/{uid}.inbodyResults[]     multi-measurement array,   Coach (manual entry,           _renderClientTabInBody (sparklines, HIGH (device reading) but        Direct: peso/SMM/PBF/    C
 *   {peso,smm,pbf,vfl,score,          irregular real-world       InBody Dial H30 device)         WhatsApp export, PNG export)        NO stated-goal awareness --       VFL are the client's
 *   tipo_cuerpo,fecha,ts,nota}        intervals                                                                                      _trendArrow's hib (higher-is-    literal body-comp goal
 *                                                                                                                                     better) table is HARDCODED
 *                                                                                                                                     (peso:false always) -- NOT
 *                                                                                                                                     goal-aware (a surplus/bulk
 *                                                                                                                                     goal wants peso UP, not down).
 *   fichas_onboarding/{uid}.data.     static-ish, coach-edited   Coach (onboarding/ficha        _mapNutritionContext             HIGH (explicit coach input)       Direct: the stated       E
 *   objetivo_calorico                 occasionally               editor)                        (Generator nutrition context)                                        body-comp direction
 *   ('superávit'/'mantenimiento'/                                                                                                                                    ("superávit" = gain,
 *   'déficit')                                                                                                                                                       "déficit" = lose)
 *   fichas_onboarding/{uid}.data.     static-ish                 Coach                          _computeAdaptivePrescriptionForRequest HIGH (explicit coach input)  Direct: which muscles     E
 *   prioridades.grupos_musculares                                                                (adaptivePrescription priority                                     the client's goal
 *                                                                                                 muscles)                                                            actually prioritizes
 *   fichas_onboarding/{uid}.          static-ish, occasionally   Coach (photo upload +           _mapNutritionContext-adjacent    MEDIUM (photo-estimated, a       Adjacent: circumference/  F
 *   fotometria (circunferencias +     updated                    fotogrametría analysis)         onboarding-editor only -- NOT     DIFFERENT measurement method     photo-based body-comp
 *   pliegues)                                                                                     currently cross-referenced       than the InBody device)          estimate, not currently
 *                                                                                                 against inbodyResults anywhere)                                    reconciled with InBody
 *   progressionHistory                already fully mapped in   calculateProgression /          Generator, Coach T198/T215,      HIGH, T205-fixed (execution-     Direct: strength/PR/     A/B
 *   .byPrescriptionExerciseId[pid]    T160/166/T205/T212         _mapExerciseProgressionHistory  learnedState (T211-213)          completeness-gated confidence,   performance trend per
 *   .history[]{action,newLoad,...}                                                                                                 PID-first)                       exercise (already the
 *                                                                                                                                                                     T219 performance
 *                                                                                                                                                                     substrate)
 *   learnedState (T210-213)           mesocycle-scoped,          window.VDSEN_LEARNED           Generator (learnedState field,   Confidence-gated per item        Direct: volume/exercise/  A/B/D
 *   {volumeToleranceByMuscle,         already-computed                                          T214), Coach (T215)              (T210's shared rule)              pattern tolerance,
 *   exerciseToleranceByPid,                                                                                                                                          recovery sensitivity --
 *   patternTolerance,                                                                                                                                                 all already outcome-
 *   recoverySensitivity}                                                                                                                                              adjacent
 *   executionFidelity /              week/session/PID-scoped    window.VDSEN_ADHERENCE         Generator, Coach, weeklyDecision  Confidence-gated (T202-205)       Adherence CONTEXT for      E
 *   sessionAdherence (T202-207)                                 (T202-204)                                                                                          gating outcome
 *                                                                                                                                                                     attribution, never the
 *                                                                                                                                                                     outcome itself
 *   postsession_{W}_{D}                per-session                post-session modal            _computeDeloadTriggers,           HIGH (self-report) but MEDIUM    Recovery/pain OUTCOME     D/F
 *   {eimd, articularPain, sleepHours,                                                            calculateProgression EIMD veto,   for subjective severity           context (already the
 *   rpeAverage}                                                                                  T212's hadPainFlag (T212)                                          T213 substrate)
 *   ci_sem_{W} {who5, hrv, peso,      per-week                   guardarCI() (client)           Coach Ehrenstein semaphore,       HIGH (self-report)                Subjective wellbeing      D/F
 *   sleep, energia, subj_score,                                                                  T177+ weekly decision, T213                                        OUTCOME, distinct from
 *   adherencia_pct, ics_promedio}                                                                recovery sensitivity                                               objective InBody data
 *   mesocycleDecision (T192-200)      mesocycle-scoped,          _decideMesocycleTransition     Generator, Coach T198             Deterministic given inputs       Not an outcome itself --   N/A
 *   {action, preserveExercisePids,    freshly computed each                                                                                                          a DECISION consuming
 *   reviewExercisePids}               call                                                                                                                           outcome-adjacent evidence
 *
 * MISMATCH FOUND (documented, NOT fixed -- pre-existing display-only
 * behavior, no live decision-making depends on it, out of this ticket's
 * scope to touch the InBody display tab): `_trendArrow`'s `hib` (higher-is-
 * better) table on `_INBODY_FIELDS` hardcodes `peso: false` (lower is
 * always "good") regardless of the client's actual `objetivo_calorico`
 * (a 'superávit'/bulk goal wants peso UP). This only affects the Coach's
 * InBody tab arrow/color display (cosmetic, not a decision), and T220's
 * new body-composition response classifier is built as its OWN,
 * goal-aware function rather than reusing this hardcoded table --
 * `_trendArrow` itself is untouched.
 *
 * Classification of what's available:
 *   A. PERFORMANCE OUTCOME    -- progressionHistory (load/reps/RIR trend)
 *   B. MUSCLE/PATTERN RESPONSE -- learnedState (T211/212), progressionHistory
 *   C. BODY-COMPOSITION OUTCOME -- clients/{uid}.inbodyResults[]
 *   D. RECOVERY OUTCOME       -- postsession_{W}_{D}, ci_sem_{W}, recoverySensitivity (T213)
 *   E. ADHERENCE CONTEXT      -- executionFidelity/sessionAdherence (T202-207), objetivo_calorico/prioridades (goal context)
 *   F. SUBJECTIVE OUTCOME     -- ci_sem_{W} self-report, fotometria (photo-estimated)
 *
 * Run: node tests/t217-outcome-data-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// The map's own claims, verified against real code.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("const results = Array.isArray(c.inbodyResults)"), 'BODY-COMPOSITION OUTCOME source confirmed: clients/{uid}.inbodyResults array');
ok(COACH.includes("{ id:'peso', label:'Peso', unit:'kg',  step:'0.1', hib:false, type:'number' }") && COACH.includes("{ id:'smm',  label:'SMM',  unit:'kg',  step:'0.1', hib:true,  type:'number' }"),
  '_INBODY_FIELDS confirmed: peso/smm/pbf/vfl with a HARDCODED (non-goal-aware) higher-is-better table');
ok(COACH.includes("if (results.length >= 2) {"), "confirmed the existing UI itself already requires 2+ measurements before showing any trend -- precedent for T218's own 'one measurement never HIGH' rule");

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
ok(CLIENT.includes('"options":["superávit","mantenimiento","déficit"]'), 'objetivo_calorico\'s exact enum confirmed: superávit/mantenimiento/déficit -- the goal-direction signal T220 will use');

ok(COACH.includes('var priorityMuscles = (fd.prioridades && Array.isArray(fd.prioridades.grupos_musculares))'), 'priority muscles (fd.prioridades.grupos_musculares) confirmed as the existing goal-relevance signal, already reused by T185-188 adaptivePrescription');

console.log('');
console.log('T217 — Outcome data contract map: ' + pass + ' assertions PASSED');
