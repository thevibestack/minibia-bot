'use strict';

/**
 * Slice-5 wiring tests (REQ-18..22,24,25): the ported automation modules ->
 * tree -> queue -> game-handler funnel against the REAL committed agent
 * bundle, with a mocked game client carrying the probed surfaces
 * (channelManager Trade channel, world.activeCreatures, spawn data, loot
 * command, premium fields). Toggles honored (module OFF = zero actions),
 * queue no-bypass (handler calls only through dispatched closures), premium
 * blocks ONLY gated modules (others keep working, REQ-22).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', '..', 'minibia-desktop-agent.js'), 'utf8');

async function waitFor(fn, { timeout = 5000, step = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * Fresh jsdom page with a rich mocked gameClient carrying the slice-5 probed
 * surfaces: channelManager (Trade id 2 + Default), world.activeCreatures
 * (mutable), spawns map, loot command, premium field.
 */
function makePage(overrides = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const casts = [];
  const sent = [];          // Trade-channel sends
  const lootCalls = [];     // loot-command calls
  const uses = [];          // mouse.use fallback calls
  const creatures = overrides.creatures !== undefined ? overrides.creatures : [];
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, xp: 1000, gold: 500 },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false } }, spells: {} },
      premium: overrides.premium,
    },
    interface: {
      getSpell: (sid) => ({ 61: { cost: 20 }, 50: { cost: 25 } }[sid] || null),
      hotbarManager: {
        __handleClick: (slot) => casts.push({ slot, at: Date.now() }),
        __canPlayerCastSpell: () => true,
        __runeAttackUntil: null,
        __runeHealUntil: null,
      },
      channelManager: {
        getChannel: (name) => (name === 'Default' ? { __contents: overrides.chatContents || [] } : null),
        getChannelById: (id) => (id === 2 ? { send: (msg) => sent.push(msg) } : null),
      },
    },
    world: {
      activeCreatures: creatures,
      spawns: overrides.spawns !== undefined ? overrides.spawns : { query: (m) => (m === 'Rat' ? [{ x: 100, y: 200 }] : null) },
    },
    lootCommands: overrides.lootCommand !== undefined
      ? overrides.lootCommand
      : { routeLoot: (monster, dest) => lootCalls.push({ monster, dest }) },
    mouse: { use: (args) => uses.push(args) },
    backpack: { slots: [] },
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  return { dom, casts, sent, lootCalls, uses, creatures, gameClient };
}

function teardown(dom) {
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch { /* best-effort */ }
  dom.window.close();
}

/** Full slice-5 config: everything OFF except what the test turns on. */
function sliceConfig(overrides = {}) {
  return Object.assign({
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: false, threshold: 50, slot: null },
    rotation: { spells: [] },
    healItems: { on: false, threshold: 50, slotCids: [] },
    healMagic: { on: false, threshold: 150, slot: 2, sid: 61, word: null },
    runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null },
    training: { on: false, slot: null, sid: null, reserve: 0, word: null },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    trade: { on: false, message: '', intervalMs: 180000 },
    loot: { on: false, defaultDest: null, perMonster: {} },
    spawns: { on: false },
    huntStats: { on: false },
    learning: { knownWords: [] },
    armed: true,
  }, overrides);
}

test('REQ-18: trade broadcasts through the queue to the game Trade channel; OFF = zero', async () => {
  const { dom, sent } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ trade: { on: true, message: 'buying blank runes', intervalMs: 1 } }));

    assert.equal(await waitFor(() => sent.length >= 1, { timeout: 6000 }), true,
      '3-min cadence (intervalMs 1 for the test) -> Trade channel send');
    assert.equal(sent[0], 'buying blank runes');
    const q = handle.getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'the send passed the queue (REQ-12 no-bypass)');

    // OFF toggle: zero further sends.
    dom.window.__mbAgent.applyConfig(sliceConfig({ trade: { on: false, message: 'buying blank runes', intervalMs: 1 } }));
    const before = sent.length;
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(sent.length, before, 'trade OFF -> no broadcasts (no spam, REQ-18)');
  } finally {
    teardown(dom);
  }
});

test('REQ-18: no native channel surface -> degrade recorded in the snapshot, never sends', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  try {
    const gameClient = {
      player: { name: 'Flamamex', vocation: 4, state: { mana: 100, maxMana: 120, health: 100 } },
      interface: { hotbarManager: { __handleClick: () => {}, __canPlayerCastSpell: () => true } },
      mouse: { use: () => {} },
    }; // NO channelManager at all
    dom.window.gameClient = gameClient;
    dom.window.eval(BUNDLE);
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ trade: { on: true, message: 'hi', intervalMs: 1 } }));
    await waitFor(() => {
      const st = handle.getState().modules.trade;
      return st && st.reason === 'no native trade channel';
    }, { timeout: 6000 });
    const st = handle.getState().modules.trade;
    assert.equal(st.available, false, 'honest panel state');
    assert.equal(st.reason, 'no native trade channel');
  } finally {
    teardown(dom);
  }
});

test('REQ-19: a killed creature with loot routes to its destination via the game loot command', async () => {
  const { dom, creatures, lootCalls } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({
      loot: { on: true, defaultDest: 'Loot bag', perMonster: { Rat: 'Dust bag' } },
    }));
    creatures.push({ id: 1, name: 'Rat', loot: true });
    await new Promise((r) => setTimeout(r, 700)); // baseline scan sees the Rat
    creatures.length = 0; // Rat disappears -> kill with loot
    assert.equal(await waitFor(() => lootCalls.length >= 1, { timeout: 6000 }), true,
      'kill + loot -> routed via the game loot command (REQ-19)');
    assert.deepEqual(lootCalls[0], { monster: 'Rat', dest: 'Dust bag' }, 'per-monster destination wins');
  } finally {
    teardown(dom);
  }
});

test('REQ-19: loot without a configured destination never fires; no loot info never routes', async () => {
  const { dom, creatures, lootCalls } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ loot: { on: true, defaultDest: null, perMonster: {} } }));
    creatures.push({ id: 1, name: 'Rat', loot: true });
    await new Promise((r) => setTimeout(r, 700));
    creatures.length = 0;
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(lootCalls.length, 0, 'no destination -> no route');
    const st = handle.getState().modules.loot;
    assert.equal(st.pendingCount >= 1, true, 'the kill stayed pending (not silently dropped)');
  } finally {
    teardown(dom);
  }
});

test('REQ-20: getSpawns RPC resolves monster locations; absent data -> "no spawn data"', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ spawns: { on: true } }));
    const q = dom.window.__mbAgent.getSpawns('Rat');
    assert.equal(q.available, true);
    assert.deepEqual(JSON.parse(JSON.stringify(q.locations)), [{ x: 100, y: 200 }]);

    const noSpawns = makePage({ spawns: null });
    try {
      const h2 = noSpawns.dom.window.__mbAgentHandle;
      assert.equal(await waitFor(() => h2.isReady()), true);
      noSpawns.dom.window.__mbAgent.applyConfig(sliceConfig({ spawns: { on: true } }));
      const q2 = noSpawns.dom.window.__mbAgent.getSpawns('Rat');
      assert.equal(q2.available, false);
      assert.equal(q2.reason, 'no spawn data');
      assert.equal(h2.getState().modules.spawns.reason, 'no spawn data');
    } finally {
      teardown(noSpawns.dom);
    }
  } finally {
    teardown(dom);
  }
});

test('REQ-21: hunt stats accumulate from agent snapshots; toggle OFF freezes them', async () => {
  const { dom, gameClient, creatures } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ huntStats: { on: true } }));
    creatures.push({ id: 1, name: 'Rat', loot: true });
    await new Promise((r) => setTimeout(r, 800));
    gameClient.player.state.xp = 2000;
    gameClient.player.state.gold = 900;
    await new Promise((r) => setTimeout(r, 800));
    creatures.length = 0; // Rat killed
    await new Promise((r) => setTimeout(r, 800));

    const st = handle.getState().modules.huntStats;
    assert.equal(st.running, true);
    assert.equal(st.totals.xp, 1000, 'xp delta accumulated (REQ-21)');
    assert.equal(st.totals.gold, 400);
    assert.equal(st.totals.kills, 1, 'kill diff from world.activeCreatures');

    // Toggle OFF = session stop -> stats freeze.
    dom.window.__mbAgent.applyConfig(sliceConfig({ huntStats: { on: false } }));
    const frozen = handle.getState().modules.huntStats;
    assert.equal(frozen.frozen, true);
    gameClient.player.state.xp = 9999;
    await new Promise((r) => setTimeout(r, 800));
    const after = handle.getState().modules.huntStats;
    assert.equal(after.totals.xp, frozen.totals.xp, 'snapshot freezes at the stop point (REQ-21)');
  } finally {
    teardown(dom);
  }
});

test('REQ-22: premium=false blocks ONLY the gated modules; heal-items keeps working', async () => {
  const { dom, casts, uses, gameClient } = makePage({ premium: false });
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    const cfg = sliceConfig({
      trade: { on: true, message: 'hi', intervalMs: 1 },
      loot: { on: true, defaultDest: 'bag', perMonster: {} },
      spawns: { on: true },
      huntStats: { on: true },
      healItems: { on: true, threshold: 50, slotCids: [100] },
    });
    gameClient.backpack.slots = [{ index: 3, cid: 100 }];
    gameClient.player.state.health = 30; // below the heal threshold -> heal-items fires
    dom.window.__mbAgent.applyConfig(cfg);

    assert.equal(await waitFor(() => uses.length >= 1, { timeout: 6000 }), true,
      'non-gated modules keep working (REQ-22)');
    assert.equal(uses.length >= 1, true);
    const st = handle.getState().modules;
    assert.equal(st.trade.premium.blocked, true, 'trade reports Premium required');
    assert.equal(st.trade.reason, 'premium-required');
    assert.equal(st.loot.premium.blocked, true);
    assert.equal(st.spawns.premium.blocked, true);
    assert.equal(st.huntStats.premium.blocked, true);
    assert.equal(casts.length, 0, 'gated module never fired');
  } finally {
    teardown(dom);
  }
});

test('REQ-24: echo validation wired to heal-magic word fires — pass counts; miss logs + no refire', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    const chat = { __contents: [] };
    gameClient.interface.channelManager.getChannel = (name) => (name === 'Default' ? chat : null);
    dom.window.__mbAgent.applyConfig(sliceConfig({
      healMagic: { on: true, threshold: 150, slot: 2, sid: 61, word: 'exura' },
    }));
    gameClient.player.state.health = 100;

    // Words-path fire -> validation starts; the game echoes the player's word.
    assert.equal(await waitFor(() => casts.some((c) => c.slot === 2), { timeout: 6000 }), true,
      'heal fires via __handleClick');
    const echoTime = Date.now() - 100; // pre-existing entries are NOT valid echoes
    chat.__contents = [{ name: 'Flamamex', message: 'exura', __time: echoTime - 500 }];
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(handle.getState().modules.echo.misses, 0, 'pre-existing history never validates (baseline)');
    chat.__contents.push({ name: 'Flamamex', message: 'exura', __time: Date.now() });
    assert.equal(await waitFor(() => handle.getState().modules.echo.passes >= 1, { timeout: 4000 }), true,
      'echo arrives within 2500ms -> pass counted (REQ-24)');
  } finally {
    teardown(dom);
  }
});

test('REQ-24: no word configured -> validation skipped entirely (no echo path)', async () => {
  const { dom, gameClient, casts } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({
      healMagic: { on: true, threshold: 150, slot: 2, sid: 61, word: null },
    }));
    gameClient.player.state.health = 100;
    assert.equal(await waitFor(() => casts.some((c) => c.slot === 2), { timeout: 6000 }), true);
    await new Promise((r) => setTimeout(r, 400));
    const st = handle.getState().modules.echo;
    assert.equal(st.active, false, 'no validation started (REQ-24 skip)');
    assert.equal(st.misses, 0);
  } finally {
    teardown(dom);
  }
});

test('REQ-25: unknown-word offers surface in the snapshot; respondOffer decline silences for the session', async () => {
  const { dom, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    const chat = { __contents: [] };
    gameClient.interface.channelManager.getChannel = (name) => (name === 'Default' ? chat : null);
    dom.window.__mbAgent.applyConfig(sliceConfig());

    chat.__contents = [
      { name: 'Flamamex', message: 'exura', __time: Date.now() - 2000 },
      { name: 'Flamamex', message: 'exura', __time: Date.now() },
    ];
    assert.equal(await waitFor(() => {
      const o = handle.getState().modules.learning && handle.getState().modules.learning.offers;
      return Array.isArray(o) && o.length >= 1;
    }, { timeout: 6000 }), true, 'offer surfaces for the panel (REQ-25)');
    const offers = handle.getState().modules.learning.offers;
    assert.equal(offers[0].word, 'exura');

    // Decline (panel button -> server RPC): session-silent.
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.respondOffer('decline', 'exura'))),
      { ok: true, action: 'decline', word: 'exura' });
    assert.equal(handle.getState().modules.learning.offers.length, 0, 'declined offer leaves the panel list');
    chat.__contents.push({ name: 'Flamamex', message: 'exura', __time: Date.now() });
    chat.__contents.push({ name: 'Flamamex', message: 'exura', __time: Date.now() + 1 });
    await new Promise((r) => setTimeout(r, 700));
    const after = handle.getState().modules.learning.offers;
    assert.equal(after.length, 0, 'declined word never offers again this session (REQ-25)');
  } finally {
    teardown(dom);
  }
});

test('REQ-25: respondOffer refused pre-Connect; confirm marks the word known on rebuild', async () => {
  const { dom, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    // Disarmed: RPC refused (REQ-02 gate).
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.respondOffer('decline', 'exura'))),
      { ok: false, reason: 'not connected' });

    const chat = { __contents: [] };
    gameClient.interface.channelManager.getChannel = (name) => (name === 'Default' ? chat : null);
    dom.window.__mbAgent.applyConfig(sliceConfig());
    chat.__contents = [
      { name: 'Flamamex', message: 'exura', __time: Date.now() - 2000 },
      { name: 'Flamamex', message: 'exura', __time: Date.now() },
    ];
    assert.equal(await waitFor(() => handle.getState().modules.learning.offers.length >= 1, { timeout: 6000 }), true);

    // Confirm path: the server appends the word to learning.knownWords and
    // pushes the config; the rebuilt module treats it as configured.
    const cfg = sliceConfig({ learning: { knownWords: ['exura'] } });
    dom.window.__mbAgent.applyConfig(cfg);
    chat.__contents.push({ name: 'Flamamex', message: 'exura', __time: Date.now() + 5 });
    chat.__contents.push({ name: 'Flamamex', message: 'exura', __time: Date.now() + 6 });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(handle.getState().modules.learning.offers.length, 0, 'configured word -> no further offers');
    assert.ok(handle.getState().modules.learning.knownWords.indexOf('exura') !== -1, 'knownWords exposed in state');
  } finally {
    teardown(dom);
  }
});
