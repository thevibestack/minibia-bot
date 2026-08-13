'use strict';

/**
 * Hidden-module scope jsdom tests: ATTACK + CAVEBOT are removed from every
 * panel surface (no tab, no toggle, no config deck, no live-state line, no
 * spell-picker target) while their server-returned config survives a config
 * push untouched (buildPushConfig keeps MODULE_IDS intact). The deprecated
 * /api/cavebot RPC surface stays unused by the UI.
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
    attack: { on: true, targeting: 'lowest-hp', sid: null, runeSlot: null },
    cavebot: { on: true, paused: false, monsters: ['Rat'] },
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
  '/api/cavebot': () => ({ ok: true, result: { ok: true } }),
};

test('Hidden-module scope: ATTACK + CAVEBOT have no tab, toggle or config deck in the DOM', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    await connect(dom);
    const doc = dom.window.document;
    for (const id of ['attack', 'cavebot']) {
      assert.equal(doc.querySelector('.tab-btn[data-tab="' + id + '"]'), null, 'no ' + id + ' tab');
      assert.equal(doc.querySelector('input[data-module="' + id + '"]'), null, 'no ' + id + ' toggle');
      assert.equal(doc.querySelector('[data-config-tab="' + id + '"]'), null, 'no ' + id + ' config deck');
      assert.equal(doc.querySelector('[data-dashboard-card="' + id + '"]'), null, 'no ' + id + ' dashboard card');
    }
    // The live-state view must not surface the hidden modules either.
    const live = doc.getElementById('live-state').textContent;
    assert.doesNotMatch(live, /Cavebot:/, 'no cavebot live line');
    assert.doesNotMatch(live, /Attack:/, 'no attack live line');
  } finally {
    await teardown(dom);
  }
});

test('Hidden-module scope: a visible push keeps attack/cavebot config as the server returned it', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    const runes = dom.window.document.querySelector('input[data-module="runes"]');
    assert.ok(runes, 'visible runes toggle rendered');
    runes.checked = true;
    runes.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));

    const cfg = requests.filter((r) => r.url === '/api/config' && r.method === 'POST').at(-1).body.config;
    assert.equal(cfg.modules.runes.on, true, 'visible toggle carried');
    assert.equal(cfg.modules.attack.on, true, 'hidden attack config not forced off');
    assert.equal(cfg.modules.attack.targeting, 'lowest-hp', 'hidden attack settings preserved');
    assert.equal(cfg.modules.cavebot.on, true, 'hidden cavebot config not forced off');
    assert.deepEqual(cfg.modules.cavebot.monsters, ['Rat'], 'hidden cavebot settings preserved');
  } finally {
    await teardown(dom);
  }
});

test('Hidden-module scope: the panel never issues the cavebot RPC through the UI', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('[data-cavebot-command]').length, 0, 'no cavebot command buttons');
    assert.equal(doc.querySelectorAll('[data-cavebot-monster]').length, 0, 'no cavebot monster pickers');
    // Let a poll cycle run; only the UI-driven requests should exist.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(requests.filter((r) => r.url === '/api/cavebot').length, 0, 'no cavebot RPC from the UI');
  } finally {
    await teardown(dom);
  }
});
