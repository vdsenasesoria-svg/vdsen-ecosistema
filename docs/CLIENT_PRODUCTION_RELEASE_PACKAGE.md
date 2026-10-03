# Client app — paquete de lanzamiento a producción (NO EJECUTADO)

Estado: **preparado, NO desplegado.** Ningún comando de este documento se ejecutó. Este documento NO autoriza producción: la autorización es de Ayrton.
Autoridad de la secuencia: `docs/FIRESTORE_DEPLOYMENT_RUNBOOK.md` (no se inventan comandos fuera de él / del repositorio).

## 1. Identidad del release

| Campo | Valor |
|---|---|
| Rama | `codex/client-app-next` |
| RELEASE_RUNTIME_SHA (el que tiene deployment Preview) | `d7bb71521d750eafd46a15fdd3c6ee157d4bd4cf` — Preview `dpl_Eucadoaj3buvedSnDNxoeLaxtf3B` (`codex/client-app-next`) |
| RELEASE_PACKAGE_SHA | HEAD de `codex/client-app-next` con este documento. `git diff --name-status d7bb715..d19bfe4` = solo `M docs/CLIENT_PRODUCTION_RELEASE_PACKAGE.md` → equivalencia de runtime PROBADA entre ambos. **Los SHA posteriores a `d7bb715` (solo docs) NO tienen deployment Preview propio ni se desplegaron.** Cada edición posterior solo de docs mantiene la equivalencia; verificarlo con `git diff --name-status d7bb715..HEAD` antes del GO. |
| Último commit de código de runtime previo | `cf9eaa9c96a5c9313806234971dc9e4be8b67c72` |
| Commits posteriores | solo este paquete + `tests/t558-self-coach-topology.cjs` (+ su alta en la lista del runner de emulador). **Cero cambios de código de runtime** desde `cf9eaa9`. |
| `main` (referencia, intacta) | `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c` (ancestro del release: el release es fast-forward de `main`) |
| Alcance | App Client (`vdsen-cliente.html`) + reglas/índices/API/SW requeridos por el runbook |
| Estado congelado | CLIENT TRAINING = FEATURE_COMPLETE · NUTRICIÓN = DISPLAY_ONLY / DISPLAY_READY · SUPLEMENTOS = DISPLAY_ONLY / DISPLAY_READY · `NUMERIC_APPLY_ENABLED = false` |

El SHA a desplegar lo nombra **explícitamente Ayrton** al autorizar (no «el HEAD del momento»); verificarlo con `git rev-parse HEAD`. Los commits posteriores a `cf9eaa9` solo tocan docs/tests.

## 2. Módulos incluidos

- Client Training completo (registro por serie y Express, corrección, temporizador de descanso + alerta + avance, SIGUIENTE/CONTINUAR, notas por semana/PID, ÚLTIMA SEMANA + USAR CARGA/REPS, sustituciones, cardio explícito, check-in post-sesión, Home día siguiente, offline/reconexión).
- Nutrición: solo visualización. Suplementos: solo visualización (contrato en `docs/CLIENT_MODULE_STATUS.md`).
- Endurecimiento de reglas Firestore, índice `plans_backup`, API endurecida (`api/*`, requiere `apiAccessEnabled`), service worker `vdsen-v13`.

## 3. Explícitamente excluido

Auto-aplicación numérica (`NUMERIC_APPLY_ENABLED=false`; no hay registros `APPLIED`) · incrementos por equipo · generador / autoría de planes · tracking de nutrición · tracking de suplementos · pulido especulativo de entrenamiento.

## 4. Delta de producción

**PRODUCTION_BASELINE_COMMIT = `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c` (PROBADO por metadatos de Vercel de solo lectura, 2026-10-03).** Deployment `dpl_3RKY7UixzLDr9iK4NQ6VcKriz3Cn` (proyecto `vdsen-ecosistema`, `prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`, equipo `team_VZc5H7Q1DBIJ3g0mwrSBz1o8`): `target=production`, `source=git`, `githubCommitRef=main`, `READY`, `isRollbackCandidate=true`, con los alias `vdsen-ecosistema.vercel.app`, `…-vdsenasesoria-svgs-projects.vercel.app` y `…-git-main-…`. Es el deployment de producción más reciente y el que tiene el alias de producción. Releer este dato justo antes del GO (un rollback/promoción posterior lo cambiaría).

| Área | Delta respecto de `main` (pista de baseline) |
|---|---|
| App / config | 3 HTML (`vdsen-cliente`, `vdsen-coach`, `ficha-publica`), `api/*`, `assets/*`, `sw.js` (`vdsen-v13`), `manifest.json` (`scope`, `sizes`), `package.json` (+`firebase-admin ^13`, `openai ^4.98`), `firebase.json`, `.firebaserc`, `.env.example` |
| Reglas Firestore | **SÍ** — endurecimiento amplio de `firestore.rules` (~157 líneas). Orden obligatorio: la app antigua NO funciona con las reglas nuevas. |
| Índices | **SÍ** — `plans_backup (coachId ASC, clientId ASC, backedUpAt)`. Aditivo. |
| Migración de esquema | **NO** (sin cambios de forma de documentos; el cliente escribe `planId` en logs raíz, ya cierto en `main`). |
| Migración de datos | **NO** automática. **Hay precondiciones de datos a verificar a mano** (sección 5). |
| Colecciones nuevas | **NO** (`expedientes` no tiene regla; el espejo del check-in falla por reglas y la app lo comunica: «sincronización con coach pendiente»). |
| Variables de entorno (Vercel) | **SÍ — nuevas**: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (el API lanza `FIREBASE_ADMIN_NOT_CONFIGURED` si faltan). `OPENAI_API_KEY` / `OPENAI_MODEL` ya existentes. Nunca se commitean valores. |
| Service worker / caché | `vdsen-v13`; HTML network-first (la caché es solo respaldo offline) → los clientes toman la versión nueva al primer fetch en línea; PRECACHE verificado. |
| Binding de proyecto | Firebase: `production` = `vdsen-ecosistema`, `staging` = `vdsen-ecosistema-staging`; sin proyecto por defecto → siempre `--project`. Vercel: proyecto `vdsen-ecosistema` (`prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`, visto en la sesión). El HTML canónico lleva el `projectId` de producción; el swap a staging existe solo en la rama de preview `preview/staging-client` (deploy-only, nunca se mergea). |

## 5. Precondiciones (todas deben cumplirse; verificación manual en Console / Vercel — el repo no tiene script para ellas)

1. **Commit/baseline**: `git rev-parse HEAD` = SHA aprobado; árbol limpio; `main` sin tocar.
2. **Coach+atleta con el mismo UID (topología del plan de producción `coachId == clientId`)**: permitido por las reglas; probado en emulador (`tests/t558-self-coach-topology.cjs`, 4/4).
3. **Clientes huérfanos** (`clients/*` sin `coachId`): con las reglas nuevas un Coach NO puede leerlos ni reclamarlos; el atleta sí entrena. Confirmar en Console que cada cliente real tiene `coachId`; si no, recuperarlo solo con `scripts/admin-recover-client.cjs`.
4. **Logs raíz sin `planId`** (`logs/{uid}`): riesgo `LEGACY_UNBOUND` (la referencia de semana previa/progreso podría reiniciar en semana 1). Revisar en Console los logs del atleta real antes de la liberación.
5. **Entitlement del API**: conceder `apiAccessEnabled` a los Coaches aprobados ANTES de las reglas/API: `node scripts/admin-coach-api-access.cjs --project vdsen-ecosistema --uid <coachUid> --grant --dry-run` y luego `--grant --yes`.
6. **Variables de entorno de Vercel** (sección 4) configuradas en el proyecto de producción.
7. **Mecanismo de despliegue de la app = GAP (puerta de release; ver sección 6b).** El repo no contiene CLI/hook/CI/promoción de Vercel (sin `.github/`, `.vercel/`, scripts de deploy; `package.json` sin scripts). La única vía probada es la integración Git de Vercel: `CLAUDE.md` («auto-deploy en push a main») y los deployments *Production* de GitHub, todos con ref = commit de `main`. Esa vía exige mutar `main`, lo cual NO está aprobado. Ayrton debe elegir y autorizar por escrito el mecanismo (p. ej. si la promoción de un deployment *Preview* existente del SHA aprobado está disponible en su proyecto — no demostrado por el repo) antes de cualquier GO. Ver sección 6, paso 4.
8. **Aviso (preexistente)**: todo el repositorio se sirve públicamente en Vercel (no hay `.vercelignore`). No es bloqueante de este release; no subir secretos.
9. **Referencia de rollback anotada** (sección 8) antes de cualquier despliegue.
10. Verificado en repo: sin credenciales commiteadas (solo claves web públicas de Firebase).

## 6. Secuencia de despliegue (pegar y ejecutar SOLO tras autorización de Ayrton)

Orden del runbook (no hay desviación): preflight → entitlement → índices → app+API → reglas → smoke → rollback listo.

```bash
# 0. Preflight (local)
git fetch origin codex/client-app-next
git checkout codex/client-app-next && git pull --ff-only
git rev-parse HEAD            # == SHA aprobado
git status                    # limpio
node --test tests/*.test.js
node scripts/test-auto-apply-emulator.cjs
git diff --check
firebase projects:list
firebase use                  # el runbook espera vdsen-ecosistema; `.firebaserc` no define alias por defecto, así que puede no haber proyecto activo: no confiar en esto y usar SIEMPRE --project vdsen-ecosistema explícito. Ante duda, DETENERSE

# 1. Guardar referencia de rollback de reglas (Console → Firestore → Reglas → historial): anotar versión/fecha y copiar el texto a un archivo fechado.
#    Referencia en repo: git show 3019bda:firestore.rules

# 2. Entitlement (por cada Coach aprobado)
node scripts/admin-coach-api-access.cjs --project vdsen-ecosistema --uid <coachUid> --grant --dry-run
node scripts/admin-coach-api-access.cjs --project vdsen-ecosistema --uid <coachUid> --grant --yes

# 3. Índices
firebase deploy --only firestore:indexes --project vdsen-ecosistema
#    Esperar en Console → Índices: plans_backup (coachId, clientId, backedUpAt) = Enabled. No continuar antes.

# 4. App + API (Vercel) — APP_DEPLOY_MECHANISM = GAP. SIN COMANDO APROBADO (ver sección 6b).
#    `git push origin codex/client-app-next:main` está RECHAZADO. No continuar hasta que Ayrton autorice por escrito una de las dos decisiones de la sección 6b.

# 5. Reglas (solo cuando 3 y 4 estén verificados)
firebase deploy --only firestore:rules --project vdsen-ecosistema
```

Orden: los pasos de Firebase (índices, reglas) son siempre manuales (no hay CI que los dispare); el único disparador automático posible es la integración Git de Vercel (un push a `main` publica la app al instante), por lo que `main` NO debe recibir el commit antes de que el índice esté *Enabled*, y las reglas solo después de la app verificada. Nota: cada push a `codex/client-app-next` ya genera un deployment *Preview* (sin efecto en producción); ese HTML canónico apunta al Firebase de producción, no distribuir URLs de preview. Si el binding de Vercel no coincide con `vdsen-ecosistema` (`prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`): NO-GO.

## 6b. Resolución del mecanismo de despliegue de la app (evidencia, sin ejecutar nada)

Resultado: **APP_DEPLOY_MECHANISM = GAP.** Evidencia (solo lectura, 2026-10-03):

- Repo: sin `.vercel/`, `.github/`, scripts de deploy, hooks, `productionBranch` ni `orgId`; `package.json` sin scripts; `vercel.json` solo rewrites/headers. La CLI de Vercel NO está instalada en la máquina de trabajo y no hay sesión (`VERCEL_ACCOUNT_METADATA` por CLI = NOT_VERIFIED; los metadatos salieron del conector Vercel de solo lectura).
- Vía probada: integración Git (todos los deployments *Production* recientes tienen `githubCommitRef=main`). Muta `main` → no aprobada.
- Candidato A, `vercel deploy --prod` desde un checkout limpio: sin evidencia en el repo (sin `.vercel/project.json`, sin vínculo local); subiría un árbol de trabajo sin identidad de release garantizada. No aceptado.
- Candidato B, **promover un deployment *Preview* existente**: existen deployments *Preview* `READY` del SHA exacto `d7bb71521d750eafd46a15fdd3c6ee157d4bd4cf` (`dpl_Eucadoaj3buvedSnDNxoeLaxtf3B`, rama `codex/client-app-next`; `dpl_G9zf5FSf162wQz5cwDTc5ARMj9zT`, rama `claude/t553-authority`), con `githubCommitSha` en sus metadatos → procedencia exacta verificable; no muta `main`; el orden lo controla el operador; rollback: el deployment de producción actual (`dpl_3RKY7…`, `f6596ba`) es `isRollbackCandidate=true`. La documentación de Vercel describe `vercel promote <deployment>` / «Promote» del panel («no reconstruye»). **No es evidencia del repo ni se ha demostrado en este proyecto**, y quedan sin verificar: (i) el ámbito de las variables de entorno: un deployment Preview se construyó con las variables *Preview*, y el listado de variables devolvió 403 (no se pudo comprobar que `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` existan con ámbito Production o Preview); (ii) autenticación/permiso para promover.
- Candidato C (hook/CI): no existe evidencia en el repo. Candidato D: ninguno.

**Decisión mínima que Ayrton debe tomar (no se toma en su nombre):** (1) una excepción explícita y por escrito que permita mutar `main` con el SHA aprobado (fast-forward, sin force), o (2) autorizar establecer y verificar un mecanismo sin `main` (promoción del Preview del SHA aprobado), que exige antes comprobar en el panel el ámbito de las variables `FIREBASE_*`/`OPENAI_*` y que el rollback a `dpl_3RKY7…` está disponible. Mientras tanto, el paso 4 sigue sin comando.

### 6b.1 Verificación de la ruta de promoción (solo lectura, 2026-10-03; nada se promovió ni desplegó)

| Pregunta | Resultado |
|---|---|
| Identidad del Preview `dpl_Eucadoaj3buvedSnDNxoeLaxtf3B` | `READY`, `target=null` (Preview), proyecto `vdsen-ecosistema` (`prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`), equipo `team_VZc5H7Q1DBIJ3g0mwrSBz1o8`, `source=git`, ref `codex/client-app-next`, SHA `d7bb715…`; no sustituido por ningún commit de runtime (solo docs después). |
| Firebase del lado cliente del Preview | PRODUCCIÓN: el HTML canónico en `d7bb715` lleva `projectId: "vdsen-ecosistema"` (el swap a staging solo existe en `preview/staging-client`). |
| Variables de entorno requeridas (nombres referenciados por `api/`) | `OPENAI_API_KEY`, `OPENAI_MODEL` (ya usadas por producción en `main`) y **nuevas** `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (`api/_firebaseAdmin.js`; `main` no las referencia: probablemente no existen hoy en Production). |
| Disponibilidad Preview / Production de esas variables | **NOT_VERIFIED** (el conector recibió 403 al listar variables). Firebase del lado servidor del Preview: **UNKNOWN** (un Preview usa las variables de ámbito Preview; podrían faltar o apuntar a staging). Mientras no se pruebe: `PREVIEW ENV COMPATIBILITY = NOT_VERIFIED`; si resultaran apuntar a staging → `PROMOTION_PATH = UNSAFE`. |
| `Production Branch` (Settings → Git) | **NOT_VERIFIED** (el conector no la expone). Evidencia indirecta: todos los deployments Production recientes son Git con ref `main`. |
| Permiso de promoción / destino / rebuild | `PROMOTION_PERMISSION = NOT_VERIFIED` (no se puede probar sin ejecutar; el conector ya mostró 403 en variables y en *rollback*). Destino = target Production del proyecto: NOT_VERIFIED. Rebuild: según la documentación de Vercel la promoción no reconstruye (NO), no comprobado en este proyecto. |
| Procedencia del código | PROBADA para el artefacto: el deployment es inmutable y sus metadatos fijan `githubCommitSha = d7bb715…`. Tras una promoción habría que releer el deployment Production y comprobar el mismo `githubCommitSha`. |
| Orden de despliegue | GAP mientras el entorno no esté probado. Si se resuelve: ningún push a `main` ocurre (la integración Git solo crea Previews para otras ramas), así que la promoción sería el único cambio de app; índices antes, reglas después. |
| Rollback | Objetivo `dpl_3RKY7UixzLDr9iK4NQ6VcKriz3Cn`: `READY`, `source=git`, SHA `f6596ba…`, con los alias de producción, y marcado `isRollbackCandidate=true` en la lista anterior (el listado de candidatos hoy devuelve 403 al conector). Mecanismo según la documentación de Vercel (NO evidencia del repo, NO ejecutar sin GO): `vercel rollback dpl_3RKY7UixzLDr9iK4NQ6VcKriz3Cn` (o promover de vuelta ese deployment desde el panel). La CLI no está instalada aquí. Si la app vuelve a `f6596ba`, revertir TAMBIÉN las reglas (la app antigua no funciona con las reglas nuevas). |

**Clasificación: APP_DEPLOY_MECHANISM = GAP** (entorno Preview no verificado, *Production Branch* no leída, permiso de promoción sin probar). **PROMOTION_PATH = GAP** (no se probó inseguro; tampoco seguro).

## 7. Verificación posterior (smoke; cuentas de prueba, sin datos personales reales)

| # | Verificación | Resultado esperado |
|---|---|---|
| 1 | Login atleta | entra; lee `clients/{uid}` |
| 2 | Plan activo | plan correcto (semana/día/ejercicios) |
| 3 | Registro detallado de serie | carga/reps guardados; RIR/ICS/Pump solo si se tocaron |
| 4 | Corrección de serie | «Corregir» actualiza un único registro |
| 5 | Temporizador de descanso | corre, alerta y avanza |
| 6 | Transición de sesión | siguiente serie/ejercicio con un toque |
| 7 | Completar + check-in | sesión completada; check-in guardado (el espejo `expedientes` puede mostrar «sincronización con coach pendiente»: esperado) |
| 8 | Home día siguiente | estado correcto tras completar |
| 9 | Notas | nota por semana+PID persiste |
| 10 | Última semana / USAR CARGA/REPS | solo lectura; USAR solo carga+reps, sin autoguardar |
| 11 | Nutrición (display) | calorías/macros/comidas sin NaN/undefined |
| 12 | Suplementos (display) | nombre, dosis, timing |
| 13 | Viewport móvil | 320–430 px sin desborde horizontal |
| 14 | Offline básico | sin éxito falso; escritura en cola se sincroniza una vez |
| 15 | Tenant / seguridad | atleta no escribe `progressionApplications`; otro coach / coach autocreado denegado en cliente ajeno, logs, fichas; reclamar huérfano denegado; API: sin entitlement 403, con entitlement OK, token inválido 401; Coach dueño lista clientes, abre Monitor, restaura respaldo de plan sin error de índice |
| 16 | Caché / SW | la app activa muestra el SW `vdsen-v13` (DevTools → Application) y carga el HTML nuevo en línea |
| 17 | Aserciones | `NUMERIC_APPLY_ENABLED` false; 0 registros `APPLIED`; `apiAccessEnabled` solo en UIDs aprobados; ningún Coach puede escribir `apiAccessEnabled` |

## 8. Rollback (por separado; solo lo que el runbook soporta)

- **App / API**: revertir el deployment de Vercel al anterior (el runbook dice «revertir en Vercel» al deployment previo anotado en el preflight). `apiAccessEnabled` es inocuo para el API antiguo.
- **Reglas Firestore**: Console → Reglas → historial → publicar de nuevo la versión anotada (o `firebase deploy --only firestore:rules --project vdsen-ecosistema` con el texto exportado). La app nueva sigue funcionando con reglas antiguas. Si se revierte la app, revertir TAMBIÉN las reglas: la app antigua no funciona con las reglas nuevas (razón del orden obligatorio del runbook; el runbook añade que el cliente antiguo solo pierde los registros de progresión del modo sombra, pero el Coach antiguo hace consultas que las reglas nuevas rechazan).
- **Índices**: aditivos; no requieren rollback.
- **Datos**: este release no migra datos; no hay rollback de datos.

## 9. Deuda conocida no bloqueante

Estrategia de visualización de logs raíz legacy/unbound en el Coach · `EXERCISE_HISTORY` al cambiar de plan · `buildBoostcampExercise` muerto · runtime Admin del API en staging sin ensayar · espejo de check-in `expedientes` sin regla · repo servido públicamente por Vercel (sin `.vercelignore`) y repositorio GitHub con `private: false` según la API (`CLAUDE.md` dice privado; verificar visibilidad) · supersets solo cubiertos por tests unitarios (el plan de Ayrton no tiene) · incrementos por equipo y auto-aplicación (fases futuras).

## 10. Problema de datos del plan conocido

Filas «Cardio Zone 2» (Día 6 / Día 7) del plan de Ayrton están autoradas como una serie de fuerza de 1 rep, **sin `exerciseType: "cardio"`**. Es DATO DE PLAN / autoría (lado Coach), no defecto del Client: el Client renderiza cardio cuando `exerciseType` es explícito y **nunca** lo infiere por el nombre. El plan no se modificó.

## 11. Procedencia de la validación humana

- Ayrton entrenó el **Día 6** con el build **T555** (preview de staging, cuenta humana de entrenamiento, no producción) y reportó fallos de UX (temporizador, alarma fuera del navegador, cardio); tras los arreglos de T555 comentó «lo demás parece que todo bien» (matiz: «parece»). Dispositivo/SO no registrados en el repo; la afirmación «móvil» procede de su reporte, no de un registro del dispositivo.
- Cambios posteriores (T556: alarma revertida, modo detallado + temporizador activos por defecto, «COACH AYRTON» en el encabezado) fueron los pedidos por él; **no** hubo una pasada humana nueva sobre el build final `cf9eaa9`. Esa validación se cubre con la evidencia automatizada de staging (`docs/CLIENT_MODULE_STATUS.md`, `docs/T554_TRAIN_READY.md`).
- La validación humana fue contra staging; **no hay validación humana contra producción**.

## 12. Checklist GO / NO-GO objetivo

GO solo si **todas** son verdaderas; cualquier falsa = NO-GO.

- [ ] HEAD = SHA aprobado por Ayrton; árbol limpio; `main` intacto hasta que Ayrton autorice por escrito el mecanismo de app.
- [ ] **APP_DEPLOY_MECHANISM probado y autorizado por Ayrton (hoy: GAP → NO-GO).**
- [x] `PRODUCTION_BASELINE_COMMIT` = `f6596ba` — **RESOLVED_FROM_VERCEL_METADATA** (deployment `dpl_3RKY7UixzLDr9iK4NQ6VcKriz3Cn`; no se resolvió desde el repo). Releer justo antes del GO.
- [ ] `--project vdsen-ecosistema` explícito; identidad del proyecto Vercel `prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN` PROBADA por metadatos (Production = deployments de Git con ref `main`); pendiente solo confirmar en el panel Settings → Git la *Production Branch* y el ámbito de las variables de entorno (listado 403 para el conector).
- [ ] Suite unitaria y de emulador en verde sobre el SHA; `git diff --check` limpio.
- [ ] `NUMERIC_APPLY_ENABLED=false` y 0 registros `APPLIED`.
- [ ] Todos los clientes reales tienen `coachId` (o recuperados vía script admin).
- [ ] Logs raíz del atleta real revisados (`planId` presente o riesgo LEGACY_UNBOUND aceptado por Ayrton).
- [ ] `apiAccessEnabled` concedido a los Coaches aprobados; 3 variables `FIREBASE_*` presentes en Vercel.
- [ ] Referencia de rollback (versión de reglas + deployment previo de Vercel) anotada.
- [ ] Índice `plans_backup` en estado *Enabled* antes de publicar reglas.
- [ ] Smoke (sección 7) completo tras app y tras reglas; cualquier fallo = rollback.
- [ ] Autorización explícita de Ayrton registrada.
