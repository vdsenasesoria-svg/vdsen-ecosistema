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
7. **Mecanismo de despliegue de la app = GAP (puerta de release; ver sección 6b).** La vía propuesta que NO muta `main` es *Promote to Production* del Preview `dpl_Eucadoaj3buvedSnDNxoeLaxtf3B` (SHA `d7bb715…`) desde el panel de Vercel. Sigue en GAP hasta cumplir las condiciones de la sección 6b.2. La vía por push a `main` queda RECHAZADA.
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
#    `git push origin codex/client-app-next:main` está RECHAZADO. La vía candidata sin `main` (acción de panel, NO ejecutar sin GO explícito de Ayrton): Deployments → `dpl_Eucadoaj3buvedSnDNxoeLaxtf3B` → «…» → «Promote to Production» (equivalente CLI según la documentación de Vercel: `vercel promote <url>`; la CLI no está instalada aquí). Requiere cumplir antes la sección 6b.2.

# 5. Reglas (solo cuando 3 y 4 estén verificados)
firebase deploy --only firestore:rules --project vdsen-ecosistema
```

Orden: los pasos de Firebase (índices, reglas) son siempre manuales (no hay CI que los dispare). La integración Git de Vercel solo publica en Production con un push a la rama de producción (`main`); cada push a otra rama genera solo un Preview. Con la promoción de Preview, `main` no se toca y la promoción es el único cambio de app. Contexto operativo: cada push a `codex/client-app-next` sigue creando Previews nuevos (sin efecto en Production); el Preview a promover debe ser el del SHA aprobado. Si el binding de Vercel no coincide con `vdsen-ecosistema` (`prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`): NO-GO.

## 6b. Resolución del mecanismo de despliegue de la app (evidencia, sin ejecutar nada)

Resultado: **APP_DEPLOY_MECHANISM = GAP.** Evidencia (solo lectura, 2026-10-03):

- Repo: sin `.vercel/`, `.github/`, scripts de deploy, hooks, `productionBranch` ni `orgId`; `package.json` sin scripts; `vercel.json` solo rewrites/headers. La CLI de Vercel NO está instalada en la máquina de trabajo y no hay sesión (`VERCEL_ACCOUNT_METADATA` por CLI = NOT_VERIFIED; los metadatos salieron del conector Vercel de solo lectura).
- Vía probada: integración Git (todos los deployments *Production* recientes tienen `githubCommitRef=main`). Muta `main` → no aprobada.
- Candidato A, `vercel deploy --prod` desde un checkout limpio: sin evidencia en el repo (sin `.vercel/project.json`, sin vínculo local); subiría un árbol de trabajo sin identidad de release garantizada. No aceptado.
- Candidato B, **promover un deployment *Preview* existente** (vía propuesta): existe un Preview `READY` del SHA exacto `d7bb71521d750eafd46a15fdd3c6ee157d4bd4cf` (`dpl_Eucadoaj3buvedSnDNxoeLaxtf3B`, rama `codex/client-app-next`), con `githubCommitSha` fijo en sus metadatos → procedencia exacta verificable; no muta `main`; el operador controla el orden. Contrato oficial de Vercel (<https://vercel.com/docs/deployments/promoting-a-deployment>, actualizada 2026-06-26, leída en esta sesión): *Promote preview to production* se hace «through a complete rebuild»; si las variables de Preview y Production difieren, «the variables used will change … to those you have linked to the production environment. You cannot use your preview environment variables in a production deployment». Es decir, **las variables de ámbito Preview NO son la puerta de release**; la puerta son las variables de ámbito **Production**.
- Candidato C (hook/CI): no existe evidencia en el repo. Candidato D: ninguno.

**Decisión que Ayrton debe tomar (no se toma en su nombre):** autorizar por escrito la vía de promoción de Preview (candidato B) una vez cumplidas las condiciones de 6b.2, o, alternativamente, una excepción explícita para mutar `main`.


### 6b.1 Tres operaciones distintas de Vercel (no confundir)

| Operación | ¿Rebuild? | Variables de entorno |
|---|---|---|
| **Promote Preview → Production** (vía propuesta, `dpl_Eucadoaj3…`) | **SÍ, rebuild completo** | Se usan las de **Production**; las de Preview no |
| **Instant Rollback** (a `dpl_3RKY7…`) | **NO** (reasigna dominios a un deployment que ya sirvió producción) | Las que ese deployment ya tenía; no se reconstruyen |
| Promover un deployment de producción *staged* | NO | — (no aplica a esta vía) |

La evidencia genérica «la API de promoción no reconstruye» NO aplica a Preview → Production.

### 6b.2 Estado de la ruta de promoción (solo lectura, 2026-10-03; nada se promovió ni desplegó)

| Elemento | Estado |
|---|---|
| Preview `dpl_Eucadoaj3buvedSnDNxoeLaxtf3B` | `READY`, `target=null` (Preview), proyecto `vdsen-ecosistema` (`prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`), equipo `team_VZc5H7Q1DBIJ3g0mwrSBz1o8`, `source=git`, ref `codex/client-app-next`, SHA `d7bb715…`; no sustituido por commits de runtime (después solo docs). |
| Procedencia del código | PROBADA para el Preview. Tras promover, el deployment Production resultante debe mostrar `githubCommitSha = d7bb71521d750eafd46a15fdd3c6ee157d4bd4cf`; comprobarlo. |
| Preview → Production reconstruye | SÍ (contrato oficial arriba). Entorno Preview: contexto, **no es puerta de release**. |
| Variables de entorno, ámbito **Production** (verificadas MANUALMENTE en el panel de Vercel; no se re-auditan) | `OPENAI_API_KEY` = PRESENT · `OPENAI_MODEL` = PRESENT · **`FIREBASE_PROJECT_ID` = MISSING · `FIREBASE_CLIENT_EMAIL` = MISSING · `FIREBASE_PRIVATE_KEY` = MISSING**. **PRODUCTION_FIREBASE_ENV = NOT_READY.** Clasificación: **PRODUCTION CONFIGURATION BLOCKER** (configuración de producción pendiente; NO es un defecto de código). Sin ellas el API falla cerrado (`FIREBASE_ADMIN_NOT_CONFIGURED`) y la generación con IA del Coach dejaría de funcionar tras la promoción. Procedimiento: sección 6c. |
| `FIREBASE_PROJECT_ID` en Production | MISSING; al añadirla debe ser exactamente `vdsen-ecosistema`. No imprimir secretos. |
| Firebase del lado cliente | PRODUCCIÓN (`projectId: "vdsen-ecosistema"` en el HTML canónico de `d7bb715`). |
| Permiso / acción *Promote to Production* disponible para el candidato | **NOT_VERIFIED** (solo se comprueba en el panel sin pulsarla). |
| Production Branch | **`main`** (verificado manualmente en el panel). No bloqueante para la promoción de Preview. Contexto operativo: un push a `main` publicaría en Production automáticamente; este release NO lo usa. |
| Rollback | Objetivo `dpl_3RKY7UixzLDr9iK4NQ6VcKriz3Cn`: `READY`, `source=git`, SHA `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c`, con los alias de producción, marcado `isRollbackCandidate=true` en la lista anterior (hoy el listado de candidatos devuelve 403 al conector). **Instant Rollback = sin rebuild.** Mecanismo según la documentación oficial (NO ejecutar sin GO): Deployments → ese deployment → Instant Rollback, o `vercel rollback dpl_3RKY7UixzLDr9iK4NQ6VcKriz3Cn`. Si la app vuelve a `f6596ba`, revertir TAMBIÉN las reglas. |

**Condiciones restantes para `APP_DEPLOY_MECHANISM = PROVEN` (hoy GAP):** (1) las tres variables `FIREBASE_*` se añaden en ámbito Production (`OPENAI_*` ya están) — ver 6c; (2) `FIREBASE_PROJECT_ID` de Production = `vdsen-ecosistema`; (3) *Promote to Production* está disponible/permitido para `dpl_Eucadoaj3…`; (4) el procedimiento de verificación posterior y de rollback sigue siendo ejecutable (el deployment `dpl_3RKY7…` sigue elegible y `READY`).
**Ya no es bloqueo:** «el entorno de servidor del Preview podría apuntar a staging» (Preview → Production reconstruye con variables de Production).


## 6c. Bootstrap de las variables Firebase Admin en Vercel Production (PREPARADO, NO EJECUTADO)

**No se añadió ninguna variable, no se creó ninguna cuenta de servicio ni clave, no se tocó IAM. NO PEGAR CREDENCIALES EN EL CHAT NI EN EL REPO.**

### 6c.1 Contrato de runtime (probado en el repo)

- Consumidor único: `api/_firebaseAdmin.js` (`process.env.FIREBASE_PROJECT_ID|CLIENT_EMAIL|PRIVATE_KEY`), usado solo por `api/vdsen-generate.js` (vía `api/_vdsenAuth.js`). Solo servidor (función de Vercel; nunca llega al navegador). Los scripts de operador (`scripts/admin-*.cjs`) usan credenciales propias del operador, no las de Vercel.
- Inicialización: carga perezosa (`require('firebase-admin')` al primer uso) con `admin.credential.cert({ projectId, clientEmail, privateKey })`; no hay JSON de cuenta de servicio ni fallback (ni ADC ni valores por defecto).
- Si falta cualquiera de las tres → `Error('FIREBASE_ADMIN_NOT_CONFIGURED')` y el API falla cerrado (probado en `api/_firebaseAdmin.test.js`).
- Clave privada: el código hace `privateKey.replace(/\\n/g, '\n')` → acepta `\n` literales (formato del JSON) o saltos de línea reales. **No** recorta comillas: pegar el valor SIN las comillas que rodean el campo en el JSON.
- Mismos nombres de variable en staging y producción (el repo no define otros); el valor de `FIREBASE_PROJECT_ID` decide el proyecto.

### 6c.2 Fuente de cada valor

| Variable | Valor / fuente | Formato | ¿Sensible? / ¿verificable a simple vista? |
|---|---|---|---|
| `FIREBASE_PROJECT_ID` | exactamente `vdsen-ecosistema` | texto | no sensible; visible → verificable |
| `FIREBASE_CLIENT_EMAIL` | campo `client_email` de una cuenta de servicio autorizada del proyecto de producción (termina en `@vdsen-ecosistema.iam.gserviceaccount.com`) | email | no secreto; visible si no se marca como sensible → verificable |
| `FIREBASE_PRIVATE_KEY` | campo `private_key` de una clave de la MISMA cuenta | PEM `-----BEGIN PRIVATE KEY-----…-----END PRIVATE KEY-----` con `\n` literales o saltos reales, sin comillas | sensible; no visible tras guardar → solo se verifica funcionalmente |

**SERVICE_ACCOUNT_IDENTITY = DECISION_REQUIRED.** El repo no prueba qué cuenta usar. `.env.example` indica el origen genérico (Firebase Console → Project Settings → Service Accounts → Generate new private key). Pista no probatoria: un script local (`vdsen-push.js`) referencia un JSON de operador del tipo `vdsen-ecosistema-firebase-adminsdk-fbsvc-<keyid>.json`, lo que sugiere que ya existe la cuenta Admin SDK por defecto de Firebase; no se infiere ni se inventa su email. Decisión para Ayrton: (a) reutilizar esa cuenta por defecto (permisos amplios en Vercel) o (b) una cuenta de servicio dedicada al runtime del API con rol mínimo (recomendada por mínimo privilegio; hay que crearla y es un cambio de IAM que debe autorizarse aparte). Cualquiera que sea, `client_email` y `private_key` deben salir del mismo JSON.

### 6c.3 Operaciones server-side y permisos mínimos

- Auth: `verifyIdToken(token)` (firma/emisor/audiencia/expiración; sin `checkRevoked`). Sin custom claims, sin gestión de usuarios.
- Firestore: UNA lectura, `coaches/{uid}` (campo `apiAccessEnabled === true`). Ninguna escritura. Ninguna otra operación Admin en `api/`.
- **MINIMUM IAM = PARTIAL.** El repo prueba el conjunto de operaciones (1 lectura Firestore + verificación de token), pero NO prueba un mapeo exacto de roles IAM. Candidato a validar (no probado por el repo): un rol de solo lectura de Firestore/Datastore sobre el proyecto (p. ej. visor de Datastore); no se necesita Owner/Editor ni permisos de escritura. El rol Admin SDK por defecto es más amplio de lo necesario.

### 6c.4 Procedimiento manual para Ayrton (solo Production)

1. Decidir `SERVICE_ACCOUNT_IDENTITY` (6c.2) y tener la cuenta/clave listas por el canal habitual. **No pegar valores en el chat ni en commits.**
2. Vercel → proyecto `vdsen-ecosistema` → Settings → Environment Variables → Add, **Environment = Production únicamente** (no Preview, no Development):
   - `FIREBASE_PROJECT_ID` = `vdsen-ecosistema`.
   - `FIREBASE_CLIENT_EMAIL` = el `client_email` de la cuenta elegida.
   - `FIREBASE_PRIVATE_KEY` = el `private_key` de esa cuenta (marcar sensible; sin comillas; los `\n` literales o saltos reales son válidos).
3. No tocar `OPENAI_*` ni nada más. No desplegar: un cambio de variables solo aplica a un deployment nuevo; la promoción de Preview → Production (que reconstruye con las variables de Production) las recogerá.

### 6c.5 Validación posterior a la configuración y ANTES de promover

1. Las tres variables existen con scope Production (y solo Production).
2. `FIREBASE_PROJECT_ID` = `vdsen-ecosistema` (visible).
3. El dominio del `FIREBASE_CLIENT_EMAIL` es `@vdsen-ecosistema.iam.gserviceaccount.com` y es la cuenta elegida.
4. La clave privada es de esa misma cuenta: no verificable en el panel (sensible); se comprueba en el smoke posterior a la promoción (Coach con `apiAccessEnabled` → el API responde bien; token inválido → 401) y, si falla, rollback (6b.2).
5. Ninguna variable apunta a staging (`vdsen-ecosistema-staging` no aparece en ningún valor).
6. El SHA de runtime sigue siendo `d7bb71521d750eafd46a15fdd3c6ee157d4bd4cf` (`git diff --name-status d7bb715..HEAD` = solo docs).
7. El Preview `dpl_Eucadoaj3buvedSnDNxoeLaxtf3B` sigue `READY`.
8. *Promote to Production* sigue disponible (sin pulsarlo).
9. `NUMERIC_APPLY_ENABLED` sigue en `false`.

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
- [ ] `--project vdsen-ecosistema` explícito. Vercel: PROJECT IDENTITY = PROVEN (`prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`); PRODUCTION BASELINE = PROVEN; PRODUCTION ENV VARS = NOT_VERIFIED; PROMOTION PERMISSION = NOT_VERIFIED; PRODUCTION BRANCH = NOT_VERIFIED / NO BLOQUEANTE para la promoción de Preview.
- [ ] Suite unitaria y de emulador en verde sobre el SHA; `git diff --check` limpio.
- [ ] `NUMERIC_APPLY_ENABLED=false` y 0 registros `APPLIED`.
- [ ] Todos los clientes reales tienen `coachId` (o recuperados vía script admin).
- [ ] Logs raíz del atleta real revisados (`planId` presente o riesgo LEGACY_UNBOUND aceptado por Ayrton).
- [ ] `apiAccessEnabled` concedido a los Coaches aprobados; `FIREBASE_PROJECT_ID` (= `vdsen-ecosistema`), `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY` añadidas en ámbito **Production** de Vercel (hoy MISSING; `OPENAI_*` ya PRESENT) siguiendo 6c, sin imprimir secretos y con `SERVICE_ACCOUNT_IDENTITY` decidida por Ayrton.
- [ ] Referencia de rollback (versión de reglas + deployment previo de Vercel) anotada.
- [ ] Índice `plans_backup` en estado *Enabled* antes de publicar reglas.
- [ ] Smoke (sección 7) completo tras app y tras reglas; cualquier fallo = rollback.
- [ ] Autorización explícita de Ayrton registrada.
