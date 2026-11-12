# T587 · Ampliación a los demás clientes: elegibilidad y diseño para superar el límite de 10 (sin habilitar a todos)

**Estado:** herramienta de elegibilidad (solo lectura) + diseño. **No se activó ningún cliente, no se tocó la allowlist ni el tope de 10, no se cambió ningún flag.**
Principio: el algoritmo es el mismo para todos; lo que cambia por persona es su plan inicial, sus prioridades, sus restricciones, su bitácora y su recuperación. No hay listas manuales de ejercicios ni de máquinas.

## 1. Elegibilidad técnica automática (`scripts/fleet/eligibility-report.cjs`, 3 pruebas)
Clasifica cada cliente: `NO_ACTIVE_PLAN` · `NEEDS_PLAN_PREP` (sin PID único por ejercicio y/o sin `updatedAt` ISO: el motor falla cerrado) · `SAFETY_HOLD` (dolor articular en cualquiera de las dos últimas sesiones registradas) ·
`NEEDS_EVIDENCE` (plan listo, aún sin 2 exposiciones comparables por identidad y posteriores a la última revisión del plan) · `ELIGIBLE`. *Elegible no significa activado.*
**Lectura real de producción (2026-10-20, agregada):** 65 clientes → 32 sin plan activo · **32 necesitan preparar el plan** · 0 con pausa de seguridad · **1 necesita evidencia (el piloto)** · **0 elegibles**.
Conclusión: hoy el cuello de botella no es el límite de 10 sino la preparación de los 32 planes (procedimiento de `docs/T587_LEGACY_PLAN_NORMALIZATION.md`) y acumular evidencia.

## 2. Mecanismos actuales
* Allowlist de la release `releaseControl/autonomousProgression` (solo Admin): `enabled`, `clientIds`; **más de 10 ids invalida todo** (falla cerrada); sin comodines.
* Canario del Coach `coaches/{id}.autoApplyCanary` (por cliente / por PID).
* Interruptores de entorno `AUTONOMOUS_PROGRESSION_ENABLED` y `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED` (se leen al desplegar). Sin `CRON_SECRET`, el barrido programado está inerte.
* El apagado fue demostrado en emulador (`tests/t587-pilot-stop-emulator.cjs`).

## 3. Diseño propuesto para superar el tope de 10 sin abrir todo (requiere decisión del propietario y un PR de código; NO implementado)
**Cohortes.** En lugar de una lista única más larga, un documento por cohorte (solo Admin): `releaseControl/cohorts/{cohortId}` = `{ schema:'vdsen-release-cohort-v1', enabled, clientIds (≤ 10), mode:'OBSERVE'|'APPLY', approvedBy, approvedAt, note }`.
* El servidor autoriza a un cliente solo si **existe una cohorte habilitada que lo liste** (releída dentro de cada transacción, como hoy). `OBSERVE` = solo materializa PENDING (lo que se habría prescrito); `APPLY` = además aplica (y solo si el flag global numérico está encendido). Una cohorte mal formada, con comodín, con > 10 ids o con un id repetido en otra cohorte habilitada **falla cerrada** y bloquea solo a esa cohorte.
* **Techo global** `RELEASE_MAX_TOTAL` (constante de código, p. ej. 30 al principio): la suma de ids de cohortes habilitadas no puede superarlo; superarlo invalida la ampliación, no a los ya activos de cohortes previas.
* **Parada por cohorte y global:** `enabled:false` en la cohorte (efecto inmediato) o en el documento maestro `releaseControl/cohorts/_global` (apaga todas); el piloto actual queda como cohorte 0 sin cambios de comportamiento.
* **Auditoría:** cada alta/baja de cohorte escribe un registro append-only (quién, cuándo, qué ids) que el motor nunca lee como autoridad.
* **Compatibilidad:** el documento actual `autonomousProgression` sigue valiendo como cohorte 0 hasta migrarlo.
**Pruebas necesarias antes de fusionar ese cambio:** cohorte válida / inválida / vacía / con comodín / con > 10 / con id duplicado; techo global; modo OBSERVE vs APPLY; parada por cohorte y global; aislamiento entre cohortes; idempotencia; retrocompatibilidad con el documento actual; emulador con el ejecutor real (como `t587-pilot-stop-emulator`).

## 4. Procedimiento de ampliación (por cohorte, hoy sin cambiar código: máximo 10 con el documento actual)
1. `eligibility-report.cjs --detail` → candidatos `ELIGIBLE` (y, tras preparar su plan, los `NEEDS_EVIDENCE`).
2. Preparar planes con el procedimiento A3 (vista previa → respaldo → simulación → aplicación **autorizada** → verificación; política de `updatedAt` decidida por el propietario).
3. El propietario elige la cohorte (≤ 10) y la autoriza; se activan las dos barreras para esos UID (herramienta equivalente a `ayrton-canary.cjs` extendida a una lista, con simulación por defecto).
4. Semana de **observación** con aplicación numérica apagada; revisión de lo que habría prescrito.
5. Solo entonces aplicación numérica; vigilancia con `pilot-readiness.cjs` (por cliente) y parada probada.
6. La siguiente cohorte repite 1–5 solo con el motor ya validado en la anterior.

## 5. Qué falta (honesto)
Sesión real del piloto (E2) · aprobación del propietario de la política de `updatedAt` y de la cohorte · PR de cohortes + techo (diseño de §3) · contrato de prioridad muscular emitido por el Motor externo · reglas sin definir (regresión de repeticiones, redistribución entre músculos bajo fatiga, RIR fuera de descarga).
