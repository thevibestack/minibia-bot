'use strict';

/**
 * Heal-items module unit tests (task 4.1, REQ-13): pure decision + the
 * queue-agnostic fire path. The jsdom wiring tests (modules-wiring.test.js)
 * prove the module -> tree -> queue -> game-handler funnel.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHealItems, defaultFindSlot } = require('../../../src/agent/modules/heal-items');

function moduleWith(overrides = {}, opts = {}) {
  const config = Object.assign({ on: true, threshold: 50, slotCids: [100] }, overrides);
  return createHealItems(Object.assign({ config, gameClient: () => opts.gameClient || null }, opts));
}

test('REQ-13: health <= threshold with an item -> fire decision carries the slot', () => {
  const m = moduleWith({}, { findSlot: () => ({ which: 0, index: 3 }) });
  const d = m.decide({ health: 40 });
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'low-hp');
  assert.deepEqual(d.item, { which: 0, index: 3 });
});

test('REQ-13: health above threshold -> no fire (healthy)', () => {
  const m = moduleWith({});
  assert.equal(m.decide({ health: 51 }).fire, false);
  assert.equal(m.decide({ health: 51 }).reason, 'healthy');
});

test('REQ-13: equality at the threshold fires', () => {
  const m = moduleWith({}, { findSlot: () => ({ which: 0, index: 1 }) });
  assert.equal(m.decide({ health: 50 }).fire, true, 'health <= threshold includes equality');
});

test('REQ-13: no item in the container -> no fire (no-item)', () => {
  const m = moduleWith({}, { findSlot: () => null });
  assert.equal(m.decide({ health: 10 }).fire, false);
  assert.equal(m.decide({ health: 10 }).reason, 'no-item');
});

test('REQ-13: module OFF -> zero actions regardless of health', () => {
  const m = moduleWith({ on: false });
  assert.equal(m.decide({ health: 1 }).fire, false);
  assert.equal(m.decide({ health: 1 }).reason, 'off');
  assert.equal(m.isEnabled(), false);
});

test('REQ-13: missing health read -> no fire (no-health)', () => {
  const m = moduleWith({});
  assert.equal(m.decide({}).fire, false);
  assert.equal(m.decide({ health: null }).reason, 'no-health');
});

test('REQ-13: missing/invalid threshold -> no fire', () => {
  assert.equal(moduleWith({ threshold: 'abc' }).decide({ health: 10 }).reason, 'no-threshold');
});

test('REQ-13: fire uses __useItemOnSelf when the probed action exists', () => {
  const calls = [];
  const gameClient = {
    interface: { hotbarManager: { __useItemOnSelf: (args) => { calls.push(args); } } },
    mouse: { use: () => calls.push('mouse') },
  };
  const m = moduleWith({}, { gameClient });
  assert.equal(m.fire({ which: 0, index: 3 }), true);
  assert.deepEqual(calls, [{ which: 0, index: 3 }], 'live-probed use-on-self action preferred');
});

test('REQ-13: fire falls back to mouse.use when __useItemOnSelf is absent', () => {
  const calls = [];
  const gameClient = { mouse: { use: (args) => calls.push(args) } };
  const m = moduleWith({}, { gameClient });
  assert.equal(m.fire({ which: 1, index: 5 }), true);
  assert.deepEqual(calls, [{ which: 1, index: 5 }], 'proven mouse.use right-click-use path');
});

test('REQ-13: fire falls back to mouse.use when __useItemOnSelf throws', () => {
  const calls = [];
  const gameClient = {
    interface: { hotbarManager: { __useItemOnSelf: () => { throw new Error('signature mismatch'); } } },
    mouse: { use: (args) => calls.push(args) },
  };
  const m = moduleWith({}, { gameClient });
  assert.equal(m.fire({ which: 0, index: 3 }), true);
  assert.deepEqual(calls, [{ which: 0, index: 3 }]);
});

test('REQ-13: fire with no game handler -> false + error log, never throws', () => {
  const errors = [];
  const m = moduleWith({}, { log: { error: (m2) => errors.push(m2) } });
  assert.equal(m.fire({ which: 0, index: 3 }), false);
  assert.equal(errors.length, 1);
});

test('REQ-13: defaultFindSlot scans the probe-order container sources by cid', () => {
  const gameClient = {
    backpack: { slots: [{ index: 1, cid: 999 }, { index: 2, cid: 100 }] },
  };
  const hit = defaultFindSlot(gameClient, [100]);
  assert.equal(hit.which, 0, 'backpack is the first PRESENT source (containerPrototype absent)');
  assert.equal(hit.index, 2);
});

test('REQ-13: defaultFindSlot degrades to null when container state is absent', () => {
  assert.equal(defaultFindSlot(null, [100]), null);
  assert.equal(defaultFindSlot({}, [100]), null);
  assert.equal(defaultFindSlot({ player: {} }, []), null);
});
