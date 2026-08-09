'use strict';

/**
 * Heal-magic module unit tests (task 4.2, REQ-14): hp threshold, mana
 * feasibility (cost resolved from the probed interface.getSpell location),
 * the vocation gate and GLOBAL_COOLDOWN defer.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHealMagic } = require('../../../src/agent/modules/heal-magic');

function moduleWith(overrides = {}, opts = {}) {
  const config = Object.assign({ on: true, threshold: 150, slot: 2, sid: 61 }, overrides);
  return createHealMagic(Object.assign({
    config,
    getSpellCost: () => 20,
    canCastSpell: () => true,
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: false } }),
    now: () => 1000,
  }, opts));
}

const ctx = { health: 120, mana: 100, maxMana: 120 };

test('REQ-14: health <= threshold with mana and clear cooldowns -> fire on the heal slot', () => {
  const m = moduleWith();
  const d = m.decide(ctx);
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'low-hp');
  assert.equal(d.slot, 2);
});

test('REQ-14: health above threshold -> no fire', () => {
  const m = moduleWith({ threshold: 100 });
  assert.equal(m.decide({ ...ctx, health: 101 }).fire, false);
  assert.equal(m.decide({ ...ctx, health: 101 }).reason, 'healthy');
});

test('REQ-14: module OFF -> no fire regardless of health', () => {
  const m = moduleWith({ on: false });
  assert.equal(m.decide({ ...ctx, health: 1 }).fire, false);
  assert.equal(m.decide({ ...ctx, health: 1 }).reason, 'off');
});

test('REQ-14: mana below spell cost -> no fire (insufficient)', () => {
  const m = moduleWith({}, { getSpellCost: () => 120 });
  assert.equal(m.decide({ ...ctx, mana: 100 }).fire, false);
  assert.equal(m.decide({ ...ctx, mana: 100 }).reason, 'insufficient');
});

test('REQ-14: cost resolved via the probed interface.getSpell location (spellbook empty)', () => {
  // Simulates the live probe (obs 10320): spellbook empty, interface.getSpell
  // is the resolver. The injected getSpellCost receives the sid.
  let seen = null;
  const m = moduleWith({ sid: 61 }, { getSpellCost: (sid) => { seen = sid; return 20; } });
  assert.equal(m.decide(ctx).fire, true);
  assert.equal(seen, 61);
});

test('REQ-14: unknown spell cost -> no fire (no-cost, safe pause)', () => {
  const m = moduleWith({}, { getSpellCost: () => null });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'no-cost');
});

test('REQ-14: GLOBAL_COOLDOWN active -> deferred to a later tick', () => {
  const m = moduleWith({}, {
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: true, seconds: 1.2 } }),
  });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'global-cooldown');
});

test('REQ-14: per-spell cooldown active -> deferred', () => {
  const m = moduleWith({}, {
    readCooldown: () => ({ cooldown: { active: true, seconds: 4 }, globalCooldown: { active: false } }),
  });
  assert.equal(m.decide(ctx).reason, 'cooldown');
});

test('REQ-14: vocation gate false -> no fire (live-probed __canPlayerCastSpell)', () => {
  const m = moduleWith({}, { canCastSpell: () => false });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'vocation-gate');
});

test('REQ-14: vocation gate feature-absent (null) -> gate skipped, heal still fires', () => {
  const m = moduleWith({}, { canCastSpell: () => null });
  assert.equal(m.decide(ctx).fire, true, 'absent gate never blocks');
});

test('REQ-14: invalid hotbar slot -> no fire', () => {
  const m = moduleWith({ slot: 0 });
  assert.equal(m.decide(ctx).reason, 'no-slot');
});

test('REQ-14: fire calls __handleClick via the proven firing path', () => {
  const clicks = [];
  const m = moduleWith({});
  const ok = m.fire({ slot: 2 }, {
    gameClient: { interface: { hotbarManager: { __handleClick: (slot) => clicks.push(slot) } } },
    document: null,
  });
  assert.equal(ok, true);
  assert.deepEqual(clicks, [2]);
});
