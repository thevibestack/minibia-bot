'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', '..', 'minibia-desktop-agent.js'), 'utf8');

/** Poll until fn() is truthy (real timers; jsdom windows run node timers). */
async function waitFor(fn, { timeout = 5000, step = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * Fresh jsdom page with a mocked gameClient, the agent bundle evaluated.
 * `spells` seeds the combat rotation rules (userscript shape); health is
 * mutable through the returned gameClient.
 */
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
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 100 },
      spellbook: {
        cooldowns: { GLOBAL_COOLDOWN: { active: false }, 24: { active: false } },
        spells: { 24: { cost: 20 } },
      },
    },
    interface: {
      hotbarManager: {
        __handleClick: (slot) => { casts.push({ slot, at: Date.now() }); },
      },
    },
    mouse: { use: () => {} },
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  const surface = () => dom.window.__mbAgent || null;
  return { dom, casts, gameClient, surface };
}

/** Tear down the page: destroy the agent (stops its timers) and close. */
function teardown(dom) {
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch {
    /* teardown is best-effort */
  }
  dom.window.close();
}

/** Default slice-2 config: survival sample leaf + optional combat spells.
 *  armed:true is the REQ-02 gate extension (slice 3) — the agent refuses
 *  every action until an explicit armed push arrives. */
function seedConfig(overrides = {}) {
  return {
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: true, threshold: 50, slot: 1 },
    rotation: { spells: overrides.spells || [] },
    armed: true,
  };
}

test('2.5: bundle boots and exposes the REQ-04 __mbAgent surface', async () => {
  const { dom, surface } = makePage();
  try {
    assert.ok(await waitFor(() => surface() !== null), '__mbAgent exposed by the boot epilogue');
    const s = surface();
    for (const key of ['readStats', 'readCooldown', 'fireSlot', 'eatFood', 'getChat',
      'getRuneState', 'getWalkState', 'getPlayerInfo', 'applyConfig']) {
      assert.equal(typeof s[key], 'function', 'surface key ' + key + ' present (REQ-04)');
    }
    assert.equal(typeof dom.window.__mbAgentHandle, 'object', 'full handle exposed for tests/app control');
    // Slice-4 surfaces wired: the eat RPC is gated by the REQ-02 gate
    // (disarmed here -> refused), the rune state reports the real module.
    // (JSON-normalize: objects created in the jsdom realm carry a different
    // prototype, so deepStrictEqual would reject them.)
    assert.equal(JSON.stringify(s.eatFood()), JSON.stringify({ ok: false, reason: 'not connected' }),
      'eatFood RPC refused pre-arm (REQ-02 gate)');
    assert.equal(JSON.stringify(s.getRuneState()), JSON.stringify({ on: false, available: false, reason: 'off', lastFireAt: 0 }),
      'getRuneState reports the real rune module (REQ-15)');
    // Slice-6 forward contract: getWalkState now reports the real routes-v1
    // module — the mock has no world.pathfinder, so the honest degrade is
    // "no pathfinder data"; route recording stays FUTURE (REQ-23).
    const walkState = s.getWalkState();
    assert.equal(walkState.available, false, 'no pathfinder in the mock -> honest degrade (REQ-23)');
    assert.equal(walkState.reason, 'no pathfinder data');
    assert.equal(walkState.recording, 'future', 'route recording is FUTURE in v1 (REQ-23)');
    // walkTo RPC is gated by the REQ-02 gate (disarmed here -> refused).
    assert.equal(JSON.stringify(s.walkTo(100, 200)), JSON.stringify({ ok: false, reason: 'not connected' }),
      'walkTo RPC refused pre-arm (REQ-02 gate)');
  } finally {
    teardown(dom);
  }
});

test('2.5: readiness polling wires gameClient; reads flow through the surface', async () => {
  const { dom, surface } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true, 'wired once gameClient+hotbarManager exist');
    const s = surface();
    const stats = s.readStats();
    assert.equal(stats.mana, 100);
    assert.equal(stats.health, 100);
    assert.equal(stats.source, 'state');
    assert.equal(JSON.stringify(s.getPlayerInfo()), JSON.stringify({ name: 'Flamamex', vocationId: 4, vocationLabel: null }),
      'identity read; label resolves once __VOCATION_NAMES is live-probed (slice 1 contract)');
    assert.equal(s.getChat().length, 0);
    const cd = s.readCooldown(24);
    assert.equal(cd.cooldown.active, false);
  } finally {
    teardown(dom);
  }
});

test('2.5: low hp dispatches the survival heal through the QUEUE to __handleClick', async () => {
  const { dom, casts, gameClient, surface } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    surface().applyConfig(seedConfig());
    gameClient.player.state.health = 30; // <= threshold 50

    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 5000 }), true,
      'jittered ticker drives tree -> queue -> game handler');
    assert.equal(casts[0].slot, 1, 'heal fired via __handleClick(slot 1) (REQ-06 handler boundary)');

    const q = handle.getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'every action passed through the Action Queue (REQ-12)');
    assert.ok(q.pending <= 1, 'no unbounded backlog while the queue throttles');
    assert.equal(handle.getState().lastPath[0].id, 'priority-root', 'tree path recorded per tick');
  } finally {
    teardown(dom);
  }
});

test('2.5: the queue throttles consecutive dispatches — second heal no earlier than ~150ms (REQ-12)', async () => {
  const { dom, casts, gameClient, surface } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    surface().applyConfig(seedConfig());
    gameClient.player.state.health = 30;

    assert.equal(await waitFor(() => casts.length >= 2, { timeout: 8000 }), true,
      'health stays low -> the condition re-arms and a second heal dispatches');
    const gap = casts[1].at - casts[0].at;
    assert.ok(gap >= 150, 'global minimum interval enforced between ANY two actions (REQ-12); gap=' + gap + 'ms');
  } finally {
    teardown(dom);
  }
});

test('2.5: priority end-to-end — survival beats combat while hp is low (REQ-11)', async () => {
  const { dom, casts, gameClient, surface } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    surface().applyConfig(seedConfig({
      spells: [{ slot: 4, sid: 24, threshold: 0, reserve: 0, repeat: 999, cooldownMs: 0 }],
    }));

    // Healthy: survival condition false -> combat branch fires slot 4.
    assert.equal(await waitFor(() => casts.some((c) => c.slot === 4), { timeout: 5000 }), true,
      'combat leaf (rotation engine) fires while healthy');

    // HP drops: the NEXT fire must be the survival heal, not another combat cast.
    gameClient.player.state.health = 30;
    const before = casts.length;
    assert.equal(await waitFor(() => casts.length > before, { timeout: 5000 }), true);
    assert.equal(casts[casts.length - 1].slot, 1, 'survival beat combat in the same tick cadence (REQ-11)');
  } finally {
    teardown(dom);
  }
});

test('2.5: applyConfig toggles the survival leaf off — no heals fire', async () => {
  const { dom, casts, gameClient, surface } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    const cfg = seedConfig();
    cfg.survival.on = false;
    surface().applyConfig(cfg);
    gameClient.player.state.health = 10;

    await new Promise((r) => setTimeout(r, 800)); // several tick cadences elapse
    assert.equal(casts.length, 0, 'disabled survival leaf produces no actions');
    const res = surface().applyConfig(seedConfig());
    assert.equal(res.ok, true, 'applyConfig returns the normalized config');
    assert.equal(res.config.survival.threshold, 50);
  } finally {
    teardown(dom);
  }
});
