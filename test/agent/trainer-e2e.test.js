'use strict';

/**
 * PR 4 — TRAINER end-to-end tests (REQ-30/31/32, D2/D3/D4).
 *
 * The committed bundle is evaluated in jsdom with a mocked gameClient whose
 * spellbook resolves the training spell cost (sid 7 -> 200 mana), whose
 * player.state carries the probed rune-cap fields (__state.capacity /
 * maxCapacity), and whose hotbarManager records __handleClick casts. The
 * tree runs on real jittered timers (the repo's proven harness); assertions
 * are count/order-deterministic (x casts over a fixed window, then the
 * state flips and a cast appears).
 */

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
 * Fresh jsdom page with a mocked gameClient: the training spell resolves at
 * cost 200, cooldowns are clear, the vocation gate passes, and the rune cap
 * fields (__state.capacity / maxCapacity) read from `cap` (mutable).
 */
function makePage(overrides = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const casts = [];
  const cap = { capacity: 200, maxCapacity: 400 }; // ratio 0.5 — not full
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 400, maxMana: 500, health: 100, maxHealth: 100, __state: { capacity: cap.capacity }, maxCapacity: cap.maxCapacity },
      spellbook: {
        cooldowns: { GLOBAL_COOLDOWN: { active: false, seconds: 0 }, 7: { active: false, seconds: 0 }, 12: { active: false, seconds: 0 } },
        spells: { 7: { cost: 200 }, 12: { cost: 30 } },
      },
    },
    interface: {
      hotbarManager: {
        // The Trainer verifies the current live SID mapping and confirms a
        // cast from observable mana loss. Model the same live contract here.
        slots: [{}, {}, { spell: { sid: 7 } }, {}, { spell: { sid: 12 } }, {}, { spell: { sid: 7 } }],
        __handleClick: (slot) => {
          casts.push({ slot, at: Date.now() });
          const sid = slot === 5 ? 12 : (slot === 3 || slot === 7 ? 7 : null);
          if (sid !== null) gameClient.player.state.mana -= gameClient.player.spellbook.spells[sid].cost;
        },
        __canPlayerCastSpell: () => true,
      },
    },
    mouse: { use: () => {} },
  };
  // Mutable cap: the tests flip player.state fields directly.
  gameClient.setCap = (capacity, maxCapacity) => {
    cap.capacity = capacity;
    cap.maxCapacity = maxCapacity;
    gameClient.player.state.__state.capacity = capacity;
    gameClient.player.state.maxCapacity = maxCapacity;
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  return { dom, casts, gameClient, surface: () => dom.window.__mbAgent, handle: () => dom.window.__mbAgentHandle };
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

/** PR4 config: training ON (slot 7, sid 7, cost 200, reserve 30), strict rune
 *  CAP with a fallback slot, everything else OFF unless overridden. */
function trainerConfig(overrides = {}) {
  return Object.assign({
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: false, threshold: 50, slot: null },
    rotation: { spells: [] },
    healItems: { on: false, threshold: 50, slotCids: [] },
    healMagic: { on: false, threshold: 150, slot: null, sid: null, reserve: 0, word: null },
    runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null, reserve: 0,
      capMode: 'strict', capFullThreshold: 1.0, fallbackSlot: 3, fallbackSid: 7, fallbackManaPct: 0.5 },
    training: { on: true, slot: 7, sid: 7, reserve: 30, word: null,
      eatWithMagic: { enabled: false, slot: null, sid: null } },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    armed: true,
  }, overrides);
}

test('REQ-30: strict cap full + no fallback -> rune-making STOPS, capFull rides the snapshot', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    const cfg = trainerConfig();
    cfg.runes.fallbackSlot = null;
    surface().applyConfig(cfg);
    gameClient.setCap(400, 400); // ratio 1.0 -> cap full

    await new Promise((r) => setTimeout(r, 700)); // several tick cadences elapse
    assert.equal(casts.length, 0, 'cap full + strict -> no rune-making cast at all');
    const tr = handle().getState().modules.training;
    assert.equal(tr.capFull, true, 'module state capFull flows through getState -> snapshot');
    assert.equal(tr.cap.ratio, 1);
  } finally {
    teardown(dom);
  }
});

test('REQ-30: cap full + fallback + mana >= fallback% -> the fallback slot casts instead', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    surface().applyConfig(trainerConfig());
    gameClient.setCap(400, 400);            // cap full
    gameClient.player.state.mana = 400;     // 80% >= fallback 50%

    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true);
    assert.equal(casts[0].slot, 3, 'fallback slot fires — NOT the rune-making slot 7');
    assert.equal(handle().getState().modules.training.capFull, true);
  } finally {
    teardown(dom);
  }
});

test('REQ-30: cap full + mana < fallback% -> the trainer idles until mana recovers', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    surface().applyConfig(trainerConfig());
    gameClient.setCap(400, 400);            // cap full
    gameClient.player.state.mana = 200;     // 40% < fallback 50%

    await new Promise((r) => setTimeout(r, 700));
    assert.equal(casts.length, 0, 'idle: neither training nor fallback casts');

    gameClient.player.state.mana = 400;     // mana recovers -> fallback fires
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true);
    assert.equal(casts[0].slot, 3);
  } finally {
    teardown(dom);
  }
});

test('REQ-31: mana below cost + reserve (200+30=230) -> no cast; at 230 the training cast fires', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    surface().applyConfig(trainerConfig());
    gameClient.player.state.mana = 210; // 210 < 230 (spec scenario: waits until >= 230)

    await new Promise((r) => setTimeout(r, 700));
    assert.equal(casts.length, 0, 'mana 210 < cost 200 + reserve 30 -> trainer waits (REQ-31)');

    gameClient.player.state.mana = 230;
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true);
    assert.equal(casts[0].slot, 7, 'training cast fires via __handleClick once mana >= 230');
  } finally {
    teardown(dom);
  }
});

test('REQ-32: mana low waits even when magic food is configured; food is cadence-driven after runes', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    const cfg = trainerConfig();
    cfg.training.eatWithMagic = { enabled: true, slot: 5, sid: 12 };
    surface().applyConfig(cfg);
    gameClient.player.state.mana = 210; // below cost+reserve

    await new Promise((r) => setTimeout(r, 700));
    assert.equal(casts.length, 0, 'low mana waits; food magic is never an automatic low-mana fallback');
    assert.equal(handle().getState().modules.training.waitingForMana, true);

    gameClient.player.state.mana = 230;
    assert.equal(await waitFor(() => casts.some((c) => c.slot === 7), { timeout: 4000 }), true,
      'the persisted trainer fires automatically once mana reaches cost + reserve');
  } finally {
    teardown(dom);
  }
});
