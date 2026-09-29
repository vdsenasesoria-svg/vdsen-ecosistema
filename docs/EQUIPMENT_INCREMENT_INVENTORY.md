# Inventario de metadatos de incremento de carga por equipo

Generado por `node scripts/equipment-increment-inventory.cjs` (solo lectura; verificado por `tests/t501-equipment-inventory.test.js`).
Solo cuenta un incremento **explícito con fuente** (`loadIncrement.kind` = STEP | PLATE_LOADED_BAR | AVAILABLE_LOADS y `source` =
EXERCISE_METADATA | GYM_METADATA | COACH_CONFIGURED). El tipo de equipo nunca establece un incremento.

- Equipos/etiquetas inventariados: **28**
- Con incremento explícito y fuente: **0**
- Sin incremento (`UNRESOLVED_EQUIPMENT_INCREMENT`): **28**

| Sede (gymId) | Equipo | Tipo | equipmentId | Identidad | Incremento | Fuente | Ejercicios |
|---|---|---|---|---|---|---|---|
| — | Banco multiposición | bench | functional-adjustable-bench | EXPLICIT_EQUIPMENT_ID | NONE | — | 0 |
| smart-fit-san-diego | Accesorio de polea | cable | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Banco ajustable para hiperextensión de espalda baja | bench | functional-hyperextension-bench | LABEL_MATCHES_FUNCTIONAL_EQUIPMENT | NONE | — | 1 |
| smart-fit-san-diego | Banco predicador | bench | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Barra fija | barbell | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Barra hexagonal | trap_bar | functional-trap-bar | LABEL_MATCHES_FUNCTIONAL_EQUIPMENT | NONE | — | 1 |
| smart-fit-san-diego | Barra olímpica | barbell | functional-olympic-barbell | LABEL_MATCHES_FUNCTIONAL_EQUIPMENT | NONE | — | 12 |
| smart-fit-san-diego | Barras paralelas | barbell | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Belt Squat | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Estación de Poleas | cable | functional-cable-station | LABEL_MATCHES_FUNCTIONAL_EQUIPMENT | NONE | — | 4 |
| smart-fit-san-diego | Extensión de rodilla | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Hack squat | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Hip Thrust Machine | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Impulse · discos | machine | — | NO_EQUIPMENT_ID | NONE | — | 5 |
| smart-fit-san-diego | Impulse · peso integrado | machine | — | NO_EQUIPMENT_ID | NONE | — | 2 |
| smart-fit-san-diego | Mancuernas | free_weight | functional-dumbbells | LABEL_MATCHES_FUNCTIONAL_EQUIPMENT | NONE | — | 14 |
| smart-fit-san-diego | Máquina | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Máquina plate-loaded · discos | machine | sf-sd-converging-lat-pulldown-plate-loaded | EXPLICIT_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Matrix · peso integrado | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Matrix · placas | machine | — | NO_EQUIPMENT_ID | NONE | — | 11 |
| smart-fit-san-diego | Polea ajustable | cable | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Polea alta | cable | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Polea Alta | cable | — | NO_EQUIPMENT_ID | NONE | — | 3 |
| smart-fit-san-diego | Polea baja | cable | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Polea Baja | cable | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Prensa de pierna | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Sentadilla Pendular | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |
| smart-fit-san-diego | Smith | machine | — | NO_EQUIPMENT_ID | NONE | — | 1 |

## Datos que el Coach debe aportar (por equipo, solo valores reales)

- `STEP`: paso del stack/placa integrada (`step`), mínimo/máximo opcional (`min`/`max`) y `unit`.
- `PLATE_LOADED_BAR`: peso de la barra/brazo (`barWeight`), disco más pequeño (`smallestPlate`), `max` opcional y `unit`.
- `AVAILABLE_LOADS`: lista de cargas disponibles (mancuernas / implementos fijos) y `unit`.
- Cada valor se configura en el editor de incremento del Coach (T502) y queda con `source: COACH_CONFIGURED`.
- Los equipos sin `equipmentId` explícito quedan identificados por ejercicio (`exercise:<id>`) hasta que se les asigne uno.
