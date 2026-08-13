'use strict';

/**
 * Slice-4 wiring tests (REQ-13..17): each module -> tree -> queue ->
 * game-handler funnel against the REAL committed agent bundle, with a mocked
 * game client. Toggles honored (module OFF = zero actions), queue no-bypass
 * (handler calls happen only through dispatched queue closures), and the
 * REQ-04 surface (getRuneState / eatFood) wired to the real modules.
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
 * Wait until `count` fresh tree ticks have been observed (de-flake, obs
 * 10502). tickOnce() reassigns state.lastPath to a NEW array on every tick
 * (tree.tick builds a fresh path per call), so a reference change proves a
 * tick ran — deterministic under parallel load, unlike a fixed sleep. Use
 * for "nothing happens" assertions: prove the tree actually ticked N times,
 * THEN assert the counters.
 */
async function waitTicks(handle, count = 3, { timeout = 5000 } = {}) {
  let last = handle.getState().lastPath;
  let seen = 0;
  const start = Date.now();
  for (;;) {
    const cur = handle.getState().lastPath;
    if (cur !== last) { seen += 1; last = cur; }
    if (seen >= count) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Fresh jsdom page with a rich mocked gameClient carrying the live-probed
 * surface (obs 10320): __handleClick, __useItemOnSelf, __canPlayerCastSpell,
 * __runeAttackUntil/__runeHealUntil, interface.getSpell, container sources.
 */
function makePage() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const casts = [];     // hotbarManager.__handleClick
  const selfUses = [];  // hotbarManager.__useItemOnSelf
  const uses = [];      // gameClient.mouse.use
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 100 },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false }, 61: { active: false } }, spells: {} },
      conditions: null, // settable per test
    },
    interface: {
      getSpell: (sid) => ({ 61: { cost: 20 }, 50: { cost: 25 } }[sid] || null),
      hotbarManager: {
        // Trainer now verifies the live SID -> F-slot mapping and requires
        // observable mana consumption before treating a cast as accepted.
        // Keep this shared client realistic so wiring tests exercise the
        // actual confirmation flow rather than a click-only mock.
        slots: [{}, { spell: { sid: 61 } }, {}, {}, {}, {}, { spell: { sid: 50 } }],
        __handleClick: (index) => {
          const slot = index + 1; // real client: __handleClick is 0-based
          casts.push({ slot, at: Date.now() });
          const sid = slot === 2 ? 61 : slot === 7 ? 50 : null;
          const spell = sid === null ? null : ({ 61: { cost: 20 }, 50: { cost: 25 } }[sid] || null);
          if (spell) gameClient.player.state.mana -= spell.cost;
        },
        __useItemOnSelf: (args) => selfUses.push(args),
        __canPlayerCastSpell: () => true,
        __runeAttackUntil: null,
        __runeHealUntil: null,
      },
    },
    backpack: { slots: [] },
    mouse: { use: (args) => uses.push(args) },
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  return { dom, casts, selfUses, uses, gameClient };
}

function teardown(dom) {
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch { /* best-effort */ }
  dom.window.close();
}

/** Full slice-4 config: everything OFF except what the test turns on. */
function moduleConfig(overrides = {}) {
  return Object.assign({
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: false, threshold: 50, slot: null },
    rotation: { spells: [] },
    healItems: { on: false, threshold: 50, slotCids: [] },
    healMagic: { on: false, threshold: 150, slot: 2, sid: 61 },
    runes: { on: false, attackSlot: 4, healSlot: null, healThreshold: null },
    training: { on: false, slot: 7, sid: 50, reserve: 0 },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    armed: true,
  }, overrides);
}

test('REQ-13: heal-items module -> tree -> queue -> __useItemOnSelf (selfUses); OFF = zero', async () => {
  const { dom, casts, selfUses, uses, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    gameClient.backpack.slots = [{ index: 3, cid: 100 }];
    dom.window.__mbAgent.applyConfig(moduleConfig({ healItems: { on: true, threshold: 50, slotCids: [100] } }));
    gameClient.player.state.health = 30;

    assert.equal(await waitFor(() => selfUses.length >= 1, { timeout: 6000 }), true,
      'low hp + potion -> use-on-self action fires');
    assert.deepEqual(JSON.parse(JSON.stringify(selfUses[0])), { which: 0, index: 3 },
      'probed __useItemOnSelf receives the found slot (JSON-normalized: jsdom realm)');
    assert.equal(uses.length, 0, 'primary path used, no mouse.use fallback');
    assert.equal(casts.length, 0, 'no hotbar cast from the heal-items path');

    const q = handle.getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'every heal action passed the queue (REQ-12 no-bypass)');

    // OFF toggle: zero actions.
    dom.window.__mbAgent.applyConfig(moduleConfig({ healItems: { on: false, threshold: 50, slotCids: [100] } }));
    gameClient.player.state.health = 5;
    const before = selfUses.length;
    assert.equal(await waitTicks(handle, 3), true, 'the tree ticks while the module is OFF');
    assert.equal(selfUses.length, before, 'module OFF -> zero actions (REQ-13 toggle)');
  } finally {
    teardown(dom);
  }
});

test('REQ-13: heal-items with no potion in the container -> zero actions', async () => {
  const { dom, selfUses } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    gameClientSlotless(dom.window.gameClient);
    dom.window.__mbAgent.applyConfig(moduleConfig({ healItems: { on: true, threshold: 50, slotCids: [100] } }));
    dom.window.gameClient.player.state.health = 10;
    assert.equal(await waitTicks(handle, 3), true, 'the tree ticks while no potion is present');
    assert.equal(selfUses.length, 0, 'no item found -> no action (safe degrade)');
  } finally {
    teardown(dom);
  }
});

function gameClientSlotless(gc) {
  gc.backpack.slots = [{ index: 1, cid: 999 }]; // wrong cid
}

test('REQ-14: heal-magic module -> tree -> queue -> __handleClick; GLOBAL_COOLDOWN defers', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(moduleConfig({ healMagic: { on: true, threshold: 150, slot: 2, sid: 61 } }));
    gameClient.player.state.health = 120;

    assert.equal(await waitFor(() => casts.some((c) => c.slot === 2), { timeout: 6000 }), true,
      'low hp + mana -> heal slot fires via __handleClick (REQ-14)');

    // GLOBAL_COOLDOWN active -> the next heal defers to a later tick.
    gameClient.player.spellbook.cooldowns.GLOBAL_COOLDOWN = { active: true, seconds: 3 };
    gameClient.player.state.health = 5;
    const before = casts.filter((c) => c.slot === 2).length;
    assert.equal(await waitTicks(handle, 3), true, 'the tree ticks while GLOBAL_COOLDOWN is active');
    assert.equal(casts.filter((c) => c.slot === 2).length, before, 'GLOBAL_COOLDOWN defers the heal (REQ-14)');

    gameClient.player.spellbook.cooldowns.GLOBAL_COOLDOWN = { active: false };
    assert.equal(await waitFor(() => casts.filter((c) => c.slot === 2).length > before, { timeout: 6000 }), true,
      'cooldown clear -> heal fires again');
  } finally {
    teardown(dom);
  }
});

test('REQ-14: heal-magic OFF and mana-starved -> zero actions', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(moduleConfig({ healMagic: { on: false, threshold: 150, slot: 2, sid: 61 } }));
    gameClient.player.state.health = 1;
    gameClient.player.state.mana = 5; // below the 20 cost anyway
    assert.equal(await waitTicks(handle, 3), true, 'the tree ticks while the heal module is OFF');
    assert.equal(casts.length, 0, 'module OFF -> zero actions (REQ-14 toggle)');
  } finally {
    teardown(dom);
  }
});

test('REQ-15: runes fire on expiry via __handleClick; active window defers; absent timers degrade', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    const hb = gameClient.interface.hotbarManager;
    dom.window.__mbAgent.applyConfig(moduleConfig({ runes: { on: true, attackSlot: 4, healSlot: null, healThreshold: null } }));

    // Native window ACTIVE -> defer, no double-fire.
    hb.__runeAttackUntil = Date.now() + 10000;
    assert.equal(await waitTicks(handle, 3), true, 'the tree ticks while the native window is active');
    assert.equal(casts.filter((c) => c.slot === 4).length, 0, 'native window active -> deferred (REQ-15)');

    // Window expired -> fire on the rune slot.
    hb.__runeAttackUntil = Date.now() - 100;
    assert.equal(await waitFor(() => casts.some((c) => c.slot === 4), { timeout: 6000 }), true,
      'expired window -> rune action enqueued via __handleClick (REQ-15)');

    // Feature absent -> degrade, NEVER fires (design D7, no fallback loop).
    delete hb.__runeAttackUntil;
    delete hb.__runeHealUntil;
    const before = casts.length;
    assert.equal(await waitTicks(handle, 3), true, 'the tree ticks while the rune data is absent');
    assert.equal(casts.length, before, 'no native rune data -> never fires');
    const st = handle.getState().modules.runes;
    assert.equal(st.available, false, 'degrade recorded in module state');
    assert.equal(st.reason, 'no native rune data');
    assert.equal(dom.window.__mbAgent.getRuneState().reason, 'no native rune data', 'surface exposes the degrade');
  } finally {
    teardown(dom);
  }
});

test('REQ-15: rune heal fires only while health <= healThreshold', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    const hb = gameClient.interface.hotbarManager;
    hb.__runeAttackUntil = Date.now() - 100;
    hb.__runeHealUntil = Date.now() - 100;
    dom.window.__mbAgent.applyConfig(moduleConfig({
      runes: { on: true, attackSlot: 4, healSlot: 3, healThreshold: 40 },
    }));

    gameClient.player.state.health = 30;
    assert.equal(await waitFor(() => casts.some((c) => c.slot === 3), { timeout: 6000 }), true,
      'low hp -> heal rune fires first');
    assert.equal(casts.some((c) => c.slot === 4), false, 'no attack rune while the heal rune is pending');

    gameClient.player.state.health = 80;
    assert.equal(await waitFor(() => casts.some((c) => c.slot === 4), { timeout: 6000 }), true,
      'healthy -> attack rune cycles');
  } finally {
    teardown(dom);
  }
});

test('REQ-16: training casts at queue cadence; pauses below cost+reserve', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(moduleConfig({ training: { on: true, slot: 7, sid: 50, reserve: 0 } }));

    assert.equal(await waitFor(() => casts.filter((c) => c.slot === 7).length >= 2, { timeout: 8000 }), true,
      'repeat casts while the vocation gate passes (REQ-16)');
    // Cadence: every cast went through the queue one at a time. The strict
    // >=150ms spacing is proven in test/core/queue.test.js (fake clock) and
    // test/agent/bootstrap.test.js (real timers); fire-slot scheduling makes
    // a wall-clock gap assertion here flaky under parallel CPU load.
    const q = handle.getState().queue;
    assert.ok(q.enqueued >= 2 && q.dispatched >= 2, 'repeat casts dispatched through the queue (REQ-12)');
    assert.ok(q.pending <= 1, 'no unbounded backlog while the queue throttles');

    // Pause below cost+reserve: cost 25, reserve 90 -> needs mana >= 115.
    gameClient.player.state.mana = 100;
    dom.window.__mbAgent.applyConfig(moduleConfig({ training: { on: true, slot: 7, sid: 50, reserve: 90 } }));
    const before = casts.filter((c) => c.slot === 7).length;
    assert.equal(await waitTicks(handle, 3), true, 'the tree ticks while the reserve gate holds');
    assert.equal(casts.filter((c) => c.slot === 7).length, before, 'below cost+reserve -> training pauses (REQ-16)');
  } finally {
    teardown(dom);
  }
});

test('REQ-17: eat every-N-casts — training casts advance the counter and the forced eat lands even while SATED', async () => {
  const { dom, casts, uses, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    gameClient.player.conditions = { has: (k) => k === 'SATED' }; // SATED true always

    dom.window.__mbAgent.applyConfig(moduleConfig({
      training: { on: true, slot: 7, sid: 50, reserve: 0 },
      eat: { on: true, everyCasts: 2, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    }));

    // Two training casts -> castsSinceFood reaches 2 -> forced eat (SATED pre-check skipped).
    assert.equal(await waitFor(() => casts.filter((c) => c.slot === 7).length >= 2, { timeout: 8000 }), true);
    assert.equal(await waitFor(() => uses.length >= 1, { timeout: 6000 }), true,
      'forced eat lands via mouse.use even though SATED is true (REQ-17 everyCasts)');
  } finally {
    teardown(dom);
  }
});

test('REQ-17: eat OFF + SATED false -> zero eat actions', async () => {
  const { dom, uses, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    gameClient.player.conditions = { has: () => false }; // hungry
    dom.window.__mbAgent.applyConfig(moduleConfig({ eat: { on: false } }));
    assert.equal(await waitTicks(handle, 3), true, 'the tree ticks while the eat module is OFF');
    assert.equal(uses.length, 0, 'eat module OFF -> zero actions (REQ-17 toggle)');
  } finally {
    teardown(dom);
  }
});

test('REQ-17 (PR5 regression): NORMAL hunger (SATED false) enqueues an eat action through the Action Queue', async () => {
  const { dom, uses, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    gameClient.player.conditions = { has: (k) => k === 'SATED' && false }; // hungry
    dom.window.__mbAgent.applyConfig(moduleConfig({
      eat: { on: true, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    }));
    // Normal food path (no forced cadence): the hunger flag drives the eat
    // decision -> queue-dispatched attempt -> mouse.use fallback lands.
    assert.equal(await waitFor(() => uses.length >= 1, { timeout: 6000 }), true,
      'hunger eat attempt lands via mouse.use (REQ-17 normal food enqueue)');
    const q = handle.getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'the eat action passed the queue (REQ-12 no-bypass)');
  } finally {
    teardown(dom);
  }
});

test('REQ-11: survival priority — heal-magic beats training in the same tick cadence', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig(moduleConfig({
      healMagic: { on: true, threshold: 150, slot: 2, sid: 61 },
      training: { on: true, slot: 7, sid: 50, reserve: 0 },
    }));

    gameClient.player.state.health = 40; // below healMagic threshold, mana ample
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 8000 }), true,
      'low hp -> heal branch runs (REQ-11 survival first)');
    // The FIRST cast is deterministically the heal: the urgent head-insert
    // puts it ahead of any pending normal entry and the drain breaks at the
    // first not-due entry, so nothing can dispatch before it.
    assert.equal(casts[0].slot, 2, 'the FIRST cast is the heal — same-tick priority over training (REQ-11)');
    // The queue DEFERS, never drops (REQ-12): while hp stays low the heal
    // re-arms each queue cycle and the deferred training entry dispatches
    // AFTER it — the heal always stays ahead. (De-flake, obs 10502: the old
    // "training NEVER fires" assertion contradicted this defer-never-drop
    // semantics and raced the deferred dispatch under load — a delayed drain
    // dispatching both entries made slot 7 visible at the check.)
    assert.equal(await waitTicks(handle, 3), true, 'the cadence continues while hp is low');
    const firstTraining = casts.findIndex((c) => c.slot === 7);
    assert.ok(firstTraining === -1 || firstTraining > 0,
      'training only ever fires AFTER the heal (deferred, never preemptive)');
  } finally {
    teardown(dom);
  }
});

test('REQ-04/15: surface getRuneState reports the real module; eatFood RPC is gated + queued', async () => {
  const { dom, uses, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    const surface = dom.window.__mbAgent;

    // Disarmed -> both RPCs refused.
    assert.deepEqual(JSON.parse(JSON.stringify(surface.eatFood())), { ok: false, reason: 'not connected' });

    dom.window.__mbAgent.applyConfig(moduleConfig({
      healItems: { on: true, threshold: 50, slotCids: [100] },
      runes: { on: true, attackSlot: 4, healSlot: null, healThreshold: null },
      eat: { on: true, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    }));
    gameClient.backpack.slots = [{ index: 3, cid: 100 }];

    // getRuneState -> real module state (not the slice-2 null stub).
    const rs = surface.getRuneState();
    assert.equal(rs.on, true);
    assert.equal(rs.available, true);

    // eatFood RPC -> queued (no-bypass), and the attempt lands via mouse.use.
    assert.deepEqual(JSON.parse(JSON.stringify(surface.eatFood())), { result: 'queued' });
    assert.equal(await waitFor(() => uses.length >= 1, { timeout: 6000 }), true,
      'RPC eat attempt dispatched through the queue');
  } finally {
    teardown(dom);
  }
});
