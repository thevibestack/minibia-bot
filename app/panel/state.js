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
   * Visible product tabs: DASHBOARD (quick-access cards) first, then the
   * configuration tabs of the ACTIVE modules only. Every tab id here is a
   * rendered tab button + panel. Hidden modules (see HIDDEN_MODULES) are
   * deliberately absent from this list — no tab, no toggle, no config deck.
   */
  const TABS = [
    { id: 'dashboard', modules: [] },
    { id: 'heal', modules: ['healMagic'] },
    { id: 'trainer', modules: ['runes', 'training'] },
    { id: 'others', modules: ['eat'] },
  ];
  const TAB_IDS = TABS.map((t) => t.id);

  /** The 13 modules (design config "modules" map). MODULE_DEFS/MODULE_IDS stay
   * INTACT for config round-trip safety: buildPushConfig still iterates every
   * id and hidden modules keep whatever `on`/settings the server returned.
   * Hiding is render-time only — see HIDDEN_MODULES. */
  const MODULE_DEFS = [
    { id: 'healItems', label: 'Heal with items', tab: 'heal' },
    { id: 'manaItems', label: 'Mana potions', tab: 'heal' },
    { id: 'healMagic', label: 'Heal with magic', tab: 'heal' },
    { id: 'attack', label: 'Attack', tab: 'attack' },
    { id: 'cavebot', label: 'Cavebot', tab: 'cavebot' },
    { id: 'runes', label: 'Runes', tab: 'trainer' },
    { id: 'training', label: 'Magic training', tab: 'trainer' },
    { id: 'eat', label: 'Eat', tab: 'others' },
    { id: 'trade', label: 'Auto trade broadcast', tab: 'others' },
    { id: 'loot', label: 'Auto-loot', tab: 'others' },
    { id: 'spawns', label: 'Spawn maps', tab: 'others' },
    { id: 'huntStats', label: 'Hunt stats', tab: 'others' },
    { id: 'routes', label: 'Routes', tab: 'others' },
  ];
  const MODULE_IDS = MODULE_DEFS.map((m) => m.id);

  /** Modules removed from every UI surface (tab, toggle, config deck, live
   *  line) by the approved dashboard-first scope. Config for these modules is
   *  still carried untouched through buildPushConfig. */
  const HIDDEN_MODULES = new Set([
    'attack', 'cavebot', 'trade', 'loot', 'spawns', 'huntStats', 'routes',
    'healItems', 'manaItems',
  ]);

  /** Full MODULE_DEFS grouping (hidden included — render filters it). Built
   * from MODULE_DEFS first so tabs that are no longer in TABS still resolve. */
  const MODULE_BY_TAB = (function () {
    const out = {};
    for (const def of MODULE_DEFS) {
      if (!out[def.tab]) out[def.tab] = [];
      out[def.tab].push(def);
    }
    for (const tab of TABS) if (!out[tab.id]) out[tab.id] = [];
    return out;
  }());

  /** Dashboard quick-access cards (visible modules only): module id -> the
   * configuration tab the "Configurar" button jumps to. */
  const DASHBOARD_CARDS = [
    { id: 'training', configTab: 'trainer' },
    { id: 'eat', configTab: 'others' },
    { id: 'healMagic', configTab: 'heal' },
    { id: 'runes', configTab: 'trainer' },
  ];

  /* ----------------------- slice 1b (REQ-28, D5) ----------------------- */
  /** Modules whose spell sid the picker can choose (heal + training). The
   * hidden attack module is not offered here. */
  const PICKER_MODULES = ['healMagic', 'training'];

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
      'linkFirst': 'Link first PWA',
      'refused': 'refused: %reason%',
      'language': 'Language',
      'tab.heal': 'HEAL',
      'tab.attack': 'ATTACK',
      'tab.trainer': 'TRAINER',
      'tab.cavebot': 'CAVEBOT',
      'tab.others': 'OTHERS',
      'tab.dashboard': 'DASHBOARD',
      'dashboard.title': 'Quick access',
      'dashboard.goConfig': 'Configure',
      'dashboard.status.off': 'Off — no actions',
      'dashboard.status.armed': 'Armed — waiting for live data',
      'dashboard.training.created': 'Runes created: %count%',
      'dashboard.training.ready': 'Ready to cast — waiting for the game cycle',
      'dashboard.runes.ready': 'Rune data ready',
      'dashboard.runes.unavailable': 'No native rune data (display only)',
      'dashboard.eat.lastAte': 'Last ate %time%',
      'dashboard.eat.none': 'No food actions yet',
      'dashboard.eat.created': 'Food created: %count%',
      'dashboard.eat.nextMeal': 'Next meal %time%',
      'dashboard.eat.nextMealNone': 'No next meal yet',
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
      'module.manaItems': 'Mana potions',
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
      'tutorial.connect.title': '1. Connect the game',
      'tutorial.connect.body': 'Use this control to link the game, then confirm Connect when the character name appears. The guide never connects or changes settings for you.',
      'tutorial.live.title': '2. Load live data',
      'tutorial.live.body': 'After Connect, wait for live health/mana, spell catalog, hotbar and backpacks to load. These are read-only game data used by the forms below.',
      'tutorial.healSpell.title': '3. Survival: choose your healing spell',
      'tutorial.healSpell.body': 'In Spell picker select Heal spell, then choose a valid healing spell for this character. The panel only lists live, vocation-compatible spells.',
      'tutorial.healRules.title': '4. Survival: thresholds and potions',
      'tutorial.healRules.body': 'Set the HP threshold and mana reserve, choose HP and optional mana potions from the visible backpacks, then Save survival settings. The chosen heal spell must show a live F-slot mapping.',
      'tutorial.attack.title': '5. Combat: Assist is manual target only',
      'tutorial.attack.body': 'Enable Attack only if you want spells/runes on the creature YOU already targeted. Assist never chooses a new target for you.',
      'tutorial.caveMonsters.title': '6. Cavebot: choose monsters',
      'tutorial.caveMonsters.body': 'Select visible monster names and the priority, then save the Cavebot configuration. Cavebot may select only those configured monsters.',
      'tutorial.caveRoute.title': '7. Cavebot: record the route',
      'tutorial.caveRoute.body': 'Record while you walk, Stop & keep, then Save route. Cavebot pauses its route to fight configured monsters and resumes afterward.',
      'tutorial.trainerRune.title': '8. Trainer: choose a rune',
      'tutorial.trainerRune.body': 'Choose the rune-making spell. It must be in the live hotbar; the form shows its real F-slot and saves only that mapping.',
      'tutorial.trainerFallback.title': '9. Trainer: fallback spell',
      'tutorial.trainerFallback.body': 'Optionally enable automatic fallback, choose its spell and mana percentage. It also requires a live hotbar mapping.',
      'tutorial.trainerCap.title': '10. Trainer: capacity policy',
      'tutorial.trainerCap.body': 'Choose whether to stop at capacity and its threshold. This policy controls rune-making only; it does not invent backpack or hotbar data.',
      'tutorial.verify.title': '11. Verify before running',
      'tutorial.verify.body': 'Use Live state and Activity log to confirm HP/mana, module status, route state and validation messages. Enable modules only after you saved valid settings.',
      'tutorial.connectRequired': 'Connect a game first. Until then, the configuration controls are intentionally unavailable and the guide cannot invent live data.',
      'tutorial.hotbarUnavailable': 'The live hotbar is unavailable or empty. Put the selected spell on F1–F12 in the game, refresh after Connect, and wait for its mapped-slot message before saving.',
      'tutorial.inventoryUnavailable': 'No live backpack items are available. Open the backpack in the game and use Refresh items; potion choices are intentionally not guessed.',
      'tutorial.creaturesUnavailable': 'No visible creatures were received. Bring the monsters on screen and refresh after Connect; Cavebot cannot be configured with invented names.',
      'tutorial.next': 'Next',
      'tutorial.back': 'Back',
      'tutorial.finish': 'Finish',
      'tutorial.dismiss': 'Skip tutorial',
      'tutorial.restart': 'Guide',
      'gameData.refresh': 'Refresh game data',
      'gameData.refreshing': 'Refreshing game data…',
      'gameData.updated': 'Game data updated at %time%',
      'gameData.partial': 'Some game data could not refresh. Check the game PWA and try again.',
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
      'picker.module.training': 'Rune-making spell',
      'picker.search': 'Search spells…',
      'picker.categoryEmpty': 'No spells in this category for the connected character.',
      'picker.none': 'No spells match.',
      'picker.meta': 'mana %mana%, level %level%',
      'picker.pick': 'Pick',
      'picker.current': 'current',
      // Slice 2 (PR3, REQ-29): HEAL settings form + live state line.
      'heal.formTitle': 'Survival / healing',
      'heal.mode': 'Healing method',
      'heal.mode.magic': 'Magic only',
      'heal.mode.items': 'Items only',
      'heal.mode.both': 'Magic + items',
      'heal.magicTitle': 'Magic healing',
      'heal.itemsTitle': 'HP potions / items',
      'heal.manaTitle': 'Mana potions',
      'heal.manaEnabled': 'Use mana potions',
      'heal.manaThreshold': 'Use mana potion at mana %',
      'heal.hotbarMapped': 'Mapped to live hotbar slot F%slot%',
      'heal.hotbarMissing': 'Put this spell in the game hotbar first; no fake slot is saved.',
      'heal.inventoryHint': 'Choose the actual item types from open backpacks. The game does not expose a reliable potion category, so nothing is guessed.',
      'heal.threshold': 'Health threshold %',
      'heal.itemThreshold': 'Use items at health %',
      'heal.slot': 'Spell hotbar slot (F1 = 1)',
      'heal.reserve': 'Mana reserve after cast %',
      'heal.itemsEmpty': 'Open the backpack with your potions and refresh the items.',
      'heal.itemsRefresh': 'Refresh backpack',
      'heal.itemsSelected': '%count% item type(s) selected',
      'heal.save': 'Save survival settings',
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
      'trainer.runeSlot': 'Spell hotbar slot (1-12)',
      'trainer.runeSlotHint': 'If this spell is on F1, set slot 1. F2 = slot 2, and so on.',
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
      'trainer.waitingMana': 'Rune-making armed — waiting for %required% mana (%current% available).',
      // Slice 5 (PR5, REQ-33/34): OTHERS settings form + anti-bot live state.
      'others.formTitle': 'Other settings',
      'others.foodTitle': 'Food',
      'others.foodSlot': 'Food slot (backpack index)',
      'others.everyCasts': 'Eat every N casts (0 = hunger only)',
      // PR 4 (REQ-01): unified food magic + safety net live in modules.eat.
      'others.foodMagic': 'Food with magic',
      'others.foodMagicToggle': 'Create food with magic',
      'others.foodMagicSelect': 'Food spell (e.g. exevo pan)',
      'others.foodMagicSelectEmpty': 'Select spell',
      'others.foodMagicMapping': 'Food spell → live F%slot% from the game',
      'others.foodMagicHotbar': 'Put the food spell on F1–F12, refresh game data, then save.',
      'others.safetyNet': 'Safety-net meal every N minutes (default 20)',
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
      'attack.formTitle': 'Attack Assist settings',
      'attack.skeletonNote': 'Uses only your selected target; it never chooses one for you.',
      'attack.targeting': 'Targeting',
      'attack.targetingLowestHp': 'Lowest HP',
      'attack.targetingNearest': 'Nearest',
      'attack.runeSlot': 'Offensive rune slot',
      'attack.spellHint': 'Offensive spell — pick it with the spell picker below.',
      'attack.save': 'Save attack settings',
      'cavebot.formTitle': 'Cavebot',
      'cavebot.skeletonNote': 'Stops route movement for configured monsters and resumes afterward.',
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
      'linkFirst': 'Vincular primera PWA',
      'refused': 'rechazado: %reason%',
      'language': 'Idioma',
      'tab.heal': 'CURAR',
      'tab.attack': 'ATAQUE',
      'tab.trainer': 'ENTRENAR',
      'tab.cavebot': 'CAVEBOT',
      'tab.others': 'OTROS',
      'tab.dashboard': 'INICIO',
      'dashboard.title': 'Acceso rápido',
      'dashboard.goConfig': 'Configurar',
      'dashboard.status.off': 'Apagado — sin acciones',
      'dashboard.status.armed': 'Activo — esperando datos vivos',
      'dashboard.training.created': 'Runas creadas: %count%',
      'dashboard.training.ready': 'Listo para lanzar — esperando el ciclo del juego',
      'dashboard.runes.ready': 'Datos de runas listos',
      'dashboard.runes.unavailable': 'Sin datos nativos de runas (solo lectura)',
      'dashboard.eat.lastAte': 'Última comida %time%',
      'dashboard.eat.none': 'Todavía sin acciones de comida',
      'dashboard.eat.created': 'Comida creada: %count%',
      'dashboard.eat.nextMeal': 'Siguiente comida %time%',
      'dashboard.eat.nextMealNone': 'Sin próxima comida todavía',
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
      'module.manaItems': 'Pociones de maná',
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
      'tutorial.connect.title': '1. Conectá el juego',
      'tutorial.connect.body': 'Usá este control para vincular el juego y después confirmá Conectar cuando aparezca el personaje. La guía nunca conecta ni cambia ajustes por vos.',
      'tutorial.live.title': '2. Cargá los datos vivos',
      'tutorial.live.body': 'Después de Conectar, esperá vida/maná, catálogo de magias, hotbar y mochilas. Son datos de juego de solo lectura usados por los formularios.',
      'tutorial.healSpell.title': '3. Supervivencia: elegí la magia de curación',
      'tutorial.healSpell.body': 'En Selector de magias elegí Hechizo de curación y una magia válida del personaje. El panel sólo lista magias reales y compatibles con tu vocación.',
      'tutorial.healRules.title': '4. Supervivencia: umbrales y pociones',
      'tutorial.healRules.body': 'Definí vida, reserva de maná, pociones HP y opcionalmente de maná desde las mochilas visibles; después guardá. La magia elegida debe mostrar su F-slot vivo.',
      'tutorial.attack.title': '5. Combate: Assist usa objetivo manual',
      'tutorial.attack.body': 'Activá Ataque sólo para lanzar magia/runa sobre el monstruo que VOS ya marcaste. Assist nunca elige un objetivo nuevo.',
      'tutorial.caveMonsters.title': '6. Cavebot: elegí monstruos',
      'tutorial.caveMonsters.body': 'Elegí monstruos visibles y prioridad, y guardá la configuración. Cavebot sólo puede seleccionar los monstruos configurados.',
      'tutorial.caveRoute.title': '7. Cavebot: grabá la ruta',
      'tutorial.caveRoute.body': 'Grabá mientras caminás, detené y conservá, y guardá la ruta. Cavebot pausa la ruta para pelear y luego la retoma.',
      'tutorial.trainerRune.title': '8. Entrenar: elegí una runa',
      'tutorial.trainerRune.body': 'Elegí la magia de runa. Debe estar en el hotbar vivo: el formulario muestra su F-slot real y sólo guarda ese mapeo.',
      'tutorial.trainerFallback.title': '9. Entrenar: magia alternativa',
      'tutorial.trainerFallback.body': 'Opcionalmente activá la alternativa, elegí su magia y porcentaje de maná. También necesita un mapeo vivo del hotbar.',
      'tutorial.trainerCap.title': '10. Entrenar: política de capacidad',
      'tutorial.trainerCap.body': 'Definí si se detiene al llegar a capacidad y su umbral. Esta regla sólo controla runas; no inventa mochilas ni hotkeys.',
      'tutorial.verify.title': '11. Verificá antes de correr',
      'tutorial.verify.body': 'Revisá Estado en vivo y Registro para confirmar vida/maná, módulos, ruta y validaciones. Activá módulos recién después de guardar ajustes válidos.',
      'tutorial.connectRequired': 'Primero conectá el juego. Hasta entonces los controles están bloqueados a propósito: la guía no inventa datos vivos.',
      'tutorial.hotbarUnavailable': 'El hotbar vivo no está disponible o está vacío. Poné la magia elegida en F1–F12 dentro del juego, refrescá después de Conectar y esperá el mensaje de slot mapeado antes de guardar.',
      'tutorial.inventoryUnavailable': 'No hay objetos de mochila disponibles. Abrí la BP en el juego y usá Refrescar objetos; las pociones no se adivinan.',
      'tutorial.creaturesUnavailable': 'No llegaron criaturas visibles. Poné los monstruos en pantalla y refrescá después de Conectar; Cavebot no se configura con nombres inventados.',
      'tutorial.next': 'Siguiente',
      'tutorial.back': 'Atrás',
      'tutorial.finish': 'Terminar',
      'tutorial.dismiss': 'Omitir tutorial',
      'tutorial.restart': 'Guía',
      'gameData.refresh': 'Actualizar datos del juego',
      'gameData.refreshing': 'Actualizando datos del juego…',
      'gameData.updated': 'Datos del juego actualizados a las %time%',
      'gameData.partial': 'No se pudieron actualizar algunos datos. Revisá la PWA del juego e intentá de nuevo.',
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
      'picker.module.training': 'Magia para crear runa',
      'picker.search': 'Buscar magias…',
      'picker.categoryEmpty': 'No hay magias de esta categoría para el personaje conectado.',
      'picker.none': 'No hay magias que coincidan.',
      'picker.meta': 'maná %mana%, nivel %level%',
      'picker.pick': 'Elegir',
      'picker.current': 'actual',
      // Slice 2 (PR3, REQ-29): formulario de ajustes de CURAR + línea de estado.
      'heal.formTitle': 'Supervivencia / curación',
      'heal.mode': 'Método de curación',
      'heal.mode.magic': 'Solo magia',
      'heal.mode.items': 'Solo objetos',
      'heal.mode.both': 'Magia + objetos',
      'heal.magicTitle': 'Curación con magia',
      'heal.itemsTitle': 'Pociones / objetos de vida',
      'heal.manaTitle': 'Pociones de maná',
      'heal.manaEnabled': 'Usar pociones de maná',
      'heal.manaThreshold': 'Usar poción de maná al % de maná',
      'heal.hotbarMapped': 'Mapeado al slot vivo F%slot%',
      'heal.hotbarMissing': 'Primero poné este hechizo en el hotbar del juego; no se guarda un slot inventado.',
      'heal.inventoryHint': 'Elegí los tipos reales de objetos de las BP abiertas. El juego no expone una categoría confiable de pociones, así que no se adivina.',
      'heal.threshold': 'Curar con magia al % de vida',
      'heal.itemThreshold': 'Usar objetos al % de vida',
      'heal.slot': 'Slot de magia (F1 = 1)',
      'heal.reserve': 'Reserva de maná después de curar %',
      'heal.itemsEmpty': 'Abrí la BP con las pociones y actualizá los objetos.',
      'heal.itemsRefresh': 'Actualizar BP',
      'heal.itemsSelected': '%count% tipo(s) de objeto seleccionado(s)',
      'heal.save': 'Guardar supervivencia',
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
      'trainer.runeSlot': 'Slot del hotbar para esta magia (1-12)',
      'trainer.runeSlotHint': 'Si esta magia está en F1, poné slot 1. F2 = slot 2, y así.',
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
      'trainer.waitingMana': 'Fabricación de runas activada — esperando %required% de maná (%current% disponible).',
      // Slice 5 (PR5, REQ-33/34): formulario de OTROS + estado anti-bot en vivo.
      'others.formTitle': 'Otros ajustes',
      'others.foodTitle': 'Comida',
      'others.foodSlot': 'Slot de comida (índice de mochila)',
      'others.everyCasts': 'Comer cada N hechizos (0 = solo con hambre)',
      // PR 4 (REQ-01): comida con magia unificada + red de seguridad en modules.eat.
      'others.foodMagic': 'Comida con magia',
      'others.foodMagicToggle': 'Crear comida con magia',
      'others.foodMagicSelect': 'Magia de comida (ej. exevo pan)',
      'others.foodMagicSelectEmpty': 'Elegí una magia',
      'others.foodMagicMapping': 'Magia de comida → F%slot% viva del juego',
      'others.foodMagicHotbar': 'Poné la magia de comida en F1–F12, actualizá datos del juego y guardá.',
      'others.safetyNet': 'Comida de red de seguridad cada N minutos (por defecto 20)',
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
      'attack.formTitle': 'Ajustes de ataque asistido',
      'attack.skeletonNote': 'Usa solamente el objetivo que vos seleccionaste; nunca elige uno por su cuenta.',
      'attack.targeting': 'Targeting',
      'attack.targetingLowestHp': 'Menor vida',
      'attack.targetingNearest': 'Más cercano',
      'attack.runeSlot': 'Slot de runa ofensiva',
      'attack.spellHint': 'Hechizo ofensivo — elegilo con el selector de magias de abajo.',
      'attack.save': 'Guardar ataque',
      'cavebot.formTitle': 'Cavebot',
      'cavebot.skeletonNote': 'Pausa la ruta por monstruos configurados y la retoma al terminar.',
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
   * Interactive onboarding follows real controls in the same order a safe
   * setup happens. `requires` never unlocks or fabricates game data: the
   * resolver below points to the honest validation control while data is
   * missing. This makes the guide useful on both a fresh disconnected panel
   * and an already-connected character.
   */
  const TUTORIAL_STEPS = [
    { tab: null, key: 'tutorial.connect.title', body: 'tutorial.connect.body', target: '#link-first-btn', kind: 'connect' },
    { tab: null, key: 'tutorial.live.title', body: 'tutorial.live.body', target: '#live-state', requires: 'armed' },
    { tab: 'heal', key: 'tutorial.healSpell.title', body: 'tutorial.healSpell.body', target: '[data-picker-module-btn="healMagic"]', requires: 'catalog' },
    { tab: 'heal', key: 'tutorial.healRules.title', body: 'tutorial.healRules.body', target: '#heal-save-btn', requires: 'hotbar-inventory' },
    { tab: 'trainer', key: 'tutorial.trainerRune.title', body: 'tutorial.trainerRune.body', target: '#trainer-rune-select', requires: 'hotbar' },
    { tab: 'trainer', key: 'tutorial.trainerFallback.title', body: 'tutorial.trainerFallback.body', target: '#trainer-fallback-select', requires: 'hotbar' },
    { tab: 'trainer', key: 'tutorial.trainerCap.title', body: 'tutorial.trainerCap.body', target: '#trainer-cap-mode', requires: 'armed' },
    { tab: null, key: 'tutorial.verify.title', body: 'tutorial.verify.body', target: '#live-state', requires: 'armed' },
  ];

  /**
   * Resolve the step against the data we truly have. A missing dependency is
   * guidance, not an error and never a reason to dispatch a game action.
   * @param {object} state
   * @param {number} index
   * @returns {object|null}
   */
  function tutorialStepFor(state, index) {
    const step = TUTORIAL_STEPS[index];
    if (!step) return null;
    const resolved = Object.assign({}, step, { unavailable: false });
    if (step.kind === 'connect') {
      resolved.target = state.gate === GATE_CONFIRMED ? '#connect-btn'
        : (state.gate === GATE_ARMED ? '#live-state' : '#link-first-btn');
      return resolved;
    }
    if (state.gate !== GATE_ARMED) {
      resolved.target = '#status-bar';
      resolved.body = 'tutorial.connectRequired';
      resolved.unavailable = true;
      return resolved;
    }
    const slots = state.hotbar && Array.isArray(state.hotbar.slots) ? state.hotbar.slots : [];
    const hotbarReady = state.hotbar && state.hotbar.available === true && slots.length > 0;
    const items = liveInventoryItems(state);
    const creatures = state.creatures && Array.isArray(state.creatures.items) ? state.creatures.items : [];
    if (step.requires === 'catalog' && (!state.catalog || state.catalog.loaded !== true || !Array.isArray(state.catalog.spells) || state.catalog.spells.length === 0)) {
      resolved.target = '.spell-picker';
      resolved.body = 'picker.empty';
      resolved.unavailable = true;
    } else if (step.requires === 'hotbar' && !hotbarReady) {
      resolved.target = step.tab === 'trainer' ? '#trainer-rune-select' : '#heal-save-btn';
      resolved.body = 'tutorial.hotbarUnavailable';
      resolved.unavailable = true;
    } else if (step.requires === 'hotbar-inventory' && (!hotbarReady || items.length === 0)) {
      resolved.target = !hotbarReady ? '#heal-save-btn' : '#heal-items-refresh';
      resolved.body = !hotbarReady ? 'tutorial.hotbarUnavailable' : 'tutorial.inventoryUnavailable';
      resolved.unavailable = true;
    } else if (step.requires === 'creatures' && creatures.length === 0) {
      resolved.target = '#cavebot-targeting';
      resolved.body = 'tutorial.creaturesUnavailable';
      resolved.unavailable = true;
    }
    return resolved;
  }

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
      // Slice 1a (REQ-26): product shell state — dashboard opens first.
      tab: 'dashboard',       // active tab id (TABS)
      lang: LANG_EN,           // 'en' | 'es' — default EN (REQ-26)
      soundEnabled: true,      // alert sound toggle — default ON (persisted 'mb-panel-sound')
      tutorial: null,          // null | {step: number} — first-run stepper
      confirmStop: null,       // Slice B (REQ-45, D-B6): null | {pending: true, at} — Stop-Botting confirm overlay
      // Slice B (REQ-46, D-B3): hotkey surface availability + configured
      // F-keys (from /api/hotkeys). available:false drives the display-only
      // degrade (disabled selects + honest note). Default true until the
      // connect-time read lands.
      hotkeys: { available: true, reason: null, configured: { runeKey: 'F4', fallbackKey: 'F5' } },
      // Slice 1b (REQ-27/28): profile cross-load + spell picker state.
      profiles: [],            // character names with saved configs (REQ-27)
      catalog: { spells: [], loaded: false, reason: null }, // filtered client catalog (REQ-28)
      inventory: { containers: [], loaded: false, reason: null }, // live BP/container items for survival + food
      hotbar: { slots: [], loaded: false, available: false, reason: null }, // live spell SID -> F-slot mapping
      creatures: { items: [], loaded: false, reason: null }, // live MiniBia creatures for Cavebot target selection
      // Explicit read-only live-data refresh. This is intentionally separate
      // from persisted configuration: it only describes the last panel read.
      gameDataRefresh: { loading: false, lastUpdatedAt: null, failed: [] },
      picker: { module: 'healMagic', query: '' }, // picker module + search (REQ-28)
      profileLoad: null,       // {ok, from, rejected[], reason, at} — last cross-load (REQ-27)
      // Slice 2 (PR3, REQ-29): HEAL settings form raw values — pure UI
      // strings that survive re-renders (walkTo precedent); SAVE_HEAL_SETTINGS
      // converts + commits them into config.modules.healMagic.
      healForm: { mode: '', threshold: '', reserve: '', itemThreshold: '', itemCids: '', manaEnabled: '', manaItemThreshold: '', manaItemCids: '' },
      // Slice 3 (PR4, REQ-30/31/32): TRAINER settings form raw values — pure
      // UI strings (percent/ratio conversion at save, see SAVE_TRAINER_SETTINGS).
      // Slice B (REQ-42..46): runeSid (inline rune select, D-B2), the F-key
      // hotkey selects (D-B3) and the toggle switches (D-B4) extend the form.
      trainerForm: {
        capMode: '', capFullThreshold: '', fallbackSid: '', fallbackManaPct: '', reserve: '',
        runeSid: '', autoFallback: '', stopRuneMaking: '', stopBotting: '',
        foodMagicEnabled: '', foodMagicSid: '', foodEveryRunes: '',
      },
      // Slice 5 (PR5, REQ-33/34): OTHERS settings form raw values — pure UI
      // strings (food slot, every-N-casts, loot default destination, anti-bot
      // replies as `pattern => reply` lines) that survive re-renders;
      // SAVE_OTHERS_SETTINGS parses + commits them into the config.
      othersForm: { foodSlot: '', everyCasts: '', foodMagicEnabled: '', foodMagicSid: '', safetyNet: '', lootDest: '', antibotReplies: '' },
      // Slice 7 (PR6, REQ-35/36): ATTACK settings form raw values (pure UI
      // strings that survive re-renders — targeting select + rune slot; the
      // spell sid comes from the picker) + the cavebot recorded-route result
      // (CAVEBOT_RECORDED -> Save writes config.routes, REQ-36).
      attackForm: { targeting: '', runeSlot: '' },
      cavebotForm: { monsters: [], targeting: '' },
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
    const modules = state.config && state.config.modules || {};
    const hm = modules.healMagic || {};
    const hi = modules.healItems || {};
    const mi = modules.manaItems || {};
    const stats = snapshotStats(state.snapshot);
    const toPct = (value, max) => {
      if (!Number.isFinite(Number(value))) return '';
      return max !== null && max > 0 ? String(Math.round(Number(value) / max * 100)) : String(value);
    };
    const magicOn = state.modules && state.modules.healMagic === true || hm.on === true;
    const itemsOn = state.modules && state.modules.healItems === true || hi.on === true;
    const mode = magicOn && itemsOn ? 'both' : itemsOn ? 'items' : 'magic';
    return {
      mode,
      threshold: toPct(hm.threshold, stats.maxHealth),
      reserve: toPct(hm.reserve, stats.maxMana),
      itemThreshold: toPct(hi.threshold, stats.maxHealth),
      itemCids: Array.isArray(hi.slotCids) ? hi.slotCids.map(Number).filter(Number.isFinite).join(',') : '',
      manaEnabled: mi.on === true ? 'true' : 'false',
      manaItemThreshold: toPct(mi.threshold, stats.maxMana),
      manaItemCids: Array.isArray(mi.slotCids) ? mi.slotCids.map(Number).filter(Number.isFinite).join(',') : '',
    };
  }

  function selectedItemCids(state, form, key) {
    const derived = healFormFromConfig(state);
    const source = form && form[key] !== '' && form[key] !== undefined ? form[key] : derived[key];
    return String(source || '').split(',').map((v) => v.trim()).filter(Boolean).map(Number)
      .filter((v, index, list) => Number.isInteger(v) && v >= 0 && list.indexOf(v) === index);
  }

  function selectedHealItemCids(state, form) { return selectedItemCids(state, form, 'itemCids'); }
  function selectedManaItemCids(state, form) { return selectedItemCids(state, form, 'manaItemCids'); }

  function hotbarSlotForSpell(state, sid) {
    const wanted = Number(sid);
    if (!Number.isInteger(wanted)) return null;
    const slots = state.hotbar && Array.isArray(state.hotbar.slots) ? state.hotbar.slots : [];
    const found = slots.filter((entry) => Number(entry && entry.sid) === wanted)[0] || null;
    const slot = Number(found && found.slot);
    return Number.isInteger(slot) && slot >= 1 && slot <= 12 ? slot : null;
  }

  function hasSpellSid(value) {
    return value !== null && value !== undefined && value !== '' && Number.isInteger(Number(value));
  }

  function liveInventoryItems(state) {
    const containers = state.inventory && Array.isArray(state.inventory.containers) ? state.inventory.containers : [];
    const seen = new Set();
    const out = [];
    for (const container of containers) {
      for (const item of (container && container.items) || []) {
        const cid = Number(item && item.cid);
        if (!Number.isInteger(cid) || seen.has(cid)) continue;
        seen.add(cid);
        out.push(item);
      }
    }
    return out;
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
    const threshold = Number(runes.capFullThreshold);
    const pct = Number(runes.fallbackManaPct);
    const runeSid = Number(training.sid);
    const fallbackSid = Number(runes.fallbackSid);
    return {
      capMode: runes.capMode === 'off' ? 'off' : 'strict',
      capFullThreshold: String(Number.isFinite(threshold) && threshold > 0 ? Math.round(threshold * 100) : 100),
      fallbackSid: hasSpellSid(runes.fallbackSid) ? String(fallbackSid) : '',
      fallbackManaPct: String(Number.isFinite(pct) ? Math.round(pct * 100) : 50),
      reserve: Number.isFinite(Number(training.reserve)) ? String(training.reserve) : '0',
      runeSid: hasSpellSid(training.sid) ? String(runeSid) : '',
      autoFallback: hasSpellSid(runes.fallbackSid) ? 'true' : 'false',
      stopRuneMaking: training.stopRuneMaking === true ? 'true' : 'false',
      stopBotting: training.stopBotting === true ? 'true' : 'false',
      foodMagicEnabled: training.eatWithMagic && training.eatWithMagic.enabled === true ? 'true' : 'false',
      foodMagicSid: hasSpellSid(training.eatWithMagic && training.eatWithMagic.sid) ? String(Number(training.eatWithMagic.sid)) : '',
      foodEveryRunes: String(Math.max(1, Math.floor(Number(training.eatWithMagic && training.eatWithMagic.everyRunes) || 1))),
    };
  }

  /** Slice B (REQ-46, D-B3): the F-key selectable hotkeys. */
  const FKEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

  function spellText(spell) {
    return String([spell && spell.name, spell && spell.words, spell && spell.description]
      .filter(Boolean).join(' ')).toLowerCase();
  }

  function isPlaceholderSpell(spell) {
    return String(spell && spell.name || '').toLowerCase() === 'unknown' && !spell.words;
  }

  function isRuneCreationSpell(spell) {
    const text = spellText(spell);
    return /\brune\b/.test(text) || /\badori\b/.test(text) || /create[s]?\s+.*rune/.test(text);
  }

  function isHealingSpell(spell) {
    const text = spellText(spell);
    return !isRuneCreationSpell(spell)
      && (/\bheal/.test(text) || /\bexura\b/.test(text) || /\bsio\b/.test(text) || /\bvita\b/.test(text));
  }

  function isAttackSpell(spell) {
    const text = spellText(spell);
    return !isRuneCreationSpell(spell) && !isHealingSpell(spell)
      && (/\bdamage\b|\bstrike\b|\battack\b|\bforce\b|\bfire\b|\benergy\b|\bpoison\b|\bdeath\b|\bexplosion\b|\bwave\b|\bbeam\b|\bexori\b|\bexevo\b/.test(text));
  }

  /** MiniTibia exposes a live spell catalog, not a canonical spell type. Food
   * creation therefore has to be positively identified from its own metadata;
   * never treat a generic exevo/heal/attack spell as food just because it is
   * selectable. `exevo pan` and the live Food entry are the supported shape. */
  function isFoodCreationSpell(spell) {
    const text = spellText(spell);
    return /\bexevo\s+pan\b/.test(text)
      || /\bfood\b/.test(text)
      || /\b(create|creates|conjure|conjures)\b.*\b(food|bread|pan)\b/.test(text);
  }

  function spellMatchesPickerModule(spell, module) {
    if (module === 'training') return isRuneCreationSpell(spell);
    if (module === 'healMagic') return isHealingSpell(spell);
    if (module === 'attack') return isAttackSpell(spell);
    return true;
  }

  /**
   * Slice B (REQ-42, D-B2): catalog rows filtered to rune-creation spells.
   * The live client exposes name/words/description, not a canonical type flag,
   * so the panel classifies by those extracted fields and keeps a full-list
   * fallback only when the client catalog carries no obvious rune makers. Pure.
   * @param {object} state
   * @returns {{runes: Array, list: Array, fallback: boolean}}
   */
  function filterRuneCatalog(state) {
    const spells = (state.catalog && state.catalog.spells) || [];
    const runes = spells.filter((s) => s && typeof s === 'object' && isRuneCreationSpell(s));
    return { runes, list: runes.length > 0 ? runes : spells, fallback: runes.length === 0 && spells.length > 0 };
  }

  /** Live spells suitable as a CAP fallback. Rune makers are excluded because
   * the fallback must be an alternate action, not a second creation spell. */
  function filterFallbackCatalog(state) {
    const spells = (state.catalog && state.catalog.spells) || [];
    return spells.filter((s) => s && typeof s === 'object'
      && !isPlaceholderSpell(s) && !isRuneCreationSpell(s));
  }

  function filterFoodCatalog(state) {
    const spells = (state.catalog && state.catalog.spells) || [];
    return spells.filter((spell) => spell && typeof spell === 'object'
      && !isPlaceholderSpell(spell) && isFoodCreationSpell(spell));
  }

  /** Reconcile persisted Trainer slots to the live F1–F12 catalog. A slot
   * change is safe to update by SID; a missing mapping is NOT safe: disable
   * Trainer before the old slot can invoke an unrelated spell. */
  function reconcileTrainerHotbar(state, slots) {
    const config = state.config;
    // During Connect profile config commonly arrives before the independent
    // hotbar request. Do not disarm on that temporary unknown; reconcile only
    // after a real hotbar response has settled.
    if (!state.hotbar || state.hotbar.loaded !== true || !config || !config.modules || !config.modules.training) {
      return { state, changed: false, issue: null };
    }
    const live = Array.isArray(slots) ? slots : [];
    const slotFor = (sid) => {
      const found = live.find((entry) => Number(entry && entry.sid) === Number(sid));
      const slot = Number(found && found.slot);
      return Number.isInteger(slot) && slot >= 1 && slot <= 12 ? slot : null;
    };
    const next = JSON.parse(JSON.stringify(config));
    const training = next.modules.training || {};
    const runes = next.modules.runes || (next.modules.runes = {});
    const mappings = [];
    if (hasSpellSid(training.sid)) mappings.push({ key: 'rune', sid: Number(training.sid), object: training, property: 'slot' });
    if (hasSpellSid(runes.fallbackSid)) mappings.push({ key: 'fallback', sid: Number(runes.fallbackSid), object: runes, property: 'fallbackSlot' });
    const food = training.eatWithMagic;
    if (food && food.enabled === true && hasSpellSid(food.sid)) mappings.push({ key: 'food', sid: Number(food.sid), object: food, property: 'slot' });
    if (mappings.length === 0) return { state, changed: false, issue: null };
    const missing = mappings.find((mapping) => slotFor(mapping.sid) === null);
    if (missing) {
      training.on = false;
      const modules = Object.assign({}, state.modules, { training: false });
      const issue = { key: missing.key, sid: missing.sid, kind: 'missing' };
      return { state: Object.assign({}, state, { modules, config: next, trainerHotbarIssue: issue }), changed: true, issue };
    }
    let changed = false;
    for (const mapping of mappings) {
      const slot = slotFor(mapping.sid);
      if (Number(mapping.object[mapping.property]) !== slot) {
        mapping.object[mapping.property] = slot;
        changed = true;
      }
    }
    const issue = null;
    return { state: Object.assign({}, state, { config: next, trainerHotbarIssue: issue }), changed, issue };
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

  /** Cyber cockpit selected-spell card: image when the client catalog provides
   *  one, deterministic glyph fallback otherwise, plus the real client data we
   *  have already extracted. This keeps the forms readable without inventing
   *  missing data. */
  function spellFromCatalog(state, sid) {
    const list = state && state.catalog && Array.isArray(state.catalog.spells) ? state.catalog.spells : [];
    if (sid === '' || sid === null || sid === undefined) return null;
    const n = Number(sid);
    if (!Number.isInteger(n)) return null;
    for (let i = 0; i < list.length; i += 1) {
      if (Number(list[i] && list[i].sid) === n) return list[i];
    }
    return { sid: n, name: 'SID ' + n, words: '', mana: null, level: null };
  }

  function renderSpellCard(state, moduleId, title, sid) {
    const spell = spellFromCatalog(state, sid);
    const empty = !spell;
    const name = empty ? 'No spell selected' : String(spell.name || ('SID ' + spell.sid));
    const image = spell && [spell.imageDataURL, spell.image, spell.iconUrl, spell.imageUrl]
      .find((v) => typeof v === 'string' && v);
    const glyph = name.trim().slice(0, 2).toUpperCase() || '∅';
    const thumb = image
      ? '<span class="spell-card-icon"><img alt="" src="' + escapeHtml(image) + '"></span>'
      : '<span class="spell-card-icon spell-card-fallback">' + escapeHtml(glyph) + '</span>';
    const liveSlot = spell ? hotbarSlotForSpell(state, spell.sid) : null;
    // The panel speaks in game concepts (cost, level and real F-key), never
    // implementation ids. The game catalog remains the only source of truth.
    const chips = spell ? [
      'MP ' + (spell.mana === null || spell.mana === undefined ? '—' : String(spell.mana)),
      'LV ' + (spell.level === null || spell.level === undefined ? '—' : String(spell.level)),
      liveSlot === null ? 'F —' : 'F' + String(liveSlot),
    ] : ['Pick from live catalog'];
    if (spell && (spell.vocation || spell.vocationLabel)) chips.push(String(spell.vocation || spell.vocationLabel));
    if (spell && (spell.cooldown || spell.cooldownMs)) chips.push('CD ' + String(spell.cooldown || spell.cooldownMs));
    return '<div class="spell-card" data-selected-spell="' + escapeHtml(moduleId) + '">'
      + '<div class="spell-card-title">' + escapeHtml(title) + '</div>'
      + '<div class="spell-card-body">' + thumb
      + '<div class="spell-card-main"><strong>' + escapeHtml(name) + '</strong>'
      + (spell && spell.words ? '<code>' + escapeHtml(String(spell.words)) + '</code>' : '<code>—</code>')
      + (spell && spell.description ? '<small class="spell-card-description">' + escapeHtml(String(spell.description)) + '</small>' : '')
      + '<div class="spell-card-chips">' + chips.map((c) => '<span>' + escapeHtml(c) + '</span>').join('') + '</div>'
      + '</div></div></div>';
  }

  /** Compact operational summary for Trainer. It only derives information
   * from the connected snapshot, catalog and live F1–F12 mapping. */
  function renderTrainerExecutionCard(state, stats, runeSpell, requiredMana, foodSid, foodEnabled) {
    const snapshot = state.snapshot && typeof state.snapshot === 'object' ? state.snapshot : {};
    const training = (snapshot.agent && snapshot.agent.training) || snapshot.training || null;
    const es = state.lang === LANG_ES;
    const say = (spanish, english) => es ? spanish : english;
    const mana = stats.mana;
    const configured = runeSpell && hotbarSlotForSpell(state, runeSpell.sid) !== null;
    let status = renderTrainerRuntimeStatus(state, training, stats);
    if (!status) {
      if (!configured) status = say('Elegí una runa del catálogo vivo y colocala en F1–F12.', 'Choose a live rune spell and put it on F1–F12.');
      else if (mana === null || requiredMana === null) status = say('Actualizá los datos del juego para leer maná y hotbar.', 'Refresh game data to read mana and hotbar.');
      else if (mana < requiredMana) status = say('Esperando maná: ' + Math.floor(mana) + '/' + requiredMana + ' MP.', 'Waiting for mana: ' + Math.floor(mana) + '/' + requiredMana + ' MP.');
      else status = say('Lista para lanzar la runa en el próximo ciclo del juego.', 'Ready to cast the rune on the next game cycle.');
    }
    const next = foodEnabled && foodSid
      ? say('Después de las runas configuradas: crea y come comida nueva.', 'After the configured rune count: creates and consumes new food.')
      : say('Siguiente acción: crear runa al llegar al maná requerido.', 'Next action: create the rune at required mana.');
    return '<section class="trainer-execution-card" aria-live="polite">'
      + '<div class="trainer-execution-head"><div><span>' + escapeHtml(say('Ejecución en vivo', 'Live execution')) + '</span><strong>' + escapeHtml(next) + '</strong></div>'
      + '<button type="button" class="trainer-refresh-btn" data-refresh-game-data>' + escapeHtml(say('Actualizar datos', 'Refresh data')) + '</button></div>'
      + '<div class="trainer-execution-metrics">'
      + '<div><small>' + escapeHtml(say('Maná actual', 'Current mana')) + '</small><b>' + escapeHtml(mana === null ? '—' : String(Math.floor(mana))) + ' / ' + escapeHtml(stats.maxMana === null ? '—' : String(Math.floor(stats.maxMana))) + '</b></div>'
      + '<div><small>' + escapeHtml(say('Requerido', 'Required')) + '</small><b>' + escapeHtml(requiredMana === null ? '—' : String(requiredMana)) + ' MP</b></div>'
      + '<div><small>' + escapeHtml(say('Runa', 'Rune')) + '</small><b>' + escapeHtml(runeSpell ? String(runeSpell.name || '—') : '—') + '</b></div>'
      + '</div><p class="trainer-execution-status">' + escapeHtml(status) + '</p></section>';
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
    const magic = eat.magic && typeof eat.magic === 'object' ? eat.magic : {};
    const loot = cfg.loot || {};
    const antibot = cfg.antibot || {};
    const replies = Array.isArray(antibot.replies) ? antibot.replies : [];
    return {
      foodSlot: eat.slot !== null && eat.slot !== undefined ? String(eat.slot) : '',
      everyCasts: Number.isFinite(Number(eat.everyCasts)) ? String(eat.everyCasts) : '',
      // PR 4 (REQ-01): the unified magic toggle + spell + safety net derive
      // from modules.eat (the only food config surface left).
      foodMagicEnabled: magic.enabled === true ? 'true' : 'false',
      foodMagicSid: hasSpellSid(magic.sid) ? String(Number(magic.sid)) : '',
      safetyNet: Number.isFinite(Number(eat.safetyNetMinutes)) ? String(eat.safetyNetMinutes) : '',
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

  /** Save failures are configuration problems, never a runtime mana state.
   * Keep the prefix translated and preserve the server detail for action. */
  function configSaveFailureText(state, reason) {
    const detail = String(reason || 'save rejected');
    return state.lang === LANG_ES
      ? 'No se pudo guardar la configuración: ' + detail
      : 'Could not save configuration: ' + detail;
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
    const es = state.lang === LANG_ES;
    const invalid = (en, esText) => ({ ok: false, refusal: {
      action: 'SAVE_TRAINER_SETTINGS', module: 'training', reason: es ? esText : en, at,
    } });
    const capMode = String(form.capMode || '').trim() || 'strict';
    const rawThreshold = String(form.capFullThreshold || '').trim();
    const rawFallbackPct = String(form.fallbackManaPct || '').trim();
    const rawReserve = String(form.reserve || '').trim();
    const runeSidRaw = String(form.runeSid || '').trim();
    const fallbackSidRaw = String(form.fallbackSid || '').trim();
    const foodMagicEnabled = String(form.foodMagicEnabled || '') || 'false';
    const foodMagicSidRaw = String(form.foodMagicSid || '').trim();
    const rawFoodEveryRunes = String(form.foodEveryRunes || '').trim();
    const autoFallback = String(form.autoFallback || '') || 'false';
    const stopRuneMaking = String(form.stopRuneMaking || '') || 'false';
    const stopBotting = String(form.stopBotting || '') || 'false';
    if (capMode !== 'strict' && capMode !== 'off') return invalid('Choose a CAP policy: Strict or Off.', 'Elegí una política de capacidad: Estricto o Apagado.');
    const cap = snapshotCap(state.snapshot);
    const capAvailable = Boolean(cap && cap.ratio !== null);
    const threshold = rawThreshold === '' ? 100 : Number(rawThreshold);
    const fallbackPct = rawFallbackPct === '' ? 50 : Number(rawFallbackPct);
    const reserve = rawReserve === '' ? 0 : Number(rawReserve);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      return invalid('Fix “CAP full at %”: enter 0–100 (100 is the safe default).', 'Corregí “Tope lleno al %”: ingresá 0–100 (100 es el valor seguro).');
    }
    if (!Number.isFinite(fallbackPct) || fallbackPct < 0 || fallbackPct > 100) {
      return invalid('Fix “Fallback mana %”: enter 0–100.', 'Corregí “Maná para alternativa %”: ingresá 0–100.');
    }
    if (!Number.isFinite(reserve) || reserve < 0) {
      return invalid('Fix “Mana reserve”: enter 0 or more.', 'Corregí “Reserva de maná”: ingresá 0 o más.');
    }
    const spells = (state.catalog && state.catalog.spells) || [];
    const findSpell = (raw) => {
      const sid = Number(raw);
      return Number.isInteger(sid) ? spells.filter((spell) => Number(spell && spell.sid) === sid)[0] || null : null;
    };
    const runeSpell = findSpell(runeSidRaw);
    if (!runeSpell || !isRuneCreationSpell(runeSpell)) {
      return invalid('Choose a live rune-making spell in “Select Rune to Create”.', 'Elegí una magia real para fabricar runas en “Elegir runa a crear”.');
    }
    const runeSlot = hotbarSlotForSpell(state, runeSpell.sid);
    if (runeSlot === null) {
      return invalid('Add the selected rune spell to F1–F12 in the game, refresh Live hotbar, then save.', 'Agregá la runa elegida a F1–F12 en el juego, refrescá el hotbar vivo y guardá.');
    }
    if (autoFallback !== 'true' && autoFallback !== 'false') return invalid('Set Automatic fallback to On or Off.', 'Definí Magia alternativa automática en activada o desactivada.');
    let fallbackSpell = null;
    let fallbackSlot = null;
    if (autoFallback === 'true') {
      fallbackSpell = findSpell(fallbackSidRaw);
      if (!fallbackSpell || isRuneCreationSpell(fallbackSpell)) {
        return invalid('Choose a live non-rune fallback spell, or turn Automatic fallback off.', 'Elegí una magia alternativa real que no sea runa, o apagá la alternativa automática.');
      }
      fallbackSlot = hotbarSlotForSpell(state, fallbackSpell.sid);
      if (fallbackSlot === null) {
        return invalid('Add the selected fallback spell to F1–F12 in the game, refresh Live hotbar, then save.', 'Agregá la magia alternativa a F1–F12 en el juego, refrescá el hotbar vivo y guardá.');
      }
    }
    if (foodMagicEnabled !== 'true' && foodMagicEnabled !== 'false') return invalid('Set Food magic to On or Off.', 'Definí Magia de comida en activada o desactivada.');
    let foodSpell = null;
    let foodSlot = null;
    let foodEveryRunes = 1;
    if (foodMagicEnabled === 'true') {
      foodSpell = findSpell(foodMagicSidRaw);
      if (!foodSpell || !isFoodCreationSpell(foodSpell)) {
        return invalid('Choose your food spell from the live catalog (for example, exevo pan).', 'Elegí tu magia de comida del catálogo vivo (por ejemplo, exevo pan).');
      }
      foodSlot = hotbarSlotForSpell(state, foodSpell.sid);
      if (foodSlot === null) {
        return invalid('Add the selected food spell to F1–F12 in the game, refresh Live hotbar, then save.', 'Agregá la magia de comida a F1–F12 en el juego, refrescá el hotbar vivo y guardá.');
      }
      foodEveryRunes = Number(rawFoodEveryRunes === '' ? '1' : rawFoodEveryRunes);
      if (!Number.isInteger(foodEveryRunes) || foodEveryRunes < 1) {
        return invalid('Fix “Cast food every N runes”: enter 1 or more.', 'Corregí “Lanzar comida cada N runas”: ingresá 1 o más.');
      }
    }
    if (stopRuneMaking !== 'true' && stopRuneMaking !== 'false') return invalid('Set Stop rune-making to On or Off.', 'Definí Detener fabricación de runas en activada o desactivada.');
    if (stopBotting !== 'true' && stopBotting !== 'false') return invalid('Set Stop botting to On or Off.', 'Definí Detener el bot en activada o desactivada.');
    const config = JSON.parse(JSON.stringify(state.config || {}));
    if (!config.modules || typeof config.modules !== 'object') config.modules = {};
    if (!config.modules.runes || typeof config.modules.runes !== 'object') config.modules.runes = {};
    if (!config.modules.training || typeof config.modules.training !== 'object') config.modules.training = {};
    config.modules.runes.capMode = capMode;
    // CAP is absent in some live MiniBia versions. Strict remains safely
    // configured at 100%, while the agent explicitly ignores unknown CAP.
    config.modules.runes.capFullThreshold = capAvailable ? threshold / 100 : 1;
    config.modules.runes.fallbackSid = fallbackSpell ? Number(fallbackSpell.sid) : null;
    config.modules.runes.fallbackSlot = fallbackSlot;
    config.modules.runes.fallbackManaPct = fallbackPct / 100;
    config.modules.training.sid = Number(runeSpell.sid);
    config.modules.training.slot = runeSlot;
    config.modules.training.word = typeof runeSpell.words === 'string' ? runeSpell.words : null;
    config.modules.training.reserve = reserve;
    config.modules.training.eatWithMagic = {
      enabled: foodMagicEnabled === 'true', slot: foodSlot,
      sid: foodSpell ? Number(foodSpell.sid) : null, everyRunes: foodEveryRunes,
    };
    config.modules.training.stopRuneMaking = stopRuneMaking === 'true';
    config.modules.training.stopBotting = stopBotting === 'true';
    const modules = Object.assign({}, state.modules);
    if (stopRuneMaking === 'true' || stopBotting === 'true') {
      modules.training = false;
      config.modules.training.on = false;
    }
    return {
      ok: true,
      state: Object.assign({}, state, {
        modules, config,
        trainerForm: {
          capMode, capFullThreshold: String(capAvailable ? threshold : 100), fallbackSid: fallbackSpell ? String(fallbackSpell.sid) : '',
          fallbackManaPct: String(fallbackPct), reserve: String(reserve), runeSid: String(runeSpell.sid),
          autoFallback, stopRuneMaking, stopBotting,
          foodMagicEnabled, foodMagicSid: foodSpell ? String(foodSpell.sid) : '', foodEveryRunes: String(foodEveryRunes),
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

      case 'ATTACH_FIRST':
        return {
          state: Object.assign({}, state, { gate: GATE_PROBING, refusal: null, lastError: null }),
          effects: [{ type: 'attach-first' }],
        };

      case 'ATTACH_FIRST_FAILED':
        return {
          state: Object.assign({}, state, { gate: GATE_DISCONNECTED, lastError: action.message || 'attach failed' }),
          effects: [],
        };

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
        // REQ-09 (slice C, PR 1): single toggle truth — the toggle ALSO
        // writes config.modules[id].on, so the config the push-config effect
        // persists is exactly what the panel shows. Config and live state
        // never diverge.
        const config = Object.assign({}, state.config, {
          modules: Object.assign({}, state.config && state.config.modules, {
            [action.module]: Object.assign(
              {}, state.config && state.config.modules && state.config.modules[action.module],
              { on: action.on === true },
            ),
          }),
        });
        return {
          state: Object.assign({}, state, { modules, config, refusal: null }),
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
        // A profile is a new source of truth. Never retain an unsaved Trainer
        // draft from the prior profile: on the next Save it could overwrite
        // this profile with stale rune/food values.
        const prefilled = Object.assign({}, state, {
          modules, config: config || null, trainerForm: {
            capMode: '', capFullThreshold: '', fallbackSid: '', fallbackManaPct: '', reserve: '', runeSid: '',
            autoFallback: '', stopRuneMaking: '', stopBotting: '',
            foodMagicEnabled: '', foodMagicSid: '', foodEveryRunes: '',
          },
          refusal: null,
        });
        const reconciled = reconcileTrainerHotbar(prefilled, prefilled.hotbar && prefilled.hotbar.slots);
        return { state: reconciled.state, effects: reconciled.changed ? [{ type: 'push-config' }] : [] };
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

      case 'CONFIG_SAVE_RESULT':
        if (action.ok === true) {
          return { state: Object.assign({}, state, { refusal: null, lastError: null }), effects: [] };
        }
        return {
          state: Object.assign({}, state, {
            lastError: null,
            refusal: {
              action: 'SAVE_CONFIGURATION', module: action.module || null,
              reason: configSaveFailureText(state, action.reason), at: Date.now(),
            },
          }), effects: [],
        };

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
        // Advance one step and walk the tour to the step's real control tab.
        // Past the last step the tutorial ends with the 'tutorial-seen'
        // effect (app.js persists localStorage so it never shows again).
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

      case 'TUTORIAL_BACK': {
        // Back is intentionally UI-only: it neither saves nor changes a bot
        // module. The target tab follows the previous instructional step.
        if (state.tutorial === null || state.tutorial.step <= 0) return { state, effects: [] };
        const previousStep = state.tutorial.step - 1;
        const stepTab = TUTORIAL_STEPS[previousStep].tab;
        return {
          state: Object.assign({}, state, {
            tutorial: { step: previousStep },
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
        // Pick a spell for a module. The list is ALREADY filtered to what the
        // current vocation can cast. Current mana never blocks selection or
        // saving: the live agent waits until cost + reserve before firing.
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
        const config = JSON.parse(JSON.stringify(state.config || {}));
        if (!config.modules || typeof config.modules !== 'object') config.modules = {};
        if (!config.modules[module] || typeof config.modules[module] !== 'object') {
          config.modules[module] = {};
        }
        config.modules[module].sid = sid;
        const nextTrainerForm = module === 'training'
          ? Object.assign({}, state.trainerForm || {}, { runeSid: String(sid) })
          : state.trainerForm;
        return {
          state: Object.assign({}, state, { config, trainerForm: nextTrainerForm, refusal: null }),
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
        // Survival flow values survive all re-renders. Item selection is kept
        // as a CID list internally; the UI only exposes live item cards.
        const key = String(action.key || '');
        if (['mode', 'threshold', 'reserve', 'itemThreshold', 'itemCids', 'manaEnabled', 'manaItemThreshold', 'manaItemCids'].indexOf(key) === -1) {
          return { state, effects: [] };
        }
        const healForm = Object.assign({}, state.healForm || {
          mode: '', threshold: '', reserve: '', itemThreshold: '', itemCids: '', manaEnabled: '', manaItemThreshold: '', manaItemCids: '',
        });
        healForm[key] = String(action.value === null || action.value === undefined ? '' : action.value);
        return { state: Object.assign({}, state, { healForm }), effects: [] };
      }

      case 'TOGGLE_HEAL_ITEM': {
        const cid = Number(action.cid);
        if (!Number.isInteger(cid) || cid < 0) return { state, effects: [] };
        const form = Object.assign({}, state.healForm || {});
        const key = action.kind === 'mana' ? 'manaItemCids' : 'itemCids';
        const selected = selectedItemCids(state, form, key);
        const at = selected.indexOf(cid);
        if (at === -1) selected.push(cid);
        else selected.splice(at, 1);
        form[key] = selected.join(',');
        return { state: Object.assign({}, state, { healForm: form }), effects: [] };
      }

      case 'INVENTORY_LOADED':
        return {
          state: Object.assign({}, state, {
            inventory: {
              containers: Array.isArray(action.containers) ? action.containers : [],
              loaded: action.ok !== false,
              reason: action.reason || null,
            },
          }),
          effects: [],
        };

      case 'HOTBAR_CATALOG':
        {
          const withHotbar = Object.assign({}, state, {
            hotbar: {
              slots: Array.isArray(action.slots) ? action.slots : [],
              loaded: action.ok !== false,
              available: action.available === true,
              reason: action.reason || null,
            },
          });
          const reconciled = reconcileTrainerHotbar(withHotbar, withHotbar.hotbar.slots);
          return { state: reconciled.state, effects: reconciled.changed ? [{ type: 'push-config' }] : [] };
        }

      case 'CREATURE_CATALOG':
        return {
          state: Object.assign({}, state, {
            creatures: { items: Array.isArray(action.creatures) ? action.creatures : [], loaded: action.ok !== false, reason: action.reason || null },
          }), effects: [],
        };

      case 'REFRESH_GAME_DATA':
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        if (state.gameDataRefresh && state.gameDataRefresh.loading) return { state, effects: [] };
        return {
          state: Object.assign({}, state, {
            gameDataRefresh: Object.assign({}, state.gameDataRefresh || {}, { loading: true, failed: [] }),
            refusal: null,
            lastError: null,
          }),
          effects: [{ type: 'refresh-game-data' }],
        };

      case 'GAME_DATA_REFRESH_FINISHED':
        return {
          state: Object.assign({}, state, {
            gameDataRefresh: {
              loading: false,
              lastUpdatedAt: Number.isFinite(Number(action.at)) ? Number(action.at) : Date.now(),
              failed: Array.isArray(action.failed) ? action.failed.slice() : [],
            },
          }),
          effects: [],
        };

      case 'REFRESH_INVENTORY':
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        return { state, effects: [{ type: 'refresh-inventory' }] };

      case 'SAVE_HEAL_SETTINGS': {
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const form = state.healForm || {};
        const derived = healFormFromConfig(state);
        const val = (key) => (form[key] !== '' && form[key] !== undefined ? form[key] : derived[key]);
        // Hidden-module scope: the HP-potion + mana-potion surfaces are gone
        // from the UI, so the survival form is ALWAYS magic-only. The items /
        // mana configs are left exactly as the server returned them — saving
        // healMagic settings never flips a hidden module off or wipes it.
        const itemsHidden = HIDDEN_MODULES.has('healItems');
        const manaHidden = HIDDEN_MODULES.has('manaItems');
        const mode = itemsHidden && manaHidden ? 'magic' : String(val('mode') || 'magic');
        const magicOn = mode === 'magic' || mode === 'both';
        const itemsOn = itemsHidden ? false : (mode === 'items' || mode === 'both');
        const manaItemsOn = manaHidden ? false : String(val('manaEnabled')) === 'true';
        const at = Date.now();
        if (!magicOn && !itemsOn) {
          return { state: Object.assign({}, state, { refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'healMagic', reason: 'invalid survival settings — choose magic, items or both', at } }), effects: [] };
        }
        const stats = snapshotStats(state.snapshot);
        const maxHp = stats.maxHealth;
        const maxMana = stats.maxMana;
        if ((magicOn || itemsOn) && (maxHp === null || !Number.isFinite(maxHp))) {
          return { state: Object.assign({}, state, { refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'healMagic', reason: 'unknown max health — wait for a snapshot', at } }), effects: [] };
        }
        if ((magicOn || manaItemsOn) && (maxMana === null || !Number.isFinite(maxMana))) {
          return { state: Object.assign({}, state, { refusal: { action: 'SAVE_HEAL_SETTINGS', module: magicOn ? 'healMagic' : 'manaItems', reason: 'unknown max mana — wait for a snapshot', at } }), effects: [] };
        }
        const thresholdPct = Number(String(val('threshold') || '').trim());
        const itemThresholdPct = Number(String(val('itemThreshold') || '').trim());
        const manaPct = Number(String(val('reserve') || '').trim());
        const manaItemThresholdPct = Number(String(val('manaItemThreshold') || '').trim());
        const itemCids = selectedHealItemCids(state, form);
        const manaItemCids = selectedManaItemCids(state, form);
        const config = JSON.parse(JSON.stringify(state.config || {}));
        if (!config.modules || typeof config.modules !== 'object') config.modules = {};
        const hm = config.modules.healMagic || {};
        const selectedSid = Number(hm.sid);
        const magicSlot = hotbarSlotForSpell(state, selectedSid);
        if (magicOn && (!Number.isFinite(thresholdPct) || thresholdPct < 0 || thresholdPct > 100
          || !Number.isFinite(manaPct) || manaPct < 0 || manaPct > 100
          || !Number.isInteger(selectedSid))) {
          return { state: Object.assign({}, state, { refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'healMagic', reason: 'invalid magic heal — choose a healing spell and set health/mana percentages from 0 to 100', at } }), effects: [] };
        }
        if (magicOn && magicSlot === null) {
          return { state: Object.assign({}, state, { refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'healMagic', reason: 'selected heal spell is not in the live hotbar — add it in the game first', at } }), effects: [] };
        }
        if (itemsOn && (!Number.isFinite(itemThresholdPct) || itemThresholdPct < 0 || itemThresholdPct > 100 || itemCids.length === 0)) {
          return { state: Object.assign({}, state, { refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'healItems', reason: 'invalid HP potion setup — select at least one backpack item and set health 0-100%', at } }), effects: [] };
        }
        if (manaItemsOn && (!Number.isFinite(manaItemThresholdPct) || manaItemThresholdPct < 0 || manaItemThresholdPct > 100 || manaItemCids.length === 0)) {
          return { state: Object.assign({}, state, { refusal: { action: 'SAVE_HEAL_SETTINGS', module: 'manaItems', reason: 'invalid mana potion setup — select at least one backpack item and set mana 0-100%', at } }), effects: [] };
        }
        config.modules.healMagic = hm;
        config.modules.healMagic.on = magicOn;
        if (magicOn) {
          config.modules.healMagic.threshold = Math.max(0, Math.round(maxHp * thresholdPct / 100));
          config.modules.healMagic.slot = magicSlot;
          config.modules.healMagic.reserve = Math.max(0, Math.round(maxMana * manaPct / 100));
        }
        if (itemsOn) {
          config.modules.healItems = config.modules.healItems || {};
          config.modules.healItems.on = itemsOn;
          config.modules.healItems.threshold = Math.max(0, Math.round(maxHp * itemThresholdPct / 100));
          config.modules.healItems.slotCids = itemCids;
        }
        if (manaItemsOn) {
          config.modules.manaItems = config.modules.manaItems || {};
          config.modules.manaItems.on = manaItemsOn;
          config.modules.manaItems.threshold = Math.max(0, Math.round(maxMana * manaItemThresholdPct / 100));
          config.modules.manaItems.slotCids = manaItemCids;
        }
        const modules = Object.assign({}, state.modules, { healMagic: magicOn });
        if (!itemsHidden) modules.healItems = itemsOn;
        if (!manaHidden) modules.manaItems = manaItemsOn;
        return {
          state: Object.assign({}, state, {
            modules, config,
            healForm: {
              mode, threshold: magicOn ? String(thresholdPct) : val('threshold'),
              reserve: magicOn ? String(manaPct) : val('reserve'),
              itemThreshold: itemsOn ? String(itemThresholdPct) : val('itemThreshold'),
              itemCids: itemCids.join(','), manaEnabled: manaItemsOn ? 'true' : 'false',
              manaItemThreshold: manaItemsOn ? String(manaItemThresholdPct) : val('manaItemThreshold'),
              manaItemCids: manaItemCids.join(','),
            }, refusal: null,
          }), effects: [{ type: 'push-config' }],
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
        // is harmless. Slice B (REQ-42/44/46): the rune sid + hotkey F-keys
        // + the toggle switches are form values too.
        const key = String(action.key || '');
        const TRAINER_KEYS = ['capMode', 'capFullThreshold', 'fallbackSid', 'fallbackManaPct',
          'reserve', 'runeSid', 'autoFallback', 'stopRuneMaking', 'stopBotting',
          'foodMagicEnabled', 'foodMagicSid', 'foodEveryRunes'];
        if (TRAINER_KEYS.indexOf(key) === -1) return { state, effects: [] };
        const trainerForm = Object.assign({}, state.trainerForm || {
          capMode: '', capFullThreshold: '', fallbackSid: '', fallbackManaPct: '', reserve: '',
          runeSid: '', autoFallback: '', stopRuneMaking: '', stopBotting: '',
          foodMagicEnabled: '', foodMagicSid: '', foodEveryRunes: '',
        });
        trainerForm[key] = String(action.value === null || action.value === undefined ? '' : action.value);
        const refusal = state.refusal && state.refusal.action === 'SAVE_TRAINER_SETTINGS' ? null : state.refusal;
        return { state: Object.assign({}, state, { trainerForm, refusal }), effects: [] };
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

      case 'ASSIGN_HOTKEY': {
        // REQ-46 (D-B3): assign the selected F-key to the rune/fallback
        // hotbar slot — the effect posts /api/hotkeys (server -> in-page
        // setHotbarKeybind RPC + per-character persistence). Armed-gated
        // like every RPC effect.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const which = action.which === 'fallback' ? 'fallback' : 'rune';
        return { state, effects: [{ type: 'hotkey-assign', which }] };
      }

      case 'HOTKEY_RESULT': {
        // REQ-46 (D-B3): the /api/hotkeys assign outcome — a failure surfaces
        // as a visible refusal (never silent); success clears it.
        const which = action.which === 'fallback' ? 'fallback' : 'rune';
        if (action.ok === true) {
          return { state: Object.assign({}, state, { refusal: null }), effects: [] };
        }
        const at = Date.now();
        return {
          state: Object.assign({}, state, {
            refusal: { action: 'ASSIGN_HOTKEY', module: 'training', reason: String(action.reason || 'hotkey assign failed'), at },
          }),
          effects: [],
        };
      }

      case 'HOTKEYS_LOADED': {
        // REQ-46 (D-B3): /api/hotkeys read result — available:false drives
        // the display-only degrade (disabled selects + honest note, D-B3).
        const configured = action.configured && typeof action.configured === 'object'
          ? { runeKey: action.configured.runeKey || 'F4', fallbackKey: action.configured.fallbackKey || 'F5' }
          : { runeKey: 'F4', fallbackKey: 'F5' };
        return {
          state: Object.assign({}, state, {
            hotkeys: {
              available: action.available === true,
              reason: typeof action.reason === 'string' ? action.reason : null,
              configured,
            },
          }),
          effects: [],
        };
      }

      /* ------------------- slice 5 (PR5, REQ-33/34): OTHERS form ------------------- */

      case 'UPDATE_OTHERS_INPUT': {
        // REQ-33/34: pure UI state — the OTHERS form values survive re-renders
        // (healForm/trainerForm precedent). No gate: typing pre-Connect is
        // harmless.
        const key = String(action.key || '');
        const OTHERS_KEYS = ['foodSlot', 'everyCasts', 'foodMagicEnabled', 'foodMagicSid', 'safetyNet', 'lootDest', 'antibotReplies'];
        if (OTHERS_KEYS.indexOf(key) === -1) return { state, effects: [] };
        const othersForm = Object.assign({}, state.othersForm || {
          foodSlot: '', everyCasts: '', foodMagicEnabled: '', foodMagicSid: '', safetyNet: '',
          lootDest: '', antibotReplies: '',
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
        // PR 4 (REQ-01): the unified food magic + safety net commit into
        // modules.eat — the ONLY food config surface left (no
        // training.eatWithMagic anywhere). An untouched toggle/field
        // PRESERVES the saved config; enabling magic requires a live food
        // spell mapped to F1–F12 (same trust boundary as the trainer forms —
        // the server re-checks on save).
        const cfgEat = state.config && state.config.modules && state.config.modules.eat;
        const savedMagic = cfgEat && cfgEat.magic && typeof cfgEat.magic === 'object' ? cfgEat.magic : {};
        const rawMagicEnabled = String(form.foodMagicEnabled || '');
        const rawMagicSid = String(form.foodMagicSid || '').trim();
        const rawSafetyNet = String(form.safetyNet || '').trim();
        const foodMagicEnabled = rawMagicEnabled === '' ? savedMagic.enabled === true : rawMagicEnabled === 'true';
        const savedSafety = Number(cfgEat && cfgEat.safetyNetMinutes);
        const safetyNet = rawSafetyNet === ''
          ? (Number.isFinite(savedSafety) && savedSafety >= 1 ? savedSafety : 20)
          : Number(rawSafetyNet);
        if (!Number.isFinite(safetyNet) || safetyNet < 1) {
          return invalid('invalid other settings — safety net minutes must be >= 1');
        }
        let foodMagic = { enabled: false, slot: null, sid: null };
        if (foodMagicEnabled) {
          const spells = (state.catalog && state.catalog.spells) || [];
          const foodSpell = spells.filter((s) => Number(s && s.sid) === Number(rawMagicSid))[0] || null;
          if (!foodSpell || !isFoodCreationSpell(foodSpell)) {
            return invalid('invalid other settings — food spell must be from the live catalog (for example, exevo pan)');
          }
          const magicSlot = hotbarSlotForSpell(state, rawMagicSid);
          if (magicSlot === null) {
            return invalid('invalid other settings — add the food spell to F1–F12 in the game, refresh Live hotbar, then save');
          }
          foodMagic = { enabled: true, slot: magicSlot, sid: Number(rawMagicSid) };
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
        config.modules.eat.safetyNetMinutes = safetyNet;
        config.modules.eat.magic = foodMagic;
        // The loot destination + anti-bot replies surfaces are removed from
        // this UI generation, so an empty form PRESERVES the server-returned
        // hidden config instead of wiping it on a food-only save.
        const savedLoot = state.config && state.config.modules && state.config.modules.loot;
        const savedAntibot = state.config && state.config.modules && state.config.modules.antibot;
        config.modules.loot.defaultDest = rawDest !== ''
          ? rawDest
          : (savedLoot && savedLoot.defaultDest !== undefined ? savedLoot.defaultDest : null);
        config.modules.antibot.replies = rawReplies !== ''
          ? parsed.entries
          : (savedAntibot && Array.isArray(savedAntibot.replies) ? savedAntibot.replies : parsed.entries);
        return {
          state: Object.assign({}, state, {
            config,
            othersForm: {
              foodSlot: foodSlot === null ? '' : String(foodSlot),
              everyCasts: String(everyCasts),
              foodMagicEnabled: foodMagicEnabled ? 'true' : 'false',
              foodMagicSid: foodMagic.sid !== null ? String(foodMagic.sid) : '',
              safetyNet: String(safetyNet),
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
          const config = JSON.parse(JSON.stringify(state.config || {}));
          if (!config.modules || typeof config.modules !== 'object') config.modules = {};
          if (!config.modules.cavebot || typeof config.modules.cavebot !== 'object') config.modules.cavebot = {};
          const form = state.cavebotForm || {};
          const selected = Array.isArray(form.monsters) && form.monsters.length > 0
            ? form.monsters : (Array.isArray(config.modules.cavebot.monsters) ? config.modules.cavebot.monsters : []);
          config.modules.cavebot.monsters = selected.map((name) => String(name || '').trim()).filter(Boolean);
          config.modules.cavebot.targeting = form.targeting === 'lowest-hp' ? 'lowest-hp'
            : (form.targeting === 'nearest' ? 'nearest' : (config.modules.cavebot.targeting === 'lowest-hp' ? 'lowest-hp' : 'nearest'));
          if (recorded && Array.isArray(recorded.points) && recorded.points.length > 0) config.routes = recorded.points;
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

      case 'TOGGLE_CAVEBOT_MONSTER': {
        const name = String(action.name || '').trim();
        if (!name) return { state, effects: [] };
        const form = Object.assign({}, state.cavebotForm || { monsters: [], targeting: '' });
        const selected = Array.isArray(form.monsters) ? form.monsters.slice() : [];
        const at = selected.findIndex((item) => item.toLowerCase() === name.toLowerCase());
        if (at === -1) selected.push(name); else selected.splice(at, 1);
        form.monsters = selected;
        return { state: Object.assign({}, state, { cavebotForm: form }), effects: [] };
      }

      case 'UPDATE_CAVEBOT_INPUT': {
        if (action.key !== 'targeting') return { state, effects: [] };
        const form = Object.assign({}, state.cavebotForm || { monsters: [], targeting: '' });
        form.targeting = action.value === 'lowest-hp' ? 'lowest-hp' : 'nearest';
        return { state: Object.assign({}, state, { cavebotForm: form }), effects: [] };
      }

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
    if (state.gate === GATE_DISCONNECTED || state.gate === GATE_PROBING) {
      parts.push('<button type="button" id="link-first-btn">' + escapeHtml(t(state, 'linkFirst')) + '</button>');
    }
    if (state.gate === GATE_CONFIRMED) {
      parts.push('<button type="button" id="connect-btn">' + escapeHtml(t(state, 'connect')) + '</button>');
      parts.push('<button type="button" id="cancel-btn">' + escapeHtml(t(state, 'cancel')) + '</button>');
    }
    if (state.gate === GATE_ARMED) {
      parts.push('<button type="button" id="disconnect-btn">' + escapeHtml(t(state, 'disconnect')) + '</button>');
      const gameDataRefresh = state.gameDataRefresh || {};
      const isRefreshing = gameDataRefresh.loading === true;
      parts.push('<button type="button" id="refresh-game-data-btn"'
        + (isRefreshing ? ' disabled' : '') + '>'
        + escapeHtml(t(state, isRefreshing ? 'gameData.refreshing' : 'gameData.refresh')) + '</button>');
      if (isRefreshing) {
        parts.push('<span class="game-data-refresh-status" role="status" aria-live="polite">'
          + escapeHtml(t(state, 'gameData.refreshing')) + '</span>');
      } else if (Array.isArray(gameDataRefresh.failed) && gameDataRefresh.failed.length > 0) {
        parts.push('<span class="game-data-refresh-status is-error" role="status" aria-live="polite">'
          + escapeHtml(t(state, 'gameData.partial')) + '</span>');
      } else if (Number.isFinite(Number(gameDataRefresh.lastUpdatedAt))) {
        parts.push('<span class="game-data-refresh-status" role="status" aria-live="polite">'
          + escapeHtml(tVar(state, 'gameData.updated', { time: new Date(Number(gameDataRefresh.lastUpdatedAt)).toLocaleTimeString() })) + '</span>');
      }
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
    parts.push('<button type="button" class="tutorial-restart-btn" data-tutorial-action="restart">'
      + escapeHtml(t(state, 'tutorial.restart')) + '</button>');
    return '<div class="status-bar">' + parts.join(' ') + '</div>';
  }

  /**
   * Tabbed module list: the DASHBOARD tab first (quick-access cards, default
   * tab), then one panel per visible configuration tab holding that tab's
   * module toggles. HIDDEN_MODULES are filtered out here — they never render
   * as a tab, a toggle or a panel. ALL panels render in the DOM (the active
   * one is visible via the `hidden` attribute) — the reducer keeps every
   * toggle state live, and tab switching is pure CSS/attribute work.
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
      let body;
      if (tab.id === 'dashboard') {
        body = renderDashboard(state);
      } else {
        const defs = (MODULE_BY_TAB[tab.id] || []).filter((def) => !HIDDEN_MODULES.has(def.id));
        if (defs.length === 0) {
          body = '<div class="tab-empty">' + escapeHtml(t(state, 'skeleton.note')) + '</div>';
        } else {
          body = defs.map((def) => {
            const checked = state.modules[def.id] === true;
            const disabled = state.gate !== GATE_ARMED ? ' disabled' : '';
            return '<label class="module-toggle"><input type="checkbox" data-module="' + def.id + '"'
              + (checked ? ' checked' : '') + disabled + '> ' + escapeHtml(moduleLabel(state, def)) + '</label>';
          }).join('');
        }
      }
      return '<section class="tab-panel" data-tab-panel="' + tab.id + '" role="tabpanel"' + hidden + '>'
        + body + '</section>';
    }).join('');

    return '<div class="module-list">' + nav + panels + '</div>';
  }

  /** One readable dashboard status line per card — derived ONLY from the live
   *  snapshot (or the saved config where the snapshot exposes no module state,
   *  e.g. healMagic). Never raw JSON; honest '—' when there is no snapshot. */
  function dashboardStatusLine(state, card) {
    if (!state.snapshot || typeof state.snapshot !== 'object') return '—';
    const modules = state.snapshot.agent && state.snapshot.agent.modules
      ? state.snapshot.agent.modules : {};
    const stats = snapshotStats(state.snapshot);
    if (card.id === 'training') {
      const training = modules.training;
      if (!training) return '—';
      if (training.on !== true) return t(state, 'dashboard.status.off');
      if (training.capFull === true) return t(state, 'trainer.capFullAlert');
      const runtime = renderTrainerRuntimeStatus(state, training, stats);
      if (runtime) return runtime;
      const created = Number(training.successfulRuneCreations);
      if (Number.isInteger(created) && created > 0) {
        return tVar(state, 'dashboard.training.created', { count: created });
      }
      return t(state, 'dashboard.training.ready');
    }
    if (card.id === 'runes') {
      const runes = modules.runes;
      if (!runes) return '—';
      if (runes.on !== true) return t(state, 'dashboard.status.off');
      return runes.available === false
        ? t(state, 'dashboard.runes.unavailable')
        : t(state, 'dashboard.runes.ready');
    }
    if (card.id === 'eat') {
      // REQ-07 (PR 4): the Comida card reads the LIVE eat getState (unified
      // PR 3 shape) — never the saved config. One escaped line:
      // "N created · next HH:MM · last HH:MM". The Runes card stays runes-only.
      const eat = modules.eat;
      if (!eat) return '—';
      if (eat.on !== true) return t(state, 'dashboard.status.off');
      if (eat.paused === true) return t(state, 'eat.pausedAlert');
      const parts = [];
      const created = Number(eat.foodCreated);
      if (Number.isInteger(created) && created > 0) {
        parts.push(tVar(state, 'dashboard.eat.created', { count: created }));
      }
      const at = Number(eat.lastEatAt);
      if (Number.isFinite(at) && at > 0) {
        const next = Number(eat.nextMealAt);
        parts.push(Number.isFinite(next) && next > 0
          ? tVar(state, 'dashboard.eat.nextMeal', { time: new Date(next).toLocaleTimeString() })
          : t(state, 'dashboard.eat.nextMealNone'));
        parts.push(tVar(state, 'dashboard.eat.lastAte', { time: new Date(at).toLocaleTimeString() }));
      }
      if (parts.length === 0) return t(state, 'dashboard.eat.none');
      return parts.join(' · ');
    }
    if (card.id === 'healMagic') {
      // REQ-09/10 (slice C): the LIVE snapshot module state is the single
      // truth; the saved config is the fallback when the snapshot carries no
      // healMagic entry yet (pre-T2 agent or disconnected).
      const hmLive = modules.healMagic;
      const hmCfg = state.config && state.config.modules && state.config.modules.healMagic;
      const hm = hmLive || hmCfg;
      if (!hm) return '—';
      if (hm.on !== true) return t(state, 'heal.liveOff');
      if (stats.health !== null && stats.maxHealth !== null && stats.maxHealth > 0) {
        const hpPct = Math.round(stats.health / stats.maxHealth * 100);
        const tAbs = Number(hm.threshold);
        const tPct = Number.isFinite(tAbs) && tAbs >= 0 ? Math.round(tAbs / stats.maxHealth * 100) : null;
        return tVar(state, 'heal.liveOn', {
          pct: hpPct, max: stats.maxHealth,
          t: tPct, slot: hm.slot === null || hm.slot === undefined ? '—' : hm.slot,
        });
      }
      return t(state, 'dashboard.status.armed');
    }
    return '—';
  }

  /** DASHBOARD quick-access grid: one card per active module with a direct
   *  ON/OFF switch (same TOGGLE_MODULE dispatch as the tab toggles, gated on
   *  the armed gate) + a live status line + a "Configurar" shortcut that
   *  dispatches SET_TAB to the module's configuration tab. */
  function renderDashboard(state) {
    const parts = ['<div class="dashboard-grid">'];
    for (const card of DASHBOARD_CARDS) {
      const def = MODULE_DEFS.filter((d) => d.id === card.id)[0];
      if (!def) continue;
      const checked = state.modules[card.id] === true;
      const disabled = state.gate !== GATE_ARMED ? ' disabled' : '';
      const label = moduleLabel(state, def);
      const status = dashboardStatusLine(state, card);
      parts.push('<article class="dashboard-card' + (checked ? ' is-on' : '')
        + '" data-dashboard-card="' + card.id + '">'
        + '<div class="dashboard-card-head">'
        + '<h3>' + escapeHtml(label) + '</h3>'
        + '<label class="dashboard-toggle" title="' + escapeHtml(label) + '">'
        + '<input type="checkbox" data-module="' + card.id + '"'
        + (checked ? ' checked' : '') + disabled
        + ' aria-label="' + escapeHtml(label) + '">'
        + '<span class="dashboard-toggle-track" aria-hidden="true"></span></label>'
        + '</div>'
        + '<p class="dashboard-card-status' + (card.id === 'eat' ? ' dashboard-card-status--food' : '') + '">' + escapeHtml(status) + '</p>'
        + '<button type="button" class="dashboard-go-btn" data-dashboard-go="' + card.configTab + '">'
        + escapeHtml(t(state, 'dashboard.goConfig')) + '</button>'
        + '</article>');
    }
    parts.push('</div>');
    return parts.join('');
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
    if (catalog.playerLevel !== null && catalog.playerLevel !== undefined || catalog.vocationLabel) {
      parts.push('<div class="picker-context">'
        + (catalog.vocationLabel ? '<span>' + escapeHtml(String(catalog.vocationLabel)) + '</span>' : '')
        + (catalog.playerLevel !== null && catalog.playerLevel !== undefined ? '<span>LV ' + escapeHtml(String(catalog.playerLevel)) + '</span>' : '')
        + '<span>' + escapeHtml(String((catalog.spells || []).length)) + ' spells</span>'
        + '</div>');
    }
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
    const spells = (catalog.spells || []).filter((s) => {
      if (isPlaceholderSpell(s)) return false;
      if (!spellMatchesPickerModule(s, p.module)) return false;
      return !q
        || String(s.name || '').toLowerCase().indexOf(q) !== -1
        || String(s.words || '').toLowerCase().indexOf(q) !== -1
        || String(s.description || '').toLowerCase().indexOf(q) !== -1;
    });
    const currentSid = state.config && state.config.modules && state.config.modules[p.module]
      ? state.config.modules[p.module].sid
      : null;
    if (spells.length === 0) {
      parts.push('<p class="picker-none">' + escapeHtml(q ? t(state, 'picker.none') : t(state, 'picker.categoryEmpty')) + '</p>');
    } else {
      parts.push('<ul class="picker-list">'
        + spells.slice(0, 60).map((s) => {
          const isCurrent = Number(currentSid) === Number(s.sid);
          const image = [s.imageDataURL, s.image, s.iconUrl, s.imageUrl]
            .find((v) => typeof v === 'string' && v);
          const thumb = image
            ? '<span class="picker-icon"><img alt="" src="' + escapeHtml(image) + '"></span>'
            : '<span class="picker-icon picker-icon-fallback">' + escapeHtml(String(s.name || '?').trim().slice(0, 2).toUpperCase()) + '</span>';
          const chips = [
            'SID ' + (s.sid === null || s.sid === undefined ? '—' : String(s.sid)),
            'MP ' + (s.mana === null || s.mana === undefined ? '—' : String(s.mana)),
            'LV ' + (s.level === null || s.level === undefined ? '—' : String(s.level)),
          ];
          if (s.cid !== null && s.cid !== undefined) chips.push('CID ' + String(s.cid));
          if (s.vocation || s.vocationLabel) chips.push(String(s.vocation || s.vocationLabel));
          if (s.cooldown || s.cooldownMs) chips.push('CD ' + String(s.cooldown || s.cooldownMs));
          return '<li class="picker-row' + (isCurrent ? ' current' : '') + '">'
            + thumb
            + '<span class="picker-main"><span class="picker-name">' + escapeHtml(String(s.name || '')) + '</span>'
            + (s.words ? '<span class="picker-words">' + escapeHtml(s.words) + '</span>' : '')
            + (s.description ? '<span class="picker-description">' + escapeHtml(String(s.description)) + '</span>' : '')
            + '</span>'
            + '<span class="picker-meta">' + chips.map((c) => '<b>' + escapeHtml(c) + '</b>').join('') + '</span>'
            + '<span class="picker-legacy-meta">' + escapeHtml(tVar(state, 'picker.meta', { mana: s.mana, level: s.level })) + '</span>'
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
   * Hidden-module scope: with HP/mana potions removed from the UI the form is
   * ALWAYS magic-only — the mode buttons and the items/mana sections do not
   * render (the healMagic config stays fully functional).
   * @param {object} state
   * @returns {string}
   */
  function renderHealForm(state) {
    const form = state.healForm || {};
    const derived = healFormFromConfig(state);
    const val = (key) => (form[key] !== '' && form[key] !== undefined ? form[key] : derived[key]);
    const itemsHidden = HIDDEN_MODULES.has('healItems');
    const manaHidden = HIDDEN_MODULES.has('manaItems');
    const mode = itemsHidden && manaHidden ? 'magic' : (val('mode') || 'magic');
    const magicOn = mode === 'magic' || mode === 'both';
    const itemsOn = !itemsHidden && (mode === 'items' || mode === 'both');
    const manaItemsOn = !manaHidden && String(val('manaEnabled')) === 'true';
    const hm = state.config && state.config.modules && state.config.modules.healMagic || {};
    const hpSelected = selectedHealItemCids(state, form);
    const manaSelected = selectedManaItemCids(state, form);
    const items = liveInventoryItems(state);
    const magicSlot = hotbarSlotForSpell(state, hm.sid);
    const modeButton = (id) => '<button type="button" class="heal-mode' + (mode === id ? ' active' : '')
      + '" data-heal-mode="' + id + '">' + escapeHtml(t(state, 'heal.mode.' + id)) + '</button>';
    const cards = (kind, selected) => items.length === 0
      ? '<p class="heal-items-empty">' + escapeHtml(t(state, 'heal.itemsEmpty')) + '</p>'
      : '<div class="heal-item-grid">' + items.map((item) => {
        const cid = Number(item.cid); const active = selected.indexOf(cid) !== -1;
        const image = typeof item.imageDataURL === 'string' ? item.imageDataURL : '';
        const icon = image ? '<img alt="" src="' + escapeHtml(image) + '">' : '<span>' + escapeHtml(String(cid)) + '</span>';
        const name = String(item.name || ('Item #' + cid));
        const count = Number.isFinite(Number(item.count)) && Number(item.count) > 1 ? ' ×' + Number(item.count) : '';
        return '<button type="button" class="heal-item-card' + (active ? ' active' : '')
          + '" data-heal-item-cid="' + cid + '" data-heal-item-kind="' + kind + '"><i>' + icon + '</i><span>'
          + escapeHtml(name) + '<small>CID ' + cid + count + '</small></span></button>';
      }).join('') + '</div>';
    const hotbarNote = magicSlot === null
      ? '<p class="heal-items-empty">' + escapeHtml(t(state, 'heal.hotbarMissing')) + '</p>'
      : '<p class="trainer-note">' + escapeHtml(tVar(state, 'heal.hotbarMapped', { slot: magicSlot })) + '</p>';
    return '<div class="heal-form survival-form">'
      + '<h3>' + escapeHtml(t(state, 'heal.formTitle')) + '</h3>'
      + (!itemsHidden || !manaHidden
        ? '<div class="heal-mode-row"><span>' + escapeHtml(t(state, 'heal.mode')) + '</span>'
          + modeButton('magic') + modeButton('items') + modeButton('both') + '</div>'
        : '')
      + '<div class="survival-grid">'
      + (magicOn ? '<section class="survival-card"><h4>' + escapeHtml(t(state, 'heal.magicTitle')) + '</h4>'
        + renderSpellCard(state, 'healMagic', t(state, 'picker.module.healMagic'), hm.sid) + hotbarNote
        + '<label class="heal-field">' + escapeHtml(t(state, 'heal.threshold'))
        + ' <input type="number" id="heal-threshold" min="0" max="100" step="1" value="' + escapeHtml(val('threshold')) + '"></label>'
        + '<label class="heal-field">' + escapeHtml(t(state, 'heal.reserve'))
        + ' <input type="number" id="heal-reserve" min="0" max="100" step="1" value="' + escapeHtml(val('reserve')) + '"></label></section>' : '')
      + (itemsOn ? '<section class="survival-card"><h4>' + escapeHtml(t(state, 'heal.itemsTitle')) + '</h4>'
        + '<label class="heal-field">' + escapeHtml(t(state, 'heal.itemThreshold'))
        + ' <input type="number" id="heal-item-threshold" min="0" max="100" step="1" value="' + escapeHtml(val('itemThreshold')) + '"></label>'
        + '<p class="trainer-note">' + escapeHtml(t(state, 'heal.inventoryHint')) + '</p>'
        + '<div class="heal-items-head"><span>' + escapeHtml(tVar(state, 'heal.itemsSelected', { count: hpSelected.length })) + '</span>'
        + '<button type="button" id="heal-items-refresh">' + escapeHtml(t(state, 'heal.itemsRefresh')) + '</button></div>' + cards('hp', hpSelected) + '</section>' : '')
      + (!manaHidden ? '<section class="survival-card"><h4>' + escapeHtml(t(state, 'heal.manaTitle')) + '</h4>'
        + '<label class="toggle"><input type="checkbox" id="heal-mana-enabled"' + (manaItemsOn ? ' checked' : '') + '> ' + escapeHtml(t(state, 'heal.manaEnabled')) + '</label>'
        + (manaItemsOn ? '<label class="heal-field">' + escapeHtml(t(state, 'heal.manaThreshold'))
          + ' <input type="number" id="heal-mana-item-threshold" min="0" max="100" step="1" value="' + escapeHtml(val('manaItemThreshold')) + '"></label>'
          + '<p class="trainer-note">' + escapeHtml(t(state, 'heal.inventoryHint')) + '</p>'
          + '<div class="heal-items-head"><span>' + escapeHtml(tVar(state, 'heal.itemsSelected', { count: manaSelected.length })) + '</span></div>' + cards('mana', manaSelected) : '')
        + '</section>' : '')
      + '</div><button type="button" id="heal-save-btn">' + escapeHtml(t(state, 'heal.save')) + '</button></div>';
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
    const es = state.lang === LANG_ES;
    const text = (spanish, english) => es ? spanish : english;
    const stats = snapshotStats(state.snapshot);
    const cap = snapshotCap(state.snapshot);
    const capAvailable = Boolean(cap && cap.ratio !== null);
    const rune = filterRuneCatalog(state);
    const fallbackSpells = filterFallbackCatalog(state);
    const foodSpells = filterFoodCatalog(state);
    const currentSid = val('runeSid');
    const fallbackSid = val('fallbackSid');
    const foodSid = val('foodMagicSid');
    const runeSpell = ((state.catalog && state.catalog.spells) || []).filter((spell) => String(Number(spell.sid)) === currentSid)[0] || null;
    const cost = Number(runeSpell && runeSpell.mana);
    const reserve = Math.max(0, Number(val('reserve')) || 0);
    const requiredMana = Number.isFinite(cost) ? cost + reserve : null;
    const options = (list, selected) => list.map((spell) => {
      const sid = String(Number(spell.sid));
      return '<option value="' + sid + '"' + (selected === sid ? ' selected' : '') + '>'
        + escapeHtml(String(spell.name || '')) + (spell.words ? ' — ' + escapeHtml(String(spell.words)) : '') + '</option>';
    }).join('');
    const select = (id, list, selected, empty) => '<select id="' + id + '"><option value="">' + escapeHtml(empty) + '</option>'
      + options(list, selected) + '</select>';
    const mapping = (sid, kind) => {
      const slot = hotbarSlotForSpell(state, sid);
      if (slot !== null) return '<p class="trainer-note trainer-hotbar-ok">' + escapeHtml(text(kind + ' → F' + slot + ' detectada del juego.', kind + ' → live F' + slot + ' detected from the game.')) + '</p>';
      if (sid) return '<p class="trainer-note trainer-hotbar-missing">' + escapeHtml(text(kind + ' no está en F1–F12. Reacomodala en el juego y usá Actualizar datos.', kind + ' is not on F1–F12. Move it in the game and use Refresh data.')) + '</p>';
      return '<p class="trainer-note">' + escapeHtml(text('Elegí una magia del catálogo vivo.', 'Choose a spell from the live catalog.')) + '</p>';
    };
    const autoFallback = val('autoFallback') === 'true';
    const foodMagicEnabled = val('foodMagicEnabled') === 'true';
    const stopRuneMaking = val('stopRuneMaking') === 'true';
    const stopBotting = val('stopBotting') === 'true';
    const stopNote = stopBotting ? '<div class="module-alert alert-stop-botting">' + escapeHtml(t(state, 'trainer.stopBottingActive')) + '</div>' : '';
    const costNote = requiredMana === null
      ? text('El coste sale de la magia elegida cuando el catálogo vivo esté disponible.', 'Cost comes from the selected spell once the live catalog is available.')
      : text('Coste automático: ' + cost + ' MP + reserva ' + reserve + ' = lanzará desde ' + requiredMana + ' MP. No escribas el total.', 'Automatic cost: ' + cost + ' MP + reserve ' + reserve + ' = it will cast at ' + requiredMana + ' MP. Do not enter the total.');
    const capSection = capAvailable
      ? '<details class="trainer-optional"><summary>' + escapeHtml(text('Capacidad y alertas (opcional)', 'Capacity & alerts (optional)')) + '</summary>'
        + '<div class="trainer-optional-body">'
        + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.whenCapFull')) + ' <select id="trainer-cap-mode">'
        + '<option value="strict"' + (val('capMode') === 'strict' ? ' selected' : '') + '>' + escapeHtml(t(state, 'trainer.capModeStrict')) + '</option>'
        + '<option value="off"' + (val('capMode') === 'off' ? ' selected' : '') + '>' + escapeHtml(t(state, 'trainer.capModeOff')) + '</option></select></label>'
        + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.capFullThreshold'))
        + ' <input type="number" id="trainer-cap-threshold" min="0" max="100" step="1" value="' + escapeHtml(val('capFullThreshold')) + '"></label></div></details>'
      : '<details class="trainer-optional trainer-optional-unavailable"><summary>' + escapeHtml(text('Capacidad: no disponible', 'Capacity: unavailable')) + '</summary><div class="trainer-optional-body"><p class="trainer-note">' + escapeHtml(text('Esta PWA no expone CAP. No se inventa ni bloquea el entrenamiento. Actualizá datos si el cliente llega a exponerla.', 'This PWA does not expose CAP. It is not guessed and does not block Trainer. Refresh data if the client starts exposing it.')) + '</p></div></details>';
    return '<div class="trainer-form"><h3>' + escapeHtml(t(state, 'trainer.formTitle')) + '</h3>' + stopNote
      + renderTrainerExecutionCard(state, stats, runeSpell, requiredMana, foodSid, foodMagicEnabled)
      + '<div class="trainer-grid"><div class="trainer-col trainer-primary"><h4>' + escapeHtml(t(state, 'trainer.runeMakingTitle')) + '</h4>'
      + renderSpellCard(state, 'training', t(state, 'picker.module.training'), currentSid)
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.runeSelect')) + ' '
      + select('trainer-rune-select', rune.list, currentSid, text('Elegí una runa', 'Select rune')) + '</label>' + mapping(currentSid, text('La runa', 'Rune'))
      + (rune.fallback ? '<p class="trainer-note">' + escapeHtml(t(state, 'trainer.runeSelectFallback')) + '</p>' : '')
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.castLogic'))
      + ' <input type="number" id="trainer-reserve" min="0" step="1" value="' + escapeHtml(val('reserve')) + '"></label>'
      + '<p class="trainer-note trainer-cost-note">' + escapeHtml(costNote) + '</p>'
      + '<details class="trainer-optional"' + (autoFallback ? ' open' : '') + '><summary>' + escapeHtml(text('Magia alternativa (opcional)', 'Fallback magic (optional)')) + '</summary><div class="trainer-optional-body">'
      + '<label class="toggle"><input type="checkbox" id="trainer-auto-fallback"' + (autoFallback ? ' checked' : '') + '> '
      + escapeHtml(t(state, 'trainer.autoFallbackMagic')) + '</label>'
      + (autoFallback ? renderSpellCard(state, 'trainer-fallback', t(state, 'trainer.fallbackMagic'), fallbackSid)
        + '<label class="trainer-field">' + escapeHtml(text('Elegir magia alternativa', 'Select fallback spell')) + ' '
        + select('trainer-fallback-select', fallbackSpells, fallbackSid, text('Sin alternativa', 'No fallback')) + '</label>' + mapping(fallbackSid, text('La alternativa', 'Fallback'))
        + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.fallbackManaPct'))
        + ' <input type="number" id="trainer-fallback-pct" min="0" max="100" step="1" value="' + escapeHtml(val('fallbackManaPct')) + '"></label>' : '')
      + '</div></details>'
      + '<details class="trainer-optional"' + (foodMagicEnabled ? ' open' : '') + '><summary>' + escapeHtml(text('Comida creada por magia (opcional)', 'Food created by magic (optional)')) + '</summary><div class="trainer-optional-body">'
      + '<label class="toggle"><input type="checkbox" id="trainer-food-magic-enabled"' + (foodMagicEnabled ? ' checked' : '') + '> '
      + escapeHtml(text('Usar magia de comida al fabricar runas', 'Use food magic while making runes')) + '</label>'
      + (foodMagicEnabled ? renderSpellCard(state, 'trainer-food-magic', text('Magia de comida', 'Food magic'), foodSid)
        + '<label class="trainer-field">' + escapeHtml(text('Elegir magia de comida (ej. exevo pan)', 'Choose food spell (e.g. exevo pan)')) + ' '
        + select('trainer-food-magic-select', foodSpells, foodSid, text('Elegí una magia', 'Select spell')) + '</label>' + mapping(foodSid, text('La magia de comida', 'Food spell'))
        + '<label class="trainer-field">' + escapeHtml(text('Lanzar comida cada N runas creadas', 'Cast food every N created runes'))
        + ' <input type="number" id="trainer-food-every-runes" min="1" step="1" value="' + escapeHtml(val('foodEveryRunes')) + '"></label>'
        + '<p class="trainer-note">' + escapeHtml(text('Sólo usa la comida nueva que aparece en los primeros 20 slots.', 'Only uses the new food that appears in the first 20 slots.')) + '</p>' : '')
      + '</div></details>'
      + '</div><div class="trainer-col trainer-secondary">'
      + capSection
      + '<details class="trainer-optional"><summary>' + escapeHtml(text('Alertas y detención (opcional)', 'Alerts & stops (optional)')) + '</summary><div class="trainer-optional-body"><div class="trainer-toggles"><label class="trainer-field trainer-check"><input type="checkbox" id="trainer-sound-alert"' + (state.soundEnabled !== false ? ' checked' : '') + '> ' + escapeHtml(t(state, 'trainer.soundAlert')) + '</label>'
      + '<label class="trainer-field trainer-check"><input type="checkbox" id="trainer-stop-runes"' + (stopRuneMaking ? ' checked' : '') + '> ' + escapeHtml(t(state, 'trainer.stopRuneMaking')) + '</label>'
      + '<label class="trainer-field trainer-check"><input type="checkbox" id="trainer-stop-botting"' + (stopBotting ? ' checked' : '') + '> ' + escapeHtml(t(state, 'trainer.stopBotting')) + '</label></div></div></details>'
      + '<button type="button" id="trainer-save-btn" class="trainer-save">' + escapeHtml(t(state, 'trainer.save')) + '</button></div></div></div>';
  }

  /**
   * OTHERS settings form: the food section (slot + every-N-casts). The
   * auto-loot destination and the anti-bot `pattern => reply` list are
   * removed from this UI generation — the reducer still preserves their
   * server-returned config on save. Values come from the pure-UI othersForm
   * state (survive re-renders) falling back to the saved config.
   * @param {object} state
   * @returns {string}
   */
  function renderOthersForm(state) {
    const form = state.othersForm || {};
    const derived = othersFormFromConfig(state);
    const val = (key) => (form[key] !== '' && form[key] !== undefined ? form[key] : derived[key]);
    // PR 4 (REQ-01): the unified food-magic surface — toggle, live-catalog
    // spell select and the live F-slot mapping note (trainer rune select
    // pattern). The fixed-slot fallback fields stay right above.
    const foodSpells = filterFoodCatalog(state);
    const foodMagicEnabled = val('foodMagicEnabled') === 'true';
    const foodSid = val('foodMagicSid');
    const foodSlot = hotbarSlotForSpell(state, foodSid);
    const foodMapping = foodSid
      ? (foodSlot !== null
          ? tVar(state, 'others.foodMagicMapping', { slot: foodSlot })
          : t(state, 'others.foodMagicHotbar'))
      : '';
    const foodOptions = foodSpells.map((spell) => {
      const sid = String(Number(spell.sid));
      return '<option value="' + sid + '"' + (foodSid === sid ? ' selected' : '') + '>'
        + escapeHtml(String(spell.name || '')) + (spell.words ? ' — ' + escapeHtml(String(spell.words)) : '') + '</option>';
    }).join('');
    return '<div class="others-form">'
      + '<h3>' + escapeHtml(t(state, 'others.formTitle')) + '</h3>'
      + '<h4>' + escapeHtml(t(state, 'others.foodTitle')) + '</h4>'
      + '<label class="others-field">' + escapeHtml(t(state, 'others.foodSlot'))
      + ' <input type="number" id="others-food-slot" min="1" step="1" value="' + escapeHtml(val('foodSlot')) + '"></label>'
      + '<label class="others-field">' + escapeHtml(t(state, 'others.everyCasts'))
      + ' <input type="number" id="others-every-casts" min="0" step="1" value="' + escapeHtml(val('everyCasts')) + '"></label>'
      + '<h4>' + escapeHtml(t(state, 'others.foodMagic')) + '</h4>'
      + '<label class="others-field">' + escapeHtml(t(state, 'others.foodMagicToggle'))
      + ' <input type="checkbox" id="others-food-magic-enabled"' + (foodMagicEnabled ? ' checked' : '') + '></label>'
      + (foodMagicEnabled
          ? '<label class="others-field">' + escapeHtml(t(state, 'others.foodMagicSelect'))
            + ' <select id="others-food-magic-select"><option value="">' + escapeHtml(t(state, 'others.foodMagicSelectEmpty')) + '</option>'
            + foodOptions + '</select></label>'
            + (foodMapping ? '<p class="trainer-note'
              + (foodSlot !== null ? ' trainer-hotbar-ok' : ' trainer-hotbar-missing') + '">'
              + escapeHtml(foodMapping) + '</p>' : '')
          : '')
      + '<label class="others-field">' + escapeHtml(t(state, 'others.safetyNet'))
      + ' <input type="number" id="others-food-safety-net" min="1" step="1" value="' + escapeHtml(val('safetyNet')) + '"></label>'
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
    const attack = state.config && state.config.modules && state.config.modules.attack || {};
    return '<div class="attack-form">'
      + '<h3>' + escapeHtml(t(state, 'attack.formTitle')) + '</h3>'
      + '<p class="skeleton-note">' + escapeHtml(t(state, 'attack.skeletonNote')) + '</p>'
      + renderSpellCard(state, 'attack', t(state, 'picker.module.attack'), attack.sid)
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
    const saved = state.config && state.config.modules && state.config.modules.cavebot || {};
    const form = state.cavebotForm || { monsters: [], targeting: '' };
    const selected = Array.isArray(form.monsters) && form.monsters.length > 0
      ? form.monsters : (Array.isArray(saved.monsters) ? saved.monsters : []);
    const targeting = form.targeting || saved.targeting || 'nearest';
    const creatures = state.creatures && Array.isArray(state.creatures.items) ? state.creatures.items : [];
    const parts = ['<div class="cavebot-form">', '<h3>' + escapeHtml(t(state, 'cavebot.formTitle')) + '</h3>'];
    parts.push('<p class="cavebot-future">Elige los monstruos visibles, guarda, y Cavebot pausa la ruta para atacarlos.</p>');
    parts.push('<label class="attack-field">Prioridad de objetivo <select id="cavebot-targeting">'
      + '<option value="nearest"' + (targeting === 'nearest' ? ' selected' : '') + '>Más cercano</option>'
      + '<option value="lowest-hp"' + (targeting === 'lowest-hp' ? ' selected' : '') + '>Menor vida</option>'
      + '</select></label>');
    parts.push('<div class="cavebot-monsters"><strong>Monstruos visibles</strong>');
    if (creatures.length === 0) parts.push('<p class="cavebot-status">No hay monstruos visibles; abrí el juego y refrescá la pestaña.</p>');
    else {
      for (const creature of creatures) {
        const name = String(creature && creature.name || '').trim();
        if (!name) continue;
        const on = selected.some((item) => item.toLowerCase() === name.toLowerCase());
        parts.push('<button type="button" class="cavebot-btn' + (on ? ' primary' : '') + '" data-cavebot-monster="' + escapeHtml(name) + '">' + escapeHtml(name)
          + (Number.isFinite(Number(creature.healthPct)) ? ' · ' + Math.round(Number(creature.healthPct)) + '%' : '') + '</button>');
      }
    }
    parts.push('</div>');
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
    parts.push('<p class="cavebot-future">Guardá para aplicar monstruos, prioridad y la última ruta grabada.</p>');
    parts.push('</div>');
    return parts.join('');
  }

  /** Config form: module settings shell (heal/trainer/others — the visible
   *  modules only) + the slice-1b profile loader and spell picker. Hidden
   *  modules never get a deck section here. */
  function renderConfigForm(state) {
    const head = '<h2>' + escapeHtml(t(state, 'configuration')) + '</h2>';
    const activeTab = state.tab || 'dashboard';
    const deck = (id, html) => '<section class="config-tab config-tab-' + id + (activeTab === id ? ' active' : '')
      + '" data-config-tab="' + id + '">' + html + '</section>';
    let body;
    if (state.gate === GATE_ARMED) {
      body = '<div class="control-console">'
        + '<div class="control-stage">'
        + deck('heal', renderHealForm(state))
        + deck('trainer', renderTrainerForm(state))
        + deck('others', renderOthersForm(state))
        + '</div>'
        + '<aside class="control-side" aria-label="Catalog and profiles">'
        + renderSpellPicker(state)
        + renderProfileLoader(state)
        + '</aside>'
        + '</div>';
    } else {
      body = '<div class="config-shell bot-card">' + escapeHtml(t(state, 'configLocked')) + '</div>';
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
  /** Explain the agent's Trainer state as an instruction, not an internal
   * reason code. This is intentionally derived from the live snapshot so it
   * clears as soon as the runtime advances; it is never a stale save alert. */
  function renderTrainerRuntimeStatus(state, training, stats) {
    const es = state.lang === LANG_ES;
    const say = (spanish, english) => es ? spanish : english;
    const issue = state.trainerHotbarIssue;
    if (issue) {
      const name = issue.key === 'food' ? say('magia de comida', 'food spell')
        : issue.key === 'fallback' ? say('magia alternativa', 'fallback spell')
          : say('runa', 'rune spell');
      return say('Hotbar desactualizado: la ' + name + ' ya no está en F1–F12. Entrenamiento se apagó para no usar otro botón. Reacomodala, actualizá datos y guardá.',
        'Stale hotbar: the ' + name + ' is no longer in F1–F12. Trainer was turned off so it cannot use another button. Rearrange it, refresh game data, then save.');
    }
    if (!training || typeof training !== 'object') return '';
    const reason = String(training.lastReason || '');
    if (training.waitingForMana === true || reason === 'reserve' || reason === 'insufficient') {
      const required = Number(training.requiredMana);
      const need = Number.isFinite(required) ? Math.ceil(required) : '—';
      const current = stats.mana === null ? '—' : Math.floor(stats.mana);
      return say('Esperando maná: ' + current + '/' + need + ' MP. Se lanzará sola al llegar al coste + reserva; no hace falta guardar otra vez.',
        'Waiting for mana: ' + current + '/' + need + ' MP. It will cast by itself at spell cost + reserve; you do not need to save again.');
    }
    if (reason === 'cooldown' || reason === 'global-cooldown') {
      return say('Esperando cooldown del juego. La configuración sigue activa y reintentará automáticamente.',
        'Waiting for the game cooldown. Configuration stays active and retries automatically.');
    }
    if (training.foodCycle === 'waiting-for-created-food' || reason === 'waiting-for-created-food') {
      return say('Comida: se lanzó la magia y el bot espera que aparezca el ítem nuevo en los primeros 20 slots. No comerá ítems viejos.',
        'Food: the spell was cast and the bot is waiting for the new item in the first 20 slots. It will not consume old items.');
    }
    if (training.foodCycle === 'timeout' || reason === 'food-not-created-timeout') {
      return say('No apareció comida nueva a tiempo. Revisá que la magia cree comida en esta PWA y que haya espacio visible; el ciclo se detuvo de forma segura.',
        'No new food item appeared in time. Check that this spell creates food in this PWA and that visible space exists; the cycle stopped safely.');
    }
    if (reason === 'created-food-consume-failed') {
      return say('La comida apareció, pero el juego no aceptó consumirla. Revisá la PWA y actualizá datos; no se reintentará a ciegas.',
        'Food appeared, but the game did not accept consuming it. Check the PWA and refresh game data; it will not blindly retry.');
    }
    if (reason === 'confirmation-timeout') {
      return say('El juego no confirmó la acción a tiempo. No se avanzó el ciclo: revisá conexión/hotbar y actualizá datos.',
        'The game did not confirm the action in time. The cycle did not advance: check connection/hotbar and refresh game data.');
    }
    return '';
  }

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
      // REQ-09/10 (slice C): the LIVE snapshot module state is the single
      // truth; the saved config is the fallback when the snapshot carries no
      // healMagic entry yet (pre-T2 agent or disconnected).
      const modules = state.snapshot.agent && state.snapshot.agent.modules
        ? state.snapshot.agent.modules : null;
      const hmLive = modules && modules.healMagic;
      const hmCfg = state.config && state.config.modules && state.config.modules.healMagic;
      const hm = hmLive || hmCfg;
      if (hm && stats.health !== null && stats.maxHealth !== null && stats.maxHealth > 0) {
        const hpPct = Math.round(stats.health / stats.maxHealth * 100);
        const tAbs = Number(hm.threshold);
        const tPct = Number.isFinite(tAbs) && tAbs >= 0 ? Math.round(tAbs / stats.maxHealth * 100) : null;
        parts.push('<div class="heal-state">' + (hm.on === true
          ? escapeHtml(tVar(state, 'heal.liveOn', { pct: hpPct, max: stats.maxHealth, t: tPct, slot: hm.slot === null || hm.slot === undefined ? '—' : hm.slot }))
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
      // (`modules` is resolved above the heal line — slice C, REQ-09/10.)
      const trainerStatus = renderTrainerRuntimeStatus(state, modules && modules.training, stats);
      if (trainerStatus) parts.push('<div class="module-alert alert-training-wait">' + escapeHtml(trainerStatus) + '</div>');
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
      if (modules && modules.routes && !HIDDEN_MODULES.has('routes')) {
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
      // PR6 (REQ-35/36): skeleton module lines — hidden-module scope removes
      // the attack + cavebot live lines from the visible UI.
      if (modules && modules.attack && !HIDDEN_MODULES.has('attack')) {
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
      const cavebot = HIDDEN_MODULES.has('cavebot') ? null : snapshotCavebot(state.snapshot);
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
    const cur = tutorialStepFor(state, step);
    const title = escapeHtml(t(state, cur.key));
    const body = escapeHtml(t(state, cur.body || cur.key));
    const isLast = step >= steps.length - 1;
    const back = '<button type="button" class="tutorial-btn" data-tutorial-action="back"'
      + (step === 0 ? ' disabled aria-disabled="true"' : '') + '>' + escapeHtml(t(state, 'tutorial.back')) + '</button>';
    const cta = isLast
      ? '<button type="button" class="tutorial-btn primary" data-tutorial-action="next">' + escapeHtml(t(state, 'tutorial.finish')) + '</button>'
      : '<button type="button" class="tutorial-btn primary" data-tutorial-action="next">' + escapeHtml(t(state, 'tutorial.next')) + '</button>';
    return '<div class="tutorial-overlay" data-tutorial data-tutorial-target="' + escapeHtml(cur.target || '')
      + '" role="dialog" aria-modal="false" aria-label="' + title + '">'
      + '<div class="tutorial-card">'
      + '<h3>' + title + '</h3>'
      + '<p class="tutorial-copy' + (cur.unavailable ? ' tutorial-data-warning' : '') + '" role="status">' + body + '</p>'
      + '<div class="tutorial-progress">' + (step + 1) + ' / ' + steps.length + '</div>'
      + '<div class="tutorial-actions">'
      + back
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
    HIDDEN_MODULES,
    DASHBOARD_CARDS,
    PICKER_MODULES,
    I18N,
    TUTORIAL_STEPS,
    tutorialStepFor,
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
    renderDashboard,
    dashboardStatusLine,
    renderProfileLoader,
    renderSpellPicker,
    renderConfigForm,
    healFormFromConfig,
    selectedManaItemCids,
    hotbarSlotForSpell,
    isFoodCreationSpell,
    filterFoodCatalog,
    reconcileTrainerHotbar,
    renderHealForm,
    trainerFormFromConfig,
    renderTrainerForm,
    spellMatchesPickerModule,
    filterRuneCatalog,
    snapshotCap,
    renderBar,
    othersFormFromConfig,
    parseRepliesText,
    renderOthersForm,
    attackFormFromConfig,
    renderAttackForm,
    renderCavebotForm,
    renderTrainerRuntimeStatus,
    renderLiveState,
    renderLog,
    renderTutorial,
    renderPanel,
  };
});
