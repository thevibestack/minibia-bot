'use strict';

/**
 * PR 6 — skeleton wiring tests (REQ-35/36, D10, task 6.3): the attack +
 * cavebot modules reach the agent through the REAL committed bundle —
 * getState carries the skeleton flags, NO tree actions ever fire from the
 * skeletons (no combat loop, no continuous walking), and the cavebot
 * record/start RPCs are armed-gated and queue-dispatched (REQ-12
 * no-bypass; the start walk issues the NATIVE pathTo to the NEAREST
 * waypoint — euclidean min — never synthetic input).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', '..', 'minibia-desktop-agent.js'), 'utf8');

async function waitFor(fn, { timeout = 6000, step = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** Fresh jsdom page with a mocked gameClient carrying the PR6 surfaces:
 *  pathfinder (native walk-to) + player position + ground objects. All
 *  overridable (null = absent). */
function makePage(overrides = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const pathCalls = [];
  const pf = overrides.pathfinder !== undefined ? overrides.pathfinder : {
    pathTo: (x, y) => { pathCalls.push({ x, y }); return true; },
  };
  const position = overrides.position !== undefined ? overrides.position : { x: 118, y: 138 };
  const objects = overrides.objects !== undefined ? overrides.objects : null;
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, __position: position },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false } }, spells: {} },
    },
    interface: {
      getSpell: () => null,
      hotbarManager: { __handleClick: () => {} },
    },
    world: { pathfinder: pf, objects },
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

/** PR6 config: everything OFF except what the test turns on (flat agent
 *  shape — the wiring convention). `route` rides on the cavebot config. */
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
    attack: { on: false, targeting: 'lowest-hp', sid: null, runeSlot: null },
    cavebot: { on: false, paused: false, route: [] },
    armed: true,
  }, overrides);
}

/* ------------------------------ attack (REQ-35) ----------------------------- */

test('REQ-35: getState reports the attack skeleton — disclosure, pickers, no loop', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({
      attack: { on: true, targeting: 'nearest', sid: 12, runeSlot: 5 },
    }));
    const st = handle.getState().modules.attack;
    assert.equal(st.skeleton, true);
    assert.equal(st.disclosure, 'skeleton — limited');
    assert.equal(st.combatLoop, false);
    assert.equal(st.on, true);
    assert.equal(st.targeting, 'nearest');
    assert.deepEqual(JSON.parse(JSON.stringify(st.spell)), { sid: 12 });
    assert.deepEqual(JSON.parse(JSON.stringify(st.rune)), { slot: 5 });
  } finally {
    teardown(dom);
  }
});

/* ------------------------------ cavebot (REQ-36) ---------------------------- */

test('REQ-36: getState reports the cavebot skeleton — route, pause, editing FUTURE', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({
      cavebot: { on: true, paused: false, route: [{ x: 100, y: 100 }, { x: 120, y: 140 }] },
    }));
    const st = handle.getState().modules.cavebot;
    assert.equal(st.skeleton, true);
    assert.equal(st.editing, 'future');
    assert.equal(st.paused, false);
    assert.equal(st.savedRoute.count, 2);
    assert.equal(st.recording.active, false);
  } finally {
    teardown(dom);
  }
});

test('REQ-36: the saved route also flows from the top-level routes array (store shape)', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    // The per-character store carries the route at the TOP level
    // (`routes: [...]` — REQ-36 "save = config.routes").
    dom.window.__mbAgent.applyConfig(sliceConfig({
      cavebot: { on: true },
      routes: [{ x: 40, y: 30 }, { x: 1, y: 1 }],
    }));
    const st = handle.getState().modules.cavebot;
    assert.equal(st.savedRoute.count, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(st.savedRoute.first)), { x: 40, y: 30 });
  } finally {
    teardown(dom);
  }
});

test('REQ-36: cavebotStart walks to the NEAREST waypoint via the NATIVE pathTo through the queue', async () => {
  const { dom, pathCalls } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({
      cavebot: { on: true, paused: false, route: [{ x: 100, y: 100 }, { x: 120, y: 140 }] },
    }));
    const res = dom.window.__mbAgent.cavebotStart();
    assert.equal(res.ok, true);
    assert.equal(res.waypoint, 1, 'nearest waypoint (120,140) to position (118,138)');
    assert.equal(res.x, 120);
    assert.equal(res.y, 140);
    assert.equal(res.method, 'pathTo', 'native autowalk primitive, never synthetic input');
    assert.equal(await waitFor(() => pathCalls.length >= 1), true, 'the native call lands (queue-dispatched)');
    assert.deepEqual(pathCalls[0], { x: 120, y: 140 });
    const q = handle.getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'start walk passed the queue (REQ-12 no-bypass)');
  } finally {
    teardown(dom);
  }
});

test('REQ-36: cavebotStart is refused pre-Connect and per gate (off/paused/no-route/no-position)', async () => {
  const { dom, pathCalls } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    // Pre-Connect (disarmed).
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.cavebotStart())),
      { ok: false, reason: 'not connected' });
    dom.window.__mbAgent.applyConfig(sliceConfig({ cavebot: { on: false } }));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.cavebotStart())),
      { ok: false, reason: 'off' });
    dom.window.__mbAgent.applyConfig(sliceConfig({
      cavebot: { on: true, paused: true, route: [{ x: 1, y: 1 }] },
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.cavebotStart())),
      { ok: false, reason: 'paused' });
    dom.window.__mbAgent.applyConfig(sliceConfig({ cavebot: { on: true, route: [] } }));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.cavebotStart())),
      { ok: false, reason: 'no-route' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pathCalls.length, 0, 'no native call from refused starts');
  } finally {
    teardown(dom);
  }
});

test('REQ-36: cavebotStart degrades without position or pathfinder — refused, never fires', async () => {
  const { dom, pathCalls } = makePage({ position: null });
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({
      cavebot: { on: true, route: [{ x: 1, y: 1 }] },
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.cavebotStart())),
      { ok: false, reason: 'no-position' });
  } finally {
    teardown(dom);
  }
  const page2 = makePage({ pathfinder: null });
  try {
    const handle = page2.dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    page2.dom.window.__mbAgent.applyConfig(sliceConfig({
      cavebot: { on: true, route: [{ x: 1, y: 1 }] },
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(page2.dom.window.__mbAgent.cavebotStart())),
      { ok: false, reason: 'no walk-to method' });
  } finally {
    teardown(page2.dom);
  }
  // Nothing fired in either degrade.
  assert.equal(pathCalls.length, 0, 'no native call from degraded starts');
});

/* ------------------------------ recording (REQ-36) --------------------------- */

test('REQ-36: startRouteRecording arms the sampler — throttled snapshots accumulate', async () => {
  const { dom, gameClient } = makePage({ position: { x: 10, y: 10 } });
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({ cavebot: { on: true } }));
    const res = dom.window.__mbAgent.startRouteRecording();
    assert.equal(res.ok, true);
    assert.equal(handle.getState().modules.cavebot.recording.active, true);
    // Move the player so consecutive snapshots differ (throttle + dedupe).
    let tick = 0;
    gameClient.player.state.__position = { x: 10, y: 10 };
    const sampler = setInterval(() => {
      tick += 1;
      gameClient.player.state.__position = { x: 10 + (tick % 2), y: 10 + (tick % 3) };
    }, 300);
    try {
      assert.equal(await waitFor(() => handle.getState().modules.cavebot.recording.points >= 3,
        { timeout: 9000 }), true, 'snapshots land on the sampler cadence');
    } finally {
      clearInterval(sampler);
    }
    const stopped = dom.window.__mbAgent.stopRouteRecording();
    assert.equal(stopped.ok, true);
    assert.ok(stopped.points.length >= 3, 'stop returns the recorded waypoints');
    assert.equal(handle.getState().modules.cavebot.recording.active, false);
    assert.equal(stopped.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), true,
      'plain {x,y} save shape');
  } finally {
    teardown(dom);
  }
});

test('REQ-36: record RPCs are armed-gated and idempotent', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    // Pre-Connect.
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.startRouteRecording())),
      { ok: false, reason: 'not connected' });
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.stopRouteRecording())),
      { ok: false, reason: 'not connected' });
    dom.window.__mbAgent.applyConfig(sliceConfig({ cavebot: { on: true } }));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.stopRouteRecording())),
      { ok: false, reason: 'not-recording' });
    assert.equal(dom.window.__mbAgent.startRouteRecording().ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__mbAgent.startRouteRecording())),
      { ok: false, reason: 'already-recording' });
    assert.equal(dom.window.__mbAgent.stopRouteRecording().ok, true);
  } finally {
    teardown(dom);
  }
});

/* --------------------------- no tree loop (REQ-35/36) ------------------------ */

test('REQ-35/36: skeletons run NO tree actions and never walk on their own', async () => {
  const { dom, pathCalls } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(sliceConfig({
      attack: { on: true, targeting: 'lowest-hp', sid: 12, runeSlot: 3 },
      cavebot: { on: true, paused: false, route: [{ x: 100, y: 100 }] },
    }));
    // Let ticks run for a moment with both skeletons ON.
    await new Promise((r) => setTimeout(r, 1200));
    const q = handle.getState().queue;
    assert.equal(q.enqueued, 0, 'no queue entry from the skeletons (no tree loop)');
    assert.equal(q.dispatched, 0, 'no dispatch from the skeletons');
    assert.equal(pathCalls.length, 0, 'never an autonomous walk');
    assert.equal(handle.getState().armed, true);
  } finally {
    teardown(dom);
  }
});
