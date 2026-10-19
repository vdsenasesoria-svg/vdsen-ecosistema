# T584 · Sesión real de Ayrton con la actualización aplicada — pasos de la mañana

**Alcance:** solo la cuenta de Ayrton (UID entregado por el propietario en el chat de T584; no está en este repositorio). Sin CRON. Sin otros clientes. Sustituye la parte operativa de `docs/T583_AYRTON_PILOT_PROPOSAL.md`.

## Qué queda preparado
- El motor T584 (ICS ≥ 8 deja de bloquear LOAD/REPS; doble progresión en el techo del rango; carga orientativa sin equipo; la carga realmente usada alimenta la siguiente evaluación), fusionado en canonical con el CI en verde.
- `scripts/pilot/ayrton-canary.cjs`: enciende o apaga las **dos barreras de Firestore** (allowlist de la release + canario del Coach) **solo para un UID**. Por defecto simula; sin `--confirm` no escribe nada; se niega si ya hay otros clientes listados; no toca variables de Vercel, CRON, planes ni bitácoras.

## Orden (importa: las variables de entorno se leen al desplegar)
1. **Variables de producción** (Vercel → proyecto `vdsen-ecosistema` → Settings → Environment Variables, entorno *Production*):
   - `AUTONOMOUS_PROGRESSION_ENABLED` = `true`
   - `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED` = `true`  *(si prefieres observar primero sin aplicar: déjala en `false`; el servidor solo guardará lo que HABRÍA prescrito)*
   - **No** crees ni cambies `CRON_SECRET`: sin él el barrido programado no actúa.
2. **Release** del commit de T584 (lleva el motor nuevo y toma las variables del paso 1): interruptor `CLIENT_APP_RELEASE_ENABLED=true` en GitHub → Environment *Production*, luego el workflow `vdsen-app-release-prod.yml` con `runtime_sha` = el SHA de la fusión de T584 (te lo dejo en el informe), y al terminar vuelve a poner el interruptor en `false`.
3. **Barreras de Ayrton** (una sola vez; requiere `gcloud auth login` en tu equipo):
   ```
   node scripts/pilot/ayrton-canary.cjs --uid <UID_AYRTON> --mode status
   node scripts/pilot/ayrton-canary.cjs --uid <UID_AYRTON> --mode enable
   node scripts/pilot/ayrton-canary.cjs --uid <UID_AYRTON> --mode enable --confirm
   ```
   El primero solo lee, el segundo simula, el tercero escribe.

## Qué esperar en tu sesión
- Entrenas normal en el Cliente (carga, repeticiones, RIR, ICS) y completas la sesión. Con ICS ≥ 8 el Cliente puede recomendar "añadir serie": eso queda para el Coach y ya **no** bloquea un posible ajuste de carga o repeticiones.
- Si hay evidencia suficiente (2 exposiciones comparables del mismo ejercicio, dirección confirmada, sin dolor), en la **siguiente exposición** verás **AUTOAJUSTE VDSEN** (valor anterior → nuevo) en ese ejercicio: carga orientativa (puedes usar otra y registrar la real; esa será la base de la siguiente evaluación) o repeticiones dentro del rango del Motor. Sin evidencia suficiente: nada cambia.
- Con `NUMERIC_APPLY=false` no verás cambios: solo quedan registros `PENDING` en `logs/{uid}/mesos/{planId}` con lo que se habría prescrito.

## Detener o revertir (de más rápido a más completo)
1. `node scripts/pilot/ayrton-canary.cjs --uid <UID_AYRTON> --mode stop --confirm` → efecto inmediato (el ejecutor relee ambas barreras dentro de cada transacción).
2. Variables del paso 1 de nuevo a `false` y repetir el paso 2 (release) para que tomen efecto.
3. Una decisión del Coach sobre un ejercicio concreto hace que el Cliente muestre su prescripción base (y una exposición ya empezada conserva lo que empezó).

## Parar si ocurre cualquiera
Una carga que no puedes montar de forma sistemática · más de un ajuste para la misma exposición · dolor reportado que no bloquea · unidad incorrecta · cualquier error repetido del endpoint `/api/autonomous-progression-trigger`.
