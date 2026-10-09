# EM.7 — Contrato real de autorización de queries (y por qué la assertion original era inválida)

**`firestore.rules` NO se modificó en ningún momento.** Su hash sigue siendo
`ba172a4f2e9831e55fb0a10c369b4a073193efb56eb5ea61245a0f178043e1e6`, idéntico al de producción.

Suite determinista: `tests/em7-query-authorization.cjs`, con el emulador de Firestore arriba y
`firebase-tools` en el runtime de test.

---

## 1. La assertion original era INVÁLIDA

EM.7 afirmaba:

> *"a clientId-only query MUST permission-deny for BOTH plans and plans_backup"*

Es falso: **las dos colecciones tienen contratos distintos** (leídos de `firestore.rules`).

| Colección | Regla de lectura | ¿Rama de atleta? |
|---|---|---|
| `plans` | L99-101 `(exists(coaches/uid) && resource.data.coachId == uid)` **\|\|** `resource.data.clientId == uid` | **SÍ** |
| `plans_backup` | L204 `resource.data.get('coachId','') == uid` | NO |
| `fichas_publicas` | L199 `isCoachUser() && resource.data.get('coachId','') == uid` | NO |

La rama `|| resource.data.clientId == request.auth.uid` en `plans` es **intencional**: el atleta lee su
propio plan. Por eso una query sólo por `clientId` puede comportarse distinto según la colección.

**Invariante correcta, la que sí se prueba:**

> **NINGÚN ACTOR PUEDE RECIBIR UN DOCUMENTO DE OTRO COACH/CLIENTE MEDIANTE UNA QUERY SUBESPECIFICADA.**

El resultado observable puede ser *permitida con filas propias*, *permitida con cero filas* o
*denegada*, según colección + identidad + forma de la query.

---

## 2. Hallazgo central: el motor devuelve HTTP 500, no EMPTY

Con token real del Auth emulator, sobre `plans`:

```
coach: coachId+clientId (control)   -> HTTP 200  [plan_A1]        ✅
athlete: clientId only              -> HTTP 500  {"status":"UNKNOWN"}
coach:   clientId only              -> HTTP 500  {"status":"UNKNOWN"}
owner bypass: clientId only         -> HTTP 200  [plan_A1]
```

**La query `clientId`-only sobre `plans` NO devuelve EMPTY.** El motor del emulador **no puede evaluar la
regla disyuntiva** para esa forma de query y **falla con 500**, en lugar de permitir o denegar.

Esto importa: una versión anterior de esta suite trataba `HTTP 500` como *"0 rows"*, y por eso varias
filas **pasaban por la razón equivocada**. Ahora un error de evaluación se reporta como **UNKNOWN** y
**nunca cuenta como PASS**: *"el motor no pudo decidir"* no es evidencia de seguridad.

En `plans_backup` y `fichas_publicas` —cláusula **simple**, sin disyunción— el motor **sí decide** y
**deniega correctamente**.

---

## 3. Resultado (12 filas deterministas)

```
CLIENT_A1 clientId==own                -> UNKNOWN (http500)
CLIENT_A1 clientId==foreign            -> UNKNOWN (http500)
COACH_A   coachId+clientId own         -> PASS  1 row  plan_A1
COACH_A   coachId=self+clientId=foreign-> PASS  0 rows
COACH_A   clientId only                -> UNKNOWN (http500)
COACH_A   clientId==B1 only            -> UNKNOWN (http500)
COACH_B   clientId==A1                 -> UNKNOWN (http500)
COACH_B   coachId=A+clientId=A1        -> PASS  DENIED  false for 'list' @ L99
COACH_B   coachId=A only               -> UNKNOWN (http500)
plans_backup  clientId only            -> PASS  DENIED  false for 'list' @ L204
plans_backup  coachId+clientId own     -> PASS  1 row  bk_A1
plans_backup  coachId=B                -> PASS  DENIED
plans_backup  CLIENT_A1                -> PASS  DENIED
fichas_publicas coachId=self           -> PASS  1 row  fp_A1
fichas_publicas coachId=B              -> PASS  DENIED
fichas_publicas CLIENT_A1              -> PASS  DENIED
fichas_publicas COACH_B coachId=A      -> PASS  DENIED
anonymous plans clientId only          -> PASS  DENIED

12/12 filas deterministas PASS
UNKNOWN_EVALUATIONS = 6  (todas sobre `plans` con forma clientId-only)
LEAK_DETECTED = NO
EM7_SECURITY = PASS_WITH_UNKNOWN_EVALUATIONS
```

**Cero filas ajenas en todo caso en que el motor pudo decidir.** No hay exposición de datos.

---

## 4. Clasificación

```
FOREIGN_DATA_EXPOSURE = NONE OBSERVED
EM.7_PRODUCT_SECURITY = PASS en todo caso determinista
RESIDUAL LIMITATION   = el motor del emulador no evalúa la regla disyuntiva de `plans`
                        para queries clientId-only -> UNKNOWN, nunca PASS
ROOT CAUSE (cuelgue)  = NO es transporte ni reglas: la assertion del test contradecía
                        el contrato de la colección
FIRESTORE.RULES CHANGED = NO
```

---

## 5. Lo que la suite NO afirma

- No afirma que la query `clientId`-only sobre `plans` sea segura **por decisión del motor**: es
  **UNKNOWN**. Lo probado es que **en todos los casos decidibles no aparece ninguna fila ajena**,
  incluidos los ataques cross-coach.
- No sustituye la cobertura del exportador real por Web SDK: el export sigue ejercitándose por su
  adaptador real en EM.1–EM.6 y EM.8–EM.11.
- No modifica reglas, no despliega, no toca producción.
