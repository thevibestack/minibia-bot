'use strict';

/**
 * Panel jsdom tests (task 3.5, REQ-02/08/09): the panel shell rendered in
 * a real DOM — gate blocks module toggles pre-Connect, connect flow arms
 * with per-character pre-fill, no network needed (fetch stubbed).
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

const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

/**
 * jsdom page with the real panel shell. `fetchStub` (async (url, opts) ->
 * Response-like {json()}) is installed BEFORE app.js evaluates, so polling
 * and the connect flow use it. Without a stub the panel still renders and
 * dispatches (app.js feature-detects fetch).
 */
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

function toggleById(dom, moduleId, on) {
  const input = dom.window.document.querySelector('input[data-module="' + moduleId + '"]');
  assert.ok(input, 'toggle for ' + moduleId + ' rendered');
  input.checked = on;
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function clickById(dom, id) {
  const btn = dom.window.document.getElementById(id);
  assert.ok(btn, 'button ' + id + ' rendered');
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

test('REQ-08: panel boots into the shell — status bar, dashboard + visible toggles, config + live sections', () => {
  const dom = makePanel();
  try {
    const doc = dom.window.document;
    assert.match(doc.getElementById('status-bar').textContent, /Disconnected/);
    // 4 dashboard card toggles + healMagic + runes + training + eat tab toggles.
    assert.equal(doc.querySelectorAll('input[data-module]').length, 8, '4 dashboard cards + 4 visible tab toggles');
    assert.equal(doc.querySelectorAll('.dashboard-card').length, 4, 'dashboard grid renders 4 cards');
    assert.ok(doc.getElementById('config-form'));
    assert.ok(doc.getElementById('live-state'));
    assert.match(doc.getElementById('live-state').textContent, /No snapshot yet/);
    assert.equal(dom.window.__mbPanel.getState().gate, 'disconnected');
    assert.equal(dom.window.__mbPanel.getState().tab, 'dashboard', 'dashboard is the default tab');
  } finally {
    teardown(dom);
  }
});

test('REQ-02: toggles are refused pre-Connect — "not connected" surfaces in the UI', () => {
  const dom = makePanel();
  try {
    toggleById(dom, 'healMagic', true);
    const s = dom.window.__mbPanel.getState();
    assert.equal(s.modules.healMagic, false, 'toggle NOT applied pre-Connect');
    assert.equal(s.refusal.reason, 'not connected');
    assert.match(dom.window.document.getElementById('status-bar').textContent, /refused: not connected/);
    const input = dom.window.document.querySelector('input[data-module="healMagic"]');
    assert.equal(input.checked, false, 'checkbox stays unchecked');
    assert.equal(input.disabled, true, 'toggle disabled pre-Connect');
  } finally {
    teardown(dom);
  }
});

test('REQ-02: probing shows the player identity once readable; Connect arms', async () => {
  const dom = makePanel({ fetchStub: async () => ({ json: async () => ({ identity: FLAMAMEX }) }) });
  try {
    await new Promise((r) => setTimeout(r, 60)); // one poll tick (500ms cadence — first poll fires immediately)
    const s = dom.window.__mbPanel.getState();
    assert.equal(s.gate, 'confirmed');
    assert.equal(s.identity.name, 'Flamamex');
    assert.match(dom.window.document.getElementById('status-bar').textContent, /Flamamex.*druid/);
    assert.ok(dom.window.document.getElementById('connect-btn'), 'Connect button rendered');
  } finally {
    teardown(dom);
  }
});

test('REQ-02/09: full connect flow — click Connect, per-character config pre-fills, toggles apply', async () => {
  const saved = {
    character: 'Flamamex',
    connected: false,
    modules: { trade: { on: true, message: 'WTS blank runes', intervalMs: 180000 } },
  };
  const dom = makePanel({
    fetchStub: async (win, url, opts) => {
      if (url === '/api/identity') return { json: async () => ({ identity: FLAMAMEX }) };
      if (url === '/api/snapshot') return { json: async () => ({ stats: { health: 55 } }) };
      if (url === '/api/connect' && opts.method === 'POST') {
        assert.match(JSON.parse(opts.body).character, /Flamamex/);
        return { json: async () => ({ ok: true, identity: FLAMAMEX, config: saved }) };
      }
      return { json: async () => ({ ok: true }) };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 60));
    clickById(dom, 'connect-btn');
    await new Promise((r) => setTimeout(r, 40)); // effect executor round-trip

    const s = dom.window.__mbPanel.getState();
    assert.equal(s.gate, 'armed', 'gate armed after Connect');
    assert.equal(s.modules.trade, true, 'saved config pre-fills the toggle (REQ-09)');

    // Toggles now apply.
    toggleById(dom, 'healMagic', true);
    assert.equal(dom.window.__mbPanel.getState().modules.healMagic, true, 'armed toggle applies');
    assert.equal(dom.window.__mbPanel.getState().refusal, null);
    const input = dom.window.document.querySelector('input[data-module="healMagic"]');
    assert.equal(input.disabled, false, 'toggles enabled when armed');
  } finally {
    teardown(dom);
  }
});

test('REQ-02: Disconnect resets the gate; toggles refused again', async () => {
  const dom = makePanel({
    fetchStub: async (win, url, opts) => {
      if (url === '/api/identity') return { json: async () => ({ identity: FLAMAMEX }) };
      if (url === '/api/connect') return { json: async () => ({ ok: true, identity: FLAMAMEX, config: { character: 'Flamamex' } }) };
      return { json: async () => ({ ok: true }) };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 60));
    clickById(dom, 'connect-btn');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(dom.window.__mbPanel.getState().gate, 'armed');

    clickById(dom, 'disconnect-btn');
    assert.equal(dom.window.__mbPanel.getState().gate, 'disconnected');
    assert.equal(dom.window.__mbPanel.getState().identity, null, 'identity cleared on disconnect');

    toggleById(dom, 'runes', true);
    assert.equal(dom.window.__mbPanel.getState().modules.runes, false, 'refused again after reset');
  } finally {
    teardown(dom);
  }
});

test('REQ-02: failed connect returns to confirmed with the error shown', async () => {
  const dom = makePanel({
    fetchStub: async (win, url, opts) => {
      if (url === '/api/identity') return { json: async () => ({ identity: FLAMAMEX }) };
      if (url === '/api/connect') return { json: async () => ({ ok: false, reason: 'agent unreachable' }) };
      return { json: async () => ({ ok: true }) };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 60));
    clickById(dom, 'connect-btn');
    await new Promise((r) => setTimeout(r, 40));
    const s = dom.window.__mbPanel.getState();
    assert.equal(s.gate, 'confirmed', 'not armed when the server refuses');
    assert.match(s.lastError, /agent unreachable/);
    assert.match(dom.window.document.getElementById('status-bar').textContent, /agent unreachable/);
  } finally {
    teardown(dom);
  }
});

test('REQ-08: snapshot polling renders the live state view', async () => {
  const dom = makePanel({
    fetchStub: async (win, url) => {
      if (url === '/api/identity') return { json: async () => ({ identity: null }) };
      if (url === '/api/snapshot') return { json: async () => ({ stats: { health: 42, mana: 80 }, ok: true }) };
      return { json: async () => ({}) };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 60));
    const text = dom.window.document.getElementById('live-state').textContent;
    // REQ-26 (slice 1a): the live view renders READABLE stats — never the raw
    // JSON payload (the old <pre class="live-payload"> is gone).
    assert.match(text, /Health 42/);
    assert.match(text, /Mana 80/);
    assert.ok(!text.includes('{'), 'no raw JSON in the live view');
  } finally {
    teardown(dom);
  }
});

test('REQ-11 (T4): alerts section is MOUNTED — ALERT entries appear in #panel-alerts', () => {
  const dom = makePanel();
  try {
    const alertsSection = dom.window.document.getElementById('panel-alerts');
    assert.ok(alertsSection, 'the #panel-alerts container exists in the production shell');
    assert.match(alertsSection.textContent, /Alerts/, 'section renders its localized title');
    assert.match(alertsSection.textContent, /No alerts yet/, 'empty state shows until an alert fires');

    dom.window.__mbPanel.dispatch({ type: 'ALERT', kind: 'info', message: 'hotbar drift detected' });
    const mounted = dom.window.document.getElementById('panel-alerts');
    assert.match(mounted.textContent, /hotbar drift detected/, 'alert message mounts into #panel-alerts');
    assert.equal(dom.window.__mbPanel.getState().alerts.length, 1);
  } finally {
    teardown(dom);
  }
});
