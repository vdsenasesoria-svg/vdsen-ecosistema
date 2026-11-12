# Runbook: preparar una futura release de REGLAS de Firestore

Estado actual del repo: `release_mode` es **`app_only`**. Este documento es **procedimiento**, no una
autorización. **No describe nada que deba ejecutarse ahora.**

---

## 1. Por qué hace falta un procedimiento

Hasta el primer release de Client App, el estado revisado (`.release/vdsen-client.json`) describía
siempre una release de **reglas**. Desde ese release describe una release de **app**, y el propio
estado lo declara:

- `release_mode: app_only`
- `rules_transition.rollback_sha256` / `rollback_source_path` son **HISTÓRICOS**: pertenecen a la
  release de reglas ya cerrada. Un release de app nunca toca reglas, así que **no se reescribieron**
  a propósito: hacerlo destruiría la evidencia de qué habría restaurado esa release.
- `rules_transition.target_sha256` **sí** es actual: es el hash de las reglas vivas y se re-verifica
  en cada `check`.

Además, el carril de reglas exige ahora explícitamente su modo:

> `live.cjs` → `prepare()` y `apply()` llaman `assertReleaseMode(s, 'rules_only', ...)`
> **antes de cualquier trabajo de red**. Un estado `app_only` **no puede** llegar al camino de
> despliegue de reglas.

**Consecuencia:** una futura release de reglas **no puede** despacharse contra el estado actual. El
gate lo va a rechazar, y eso es intencional. Hay que preparar el estado primero.

---

## 2. Procedimiento

Todos los pasos son **locales y read-only** salvo el último, que es el dispatch (y ese no es parte
de este documento).

### Paso 1 — Declarar la intención

Cambiar `release_mode` a `rules_only` en `.release/vdsen-client.json`.

No alcanza con esto: el resto de los pasos es lo que hace que la declaración sea **verdadera**.

### Paso 2 — Leer las reglas VIVAS actuales

Leer el ruleset activo desde la API de Firebase Rules, **no** desde el archivo del repo. El repo
puede estar adelantado o atrasado respecto de lo desplegado; sólo lo desplegado puede ser baseline
de rollback.

- Endpoint de observación ya presente en el carril: `OBSERVED_RULES_API`
  (`https://firebaserules.googleapis.com/v1/projects/`)
- Requiere un `access_token` con scope **`cloud-platform`** — **no** un `id_token`
  (un `id_token` devuelve **HTTP 401**; ya pasó en esta serie).

### Paso 3 — Capturar la fuente exacta

Guardar el contenido **tal cual** se leyó, sin reformatear ni normalizar. El baseline de rollback
tiene que ser byte-idéntico a lo que estaba sirviendo.

### Paso 4 — Hashear

`sha256` del contenido capturado. Ese es el `rollback_sha256` nuevo.

### Paso 5 — Referencia inmutable content-addressed

Escribir el archivo en:

```
.release/rollback/firestore.rules.<sha256>.rules
```

El nombre **contiene** el hash, y el schema lo exige con este patrón:

```json
"rollback_source_path": { "pattern": "^\\.release/rollback/firestore\\.rules\\.[0-9a-f]{64}\\.rules$" }
```

Eso hace que la referencia sea inmutable y verificable: si el contenido cambia, el nombre deja de
coincidir y el gate falla.

### Paso 6 — Actualizar la procedencia

En `.release/vdsen-client.json`:

- `rules_transition.rollback_sha256` → el hash del paso 4
- `rules_transition.rollback_source_path` → la ruta del paso 5

### Paso 7 — Verificar el target

Confirmar que `rules_transition.target_sha256` es el hash de las reglas que se **quieren** desplegar,
y que ese contenido está en `firestore.rules` en el SHA de runtime revisado.

### Paso 8 — Re-correr los gates

```
node scripts/release/check.cjs
node scripts/release/baseline.cjs unit
node scripts/release/baseline.cjs emulator
git diff --check
```

Requisitos: `check.cjs` PASS, `NEW_REGRESSIONS=0`, `critical=[]`.

Los gates incluyen la coherencia del modo: `check.cjs` valida el estado contra el schema (donde
`app_only` **exige** `app_release` por `if`/`then`) y valida la coherencia cruzada cuando el modo es
`app_only`. Con `rules_only` esa coherencia no aplica, pero el bloque `app_release` **puede quedarse**
como registro histórico: el schema no lo prohíbe.

### Paso 9 — Recién entonces, dispatch

El dispatch de la release de reglas es una decisión del owner, fuera de este documento. El carril
exige además su **propio** kill switch (`PRODUCTION_RELEASE_ENABLED`) y el Environment `Production`.

---

## 3. Comandos autoritativos

Estos son los comandos canónicos, tal como los corre CI. **No** existe un `npm run` para ellos y
**no debe agregarse**: `check.cjs` exige que `package.json` sea byte-idéntico al del runtime
desplegado (`assert.deepEqual(git('show', runtime + ':package.json'), json('package.json'))`), así
que añadir un bloque `scripts` rompería el gate y forzaría un despliegue de producción sólo para
introducir un alias. Documentarlo es más barato y no toca la superficie desplegada.

```
node scripts/release/check.cjs
node scripts/release/baseline.cjs unit
node scripts/release/baseline.cjs emulator
git diff --check
```

## 4. Qué NO hacer

- **No** reescribir `rollback_sha256` sin capturar las reglas vivas: produciría un baseline falso y
  el rollback restauraría algo distinto de lo que estaba sirviendo.
- **No** asumir que `rules_transition` del estado `app_only` sirve para la release nueva.
- **No** cambiar el modo sin completar los pasos 2-6. El modo es una intención; los pasos la
  convierten en verdad.
- **No** tocar `main` ni desplegar reglas como parte de un release de app.

---

## 4. Nota sobre la reproducibilidad del baseline de emulador en Windows

Observado en esta serie, para que no se confunda con una regresión de producto:

- Local (Windows, Node 24): `47 PASS / 36 FAIL / 1 CANCELLED`
- CI canónico (Ubuntu, Node 22): `84 PASS / 0 FAIL`

`NEW_REGRESSIONS = 0` en ambos: los 36 fallos locales son **identidades del baseline conocido**, no
regresiones. La causa observada es una **cascada**: `tests/t538-tenant-isolation.cjs::T01` se
**CANCELA** en este entorno y sus tests siguientes caen como `FAIL`. Ejecutando `t538` solo, sus
tests pasan.

Recursos que **no** son la causa (verificado): el JAR del emulador está pinneado con hash
(`9d43599e…`), Java 21 está presente, el reporter estructurado emite correctamente sus 84 eventos
(`VDSEN_TEST_EVENT`), y el parseo los lee bien. La diferencia es de entorno, no de producto.

**El CI canónico es la autoridad.** Un `gate=FAIL` local con `NEW_REGRESSIONS=0` y
`KNOWN_FAILURES_REMAINING` igual al baseline conocido **no** debe tratarse como regresión.
