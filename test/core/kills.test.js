'use strict';

/**
 * Kill observer tests (REQ-21/19 feed, task 5.4): the active-creature diff
 * detects disappearances as kills; an absent creature array degrades to
 * available:false without inventing events.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKillObserver, creatureId, creatureName, creatureLoot } = require('../../src/core/kills');

test('REQ-21: first scan establishes the baseline, no kills reported', () => {
  let list = [{ id: 1, name: 'Rat' }, { id: 2, name: 'Wolf' }];
  const obs = createKillObserver({ readActiveCreatures: () => list, now: () => 1000 });
  assert.deepEqual(obs.scan(), { kills: [], available: true });
});

test('REQ-21: a creature disappearing between scans is a kill (name + loot preserved)', () => {
  let list = [{ id: 1, name: 'Rat', loot: true }, { id: 2, name: 'Wolf' }];
  const obs = createKillObserver({ readActiveCreatures: () => list, now: () => 1000 });
  obs.scan();
  list = [{ id: 2, name: 'Wolf' }]; // Rat disappeared -> kill
  const { kills, available } = obs.scan();
  assert.equal(available, true);
  assert.equal(kills.length, 1);
  assert.equal(kills[0].name, 'Rat');
  assert.equal(kills[0].loot, true, 'loot info preserved for routing (REQ-19)');
});

test('REQ-21: kills without loot info carry loot null (unknown, unprobed)', () => {
  let list = [{ id: 1, name: 'Bat' }];
  const obs = createKillObserver({ readActiveCreatures: () => list, now: () => 1000 });
  obs.scan();
  list = [];
  const { kills } = obs.scan();
  assert.equal(kills.length, 1);
  assert.equal(kills[0].loot, null);
});

test('REQ-21: explicit loot:false is not routable loot', () => {
  assert.equal(creatureLoot({ id: 1, loot: false }), false);
  assert.equal(creatureLoot({ id: 1 }), null);
  assert.equal(creatureLoot({ id: 1, loot: true }), true);
});

test('REQ-21: absent creature array -> available:false, zero kills (degrade)', () => {
  const obs = createKillObserver({ readActiveCreatures: () => null, now: () => 1000 });
  assert.deepEqual(obs.scan(), { kills: [], available: false });
  const obs2 = createKillObserver({ readActiveCreatures: () => 'nope', now: () => 1000 });
  assert.deepEqual(obs2.scan(), { kills: [], available: false });
});

test('REQ-21: the observer recovers when the array reappears', () => {
  let list = null;
  const obs = createKillObserver({ readActiveCreatures: () => list, now: () => 1000 });
  assert.equal(obs.scan().available, false);
  list = [{ id: 1, name: 'Rat' }];
  assert.equal(obs.scan().available, true);
  assert.deepEqual(obs.scan().kills, [], 'baseline re-established after recovery');
  list = [];
  assert.equal(obs.scan().kills.length, 1, 'kill detected after recovery');
});

test('REQ-21: reset() drops the baseline (new session)', () => {
  let list = [{ id: 1, name: 'Rat' }];
  const obs = createKillObserver({ readActiveCreatures: () => list, now: () => 1000 });
  obs.scan();
  obs.reset();
  obs.scan(); // fresh baseline
  list = [];
  assert.equal(obs.scan().kills.length, 1, 'after reset the next disappearance is a kill');
});

test('REQ-21: entries without a stable id are ignored (no phantom kills)', () => {
  let list = [{ name: 'Rat' }];
  const obs = createKillObserver({ readActiveCreatures: () => list, now: () => 1000 });
  obs.scan();
  list = [];
  const { kills } = obs.scan();
  assert.equal(kills.length, 1, 'name-only entries still diff by name');
  assert.equal(kills[0].name, 'Rat');
});

test('identity helpers: id/name/loot extraction over candidate fields', () => {
  assert.equal(creatureId({ id: 7 }), 'id|7');
  assert.equal(creatureId({ speciesId: 9 }), 'sid|9');
  assert.equal(creatureId({ name: 'Rat' }), 'name|Rat');
  assert.equal(creatureId({}), null);
  assert.equal(creatureName({ name: 'Rat' }), 'Rat');
  assert.equal(creatureName({ speciesName: 'Rat' }), 'Rat');
  assert.equal(creatureName({ type: 'Rat' }), 'Rat');
  assert.equal(creatureName({}), null);
});
