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
   * Each tab owns the module toggles that land there. ATTACK + CAVEBOT are
   * skeleton tabs (their modules arrive with later slices — the shell
   * reserves their space and discloses "skeleton — limited").
   */
  const TABS = [
    { id: 'heal', modules: ['healItems', 'healMagic'] },
    { id: 'attack', modules: [] },   // skeleton (slice 6: attack.js) — reserved
    { id: 'trainer', modules: ['runes', 'training'] },
    { id: 'cavebot', modules: [] },  // skeleton (slice 6: cavebot.js) — reserved
    { id: 'others', modules: ['eat', 'trade', 'loot', 'spawns', 'huntStats', 'routes'] },
  ];
  const TAB_IDS = TABS.map((t) => t.id);

  /** The 10 modules (design config "modules" map), regrouped per tab (REQ-26). */
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
      tutorial: null,          // null | {step: number} — first-run stepper
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
      trainerForm: {
        capMode: '', capFullThreshold: '', fallbackSlot: '', fallbackManaPct: '',
        reserve: '', eatMagic: '', eatMagicSlot: '',
      },
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
   * @param {object} state
   * @returns {object} trainerForm-shaped value strings
   */
  function trainerFormFromConfig(state) {
    const cfg = state.config && state.config.modules || {};
    const runes = cfg.runes || {};
    const training = cfg.training || {};
    const ew = training.eatWithMagic && typeof training.eatWithMagic === 'object'
      ? training.eatWithMagic : {};
    const threshold = Number(runes.capFullThreshold);
    const pct = Number(runes.fallbackManaPct);
    return {
      capMode: runes.capMode === 'off' ? 'off' : 'strict',
      capFullThreshold: String(Number.isFinite(threshold) ? Math.round(threshold * 100) : 100),
      fallbackSlot: runes.fallbackSlot !== null && runes.fallbackSlot !== undefined
        ? String(runes.fallbackSlot) : '',
      fallbackManaPct: String(Number.isFinite(pct) ? Math.round(pct * 100) : 50),
      reserve: Number.isFinite(Number(training.reserve)) ? String(training.reserve) : '',
      eatMagic: ew.enabled === true ? 'true' : 'false',
      eatMagicSlot: ew.slot !== null && ew.slot !== undefined ? String(ew.slot) : '',
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
        const lang = action.lang === LANG_ES ? LANG_ES : LANG_EN;
        return { state: Object.assign({}, state, { lang }), effects: [] };
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
        // is harmless.
        const key = String(action.key || '');
        const TRAINER_KEYS = ['capMode', 'capFullThreshold', 'fallbackSlot', 'fallbackManaPct',
          'reserve', 'eatMagic', 'eatMagicSlot'];
        if (TRAINER_KEYS.indexOf(key) === -1) return { state, effects: [] };
        const trainerForm = Object.assign({}, state.trainerForm || {
          capMode: '', capFullThreshold: '', fallbackSlot: '', fallbackManaPct: '',
          reserve: '', eatMagic: '', eatMagicSlot: '',
        });
        trainerForm[key] = String(action.value === null || action.value === undefined ? '' : action.value);
        return { state: Object.assign({}, state, { trainerForm }), effects: [] };
      }

      case 'SAVE_TRAINER_SETTINGS': {
        // REQ-30/31/32 (PR4): commit the TRAINER form into the config.
        // Percent inputs (cap full threshold, fallback mana) convert to the
        // 0..1 ratios the agent compares; the cap settings land in
        // config.modules.runes (the config shape owns them, D3) and the
        // reserve + eat-with-magic land in config.modules.training (D2/D4).
        // Invalid values are refused with a visible reason — never silently
        // dropped. The push-config effect carries the change to the agent.
        if (state.gate !== GATE_ARMED) return { state: refuse(state, action), effects: [] };
        const form = state.trainerForm || {};
        const at = Date.now();
        const invalid = (reason) => ({
          state: Object.assign({}, state, { refusal: { action: 'SAVE_TRAINER_SETTINGS', module: 'training', reason, at } }),
          effects: [],
        });
        // The cap-mode select always renders a value (strict/off) — an
        // untouched form (empty) means the default 'strict'.
        const capMode = String(form.capMode || '').trim() || 'strict';
        const rawThreshold = String(form.capFullThreshold || '').trim();
        const rawFallbackSlot = String(form.fallbackSlot || '').trim();
        const rawFallbackPct = String(form.fallbackManaPct || '').trim();
        const rawReserve = String(form.reserve || '').trim();
        const eatMagic = String(form.eatMagic || '');
        const rawEatSlot = String(form.eatMagicSlot || '').trim();
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
        return {
          state: Object.assign({}, state, {
            config,
            trainerForm: {
              capMode, capFullThreshold: String(threshold), fallbackSlot: fallbackSlot === null ? '' : String(fallbackSlot),
              fallbackManaPct: String(fallbackPct), reserve: String(reserve),
              eatMagic, eatMagicSlot: eatSlot === null ? '' : String(eatSlot),
            },
            refusal: null,
          }),
          effects: [{ type: 'push-config' }],
        };
      }

      case 'RESET':
        return { state: reset(), effects: [] };

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

  /** REQ-25: offer row HTML (word + time + best-effort sid + Confirm/Decline). */
  function renderOffer(offer) {
    const when = offer.ts
      ? new Date(offer.ts).toLocaleTimeString() + ' ' + new Date(offer.ts).toLocaleDateString()
      : 'now';
    const sid = Number.isInteger(offer.sid) ? offer.sid : null;
    return '<div class="learning-offer">'
      + '<code>' + escapeHtml(offer.word) + '</code>'
      + ' <span class="offer-time">(' + escapeHtml(when) + (sid !== null ? ', sid ' + sid : '') + ')</span>'
      + ' <button type="button" class="offer-btn" data-offer-action="confirm" data-word="' + escapeHtml(offer.word) + '">Confirm</button>'
      + ' <button type="button" class="offer-btn" data-offer-action="decline" data-word="' + escapeHtml(offer.word) + '">Decline</button>'
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
   * TRAINER settings form (PR4, REQ-30/31/32): rune cap mode + full
   * threshold %, fallback slot + fallback mana %, mana reserve and
   * eat-with-magic (toggle + magic-food slot) + a Save button. Values come
   * from the pure-UI trainerForm state (survive re-renders) falling back to
   * the saved config (ratios shown as percent). The rune spell itself is
   * chosen with the spell picker (picker module 'training', REQ-28); the
   * module toggles live in the TRAINER tab module list.
   * @param {object} state
   * @returns {string}
   */
  function renderTrainerForm(state) {
    const form = state.trainerForm || {};
    const derived = trainerFormFromConfig(state);
    const val = (key) => (form[key] !== '' && form[key] !== undefined ? form[key] : derived[key]);
    const capMode = val('capMode');
    const eatChecked = val('eatMagic') === 'true' ? ' checked' : '';
    return '<div class="trainer-form">'
      + '<h3>' + escapeHtml(t(state, 'trainer.formTitle')) + '</h3>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.capMode'))
      + ' <select id="trainer-cap-mode">'
      + '<option value="strict"' + (capMode === 'strict' ? ' selected' : '') + '>'
      + escapeHtml(t(state, 'trainer.capModeStrict')) + '</option>'
      + '<option value="off"' + (capMode === 'off' ? ' selected' : '') + '>'
      + escapeHtml(t(state, 'trainer.capModeOff')) + '</option>'
      + '</select></label>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.capFullThreshold'))
      + ' <input type="number" id="trainer-cap-threshold" min="0" max="100" step="1" value="' + escapeHtml(val('capFullThreshold')) + '"></label>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.fallbackSlot'))
      + ' <input type="number" id="trainer-fallback-slot" min="1" max="12" step="1" value="' + escapeHtml(val('fallbackSlot')) + '"></label>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.fallbackManaPct'))
      + ' <input type="number" id="trainer-fallback-pct" min="0" max="100" step="1" value="' + escapeHtml(val('fallbackManaPct')) + '"></label>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.reserve'))
      + ' <input type="number" id="trainer-reserve" min="0" step="1" value="' + escapeHtml(val('reserve')) + '"></label>'
      + '<label class="trainer-field trainer-check">'
      + '<input type="checkbox" id="trainer-eat-magic"' + eatChecked + '> '
      + escapeHtml(t(state, 'trainer.eatWithMagic')) + '</label>'
      + '<label class="trainer-field">' + escapeHtml(t(state, 'trainer.eatMagicSlot'))
      + ' <input type="number" id="trainer-eat-magic-slot" min="1" max="12" step="1" value="' + escapeHtml(val('eatMagicSlot')) + '"></label>'
      + '<button type="button" id="trainer-save-btn">' + escapeHtml(t(state, 'trainer.save')) + '</button>'
      + '</div>';
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
      body = renderHealForm(state) + renderTrainerForm(state) + renderProfileLoader(state)
        + renderSpellPicker(state)
        + '<div class="routes-form">'
        + '<h3>Routes (v1)</h3>'
        + '<label class="route-coord">X <input type="number" id="route-x" value="' + escapeHtml(wt.x) + '" step="any"></label>'
        + '<label class="route-coord">Y <input type="number" id="route-y" value="' + escapeHtml(wt.y) + '" step="any"></label>'
        + '<button type="button" id="route-walk-btn">Walk to</button>'
        + '<p class="routes-future">Route recording — FUTURE (out of scope in v1).</p>'
        + '</div>';
    } else {
      body = '<div class="config-shell">' + escapeHtml(t(state, 'configLocked')) + '</div>';
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
        parts.push('<div class="premium-required">Premium required — '
          + blocked.map((b) => escapeHtml(b.label)).join(', ')
          + ' stay disabled (REQ-22).</div>');
      }
      const offers = snapshotOffers(state.snapshot);
      if (offers.length > 0) {
        parts.push('<div class="offers">'
          + '<h3>Registration offers</h3>'
          + offers.map(renderOffer).join('')
          + '</div>');
      }
      // Slice-6 polish (REQ-17/23): module alert states wired into the live
      // view — the eat 3-fail pause alert and the routes autowalk read.
      const modules = state.snapshot.agent && state.snapshot.agent.modules
        ? state.snapshot.agent.modules : null;
      if (modules && modules.eat && modules.eat.paused === true) {
        parts.push('<div class="module-alert alert-eat">Eating paused — 3 consecutive failed attempts.</div>');
      }
      // Slice 3 (PR4, REQ-30, D3): the trainer's strict-CAP state — the panel
      // ALERT + beep fire on the rising edge (app.js); this line keeps the
      // cap-full condition VISIBLE while it persists.
      if (modules && modules.training && modules.training.capFull === true) {
        parts.push('<div class="module-alert alert-cap-full">'
          + escapeHtml(t(state, 'trainer.capFullAlert')) + '</div>');
      }
      if (modules && modules.routes) {
        const r = modules.routes;
        let line;
        if (r.available !== true) {
          line = 'Routes: ' + (r.reason || 'no pathfinder data');
        } else if (r.isAutoWalking === true) {
          line = 'Auto-walking: '
            + (Number.isInteger(r.stepsRemaining) ? r.stepsRemaining + ' steps remaining' : 'in progress');
          if (r.destination && Number.isFinite(r.destination.x) && Number.isFinite(r.destination.y)) {
            line += ' to (' + r.destination.x + ', ' + r.destination.y + ')';
          }
        } else {
          line = 'Routes: not auto-walking';
        }
        parts.push('<div class="routes-state">' + escapeHtml(line) + '</div>');
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

  /** Full panel body render (status bar + tabs + config + live state + log
   *  + tutorial overlay). */
  function renderPanel(state) {
    return '<main id="panel-root">'
      + renderStatusBar(state)
      + renderModuleList(state)
      + renderConfigForm(state)
      + renderLiveState(state)
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
    snapshotStats,
    formatLogResult,
    renderOffer,
    renderStatusBar,
    renderModuleList,
    renderProfileLoader,
    renderSpellPicker,
    renderConfigForm,
    healFormFromConfig,
    renderHealForm,
    trainerFormFromConfig,
    renderTrainerForm,
    renderLiveState,
    renderLog,
    renderTutorial,
    renderPanel,
  };
});
