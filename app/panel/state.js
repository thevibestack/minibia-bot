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

  /** The 10 modules (design config "modules" map). */
  const MODULE_DEFS = [
    { id: 'healItems', label: 'Heal with items' },
    { id: 'healMagic', label: 'Heal with magic' },
    { id: 'runes', label: 'Runes' },
    { id: 'training', label: 'Magic training' },
    { id: 'eat', label: 'Eat' },
    { id: 'trade', label: 'Auto trade broadcast' },
    { id: 'loot', label: 'Auto-loot' },
    { id: 'spawns', label: 'Spawn maps' },
    { id: 'huntStats', label: 'Hunt stats' },
    { id: 'routes', label: 'Routes' },
  ];
  const MODULE_IDS = MODULE_DEFS.map((m) => m.id);

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
      refusal: null,           // last refused action {action, module, reason, at}
      lastError: null,
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

  /* ------------------------------ render ------------------------------ */

  /** Status bar: gate state, confirmed player, refusal/error, controls. */
  function renderStatusBar(state) {
    const parts = [];
    parts.push('<span class="gate gate-' + state.gate + '">' + escapeHtml(gateLabel(state)) + '</span>');
    if (state.identity) {
      parts.push('<span class="player">' + escapeHtml(state.identity.name)
        + ' <em>(' + escapeHtml(state.identity.vocationLabel || '?') + ')</em></span>');
    }
    if (state.gate === GATE_CONFIRMED) {
      parts.push('<button type="button" id="connect-btn">Connect</button>');
      parts.push('<button type="button" id="cancel-btn">Cancel</button>');
    }
    if (state.gate === GATE_ARMED) {
      parts.push('<button type="button" id="disconnect-btn">Disconnect</button>');
    }
    if (state.refusal) {
      parts.push('<span class="refusal">refused: ' + escapeHtml(state.refusal.reason) + '</span>');
    }
    if (state.lastError) {
      parts.push('<span class="error">' + escapeHtml(state.lastError) + '</span>');
    }
    return '<div class="status-bar">' + parts.join(' ') + '</div>';
  }

  /** Module toggle list — all 10 modules; disabled (refused) pre-arm. */
  function renderModuleList(state) {
    const rows = MODULE_DEFS.map((def) => {
      const checked = state.modules[def.id] === true;
      const disabled = state.gate !== GATE_ARMED ? ' disabled' : '';
      return '<label class="module-toggle"><input type="checkbox" data-module="' + def.id + '"'
        + (checked ? ' checked' : '') + disabled + '> ' + escapeHtml(def.label) + '</label>';
    });
    return '<div class="module-list">' + rows.join('') + '</div>';
  }

  /** Config form SHELL — real per-module settings forms land with slices 4-6. */
  function renderConfigForm(state) {
    const head = '<h2>Configuration</h2>';
    const body = state.gate === GATE_ARMED
      ? '<div class="config-shell">Select a module to configure — settings forms arrive with the module slices.</div>'
      : '<div class="config-shell">Configuration unlocks after Connect.</div>';
    return '<section class="config-form">' + head + body + '</section>';
  }

  /** Live state view placeholder — snapshot polling payload (500ms). */
  function renderLiveState(state) {
    const head = '<h2>Live state</h2>';
    let body;
    if (state.snapshot === null) {
      body = '<div class="live-empty">No snapshot yet — connecting…</div>';
    } else {
      body = '<pre class="live-payload">' + escapeHtml(JSON.stringify(state.snapshot, null, 2)) + '</pre>';
    }
    return '<section class="live-state">' + head + body + '</section>';
  }

  /** Full panel body render (status bar + modules + config + live state). */
  function renderPanel(state) {
    return '<main id="panel-root">'
      + renderStatusBar(state)
      + renderModuleList(state)
      + renderConfigForm(state)
      + renderLiveState(state)
      + '</main>';
  }

  return {
    GATE_STATES,
    GATE_DISCONNECTED,
    GATE_PROBING,
    GATE_CONFIRMED,
    GATE_ARMED,
    MODULE_DEFS,
    MODULE_IDS,
    createInitialState,
    panelReducer,
    dispatch,
    gateLabel,
    escapeHtml,
    renderStatusBar,
    renderModuleList,
    renderConfigForm,
    renderLiveState,
    renderPanel,
  };
});
