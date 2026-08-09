'use strict';

/**
 * PR 3 — HEAL interrupt end-to-end tests (REQ-29, REQ-14 MODIFIED, D1).
 *
 * The committed bundle is evaluated in jsdom with a mocked gameClient whose
 * spellbook resolves the heal spell cost (sid 61 -> 20 mana) and whose
 * hotbarManager records __handleClick casts. The tree runs on real jittered
 * timers (the repo's proven harness); assertions are ORDER-deterministic —
 * the urgent heal is guaranteed to dispatch before the pinned-jitter rune
 * entry (heal jitter 50-400ms vs rune pinned 600ms), so the interrupt
 * scenario never races.
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
 * Fresh jsdom page with a mocked gameClient that resolves the heal spell:
 * spellbook.spells[61] = {cost: 20}, clear cooldowns, live vocation gate.
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
        cooldowns: { GLOBAL_COOLDOWN: { active: false, seconds: 0 }, 61: { active: false, seconds: 0 } },
        spells: { 61: { cost: 20 } },
      },
    },
    interface: {
      hotbarManager: {
        __handleClick: (slot) => { casts.push({ slot, at: Date.now(), rune: false }); },
        __canPlayerCastSpell: () => true,
      },
    },
    mouse: { use: () => {} },
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

/** PR3 config: healMagic ON (slot 2, sid 61, threshold 50 HP), everything
 *  else OFF unless overridden. armed:true is the REQ-02 gate. */
function healConfig(overrides = {}) {
  return Object.assign({
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: false, threshold: 50, slot: null },
    rotation: { spells: [] },
    healItems: { on: false, threshold: 50, slotCids: [] },
    healMagic: { on: true, threshold: 50, slot: 2, sid: 61, reserve: 0, word: null },
    runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null },
    training: { on: false, slot: null, sid: null, reserve: 0, word: null },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    armed: true,
  }, overrides);
}

test('REQ-29: hp <= threshold with mana and clear cooldowns -> heal slot fires via __handleClick', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    surface().applyConfig(healConfig());
    gameClient.player.state.health = 30; // 30% of maxHealth 100 <= threshold 50

    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true,
      'jittered ticker drives tree -> queue -> game handler');
    assert.equal(casts[0].slot, 2, 'heal fired via __handleClick(slot 2) (REQ-06 boundary)');
    const q = handle().getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'every action passed through the Action Queue (REQ-12)');
  } finally {
    teardown(dom);
  }
});

test('REQ-29: heal INTERRUPTS in-flight rune work — urgent jumps, rune defers (spec scenario 1)', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    surface().applyConfig(healConfig());
    gameClient.player.state.health = 30; // hp 30% < threshold 50%

    // Simulate rune-making IN FLIGHT: a rune-work entry already queued with
    // a pinned 600ms jitter (fireAt enqueue+600). The urgent heal (jitter
    // 50-400ms from the tick where hp is low) is ALWAYS due first.
    handle().getQueue().enqueue(() => { casts.push({ slot: 7, rune: true }); },
      { kind: 'rune-work', jitterMs: 600 });

    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true);
    assert.equal(casts[0].slot, 2, 'the HEAL fires first — it preempts the in-flight rune work');
    assert.ok(!casts.some((c) => c.rune === true), 'rune work not dispatched yet');
    assert.ok(handle().getState().queue.pending >= 1, 'rune work still PENDING (deferred, never dropped)');

    // While hp stays below the threshold the heal keeps re-arming and the
    // rune work stays deferred (never dropped). Once hp recovers the heal
    // stops and the deferred work resumes on a LATER drain.
    gameClient.player.state.health = 100;
    assert.equal(await waitFor(() => casts.some((c) => c.rune === true), { timeout: 4000 }), true,
      'rune work fires on a LATER drain — deferred to a later tick, not cancelled');
    const runeIdx = casts.findIndex((c) => c.rune === true);
    assert.ok(runeIdx > 0, 'rune work fired AFTER the heal');
    assert.equal(casts[runeIdx].slot, 7);
  } finally {
    teardown(dom);
  }
});

test('REQ-29: GLOBAL_COOLDOWN active -> the heal defers a tick, no bypass (spec scenario 2)', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    surface().applyConfig(healConfig());
    gameClient.player.state.health = 30;
    gameClient.player.spellbook.cooldowns.GLOBAL_COOLDOWN.active = true;

    await new Promise((r) => setTimeout(r, 600)); // several tick cadences elapse
    assert.equal(casts.length, 0, 'heal due but GLOBAL_COOLDOWN active -> deferred, NEVER bypassed');

    gameClient.player.spellbook.cooldowns.GLOBAL_COOLDOWN.active = false;
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true,
      'once the cooldown clears, the next tick fires the heal');
    assert.equal(casts[0].slot, 2);
  } finally {
    teardown(dom);
  }
});

test('REQ-29: heal OFF -> hp below threshold produces NO heal action (spec scenario 3)', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    const cfg = healConfig();
    cfg.healMagic.on = false;
    surface().applyConfig(cfg);
    gameClient.player.state.health = 10;

    await new Promise((r) => setTimeout(r, 600)); // several tick cadences elapse
    assert.equal(casts.length, 0, 'heal OFF -> nothing fires, regardless of hp');
  } finally {
    teardown(dom);
  }
});

test('REQ-14 MODIFIED: the heal branch evaluates BEFORE runes — hp drop preempts rune fire', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    // Runes ON with an EXPIRED native attack window: the rune branch WOULD
    // fire slot 7 on its own (mock exposes __runeAttackUntil).
    gameClient.interface.hotbarManager.__runeAttackUntil = Date.now() - 1000;
    surface().applyConfig(healConfig({
      runes: { on: true, attackSlot: 7, healSlot: null, healThreshold: null },
    }));

    // Healthy: heal condition fails -> the tree reaches the runes branch.
    assert.equal(await waitFor(() => casts.some((c) => c.slot === 7), { timeout: 4000 }), true,
      'rune attack fires while hp is healthy (tree order: heal first, then runes)');

    // HP drops: the NEXT action enqueued is the heal (tree priority), and
    // the urgent entry jumps any pending rune work.
    const before = casts.length;
    gameClient.player.state.health = 30;
    assert.equal(await waitFor(() => casts.length > before, { timeout: 4000 }), true);
    assert.equal(casts[casts.length - 1].slot, 2, 'the heal preempts the rune after the hp drop');
  } finally {
    teardown(dom);
  }
});

test('REQ-31/D2: hp low but mana below cost + reserve -> heal pauses (e2e reserve gate)', async () => {
  const { dom, casts, gameClient, surface, handle } = makePage();
  try {
    assert.equal(await waitFor(() => handle().isReady()), true);
    const cfg = healConfig();
    cfg.healMagic.reserve = 90; // needs mana >= 20 + 90 = 110; mock has 100
    surface().applyConfig(cfg);
    gameClient.player.state.health = 30;

    await new Promise((r) => setTimeout(r, 600));
    assert.equal(casts.length, 0, 'heal due but mana < cost + reserve -> pauses until mana recovers');

    gameClient.player.state.mana = 110;
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true,
      'once mana >= cost + reserve, the heal fires');
    assert.equal(casts[0].slot, 2);
  } finally {
    teardown(dom);
  }
});
