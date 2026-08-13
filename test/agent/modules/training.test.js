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
    eatWithMagic: { enabled: true, slot: 4, sid: 24, everyRunes: 1 },
  }, overrides.config || {});
  const m = createTraining({
    config,
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
  const food = h.m.decide({ mana: 30, maxMana: 270 });
  assert.deepEqual({ fire: food.fire, kind: food.kind, slot: food.slot, sid: food.sid, cost: food.cost },
    { fire: true, kind: 'eat-magic', slot: 4, sid: 24, cost: 30 });
  assert.equal(h.fire(food, 30), true);
}

test('HMM 210 + reserve 30 waits at 96 and arms at 240 without save-time blocking', () => {
  const h = harness({ config: { eatWithMagic: { enabled: false } } });
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
