# Client app — paquete de lanzamiento a producción (NO EJECUTADO)

Estado: **preparado, NO desplegado.** Ningún comando de este documento se ejecutó. Este documento NO autoriza producción: la autorización es de Ayrton.
Autoridad de la secuencia: `docs/FIRESTORE_DEPLOYMENT_RUNBOOK.md` (no se inventan comandos fuera de él / del repositorio).

## 1. Identidad del release

| Campo | Valor |
|---|---|
| Rama | `codex/client-app-next` |
| Commit de código aprobado (SHA completo) | `cf9eaa9c96a5c9313806234971dc9e4be8b67c72` |
| Commits posteriores | solo este paquete + `tests/t558-self-coach-topology.cjs` (+ su alta en la lista del runner de emulador). **Cero cambios de código de runtime** desde `cf9eaa9`. |
| `main` (referencia, intacta) | `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c` (ancestro del release: el release es fast-forward de `main`) |
| Alcance | App Client (`vdsen-cliente.html`) + reglas/índices/API/SW requeridos por el runbook |
| Estado congelado | CLIENT TRAINING = FEATURE_COMPLETE · NUTRICIÓN = DISPLAY_ONLY / DISPLAY_READY · SUPLEMENTOS = DISPLAY_ONLY / DISPLAY_READY · `NUMERIC_APPLY_ENABLED = false` |

El SHA a desplegar es el HEAD de `codex/client-app-next` al momento de la autorización; verificarlo con `git rev-parse HEAD` y compararlo contra el SHA que Ayrton apruebe.

## 2. Módulos incluidos

- Client Training completo (registro por serie y Express, corrección, temporizador de descanso + alerta + avance, SIGUIENTE/CONTINUAR, notas por semana/PID, ÚLTIMA SEMANA + USAR CARGA/REPS, sustituciones, cardio explícito, check-in post-sesión, Home día siguiente, offline/reconexión).
- Nutrición: solo visualización. Suplementos: solo visualización (contrato en `docs/CLIENT_MODULE_STATUS.md`).
- Endurecimiento de reglas Firestore, índice `plans_backup`, API endurecida (`api/*`, requiere `apiAccessEnabled`), service worker `vdsen-v13`.

## 3. Explícitamente excluido

Auto-aplicación numérica (`NUMERIC_APPLY_ENABLED=false`; no hay registros `APPLIED`) · incrementos por equipo · generador / autoría de planes · tracking de nutrición · tracking de suplementos · pulido especulativo de entrenamiento.

## 4. Delta de producción

**PRODUCTION_BASELINE_COMMIT = UNKNOWN.** El commit hoy desplegado en producción no se puede probar desde el repositorio (`main` = `f6596ba` es solo una pista, no una prueba). Antes de desplegar, probarlo en el panel de Vercel (Deployments → Production → commit) y anotarlo aquí.

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
7. **Auto-deploy de Vercel**: según `CLAUDE.md` un push a `main` despliega solo. Para respetar el orden (índices → app → reglas) la app NO debe desplegarse por un push accidental: confirmar en el panel qué rama es *Production* y cuándo se mergea. Ver sección 6, paso 4.
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
firebase use                  # debe imprimir exactamente vdsen-ecosistema; si hay duda, DETENERSE

# 1. Guardar referencia de rollback de reglas (Console → Firestore → Reglas → historial): anotar versión/fecha y copiar el texto a un archivo fechado.
#    Referencia en repo: git show 3019bda:firestore.rules

# 2. Entitlement (por cada Coach aprobado)
node scripts/admin-coach-api-access.cjs --project vdsen-ecosistema --uid <coachUid> --grant --dry-run
node scripts/admin-coach-api-access.cjs --project vdsen-ecosistema --uid <coachUid> --grant --yes

# 3. Índices
firebase deploy --only firestore:indexes --project vdsen-ecosistema
#    Esperar en Console → Índices: plans_backup (coachId, clientId, backedUpAt) = Enabled. No continuar antes.

# 4. App + API (Vercel). El runbook solo dice «desplegar el commit aprobado»; el mecanismo del repo es Vercel con auto-deploy en push a main.
#    Con el SHA aprobado: git push origin codex/client-app-next:main   (fast-forward; sin force)   ← ESTE paso despliega producción
#    Verificar en el panel de Vercel que el deployment Production corresponde al SHA y que /coach y /cliente cargan.

# 5. Reglas (solo cuando 3 y 4 estén verificados)
firebase deploy --only firestore:rules --project vdsen-ecosistema
```

Antes del paso 4 confirmar en Vercel que la rama de producción es `main` y que no existe otro proyecto enlazado al repo. Si el binding no coincide con `vdsen-ecosistema`: NO-GO.

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
- **Reglas Firestore**: Console → Reglas → historial → publicar de nuevo la versión anotada (o `firebase deploy --only firestore:rules --project vdsen-ecosistema` con el texto exportado). La app nueva sigue funcionando con reglas antiguas. Si se revierte la app pero NO las reglas, el cliente antiguo no puede crear registros de progresión (solo afecta al modo sombra, no al registro de entrenamiento) — revertir reglas primero o junto con la app.
- **Índices**: aditivos; no requieren rollback.
- **Datos**: este release no migra datos; no hay rollback de datos.

## 9. Deuda conocida no bloqueante

Estrategia de visualización de logs raíz legacy/unbound en el Coach · `EXERCISE_HISTORY` al cambiar de plan · `buildBoostcampExercise` muerto · runtime Admin del API en staging sin ensayar · espejo de check-in `expedientes` sin regla · repo servido públicamente (sin `.vercelignore`) · supersets solo cubiertos por tests unitarios (el plan de Ayrton no tiene) · incrementos por equipo y auto-aplicación (fases futuras).

## 10. Problema de datos del plan conocido

Filas «Cardio Zone 2» (Día 6 / Día 7) del plan de Ayrton están autoradas como una serie de fuerza de 1 rep, **sin `exerciseType: "cardio"`**. Es DATO DE PLAN / autoría (lado Coach), no defecto del Client: el Client renderiza cardio cuando `exerciseType` es explícito y **nunca** lo infiere por el nombre. El plan no se modificó.

## 11. Procedencia de la validación humana

- Ayrton entrenó el **Día 6** en su móvil con el build **T555** (preview de staging, cuenta humana de entrenamiento, no producción) y confirmó «todo bien».
- Cambios posteriores (T556: alarma revertida, modo detallado + temporizador activos por defecto, «COACH AYRTON» en el encabezado) fueron los pedidos por él; **no** hubo una pasada humana nueva sobre el build final `cf9eaa9`. Esa validación se cubre con la evidencia automatizada de staging (`docs/CLIENT_MODULE_STATUS.md`, `docs/T554_TRAIN_READY.md`).
- La validación humana fue contra staging; **no hay validación humana contra producción**.

## 12. Checklist GO / NO-GO objetivo

GO solo si **todas** son verdaderas; cualquier falsa = NO-GO.

- [ ] HEAD = SHA aprobado por Ayrton; árbol limpio; `main` intacto hasta el paso 4.
- [ ] `PRODUCTION_BASELINE_COMMIT` probado en el panel de Vercel y anotado (hoy: UNKNOWN).
- [ ] `firebase use` / `--project` = `vdsen-ecosistema`; binding de Vercel = `prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`, rama Production confirmada.
- [ ] Suite unitaria y de emulador en verde sobre el SHA; `git diff --check` limpio.
- [ ] `NUMERIC_APPLY_ENABLED=false` y 0 registros `APPLIED`.
- [ ] Todos los clientes reales tienen `coachId` (o recuperados vía script admin).
- [ ] Logs raíz del atleta real revisados (`planId` presente o riesgo LEGACY_UNBOUND aceptado por Ayrton).
- [ ] `apiAccessEnabled` concedido a los Coaches aprobados; 3 variables `FIREBASE_*` presentes en Vercel.
- [ ] Referencia de rollback (versión de reglas + deployment previo de Vercel) anotada.
- [ ] Índice `plans_backup` en estado *Enabled* antes de publicar reglas.
- [ ] Smoke (sección 7) completo tras app y tras reglas; cualquier fallo = rollback.
- [ ] Autorización explícita de Ayrton registrada.
