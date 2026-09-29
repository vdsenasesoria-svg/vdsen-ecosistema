# Datos de equipo requeridos (siguiente paso)

Generado por `node scripts/generate-equipment-data-required.cjs`; verificado por `tests/t525-equipment-data-required.test.js`. **No contiene valores numéricos**: el Coach completa solo incrementos REALES de su gimnasio.

Hoy 0 equipos tienen incremento; sin ellos no existe ningún candidato de carga ejecutable (la auto-aplicación de REST no depende de esto).

## Cómo completarlo

1. Coach → Monitor → cola de equipos → exportar plantilla (o usar `docs/equipment-increments-template.csv`, mismas columnas).
2. `kind`: `STEP` (paso + unidad) · `PLATE_LOADED_BAR` (barra + disco mínimo + unidad) · `AVAILABLE_LOADS` (lista de cargas + unidad).
3. Importar con la herramienta masiva (todo o nada; vista previa de impacto antes de guardar).

## Prioridad por cobertura de ejercicios

| # | Equipo | Ejercicios | Cobertura acum. | Tipo de dato a completar |
|---|---|---|---|---|
| 1 | Mancuernas | 14 | 20% | kind + paso/cargas + unidad |
| 2 | Barra olímpica | 12 | 38% | barra + disco mínimo + unidad |
| 3 | Estación de Poleas | 4 | 43% | kind + paso/cargas + unidad |
| 4 | Polea alta | 4 | 49% | kind + paso/cargas + unidad |
| 5 | Polea baja | 2 | 52% | kind + paso/cargas + unidad |
| 6 | Abdominal Machine Matrix | 1 | 54% | kind + paso/cargas + unidad |
| 7 | Abductor / Adductor Matrix | 1 | 55% | kind + paso/cargas + unidad |
| 8 | Aducción Vertical (cross over vertical) de Pecho Impulse | 1 | 57% | kind + paso/cargas + unidad |
| 9 | Banco ajustable para hiperextensión de espalda baja | 1 | 58% | kind + paso/cargas + unidad |
| 10 | Banco predicador | 1 | 59% | kind + paso/cargas + unidad |
| 11 | Barra fija | 1 | 61% | kind + paso/cargas + unidad |
| 12 | Barra hexagonal | 1 | 62% | kind + paso/cargas + unidad |
| 13 | Barras paralelas | 1 | 64% | kind + paso/cargas + unidad |
| 14 | Belt Squat | 1 | 65% | kind + paso/cargas + unidad |
| 15 | Curl de Bíceps placas Matrix | 1 | 67% | kind + paso/cargas + unidad |
| 16 | Curl Femoral Sentado Matrix | 1 | 68% | kind + paso/cargas + unidad |
| 17 | Extensión de rodilla | 1 | 70% | kind + paso/cargas + unidad |
| 18 | Extensión de Rodilla Matrix | 1 | 71% | kind + paso/cargas + unidad |
| 19 | Fondos sentado Matrix | 1 | 72% | kind + paso/cargas + unidad |
| 20 | Glute Machine Matrix | 1 | 74% | kind + paso/cargas + unidad |
| 21 | Hack squat | 1 | 75% | kind + paso/cargas + unidad |
| 22 | Hip Thrust Machine | 1 | 77% | kind + paso/cargas + unidad |
| 23 | Máquina plate-loaded · discos | 1 | 78% | kind + paso/cargas + unidad |
| 24 | Pec Fly / Reverse Pec Deck placas Matrix | 1 | 80% | kind + paso/cargas + unidad |
| 25 | Polea ajustable | 1 | 81% | kind + paso/cargas + unidad |
| 26 | Prensa de pierna | 1 | 83% | kind + paso/cargas + unidad |
| 27 | Prensa de Pierna Matrix peso integrado | 1 | 84% | kind + paso/cargas + unidad |
| 28 | Press de Hombro Convergente Matrix | 1 | 86% | kind + paso/cargas + unidad |
| 29 | Press de Hombro discos Impulse | 1 | 87% | kind + paso/cargas + unidad |
| 30 | Press de Pecho discos Impulse | 1 | 88% | kind + paso/cargas + unidad |
| 31 | Press de Pecho placas Matrix | 1 | 90% | kind + paso/cargas + unidad |
| 32 | Press de Pecho Sentado Impulse | 1 | 91% | kind + paso/cargas + unidad |
| 33 | Press Inclinado discos Impulse | 1 | 93% | kind + paso/cargas + unidad |
| 34 | Remo Inclinado con Apoyo de Pecho discos Impulse | 1 | 94% | kind + paso/cargas + unidad |
| 35 | Remo Sentado discos Impulse | 1 | 96% | kind + paso/cargas + unidad |
| 36 | Remo Sentado Divergente placas Matrix | 1 | 97% | kind + paso/cargas + unidad |
| 37 | Sentadilla Pendular | 1 | 99% | kind + paso/cargas + unidad |
| 38 | Smith | 1 | 100% | kind + paso/cargas + unidad |
| 39 | Banco multiposición | 0 | 100% | kind + paso/cargas + unidad |

## Solicitud mínima: los dos primeros equipos (Mancuernas + Barra olímpica = 38% de los ejercicios)

No se pre-llena ningún valor físico: todo debe salir de la realidad del gimnasio. Usa la plantilla (`docs/equipment-increments-template.csv`, filas `functional-dumbbells` y `functional-olympic-barbell`, `scope` = SHARED).

| Equipo (`equipmentId`) | `kind` | Campos obligatorios | Opcionales |
|---|---|---|---|
| Mancuernas (`functional-dumbbells`) | `AVAILABLE_LOADS` **o** `STEP` (el que describa la realidad) | `unit` (KG o LB) + `loads` (todos los pesos de mancuerna disponibles, separados por espacio) — o, con `STEP`: `unit` + `step` (salto constante entre mancuernas consecutivas) | `min`, `max` (solo con `STEP`) |
| Barra olímpica (`functional-olympic-barbell`) | `PLATE_LOADED_BAR` | `unit` (KG o LB) + `barWeight` (barra vacía) + `smallestPlate` (el disco más pequeño que se carga POR LADO; el salto mínimo resultante es 2 × ese disco) | `max` (carga máxima) |

Si en algún gimnasio los valores difieren, indica `scope` = GYM y el `gymId`. Lo que no se sepa se deja en blanco (el equipo queda sin resolver y el candidato sigue bloqueado; nunca se estima).

Con esos dos equipos configurados, los candidatos de carga de los ejercicios que los usan pasan de `BLOCKED_EQUIPMENT_DATA` a `READY_BUT_DISABLED` (la aplicación real sigue apagada).


Prioridad inmediata: **Mancuernas**, **Barra olímpica**, y luego los equipos siguientes de la tabla. Equipos sin identidad canónica (2 grupos) solo se configuran por ejercicio.
