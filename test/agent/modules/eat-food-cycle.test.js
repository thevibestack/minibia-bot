'use strict';

/**
 * PR 3 — eat food cycle tests (REQ-01..06): the magic-first -> created ->
 * consumed loop driven through the SAME confirmation machine training.js
 * owns, via the thin facade the bootstrap food node uses. The tiny `drive()`
 * below mirrors the bootstrap food node action exactly (decide ->
 * requestFoodMagic/foodStep -> fire; resetFoodCycle + noteMagicUnavailable
 * on machine block; noteMeal on the created-food-consumed final step).
 *
 * These tests prove the CYCLE (not just single decisions): no double-eat
 * while the machine owns a meal, the safety net overriding SATED on the
 * magic path, and the timeout -> normal-fallback -> magic re-arm (REQ-03).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEatModule } = require('../../../src/agent/modules/eat');
const { createTraining } = require('../../../src/agent/modules/training');

function harness(overrides = {}) {
  let clock = 1000;
  let slots = [{ which: 0, index: 1, cid: 42, count: 1 }];
  const hotbar = Object.assign({}, overrides.hotbar !== undefined ? overrides.hotbar : { 4: 24 });
  const clicks = [];
  const consumes = [];
  const gameClient = {
    player: {
      conditions: overrides.noConditions
        ? null
        : { has: (k) => (overrides.sated === true ? k === 'SATED' : k === 'SATED' && false) },
    },
    mouse: { use: () => {} },
    containerPrototype: { slots: [] },
    interface: { hotbarManager: { __handleClick: (index) => clicks.push(index + 1) } },
  };
  const training = createTraining({
    config: { on: true, slot: 3, sid: 35, reserve: 30 },
    foodMagicConfig: () => ({ enabled: true, slot: 4, sid: 24 }),
    capConfig: { capMode: 'off', capFullThreshold: 1, fallbackSlot: null, fallbackSid: null, fallbackManaPct: 0.5 },
    readCap: () => null,
    getSpellCost: (sidOrSlot) => ({ 35: 210, 24: 30 }[sidOrSlot] ?? null),
    canCastSpell: () => true,
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: false } }),
    readHotbarSlotSid: (slot) => hotbar[slot] ?? null,
    readVisibleSlots: () => slots,
    consumeItem: (item) => { consumes.push(item); return true; },
    now: () => clock,
    actionConfirmationTimeoutMs: 1000,
    foodArrivalTimeoutMs: 1000,
  });
  const eat = createEatModule({
    config: Object.assign({
      on: true, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [],
      safetyNetMinutes: 20, magic: { enabled: true, slot: 4, sid: 24 },
    }, overrides.eatConfig || {}),
    gameClient: () => gameClient,
    document: null,
    now: () => clock,
    log: { warn: () => {} },
    readHotbarSlotSid: (slot) => hotbar[slot] ?? null,
    foodCycle: () => training.getState().foodCycle,
    foodMagicPending: () => training.getState().foodMagicPending,
  });
  const ctx = { mana: 100, maxMana: 270, castsSinceFood: 0, lastEatAt: 0 };

  /** Mirror of the bootstrap food node action (single source of truth). */
  function drive() {
    const d = eat.decide(ctx);
    if (d.fire && d.kind === 'eat-magic') {
      training.requestFoodMagic();
      const fd = training.foodStep(ctx);
      if (!fd || !fd.fire) {
        if (training.getState().blockedReason) {
          training.resetFoodCycle();
          eat.noteMagicUnavailable();
        }
        return { action: null, reason: d.reason };
      }
      const kind = fd.kind === 'consume-created-food' ? 'consume-created-food' : 'eat-magic';
      const ok = training.fire(fd, { gameClient, document: null, mana: ctx.mana });
      ctx.mana = Math.max(0, ctx.mana - Number(fd.cost) || 0); // live mana refresh (next tick read)
      return { action: kind, ok, reason: d.reason };
    }
    if (d.fire && d.kind === 'eat') {
      return { action: 'eat', ok: eat.fire(ctx, d), reason: d.reason };
    }
    if (!d.fire && d.reason === 'magic-cycle-active') {
      const fd = training.foodStep(ctx);
      if (fd && fd.reason === 'created-food-consumed') eat.noteMeal(ctx);
      if (fd && fd.fire) {
        const kind = fd.kind === 'consume-created-food' ? 'consume-created-food' : 'eat-magic';
        const ok = training.fire(fd, { gameClient, document: null, mana: ctx.mana });
        ctx.mana = Math.max(0, ctx.mana - Number(fd.cost) || 0);
        return { action: kind, ok, reason: 'magic-cycle-active' };
      }
      if (training.getState().blockedReason) {
        training.resetFoodCycle();
        eat.noteMagicUnavailable();
      }
      return { action: null, reason: 'magic-cycle-active' };
    }
    return { action: null, reason: d.reason };
  }

  return {
    eat, training, ctx, clicks, consumes,
    slots: () => slots,
    setSlots: (next) => { slots = next; },
    advance: (ms) => { clock += ms; },
    drive,
  };
}

test('PR 3 (REQ-01/02/05): full magic-first cycle — request -> cast -> created slot -> consume -> meal counted, NO normal eat', () => {
  const h = harness();
  // Hungry (SATED false): the eat module requests magic food, the machine
  // casts the pan (slot 4) and waits for the creation confirmation.
  assert.deepEqual(h.drive(), { action: 'eat-magic', ok: true, reason: 'flag' });
  assert.deepEqual(h.clicks, [4], 'the pan F-slot fires, never a typed slot');
  // The created item arrives in the visible 20-slot surface (dynamic slot 2).
  h.setSlots([h.slots()[0], { which: 0, index: 2, cid: 777, count: 1 }]);
  assert.equal(h.drive().action, null, 'confirmation step: food-created-confirmed (machine still owns the meal)');
  assert.equal(h.training.getState().foodCycle, 'created-food-ready');
  // Next step consumes the CREATED item (not config.slot) — REQ-02.
  assert.deepEqual(h.drive(), { action: 'consume-created-food', ok: true, reason: 'magic-cycle-active' });
  assert.equal(h.consumes.length, 1);
  assert.deepEqual(h.consumes[0], { which: 0, index: 2, cid: 777, count: 1 },
    'the created slot (index 2) is consumed, NOT the configured food slot');
  // The slot empties -> the final step confirms consumption and counts the meal.
  h.setSlots([h.slots()[0], { which: 0, index: 2, cid: null, count: null }]);
  assert.equal(h.drive().action, null, 'final step: created-food-consumed');
  assert.equal(h.training.getState().foodCycle, 'idle');
  const st = h.eat.getState();
  assert.equal(st.foodCreated, 1, 'meal counted on consumption');
  assert.equal(st.source, 'magic');
  assert.ok(st.lastEatAt > 0, 'meal anchored');
  assert.equal(st.nextMealAt, st.lastEatAt + 20 * 60 * 1000);
  // Structural no-double-eat: the normal path NEVER fired during the cycle.
  assert.equal(h.clicks.filter((c) => c !== 4).length, 0, 'only the pan fired (REQ-05)');
});

test('PR 3 (REQ-05): hunger + safety due NEVER fall through to normal food while the machine owns the meal', () => {
  const h = harness();
  assert.equal(h.drive().action, 'eat-magic');
  // Advance the machine to created-food-ready (busy), then make BOTH the
  // hunger flag and the safety net due — the machine still owns the meal.
  h.setSlots([h.slots()[0], { which: 0, index: 2, cid: 777, count: 1 }]);
  h.drive(); // food-created-confirmed
  assert.equal(h.training.getState().foodCycle, 'created-food-ready');
  h.ctx.lastEatAt = 0;
  h.advance(21 * 60 * 1000);
  for (let i = 0; i < 3; i += 1) {
    const r = h.drive();
    assert.notEqual(r.action, 'eat', 'magic-cycle-active: the normal path NEVER fires');
  }
  // The busy steps still advance the machine: the created item gets consumed.
  assert.equal(h.consumes.length, 1, 'consume fires while the guard holds (no double-eat)');
});

test('PR 3 (REQ-04): safety net overrides SATED on the magic path — the cycle still fires', () => {
  const h = harness({ sated: true });
  assert.equal(h.drive().action, null, 'sated + inside the safety window -> wait');
  h.advance(21 * 60 * 1000);
  assert.deepEqual(h.drive(), { action: 'eat-magic', ok: true, reason: 'safety-net' },
    'the safety net is the universal floor regardless of SATED');
});

test('PR 3 (REQ-03): no pan on the live hotbar -> normal food path serves hunger', () => {
  const h = harness({ hotbar: {} }); // sid 24 unmapped anywhere
  assert.deepEqual(h.drive(), { action: 'eat', ok: false, reason: 'flag' },
    'hungry + no magic -> normal eat decision (no-food-source attempt is not a failure)');
  assert.equal(h.eat.getState().magicSid, null, 'honest magicSid: no resolvable F-slot');
});

test('PR 3 (REQ-03): creation timeout -> machine blocks -> normal path serves until the retry window passes, then magic re-arms', () => {
  const h = harness();
  assert.equal(h.drive().action, 'eat-magic');
  h.advance(1000); // food arrival window expires without a delta
  assert.equal(h.drive().action, null, 'block observed (food-not-created-timeout) + cycle reset');
  assert.equal(h.training.getState().foodCycle, 'idle');
  assert.equal(h.training.getState().blockedReason, null, 'food block cleared by resetFoodCycle');
  // Normal path serves the fallback meal while the retry window is open.
  assert.deepEqual(h.drive(), { action: 'eat', ok: false, reason: 'flag' }, 'REQ-03 timeout -> normal fallback');
  assert.deepEqual(h.drive(), { action: 'eat', ok: false, reason: 'flag' }, 'still normal inside the retry window');
  // After safetyNetMinutes the magic path re-arms.
  h.advance(21 * 60 * 1000);
  assert.deepEqual(h.drive(), { action: 'eat-magic', ok: true, reason: 'flag' }, 'magic re-armed after the retry window');
});

test('PR 3 (REQ-04): readFoodState unavailable (no conditions, no timer) never crashes the cycle', () => {
  const h = harness({ noConditions: true });
  assert.deepEqual(h.drive(), { action: 'eat-magic', ok: true, reason: 'hunger' },
    'unknown hunger counts as hungry on the magic path (no crash)');
});
