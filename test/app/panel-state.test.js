'use strict';

/**
 * Panel state tests (tasks 3.2/3.3/3.4): the interconnection gate state
 * machine (REQ-02) and the pure render functions (REQ-08 panel shell).
 * node:test only — no DOM, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('../../app/panel/state.js');

const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

/** Run a reducer chain from the initial state; returns final {state, effects}. */
function run(actions) {
  let state = P.createInitialState();
  const allEffects = [];
  for (const action of actions) {
    const result = P.panelReducer(state, action);
    state = result.state;
    allEffects.push.apply(allEffects, result.effects);
  }
  return { state, effects: allEffects };
}

/* ------------------------------ gate machine ----------------------------- */

test('REQ-02: gate starts disconnected; PROBE_START moves to probing', () => {
  const s = P.createInitialState();
  assert.equal(s.gate, P.GATE_DISCONNECTED);
  const r = P.panelReducer(s, { type: 'PROBE_START' });
  assert.equal(r.state.gate, P.GATE_PROBING);
});

test('REQ-02: probing with no identity keeps polling ("waiting for game")', () => {
  const r = run([{ type: 'PROBE_START' }, { type: 'PROBE_RESULT', identity: null }]);
  assert.equal(r.state.gate, P.GATE_PROBING);
  assert.equal(r.state.identity, null);
  assert.equal(P.gateLabel(r.state), 'Waiting for game…');
});

test('REQ-02: identity readable -> confirmed, name+vocation shown, NOT armed', () => {
  const r = run([{ type: 'PROBE_START' }, { type: 'PROBE_RESULT', identity: FLAMAMEX }]);
  assert.equal(r.state.gate, P.GATE_CONFIRMED);
  assert.deepEqual(r.state.identity, FLAMAMEX);
  assert.equal(P.gateLabel(r.state), 'Confirming connection');
});

test('REQ-02: Connect arms the gate and emits the connect effect', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
  ]);
  assert.equal(r.state.gate, P.GATE_ARMED);
  assert.deepEqual(r.effects, [{ type: 'connect' }]);
});

test('REQ-02: Cancel resets to disconnected (probing + confirmed)', () => {
  const probing = run([{ type: 'PROBE_START' }, { type: 'CANCEL' }]);
  assert.equal(probing.state.gate, P.GATE_DISCONNECTED);
  const confirmed = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CANCEL' },
  ]);
  assert.equal(confirmed.state.gate, P.GATE_DISCONNECTED);
  assert.equal(confirmed.state.identity, null, 'identity cleared on reset');
});

test('REQ-02: Disconnect resets from armed and emits the disconnect effect', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
    { type: 'DISCONNECT' },
  ]);
  assert.equal(r.state.gate, P.GATE_DISCONNECTED);
  assert.equal(r.state.identity, null);
  assert.deepEqual(r.effects, [{ type: 'connect' }, { type: 'disconnect' }]);
});

test('REQ-02: module toggle pre-Connect is REFUSED with "not connected"', () => {
  for (const gate of [P.GATE_DISCONNECTED, P.GATE_PROBING, P.GATE_CONFIRMED]) {
    let state = P.createInitialState();
    if (gate === P.GATE_PROBING) state = P.panelReducer(state, { type: 'PROBE_START' }).state;
    if (gate === P.GATE_CONFIRMED) {
      state = P.panelReducer(state, { type: 'PROBE_START' }).state;
      state = P.panelReducer(state, { type: 'PROBE_RESULT', identity: FLAMAMEX }).state;
    }
    const r = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'healItems', on: true });
    assert.equal(r.state.gate, gate, 'gate unchanged');
    assert.equal(r.state.modules.healItems, false, 'toggle not applied');
    assert.ok(r.state.refusal, 'refusal recorded in ' + gate);
    assert.equal(r.state.refusal.reason, 'not connected');
    assert.equal(r.state.refusal.module, 'healItems');
    assert.deepEqual(r.effects, [], 'no push effect on refusal');
  }
});

test('REQ-02: armed toggle applies, clears the refusal, emits push-config', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
    { type: 'TOGGLE_MODULE', module: 'trade', on: true },
  ]);
  assert.equal(r.state.modules.trade, true);
  assert.equal(r.state.refusal, null);
  assert.deepEqual(r.effects.slice(-1), [{ type: 'push-config' }]);
});

test('REQ-02: unknown module ids are ignored', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
    { type: 'TOGGLE_MODULE', module: 'not-a-module', on: true },
  ]);
  assert.deepEqual(r.state.modules.healItems, false);
  assert.deepEqual(r.effects, [{ type: 'connect' }], 'no push for unknown id');
});

test('REQ-02/09: identity change while ARMED disarms to confirmed with an effect', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
    { type: 'PROBE_RESULT', identity: { name: 'Rooker', vocationId: 1, vocationLabel: 'knight' } },
  ]);
  assert.equal(r.state.gate, P.GATE_CONFIRMED, 'never armed for a different character');
  assert.equal(r.state.identity.name, 'Rooker', 'new identity displayed');
  assert.deepEqual(r.effects.slice(-1), [{ type: 'disarm' }]);
});

test('REQ-02: same-identity polls while armed change nothing', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
  ]);
  assert.equal(r.state.gate, P.GATE_ARMED);
  assert.deepEqual(r.effects, [{ type: 'connect' }]);
});

test('REQ-02: CONNECT_FAILED returns to confirmed with the error surfaced', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
    { type: 'CONNECT_FAILED', message: 'agent unreachable' },
  ]);
  assert.equal(r.state.gate, P.GATE_CONFIRMED);
  assert.equal(r.state.lastError, 'agent unreachable');
});

test('REQ-09: PREFILL_CONFIG pre-fills toggles for the confirmed character', () => {
  const saved = {
    character: 'Flamamex',
    modules: {
      trade: { on: true, message: 'WTS' },
      healItems: { on: true, threshold: 42, slotCids: [3174] },
      spawns: { on: false },
    },
  };
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'PREFILL_CONFIG', config: saved },
  ]);
  assert.equal(r.state.modules.trade, true);
  assert.equal(r.state.modules.healItems, true);
  assert.equal(r.state.modules.spawns, false, 'absent modules default off');
  assert.equal(r.state.modules.runes, false);
  assert.equal(r.state.config.character, 'Flamamex', 'full config mirrored for the armed push');
});

test('REQ-09: PREFILL_CONFIG pre-Connect is refused', () => {
  const r = run([{ type: 'PREFILL_CONFIG', config: { modules: { trade: { on: true } } } }]);
  assert.equal(r.state.modules.trade, false);
  assert.equal(r.state.refusal.reason, 'not connected');
});

/* ------------------------------ render (REQ-08) --------------------------- */

test('REQ-08: renderPanel shows the status bar, the visible toggles, config shell, live view', () => {
  const html = P.renderPanel(P.createInitialState());
  assert.match(html, /Disconnected/, 'gate label rendered');
  const count = (html.match(/class="module-toggle"/g) || []).length;
  assert.equal(count, 4, 'only the 4 visible module toggles render');
  assert.equal((html.match(/data-dashboard-card="/g) || []).length, 4, '4 dashboard quick-access cards');
  for (const def of P.MODULE_DEFS) {
    if (P.HIDDEN_MODULES.has(def.id)) {
      assert.doesNotMatch(html, new RegExp('data-module="' + def.id + '"'), def.id + ' never renders a toggle');
    } else {
      assert.match(html, new RegExp('data-module="' + def.id + '"'), def.id + ' renders its toggle');
    }
  }
  assert.match(html, /Configuration/, 'config form shell');
  assert.match(html, /Live state/, 'live state view placeholder');
  assert.match(html, /No snapshot yet/, 'placeholder state');

  // Connect button appears once the gate is confirmed (REQ-02 explicit Connect).
  const confirmed = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
  ]).state;
  assert.match(P.renderPanel(confirmed), /id="connect-btn"/, 'connect control rendered when confirmed');
});

test('REQ-08: status bar renders the confirmed player with vocation label', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
  ]);
  const html = P.renderStatusBar(r.state);
  assert.match(html, /Flamamex/);
  assert.match(html, /druid/);
  assert.match(html, /id="connect-btn"/, 'Connect button shown pre-arm');
  assert.doesNotMatch(html, /id="disconnect-btn"/, 'not armed yet — no disconnect button');
});

test('REQ-08: refusal text renders in the status bar', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'TOGGLE_MODULE', module: 'healItems', on: true },
  ]);
  const html = P.renderStatusBar(r.state);
  assert.match(html, /refused: not connected/);
});

test('REQ-08: module toggles are disabled until armed', () => {
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
  ]);
  const html = P.renderModuleList(r.state);
  assert.match(html, /disabled/, 'toggles disabled pre-arm');

  const armed = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
  ]);
  assert.doesNotMatch(P.renderModuleList(armed.state), /disabled/, 'toggles enabled when armed');
});

test('REQ-08: render escapes player-controlled strings (XSS-safe)', () => {
  const evil = { name: '<img src=x onerror=alert(1)>', vocationId: 4, vocationLabel: 'druid' };
  const r = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: evil },
  ]);
  const html = P.renderStatusBar(r.state);
  assert.doesNotMatch(html, /<img/, 'name escaped');
  assert.match(html, /&lt;img/);
});

test('REQ-08/26: live view renders readable stats — payload fields never leak raw', () => {
  const r = run([{ type: 'SNAPSHOT', data: { health: 42, weird: '<script>' } }]);
  const html = P.renderLiveState(r.state);
  // REQ-26 (slice 1a): the live view renders the readable stats line, never
  // the raw JSON payload (old <pre class="live-payload"> removed). Payload
  // fields that are not part of the stats surface never reach the DOM.
  assert.match(html, /Health 42/);
  assert.doesNotMatch(html, /<script>/, 'payload never rendered raw');
});

test('REQ-08: alerts and offers are capped at 20 entries', () => {
  let state = P.createInitialState();
  for (let i = 0; i < 25; i += 1) {
    state = P.panelReducer(state, { type: 'ALERT', kind: 'info', message: 'm' + i }).state;
    state = P.panelReducer(state, { type: 'OFFER', word: 'w' + i }).state;
  }
  assert.equal(state.alerts.length, 20);
  assert.equal(state.offers.length, 20);
});

test('gate label helper covers all states', () => {
  assert.equal(P.gateLabel({ gate: P.GATE_DISCONNECTED }), 'Disconnected');
  assert.equal(P.gateLabel({ gate: P.GATE_PROBING }), 'Waiting for game…');
  assert.equal(P.gateLabel({ gate: P.GATE_CONFIRMED }), 'Confirming connection');
  assert.equal(P.gateLabel({ gate: P.GATE_ARMED }), 'Connected');
});
