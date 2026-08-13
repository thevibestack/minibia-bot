'use strict';

/**
 * Container slot lookup tests (REQ-13/17, src/core/items.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readContainers, findSlotByCid, snapshotVisibleSlots, findCreatedSlotDelta } = require('../../src/core/items');

test('findSlotByCid: returns the first slot whose cid matches the wanted list', () => {
  const containers = [
    { slots: [{ index: 1, cid: 100 }, { index: 2, cid: 200 }] },
    { slots: [{ index: 1, cid: 300 }] },
  ];
  const hit = findSlotByCid(containers, [3174, 200]);
  assert.deepEqual(hit, { which: 0, index: 2, element: null });
});

test('findSlotByCid: matches numeric strings and keeps the slot element', () => {
  const element = { nodeName: 'CANVAS' };
  const containers = [
    { slots: [{ index: 4, cid: '42', element }] },
  ];
  const hit = findSlotByCid(containers, ['42']);
  assert.equal(hit.which, 0);
  assert.equal(hit.index, 4);
  assert.equal(hit.element, element);
});

test('findSlotByCid: falls back to the 1-based position when the slot has no index', () => {
  const containers = [{ slots: [{ cid: 7 }, { cid: 8 }] }];
  const hit = findSlotByCid(containers, [8]);
  assert.equal(hit.index, 2, 'position fallback is 1-based');
});

test('findSlotByCid: prefers the canvas element when slot.element is absent', () => {
  const canvas = { nodeName: 'CANVAS' };
  const containers = [{ slots: [{ index: 1, cid: 5, canvas: { canvas } }] }];
  const hit = findSlotByCid(containers, [5]);
  assert.equal(hit.element, canvas);
});

test('findSlotByCid: returns null when nothing matches', () => {
  assert.equal(findSlotByCid([{ slots: [{ index: 1, cid: 1 }] }], [999]), null);
});

test('findSlotByCid: returns null on unknown shapes (degrade, no throw)', () => {
  assert.equal(findSlotByCid(null, [1]), null);
  assert.equal(findSlotByCid([], [1]), null);
  assert.equal(findSlotByCid([{ noSlots: true }], [1]), null);
  assert.equal(findSlotByCid([{ slots: 'not-an-array' }], [1]), null);
  assert.equal(findSlotByCid([{ slots: [{ index: 1 }] }], []), null);
  assert.equal(findSlotByCid([{ slots: [null] }], [1]), null);
});

test('readContainers: scans the live-probed sources in order, deduped', () => {
  const shared = { slots: [] };
  const gc = {
    containerPrototype: shared,
    backpack: { slots: [] },
    interface: { containerPrototype: shared }, // duplicate of the first source
    player: { containers: [{ slots: [] }] },
  };
  const out = readContainers(gc);
  assert.equal(out.length, 3, 'duplicate reference scanned once');
  assert.equal(out[0], gc.containerPrototype, 'probe order: containerPrototype first');
  assert.equal(out[1], gc.backpack);
  assert.equal(out[2], gc.player.containers[0]);
});

test('readContainers: tolerates a missing player/interface', () => {
  assert.deepEqual(readContainers({ backpack: { slots: [] } }).length, 1);
  assert.deepEqual(readContainers(null), []);
  assert.deepEqual(readContainers(undefined), []);
});

test('snapshotVisibleSlots: reads only the first twenty visible slots across containers', () => {
  const containers = [{ slots: Array.from({ length: 15 }, (_, i) => ({ index: i + 1, cid: i + 100 })) },
    { slots: Array.from({ length: 15 }, (_, i) => ({ index: i + 1, cid: i + 200 })) }];
  const snapshot = snapshotVisibleSlots(containers, 20);
  assert.equal(snapshot.length, 20);
  assert.deepEqual(snapshot[0].which, 0);
  assert.deepEqual(snapshot[19], { which: 1, index: 5, cid: 204, count: null, element: null });
});

test('findCreatedSlotDelta: returns only an item added or changed after the spell', () => {
  const before = [{ which: 0, index: 1, cid: 10, count: 1 }, { which: 0, index: 2, cid: null, count: null }];
  const after = [{ which: 0, index: 1, cid: 10, count: 1 }, { which: 0, index: 2, cid: 999, count: 1, element: { id: 'food' } }];
  assert.deepEqual(findCreatedSlotDelta(before, after), after[1]);
  assert.equal(findCreatedSlotDelta(before, before), null, 'unchanged pre-existing items are never candidates');
});
