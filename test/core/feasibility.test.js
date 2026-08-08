'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canCast } = require('../../src/core/feasibility');

test('REQ-01: fires when mana >= cost and reserve satisfied (80-20=60 >= 30)', () => {
  const v = canCast({ mana: 80, cost: 20, reserve: 30 });
  assert.equal(v.fire, true);
  assert.equal(v.reason, 'ok');
  assert.equal(v.never, false);
});

test('REQ-01: reserve equality passes (50-20=30 === 30)', () => {
  const v = canCast({ mana: 50, cost: 20, reserve: 30 });
  assert.equal(v.fire, true);
});

test('REQ-01: mana below cost is skipped as infeasible (15 < 20)', () => {
  const v = canCast({ mana: 15, cost: 20 });
  assert.equal(v.fire, false);
  assert.equal(v.reason, 'insufficient');
  assert.equal(v.never, false);
});

test('REQ-01: cost > maxMana is never feasible with a single warning', () => {
  const warned = new Set();
  const warnings = [];
  const v1 = canCast({ mana: 120, cost: 300, maxMana: 120, key: 'slot-4', warned, onWarn: (m) => warnings.push(m) });
  assert.equal(v1.fire, false);
  assert.equal(v1.never, true);
  assert.equal(v1.reason, 'never');
  assert.equal(warnings.length, 1, 'exactly one warning on first evaluation');

  // Repeated evaluations across ticks must not spam: still one warning total.
  for (let i = 0; i < 5; i++) {
    canCast({ mana: 120, cost: 300, maxMana: 120, key: 'slot-4', warned, onWarn: (m) => warnings.push(m) });
  }
  assert.equal(warnings.length, 1, 'no per-tick spam');
  assert.match(warnings[0], /cost 300 exceeds maxMana 120/);
});

test('REQ-01: reserve >= mana blocks the cast (25-10=15 < 25)', () => {
  const v = canCast({ mana: 25, cost: 10, reserve: 25 });
  assert.equal(v.fire, false);
  assert.equal(v.reason, 'reserve');
});

test('REQ-01: mana === cost passes (equality)', () => {
  const v = canCast({ mana: 20, cost: 20 });
  assert.equal(v.fire, true);
});

test('REQ-01: reserve 0 (OFF) uses the plain mana >= cost rule', () => {
  assert.equal(canCast({ mana: 30, cost: 20, reserve: 0 }).fire, true);
  assert.equal(canCast({ mana: 19, cost: 20, reserve: 0 }).fire, false);
});

test('REQ-01: warning dedupe is per-key', () => {
  const warned = new Set();
  const warnings = [];
  const warn = (m) => warnings.push(m);
  canCast({ mana: 1, cost: 999, maxMana: 100, key: 'slot-1', warned, onWarn: warn });
  canCast({ mana: 1, cost: 888, maxMana: 100, key: 'slot-2', warned, onWarn: warn });
  canCast({ mana: 1, cost: 999, maxMana: 100, key: 'slot-1', warned, onWarn: warn });
  assert.equal(warnings.length, 2, 'one warning per distinct spell key');
});
