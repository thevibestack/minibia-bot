'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', '..', 'minibia-desktop-agent.js'), 'utf8');

function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started >= timeout) { clearInterval(timer); resolve(false); }
    }, 10);
  });
}

function page(overrides = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://minibia.com/play', runScripts: 'dangerously' });
  const clicks = [];
  const backpack = { slots: [{ index: 1, cid: 42, count: 1 }] };
  const player = {
    name: 'Flamamex', vocation: 4,
    state: { mana: 240, maxMana: 270, health: 215, maxHealth: 215 },
    spellbook: { spells: { 35: { cost: 210 }, 24: { cost: 30 } }, cooldowns: { GLOBAL_COOLDOWN: { active: false }, 35: { active: false }, 24: { active: false } } },
  };
  const hotbarManager = {
    slots: [{}, {}, { spell: { sid: 35 } }, { spell: { sid: 24 } }],
    __canPlayerCastSpell: () => true,
    __handleClick(index) {
      const slot = index + 1; // real client: __handleClick is 0-based
      clicks.push(slot);
      if (slot === 3) player.state.mana -= 210;
      if (slot === 4) {
        player.state.mana -= 30;
        // The creation is NOT guaranteed: some pages never materialize the
        // item (REQ-03 timeout scenario is driven by overrides.createFoodOnPan).
        if (overrides.createFoodOnPan !== false) backpack.slots.push({ index: 2, cid: 777, count: 1 });
      }
    },
    __useItemOnSelf({ index }) {
      const item = backpack.slots.find((slot) => slot.index === index);
      if (item) item.cid = null;
    },
  };
  dom.window.gameClient = { player, backpack, interface: { hotbarManager }, mouse: { use() {} } };
  dom.window.eval(BUNDLE);
  return { dom, clicks };
}

function destroy(dom) {
  const handle = dom.window.__mbAgentHandle;
  if (handle && typeof handle.destroy === 'function') handle.destroy();
  dom.window.close();
}

test('PR 3: bundled agent runs the full eat-driven magic-food loop — eat requests, machine confirms, created slot consumed (REQ-02/05)', async () => {
  const { dom, clicks } = page();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    // Unified shape (PR 3): the eat module owns the food decision; the
    // confirmation machine lives in the trainer and consumes the CREATED
    // slot (dynamic discovery, REQ-02), never a typed one.
    dom.window.__mbAgent.applyConfig({
      queue: { minIntervalMs: 10 }, jitter: { min: 5, max: 5 }, armed: true,
      survival: { on: false }, healItems: { on: false }, manaItems: { on: false }, healMagic: { on: false },
      runes: { on: false, capMode: 'off' }, rotation: { spells: [] },
      eat: { on: true, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [],
        safetyNetMinutes: 20, magic: { enabled: true, slot: 4, sid: 24 } },
      training: { on: true, slot: 3, sid: 35, reserve: 30 },
    });
    const completed = await waitFor(() => handle.getState().modules.training.lastReason === 'created-food-consumed');
    assert.equal(completed, true, JSON.stringify({ clicks, training: handle.getState().modules.training }));
    assert.deepEqual(clicks.slice(0, 2), [3, 4], 'HMM then the pan F-slot — the eat decision drove the pan');
    assert.equal(handle.getState().modules.training.successfulRuneCreations, 1);
    const eatSt = handle.getState().modules.eat;
    assert.equal(eatSt.foodCreated, 1, 'Comida counter from the confirmed consumption');
    assert.equal(eatSt.source, 'magic', 'the meal source is magic, not normal');
    assert.ok(eatSt.lastEatAt > 0, 'meal anchored for the safety net');
    assert.equal(eatSt.magicSid, 24, 'live hotbar resolved the pan sid');
  } finally {
    destroy(dom);
  }
});

test('PR 3 (REQ-03): eat magic fails to create -> machine block -> cycle resets for the NORMAL fallback path', async () => {
  const { dom, clicks } = page({ createFoodOnPan: false }); // the pan never materializes the item
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    // Pan configured but the game NEVER creates the item: the creation
    // window expires -> the food node resets the cycle and notes magic
    // unavailable -> the normal path is ready to serve the fallback.
    dom.window.__mbAgent.applyConfig({
      queue: { minIntervalMs: 10 }, jitter: { min: 5, max: 5 }, armed: true,
      survival: { on: false }, healItems: { on: false }, manaItems: { on: false }, healMagic: { on: false },
      runes: { on: false, capMode: 'off' }, rotation: { spells: [] },
      eat: { on: true, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [],
        safetyNetMinutes: 20, magic: { enabled: true, slot: 4, sid: 24 } },
      training: { on: true, slot: 3, sid: 35, reserve: 30 },
    });
    // The pan fires once...
    assert.equal(await waitFor(() => clicks.includes(4), 8000), true);
    const panCasts = () => clicks.filter((c) => c === 4).length;
    // ...then the creation window (4s) expires: the block + cycle reset are
    // atomic within one tick, so assert the STABLE post-reset state.
    await new Promise((r) => setTimeout(r, 6000));
    const st = handle.getState().modules.training;
    assert.equal(st.foodCycle, 'idle', 'cycle reset after the block (resetFoodCycle)');
    assert.equal(st.blockedReason, null, 'food block cleared');
    assert.equal(st.pendingAction, null, 'no stale machine action');
    assert.equal(handle.getState().modules.eat.on, true, 'eat stays on for the normal fallback');
    assert.equal(panCasts(), 1, 'no pan re-cast while magic is unavailable (retry window)');
  } finally {
    destroy(dom);
  }
});
