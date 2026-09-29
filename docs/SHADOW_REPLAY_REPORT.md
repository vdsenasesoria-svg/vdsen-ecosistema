# Reproducción en sombra: preparación de aplicación (sintética)

Generado por `node scripts/replay-application-readiness.cjs` sobre fixtures sintéticos deterministas (sin datos de producción; la configuración de equipo es de prueba y no toca el catálogo).
Responde: cuando se active la bandera, ¿por qué se aplicaría o no cada candidato?

- Candidatos: **15** · READY_BUT_DISABLED: **2** · BLOCKED: **13** · EXECUTABLE: **0**
- Bloqueados por equipo: **5** · por ciencia/rama sin resolver: **2**

## Bloqueos por motivo

| Motivo | Candidatos |
|---|---|
| MAGNITUDE_BRANCH_UNRESOLVED | 2 |
| SCIENCE_POLICY_UNRESOLVED | 2 |
| COACH_OVERRIDE | 1 |
| DIRECTION_CONFLICTING | 1 |
| DIRECTION_NOT_REALIZABLE | 1 |
| DIRECTION_UNCONFIRMED | 1 |
| EQUIPMENT_IDENTITY_UNRESOLVED | 1 |
| EQUIPMENT_OUT_OF_RANGE | 1 |
| EVIDENCE_COUNT_INSUFFICIENT | 1 |
| SAFETY_CONFLICT | 1 |
| TARGET_ALREADY_STARTED | 1 |
| UNIT_MISMATCH | 1 |
| UNRESOLVED_EQUIPMENT_INCREMENT | 1 |

## Detalle

| Escenario | Dimensión | Estado | Bloqueos | Ciencia |
|---|---|---|---|---|
| A-load ready (synthetic shared step) | LOAD | READY_BUT_DISABLED | — | — |
| A-load, equipment increment not configured | LOAD | BLOCKED | UNRESOLVED_EQUIPMENT_INCREMENT | — |
| A-load, equipment identity unresolved (generic label) | LOAD | BLOCKED | EQUIPMENT_IDENTITY_UNRESOLVED | — |
| A-load, increment unit mismatch | LOAD | BLOCKED | UNIT_MISMATCH | — |
| A-load, grid step swallows the move | LOAD | BLOCKED | DIRECTION_NOT_REALIZABLE | — |
| A-load, above equipment maximum | LOAD | BLOCKED | EQUIPMENT_OUT_OF_RANGE | — |
| C rest ready (independent of equipment) | REST | READY_BUT_DISABLED | — | — |
| D/E branch unresolved (science) | — | BLOCKED | MAGNITUDE_BRANCH_UNRESOLVED, SCIENCE_POLICY_UNRESOLVED | RULE_D_E_ALTERNATIVE_NOT_DEFINED |
| D branch unresolved (science) | — | BLOCKED | MAGNITUDE_BRANCH_UNRESOLVED, SCIENCE_POLICY_UNRESOLVED | RULE_D_E_ALTERNATIVE_NOT_DEFINED |
| single exposure only | LOAD | BLOCKED | EVIDENCE_COUNT_INSUFFICIENT | — |
| direction unconfirmed by prior exposure | LOAD | BLOCKED | DIRECTION_UNCONFIRMED | — |
| direction conflicting across exposures | LOAD | BLOCKED | DIRECTION_CONFLICTING | — |
| safety conflict | LOAD | BLOCKED | SAFETY_CONFLICT | — |
| Coach override after evidence | LOAD | BLOCKED | COACH_OVERRIDE | — |
| target exposure already started | LOAD | BLOCKED | TARGET_ALREADY_STARTED | — |
