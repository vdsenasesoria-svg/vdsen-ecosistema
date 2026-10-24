# Runbook — canario de un atleta con LOAD autónomo (progresión autónoma)

> **Vigencia (T582/T583):** el equipamiento ya NO es un requisito de LOAD: sin incrementos verificados la carga es orientativa (`ADVISORY_GENERIC`). Los pasos que dicen "LOAD queda `BLOCKED_EQUIPMENT_DATA`" y el paso 0 son históricos. El procedimiento vigente del piloto (Ayrton) está en `docs/T583_AYRTON_PILOT_PROPOSAL.md`.

Estado de la evidencia: PENDING→APPLIED→CONSUMED, REPS, REST e idempotencia validados en staging hospedado (T576); LOAD con incremento verificado validado en emulador y en staging (T578). **Nada de esto se ha activado en producción.** Activar `AUTONOMOUS_PROGRESSION_ENABLED` / `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED` en el proyecto de producción es una **decisión explícita del director** (`docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md`, `AGENTS.md`: nunca habilitar la aplicación numérica dentro de un cambio de infraestructura de release; las credenciales de producción solo existen en los workflows protegidos). Este documento deja preparado el camino; no lo ejecuta.

## 0. Lo único que falta y no puede inventarse: los incrementos reales del Coach
Sin incrementos configurados LOAD queda `BLOCKED_EQUIPMENT_DATA` por diseño. Solo el Coach conoce los números reales del gimnasio.

1. Abre `docs/pilot/equipment-increments-pilot-template.csv` (5 equipos de mayor cobertura: mancuernas, barra olímpica, estación de poleas, polea alta, polea baja; lista completa por prioridad en `docs/EQUIPMENT_DATA_REQUIRED_NEXT.md`, plantilla completa en `docs/equipment-increments-template.csv`).
2. Completa **solo valores reales**; deja en blanco lo que no sepas:
   - `kind=STEP` → `unit` (KG o LB) + `step` (paso real de la pila; `min`/`max` opcionales).
   - `kind=PLATE_LOADED_BAR` → `unit` + `barWeight` + `smallestPlate` (el progreso mínimo es 2 × disco).
   - `kind=AVAILABLE_LOADS` → `unit` + `loads` separadas por espacio (p. ej. mancuernas disponibles).
3. Valídalo **sin tocar nada** (solo lee el archivo, usa el mismo parser que la importación del Coach, todo o nada):
   ```
   node scripts/validate-equipment-increments.cjs docs/pilot/equipment-increments-pilot-template.csv
   ```
   Debe decir `RESULTADO: VÁLIDO`, listar cuántos ejercicios del catálogo desbloquea cada equipo y salir con código 0. Cualquier error (unidad faltante, paso negativo, equipo desconocido, tipo desconocido) rechaza el archivo completo con el motivo.
4. Importa el mismo archivo en la app del Coach (Monitor → cola de equipos → importar), que muestra la vista previa de impacto antes de guardar. Esto escribe `coaches/{uid}.equipmentIncrements` con procedencia `COACH_CONFIGURED`.

## 1. Elegir al atleta piloto y sus ejercicios
- Un solo atleta (allowlist máx. 10, aquí 1), ideal con ≥ 2 exposiciones comparables por ejercicio y sin lesión activa (E08 bloquea aumentos con dolor articular).
- Lista de `prescriptionExerciseId` del piloto: usa solo ejercicios cuyo equipo quedó configurado en el paso 0.

## 2. Activación (solo con autorización del director; orden ya probado en staging)
1. Variables del proyecto de producción **a `false`** y desplegar por el workflow protegido (`.github/workflows/vdsen-release-prod.yml`, Environment `Production`).
2. Crear `releaseControl/autonomousProgression` = `{ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ['<uid del piloto>'] }` (solo Admin; ninguna regla la expone).
3. Canario del Coach: `coaches/{uid}.autoApplyCanary = { enabled: true, clientIds: ['<uid del piloto>'], prescriptionExerciseIds: ['<PIDs del paso 1>'] }`.
4. Habilitar `AUTONOMOUS_PROGRESSION_ENABLED=true` y `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=true` y redeplegar. **No habilitar CRON** durante el piloto (el cron solo procesa uids de la allowlist, pero añade un secreto y una ruta más).
5. Verificar con el propio atleta piloto: tras 2 exposiciones comparables y evidencia persistida, aparece el overlay `AUTOAJUSTE VDSEN` en la siguiente exposición; el Coach lo ve en el panel de monitoreo (estados PENDING → APPLIED → CONSUMED).

## 3. Qué mirar y cuándo parar
- Esperado: LOAD solo en pasos reales del equipo (nunca una carga fabricada); `BLOCKED_EQUIPMENT_DATA` si falta el dato; REPS/REST como antes; un único overlay por exposición.
- Parar y revertir ante: carga aplicada que el atleta no puede montar, overlay duplicado, dolor reportado que no bloquea, o cualquier 5xx repetido del endpoint `/api/autonomous-progression-trigger`.
- Reversión (en este orden): (1) `AUTONOMOUS_PROGRESSION_ENABLED=false` + `..._NUMERIC_APPLY_ENABLED=false` y redeploy; (2) borrar `releaseControl/autonomousProgression`; (3) vaciar `autoApplyCanary`; (4) un overlay ya aplicado y aún no consumido se revierte con `revertOverlayTransaction` (antes de que empiece la exposición objetivo). Tras desarmar, verificar con la fase OFF del arnés (`node scripts/t575-hosted-matrix.cjs --phase off ...`, solo staging) y que la allowlist no existe.

## 4. Validación previa recomendada en staging con los incrementos reales
Antes de producción, repetir en **staging** el caso H29–H31 de `scripts/t575-hosted-matrix.cjs` con los incrementos reales del piloto (procedimiento y trampas: `docs/T578_VERIFIED_LOAD_VALIDATION.md` §4/4b). Staging sigue desarmado; armarlo y desarmarlo siempre en la misma sesión.

## Limitaciones conocidas
- Rechazo en Preview y cron hospedado no probados (SKIP en las matrices hospedadas).
- Sin incrementos reales cargados hoy: 0 de 39 equipos con identidad resuelta tienen incremento.
- LOAD autónomo usa solo incrementos Coach-configurados; no se infiere nada del tipo de máquina ni del nombre del ejercicio.
