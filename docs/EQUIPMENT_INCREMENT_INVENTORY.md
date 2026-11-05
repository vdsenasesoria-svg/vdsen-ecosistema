# Inventario de identidad y metadatos de incremento por equipo

Generado por `node scripts/equipment-increment-inventory.cjs` (solo lectura; verificado por `tests/t501-equipment-inventory.test.js`).
Identidad: `equipmentId` exacto > alias canónico exacto (mayúsculas/acentos/espacios normalizados, nunca similitud) > sin resolver.
Solo cuenta un incremento **explícito con fuente** (`loadIncrement.kind` = STEP | PLATE_LOADED_BAR | AVAILABLE_LOADS y `source` =
EXERCISE_METADATA | GYM_METADATA | COACH_CONFIGURED). El tipo de equipo nunca establece un incremento.

- Equipos canónicos / grupos de etiqueta: **41**
- Identidad resuelta: **39** · sin resolver: **2**
- Con incremento explícito y fuente en el catálogo estático: **0**

| Sede (gymId) | Equipo | Tipo | equipmentId | Identidad | Motivo sin resolver | Incremento | Fuente | Ejercicios | Alias |
|---|---|---|---|---|---|---|---|---|---|
| smart-fit-san-diego | Mancuernas | free_weight | functional-dumbbells | ALIAS_MATCH | — | NONE | — | 14 | Mancuernas |
| smart-fit-san-diego | Barra olímpica | barbell | functional-olympic-barbell | ALIAS_MATCH | — | NONE | — | 12 | Barra olímpica |
| smart-fit-san-diego | Estación de Poleas | cable | functional-cable-station | ALIAS_MATCH | — | NONE | — | 4 | Estación de Poleas |
| smart-fit-san-diego | Polea alta | cable | sf-sd-eq-polea-alta | ALIAS_MATCH | — | NONE | — | 4 | Polea Alta / Polea alta |
| smart-fit-san-diego | Polea baja | cable | sf-sd-eq-polea-baja | ALIAS_MATCH | — | NONE | — | 2 | Polea Baja / Polea baja |
| smart-fit-san-diego | Abdominal Machine Matrix | machine | sf-sd-eq-matrix-abdominal-machine | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Abductor / Adductor Matrix | machine | sf-sd-eq-matrix-abductor-adductor | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Accesorio de polea | cable | — | UNRESOLVED | ATTACHMENT_NOT_LOAD_IMPLEMENT | NONE | — | 1 | Accesorio de polea |
| smart-fit-san-diego | Aducción Vertical (cross over vertical) de Pecho Impulse | machine | sf-sd-eq-impulse-vertical-chest-adduction | EXERCISE_MAPPING | — | NONE | — | 1 | Impulse · peso integrado |
| smart-fit-san-diego | Banco ajustable para hiperextensión de espalda baja | bench | functional-hyperextension-bench | ALIAS_MATCH | — | NONE | — | 1 | Banco ajustable para hiperextensión de espalda baja |
| smart-fit-san-diego | Banco predicador | bench | sf-sd-eq-banco-predicador | ALIAS_MATCH | — | NONE | — | 1 | Banco predicador |
| smart-fit-san-diego | Barra fija | barbell | sf-sd-eq-barra-fija | ALIAS_MATCH | — | NONE | — | 1 | Barra fija |
| smart-fit-san-diego | Barra hexagonal | trap_bar | functional-trap-bar | ALIAS_MATCH | — | NONE | — | 1 | Barra hexagonal |
| smart-fit-san-diego | Barras paralelas | barbell | sf-sd-eq-barras-paralelas | ALIAS_MATCH | — | NONE | — | 1 | Barras paralelas |
| smart-fit-san-diego | Belt Squat | machine | sf-sd-eq-belt-squat | ALIAS_MATCH | — | NONE | — | 1 | Belt Squat |
| smart-fit-san-diego | Curl de Bíceps placas Matrix | machine | sf-sd-eq-matrix-biceps-curl | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Curl Femoral Sentado Matrix | machine | sf-sd-eq-matrix-seated-leg-curl | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Extensión de rodilla | machine | sf-sd-eq-extension-de-rodilla | ALIAS_MATCH | — | NONE | — | 1 | Extensión de rodilla |
| smart-fit-san-diego | Extensión de Rodilla Matrix | machine | sf-sd-eq-matrix-knee-extension | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Fondos sentado Matrix | machine | sf-sd-eq-matrix-seated-dip | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Glute Machine Matrix | machine | sf-sd-eq-matrix-glute-machine | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Hack squat | machine | sf-sd-eq-hack-squat | ALIAS_MATCH | — | NONE | — | 1 | Hack squat |
| smart-fit-san-diego | Hip Thrust Machine | machine | sf-sd-eq-hip-thrust-machine | ALIAS_MATCH | — | NONE | — | 1 | Hip Thrust Machine |
| smart-fit-san-diego | Máquina | machine | — | UNRESOLVED | GENERIC_LABEL | NONE | — | 1 | Máquina |
| smart-fit-san-diego | Máquina plate-loaded · discos | machine | sf-sd-converging-lat-pulldown-plate-loaded | EXPLICIT_ID | — | NONE | — | 1 | Máquina plate-loaded · discos |
| smart-fit-san-diego | Pec Fly / Reverse Pec Deck placas Matrix | machine | sf-sd-eq-matrix-pec-fly-reverse-deck | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Polea ajustable | cable | sf-sd-eq-polea-ajustable | ALIAS_MATCH | — | NONE | — | 1 | Polea ajustable |
| smart-fit-san-diego | Prensa de pierna | machine | sf-sd-eq-prensa-de-pierna | ALIAS_MATCH | — | NONE | — | 1 | Prensa de pierna |
| smart-fit-san-diego | Prensa de Pierna Matrix peso integrado | machine | sf-sd-eq-matrix-leg-press-selectorized | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · peso integrado |
| smart-fit-san-diego | Press de Hombro Convergente Matrix | machine | sf-sd-eq-matrix-converging-shoulder-press | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Press de Hombro discos Impulse | machine | sf-sd-eq-impulse-shoulder-press-plate-loaded | EXERCISE_MAPPING | — | NONE | — | 1 | Impulse · discos |
| smart-fit-san-diego | Press de Pecho discos Impulse | machine | sf-sd-eq-impulse-chest-press-plate-loaded | EXERCISE_MAPPING | — | NONE | — | 1 | Impulse · discos |
| smart-fit-san-diego | Press de Pecho placas Matrix | machine | sf-sd-eq-matrix-chest-press-selectorized | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Press de Pecho Sentado Impulse | machine | sf-sd-eq-impulse-seated-chest-press | EXERCISE_MAPPING | — | NONE | — | 1 | Impulse · peso integrado |
| smart-fit-san-diego | Press Inclinado discos Impulse | machine | sf-sd-eq-impulse-incline-press-plate-loaded | EXERCISE_MAPPING | — | NONE | — | 1 | Impulse · discos |
| smart-fit-san-diego | Remo Inclinado con Apoyo de Pecho discos Impulse | machine | sf-sd-eq-impulse-chest-supported-incline-row | EXERCISE_MAPPING | — | NONE | — | 1 | Impulse · discos |
| smart-fit-san-diego | Remo Sentado discos Impulse | machine | sf-sd-eq-impulse-seated-row-plate-loaded | EXERCISE_MAPPING | — | NONE | — | 1 | Impulse · discos |
| smart-fit-san-diego | Remo Sentado Divergente placas Matrix | machine | sf-sd-eq-matrix-diverging-seated-row | EXERCISE_MAPPING | — | NONE | — | 1 | Matrix · placas |
| smart-fit-san-diego | Sentadilla Pendular | machine | sf-sd-eq-sentadilla-pendular | ALIAS_MATCH | — | NONE | — | 1 | Sentadilla Pendular |
| smart-fit-san-diego | Smith | machine | sf-sd-eq-smith | ALIAS_MATCH | — | NONE | — | 1 | Smith |
| — | Banco multiposición | bench | functional-adjustable-bench | EXPLICIT_ID | — | NONE | — | 0 | Banco ajustable / Banco multiposición |

## Datos que el Coach debe aportar (por equipo, solo valores reales)

- `STEP`: paso del stack/placa integrada (`step`), mínimo/máximo opcional (`min`/`max`) y `unit`.
- `PLATE_LOADED_BAR`: peso de la barra/brazo (`barWeight`), disco más pequeño (`smallestPlate`), `max` opcional y `unit`.
- `AVAILABLE_LOADS`: lista de cargas disponibles (mancuernas / implementos fijos) y `unit`.
- Se configura una vez por equipo (compartido o por sede) o, como excepción, por ejercicio; siempre con `source: COACH_CONFIGURED`.
- Etiquetas sin identidad (familia de máquinas, "Máquina" genérica, accesorio) solo pueden configurarse por ejercicio.
