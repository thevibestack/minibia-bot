'use strict';

/**
 * Slice-6 panel tests (REQ-23, REQ-08/09 polish): walk-to action gating +
 * effect emission, walk-to form state survival, eat-pause + routes alert
 * rendering in the live view, and the per-character pre-fill on CHARACTER
 * SELECT (saved config fetched when the identity confirms, before Connect).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PANEL_DIR = path.join(__dirname, '..', '..', 'app', 'panel');
const INDEX_HTML = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8');
const STATE_JS = fs.readFileSync(path.join(PANEL_DIR, 'state.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(PANEL_DIR, 'app.js'), 'utf8');

const P = require('../../app/panel/state.js');
const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

/** Snapshot payload shaped like the app's SNAPSHOT_EXPRESSION result. */
function snapshotWith(modules) {
  return { stats: { health: 42 }, agent: { modules } };
}

/** Drive the pure state to armed. */
function armedState() {
  let state = P.createInitialState();
  state = P.panelReducer(state, { type: 'PROBE_START' }).state;
  state = P.panelReducer(state, { type: 'PROBE_RESULT', identity: FLAMAMEX }).state;
  state = P.panelReducer(state, { type: 'CONNECT' }).state;
  return state;
}

/* ------------------------------ pure state ------------------------------ */

test('REQ-23: WALK_TO refused pre-Connect ("not connected")', () => {
  const state = P.createInitialState();
  const r = P.panelReducer(state, { type: 'WALK_TO', x: 150, y: 200 });
  assert.equal(r.effects.length, 0);
  assert.equal(r.state.refusal.reason, 'not connected');
});

test('REQ-23: armed WALK_TO emits the walk-to effect with numeric coordinates', () => {
  const state = armedState();
  const r = P.panelReducer(state, { type: 'WALK_TO', x: '150', y: '200.5' });
  assert.deepEqual(r.effects, [{ type: 'walk-to', x: 150, y: 200.5 }]);
});

test('REQ-23: WALK_TO with empty or non-numeric inputs is ignored (no effect, no refusal)', () => {
  const state = armedState();
  for (const bad of [{ x: '', y: '5' }, { x: '5', y: '' }, { x: 'a', y: '5' }, { x: null, y: 5 }]) {
    const r = P.panelReducer(state, { type: 'WALK_TO', x: bad.x, y: bad.y });
    assert.equal(r.effects.length, 0, 'no effect for ' + JSON.stringify(bad));
  }
});

test('REQ-23: UPDATE_WALK_INPUT preserves the form values across re-renders', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_WALK_INPUT', key: 'x', value: '120' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_WALK_INPUT', key: 'y', value: '80' }).state;
  assert.deepEqual(state.walkTo, { x: '120', y: '80' });
  const r = P.panelReducer(state, { type: 'UPDATE_WALK_INPUT', key: 'x', value: '' });
  assert.deepEqual(r.state.walkTo, { x: '', y: '80' });
});

test('REQ-23: renderConfigForm shows the Routes v1 walk-to form + FUTURE marker when armed', () => {
  const state = armedState();
  const html = P.renderConfigForm(state);
  assert.match(html, /id="route-x"/);
  assert.match(html, /id="route-y"/);
  assert.match(html, /id="route-walk-btn"/);
  assert.match(html, /Route recording — FUTURE \(out of scope in v1\)/);
  assert.ok(!html.includes('Configuration unlocks after Connect'));
});

test('REQ-23: renderConfigForm hides the walk-to form before Connect', () => {
  const html = P.renderConfigForm(P.createInitialState());
  assert.match(html, /Configuration unlocks after Connect/);
  assert.ok(!html.includes('route-walk-btn'));
});

test('REQ-17 (polish): renderLiveState shows the eat 3-fail pause alert from the snapshot', () => {
  const state = P.createInitialState();
  state.snapshot = snapshotWith({ eat: { on: true, paused: true } });
  const html = P.renderLiveState(state);
  assert.match(html, /Eating paused — 3 consecutive failed attempts/);
});

test('REQ-23 (polish): renderLiveState shows the routes autowalk read — steps + destination', () => {
  const state = P.createInitialState();
  state.snapshot = snapshotWith({
    routes: { available: true, isAutoWalking: true, stepsRemaining: 12, destination: { x: 120, y: 140 } },
  });
  const html = P.renderLiveState(state);
  assert.match(html, /Auto-walking: 12 steps remaining to \(120, 140\)/);
});

test('REQ-23 (polish): renderLiveState shows honest routes states — not walking / no pathfinder data', () => {
  const idle = P.createInitialState();
  idle.snapshot = snapshotWith({ routes: { available: true, isAutoWalking: false, stepsRemaining: null } });
  assert.match(P.renderLiveState(idle), /Routes: not auto-walking/);

  const noPf = P.createInitialState();
  noPf.snapshot = snapshotWith({ routes: { available: false, reason: 'no pathfinder data' } });
  assert.match(P.renderLiveState(noPf), /Routes: no pathfinder data/);
});

/* --------------------------- jsdom shell --------------------------- */

function makePanel({ fetchStub } = {}) {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://127.0.0.1:9222/',
    runScripts: 'dangerously',
  });
  if (fetchStub) {
    dom.window.fetch = async (url, opts) => fetchStub(dom.window, url, opts);
  }
  dom.window.eval(STATE_JS);
  dom.window.eval(APP_JS);
  return dom;
}

function teardown(dom) {
  try {
    if (dom.window.__mbPanel && typeof dom.window.__mbPanel.stop === 'function') dom.window.__mbPanel.stop();
  } catch { /* best-effort */ }
  dom.window.close();
}

function clickById(dom, id) {
  const btn = dom.window.document.getElementById(id);
  assert.ok(btn, 'button ' + id + ' rendered');
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

test('REQ-09 (polish, jsdom): character select pre-fills the SAVED config before Connect', async () => {
  const requests = [];
  const dom = makePanel({
    fetchStub: async (win, url, opts) => {
      if (url === '/api/identity' && !opts) return { json: async () => ({ identity: FLAMAMEX }) };
      if (url === '/api/snapshot') return { json: async () => ({ stats: { health: 55 } }) };
      requests.push({ url, method: opts && opts.method });
      if (url.startsWith('/api/character-config')) {
        return {
          json: async () => ({
            ok: true,
            config: { character: 'Flamamex', modules: { trade: { on: true, message: 'WTS runes' } } },
          }),
        };
      }
      if (url === '/api/connect' && opts && opts.method === 'POST') {
        return { json: async () => ({ ok: true, identity: FLAMAMEX, config: null }) };
      }
      return { json: async () => ({ ok: true }) };
    },
  });
  try {
    const panel = dom.window.__mbPanel;
    await new Promise((r) => setTimeout(r, 250));
    // Confirmed WITHOUT clicking Connect: the saved config pre-filled.
    assert.equal(panel.getState().gate, 'confirmed');
    assert.equal(panel.getState().modules.trade, true, 'saved toggle pre-filled on character select (REQ-09)');
    const prefillReq = requests.find((rq) => rq.url.startsWith('/api/character-config'));
    assert.ok(prefillReq, 'saved config fetched for the confirmed character');
    assert.match(prefillReq.url, /name=Flamamex/);
  } finally {
    teardown(dom);
  }
});

test('REQ-23 (jsdom): the Walk button posts /api/walk-to with the form coordinates', async () => {
  const requests = [];
  const dom = makePanel({
    fetchStub: async (win, url, opts) => {
      if (url === '/api/identity' && !opts) return { json: async () => ({ identity: FLAMAMEX }) };
      if (url === '/api/snapshot') return { json: async () => ({ stats: { health: 55 } }) };
      requests.push({ url, method: opts && opts.method, body: opts && opts.body });
      if (url === '/api/character-config') {
        return { json: async () => ({ ok: true, config: { character: 'Flamamex' } }) };
      }
      if (url === '/api/connect' && opts && opts.method === 'POST') {
        return { json: async () => ({ ok: true, identity: FLAMAMEX, config: { character: 'Flamamex' } }) };
      }
      if (url === '/api/walk-to') return { json: async () => ({ ok: true, x: 150, y: 200, result: { ok: true } }) };
      return { json: async () => ({ ok: true }) };
    },
  });
  try {
    const panel = dom.window.__mbPanel;
    await new Promise((r) => setTimeout(r, 250));
    clickById(dom, 'connect-btn');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(panel.getState().gate, 'armed');

    // Type into the walk-to inputs (the 'input' event keeps the values).
    // NOTE: each dispatch re-renders the form, so re-query between inputs
    // (exactly like a real user typing into the live DOM).
    var xInput = dom.window.document.getElementById('route-x');
    assert.ok(xInput, 'walk-to inputs rendered when armed');
    xInput.value = '150';
    xInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    var yInput = dom.window.document.getElementById('route-y');
    assert.ok(yInput, 'y input still rendered after the x re-render');
    yInput.value = '200';
    yInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // A re-render (snapshot poll) must not wipe the typed values.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(dom.window.document.getElementById('route-x').value, '150', 'x survives re-render');
    assert.equal(dom.window.document.getElementById('route-y').value, '200', 'y survives re-render');

    clickById(dom, 'route-walk-btn');
    await new Promise((r) => setTimeout(r, 100));
    const walkReq = requests.find((rq) => rq.url === '/api/walk-to');
    assert.ok(walkReq, 'Walk posts to /api/walk-to (REQ-23)');
    const body = JSON.parse(walkReq.body);
    assert.equal(body.x, 150);
    assert.equal(body.y, 200);
    assert.equal(body.character, 'Flamamex');
  } finally {
    teardown(dom);
  }
});

test('REQ-23 (jsdom): Walk button pre-Connect is refused by the gate (no /api/walk-to)', async () => {
  const requests = [];
  const dom = makePanel({
    fetchStub: async (win, url, opts) => {
      if (url === '/api/identity' && !opts) return { json: async () => ({ identity: FLAMAMEX }) };
      if (url === '/api/snapshot') return { json: async () => ({ stats: { health: 55 } }) };
      requests.push({ url, method: opts && opts.method });
      return { json: async () => ({ ok: true }) };
    },
  });
  try {
    const panel = dom.window.__mbPanel;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(panel.getState().gate, 'confirmed');
    assert.ok(!dom.window.document.getElementById('route-walk-btn'), 'no walk-to form pre-Connect');
    assert.equal(panel.getState().refusal, null);
    const walkReq = requests.find((rq) => rq.url === '/api/walk-to');
    assert.ok(!walkReq, 'no walk-to request pre-Connect');
  } finally {
    teardown(dom);
  }
});
