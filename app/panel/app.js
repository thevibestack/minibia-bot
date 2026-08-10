/* =========================================================================
 * Minibia Desktop Bot — control panel wiring (task 3.4, REQ-08/09).
 *
 * Browser glue around app/panel/state.js (pure). Responsibilities:
 *   - render the panel state into the four shell sections;
 *   - connect flow: PROBE_START -> poll /api/identity (500ms) -> the user
 *     clicks Connect -> POST /api/connect (server pushes applyConfig with
 *     armed:true to the in-page agent) -> per-character pre-fill (REQ-09);
 *   - module toggles (all 10) dispatch TOGGLE_MODULE — the reducer REFUSES
 *     them until the gate is armed ("not connected", REQ-02) and the effect
 *     executor pushes the config to the agent when armed;
 *   - snapshot polling (~500ms, REQ-04) into the live state view.
 *
 * Testability: this file is evaluated in jsdom with a stubbed fetch (or no
 * fetch — the panel still renders and dispatches; polling simply skips).
 * window.__mbPanel = {dispatch, getState, stop} is the test/app surface.
 * ========================================================================= */
(function () {
  'use strict';

  var P = window.MbPanelState;
  if (!P) throw new Error('app.js requires state.js (window.MbPanelState)');

  var POLL_INTERVAL_MS = 500;
  var fetchImpl = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  var state = P.createInitialState();
  var pollTimer = null;
  var prefilledFor = null; // last character whose saved config was pre-fetched
  var lastCapFull = false; // PR4 (REQ-30, D3): rising-edge detection for the cap-full alert
  var lastAntibotSeq = 0;  // PR5 (REQ-33): per-alert-id latch — each NEW anti-bot alert rings once

  /* ------------------------------- render ------------------------------- */

  function render() {
    var el = function (id) { return document.getElementById(id); };
    var statusBar = el('status-bar');
    var moduleList = el('module-list');
    var configForm = el('config-form');
    var liveState = el('live-state');
    var activityLog = el('activity-log');
    var tutorialRoot = el('tutorial-root');
    if (statusBar) statusBar.innerHTML = P.renderStatusBar(state);
    if (moduleList) moduleList.innerHTML = P.renderModuleList(state);
    if (configForm) configForm.innerHTML = P.renderConfigForm(state);
    if (liveState) liveState.innerHTML = P.renderLiveState(state);
    if (activityLog) activityLog.innerHTML = P.renderLog(state);
    if (tutorialRoot) tutorialRoot.innerHTML = P.renderTutorial(state);
  }

  /* ----------------------------- API calls ------------------------------ */

  function jsonRequest(path, opts) {
    if (!fetchImpl) return Promise.resolve(null);
    return fetchImpl(path, opts)
      .then(function (res) {
        return res.json().catch(function () { return null; });
      })
      .catch(function (err) {
        dispatch({ type: 'ERROR', message: 'panel API unreachable: ' + (err && err.message ? err.message : err) });
        return null;
      });
  }

  function postJson(path, body) {
    return jsonRequest(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Full per-character config to push: saved settings + live toggles. */
  function buildPushConfig() {
    var cfg = JSON.parse(JSON.stringify(state.config || {}));
    cfg.modules = cfg.modules || {};
    for (var i = 0; i < P.MODULE_IDS.length; i += 1) {
      var id = P.MODULE_IDS[i];
      if (!cfg.modules[id] || typeof cfg.modules[id] !== 'object') cfg.modules[id] = {};
      cfg.modules[id].on = state.modules[id] === true;
    }
    return cfg;
  }

  /**
   * Slice 1b (REQ-27/28): after Connect the panel fetches the castable spell
   * catalog (filtered server-side) and the profile list for the cross-load
   * offer. Refetches on every connect (new character = new catalog).
   */
  function refreshSpellData() {
    if (!fetchImpl) return;
    jsonRequest('/api/spell-catalog').then(function (res) {
      if (!res) return;
      dispatch({
        type: 'SPELL_CATALOG',
        spells: res.catalog || [],
        playerLevel: res.playerLevel,
        vocationLabel: res.vocationLabel,
        reason: res.ok === false ? res.reason : null,
      });
    });
    jsonRequest('/api/profiles').then(function (res) {
      if (res && Array.isArray(res.profiles)) dispatch({ type: 'PROFILES_LOADED', names: res.profiles });
    });
  }

  /* ---------------------------- effect executor ------------------------- */

  function executeEffect(effect) {
    // REQ-26 (slice 1a): tutorial persistence — localStorage is feature-
    // detected and independent from the API layer.
    if (effect.type === 'tutorial-seen') {
      try {
        window.localStorage.setItem('tutorialSeen', '1');
      } catch (e) { /* private mode / disabled storage: best-effort */ }
      return;
    }
    if (!fetchImpl) return; // tests without network: state machine only
    switch (effect.type) {
      case 'connect': {
        var name = state.identity ? state.identity.name : null;
        postJson('/api/connect', { character: name }).then(function (res) {
          if (res && res.ok) {
            dispatch({ type: 'PREFILL_CONFIG', config: res.config });
            refreshSpellData(); // REQ-27/28: catalog + profiles after Connect
          } else {
            dispatch({ type: 'CONNECT_FAILED', message: (res && res.reason) || 'connect refused' });
          }
        });
        break;
      }
      case 'disconnect':
      case 'disarm':
        postJson('/api/disconnect', {});
        break;
      case 'push-config': {
        var cfg = buildPushConfig();
        postJson('/api/config', { character: state.identity ? state.identity.name : null, config: cfg })
          .then(function (res) {
            // REQ-28 (slice 1b): a refused save (spell no longer castable /
            // mana dropped since the pick) surfaces the server reason in the
            // status bar — never silent.
            if (res && res.ok === false && res.reason) {
              dispatch({ type: 'ERROR', message: 'config refused: ' + res.reason });
            }
          });
        break;
      }
      case 'load-profile': {
        // REQ-27 (slice 1b): cross-load another character's config — the
        // server validates every sid and returns {accepted, rejected}. The
        // accepted config replaces the panel state; the rejection list
        // renders visibly (PROFILE_LOAD_RESULT).
        var from = effect.from;
        postJson('/api/load-profile', {
          character: state.identity ? state.identity.name : null,
          from: from,
        }).then(function (res) {
          if (res && res.ok) {
            dispatch({ type: 'PREFILL_CONFIG', config: res.config });
            dispatch({ type: 'PROFILE_LOAD_RESULT', ok: true, from: res.from, rejected: res.rejected || [] });
          } else {
            dispatch({
              type: 'PROFILE_LOAD_RESULT',
              ok: false,
              from: from,
              reason: (res && res.reason) || 'load failed',
            });
          }
        });
        break;
      }
      case 'walk-to': {
        // REQ-23 (slice 6): the server RPCs the in-page agent, which issues
        // the NATIVE autowalk walk-to through the Action Queue.
        postJson('/api/walk-to', {
          character: state.identity ? state.identity.name : null,
          x: effect.x,
          y: effect.y,
        });
        break;
      }
      case 'offer-confirm':
      case 'offer-decline': {
        // REQ-25: user decision on a learning offer. Confirm -> the server
        // persists the word into the character config (store) and pushes the
        // updated config; Decline -> the server RPCs the agent to silence the
        // word for the session.
        postJson('/api/offer', {
          action: effect.type === 'offer-confirm' ? 'confirm' : 'decline',
          word: effect.word,
          character: state.identity ? state.identity.name : null,
        });
        break;
      }
      case 'antibot-confirm': {
        // REQ-34 (PR5): user confirmed a pending anti-bot pattern — the
        // server persists the confirmation per character and RPCs the agent
        // confirmAntibot (session-confirmed -> later occurrences auto-reply).
        postJson('/api/antibot-confirm', {
          character: state.identity ? state.identity.name : null,
          pattern: effect.pattern,
        });
        break;
      }
      case 'cavebot-command': {
        // REQ-36 (PR6): cavebot skeleton controls reach the in-page agent
        // via the server RPC. The record-stop result carries the recorded
        // waypoints — they land in state.cavebotRecorded so Save writes
        // config.routes (REQ-36 "save = config.routes").
        postJson('/api/cavebot', {
          character: state.identity ? state.identity.name : null,
          command: effect.command,
        }).then(function (res) {
          if (res && effect.command === 'record-stop'
            && res.result && res.result.ok && Array.isArray(res.result.points)) {
            dispatch({ type: 'CAVEBOT_RECORDED', points: res.result.points });
          }
        });
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------ dispatch ------------------------------ */

  function dispatch(action) {
    var result = P.panelReducer(state, action);
    state = result.state;
    render();
    for (var i = 0; i < result.effects.length; i += 1) executeEffect(result.effects[i]);
    // REQ-26 (slice 1a): panel-level alerts ring the audio stub (feature-
    // detected; TRAINER/OTHERS slices route their module alerts through the
    // same ALERT action — the hook is live now, the sound arrives with them).
    if (action && action.type === 'ALERT') beep();
    return state;
  }

  /* ------------------------------- polling ------------------------------ */

  function poll() {
    jsonRequest('/api/identity').then(function (res) {
      if (res) dispatch({ type: 'PROBE_RESULT', identity: res.identity });
      // REQ-09 per-character pre-fill on CHARACTER SELECT (slice 6 polish):
      // as soon as a confirmed identity is known, fetch its saved config so
      // the toggles show the saved state BEFORE Connect. Re-fetches when a
      // DIFFERENT character appears; a completed Connect pre-fill stays
      // authoritative (the guard below skips when the gate left confirmed).
      if (state.gate === P.GATE_CONFIRMED && state.identity && prefilledFor !== state.identity.name) {
        prefilledFor = state.identity.name;
        jsonRequest('/api/character-config?name=' + encodeURIComponent(state.identity.name))
          .then(function (prefillRes) {
            if (prefillRes && prefillRes.config && state.gate === P.GATE_CONFIRMED) {
              dispatch({ type: 'PREFILL_CONFIG', config: prefillRes.config });
            }
          });
      } else if (state.gate === P.GATE_DISCONNECTED) {
        prefilledFor = null;
      }
    });
    jsonRequest('/api/snapshot').then(function (res) {
      if (res) dispatch({ type: 'SNAPSHOT', data: res });
      // PR4 (REQ-30, D3): the trainer's capFull state rides the snapshot —
      // on the RISING edge the panel raises an ALERT (the ALERT dispatch
      // rings the Web Audio beep; the live state view keeps the condition
      // visible while it persists). Falling edge / steady state: silent.
      if (res && res.agent && res.agent.modules && res.agent.modules.training) {
        var capFull = res.agent.modules.training.capFull === true;
        if (capFull && !lastCapFull) {
          dispatch({ type: 'ALERT', kind: 'cap-full', message: 'Rune cap full — rune-making stopped (fallback or idle)' });
        }
        lastCapFull = capFull;
      }
      // PR5 (REQ-33): anti-bot alerts ride the snapshot — each NEW alert id
      // raises the panel ALERT (the ALERT dispatch rings the Web Audio beep);
      // steady state / already-seen ids stay silent. A module restart resets
      // the id sequence (detected by a lower max id) and re-arms the latch.
      if (res && res.agent && res.agent.modules && res.agent.modules.antibot) {
        var antibotAlerts = res.agent.modules.antibot.alerts;
        if (Array.isArray(antibotAlerts) && antibotAlerts.length > 0) {
          var maxSeq = 0;
          for (var ai = 0; ai < antibotAlerts.length; ai += 1) {
            var aid = Number(antibotAlerts[ai].id) || 0;
            if (aid > maxSeq) maxSeq = aid;
          }
          if (maxSeq < lastAntibotSeq) lastAntibotSeq = 0; // agent restart: ids restart
          for (var aj = 0; aj < antibotAlerts.length; aj += 1) {
            var alert = antibotAlerts[aj];
            if ((Number(alert.id) || 0) > lastAntibotSeq) {
              dispatch({
                type: 'ALERT',
                kind: 'antibot-' + (alert.kind || 'event'),
                message: alert.message || 'Anti-bot: ' + (alert.kind || 'event'),
              });
            }
          }
          lastAntibotSeq = maxSeq;
        }
      }
    });
  }

  function startPolling() {
    if (!fetchImpl || pollTimer !== null) return;
    pollTimer = window.setInterval(poll, POLL_INTERVAL_MS);
    dispatch({ type: 'PROBE_START' });
    poll();
  }

  function stopPolling() {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /* ------------------------------ DOM wiring ----------------------------- */

  document.addEventListener('change', function (e) {
    var target = e.target;
    if (target && target.matches && target.matches('input[data-module]')) {
      dispatch({ type: 'TOGGLE_MODULE', module: target.getAttribute('data-module'), on: target.checked });
    } else if (target && target.matches && target.matches('#trainer-eat-magic')) {
      // REQ-32 (PR4): eat-with-magic checkbox — pure UI value (change, not
      // input: checkboxes fire change).
      dispatch({ type: 'UPDATE_TRAINER_INPUT', key: 'eatMagic', value: target.checked ? 'true' : 'false' });
    } else if (target && target.matches && target.matches('#trainer-cap-mode')) {
      // REQ-30 (PR4): cap mode select — pure UI value (selects fire change).
      dispatch({ type: 'UPDATE_TRAINER_INPUT', key: 'capMode', value: target.value });
    } else if (target && target.matches && target.matches('#attack-targeting')) {
      // REQ-35 (PR6): attack targeting select — pure UI value.
      dispatch({ type: 'UPDATE_ATTACK_INPUT', key: 'targeting', value: target.value });
    }
  });

  // Routes v1 (REQ-23, slice 6): keep the walk-to coordinate inputs in
  // panel state so re-renders never wipe the typed values.
  document.addEventListener('input', function (e) {
    var target = e.target;
    if (target && target.matches && (target.matches('#route-x') || target.matches('#route-y'))) {
      dispatch({
        type: 'UPDATE_WALK_INPUT',
        key: target.matches('#route-x') ? 'x' : 'y',
        value: target.value,
      });
    } else if (target && target.matches && target.matches('#spell-search')) {
      // REQ-28 (slice 1b): spell picker search — pure UI state.
      dispatch({ type: 'PICKER_SEARCH', query: target.value });
    } else if (target && target.matches && target.matches('#heal-threshold, #heal-slot, #heal-reserve')) {
      // REQ-29 (PR3): HEAL settings form — pure UI values that survive
      // re-renders; the Save button commits them into the config.
      var healKey = target.matches('#heal-threshold') ? 'threshold'
        : (target.matches('#heal-slot') ? 'slot' : 'reserve');
      dispatch({ type: 'UPDATE_HEAL_INPUT', key: healKey, value: target.value });
    } else if (target && target.matches && target.matches(
      '#trainer-cap-threshold, #trainer-fallback-slot, #trainer-fallback-pct, #trainer-reserve, #trainer-eat-magic-slot')) {
      // REQ-30/31/32 (PR4): TRAINER settings form — pure UI values that
      // survive re-renders; the Save button commits them into the config.
      var trainerKey = target.matches('#trainer-cap-threshold') ? 'capFullThreshold'
        : target.matches('#trainer-fallback-slot') ? 'fallbackSlot'
          : target.matches('#trainer-fallback-pct') ? 'fallbackManaPct'
            : target.matches('#trainer-reserve') ? 'reserve' : 'eatMagicSlot';
      dispatch({ type: 'UPDATE_TRAINER_INPUT', key: trainerKey, value: target.value });
    } else if (target && target.matches && target.matches(
      '#others-food-slot, #others-every-casts, #others-loot-dest, #others-replies')) {
      // REQ-33/34 (PR5): OTHERS settings form — pure UI values that survive
      // re-renders; the Save button commits them into the config.
      var othersKey = target.matches('#others-food-slot') ? 'foodSlot'
        : target.matches('#others-every-casts') ? 'everyCasts'
          : target.matches('#others-loot-dest') ? 'lootDest' : 'antibotReplies';
      dispatch({ type: 'UPDATE_OTHERS_INPUT', key: othersKey, value: target.value });
    } else if (target && target.matches && target.matches('#attack-rune-slot')) {
      // REQ-35 (PR6): ATTACK settings form — pure UI value (the targeting
      // select fires change above; the rune slot is a number input).
      dispatch({ type: 'UPDATE_ATTACK_INPUT', key: 'runeSlot', value: target.value });
    }
  });

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.matches) return;
    if (target.matches('#connect-btn')) dispatch({ type: 'CONNECT' });
    else if (target.matches('#cancel-btn')) dispatch({ type: 'CANCEL' });
    else if (target.matches('#disconnect-btn')) dispatch({ type: 'DISCONNECT' });
    else if (target.matches('#route-walk-btn')) {
      // REQ-23: walk-to via the native autowalk primitive (server RPC).
      var wt = state.walkTo || { x: '', y: '' };
      dispatch({ type: 'WALK_TO', x: wt.x, y: wt.y });
    }
    else if (target.matches('.offer-btn')) {
      // REQ-25: Confirm/Decline on a registration offer.
      var word = target.getAttribute('data-word') || '';
      var action = target.getAttribute('data-offer-action') || '';
      if (action === 'confirm') dispatch({ type: 'CONFIRM_OFFER', word: word });
      else if (action === 'decline') dispatch({ type: 'DECLINE_OFFER', word: word });
    }
    else if (target.matches('.tab-btn')) {
      // REQ-26: product-shell tab navigation (pure UI, no gate).
      dispatch({ type: 'SET_TAB', tab: target.getAttribute('data-tab') });
    }
    else if (target.matches('.lang-btn')) {
      // REQ-26: i18n ES/EN switcher.
      dispatch({ type: 'SET_LANG', lang: target.getAttribute('data-lang') });
    }
    else if (target.matches('[data-tutorial-action]')) {
      // REQ-26: first-run tutorial — Next/Finish advance the stepper (the
      // reducer walks the active tab), Dismiss skips. Finish/dismiss persist
      // 'tutorialSeen' via the tutorial-seen effect.
      var tAction = target.getAttribute('data-tutorial-action');
      if (tAction === 'next') dispatch({ type: 'TUTORIAL_NEXT' });
      else if (tAction === 'dismiss') dispatch({ type: 'TUTORIAL_DISMISS' });
    }
    else if (target.matches('#profile-load-btn')) {
      // REQ-27 (slice 1b): explicit cross-load of the selected profile.
      var profileSelect = document.getElementById('profile-select');
      if (profileSelect && profileSelect.value) {
        dispatch({ type: 'LOAD_PROFILE', from: profileSelect.value });
      }
    }
    else if (target.matches('[data-pick-spell]')) {
      // REQ-28 (slice 1b): pick a spell for the active picker module — the
      // reducer validates vocation (list membership) + current mana.
      dispatch({
        type: 'PICK_SPELL',
        module: target.getAttribute('data-picker-module') || 'healMagic',
        sid: Number(target.getAttribute('data-pick-spell')),
      });
    }
    else if (target.matches('.picker-module-btn')) {
      // REQ-28 (slice 1b): switch the picker target (heal spell / training).
      dispatch({ type: 'PICKER_SET_MODULE', module: target.getAttribute('data-picker-module-btn') });
    }
    else if (target.matches('#heal-save-btn')) {
      // REQ-29 (PR3): commit the HEAL settings form (threshold % -> absolute
      // hp via snapshot maxHealth, slot, reserve) into the config.
      dispatch({ type: 'SAVE_HEAL_SETTINGS' });
    }
    else if (target.matches('#trainer-save-btn')) {
      // REQ-30/31/32 (PR4): commit the TRAINER settings form (cap mode,
      // cap % -> ratio, fallback slot + mana % -> ratio, reserve,
      // eat-with-magic) into the config.
      dispatch({ type: 'SAVE_TRAINER_SETTINGS' });
    }
    else if (target.matches('#others-save-btn')) {
      // REQ-33/34 (PR5): commit the OTHERS settings form (food slot +
      // every-N-casts, loot default destination, anti-bot pattern => reply
      // lines) into the config.
      dispatch({ type: 'SAVE_OTHERS_SETTINGS' });
    }
    else if (target.matches('.antibot-confirm-btn')) {
      // REQ-34 (PR5): confirm the pending anti-bot pattern — the effect
      // posts /api/antibot-confirm (server persists + RPC confirmAntibot).
      dispatch({ type: 'CONFIRM_ANTIBOT', pattern: target.getAttribute('data-antibot-confirm') || '' });
    }
    else if (target.matches('#attack-save-btn')) {
      // REQ-35 (PR6): commit the ATTACK settings form (targeting choice +
      // offensive rune slot) into the config.
      dispatch({ type: 'SAVE_ATTACK_SETTINGS' });
    }
    else if (target.matches('[data-cavebot-command]')) {
      // REQ-36 (PR6): cavebot skeleton controls — record/stop/save/pause/
      // resume/start (the reducer emits the cavebot-command / push-config
      // effects; the record-stop result carries the waypoints to save).
      dispatch({ type: 'CAVEBOT_COMMAND', command: target.getAttribute('data-cavebot-command') });
    }
  });

  /* --------------------------- audio stub (REQ-26) ------------------------ */

  /**
   * Web Audio beep for alerts (design D3 alert path — TRAINER/OTHERS slices
   * reuse this hook). Feature-detected: without AudioContext (or on user-
   * gesture restrictions) it degrades to a silent no-op, never throws.
   * @returns {boolean} true when a beep was actually scheduled
   */
  function beep() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (typeof Ctor !== 'function') return false;
    try {
      var ctx = new Ctor();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0.04;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
      // Best-effort cleanup — some browsers reject sync teardown after stop.
      osc.onended = function () {
        try { ctx.close(); } catch (e) { /* no-op */ }
      };
      return true;
    } catch (e) {
      return false;
    }
  }

  /* -------------------------------- boot -------------------------------- */

  // REQ-26: first-run tutorial — show once, persist 'tutorialSeen' on
  // dismiss/finish (reducer effect). The tutorial walks every tab.
  var tutorialSeen = false;
  try {
    tutorialSeen = window.localStorage && window.localStorage.getItem('tutorialSeen') === '1';
  } catch (e) { tutorialSeen = false; }
  if (!tutorialSeen) dispatch({ type: 'TUTORIAL_START' });

  render();
  startPolling();

  window.__mbPanel = {
    dispatch: dispatch,
    getState: function () { return state; },
    stop: stopPolling,
    beep: beep, // audio stub hook (REQ-26) — exposed for tests + later slices
  };
})();
