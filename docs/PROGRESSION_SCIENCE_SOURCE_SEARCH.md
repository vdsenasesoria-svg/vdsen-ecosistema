# Búsqueda exhaustiva de fuentes: decisiones científicas pendientes (T521)

Alcance: TODO el conocimiento controlado por el repositorio (`docs/`, `references/`, `CLAUDE.md`, informes `*.md`/`*.txt`, JSON, tests con procedencia y el código
del motor legado congelado). No se usó conocimiento externo. `competitive_physique_update/` **no existe** en el repositorio (los "knowledge packs" externos no están
versionados aquí). Las reglas A–E del módulo de magnitud provienen de instrucciones del director dadas fuera del repositorio: **el texto fuente de las reglas
A–E no está en ningún archivo versionado** (solo su implementación con `ruleAuthority: VDSEN_HEURISTIC`).

Conceptos buscados (es/en): double progression, carga vs reps, reps perdidas/no alcanzadas, regresión de repeticiones, intervalo/aumento de descanso, fatiga, RIR,
serie representativa / última / peor / mejor / promedio, exposiciones comparables, tendencia de rendimiento.

Verificado por `tests/t521-science-sources.test.js` (cada cita existe en el archivo indicado).

## A. RULE_D_E_ALTERNATIVE — ¿reducir reps o reducir carga cuando las reps no se cumplen / el esfuerzo es mayor al prescrito?

**FUENTE ENCONTRADA: NO (soporte parcial insuficiente).**

| Archivo | Sección | Qué respalda | Qué NO respalda | Nivel |
|---|---|---|---|---|
| `docs/CONTEXTO_GENERADOR.md` | §8 DOUBLE PROGRESSION (l.173–180) | "La Client App progresa reps primero, luego carga"; `repsTarget` es el techo del rango | Rige la progresión hacia ARRIBA. No dice qué hacer cuando faltan reps o el RIR es más duro | Doctrina VDSEN (alto, pero otra rama) |
| `docs/VDSEN_DEV_STATE.md` | "RIR sign convention (CONGELADO)" (l.1533–1537) | `rir_error = avgRIR − rirObj`; `< 0` → TOO_HARD → **no subir**; `|err| ≤ 1` → PRESCRIPTION_MATCH | No indica reducir reps ni carga; es el motor legado, degradado a evidencia (T500) | Motor legado congelado |
| `docs/VDSEN_DEV_STATE.md` | Exclusiones del motor (l.1546) | "Una exposición mala ≠ regresión (requiere 3 consecutivas)" | Contradice actuar sobre 2 exposiciones en la rama DOWN; no elige reps vs carga | Motor legado congelado |
| `vdsen-cliente.html` `calculateProgression` | l.15660–15704 | El legado responde a TOO_HARD repetido con "candidato a bajar carga ~5%" | Es un porcentaje del legado no canónico; no es la regla D/E | Código legado (no canónico) |

Conclusión: ninguna fuente elige entre reps y carga para D/E. **No se implementa.**

## B. RULE_C_E_PRECEDENCE — RIR correcto con reps incompletas: ¿descanso primero (C) y luego E, o E primero?

**FUENTE ENCONTRADA: NO.**

| Archivo | Sección | Qué respalda | Qué NO respalda | Nivel |
|---|---|---|---|---|
| `references/prompt-maestro-vdsen-coach.md` | A.11 Descansos (l.269–281) | Descansos PRESCRITOS por tipo de ejercicio (p. ej. 120–180 s compuesto de hipertrofia) | No define aumentar el descanso ante reps incompletas, ni "+30 s", ni precedencia con E | Doctrina VDSEN de prescripción |
| `vdsen-cliente.html` | temporizador de descanso | Solo cronómetro con respaldo por `fatigueCost` | No es política de progresión | UI |

La regla C (+30 s) y su precedencia respecto a E no aparecen en ningún archivo versionado. **No se implementa; la colisión C+E sigue `AMBIGUOUS` (C registrada, E diferida).**

## C. REPRESENTATIVE_SET — ¿qué serie representa una exposición?

**FUENTE ENCONTRADA: PARCIAL y CONTRADICTORIA entre sí.**

| Archivo | Sección | Qué respalda | Qué NO respalda | Nivel |
|---|---|---|---|---|
| `vdsen-cliente.html` `calculateProgression` | l.15523–15528, 15599, 15664 | El motor legado v3.1 usa el **promedio** de series (`avgReps`, `avgRIR`, carga media) | Es el motor legado congelado y degradado; las reglas A–E no citan su base | Código legado (no canónico) |
| `docs/VDSEN_DEV_STATE.md` | RIR sign convention (l.1533–1534) | `rir_error = avgRIR − rirObj` (promedio) | Idem | Motor legado congelado |
| `references/prompt-maestro-vdsen-coach.md` | A.12 (l.286) | La señal (retirada en T497) exigía ICS≥8, pump bueno y RIR>objetivo en **TODAS** las series | Cuantificador universal para un aviso de volumen, no regla de magnitud; retirado por decisión del director | Doctrina VDSEN histórica |
| `assets/progression-magnitude-policy.js` | `EVIDENCE_BASIS` | El runtime canónico usa la **última serie** del Módulo D (`LAST_SET_CURRENT_RUNTIME_HEURISTIC`) | Es una heurística de implementación, no una fuente | Runtime (heurística) |

Conclusión: existen dos bases en uso (promedio en el legado, última serie en el canónico) sin fuente que arbitre entre ellas. **No se implementa.**
Ver `docs/REPRESENTATIVE_SET_SIMULATION.md` para cuánto cambia el resultado según la estrategia.

## Hallazgo adicional de coherencia

`references/prompt-maestro-vdsen-coach.md` A.12 (l.286) todavía describe la sugerencia intra-sesión de "serie extra" que el director eliminó (T497). Es documentación
histórica desactualizada; no afecta al runtime.

## Resultado de la Fase "implementar solo lo respaldado"

Ninguna de las tres reglas tiene respaldo suficiente. No se modificó `progression-magnitude-policy.js`. Las opciones de producto están en
`docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md` (no son hechos científicos).
