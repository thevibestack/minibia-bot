'use strict';

/**
 * Monster spawn maps provider tests (REQ-20, task 5.3): feature-detected
 * spawn-data read, monster -> locations, "no spawn data" degrade, premium
 * gate (REQ-22). Panel consumption is via the snapshot state (routes
 * consumption is slice 6).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSpawnsModule, normalizeSpawnLocations } = require('../../../src/agent/modules/spawns');

function makeModule(overrides = {}) {
  return createSpawnsModule({
    config: Object.assign({ on: true }, overrides.config),
    readSpawnData: overrides.readSpawnData !== undefined ? overrides.readSpawnData : () => [{ x: 100, y: 200 }],
    readPremium: overrides.readPremium || (() => ({ gated: true, active: true, source: 'test' })),
    log: {},
  });
}

test('REQ-20: a queried monster resolves to spawn locations from the game data', () => {
  const mod = makeModule({ readSpawnData: (m) => (m === 'Rat' ? [{ x: 100, y: 200 }, { x: 110, y: 210 }] : null) });
  const q = mod.query('Rat');
  assert.equal(q.available, true);
  assert.equal(q.reason, 'ok');
  assert.deepEqual(q.locations, [{ x: 100, y: 200 }, { x: 110, y: 210 }]);
  assert.equal(mod.getState().lastQuery.monster, 'Rat');
  assert.equal(mod.getState().available, true);
});

test('REQ-20: spawn data unavailable -> "no spawn data" state, never fails', () => {
  const mod = makeModule({ readSpawnData: () => null });
  const q = mod.query('Rat');
  assert.equal(q.available, false);
  assert.equal(q.reason, 'no spawn data');
  assert.equal(q.locations, null);
  assert.equal(mod.getState().reason, 'no spawn data');
});

test('REQ-20: throwing read -> same "no spawn data" degrade', () => {
  const mod = makeModule({ readSpawnData: () => { throw new Error('boom'); } });
  assert.equal(mod.query('Rat').reason, 'no spawn data');
});

test('REQ-20: empty monster -> no-monster state', () => {
  const mod = makeModule();
  assert.equal(mod.query('').reason, 'no-monster');
  assert.equal(mod.query('  ').available, false);
});

test('REQ-20: feature-detected reader forms — query fn, get fn, object map', () => {
  const queryFn = makeModule({ readSpawnData: (m) => ({ query: (name) => (name === 'Rat' ? [{ x: 1, y: 2 }] : null) }.query(m)) });
  assert.equal(queryFn.query('Rat').available, true);
  assert.equal(queryFn.query('Wolf').available, false);
});

test('normalizeSpawnLocations: array points, single point, string pairs, nested, unshaped', () => {
  assert.deepEqual(normalizeSpawnLocations([{ x: 1, y: 2 }, { x: 3, y: 4, z: 5 }]), [{ x: 1, y: 2 }, { x: 3, y: 4, z: 5 }]);
  assert.deepEqual(normalizeSpawnLocations({ x: 1, y: 2 }), [{ x: 1, y: 2 }]);
  assert.deepEqual(normalizeSpawnLocations(['1,2', '3,4,5']), [{ x: 1, y: 2 }, { x: 3, y: 4, z: 5 }]);
  assert.deepEqual(normalizeSpawnLocations({ name: 'Rat', locations: [{ x: 7, y: 8 }] }), [{ x: 7, y: 8 }]);
  assert.equal(normalizeSpawnLocations([]), null, 'empty shaped data is still "no spawn data"');
  assert.equal(normalizeSpawnLocations(null), null);
  assert.equal(normalizeSpawnLocations(42), null);
  assert.equal(normalizeSpawnLocations('garbage'), null);
  assert.equal(normalizeSpawnLocations({ foo: 1 }), null);
});

test('REQ-22: explicit non-premium -> premium-required state; unknown never blocks', () => {
  const premiumFalse = { gated: true, active: false, source: 'player.premium' };
  const blocked = makeModule({ readPremium: () => premiumFalse });
  const q = blocked.query('Rat');
  assert.equal(q.available, false);
  assert.equal(q.reason, 'premium-required');
  assert.equal(blocked.getState().premium.blocked, true);

  const unknown = { gated: true, active: null, source: null };
  const open = makeModule({ readPremium: () => unknown });
  assert.equal(open.query('Rat').available, true, 'unknown premium never blocks (REQ-22)');
});
