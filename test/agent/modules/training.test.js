'use strict';

/**
 * Training module unit tests (task 4.4, REQ-16): repeat-cast while the
 * vocation gate passes, pause below cost+reserve, feature-absent gate
 * degrade, and the queue-cadence contract (one cast per queue slot — proven
 * in the jsdom wiring tests).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTraining } = require('../../../src/agent/modules/training');

function moduleWith(overrides = {}, opts = {}) {
  const config = Object.assign({ on: true, slot: 7, sid: 50, reserve: 0 }, overrides);
  return createTraining(Object.assign({
    config,
    getSpellCost: () => 25,
    canCastSpell: () => true,
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: false } }),
    now: () => 1000,
  }, opts));
}

const ctx = { mana: 200, maxMana: 220 };

test('REQ-16: gate passes + mana feasible -> training cast fires', () => {
  const m = moduleWith();
  const d = m.decide(ctx);
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'train');
  assert.equal(d.slot, 7);
});

test('REQ-16: repeat-cast — same state keeps the decision fire on every tick', () => {
  const m = moduleWith();
  assert.equal(m.decide(ctx).fire, true);
  assert.equal(m.decide(ctx).fire, true, 'cadence is enforced by the queue, not by the module');
});

test('REQ-16: below cost -> pause (insufficient)', () => {
  const m = moduleWith({}, { getSpellCost: () => 250 });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'insufficient');
});

test('REQ-16: below cost+reserve -> pause until mana recovers', () => {
  const m = moduleWith({ reserve: 100 }, { getSpellCost: () => 50 });
  assert.equal(m.decide({ ...ctx, mana: 140 }).fire, false, '200 - 50 < reserve 100... ' +
    'mana 140 - 50 = 90 < 100 -> reserve pause');
  assert.equal(m.decide({ ...ctx, mana: 140 }).reason, 'reserve');
  assert.equal(m.decide({ ...ctx, mana: 150 }).fire, true, '150 - 50 = 100 >= 100 -> fires');
});

test('REQ-16: unknown spell cost -> pause (no-cost, cannot prove feasibility)', () => {
  const m = moduleWith({}, { getSpellCost: () => null });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'no-cost');
});

test('REQ-16: __canPlayerCastSpell is the vocation gate — false pauses', () => {
  const m = moduleWith({}, { canCastSpell: () => false });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'vocation-gate');
});

test('REQ-16: vocation gate feature-absent (null) -> mana gate alone, cast proceeds', () => {
  const m = moduleWith({}, { canCastSpell: () => null });
  assert.equal(m.decide(ctx).fire, true, 'absent gate never blocks (mana feasibility still gates)');
});

test('REQ-16: GLOBAL_COOLDOWN active -> defer', () => {
  const m = moduleWith({}, {
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: true } }),
  });
  assert.equal(m.decide(ctx).reason, 'global-cooldown');
});

test('REQ-16: module OFF -> no cast', () => {
  const m = moduleWith({ on: false });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'off');
  assert.equal(m.isEnabled(), false);
});

test('REQ-16: no hotbar slot -> no cast', () => {
  const m = moduleWith({ slot: null });
  assert.equal(m.decide(ctx).reason, 'no-slot');
});

test('REQ-16: fire calls __handleClick via the proven firing path', () => {
  const clicks = [];
  const m = moduleWith({});
  const ok = m.fire({ slot: 7 }, {
    gameClient: { interface: { hotbarManager: { __handleClick: (slot) => clicks.push(slot) } } },
    document: null,
  });
  assert.equal(ok, true);
  assert.deepEqual(clicks, [7]);
});
