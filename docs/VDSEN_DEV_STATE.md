# VDSEN Dev State — Handoff Document
> Actualizado: 2026-09-07 · branch `claude/learned-state-activation-d5b69n` · FASE 66 DONE · Suite 1892/1892

---

## Documentos de referencia

| Documento | Cuándo leer |
|-----------|-------------|
| `docs/VDSEN_DEV_STATE.md` | Siempre (estado técnico del ecosistema) |
| `docs/CONTEXTO_GENERADOR.md` | Solo para tareas de generación, validación, adaptación longitudinal o contratos del Motor |

Generator contract: `docs/CONTEXTO_GENERADOR.md` — leer únicamente para tareas de generación, validación, adaptación longitudinal o contratos del Motor.

---

## Estado actual

| Item | Valor |
|------|-------|
| main HEAD | `099fd74` |
| Rama activa | `main` |
| FASE 12–15 | MERGED |
| FASE 16 | MERGED — commit `3e277d1` |
| FASE 17 | MERGED — commit `604894c` |
| FASE 18 | MERGED — commit `e8c91c2` |
| FASE 19 | MERGED — commit `4575a7c` |
| FASE 20 | MERGED — commit `0d4be7c` |
| FASE 21 | MERGED — commit `b4e4a91` |
| FASE 22–24 | MERGED — commit `2b36630` |
| FASE 25 | MERGED — commit `cbb5691` |
| FASE 26 | MERGED — commits `666615b`+`8dbccda`+`955620d`+`ff83efd`+`8b45a75`+`43f99a1` · índice compuesto + reglas Firestore validados en producción |
| FASE 27 | MERGED — commit `769666c` · Missing Data Workflow · 2026-09-01 |
| FASE 29 | MERGED — commit `088eb3f` · Legacy Identity Display · 2026-09-01 |
| FASE 30 | MERGED — commit `06c3ef9` · Performance: reads filtrados, preloaded data, onSnapshot plan monitor |
| FASE 31 | MERGED — commit `17e1b00` · UX Coach: tarjetas monitor, apply individual, dirty save button |
| FASE 32 | MERGED — commit `1975fd8` · UX Cliente: touch targets, setDone flash, ring fix |
| FASE 33 | DONE — commits `7a29aa6`+`f10c75f` · End-to-End Integration Audit: 25 bugs corregidos |
| FASE 34 | DONE — Legacy Identity Hardening: BUG H-3 + BUG G4 corregidos, 17 tests nuevos |
| Suite tests | **1820/1820 PASS** (P01–P426 + F34-A–J + F36-B–N + F37-A–I + F39-A–E + F45-A–J + F46-A–O + BUG-RIR0-A–I + BUG-XSS-A–F + BUG-LS-DIV-A–D + F47-A–I + F48-A–J + F49-A–M + F50-A–Q + F51-A–M + F52-A–N + F53-A–M + F54-A–M + F55-A–M + F56-A–M + F57-A–M + F58-A–M + F59-A–M + F60-A–M + F61-A–N + F62-A–N + F63-A–L + F64-A–M) |
| FASE 45 | DONE — Learned State Activation v1 (topology + distribution engines) |
| FASE 46 | MERGED — Exercise Learned State Activation v1 · `099fd74` (fast-forward desde `claude/learned-state-activation-d5b69n`) |
| Bug: RIR-0 | FIXED — RIR 0 (fallo) no colapsa a default 2 en saveExpress/markExpressSerie/SS paths (vdsen-cliente.html) |
| Bug: XSS-preview | FIXED — _escH aplicada en vdsenAIPreview decisionTrace/flags/warnings/audit (vdsen-coach.html) |
| Bug: LS-diverge | FIXED — autoGeneratePlan aplica los 3 learned state engines igual que _autoGenerateForModal (vdsen-coach.html) |
| XSS: _askConfirm | FIXED — displayName/email/ejercicio en 4 sitios de _askConfirm (commit 044b503) |
| XSS: UI_STATES | FIXED — vdsenAIPreview UI_STATES + partial-escape en _autoGenerateForModal catch (commit 08b3d54) |
| Audit: hard constraints | VERIFIED SAFE — hardRejected gate en línea 9700 previa a score; VETO throw en import antes de aceptar plan |
| Audit: write amplification | SAFE — dual-write en _doSaveLogs es T1 intencional (migración mesos/); sin loops de escritura |
| Audit: read amplification | SAFE — carga de clientes usa Promise.all batching; buildPrescriptionContext ≤3 reads; sin polling |
| Audit: Decision Trace | BY DESIGN — trace de vdsenAIPreview viene de respuesta API; LS trace solo en console (v1) |
| Audit: LB/KG display | LOW PRIORITY — label "kg" hardcodeado en monitor coach (display-only, integridad de datos OK) |
| FASE 47 | DONE — Longitudinal Validation Framework: `_buildLongitudinalValidationReport` + 9 fixtures (FIX-A–I) · Suite 1263/1263 |
| FASE 48 | DONE — Longitudinal Validation Gate: `_buildLongitudinalValidationReport` + `_applyLongitudinalValidationGate` en coach; gate en autoGeneratePlan + _autoGenerateForModal; CONTINUIDAD block en success UI · Suite 1299/1299 |
| FASE 49 | DONE — Longitudinal Repair Bridge: `_buildLongitudinalRepairHints` puro (6 tipos → preferredAction/reasonCodes); integrado en success UI de ambos flows (max 3 "MEJORAS LONGITUDINALES PROPUESTAS"); tests F49-A–M (37 assertions) · Suite 1336/1336 |
| FASE 50 | DONE — Longitudinal Repair Execution Bridge: `_buildExerciseCandidatesForLV` (candidatos desde training+prevPlan) + `_applyLongitudinalRepairHintsToCandidates` (puro, ajusta priority/cost de candidatos válidos, re-audit gate wouldAddCriticalIssue, sort priority DESC/cost ASC); badge [reasonCode] en hints con candidato matched; tests F50-A–Q (52 assertions) · Suite 1388/1388 |
| FASE 51 | DONE — Longitudinal Repair Selection Audit: `_auditCandidateSelection` puro (selectedCandidate, selectionReason, historyInfluence, reasonCodes, alert); detecta TOP_RANKED_REPAIR_NOT_SELECTED cuando candidato superior elegible fue ignorado sin justificación; Decision Trace "📋 candidato · reason · HISTORY:✓" en Preview de ambos flujos; 0 auto-apply; tests F51-A–M (26 assertions) · Suite 1414/1414 |
| FASE 52 | DONE — Longitudinal Repair Outcome Validation: `_auditRepairOutcome` puro (post-hoc, 0 writes, 0 correcciones); clasifica APPLIED_AS_EXPECTED / PARTIALLY_APPLIED / NOT_APPLIED / OUTCOME_NOT_VERIFIABLE; alerta REPAIR_NOT_REFLECTED cuando selección no se refleja en plan; candidatos estructurales → NOT_VERIFIABLE; PARTIALLY_APPLIED cuando plan tiene días sin datos de ejercicio; outcome integrado en Decision Trace de ambos flujos; tests F52-A–N (26 assertions) · Suite 1440/1440 |
| FASE 53 | DONE — Structural Repair Outcome Verification: `_auditStructuralRepairOutcome` puro; verifica REVIEW_DISTRIBUTION_TOPOLOGY (cambio en daysPerWeek), REVIEW_TOPOLOGY_CHOICE (cambio en set de labels de días), REVIEW_STABILITY (ratio ejercicios preservados ≥0.7/≥0.3/<0.3); alerta STRUCTURAL_REPAIR_NOT_REFLECTED; ruteado desde `_auditRepairOutcome`; Preview flows actualizados con `context:{prevPlan:_prevPlanForLV[2]}`; tests F53-A–M (26 assertions) · Suite 1466/1466 |
| FASE 54 | DONE — Repair Effectiveness Audit: `_auditRepairEffectiveness` puro; compara issues longitudinales antes/después (validationBefore derivado de hints, validationAfter=_longValReport); clasifica RESOLVED/IMPROVED/UNCHANGED/REGRESSED/NOT_VERIFIABLE; alerta REPAIR_INEFFECTIVE cuando applied pero issues persisten, REPAIR_REGRESSION cuando aparecen nuevas SUSPECT; APPLIED_AS_EXPECTED ≠ RESOLVED; historyInfluence no compensa nuevas criticalIssues; Decision Trace extendido en ambos flujos con _effAudit.effectiveness; tests F54-A–M (27 assertions) · Suite 1493/1493 |
| FASE 55 | DONE — Repair Effectiveness Gate: `_applyRepairEffectivenessGate` puro conecta efectividad al quality gate real; REGRESSED → REVIEW_REQUIRED + criticalIssues; UNCHANGED+REPAIR_INEFFECTIVE → WARN + warnings; RESOLVED/IMPROVED → note only (sin elevación); NOT_VERIFIABLE y null → sin cambio; gate solo eleva nunca reduce; integrado en ambos flujos antes del write con IIFE `_effGate55`/`_effGate55b`; confirmación muestra razón compacta; tests F55-A–M (25 assertions) · Suite 1518/1518 |
| FASE 56 | DONE — Repair Decision Consistency Audit: `_auditRepairDecisionConsistency` puro detecta combinaciones imposibles/contradictorias entre selectionAudit/outcomeAudit/effectivenessAudit/gate; CRITICAL: RESOLVED_WITHOUT_APPLICATION (eff=RESOLVED/IMPROVED + outcome=NOT_APPLIED), REGRESSED_NOT_ELEVATED (REGRESSED sin gate=REVIEW_REQUIRED), APPLIED_WITHOUT_CANDIDATE (APPLIED_AS_EXPECTED sin selectedCandidate); WARNING: HISTORY_INFLUENCE_WITHOUT_REASONS, RESOLVED_BUT_OUTCOME_NOT_VERIFIABLE; `_applyConsistencyGate` eleva gate según severidad (CRITICAL→REVIEW_REQUIRED, WARNING→WARN, nunca reduce); IIFEs `_effGate55`/`_effGate55b` extendidos para encadenar `_ca56`/`_ca56b`; Decision Trace extendido con `_consAudit56`/`_consAudit56b`; tests F56-A–M (28 assertions) · Suite 1546/1546 |
| FASE 57 | DONE — Final Repair Pre-Write Revalidation: `_runFinalRepairRevalidation` puro orquesta la cadena F51–F56 completa contra el `_finalTraining` real (plan persisted al Firestore), no preview hipotético; eleva gate a REVIEW_REQUIRED para REPAIR_NOT_REFLECTED, STRUCTURAL_REPAIR_NOT_REFLECTED, REGRESSED (via F55), inconsistencia CRITICAL (via F56); ambos IIFEs `_effGate55`/`_effGate55b` simplificados a 3 líneas usando `.gate` del orquestador; checks REVIEW_REQUIRED pre-write inalterados (bloquean write hasta revisión explícita); tests F57-A–M (28 assertions) · Suite 1574/1574 |
| FASE 58 | DONE — Coach Client-Plan Mirror View: `_buildClientMirrorView(plan)` puro (0 I/O, 0 mutation) renderiza el plan activo del cliente con paridad visual/semántica con la app cliente; maneja RIR=0/load=0/SST/AMRAP/legacy/alternatives/coachNote/techniqueNote/supersetGroup/variacion_vertical; `_openClientMirrorModal()` abre overlay read-only desde botón "👁 Ver como cliente" en planActionsHtml; sin logs/progresión/autofill/writes; tests F58-A–M (21 assertions) · Suite 1595/1595 |
| FASE 59 | DONE — Client Mirror Parity Audit: `_auditClientMirrorParity(plan, mirrorHtml)` puro detecta MISSING_IN_MIRROR (day.label, exerciseName, coachNote, coachNote.label, techniqueNote, alternative, supersetGroup) y VALUE_MISMATCH (set.repsTarget, set.rirTarget); `_buildClientMirrorView` corregido con 6 gaps de paridad vs vdsen-cliente.html: nivel_medio full labels (FUNDAMENTAL/SUPLEMENTARIO/ASISTENCIA+/ASISTENCIA) + colores correctos (#cc4444/#FF8844/#C4FF00/#888888), zona badge (_getZonaBadge), coachNote blue-border "NOTA DEL COACH", TECHNIQUE_META+TECHNIQUE_DESCRIPTIONS.short block, SET_NOTE_LABELS pretty labels, techniqueFromWeek "NUEVA ESTA SEMANA" badge; tests F59-A–M (23 assertions) · Suite 1618/1618 |
| FASE 60 | DONE — Week-Aware Client Mirror: `_buildClientMirrorView(plan, week)` ahora acepta semana para renderizar estado visual dependiente de semana; helpers puros `_getTotalWeeksMirror`, `_isY3TExerciseMirror`, `_getY3TPhaseMirror`, `_isTechniqueActiveMirror`, `_getEffectiveSetsMirror`, `_getAdjustedRIRMirror`, `_buildClientMirrorWeekContext(plan, week)` → `{week, totalWeeks, isDeload, days:[{exercises:[{isY3T, y3tPhase, y3tPhaseMeta, effectiveSets, techniqueActive, adjustedRIR}]}]}`; lógica de semana idéntica a vdsen-cliente.html (getY3TPhase/getEffectiveSets/isTechniqueActive); Y3T muestra badge de fase (S1·FUERZA/S2·HIPERTROFIA/S3·METABÓLICA/DELOAD) y filtra effectiveSets; FST7/SST/SST_RIV inactivos en deload → "⏸ No disponible esta semana"; techniqueFromWeek badge solo en semana exacta de activación; `_openClientMirrorModal()` con selector de semana read-only (pills 1..N, ⟲ en última); 0 writes, 0 logs, 0 cambios de estado real; tests F60-A–M (32 assertions) · Suite 1650/1650 |
| FASE 61 | DONE — Client Mirror Execution State Overlay: `_buildClientMirrorExecutionState(plan, logs, week)` puro (0 I/O, 0 writes, 0 listeners, 0 mutation) construye estado de ejecución para la semana seleccionada desde `logs.entries`; matching PID-first (prescriptionExerciseId en valor del log), exerciseId como fallback canónico, posición como último recurso; invariantes congelados: POSITION != IDENTITY, autoFilled/autoClosed != real execution, progrec.newLoad != prescription; `_buildClientMirrorView(plan, week, execState)` extendido con overlay de ejecución por set (✅ real/⚠️ auto), badges de sesión (✓ COMPLETADA/⚠️ ADMIN), sugerencia 💡 progrec con etiqueta "solo sugerencia"; `_detailLogsData` cacheado en `showClientDetail` con un `getDoc` (sin listeners ni polling); `_openClientMirrorModal` computa execState por semana; tests F61-A–N (47 assertions) · Suite 1697/1697 |
| FASE 64 | DONE — Active Plan Mirror Source Integrity: `_resolveClientMirrorPlanSource(selectedClient, activePlanRef, cachedPlans, requestContext)` puro (0 I/O, 0 writes, 0 mutation) verifica identidad del plan antes de renderizar el mirror; retorna `{status, plan, reason}` con 5 estados: `READY` (plan verificado), `NO_ACTIVE_PLAN` (activePlanId nulo), `STALE` (requestContext.clientId o planId difieren del estado actual → ocurre cuando el coach cambia de cliente rápidamente o llega una respuesta async tardía), `CLIENT_MISMATCH` (activePlanRef.planId != selectedClient.activePlanId → caché desactualizado), `NOT_VERIFIABLE` (activePlanId presente pero planData null → plan eliminado o no encontrado); `_openClientMirrorModal(callerClientId)` ahora acepta clientId del botón, compara contra `_detailClientId`, y llama al resolver antes de pintar — si status != READY muestra overlay de error read-only en lugar del mirror, sin fallback silencioso; tests F64-A–M (31 assertions) · Suite 1820/1820 |
| FASE 66 | DONE — Coach Intent: Training Days & Meals Per Day: `_normalizeCoachIntent({trainingDays, mealsPerDay})` puro convierte valores UI a `{trainingDays:{mode,value}, mealsPerDay:{mode,value}}` con `mode: 'EXPLICIT'|'AUTO'`; sin números mágicos — null/''/'AUTO'/≤0 → AUTO, entero positivo → EXPLICIT; `_auditCoachIntentConformance(coachIntent, plan, nutrition)` puro detecta MISMATCH entre intento EXPLICIT y resolución del plan (daysPerWeek/days.length vs trainingDays.value; comidas.length vs mealsPerDay.value); `_buildCoachIntentDecisionTrace(coachIntent, resolvedDays, resolvedMeals)` puro → `{trainingDaysDecision, mealsPerDayDecision}` con source COACH_EXPLICIT/ENGINE_OPTIMIZED, requestedValue, resolvedValue, reasonCodes; `_buildCoachIntentConstraintText(coachIntent)` puro → string de restricciones explícitas para inyectar en userMsg (vacío cuando ambos AUTO); UI: selects "Días/semana" (AUTO/2-7) y "Comidas/día" (AUTO/2-6) añadidos en tarjeta `autoGeneratePlan` y en modal `_autoGenerateForModal`; ambos flujos de generación leen intent, inyectan restricciones en el prompt API, ejecutan conformance audit post-generación (MISMATCH → _askConfirm antes del write), y muestran bloque "CONFIGURACIÓN RESUELTA" compacto en status; vdsen-plan-v2 puro intacto — metadata solo en wrapper/UI; tests F66-A–O (45 assertions) · Suite 1892/1892 |
| FASE 65 | DONE — Client Mirror Log Source Integrity: `_resolveClientMirrorLogSource(selectedClientId, cachedLogsRef, requestContext)` puro (0 I/O, 0 writes, 0 listeners, 0 mutation) endurece la fuente de `_detailLogsData` antes de construir execState; retorna `{status, logs, reason}` con 5 estados: `READY` (logs del cliente verificados, provenance clientId matchea), `NO_LOGS` (null o datos vacíos — degrada a plan sin ejecución, nunca bloquea el mirror), `STALE` (requestClientId != selectedClientId — cambio de cliente entre request y resolución), `CLIENT_MISMATCH` (cachedLogsRef.clientId != selectedClientId — logs de otro cliente), `NOT_VERIFIABLE` (cachedLogsRef sin clientId — provenance imposible de verificar); `_detailLogsData` ahora almacena `{ clientId, data }` en lugar de datos crudos; `_openClientMirrorModal` llama al resolver: READY→usa logs, NO_LOGS→plan sin overlay, STALE/MISMATCH/NOT_VERIFIABLE→logs=null + aviso read-only naranja (plan siempre renderiza si plan source es READY); STALE/MISMATCH/NOT_VERIFIABLE jamás alimentan `_buildClientMirrorExecutionState`; 0 listeners/polling nuevos, 0 writes, 0 fallback a logs del último cliente visible; tests F65-A–J (27 assertions) · Suite 1847/1847 |
| FASE 63 | DONE — Client Mirror Session Summary: `_buildClientMirrorSessionSummary(plan, logs, week, execState)` puro (0 I/O, 0 writes, 0 mutation) agrega por día: `setsReal`/`setsTotal` (prescribed), `exercisesReal`/`exercisesTotal`, `sessionState` ('complete'|'partial'|'admin'|'none'), `avgRirReal` (media de rir_real de sets reales únicamente, null si ninguno), `volKg`/`volLb` (carga×reps de sets reales separados por unidad), `setsAutoFilled`, `hasAnyExecData`; `_buildClientMirrorView` inyecta bloque compacto por día con series/ejercicios/RIR real/volumen/auto-relleno cuando hay execDay con datos (sessionDone, sessionAutoClosed o sets registrados); autoFilled excluido de volumen, setsReal, exercisesReal y avgRirReal; RIR=0 preservado; bloque ausente cuando no hay datos reales de ejecución para el día; tests F63-A–L (53 assertions) · Suite 1789/1789 |
| FASE 62 | DONE — Client Mirror Execution Parity Audit: `_auditClientMirrorExecutionParity(plan, logs, week, execState)` puro detecta IDENTITY_MISMATCH (PID/exerciseId huérfanos en log sin match en plan → WARN), MISSING_EXECUTION_STATE (log entries matchean ejercicio pero execState tiene 0 sets, o set S específico no está en execState → ERROR), FALSE_REAL_EXECUTION (execState.done=true + !isAutoFilled pero raw.autoFilled=true o raw.done=false → ERROR), VALUE_MISMATCH (carga/reps/rir_real/ics/pump/unit discrepan entre raw y execState → ERROR); retorna `{status:'OK'|'HAS_WARNINGS'|'HAS_ERRORS', issues:[{type,severity,dayIndex,exerciseName,setIndex,detail}], summary}`; nunca eleva positional fallback para entradas con PID/exerciseId huérfanos; RIR=0 preservado sin colapsarse a null; 0 writes, 0 I/O, 0 mutation; tests F62-A–N (39 assertions) · Suite 1736/1736 |
| FASE 37 | DONE — LOGS_BY_WEEK index en memoria · commit `96fbc1b` |
| FASE 38 | DONE — XSS guards _escH en 8 interpolaciones coach · commit `470a261` |
| FASE 39 | DONE — Fix _buildCheckInData adherencia + rir_real_prom · commit `eb1a825` |
| FASE 40 | DONE — Optimizar O(n) scans restantes con LOGS_BY_WEEK · commits `4c2d6ab`+`a3c5fb8`+`ae5f79a` |
| FASE 41 | DONE — Fix ciICSSet shadowing (ics_promedio nunca calculaba) + null guard NaN carga · commit `96eb190` |
| FASE 42 | DONE — XSS coach: 11+ sitios e.message, displayName, coachId via data-attributes · commit `96eb190` |
| FASE 43 | DONE — Orphan listeners (_waitUnsubClientDoc/Plan), duplicate click-out handlers, dead code renderEmpty() · commit `0e53dd3` |
| FASE 44 | DONE — Consistencia REAL_WEEK en submitPostSession postsession_ key · commit `81faae5` |
| FASE 42b | DONE — XSS _escH en e.code|e.message del diagnóstico Firebase (3 sitios) · commit `69ae048` |
| FASE 45 | DONE — Learned State Activation v1 (topology + distribution) · commit `08313e9` |
| FASE 46 | MERGED — Exercise Learned State Activation v1 · main `099fd74` |
| Vercel | auto-deploy en push a main |
| FASE 35 | MERGED — Historical Data Scalability Discovery: reporte completo 28 puntos |
| FASE 36 | DONE (T1) — Log Rotation Architecture · commits `1e2a3ed`+`9833dc0` · Suite 1087/1087 PASS |

---

## Reglas de dominio vigentes

### Deload — REGLA CORREGIDA (2026-08-31)
**El deload en VDSEN es reactivo/contextual. NO existe deload de calendario.**

- ~~Semana 6 = deload automático~~ → INCORRECTO, no implementar
- El deload depende de: fatiga, caída de rendimiento, recuperación, readiness, dolor, adherencia, historial longitudinal
- No introducir ninguna lógica `currentWeek === 6 → deload` en ningún nuevo código

---

---

## FASE 36 — Log Rotation Architecture (DONE T1 · 2026-09-01)

**Objetivo:** Eliminar crecimiento indefinido de `logs/{uid}.entries` mediante rotación por mesociclo (`logs/{uid}/mesos/{planId}`), con transición backward-compatible.

**Baseline:** main `dd6e526` · Suite 1060/1060 PASS · Branch `claude/fase-36-log-rotation`  
**Resultado:** commits `1e2a3ed` (36A Gate) + `9833dc0` (36B T1) · Suite 1087/1087 PASS

---

### FASE 36A — planId Stability Gate

**Tipo:** READ-ONLY. Auditoría de todas las rutas de escritura y lectura de `logs/`.

#### Matrix de estabilidad de planId

| Ruta | Archivo | R/W | planId disponible | Fuente de planId | Estable | Puede ser null | Legacy | Safe for Rotation |
|------|---------|-----|-------------------|-----------------|---------|---------------|--------|-------------------|
| `_doSaveLogs` | cliente ~L8566 | W | ✓ | `ACTIVE_PLAN_ID` (global, asignado en `loadPlan` desde Firestore `clients/{uid}.activePlanId`) | ✓ | ✓ (sin plan asignado) | — | ✓ PASS |
| Plan changed flush (`if(planChanged)`) | cliente ~L1582 | W | ✓ | `ACTIVE_PLAN_ID` recién asignado antes del flush | ✓ | NO (sería bug) | — | ✓ PASS |
| Week-reset write (`_doSaveLogs` post plan-change) | cliente ~L1589 | W | ✓ | `ACTIVE_PLAN_ID` ya actualizado | ✓ | NO | — | ✓ PASS |
| `visibilitychange` flush (Safari) | cliente ~L3363 | W | ✓ | `ACTIVE_PLAN_ID` global, persiste durante sesión | ✓ | ✓ | — | ✓ PASS |
| `loadPlan` carga inicial de logs | cliente ~L1554 | R | ✓ | `activePlanId` obtenido de `clients/{uid}` antes de leer logs | ✓ | ✓ (sin plan) | — | ✓ PASS |
| `_refreshLogsFromFirestore` (background sync) | cliente ~L3326 | R | ⚠ PARCIAL | Lee `logs/{uid}` legacy — NO tiene `activePlanId` en scope | Depende de ACTIVE_PLAN_ID global | ✓ | — | ⚠ REQUIERE ATENCIÓN |
| `onSnapshot logs/{uid}` (cliente) | cliente ~L1690 | R (listener) | ⚠ PARCIAL | Escucha path `logs/{uid}` hardcodeado — no sabe de sub-path | Escucha el doc legacy | ✓ | — | ⚠ REQUIERE REDESIGN |
| `loadClientList` N×getDoc | coach ~L1833 | R | ✓ (no necesario) | Lee `logs/{uid}` por UID, no necesita planId | N/A | N/A | — | ✓ PASS (sin cambio needed) |
| Monitor `onSnapshot logs/{clientId}` | coach ~L3503 | R (listener) | ✓ (no necesario) | Escucha `logs/{uid}` del cliente seleccionado | N/A | N/A | — | ✓ PASS (sin cambio needed) |
| Coach: cambiar semana (`updateDoc`) | coach ~L3425 | W coach | ✓ (no necesario) | Escribe a `logs/{uid}` del cliente — no usa planId del coach | N/A | N/A | — | ✓ (scope fuera de rotation) |
| Coach: cerrar mesociclo (`updateDoc`) | coach ~L3490 | W coach | ✓ | `clientData.activePlanId` disponible en scope | ✓ | ✓ | — | ✓ PASS |
| `resetClientWeek` | coach ~L12952 | W coach | ✓ | Lee `clients/{clientId}.activePlanId` justo antes del write | ✓ | ✓ | — | ✓ PASS |
| `resetClientWeekKeepSessions` | coach ~L12985 | W coach | ✓ | Lee `clients/{clientId}.activePlanId` justo antes del write | ✓ | ✓ | — | ✓ PASS |
| `setClientWeekManual` | coach ~L12933 | W coach | — | Escribe solo `currentWeek` — sin planId | N/A | N/A | — | ✓ PASS (sin planId needed) |
| `mergeClients` | coach ~L2315 | W admin | — | Copia `logs/{uid}` completo — acción admin excepcional | N/A | N/A | — | ⚠ NOTA (ver abajo) |
| `repairClientUID` | coach ~L12782 | W admin | — | Copia `logs/{uid}` completo — acción admin excepcional | N/A | N/A | — | ⚠ NOTA (ver abajo) |
| `exportClientPDF` / `generateFullClientReport` | coach ~L3793 | R | — | Lee `logs/{uid}` por clientId | N/A | N/A | — | ✓ PASS (read-only, fallback ok) |
| `showClientDetail` / `loadClientDetail` | coach ~L1423 | R | — | Lee `logs/{uid}` por clientId | N/A | N/A | — | ✓ PASS |
| `loadBackupLogs` (localStorage) | cliente ~L8607 | R | ✓ | Backup ya incluye `planId` en payload | ✓ | ✓ | — | ✓ PASS |
| Dashboard coach `logsPromises` | coach ~L13088 | R | — | Lee `logs/{uid}` por clientId — no usa planId | N/A | N/A | — | ✓ PASS |

#### Análisis de rutas con bandera ⚠

**`onSnapshot(logs/{uid})`  (cliente ~L1690) — BLOQUEANTE:**
- El listener escucha `logs/{uid}` hardcodeado. En una arquitectura de sub-colección (`logs/{uid}/mesos/{planId}`), este listener no recibiría eventos de cambio del nuevo path.
- No puede reconfigurarse dinámicamente con el planId sin cancelar y re-suscribir el listener.
- El listener también actúa como sync multi-dispositivo: si el segundo dispositivo escribe al nuevo path, este listener no lo verá.
- **Para rotation correcta, el listener debe cambiarse a escuchar `logs/{uid}/mesos/{planId}`**, lo que requiere que `planId` sea conocido en el momento de configurar el listener (justo después de `loadPlan`).
- **Evaluación:** `ACTIVE_PLAN_ID` **está disponible** cuando se configura el listener (~L1690, dentro de `loadPlan`, después de L1551 donde se asigna `ACTIVE_PLAN_ID`). El planId ES estable en ese momento. ✓

**`_refreshLogsFromFirestore` (~L3326) — ATENCIÓN:**
- Lee `logs/{uid}` explícitamente — necesitaría leer del nuevo path.
- `ACTIVE_PLAN_ID` global está disponible como global en el momento en que se llama. ✓
- Requiere cambio de path pero la fuente de planId es estable.

**`mergeClients` y `repairClientUID` — NOTA:**
- Son acciones admin excepcionales que copian el documento `logs/{uid}` completo.
- Con rotation, estos también deberían copiar sub-colecciones — lo cual Firestore no permite con un `setDoc` simple de documento raíz.
- **Esta es una complejidad adicional real** para acciones admin. Se puede defer a FASE 36 si las acciones admin se actualizan o se documenta como limitación conocida.

#### Fuente de planId — trazabilidad completa

```
clients/{uid}.activePlanId  [Firestore — fuente de verdad]
    ↓ (loadPlan, ~L1379)
activePlanId [variable local en loadPlan]
    ↓ (asignación ~L1551)
ACTIVE_PLAN_ID [var global, persiste toda la sesión]
    ↓
_doSaveLogs → entries escritas en logs/{uid}
              (campo planId: ACTIVE_PLAN_ID guardado para detección de cambio)
```

**Invariantes verificados:**
- `ACTIVE_PLAN_ID` se asigna en `loadPlan` exactamente una vez, desde Firestore (`clients/{uid}.activePlanId`), antes de cualquier write de logs en la sesión.
- No depende de posición (di/ei), nombre, fecha ni inferencia.
- Persiste correctamente durante toda la sesión sin mutación.
- Al cambio de plan (`planChanged`), `ACTIVE_PLAN_ID` se actualiza ANTES del flush de logs limpios.
- El backup de localStorage incluye `planId: ACTIVE_PLAN_ID` — la restauración puede distinguir si el plan cambió entre sesiones.

#### Resultado del Gate

| Criterio | Estado |
|----------|--------|
| Toda ruta WRITE activa tiene planId estable | ✓ PASS |
| planId proviene de fuente persistente/confiable (Firestore `clients/{uid}`) | ✓ PASS |
| No depende de dayIndex/exerciseIndex | ✓ PASS |
| No depende de UI temporal | ✓ PASS |
| No se infiere por nombre | ✓ PASS |
| reload/relogin mantiene resolución correcta | ✓ PASS (planId re-obtenido desde Firestore en cada `loadPlan`) |
| Plan activo tiene identificación inequívoca | ✓ PASS (`activePlanId` = doc ID de Firestore) |
| Sesiones históricas pueden asociarse al plan | ✓ PASS (campo `planId` ya guardado en `logs/{uid}` desde FASE 33) |
| `onSnapshot` puede reconfigurarse con planId | ✓ PASS (`ACTIVE_PLAN_ID` disponible en scope al configurar el listener) |
| Complejidad admin (`mergeClients`, `repairUID`) | ⚠ LIMITACIÓN CONOCIDA — acción admin copia doc raíz, no sub-cols |

**VEREDICTO: GATE PASS ✓**

Todos los paths de escritura activos (cliente) tienen `ACTIVE_PLAN_ID` estable. El planId es un identificador real de Firestore, obtenido de `clients/{uid}.activePlanId`, sin inferencia ni posición. La rotation es arquitectónicamente segura.

La limitación de acciones admin (`mergeClients`, `repairClientUID`) se documenta como deuda conocida, no como bloqueante del Gate — son acciones excepcionales fuera del flujo de workout.

---

### FASE 36B — Implementación (DONE · commit `9833dc0`)

Gate PASS confirmado. T1 implementado y mergeado.

**Path objetivo:** `logs/{uid}/mesos/{planId}`  
**Estrategia:** dual-write T1 → new-write-only T2 → retirada T3

**Cambios aplicados:**
- `vdsen-cliente.html` `_doSaveLogs`: dual-write — escribe `logs/{uid}/mesos/{planId}` primero (no-fatal), legacy siempre.
- `vdsen-cliente.html` `loadPlan`: new-first read — intenta meso path, fallback a legacy.
- `firestore.rules`: sub-colección `mesos/{planId}` con mismas reglas de aislamiento.
- `vdsen-coach.html` `resetClientWeek` + `resetClientWeekKeepSessions`: dual-write reset.
- Tests F36-B a F36-N (27 tests nuevos). Suite: 1087/1087 PASS.

**Limitación conocida (no bloqueante):**
`mergeClients` y `repairClientUID` no copian sub-colecciones. Deuda admin diferida a T2.

**Retirement T2:** avanzar cuando ≥90% clientes con meso path, sin errores de fallback en logs.  
**Retirement T3:** new-write/read solo, legacy como histórico.

---

## FASE 35 — Historical Data Scalability Discovery (DONE · 2026-09-01)

**Tipo:** DISCOVERY puro — 0 cambios funcionales. Solo este documento modificado.  
**Objetivo:** Auditar la escalabilidad longitudinal del ecosistema, con foco en `logs/{uid}.entries`. Producir reporte de 28 puntos, opciones arquitectónicas y clasificación de urgencia para FASE 36.

---

### PUNTO 1 — Modelo actual de `logs/{uid}`

Un único documento Firestore por cliente, colección `logs`, ID = UID del cliente.

**Top-level campos:**
```
{
  entries:         { /* flat map COMPLETO de todos los registros */ },
  currentWeek:     number,          // REAL_WEEK (no la semana en vista)
  planId:          string | null,   // activePlanId al momento del último save
  exerciseUnits:   { [nombre]: unit },       // 'kg' | 'lb' por nombre de ejercicio
  exerciseHistory: { [nombre_lower]: { load, reps, rir, unit, updatedAt } },
  updatedAt:       number           // Date.now()
}
```

**Namespace de keys en `entries` (exhaustivo):**

| Patrón | Descripción | Cardinalidad por mesociclo |
|--------|-------------|--------------------------|
| `log_{W}_{D}_{E}_s{S}` | Dato de un set real o autoFilled | W×D×E×S (típico 6×4×6×4 = 576) |
| `done_{W}_{D}` | Sesión completada (boolean) | W×D (≤24) |
| `postsession_{W}_{D}` | Check-in post-sesión (EIMD, articular, sueño, RPE) | W×D (≤24) |
| `progrec_{W}_{D}` | Recomendaciones de progresión (objeto con recommendations[]) | W×D (≤24) |
| `ci_sem_{W}` | Check-in semanal (peso, HRV, WHO-5, etc.) | W (≤6) |
| `exmod_{W}_{D}_{E}` | Modificación de ejercicio en sesión | variable |
| `exseries_{W}_{D}_{E}_s{S}` | Tracking de series adicionales | variable |
| `ss_step_{W}_{D}_{grp}_r{R}_m{M}` | Estado de superserie | variable |
| `exexpress_{W}_{D}_{idx}` | Express data (workout rápido) | variable |
| `wearable_{W}_{D}` | Datos de wearable integrado | opcional |
| `engine_state` | Snapshot del motor de progresión | 1 por doc |
| `exnote_{W}_{D}_{E}` / `exnote_{D}_{E}` | Notas del cliente por ejercicio | variable |

**Total keys estimado por mesociclo (6 semanas, 4 días, 6 ejercicios, 4 series):**
- Contribución dominante: `log_*` = 576 keys
- Subtotal restante: ~100–150 keys
- **Total por mesociclo: ~700–800 keys**
- Todos los mesociclos se acumulan en el mismo flat map sin partición temporal

---

### PUNTO 2 — Operación de escritura (`_doSaveLogs`)

**Archivo:** `vdsen-cliente.html` ~L8556  
**Tipo:** `FB.setDoc(ref, { entries: _safeEntries, ... })` — **reemplaza el documento COMPLETO** en cada invocación.

```javascript
async function _doSaveLogs() {
  const _safeEntries = JSON.parse(JSON.stringify(LOGS || {}));     // deep-copy para sanear undefined
  const ref = FB.doc(FB.db, 'logs', USER.uid);
  await FB.setDoc(ref, {
    entries: _safeEntries, currentWeek: REAL_WEEK, planId: ACTIVE_PLAN_ID,
    exerciseUnits: _safeUnits, exerciseHistory: _safeHist, updatedAt: Date.now()
  });
}
```

**Triggers de escritura:** registrar set → copia de serie → toggle unidad → completar sesión → post-sesión → check-in → progresión → avance de semana.  
**Debounce:** 400 ms. Múltiples interacciones rápidas → 1 write.  
**Frecuencia real:** ~2–5 writes/minuto durante workout activo.  
**localStorage backup:** síncrono e inmediato antes del debounce (sin latencia de red).

---

### PUNTO 3 — Operaciones de lectura y su amplificación

| Ruta | Archivo | Función | Tipo | Doc completo | Frecuencia |
|------|---------|---------|------|-------------|------------|
| Carga inicial | cliente | `loadPlan` / startup | `getDoc` | ✓ | 1 vez por sesión |
| Sync multi-dispositivo | cliente | `onSnapshot logs/{uid}` | listener | ✓ por evento | Continuo (cada cambio) |
| Re-sync background | cliente | `_refreshLogsFromFirestore` | `getDoc` | ✓ | Al volver de background >30s |
| Lista de clientes | coach | `loadClientList` | `Promise.all(getDoc×N)` | ✓ por cliente | Cada refresh del coach |
| Monitor cliente | coach | `onSnapshot logs/{uid}` | listener | ✓ por evento | Continuo por cliente activo |
| Detalle cliente | coach | `showClientDetail` | `getDoc` | ✓ | Por click |
| Reporte PDF | coach | `generateFullClientReport` | `getDoc` | ✓ | Por demanda |
| Export PDF sesión | coach | `exportClientPDF` | `getDoc` | ✓ | Por demanda |

**Red amplification crítica — `loadClientList`:**  
Para N clientes: `N × getDoc(logs/{uid})` en paralelo. Con 10 clientes = 10 lecturas de documento completo. Con 50 clientes = 50 lecturas. Cada lectura = todo el historial de ese cliente (potencialmente 2 MB por cliente con años de datos).

---

### PUNTO 4 — Procesamiento full-scan de `entries`

Estas funciones iteran **todas** las keys del flat map en cada invocación:

| Función | Archivo | Operación | Complejidad | Contexto |
|---------|---------|-----------|------------|---------|
| `_mapLogs` (~L710) | coach | Clasifica cada key por regex, construye resumen | O(n) | `loadClientList`, `_renderMonitorForWeek` |
| `getClientAlert` (~L1122) | coach | Escanea todas las keys `log_*` buscando max timestamp | O(n) | `loadClientList` (×N clientes) |
| `isClientLiveTraining` (~L1615) | coach | Escanea todas las keys `log_*` buscando ts < 5min | O(n) | Tick periódico |
| `_computeClientAttentionState` | coach | Procesa entries completas | O(n) | `loadClientList` (×N clientes) |
| `aggregateClientLogs` | coach | Agrega estadísticas de todo el historial | O(n) | `generateFullClientReport` |
| `_getPrevWeekData` (~L13422) | cliente | `Object.keys(LOGS).forEach` para PID lookup | O(n) | `renderEntrenamiento` (por ejercicio) |
| `_getExposures` (~L12465) | cliente | `Object.keys(LOGS).forEach` para PID lookup | O(n) | Progression engine (por ejercicio) |
| `_getProgRecForExercise` | cliente | `Object.keys(LOGS).filter` por semana descendente | O(n) | `renderEntrenamiento` |

**Nota crítica:** `_mapLogs` ya tiene `sizeWarning: setCount > 500`. El equipo era consciente del límite antes de esta auditoría.

---

### PUNTO 5 — Límites de Firestore relevantes

| Límite | Valor | Relevancia |
|--------|-------|------------|
| Tamaño máximo de documento | **1 MB** | `logs/{uid}` puede excederlo con años de datos |
| Escritura máxima por documento | 1 write/s sostenido (burst mayor) | `_doSaveLogs` debounced 400ms = hasta 2.5/s en burst — posible throttle |
| Costos de lectura | 1 lectura por documento (no por key) | 50 clientes = 50 lecturas completas en `loadClientList` |
| `onSnapshot` — facturación | Cada cambio = 1 lectura de documento | Con 10 clientes monitoreados = 10 lecturas por cada set guardado por cualquiera |
| `update` vs `setDoc` | `update` puede afectar solo campos específicos | No se usa actualmente; se usa `setDoc` siempre |

---

### PUNTO 6 — Estimaciones de crecimiento

**Perfil LIGHT (3 días/semana, 5 ejercicios, 3 series, 4 semanas/mesociclo):**
- `log_*` keys por meso: 3×5×3×4 = 180
- Demás keys: ~60
- **Total por meso: ~240 keys** | bytes estimados: ~30 KB por mesociclo
- Acumulado 12 mesos (1 año): ~2.880 keys | ~360 KB — **por debajo del límite 1 MB**

**Perfil NORMAL (4 días/semana, 6 ejercicios, 4 series, 6 semanas/meso):**
- `log_*` keys por meso: 4×6×4×6 = 576
- Demás keys: ~150
- **Total por meso: ~726 keys** | bytes estimados: ~90 KB por mesociclo
- Acumulado 6 mesos (6 mesos): ~4.356 keys | ~540 KB — por debajo del límite
- Acumulado 12 mesos (12 mesos): ~8.712 keys | ~1.08 MB — **supera el límite de 1 MB**

**Perfil HIGH (5 días/semana, 8 ejercicios, 5 series, 6 semanas/meso, datos extra):**
- `log_*` keys por meso: 5×8×5×6 = 1.200
- Demás keys: ~200
- **Total por meso: ~1.400 keys** | bytes estimados: ~175 KB por mesociclo
- Acumulado 6 mesos: ~8.400 keys | ~1.05 MB — **supera el límite**
- Acumulado 12 mesos: ~16.800 keys | ~2.1 MB — muy por encima del límite

**Horizonte de riesgo:** cliente NORMAL a partir de ~10–11 meses; cliente HIGH a partir de ~5–6 mesos.

---

### PUNTO 7 — Hot / Warm / Cold data

| Categoría | Datos | Acceso actual | Frecuencia |
|-----------|-------|---------------|-----------|
| **HOT** | Semana actual (`log_{W}_*`, `done_{W}_*`, `postsession_{W}_*`, `progrec_{W}_*`, `ci_sem_{W}`) | Cada render de workout | Múltiple por sesión |
| **WARM** | Semana anterior (`log_{W-1}_*`) | `_getPrevWeekData`, progression engine | Por ejercicio en render |
| **WARM** | Últimas 5 semanas (`_getExposures` maxExposures=5) | Historial de exposiciones | Por ejercicio en render |
| **COLD** | Todo lo anterior a 5 semanas atrás | `aggregateClientLogs`, PDF report | Por demanda (raro) |
| **COLD** | `exerciseHistory` (nombre→última carga) | Lookup de última carga conocida | Occasional |

**Observación:** Solo HOT+WARM data (últimas 6 semanas) se necesita para el flujo de workout y progresión activos. COLD data (mesos anteriores) solo se usa en reportes y agregados PDF — acceso raro.

---

### PUNTO 8 — Listeners / cache audit

| Listener | Archivo | Colección | Cuándo se crea | Cuándo se destruye |
|----------|---------|-----------|---------------|-------------------|
| `onSnapshot(logs/{uid})` | cliente | `logs` | Login/loadPlan | Logout / `_monitorUnsub()` |
| `onSnapshot(logs/{clientId})` | coach-Monitor | `logs` | Al seleccionar cliente en Monitor | Cambio de cliente / cleanup FASE 33 |
| `onSnapshot(plans/{planId})` | coach-Monitor | `plans` | Al seleccionar cliente en Monitor | Cambio de plan / cleanup FASE 33 |
| `onSnapshot(clients)` | coach | `clients` | Login | Logout |

**`_activePlanCache`:** caché local del plan en el closure del Monitor coach. No se invalida explícitamente si el plan cambia entre sesiones — posible stale (aceptado, mitigado por `onSnapshot` de plans).

---

### PUNTO 9 — Opciones arquitectónicas (A–E)

#### Opción A — Status Quo (sin cambios)
- No se hace nada hasta que un cliente real alcance el límite
- **Pros:** cero deuda técnica nueva, cero riesgo de migración
- **Contras:** en ~10–11 meses para cliente NORMAL el documento deja de poder escribirse (`RESOURCE_EXHAUSTED`); error silencioso para el cliente salvo por el badge de error
- **Urgencia:** baja a corto plazo, bloqueante a mediano

#### Opción B — Rotation: un documento por mesociclo (`logs_{uid}_{planId}`)
- Cada mesociclo guarda en `logs_{uid}_{planId}` en lugar de `logs/{uid}`
- HOT: solo el meso activo. COLD: documentos anteriores bajo demanda
- **Pros:** tamaño acotado por design, reads de lista mucho más baratos
- **Contras:** migración de todos los documentos `logs/{uid}` existentes; cambios en loadPlan, progression engine, Monitor, reportes; complejidad de "plan cambiado mid-meso"
- **Urgencia:** candidata fuerte para FASE 36

#### Opción C — Sub-colección por semana (`logs/{uid}/weeks/{W}`)
- entries de cada semana en sub-docs independientes
- **Pros:** reads de semana actuales muy pequeños; histórico accesible individualmente
- **Contras:** migración; cambia el modelo de datos radicalmente; Coach necesitaría N reads para el reporte; `onSnapshot` individual por semana
- **Urgencia:** mayor complejidad que B, menor beneficio relativo

#### Opción D — Archivado periódico (prune cold data)
- Script/función que mueve entradas de mesos anteriores a `logs_archive/{uid}/{planId}` 
- `logs/{uid}` siempre contiene solo el meso activo + últimas 5 semanas warm
- **Pros:** no cambia el modelo de escritura; reads calientes se vuelven pequeños
- **Contras:** requiere función de archivado (Cloud Function o acción coach); mayor superficie de bugs en archivado; datos históricos fragmentados
- **Urgencia:** viable como solución temporal o complementaria a B

#### Opción E — Firestore `update` + campo diff en lugar de `setDoc` completo
- Cambiar `_doSaveLogs` a `FB.updateDoc(ref, { 'entries.log_W_D_E_s0': value, updatedAt: ... })`
- **Pros:** cada write solo envía el delta — reduce amplificación de escritura
- **Contras:** NO resuelve el límite de tamaño del documento; complejidad del diff tracking; Firestore no admite eliminación de campos individuales en nested objects con update simple
- **Urgencia:** mejora de performance de escritura, no soluciona el problema raíz

---

### PUNTO 10 — Estrategia de migración (discovery)

Para cualquier opción que implique cambio de schema:

**Sin migración = Opción A o D (parcial).** Para B o C se requiere:

1. **Escritura dual** durante transición: escribir tanto al schema nuevo como al viejo durante N semanas
2. **Lectura con fallback**: `loadPlan` intenta nuevo schema, cae a legacy
3. **Sin migraciones masivas**: no existe Cloud Functions en el proyecto actualmente; una migración masiva requeriría run manual o función ad-hoc; riesgo de timeout para clientes con muchos datos
4. **Invariantes a preservar durante migración**: deload reactivo, autoFilled excluido, POSITION ≠ IDENTITY, progrec.newLoad = sugerencia

**Recomendación:** cualquier cambio debe ser aditivo y backward-compatible durante al menos 2 mesociclos completos antes de deprecar el path legacy.

---

### PUNTO 11 — Compatibilidad hacia atrás

Todos los campos en `logs/{uid}` son leídos con `|| {}` o `|| []` o verificaciones de existencia. No hay lecturas que fallen si un campo no existe.

El schema de entries nunca se valida contra un schema formal — es tolerante a campos desconocidos. Un documento nuevo con schema distinto no rompe el código actual siempre que las keys conocidas estén presentes con su tipo esperado.

**Riesgo de ruptura backward compatibility = BAJO** para schema aditivo, MEDIO para schema sustractivo.

---

### PUNTO 12 — Impacto en reglas de seguridad Firestore (`firestore.rules`)

Las reglas actuales validan acceso por UID (`request.auth.uid === uid` para `logs/{uid}`). Un cambio a `logs_{uid}_{planId}` requeriría actualizar las reglas para el nuevo path. Sub-colecciones requieren reglas de sub-colección explícitas.

**Impacto:** MODERADO. Reglas actuales son simples; actualización es directa pero debe revisarse para que no queden paths sin protección.

---

### PUNTO 13 — Matriz de decisión

| Criterio | A (Status Quo) | B (Rotation) | C (Sub-col) | D (Archivado) | E (Update diff) |
|----------|---------------|-------------|------------|--------------|----------------|
| Riesgo doc overflow | ALTO (futuro) | BAJO | BAJO | BAJO | ALTO (futuro) |
| Complejidad impl | NINGUNA | MEDIA | ALTA | MEDIA | BAJA |
| Riesgo migración | NINGUNO | MEDIO | ALTO | BAJO | NINGUNO |
| Performance escritura | SIN CAMBIO | MEJOR | MEJOR | SIN CAMBIO | MEJOR |
| Performance lectura | SIN CAMBIO | MEJOR | MEJOR | MEJOR | SIN CAMBIO |
| Costo Firestore | SIN CAMBIO | MEJOR | SIMILAR | MEJOR | MEJOR |
| Backward compat | TOTAL | REQUIERE DUAL | REQUIERE DUAL | PARCIAL | TOTAL |
| **Recomendación** | Fallback temporal | **CANDIDATA FASE 36** | Deferred | Complementaria | Mejora puntual |

---

### PUNTO 14 — Clasificación de urgencia

| Escenario | Horizonte de riesgo | Acción recomendada |
|-----------|--------------------|--------------------|
| Cliente LIGHT (≤3 días, 5 ej, 3 series) | >24 meses | Monitorear; sin acción urgente |
| Cliente NORMAL (4 días, 6 ej, 4 series) | ~10–11 meses | Planificar Opción B en FASE 36 |
| Cliente HIGH (5 días, 8 ej, 5 series) | ~5–6 meses | Prioridad ALTA para FASE 36 |
| Coach con >20 clientes | Inmediato (performance) | `loadClientList` ya es costoso sin ser bloqueante |
| Error Firestore silencioso al overflow | Al alcanzar 1 MB | Badge de error ya existe; sin pérdida de datos (localStorage backup) |

**Urgencia global: MEDIA** — no es una emergencia para clientes actuales, pero es un bloqueante architectural confirmado para clientes con más de ~10 meses de uso continuo.

---

### PUNTO 15 — Hallazgos de performance CPU/DOM

- `_getPrevWeekData` y `_getExposures` iteran el flat map completo con `Object.keys(LOGS).forEach` — O(n) por ejercicio. Con 6 ejercicios/día y 1.000+ keys: ~6.000 iteraciones por render.
- `_mapLogs` en coach itera el mapa completo por cada cliente en `loadClientList` — con 20 clientes y 1.000 keys cada uno: 20.000 iteraciones en startup del coach.
- `getClientAlert` y `isClientLiveTraining` tienen el mismo patrón O(n) y se llaman en tick periódico.
- No se observa DOM thrashing significativo — render es event-driven, no polling DOM.
- **Recomendación:** construir índices en memoria al cargar los logs (e.g. `LOGS_BY_WEEK[W]`) para reducir O(n) a O(1) en las rutas calientes.

---

### PUNTO 16 — Resumen de hallazgos críticos (28 puntos resumidos en tabla)

| # | Hallazgo | Severidad | Tipo |
|---|---------|-----------|------|
| 1 | `logs/{uid}` = único doc, campo `entries` flat map acumulativo sin partición temporal | INFORMATIVO | Arquitectura |
| 2 | `_doSaveLogs` = `setDoc` completo (no diff) — carga útil crece con la historia | MEDIO | Performance escritura |
| 3 | Debounce 400ms mitiga frecuencia pero no tamaño del payload | MITIGACIÓN PARCIAL | Write path |
| 4 | localStorage backup síncrono — sin pérdida de datos en error de red | POSITIVO | Resiliencia |
| 5 | `onSnapshot logs/{uid}` cliente: full doc por evento de sync | INFORMATIVO | Read path |
| 6 | `loadClientList` coach: N `getDoc` paralelos al cargar la lista | MEDIO | Read amplification |
| 7 | Monitor coach: `onSnapshot logs/{clientId}` — full doc en tiempo real | INFORMATIVO | Listener |
| 8 | `_mapLogs` O(n) × N clientes en startup del coach | MEDIO | CPU coach |
| 9 | `getClientAlert` O(n) escanea todas las keys `log_*` por cliente | MEDIO | CPU coach |
| 10 | `isClientLiveTraining` O(n) en tick periódico | BAJO | CPU coach |
| 11 | `_getPrevWeekData` O(n) por ejercicio en render | BAJO | CPU cliente |
| 12 | `_getExposures` O(n) por ejercicio en render | BAJO | CPU cliente |
| 13 | `_mapLogs` ya tiene `sizeWarning: setCount > 500` — equipo consciente del riesgo | POSITIVO | Awareness |
| 14 | Cliente NORMAL supera 1 MB Firestore en ~10–11 meses de uso continuo | ALTO | Límite hard |
| 15 | Cliente HIGH supera 1 MB Firestore en ~5–6 meses | ALTO | Límite hard |
| 16 | Error al superar 1 MB = `RESOURCE_EXHAUSTED` — sin pérdida de datos (localStorage) | INFORMATIVO | Failure mode |
| 17 | Todos los mesos históricos acumulados sin TTL ni partición | ALTO | Arquitectura |
| 18 | Solo HOT (semana actual) + WARM (5 semanas anteriores) needed para workout activo | INFORMATIVO | Data access pattern |
| 19 | COLD data (mesos anteriores a 5 semanas) solo necesaria para reportes y PDF | INFORMATIVO | Data access pattern |
| 20 | Opción B (rotation por mesociclo) = mejor relación complejidad/beneficio | RECOMENDACIÓN | Arquitectura |
| 21 | Migración requiere escritura dual y fallback — sin Cloud Functions en proyecto | MEDIO | Migración |
| 22 | `firestore.rules` necesita actualización para nuevo path en Opción B | BAJO | Seguridad |
| 23 | `exerciseHistory` (nombre-keyed) crecimiento acotado — no es fuente de overflow | POSITIVO | Arquitectura |
| 24 | `exerciseUnits` (nombre→unit) crecimiento acotado — no es fuente de overflow | POSITIVO | Arquitectura |
| 25 | `engine_state` clave única — 1 entry por documento — no escala con tiempo | POSITIVO | Arquitectura |
| 26 | Índices en memoria (LOGS_BY_WEEK) eliminarían O(n) en rutas calientes | MEJORA | Performance |
| 27 | `_computeClientAttentionState` y sorting por estado atencion — O(n×N) en startup coach | MEDIO | CPU coach |
| 28 | Urgencia global = MEDIA; acción recomendada = Opción B en FASE 36 | RESUMEN | Decisión |

---

### Propuesta FASE 36 — Mesocycle Rotation

**Objetivo:** Implementar Opción B (rotation) sin migración masiva ni cambios de schema en el flow de lectura activo.

**Estrategia:**
1. **Nuevo path de escritura:** al crear/cambiar plan activo, `_doSaveLogs` escribe a `logs/{uid}/mesos/{planId}` en lugar de (o además de) `logs/{uid}`
2. **Escritura dual** durante período de transición (configurable): escribe a ambos paths
3. **Lectura con fallback:** `loadPlan` intenta `logs/{uid}/mesos/{activePlanId}`, cae a `logs/{uid}` legacy
4. **Índices en memoria:** construir `LOGS_BY_WEEK` en el `onSnapshot` handler para eliminar O(n) en rutas calientes
5. **Datos fríos bajo demanda:** `generateFullClientReport` lee mesos anteriores con un fetch separado y explícito
6. **Reglas Firestore:** actualizar para `logs/{uid}/mesos/{planId}`
7. **Backward compat:** `logs/{uid}` sigue siendo legible durante transición; sin migración de documentos existentes
8. **0 cambios en contrato de progresión**, deload, POSITION≠IDENTITY, autoFilled

**Alcance estimado:** 3–4 archivos (`vdsen-cliente.html`, `vdsen-coach.html`, `firestore.rules`, tests); ~2–3 días de desarrollo.

**Prioridad:** ALTA para clientes que ya llevan >6 meses de uso; MEDIA para clientes nuevos.

---

## FASE 34 — Legacy Identity Hardening (DONE)

**Objetivo:** Endurecer todas las rutas de identidad de ejercicios sin migraciones, backfill ni cambio de schema. Planes/logs históricos sin `prescriptionExerciseId` tratados de forma segura, explicable y no destructiva.

### Inventario de rutas de identidad

| Ruta | Archivo | Tipo | PID-first | Nombre-fallback | Unique-check | Position-fallback | Segura |
|------|---------|------|-----------|-----------------|--------------|-------------------|--------|
| `_getExposures` | cliente | READ | ✓ + dup guard | posicional c/ name guard | N/A | legacy aceptado | PARCIALMENTE SAFE |
| `EXERCISE_HISTORY` | cliente | READ/WRITE | N/A | name-keyed | N/A | NO | SAFE |
| `_getPrevWeekData` | cliente | READ | ✓ + dup guard | posicional c/ name guard | ✓ | legacy aceptado | PARCIALMENTE SAFE |
| `_resolveExerciseRowId` | coach | READ | ✓ | **único** (FASE 34) | ✓ (FASE 34) | NO | SAFE (post-fix) |
| `_resolveExerciseInFreshPlan` | coach | **WRITE** | ✓ | **único** (FASE 34) | ✓ (FASE 34) | **ELIMINADO** | SAFE (post-fix) |
| `_buildRecApplyPreview` | coach | READ | ✓ | único (pre-existente) | ✓ (matches≠1) | NO | SAFE |
| `_resolveMatchF26` / `_comparePlans` | coach | READ | ✓ | único | ✓ | NO | SAFE |
| `_stampPrescriptionIds` | coach | WRITE | ✓ preserva | N/A | ✓ (dedup) | NO | SAFE |
| `_restampPrescriptionIds` | coach | WRITE | N/A (fresh) | N/A | ✓ | NO | SAFE |

### Bugs corregidos

| Bug | Descripción | Tipo | Fix |
|-----|-------------|------|-----|
| **H-3** | `_resolveExerciseInFreshPlan`: positional fallback en path de ESCRITURA (apply loads) | CRÍTICO | Eliminado positional; agregado nombre-único; sin PID ni nombre → -1 |
| **G4** | `_resolveExerciseRowId`: nombre fallback retornaba PRIMER match sin verificar unicidad | READ | Colecta todos los matches; si >1 → null (AMBIGUOUS) |

### Cambios adicionales (soporte H-3)
- `_confirmApplyRecModal`: checkbox agrega `data-exname` (XSS-safe via `_escH`)
- `selected.push(...)`: incluye `exerciseName` junto con `exerciseIndex`, `recommendedLoad`, `prescriptionExerciseId`

### Tests agregados
17 nuevos tests (F34-A–J), suite total: **1060/1060 PASS**

| Caso | Cobertura |
|------|-----------|
| F34-A | PID exacto → índice correcto incluso si exerciseIndex difiere |
| F34-B | PID presente no encontrado → -1 (SKIP) |
| F34-C | Sin PID, nombre único → match por nombre |
| F34-D | Sin PID, nombre duplicado → AMBIGUOUS → -1 |
| F34-E | Sin PID y sin nombre → -1 |
| F34-F | exerciseIndex solo (sin PID ni nombre) → -1 (POSITION ≠ IDENTITY) |
| F34-G | `_resolveExerciseRowId34`: PID primario, nombre fallback único |
| F34-H | `_resolveExerciseRowId34`: nombre duplicado → null; PID correcto aun con dup → éxito |
| F34-I | `_resolveExerciseRowId34`: PID stale → degrada a nombre único (safe READ); PID stale + ambiguo → null |
| F34-J | autoFilled excluido de exposures |

### Invariantes preservados
- **POSITION ≠ IDENTITY**: Eliminado el único positional fallback en write path (H-3)
- **Deload = reactivo/contextual**: Sin tocar
- **autoFilled ≠ ejecución real**: Excluido en todas las rutas de historial
- **progrec.newLoad = sugerencia**: Sin mutación automática al plan

### Deferred (sin cambio en FASE 34)
- `_getExposures` / `_getPrevWeekData`: positional legacy con name guard — limitación aceptada para logs sin snapshot
- H-4, L-1, L-2, M-2: fuera de scope identity

---

## FASE 33 — End-to-End Integration Audit (DONE · commits `7a29aa6`+`f10c75f`)

**Auditoría end-to-end del circuito completo:** COACH→PLAN→SAVE→PID→CLIENT→WORKOUT→LOGS→POSTSESSION→CHECK-IN→PROGRESIÓN→MONITOR→APPLY LOADS→PLAN UPDATE→SIGUIENTE PRESCRIPCIÓN.

### Bugs corregidos (25 total, 2 batches)

#### Batch 1 — `7a29aa6`
| ID | Severidad | Descripción |
|----|-----------|-------------|
| PID gap | CRITICAL | `loadPlan` no mapeaba `prescriptionExerciseId` ni `exerciseId` desde Firestore → identidad de ejercicios perdida |
| Monitor re-render | MEDIUM | `_renderMonitorForWeek()` no se llamaba tras apply loads → UI stale |
| Double-click apply | MEDIUM | Botones "Aplicar" no tenían flag `disabled` → doble-write en Firestore |

#### Batch 2 — `7a29aa6` (mismo commit)
| ID | Severidad | Descripción |
|----|-----------|-------------|
| C-1 `_postSessionSubmitting` | MEDIUM | Flag stuck `true` tras fallo de validación EIMD → bloqueo permanente del modal |
| C-2 `markSessionDone` | MEDIUM | Sin re-entrancy guard → doble-tap abría 2 modales simultáneos |
| `_sesTimerInterval` stacking | MEDIUM | `setInterval` sin clear previo → múltiples ticks superpuestos en rest timer |
| E-1 `refreshLogs` | LOW | `renderResumen()` condicionado a `entriesChanged` (key-count) → ediciones in-place (mismo key) no re-renderizaban resumen |
| I-Co3 `loadClients` | MEDIUM | `ReferenceError: loadClients is not defined` → corregido a `loadClientList()` |
| BUG-4 `closeClientModal` | HIGH | Sin dirty guard → cerrar modal descartaba cambios sin aviso |
| BUG-5 `navClient` | HIGH | Sin dirty guard → navegar entre clientes descartaba cambios sin aviso |
| Monitor race condition | CRITICAL | `select.onchange` async sin generation counter → respuestas fuera de orden podían mezclar datos de dos clientes |
| M-3 AI draft PIDs | MEDIUM | `_vdsenSaveDraftToFirestore` no llamaba `_stampPrescriptionIds` → planes AI sin PIDs |
| BUG-7 `saveTrainingPlan` | LOW | Sin double-submit guard `_savingTrainingPlan` → escrituras duplicadas |
| L-3 `createdAt` type | LOW | 5 ocurrencias de `Date.now()` (number) → `new Date().toISOString()` (string) |
| I-Co2 Firestore leaks | MEDIUM | `_monitorUnsub`/`_monitorPlanUnsub`/`_fichasUnsub` no limpiados en logout → listeners huérfanos |
| I-C4 Rest timer reload | MEDIUM | Hard page reload interrumpía rest timer sin restaurar estado desde `localStorage` |

#### Batch 3 — `f10c75f`
| ID | Severidad | Descripción |
|----|-----------|-------------|
| J-5 scroll jarring | MEDIUM | `scrollIntoView({ behavior:'instant', block:'start' })` → `{ behavior:'smooth', block:'nearest' }` |
| J-4 z-index iOS | MEDIUM | `restTimerOverlay` z-index 200 → 9000; `timerPill` 201 → 9001; `padding-bottom: env(safe-area-inset-bottom)` |
| BUG-2 editor dirty | MEDIUM | `addExRow`/`removeExRow`/`addDayBlock`/daylabel input no llamaban `markEditorDirty()` |
| BUG-3 manual dirty | HIGH | Manual plan builder (8 mutaciones) nunca llamaba `markEditorDirty()` |
| BUG-1 showSection guard | MEDIUM | `showSection()` sin dirty guard para manual plan → salir de crearPlan sin advertencia |
| M-1 rirByWeek manual | MEDIUM | `saveManualPlan()` guardaba plan sin `rirByWeek` → cliente usaba fallback `rirSchemeForWeeks` genérico en cada render |
| M-4 rirByWeek AI draft | MEDIUM | `_vdsenSaveDraftToFirestore()` no incluía `rirByWeek` |
| M-5 rirByWeek template | MEDIUM | `_applyTemplateToClient()` no incluía `rirByWeek` |

### Bugs NO corregidos (deferred — bajo impacto o complejidad alta)

| ID | Severidad | Motivo de diferimiento |
|----|-----------|------------------------|
| BUG G4 | MEDIUM | Fallback posicional solo afecta planes legacy sin PIDs; todos los nuevos paths ya estampan PIDs |
| BUG H-3 | LOW | `_resolveExerciseInFreshPlan` positional fallback — solo legacy |
| BUG H-4 | LOW | Orphaned Promise si confirm modal abierto dos veces rápido |
| BUG L-1 | DEFERRED | `parsePlanText` hardcodea `weeks: 4` |
| BUG L-2 | DEFERRED | JSON en text import silenciosamente descartado |
| BUG M-2 | DEFERRED | `saveManualPlan` borra plan previo sin backup |

### Invariantes preservados
- 0 cambios de contrato de logs o planes
- Deload: reactivo/contextual (sin cambios)
- POSITION ≠ IDENTITY en todo momento
- `autoFilled` excluido de progresión, ICS real, RIR real
- Suite: **1043/1043 PASS** (P01–P426)

---

## FASES completadas

### FASE 27 — Missing Data Workflow (rama `claude/fase-27-missing-data`)
**Detección determinista y no-punitiva de datos faltantes en logs del cliente**

Archivos modificados:
- `vdsen-cliente.html` — `_detectMissingData` (pura), `_renderClientMissingHints`, banner en `renderResumen`
- `vdsen-coach.html` — `_detectMissingData` (pura), `_renderCoachMissingData`, sección en `_renderMonitorForWeek`
- `tests/progression-engine.test.js` — P405-P423 (19 tests, 27 assertions)

Tipos implementados:
| Tipo | Severidad | Auto-emitido |
|------|-----------|--------------|
| MISSING_RIR | attention | ✓ |
| MISSING_ICS | attention | ✓ |
| PARTIAL_SESSION | info | ✓ |
| MISSING_POSTSESSION | info | ✓ |
| MISSING_CHECKIN | info | ✓ |
| INSUFFICIENT_EXPOSURE | — | ✗ NEEDS_FUTURE_RULE |

Semánticas críticas (no interpretar como evaluación de adherencia):
- **PARTIAL_SESSION** = estado de datos incompletos (series sin cierre de sesión). NO es señal automática de mala adherencia del cliente. El coach evalúa contexto.
- **MISSING_CHECKIN** usa `totalRealSets > 0` como criterio operacional para considerar la semana iniciada. `totalRealSets` excluye `autoFilled`. No es evaluación de adherencia — es la condición mínima de actividad para que un check-in sea relevante.

Reglas de implementación:
- `autoFilled: true` excluido de MISSING_RIR, MISSING_ICS, PARTIAL_SESSION y `totalRealSets`
- `rir_real` = RIR real canónico (0–5); `rir` = target prescrito (no leído por el motor)
- ICS válido: 1–10 (fuera de rango → MISSING_ICS)
- 0 nuevas Firestore reads / 0 listeners / 0 polling
- POSITION ≠ IDENTITY (sin cambios en identidad de ejercicios)
- INSUFFICIENT_EXPOSURE: tipo soportado, NO auto-emitido (NEEDS_FUTURE_RULE)
- Deload: reactivo/contextual únicamente (sin cambios)

Commit: `769666c` · 2026-09-01

---

### FASE 29 — Legacy Identity Display (rama `claude/fase-29-legacy-identity-display` — MERGED `088eb3f`)

**Discovery:** 2026-09-01. **Implementación:** 2026-09-01.

**Gap corregido:**
- `_renderMonitorForWeek` (coach) — columna "última acción" del panel de rendimiento por ejercicio.
- Antes: `lastRec.recommendations[ei]` (posicional) como lookup primario; `name-match` como fallback.
- Después: solo `name-match` (`r.exerciseName.toLowerCase().trim() === exLower`).
- Impacto: solo display. 0 writes, 0 Firestore reads.

Archivos modificados:
- `vdsen-coach.html` — eliminadas 4 líneas del bloque `if/else` posicional (líneas ~3159-3165)
- `tests/progression-engine.test.js` — P424–P426 (7 assertions nuevas)

Tests:
| Test | Escenario | Resultado |
|------|-----------|-----------|
| P424 | Ejercicios reordenados post-progrec | name-match ignora posición; cada nombre resuelve su propia acción |
| P425 | Nombre presente (incl. case-insensitive, espacios) | acción correcta devuelta |
| P426 | Sin match / lastRec null / lastRec sin recommendations | "—" (sin acción inventada) |

Invariantes preservados:
- 0 Firestore reads/listeners/polling
- 0 cambios de contrato
- 0 migración
- Deload: reactivo/contextual (sin cambios)
- POSITION ≠ IDENTITY (gap eliminado)

Suite: **1043/1043 PASS** (P01–P426). Commit: `088eb3f` · 2026-09-01

---

### FASE 30 — Performance: reads filtrados + preloaded data + onSnapshot Monitor (rama `claude/fase-30-performance` — MERGED `06c3ef9`)

**Tres fixes independientes de performance/consistencia en la app coach:**

**A. `loadClientList()` — eliminar read no filtrado**
- Antes: `getDocs(collection(db,"clients"))` leía TODOS los clientes sin filtro (N lecturas globales)
- Después: solo `where("coachId","==",currentCoach.uid)` — read acotado al coach activo
- Eliminada detección de "legacy unassigned clients" (requería read global; movida a acción admin explícita)

**B. `loadDashboard(preloaded=null)` — compartir datos entre loadClientList y dashboard**
- Antes: `loadClientList()` + `loadDashboard()` ejecutaban N×2 reads independientes en startup
- Después: `loadClientList()` pasa sus datos ya cargados a `loadDashboard({ clients, logsMap, planMap })` — 0 reads extra en startup
- `loadDashboard()` sigue funcionando standalone (sin preloaded) cuando el usuario navega al tab directamente

**C. Monitor — `onSnapshot(plans/{activePlanId})`**
- Antes: `_activePlanCache` era un getDoc one-shot → stale si el coach editaba el plan en otra pestaña
- Después: `onSnapshot` reactivo en el plan activo del cliente seleccionado; re-renders `_renderMonitorForWeek` en cada cambio
- Unsub gestionado en `select.onchange` y en cleanup de cliente seleccionado

Archivos: `vdsen-coach.html`. Suite: 1043/1043. Commit: `06c3ef9` · 2026-09-01

---

### FASE 31 — UX Coach App (rama `claude/fase-31-ux-coach` — MERGED `17e1b00`)

**Mejoras visuales en Monitor y editor de plan:**

**Monitor — recommendation cards**
- Borde izquierdo coloreado por tipo de acción (dominant visual signal)
- Chip semi-transparente con borde del color del tipo
- Botón "↑ Aplicar" individual por recomendación (solo para load actions)
- Header con contador ↑/↓/= compacto

**Monitor — wiring del apply individual**
- `._mon-apply-single` con `data-recidx` → `fakeRec = { recommendations: [rec] }` → `_applyRecLoadsToMonitor`

**Editor de plan — `_updateDirtyTabUI` extendido**
- `saveManualPlanBtn`: orange + texto urgente cuando dirty; default cuando clean
- `markEditorClean()` llamado tras `saveManualPlan()` exitoso

Archivos: `vdsen-coach.html`. Suite: 1043/1043. Commit: `17e1b00` · 2026-09-01

---

### FASE 32 — UX Cliente (rama `claude/fase-32-ux-cliente` — MERGED `1975fd8`)

**Mejoras de interacción en la app cliente:**

**Touch targets**
- `.ws-btn`: `min-height:44px` + `display:inline-flex;align-items:center;justify-content:center`
- Pump buttons (renderer nuevo): `min-height:40px`

**Feedback visual set completado**
- `@keyframes setDone`: extendida a `0.7s`, añadido scale pulse `1.01 → 1.0`
- `completeSet()`: `setTimeout` aplica animación al `setrow_${key}` tras `_refreshExPanelOnly()`

**Rest timer ring — fix gradient**
- `_updateRestRing()`: `url(#rg1)` → `#C4FF00` directo (el gradiente era monochromático; la referencia rompía en el overlay fallback)

Archivos: `vdsen-cliente.html`. Suite: 1043/1043. Commit: `1975fd8` · 2026-09-01

---

### FASE 26 — Coach Plan Comparison / Current vs Previous Prescription (rama `claude/client-app-improvements-qayy4n`)
**Herramienta READ-ONLY para el coach: comparar plan actual vs prescripción anterior**

Archivos modificados:
- `vdsen-coach.html` — 4 edits: state var `_detailPrevPlanData`, reset en `showClientDetail`, sección HTML `#planCompareSection`, bloque de funciones FASE 26
- `tests/progression-engine.test.js` — P378-P399 (22 test cases, 36 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

**Funciones puras (XSS-safe, 0 lecturas Firestore extra al abrir modal):**
- `_normNameF26(s)` — normalización de nombre: lower, sin tildes, sin especiales, trim
- `_buildExMap26(days)` — indexa ejercicios por `prescriptionExerciseId` (PID) y por nombre normalizado
- `_resolveMatchF26(prevEx, curMap, prevMap)` — PID primario; nombre único en ambos planes como fallback; null si ambiguo (duplicado en alguno)
- `_compareExSets26(curEx, prevEx, exName, pid, di)` — diffs por set: LOAD_CHANGED, RIR_CHANGED, REST_CHANGED, SETS_CHANGED
- `_comparePlans(curPlan, prevPlan)` — función principal pura; emite ADDED, REMOVED + diffs de sets
- `_renderPlanComparison(diffs, container)` — renderer DOM (textContent, XSS-safe)
- `_togglePlanCompare(clientId)` — async toggle; lazy load de `plans_backup` en primer click; JS sort por `backedUpAt`

**Diff types soportados:** ADDED, REMOVED, LOAD_CHANGED, SETS_CHANGED, RIR_CHANGED, REST_CHANGED (EXERCISE_REPLACED reservado, nunca auto-inferido)

**Invariantes:** POSITION ≠ IDENTITY · nombre duplicado en cualquier plan → ambigüedad → REMOVED+ADDED · `plan.sets[].load` únicamente, nunca `logs.carga` · sin new Firestore reads al abrir modal

---

### FASE 25 — Client Workout / Next Action UX (MERGED `cbb5691`)
**Resolver determinista de siguiente acción en workout + hint contextual en rest timer**

Archivos modificados:
- `vdsen-cliente.html` — 5 parches quirúrgicos
- `tests/progression-engine.test.js` — P351-P370 (35 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

**`_resolveNextWorkoutAction(di, exercises, lastEi, lastSi, logs, currentWeek, totalWeeks)`**
- Función pura, sin I/O, sin lecturas Firestore adicionales
- Devuelve `{ type, label }` con tipo: `SUPERSET_PARTNER` → `NEXT_SET` → `NEXT_EXERCISE` → `SESSION_DONE` → `NONE`
- Prioridad exacta: partner SS primero; mismo ejercicio; ejercicio siguiente activo; sesión completa
- Omite ejercicios donde `isTechniqueActive = false` o `getEffectiveSets = []`

**`_renderNextWorkoutAction(action)`**
- Renderiza en `#nextActionHint` (overlay full-screen) y `#nextActionHintCompact` (overlay compacto)
- Usa `textContent` exclusivamente — XSS-safe
- Oculta el hint si `type === 'NONE'`

**Integración rest timer**
- `startRestTimer` → llamada inmediata a `_renderNextWorkoutAction` en `completeSet`
- `stopRestTimer` → limpia ambos hints vía `textContent = ''`
- 0 nuevas colecciones Firestore, 0 nuevos listeners, 0 polling

**Tests P351-P370**: 20 casos (35 assertions) — resolver puro: NONE, NEXT_SET, NEXT_EXERCISE, SESSION_DONE, SUPERSET_PARTNER, prioridades, idempotencia, currentWeek, di, stubs isTechniqueActive/getEffectiveSets

**Tests P371-P377 (Audit Fix)**: 7 casos (18 assertions) — integración `completeSet`: SUPERSET_PARTNER se renderiza antes del early return, autoFilled no dispara render, restTime=0 renderiza NEXT_SET/NEXT_EXERCISE/SESSION_DONE, restTime>0 mantiene timer + hint, partner + timer lógico → no timer real

---

### AUDIT FIX 22/23/24 (rama `claude/client-app-improvements-qayy4n`)
**Correcciones post-audit sobre FASEs 22, 23, 24**

Archivos modificados:
- `vdsen-coach.html` — 4 parches quirúrgicos
- `tests/progression-engine.test.js` — P331-P350 (36 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

**FIX MEDIUM — FASE 22: `_resolveExerciseRowId` prefiere PID**
- Firma ampliada: `_resolveExerciseRowId(exerciseName, planCache, pid?)`
- Si `pid` provisto → búsqueda primaria por `prescriptionExerciseId` en todo el plan
- Si no encontrado por PID (o pid vacío/null) → fallback al nombre normalizado (comportamiento legacy)
- Botón ✏️ del Monitor ahora emite `data-expid` con el PID resuelto desde `_activePlanCache.days[lastRecDay]` en tiempo de render
- `_deepLinkToExercise(exerciseName, pid?)` acepta PID opcional y lo pasa a `_resolveExerciseRowId`
- Tests P331-P340: 10 casos (duplicado por nombre, PID exacto, PID vacío, PID bogus, fallback legacy)

**FIX HIGH — FASE 23: `_discardEditorChanges()` explícito**
- Nueva función `_discardEditorChanges()` — reconstruye `#training-editor` desde `_detailPlanData.days` vía `renderTrainingEditor`
- `_switchClientTab`: al confirmar abandono llama `_discardEditorChanges()` ANTES de `markEditorClean()`
- El discard es ahora explícito e inmediato, no implícito en el siguiente render del tab Plan
- Tests P341-P350: 10 casos de regresión (secuencia dirty→discard→clean, invariante triple condición, flujo completo)

**FASE 24 integration:** sin cambios adicionales (pasó el audit; integración correcta verificada por tests)

Suite: **908/908 PASS** (P01–P350)

---

### FASE 24 (rama `claude/fase-24-dirty-plan-indicator` — MERGED en main `950434e`)
**Dirty Plan Indicator — indicador visual ● en tab Plan cuando hay cambios sin guardar**

Archivos modificados:
- `vdsen-coach.html` — 4 parches quirúrgicos
- `tests/progression-engine.test.js` — P321-P330 (16 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

Helpers añadidos:

**`_planTabLabel(isDirty, baseLabel?)`** — puro, exportado en `window`  
- Retorna `baseLabel + ' ●'` si `isDirty === true`, de lo contrario `baseLabel`  
- Fallback: `'🏋️ Plan'` si `baseLabel` es vacío/null

**`_updateDirtyTabUI(isDirty)`** — DOM function, exportada en `window`  
- Busca `#dirtyPlanDot` y alterna su atributo `hidden`  
- 0 reads Firestore · seguro si el elemento no existe

Cambios UI:
- `ctab_plan` button ahora contiene `<span id="dirtyPlanDot" hidden>●</span>` (naranja)
- `markEditorDirty()` y `markEditorClean()` llaman `_updateDirtyTabUI` automáticamente
- `showClientDetail()` llama `markEditorClean()` al abrir nuevo cliente (reset de estado)

Invariantes preservados:
- `_dirtyEditor` y `markEditorClean/Dirty` ya existían — sin nueva infraestructura
- 0 reads Firestore nuevos
- Sin cambios en algoritmos de progresión

Suite: **872/872 PASS** (P01–P330)

---

### FASE 23 (rama `claude/fase-23-unsaved-changes-guard` — MERGED en main `ce276ee`)
**Unsaved Changes Guard — aviso al cambiar de tab con plan sin guardar**

Archivos modificados:
- `vdsen-coach.html` — 1 parche quirúrgico
- `tests/progression-engine.test.js` — P311-P320 (10 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

Helpers añadidos:

**`_shouldWarnDirtyLeave(fromTab, toTab, isDirty)`** — puro, exportado en `window`  
- Retorna `true` solo si `isDirty === true && fromTab === 'plan' && toTab !== 'plan'`  
- 0 reads Firestore · no tiene side effects

Cambio UI:
- `_switchClientTab` ahora es `async` y usa `_shouldWarnDirtyLeave` antes de cambiar
- Si el usuario está en tab Plan con cambios pendientes y cambia a otro tab → modal `_askConfirm` "¿Salir sin guardar?"
- Si cancela: permanece en Plan. Si confirma: `markEditorClean()` + switch
- `beforeunload` guard (ya existente desde antes) se mantiene intacto para recarga/cierre

Invariantes preservados:
- `calculateProgression` sin cambios
- `_dirtyEditor` y `markEditorClean` ya existían — solo se usa, no se crea infraestructura nueva
- 0 reads Firestore nuevos

Suite: **856/856 PASS** (P01–P320)

---

### FASE 22 (rama `claude/fase-22-monitor-editor-deeplink` — MERGED en main `e49dfe3`)
**Coach Monitor → Plan Editor Deep Link — botón ✏️ por ejercicio en Monitor**

Archivos modificados:
- `vdsen-coach.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P301-P310 (21 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

Helpers añadidos:

**`_resolveExerciseRowId(exerciseName, planCache, pid?)`** — puro, exportado en `window`  
- Input: nombre de ejercicio + `_activePlanCache` + PID opcional (ver Audit Fix)
- Input original: nombre de ejercicio + `_activePlanCache`  
- Output: `{ di, ei, pid }` o `null`  
- Normalización: lowercase + trim + colapso de espacios (igual que `_normN20`)  
- 0 reads Firestore · no muta planCache

**`_deepLinkToExercise(exerciseName)`** — DOM function, exportada en `window`  
- Llama `_switchClientTab('plan')` → abre training-editor si cerrado → scroll+highlight de la fila  
- Highlight: `outline: 2px solid #44BB88` por 2 s  
- Fallback: si no resuelve `prescriptionExerciseId`, usa `exrow_${di}_${ei}`

Cambio UI:
- Cada tarjeta de recomendación en Monitor ahora tiene botón ✏️ en la cabecera (junto al badge de acción)
- Atributo `data-exname` en el botón para evitar inyección JS (XSS-safe)

Invariantes preservados:
- 0 reads Firestore nuevos
- `calculateProgression` sin cambios
- Load semantics intacto
- Sin cambios en claves de logs

Suite: **846/846 PASS** (P01–P310)

---

### FASE 21 (merge commit `b4e4a91` — MERGED a main)
**Coach Monitor: Plan Change Preview — vista de cambios antes de confirmar aplicación de cargas**

Archivos modificados:
- `vdsen-coach.html` — 3 parches quirúrgicos
- `tests/progression-engine.test.js` — P290-P300 (30 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

Helpers añadidos:

**`_buildPlanChangeSummary(preview, selectedPids?)`** — puro, exportado en `window`  
- Input: array de preview entries + opcional array de IDs seleccionadas (pid || String(ei))  
- Output: `{ exerciseCount, setCount, changes }` — sin mutar el preview  
- Usado por el modal para header dinámico y por los tests

Cambios en **`_buildRecApplyPreview`** (extensión quirúrgica):
- `setCount`: número real de sets del ejercicio en el plan  
- `mixedCurrentLoads`: `true` si distintos sets tienen cargas diferentes  
- `unit`: primera unidad encontrada en sets del plan (`null` si no existe)  
- Filtro no-op: si `!mixedCurrentLoads && currentLoad === recommendedLoad` → excluida  

Cambios en **`_confirmApplyRecModal`** (reemplazo quirúrgico):
- Header "REVISAR CAMBIOS" + resumen dinámico (`N ejercicios cambiarán · M sets afectados`)  
- Resumen se actualiza en tiempo real al desmarcar checkboxes (`change` event)  
- Cada fila muestra: nombre ejercicio / carga actual → carga propuesta / N sets  
- Cargas mixtas: muestra "Variable → 85" (no oculta complejidad)  
- Unidades: muestra `kg`/`lb` si existe en el plan; si no, solo número  
- Botones: "Confirmar cambios" / "Cancelar"  
- Todo el contenido dinámico escapado con `_escH()`  

Performance:
- Preview: 0 lecturas Firestore  
- Confirmación: mantiene 1 fresh read existente de FASE 20  
- 0 listeners extras, 0 polling  

Invariantes preservados:
- `calculateProgression()` SIN CAMBIOS  
- FASE 20 identity contract (LEGACY/AMBIGUOUS/NONE) intacto  
- FASE 20 race guard (fresh read antes del write) intacto  
- Filtro de acciones (solo increase_load/reduce_load) intacto  
- Set preservation (Object.assign) intacto  
- 0 nuevas colecciones Firestore  
- Schema vdsen-plan-v2 sin cambios  
- Auth sin cambios  

Limitaciones:
- `unit` toma el valor del primer set con unidad en el plan; sets con unidades mixtas no son comunes pero no se validan
- Nombres de ejercicio muy largos se truncan con `text-overflow:ellipsis` en el modal

---

### FASE 20 (merge commit `0d4be7c` — MERGED a main)
**Coach Monitor: Aplicar cargas recomendadas al plan activo (hardened)**

Archivos modificados:
- `vdsen-coach.html` — 4 parches quirúrgicos (hardening)
- `tests/progression-engine.test.js` — P269-P289 (57 assertions nuevas)
- `docs/CONTEXTO_GENERADOR.md` — sección 5 Load Semantics (contrato formal)
- `docs/VDSEN_DEV_STATE.md` — este bloque

#### Contrato de identidad (identity contract)

| Nivel | Condición | Resultado |
|-------|-----------|-----------|
| LEGACY | nombre normalizado, coincidencia ÚNICA en el día | incluida; extrae `prescriptionExerciseId` del plan |
| AMBIGUOUS | 2+ ejercicios con mismo nombre en el día | excluida, sin aplicar |
| NONE | 0 coincidencias de nombre | excluida |
| HIGH (futuro) | `prescriptionExerciseId` directo en recomendación | no implementado aún — `calculateProgression` SIN CAMBIOS |

Nota: `calculateProgression` no emite `prescriptionExerciseId` en sus recomendaciones (congelado). El matching actual es siempre LEGACY: nombre → plan exercise → extrae ID del plan exercise como ancla.

#### Contrato de load semantics

Formalizado en `docs/CONTEXTO_GENERADOR.md` sección 5:
- `plan.sets[].load` = carga prescrita vigente, modificable SOLO por acción explícita del Coach
- `logs.carga` = carga real ejecutada — nunca toca el plan
- `progrec.newLoad` = sugerencia del Engine — no vinculante, nunca auto-aplicada

#### Guard de race condition (fresh-read)

Antes de `updateDoc`, se re-lee el plan desde Firestore. Para cada selección confirmada:
- Si `sel.prescriptionExerciseId` existe → re-busca por ID en plan fresco; si no está → SKIP
- Si no hay ID → fallback posicional; si índice fuera de rango → SKIP
Implementado en `_resolveExerciseInFreshPlan(sel, freshDayExercises)`.

#### Filter de acciones

Solo `increase_load` y `reduce_load` pueden mutar `plan.sets[].load`.  
`maintain`, `freeze_load`, `add_sets`, `reduce_sets`, `deload`, `progress_reps` → excluidas del preview.

#### Preservación de sets

`Object.assign({}, s, { load: match.recommendedLoad })` — solo `load` cambia.  
`repsTarget`, `rirTarget`, `restSeconds`, `setIndex` preservados intactos.

Invariantes preservados:
- `calculateProgression()` SIN CAMBIOS
- 0 nuevas colecciones Firestore
- Schema `vdsen-plan-v2` sin cambios
- Claves de logs sin cambios
- `_classifyBlocks`, `parsePlanFromJSON`, `_normalizeTrainingPlan` sin tocar
- Auth sin cambios
- Single-coach permanente

---

### FASE 19 (merge commit `4575a7c` — MERGED a main)
**Client Post-Session: Resumen de recomendaciones de progresión en el overlay de sesión completa**

Archivos modificados:
- `vdsen-cliente.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P261-P268 (28 assertions nuevas)

Helper puro añadido (exportado como `window._buildProgreSummaryHtml`):
- `_buildProgreSummaryHtml(progrec)` — genera HTML del resumen de recomendaciones post-sesión. Retorna `''` si progrec es null/undefined o si no tiene recommendations ni deloadTriggers. XSS-safe via `_escHTml`. Formatea newLoad: entero sin decimales, decimal con 1 decimal. Muestra deloadTriggers si presentes. No muta el input.

Punto de inserción en `vdsen-cliente.html`:
- `_buildProgreSummaryHtml` insertado después de `_coachNoteHtml` (línea ~12464)
- En `showSessionSummary(di)`: lee `LOGS['progrec_'+CURRENT_WEEK+'_'+di]` (ya calculado por `submitPostSession` antes de llamar a esta función), genera HTML de recomendaciones, lo añade al overlay. Si hay recomendaciones: elimina el auto-dismiss de 8s (el cliente puede leerlas sin presión de tiempo; cierra con ×).

Flujo de datos (ya existía — solo faltaba el display post-sesión):
```
submitPostSession()
  → calculateProgression(di, postData) → LOGS['progrec_W_D']
  → _confirmSessionDone(di)
  → showSessionSummary(di) → _buildProgreSummaryHtml(LOGS['progrec_W_D']) → overlay
```

Invariantes preservados:
- 0 nuevas lecturas Firestore
- `_buildProgreSummaryHtml` pura (determinista, sin side effects)
- XSS: usa `_escHTml`
- No modifica el progrec existente ni el schema
- No duplica la lógica del "block HOY" (`_buildSessionTargetBanner`) — esa muestra el objetivo por ejercicio ANTES de la sesión; esta muestra el resumen de acciones DESPUÉS de completarla
- Schema vdsen-plan-v2 sin cambios
- Colecciones Firestore sin cambios
- Progression Engine sin cambios
- Auth sin cambios

Limitaciones:
- Auto-dismiss eliminado solo cuando hay recomendaciones; si no hay progrec (primera sesión sin historial previo) el overlay mantiene el dismiss de 8s
- Nombre del ejercicio puede truncarse con text-overflow en nombres muy largos (legibilidad en móvil)

---

### FASE 18 (merge commit `e8c91c2` — MERGED a main)
**Client Workout: Notas del coach visibles durante el entrenamiento**

Archivos modificados:
- `vdsen-cliente.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P253-P260 (22 assertions nuevas)

Helper puro añadido (exportado como `window._coachNoteHtml`):
- `_coachNoteHtml(note)` — genera HTML del banner de nota del coach. Retorna `''` si `note` es null/undefined/blank. Escapa XSS con `_escHTml`. Preserva saltos de línea via `white-space:pre-line`. Visual: borde izquierdo azul, label "NOTA DEL COACH" en caps, texto multilinea.

Punto de inserción en `vdsen-cliente.html`:
- Llamada a `_coachNoteHtml(ej.coachNote)` en `_exRowHtml`, después del bloque `_exNoteInline` y antes del badge Y3T

Flujo de datos (ya existía — solo faltaba el display):
```
plan.exercises[].coachNote
  → loadPlan (líneas 1429, 1439: coachNote: e.coachNote || '')
  → ej.coachNote en el render
  → _coachNoteHtml(ej.coachNote) → HTML inline durante workout
```

Invariantes preservados:
- 0 nuevas lecturas Firestore
- `_coachNoteHtml` pura (determinista, sin side effects)
- XSS: usa `_escHTml` (escaper correcto en cliente)
- `coachNote` es readonly para el cliente (inmutable durante sesión)
- Schema vdsen-plan-v2 sin cambios — `coachNote` ya era campo del editor del coach (FASE 10)
- Colecciones Firestore sin cambios
- Progression Engine sin cambios
- Auth sin cambios

Limitaciones:
- Banner solo visible si el coach guardó nota en el editor de ejercicios
- Sin truncado de notas largas (se muestra íntegra con scroll de página)

---

### FASE 17 (merge commit `604894c` — MERGED a main)
**Coach Monitor: Exportación CSV operativa por cliente**

Archivos modificados:
- `vdsen-coach.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P238-P251 (78 assertions nuevas)

Helpers puros añadidos (exportados en `window`):
- `_escapeCsvCell(value)` — RFC4180 + neutralización de formula injection (`=`, `+`, `-`, `@`)
- `_safeExportFilename(name, date)` — sanitiza nombre del cliente, formato `vdsen_<name>_<YYYY-MM-DD>.csv`
- `_normalizeTimestamp(ts)` — acepta Date, ms, ISO string, Firestore Timestamp stub; devuelve ISO string o ''
- `_buildPlanLookup(planData)` — construye `{byPrescId, byPos}` para resolución de nombres
- `_resolveExerciseName(entry, di, ei, lookup)` — tres niveles: `exerciseNameSnapshot` → `byPrescId` → `byPos`
- `_buildOperationalExportRows(entries, planData)` — construye array de filas con `recordType` (SET/POSTSESSION/CHECKIN/PROGRESSION), ordena por week → day → typeOrder → setIndex
- `_toCsvString(rows, columns)` — genera CSV RFC4180 con BOM (`﻿`) para Excel
- `exportClientCsv(clientData, logs, planData)` — orquesta descarga; muestra toast si sin datos o error

UI añadida:
- Botón `⬇ Exportar CSV` en Monitor (a la derecha de "Ver plan"), aparece con el cliente activo
- 0 Firestore reads; usa `_activePlanCache` existente
- `autoFilled` exportado como flag `true/false` (no excluido — trazabilidad de auditoría)

Columnas CSV (25):
`recordType, week, day, exerciseName, prescriptionExerciseId, setIndex, load, unit, reps, rir_real, ics, pump, autoFilled, done, weight, hrv, who5, sleep, eimd, articular, patron, rpe, progressionAction, progressionReason, timestamp`

Invariantes preservados:
- 0 lecturas Firestore nuevas
- Todos los helpers son puros
- `_classifyBlocks`, `_normalizeTrainingPlan`, `parsePlanFromJSON` sin cambios
- Schema vdsen-plan-v2 sin cambios
- Colecciones Firestore sin cambios

---

### FASE 16 (merge commit `3e277d1` — MERGED a main)
**Coach Plan Editor: Safe Exercise Substitution Workflow**

Archivos modificados:
- `vdsen-coach.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P226-P237 (35 assertions nuevas)

Helper puro añadido (exportado como `window._replacePrescriptionExercise`):
- `_replacePrescriptionExercise(exercise, replacement, generateId)` — devuelve nuevo objeto sin mutar el original. Preserva sets, restSeconds, supersetGroup, coachNote y toda metadata estructural. Genera nueva `prescriptionExerciseId` solo si la identidad cambia. Si misma identidad (mismo `exerciseId` canónico o mismo nombre normalizado) → no regenera ID.

UI añadida:
- Botón `⇄` en cada ejercicio del Plan Editor (entre ↓ y ×)
- Modal de sustitución: ejercicio actual, buscador (substring case-insensitive), resultados del catálogo (`_filterExerciseCatalog` FASE 10), confirmación con nota "historial independiente", cancelar
- `openSubstModal(di, ei)` / `closeSubstModal()` — sin side effects en cancelar
- `_substApply()` — actualiza solo `data-prescription-id` y nombre en el DOM; llama `markEditorDirty()`; persistencia ocurre en "Guardar" normal

Semántica de identidad:
- OLD_ID → NEW_ID en la instancia sustituida únicamente
- Hermanos (siblings) no se tocan
- Reorder-safe: identidad no depende de posición
- Mismo ejercicio seleccionado → "Ya es el ejercicio seleccionado", sin nuevo ID
- 0 Firestore reads por keystroke / 0 listeners nuevos

Invariantes preservados:
- `_classifyBlocks`, `_normalizeTrainingPlan`, `parsePlanFromJSON` sin cambios
- Progression Engine sin cambios
- Schema vdsen-plan-v2 sin cambios
- Colecciones Firestore sin cambios

---

### FASE 14 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Coach Monitor: Bitácora completa de entrenamiento por sesión**

Archivos modificados:
- `vdsen-coach.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P206-P215 (33 assertions nuevas)

Helper añadido (antes de `_coachGetWeeklyCheckins`):
- `_coachBuildBitacora(logs, week, planData)` — organiza todos los sets registrados en una semana por día → ejercicio → set. Incluye sets autoFilled (marcados). Incluye flags `done` y objeto `postsession` por día. Nombres de ejercicio y targets desde el plan si disponible, fallback genérico. 0 lecturas Firestore.

Comportamiento añadido en Monitor:
- `<details>` "📋 Bitácora completa — Sem N" al final del Monitor (colapsado por defecto)
- Muestra todos los días con datos, con header (✓/○ + label + RPE/EIMD/sueño del postsession)
- Por ejercicio: nombre, reps target, RIR target, tabla de sets con carga/reps/RIR real/ICS/pump
- ICS coloreado (verde/amarillo/rojo). Sets autoFilled marcados con "auto" en gris.

Invariantes preservados:
- 0 lecturas Firestore nuevas
- `_coachBuildBitacora` pura (determinista, sin side effects)
- Sin cambios a schema, colecciones, auth ni algoritmo de progresión

---

### FASE 13 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Coach Monitor: contexto semanal, tendencia de peso, check-in pendiente, adherencia**

Archivos modificados:
- `vdsen-coach.html` — 4 parches quirúrgicos
- `tests/progression-engine.test.js` — P196-P205 (37 assertions nuevas)

Helpers añadidos (antes de `loadMonitorClients`):
- `_coachGetWeeklyCheckins(entries, max)` — espejo de `_getWeeklyCheckins` del cliente
- `_coachCalcWeightTrend(entries, max)` — espejo de `_calcWeightTrend`; retorna `NO_DATA` (no `SIN_DATOS`)
- `_coachHasPendingCheckin(entries, currentWeek)` — true si `currentWeek > 1` y `ci_sem_{W}` ausente
- `_coachCalcAdherence(entries, week, totalDays, planData)` → `{sessionsCompleted, sessionsTotal, sessionPct, setsCompleted, setsTotal, setPct}`. SET_ADHERENCE_APPROXIMATE.

Bugs corregidos en el callback onSnapshot:
- `totalWeeks` estaba undefined → ahora `const totalWeeks = (_activePlanCache?.weeks) ?? 6`
- `planData?.days?.length` era undefined → ahora usa `_activePlanCache?.days?.length`

Comportamiento añadido en Monitor:
- Header de semana: "SEM N / M SEM" (M = totalWeeks del plan, no hardcoded 6)
- Chip tendencia de peso: ⚖ SUBIENDO/BAJANDO/ESTABLE + rate kg/sem (solo si NO_DATA no aplica)
- Chip check-in pendiente: "⚠ Check-in sem N pendiente" cuando aplica
- Badge adherencia: "ADHERENCIA SEM N / Sesiones N/M · X% / Series N/M · X%"

Invariantes preservados:
- 0 lecturas Firestore nuevas en los helpers
- CURRENT_WEEK vs REAL_WEEK: el Monitor usa solo `logs.currentWeek`
- Sin cambios a schema, colecciones, auth ni farmacología
- Clasificación REVIEW/PROGRESSING/STABLE/NO_DATA del attention monitor sin cambios

---

### FASE 12 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Client UX: Check-in History, Weight Trend, Week Performance Summary**

Archivos modificados:
- `vdsen-cliente.html` — 5 parches quirúrgicos
- `tests/progression-engine.test.js` — P186-P195 (36 assertions nuevas)

Funciones añadidas (antes de `_calcSessionStats`):
- `_getWeeklyCheckins(entries, max)` — extrae hasta `max` entradas `ci_sem_{W}` de LOGS, ordenadas newest-first
- `_calcWeightTrend(checkins)` — tasa de cambio de peso usando semanas reales (no asume consecutividad). Umbrales: >+0.5 → SUBIENDO; <-0.5 → BAJANDO; else → ESTABLE; <2 pesos → SIN_DATOS
- `_buildWeekPerfSummary()` — strip de stats semanales (series totales, RIR medio, ICS medio) para CURRENT_WEEK, todas las sesiones, excluye autoFilled. 0 lecturas Firestore. Devuelve `''` si no hay sets.
- `_buildCheckinHistory()` — tabla HTML de los últimos 6 check-ins con chip de tendencia de peso

Comportamiento añadido en Tab Check-in (`renderCheckin`):
- Chip "SEMANA N DE M" bajo el header, atenuado si `CURRENT_WEEK < REAL_WEEK`
- Sección "HISTORIAL DE CHECK-INS" antes del botón GUARDAR: chip tendencia (↑/→/↓) + tabla peso/HRV/sueño/WHO-5 de las 6 últimas semanas. Estado vacío: "Aún no hay check-ins previos."

Comportamiento añadido en Tab Entrenamiento (`renderEntrenamiento`):
- Strip "Resumen sem N" debajo del session dashboard: series totales, RIR medio e ICS medio de la semana completa (todas las sesiones en CURRENT_WEEK)
- Solo visible si hay al menos 1 serie completada en la semana

Invariantes preservados:
- CURRENT_WEEK vs REAL_WEEK: sin mutación
- 0 lecturas/listeners Firestore nuevos
- Sin cambios a schema, colecciones ni auth

---

### FASE 5 (mergeada a main — `4a87e42`)
- Máquina de estados de workout en `vdsen-cliente.html`
- Algoritmo progresión v3.1 completo
- Check-in post-sesión + semanal
- Semana final = MESOCYCLE_CHECKPOINT únicamente.
  Deload es reactivo y requiere ≥2 deloadTriggers.
  La semana final sola nunca dispara deload.

### FASE 11 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Template Library + Apply to Current Client**

Storage audit: colección `templates` ya existía con reglas Firestore correctas. Schema: `{ name, coachId, weeks, days:[{label, exercises}], createdAt }`. Solo entrenamiento (sin nutrición/suplementación/farmacología). No se creó colección nueva. No se modificaron reglas.

Archivos modificados:
- `vdsen-coach.html` — botón `📚 Biblioteca` + 3 funciones nuevas
- `tests/progression-engine.test.js` — P176-P185 (31 assertions nuevas)

Funciones añadidas:
- `_filterTemplates(query, templates)` — substring CI, preserva orden, no muta input
- `_applyTemplateToClient(template, clientId, closeModal)` — restamp IDs → addDoc plans → updateDoc activePlanId (create-first, assign-after)
- `openPlanTemplateLibrary(clientId)` — modal DOM API (XSS-safe via textContent), 1 Firestore read al abrir, filtrado local, guard `applying` doble-click

Comportamiento añadido:
- Botón `📚 Biblioteca` en acciones del plan del cliente activo
- Modal responsive: loading → empty ("No tienes templates…") / error / lista
- Cada template: nombre + días · semanas · fecha (DOM API, sin innerHTML inseguro)
- "Usar →" aplica al cliente activo directamente, sin selector de cliente
- Plan creado antes de asignar activePlanId (transacción segura)
- Auto-agrega ejercicios del template al catálogo del coach
- `_saveCurrentPlanAsTemplate` ya pedía nombre (sin cambio necesario)

Limitaciones documentadas:
- 1 lectura Firestore al abrir biblioteca; no realtime listener
- No hay botón de eliminar template desde la biblioteca (existe en pestaña Plantillas existente)
- No hay paginación si el coach tiene >50 templates

---

### FASE 10 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Plan Editor UX: Autocomplete, Reorder, restSeconds**

Archivos modificados:
- `vdsen-coach.html` — 6 parches quirúrgicos en `_exRowHtml`, `_moveExRow`, `addExRow`, `renderTrainingEditor`, `toggleTrainingEditor`, `saveTrainingPlan`
- `tests/progression-engine.test.js` — P166-P175 (35 assertions nuevas)

Funciones añadidas:
- `_filterExerciseCatalog(query, catalog, limit)` — substring CI, max 6, sin Firestore reads
- `_moveArrayItem(items, from, to)` — reordenar array puro, no muta original
- `_parseRestSeconds(value)` — convierte string/undefined/negativo a número ≥ 0
- `_acShow(input)` / `_acHide(input)` — dropdown XSS-safe vía createElement/textContent
- `_updateReorderBtns(list)` — visibilidad ↑↓ por posición (primero oculta ↑, último oculta ↓)

Comportamiento añadido:
- **Autocomplete**: input de nombre usa custom dropdown (XSS-safe, no datalist). Fuente: `_allExercises` en memoria. Muestra nombre + motorPattern/equipment opcionales.
- **Reorder ↑↓**: botones ahora tienen `data-reorder="up/dn"`. Visibilidad actualizada al abrir editor, añadir ejercicio y después de cada movimiento. `prescriptionExerciseId` se preserva (viaja en `data-prescription-id` del DOM row).
- **restSeconds inline**: 4ª columna en grid de series. Carga de `sets[0].restSeconds`, guarda con `_parseRestSeconds`. Ya no hardcodeado a 90.

Limitaciones documentadas:
- Editor usa un único restSeconds por ejercicio (aplicado igual a todos sus sets), consistente con el modelo actual de reps/RIR uniformes por ejercicio.
- Datalist `coach_exlist` eliminado; el autocomplete nativo queda reemplazado por el custom dropdown.

---

### FASE 9 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Contextual Rest Timer + Active Workout Flow**

Archivos modificados:
- `vdsen-cliente.html` — 8 parches quirúrgicos
- `tests/progression-engine.test.js` — P147-P165 (19 tests nuevos)

Funciones añadidas:
- `_scrollToNextPendingSet()` — query `[data-pending="1"]` en `#exPanel`, scrollIntoView smooth (200ms delay)
- `_nextSerie()` — botón SIGUIENTE ▶: `stopRestTimer()` + `_scrollToNextPendingSet()`
- `_refreshSessionDashboard()` — actualiza `#_sesDashboard` innerHTML in-place, 0 Firestore reads

Comportamiento añadido:
- **Rest timer contextual**: auto-arranca al completar una serie usando `ej.sets[si].restSeconds` como única fuente de verdad
- **Sin heurísticas de fallback**: si `restSeconds` falta o es inválido, no se inicia timer automáticamente
- **Semántica de técnica preservada**: Y3T s1 ≥210s, Y3T s2 ≥150s; FST7 40s entre series / 180s tras la final
- **Guard autoFilled**: si `prev.autoFilled === true` (estado pre-guardado), no iniciar timer
- **Dashboard inmediato**: `_refreshExPanelOnly()` llama `_refreshSessionDashboard()` en cada save de serie
- **Set pendiente resaltado**: `data-pending="1"` + borde accent `rgba(196,255,0,.4)` en la fila activa
- **Scroll automático**: al finalizar timer y al pulsar SIGUIENTE ▶, desplaza al siguiente set pendiente
- **Wrapper `id="_sesDashboard"`**: permite update in-place sin re-render completo

Limitaciones documentadas:
- Timer no persiste en Firestore — usa solo localStorage (`vdsen_restEnd`, `vdsen_restTotal`)
- Si recarga durante descanso: timer se resetea (documentado, no es bug)
- `data-pending="1"` se asigna al `activeSi` del ejercicio activo; si hay múltiples ejercicios con sets pendientes, solo el primero está marcado

---

### FASE 8 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Live Training + Client Session Dashboard**

Archivos modificados:
- `vdsen-coach.html` — `_getLiveInfo()` helper + enhanced live badge + live-aware sort
- `vdsen-cliente.html` — `_calcSessionStats()` + `_fmtElapsed()` + `_statCell()` + session dashboard strip + session timer
- `tests/progression-engine.test.js` — P129-P146 (18 tests nuevos)

Funcionalidades añadidas:
- `_getLiveInfo(entries, planData)` — 0 Firestore reads; mismo umbral 5 min que `isClientLiveTraining`; identifica día activo, ejercicio actual (via plan), sets completados/totales del día
- Coach live badge: ahora muestra "● EN VIVO · [ejercicio] N/Ms" en lugar de solo "● EN VIVO"
- Auto-refresh live timer actualizado para usar `_getLiveInfo` con `innerHTML` (no textContent)
- Sort coach: live bump = `_ATTN_PRIORITY[state] * 2 - (live ? 1 : 0)`; REVIEW siempre domina
- `_calcSessionStats(logs, di, week)` — completedSets, avgRIR (0-5), avgICS (1-10), sessionStart (min ts)
- Session dashboard strip en Tab Entrenamiento (solo semana activa `CURRENT_WEEK === REAL_WEEK`)
  - 4 celdas: Series N/Total · Tiempo mm:ss · RIR medio · ICS medio
  - Tiempo: `setInterval` cada 1s, limpiado en re-render; derivado del primer ts real del día
  - ICS coloreado: verde ≥8, dorado ≥7, rojo <7
- XSS: `exerciseName` escapado con `_escH` en render del live badge (data layer retorna raw)

Limitaciones documentadas:
- Session start derivado del mínimo ts de logs reales del día; si recargas sin logs previos, timer empieza desde la primera serie guardada post-reload
- Tiempo sesión no persiste en Firestore — no se añade campo nuevo (spec: no cambiar schema)
- Live detection threshold 5 min: cliente sin actividad reciente aparece como no-live aunque esté en sesión

---

### FASE 7 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Coach Attention Monitor**

Archivos modificados:
- `vdsen-coach.html` — helpers de atención + redesign lista clientes + parche panel rendimiento
- `tests/progression-engine.test.js` — P110-P128 (19 tests nuevos)

Funcionalidades añadidas:
- `_ATTN_PRIORITY` / `_ATTN_BADGE` — constantes de estado visual (REVIEW/PROGRESSING/STABLE/NO_DATA)
- `_computeClientAttentionState(entries, planData, currentWeek)` — estado determinístico, 0 Firestore reads
  - Escanea semana actual y anterior (scanWeeks = [cw, cw-1])
  - REVIEW signals: deloadTriggers ≥ 2, action='deload', reason='TOO_HARD_REPEATED', reason='PERFORMANCE_REGRESSION', postsession.articular=true, postsession.eimd ≥ 3
  - `reduce_load` solo NO es REVIEW — requiere reason=TOO_HARD_REPEATED
  - PROGRESSING signals: action='increase_load', reason='REPS_PROGRESSING'
  - Dedup por (code + ex); máx 3 reasons devueltos
  - Prioridad: REVIEW > PROGRESSING > STABLE > NO_DATA
- Lista de clientes rediseñada (dos pasadas: build rowData → sort → render)
  - Header resumen: `🔴 N revisar 🟢 N progresando ⚪ N estables ◌ N sin datos`
  - Ordenada por _ATTN_PRIORITY → alpha
  - Badge de atención + reasons inline por cliente
  - XSS: r.ex y r.label escapados con `_escH` en render
- Panel "Rendimiento por ejercicio": auto-abre `<details>` si hay REVISAR; filas REVISAR destacadas con fondo rojo tenue + nombre en rojo bold; contador "↓ N a revisar" en summary

Bugs corregidos en self-review:
1. **XSS** — `r.label` puede contener `ps.patron` (data Firestore); escapado con `_escH` en render de reasons

---

### FASE 6 (mergeada a main — `2b6e927`)
**Performance History UX + Next Exposure**

Archivos modificados:
- `vdsen-cliente.html` — helpers de historial + bloque HOY
- `vdsen-coach.html` — panel rendimiento por ejercicio (`<details>` collapsible)
- `tests/progression-engine.test.js` — P88-P109 (22 tests nuevos)

Funcionalidades añadidas:
- `_getExposures(prescId, di, ei, nombre, max)` — últimas N exposiciones comparables
  - Confidence HIGH cuando prescriptionExerciseId match único por posición
  - Confidence LOW cuando cae a path positional legacy (con guard de nombre normalizado)
  - Ordena sets por setIdx (S0→S1→S2) en path HIGH
- `_calcTrend(exposures)` — PROGRESANDO | ESTABLE | REVISAR | NEW
  - REVISAR requiere ≥3 exposiciones con 2 descensos consecutivos
  - Una sesión mala → ESTABLE (no REVISAR)
- `_calcPR(exposures)` — mejor carga histórica
- `_buildNextExposureHtml(progrec, unit, nombre)` — bloque HOY inline
  - Consume progrec existente, nunca recalcula
  - Guard nombre vs progrec.exerciseName (stale-progrec protection)
  - Muestra unidad real KG/LB (no hardcoded)
- `showExHistory(di, ei)` — modal bottom-sheet historial (últimas 5)
  - Escapa nombre con `_escHTml` (XSS protection)
  - Botón "📈 Historial" en menú opciones de ejercicio

Bugs corregidos en self-review:
1. **XSS** — `nombre` escapado con `_escHTml()` en innerHTML del modal
2. **Unidad hardcoded** — `_buildNextExposureHtml` acepta `unit`, lo usa en display
3. **Stale progrec** — guard `_normName(progrec.exerciseName) !== _normName(nombre)` → fallback a nueva referencia
4. **Orden de sets** — HIGH confidence path ordena candidateSets por setIdx antes de mapear

---

## Invariantes permanentes (NUNCA cambiar)

### Identidad de ejercicios
```
HIGH  → prescriptionExerciseId exact match (preferido, stable UUID)
LOW   → positional (di/ei) + guard exact normalized name (legacy)
NONE  → mismatch/ambiguo → no history shown
```

### Log key format
`log_{W}_{D}_{E}_s{S}` — NUNCA cambiar. Metadata en entries es aditiva.

### RIR sign convention (CONGELADO)
```
rir_error = avgRIR - rirObj
> 0  → TOO_EASY  → candidato a subir carga
< 0  → TOO_HARD  → no subir
|err| ≤ 1 → PRESCRIPTION_MATCH
```

### Variables de semana
- `REAL_WEEK` — semana real en Firestore. NUNCA mutada por navegación.
- `CURRENT_WEEK` — semana vista. Puede diferir de `REAL_WEEK` (modo lectura pasado/futuro).

### Exclusiones del motor (CONGELADO)
- `autoFilled: true` → excluido de historial y observationsCount
- Una exposición mala ≠ regresión (requiere 3 consecutivas)
- NO recalcular progrec en path de historial (consume el ya existente)

### Program Mutation (CONGELADO)
- `add_sets` = recommendation only — nunca muta el plan activo
- `deload` = recommendation only — nunca muta el plan activo
- `reduce_sets` = renderer/session-local only (no persiste)
- Progression Engine nunca persiste cambios automáticos de volumen/frecuencia al plan activo

### Load Sources
```
A  plan.sets[].load     → placeholder / prescripción técnica
B  LOGS.carga           → carga real ejecutada
C  progrec.newLoad      → sugerencia de próxima exposición
```
Nunca mezclar A, B, C. Cada fuente tiene semántica independiente.

### Colecciones Firestore (NO cambiar)
- Sin nuevas colecciones
- Sin migración destructiva
- `activePlanId` intocable
- `logs/{uid}` — doc único por cliente

### Arquitectura
- **SINGLE-COACH permanente.**
  No diseñar multicoach / workspaces / transfers salvo instrucción explícita.

---

## Backlog ordenado (NO implementar sin autorización)

```
A. Coach Attention Monitor
B. Live Training indicator
C. Client Session Dashboard
D. Contextual Rest Timer
E. Check-in / body-history UX
F. Active-session exercise substitution (sin perder historial)
G. CSV logs export
H. Push notifications
I. Plan editor drag-and-drop
J. Photo progress
```

---

## Deuda técnica

**P1 FUTURE — logs/{uid} crecimiento de documento único**
`logs/{uid}.entries` crece en un documento Firestore único sin límite.
No migrar ahora — sin impacto operativo en volúmenes actuales.
Futuro: session/checkin subcollections con migración versionada y flag de versión.

---

## Restricciones de arquitectura

- **Stack**: HTML single-file, Tailwind CDN, Firebase SDK v10.12.0 modular — SIN bundler, SIN framework
- **Deploy**: Vercel estático, auto-deploy en push a main
- **Regla de edición**: NUNCA reescribir archivos completos. str_replace quirúrgico.
- **Colecciones activas**: coaches, clients, exercises, plans, logs, compendio
- **Merge a main**: requiere autorización explícita del usuario

---

## Tests

```bash
node tests/progression-engine.test.js
# → 255/255 PASS
```

Rangos:
- P01–P60: Progression core / RIR / deload / safeguards
- P61–P87: Stable Exercise Identity + legacy/history hardening + consistency tests
- P88–P105: FASE 6 Performance History UX
- P106–P109: FASE 6 self-review fixes
- P110–P128: FASE 7 Coach Attention Monitor
- P129–P146: FASE 8 Live Training + Session Dashboard

---

## Comandos de referencia

```bash
# Ver rama actual y último commit
git log --oneline -5

# Correr tests
node tests/progression-engine.test.js
# → 296/296 PASS

# Diff vs main
git diff main...HEAD --stat

# Push rama
git push -u origin claude/client-app-improvements-qayy4n
```
