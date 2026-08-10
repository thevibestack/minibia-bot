/* =========================================================================
 * Minibia Desktop Bot — control panel state (tasks 3.2/3.3/3.4).
 *
 * PURE module: the panel render logic and the interconnection gate state
 * machine live here, fully node-testable (no DOM, no network). The browser
 * wiring (app/panel/app.js) dispatches actions; the panel server
 * (app/panel/server.ts) executes the effects (connect/disconnect/applyConfig
 * pushes).
 *
 * Gate state machine (REQ-02): disconnected -> probing -> confirmed -> armed.
 *   - disconnected: nothing attached / cancelled / disconnected.
 *   - probing:      app polls the in-page agent; identity not readable yet
 *                   ("waiting for game" — Cloudflare challenge page).
 *   - confirmed:    player name + vocation label read and DISPLAYED; the
 *                   user must click Connect before anything arms.
 *   - armed:        explicit Connect done; module toggles accepted; config
 *                   is pushed to the agent with armed:true.
 *   Cancel (probing|confirmed) and disconnect (armed) reset to disconnected.
 *   An identity CHANGE while armed disarms (effect 'disarm') — the gate
 *   never stays armed for a different character (REQ-09 per-character).
 *
 * Toggle/setting actions are REFUSED with reason 'not connected' until the
 * gate is armed (REQ-02 GIVEN: module toggle pre-Connect -> refused).
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MbPanelState = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GATE_DISCONNECTED = 'disconnected';
  const GATE_PROBING = 'probing';
  const GATE_CONFIRMED = 'confirmed';
  const GATE_ARMED = 'armed';
  const GATE_STATES = [GATE_DISCONNECTED, GATE_PROBING, GATE_CONFIRMED, GATE_ARMED];

  const LANGS = ['en', 'es'];
  const LANG_EN = 'en';
  const LANG_ES = 'es';

  /* ------------------------------ slice 1a (REQ-26) ----------------------------- */

  /**
   * Product tabs (design D7, REQ-26): HEAL/ATTACK/TRAINER/CAVEBOT/OTHERS.
   * Each tab owns the module toggles that land there. ATTACK + CAVEBOT host
   * the PR6 skeleton modules (REQ-35/36) — their tabs disclose
   * "skeleton — limited" (`skeleton: true`) while the full behaviors arrive
   * with later updates.
   */
  const TABS = [
    { id: 'heal', modules: ['healItems', 'healMagic'] },
    { id: 'attack', modules: ['attack'], skeleton: true },   // PR6 (REQ-35): skeleton module — disclosed
    { id: 'trainer', modules: ['runes', 'training'] },
    { id: 'cavebot', modules: ['cavebot'], skeleton: true }, // PR6 (REQ-36): skeleton module — disclosed
    { id: 'others', modules: ['eat', 'trade', 'loot', 'spawns', 'huntStats', 'routes'] },
  ];
  const TAB_IDS = TABS.map((t) => t.id);

  /** The 12 modules (design config "modules" map), regrouped per tab (REQ-26). */
  const MODULE_DEFS = [
    { id: 'healItems', label: 'Heal with items', tab: 'heal' },
    { id: 'healMagic', label: 'Heal with magic', tab: 'heal' },
    { id: 'runes', label: 'Runes', tab: 'trainer' },
    { id: 'training', label: 'Magic training', tab: 'trainer' },
    { id: 'eat', label: 'Eat', tab: 'others' },
    { id: 'trade', label: 'Auto trade broadcast', tab: 'others' },
    { id: 'loot', label: 'Auto-loot', tab: 'others' },
    { id: 'spawns', label: 'Spawn maps', tab: 'others' },
    { id: 'huntStats', label: 'Hunt stats', tab: 'others' },
    { id: 'routes', label: 'Routes', tab: 'others' },
    // PR6 (REQ-35/36, D10): skeleton modules — state-only; the tabs disclose
    // "skeleton — limited" until the full behaviors arrive.
    { id: 'attack', label: 'Attack', tab: 'attack' },
    { id: 'cavebot', label: 'Cavebot', tab: 'cavebot' },
  ];
  const MODULE_IDS = MODULE_DEFS.map((m) => m.id);
  const MODULE_BY_TAB = (function () {
    const out = {};
    for (const tab of TABS) out[tab.id] = [];
    for (const def of MODULE_DEFS) out[def.tab].push(def);
    return out;
  }());

  /* ----------------------- slice 1b (REQ-28, D5) ----------------------- */
  /** Modules whose spell sid the picker can choose (heal + training). */
  const PICKER_MODULES = ['healMagic', 'training', 'attack']; // PR6 (REQ-35): offensive spell picker

  /* ------------------------------ i18n (REQ-26) ------------------------------ */
  /* Default EN; ES is a full translation. `t(state, key)` resolves the key
   * for state.lang and falls back to EN when a key is missing. */

  const I18N = {
    en: {
      'gate.disconnected': 'Disconnected',
      'gate.probing': 'Waiting for game…',
      'gate.confirmed': 'Confirming connection',
      'gate.armed': 'Connected',
      'connect': 'Connect',
      'cancel': 'Cancel',
      'disconnect': 'Disconnect',
      'refused': 'refused: %reason%',
      'language': 'Language',
      'tab.heal': 'HEAL',
      'tab.attack': 'ATTACK',
      'tab.trainer': 'TRAINER',
      'tab.cavebot': 'CAVEBOT',
      'tab.others': 'OTHERS',
      'configuration': 'Configuration',
      'configLocked': 'Configuration unlocks after Connect.',
      'liveState': 'Live state',
      'activityLog': 'Activity log',
      'noSnapshot': 'No snapshot yet — connecting…',
      'log.empty': 'No activity yet.',
      'stats.health': 'Health',
      'stats.mana': 'Mana',
      'skeleton.note': 'Skeleton — limited functionality arrives in a later update.',
      'module.healItems': 'Heal with items',
      'module.healMagic': 'Heal with magic',
      'module.runes': 'Runes',
      'module.training': 'Magic training',
      'module.eat': 'Eat',
      'module.trade': 'Auto trade broadcast',
      'module.loot': 'Auto-loot',
      'module.spawns': 'Spawn maps',
      'module.huntStats': 'Hunt stats',
      'module.routes': 'Routes',
      'module.attack': 'Attack',
      'module.cavebot': 'Cavebot',
      'picker.module.attack': 'Attack spell',
      'tutorial.title': 'Welcome to the bot panel',
      'tutorial.body': 'This panel controls your bot, one tab per activity. This tour shows each tab — you can dismiss it at any time.',
      'tutorial.tab.heal': 'HEAL — set up healing: health threshold, potions or magic spells.',
      'tutorial.tab.attack': 'ATTACK — combat targeting (lowest HP / nearest) arrives in a later update.',
      'tutorial.tab.trainer': 'TRAINER — rune-making with a strict cap, mana reserve and fallback spell.',
      'tutorial.tab.cavebot': 'CAVEBOT — route recording and autowalk are planned for a later update.',
      'tutorial.tab.others': 'OTHERS — food, auto-loot, trade broadcasts and anti-bot alerts.',
      'tutorial.next': 'Next',
      'tutorial.finish': 'Finish',
      'tutorial.dismiss': 'Skip tutorial',
      // Slice 1b (REQ-27/28): profile cross-load + spell picker.
      'profile.title': 'Profiles',
      'profile.none': 'No saved configs for other characters yet — they appear here once a Connect saves them.',
      'profile.loadFrom': 'Load config from',
      'profile.loadBtn': 'Load config',
      'profile.loadedAll': "Loaded %from%'s config — everything applies.",
      'profile.loadedRejected': "Loaded %from%'s config — incompatible entries rejected:",
      'profile.failed': "Could not load %from%'s config: %reason%",
      'picker.title': 'Spell picker',
      'picker.empty': 'No spell catalog yet — connect a character to load it.',
      'picker.module.healMagic': 'Heal spell',
      'picker.module.training': 'Training spell',
      'picker.search': 'Search spells…',
      'picker.none': 'No spells match.',
      'picker.meta': 'mana %mana%, level %level%',
      'picker.pick': 'Pick',
      'picker.current': 'current',
      // Slice 2 (PR3, REQ-29): HEAL settings form + live state line.
      'heal.formTitle': 'Heal settings',
      'heal.threshold': 'Health threshold %',
      'heal.slot': 'Hotbar slot',
      'heal.reserve': 'Mana reserve',
      'heal.save': 'Save heal settings',
      'heal.liveOn': 'Heal magic on — hp %pct%% of %max%, fires at %t%% (slot %slot%)',
      'heal.liveOff': 'Heal magic off — no heal actions',
      // Slice 3 (PR4, REQ-30/31/32): TRAINER settings form + cap alert.
      'trainer.formTitle': 'Trainer settings',
      'trainer.capMode': 'Rune cap mode',
      'trainer.capModeStrict': 'Strict — stop at cap',
      'trainer.capModeOff': 'Off — never stop',
      'trainer.capFullThreshold': 'Cap full at %',
      'trainer.fallbackSlot': 'Fallback slot (empty = idle)',
      'trainer.fallbackManaPct': 'Fallback mana %',
      'trainer.reserve': 'Mana reserve',
      'trainer.eatWithMagic': 'Eat with magic when mana low',
      'trainer.eatMagicSlot': 'Magic food slot',
      'trainer.save': 'Save trainer settings',
      'trainer.capFullAlert': 'Rune cap full — rune-making stopped (fallback or idle)',
      // PR A (REQ-40/41, D-A3/A5): rune-check pause banner + resume + alert
      // kind labels (the detection ALERT rides the anti-bot per-id latch).
      'trainer.runeCheckAlert': 'Rune check detected — botting paused (solve the check to resume)',
      'trainer.runeCheckResumed': 'Rune check resolved — botting resumed',
      'trainer.resumeBtn': 'Resume botting',
      'alert.kind.antibot-runecheck': 'Rune check',
      // Slice B (REQ-42..46, D-B1..B6): TRAINER 2-col redesign — rune select,
      // hotkeys, mana/CAP bars, toggles and the Stop-Botting confirm. New
      // labels are i18n EN+ES; the tab/module labels keep following the panel
      // language (decision 1, D-B1).
      'trainer.runeMakingTitle': 'Rune-making',
      'trainer.capacityTitle': 'Capacity & alerts',
      'trainer.runeSelect': 'Select Rune to Create',
      'trainer.runeSelectFallback': 'No rune spells matched — showing the full catalog',
      'trainer.castLogic': 'If Mana >= cost + reserve',
      'trainer.runeHotkey': 'Rune Hotkey',
      'trainer.fallbackHotkey': 'Fallback Hotkey',
      'trainer.assignBtn': 'Assign',
      'trainer.fallbackMagic': 'Fallback Magic',
      'trainer.autoFallbackMagic': 'Auto Fallback Magic',
      'trainer.manaBar': 'Your mana',
      'trainer.capBar': 'Current cap',
      'trainer.whenCapFull': 'When CAP is Full',
      'trainer.soundAlert': 'Sound Alert',
      'trainer.stopRuneMaking': 'Stop Rune-Making',
      'trainer.stopBotting': 'Stop Botting Entirely',
      'trainer.stopBottingActive': 'Botting stopped — rune-making is off (healing and eating continue). Save with Stop Botting off to re-enable.',
      'trainer.confirmTitle': 'Stop botting entirely?',
      'trainer.confirmBody': 'This turns rune-making off — healing and eating continue. You can re-enable it any time.',
      'trainer.confirmYes': 'Yes, stop botting',
      'trainer.confirmNo': 'Cancel',
      'trainer.hotkeyUnavailable': 'Hotkeys unavailable — the game keyboard surface is not exposed (display only)',
      // Slice 5 (PR5, REQ-33/34): OTHERS settings form + anti-bot live state.
      'others.formTitle': 'Other settings',
      'others.foodTitle': 'Food',
      'others.foodSlot': 'Food slot (backpack index)',
      'others.everyCasts': 'Eat every N casts (0 = hunger only)',
      'others.lootTitle': 'Auto-loot',
      'others.lootDest': 'Default destination (empty = loot only listed monsters)',
      'others.antibotTitle': 'Anti-bot chat replies',
      'others.antibotReplies': 'One per line: pattern => reply (first match asks confirmation once per session)',
      'others.save': 'Save other settings',
      'others.confirmPrompt': 'Anti-bot pattern "%pattern%" seen — confirm to auto-reply "%reply%"?',
      'others.confirmBtn': 'Confirm & enable auto-reply',
      'others.sendUnavailable': 'Auto-replies unavailable — no Default-channel send surface (alert only)',
      'others.alertsTitle': 'Anti-bot alerts',
      'others.noAlerts': 'No anti-bot events yet.',
      'others.alertSpeak': 'Speak',
      'others.alertMoved': 'Moved',
      'others.alertAttacked': 'Attack',
      // Slice 7 (PR6, REQ-35/36): ATTACK + CAVEBOT skeleton forms.
      'attack.formTitle': 'Attack settings (skeleton)',
      'attack.skeletonNote': 'Combat logic is limited — full targeting arrives in a later update.',
      'attack.targeting': 'Targeting',
      'attack.targetingLowestHp': 'Lowest HP',
      'attack.targetingNearest': 'Nearest',
      'attack.runeSlot': 'Offensive rune slot',
      'attack.spellHint': 'Offensive spell — pick it with the spell picker below.',
      'attack.save': 'Save attack settings',
      'cavebot.formTitle': 'Cavebot (skeleton)',
      'cavebot.skeletonNote': 'Route walking is limited — the full cavebot arrives in a later update.',
      'cavebot.record': 'Record route',
      'cavebot.stopRecord': 'Stop & keep',
      'cavebot.saveRoute': 'Save route',
      'cavebot.pause': 'Pause',
      'cavebot.resume': 'Resume',
      'cavebot.start': 'Start (nearest waypoint)',
      'cavebot.recording': 'Recording — %count% waypoints',
      'cavebot.idle': 'Not recording',
      'cavebot.savedRoute': 'Saved route: %count% waypoints',
      'cavebot.noRoute': 'No saved route yet — record and save one.',
      'cavebot.paused': 'Paused',
      'cavebot.editingFuture': 'Route editing — FUTURE (out of scope in v1).',
      // Audit i18n completion: routes/attack/cavebot live lines, learning
      // offer buttons, the eat-pause alert, the premium notice, the routes
      // form and the anti-bot alert fallback (state.js + app.js).
      'routes.title': 'Routes (v1)',
      'routes.walkTo': 'Walk to',
      'routes.recordingFuture': 'Route recording — FUTURE (out of scope in v1).',
      'routes.unavailable': 'Routes: %reason%',
      'routes.notWalking': 'Routes: not auto-walking',
      'routes.autoWalkingSteps': 'Auto-walking: %count% steps remaining',
      'routes.autoWalkingStepsTo': 'Auto-walking: %count% steps remaining to (%x%, %y%)',
      'routes.autoWalkingProgress': 'Auto-walking: in progress',
      'routes.autoWalkingProgressTo': 'Auto-walking: in progress to (%x%, %y%)',
      'attack.stateOn': 'Attack: on — %targeting% (skeleton)',
      'attack.stateOnSpell': 'Attack: on — %targeting% — spell sid %sid% (skeleton)',
      'attack.stateOnRune': 'Attack: on — %targeting% — rune slot %slot% (skeleton)',
      'attack.stateOnFull': 'Attack: on — %targeting% — spell sid %sid% — rune slot %slot% (skeleton)',
      'attack.stateOff': 'Attack: off — %targeting% (skeleton)',
      'cavebot.stateOn': 'Cavebot: on — %detail%',
      'cavebot.stateOff': 'Cavebot: off — %detail%',
      'cavebot.stateRecording': 'recording %count% waypoints',
      'cavebot.stateNotRecording': 'not recording',
      'cavebot.stateSavedRoute': ' — saved route %count% waypoints',
      'cavebot.statePaused': ' — PAUSED',
      'offers.title': 'Registration offers',
      'offers.confirm': 'Confirm',
      'offers.decline': 'Decline',
      'eat.pausedAlert': 'Eating paused — 3 consecutive failed attempts.',
      'premium.required': 'Premium required — %modules% stay disabled (REQ-22).',
      'alert.antibot': 'Anti-bot: %kind%',
      // Audit: panel alert list + sound toggle (state.js + app.js).
      'alerts.title': 'Alerts',
      'alerts.empty': 'No alerts yet.',
      'alert.kind.cap-full': 'Rune cap full',
      'alert.kind.antibot-speak': 'Anti-bot: speak',
      'alert.kind.antibot-moved': 'Anti-bot: moved',
      'alert.kind.antibot-attacked': 'Anti-bot: attack',
      'alert.kind.info': 'Info',
      'alert.kind.event': 'Event',
      'sound.enabled': 'Alert sounds',
    },
    es: {
      'gate.disconnected': 'Desconectado',
      'gate.probing': 'Esperando al juego…',
      'gate.confirmed': 'Confirmando conexión',
      'gate.armed': 'Conectado',
      'connect': 'Conectar',
      'cancel': 'Cancelar',
      'disconnect': 'Desconectar',
      'refused': 'rechazado: %reason%',
      'language': 'Idioma',
      'tab.heal': 'CURAR',
      'tab.attack': 'ATAQUE',
      'tab.trainer': 'ENTRENAR',
      'tab.cavebot': 'CAVEBOT',
      'tab.others': 'OTROS',
      'configuration': 'Configuración',
      'configLocked': 'La configuración se desbloquea al conectar.',
      'liveState': 'Estado en vivo',
      'activityLog': 'Registro de actividad',
      'noSnapshot': 'Aún sin datos — conectando…',
      'log.empty': 'Sin actividad todavía.',
      'stats.health': 'Vida',
      'stats.mana': 'Maná',
      'skeleton.note': 'Esqueleto — funcionalidad limitada en una próxima actualización.',
      'module.healItems': 'Curar con objetos',
      'module.healMagic': 'Curar con magia',
      'module.runes': 'Runas',
      'module.training': 'Entrenar magia',
      'module.eat': 'Comer',
      'module.trade': 'Difusión de comercio',
      'module.loot': 'Auto-loot',
      'module.spawns': 'Mapas de spawns',
      'module.huntStats': 'Estadísticas de caza',
      'module.routes': 'Rutas',
      'module.attack': 'Ataque',
      'module.cavebot': 'Cavebot',
      'picker.module.attack': 'Hechizo de ataque',
      'tutorial.title': 'Bienvenido al panel del bot',
      'tutorial.body': 'Este panel controla tu bot, una pestaña por actividad. Este recorrido muestra cada pestaña — podés omitirlo en cualquier momento.',
      'tutorial.tab.heal': 'CURAR — configurá la curación: umbral de vida, pociones o magia.',
      'tutorial.tab.attack': 'ATAQUE — el targeting (menor vida / más cercano) llega en una próxima actualización.',
      'tutorial.tab.trainer': 'ENTRENAR — runas con tope estricto, reserva de maná y hechizo alternativo.',
      'tutorial.tab.cavebot': 'CAVEBOT — grabado de rutas y autowalk planificados para una próxima actualización.',
      'tutorial.tab.others': 'OTROS — comida, auto-loot, difusión de comercio y alertas anti-bot.',
      'tutorial.next': 'Siguiente',
      'tutorial.finish': 'Terminar',
      'tutorial.dismiss': 'Omitir tutorial',
      // Slice 1b (REQ-27/28): profile cross-load + spell picker.
      'profile.title': 'Perfiles',
      'profile.none': 'Todavía no hay configs de otros personajes — aparecen acá cuando un Connect las guarda.',
      'profile.loadFrom': 'Cargar config de',
      'profile.loadBtn': 'Cargar config',
      'profile.loadedAll': 'Config de %from% cargada — todo aplica.',
      'profile.loadedRejected': 'Config de %from% cargada — entradas incompatibles rechazadas:',
      'profile.failed': 'No se pudo cargar la config de %from%: %reason%',
      'picker.title': 'Selector de magias',
      'picker.empty': 'Todavía no hay catálogo de magias — conectá un personaje para cargarlo.',
      'picker.module.healMagic': 'Hechizo de curación',
      'picker.module.training': 'Hechizo de entrenamiento',
      'picker.search': 'Buscar magias…',
      'picker.none': 'No hay magias que coincidan.',
      'picker.meta': 'maná %mana%, nivel %level%',
      'picker.pick': 'Elegir',
      'picker.current': 'actual',
      // Slice 2 (PR3, REQ-29): formulario de ajustes de CURAR + línea de estado.
      'heal.formTitle': 'Ajustes de curación',
      'heal.threshold': 'Umbral de vida %',
      'heal.slot': 'Slot del hotbar',
      'heal.reserve': 'Reserva de maná',
      'heal.save': 'Guardar curación',
      'heal.liveOn': 'Magia de curación activa — vida %pct%% de %max%, dispara al %t%% (slot %slot%)',
      'heal.liveOff': 'Magia de curación apagada — sin acciones de curación',
      // Slice 3 (PR4, REQ-30/31/32): formulario de ENTRENAR + alerta de tope.
      'trainer.formTitle': 'Ajustes de entrenamiento',
      'trainer.capMode': 'Modo de tope de runas',
      'trainer.capModeStrict': 'Estricto — parar al tope',
      'trainer.capModeOff': 'Apagado — no parar nunca',
      'trainer.capFullThreshold': 'Tope lleno al %',
      'trainer.fallbackSlot': 'Slot alternativo (vacío = esperar)',
      'trainer.fallbackManaPct': 'Maná para el alternativo %',
      'trainer.reserve': 'Reserva de maná',
      'trainer.eatWithMagic': 'Comer con magia cuando falte maná',
      'trainer.eatMagicSlot': 'Slot de comida mágica',
      'trainer.save': 'Guardar entrenamiento',
      'trainer.capFullAlert': 'Tope de runas lleno — se detuvo la fabricación (alternativo o espera)',
      // PR A (REQ-40/41, D-A3/A5): banner de pausa por check de runas +
      // reanudar + etiquetas de alerta (la ALERTA de detección viaja por el
      // latch por-id anti-bot).
      'trainer.runeCheckAlert': 'Check de runas detectado — bot pausado (resolvé el check para reanudar)',
      'trainer.runeCheckResumed': 'Check de runas resuelto — bot reanudado',
      'trainer.resumeBtn': 'Reanudar bot',
      'alert.kind.antibot-runecheck': 'Check de runas',
      // Slice B (REQ-42..46, D-B1..B6): rediseño del ENTRENAR en 2 columnas —
      // selector de runas, teclas, barras de maná/capacidad, interruptores y
      // confirmación de "detener el bot". Etiquetas nuevas i18n EN+ES (las de
      // pestañas/módulos ya siguen el idioma del panel, decisión 1).
      'trainer.runeMakingTitle': 'Fabricar runas',
      'trainer.capacityTitle': 'Capacidad y alertas',
      'trainer.runeSelect': 'Elegir runa a crear',
      'trainer.runeSelectFallback': 'No se encontraron runas — mostrando todo el catálogo',
      'trainer.castLogic': 'Si Maná >= coste + reserva',
      'trainer.runeHotkey': 'Tecla de runa',
      'trainer.fallbackHotkey': 'Tecla de alternativa',
      'trainer.assignBtn': 'Asignar',
      'trainer.fallbackMagic': 'Magia alternativa',
      'trainer.autoFallbackMagic': 'Magia alternativa automática',
      'trainer.manaBar': 'Tu maná',
      'trainer.capBar': 'Capacidad actual',
      'trainer.whenCapFull': 'Cuando la capacidad esté llena',
      'trainer.soundAlert': 'Alerta sonora',
      'trainer.stopRuneMaking': 'Detener fabricación de runas',
      'trainer.stopBotting': 'Detener el bot por completo',
      'trainer.stopBottingActive': 'Bot detenido — fabricación de runas apagada (curar y comer continúan). Guardá con "Detener el bot" desactivado para reanudar.',
      'trainer.confirmTitle': '¿Detener el bot por completo?',
      'trainer.confirmBody': 'Esto apaga la fabricación de runas — curar y comer continúan. Podés volver a activarlo cuando quieras.',
      'trainer.confirmYes': 'Sí, detener el bot',
      'trainer.confirmNo': 'Cancelar',
      'trainer.hotkeyUnavailable': 'Teclas no disponibles — la superficie de teclado del juego no está expuesta (solo lectura)',
      // Slice 5 (PR5, REQ-33/34): formulario de OTROS + estado anti-bot en vivo.
      'others.formTitle': 'Otros ajustes',
      'others.foodTitle': 'Comida',
      'others.foodSlot': 'Slot de comida (índice de mochila)',
      'others.everyCasts': 'Comer cada N hechizos (0 = solo con hambre)',
      'others.lootTitle': 'Auto-loot',
      'others.lootDest': 'Destino por defecto (vacío = loot solo a monstruos listados)',
      'others.antibotTitle': 'Respuestas anti-bot',
      'others.antibotReplies': 'Una por línea: patrón => respuesta (la primera coincidencia pide confirmación una vez por sesión)',
      'others.save': 'Guardar otros ajustes',
      'others.confirmPrompt': 'Patrón anti-bot "%pattern%" detectado — ¿confirmás para responder "%reply%"?',
      'others.confirmBtn': 'Confirmar y activar respuesta',
      'others.sendUnavailable': 'Respuestas no disponibles — sin superficie de envío al canal Default (solo alertas)',
      'others.alertsTitle': 'Alertas anti-bot',
      'others.noAlerts': 'Todavía no hay eventos anti-bot.',
      'others.alertSpeak': 'Habla',
      'others.alertMoved': 'Movimiento',
      'others.alertAttacked': 'Ataque',
      // Slice 7 (PR6, REQ-35/36): formularios esqueleto de ATAQUE + CAVEBOT.
      'attack.formTitle': 'Ajustes de ataque (esqueleto)',
      'attack.skeletonNote': 'La lógica de combate es limitada — el targeting completo llega en una próxima actualización.',
      'attack.targeting': 'Targeting',
      'attack.targetingLowestHp': 'Menor vida',
      'attack.targetingNearest': 'Más cercano',
      'attack.runeSlot': 'Slot de runa ofensiva',
      'attack.spellHint': 'Hechizo ofensivo — elegilo con el selector de magias de abajo.',
      'attack.save': 'Guardar ataque',
      'cavebot.formTitle': 'Cavebot (esqueleto)',
      'cavebot.skeletonNote': 'El caminado de rutas es limitado — el cavebot completo llega en una próxima actualización.',
      'cavebot.record': 'Grabar ruta',
      'cavebot.stopRecord': 'Parar y conservar',
      'cavebot.saveRoute': 'Guardar ruta',
      'cavebot.pause': 'Pausar',
      'cavebot.resume': 'Reanudar',
      'cavebot.start': 'Iniciar (waypoint más cercano)',
      'cavebot.recording': 'Grabando — %count% waypoints',
      'cavebot.idle': 'Sin grabar',
      'cavebot.savedRoute': 'Ruta guardada: %count% waypoints',
      'cavebot.noRoute': 'Todavía no hay ruta guardada — grabá una y guardala.',
      'cavebot.paused': 'Pausado',
      'cavebot.editingFuture': 'Edición de rutas — FUTURO (fuera de alcance en v1).',
      // Audit i18n completion: rutas/ataque/cavebot líneas en vivo, botones de
      // oferta, alerta de comida pausada, aviso de premium y el formulario de
      // rutas (state.js + app.js).
      'routes.title': 'Rutas (v1)',
      'routes.walkTo': 'Caminar a',
      'routes.recordingFuture': 'Grabación de rutas — FUTURO (fuera de alcance en v1).',
      'routes.unavailable': 'Rutas: %reason%',
      'routes.notWalking': 'Rutas: sin caminado automático',
      'routes.autoWalkingSteps': 'Caminado automático: quedan %count% pasos',
      'routes.autoWalkingStepsTo': 'Caminado automático: quedan %count% pasos hasta (%x%, %y%)',
      'routes.autoWalkingProgress': 'Caminado automático: en curso',
      'routes.autoWalkingProgressTo': 'Caminado automático: en curso hasta (%x%, %y%)',
      'attack.stateOn': 'Ataque: activo — %targeting% (esqueleto)',
      'attack.stateOnSpell': 'Ataque: activo — %targeting% — hechizo sid %sid% (esqueleto)',
      'attack.stateOnRune': 'Ataque: activo — %targeting% — runa slot %slot% (esqueleto)',
      'attack.stateOnFull': 'Ataque: activo — %targeting% — hechizo sid %sid% — runa slot %slot% (esqueleto)',
      'attack.stateOff': 'Ataque: apagado — %targeting% (esqueleto)',
      'cavebot.stateOn': 'Cavebot: activo — %detail%',
      'cavebot.stateOff': 'Cavebot: apagado — %detail%',
      'cavebot.stateRecording': 'grabando %count% waypoints',
      'cavebot.stateNotRecording': 'sin grabar',
      'cavebot.stateSavedRoute': ' — ruta guardada de %count% waypoints',
      'cavebot.statePaused': ' — PAUSADO',
      'offers.title': 'Ofertas de registro',
      'offers.confirm': 'Confirmar',
      'offers.decline': 'Rechazar',
      'eat.pausedAlert': 'Comer pausado — 3 intentos fallidos consecutivos.',
      'premium.required': 'Se requiere Premium — %modules% permanecen desactivados (REQ-22).',
      'alert.antibot': 'Anti-bot: %kind%',
      // Audit: lista de alertas del panel + interruptor de sonido (state.js + app.js).
      'alerts.title': 'Alertas',
      'alerts.empty': 'Todavía no hay alertas.',
      'alert.kind.cap-full': 'Tope de runas lleno',
      'alert.kind.antibot-speak': 'Anti-bot: habla',
      'alert.kind.antibot-moved': 'Anti-bot: movimiento',
      'alert.kind.antibot-attacked': 'Anti-bot: ataque',
      'alert.kind.info': 'Información',
      'alert.kind.event': 'Evento',
      'sound.enabled': 'Sonidos de alerta',
    },
  };

  /** Resolve an i18n key for a state.lang (falls back to EN). */
  function t(state, key) {
    const lang = state && state.lang === LANG_ES ? LANG_ES : LANG_EN;
    const dict = I18N[lang] || I18N[LANG_EN];
    return dict[key] !== undefined ? dict[key] : (I18N[LANG_EN][key] !== undefined ? I18N[LANG_EN][key] : key);
  }

  /** Resolve with %var% substitution ({reason} style template). */
  function tVar(state, key, vars) {
    let out = t(state, key);
    if (vars && typeof vars === 'object') {
      for (const k of Object.keys(vars)) out = out.split('%' + k + '%').join(String(vars[k]));
    }
    return out;
  }

  /** Readable module label for the current language (module.* key). */
  function moduleLabel(state, def) {
    return t(state, 'module.' + def.id);
  }

  /**
   * Tutorial stepper (design D7, REQ-26): one step per tab + intro. The step
   * carries the tab it highlights; TUTORIAL_NEXT switches the active tab so
   * the walk physically visits every tab. localStorage 'tutorialSeen' lives
   * in app.js (dismiss/finish effect); the reducer owns only the step state.
   */
  const TUTORIAL_STEPS = [
    { tab: null, key: 'tutorial.title', body: 'tutorial.body' },
    { tab: 'heal', key: 'tutorial.tab.heal' },
    { tab: 'attack', key: 'tutorial.tab.attack' },
    { tab: 'trainer', key: 'tutorial.tab.trainer' },
    { tab: 'cavebot', key: 'tutorial.tab.cavebot' },
    { tab: 'others', key: 'tutorial.tab.others' },
  ];

  function emptyModules() {
    const out = {};
    for (const id of MODULE_IDS) out[id] = false;
    return out;
  }

  /**
   * Initial panel state. `config` mirrors the per-character config that will
   * be pushed to the agent (armed pushes carry it).
   */
  function createInitialState() {
    return {
      gate: GATE_DISCONNECTED,
      identity: null,          // {name, vocationId, vocationLabel} | null
      modules: emptyModules(), // {moduleId: boolean} — toggle state
      config: null,            // full per-character config (armed pushes)
      snapshot: null,          // live state view payload (SNAPSHOT)
      alerts: [],              // {kind, message, at} — eat pause, premium...
      offers: [],              // {word, ts} — learning offers (slice 5)
      walkTo: { x: '', y: '' }, // routes v1 form values (slice 6, REQ-23)
      refusal: null,           // last refused action {action, module, reason, at}
      lastError: null,
      // Slice 1a (REQ-26): product shell state.
      tab: 'heal',             // active tab id (TABS)
      lang: LANG_EN,           // 'en' | 'es' — default EN (REQ-26)
      soundEnabled: true,      // alert sound toggle — default ON (persisted 'mb-panel-sound')
      tutorial: null,          // null | {step: number} — first-run stepper
      confirmStop: null,       // Slice B (REQ-45, D-B6): null | {pending: true, at} — Stop-Botting confirm overlay
      // Slice 1b (REQ-27/28): profile cross-load + spell picker state.
      profiles: [],            // character names with saved configs (REQ-27)
      catalog: { spells: [], loaded: false, reason: null }, // filtered client catalog (REQ-28)
      picker: { module: 'healMagic', query: '' }, // picker module + search (REQ-28)
      profileLoad: null,       // {ok, from, rejected[], reason, at} — last cross-load (REQ-27)
      // Slice 2 (PR3, REQ-29): HEAL settings form raw values — pure UI
      // strings that survive re-renders (walkTo precedent); SAVE_HEAL_SETTINGS
      // converts + commits them into config.modules.healMagic.
      healForm: { threshold: '', slot: '', reserve: '' },
      // Slice 3 (PR4, REQ-30/31/32): TRAINER settings form raw values — pure
      // UI strings (percent/ratio conversion at save, see SAVE_TRAINER_SETTINGS).
      // Slice B (REQ-42..46): runeSid (inline rune select, D-B2), the F-key
      // hotkey selects (D-B3) and the toggle switches (D-B4) extend the form.
      trainerForm: {
        capMode: '', capFullThreshold: '', fallbackSlot: '', fallbackManaPct: '',
        reserve: '', eatMagic: '', eatMagicSlot: '',
        runeSid: '', runeKey: '', fallbackKey: '',
        autoFallback: '', stopRuneMaking: '', stopBotting: '',
      },
      // Slice 5 (PR5, REQ-33/34): OTHERS settings form raw values — pure UI
      // strings (food slot, every-N-casts, loot default destination, anti-bot
      // replies as `pattern => reply` lines) that survive re-renders;
      // SAVE_OTHERS_SETTINGS parses + commits them into the config.
      othersForm: { foodSlot: '', everyCasts: '', lootDest: '', antibotReplies: '' },
      // Slice 7 (PR6, REQ-35/36): ATTACK settings form raw values (pure UI
      // strings that survive re-renders — targeting select + rune slot; the
      // spell sid comes from the picker) + the cavebot recorded-route result
      // (CAVEBOT_RECORDED -> Save writes config.routes, REQ-36).
      attackForm: { targeting: '', runeSlot: '' },
      cavebotRecorded: null, // {points: Array<{x,y}>, at} | null — last stopped recording
    };
  }

  /** Escape HTML in any user-visible string (player names are page data). */
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Slice 2 (PR3, REQ-29): derive the HEAL form values from the saved config.
   * The agent stores the threshold as ABSOLUTE hp (v1 semantics, unchanged);
   * the FORM speaks percent — the conversion needs the snapshot maxHealth.
   * When maxHealth is unknown the raw absolute value shows (honest degrade).
   * @param {object} state
   * @returns {{threshold: string, slot: string, reserve: string}}
   */
  function healFormFromConfig(state) {
    const hm = state.config && state.config.modules && state.config.modules.healMagic;
    const maxHp = snapshotStats(state.snapshot).maxHealth;
    const threshold = hm && Number.isFinite(Number(hm.threshold)) ? Number(hm.threshold) : null;
    const pct = threshold === null ? ''
      : (maxHp !== null && maxHp > 0 ? String(Math.round(threshold / maxHp * 100)) : String(threshold));
    const slot = hm && hm.slot !== null && hm.slot !== undefined ? String(hm.slot) : '';
    const reserve = hm && Number.isFinite(Number(hm.reserve)) ? String(hm.reserve) : '';
    return { threshold: pct, slot, reserve };
  }

  /**
   * Slice 3 (PR4, REQ-30/31/32): derive the TRAINER form values from the
   * saved config. The config stores ratios (capFullThreshold/fallbackManaPct
   * as 0..1) and the FORM speaks percent — the conversion happens here at
   * render time and again at save (SAVE_TRAINER_SETTINGS). Missing values
   * fall back to the forward-compat defaults (strict, 100%, 50%).
   * Slice B (REQ-42..46): the inline rune sid (D-B2), the hotkey F-keys
   * (D-B3) and the toggle switches (D-B4) derive here too.
   * @param {object} state
   * @returns {object} trainerForm-shaped value strings
   */
  function trainerFormFromConfig(state) {
    const cfg = state.config && state.config.modules || {};
    const runes = cfg.runes || {};
    const training = cfg.training || {};
    const ew = training.eatWithMagic && typeof training.eatWithMagic === 'object'
      ? training.eatWithMagic : {};
    const hotkeys = training.hotkeys && typeof training.hotkeys === 'object'
      ? training.hotkeys : {};
    const threshold = Number(runes.capFullThreshold);
    const pct = Number(runes.fallbackManaPct);
    const sid = Number(training.sid);
    return {
      capMode: runes.capMode === 'off' ? 'off' : 'strict',
      capFullThreshold: String(Number.isFinite(threshold) ? Math.round(threshold * 100) : 100),
      fallbackSlot: runes.fallbackSlot !== null && runes.fallbackSlot !== undefined
        ? String(runes.fallbackSlot) : '',
      fallbackManaPct: String(Number.isFinite(pct) ? Math.round(pct * 100) : 50),
      reserve: Number.isFinite(Number(training.reserve)) ? String(training.reserve) : '',
      eatMagic: ew.enabled === true ? 'true' : 'false',
      eatMagicSlot: ew.slot !== null && ew.slot !== undefined ? String(ew.slot) : '',
      // Slice B (D-B2/D-B3/D-B4): rune sid + hotkey F-keys + toggles.
      runeSid: Number.isInteger(sid) ? String(sid) : '',
      runeKey: hotkeys.runeKey || 'F4',
      fallbackKey: hotkeys.fallbackKey || 'F5',
      autoFallback: runes.fallbackSlot !== null && runes.fallbackSlot !== undefined ? 'true' : 'false',
      stopRuneMaking: training.stopRuneMaking === true ? 'true' : 'false',
      stopBotting: training.stopBotting === true ? 'true' : 'false',
    };
  }

  /** Slice B (REQ-46, D-B3): the F-key selectable hotkeys. */
  const FKEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

  /**
   * Slice B (REQ-42, D-B2): catalog rows filtered to rune spells — /rune/i on
   * the name OR the words (the catalog carries NO rune flag, documented
   * limitation D-B2). Falls back to the FULL list when no rune matches so the
   * select stays honest and usable. Pure.
   * @param {object} state
   * @returns {{runes: Array, list: Array, fallback: boolean}}
   */
  function filterRuneCatalog(state) {
    const spells = (state.catalog && state.catalog.spells) || [];
    const runes = spells.filter((s) => s && typeof s === 'object'
      && (/rune/i.test(String(s.name || '')) || /rune/i.test(String(s.words || ''))));
    return { runes, list: runes.length > 0 ? runes : spells, fallback: runes.length === 0 && spells.length > 0 };
  }

  /**
   * Slice B (REQ-43, D-B5): the trainer CAP snapshot — the training module
   * carries {capacity, maxCapacity, ratio} in its getState (training.js:261,
   * already live). Pure; null when absent.
   * @param {object|null} snapshot
   * @returns {{capacity: number|null, maxCapacity: number|null, ratio: number|null}|null}
   */
  function snapshotCap(snapshot) {
    const c = snapshot && snapshot.agent && snapshot.agent.modules
      && snapshot.agent.modules.training && snapshot.agent.modules.training.cap;
    if (!c || typeof c !== 'object') return null;
    const num = (v) => (v === null || v === undefined || v === '' ? null
      : (Number.isFinite(Number(v)) ? Number(v) : null));
    return { capacity: num(c.capacity), maxCapacity: num(c.maxCapacity), ratio: num(c.ratio) };
  }

  /** Slice B (REQ-43, D-B5): shared gradient-bar markup — localized label,
   *  percent, cur/max values and the CSS-width fill. Pure.
   *  @param {object} state
   *  @param {string} cls - bar variant class (mana-bar / cap-bar)
   *  @param {string} data - data-bar attribute (test hook)
   *  @param {string} labelKey - i18n key (trainer.manaBar / trainer.capBar)
   *  @param {number|null} cur
   *  @param {number|null} max
   *  @param {number|null} pct - percent to display + drive the fill width */
  function renderBar(state, cls, data, labelKey, cur, max, pct) {
    const pctText = pct === null ? '—' : String(pct) + '%';
    const width = pct === null ? 0 : Math.max(0, Math.min(100, pct));
    return '<div class="bar ' + cls + '" data-bar="' + data + '">'
      + '<div class="bar-label">' + escapeHtml(t(state, labelKey)) + ': <strong>' + escapeHtml(pctText) + '</strong>'
      + ' <span class="bar-values">' + escapeHtml(cur === null ? '—' : String(cur)) + ' / '
      + escapeHtml(max === null ? '—' : String(max)) + '</span></div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div>'
      + '</div>';
  }

  /**
   * Slice 5 (PR5, REQ-33/34): derive the OTHERS form values from the saved
   * config. The anti-bot replies render as `pattern => reply` lines (one per
   * entry) — the exact format SAVE_OTHERS_SETTINGS parses back.
   * @param {object} state
   * @returns {object} othersForm-shaped value strings
   */
  function othersFormFromConfig(state) {
    const cfg = state.config && state.config.modules || {};
    const eat = cfg.eat || {};
    const loot = cfg.loot || {};
    const antibot = cfg.antibot || {};
    const replies = Array.isArray(antibot.replies) ? antibot.replies : [];
    return {
      foodSlot: eat.slot !== null && eat.slot !== undefined ? String(eat.slot) : '',
      everyCasts: Number.isFinite(Number(eat.everyCasts)) ? String(eat.everyCasts) : '',
      lootDest: typeof loot.defaultDest === 'string' && loot.defaultDest ? loot.defaultDest : '',
      antibotReplies: replies
        .filter((r) => r && typeof r === 'object')
        .map((r) => String(r.pattern || '') + ' => ' + String(r.reply || ''))
        .join('\n'),
    };
  }

  /**
   * Slice 5 (PR5, REQ-33/34): parse the anti-bot replies textarea — one
   * `pattern => reply` entry per line, blank lines skipped. A malformed line
   * returns the line number + text (the save is refused with a visible
   * reason — never a silent drop).
   * @param {string} text
   * @returns {{error: string|null, entries: Array<{pattern: string, reply: string}>}}
   */
  function parseRepliesText(text) {
    const entries = [];
    const lines = String(text === null || text === undefined ? '' : text).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      const sep = line.indexOf(' => ');
      const pattern = sep === -1 ? '' : line.slice(0, sep).trim();
      const reply = sep === -1 ? '' : line.slice(sep + 4).trim();
      if (!pattern || !reply) {
        return { error: 'line ' + (i + 1) + ' must be "pattern => reply"', entries: null };
      }
      entries.push({ pattern, reply });
    }
    return { error: null, entries };
  }

  /**
   * Slice 7 (PR6, REQ-35): derive the ATTACK form values from the saved
   * config — targeting choice (lowest-hp/nearest, default lowest-hp) and
   * the offensive rune slot. The spell sid is chosen with the picker
   * (PICK_SPELL writes config.modules.attack.sid), not this form.
   * @param {object} state
   * @returns {{targeting: string, runeSlot: string}}
   */
  function attackFormFromConfig(state) {
    const cfg = state.config && state.config.modules || {};
    const attack = cfg.attack || {};
    return {
      targeting: attack.targeting === 'nearest' ? 'nearest' : 'lowest-hp',
      runeSlot: attack.runeSlot !== null && attack.runeSlot !== undefined
        ? String(attack.runeSlot) : '',
    };
  }

  /** Refusal factory — the shared "not connected" gate reason. */
  function refuse(state, action) {
    return Object.assign({}, state, {
      refusal: {
        action: action.type,
        module: action.module || null,
        reason: 'not connected',
        at: Date.now(),
      },
    });
  }

  /** Identity change detection: name differs from the confirmed one. */
  function identityChanged(state, identity) {
    return Boolean(state.identity && identity && state.identity.name !== identity.name);
  }

  /**
   * Slice B (REQ-30/31/32 + REQ-42..46): validate + commit the TRAINER form
   * into the config. Percent inputs (cap full threshold, fallback mana)
   * convert to the 0..1 ratios the agent compares; the cap settings land in
   * config.modules.runes (D3), reserve + eat-with-magic + rune sid + hotkeys
   * in config.modules.training (D2/D4/D-B2/D-B3). Slice-B toggle semantics
   * (D-B4): Auto Fallback Magic ON requires a fallback slot; Stop Rune-Making
   * and Stop Botting Entirely BOTH end at the runes module OFF only — healing
   * and eating continue (decision 4). Invalid values are refused with a
   * visible reason — never silently dropped. Pure; shared by
   * SAVE_TRAINER_SETTINGS and the Stop-Botting confirm commit (CONFIRM_STOP).
   * @param {object} state
   * @param {object} form - trainerForm-shaped raw values
   * @returns {{ok: boolean, state?: object, effects?: Array, refusal?: object}}
   */
  function commitTrainerSettings(state, form) {
    const at = Date.now();
    const invalid = (reason) => ({ ok: false, refusal: { action: 'SAVE_TRAINER_SETTINGS', module: 'training', reason, at } });
    const capMode = String(form.capMode || '').trim() || 'strict';
    const rawThreshold = String(form.capFullThreshold || '').trim();
    const rawFallbackSlot = String(form.fallbackSlot || '').trim();
    const rawFallbackPct = String(form.fallbackManaPct || '').trim();
    const rawReserve = String(form.reserve || '').trim();
    const eatMagic = String(form.eatMagic || '');
    const rawEatSlot = String(form.eatMagicSlot || '').trim();
    const runeSid = String(form.runeSid || '').trim();
    // Empty toggles default OFF (a fresh form never blocks an untouched save).
    const autoFallback = String(form.autoFallback || '') || 'false';
    const stopRuneMaking = String(form.stopRuneMaking || '') || 'false';
    const stopBotting = String(form.stopBotting || '') || 'false';
    const runeKey = String(form.runeKey || '').trim() || 'F4';
    const fallbackKey = String(form.fallbackKey || '').trim() || 'F5';
    if (capMode !== 'strict' && capMode !== 'off') {
      return invalid('invalid trainer settings — cap mode must be strict or off');
    }
    const threshold = Number(rawThreshold);
    const fallbackPct = Number(rawFallbackPct);
    const reserve = Number(rawReserve);
    if (rawThreshold === '' || rawFallbackPct === '' || rawReserve === ''
      || !Number.isFinite(threshold) || threshold < 0 || threshold > 100
      || !Number.isFinite(fallbackPct) || fallbackPct < 0 || fallbackPct > 100
      || !Number.isFinite(reserve) || reserve < 0) {
      return invalid('invalid trainer settings — cap % 0-100, fallback mana % 0-100, reserve >= 0');
    }
    const fallbackSlot = rawFallbackSlot === '' ? null : Number(rawFallbackSlot);
    if (fallbackSlot !== null && (!Number.isInteger(fallbackSlot) || fallbackSlot < 1 || fallbackSlot > 12)) {
      return invalid('invalid trainer settings — fallback slot must be 1-12 or empty');
    }
    const ewEnabled = eatMagic === 'true';
    if (eatMagic !== 'true' && eatMagic !== 'false') {
      return invalid('invalid trainer settings — eat with magic must be on or off');
    }
    const eatSlot = rawEatSlot === '' ? null : Number(rawEatSlot);
    if (eatSlot !== null && (!Number.isInteger(eatSlot) || eatSlot < 1 || eatSlot > 12)) {
      return invalid('invalid trainer settings — magic food slot must be 1-12 or empty');
    }
    if (ewEnabled && eatSlot === null) {
      return invalid('invalid trainer settings — eat with magic needs a magic food slot');
    }
    // Slice B (REQ-42, D-B2): the inline rune select — a non-empty sid MUST
    // resolve to a catalog spell (PICK_SPELL pattern, REQ-28).
    if (runeSid !== '') {
      const sid = Number(runeSid);
      if (!Number.isInteger(sid)) {
        return invalid('invalid trainer settings — rune spell id must be a number');
      }
      const spells = (state.catalog && state.catalog.spells) || [];
      if (spells.filter((s) => Number(s.sid) === sid).length === 0) {
        const label = (state.identity && state.identity.vocationLabel) || 'current vocation';
        return invalid('invalid trainer settings — rune spell not available for ' + label);
      }
    }
    // Slice B (REQ-44, D-B4): toggle value validation.
    if (autoFallback !== 'true' && autoFallback !== 'false') {
      return invalid('invalid trainer settings — auto fallback magic must be on or off');
    }
    if (autoFallback === 'true' && fallbackSlot === null) {
      return invalid('invalid trainer settings — auto fallback magic needs a fallback slot');
    }
    if (stopRuneMaking !== 'true' && stopRuneMaking !== 'false') {
      return invalid('invalid trainer settings — stop rune-making must be on or off');
    }
    if (stopBotting !== 'true' && stopBotting !== 'false') {
      return invalid('invalid trainer settings — stop botting must be on or off');
    }
    // Slice B (REQ-46, D-B3): hotkeys must be selectable F-keys.
    if (FKEYS.indexOf(runeKey) === -1 || FKEYS.indexOf(fallbackKey) === -1) {
      return invalid('invalid trainer settings — hotkeys must be F1-F12');
    }
    const config = JSON.parse(JSON.stringify(state.config || {}));
    if (!config.modules || typeof config.modules !== 'object') config.modules = {};
    if (!config.modules.runes || typeof config.modules.runes !== 'object') config.modules.runes = {};
    if (!config.modules.training || typeof config.modules.training !== 'object') config.modules.training = {};
    config.modules.runes.capMode = capMode;
    config.modules.runes.capFullThreshold = threshold / 100;
    config.modules.runes.fallbackSlot = fallbackSlot;
    config.modules.runes.fallbackManaPct = fallbackPct / 100;
    config.modules.training.reserve = reserve;
    if (!config.modules.training.eatWithMagic || typeof config.modules.training.eatWithMagic !== 'object') {
      config.modules.training.eatWithMagic = {};
    }
    config.modules.training.eatWithMagic.enabled = ewEnabled;
    config.modules.training.eatWithMagic.slot = eatSlot;
    // Slice B (REQ-44, D-B4): either stop toggle turns the runes MODULE off
    // only — healing and eating continue (decision 4). The module toggle
    // state is what the push reads (buildPushConfig), so flip it here too.
    const modules = Object.assign({}, state.modules);
    if (stopRuneMaking === 'true' || stopBotting === 'true') {
      modules.runes = false;
      config.modules.runes.on = false;
    }
    return {
      ok: true,
      state: Object.assign({}, state, {
        modules,
        config,
        trainerForm: {
          capMode, capFullThreshold: String(threshold), fallbackSlot: fallbackSlot === null ? '' : String(fallbackSlot),
          fallbackManaPct: String(fallbackPct), reserve: String(reserve),
          eatMagic, eatMagicSlot: eatSlot === null ? '' : String(eatSlot),
          runeSid, runeKey, fallbackKey, autoFallback, stopRuneMaking, stopBotting,
        },
        refusal: null,
      }),
      effects: [{ type: 'push-config' }],
    };
  }

  /**
   * Pure reducer. Returns {state, effects}. Effects are executed by the
   * wiring layer (app.js/server): 'connect' (server push armed config),
   * 'disconnect' (server push armed:false), 'disarm' (identity change while
   * armed).
   * @param {object} state
   * @param {object} action
   * @returns {{state: object, effects: Array<{type: string}>}}
   */
  function panelReducer(state, action) {
    if (!action || typeof action !== 'object') return { state, effects: [] };
    switch (action.type) {
      case 'PROBE_START':
        if (state.gate === GATE_DISCONNECTED) {
          return { state: Object.assign({}, state, { gate: GATE_PROBING }), effects: [] };
        }
        return { state, effects: [] };

      case 'PROBE_RESULT': {
        const identity = action.identity || null;
        if (state.gate === GATE_PROBING) {
          if (!identity) return { state, effects: [] }; // "waiting for game" — keep polling
          return {
            state: Object.assign({}, state, { gate: GATE_CONFIRMED, identity, refusal: null }),
            effects: [],
          };
        }
        if ((state.gate === GATE_CONFIRMED || state.gate === GATE_ARMED) && identity && identityChanged(state, identity)) {
          // Different character appeared: show the new identity, require a
          // fresh Connect; disarm if we were armed (per-character isolation).
          const next = Object.assign({}, state, { gate: GATE_CONFIRMED, identity, refusal: null });
          const effects = state.gate === GATE_ARMED ? [{ type: 'disarm' }] : [];
          return { state: next, effects };
        }
        return { state, effects: [] };
      }

      case 'CONNECT':
        if (state.gate !== GATE_CONFIRMED) {
          return { state: refuse(state, action), effects: [] };
        }
        return {
          state: Object.assign({}, state, { gate: GATE_ARMED, refusal: null, lastError: null }),
          effects: [{ type: 'connect' }],
        };

      case 'CONNECT_FAILED':
        if (state.gate === GATE_ARMED) {
          return {
            state: Object.assign({}, state, {
              gate: GATE_CONFIRMED,
              lastError: action.message || 'connect failed',
            }),
            effects: [],
          };
        }
        return { state, effects: [] };

      case 'CANCEL':
        if (state.gate === GATE_PROBING || state.gate === GATE_CONFIRMED) {
          return { state: reset(), effects: [] };
        }
        return { state, effects: [] };

      case 'DISCONNECT':
        if (state.gate === GATE_ARMED || state.gate === GATE_CONFIRMED) {
          return { state: reset(), effects: [{ type: 'disconnect' }] };
        }
        return { state, effects: [] };

      case 'TOGGLE_MODULE': {
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        if (MODULE_IDS.indexOf(action.module) === -1) return { state, effects: [] };
        const modules = Object.assign({}, state.modules);
        modules[action.module] = action.on === true;
        return {
          state: Object.assign({}, state, { modules, refusal: null }),
          effects: [{ type: 'push-config' }],
        };
      }

      case 'UPDATE_SETTING':
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        return { state, effects: [{ type: 'push-config' }] };

      case 'UPDATE_WALK_INPUT': {
        // Pure UI state (no gate): preserves the routes walk-to form values
        // across re-renders (the config form re-renders on every dispatch).
        const prev = state.walkTo || { x: '', y: '' };
        const next = Object.assign({}, prev);
        if (action.key === 'x' || action.key === 'y') {
          next[action.key] = String(action.value === null || action.value === undefined ? '' : action.value);
        }
        return { state: Object.assign({}, state, { walkTo: next }), effects: [] };
      }

      case 'WALK_TO': {
        // REQ-23 (slice 6): walk-to via the native autowalk primitive. The
        // action is armed-gated like every other action; the effect executor
        // posts /api/walk-to (server -> in-page walkTo RPC -> queue ->
        // pathfinder.pathTo). Empty/non-numeric inputs are ignored.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const rawX = String(action.x === null || action.x === undefined ? '' : action.x).trim();
        const rawY = String(action.y === null || action.y === undefined ? '' : action.y).trim();
        if (rawX === '' || rawY === '' || !Number.isFinite(Number(rawX)) || !Number.isFinite(Number(rawY))) {
          return { state, effects: [] };
        }
        return { state, effects: [{ type: 'walk-to', x: Number(rawX), y: Number(rawY) }] };
      }

      case 'CONFIRM_OFFER': {
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        return {
          state,
          effects: [{ type: 'offer-confirm', word: String(action.word || '') }],
        };
      }

      case 'DECLINE_OFFER': {
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        return {
          state,
          effects: [{ type: 'offer-decline', word: String(action.word || '') }],
        };
      }

      case 'PREFILL_CONFIG': {
        if (state.gate !== GATE_CONFIRMED && state.gate !== GATE_ARMED) {
          return { state: refuse(state, action), effects: [] };
        }
        const config = action.config;
        const modules = emptyModules();
        if (config && config.modules && typeof config.modules === 'object') {
          for (const id of MODULE_IDS) {
            const m = config.modules[id];
            if (m && typeof m === 'object') modules[id] = m.on === true;
          }
        }
        // Slice 2 (PR3): the HEAL form keeps ONLY user-typed values (walkTo
        // precedent); untouched fields fall back to the config-derived
        // percent view at render time (healFormFromConfig). The loaded
        // config therefore shows without overwriting typed input.
        return {
          state: Object.assign({}, state, { modules, config: config || null, refusal: null }),
          effects: [],
        };
      }

      case 'SNAPSHOT':
        return { state: Object.assign({}, state, { snapshot: action.data !== undefined ? action.data : null }), effects: [] };

      case 'ALERT': {
        const alerts = (state.alerts || []).concat([{
          kind: action.kind || 'info',
          message: action.message || '',
          at: action.at || Date.now(),
        }]);
        return { state: Object.assign({}, state, { alerts: alerts.slice(-20) }), effects: [] };
      }

      case 'OFFER': {
        const offers = (state.offers || []).concat([{ word: action.word || '', ts: action.ts || Date.now() }]);
        return { state: Object.assign({}, state, { offers: offers.slice(-20) }), effects: [] };
      }

      case 'ERROR':
        return { state: Object.assign({}, state, { lastError: action.message || String(action.error || 'error') }), effects: [] };

      /* ------------------------- slice 1a (REQ-26) actions ------------------------- */

      case 'SET_TAB': {
        // Product-shell tab navigation (REQ-26): pure UI, no gate — tabs are
        // navigable before Connect. Unknown tab ids are ignored.
        const tab = String(action.tab || '');
        if (TAB_IDS.indexOf(tab) === -1) return { state, effects: [] };
        return { state: Object.assign({}, state, { tab }), effects: [] };
      }

      case 'SET_LANG': {
        // i18n ES/EN (REQ-26): 'es' or anything else -> 'en' (default EN).
        // The lang-set effect persists the choice (app.js -> localStorage
        // 'mb-panel-lang') so the panel restores the chosen language.
        const lang = action.lang === LANG_ES ? LANG_ES : LANG_EN;
        return { state: Object.assign({}, state, { lang }), effects: [{ type: 'lang-set', lang }] };
      }

      case 'SET_SOUND': {
        // Audit: alert sound toggle — the sound-set effect persists it
        // (app.js -> localStorage 'mb-panel-sound') so the choice survives
        // reloads. Default ON; any non-true value turns the beep off.
        const enabled = action.enabled === true || action.enabled === 'true';
        return { state: Object.assign({}, state, { soundEnabled: enabled }), effects: [{ type: 'sound-set', enabled }] };
      }

      case 'TUTORIAL_START':
        // First-run stepper (REQ-26): show from step 0 (intro). Ignored when
        // already running (the app gate is localStorage 'tutorialSeen').
        if (state.tutorial !== null) return { state, effects: [] };
        return { state: Object.assign({}, state, { tutorial: { step: 0 } }), effects: [] };

      case 'TUTORIAL_NEXT': {
        // Advance one step and walk the tour to the step's tab. Past the last
        // step the tutorial ends with the 'tutorial-seen' effect (app.js
        // persists localStorage so it never shows again).
        if (state.tutorial === null) return { state, effects: [] };
        const nextStep = state.tutorial.step + 1;
        if (nextStep >= TUTORIAL_STEPS.length) {
          return {
            state: Object.assign({}, state, { tutorial: null }),
            effects: [{ type: 'tutorial-seen' }],
          };
        }
        const stepTab = TUTORIAL_STEPS[nextStep].tab;
        return {
          state: Object.assign({}, state, {
            tutorial: { step: nextStep },
            tab: stepTab !== null ? stepTab : state.tab,
          }),
          effects: [],
        };
      }

      case 'TUTORIAL_DISMISS':
        if (state.tutorial === null) return { state, effects: [] };
        return {
          state: Object.assign({}, state, { tutorial: null }),
          effects: [{ type: 'tutorial-seen' }],
        };

      /* --------------------- slice 1b (REQ-27/28) actions --------------------- */

      case 'PROFILES_LOADED':
        // REQ-27: character names with saved configs (from /api/profiles).
        // Sorted so the select is stable across re-renders.
        return {
          state: Object.assign({}, state, {
            profiles: Array.isArray(action.names) ? action.names.slice().sort() : [],
          }),
          effects: [],
        };

      case 'SPELL_CATALOG':
        // REQ-28: catalog filtered by the CURRENT character's vocation +
        // level (server-side). `reason` carries the honest degrade when the
        // in-page RPC was unavailable.
        return {
          state: Object.assign({}, state, {
            catalog: {
              spells: Array.isArray(action.spells) ? action.spells : [],
              loaded: true,
              reason: typeof action.reason === 'string' ? action.reason : null,
            },
          }),
          effects: [],
        };

      case 'PICKER_SET_MODULE': {
        // REQ-28: switch the picker target (heal spell / training spell).
        const module = String(action.module || '');
        if (PICKER_MODULES.indexOf(module) === -1) return { state, effects: [] };
        return {
          state: Object.assign({}, state, {
            picker: Object.assign({}, state.picker || {}, { module }),
          }),
          effects: [],
        };
      }

      case 'PICKER_SEARCH': {
        // REQ-28: pure UI search text — survives re-renders like walkTo.
        const query = String(action.query || '').slice(0, 80);
        return {
          state: Object.assign({}, state, {
            picker: Object.assign({}, state.picker || {}, { query }),
          }),
          effects: [],
        };
      }

      case 'PICK_SPELL': {
        // REQ-28: pick a spell for a module. The list is ALREADY filtered to
        // what the current vocation can cast — a sid outside it is rejected
        // with a vocation reason; a spell whose cost exceeds CURRENT mana is
        // rejected with a mana message. Success writes the sid into the
        // config and pushes it (the server re-checks on save).
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const module = String(action.module || '');
        if (PICKER_MODULES.indexOf(module) === -1) return { state, effects: [] };
        const sid = Number(action.sid);
        if (!Number.isInteger(sid)) return { state, effects: [] };
        const spells = (state.catalog && state.catalog.spells) || [];
        const spell = spells.filter((s) => Number(s.sid) === sid)[0] || null;
        const at = Date.now();
        if (!spell) {
          const label = (state.identity && state.identity.vocationLabel) || 'current vocation';
          return {
            state: Object.assign({}, state, {
              refusal: { action: 'PICK_SPELL', module, reason: 'spell not available for ' + label, at },
            }),
            effects: [],
          };
        }
        const stats = snapshotStats(state.snapshot);
        if (stats.mana !== null && Number.isFinite(Number(spell.mana)) && Number(spell.mana) > stats.mana) {
          return {
            state: Object.assign({}, state, {
              refusal: {
                action: 'PICK_SPELL',
                module,
                reason: 'not enough mana — costs ' + spell.mana + ', you have ' + Math.floor(stats.mana),
                at,
              },
            }),
            effects: [],
          };
        }
        const config = JSON.parse(JSON.stringify(state.config || {}));
        if (!config.modules || typeof config.modules !== 'object') config.modules = {};
        if (!config.modules[module] || typeof config.modules[module] !== 'object') {
          config.modules[module] = {};
        }
        config.modules[module].sid = sid;
        return {
          state: Object.assign({}, state, { config, refusal: null }),
          effects: [{ type: 'push-config' }],
        };
      }

      case 'LOAD_PROFILE': {
        // REQ-27: explicit cross-load of another character's config. The
        // effect executor posts /api/load-profile; the server validates every
        // sid and returns {accepted, rejected:[{key,reason}]}.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const from = String(action.from || '').trim();
        if (!from) return { state, effects: [] };
        return { state, effects: [{ type: 'load-profile', from }] };
      }

      /* ------------------- slice 2 (PR3, REQ-29): HEAL form ------------------- */

      case 'UPDATE_HEAL_INPUT': {
        // REQ-29: pure UI state — the HEAL form values survive re-renders
        // (walkTo precedent). No gate: typing pre-Connect is harmless.
        const key = String(action.key || '');
        if (key !== 'threshold' && key !== 'slot' && key !== 'reserve') return { state, effects: [] };
        const healForm = Object.assign({}, state.healForm || { threshold: '', slot: '', reserve: '' });
        healForm[key] = String(action.value === null || action.value === undefined ? '' : action.value);
        return { state: Object.assign({}, state, { healForm }), effects: [] };
      }

      case 'SAVE_HEAL_SETTINGS': {
        // REQ-29 (PR3): commit the HEAL form into config.modules.healMagic.
        // The threshold is entered as a PERCENT of max health and converted
        // to the ABSOLUTE hp the v1 agent compares (needs the snapshot
        // maxHealth). Slot must be a hotbar slot 1-12; reserve a non-negative
        // mana amount. Invalid values are refused with a visible reason —
        // never silently dropped. The push-config effect carries the change
        // to the agent (REQ-08 applyConfig).
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const form = state.healForm || { threshold: '', slot: '', reserve: '' };
        const at = Date.now();
        const rawThreshold = String(form.threshold || '').trim();
        const rawSlot = String(form.slot || '').trim();
        const rawReserve = String(form.reserve || '').trim();
        if (rawThreshold === '' || rawSlot === '' || rawReserve === '') {
          return {
            state: Object.assign({}, state, {
              refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'healMagic', reason: 'invalid heal settings — threshold, slot and reserve are required', at },
            }),
            effects: [],
          };
        }
        const pct = Number(rawThreshold);
        const slot = Number(rawSlot);
        const reserve = Number(rawReserve);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100
          || !Number.isInteger(slot) || slot < 1 || slot > 12
          || !Number.isFinite(reserve) || reserve < 0) {
          return {
            state: Object.assign({}, state, {
              refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'healMagic', reason: 'invalid heal settings — threshold 0-100%, slot 1-12, reserve >= 0', at },
            }),
            effects: [],
          };
        }
        const maxHp = snapshotStats(state.snapshot).maxHealth;
        if (maxHp === null || !Number.isFinite(maxHp)) {
          return {
            state: Object.assign({}, state, {
              refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'healMagic', reason: 'unknown max health — cannot convert the % threshold; wait for a snapshot', at },
            }),
            effects: [],
          };
        }
        const thresholdAbs = Math.max(0, Math.round(maxHp * pct / 100));
        const config = JSON.parse(JSON.stringify(state.config || {}));
        if (!config.modules || typeof config.modules !== 'object') config.modules = {};
        if (!config.modules.healMagic || typeof config.modules.healMagic !== 'object') config.modules.healMagic = {};
        config.modules.healMagic.threshold = thresholdAbs;
        config.modules.healMagic.slot = slot;
        config.modules.healMagic.reserve = reserve;
        return {
          state: Object.assign({}, state, {
            config,
            healForm: { threshold: String(pct), slot: String(slot), reserve: String(reserve) },
            refusal: null,
          }),
          effects: [{ type: 'push-config' }],
        };
      }

      case 'PROFILE_LOAD_RESULT':
        // REQ-27: cross-load outcome — the visible rejection list renders in
        // the config form (never silent).
        return {
          state: Object.assign({}, state, {
            profileLoad: {
              ok: action.ok === true,
              from: String(action.from || ''),
              rejected: Array.isArray(action.rejected) ? action.rejected : [],
              reason: typeof action.reason === 'string' ? action.reason : null,
              at: Date.now(),
            },
          }),
          effects: [],
        };

      /* ------------------- slice 3 (PR4, REQ-30/31/32): TRAINER form ------------------- */

      case 'UPDATE_TRAINER_INPUT': {
        // REQ-30/31/32: pure UI state — the TRAINER form values survive
        // re-renders (healForm/walkTo precedent). No gate: typing pre-Connect
        // is harmless. Slice B (REQ-44, D-B4): the toggle switches
        // (autoFallback/stopRuneMaking/stopBotting) are form values too.
        const key = String(action.key || '');
        const TRAINER_KEYS = ['capMode', 'capFullThreshold', 'fallbackSlot', 'fallbackManaPct',
          'reserve', 'eatMagic', 'eatMagicSlot',
          'autoFallback', 'stopRuneMaking', 'stopBotting'];
        if (TRAINER_KEYS.indexOf(key) === -1) return { state, effects: [] };
        const trainerForm = Object.assign({}, state.trainerForm || {
          capMode: '', capFullThreshold: '', fallbackSlot: '', fallbackManaPct: '',
          reserve: '', eatMagic: '', eatMagicSlot: '',
        });
        trainerForm[key] = String(action.value === null || action.value === undefined ? '' : action.value);
        return { state: Object.assign({}, state, { trainerForm }), effects: [] };
      }

      case 'SAVE_TRAINER_SETTINGS': {
        // REQ-30/31/32 (PR4) + Slice B (REQ-42..46): commit the TRAINER form
        // into the config (see commitTrainerSettings). Slice B (REQ-45,
        // D-B6): Stop Botting Entirely is a DESTRUCTIVE action — the first
        // save with stopBotting on only ARMS the confirm overlay (no commit,
        // no push); the overlay's Yes dispatches CONFIRM_STOP which commits.
        // The form is validated up front so a refusal never opens the dialog.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const form = state.trainerForm || {};
        const probe = commitTrainerSettings(state, form);
        if (!probe.ok) return { state: Object.assign({}, state, { refusal: probe.refusal }), effects: [] };
        if (String(form.stopBotting || '') === 'true' && !(state.confirmStop && state.confirmStop.pending)) {
          return {
            state: Object.assign({}, state, { confirmStop: { pending: true, at: Date.now() }, refusal: null }),
            effects: [],
          };
        }
        return { state: Object.assign({}, probe.state, { confirmStop: null }), effects: probe.effects };
      }

      case 'CONFIRM_STOP': {
        // REQ-45 (D-B6): the confirm overlay's Yes — commits the pending
        // trainer save with stopBotting honored (rune-making off; heal/eat
        // continue). No-op when no confirmation is pending.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        if (!(state.confirmStop && state.confirmStop.pending)) return { state, effects: [] };
        const result = commitTrainerSettings(state, state.trainerForm || {});
        if (!result.ok) {
          return { state: Object.assign({}, state, { refusal: result.refusal, confirmStop: null }), effects: [] };
        }
        return { state: Object.assign({}, result.state, { confirmStop: null }), effects: result.effects };
      }

      case 'CANCEL_STOP': {
        // REQ-45 (D-B6): the confirm overlay's No — drop the pending
        // confirmation; nothing is saved or pushed.
        return { state: Object.assign({}, state, { confirmStop: null }), effects: [] };
      }

      /* ------------------- slice 5 (PR5, REQ-33/34): OTHERS form ------------------- */

      case 'UPDATE_OTHERS_INPUT': {
        // REQ-33/34: pure UI state — the OTHERS form values survive re-renders
        // (healForm/trainerForm precedent). No gate: typing pre-Connect is
        // harmless.
        const key = String(action.key || '');
        const OTHERS_KEYS = ['foodSlot', 'everyCasts', 'lootDest', 'antibotReplies'];
        if (OTHERS_KEYS.indexOf(key) === -1) return { state, effects: [] };
        const othersForm = Object.assign({}, state.othersForm || {
          foodSlot: '', everyCasts: '', lootDest: '', antibotReplies: '',
        });
        othersForm[key] = String(action.value === null || action.value === undefined ? '' : action.value);
        return { state: Object.assign({}, state, { othersForm }), effects: [] };
      }

      case 'SAVE_OTHERS_SETTINGS': {
        // REQ-33/34 (PR5): commit the OTHERS form into the config: the food
        // slot + every-N-casts cadence (eat module, REQ-17 unchanged), the
        // auto-loot default destination (REQ-33 — auto-loot fires ONLY with a
        // configured list; per-monster entries stay managed elsewhere), and
        // the anti-bot `pattern => reply` list (REQ-34 confirm-once config).
        // Invalid values are refused with a visible reason — never silently
        // dropped. The push-config effect carries the change to the agent.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const form = state.othersForm || {};
        const at = Date.now();
        const invalid = (reason) => ({
          state: Object.assign({}, state, { refusal: { action: 'SAVE_OTHERS_SETTINGS', module: 'others', reason, at } }),
          effects: [],
        });
        const rawSlot = String(form.foodSlot || '').trim();
        const rawCasts = String(form.everyCasts || '').trim();
        const rawDest = String(form.lootDest || '').trim();
        const rawReplies = String(form.antibotReplies || '');
        const foodSlot = rawSlot === '' ? null : Number(rawSlot);
        if (foodSlot !== null && (!Number.isInteger(foodSlot) || foodSlot < 1)) {
          return invalid('invalid other settings — food slot must be a positive backpack index or empty');
        }
        const everyCasts = rawCasts === '' ? 0 : Number(rawCasts);
        if (!Number.isFinite(everyCasts) || everyCasts < 0) {
          return invalid('invalid other settings — eat every N casts must be >= 0');
        }
        const parsed = parseRepliesText(rawReplies);
        if (parsed.error) {
          return invalid('invalid anti-bot replies — ' + parsed.error);
        }
        const config = JSON.parse(JSON.stringify(state.config || {}));
        if (!config.modules || typeof config.modules !== 'object') config.modules = {};
        if (!config.modules.eat || typeof config.modules.eat !== 'object') config.modules.eat = {};
        if (!config.modules.loot || typeof config.modules.loot !== 'object') config.modules.loot = {};
        if (!config.modules.antibot || typeof config.modules.antibot !== 'object') config.modules.antibot = {};
        config.modules.eat.slot = foodSlot;
        config.modules.eat.everyCasts = everyCasts;
        config.modules.loot.defaultDest = rawDest === '' ? null : rawDest;
        config.modules.antibot.replies = parsed.entries;
        return {
          state: Object.assign({}, state, {
            config,
            othersForm: {
              foodSlot: foodSlot === null ? '' : String(foodSlot),
              everyCasts: String(everyCasts),
              lootDest: rawDest,
              antibotReplies: rawReplies,
            },
            refusal: null,
          }),
          effects: [{ type: 'push-config' }],
        };
      }

      case 'CONFIRM_ANTIBOT': {
        // REQ-34 (PR5): user confirmation on the pending anti-bot pattern —
        // the effect posts /api/antibot-confirm (server persists per
        // character + RPCs the agent confirmAntibot, enabling auto-replies).
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const pattern = String(action.pattern || '').trim();
        if (!pattern) return { state, effects: [] };
        return { state, effects: [{ type: 'antibot-confirm', pattern }] };
      }

      case 'RUNECHECK_RESUME': {
        // REQ-41 (PR A, D-A4): manual resume of a paused rune check — the
        // effect posts /api/runecheck-resume (server -> agent resumeRuneCheck
        // RPC: queue unpause + state clear). Armed-gated like every RPC.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        return { state, effects: [{ type: 'runecheck-resume' }] };
      }

      case 'RESET':
        return { state: reset(), effects: [] };

      /* ------------------- slice 7 (PR6, REQ-35/36): skeletons ------------------- */

      case 'UPDATE_ATTACK_INPUT': {
        // REQ-35: pure UI state — the ATTACK form values survive re-renders
        // (healForm/trainerForm precedent). No gate: typing pre-Connect is
        // harmless.
        const key = String(action.key || '');
        if (key !== 'targeting' && key !== 'runeSlot') return { state, effects: [] };
        const attackForm = Object.assign({}, state.attackForm || { targeting: '', runeSlot: '' });
        attackForm[key] = String(action.value === null || action.value === undefined ? '' : action.value);
        return { state: Object.assign({}, state, { attackForm }), effects: [] };
      }

      case 'SAVE_ATTACK_SETTINGS': {
        // REQ-35 (PR6): commit the ATTACK form into config.modules.attack —
        // the targeting choice (lowest-hp/nearest) + the offensive rune
        // slot; the offensive SPELL sid comes from the picker (PICK_SPELL).
        // Invalid values are refused with a visible reason — never silently
        // dropped. The push-config effect carries the change to the agent.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const form = state.attackForm || {};
        const at = Date.now();
        const rawTargeting = String(form.targeting || '').trim() || 'lowest-hp';
        const rawSlot = String(form.runeSlot || '').trim();
        if (rawTargeting !== 'lowest-hp' && rawTargeting !== 'nearest') {
          return {
            state: Object.assign({}, state, {
              refusal: { action: 'SAVE_ATTACK_SETTINGS', module: 'attack', reason: 'invalid attack settings — targeting must be lowest-hp or nearest', at },
            }),
            effects: [],
          };
        }
        const runeSlot = rawSlot === '' ? null : Number(rawSlot);
        if (runeSlot !== null && (!Number.isInteger(runeSlot) || runeSlot < 1 || runeSlot > 12)) {
          return {
            state: Object.assign({}, state, {
              refusal: { action: 'SAVE_ATTACK_SETTINGS', module: 'attack', reason: 'invalid attack settings — rune slot must be 1-12 or empty', at },
            }),
            effects: [],
          };
        }
        const config = JSON.parse(JSON.stringify(state.config || {}));
        if (!config.modules || typeof config.modules !== 'object') config.modules = {};
        if (!config.modules.attack || typeof config.modules.attack !== 'object') config.modules.attack = {};
        config.modules.attack.targeting = rawTargeting;
        config.modules.attack.runeSlot = runeSlot;
        return {
          state: Object.assign({}, state, {
            config,
            attackForm: { targeting: rawTargeting, runeSlot: runeSlot === null ? '' : String(runeSlot) },
            refusal: null,
          }),
          effects: [{ type: 'push-config' }],
        };
      }

      case 'CAVEBOT_COMMAND': {
        // REQ-36 (PR6): cavebot skeleton controls — armed-gated like every
        // action. 'record'/'stop'/'start' emit the cavebot-command effect
        // (server -> in-page RPC); 'save' writes the LAST stopped recording
        // into config.routes (REQ-36 "save = config.routes") and pushes;
        // 'pause'/'resume' toggle config.modules.cavebot.paused and push.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const command = String(action.command || '');
        if (command === 'record' || command === 'start') {
          return {
            state,
            effects: [{ type: 'cavebot-command', command: command === 'record' ? 'record-start' : 'start' }],
          };
        }
        if (command === 'stop') {
          return { state, effects: [{ type: 'cavebot-command', command: 'record-stop' }] };
        }
        if (command === 'save') {
          const recorded = state.cavebotRecorded;
          if (!recorded || !Array.isArray(recorded.points) || recorded.points.length === 0) {
            return { state, effects: [] }; // nothing recorded yet — no-op
          }
          const config = JSON.parse(JSON.stringify(state.config || {}));
          config.routes = recorded.points;
          return { state: Object.assign({}, state, { config }), effects: [{ type: 'push-config' }] };
        }
        if (command === 'pause' || command === 'resume') {
          const config = JSON.parse(JSON.stringify(state.config || {}));
          if (!config.modules || typeof config.modules !== 'object') config.modules = {};
          if (!config.modules.cavebot || typeof config.modules.cavebot !== 'object') config.modules.cavebot = {};
          config.modules.cavebot.paused = command === 'pause';
          return { state: Object.assign({}, state, { config }), effects: [{ type: 'push-config' }] };
        }
        return { state, effects: [] };
      }

      case 'CAVEBOT_RECORDED':
        // REQ-36 (PR6): the record-stop RPC result — the recorded waypoints
        // land here so the Save action can write config.routes.
        return {
          state: Object.assign({}, state, {
            cavebotRecorded: {
              points: Array.isArray(action.points) ? action.points : [],
              at: Date.now(),
            },
          }),
          effects: [],
        };

      default:
        return { state, effects: [] };
    }
  }

  function reset() {
    return createInitialState();
  }

  /** Dispatch helper: applies the reducer and returns the new state. */
  function dispatch(state, action) {
    const result = panelReducer(state, action);
    return result;
  }

  /** Human label for the gate state (status bar). */
  function gateLabel(state) {
    switch (state.gate) {
      case GATE_DISCONNECTED: return 'Disconnected';
      case GATE_PROBING: return 'Waiting for game…';
      case GATE_CONFIRMED: return 'Confirming connection';
      case GATE_ARMED: return 'Connected';
      default: return state.gate;
    }
  }

  /* ------------------------------ slice 5 helpers ------------------------------ */

  /**
   * REQ-22: gated modules whose snapshot state reports premium-blocked
   * ("Premium required"). Reads the live snapshot payload (agent state
   * modules). Pure.
   * @param {object|null} snapshot - /api/snapshot payload (SNAPSHOT action data)
   * @returns {Array<{id: string, label: string}>}
   */
  function premiumBlockedModules(snapshot) {
    const gated = { trade: 'Auto trade broadcast', loot: 'Auto-loot', spawns: 'Spawn maps', huntStats: 'Hunt stats' };
    const out = [];
    const modules = snapshot && snapshot.agent && snapshot.agent.modules;
    if (!modules || typeof modules !== 'object') return out;
    for (const id of Object.keys(gated)) {
      const m = modules[id];
      if (m && m.premium && m.premium.blocked === true) {
        out.push({ id, label: gated[id] });
      }
    }
    return out;
  }

  /**
   * REQ-25: open learning offers carried by the live snapshot (agent state
   * modules.learning.offers). Pure.
   * @param {object|null} snapshot - SNAPSHOT payload
   * @returns {Array<{word: string, ts: number, sid: number|null}>}
   */
  function snapshotOffers(snapshot) {
    const offers = snapshot && snapshot.agent && snapshot.agent.modules
      && snapshot.agent.modules.learning && snapshot.agent.modules.learning.offers;
    return Array.isArray(offers) ? offers : [];
  }

  /**
   * PR5 (REQ-33/34): anti-bot module state carried by the live snapshot
   * (agent state modules.antibot). Pure — null when absent.
   * @param {object|null} snapshot - SNAPSHOT payload
   * @returns {object|null}
   */
  function snapshotAntibot(snapshot) {
    const m = snapshot && snapshot.agent && snapshot.agent.modules
      && snapshot.agent.modules.antibot;
    return m && typeof m === 'object' ? m : null;
  }

  /**
   * PR6 (REQ-36): cavebot module state carried by the live snapshot (agent
   * state modules.cavebot). Pure — null when absent.
   * @param {object|null} snapshot - SNAPSHOT payload
   * @returns {object|null}
   */
  function snapshotCavebot(snapshot) {
    const m = snapshot && snapshot.agent && snapshot.agent.modules
      && snapshot.agent.modules.cavebot;
    return m && typeof m === 'object' ? m : null;
  }
  /** PR5 (REQ-33): one readable anti-bot alert row (never raw JSON). */
  function renderAntibotAlert(alert, state) {
    const kindLabel = alert && alert.kind === 'speak' ? t(state, 'others.alertSpeak')
      : alert && alert.kind === 'moved' ? t(state, 'others.alertMoved')
        : alert && alert.kind === 'attacked' ? t(state, 'others.alertAttacked')
          : String((alert && alert.kind) || 'event');
    const when = alert && Number.isFinite(Number(alert.at))
      ? new Date(Number(alert.at)).toLocaleTimeString() : '--:--:--';
    return '<div class="antibot-alert" data-antibot-alert="' + (alert && alert.id !== undefined ? alert.id : '') + '">'
      + '<span class="antibot-alert-kind">' + escapeHtml(kindLabel) + '</span>'
      + ' <span class="antibot-alert-time">' + escapeHtml(when) + '</span>'
      + ' <span class="antibot-alert-message">' + escapeHtml(String((alert && alert.message) || '')) + '</span>'
      + '</div>';
  }

  /** REQ-25: offer row HTML (word + time + best-effort sid + localized
   *  Confirm/Decline buttons). `state` optional — falls back to EN when absent
   *  (kept backward-compatible for the exported pure call). */
  function renderOffer(offer, state) {
    const when = offer.ts
      ? new Date(offer.ts).toLocaleTimeString() + ' ' + new Date(offer.ts).toLocaleDateString()
      : 'now';
    const sid = Number.isInteger(offer.sid) ? offer.sid : null;
    return '<div class="learning-offer">'
      + '<code>' + escapeHtml(offer.word) + '</code>'
      + ' <span class="offer-time">(' + escapeHtml(when) + (sid !== null ? ', sid ' + sid : '') + ')</span>'
      + ' <button type="button" class="offer-btn" data-offer-action="confirm" data-word="' + escapeHtml(offer.word) + '">'
      + escapeHtml(t(state, 'offers.confirm')) + '</button>'
      + ' <button type="button" class="offer-btn" data-offer-action="decline" data-word="' + escapeHtml(offer.word) + '">'
      + escapeHtml(t(state, 'offers.decline')) + '</button>'
      + '</div>';
  }

  /* ------------------------------ render ------------------------------ */

  /** Status bar: gate state, confirmed player, refusal/error, i18n switcher,
   *  controls (REQ-26: labels follow state.lang; default EN). */
  function renderStatusBar(state) {
    const parts = [];
    parts.push('<span class="gate gate-' + state.gate + '">' + escapeHtml(t(state, 'gate.' + state.gate)) + '</span>');
    if (state.identity) {
      parts.push('<span class="player">' + escapeHtml(state.identity.name)
        + ' <em>(' + escapeHtml(state.identity.vocationLabel || '?') + ')</em></span>');
    }
    if (state.gate === GATE_CONFIRMED) {
      parts.push('<button type="button" id="connect-btn">' + escapeHtml(t(state, 'connect')) + '</button>');
      parts.push('<button type="button" id="cancel-btn">' + escapeHtml(t(state, 'cancel')) + '</button>');
    }
    if (state.gate === GATE_ARMED) {
      parts.push('<button type="button" id="disconnect-btn">' + escapeHtml(t(state, 'disconnect')) + '</button>');
    }
    if (state.refusal) {
      parts.push('<span class="refusal">' + escapeHtml(tVar(state, 'refused', { reason: state.refusal.reason })) + '</span>');
    }
    if (state.lastError) {
      parts.push('<span class="error">' + escapeHtml(state.lastError) + '</span>');
    }
    // REQ-26 i18n switcher (ES/EN).
    parts.push('<span class="lang-switch" role="group" aria-label="' + escapeHtml(t(state, 'language')) + '">'
      + '<button type="button" class="lang-btn' + (state.lang === LANG_EN ? ' active' : '') + '" data-lang="en">EN</button>'
      + '<button type="button" class="lang-btn' + (state.lang === LANG_ES ? ' active' : '') + '" data-lang="es">ES</button>'
      + '</span>');
    // Audit: alert sound toggle — checked = beep on ALERT (default ON); the
    // reducer persists the choice (localStorage 'mb-panel-sound').
    parts.push('<label class="sound-toggle"><input type="checkbox" id="sound-toggle"'
      + (state.soundEnabled !== false ? ' checked' : '') + '> '
      + escapeHtml(t(state, 'sound.enabled')) + '</label>');
    return '<div class="status-bar">' + parts.join(' ') + '</div>';
  }

  /**
   * Tabbed module list (REQ-26, design D7): 5 tab buttons (HEAL/ATTACK/
   * TRAINER/CAVEBOT/OTHERS) + one panel per tab holding that tab's module
   * toggles. ALL panels render in the DOM (the active one is visible via the
   * `hidden` attribute) — the reducer keeps every toggle state live, and
   * tab switching is pure CSS/attribute work. Skeleton tabs (ATTACK/CAVEBOT)
   * reserve their space and disclose "skeleton — limited".
   */
  function renderModuleList(state) {
    const nav = '<div class="tab-nav" role="tablist">'
      + TABS.map((tab) => {
        const active = state.tab === tab.id ? ' active' : '';
        return '<button type="button" class="tab-btn' + active + '" role="tab" data-tab="' + tab.id + '"'
          + ' aria-selected="' + (state.tab === tab.id ? 'true' : 'false') + '">'
          + escapeHtml(t(state, 'tab.' + tab.id)) + '</button>';
      }).join('')
      + '</div>';

    const panels = TABS.map((tab) => {
      const hidden = state.tab === tab.id ? '' : ' hidden';
      const defs = MODULE_BY_TAB[tab.id] || [];
      let body;
      if (defs.length === 0) {
        body = '<div class="tab-empty">' + escapeHtml(t(state, 'skeleton.note')) + '</div>';
      } else {
        body = defs.map((def) => {
          const checked = state.modules[def.id] === true;
          const disabled = state.gate !== GATE_ARMED ? ' disabled' : '';
          return '<label class="module-toggle"><input type="checkbox" data-module="' + def.id + '"'
            + (checked ? ' checked' : '') + disabled + '> ' + escapeHtml(moduleLabel(state, def)) + '</label>';
        }).join('');
        // PR6 (REQ-35/36): skeleton tabs keep the "skeleton — limited"
        // disclosure visible under their toggles.
        if (tab.skeleton) {
          body += '<div class="tab-skeleton">' + escapeHtml(t(state, 'skeleton.note')) + '</div>';
        }
      }
      return '<section class="tab-panel" data-tab-panel="' + tab.id + '" role="tabpanel"' + hidden + '>'
        + body + '</section>';
    }).join('');

    return '<div class="module-list">' + nav + panels + '</div>';
  }

  /**
   * Profile cross-loader (design D6, REQ-27): select of every OTHER
   * character with a saved config + "Load config" button. The last load
   * result renders its rejection list — incompatible entries are NEVER
   * silent (the user sees exactly which sid was refused and why).
   * @param {object} state
   * @returns {string}
   */
  function renderProfileLoader(state) {
    const parts = ['<div class="profile-loader">', '<h3>' + escapeHtml(t(state, 'profile.title')) + '</h3>'];
    const current = state.identity && state.identity.name ? state.identity.name : null;
    const others = (state.profiles || []).filter((n) => n !== current);
    if (others.length === 0) {
      parts.push('<p class="profile-none">' + escapeHtml(t(state, 'profile.none')) + '</p>');
    } else {
      const opts = others
        .map((n) => '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>')
        .join('');
      parts.push('<label class="profile-select-wrap">' + escapeHtml(t(state, 'profile.loadFrom'))
        + ' <select id="profile-select">' + opts + '</select>'
        + ' <button type="button" id="profile-load-btn">' + escapeHtml(t(state, 'profile.loadBtn')) + '</button>'
        + '</label>');
    }
    const pl = state.profileLoad;
    if (pl) {
      if (pl.ok && pl.rejected.length === 0) {
        parts.push('<p class="profile-result ok">' + escapeHtml(tVar(state, 'profile.loadedAll', { from: pl.from })) + '</p>');
      } else if (pl.ok) {
        parts.push('<p class="profile-result">' + escapeHtml(tVar(state, 'profile.loadedRejected', { from: pl.from })) + '</p>');
        parts.push('<ul class="profile-rejected">'
          + pl.rejected.map((r) => '<li><code>' + escapeHtml(String(r.key || '')) + '</code> — '
            + escapeHtml(String(r.reason || '')) + '</li>').join('')
          + '</ul>');
      } else {
        parts.push('<p class="profile-result error">'
          + escapeHtml(tVar(state, 'profile.failed', { from: pl.from, reason: pl.reason || '' })) + '</p>');
      }
    }
    parts.push('</div>');
    return parts.join('');
  }

  /**
   * Spell picker (design D5, REQ-28): lists ONLY spells the current
   * character can cast (the server filtered the catalog by vocation label +
   * level) with a search box and a Pick action per row. Picking validates
   * mana client-side (reducer PICK_SPELL); the server re-checks on save.
   * @param {object} state
   * @returns {string}
   */
  function renderSpellPicker(state) {
    const p = state.picker || { module: 'healMagic', query: '' };
    const catalog = state.catalog || { spells: [], loaded: false };
    const parts = ['<div class="spell-picker">', '<h3>' + escapeHtml(t(state, 'picker.title')) + '</h3>'];
    if (!catalog.loaded) {
      parts.push('<p class="picker-empty">' + escapeHtml(t(state, 'picker.empty')) + '</p>');
      parts.push('</div>');
      return parts.join('');
    }
    if (catalog.reason) {
      parts.push('<p class="picker-empty">' + escapeHtml(catalog.reason) + '</p>');
      parts.push('</div>');
      return parts.join('');
    }
    parts.push('<div class="picker-modules" role="group">'
      + PICKER_MODULES.map((m) => '<button type="button" class="picker-module-btn'
        + (p.module === m ? ' active' : '') + '" data-picker-module-btn="' + m + '">'
        + escapeHtml(t(state, 'picker.module.' + m)) + '</button>').join('')
      + '</div>');
    parts.push('<label class="picker-search">' + escapeHtml(t(state, 'picker.search'))
      + ' <input type="search" id="spell-search" value="' + escapeHtml(p.query || '') + '"></label>');
    const q = String(p.query || '').toLowerCase();
    const spells = (catalog.spells || []).filter((s) => !q
      || String(s.name || '').toLowerCase().indexOf(q) !== -1
      || String(s.words || '').toLowerCase().indexOf(q) !== -1);
    const currentSid = state.config && state.config.modules && state.config.modules[p.module]
      ? state.config.modules[p.module].sid
      : null;
    if (spells.length === 0) {
      parts.push('<p class="picker-none">' + escapeHtml(t(state, 'picker.none')) + '</p>');
    } else {
      parts.push('<ul class="picker-list">'
        + spells.slice(0, 60).map((s) => {
          const isCurrent = Number(currentSid) === Number(s.sid);
          return '<li class="picker-row' + (isCurrent ? ' current' : '') + '">'
            + '<span class="picker-name">' + escapeHtml(String(s.name || '')) + '</span>'
            + '<span class="picker-meta">' + escapeHtml(tVar(state, 'picker.meta', { mana: s.mana, level: s.level })) + '</span>'
            + (s.words ? '<span class="picker-words">' + escapeHtml(s.words) + '</span>' : '')
            + '<button type="button" class="picker-pick" data-pick-spell="' + Number(s.sid)
            + '" data-picker-module="' + p.module + '">' + escapeHtml(t(state, 'picker.pick')) + '</button>'
            + (isCurrent ? '<span class="picker-current">' + escapeHtml(t(state, 'picker.current')) + '</span>' : '')
            + '</li>';
        }).join('')
        + '</ul>');
    }
    parts.push('</div>');
    return parts.join('');
  }

  /**
   * HEAL settings form (PR3, REQ-29): threshold %, hotbar slot and mana
   * reserve + a Save button. Values come from the pure-UI healForm state
   * (survive re-renders) falling back to the saved config (percent view of
   * the absolute threshold via snapshot maxHealth). The spell itself is
   * chosen with the spell picker below (REQ-28); the module toggle lives in
   * the HEAL tab module list. The agent compares health against the SAVED
   * absolute threshold — the form converts percent <-> absolute here.
   * @param {object} state
   * @returns {string}
   */
  function renderHealForm(state) {
    const form = state.healForm || { threshold: '', slot: '', reserve: '' };
    const derived = healFormFromConfig(state);
    const val = (key) => (form[key] !== '' ? form[key] : derived[key]);
    return '<div class="heal-form">'
      + '<h3>' + escapeHtml(t(state, 'heal.formTitle')) + '</h3>'
      + '<label class="heal-field">' + escapeHtml(t(state, 'heal.threshold'))
      + ' <input type="number" id="heal-threshold" min="0" max="100" step="1" value="' + escapeHtml(val('threshold')) + '"></label>'
      + '<label class="heal-field">' + escapeHtml(t(state, 'heal.slot'))
      + ' <input type="number" id="heal-slot" min="1" max="12" step="1" value="' + escapeHtml(val('slot')) + '"></label>'
      + '<label class="heal-field">' + escapeHtml(t(state, 'heal.reserve'))
      + ' <input type="number" id="heal-reserve" min="0" step="1" value="' + escapeHtml(val('reserve')) + '"></label>'
      + '<button type="button" id="heal-save-btn">' + escapeHtml(t(state, 'heal.save')) + '</button>'
      + '</div>';
  }

  /**
   * TRAINER settings form — Slice B 2-col redesign (REQ-42..46, D-B1..B6).
   * Left RUNE-MAKING: inline rune select (catalog filtered /rune/i, D-B2),
   * Cast Logic "If Mana >= cost + [reserve]", Rune Hotkey F4 + Assign (D-B3),
   * the Fallback Magic block (slot + mana % + Fallback Hotkey F5) and the
   * legacy eat-with-magic fields. Right CAPACITY & ALERTS: CURRENT CAP bar
   * (REQ-43, D-B5), "When CAP is Full" select, the Sound Alert / Auto
   * Fallback Magic / Stop Rune-Making / Stop Botting Entirely toggles (D-B4)
   * and Save bottom-right.
   * Values come from the pure-UI trainerForm state (survive re-renders)
   * falling back to the saved config (ratios shown as percent). KEPT element
   * ids: trainer-cap-mode, trainer-cap-threshold, trainer-fallback-slot,
   * trainer-fallback-pct, trainer-reserve, trainer-eat-magic,
   * trainer-eat-magic-slot, trainer-save-btn (rollback: revert to the
   * string-concat form).
   * @param {object} state
   * @returns {string}
   */
  function renderTrainerForm(state) {
    const form = state.trainerForm || {};
    const derived = trainerFormFromConfig(state);
    const val = (key) => (form[key] !== '' && form[key] !== undefined ? form[key] : derived[key]);
    const capMode = val('capMode');
    const eatChecked = val('eatMagic') === 'true' ? ' checked' : '';
    const autoFallback = val('autoFallback') === 'true';
    const stopRuneMaking = val('stopRuneMaking') === 'true';
    const stopBotting = val('stopBotting') === 'true';
    const soundOn = state.soundEnabled !== false;
    const hotkeysAvailable = !(state.hotkeys && state.hotkeys.available === false);
    const fkeySelect = (id, key) => '<select id="' + id + '"' + (hotkeysAvailable ? '' : ' disabled') + '>'
      + FKEYS.map((k) => '<option value="' + k + '"' + (val(key) === k ? ' selected' : '') + '>' + k + '</option>').join('')
      + '</select>';
    const assignBtn = (id) => '<button type="button" id="' + id + '"' + (hotkeysAvailable ? '' : ' disabled') + '>'
      + escapeHtml(t(state, 'trainer.assignBtn')) + '</button>';
    // Bars (REQ-43, D-B5): mana from snapshotStats, CAP from the training
    // module snapshot. Missing data degrades to '—' (never invented numbers).
    const stats = snapshotStats(state.snapshot);
    const manaPct = (stats.mana !== null && stats.maxMana !== null && stats.maxMana > 0)
      ? Math.round(stats.mana / stats.maxMana * 100) : null;
    const manaBar = renderBar(state, 'mana-bar', 'mana', 'trainer.manaBar', stats.mana, stats.maxMana, manaPct);
    const cap = snapshotCap(state.snapshot);
    const capPct = cap && cap.ratio !== null ? Math.round(Math.max(0, Math.min(1, cap.ratio)) * 100) : null;
    const capBar = renderBar(state, 'cap-bar', 'cap', 'trainer.capBar',
      cap ? cap.capacity : null, cap ? cap.maxCapacity : null, capPct);
    // Inline rune select (REQ-42, D-B2): rune spells only, full-list fallback.
    const rune = filterRuneCatalog(state);
    const currentSid = val('runeSid');
    const runeOpts = rune.list.map((s) => {
      const sid = String(Number(s.sid));
      return '<option value="' + sid + '"' + (currentSid === sid ? ' selected' : '') + '>'
        + escapeHtml(String(s.name || '')) + (s.words ? ' — ' + escapeHtml(String(s.words)) : '') + '</option>';
    }).join('');
    const runeSelect = '<select id="trainer-rune-select">'
      + (rune.list.length === 0 ? '<option value="">' + escapeHtml(t(state, 'picker.none')) + '</option>' : runeOpts)
      + '</select>';
    const runeFallbackNote = rune.fallback
      ? '<p class="trainer-note">' + escapeHtml(t(state, 'trainer.runeSelectFallback')) + '</p>' : '';
    const hotkeyNote = hotkeysAvailable ? '' : '<p class="trainer-hotkey-note">'
      + escapeHtml(t(state, 'trainer.hotkeyUnavailable')) + '</p>';
    const stopNote = stopBotting
      ? '<div class="module-alert alert-stop-botting">' + escapeHtml(t(state, 'trainer.stopBottingActive')) + '</div>' : '';
    return '<div class="trainer-form">'
      + '<h3>' + escapeHtml(t(state, 'trainer.formTitle')) + '</h3>'
      + stopNote
      + '<div class="trainer-grid">'
      // Left column — RUNE-MAKING.
      + '<div class="trainer-col">'
      + '<h4>' + escapeHtml(t(state, 'trainer.runeMakingTitle')) + '</h4>'
      + manaBar
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.runeSelect'))
      + ' ' + runeSelect + '</label>'
      + runeFallbackNote
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.castLogic'))
      + ' <input type="number" id="trainer-reserve" min="0" step="1" value="' + escapeHtml(val('reserve')) + '"></label>'
      + '<div class="trainer-hotkey-row">'
      + '<span class="trainer-field-label">' + escapeHtml(t(state, 'trainer.runeHotkey')) + '</span>'
      + fkeySelect('trainer-rune-key', 'runeKey') + assignBtn('trainer-rune-assign')
      + '</div>'
      + '<h4 class="trainer-sub">' + escapeHtml(t(state, 'trainer.fallbackMagic')) + '</h4>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.fallbackSlot'))
      + ' <input type="number" id="trainer-fallback-slot" min="1" max="12" step="1" value="' + escapeHtml(val('fallbackSlot')) + '"></label>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.fallbackManaPct'))
      + ' <input type="number" id="trainer-fallback-pct" min="0" max="100" step="1" value="' + escapeHtml(val('fallbackManaPct')) + '"></label>'
      + '<div class="trainer-hotkey-row">'
      + '<span class="trainer-field-label">' + escapeHtml(t(state, 'trainer.fallbackHotkey')) + '</span>'
      + fkeySelect('trainer-fallback-key', 'fallbackKey') + assignBtn('trainer-fallback-assign')
      + '</div>'
      + '<label class="trainer-field trainer-check">'
      + '<input type="checkbox" id="trainer-eat-magic"' + eatChecked + '> '
      + escapeHtml(t(state, 'trainer.eatWithMagic')) + '</label>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.eatMagicSlot'))
      + ' <input type="number" id="trainer-eat-magic-slot" min="1" max="12" step="1" value="' + escapeHtml(val('eatMagicSlot')) + '"></label>'
      + hotkeyNote
      + '</div>'
      // Right column — CAPACITY & ALERTS.
      + '<div class="trainer-col">'
      + '<h4>' + escapeHtml(t(state, 'trainer.capacityTitle')) + '</h4>'
      + capBar
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.whenCapFull'))
      + ' <select id="trainer-cap-mode">'
      + '<option value="strict"' + (capMode === 'strict' ? ' selected' : '') + '>'
      + escapeHtml(t(state, 'trainer.capModeStrict')) + '</option>'
      + '<option value="off"' + (capMode === 'off' ? ' selected' : '') + '>'
      + escapeHtml(t(state, 'trainer.capModeOff')) + '</option>'
      + '</select></label>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.capFullThreshold'))
      + ' <input type="number" id="trainer-cap-threshold" min="0" max="100" step="1" value="' + escapeHtml(val('capFullThreshold')) + '"></label>'
      + '<div class="trainer-toggles">'
      + '<label class="trainer-field trainer-check">'
      + '<input type="checkbox" id="trainer-sound-alert"' + (soundOn ? ' checked' : '') + '> '
      + escapeHtml(t(state, 'trainer.soundAlert')) + '</label>'
      + '<label class="trainer-field trainer-check">'
      + '<input type="checkbox" id="trainer-auto-fallback"' + (autoFallback ? ' checked' : '') + '> '
      + escapeHtml(t(state, 'trainer.autoFallbackMagic')) + '</label>'
      + '<label class="trainer-field trainer-check">'
      + '<input type="checkbox" id="trainer-stop-runes"' + (stopRuneMaking ? ' checked' : '') + '> '
      + escapeHtml(t(state, 'trainer.stopRuneMaking')) + '</label>'
      + '<label class="trainer-field trainer-check">'
      + '<input type="checkbox" id="trainer-stop-botting"' + (stopBotting ? ' checked' : '') + '> '
      + escapeHtml(t(state, 'trainer.stopBotting')) + '</label>'
      + '</div>'
      + '<button type="button" id="trainer-save-btn" class="trainer-save">'
      + escapeHtml(t(state, 'trainer.save')) + '</button>'
      + '</div>'
      + '</div>'
      + '</div>';
  }

  /**
   * OTHERS settings form (PR5, REQ-33/34): food (slot + every-N-casts), the
   * auto-loot default destination (auto-loot fires ONLY with a configured
   * list — REQ-33) and the anti-bot `pattern => reply` list (confirm-once
   * config, REQ-34). Values come from the pure-UI othersForm state (survive
   * re-renders) falling back to the saved config. The module toggles live in
   * the OTHERS tab module list.
   * @param {object} state
   * @returns {string}
   */
  function renderOthersForm(state) {
    const form = state.othersForm || {};
    const derived = othersFormFromConfig(state);
    const val = (key) => (form[key] !== '' && form[key] !== undefined ? form[key] : derived[key]);
    return '<div class="others-form">'
      + '<h3>' + escapeHtml(t(state, 'others.formTitle')) + '</h3>'
      + '<h4>' + escapeHtml(t(state, 'others.foodTitle')) + '</h4>'
      + '<label class="others-field">' + escapeHtml(t(state, 'others.foodSlot'))
      + ' <input type="number" id="others-food-slot" min="1" step="1" value="' + escapeHtml(val('foodSlot')) + '"></label>'
      + '<label class="others-field">' + escapeHtml(t(state, 'others.everyCasts'))
      + ' <input type="number" id="others-every-casts" min="0" step="1" value="' + escapeHtml(val('everyCasts')) + '"></label>'
      + '<h4>' + escapeHtml(t(state, 'others.lootTitle')) + '</h4>'
      + '<label class="others-field">' + escapeHtml(t(state, 'others.lootDest'))
      + ' <input type="text" id="others-loot-dest" value="' + escapeHtml(val('lootDest')) + '"></label>'
      + '<h4>' + escapeHtml(t(state, 'others.antibotTitle')) + '</h4>'
      + '<label class="others-field">' + escapeHtml(t(state, 'others.antibotReplies'))
      + ' <textarea id="others-replies" rows="4" spellcheck="false">' + escapeHtml(val('antibotReplies')) + '</textarea></label>'
      + '<button type="button" id="others-save-btn">' + escapeHtml(t(state, 'others.save')) + '</button>'
      + '</div>';
  }

  /**
   * ATTACK settings form (PR6, REQ-35): targeting choice (lowest HP /
   * nearest) + the offensive rune slot + a Save button, with the
   * "skeleton — limited" disclosure. The offensive SPELL is chosen with the
   * spell picker (picker module 'attack'); the module toggle lives in the
   * ATTACK tab module list.
   * @param {object} state
   * @returns {string}
   */
  function renderAttackForm(state) {
    const form = state.attackForm || { targeting: '', runeSlot: '' };
    const derived = attackFormFromConfig(state);
    const val = (key) => (form[key] !== '' && form[key] !== undefined ? form[key] : derived[key]);
    const targeting = val('targeting');
    return '<div class="attack-form">'
      + '<h3>' + escapeHtml(t(state, 'attack.formTitle')) + '</h3>'
      + '<p class="skeleton-note">' + escapeHtml(t(state, 'attack.skeletonNote')) + '</p>'
      + '<label class="attack-field">' + escapeHtml(t(state, 'attack.targeting'))
      + ' <select id="attack-targeting">'
      + '<option value="lowest-hp"' + (targeting === 'lowest-hp' ? ' selected' : '') + '>'
      + escapeHtml(t(state, 'attack.targetingLowestHp')) + '</option>'
      + '<option value="nearest"' + (targeting === 'nearest' ? ' selected' : '') + '>'
      + escapeHtml(t(state, 'attack.targetingNearest')) + '</option>'
      + '</select></label>'
      + '<label class="attack-field">' + escapeHtml(t(state, 'attack.runeSlot'))
      + ' <input type="number" id="attack-rune-slot" min="1" max="12" step="1" value="' + escapeHtml(val('runeSlot')) + '"></label>'
      + '<p class="attack-spell-hint">' + escapeHtml(t(state, 'attack.spellHint')) + '</p>'
      + '<button type="button" id="attack-save-btn">' + escapeHtml(t(state, 'attack.save')) + '</button>'
      + '</div>';
  }

  /**
   * CAVEBOT skeleton form (PR6, REQ-36): record / stop & keep / save /
   * pause / resume / start controls + honest status lines (recording state,
   * saved-route count, pause) read from the live snapshot module state; the
   * "route editing — FUTURE" disclosure stands below the controls.
   * @param {object} state
   * @returns {string}
   */
  function renderCavebotForm(state) {
    const live = snapshotCavebot(state.snapshot);
    const parts = ['<div class="cavebot-form">', '<h3>' + escapeHtml(t(state, 'cavebot.formTitle')) + '</h3>'];
    parts.push('<p class="skeleton-note">' + escapeHtml(t(state, 'cavebot.skeletonNote')) + '</p>');
    if (live) {
      if (live.recording && live.recording.active === true) {
        parts.push('<p class="cavebot-status recording">'
          + escapeHtml(tVar(state, 'cavebot.recording', { count: live.recording.points })) + '</p>');
      } else {
        parts.push('<p class="cavebot-status">' + escapeHtml(t(state, 'cavebot.idle')) + '</p>');
      }
      parts.push('<p class="cavebot-status">' + (live.savedRoute && live.savedRoute.count > 0
        ? escapeHtml(tVar(state, 'cavebot.savedRoute', { count: live.savedRoute.count }))
        : escapeHtml(t(state, 'cavebot.noRoute'))) + '</p>');
      if (live.paused === true) {
        parts.push('<p class="cavebot-status paused">' + escapeHtml(t(state, 'cavebot.paused')) + '</p>');
      }
    }
    parts.push('<div class="cavebot-controls">'
      + '<button type="button" class="cavebot-btn" data-cavebot-command="record">' + escapeHtml(t(state, 'cavebot.record')) + '</button>'
      + '<button type="button" class="cavebot-btn" data-cavebot-command="stop">' + escapeHtml(t(state, 'cavebot.stopRecord')) + '</button>'
      + '<button type="button" class="cavebot-btn" data-cavebot-command="save">' + escapeHtml(t(state, 'cavebot.saveRoute')) + '</button>'
      + '<button type="button" class="cavebot-btn" data-cavebot-command="pause">' + escapeHtml(t(state, 'cavebot.pause')) + '</button>'
      + '<button type="button" class="cavebot-btn" data-cavebot-command="resume">' + escapeHtml(t(state, 'cavebot.resume')) + '</button>'
      + '<button type="button" class="cavebot-btn primary" data-cavebot-command="start">' + escapeHtml(t(state, 'cavebot.start')) + '</button>'
      + '</div>');
    parts.push('<p class="cavebot-future">' + escapeHtml(t(state, 'cavebot.editingFuture')) + '</p>');
    parts.push('</div>');
    return parts.join('');
  }

  /** Config form: module settings shell + the Routes v1 walk-to form
   *  (REQ-23, slice 6) + the slice-1b profile loader and spell picker.
   *  Route RECORDING is explicitly marked FUTURE — out of v1 scope per the
   *  spec; v1 issues walk-to through the native autowalk primitive only
   *  (values survive re-renders via state.walkTo). */
  function renderConfigForm(state) {
    const head = '<h2>' + escapeHtml(t(state, 'configuration')) + '</h2>';
    let body;
    if (state.gate === GATE_ARMED) {
      const wt = state.walkTo || { x: '', y: '' };
      body = renderHealForm(state) + renderTrainerForm(state) + renderOthersForm(state)
        + renderAttackForm(state) + renderCavebotForm(state)
        + renderProfileLoader(state)
        + renderSpellPicker(state)
        + '<div class="routes-form">'
        + '<h3>' + escapeHtml(t(state, 'routes.title')) + '</h3>'
        + '<label class="route-coord">X <input type="number" id="route-x" value="' + escapeHtml(wt.x) + '" step="any"></label>'
        + '<label class="route-coord">Y <input type="number" id="route-y" value="' + escapeHtml(wt.y) + '" step="any"></label>'
        + '<button type="button" id="route-walk-btn">' + escapeHtml(t(state, 'routes.walkTo')) + '</button>'
        + '<p class="routes-future">' + escapeHtml(t(state, 'routes.recordingFuture')) + '</p>'
        + '</div>';
    } else {
      body = '<div class="config-shell">' + escapeHtml(t(state, 'configLocked')) + '</div>';
    }
    // Slice B (REQ-45, D-B6): the Stop-Botting confirm overlay (renderTutorial
    // pattern — fixed-position, styled card, Yes/No buttons wired by app.js).
    if (state.confirmStop && state.confirmStop.pending) {
      body += '<div class="confirm-overlay" data-confirm-stop role="dialog"'
        + ' aria-label="' + escapeHtml(t(state, 'trainer.confirmTitle')) + '">'
        + '<div class="confirm-card">'
        + '<h3>' + escapeHtml(t(state, 'trainer.confirmTitle')) + '</h3>'
        + '<p>' + escapeHtml(t(state, 'trainer.confirmBody')) + '</p>'
        + '<div class="confirm-actions">'
        + '<button type="button" id="confirm-stop-no" class="tutorial-btn" data-confirm-stop-action="no">'
        + escapeHtml(t(state, 'trainer.confirmNo')) + '</button>'
        + '<button type="button" id="confirm-stop-yes" class="tutorial-btn primary" data-confirm-stop-action="yes">'
        + escapeHtml(t(state, 'trainer.confirmYes')) + '</button>'
        + '</div></div></div>';
    }
    return '<section class="config-form">' + head + body + '</section>';
  }

  /**
   * Readable player stats from a snapshot payload: the app shape
   * ({stats: readStats()}), the agent shape ({agent.health/mana}) and the
   * legacy flat shape ({health, mana}) are all honored. Pure.
   * @param {object|null} snapshot
   * @returns {{health: number|null, mana: number|null, maxHealth: number|null, maxMana: number|null}}
   */
  function snapshotStats(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return { health: null, mana: null, maxHealth: null, maxMana: null };
    }
    const st = snapshot.stats && typeof snapshot.stats === 'object' ? snapshot.stats : null;
    const ag = snapshot.agent && typeof snapshot.agent === 'object' ? snapshot.agent : null;
    const num = (v) => (v === null || v === undefined || v === '' ? null
      : (Number.isFinite(Number(v)) ? Number(v) : null));
    return {
      health: num((st && st.health) || (ag && ag.health) || snapshot.health),
      mana: num((st && st.mana) || (ag && ag.mana) || snapshot.mana),
      maxHealth: num((st && st.maxHealth) || (ag && ag.maxHealth)),
      maxMana: num((st && st.maxMana) || (ag && ag.maxMana)),
    };
  }

  /** PR6 (REQ-35): localized targeting label for the ATTACK live line — the
   *  snapshot carries the targeting id (lowest-hp/nearest); the panel speaks
   *  the localized label (never the raw id). */
  function attackTargetingLabel(state, id) {
    return id === 'nearest' ? t(state, 'attack.targetingNearest') : t(state, 'attack.targetingLowestHp');
  }

  /** Live state view: stats summary + REQ-22 premium notice + REQ-25
   *  learning offers + module alert states. NEVER raw JSON (REQ-26 — the
   *  old <pre class="live-payload"> JSON dump is gone; the readable activity
   *  log renders in renderLog from the snapshot's logBuffer). */
  function renderLiveState(state) {
    const head = '<h2>' + escapeHtml(t(state, 'liveState')) + '</h2>';
    let body;
    if (state.snapshot === null) {
      body = '<div class="live-empty">' + escapeHtml(t(state, 'noSnapshot')) + '</div>';
    } else {
      const parts = [];
      const stats = snapshotStats(state.snapshot);
      if (stats.health !== null || stats.mana !== null) {
        const bits = [];
        if (stats.health !== null) {
          bits.push(escapeHtml(t(state, 'stats.health')) + ' '
            + stats.health + (stats.maxHealth !== null ? ' / ' + stats.maxHealth : ''));
        }
        if (stats.mana !== null) {
          bits.push(escapeHtml(t(state, 'stats.mana')) + ' '
            + stats.mana + (stats.maxMana !== null ? ' / ' + stats.maxMana : ''));
        }
        parts.push('<div class="stats-line">' + bits.join(' · ') + '</div>');
      }
      // Slice 2 (PR3, REQ-29): HEAL live line — module on/off + hp% vs the
      // configured threshold (percent view of the saved absolute threshold).
      const hmCfg = state.config && state.config.modules && state.config.modules.healMagic;
      if (hmCfg && stats.health !== null && stats.maxHealth !== null && stats.maxHealth > 0) {
        const hpPct = Math.round(stats.health / stats.maxHealth * 100);
        const tAbs = Number(hmCfg.threshold);
        const tPct = Number.isFinite(tAbs) && tAbs >= 0 ? Math.round(tAbs / stats.maxHealth * 100) : null;
        parts.push('<div class="heal-state">' + (hmCfg.on === true
          ? escapeHtml(tVar(state, 'heal.liveOn', { pct: hpPct, max: stats.maxHealth, t: tPct, slot: hmCfg.slot === null || hmCfg.slot === undefined ? '—' : hmCfg.slot }))
          : escapeHtml(t(state, 'heal.liveOff'))) + '</div>');
      }
      const blocked = premiumBlockedModules(state.snapshot);
      if (blocked.length > 0) {
        parts.push('<div class="premium-required">'
          + escapeHtml(tVar(state, 'premium.required', { modules: blocked.map((b) => b.label).join(', ') }))
          + '</div>');
      }
      const offers = snapshotOffers(state.snapshot);
      if (offers.length > 0) {
        parts.push('<div class="offers">'
          + '<h3>' + escapeHtml(t(state, 'offers.title')) + '</h3>'
          + offers.map((o) => renderOffer(o, state)).join('')
          + '</div>');
      }
      // Slice-6 polish (REQ-17/23): module alert states wired into the live
      // view — the eat 3-fail pause alert and the routes autowalk read.
      const modules = state.snapshot.agent && state.snapshot.agent.modules
        ? state.snapshot.agent.modules : null;
      if (modules && modules.eat && modules.eat.paused === true) {
        parts.push('<div class="module-alert alert-eat">' + escapeHtml(t(state, 'eat.pausedAlert')) + '</div>');
      }
      // Slice 3 (PR4, REQ-30, D3): the trainer's strict-CAP state — the panel
      // ALERT + beep fire on the rising edge (app.js); this line keeps the
      // cap-full condition VISIBLE while it persists.
      if (modules && modules.training && modules.training.capFull === true) {
        parts.push('<div class="module-alert alert-cap-full">'
          + escapeHtml(t(state, 'trainer.capFullAlert')) + '</div>');
      }
      // PR A (REQ-40/41, D-A3/A5): the rune-check pause banner + manual resume
      // button. The ALERT + beep for NEW runecheck events ride the anti-bot
      // per-id latch (app.js poll); this banner keeps the pause visible while
      // it persists and offers the resume action (the effect posts
      // /api/runecheck-resume -> resumeRuneCheck RPC).
      const runeCheck = state.snapshot.agent && state.snapshot.agent.runeCheck;
      if (runeCheck && runeCheck.active === true) {
        parts.push('<div class="module-alert alert-runecheck">'
          + escapeHtml(t(state, 'trainer.runeCheckAlert'))
          + ' <button type="button" class="runecheck-resume-btn" id="runecheck-resume-btn">'
          + escapeHtml(t(state, 'trainer.resumeBtn')) + '</button></div>');
      }
      // Slice 5 (PR5, REQ-33/34): the anti-bot watcher state — pending
      // confirm prompt (first pattern occurrence), recent alerts, and the
      // honest auto-reply degrade. The ALERT + beep for NEW alerts fire in
      // app.js (per-alert-id rising edge); these lines keep everything visible.
      const antibot = snapshotAntibot(state.snapshot);
      if (antibot) {
        const pending = antibot.pendingConfirm;
        if (pending && pending.pattern) {
          parts.push('<div class="antibot-confirm-prompt">'
            + escapeHtml(tVar(state, 'others.confirmPrompt', { pattern: pending.pattern, reply: pending.reply }))
            + ' <button type="button" class="antibot-confirm-btn" data-antibot-confirm="'
            + escapeHtml(pending.pattern) + '">' + escapeHtml(t(state, 'others.confirmBtn')) + '</button>'
            + '</div>');
        }
        if (antibot.sendAvailable === false) {
          parts.push('<div class="module-alert alert-antibot-send">'
            + escapeHtml(t(state, 'others.sendUnavailable')) + '</div>');
        }
        parts.push('<div class="antibot-alerts"><h3>' + escapeHtml(t(state, 'others.alertsTitle')) + '</h3>');
        const alerts = Array.isArray(antibot.alerts) ? antibot.alerts.slice(-5) : [];
        if (alerts.length === 0) {
          parts.push('<p class="antibot-none">' + escapeHtml(t(state, 'others.noAlerts')) + '</p>');
        } else {
          parts.push(alerts.map((a) => renderAntibotAlert(a, state)).join(''));
        }
        parts.push('</div>');
      }
      if (modules && modules.routes) {
        const r = modules.routes;
        let line;
        if (r.available !== true) {
          line = tVar(state, 'routes.unavailable', { reason: r.reason || 'no pathfinder data' });
        } else if (r.isAutoWalking === true) {
          const hasDest = r.destination && Number.isFinite(Number(r.destination.x))
            && Number.isFinite(Number(r.destination.y));
          if (Number.isInteger(r.stepsRemaining)) {
            line = hasDest
              ? tVar(state, 'routes.autoWalkingStepsTo', { count: r.stepsRemaining, x: r.destination.x, y: r.destination.y })
              : tVar(state, 'routes.autoWalkingSteps', { count: r.stepsRemaining });
          } else {
            line = hasDest
              ? tVar(state, 'routes.autoWalkingProgressTo', { x: r.destination.x, y: r.destination.y })
              : tVar(state, 'routes.autoWalkingProgress');
          }
        } else {
          line = t(state, 'routes.notWalking');
        }
        parts.push('<div class="routes-state">' + escapeHtml(line) + '</div>');
      }
      // PR6 (REQ-35/36): skeleton module lines — the attack targeting +
      // picker config and the cavebot recording/saved-route/pause status
      // ride the snapshot like every other module line.
      if (modules && modules.attack) {
        const a = modules.attack;
        const targeting = attackTargetingLabel(state, a.targeting);
        const hasSpell = a.on === true && a.spell && a.spell.sid !== null && a.spell.sid !== undefined;
        const hasRune = a.on === true && a.rune && a.rune.slot !== null && a.rune.slot !== undefined;
        let line;
        if (a.on === true) {
          if (hasSpell && hasRune) {
            line = tVar(state, 'attack.stateOnFull', { targeting, sid: a.spell.sid, slot: a.rune.slot });
          } else if (hasSpell) {
            line = tVar(state, 'attack.stateOnSpell', { targeting, sid: a.spell.sid });
          } else if (hasRune) {
            line = tVar(state, 'attack.stateOnRune', { targeting, slot: a.rune.slot });
          } else {
            line = tVar(state, 'attack.stateOn', { targeting });
          }
        } else {
          line = tVar(state, 'attack.stateOff', { targeting });
        }
        parts.push('<div class="attack-state">' + escapeHtml(line) + '</div>');
      }
      const cavebot = snapshotCavebot(state.snapshot);
      if (cavebot) {
        let detail = cavebot.recording && cavebot.recording.active === true
          ? tVar(state, 'cavebot.stateRecording', { count: cavebot.recording.points })
          : t(state, 'cavebot.stateNotRecording');
        if (cavebot.savedRoute && cavebot.savedRoute.count > 0) {
          detail += tVar(state, 'cavebot.stateSavedRoute', { count: cavebot.savedRoute.count });
        }
        if (cavebot.paused === true) detail += t(state, 'cavebot.statePaused');
        parts.push('<div class="cavebot-state">'
          + escapeHtml(tVar(state, cavebot.on === true ? 'cavebot.stateOn' : 'cavebot.stateOff', { detail }))
          + '</div>');
      }
      body = parts.join('');
    }
    return '<section class="live-state">' + head + body + '</section>';
  }

  /**
   * Format a log `result` value as readable text — NEVER raw JSON (REQ-26).
   * Primitives stringify; small objects render their scalar fields joined by
   * commas (no braces, no quotes, no JSON syntax).
   * @param {*} result
   * @returns {string}
   */
  function formatLogResult(result) {
    if (result === null || result === undefined) return '';
    if (typeof result !== 'object') return String(result);
    const fields = [];
    for (const k of Object.keys(result)) {
      const v = result[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue; // nested objects stay hidden — no JSON
      fields.push(k + ' ' + String(v));
    }
    return fields.join(', ');
  }

  /**
   * Activity log (design D8, REQ-26): renders snapshot logBuffer rows as
   * readable text — timestamp + module label + action + result. The raw JSON
   * dump (old <pre class="live-payload">) is GONE: the user never sees JSON
   * here. Rows come from the agent ring (cap 200, snapshot-carried); module
   * ids map to readable labels, unknown ids fall back to the id itself.
   * @param {object} state
   * @returns {string}
   */
  function renderLog(state) {
    const head = '<h2>' + escapeHtml(t(state, 'activityLog')) + '</h2>';
    const snapshot = state.snapshot;
    const buffer = snapshot && Array.isArray(snapshot.logBuffer)
      ? snapshot.logBuffer
      : (snapshot && snapshot.agent && Array.isArray(snapshot.agent.logBuffer) ? snapshot.agent.logBuffer : []);
    let body;
    if (buffer.length === 0) {
      body = '<div class="log-empty">' + escapeHtml(t(state, 'log.empty')) + '</div>';
    } else {
      const rows = buffer.slice(-100).map((entry) => {
        const when = Number.isFinite(Number(entry.ts)) ? new Date(Number(entry.ts)).toLocaleTimeString() : '--:--:--';
        const moduleId = String(entry.module || 'agent');
        const label = t(state, 'module.' + moduleId);
        const labelText = label === 'module.' + moduleId ? moduleId : label;
        const action = String(entry.action || 'event');
        const result = formatLogResult(entry.result);
        return '<div class="log-row"><span class="log-time">' + escapeHtml(when) + '</span>'
          + '<span class="log-module">' + escapeHtml(labelText) + '</span>'
          + '<span class="log-action">' + escapeHtml(action) + '</span>'
          + (result !== '' ? '<span class="log-result">' + escapeHtml(result) + '</span>' : '')
          + '</div>';
      }).join('');
      body = '<div class="log-rows">' + rows + '</div>';
    }
    return '<section class="activity-log">' + head + body + '</section>';
  }

  /**
   * Tutorial overlay (design D7, REQ-26): ~100-line custom stepper, no
   * external library. Steps walk every tab (TUTORIAL_STEPS); the active step
   * renders title + body + progress + Next/Finish + Skip. localStorage
   * 'tutorialSeen' is persisted by the app effect ('tutorial-seen') — the
   * reducer never touches storage.
   * @param {object} state
   * @returns {string} empty when the tutorial is not running
   */
  function renderTutorial(state) {
    if (!state.tutorial || !Number.isInteger(state.tutorial.step)) return '';
    const steps = TUTORIAL_STEPS;
    const step = Math.max(0, Math.min(state.tutorial.step, steps.length - 1));
    const cur = steps[step];
    const title = cur.key.indexOf('tutorial.tab.') === 0
      ? escapeHtml(t(state, 'tab.' + cur.tab))
      : escapeHtml(t(state, cur.key));
    const body = escapeHtml(t(state, cur.body || cur.key));
    const isLast = step >= steps.length - 1;
    const cta = isLast
      ? '<button type="button" class="tutorial-btn primary" data-tutorial-action="next">' + escapeHtml(t(state, 'tutorial.finish')) + '</button>'
      : '<button type="button" class="tutorial-btn primary" data-tutorial-action="next">' + escapeHtml(t(state, 'tutorial.next')) + '</button>';
    return '<div class="tutorial-overlay" data-tutorial role="dialog" aria-label="' + title + '">'
      + '<div class="tutorial-card">'
      + '<h3>' + title + '</h3>'
      + '<p>' + body + '</p>'
      + '<div class="tutorial-progress">' + (step + 1) + ' / ' + steps.length + '</div>'
      + '<div class="tutorial-actions">'
      + '<button type="button" class="tutorial-btn" data-tutorial-action="dismiss">' + escapeHtml(t(state, 'tutorial.dismiss')) + '</button>'
      + cta
      + '</div>'
      + '</div>'
      + '</div>';
  }

  /** Audit: localized severity/kind label for a panel alert. Unknown kinds
   *  fall back to the raw kind id (never the key itself). */
  function alertKindLabel(state, kind) {
    const key = 'alert.kind.' + String(kind || 'event');
    const label = t(state, key);
    return label === key ? String(kind || 'event') : label;
  }

  /** Audit: visible panel alerts section — bounded to the last 8 entries,
   *  HTML-escaped, with a localized kind label + timestamp (REQ-26 readable,
   *  never raw JSON). Rendered from state.alerts (the reducer already caps
   *  the list at 20; the render bounds the section to a readable window). */
  function renderAlerts(state) {
    const alerts = Array.isArray(state.alerts) ? state.alerts.slice(-8) : [];
    const parts = ['<section class="panel-alerts">', '<h2>' + escapeHtml(t(state, 'alerts.title')) + '</h2>'];
    if (alerts.length === 0) {
      parts.push('<p class="alerts-empty">' + escapeHtml(t(state, 'alerts.empty')) + '</p>');
    } else {
      parts.push('<div class="alerts-list">' + alerts.map((a) => {
        const when = Number.isFinite(Number(a.at))
          ? new Date(Number(a.at)).toLocaleTimeString() : '--:--:--';
        return '<div class="panel-alert" data-alert-kind="' + escapeHtml(String(a.kind || 'event')) + '">'
          + '<span class="panel-alert-kind">' + escapeHtml(alertKindLabel(state, a.kind)) + '</span>'
          + ' <span class="panel-alert-time">' + escapeHtml(when) + '</span>'
          + ' <span class="panel-alert-message">' + escapeHtml(String(a.message || '')) + '</span>'
          + '</div>';
      }).join('') + '</div>');
    }
    parts.push('</section>');
    return parts.join('');
  }

  /** Full panel body render (status bar + tabs + config + live state + alerts
   *  + log + tutorial overlay). */
  function renderPanel(state) {
    return '<main id="panel-root">'
      + renderStatusBar(state)
      + renderModuleList(state)
      + renderConfigForm(state)
      + renderLiveState(state)
      + renderAlerts(state)
      + renderLog(state)
      + renderTutorial(state)
      + '</main>';
  }

  return {
    GATE_STATES,
    GATE_DISCONNECTED,
    GATE_PROBING,
    GATE_CONFIRMED,
    GATE_ARMED,
    LANGS,
    LANG_EN,
    LANG_ES,
    TABS,
    TAB_IDS,
    MODULE_DEFS,
    MODULE_IDS,
    MODULE_BY_TAB,
    PICKER_MODULES,
    I18N,
    TUTORIAL_STEPS,
    createInitialState,
    panelReducer,
    dispatch,
    gateLabel,
    t,
    tVar,
    moduleLabel,
    escapeHtml,
    premiumBlockedModules,
    snapshotOffers,
    snapshotAntibot,
    snapshotCavebot,
    snapshotStats,
    formatLogResult,
    renderOffer,
    renderAntibotAlert,
    alertKindLabel,
    renderAlerts,
    renderStatusBar,
    renderModuleList,
    renderProfileLoader,
    renderSpellPicker,
    renderConfigForm,
    healFormFromConfig,
    renderHealForm,
    trainerFormFromConfig,
    renderTrainerForm,
    filterRuneCatalog,
    snapshotCap,
    renderBar,
    othersFormFromConfig,
    parseRepliesText,
    renderOthersForm,
    attackFormFromConfig,
    renderAttackForm,
    renderCavebotForm,
    renderLiveState,
    renderLog,
    renderTutorial,
    renderPanel,
  };
});
