# T587 · Piloto Ayrton — verificación real, sesión real y parada

**Alcance:** solo la cuenta de Ayrton. No se amplía la allowlist, no se habilita CRON, no se cambian flags. El UID lo recibe cada herramienta por argumento; **no se guarda en el repositorio** (la prueba del canario usa un valor sintético).
El piloto **no se declara completado con pruebas sintéticas**: las pruebas de emulador respaldan los mecanismos; el cierre exige una sesión real tuya.

## E1 · Verificación actual (lectura real de producción, 2026-10-20, sin modificar nada)
Herramienta: `node scripts/pilot/pilot-readiness.cjs --uid <UID>` (solo lectura; imprime booleanos y conteos).
| Comprobación | Resultado |
| --- | --- |
| Plan activo existente e íntegro | **OK**: 33 ejercicios, 33 con PID, `updatedAt` ISO |
| `rirByWeek` en el plan | OK |
| Bitácora | OK: 66 series registradas, 5 sesiones cerradas (semana 1, anteriores al Motor T586) |
| Barrera de la release | OK: abierta, **solo el piloto** (1 cliente) |
| Barrera del canario del Coach | OK: abierta para el piloto |
| Prioridades musculares persistidas | **FALLA / no declaradas** → el motor funciona sin diferenciar por prioridad |
| Rangos de repeticiones (`repsRange`) | **FALLA / 0 ejercicios** → la progresión usa carga/series; sin REPS dentro de un rango del Motor |
| Estados del motor (PENDING / APPLIED / CONSUMED) | **todos 0**: aún no se procesó evidencia con el motor |
| Variables `AUTONOMOUS_PROGRESSION_*` de Vercel | no legibles desde Firestore: confirmar en el panel de Vercel (o por el comportamiento del endpoint) |

## E2 · Sesión real (la haces tú; yo verifico después, sin tocar tu bitácora)
1. Abre el Cliente, tab Entreno. Entrena como siempre (carga y repeticiones reales, RIR, ICS).
2. Guarda y completa la sesión (post-sesión).
3. Debe aparecer solo el **resumen compacto** (PR de resumen). Toma la captura con el botón CAPTURA si quieres.
4. El servidor evalúa por sí solo (el Cliente le avisa al guardar). Para comprobarlo: `pilot-readiness.cjs --uid <UID>` → los estados dejan de ser 0 (PENDING / APPLIED / REJECTED con su razón).
5. Abre la **siguiente exposición** del mismo ejercicio: si hubo decisión verás "AUTOAJUSTE VDSEN" con el valor anterior → nuevo; si no, la prescripción base o la vigente ("Vigente: …").
6. Ejecuta esa exposición registrando lo que **realmente** uses (aunque sea otra carga).
7. Repite el chequeo: el registro pasa a CONSUMED y la siguiente evaluación parte de tu carga real.
8. Continuidad: una semana más tarde, un ejercicio sin decisión nueva sigue mostrando lo último ejecutado ("Vigente"), no vuelve al plan.
No se modifica la bitácora ni se fabrica una progresión: si el motor no encuentra evidencia suficiente, no cambia nada y lo deja registrado con su razón.

## E3 · Parada comprobada
* Parada inmediata (apaga ambas barreras): `node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode stop --confirm`.
* Parada completa: variables de Vercel a `false` y un release (tardan en surtir efecto porque se leen al desplegar).
* **Comprobado en emulador** (`tests/t587-pilot-stop-emulator.cjs`, 4 pruebas, con el ejecutor real y los mismos documentos que escribe `--mode stop`): con la barrera de la release detenida, con la del canario detenida o con ambas, y con `DISARMED`, **no se escribe un solo documento**; tras parar en pleno ciclo, nueva evidencia no genera registros, overlays ni consumos (un overlay reconocido no pasa a CONSUMED) y lo ya aplicado sigue legible; con aplicación numérica apagada solo se materializan PENDING; al reanudar, los mismos registros se aplican una sola vez; detener a un atleta no afecta a otro.
* Verificación en producción tras parar: `pilot-readiness.cjs` debe mostrar las barreras en FALLA (cerradas) y los conteos de estados sin cambios en las horas siguientes.

## Estado
E1 verificado en producción · E2 **pendiente de tu sesión real** · E3 verificado en emulador (la parada real en producción la ejecutarías tú o me la autorizas).
