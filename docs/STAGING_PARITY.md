# Paridad emulador vs Firebase real (staging) — T541

Proyecto: `vdsen-ecosistema-staging` (reglas e índice desplegados desde el commit `0654fb9`; producción y `vdsen-planes` intactos). Arnés desechable: `scripts/staging-smoke.cjs` (REST contra Auth y Firestore reales; cuentas sintéticas `*@staging-smoke.invalid` con contraseñas aleatorias en tiempo de ejecución, limpieza al final). Evidencia sin UIDs ni credenciales: `docs/staging-smoke-results.json`.

Resultado: **116 comprobaciones: 114 PASS, 0 FAIL, 2 BLOQUEADAS por credenciales de administrador de staging.**

| Grupo | PASS / total |
|---|---|
| Tenant: client profile / plans | 24/24 |
| Execution evidence + canonical fields | 39/39 |
| Coach authority (registration / entitlement) | 16/15 |
| Phone index | 6/6 |
| Private coach data | 21/21 |
| Equipment / exercises | 7/7 |
| plans_backup index query | 2/2 |

## Paridad

| Invariante | Emulador | Staging real | Clasificación |
|---|---|---|---|
| Aislamiento por inquilino (cliente, logs, plan) | T01–T05, T08, M01 | 0 desajustes | MATCH |
| Evidencia de ejecución del atleta permitida; campos canónicos denegados a atleta / otros coaches | L01–L04, R01–R16 | 0 desajustes | MATCH |
| Materialización PENDING solo por el coach dueño | T476 (materializador) | PENDING creado con evidencia real; denegado a otro / autopromovido / atleta | MATCH |
| Sin APPLIED / overlays con la bandera apagada | T529, T535 | ninguno | MATCH |
| Campo protegido `apiAccessEnabled` (crear, añadir, borrar+recrear) | A01, A02 | denegado | MATCH |
| `apiAccessEnabled` verdadero: voltear / quitar / borrar documento con entitlement | A02, A03 | requiere Admin SDK | NOT_TESTABLE (BLOCKED_BY_STAGING_ADMIN_CREDENTIALS) |
| Reclamar un cliente huérfano preexistente | O01 | crear un huérfano requiere Admin SDK | NOT_TESTABLE (BLOCKED_BY_STAGING_ADMIN_CREDENTIALS); intentos de adopción / robo / asignación por atleta: MATCH |
| Índice de celular: lectura pública; escritura solo dueño | T06 | igual | MATCH |
| Datos privados del coach (plantillas, compendio, respaldos, fichas, prospectos) | T03, T09 | igual | MATCH |
| Equipo / ejercicios del coach dueño | E01, E02 | igual | MATCH |
| Consulta de respaldos con índice compuesto | T03 | índice `READY`; 1 fila, sin error de índice | MATCH |

**Desajustes de seguridad: 0.**
