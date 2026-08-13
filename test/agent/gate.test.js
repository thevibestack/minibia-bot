'use strict';

/**
 * Agent gate tests (task 3.2, REQ-02/04/08): the in-page agent refuses to
 * act before an explicit armed push (interconnection gate), resolves the
 * vocation label from the live-probed __VOCATION_NAMES location, and never
 * injects any UI into the game document (REQ-08 no overlay).
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

/** Fresh page with a mocked gameClient carrying the REAL probed location:
 *  hotbarManager.__VOCATION_NAMES (obs 10320). */
function makePage() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const casts = [];
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 100 },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false } }, spells: {} },
    },
    interface: {
      hotbarManager: {
        __VOCATION_NAMES: { 0: 'none', 1: 'knight', 2: 'paladin', 3: 'sorcerer', 4: 'druid' },
        __handleClick: (index) => { casts.push({ slot: index + 1, at: Date.now() }); },
      },
    },
    mouse: { use: () => {} },
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  return { dom, casts, gameClient };
}

function teardown(dom) {
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch { /* best-effort */ }
  dom.window.close();
}

function armedConfig(overrides = {}) {
  return Object.assign({
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: true, threshold: 50, slot: 1 },
    rotation: { spells: [] },
    armed: true,
  }, overrides);
}

test('REQ-02: agent boots DISARMED — no action fires before an armed push', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    assert.equal(handle.getState().armed, false, 'gate starts disarmed');

    gameClient.player.state.health = 10; // way below any threshold
    await new Promise((r) => setTimeout(r, 900)); // several tick cadences
    assert.equal(casts.length, 0, 'no actions while disarmed (REQ-02 refusal)');
  } finally {
    teardown(dom);
  }
});

test('REQ-02: applyConfig without armed:true keeps the agent disarmed', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig({
      queue: { minIntervalMs: 150 },
      jitter: { min: 50, max: 400 },
      survival: { on: true, threshold: 50, slot: 1 },
      // no armed field
    });
    gameClient.player.state.health = 10;
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(casts.length, 0, 'absent armed flag never arms');
    assert.equal(handle.getState().armed, false);
  } finally {
    teardown(dom);
  }
});

test('REQ-02: fireSlot RPC is refused with "not connected" pre-Connect', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    const res = dom.window.__mbAgent.fireSlot(3, 'handleClick');
    assert.deepEqual(JSON.parse(JSON.stringify(res)), { ok: false, reason: 'not connected' });
  } finally {
    teardown(dom);
  }
});

test('REQ-02: armed push arms the engine — heals dispatch; fireSlot accepted', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig(armedConfig());
    assert.equal(handle.getState().armed, true, 'explicit armed:true arms the gate');

    gameClient.player.state.health = 30;
    assert.equal(await waitFor(() => casts.length >= 1), true, 'heal fires once armed');
    assert.equal(casts[0].slot, 1);

    assert.equal(dom.window.__mbAgent.fireSlot(2, 'handleClick'), true, 'RPC fire accepted when armed');
  } finally {
    teardown(dom);
  }
});

test('REQ-02: disarm push stops actions again (gate reset)', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig(armedConfig());
    gameClient.player.state.health = 30;
    assert.equal(await waitFor(() => casts.length >= 1), true);

    dom.window.__mbAgent.applyConfig({ armed: false });
    assert.equal(handle.getState().armed, false);
    const before = casts.length;
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(casts.length, before, 'no new actions after disarm');
  } finally {
    teardown(dom);
  }
});

test('REQ-02/D5: vocation label resolves from hotbarManager.__VOCATION_NAMES (live-probed location)', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    const info = dom.window.__mbAgent.getPlayerInfo();
    assert.equal(info.name, 'Flamamex');
    assert.equal(info.vocationId, 4);
    assert.equal(info.vocationLabel, 'druid', 'label read from the real probed table (obs 10320)');
  } finally {
    teardown(dom);
  }
});

test('REQ-08: the agent never injects UI into the game document', async () => {
  const { dom, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig(armedConfig());
    gameClient.player.state.health = 10;
    await waitFor(() => handle.getState().queue.dispatched >= 1, { timeout: 8000 });

    assert.equal(dom.window.document.body.innerHTML, '', 'no overlay/panel element in the game page');
    assert.equal(dom.window.document.querySelectorAll('style').length, 0, 'no injected styles');
    assert.equal(dom.window.document.querySelectorAll('[data-mb-panel], .module-toggle').length, 0,
      'no panel markers in the game document');
  } finally {
    teardown(dom);
  }
});

test('REQ-46: hotkey RPC degrades to display-only when the keyboard surface is absent', async () => {
  const { dom } = makePage(); // makePage has hotbarManager but NO keyboard
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    const read = dom.window.__mbAgent.getHotbarKeybinds();
    assert.equal(read.available, false, 'feature-detect: no keyboard surface');
    dom.window.__mbAgent.applyConfig(armedConfig());
    const write = dom.window.__mbAgent.setHotbarKeybind({ slot: 3, keyCode: 115 });
    assert.equal(write.ok, false, 'write refused without the keyboard surface');
    assert.equal(write.reason, 'keyboard unavailable');
  } finally {
    teardown(dom);
  }
});

test('REQ-46: hotkey RPC reads/writes keyboard.__hotbarKeybinds when armed', async () => {
  const { dom, gameClient } = makePage();
  gameClient.interface.keyboard = { __hotbarKeybinds: {} };
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    // REQ-02 gate: writes are refused pre-Connect.
    const pre = dom.window.__mbAgent.setHotbarKeybind({ slot: 3, keyCode: 115 });
    assert.deepEqual(JSON.parse(JSON.stringify(pre)), { ok: false, reason: 'not connected' });

    dom.window.__mbAgent.applyConfig(armedConfig());
    const res = dom.window.__mbAgent.setHotbarKeybind({ slot: 3, keyCode: 115 }); // F4 = 115
    assert.equal(res.ok, true);
    assert.equal(gameClient.interface.keyboard.__hotbarKeybinds[3], 115, 'keyboard.__hotbarKeybinds written');

    const read = dom.window.__mbAgent.getHotbarKeybinds();
    assert.equal(read.available, true);
    assert.equal(read.keybinds[3], 115, 'read mirrors the written keybind');

    const badSlot = JSON.parse(JSON.stringify(dom.window.__mbAgent.setHotbarKeybind({ slot: 13, keyCode: 115 })));
    assert.deepEqual(badSlot, { ok: false, reason: 'invalid slot' });
    const badKey = JSON.parse(JSON.stringify(dom.window.__mbAgent.setHotbarKeybind({ slot: 3, keyCode: 'x' })));
    assert.deepEqual(badKey, { ok: false, reason: 'invalid keyCode' });
  } finally {
    teardown(dom);
  }
});
