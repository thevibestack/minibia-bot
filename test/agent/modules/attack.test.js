'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createAttackModule, normalizeTargeting, normalizeSid, normalizeSlot, TARGETING_OPTIONS, DEFAULT_TARGETING,
} = require('../../../src/agent/modules/attack');

function makeModule(overrides = {}) {
  const fired = [];
  const target = overrides.target === undefined ? { id: 42, name: 'Rat' } : overrides.target;
  const mod = createAttackModule({
    config: Object.assign({ on: true, targeting: 'lowest-hp', sid: 61, runeSlot: null, reserve: 10 }, overrides.config || {}),
    readTarget: () => target,
    resolveSpellSlot: (sid) => (sid === 61 ? 3 : null),
    getSpellCost: () => 20,
    canCastSpell: () => true,
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: false } }),
  });
  return { mod, fired };
}

test('normalizers accept only supported targeting, sid and hotbar slots', () => {
  assert.equal(TARGETING_OPTIONS.includes('nearest'), true);
  assert.equal(normalizeTargeting('nearest'), 'nearest');
  assert.equal(normalizeTargeting('junk'), DEFAULT_TARGETING);
  assert.equal(normalizeSid('61'), 61);
  assert.equal(normalizeSid(''), null);
  assert.equal(normalizeSlot('3'), 3);
  assert.equal(normalizeSlot(13), null);
});

test('assist mode never acquires a target: no user target means no action', () => {
  const { mod } = makeModule({ target: null });
  assert.deepEqual(mod.decide({ mana: 100, maxMana: 100 }), { fire: false, reason: 'no-manual-target' });
  assert.equal(mod.getState().mode, 'assist');
});

test('assist casts the selected spell only when it is on the hotbar and affordable with reserve', () => {
  const { mod } = makeModule();
  const d = mod.decide({ mana: 30, maxMana: 100 });
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'spell');
  assert.equal(d.slot, 3);
  assert.equal(d.target, 'Rat');
  assert.equal(mod.decide({ mana: 29, maxMana: 100 }).reason, 'reserve');
});

test('assist refuses unknown spell slots, vocation rejection and cooldowns', () => {
  let mod = createAttackModule({ config: { on: true, sid: 61 }, readTarget: () => ({ name: 'Rat' }), resolveSpellSlot: () => null, getSpellCost: () => 20 });
  assert.equal(mod.decide({ mana: 100, maxMana: 100 }).reason, 'spell-not-on-hotbar');
  mod = createAttackModule({ config: { on: true, sid: 61 }, readTarget: () => ({ name: 'Rat' }), resolveSpellSlot: () => 3, getSpellCost: () => 20, canCastSpell: () => false });
  assert.equal(mod.decide({ mana: 100, maxMana: 100 }).reason, 'vocation-gate');
  mod = createAttackModule({ config: { on: true, sid: 61 }, readTarget: () => ({ name: 'Rat' }), resolveSpellSlot: () => 3, getSpellCost: () => 20, readCooldown: () => ({ cooldown: { active: true }, globalCooldown: { active: false } }) });
  assert.equal(mod.decide({ mana: 100, maxMana: 100 }).reason, 'cooldown');
});

test('a configured rune is used when no spell is selected', () => {
  const { mod } = makeModule({ config: { sid: null, runeSlot: 5, reserve: 0 } });
  const d = mod.decide({ mana: 0, maxMana: 100 });
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'rune');
  assert.equal(d.slot, 5);
});
