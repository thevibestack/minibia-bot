'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEngine } = require('../../src/core/rotation');

// Spell-shaped helper rules: condition on mana >= threshold, action spends cost.
function spellRule(id, { order, cost, threshold, repeat }) {
  return {
    id,
    order,
    repeat,
    condition: (ctx) => ctx.mana >= threshold,
    action: (ctx) => {
      ctx.mana -= cost;
    },
  };
}

test('REQ-03: no feasible rule -> no action fired', () => {
  const ctx = { mana: 5 };
  const engine = createEngine({
    rules: [spellRule('A', { order: 1, cost: 20, threshold: 10 })],
    ctx,
  });
  const r = engine.tick();
  assert.equal(r.fired, null);
  assert.equal(r.action, null);
  assert.deepEqual(r.deferred, []);
});

test('REQ-03: A (order 1) and B (order 2) both feasible -> A fires, B deferred', () => {
  const ctx = { mana: 100 };
  const engine = createEngine({
    rules: [
      spellRule('A', { order: 1, cost: 20, threshold: 0 }),
      spellRule('B', { order: 2, cost: 10, threshold: 0 }),
    ],
    ctx,
  });
  const r = engine.tick();
  assert.equal(r.fired, 'A');
  assert.equal(ctx.mana, 80, 'only A acted');
  assert.deepEqual(r.deferred, ['B']);
});

test('REQ-03: at most one action per tick', () => {
  const ctx = { mana: 100 };
  const engine = createEngine({
    rules: [
      spellRule('A', { order: 1, cost: 5, threshold: 0 }),
      spellRule('B', { order: 2, cost: 5, threshold: 0 }),
      spellRule('C', { order: 3, cost: 5, threshold: 0 }),
    ],
    ctx,
  });
  const fired = [];
  for (let i = 0; i < 3; i++) {
    fired.push(engine.tick().fired);
  }
  assert.deepEqual(fired, ['A', 'B', 'C'], 'one action per tick, in order');
  assert.equal(ctx.mana, 85);
});

test('REQ-03: earlier order wins even when listed later in the array', () => {
  const ctx = { mana: 100 };
  const engine = createEngine({
    rules: [
      spellRule('B', { order: 2, cost: 10, threshold: 0 }),
      spellRule('A', { order: 1, cost: 20, threshold: 0 }),
    ],
    ctx,
  });
  const r = engine.tick();
  assert.equal(r.fired, 'A');
});

test('REQ-03: infeasible first rule is skipped, second fires', () => {
  const ctx = { mana: 40 };
  const engine = createEngine({
    rules: [
      spellRule('A', { order: 1, cost: 20, threshold: 50 }), // infeasible
      spellRule('B', { order: 2, cost: 10, threshold: 0 }), // feasible
    ],
    ctx,
  });
  const r = engine.tick();
  assert.equal(r.fired, 'B');
  assert.equal(ctx.mana, 30);
});

test('REQ-03: repeat ON -> eligible on subsequent ticks while feasible, then completes', () => {
  const ctx = { mana: 200 };
  const engine = createEngine({
    rules: [spellRule('A', { order: 1, cost: 20, threshold: 0, repeat: 3 })],
    ctx,
  });
  const fired = [];
  for (let i = 0; i < 3; i++) {
    fired.push(engine.tick().fired);
  }
  assert.deepEqual(fired, ['A', 'A', 'A']);
  assert.equal(ctx.mana, 140);

  // Completed after 3 executions: dormant while the condition stays true.
  const r4 = engine.tick();
  assert.equal(r4.fired, null, 'completed rule does not fire while condition holds');
});

test('REQ-03: completed rule re-arms when its condition re-satisfies', () => {
  const ctx = { mana: 100 };
  const engine = createEngine({
    rules: [spellRule('A', { order: 1, cost: 20, threshold: 30, repeat: 1 })],
    ctx,
  });
  assert.equal(engine.tick().fired, 'A');
  assert.equal(ctx.mana, 80);
  // Condition still true (80 >= 30) -> repeat OFF means no second fire.
  assert.equal(engine.tick().fired, null);
  // Mana drops below threshold -> rule re-arms...
  ctx.mana = 10;
  assert.equal(engine.tick().fired, null);
  // ...and re-satisfaction (mana re-crosses threshold) fires it again.
  ctx.mana = 40;
  assert.equal(engine.tick().fired, 'A');
  assert.equal(ctx.mana, 20);
});

test('REQ-03: repeat OFF, mana=40, threshold=30, cost=20 -> no refire until mana re-crosses threshold', () => {
  const ctx = { mana: 40 };
  const engine = createEngine({
    rules: [spellRule('A', { order: 1, cost: 20, threshold: 30, repeat: 1 })],
    ctx,
  });
  assert.equal(engine.tick().fired, 'A');
  assert.equal(ctx.mana, 20, 'after fire, mana is below threshold');

  const r2 = engine.tick();
  assert.equal(r2.fired, null, 'does not fire again immediately');

  ctx.mana = 30; // re-crosses threshold (equality counts)
  assert.equal(engine.tick().fired, 'A');
});

test('REQ-03: explicit rearm() allows an immediate refire', () => {
  const ctx = { mana: 100 };
  const engine = createEngine({
    rules: [spellRule('A', { order: 1, cost: 20, threshold: 0, repeat: 1 })],
    ctx,
  });
  assert.equal(engine.tick().fired, 'A');
  assert.equal(engine.tick().fired, null, 'completed');
  assert.equal(engine.rearm('A'), true);
  assert.equal(engine.tick().fired, 'A', 're-armed fires immediately');
  assert.equal(engine.rearm('nope'), false, 'unknown rule returns false');
});

test('REQ-03: deferred list names every rule after the fired one', () => {
  const ctx = { mana: 100 };
  const engine = createEngine({
    rules: [
      spellRule('A', { order: 1, cost: 5, threshold: 0 }),
      spellRule('B', { order: 2, cost: 5, threshold: 0 }),
      spellRule('C', { order: 3, cost: 5, threshold: 0 }),
    ],
    ctx,
  });
  assert.deepEqual(engine.tick().deferred, ['B', 'C']);
});

test('REQ-03: shared context is mutable via getCtx/setCtx', () => {
  const engine = createEngine({ rules: [], ctx: { mana: 10 } });
  assert.equal(engine.getCtx().mana, 10);
  engine.setCtx({ mana: 25 });
  assert.equal(engine.getCtx().mana, 25);
});

test('REQ-03: rules without explicit order use array order', () => {
  const ctx = { mana: 100 };
  const engine = createEngine({
    rules: [
      spellRule('first', { cost: 5, threshold: 0 }),
      spellRule('second', { cost: 5, threshold: 0 }),
    ],
    ctx,
  });
  assert.equal(engine.tick().fired, 'first');
});

test('food.everyCasts: confirmed cast-kind executions increment ctx.castsSinceFood', () => {
  const ctx = { mana: 100 };
  const engine = createEngine({
    rules: [
      { id: 'cast-a', kind: 'cast', order: 1, repeat: 3, condition: () => true, action: () => true },
    ],
    ctx,
  });
  engine.tick();
  engine.tick();
  engine.tick();
  assert.equal(ctx.castsSinceFood, 3, 'one increment per confirmed cast');
});

test('food.everyCasts: skipped, unconfirmed and non-cast rules never advance the counter', () => {
  // Action returns false (fire path did not run) -> no increment.
  const ctx1 = { mana: 100 };
  const e1 = createEngine({
    rules: [{ id: 'c', kind: 'cast', order: 1, condition: () => true, action: () => false }],
    ctx: ctx1,
  });
  e1.tick();
  assert.equal(ctx1.castsSinceFood, undefined);

  // Condition false -> rule skipped, counter untouched.
  const ctx2 = {};
  const e2 = createEngine({
    rules: [{ id: 'c', kind: 'cast', order: 1, condition: () => false, action: () => true }],
    ctx: ctx2,
  });
  e2.tick();
  assert.equal(ctx2.castsSinceFood, undefined);

  // Non-cast rules (e.g. eat) never advance the counter even when confirmed.
  const ctx3 = {};
  const e3 = createEngine({
    rules: [{ id: 'eat-food', order: 1, condition: () => true, action: () => true }],
    ctx: ctx3,
  });
  e3.tick();
  assert.equal(ctx3.castsSinceFood, undefined);
});

test('food.everyCasts: eat rule fires when the counter reaches N, then the counter resets', () => {
  const ctx = { mana: 100 };
  const eats = [];
  const engine = createEngine({
    rules: [
      {
        id: 'cast-a',
        kind: 'cast',
        order: 1,
        repeat: 99,
        condition: () => ctx.mana > 40,
        action: () => {
          ctx.mana -= 20;
          return true;
        },
      },
      {
        id: 'eat-food',
        order: 2,
        repeat: 1,
        condition: () => (ctx.castsSinceFood || 0) >= 3,
        action: () => {
          eats.push(ctx.castsSinceFood);
          ctx.castsSinceFood = 0;
        },
      },
    ],
    ctx,
  });

  assert.equal(engine.tick().fired, 'cast-a'); // mana 100 -> 80, counter 1
  assert.equal(engine.tick().fired, 'cast-a'); // 80 -> 60, counter 2
  assert.equal(engine.tick().fired, 'cast-a'); // 60 -> 40, counter 3
  assert.equal(engine.tick().fired, 'eat-food', 'cast infeasible now; eat fires at the threshold');
  assert.deepEqual(eats, [3], 'eat ran with the counter at N');
  assert.equal(ctx.castsSinceFood, 0, 'counter reset after the forced eat');
  assert.equal(engine.tick().fired, null, 'no refire while the counter is below N');
});
