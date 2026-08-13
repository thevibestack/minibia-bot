'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeLiveSpell,
  normalizeLiveStats,
} = require('../../src/core/live-contract');

test('live contract: spell cost aliases normalize once to manaCost', () => {
  const fromCost = normalizeLiveSpell({
    sid: 35,
    name: 'Heavy Magic Missile',
    words: 'adori gran',
    cost: '210',
    level: 3,
    vocations: ['druid'],
  }, { source: 'client' });
  assert.equal(fromCost.manaCost, 210);
  assert.equal(Object.hasOwn(fromCost, 'cost'), false, 'raw cost alias does not escape the boundary');
  assert.equal(Object.hasOwn(fromCost, 'mana'), false, 'raw mana alias does not escape the boundary');

  const fromMana = normalizeLiveSpell({ sid: 24, name: 'Food', mana: 30 }, { source: 'client' });
  assert.equal(fromMana.manaCost, 30, 'the MiniTibia mana shape reaches the same canonical field');
});

test('live contract: explicit manaCost wins and invalid costs become unavailable', () => {
  const canonical = normalizeLiveSpell({ sid: 2, manaCost: 25, cost: 999, mana: 888 });
  assert.equal(canonical.manaCost, 25);

  const unavailable = normalizeLiveSpell({ sid: 3, cost: 'not-a-number' });
  assert.equal(unavailable.manaCost, null);
});

test('live contract: stats and CAP expose value, source and availability', () => {
  const live = normalizeLiveStats(
    { health: 215, maxHealth: 215, mana: '96', maxMana: '270', source: 'state' },
    { capacity: 209, maxCapacity: 400, ratio: 209 / 400, source: 'state' },
  );

  assert.deepEqual(live, {
    health: 215,
    maxHealth: 215,
    mana: 96,
    maxMana: 270,
    capacity: {
      value: 209,
      maximum: 400,
      ratio: 209 / 400,
      source: 'state',
      availability: 'available',
    },
    source: 'state',
    availability: {
      health: 'available',
      mana: 'available',
      capacity: 'available',
    },
  });
});

test('live contract: absent stats and partial CAP are explicit unavailable data', () => {
  const live = normalizeLiveStats(
    { health: null, maxHealth: null, mana: null, maxMana: null, source: 'none' },
    { capacity: 209, maxCapacity: null, ratio: null, source: 'partial' },
  );

  assert.equal(live.availability.health, 'unavailable');
  assert.equal(live.availability.mana, 'unavailable');
  assert.deepEqual(live.capacity, {
    value: 209,
    maximum: null,
    ratio: null,
    source: 'partial',
    availability: 'unavailable',
  });
});
