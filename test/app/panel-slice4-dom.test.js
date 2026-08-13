'use strict';

/**
 * PR 4 — TRAINER tab jsdom tests (REQ-30/31/32, D3/D4): typing the settings
 * form + Save posts /api/config with the percent->ratio conversions and
 * eat-with-magic; the cap-full snapshot state raises the panel ALERT and
 * rings the Web Audio beep on the RISING edge only.
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
    runes: { on: false, capMode: 'strict', capFullThreshold: 1.0, fallbackSlot: null, fallbackManaPct: 0.5 },
    training: { on: false, reserve: 0 },
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

/** Stub the Web Audio beep (feature-detect surface) and count creations. */
function stubAudio(dom) {
  let beeps = 0;
  dom.window.AudioContext = class {
    constructor() { beeps += 1; }
    createOscillator() {
      return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {}, onended: null };
    }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    get currentTime() { return 0; }
    get destination() { return {}; }
    close() { return Promise.resolve(); }
  };
  return () => beeps;
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
  '/api/snapshot': () => ({ stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 } }),
  '/api/character-config': () => ({ ok: true, config: BASE_CFG, warning: null }),
  '/api/connect': () => ({ ok: true, identity: FLAMAMEX, config: BASE_CFG }),
  '/api/spell-catalog': () => ({ ok: true, catalog: [], total: 0, playerLevel: 20, vocationLabel: 'druid' }),
  '/api/profiles': () => ({ ok: true, profiles: ['Flamamex'], current: 'Flamamex' }),
  '/api/config': () => ({ ok: true }),
};

const LIVE_SPELLS = [
  { sid: 35, name: 'Heavy Magic Missile Rune', words: 'adori gran', mana: 210, level: 3, vocations: [] },
  { sid: 2, name: 'Healing', words: 'exura', mana: 25, level: 1, vocations: [] },
];

function liveRoutes(extra) {
  return Object.assign({}, ROUTES, {
    '/api/spell-catalog': () => ({ ok: true, catalog: LIVE_SPELLS, total: LIVE_SPELLS.length, playerLevel: 20, vocationLabel: 'druid' }),
    '/api/hotbar': () => ({ ok: true, available: true, slots: [{ slot: 4, sid: 35 }, { slot: 7, sid: 2 }] }),
  }, extra || {});
}

async function configureTrainer(dom) {
  await new Promise((r) => setTimeout(r, 80));
  const rune = dom.window.document.getElementById('trainer-rune-select');
  rune.value = '35';
  rune.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const automatic = dom.window.document.getElementById('trainer-auto-fallback');
  automatic.checked = true;
  automatic.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const fallback = dom.window.document.getElementById('trainer-fallback-select');
  fallback.value = '2';
  fallback.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const capThreshold = dom.window.document.getElementById('trainer-cap-threshold');
  if (capThreshold) type(dom, 'trainer-cap-threshold', '100');
  type(dom, 'trainer-fallback-pct', '50');
  type(dom, 'trainer-reserve', '30');
}

test('TRAINER DOM: saving persists live rune/fallback mappings, never raw slots', async () => {
  const { dom, requests } = makePanel(liveRoutes());
  try {
    await connect(dom);
    await configureTrainer(dom);
    click(dom, '#trainer-save-btn');
    await new Promise((r) => setTimeout(r, 40));
    const req = requests.filter((r) => r.url === '/api/config').at(-1);
    assert.ok(req, 'config push posted');
    assert.equal(req.body.config.modules.training.sid, 35);
    assert.equal(req.body.config.modules.training.slot, 4);
    assert.equal(req.body.config.modules.runes.fallbackSid, 2);
    assert.equal(req.body.config.modules.runes.fallbackSlot, 7);
    assert.equal(req.body.config.modules.training.reserve, 30);
  } finally { await teardown(dom); }
});

test('TRAINER DOM: shows a compact live execution card and keeps optional rules collapsed', async () => {
  const { dom } = makePanel(liveRoutes());
  try {
    await connect(dom);
    await configureTrainer(dom);
    const html = dom.window.document.body.innerHTML;
    assert.match(html, /Heavy Magic Missile Rune/);
    assert.match(html, /adori gran/);
    assert.match(html, /MP 210/);
    assert.match(html, /Live execution/);
    assert.match(html, /F4/);
    assert.match(html, /Fallback magic \(optional\)/);
    assert.match(html, /Capacity: unavailable/);
    assert.ok(!html.includes('SID 35'));
    for (const id of ['trainer-rune-slot', 'trainer-fallback-slot', 'trainer-eat-magic-slot', 'trainer-rune-key', 'trainer-fallback-key']) {
      assert.equal(dom.window.document.getElementById(id), null, id + ' is intentionally absent');
    }
  } finally { await teardown(dom); }
});

test('REQ-01/12 (PR4, jsdom): legacy trainer food-magic controls are gone; rune/fallback/cap/stop surfaces stay', async () => {
  const { dom, requests } = makePanel(liveRoutes());
  try {
    await connect(dom);
    await configureTrainer(dom);
    for (const id of ['trainer-food-magic-enabled', 'trainer-food-magic-select', 'trainer-food-every-runes']) {
      assert.equal(dom.window.document.getElementById(id), null, id + ' removed from the trainer form');
    }
    assert.ok(dom.window.document.getElementById('trainer-rune-select'), 'rune select stays');
    assert.ok(dom.window.document.getElementById('trainer-auto-fallback'), 'auto fallback stays');
    assert.ok(dom.window.document.getElementById('trainer-fallback-select'), 'fallback select stays');
    assert.ok(dom.window.document.getElementById('trainer-reserve'), 'reserve stays');
    assert.ok(dom.window.document.getElementById('trainer-stop-runes'), 'stop-rune toggle stays');
    assert.ok(dom.window.document.getElementById('trainer-stop-botting'), 'stop-botting toggle stays');
    assert.match(dom.window.document.body.innerHTML, /Live execution/, 'execution card stays');

    click(dom, '#trainer-save-btn');
    await new Promise((r) => setTimeout(r, 40));
    const cfg = requests.filter((r) => r.url === '/api/config').at(-1).body.config;
    assert.equal(cfg.modules.training.eatWithMagic, undefined, 'trainer save posts no legacy eatWithMagic (REQ-01)');
  } finally { await teardown(dom); }
});

test('TRAINER DOM: execution-card refresh re-reads live panel data without saving configuration', async () => {
  const { dom, requests } = makePanel(liveRoutes({
    '/api/inventory': () => ({ ok: true, containers: [] }),
    '/api/creatures': () => ({ ok: true, creatures: [] }),
  }));
  try {
    await connect(dom);
    click(dom, '[data-refresh-game-data]');
    await new Promise((r) => setTimeout(r, 40));
    const urls = requests.map((request) => request.url);
    for (const path of ['/api/spell-catalog', '/api/hotbar', '/api/inventory', '/api/creatures']) {
      assert.ok(urls.includes(path), path + ' refresh requested');
    }
    assert.equal(requests.filter((request) => request.url === '/api/config').length, 0, 'refresh remains read-only');
  } finally { await teardown(dom); }
});

test('TRAINER DOM: rune selector has an explicit placeholder and excludes non-rune spells', async () => {
  const { dom } = makePanel(liveRoutes());
  try {
    await connect(dom);
    await new Promise((r) => setTimeout(r, 80));
    const options = Array.from(dom.window.document.getElementById('trainer-rune-select').options).map((o) => o.value);
    assert.deepEqual(options, ['', '35']);
  } finally { await teardown(dom); }
});

test('TRAINER DOM: unhotbarred rune refuses save with an actionable fix', async () => {
  const { dom } = makePanel(liveRoutes({ '/api/hotbar': () => ({ ok: true, available: true, slots: [{ slot: 7, sid: 2 }] }) }));
  try {
    await connect(dom);
    await configureTrainer(dom);
    click(dom, '#trainer-save-btn');
    await new Promise((r) => setTimeout(r, 30));
    assert.match(dom.window.__mbPanel.getState().refusal.reason, /Add the selected rune spell to F1–F12/i);
  } finally { await teardown(dom); }
});

test('TRAINER DOM: automatic fallback requires and persists a live mapped spell', async () => {
  const { dom, requests } = makePanel(liveRoutes());
  try {
    await connect(dom);
    await new Promise((r) => setTimeout(r, 80));
    const rune = dom.window.document.getElementById('trainer-rune-select');
    rune.value = '35'; rune.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const automatic = dom.window.document.getElementById('trainer-auto-fallback');
    automatic.checked = true; automatic.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    type(dom, 'trainer-fallback-pct', '50'); type(dom, 'trainer-reserve', '0');
    click(dom, '#trainer-save-btn');
    await new Promise((r) => setTimeout(r, 30));
    assert.match(dom.window.__mbPanel.getState().refusal.reason, /choose a live non-rune fallback/i);
    assert.equal(requests.filter((r) => r.url === '/api/config').length, 0);
  } finally { await teardown(dom); }
});

test('TRAINER DOM: Stop Botting confirms before disabling training while healing remains enabled', async () => {
  const { dom, requests } = makePanel(liveRoutes());
  try {
    await connect(dom);
    const heal = dom.window.document.querySelector('input[data-module="healMagic"]');
    heal.checked = true; heal.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await configureTrainer(dom);
    const stop = dom.window.document.getElementById('trainer-stop-botting');
    stop.checked = true; stop.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const before = requests.filter((r) => r.url === '/api/config').length;
    click(dom, '#trainer-save-btn');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(dom.window.document.getElementById('confirm-stop-yes'));
    assert.equal(requests.filter((r) => r.url === '/api/config').length, before);
    click(dom, '#confirm-stop-yes');
    await new Promise((r) => setTimeout(r, 40));
    const cfg = requests.filter((r) => r.url === '/api/config').at(-1).body.config;
    assert.equal(cfg.modules.training.on, false);
    assert.equal(cfg.modules.healMagic.on, true);
  } finally { await teardown(dom); }
});

test('TRAINER DOM: cancelling Stop Botting posts no trainer configuration', async () => {
  const { dom, requests } = makePanel(liveRoutes());
  try {
    await connect(dom); await configureTrainer(dom);
    const stop = dom.window.document.getElementById('trainer-stop-botting');
    stop.checked = true; stop.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    click(dom, '#trainer-save-btn'); await new Promise((r) => setTimeout(r, 30));
    click(dom, '#confirm-stop-no'); await new Promise((r) => setTimeout(r, 30));
    assert.equal(dom.window.document.getElementById('confirm-stop-yes'), null);
    assert.equal(requests.filter((r) => r.url === '/api/config').length, 0);
  } finally { await teardown(dom); }
});

test('TRAINER DOM: no obsolete hotkey API controls remain in the real mapping flow', async () => {
  const { dom, requests } = makePanel(liveRoutes());
  try {
    await connect(dom); await configureTrainer(dom);
    assert.equal(dom.window.document.querySelector('#trainer-rune-assign, #trainer-fallback-assign'), null);
    assert.equal(requests.filter((r) => r.url === '/api/hotkeys' && r.method === 'POST').length, 0);
  } finally { await teardown(dom); }
});
