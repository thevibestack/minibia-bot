'use strict';

/**
 * PR 3 — HEAL tab jsdom tests (REQ-29): typing the settings form + Save
 * posts /api/config with the percent threshold converted to absolute hp, and
 * the healMagic toggle stays independent of the healItems toggle.
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

const BASE_CFG = { character: 'Flamamex', modules: { healItems: { on: false }, manaItems: { on: false }, healMagic: { on: false, sid: 2 }, training: { on: false } } };

/** jsdom shell with a route-based fetch stub that RECORDS every request. */
function makePanel(routes) {
  const requests = [];
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://127.0.0.1:9222/',
    runScripts: 'dangerously',
  });
  dom.window.fetch = async (url, opts) => {
    const entry = {
      url: String(url).split('?')[0],
      method: opts && opts.method ? opts.method : 'GET',
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    };
    requests.push(entry);
    const handler = routes[entry.url];
    if (typeof handler !== 'function') return { status: 404, json: async () => ({ ok: false }) };
    const payload = handler(entry);
    return { status: 200, json: async () => payload };
  };
  dom.window.eval(STATE_JS);
  dom.window.localStorage.setItem('tutorialSeen', '1'); // skip the tour overlay
  dom.window.eval(APP_JS);
  return { dom, requests };
}

async function teardown(dom) {
  await new Promise((r) => setTimeout(r, 30));
  try {
    if (dom.window.__mbPanel && typeof dom.window.__mbPanel.stop === 'function') dom.window.__mbPanel.stop();
  } catch { /* best-effort */ }
  dom.window.close();
}

function click(dom, selector) {
  const el = dom.window.document.querySelector(selector);
  assert.ok(el, 'element ' + selector + ' rendered');
  el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

function type(dom, id, value) {
  const el = dom.window.document.getElementById(id);
  assert.ok(el, 'input ' + id + ' rendered');
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

const ROUTES = {
  '/api/identity': () => ({ identity: FLAMAMEX }),
  '/api/snapshot': () => ({ stats: { health: 30, mana: 100, maxMana: 120, maxHealth: 200 }, agent: { modules: { training: { cap: { capacity: 209, maxCapacity: 400, ratio: 0.52 } } } } }),
  '/api/character-config': () => ({ ok: true, config: BASE_CFG, warning: null }),
  '/api/connect': () => ({ ok: true, identity: FLAMAMEX, config: BASE_CFG }),
  '/api/spell-catalog': () => ({ ok: true, catalog: [{ sid: 2, name: 'Healing', mana: 25, level: 1 }], total: 1, playerLevel: 20, vocationLabel: 'druid' }),
  '/api/hotbar': () => ({ ok: true, available: true, slots: [{ slot: 2, sid: 2, name: 'Healing', mana: 25 }] }),
  '/api/inventory': () => ({ ok: true, containers: [{ which: 0, name: 'Backpack', items: [{ cid: 7618, name: 'Health Potion', count: 20 }] }] }),
  '/api/profiles': () => ({ ok: true, profiles: ['Flamamex'], current: 'Flamamex' }),
  '/api/config': () => ({ ok: true }),
};

test('REQ-29 (PR3, jsdom): typing the HEAL form + Save posts /api/config with the converted threshold', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    // Connect through the real effect path (dispatch, not clicks).
    dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
    dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: FLAMAMEX });
    dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(dom.window.__mbPanel.getState().gate, 'armed');

    // Toggle healMagic ON from the HEAL tab module list (independent switch).
    const healMagicToggle = dom.window.document.querySelector('input[data-module="healMagic"]');
    assert.ok(healMagicToggle, 'healMagic toggle rendered in the HEAL tab');
    healMagicToggle.checked = true;
    healMagicToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    // Type the form: 50% of maxHealth 200 -> absolute 100.
    type(dom, 'heal-threshold', '50');
    type(dom, 'heal-reserve', '10');

    // A snapshot re-render must not wipe the typed values.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(dom.window.document.getElementById('heal-threshold').value, '50', 'threshold survives re-render');
    assert.match(dom.window.document.body.innerHTML, /Mapped to live hotbar slot F2/, 'slot comes from live game hotbar');
    assert.equal(dom.window.document.getElementById('heal-reserve').value, '10', 'reserve survives re-render');

    click(dom, '#heal-save-btn');
    await new Promise((r) => setTimeout(r, 40));

    const cfgReqs = requests.filter((r) => r.url === '/api/config');
    assert.ok(cfgReqs.length >= 1, 'config push posted');
    const cfg = cfgReqs[cfgReqs.length - 1].body.config;
    assert.equal(cfg.modules.healMagic.on, true, 'toggle carried');
    assert.equal(cfg.modules.healMagic.threshold, 100, '50% of maxHealth 200 converted to absolute 100');
    assert.equal(cfg.modules.healMagic.slot, 2);
    assert.equal(cfg.modules.healMagic.reserve, 12, '10% of max mana 120 stored as absolute reserve');
    assert.equal(dom.window.__mbPanel.getState().refusal, null, 'valid save not refused');
  } finally {
    await teardown(dom);
  }
});

test('REQ-29 (PR3, jsdom): healMagic toggles (dashboard + HEAL tab) drive one shared toggle state', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
    dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: FLAMAMEX });
    dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
    await new Promise((r) => setTimeout(r, 60));

    const toggles = dom.window.document.querySelectorAll('input[data-module="healMagic"]');
    assert.equal(toggles.length, 2, 'dashboard card + HEAL tab toggle');
    toggles[0].checked = true;
    toggles[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));

    const state = dom.window.__mbPanel.getState();
    assert.equal(state.modules.healMagic, true, 'toggle applied through the dashboard card');
    assert.equal(dom.window.document.querySelectorAll('input[data-module="healItems"]').length, 0,
      'hidden healItems toggle never renders');
    const cfg = requests.filter((r) => r.url === '/api/config').pop().body.config;
    assert.equal(cfg.modules.healMagic.on, true);
    assert.equal(cfg.modules.healItems.on, false, 'hidden healItems stays as the server returned it');
  } finally {
    await teardown(dom);
  }
});

test('Panel UX: a focused configuration select survives draft changes and live polling', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
    dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: FLAMAMEX });
    dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
    await new Promise((r) => setTimeout(r, 60));
    click(dom, '.tab-btn[data-tab="trainer"]');

    const select = dom.window.document.getElementById('trainer-cap-mode');
    assert.ok(select, 'CAP mode select rendered');
    select.focus();
    select.value = 'off';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    assert.equal(dom.window.document.getElementById('trainer-cap-mode'), select,
      'draft change does not replace the native select');
    assert.equal(select.value, 'off');
    assert.equal(dom.window.__mbPanel.getState().trainerForm.capMode, 'off');

    dom.window.__mbPanel.dispatch({ type: 'SNAPSHOT', data: { stats: { health: 200, maxHealth: 200 }, agent: { modules: { training: { cap: { capacity: 209, maxCapacity: 400, ratio: 0.52 } } } } } });
    assert.equal(dom.window.document.getElementById('trainer-cap-mode'), select,
      'live polling does not tear down the focused select');
  } finally {
    await teardown(dom);
  }
});

test('REQ-29 (PR3, jsdom): the HEAL settings form is NOT rendered before Connect', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await new Promise((r) => setTimeout(r, 250)); // identity confirms without Connect
    assert.equal(dom.window.__mbPanel.getState().gate, 'confirmed');
    assert.ok(!dom.window.document.getElementById('heal-save-btn'), 'no heal form pre-Connect');
    assert.ok(!requests.some((r) => r.url === '/api/config'), 'no config push pre-Connect');
  } finally {
    await teardown(dom);
  }
});


test('Hidden-module scope: item-only healing surfaces are absent from the DOM', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
    dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: FLAMAMEX });
    dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
    await new Promise((r) => setTimeout(r, 80));

    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('[data-heal-mode]').length, 0, 'no healing-mode buttons');
    assert.equal(doc.getElementById('heal-item-threshold'), null, 'no HP item threshold field');
    assert.equal(doc.getElementById('heal-mana-enabled'), null, 'no mana potion toggle');
    assert.ok(doc.getElementById('heal-threshold'), 'magic threshold still rendered');
    assert.ok(doc.getElementById('heal-reserve'), 'magic reserve still rendered');
    assert.ok(doc.getElementById('heal-save-btn'), 'magic save still rendered');
  } finally {
    await teardown(dom);
  }
});
