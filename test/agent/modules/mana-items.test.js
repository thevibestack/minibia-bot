'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createManaItems, defaultFindSlot } = require('../../../src/agent/modules/mana-items');

function make(config = {}, opts = {}) {
  return createManaItems(Object.assign({
    config: Object.assign({ on: true, threshold: 40, slotCids: [268] }, config),
    gameClient: () => opts.gameClient || null,
  }, opts));
}

test('mana items fires at or below the configured absolute mana threshold', () => {
  const m = make({}, { findSlot: () => ({ which: 1, index: 3 }) });
  assert.deepEqual(m.decide({ mana: 40 }), { fire: true, reason: 'low-mana', item: { which: 1, index: 3 } });
  assert.equal(m.decide({ mana: 41 }).reason, 'mana-ok');
});

test('mana items fails safely for off/missing mana/missing item', () => {
  assert.equal(make({ on: false }).decide({ mana: 1 }).reason, 'off');
  assert.equal(make().decide({}).reason, 'no-mana');
  assert.equal(make({}, { findSlot: () => null }).decide({ mana: 1 }).reason, 'no-item');
});

test('mana items uses native use-on-self and falls back to mouse use', () => {
  const primary = []; const m = make({}, { gameClient: { interface: { hotbarManager: { __useItemOnSelf: (x) => primary.push(x) } } } });
  assert.equal(m.fire({ which: 0, index: 2 }), true);
  assert.deepEqual(primary, [{ which: 0, index: 2 }]);
  const fallback = []; const n = make({}, { gameClient: { mouse: { use: (x) => fallback.push(x) } } });
  assert.equal(n.fire({ which: 2, index: 4 }), true);
  assert.deepEqual(fallback, [{ which: 2, index: 4 }]);
});

test('mana items finds only configured CIDs in the live containers', () => {
  const hit = defaultFindSlot({ backpack: { slots: [{ index: 1, cid: 7618 }, { index: 2, cid: 268 }] } }, [268]);
  assert.equal(hit.index, 2);
});
