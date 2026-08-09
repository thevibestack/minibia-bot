'use strict';

/**
 * Slice-6 wiring tests (REQ-23): the routes-v1 module -> surface -> queue
 * -> native pathfinder funnel against the REAL committed agent bundle, with
 * a mocked game client carrying the live-probed pathfinder shape
 * (world.pathfinder: __isAutoWalking / __autoWalkStepsRemaining /
 * __autowalkStartPosition / __minimapWaypoints / pathTo — obs 10320).
 * The walk-to action reaches the game ONLY through the native pathTo call
 * inside a queue-dispatched closure (REQ-12 no-bypass, REQ-23 never
 * synthetic input); getWalkState reads the honest module state.
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

/** Fresh jsdom page with a mocked gameClient carrying the probed slice-6
 *  pathfinder surface. `pathfinder` is overridable (null = absent). */
function makePage(overrides = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const pathCalls = [];
  const pf = overrides.pathfinder !== undefined ? overrides.pathfinder : {
    __isAutoWalking: true,
    __autoWalkStepsRemaining: 12,
    __autowalkStartPosition: { x: 100, y: 100 },
    __minimapWaypoints: [{ x: 100, y: 100 }, { x: 120, y: 140 }],
    pathTo: (x, y) => { pathCalls.push({ x, y }); return true; },
  };
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100 },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false } }, spells: {} },
    },
    interface: {
      getSpell: () => null,
      hotbarManager: { __handleClick: () => {} },
    },
    world: { pathfinder: pf },
    mouse: { use: () => {} },
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  return { dom, pathCalls, gameClient };
}

function teardown(dom) {
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch { /* best-effort */ }
  dom.window.close();
}

/** Slice-6 config: everything OFF except what the test turns on. */
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
    routes: { on: false },
    armed: true,
  }, overrides);
}

test('REQ-23: getWalkState reports the autowalk read — steps, start, destination', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ routes: { on: true } }));
    const st = dom.window.__mbAgent.getWalkState();
    assert.equal(st.available, true);
    assert.equal(st.isAutoWalking, true);
    assert.equal(st.stepsRemaining, 12);
    // jsdom-realm objects carry a different prototype — JSON-normalize.
    assert.deepEqual(JSON.parse(JSON.stringify(st.startPosition)), { x: 100, y: 100 });
    assert.deepEqual(JSON.parse(JSON.stringify(st.destination)), { x: 120, y: 140 },
      'REQ-23: panel shows steps + destination');
    assert.equal(st.recording, 'future');
    assert.equal(handle.getState().modules.routes.reason, 'ok');
  } finally {
    teardown(dom);
  }
});

test('REQ-23: no pathfinder -> getWalkState degrades to "no pathfinder data"', async () => {
  const { dom } = makePage({ pathfinder: null });
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ routes: { on: true } }));
    const st = dom.window.__mbAgent.getWalkState();
    assert.equal(st.available, false);
    assert.equal(st.reason, 'no pathfinder data');
    assert.equal(st.isAutoWalking, false);
  } finally {
    teardown(dom);
  }
});

test('REQ-23: walkTo RPC is refused pre-Connect (REQ-02 gate)', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    // No applyConfig with armed:true -> disarmed.
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.walkTo(150, 200))),
      { ok: false, reason: 'not connected' });
  } finally {
    teardown(dom);
  }
});

test('REQ-23: walkTo issues the NATIVE pathTo through the queue (no synthetic input)', async () => {
  const { dom, pathCalls } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ routes: { on: true } }));
    const res = dom.window.__mbAgent.walkTo(150, 200);
    assert.equal(res.ok, true);
    assert.equal(res.method, 'pathTo', 'native autowalk primitive, never synthetic per-step input');
    assert.equal(res.x, 150);
    assert.equal(res.y, 200);

    assert.equal(await waitFor(() => pathCalls.length >= 1, { timeout: 6000 }), true,
      'the native pathTo call lands (queue-dispatched)');
    assert.deepEqual(pathCalls[0], { x: 150, y: 200 });
    const q = handle.getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'walk-to passed the queue (REQ-12 no-bypass)');
  } finally {
    teardown(dom);
  }
});

test('REQ-23: walkTo OFF toggle -> refused, native pathTo NEVER called', async () => {
  const { dom, pathCalls } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ routes: { on: false } }));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.walkTo(150, 200))),
      { ok: false, reason: 'off' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pathCalls.length, 0, 'no native call with the toggle off');
  } finally {
    teardown(dom);
  }
});

test('REQ-23: walkTo degrades without pathfinder data — refused, never fires', async () => {
  const { dom } = makePage({ pathfinder: null });
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ routes: { on: true } }));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.walkTo(150, 200))),
      { ok: false, reason: 'no pathfinder data' });
  } finally {
    teardown(dom);
  }
});

test('REQ-23: walkTo with invalid coordinates is refused (no native call)', async () => {
  const { dom, pathCalls } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ routes: { on: true } }));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.walkTo('', 200))),
      { ok: false, reason: 'invalid-coordinates' });
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.walkTo(null, 200))),
      { ok: false, reason: 'invalid-coordinates' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pathCalls.length, 0);
  } finally {
    teardown(dom);
  }
});

test('REQ-23: routes state flows through getState into the snapshot for the panel', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ routes: { on: true } }));
    const st = handle.getState().modules.routes;
    assert.equal(st.available, true);
    assert.equal(st.walkTo.available, true);
    assert.equal(st.walkTo.method, 'pathTo');
    assert.equal(st.recording, 'future');
  } finally {
    teardown(dom);
  }
});
