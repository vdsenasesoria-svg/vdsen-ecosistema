# Runbook de despliegue: reglas e índices de Firestore + aplicación + API (NO EJECUTADO)

Estado: **preparado, no desplegado.** Este documento describe la secuencia para una aprobación posterior. Nada de esto se ejecutó ni contactó producción o staging.

## Identificación de proyectos (encontrada en el repositorio)

| Entorno | Identificador | Fuente |
|---|---|---|
| PRODUCCIÓN | `vdsen-ecosistema` | `firebaseConfig.projectId` en `vdsen-coach.html` y `vdsen-cliente.html`; `scripts/migrate-ayrton-uid.js` |
| STAGING | **STAGING_NOT_CONFIGURED** | No existe `.firebaserc`, alias, proyecto alterno, CI ni credenciales/CLI de Firebase en el entorno de trabajo |

`firebase.json` solo declara `firestore.rules` (no declara `firestore.indexes.json`): el despliegue de índices debe indicarse explícitamente (`--only firestore:indexes`) o añadirse a `firebase.json` antes.

## Orden obligatorio (por qué)

La app nueva funciona con las reglas antiguas; la app antigua NO funciona con las reglas nuevas (el cliente antiguo escribía registros canónicos y el Coach antiguo hacía consultas sin filtrar). Además el API endurecido exige `apiAccessEnabled`. Por eso:

1. **Preflight** (local, sin tocar nada)
   - `git rev-parse HEAD` = commit aprobado; `git status` limpio; `node --test tests/*.test.js`; `node scripts/test-auto-apply-emulator.cjs` (todas las suites en verde); `git diff --check`.
   - Confirmar el proyecto destino: `firebase projects:list` y `firebase use` → debe imprimir **exactamente** `vdsen-ecosistema` (o el id de staging en el ensayo). Ante cualquier duda, detenerse. Pasar siempre `--project <id>` explícito.
   - Guardar la referencia de rollback: en Firebase Console → Firestore → Reglas → historial, anotar la versión vigente y su fecha; exportar su texto (`Copiar`) a un archivo fechado. Referencia en el repositorio: `git show 3019bda:firestore.rules` (última versión previa a T537).
2. **Conceder el entitlement** a los coaches aprobados ANTES de activar el API endurecido (de lo contrario pierden la generación con IA): `node scripts/admin-coach-api-access.cjs --project <id> --uid <coachUid> --grant --yes` por cada UID aprobado (`--dry-run` primero).
3. **Índices**: `firebase deploy --only firestore:indexes --project <id>`. Esperar a que `plans_backup (coachId, clientId, backedUpAt)` pase de *Building* a *Enabled* (Console → Índices). No continuar hasta que esté *Enabled*.
4. **Aplicación + API** (Vercel): desplegar el commit aprobado. Verificar que `/coach` y `/cliente` cargan y que el service worker `vdsen-v11` instala los módulos de progresión.
5. **Reglas**: `firebase deploy --only firestore:rules --project <id>`.
6. **Smoke posterior** (cuentas de prueba, sin datos personales reales):
   - Atleta: inicia sesión, lee su cliente, guarda una serie (log normal) → OK; intenta escribir `progressionApplications` → denegado.
   - Coach dueño: lista sus clientes, abre Monitor, edita equipo (`equipmentIncrements`), restaura un respaldo de plan (sin error de índice), cambia la semana de un cliente → OK.
   - Otro coach / coach autocreado: leer o escribir un cliente ajeno, sus logs, fichas → denegado; reclamar un cliente huérfano → denegado.
   - API: coach sin entitlement → 403; con entitlement → respuesta normal; token inválido → 401.
7. **Aserciones de seguridad** (deben cumplirse): `NUMERIC_APPLY_ENABLED` sigue en `false`; no existen registros `APPLIED`; `coaches/*.apiAccessEnabled` solo en UIDs aprobados; ningún coach puede escribir `apiAccessEnabled`.

## Rollback

- **Reglas**: en Console → Reglas → historial, publicar de nuevo la versión anotada en el preflight (o `firebase deploy --only firestore:rules` con el texto exportado). La app nueva sigue funcionando con reglas antiguas.
- **Índices**: son aditivos; no requieren rollback.
- **API**: revertir el despliegue de Vercel al anterior; el campo `apiAccessEnabled` es inocuo para el API antiguo.
- **Aplicación**: revertir en Vercel. Si se revierte la app pero no las reglas, el cliente antiguo dejaría de poder crear registros de progresión (solo afecta al modo sombra, no al registro de entrenamiento).

## Cambios de comportamiento que el operador debe conocer

- Los registros PENDING del modo sombra los crea el Coach dueño al abrir el Monitor (ya no el atleta).
- Recuperar clientes legacy sin coach: solo `scripts/admin-recover-client.cjs`.
- Herramientas de reparación de la app Coach ya no listan clientes ajenos.
- Registro de coach abierto: una cuenta nueva no obtiene API de pago hasta que se le conceda.

## Validación en staging

Solo con un proyecto de staging explícito y credenciales que lo identifiquen sin ambigüedad. Hoy: **STAGING_NOT_CONFIGURED** → no se desplegó nada. Para habilitarlo: crear un proyecto Firebase de staging, añadir `.firebaserc` con alias `staging` y `default` explícitos, y apuntar una copia de la app (`firebaseConfig`) a ese proyecto.
