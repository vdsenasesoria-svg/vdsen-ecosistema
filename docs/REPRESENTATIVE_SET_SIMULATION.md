# Simulación de serie representativa (solo análisis)

Generado por `node scripts/simulate-representative-set.cjs` con fixtures sintéticos deterministas. **Es solo análisis: no selecciona ni cambia la política (la adoptada es LAST_SET) y no está conectado al runtime.**
Objetivo de la fixture: 10 reps @ RIR 2. Estrategias: LAST_SET (política de producto VDSEN adoptada en T523: última serie de trabajo válida), WORST_SET (mayor falta de reps y menor margen RIR), BEST_SET (lo contrario),
MEAN (promedio redondeado de reps y RIR observado; el motor legado v3.1 promedia las series).

- Exposiciones sintéticas: **40** (20 patrones × historial previo igual / neutro)

## Resultado por estrategia

| Estrategia | Elegibles | Sin resolver | Dirección UP | DOWN | REST |
|---|---|---|---|---|---|
| LAST_SET | 5 | 0 | 4 | 16 | 6 |
| WORST_SET | 4 | 0 | 2 | 20 | 6 |
| BEST_SET | 9 | 0 | 14 | 4 | 4 |
| MEAN | 10 | 0 | 2 | 8 | 18 |

## Cuánto cambia la elección de estrategia el resultado

| Par | Cambia dirección | Cambia dimensión | Cambia magnitud | Cambia elegibilidad | Cualquier cambio |
|---|---|---|---|---|---|
| LAST_SET vs WORST_SET | 4 (10%) | 2 (5%) | 2 (5%) | 1 (3%) | 4 (10%) |
| LAST_SET vs BEST_SET | 28 (70%) | 13 (33%) | 13 (33%) | 8 (20%) | 28 (70%) |
| LAST_SET vs MEAN | 16 (40%) | 8 (20%) | 8 (20%) | 7 (18%) | 16 (40%) |
| WORST_SET vs BEST_SET | 32 (80%) | 15 (38%) | 15 (38%) | 9 (23%) | 32 (80%) |
| WORST_SET vs MEAN | 16 (40%) | 6 (15%) | 6 (15%) | 6 (15%) | 16 (40%) |
| BEST_SET vs MEAN | 32 (80%) | 19 (48%) | 19 (48%) | 15 (38%) | 32 (80%) |

## Detalle (historial previo igual)

| Patrón | LAST | WORST | BEST | MEAN |
|---|---|---|---|---|
| steady reps / easy RIR | UP A → 102.5 | UP A → 102.5 | UP A → 102.5 | UP A → 102.5 |
| steady reps / drifting RIR | no-elegible · DOWN D | no-elegible · DOWN D | UP A → 102.5 | no-elegible · HOLD MAINTAIN |
| steady reps / onTarget RIR | no-elegible · HOLD MAINTAIN | no-elegible · HOLD MAINTAIN | no-elegible · HOLD MAINTAIN | no-elegible · HOLD MAINTAIN |
| steady reps / grinding RIR | no-elegible · DOWN D | no-elegible · DOWN D | no-elegible · HOLD MAINTAIN | no-elegible · DOWN D |
| steady reps / lateEasy RIR | UP A → 102.5 | no-elegible · DOWN D | UP A → 102.5 | no-elegible · HOLD MAINTAIN |
| fading reps / easy RIR | no-elegible · UNKNOWN A+E | no-elegible · UNKNOWN A+E | UP A → 102.5 | no-elegible · UNKNOWN A+E |
| fading reps / drifting RIR | no-elegible · DOWN D+E | no-elegible · DOWN D+E | UP A → 102.5 | no-elegible · REST C+E |
| fading reps / onTarget RIR | no-elegible · REST C+E | no-elegible · REST C+E | no-elegible · HOLD MAINTAIN | no-elegible · REST C+E |
| fading reps / grinding RIR | no-elegible · DOWN D+E | no-elegible · DOWN D+E | no-elegible · HOLD MAINTAIN | no-elegible · DOWN D+E |
| fading reps / lateEasy RIR | no-elegible · UNKNOWN A+E | no-elegible · UNKNOWN A+E | no-elegible · DOWN D | no-elegible · REST C+E |
| lastMiss reps / easy RIR | no-elegible · UNKNOWN A+E | no-elegible · UNKNOWN A+E | UP A → 102.5 | no-elegible · UNKNOWN A+E |
| lastMiss reps / drifting RIR | no-elegible · DOWN D+E | no-elegible · DOWN D+E | UP A → 102.5 | no-elegible · REST C+E |
| lastMiss reps / onTarget RIR | no-elegible · REST C+E | no-elegible · REST C+E | no-elegible · HOLD MAINTAIN | no-elegible · REST C+E |
| lastMiss reps / grinding RIR | no-elegible · DOWN D+E | no-elegible · DOWN D+E | no-elegible · HOLD MAINTAIN | no-elegible · DOWN D+E |
| lastMiss reps / lateEasy RIR | no-elegible · UNKNOWN A+E | no-elegible · UNKNOWN A+E | no-elegible · DOWN D | no-elegible · REST C+E |
| short reps / easy RIR | no-elegible · UNKNOWN A+E | no-elegible · UNKNOWN A+E | no-elegible · UNKNOWN A+E | no-elegible · UNKNOWN A+E |
| short reps / drifting RIR | no-elegible · DOWN D+E | no-elegible · DOWN D+E | no-elegible · UNKNOWN A+E | no-elegible · REST C+E |
| short reps / onTarget RIR | no-elegible · REST C+E | no-elegible · REST C+E | no-elegible · REST C+E | no-elegible · REST C+E |
| short reps / grinding RIR | no-elegible · DOWN D+E | no-elegible · DOWN D+E | no-elegible · REST C+E | no-elegible · DOWN D+E |
| short reps / lateEasy RIR | no-elegible · UNKNOWN A+E | no-elegible · DOWN D+E | no-elegible · UNKNOWN A+E | no-elegible · REST C+E |
