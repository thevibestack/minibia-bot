'use strict';

/**
 * REQ-08 fix slice — NESTED config reaches the agent END TO END (the
 * missing test family: the two shapes finally cross).
 *
 * The defect: panel buildPushConfig() writes `cfg.modules.<id>.on` (NESTED
 * store shape), server.ts POST /api/config pushes it unchanged, but
 * src/agent/bootstrap.js normalizeConfig read FLAT keys only — so in the
 * real app every module toggle stayed OFF (proven at PR 6: nested push ->
 * routes.on false; flat push -> true). Panel tests mocked the applyConfigFn
 * (call-shape only) and agent tests fed flat configs; the shapes never met.
 *
 * These tests run against the COMMITTED bundle in jsdom:
 *   1. a NESTED store-shape push (the real characters.ts shape via the real
 *      store module) reaches every module — the BEFORE/AFTER routes.on case
 *      plus a real heal cast through __handleClick from nested config;
 *   2. the FULL app path: panel toggle -> buildPushConfig -> POST /api/config
 *      body -> the server bridge applyConfigFn (played exactly like
 *      server.ts: Object.assign({}, config, { armed: true })) -> the in-page
 *      agent normalizeConfig — toggles ON in the UI land as ON in the agent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', '..', 'minibia-desktop-agent.js'), 'utf8');
const store = require('../../app/store/characters.ts');

async function waitFor(fn, { timeout = 5000, step = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** Fresh jsdom page with a heal-capable mocked gameClient (the heal spell
 *  resolves: sid 61 -> cost 20; clear cooldowns; live vocation gate). */
function makePage(overrides = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const casts = [];
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 200 },
      spellbook: {
        cooldowns: { GLOBAL_COOLDOWN: { active: false, seconds: 0 }, 61: { active: false, seconds: 0 } },
        spells: { 61: { cost: 20 } },
      },
    },
    interface: {
      hotbarManager: {
        __handleClick: (slot) => { casts.push({ slot, at: Date.now() }); },
        __canPlayerCastSpell: () => true,
      },
    },
    mouse: { use: () => {} },
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  return { dom, casts, gameClient, surface: () => dom.window.__mbAgent, handle: () => dom.window.__mbAgentHandle };
}

function teardown(dom) {
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch { /* best-effort */ }
  dom.window.close();
}

/* ------------------- 1. nested store-shape push, real bundle ------------------- */

test('REQ-08 fix: BEFORE/AFTER — a NESTED store push flips routes.on (flat-only normalize dropped it)', async () => {
  const { dom, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);

    // BEFORE (the defect): the initial config is defaults — routes OFF.
    assert.equal(handle().getState().modules.routes.on, false);

    // The REAL per-character store shape, with live toggles set ON exactly
    // as the panel/server would persist them (store defaults + toggles).
    const cfg = store.defaultConfig('Flamamex');
    cfg.modules.routes.on = true;
    cfg.modules.attack.on = true;
    cfg.modules.attack.targeting = 'nearest';
    cfg.modules.attack.sid = 12;
    cfg.modules.attack.runeSlot = 5;
    cfg.modules.cavebot.on = true;
    cfg.routes = [{ x: 40, y: 30 }];
    // The server bridge push: Object.assign({}, config, { armed: true }).
    surface().applyConfig(Object.assign({}, cfg, { armed: true }));

    // AFTER (the fix): the nested push reaches the agent.
    assert.equal(handle().getState().modules.routes.on, true, 'nested push -> routes.on TRUE (was false)');
    const attack = handle().getState().modules.attack;
    assert.equal(attack.on, true);
    assert.equal(attack.targeting, 'nearest');
    assert.deepEqual(JSON.parse(JSON.stringify(attack.spell)), { sid: 12 });
    assert.deepEqual(JSON.parse(JSON.stringify(attack.rune)), { slot: 5 });
    assert.equal(handle().getState().modules.cavebot.on, true);
    assert.equal(handle().getState().modules.cavebot.savedRoute.count, 1,
      'the top-level routes array still flows into the cavebot route');
  } finally {
    teardown(dom);
  }
});

test('REQ-08 fix: every nested module toggle + setting reaches the agent (getState surfaces)', async () => {
  const { dom, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    const cfg = store.defaultConfig('Flamamex');
    for (const id of ['runes', 'training', 'eat', 'trade', 'loot', 'spawns', 'huntStats',
      'antibot', 'routes', 'attack', 'cavebot']) {
      cfg.modules[id].on = true;
    }
    // Settings that ride the nested entries (unit-tested in full; the
    // observable getState surfaces assert the reach).
    cfg.modules.training.eatWithMagic = { enabled: true, slot: 8, sid: 55 };
    cfg.modules.runes.fallbackSlot = 5;
    cfg.modules.runes.fallbackManaPct = 0.6;
    cfg.modules.cavebot.paused = false;
    cfg.modules.learning.knownWords = ['exura', 'utevo vis'];
    cfg.modules.antibot.replies = [{ pattern: 'are you bot?', reply: 'no' }];
    cfg.modules.trade.message = 'buying runes';
    cfg.modules.loot.defaultDest = 'Loot bag';
    surface().applyConfig(Object.assign({}, cfg, { armed: true }));

    const st = handle().getState().modules;
    assert.equal(st.runes.on, true);
    assert.equal(st.training.on, true);
    assert.equal(st.eat.on, true);
    assert.equal(st.trade.on, true);
    assert.equal(st.trade.message, 'buying runes', 'trade message from the nested entry');
    assert.equal(st.loot.on, true);
    assert.equal(st.loot.defaultDest, 'Loot bag', 'loot destination from the nested entry');
    assert.equal(st.spawns.on, true);
    assert.equal(st.huntStats.on, true);
    assert.deepEqual(JSON.parse(JSON.stringify(st.learning.knownWords)),
      ['exura', 'utevo vis'], 'knownWords from the nested learning entry');
    assert.equal(st.antibot.on, true);
    assert.equal(st.routes.on, true);
    assert.equal(st.attack.on, true);
    assert.equal(st.cavebot.on, true);
    assert.equal(st.cavebot.paused, false);
  } finally {
    teardown(dom);
  }
});

test('REQ-08 fix: BEHAVIOR — a nested push with healMagic ON actually casts (tree -> queue -> __handleClick)', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    const cfg = store.defaultConfig('Flamamex');
    cfg.modules.healMagic.on = true;
    cfg.modules.healMagic.slot = 2;
    cfg.modules.healMagic.sid = 61;
    cfg.modules.healMagic.reserve = 0;
    cfg.modules.healMagic.word = null;
    surface().applyConfig(Object.assign({}, cfg, { armed: true }));
    gameClient.player.state.health = 30; // 30 <= threshold 150 (store default)

    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true,
      'the nested toggle drives a REAL heal cast through the queue');
    assert.equal(casts[0].slot, 2, 'heal fired via __handleClick(slot 2)');
    const q = handle().getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'REQ-12: the cast passed the Action Queue');
  } finally {
    teardown(dom);
  }
});

/* --------------- 2. FULL app path: panel -> POST body -> server bridge -> agent --------------- */

const PANEL_DIR = path.join(__dirname, '..', '..', 'app', 'panel');
const INDEX_HTML = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8');
const STATE_JS = fs.readFileSync(path.join(PANEL_DIR, 'state.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(PANEL_DIR, 'app.js'), 'utf8');

const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

const BASE_CFG = {
  character: 'Flamamex',
  connected: false,
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

/**
 * Full-path page: the COMMITTED agent bundle + the REAL panel (state.js +
 * app.js) in one document. The fetch stub plays the server for /api/config —
 * EXACTLY the server.ts bridge push (`Object.assign({}, config,
 * { armed: true })` to the in-page agent) — and records every POST body, so
 * the test crosses: UI toggle -> buildPushConfig (nested) -> POST body ->
 * server applyConfigFn -> agent normalizeConfig.
 */
function makeFullPathPage() {
  const posts = [];
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://127.0.0.1:9222/',
    runScripts: 'dangerously',
  });
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 200 },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false }, 61: { active: false } }, spells: {} },
    },
    interface: { hotbarManager: { __handleClick: () => {}, __canPlayerCastSpell: () => true } },
    mouse: { use: () => {} },
  };
  dom.window.gameClient = gameClient;
  dom.window.fetch = async (url, opts) => {
    const entry = {
      url: String(url).split('?')[0],
      method: opts && opts.method ? opts.method : 'GET',
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    };
    if (entry.method === 'POST') posts.push(entry);
    let payload;
    if (entry.url === '/api/identity') payload = { identity: FLAMAMEX };
    else if (entry.url === '/api/character-config') payload = { config: BASE_CFG };
    else if (entry.url === '/api/snapshot') payload = { stats: { health: 100, mana: 100 }, agent: { modules: {} } };
    else if (entry.url === '/api/connect') payload = { ok: true, config: BASE_CFG };
    else if (entry.url === '/api/config') {
      // The server bridge: push the nested body to the in-page agent with
      // armed:true (server.ts POST /api/config lines 354-355).
      dom.window.__mbAgent.applyConfig(Object.assign({}, entry.body.config, { armed: true }));
      payload = { ok: true };
    } else if (entry.url === '/api/spell-catalog') payload = { ok: true, catalog: [] };
    else if (entry.url === '/api/profiles') payload = { ok: true, profiles: [] };
    else payload = { ok: false };
    return { status: 200, json: async () => payload };
  };
  dom.window.eval(BUNDLE);
  dom.window.eval(STATE_JS);
  dom.window.localStorage.setItem('tutorialSeen', '1'); // skip the tour overlay
  dom.window.eval(APP_JS);
  return { dom, posts };
}

async function teardownPanel(dom) {
  await new Promise((r) => setTimeout(r, 30));
  try {
    if (dom.window.__mbPanel && typeof dom.window.__mbPanel.stop === 'function') dom.window.__mbPanel.stop();
  } catch { /* best-effort */ }
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch { /* best-effort */ }
  dom.window.close();
}

async function connect(dom) {
  dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
  dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: FLAMAMEX });
  dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(dom.window.__mbPanel.getState().gate, 'armed');
}

test('REQ-08 fix: FULL PATH — UI toggles -> nested POST body -> server bridge -> agent toggles ON', async () => {
  const { dom, posts } = makeFullPathPage();
  try {
    await connect(dom);
    // Toggle modules in the UI (the real TOGGLE_MODULE reducer path; each
    // toggle fires the push-config effect -> POST /api/config). The 12
    // panel MODULE_IDS (antibot is configured via the OTHERS form, not a
    // toggle — PR 5).
    for (const id of ['routes', 'attack', 'cavebot', 'runes', 'training', 'eat',
      'loot', 'trade', 'spawns', 'huntStats', 'healItems', 'healMagic']) {
      dom.window.__mbPanel.dispatch({ type: 'TOGGLE_MODULE', module: id, on: true });
    }
    await new Promise((r) => setTimeout(r, 120));

    // The outgoing payload IS the nested store shape (buildPushConfig).
    const cfgPosts = posts.filter((p) => p.url === '/api/config');
    assert.ok(cfgPosts.length >= 12, 'one push-config per toggle');
    const last = cfgPosts[cfgPosts.length - 1];
    assert.equal(last.body.config.modules.routes.on, true, 'POST body carries the NESTED toggle');
    assert.equal(last.body.config.modules.attack.on, true);

    // And the agent — fed by the server bridge with that exact body — sees
    // every toggle ON (the pre-fix agent dropped the whole `modules` key).
    const st = dom.window.__mbAgentHandle.getState().modules;
    assert.equal(st.routes.on, true, 'FULL PATH: UI toggle -> agent routes.on TRUE');
    assert.equal(st.attack.on, true);
    assert.equal(st.cavebot.on, true);
    assert.equal(st.runes.on, true);
    assert.equal(st.training.on, true);
    assert.equal(st.eat.on, true);
    assert.equal(st.loot.on, true);
    assert.equal(st.trade.on, true);
    assert.equal(st.spawns.on, true);
    assert.equal(st.huntStats.on, true);
    assert.equal(dom.window.__mbAgentHandle.getState().armed, true);
  } finally {
    await teardownPanel(dom);
  }
});
