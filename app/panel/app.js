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

  /* ------------------------------- render ------------------------------- */

  function render() {
    var el = function (id) { return document.getElementById(id); };
    var statusBar = el('status-bar');
    var moduleList = el('module-list');
    var configForm = el('config-form');
    var liveState = el('live-state');
    if (statusBar) statusBar.innerHTML = P.renderStatusBar(state);
    if (moduleList) moduleList.innerHTML = P.renderModuleList(state);
    if (configForm) configForm.innerHTML = P.renderConfigForm(state);
    if (liveState) liveState.innerHTML = P.renderLiveState(state);
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

  /* ---------------------------- effect executor ------------------------- */

  function executeEffect(effect) {
    if (!fetchImpl) return; // tests without network: state machine only
    switch (effect.type) {
      case 'connect': {
        var name = state.identity ? state.identity.name : null;
        postJson('/api/connect', { character: name }).then(function (res) {
          if (res && res.ok) {
            dispatch({ type: 'PREFILL_CONFIG', config: res.config });
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
        postJson('/api/config', { character: state.identity ? state.identity.name : null, config: cfg });
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
    return state;
  }

  /* ------------------------------- polling ------------------------------ */

  function poll() {
    jsonRequest('/api/identity').then(function (res) {
      if (res) dispatch({ type: 'PROBE_RESULT', identity: res.identity });
    });
    jsonRequest('/api/snapshot').then(function (res) {
      if (res) dispatch({ type: 'SNAPSHOT', data: res });
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
    }
  });

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.matches) return;
    if (target.matches('#connect-btn')) dispatch({ type: 'CONNECT' });
    else if (target.matches('#cancel-btn')) dispatch({ type: 'CANCEL' });
    else if (target.matches('#disconnect-btn')) dispatch({ type: 'DISCONNECT' });
  });

  /* -------------------------------- boot -------------------------------- */

  render();
  startPolling();

  window.__mbPanel = {
    dispatch: dispatch,
    getState: function () { return state; },
    stop: stopPolling,
  };
})();
