# Coach Next — Paquete de release (READ-ONLY, NO EJECUTADO)

**Estado del documento: EVALUACIÓN READ-ONLY. No se despachó ningún workflow, no se desplegó nada,
no se regeneró ningún manifiesto y no se tocó la producción.**

Base del paquete: rama `feature/coach-client-export-v2` (PR #40, ABIERTO) sobre la canónica
`codex/client-app-next` @ `e3828bddc22c2b4b5adce9dc2323edecc4e081b7`.

---

## 1. Identificadores

| Concepto | Valor |
|---|---|
| Candidato (rama del export) | `f9f1a8d` (PR #40, el commit más reciente del branch) |
| Canónica actual | `e3828bddc22c2b4b5adce9dc2323edecc4e081b7` |
| Runtime de producción hoy | `8365410cf7f09427c79ead77aa4f769c16e9a803` |
| Deployment de producción | `dpl_4xAS5kXuny7APpaRjozGeNdPETMj` |
| Deployment de rollback | `dpl_FngrtpodSKHZ9aPk75aA5SS7JGnB` |
| Runtime de rollback | `d7bb71521d750eafd46a15fdd3c6ee157d4bd4cf` |
| Reglas de Firestore (objetivo) | `ba172a4f2e9831e55fb0a10c369b4a073193efb56eb5ea61245a0f178043e1e6` |
| Reglas de rollback | `bb4402e9b99d2d78c1f2867fa09bd75b89f9a88046189edfb0302b0635635f0b` |
| `main` | `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c` (intacto) |
| `firebase_project` | `vdsen-ecosistema` |
| `release_mode` vigente | `app_only` |
| `release_status` | `READY` |
| `NUMERIC_APPLY_ENABLED` | `false` (4 módulos) |
| Kill switches | `CLIENT_APP_RELEASE_ENABLED=false`, `PRODUCTION_RELEASE_ENABLED=false` |

---

## 2. Delta contra el runtime desplegado

De las **37 rutas servidas** del candidato:

```
25  idénticas al runtime desplegado 8365410c   (sin cambio de bytes)
12  nuevas o modificadas:
      1  vdsen-coach.html                       (modificado: +144 / -6)
     11  assets/client-export/*.js              (NUEVAS)
```

`vdsen-cliente.html` y `firestore.rules` **no cambian**: verificado por `git diff --stat` entre el
runtime desplegado y el candidato (la salida sólo lista `vdsen-coach.html`). **No hay transición de
reglas en esta release.**

---

## 3. Rutas servidas NUEVAS

Registradas explícitamente en `scripts/release/deployed-product.cjs` dentro de `SERVED` y, hoy, dentro
de `CANDIDATE_ONLY`, porque **producción todavía no las sirve**:

```
assets/client-export/util.js
assets/client-export/security.js
assets/client-export/collect.js
assets/client-export/normalize.js
assets/client-export/derive.js
assets/client-export/media.js
assets/client-export/serialize.js
assets/client-export/zip.js
assets/client-export/firestore-io.js
assets/client-export/runner.js
assets/client-export/ui.js
```

```
SERVED 37   DEPLOYED 26   CANDIDATE_ONLY 11
```

---

## 4. ¿El carril APP-ONLY de staged-production puede liberar este candidato?

**SÍ, y es el carril correcto.** Motivos:

1. `release_mode` es `app_only` y esta release **no toca reglas** → el carril de app aplica tal cual.
2. El delta de producto está en `vdsen-coach.html`, **ya presente en el manifiesto desplegado**. El
   carril no necesita aprender rutas nuevas para promover el HTML.
3. Los 11 assets del export son estáticos y se sirven por la misma raíz; Vercel los publica junto al
   resto del árbol.

### Lo que el operador DEBE hacer y que no es obvio

> **Al desplegar el candidato, los 11 paths deben moverse de `CANDIDATE_ONLY` a "desplegado" y el
> manifiesto regenerarse — pero SÓLO después de que el deployment staged exista de verdad.**

La secuencia importa, y es la razón por la que la Fase 8 separó los dos conceptos:

1. Crear el deployment staged (`vercel deploy --prod --skip-domain`) desde un archivo git del commit
   exacto del candidato.
2. Verificar el commit contra el deployment staged para **las 37 rutas** (antes eran 26).
3. **Entonces** vaciar `CANDIDATE_ONLY` y regenerar `.release/deployed-product.json` con
   `generate <nuevo_runtime_sha>`, de modo que el manifiesto siga describiendo lo que producción sirve.
4. Promover **exactamente una vez**.

Si se regenerara el manifiesto *antes* del paso 1, se estaría declarando desplegado algo que no lo
está — precisamente la falsificación que la Fase 8 eliminó.

### Riesgo señalado

`verifyCandidate` exige que **toda** ruta registrada en `SERVED` exista en el commit candidato. Como
los 11 assets ya están commiteados, esto se cumple. Pero si el operador regenerase el manifiesto sin
haber desplegado, `verify()` fallaría (correctamente) y el workflow se detendría. **Es el
comportamiento diseñado, no un defecto.**

---

## 4.bis — Aceptación POST-MERGE (Fase 9) — EJECUTADA

Contra un **worktree de la canónica ya mergeada** (`e3828bddc22c2b4b5adce9dc2323edecc4e081b7`,
sin los assets del export, como corresponde a un PR #40 sin mergear), servida por el arnés con Coach
A/B sintéticos y el probe de módulo inyectado:

`
AISLAMIENTO A->B (17/17)
  A) pantalla de login     0 centinelas de A     B) shell estacionado   0 centinelas de A
  C) memoria del módulo    limpia                 C2) memoria de detalle  limpia
  D) DOM de B visible      0 centinelas de A      E) DOM de B oculto      0 centinelas de A
  F) opciones de select    0 de A entre 24        G) módulo de B          limpio
  H) atributos/ids         0 de A                 I) coach activo es B    correcto
  J) mismo NOMBRE resuelve correcto               K) el detalle de B no trae datos de A
  0 errores de consola

REGRESIÓN (7/7, lista 4.1 del mandato)
  R1  login sin recarga, lista poblada
  R2  detalle de cliente propio abre, body=18505, sin error crudo
  R3  activePlanId obsoleto tolerado, body=18506, sin error crudo
  R4  cliente sin plan abre
  R5.1/R5.2  logout/login del MISMO coach, DOS pasadas: limpio al salir y lista al volver
  R6  0 errores de consola atribuibles al build

TOTAL: 24/24 filas
`

**Conclusión de la Fase 9: el arreglo está VIVO en canónica y verificado sobre el artefacto mergeado,
no sobre la rama de trabajo.** El export no está en canónica, como corresponde.

---

## 5. Evidencia de staging

```
STAGING: NOT RUN
```

**No hay evidencia de staging.** La sesión no tiene credenciales ni Firebase CLI, por lo que no se
crearon las cuentas sintéticas Coach A/B ni los clientes C1..C4, y la matriz crítica de 20 filas no se
ejecutó. Esto **bloquea** el merge del PR #40 y, por tanto, este paquete queda **incompleto para un
GO de producción**.

Evidencia equivalente obtenida en su lugar (emulador + navegador real, sin tocar Firebase):

```
Coach A→B en la misma pestaña, con probe de módulo inyectado:
  A) pantalla de login      0 centinelas de A
  B) shell estacionado      0 centinelas de A
  C) memoria del módulo     limpia (el probe vio 9 hits antes del logout)
  D/E) DOM de B visible y oculto   0 centinelas de A
  F) opciones de select     0 de A, entre 24 opciones
  G) memoria del módulo de B        limpia
  H) atributos/ids de elementos    0 de A
  → 17/17 PASS, 0 errores de consola
```

---

## 6. Tests

| Suite | Resultado |
|---|---|
| coach-runtime-hardening | **16/16 PASS** |
| client-export | **31/31 PASS** |
| client-export-large (historia masiva) | **1/1 PASS** |
| client-export-responsiveness (Fase 5) | **4/4 PASS** |
| release-infrastructure | **19/19 PASS** |
| unit baseline | **PASS 1283/0** |
| `NEW_REGRESSIONS` | **0** |
| `critical` | **[]** |
| `check.cjs` | **PASS** |
| `git diff --check` | limpio |
| export emulator | **NOT RUN** (límite de tuberías del sandbox, medido) |
| export browser | **NOT RUN** |
| combinado Coach Next | **NOT RUN** |
| emulator CI | **sin regresión conocida** |

---

## 7. Recomendación

```
READY_FOR_PRODUCTION_GO: NO
```

Dos condiciones antes de cualquier GO:

1. **Staging autenticado** en `vdsen-ecosistema-staging` con Coach A/B sintéticos y la matriz de 20
   filas: es la única condición del mandato que sigue sin cumplirse.
2. **Decisión del operador** sobre el tramo residual de 2.4 s del export de 30k series (documentado en
   la Fase 5). No es un blocker de seguridad: el export es correcto y acotado, pero congela el hilo
   hasta 2.4 s en una sola tirada. Mover el export a un Web Worker lo resolvería y es una decisión de
   arquitectura, no un defecto.

Lo que **sí** está listo y verificado: el carril app-only aplica, no hay transición de reglas, el
delta de producto es un solo archivo más 11 assets estáticos, y la separación
desplegado/candidato permite liberarlo sin falsificar metadatos de producción.

---

## 8. Lo que este paquete NO hizo

- No despachó ningún workflow de release.
- No ejecutó `vercel deploy`, `vercel promote` ni ninguna mutación.
- No regeneró `.release/deployed-product.json`.
- No tocó reglas, `main`, ni ningún dato o usuario de producción.
