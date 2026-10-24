# Acceso a la API de pago (entitlement del Coach) — T539

Tres conceptos distintos:

| Concepto | Qué es | Quién lo controla |
|---|---|---|
| **Registro de Coach** | Existe `coaches/{uid}`: una cuenta de la APP Coach. El registro sigue abierto (decisión de producto). | El propio usuario (regla de creación) |
| **Aislamiento por inquilino** | Un coach solo accede a los datos de SUS clientes (`clients/{id}.coachId`). No depende del entitlement. | `firestore.rules` |
| **Entitlement de API** | `coaches/{uid}.apiAccessEnabled === true`: permite usar los endpoints de pago / generativos (`api/vdsen-generate`). | **Solo el Admin SDK / servidor de confianza** |

## Comportamiento

- Documento inexistente, campo ausente, `false` o cualquier valor que no sea el booleano `true` → **403** (`AUTH_FORBIDDEN`).
- Token ausente / mal formado / inválido / expirado → **401** (sin cambios).
- Error al consultar Firestore → **falla cerrado** (401), nunca autoriza.
- Una ruta que olvide cablear `isAuthorizedCoach` es rechazada (403): no existe modo «solo autenticación».
- Un coach auto-creado (o un atleta que cree un documento de coach) queda **sin acceso** hasta que un administrador lo conceda.

## Reglas de Firestore (campos protegidos: `protectedCoachKeys()`)

Un coach puede crear y actualizar su perfil normal (`displayName`, `email`, `phone`, `equipmentIncrements`, …) pero **no**: crear su documento con `apiAccessEnabled` (ni `true` ni `false`), cambiarlo (false→true, true→false), quitarlo, ni borrar un documento que lo contenga (borrar + recrear). El Admin SDK ignora las reglas por diseño. No hay ningún mecanismo en el navegador para concederlo (un test lo verifica).

## Conceder / revocar (administrador, nunca automático)

```
node scripts/admin-coach-api-access.cjs --project <projectId> --uid <coachUid> --grant  --yes
node scripts/admin-coach-api-access.cjs --project <projectId> --uid <coachUid> --revoke --yes
```

- `--project` es obligatorio (nunca se infiere); `--uid` es el UID de un Coach que **ya existe** (la herramienta no crea cuentas); sin `--yes` solo muestra el cambio; `--dry-run` no escribe.
- Credenciales del operador (`GOOGLE_APPLICATION_CREDENTIALS` o entorno de Firebase Admin). No hay UIDs reales en el código.
- No se concede a todos los coaches existentes: cada UID aprobado se concede explícitamente.

## Rutas auditadas

| Ruta | Gasta la clave del servidor | Autorización |
|---|---|---|
| `api/vdsen-generate.js` | Sí (`OPENAI_API_KEY`) | `authenticateCoachRequest` + `isAuthorizedCoach` (entitlement); la autenticación precede a la llamada de pago |
| `api/generate-plan.js` | No: reenvía la clave OpenAI PROPIA del llamante (`Bearer sk-…`) y no lee variables del servidor | no aplica (no consume nada de VDSEN) |

Un test de regresión falla si una ruta nueva usa la clave del servidor sin pasar por el helper endurecido.

## Recuperación de clientes legacy sin coach

Ya no se puede reclamar desde la app ni desde el SDK de cliente (la regla de reclamación fue eliminada; `coachId` es inmutable tras crearse). Recuperación **solo administrativa**:

```
node scripts/admin-recover-client.cjs --project <projectId> --client <clientUid> --coach <coachUid> --yes
```

Exige UID de cliente y de coach explícitos, verifica que el cliente NO tiene `coachId` y falla si ya lo tiene.
