# T587 · Procedimiento reutilizable para preparar planes heredados (NO ejecutado en producción)

Herramientas: `scripts/plans/plan-normalization-lib.cjs` (pura) y `scripts/plans/normalize-legacy-plans.cjs` (CLI). Pruebas: `tests/t587-plan-normalization.test.js` (12).
**Solo lectura salvo `apply` y `rollback`, que exigen respaldo verificado + `--confirm` + `--authorized-by-owner "<texto>"`.**

## Diagnóstico real (lectura agregada de producción, sin identificadores)
33 planes activos → **1 listo, 32 por preparar**; 1000 ejercicios, **706 sin PID**, 0 PID duplicados, 32 sin `updatedAt`.

**Efecto de `updatedAt` sobre la comparabilidad** (solo planes que se escribirían): hay 348 exposiciones ligadas a un PID existente.
Con la política **`now`** (por defecto, conservadora) **0** seguirían siendo comparables (la evidencia anterior a la fecha de revisión deja de contar).
Con **`created`** (usar la fecha de creación) se conservan las **348**, pero asume que el plan no se editó después de crearse, algo que el sistema no puede probar.
Por eso no se actualiza en masa a ciegas: la política es una decisión del propietario, plan por plan o por lote.

## Qué hace (y qué no)
* Conserva los PID existentes; acuña solo los faltantes (únicos); un duplicado dentro del plan recibe PID nuevo (el primero conserva el suyo). No asocia historial antiguo a PID nuevos.
* Solo escribe `days` (si faltan o duplican PID) y/o `updatedAt` (si falta o es inválido; un `updatedAt` válido jamás se mueve). Preserva ejercicios, series, repeticiones, RIR, descansos, orden y cualquier otro campo (trabaja sobre el árbol REST tipado, sin decodificar).
* Idempotente: un plan que ya cumple no se escribe. Escritura con `updateMask` y precondición de `updateTime`: si el Coach edita a la vez, se rechaza y el proceso se detiene.
* No toca clientes, bitácoras, coach, reglas, variables de Vercel, IAM ni credenciales.

## Pasos
1. **Vista previa agregada** (solo lectura): `node scripts/plans/normalize-legacy-plans.cjs preview`. Por plan: `preview --uid <uid> --detail`. Política: `--policy now|created`.
2. **Respaldo verificable** (lee producción, escribe solo un archivo local con sha256 por plan y del conjunto): `backup --uids <a,b,…> --out <archivo.json>`.
3. **Simulación de aplicación** (sin banderas no escribe nada): `apply --uids <a,b,…> --backup <archivo.json> [--policy now|created] [--max N]`.
4. **Aplicación autorizada** (solo con autorización explícita del propietario): añadir `--confirm --authorized-by-owner "<texto>"`. Escribe un registro (`apply-log-….json`) con sha y `updateTime` posteriores y verifica cada plan al escribirlo; si una verificación falla, se detiene.
5. **Validación posterior** (solo lectura): `verify --backup <archivo.json>`.
6. **Parada:** crear un archivo `STOP` junto al respaldo (o `.stop-plan-normalization`): el proceso se detiene entre planes y deja su registro.
7. **Reversión:** `rollback --backup <archivo.json> --log <apply-log.json> --confirm --authorized-by-owner "<texto>"`. Restaura exactamente los campos cambiados (un `updatedAt` que no existía se vuelve a borrar) y se niega si el Coach editó el plan después de la aplicación.

## Recomendación de uso (decisión del propietario)
Empezar por la cohorte del piloto más 2–3 clientes con historial; `preview` por plan; elegir `now` (limpio, pierde la comparabilidad previa) o `created` (conserva 348 exposiciones si confirmas que no se editaron);
respaldo → simulación → aplicación → `verify`. Alternativa sin herramienta: guardar de nuevo cada plan desde el Coach (hace lo mismo con `updatedAt = ahora`).
