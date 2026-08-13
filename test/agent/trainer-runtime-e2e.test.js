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

function page() {
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
        backpack.slots.push({ index: 2, cid: 777, count: 1 });
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

test('PR 3 (REQ-06): the trainer confirms runes but NO LONGER arms food magic — the eat request is decoupled (T9 wires it)', async () => {
  const { dom, clicks } = page();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    // PR 3 unified shape: the legacy training.eatWithMagic is gone; the food
    // magic config rides modules.eat.magic (injected foodMagicConfig, T8).
    dom.window.__mbAgent.applyConfig({
      queue: { minIntervalMs: 10 }, jitter: { min: 5, max: 5 }, armed: true,
      survival: { on: false }, healItems: { on: false }, manaItems: { on: false }, healMagic: { on: false },
      runes: { on: false, capMode: 'off' }, rotation: { spells: [] },
      eat: { on: true, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [],
        safetyNetMinutes: 20, magic: { enabled: true, slot: 4, sid: 24 } },
      training: { on: true, slot: 3, sid: 35, reserve: 30 },
    });
    // The trainer casts HMM (slot 3)...
    assert.equal(await waitFor(() => clicks.includes(3)), true);
    // ...but the everyRunes coupling is GONE: food magic stays dormant until
    // the EAT module requests it (the bootstrap food node lands in T9).
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(clicks, [3], 'no food cast without an eat request (REQ-06 decoupling)');
    assert.equal(handle.getState().modules.training.foodMagicPending, false);
  } finally {
    destroy(dom);
  }
});
