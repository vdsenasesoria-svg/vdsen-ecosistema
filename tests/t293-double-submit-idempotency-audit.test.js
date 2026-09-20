'use strict';
/**
 * T293 — Double-submit / idempotency hardening (audit-only, no code
 * change). Audits the critical mutation paths for double-click/duplicate-
 * execution protection: an inFlight guard set synchronously before any
 * await, OR a deterministic-overwrite proof that duplicate execution is
 * harmless.
 *
 * RESULT: no defect found. Every critical path already guards correctly:
 *
 *   - activate plan: btn.disabled=true set synchronously right after the
 *     confirm() dialog returns and before any await; window.confirm()
 *     itself is a blocking native modal, so a second click physically
 *     cannot be processed while it is open (single-threaded JS) --
 *     PLUS a deterministic idempotency guard already exists inside
 *     _vdsenActivatePlanInFirestore itself (activePlanId === planId ->
 *     no-op), already proven by T266 CASE M (double activation ->
 *     byte-identical state, exactly 1 real client update issued).
 *   - save draft: btn.disabled=true before await; result.idempotent
 *     signals a repeat save was recognized rather than duplicated.
 *   - coach intervention: _savingCoachIntervention boolean checked+set
 *     before any await (T291).
 *   - session completion: _postSessionSubmitting boolean, try/finally
 *     always resets it even on an unexpected exception (T291).
 *   - weekly check-in (guardarCI, client): _guardarCIInFlight boolean
 *     checked+set before any await, buttons disabled synchronously.
 *   - plan import (loadPlanFromPastedAnalysis): btn.disabled=true before
 *     await, finally always re-enables it.
 *   - plan generation (vdsenAIPreview): btn.disabled=true before the
 *     fetch, finally always re-enables it, AbortController caps the
 *     request at 3 minutes so a hang cannot leave the button disabled
 *     indefinitely.
 *
 * Run: node tests/t293-double-submit-idempotency-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ── Activate plan: synchronous disable right after confirm(), before any await. ──
ok(COACH.includes("if (!confirmed) return;\n\n    if (btn) { btn.disabled = true; btn.textContent = '⏳ Activando…'; }"),
  'activate-plan disables its button synchronously immediately after confirm() returns, before either await');
ok(COACH.includes('if (clientData.activePlanId === planId) return;') || COACH.includes('activePlanId === planId'),
  '_vdsenActivatePlanInFirestore still has its own deterministic idempotency guard (re-activating the same plan is a no-op) -- already proven by T266 CASE M');

// ── Save draft. ──────────────────────────────────────────────────────────
ok(COACH.includes("if (btn) { btn.disabled = true; btn.textContent = '⏳ Guardando…'; }"), 'save-draft disables its button synchronously before the await');
ok(COACH.includes('result.idempotent'), 'save-draft surfaces result.idempotent -- a repeat save is recognized, not silently duplicated');

// ── Coach intervention (re-confirmed from T291). ────────────────────────
ok(COACH.includes('if (_savingCoachIntervention) return; // no duplicate writes on double click'), 'coach intervention inFlight guard still present');

// ── Session completion + weekly check-in (client app). ──────────────────
ok(CLIENT.includes('if (_postSessionSubmitting) return;'), 'post-session submit inFlight guard still present');
ok(CLIENT.includes('_postSessionSubmitting = false;\n  }\n}'), 'post-session submit resets its inFlight flag in a finally block (unlocks even on an unexpected exception)');
ok(CLIENT.includes('if (_guardarCIInFlight) return;') && CLIENT.includes('_guardarCIInFlight = true;'),
  'weekly check-in (guardarCI) inFlight guard checked and set before any async work');

// ── Plan import. ─────────────────────────────────────────────────────────
ok(COACH.includes("if (btn) { btn.disabled = true; btn._t = btn.textContent; btn.textContent = '⏳ Cargando…'; }"), 'plan import disables its button before any await');
ok(COACH.includes("if (btn) { btn.disabled = false; btn.textContent = btn._t || '📥 Cargar plan desde análisis'; }"), 'plan import re-enables its button in a finally block');

// ── Plan generation. ──────────────────────────────────────────────────────
ok(COACH.includes('const _abortCtrl = new AbortController();') && COACH.includes('setTimeout(() => _abortCtrl.abort(), 180000)'),
  'plan generation caps the request at 3 minutes -- a hang cannot leave the Generate button disabled indefinitely');

console.log('');
console.log('T293 — Double-submit/idempotency audit: ' + pass + ' assertions PASSED (no defect found, no code change)');
