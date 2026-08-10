'use strict';

/**
 * PR 6 — attack skeleton module tests (REQ-35, D10, task 6.1): the ATTACK
 * module is STATE-ONLY — targeting choice (lowest HP / nearest) + offensive
 * spell/rune pickers config with `skeleton: true` disclosure and NO combat
 * loop (combatLoop: false, no tree/queue/game surface). Unit state only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createAttackModule,
  normalizeTargeting,
  normalizeSid,
  normalizeSlot,
  TARGETING_OPTIONS,
  DEFAULT_TARGETING,
} = require('../../../src/agent/modules/attack');

function makeModule(config) {
  return createAttackModule({ config: config || {} });
}

test('REQ-35: skeleton state — disclosure, no combat loop', () => {
  const mod = makeModule({ on: true, targeting: 'lowest-hp' });
  const st = mod.getState();
  assert.equal(st.skeleton, true, 'module discloses the skeleton');
  assert.equal(st.disclosure, 'skeleton — limited', 'REQ-35: UI discloses limited functionality');
  assert.equal(st.combatLoop, false, 'no full combat loop in the skeleton');
});

test('REQ-35: targeting choice — lowest HP (default) and nearest pass through', () => {
  assert.equal(TARGETING_OPTIONS.indexOf('lowest-hp') !== -1, true);
  assert.equal(TARGETING_OPTIONS.indexOf('nearest') !== -1, true);
  const low = makeModule({ on: true, targeting: 'lowest-hp' }).getState();
  assert.equal(low.targeting, 'lowest-hp');
  const near = makeModule({ on: true, targeting: 'nearest' }).getState();
  assert.equal(near.targeting, 'nearest');
});

test('REQ-35: invalid/absent targeting falls back to the default (never crashes)', () => {
  for (const bad of [undefined, null, '', 'random', 42, {}, []]) {
    const st = makeModule({ on: true, targeting: bad }).getState();
    assert.equal(st.targeting, DEFAULT_TARGETING, 'bad targeting -> ' + String(bad));
  }
});

test('REQ-35: offensive spell sid normalizes — integer >= 0 only', () => {
  assert.equal(normalizeSid(61), 61);
  assert.equal(normalizeSid('61'), 61, 'numeric strings normalize');
  assert.equal(normalizeSid(null), null);
  assert.equal(normalizeSid(undefined), null);
  assert.equal(normalizeSid(-1), null, 'negative sid is invalid');
  assert.equal(normalizeSid(1.5), null, 'non-integer sid is invalid');
  assert.equal(normalizeSid(''), null, 'empty string is invalid');
});

test('REQ-35: offensive rune slot normalizes — integer 1-12 only', () => {
  assert.equal(normalizeSlot(3), 3);
  assert.equal(normalizeSlot('3'), 3, 'numeric strings normalize');
  assert.equal(normalizeSlot(null), null);
  assert.equal(normalizeSlot(0), null, 'slot 0 is invalid');
  assert.equal(normalizeSlot(13), null, 'slot 13 is invalid');
  assert.equal(normalizeSlot(1.5), null, 'non-integer slot is invalid');
});

test('REQ-35: getState carries the configured pickers + on flag', () => {
  const st = makeModule({ on: true, targeting: 'nearest', sid: 12, runeSlot: 5 }).getState();
  assert.equal(st.on, true);
  assert.deepEqual(st.spell, { sid: 12 });
  assert.deepEqual(st.rune, { slot: 5 });
});

test('REQ-35: off module — state reports on:false, isEnabled false', () => {
  const mod = makeModule({ on: false, targeting: 'nearest' });
  assert.equal(mod.isEnabled(), false);
  assert.equal(mod.getState().on, false);
  // The skeleton disclosure stays honest even when off.
  assert.equal(mod.getState().skeleton, true);
});

test('REQ-35: no module object -> defaults (empty config never crashes)', () => {
  const mod = createAttackModule();
  const st = mod.getState();
  assert.equal(st.on, false);
  assert.equal(st.targeting, DEFAULT_TARGETING);
  assert.equal(st.combatLoop, false);
});
