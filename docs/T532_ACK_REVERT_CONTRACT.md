# T532 — Contrato ack vs revert (y por qué `t532::14` era flaky)

**Estado: contrato determinado leyendo la implementación. Test reescrito. Un arreglo NO probado se
revirtió.** Nada de producción se tocó.

---

## 1. CONTRATO: tipo A — no hay precedencia

Cada transacción re-verifica sus propios guards **dentro** de la transacción. Los guards son
mutuamente excluyentes **por estado**, no por prioridad:

| Operación | Exige | Si no se cumple |
|---|---|---|
| `recordConsumptionReceiptTransaction` (ack) | `pidExposureStarted(...)` | `TARGET_NOT_STARTED` |
| `revertOverlayTransaction` | `!targetStarted(...)` | `TARGET_ALREADY_STARTED` |

Fuente: `assets/progression-application-consumer.js`
- L318 `// Reversal is only possible before the target exposure has started.`
- L456 `if (!eff.pidExposureStarted(...)) return _fail('TARGET_NOT_STARTED')`
- L453 `if (r.state !== 'APPLIED') return _fail('INVALID_TRANSITION')`
- L335 `// Every transition is idempotent ... and re-verifies its guards INSIDE the transaction.`

**Conclusión: gana la que commitea primero, y la otra es RECHAZADA, nunca aplicada en silencio.**
No existe un ganador prescrito que el test pueda exigir.

---

## 2. POR QUÉ EL TEST ERA FLAKY

La versión anterior:

```js
const f = await fixture(); await apply(f); await persistFirstSet(f);
const [a, rv] = await Promise.all([ack(f), revert(f)]);
assert.equal(a.written, true);                      // <-- exige que ACK gane
assert.deepEqual([rv.written, rv.reason], [false, 'TARGET_ALREADY_STARTED']);
```

Exigía un **ganador concreto** de una carrera que el protocolo deja al scheduling. Y los dos
`runTransaction` **no son simétricos**:

- `ack` corre en el **SDK web sobre el cliente** (`f.client.db`) → su canal gRPC se abre en frío.
- `revert` corre en el **Admin SDK sobre el coach** (`f.coach.db`) → reutiliza un canal ya establecido.

Así que el desenlace depende de cuánto tarde el SDK web en abrir su canal. En una máquina rápida el
revert suele alcanzar a ver el estado ya iniciado y es rechazado (que es lo que el test quiere); con
más latencia el orden se invierte. Eso es exactamente un test que pasa casi siempre y falla de vez en
cuando — confirmado empíricamente: el run `8be3792d` falló y **el re-run del mismo commit pasó**.

---

## 3. HALLAZGO ADICIONAL: la cobertura lo estaba ocultando

El resultado del gate traía:

```
FIXED_BASELINE_FAILURES: 37
recommendation: "Remove fixed exact identities through a reviewed baseline commit"
```

`tests/t538-tenant-isolation.cjs::T01` estaba en la lista de fallos conocidos. Mientras estuvo ahí, el
baseline toleraba un fallo; al corregirse, **el baseline quedó en 0 fallos conocidos**, así que
**cualquier** fallo pasa a ser `critical`. `t532::14` dejó de estar enmascarado y el flake se hizo
visible. No fue una regresión: fue un flake preexistente que quedó expuesto.

---

## 4. LA CORRECCIÓN

`t532::14` ahora separa las dos mitades, que son cosas distintas:

**Mitad 1 — DETERMINISTA.** La primera serie ya está persistida, así que la exposición **ya empezó** y
el desenlace no depende del scheduling en absoluto. Se secuencia: primero el recibo, después el
revert. Prueba la garantía real ("una vez iniciada la exposición, el revert se rechaza") en vez de un
accidente de scheduling. **Sin sleep, sin reintentos, sin timeouts.**

**Mitad 2 — CARRERA GENUINA, sólo invariantes.** No hay nada persistido, así que el target no empezó y
**las dos intercalaciones son resultados legítimos del protocolo**. Se afirma:

- exactamente una gana;
- la perdedora es rechazada **con el motivo que produce su propio guard**;
- el estado final coincide con la ganadora;
- el número de eventos `REVERTED` coincide.

Nunca se exige un ganador concreto, así que ninguna intercalación puede hacer fallar el test.

`scripts/t532-race-repro.cjs` conserva la reproducibilidad (`--mode old|new --n N`).

---

## 5. LO QUE **NO** PUDE PROBAR — límite honesto

**No logré reproducir el flake localmente.** Medido:

```
modo viejo (la assertion flaky), arnés fiel al test : 100/100 PASS
6 cargas CONCURRENTES del mismo modo (150 en total) : 0 fallos
```

El arnés necesitó dos correcciones antes de ser fiel, y ambas fueron errores míos, no del producto:
`shown` debía llevar `overlayKey: 'ovl_'+key / dimension:'LOAD' / appliedValue:102.5` (con los valores
del fixture el guard devolvía `OVERLAY_NOT_SHOWN` antes de llegar al de exposición), y `expectedRevision`
debía ser `2`, no `1` (era `REVISION_CONFLICT`).

Por lo tanto: **el mecanismo descrito en §2 (asimetría web-SDK vs Admin-SDK en la apertura de canal) es
la explicación estructural, no una reproducción medida.** La corrección es válida igualmente, porque
elimina la dependencia de un ganador concreto — que es la propiedad que hacía al test no determinista —
pero no puedo afirmar que reproduje el fallo de CI.

---

## 6. LO QUE ESTE DOCUMENTO NO HACE

- No afirma haber reproducido el flake.
- No afirma que el mecanismo de §2 esté medido; es el único candidato estructural coherente.
- No usa reintentos, sleeps ni tolerancia probabilística.
- No restaura fallos conocidos ni saca el test de la lista crítica.
