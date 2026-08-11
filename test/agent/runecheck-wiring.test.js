'use strict';

/**
 * Rune-check pause/resume wiring tests (REQ-40/41, D-A3/A4): detection
 * pauses the queue gate + carries snapshot.runeCheck; the 10s cooldown
 * without fresh verification wording auto-resumes; the resumeRuneCheck RPC
 * manually unpauses; both are armed-gated. Deterministic: createAgent is
 * driven directly with an injectable clock + no-op timers (no real bundle,
 * no real timers — tickOnce is called by hand).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createAgent } = require('../../src/agent/bootstrap');

const FLAMAMEX_CFG = {
  queue: { minIntervalMs: 150 },
  jitter: { min: 50, max: 400 },
  survival: { on: false, threshold: 50, slot: null },
  rotation: { spells: [] },
  armed: true,
  antibot: { on: true, replies: [], domRuneCheck: false },
};

/** jsdom page + gameClient with a mutable Default channel; returns the agent
 *  handle wired with a fake clock and no-op timers (tickOnce is manual). */
function makeAgent({ armed = true, config } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const contents = [];
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 100 },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false } }, spells: {} },
    },
    interface: {
      hotbarManager: { __handleClick: () => {}, __canPlayerCastSpell: () => true },
      channelManager: { getChannel: (name) => (name === 'Default' ? { __contents: contents } : null) },
    },
    mouse: { use: () => {} },
  };
  dom.window.gameClient = gameClient;
  const now = { t: 1000 };
  const handle = createAgent({
    win: dom.window,
    document: dom.window.document,
    gameClient,
    config: Object.assign({}, FLAMAMEX_CFG, config || {}, { armed }),
    now: () => now.t,
    rng: () => 0.5,
    autoStart: false,
    setTimeout: () => {},      // the ticker never self-arms — ticks are manual
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
    log: { error: () => {}, warn: () => {}, info: () => {} },
  });
  handle.poll(); // wire gameClient -> ready (autoStart false: no start yet)
  // Mirror the real flow: the server pushes the config AFTER readiness, so
  // the modules are rebuilt with the live gameClient (the initial rebuild
  // at createAgent ran with gameClient still null).
  handle.applyConfig(Object.assign({}, FLAMAMEX_CFG, config || {}, { armed }));
  handle.start(); // running=true; the no-op setTimeout never fires
  return { handle, now, contents, gameClient, dom };
}

function teardown(handle, dom) {
  try { handle.destroy(); } catch { /* best-effort */ }
  try { dom.window.close(); } catch { /* best-effort */ }
}

test('REQ-40 (wiring): chat rune-check detection pauses the queue and carries snapshot.runeCheck', () => {
  const { handle, contents, dom } = makeAgent();
  try {
    contents.push({ name: 'Cipfried', message: 'Please verify you are human', __time: 1000, type: 2 });
    handle.tickOnce();
    const st = handle.getState();
    assert.deepEqual(JSON.parse(JSON.stringify(st.runeCheck)), {
      active: true, at: 1000, kind: 'chat', lastSeenAt: 1000,
    }, 'snapshot.runeCheck carried (REQ-40)');
    assert.equal(handle.getQueue().isPaused(), true, 'queue gate paused on detection');
    assert.equal(st.queue.paused, true, 'queue stats expose the pause');
    assert.equal(st.modules.antibot.runeCheck.active, true, 'module state rides the snapshot');
  } finally {
    teardown(handle, dom);
  }
});

test('REQ-40 (wiring): paused drain is a no-op — the tree may enqueue but nothing dispatches', () => {
  const { handle, gameClient, contents, dom } = makeAgent({
    config: {
      survival: { on: true, threshold: 50, slot: 1 },
      healItems: { on: false },
      healMagic: { on: false },
      runes: { on: false },
      training: { on: false },
      eat: { on: false },
    },
  });
  try {
    contents.push({ name: 'Cipfried', message: 'click to verify you are human', __time: 1000, type: 2 });
    handle.tickOnce();
    assert.equal(handle.getQueue().isPaused(), true);
    // Low hp normally enqueues the survival heal — while paused it must NOT dispatch.
    gameClient.player.state.health = 30;
    const before = handle.getQueue().stats().dispatched;
    assert.ok(handle.tickOnce() !== null, 'tick ran while paused');
    assert.equal(handle.getQueue().stats().dispatched, before, 'no dispatch while paused');
    assert.ok(handle.getQueue().stats().pending >= 1, 'the heal stayed pending (defer, never drop)');
  } finally {
    teardown(handle, dom);
  }
});

test('REQ-40/41 (wiring): auto-resume after the 10s cooldown without fresh verification wording', () => {
  const { handle, now, contents, dom } = makeAgent();
  try {
    contents.push({ name: 'Cipfried', message: 'Please verify you are human', __time: 1000, type: 2 });
    handle.tickOnce();
    assert.equal(handle.getQueue().isPaused(), true);

    // Fresh wording before the cooldown: stays paused, lastSeenAt refreshes.
    now.t = 5000;
    contents[0] = { name: 'Cipfried', message: 'Please verify you are human', __time: 5000, type: 2 };
    handle.tickOnce();
    assert.equal(handle.getQueue().isPaused(), true, 'still paused with fresh wording');
    assert.equal(handle.getState().runeCheck.lastSeenAt, 5000, 'lastSeenAt refreshed');

    // No wording for the full 10s -> auto-resume on the next tick.
    now.t = 15000; // 5000 + 10000
    handle.tickOnce();
    assert.equal(handle.getQueue().isPaused(), false, 'auto-resumed after the cooldown');
    assert.equal(handle.getState().runeCheck, null, 'snapshot cleared');
    assert.equal(handle.getState().modules.antibot.runeCheck, null, 'module state cleared');

    // A NEW detection raises a new event and pauses again.
    now.t = 16000;
    contents[0] = { name: 'Cipfried', message: 'Please verify you are human', __time: 16000, type: 2 };
    handle.tickOnce();
    assert.equal(handle.getQueue().isPaused(), true, 're-detection pauses again');
    assert.equal(handle.getState().runeCheck.active, true);
  } finally {
    teardown(handle, dom);
  }
});

test('REQ-41 (wiring): resumeRuneCheck RPC manually unpauses and clears the state', () => {
  const { handle, contents, dom } = makeAgent();
  try {
    contents.push({ name: 'Cipfried', message: 'select the right images to verify', __time: 1000, type: 2 });
    handle.tickOnce();
    assert.equal(handle.getQueue().isPaused(), true);

    const res = handle.surface.resumeRuneCheck();
    assert.equal(res.ok, true);
    assert.equal(handle.getQueue().isPaused(), false, 'queue unpaused');
    assert.equal(handle.getState().runeCheck, null, 'snapshot cleared');
    assert.equal(handle.getState().modules.antibot.runeCheck, null, 'module cleared — no re-pause on the next tick');
    handle.tickOnce();
    assert.equal(handle.getQueue().isPaused(), false, 'the reconcile does not re-pause after manual resume');
  } finally {
    teardown(handle, dom);
  }
});

test('REQ-41 (wiring): resumeRuneCheck is refused pre-Connect (REQ-02 gate)', () => {
  const { handle, dom } = makeAgent({ armed: false });
  try {
    const res = handle.surface.resumeRuneCheck();
    assert.deepEqual(JSON.parse(JSON.stringify(res)), { ok: false, reason: 'not connected' });
  } finally {
    teardown(handle, dom);
  }
});
