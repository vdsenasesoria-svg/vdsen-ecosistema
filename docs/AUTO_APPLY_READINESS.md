# Preparación real de la auto-aplicación

Generado por `node scripts/generate-activation-docs.cjs`. **Evidencia estática / sintética / local únicamente; no hay métricas de producción.**

## 1. Preparación de CÓDIGO / POLÍTICA

| Elemento | Estado |
|---|---|
| Política de producto D/E | COACH_REVIEW_REQUIRED (1A) — sin candidato numérico |
| Política C→E | primera ocurrencia comparable → REST +30 s; persistencia → COACH_REVIEW_REQUIRED (2B) |
| Serie representativa | LAST_STANDARD_WORKING_SET · `VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET` |
| Bloqueos científicos abiertos | 0 |
| Resolvedor de equipo | listo (identidad + precedencia + rejilla física + rechazo explícito) |
| UX de configuración de equipo | lista (editor, cola, carga masiva, vista previa de impacto, procedencia) |
| Guardia de activación | 19 verificaciones independientes |
| Repetición sintética | 18 escenarios: 2 READY_BUT_DISABLED · 4 COACH_REVIEW_REQUIRED · 12 bloqueados · 0 ejecutables |
| Bloqueados por equipo / revisión del Coach / otra política | 5 / 4 / 1 |
| Validación de plataforma (Windows T478) | NON_BLOCKING_TECHNICAL_PENDING (registro: PENDING) |
| Bandera `NUMERIC_APPLY_ENABLED` | false (apagada en los 4 módulos) |
| Estado APPLIED | solo alcanzable con la bandera activa (sandbox de pruebas); con la bandera apagada la transición se rechaza (`NUMERIC_APPLY_DISABLED`) |

### Ciclo de vida de la aplicación

| Componente | Estado |
|---|---|
| APPLIED LIFECYCLE | READY_BEHIND_DISABLED_FLAG |
| CLIENT OVERLAY CONSUMER | READY_BEHIND_DISABLED_FLAG |
| ROLLBACK | READY |
| CONSUMPTION | READY |
| OVERRIDE | READY |
| STALE | READY |
| CANARY | READY_DISABLED |
| FIRESTORE_CANONICAL_WRITE_BOUNDARY | PASS / READY (reglas en el repositorio; despliegue pendiente y no autorizado) |
| Concurrencia (Emulator real) | cubierta (`tests/t532-lifecycle-emulator.cjs`) |

## 2. Preparación de DATOS REALES DE EQUIPO

| Métrica | Valor |
|---|---|
| Cobertura de identidad de equipo (grupos) | 39 / 41 |
| Cobertura de identidad (ejercicios del catálogo) | 69 / 71 |
| Cobertura de incrementos (equipos con incremento) | 0 / 39 |
| Ejercicios del catálogo listos por equipo (LOAD) | 0 / 71 |
| Candidatos LOAD ejecutables con el catálogo real | 0 (sin incrementos: sin redondeo implícito, sin respaldo por tipo de equipo) |

**Bloqueo operativo principal restante: incrementos reales de equipo (datos del Coach).** Código, política, ciclo de vida, consumidor del cliente y auditoría del Coach están listos detrás de la bandera apagada.

## Principales motivos de bloqueo o revisión (sintético)

| Motivo | Candidatos |
|---|---|
| COACH_REVIEW_REQUIRED | 4 |
| COACH_OVERRIDE | 1 |
| DIRECTION_CONFLICTING | 1 |
| DIRECTION_NOT_REALIZABLE | 1 |
| DIRECTION_UNCONFIRMED | 1 |
| EQUIPMENT_IDENTITY_UNRESOLVED | 1 |

## Equipos que más desbloquearían (ranking por uso en el catálogo)

| # | Equipo | Ejercicios | Estado |
|---|---|---|---|
| 1 | Mancuernas | 14 | INCREMENT_UNRESOLVED |
| 2 | Barra olímpica | 12 | INCREMENT_UNRESOLVED |
| 3 | Estación de Poleas | 4 | INCREMENT_UNRESOLVED |
| 4 | Polea alta | 4 | INCREMENT_UNRESOLVED |
| 5 | Polea baja | 2 | INCREMENT_UNRESOLVED |
| 6 | Abdominal Machine Matrix | 1 | INCREMENT_UNRESOLVED |
| 7 | Abductor / Adductor Matrix | 1 | INCREMENT_UNRESOLVED |
| 8 | Accesorio de polea | 1 | IDENTITY_UNRESOLVED |

Documentos relacionados: `docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md`, `docs/EQUIPMENT_DATA_REQUIRED_NEXT.md`, `docs/EQUIPMENT_ACTIVATION_READINESS.md`, `docs/SHADOW_REPLAY_REPORT.md`, `docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md`.
