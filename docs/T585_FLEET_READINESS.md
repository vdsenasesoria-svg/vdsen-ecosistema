# T585 · Preparación de la progresión autónoma para todos los clientes (simulación)

**Alcance:** solo simulación y lectura agregada. No se desplegó nada, no se tocó producción, no se amplió el límite de 10 clientes, no se activó ningún cliente más.
Suite: `tests/t585-fleet-readiness-emulator.cjs` (emulador de Firestore, datos sintéticos, planes generados con el normalizador real del Coach).

## 1. Estado real de producción (lectura agregada, sin identificadores — 2026-10-19)
| Medida | Valor |
| --- | --- |
| Documentos de cliente | 64 (33 con plan activo; 1 coach; 1 con farmacología) |
| Planes activos con `updatedAt` como ISO string | **1 de 33** (el del piloto) |
| Ejercicios con `prescriptionExerciseId` | **294 de 1000** (9 planes completos, 24 incompletos) |
| Ejercicios con `exerciseId` de catálogo / `repsRange` | 0 / 0 |

**Consecuencia:** hoy el motor NO podría actuar para casi ningún cliente, aunque se abriera la allowlist. Sin `updatedAt` string el servidor falla cerrado
(`PLAN_TIMESTAMP_MISSING`) y sin PID no hay identidad (`IDENTITY_MISSING`). Son los planes de la ruta antigua "genera y activa de inmediato", que no estampa ninguno de los dos.
`exerciseId` y `repsRange` NO son bloqueantes: LOAD funciona sin equipamiento (T582) y, sin rango, la progresión usa carga.

## 2. Qué hace el motor con cada perfil (10 perfiles = el tope de la allowlist)
| Perfil | Resultado |
| --- | --- |
| Más fácil que el objetivo, KG | LOAD 100 → 105 |
| Más fácil que el objetivo, LB | LOAD 225 → 236 (grano de 1 LB) |
| Rango 8–12 con margen | REPS 10 → 12 |
| En el techo del rango, el Cliente dice "mantener" | sin cambio (`NO_NUMERIC_DELTA`): el Cliente es compuerta |
| Más duro que el objetivo (RIR por debajo) | sin cambio |
| El Cliente pide deload | **rechazado** (`UNSUPPORTED_ACTION`), nada se aplica |
| El Cliente pide reducir series | **rechazado** (`UNSUPPORTED_ACTION`), nada se aplica |
| ICS ≥ 8 → "añadir serie" | LOAD 100 → 105 (ya no bloquea) |
| Sin identidad de catálogo | LOAD orientativo en ambos ejercicios |
| Una sola exposición | nada (necesita 2 exposiciones comparables) |

Invariantes comprobados: nada cruza entre clientes; plan, coach, cliente y bitácora quedan idénticos byte a byte (el ejecutor solo refleja un `progressionApplicationSummary` de solo lectura);
cuatro semanas seguidas sin doble aplicación aunque el barrido corra dos veces; un objetivo nunca baja por sí solo; DISARMED no escribe nada; con la aplicación numérica apagada solo queda PENDING;
un cliente fuera de la allowlist recibe cero escrituras.

## 3. Tope de 10 clientes
Una allowlist de **11** se trata como inválida y **nadie** queda activado (falla cerrada, sin activación parcial por accidente). Con 10, funciona.
Para pasar de 10 hace falta una decisión explícita del propietario y un cambio de código (`RELEASE_MAX_CLIENTS`); no se tocó.

## 4. Camino a "todos los clientes" (decisiones del propietario)
1. **Preparar los planes.** Cada plan activo necesita ser guardado de nuevo desde el Coach (el guardado explícito conserva los PID existentes, acuña los que faltan y fecha `updatedAt`),
   o recrearse con la ruta nueva (importar el JSON del Motor). Probado: un plan heredado queda inerte y sin cambios; tras el guardado del Coach progresa.
   *Un script de migración directa a producción se descartó: modificaría datos de todos los clientes y no lo autorizaste.*
2. **Escalonar.** Cohortes de ≤ 10 clientes con la allowlist y el canario del Coach, observando primero con `NUMERIC_APPLY=false` (solo PENDING) antes de aplicar.
3. **Decidir el tope.** Si el objetivo es abrirlo a toda la cartera (33 planes), subir el tope o pasar a un interruptor global; no antes de cerrar los pendientes de abajo.
4. **Pendientes de seguridad del motor (no listos):** deload, reducir series y congelar carga siguen sin soporte en el servidor (solo los anota el Cliente);
   los overlays son por exposición (el de repeticiones no se arrastra a la siguiente); la magnitud del Cliente y la del servidor difieren.

## 5. Criterio de activación sugerido por cohorte
Plan guardado con PID y `updatedAt` · cliente con ≥ 2 exposiciones comparables · cohorte ≤ 10 · primera semana en observación (`NUMERIC_APPLY=false`) · sin dolor reportado ·
interruptor de parada probado (`ayrton-canary.cjs --mode stop` equivale a apagar ambas barreras) · revisión del propietario antes de pasar a aplicar.
