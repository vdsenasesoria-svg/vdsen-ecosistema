# T603 — Cierre de seguridad temporal del Motor (handoff)

Rama: `fix/t603-temporal-security` (base `2756441`, T602). Sin producción, sin `main`, **sin desplegar Rules**, sin IAM, sin datos reales, Numeric Apply OFF, kill switch intacto. Todo validado en emulador con atletas sintéticos.

## 1. Causa raíz (residuales de T602)

1. `entries.<log>.sts` lo escribe el SDK del atleta dentro de un **mapa libre**. Firestore Rules **no pueden iterar un mapa**, así que no existe una regla que obligue `entries[k].sts == request.time` para un número arbitrario de claves. Un atleta con el SDK podía escribir `sts` cualquiera. `serverTimestamp()` en el navegador solo garantiza la hora del servidor para el cliente honesto, no impide la falsificación.
2. `coachInterventions[].decidedAt` es texto del reloj del dispositivo del Coach dentro de un **array** (tampoco iterable por Rules).

## 2. Auditoría de autoridad de escritura (reglas actuales)

| Ruta | Atleta | Coach dueño | Otros |
|---|---|---|---|
| `logs/{uid}` y `logs/{uid}/mesos/{plan}` — `entries`, `currentWeek`, historial, unidades | escribe (campos de ejecución); no puede tocar `progressionApplications`/`nextExposureOverlays`/`progressionApplicationSummary`; recibos append-only | todo (incluye canónico) | nada |
| `clients/{uid}` — `coachInterventions[]` | solo `phone*` | actualiza cualquier campo salvo `coachId` | nada |
| `plans/{id}` | lee | edita su plan (incl. activo) | nada |
| Ejecutor servidor (Admin SDK) | — | — | materializa/aplica/consume (ignora Rules) |

Conclusión: la ejecución es del atleta (afirmación del atleta), la prescripción del Coach/servidor. El **orden** entre ambos necesita un sello que ninguno de los dos pueda fijar.

## 3. Frontera de autoridad implementada

Patrón: **documentos inmutables, create-only, cuyo `at` las Rules obligan a ser `request.time`**. No requiere iterar mapas.

### 3.1 Marcador de inicio de exposición — `logs/{uid}/starts/{planId}_{week}_{day}_{exIdx}`
- Lo crea el **atleta** justo después de la primera serie de trabajo persistida de esa exposición (Client: `_writeStartMarkers`, encolado detrás de la escritura del log, una vez por exposición y dispositivo).
- Rules: `at == request.time`; campos exactos; id = plan+semana+día+ejercicio; `setKey` coincide con la exposición; **`get()` del log del mesociclo debe contener esa serie con `done == true`** (no se puede pre-crear ni adelantar una exposición futura); sin `update`/`delete` (inmutable, único: un segundo dispositivo no lo mueve).
- El servidor (consumidor) lee **solo** el marcador para decidir el orden (`evaluateOverlay` con `trustedStarts`). `entries.sts`/`ts` se ignoran para autoridad; siguen usándose para visualización.
- Sin marcador + invalidación presente ⇒ sin autoridad (fail-closed). Sin invalidación ⇒ los datos históricos siguen funcionando. **El registro de entrenamiento nunca se pierde.**

### 3.2 Registro de decisión del Coach — `clients/{uid}/decisions/{interventionId}`
- Lo crea el **Coach dueño** (`ownsClient`) en el mismo commit (batch/transacción) que la intervención (app Coach: `_decisionRecord`).
- Rules: `at == request.time`, `decidedBy == auth.uid`, `id == decisionId`, campos exactos, create-only.
- El servidor sustituye `decidedAt` por `decision.at` para toda intervención con registro válido (`withServerDecisionTimes`) antes de evaluar apply-gate, override, stale y consume. Un registro inconsistente (id distinto) se ignora.
- No se amplía ningún permiso de escritura: el Coach ya escribía en `clients`; el atleta solo gana crear sus marcadores. Identidad Coach, propiedad del atleta, PID y plan siguen verificándose como antes.

## 4. Reglas necesarias (preparadas en `firestore.rules`, NO desplegadas)

`match /logs/{userId}/starts/{startId}` y `match /clients/{clientId}/decisions/{decisionId}` (ver archivo). Aditivas: no cambian ninguna regla existente.

## 5. Evidencia (emulador, reglas reales, atletas sintéticos)

- **Rules** (`tests/t603-temporal-rules-emulator.cjs`, 7): marcador válido con hora de servidor; **falsificados rechazados** (Timestamp pasado/futuro/`now()` de cliente, número, ISO, null, ausente); no se crea antes de la serie, con serie no hecha, de otra exposición, con id/`setKey` incoherente o campos extra; inmutable y único (update/delete/recreación denegados, otro dispositivo/otro atleta/Coach no pueden crearlo); orden log→marcador encolado; el log con `sts` falsificado **persiste** (evidencia conservada) pero sin autoridad; registros de decisión: hora de servidor, decidedBy, id, otros principales, inmutable.
- **Ejecutor servidor** (`t570r` T603.E1–E7): `sts` falsificado un día atrás + revisión previa ⇒ no consume (set conservado); relojes del dispositivo 1 / −30 min / +30 min con revisión previa ⇒ `TARGET_INVALIDATED`; revisión **posterior** al marcador ⇒ no retroactiva, `CONSUMED`; sin marcador y sin invalidación ⇒ `CONSUMED` (compatibilidad); override: el registro de servidor manda aunque el texto del Coach esté 2 días atrasado (bloquea) o adelantado (no retroactivo); registro inconsistente ignorado; **Numeric Apply OFF: cero aplicaciones**. Una aplicación inválida nunca llega a `CONSUMED`.
- **Navegador real** (`scripts/e2e-t599r/chain.cjs`, relojes −30/0/+30 min): T9 edición previa, T15 edición posterior, T16 escritura offline tardía (sellada al sincronizar, después de la revisión), más comprobación de que el Client crea el marcador aceptado por las Rules reales con hora de servidor. 24/24 por reloj.
- Unitarios `tests/t603-temporal-security.test.js` (7) + ajustes de tests existentes (fixtures que extraían funciones del Client).

## 6. Compatibilidad offline y concurrencia

Offline: log y marcador se encolan en orden y se sellan al sincronizar; una revisión hecha mientras tanto queda **antes** del marcador ⇒ sin autoridad (correcto). Dos dispositivos: gana el primer marcador (inmutable); el segundo recibe denegación silenciosa sin afectar su log. Concurrencia del ejecutor: sin cambios (transaccional); las lecturas extra son por id (≤200).

## 7. Resultados de gates

Unitarios: baseline PASS (0 regresiones). Emulador (Rules reales, ahora con 2 suites nuevas/ampliadas): baseline PASS, 0 regresiones. Navegador: T599 68/68, T598 sync 27/27, chain ON 41/41, chain OFF 9/9, T594 móvil 14/14, save-latency 10/10, T9/T15/T16 a −30/0/+30 min 24/24 cada uno. `release/check` PASS (kill switch y flag numérico intactos). Compatibilidad T597 (historial), T598 (sync), T599 (objetivos efectivos), T601 (tarjetas / Guardar serie) y T602 (resolución temporal) cubierta por esas puertas. Primer CI/ejecución local mostró 3 regresiones del gate de emulador por fixtures que extraían funciones del Coach (`_decisionRecord`) y por interferencia de ejecuciones simultáneas; corregido el fixture y repetido en limpio.

## 8. Riesgos residuales

1. **Evidencia fabricada**: el atleta puede escribir un `done` falso *antes* de una futura edición y crear su marcador (el servidor no puede saber si entrenó). Es manipulación de la evidencia de ejecución, no del reloj; mitigación fuera de alcance (validación de sesión en servidor).
2. **Intervenciones sin registro** (anteriores al despliegue o de una app Coach antigua) siguen juzgándose por su texto (reloj del Coach). Tras el despliegue todas las nuevas llevan registro.
3. El marcador solo se crea para la semana en curso (`REAL_WEEK`); datos de semanas pasadas no se reescriben.
4. `updateTime` del plan cambia con cualquier escritura (fail-closed conservador).
5. El marcador solo cubre ejercicios de fuerza con clave `log_W_D_E_sN`.

## 9. Requisitos exactos de despliegue (requieren autorización explícita del propietario; NO ejecutados)

**Orden obligatorio:**
1. **Desplegar `firestore.rules`** (aditivas). Hasta entonces `starts/` y `decisions/` están denegadas por defecto.
2. Desplegar API/Client/Coach (build `t603-temporal-security-20261025-01`). **Si el Coach se despliega antes que las Rules, sus decisiones fallan** (el batch incluye el registro denegado): por eso las Rules van primero. El Client antes de las Rules solo pierde marcadores (denegados en silencio; el servidor falla cerrado).
3. Verificar en emulador/Preview: marcador y registro creados; sin regresiones.
4. Solo después, y con autorización separada, evaluar Numeric Apply.
Rollback: revertir el build; las Rules aditivas pueden quedarse.

## 10. PR y dictamen

(se completa al fusionar)

**Dictamen para el piloto:** el error de reloj y la falsificación de `sts` y de `decidedAt` quedan cerrados *en emulador*. GO condicionado a: desplegar las Rules en el orden de §9 con autorización del propietario, y aceptar los residuales §8.1–§8.2. Numeric Apply sigue OFF.
