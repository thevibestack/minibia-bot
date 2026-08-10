'use strict';

/**
 * PR 6 — ATTACK + CAVEBOT skeleton jsdom tests (REQ-35/36, D10): typing the
 * ATTACK settings form + Save posts /api/config with the targeting + rune
 * slot; the CAVEBOT controls post /api/cavebot (record/stop/start), the
 * record-stop result lands in the panel state so Save writes config.routes,
 * and pause posts the config with modules.cavebot.paused. The live-state
 * lines render from the snapshot.
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

const BASE_CFG = {
  character: 'Flamamex',
  modules: {
    healItems: { on: false },
    healMagic: { on: false },
    runes: { on: false },
    training: { on: false },
    eat: { on: false, slot: null, everyCasts: 0 },
    loot: { on: false, defaultDest: null, perMonster: {} },
    antibot: { on: false, replies: [] },
    attack: { on: false, targeting: 'lowest-hp', sid: null, runeSlot: null },
    cavebot: { on: false, paused: false },
  },
};

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

function change(dom, id, value) {
  const el = dom.window.document.getElementById(id);
  assert.ok(el, 'select ' + id + ' rendered');
  el.value = value;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

/** Connect through the real effect path. */
async function connect(dom) {
  dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
  dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: FLAMAMEX });
  dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(dom.window.__mbPanel.getState().gate, 'armed');
}

const ROUTES = {
  '/api/identity': () => ({ identity: FLAMAMEX }),
  '/api/snapshot': () => ({
    stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 },
    agent: { modules: { cavebot: { on: true, paused: false, recording: { active: true, points: 7 }, savedRoute: { count: 9 } } } },
  }),
  '/api/connect': () => ({ ok: true, config: BASE_CFG }),
  '/api/character-config': () => ({ config: BASE_CFG }),
  '/api/config': () => ({ ok: true }),
  '/api/spell-catalog': () => ({ ok: true, catalog: [] }),
  '/api/profiles': () => ({ ok: true, profiles: [] }),
  '/api/cavebot': (entry) => {
    if (entry.body && entry.body.command === 'record-stop') {
      return { ok: true, command: 'record-stop', result: { ok: true, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] } };
    }
    return { ok: true, result: { ok: true } };
  },
};

test('REQ-35: ATTACK form save posts /api/config with targeting + rune slot', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    change(dom, 'attack-targeting', 'nearest');
    type(dom, 'attack-rune-slot', '4');
    click(dom, '#attack-save-btn');
    await new Promise((r) => setTimeout(r, 60));
    const cfgReq = requests.filter((r) => r.url === '/api/config' && r.method === 'POST');
    assert.ok(cfgReq.length >= 1, 'config pushed');
    const last = cfgReq[cfgReq.length - 1];
    assert.equal(last.body.config.modules.attack.targeting, 'nearest');
    assert.equal(last.body.config.modules.attack.runeSlot, 4);
  } finally {
    teardown(dom);
  }
});

test('REQ-35: the ATTACK tab shows the toggle + the skeleton disclosure', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    await new Promise((r) => setTimeout(r, 40));
    dom.window.__mbPanel.dispatch({ type: 'SET_TAB', tab: 'attack' });
    const doc = dom.window.document;
    assert.ok(doc.querySelector('input[data-module="attack"]'), 'attack toggle');
    assert.match(doc.querySelector('[data-tab-panel="attack"]').textContent, /Skeleton — limited/);
  } finally {
    teardown(dom);
  }
});

test('REQ-36: cavebot record -> /api/cavebot record-start; stop -> points land; save -> config.routes', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    dom.window.__mbPanel.dispatch({ type: 'SET_TAB', tab: 'cavebot' });
    click(dom, '[data-cavebot-command="record"]');
    await new Promise((r) => setTimeout(r, 40));
    click(dom, '[data-cavebot-command="stop"]');
    await new Promise((r) => setTimeout(r, 60));
    click(dom, '[data-cavebot-command="save"]');
    await new Promise((r) => setTimeout(r, 60));
    const cavebotReqs = requests.filter((r) => r.url === '/api/cavebot');
    assert.deepEqual(cavebotReqs.map((r) => r.body.command), ['record-start', 'record-stop']);
    const cfgReqs = requests.filter((r) => r.url === '/api/config' && r.method === 'POST');
    const last = cfgReqs[cfgReqs.length - 1];
    assert.deepEqual(last.body.config.routes, [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      'Save writes the recorded waypoints into config.routes');
  } finally {
    teardown(dom);
  }
});

test('REQ-36: cavebot start posts /api/cavebot start', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    dom.window.__mbPanel.dispatch({ type: 'SET_TAB', tab: 'cavebot' });
    click(dom, '[data-cavebot-command="start"]');
    await new Promise((r) => setTimeout(r, 40));
    const cavebotReqs = requests.filter((r) => r.url === '/api/cavebot');
    assert.deepEqual(cavebotReqs.map((r) => r.body.command), ['start']);
  } finally {
    teardown(dom);
  }
});

test('REQ-36: pause posts the config with modules.cavebot.paused', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    dom.window.__mbPanel.dispatch({ type: 'SET_TAB', tab: 'cavebot' });
    click(dom, '[data-cavebot-command="pause"]');
    await new Promise((r) => setTimeout(r, 60));
    const cfgReqs = requests.filter((r) => r.url === '/api/config' && r.method === 'POST');
    const last = cfgReqs[cfgReqs.length - 1];
    assert.equal(last.body.config.modules.cavebot.paused, true);
  } finally {
    teardown(dom);
  }
});

test('REQ-36: the live state renders the cavebot recording status from the snapshot', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    await new Promise((r) => setTimeout(r, 40));
    dom.window.__mbPanel.dispatch({ type: 'SET_TAB', tab: 'cavebot' });
    const html = dom.window.document.getElementById('live-state').textContent;
    assert.match(html, /recording 7 waypoints/);
    assert.match(html, /saved route 9 waypoints/);
  } finally {
    teardown(dom);
  }
});
