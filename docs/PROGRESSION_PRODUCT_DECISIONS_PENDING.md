# Decisiones de producto de la progresión canónica (T521 → CERRADAS en T523)

## DECISIONES FINALES (director, T523) — política de producto VDSEN, no ciencia

| Decisión | Opción elegida | Comportamiento implementado |
|---|---|---|
| 1. Regla D/E | **1A — solo revisión del Coach** | D y E nunca generan candidato numérico; estado `COACH_REVIEW_REQUIRED`. No se reduce automáticamente carga, reps objetivo, series ni RIR. |
| 2. Precedencia C/E | **2B — C primero y E si persiste** | Primera ocurrencia comparable de C → REST +30 s únicamente. Si la misma condición persiste en la siguiente exposición comparable → E → `COACH_REVIEW_REQUIRED`. Nunca doble intervención automática. |
| 3. Serie representativa | **3A — última serie de trabajo** | Última serie de trabajo válida ejecutada (sin calentamiento, autofill, express ni series de descenso planificadas; sin sustituir series faltantes). Procedencia `VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET`. |
| 4. "Serie extra" (A.12 / legado) | No se restaura | Referencia `LEGACY_REFERENCE_NON_AUTHORITATIVE`; la autoridad de volumen es solo el Coach / política estructural canónica. |
| 5. Windows T478 | No bloqueante | `NON_BLOCKING_TECHNICAL_PENDING`; la validación en Linux sigue siendo obligatoria y pasa. |

Lo que sigue es el análisis original de opciones (histórico); las etiquetas "Hoy" describen el estado ANTES de T523.

---

# (Histórico) Decisiones de producto pendientes de la progresión canónica (T521)

Estas opciones **no son hechos científicos** y no están ordenadas por validez. Cada una es una política de producto viable con sus consecuencias. Hasta que el director
elija, cada rama sigue bloqueada con su código explícito y `NUMERIC_APPLY_ENABLED=false`. Fuentes revisadas: `docs/PROGRESSION_SCIENCE_SOURCE_SEARCH.md`.

## 1. RULE_D_E_ALTERNATIVE — reps o carga cuando las reps no se cumplen (E) o el esfuerzo es mayor al prescrito (D)

Hoy: `MAGNITUDE_BRANCH_UNRESOLVED` + `SCIENCE_POLICY_UNRESOLVED`; se conservan ambas alternativas sin elegir.

| Opción | Comportamiento exacto | Conservadurismo | Sobre-ajuste | Sub-ajuste | Efecto en aplicación automática | Compatibilidad |
|---|---|---|---|---|---|---|
| **1A. Solo revisión del Coach** | D/E nunca generan overlay; quedan como candidato de revisión (como la Regla B) | Máximo | Ninguno | Alto: el atleta sigue con una carga difícil hasta que el Coach actúe | Nunca aplica D/E; A y C siguen | Total: solo cambia un blocker por un estado de revisión |
| **1B. Reps primero (reducir objetivo de reps dentro del rango)** | Candidato REPS `−δ` acotado por el límite inferior del rango; si ya está en el límite, pasa a revisión del Coach | Alto (no toca la carga) | Bajo | Medio: con reps ya en el mínimo no ayuda | Aplica solo dimensión REPS; requiere el límite inferior del rango | Buena: `_repsCandidate` ya existe; falta decidir δ |
| **1C. Carga primero (reducir carga)** | Candidato LOAD `−p%` resuelto por equipo | Medio | Medio: cambia carga por una serie floja | Bajo | Requiere incremento de equipo y `p` (magnitud no definida) | Requiere fijar un porcentaje; hoy no hay fuente |

Tests necesarios: rama D y E por opción; frontera inferior del rango; tie con equipo; ausencia de overlay para la opción 1A; regresión de A/C.

## 2. RULE_C_E_PRECEDENCE — RIR correcto con reps incompletas

Hoy: se registra C (+descanso), E se difiere; colisión `AMBIGUOUS`.

| Opción | Comportamiento exacto | Conservadurismo | Sobre-ajuste | Sub-ajuste | Efecto en aplicación automática | Compatibilidad |
|---|---|---|---|---|---|---|
| **2A. C solo (estado actual)** | Solo aumenta el descanso; E nunca se combina | Alto | Bajo | Medio: si el descanso no resuelve, nunca se actúa sobre reps/carga | Aplica solo REST | Ya implementada |
| **2B. C primero, E si persiste** | C esta exposición; si la siguiente exposición confirma reps incompletas con RIR correcto, pasa a E (según la decisión 1) | Alto | Bajo-medio | Bajo | REST y luego la dimensión de E | Requiere memoria de exposición previa (ya existe consistencia de dirección) y la decisión 1 |
| **2C. E primero (orden del runtime del Módulo D)** | E antes que C | Medio | Medio | Bajo | Depende de la decisión 1 | Cambia el orden actual; contradice "C es la primera intervención" |

Tests: colisión C+E por opción; persistencia entre dos exposiciones; no-aplicación doble (idempotencia por exposición destino).

## 3. REPRESENTATIVE_SET — qué serie representa una exposición

Hoy: última serie (`LAST_SET_CURRENT_RUNTIME_HEURISTIC`), supuesto global provisional. Ver `docs/REPRESENTATIVE_SET_SIMULATION.md`: la elección cambia la dirección en 10–80 % de las exposiciones sintéticas según el par de estrategias.

| Opción | Comportamiento exacto | Conservadurismo | Sobre-ajuste | Sub-ajuste | Efecto en aplicación automática | Compatibilidad |
|---|---|---|---|---|---|---|
| **3A. Última serie (estado actual)** | Usa la última serie ejecutada | Bajo (sensible al cansancio acumulado) | Medio: la última serie suele ser la más dura → tendencia a DOWN/REST | Bajo | Sin cambios | Ya implementada; alineada con el Módulo D |
| **3B. Serie más dura (worst)** | Usa la serie con más falta de reps / menos margen | Alto | Bajo para subidas, alto para bajadas | Alto para subidas: casi nunca sube | Menos candidatos UP | Nueva función de selección pura; sin cambios de esquema |
| **3C. Promedio (aggregate)** | Promedio redondeado de reps, RIR observado y carga | Medio | Medio | Medio | Más candidatos REST según la simulación; alinea con el legado v3.1 | Datos ya disponibles; hay que definir redondeo y series de calentamiento excluidas |

Tests: patrones con series divergentes (fading / drifting / lateEasy); estabilidad ante orden de series; paridad con la simulación.

## Qué habilita cada decisión

Ninguna de las tres activa nada por sí sola: después de decidir, hay que (a) implementar la opción con procedencia, (b) actualizar `SCIENCE_GAPS`,
(c) reflejarlo en `docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md` y (d) recién entonces considerar el flag.
