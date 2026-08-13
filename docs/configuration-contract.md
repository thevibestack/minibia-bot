# Contrato de configuración del bot

Cada control del panel existe solamente si completa este recorrido:

`regla de MiniBia → valor persistido por personaje → validación/normalización → acción del agente → estado visible`.

No se considera configurado algo que solo cambie la pantalla.

| Prioridad / pantalla | Regla real | Configuración persistida | Acción y estado que la prueban |
| --- | --- | --- | --- |
| **Curar: magia** | Lanzar únicamente con vida bajo el umbral, con maná suficiente y reserva respetada. | `modules.healMagic.{on,threshold,slot,sid,reserve}`; umbrales/reserva se almacenan en valores absolutos. | `heal-magic` usa el slot configurado y publica su estado en el snapshot. |
| **Curar: objetos** | Usar solamente objetos presentes en contenedores abiertos y con vida bajo el umbral. | `modules.healItems.{on,threshold,slotCids}`. | `heal-items` busca los CIDs elegidos en BP y los usa sobre el personaje. |
| **Ataque asistido** | Nunca cambia el target: actúa solo sobre `player.__target` elegido por el usuario. | `modules.attack.{on,sid,runeSlot,targeting}`; `targeting` no aplica en assist. | Requiere lector de target y ciclo de combate real; no se debe presentar como activo hasta que exista. |
| **Cavebot** | Sin objetivo sigue waypoints; con monstruo configurado pausa ruta, selecciona/ataca y luego la retoma. | `modules.cavebot.{on,paused,route}` y lista superior `routes`. | Requiere ciclo de ruta y selección nativa `world.targetMonster`; grabar puntos no equivale a cavebot operativo. |
| **Entrenar / runas** | Crear la runa elegida si maná >= coste + reserva; parar o usar fallback según capacidad. | `modules.training.{on,sid,slot,reserve,eatWithMagic}` y `modules.runes.{on,capMode,capFullThreshold,fallbackSlot,fallbackManaPct}`. | `training` y `runes` calculan coste/capacidad y exponen `capFull` y estado de fallback. |
| **Comida** | Consumir el ítem configurado por cadence o contador de casts, solo si está disponible. | `modules.eat.{on,slot,cids,everyCasts,warningWindowSec,fallbackIntervalSec}`. | `eat` lee el contenedor y publica pausa tras fallos consecutivos. |
| **Loot / anti-bot** | Loot solo a destinos definidos; replies solo tras confirmación de patrón. | `modules.loot.{on,defaultDest,perMonster}` y `modules.antibot.{on,replies}`. | Módulos y alertas visibles en snapshot/log. |

## Reglas de interfaz

1. Los inputs y selects son **borradores locales**: el polling nunca puede reemplazarlos mientras tienen foco.
2. `Guardar` valida todo el bloque y recién entonces persiste y empuja la configuración al agente.
3. Los selectores de magia/runa consumen exclusivamente el catálogo extraído del cliente conectado, incluyendo icono, palabras, coste y nivel cuando el juego los expone.
4. Toda regla que no tenga acción del agente debe mostrarse como no disponible, no como una configuración funcional.
5. El tutorial se puede reiniciar y resalta la pestaña/control real de cada paso; no es un modal desconectado de la interfaz.
