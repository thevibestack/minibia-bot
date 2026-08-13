'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTraining } = require('../../../src/agent/modules/training');

function harness(overrides = {}) {
  let clock = 1000;
  let slots = [{ which: 0, index: 1, cid: 42, count: 1 }];
  const hotbar = Object.assign({ 3: 35, 4: 24, 5: 88 }, overrides.hotbar || {});
  const clicks = [];
  const consumes = [];
  const config = Object.assign({
    on: true, slot: 3, sid: 35, reserve: 30,
  }, overrides.config || {});
  const m = createTraining({
    config,
    // PR 3 (REQ-01): the machine's food-magic config is INJECTED from the
    // unified modules.eat.magic — training never reads config.eatWithMagic.
    foodMagicConfig: () => (overrides.foodMagicConfig !== undefined
      ? overrides.foodMagicConfig : { enabled: true, slot: 4, sid: 24 }),
    capConfig: Object.assign({ capMode: 'off', capFullThreshold: 1, fallbackSlot: null, fallbackSid: null, fallbackManaPct: .5 }, overrides.capConfig || {}),
    readCap: overrides.readCap || (() => null),
    getSpellCost: overrides.getSpellCost || ((sidOrSlot) => ({ 35: 210, 24: 30, 5: 20 }[sidOrSlot] ?? null)),
    canCastSpell: () => true,
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: false } }),
    readHotbarSlotSid: (slot) => hotbar[slot] ?? null,
    readVisibleSlots: () => slots,
    consumeItem: (item) => { consumes.push(item); return true; },
    now: () => clock,
    actionConfirmationTimeoutMs: 1000,
    foodArrivalTimeoutMs: 1000,
  });
  const deps = { mana: null, gameClient: { interface: { hotbarManager: { __handleClick: (index) => clicks.push(index + 1) } } } };
  return {
    m, clicks, consumes, hotbar,
    slots: () => slots,
    setSlots: (next) => { slots = next; },
    advance: (ms) => { clock += ms; },
    fire: (decision, mana) => m.fire(decision, Object.assign({}, deps, { mana })),
  };
}

function confirmRune(h) {
  const rune = h.m.decide({ mana: 240, maxMana: 270 });
  assert.deepEqual({ fire: rune.fire, kind: rune.kind, slot: rune.slot, sid: rune.sid, cost: rune.cost },
    { fire: true, kind: 'training', slot: 3, sid: 35, cost: 210 });
  assert.equal(h.fire(rune, 240), true, 'handler invocation is dispatched once');
  assert.equal(h.m.decide({ mana: 30, maxMana: 270 }).reason, 'rune-cast-confirmed');
}

function invokeFood(h) {
  h.m.requestFoodMagic(); // PR 3: the request is explicit now (no everyRunes arming)
  const food = h.m.decide({ mana: 30, maxMana: 270 });
  assert.deepEqual({ fire: food.fire, kind: food.kind, slot: food.slot, sid: food.sid, cost: food.cost },
    { fire: true, kind: 'eat-magic', slot: 4, sid: 24, cost: 30 });
  assert.equal(h.fire(food, 30), true);
}

test('HMM 210 + reserve 30 waits at 96 and arms at 240 without save-time blocking', () => {
  const h = harness({ foodMagicConfig: { enabled: false, slot: null, sid: null } });
  assert.equal(h.m.decide({ mana: 96, maxMana: 270 }).reason, 'insufficient');
  assert.equal(h.m.getState().requiredMana, 240);
  assert.equal(h.m.decide({ mana: 240, maxMana: 270 }).kind, 'training');
});

test('handler invocation without mana effect does not count a rune or schedule/cast food', () => {
  const h = harness();
  const rune = h.m.decide({ mana: 240, maxMana: 270 });
  assert.equal(h.fire(rune, 240), true);
  assert.deepEqual(h.clicks, [3]);
  assert.equal(h.m.decide({ mana: 240, maxMana: 270 }).reason, 'waiting-rune-confirmation');
  assert.equal(h.m.getState().successfulRuneCreations, 0);
  h.advance(1000);
  assert.equal(h.m.decide({ mana: 240, maxMana: 270 }).reason, 'rune-cast-no-mana-effect');
  assert.equal(h.m.decide({ mana: 240, maxMana: 270 }).reason, 'rune-cast-no-mana-effect', 'failure blocks retry spin');
  assert.deepEqual(h.clicks, [3]);
});

test('stale or rerouted hotbar SID blocks before the handler is invoked', () => {
  const h = harness();
  h.hotbar[3] = 999;
  const rune = h.m.decide({ mana: 240, maxMana: 270 });
  assert.equal(h.fire(rune, 240), false);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.m.getState().blockedReason, 'stale-hotbar-slot-3-expected-sid-35');
});

test('fallback also requires the current F-key to still map to its configured SID', () => {
  const h = harness({
    capConfig: { capMode: 'strict', capFullThreshold: 1, fallbackSlot: 5, fallbackSid: 88, fallbackManaPct: .5 },
    readCap: () => ({ capacity: 1, maxCapacity: 1, ratio: 1 }),
  });
  const fallback = h.m.decide({ mana: 270, maxMana: 270 });
  assert.equal(fallback.kind, 'fallback');
  h.hotbar[5] = 12;
  assert.equal(h.fire(fallback, 270), false);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.m.getState().blockedReason, 'stale-hotbar-slot-5-expected-sid-88');
});

test('food with mana effect but no first-20-slot delta times out and never consumes an old item', () => {
  const h = harness();
  confirmRune(h);
  invokeFood(h);
  assert.equal(h.m.decide({ mana: 0, maxMana: 270 }).reason, 'waiting-created-food');
  h.advance(1000);
  assert.equal(h.m.decide({ mana: 0, maxMana: 270 }).reason, 'food-not-created-timeout');
  assert.deepEqual(h.consumes, []);
  assert.deepEqual(h.clicks, [3, 4]);
});

test('created food consumption is not confirmed by handler invocation alone', () => {
  const h = harness();
  confirmRune(h);
  invokeFood(h);
  h.setSlots([h.slots()[0], { which: 0, index: 2, cid: 777, count: 1 }]);
  assert.equal(h.m.decide({ mana: 0, maxMana: 270 }).reason, 'food-created-confirmed');
  const consume = h.m.decide({ mana: 0, maxMana: 270 });
  assert.equal(consume.kind, 'consume-created-food');
  assert.equal(h.fire(consume, 0), true);
  assert.equal(h.m.decide({ mana: 0, maxMana: 270 }).reason, 'waiting-created-food-consumption');
  h.advance(1000);
  assert.equal(h.m.decide({ mana: 0, maxMana: 270 }).reason, 'created-food-consume-not-confirmed');
  assert.equal(h.consumes.length, 1);
});

test('successful full MiniTibia loop confirms rune, food delta, and consumption before repeating', () => {
  const h = harness();
  confirmRune(h);
  invokeFood(h);
  h.setSlots([h.slots()[0], { which: 0, index: 2, cid: 777, count: 1 }]);
  assert.equal(h.m.decide({ mana: 0, maxMana: 270 }).reason, 'food-created-confirmed');
  const consume = h.m.decide({ mana: 0, maxMana: 270 });
  assert.equal(h.fire(consume, 0), true);
  h.setSlots([h.slots()[0], { which: 0, index: 2, cid: null, count: null }]);
  assert.equal(h.m.decide({ mana: 0, maxMana: 270 }).reason, 'created-food-consumed');
  assert.equal(h.m.getState().foodCycle, 'idle');
  assert.equal(h.m.getState().successfulRuneCreations, 1);
  assert.deepEqual(h.clicks, [3, 4]);
  assert.equal(h.consumes.length, 1);
});

/* ---------------------- PR 3 — thin food facade (REQ-01/02) ---------------------- */

test('facade (PR 3): requestFoodMagic arms the machine; foodStep returns the eat-magic decision', () => {
  const h = harness();
  assert.equal(h.m.foodStep({ mana: 30, maxMana: 270 }), null, 'no request -> machine stays quiet');
  h.m.requestFoodMagic();
  const fd = h.m.foodStep({ mana: 30, maxMana: 270 });
  assert.deepEqual({ fire: fd.fire, kind: fd.kind, slot: fd.slot, sid: fd.sid, cost: fd.cost },
    { fire: true, kind: 'eat-magic', slot: 4, sid: 24, cost: 30 },
    'the machine decision comes from the INJECTED foodMagicConfig (REQ-01)');
  assert.equal(h.fire(fd, 30), true);
});

test('facade (PR 3): foodStep delegates to confirmPending while an action is in flight', () => {
  const h = harness();
  h.m.requestFoodMagic();
  const fd = h.m.foodStep({ mana: 30, maxMana: 270 });
  assert.equal(h.fire(fd, 30), true);
  // In-flight cast: confirmPending owns the step — no second cast decision.
  assert.equal(h.m.foodStep({ mana: 0, maxMana: 270 }).reason, 'waiting-created-food');
  assert.equal(h.m.getState().pendingAction, 'eat-magic');
});

test('facade (PR 3): noteRuneCreated counts runes but never arms food magic (REQ-06 decoupling)', () => {
  const h = harness();
  confirmRune(h);
  assert.equal(h.m.getState().successfulRuneCreations, 1, 'Runes card count kept');
  assert.equal(h.m.getState().foodMagicPending, false, 'no everyRunes arming anymore');
  assert.equal(h.m.foodStep({ mana: 30, maxMana: 270 }), null, 'quiet until requestFoodMagic');
});

test('facade (PR 3): resetFoodCycle clears food fields and ONLY food-prefixed blocked reasons', () => {
  const h = harness();
  confirmRune(h);
  invokeFood(h);
  h.advance(1000);
  assert.equal(h.m.decide({ mana: 0, maxMana: 270 }).reason, 'food-not-created-timeout');
  assert.equal(h.m.getState().blockedReason, 'food-not-created-timeout');
  h.m.resetFoodCycle();
  const st = h.m.getState();
  assert.equal(st.foodCycle, 'idle');
  assert.equal(st.foodMagicPending, false);
  assert.equal(st.foodDeadlineAt, null);
  assert.equal(st.blockedReason, null, 'food-prefixed block cleared');

  // Non-food blocks survive resetFoodCycle untouched.
  const h2 = harness();
  const rune = h2.m.decide({ mana: 240, maxMana: 270 });
  assert.equal(h2.fire(rune, 240), true);
  h2.advance(1000);
  assert.equal(h2.m.decide({ mana: 240, maxMana: 270 }).reason, 'rune-cast-no-mana-effect');
  h2.m.resetFoodCycle();
  assert.equal(h2.m.getState().blockedReason, 'rune-cast-no-mana-effect', 'non-food block preserved');
});

test('facade (PR 3): the injected foodMagicConfig is the ONLY config source — config.eatWithMagic is dead', () => {
  // Even a stale legacy eatWithMagic in the trainer config must be ignored.
  const h = harness({
    config: { eatWithMagic: { enabled: true, slot: 9, sid: 999 } },
    foodMagicConfig: { enabled: true, slot: 5, sid: 5 }, // harness resolves sid 5 at cost 20
  });
  h.m.requestFoodMagic();
  const fd = h.m.foodStep({ mana: 30, maxMana: 270 });
  assert.deepEqual({ fire: fd.fire, kind: fd.kind, slot: fd.slot, sid: fd.sid },
    { fire: true, kind: 'eat-magic', slot: 5, sid: 5 },
    'the unified injection wins (REQ-01: no training.eatWithMagic left)');
});
