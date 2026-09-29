# Simulación de serie representativa (solo análisis)

Generado por `node scripts/simulate-representative-set.cjs` con fixtures sintéticos deterministas. **No selecciona ninguna política y no está conectado al runtime.**
Objetivo de la fixture: 10 reps @ RIR 2. Estrategias: LAST_SET (heurística actual), WORST_SET (mayor falta de reps y menor margen RIR), BEST_SET (lo contrario),
MEAN (promedio redondeado de reps y RIR observado; el motor legado v3.1 promedia las series).

- Exposiciones sintéticas: **40** (20 patrones × historial previo igual / neutro)

## Resultado por estrategia

| Estrategia | Elegibles | Sin resolver | Dirección UP | DOWN | REST |
|---|---|---|---|---|---|
| LAST_SET | 5 | 28 | 4 | 16 | 6 |
| WORST_SET | 4 | 30 | 2 | 20 | 6 |
| BEST_SET | 9 | 10 | 14 | 4 | 4 |
| MEAN | 10 | 14 | 2 | 8 | 18 |

## Cuánto cambia la elección de estrategia el resultado

| Par | Cambia dirección | Cambia dimensión | Cambia magnitud | Cambia elegibilidad | Cualquier cambio |
|---|---|---|---|---|---|
| LAST_SET vs WORST_SET | 4 (10%) | 2 (5%) | 4 (10%) | 1 (3%) | 4 (10%) |
| LAST_SET vs BEST_SET | 28 (70%) | 16 (40%) | 28 (70%) | 8 (20%) | 28 (70%) |
| LAST_SET vs MEAN | 16 (40%) | 14 (35%) | 28 (70%) | 7 (18%) | 28 (70%) |
| WORST_SET vs BEST_SET | 32 (80%) | 18 (45%) | 32 (80%) | 9 (23%) | 32 (80%) |
| WORST_SET vs MEAN | 16 (40%) | 12 (30%) | 28 (70%) | 6 (15%) | 28 (70%) |
| BEST_SET vs MEAN | 32 (80%) | 26 (65%) | 32 (80%) | 11 (28%) | 32 (80%) |

## Detalle (historial previo igual)

| Patrón | LAST | WORST | BEST | MEAN |
|---|---|---|---|---|
| steady reps / easy RIR | UP A → 102.5 | UP A → 102.5 | UP A → 102.5 | UP A → 102.5 |
| steady reps / drifting RIR | no-elegible · DOWN D → 9 | no-elegible · DOWN D → 9 | UP A → 102.5 | no-elegible · HOLD MAINTAIN |
| steady reps / onTarget RIR | no-elegible · HOLD MAINTAIN | no-elegible · HOLD MAINTAIN | no-elegible · HOLD MAINTAIN | no-elegible · HOLD MAINTAIN |
| steady reps / grinding RIR | no-elegible · DOWN D → 8 | no-elegible · DOWN D → 8 | no-elegible · HOLD MAINTAIN | no-elegible · DOWN D → 9 |
| steady reps / lateEasy RIR | UP A → 102.5 | no-elegible · DOWN D → 9 | UP A → 102.5 | no-elegible · HOLD MAINTAIN |
| fading reps / easy RIR | no-elegible · UNKNOWN A+E → 6 | no-elegible · UNKNOWN A+E → 6 | UP A → 102.5 | no-elegible · UNKNOWN A+E → 8 |
| fading reps / drifting RIR | no-elegible · DOWN D+E → 9 | no-elegible · DOWN D+E → 9 | UP A → 102.5 | REST C → 120 |
| fading reps / onTarget RIR | REST C → 120 | REST C → 120 | no-elegible · HOLD MAINTAIN | REST C → 120 |
| fading reps / grinding RIR | no-elegible · DOWN D+E → 8 | no-elegible · DOWN D+E → 8 | no-elegible · HOLD MAINTAIN | no-elegible · DOWN D+E → 9 |
| fading reps / lateEasy RIR | no-elegible · UNKNOWN A+E → 6 | no-elegible · UNKNOWN A+E → 6 | no-elegible · DOWN D → 9 | REST C → 120 |
| lastMiss reps / easy RIR | no-elegible · UNKNOWN A+E → 6 | no-elegible · UNKNOWN A+E → 6 | UP A → 102.5 | no-elegible · UNKNOWN A+E → 8 |
| lastMiss reps / drifting RIR | no-elegible · DOWN D+E → 9 | no-elegible · DOWN D+E → 9 | UP A → 102.5 | REST C → 120 |
| lastMiss reps / onTarget RIR | REST C → 120 | REST C → 120 | no-elegible · HOLD MAINTAIN | REST C → 120 |
| lastMiss reps / grinding RIR | no-elegible · DOWN D+E → 8 | no-elegible · DOWN D+E → 8 | no-elegible · HOLD MAINTAIN | no-elegible · DOWN D+E → 9 |
| lastMiss reps / lateEasy RIR | no-elegible · UNKNOWN A+E → 6 | no-elegible · UNKNOWN A+E → 6 | no-elegible · DOWN D → 9 | REST C → 120 |
| short reps / easy RIR | no-elegible · UNKNOWN A+E → 6 | no-elegible · UNKNOWN A+E → 6 | no-elegible · UNKNOWN A+E → 6 | no-elegible · UNKNOWN A+E → 6 |
| short reps / drifting RIR | no-elegible · DOWN D+E → 9 | no-elegible · DOWN D+E → 9 | no-elegible · UNKNOWN A+E → 6 | REST C → 120 |
| short reps / onTarget RIR | REST C → 120 | REST C → 120 | REST C → 120 | REST C → 120 |
| short reps / grinding RIR | no-elegible · DOWN D+E → 8 | no-elegible · DOWN D+E → 8 | REST C → 120 | no-elegible · DOWN D+E → 9 |
| short reps / lateEasy RIR | no-elegible · UNKNOWN A+E → 6 | no-elegible · DOWN D+E → 9 | no-elegible · UNKNOWN A+E → 6 | REST C → 120 |
