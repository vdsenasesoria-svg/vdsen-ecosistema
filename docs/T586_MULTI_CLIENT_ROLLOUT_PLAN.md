# T586 · Plan paso a paso para abrir el Motor autónomo a los demás clientes

**Estado:** solo un plan. No se ejecutó nada en producción, no se migró ningún plan, no se cambió el tope de 10 clientes ni se activó Numeric Apply para nadie más.
Lectura de producción (agregada, 2026-10-19): 33 planes activos; solo 1 tiene `updatedAt` válido; 294 de 1000 ejercicios tienen identificador (PID). Sin esos dos campos el motor no actúa (falla cerrado), por eso hace falta el paso 1.

## Paso 1 · Preparar los planes (lo hace el Coach desde la app, cliente por cliente)
1. En el Coach abre el cliente → plan → **Editar plan** y **Guardar** sin cambiar nada. El guardado explícito conserva los PID existentes, acuña los que faltan y fecha `updatedAt`. Alternativa: reimportar el JSON del Motor (ruta nueva).
2. Comprobación por cliente: el plan debe tener `updatedAt` (texto ISO) y un PID por ejercicio. Un plan guardado hoy ignora la evidencia anterior a esa fecha: la primera exposición válida es la siguiente.
3. Opcional, solo cuando el Motor externo emita el contrato nuevo: `muscleGroup` por ejercicio y `musclePriorities` a nivel plan. Sin ellos el motor funciona sin diferenciar por prioridad.
No hay migración automática de planes reales (decisión del propietario).

## Paso 2 · Cohorte (máx. 10 clientes por vez)
1. El propietario elige la cohorte (UID de Firebase). El piloto actual ocupa 1 plaza.
2. Allowlist de la release y canario del Coach con exactamente esos UID. La herramienta `scripts/pilot/ayrton-canary.cjs` solo maneja un UID; para una cohorte hay que ampliarla o editar ambos documentos con Admin (decisión y revisión aparte).
3. Una allowlist de más de 10 UID se invalida entera (falla cerrada). Subir el tope es un cambio de código y una decisión explícita.

## Paso 3 · Observación antes de aplicar
1. `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=false`: el servidor solo guarda lo que HABRÍA prescrito (registros PENDING en `logs/{uid}/mesos/{planId}`).
2. Una semana de revisión del propietario: ¿las decisiones propuestas son razonables por cliente? ¿hay dolor reportado?
3. Solo entonces `NUMERIC_APPLY_ENABLED=true` (variables de Vercel + release protegido).

## Paso 4 · Criterio de activación por cliente
Plan guardado con PID y `updatedAt` · ≥ 2 exposiciones comparables · cohorte ≤ 10 · sin dolor articular activo · observación sin sorpresas · interruptor de parada probado.

## Parada y reversión (de más rápido a más completo)
1. Apagar ambas barreras de Firestore (`ayrton-canary.cjs --mode stop` para el piloto; para una cohorte, el mismo cambio en los dos documentos).
2. Variables de Vercel a `false` y un release para que tomen efecto.
3. Una decisión del Coach sobre un ejercicio devuelve ese ejercicio al plan base.

## Qué NO cubre este plan (pendiente de reglas)
Regresión de repeticiones, redistribución de volumen entre músculos bajo fatiga y adaptación del RIR objetivo fuera de `rirByWeek`: ver `docs/T586_AUTONOMOUS_AUTHORITY.md` §5.
