'use strict';

/**
 * Dashboard-first panel jsdom tests: the DASHBOARD is the default tab with a
 * quick-access card grid (one per active module) whose ON/OFF toggles reuse
 * the TOGGLE_MODULE dispatch and whose "Configurar" buttons jump to the right
 * configuration tab (SET_TAB). Hidden modules never render anywhere — no tab,
 * no toggle, no config deck — and their server-returned config survives a
 * config push untouched (buildPushConfig keeps MODULE_IDS intact).
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

/** Server-returned config: every hidden module carries ON + settings so the
 *  test can prove the panel never forces them off or drops them. */
const CFG = {
  character: 'Flamamex',
  modules: {
    healMagic: { on: false, sid: 2, slot: 2, threshold: 100, reserve: 10 },
    runes: { on: false },
    training: { on: false, sid: 35, slot: 4 },
    eat: { on: false, slot: null, everyCasts: 0 },
    healItems: { on: true, threshold: 90, slotCids: [7618] },
    manaItems: { on: true, threshold: 50, slotCids: [268] },
    attack: { on: true, targeting: 'lowest-hp' },
    cavebot: { on: true, paused: false },
    trade: { on: true, message: 'WTS blank runes' },
    loot: { on: true, defaultDest: 'Loot bag', perMonster: {} },
    spawns: { on: true },
    huntStats: { on: true },
    routes: { on: true },
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
    const pathname = String(url).split('?')[0];
    requests.push({
      url: pathname,
      method: (opts && opts.method) || 'GET',
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    });
    const handler = routes && routes[pathname];
    if (typeof handler !== 'function') return { status: 404, json: async () => ({ ok: false }) };
    return { status: 200, json: async () => handler() };
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
    stats: { health: 150, mana: 200, maxMana: 300, maxHealth: 300 },
    agent: { modules: {
      training: { on: true, capFull: false, waitingForMana: false, requiredMana: 210, successfulRuneCreations: 7, foodCycle: 'idle' },
      runes: { on: true, available: true, reason: 'ok' },
      eat: { on: true, paused: false, lastEatAt: 1700000000000 },
    } },
  }),
  '/api/connect': () => ({ ok: true, identity: FLAMAMEX, config: CFG }),
  '/api/character-config': () => ({ ok: true, config: CFG, warning: null }),
  '/api/config': () => ({ ok: true }),
  '/api/profiles': () => ({ ok: true, profiles: [] }),
  '/api/spell-catalog': () => ({ ok: true, catalog: [], total: 0 }),
};

test('DASHBOARD: renders as the first and default tab; hidden tabs never render', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    const doc = dom.window.document;
    assert.equal(dom.window.__mbPanel.getState().tab, 'dashboard', 'dashboard is the default tab');
    const tabs = [...doc.querySelectorAll('.tab-btn')].map((b) => b.getAttribute('data-tab'));
    assert.deepEqual(tabs, ['dashboard', 'heal', 'trainer', 'others'], 'dashboard is the first tab');
    assert.equal(doc.querySelector('.tab-panel[data-tab-panel="dashboard"]').hidden, false,
      'dashboard panel visible by default');
    for (const hidden of ['attack', 'cavebot']) {
      assert.equal(doc.querySelector('.tab-btn[data-tab="' + hidden + '"]'), null, hidden + ' tab absent');
    }
    const cards = [...doc.querySelectorAll('.dashboard-card')];
    assert.deepEqual(cards.map((c) => c.getAttribute('data-dashboard-card')),
      ['training', 'eat', 'healMagic', 'runes']);
  } finally {
    await teardown(dom);
  }
});

test('DASHBOARD: card toggles reuse TOGGLE_MODULE — disabled pre-Connect, applied when armed', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    const doc = dom.window.document;
    const pre = doc.querySelector('.dashboard-card[data-dashboard-card="training"] input[data-module]');
    assert.ok(pre, 'training card toggle rendered');
    assert.equal(pre.disabled, true, 'dashboard toggles disabled pre-Connect (same gate as today)');

    await connect(dom);
    const armed = doc.querySelector('.dashboard-card[data-dashboard-card="training"] input[data-module]');
    assert.equal(armed.disabled, false, 'dashboard toggles enabled when armed');
    armed.checked = true;
    armed.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(dom.window.__mbPanel.getState().modules.training, true, 'TOGGLE_MODULE applied via the dashboard card');
    const cfg = requests.filter((r) => r.url === '/api/config').at(-1);
    assert.equal(cfg.body.config.modules.training.on, true, 'card toggle pushed into the config');
  } finally {
    await teardown(dom);
  }
});

test('DASHBOARD: "Configurar" dispatches SET_TAB to the right configuration tab', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    const doc = dom.window.document;
    const targets = { training: 'trainer', runes: 'trainer', eat: 'others', healMagic: 'heal' };
    for (const cardId of Object.keys(targets)) {
      const btn = doc.querySelector('.dashboard-card[data-dashboard-card="' + cardId + '"] [data-dashboard-go]');
      assert.ok(btn, 'Configurar button on the ' + cardId + ' card');
      assert.equal(btn.getAttribute('data-dashboard-go'), targets[cardId], cardId + ' maps to its config tab');
      btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
      assert.equal(dom.window.__mbPanel.getState().tab, targets[cardId], cardId + ' Configurar jumps to ' + targets[cardId]);
    }
  } finally {
    await teardown(dom);
  }
});

test('DASHBOARD: card status lines render human-readable live data from the snapshot', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    await connect(dom);
    await new Promise((r) => setTimeout(r, 80));
    const status = (id) => dom.window.document
      .querySelector('.dashboard-card[data-dashboard-card="' + id + '"] .dashboard-card-status').textContent;

    assert.match(status('training'), /Runes created: 7/, 'training shows the runes-created count');
    assert.match(status('eat'), /Last ate/, 'eat shows the last-eat time');
    assert.match(status('runes'), /Rune data ready/, 'runes shows the native-data readiness');
    assert.match(status('healMagic'), /Heal magic off/, 'healMagic reuses the live heal line');

    // Waiting-for-mana path (requirement: training status covers it).
    dom.window.__mbPanel.dispatch({ type: 'SNAPSHOT', data: {
      stats: { health: 150, mana: 200, maxMana: 300, maxHealth: 300 },
      agent: { modules: {
        training: { on: true, capFull: false, waitingForMana: true, requiredMana: 210, successfulRuneCreations: 7, foodCycle: 'idle' },
        runes: { on: true, available: true, reason: 'ok' },
        eat: { on: true, paused: false, lastEatAt: 0 },
      } },
    } });
    assert.match(status('training'), /Waiting for mana/, 'training shows the waiting-for-mana state');

    // Cap-full path.
    dom.window.__mbPanel.dispatch({ type: 'SNAPSHOT', data: {
      stats: { health: 150, mana: 300, maxMana: 300, maxHealth: 300 },
      agent: { modules: {
        training: { on: true, capFull: true, waitingForMana: false, requiredMana: 210, successfulRuneCreations: 7, foodCycle: 'idle' },
        runes: { on: true, available: true, reason: 'ok' },
        eat: { on: true, paused: false, lastEatAt: 0 },
      } },
    } });
    assert.match(status('training'), /cap full/, 'training shows the cap-full alert');

    for (const id of ['training', 'eat', 'healMagic', 'runes']) {
      const text = status(id);
      assert.ok(!text.includes('{') && !text.includes('}'), 'no raw JSON in dashboard status');
    }
  } finally {
    await teardown(dom);
  }
});

test('REQ-07: the Comida card shows food created / next meal / last ate from the live eat getState; Runes card stays runes-only', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    await connect(dom);
    const status = (id) => dom.window.document
      .querySelector('.dashboard-card[data-dashboard-card="' + id + '"] .dashboard-card-status').textContent;

    // Full unified eat getState (PR 3 shape): cumulative foodCreated, the
    // safety-net nextMealAt and the last-eat clock anchor.
    dom.window.__mbPanel.dispatch({ type: 'SNAPSHOT', data: {
      stats: { health: 150, mana: 200, maxMana: 300, maxHealth: 300 },
      agent: { modules: {
        training: { on: true, capFull: false, waitingForMana: false, requiredMana: 210, successfulRuneCreations: 7, foodCycle: 'idle' },
        runes: { on: true, available: true, reason: 'ok' },
        eat: {
          on: true, paused: false, failures: 0, alert: null,
          lastEatAt: 1700000000000, foodCreated: 3,
          nextMealAt: 1700000000000 + 20 * 60 * 1000,
          safetyNetMinutes: 20, magicSid: 12, source: 'magic',
        },
      } },
    } });
    const eatStatus = status('eat');
    assert.match(eatStatus, /Food created: 3/, 'Comida card shows the cumulative created count');
    assert.match(eatStatus, /Next meal/, 'Comida card shows the next safety-net meal');
    assert.match(eatStatus, /Last ate/, 'Comida card shows the last-eat time');
    assert.ok(eatStatus.includes('·'), 'the three facts render as one joined status line');

    const runesStatus = status('runes');
    assert.match(runesStatus, /Rune data ready/);
    assert.doesNotMatch(runesStatus, /Food|Comida|created|Next meal|Last ate/,
      'Runes card stays runes-only (REQ-07)');

    // No-meal-yet window: honest line, no invented times.
    dom.window.__mbPanel.dispatch({ type: 'SNAPSHOT', data: {
      stats: { health: 150, mana: 200, maxMana: 300, maxHealth: 300 },
      agent: { modules: {
        training: { on: true, capFull: false, waitingForMana: false, requiredMana: 210, successfulRuneCreations: 7, foodCycle: 'idle' },
        runes: { on: true, available: true, reason: 'ok' },
        eat: { on: true, paused: false, lastEatAt: 0, foodCreated: 0, nextMealAt: null },
      } },
    } });
    assert.match(status('eat'), /No food actions yet/, 'empty window shows the honest no-actions line');
  } finally {
    await teardown(dom);
  }
});

test('Hidden modules: no toggle/card/tab/config surface; config survives a push untouched', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    const doc = dom.window.document;
    for (const id of ['attack', 'cavebot', 'trade', 'loot', 'spawns', 'huntStats', 'routes', 'healItems', 'manaItems']) {
      assert.equal(doc.querySelector('input[data-module="' + id + '"]'), null, id + ' has no toggle');
      assert.equal(doc.querySelector('[data-dashboard-card="' + id + '"]'), null, id + ' has no dashboard card');
      assert.equal(doc.querySelector('.tab-btn[data-tab="' + id + '"]'), null, id + ' has no tab');
      assert.equal(doc.querySelector('[data-config-tab="' + id + '"]'), null, id + ' has no config deck');
      assert.equal(doc.querySelector('[data-picker-module-btn="' + id + '"]'), null, id + ' has no picker target');
    }

    // A visible toggle push must still carry the hidden modules as the server returned them.
    const runes = doc.querySelector('input[data-module="runes"]');
    runes.checked = true;
    runes.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    const cfg = requests.filter((r) => r.url === '/api/config').at(-1).body.config;
    assert.equal(cfg.modules.runes.on, true, 'visible runes toggle carried');
    assert.equal(cfg.modules.healItems.on, true, 'hidden healItems on-state preserved');
    assert.deepEqual(cfg.modules.healItems.slotCids, [7618], 'hidden healItems settings preserved');
    assert.equal(cfg.modules.trade.on, true, 'hidden trade config preserved');
    assert.equal(cfg.modules.attack.on, true, 'hidden attack config preserved');
    assert.equal(cfg.modules.cavebot.on, true, 'hidden cavebot config preserved');
    assert.equal(cfg.modules.routes.on, true, 'hidden routes config preserved');
  } finally {
    await teardown(dom);
  }
});

test('Native select dropdown: a real mousedown keeps #config-form intact across polling renders', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    await connect(dom);
    const doc = dom.window.document;
    // Open the TRAINER config tab so the rune select exists.
    dom.window.__mbPanel.dispatch({ type: 'SET_TAB', tab: 'trainer' });
    await new Promise((r) => setTimeout(r, 30));
    const select = doc.getElementById('trainer-rune-select');
    assert.ok(select, 'trainer rune select rendered');

    // User clicks the native select: the browser moves activeElement to BODY
    // (the dropdown popup is not DOM). Without the mousedown guard the next
    // polling render would replace #config-form and close the open dropdown.
    const previous = doc.getElementById('config-form');
    select.dispatchEvent(new dom.window.Event('mousedown', { bubbles: true }));
    select.dispatchEvent(new dom.window.Event('focus', { bubbles: true }));
    // Simulate the browser popup behavior: focus leaves the document.
    doc.activeElement.blur();
    assert.notEqual(doc.activeElement, select, 'precondition: open native select has no DOM focus');

    // A polling render (snapshot) must NOT replace #config-form while the
    // select was recently clicked.
    dom.window.__mbPanel.dispatch({ type: 'SNAPSHOT', data: { stats: { health: 150, mana: 200, maxMana: 300, maxHealth: 300 } } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(doc.getElementById('config-form'), previous, 'config-form subtree preserved after a recent select mousedown');
    const stillThere = doc.getElementById('trainer-rune-select');
    assert.equal(stillThere, select, 'the clicked select node was not replaced');
  } finally {
    await teardown(dom);
  }
});
