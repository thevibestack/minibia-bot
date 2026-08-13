'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PANEL_DIR = path.join(__dirname, '..', '..', 'app', 'panel');
const INDEX_HTML = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8');
const STATE_JS = fs.readFileSync(path.join(PANEL_DIR, 'state.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(PANEL_DIR, 'app.js'), 'utf8');
const IDENTITY = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };
const CONFIG = { character: 'Flamamex', modules: { healMagic: { on: false }, training: { on: true, sid: 35, slot: 3, reserve: 0 } } };

function makePanel() {
  const requests = [];
  const hits = Object.create(null);
  const dom = new JSDOM(INDEX_HTML, { url: 'http://127.0.0.1:9222/', runScripts: 'dangerously' });
  dom.window.localStorage.setItem('tutorialSeen', '1');
  dom.window.fetch = async (url, opts) => {
    const pathname = String(url).split('?')[0];
    hits[pathname] = (hits[pathname] || 0) + 1;
    requests.push({ url: pathname, method: opts && opts.method || 'GET' });
    const round = hits[pathname];
    const responses = {
      '/api/identity': { identity: IDENTITY },
      // REQ-10 (slice C): the live snapshot carries the real module state —
      // healMagic ON here while the SAVED config says OFF, so the panel can
      // prove the live state is the single truth (REQ-09).
      '/api/snapshot': {
        stats: { health: 200, maxHealth: 200, mana: 270, maxMana: 270 },
        agent: { modules: { healMagic: { on: true, threshold: 150, slot: 2, sid: 61 } } },
      },
      '/api/connect': { ok: true, config: CONFIG },
      '/api/character-config': { ok: true, config: CONFIG },
      '/api/profiles': { ok: true, profiles: ['Flamamex'] },
      '/api/hotkeys': { ok: true, available: true, configured: {} },
      '/api/spell-catalog': { ok: true, catalog: [{ sid: 35, name: round > 1 ? 'Heavy Magic Missile (moved)' : 'Heavy Magic Missile', words: 'adori gran', mana: 210 }] },
      '/api/hotbar': { ok: true, available: true, slots: [{ slot: round > 1 ? 5 : 3, sid: 35 }] },
      '/api/inventory': { ok: true, containers: [{ name: 'Backpack', items: [{ cid: round > 1 ? 268 : 266, name: round > 1 ? 'Mana Potion' : 'Health Potion' }] }] },
      '/api/creatures': { ok: true, creatures: [{ id: 1, name: round > 1 ? 'Cyclops' : 'Rat', type: 'monster' }] },
    };
    return { status: 200, json: async () => responses[pathname] || { ok: false, reason: 'missing route' } };
  };
  dom.window.eval(STATE_JS);
  dom.window.eval(APP_JS);
  return { dom, requests, hits };
}

async function settle(ms = 80) { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function close(dom) {
  await settle(25);
  try { dom.window.__mbPanel.stop(); } catch { /* best effort */ }
  dom.window.close();
}

test('Refresh game data re-reads spell catalog, F1-F12, BP and creatures without saving config or acting in game', async () => {
  const { dom, requests, hits } = makePanel();
  try {
    dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
    dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: IDENTITY });
    dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
    await settle();

    const button = dom.window.document.getElementById('refresh-game-data-btn');
    assert.ok(button, 'visible while connected');
    assert.equal(button.textContent, 'Refresh game data');
    const before = Object.assign({}, hits);
    button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    assert.equal(dom.window.__mbPanel.getState().gameDataRefresh.loading, true);
    assert.equal(dom.window.document.getElementById('refresh-game-data-btn').disabled, true,
      'button is disabled while read-only refresh is in flight');
    await settle();

    for (const route of ['/api/spell-catalog', '/api/hotbar', '/api/inventory', '/api/creatures']) {
      assert.equal(hits[route], before[route] + 1, route + ' is refreshed exactly once');
    }
    assert.equal(hits['/api/profiles'], before['/api/profiles'], 'refresh does not touch saved character profiles');
    const state = dom.window.__mbPanel.getState();
    assert.equal(state.catalog.spells[0].name, 'Heavy Magic Missile (moved)');
    assert.equal(state.hotbar.slots[0].slot, 5, 'live F-slot mapping changes');
    assert.equal(state.inventory.containers[0].items[0].name, 'Mana Potion');
    assert.equal(state.creatures.items[0].name, 'Cyclops');
    assert.equal(state.gameDataRefresh.loading, false);
    assert.ok(state.gameDataRefresh.lastUpdatedAt > 0);
    assert.match(dom.window.document.getElementById('status-bar').textContent, /Game data updated at/);
    assert.equal(state.config.modules.training.slot, 5, 'stale persisted Trainer F-slot is reconciled to the live SID mapping');
    assert.equal(requests.filter((request) => request.url === '/api/config').length, 1,
      'only the required safe remap is persisted; refresh never sends a game command');
    assert.equal(requests.filter((request) => request.url === '/api/cavebot').length, 0,
      'refresh never sends a cavebot game command');

    dom.window.__mbPanel.dispatch({ type: 'SET_LANG', lang: 'es' });
    assert.match(dom.window.document.getElementById('refresh-game-data-btn').textContent, /Actualizar datos del juego/);
  } finally {
    await close(dom);
  }
});

test('REQ-09/10 (T3): heal live line shows the SNAPSHOT state (On) even when the saved config says Off', async () => {
  const { dom } = makePanel();
  try {
    dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
    dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: IDENTITY });
    dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
    await settle();

    const live = dom.window.document.getElementById('live-state');
    assert.ok(live, 'live state section rendered');
    assert.match(live.textContent, /Heal magic on/,
      'live snapshot module state is the single truth — not the saved config (off)');
    assert.doesNotMatch(live.textContent, /Heal magic off/);
  } finally {
    await close(dom);
  }
});

test('REQ-09 (T3): a panel toggle mirrors into config.modules so the next push persists the shown state', async () => {
  const { dom } = makePanel();
  try {
    dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
    dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: IDENTITY });
    dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
    await settle();

    dom.window.__mbPanel.dispatch({ type: 'TOGGLE_MODULE', module: 'healMagic', on: true });
    const state = dom.window.__mbPanel.getState();
    assert.equal(state.modules.healMagic, true, 'toggle applied');
    assert.equal(state.config.modules.healMagic.on, true, 'config mirrors the toggle — no stale divergence');
  } finally {
    await close(dom);
  }
});
