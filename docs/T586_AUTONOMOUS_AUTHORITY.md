# T586 · Autoridad autónoma del Motor: series, descanso, descarga, congelación y prioridad muscular

**Arquitectura (directiva del propietario):** el Coach prescribe el plan inicial y declara objetivos, condiciones y prioridades → el Cliente registra → el servidor (Motor VDSEN) interpreta la bitácora y ajusta;
el Cliente solo muestra la prescripción efectiva recibida. No hay un segundo motor: las reglas estructurales viven en `assets/progression-structural-policy.js` y el MISMO ciclo
(`materialize → PENDING → applyPending → APPLIED → CONSUMED`) las ejecuta, con un único candidato por exposición.

Alcance de esta entrega: **solo la progresión autónoma y la compatibilidad de planes heredados**. No toca `main`, producción, reglas de Firebase, IAM, credenciales, CRON, Numeric Apply ni otros clientes,
y no migra ningún plan real. Todo sigue detrás de los mismos interruptores (allowlist de la release + canario del Coach + `NUMERIC_APPLY`).

## 1. Qué decisiones ya se ejecutan (aplicadas Y visibles en la siguiente exposición)
| Decisión | Regla (fuente = algoritmo v3.1 del propio Cliente y tabla MEV/MRV del compendio) | Evidencia mínima |
| --- | --- | --- |
| LOAD ↑ / REPS ↑ / REST +30 s | Reglas A, C y doble progresión (sin cambios, T582–T584) | 2 exposiciones comparables, dirección confirmada |
| **Añadir serie** (`SETS` +1) | rendimiento sostenido frente a la exposición previa **y** ICS medio ≥ 8 **y** series < tope **y** volumen semanal del músculo + 1 ≤ techo | 2 exposiciones |
| **Reducir serie** (`SETS` −1) | dolor muscular post-sesión (EIMD) = 3 (veto), mínimo 1 serie | 1 exposición |
| **Descarga** (`DELOAD`) | ≥ 2 señales de fatiga (WHO-5 < 52, RPE de sesión > 9, sueño < 6 h, HRV −15 %, energía ≤ 3): series ÷ 2 (mín. 1), carga × 0,90; RIR objetivo solo si el plan trae `rirByWeek` | 1 exposición |
| **LOAD ↓** | ICS medio < 6 → × 0,85; ICS medio < 7 → × 0,90; esfuerzo mayor al prescrito en dos exposiciones consecutivas → × 0,95 | 1 / 1 / 2 exposiciones |
| **Congelar carga** (`FREEZE`) | una serie a RIR 0 fuera de la banda ±1, o esfuerzo mayor al prescrito (RIR medio − objetivo < −1) | 1 exposición |

Precedencia (una sola decisión por exposición): descarga > técnica (ICS) > dolor muscular > esfuerzo (congelar / × 0,95) > añadir serie > progresión LOAD/REPS (A, doble progresión) / REST (C).
El dolor articular sigue anulando **todo** cambio (SAFETY_CONFLICT); una decisión del Coach sobre ese ejercicio o una revisión del plan vuelve al plan base.

**Desviaciones deliberadas y conservadoras respecto de v3.1** (documentadas en el módulo): (a) las reglas de esfuerzo (congelar / × 0,95) van **antes** de añadir serie (v3.1 añadiría volumen a un atleta que ya trabaja más duro que lo prescrito);
(b) no se añade volumen mientras las repeticiones prescritas no se completen (eso es territorio de la regla C/E). Los valores por defecto de una post-sesión autocerrada o parcial (EIMD 2, sueño 7, RPE 7) **no cuentan** como evidencia.

## 2. Continuidad longitudinal (resuelta)
Una aplicación CONSUMIDA (el atleta ejecutó la exposición a la que apuntaba) sigue vigente en las exposiciones siguientes del mismo ejercicio hasta que otra la reemplace
(`CARRIED_OVERLAY`; LOAD/REPS/REST/SETS se arrastran; DESCARGA y CONGELAR son de su propia exposición). Se corta (vuelve al plan) por: revisión del plan, decisión del Coach sobre el PID, dolor articular reportado, cambio de unidad.
El plan base nunca se reescribe. Sustituye al límite documentado en T584 ("el overlay de REPS no se arrastra").

## 3. Prioridad muscular
Contrato mínimo (extensión compatible): `entrenamiento.musclePriorities = {PRIORITARIO:[claves], NO_PRIORITARIO:[claves]}` y, por ejercicio, `muscleGroup` (una clave). Vocabulario = las 19 claves de la tabla MEV/MRV (idéntico en Motor, Coach, Cliente y servidor; paridad probada).
Solo se persiste lo que el Coach/Motor declara; **nada se infiere del nombre** y un plan heredado sin declaración conserva su comportamiento. Un músculo declarado en ambas clases se descarta (ambiguo). `NO_PRIORITARIO` **no** es mantenimiento.
**Efecto real en el servidor:** el techo de volumen semanal para añadir series: PRIORITARIO hasta el MRV; NO_PRIORITARIO hasta el punto medio MEV/MRV (el propio comentario del compendio: "volumen óptimo ≈ punto medio"); sin declarar → MRV como antes.
El volumen cuenta **solo el músculo principal declarado** (un multiarticular no se cuenta varias veces) y usa lo que realmente está vigente (series ejecutadas, o las arrastradas). No hay porcentajes por categoría ni cambios de RIR/descanso por prioridad;
la prioridad nunca anula una condición de seguridad (descarga, ICS, dolor muscular y articular ganan para ambas clases).

## 4. Validación
* `tests/t586-structural-policy.test.js` (18): reglas puras, límites, paridad de tablas y vocabulario, carga/arrastre/reinicios, contrato del Coach y del Motor.
* `tests/t586-autonomous-authority-emulator.cjs` (12, emulador, ciclo cerrado: el atleta ejecuta lo que el servidor dejó): añadir/reducir serie, descarga (+ RIR por semana + regreso a línea base), congelar, LOAD ↓, REST, sin cambios injustificados,
  seguridad (dolor, decisión del Coach), continuidad de un mesociclo con **ejecución distinta de la sugerida** (102,5 en vez de 105: la siguiente evaluación parte de lo ejecutado), aislamiento, idempotencia, interruptores OFF, y los 4 escenarios de prioridad
  (misma evidencia / distinta prioridad → distinta estrategia, dos prioritarios, multiarticular, plan heredado, 4 semanas).
* Suites existentes actualizadas al contrato nuevo (no desactivadas): T475, T583-E5, T584-A2/E2/E3/E4/E5/E6 (T584-E2b conserva el contrato antiguo cuando el volumen está topado).
* **Cliente real en el navegador contra emuladores** (arnés `scripts/e2e-client-chain/`): el atleta registró la semana 2 por la interfaz → el servidor aplicó `SETS 3→4` en ambos ejercicios → la semana 3 mostró "AUTOAJUSTE VDSEN 3 → 4 series" y "0 de 4 series" → el atleta ejecutó **4** series
  → los registros pasaron a CONSUMED → la semana 4, sin decisión nueva, mostró "Vigente: 4 series" (`CARRIED_OVERLAY`). Evidencia local (no es un fixture de CI).
* Unitarias: 1568 pruebas; las 19 fallas locales de Windows (CRLF / documentos generados / recuperación de release) son las de línea base.

## 5. Estado por dimensión
**Ya se ejecutan:** LOAD ↑↓, REPS ↑, REST +30 s, SETS ±1, DELOAD (series, carga y RIR de `rirByWeek`), FREEZE, continuidad, prioridad (techo de volumen).
**Requieren nuevo contrato (no inventado):** `muscleGroup` y `musclePriorities` los emite el Motor externo (bloque definitivo actualizado en `references/motor-bloque-salida-entrenamiento.md`; el Motor externo NO se actualizó); hoy un plan sin esos campos funciona sin prioridad.
**Bloqueadas por falta de regla metodológica (se mantienen en revisión del Coach, no se adivinan):** regresión de repeticiones (regla E / D+E con repeticiones incompletas), magnitud de regresión tras UNA exposición difícil más allá de lo que fija v3.1,
redistribución de volumen **entre** músculos bajo fatiga, adaptación del RIR objetivo fuera de `rirByWeek` / descarga, y cualquier uso de músculos secundarios en el conteo de volumen.

## 6. Límites conocidos y decisiones del propietario
1. Una mejora que sí recomendamos antes de abrir a más clientes: los 33 planes activos de producción son de la ruta antigua (1 de 33 con `updatedAt` válido, 294 de 1000 ejercicios con PID): sin guardarlos de nuevo desde el Coach el motor no actúa (ver T585). Sin migración automática.
2. Tope de 10 clientes y piloto limitado al propietario: sin cambios.
3. El Cliente sigue calculando su propia recomendación v3.1 (consultiva); el servidor decide. Sus factores coinciden con el módulo compartido (probado), pero un cambio futuro de regla debe hacerse en `progression-structural-policy.js` y replicarse en el Cliente.
4. Las reglas estructurales numéricas (× 0,9 / × 0,85 / × 0,95, ÷ 2) son las de v3.1, marcadas por el propio Cliente como heurísticas VDSEN (nivel de evidencia C), no consenso científico.
