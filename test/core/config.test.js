'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeConfig } = require('../../src/core/config');

test('empty input yields canonical defaults', () => {
  const { config, errors } = normalizeConfig({}, {}, 120);
  assert.deepEqual(config.jitter, { min: 50, max: 400 });
  assert.deepEqual(config.firing, { mode: 'handleClick' });
  assert.deepEqual(config.validation, { enabled: true, windowMs: 2500, pollMs: 100 });
  assert.deepEqual(config.spells, []);
  assert.equal(config.food.warningWindowSec, 60);
  assert.equal(config.food.fallbackIntervalSec, 10);
  assert.equal(config.food.slot, null);
  assert.deepEqual(errors, []);
});

test('REQ-13: jitter clamp semantics are delegated to jitter.js', () => {
  const { config, errors } = normalizeConfig({ jitter: { min: 0, max: 10 } }, {}, 120);
  assert.deepEqual(config.jitter, { min: 50, max: 400 });
  assert.deepEqual(errors, []);
});

test('REQ-13: inverted jitter bounds are swapped', () => {
  const { config } = normalizeConfig({ jitter: { min: 400, max: 50 } }, {}, 120);
  assert.deepEqual(config.jitter, { min: 50, max: 400 });
});

test('REQ-12: threshold above maxMana is rejected with inline error and previous value kept', () => {
  const prev = {
    spells: [{ slot: 4, word: 'adori', threshold: 20, reserve: 10, repeat: 1, order: 0 }],
  };
  const { config, errors } = normalizeConfig(
    { spells: [{ slot: 4, word: 'adori', threshold: 5000, reserve: 10 }] },
    prev,
    120,
  );
  assert.equal(config.spells[0].threshold, 20, 'previous threshold must be kept');
  assert.equal(config.spells[0].reserve, 10);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /threshold 5000 exceeds maxMana 120/);
});

test('REQ-12: reserve above maxMana is rejected with inline error and previous value kept', () => {
  const prev = {
    spells: [{ slot: 2, word: 'utani', threshold: 5, reserve: 15, repeat: 1, order: 1 }],
  };
  const { config, errors } = normalizeConfig(
    { spells: [{ slot: 2, word: 'utani', threshold: 5, reserve: 999 }] },
    prev,
    120,
  );
  assert.equal(config.spells[0].reserve, 15, 'previous reserve must be kept');
  assert.equal(config.spells[0].threshold, 5);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reserve 999 exceeds maxMana 120/);
});

test('REQ-12: threshold equal to maxMana is accepted', () => {
  const { config, errors } = normalizeConfig({ spells: [{ slot: 4, threshold: 120, reserve: 0 }] }, {}, 120);
  assert.equal(config.spells[0].threshold, 120);
  assert.deepEqual(errors, []);
});

test('REQ-12: rejected value with no previous entry falls back to default 0', () => {
  const { config, errors } = normalizeConfig({ spells: [{ slot: 7, threshold: 200 }] }, {}, 120);
  assert.equal(config.spells[0].threshold, 0);
  assert.equal(errors.length, 1);
});

test('spell defaults fill missing fields', () => {
  const { config } = normalizeConfig({ spells: [{ slot: 3, word: 'exura' }] }, {}, 120);
  const spell = config.spells[0];
  assert.equal(spell.slot, 3);
  assert.equal(spell.word, 'exura');
  assert.equal(spell.validationWord, 'exura');
  assert.equal(spell.threshold, 0);
  assert.equal(spell.reserve, 0);
  assert.equal(spell.repeat, 1);
  assert.equal(spell.order, 0);
  assert.equal(spell.cooldownMs, 0);
  assert.equal(spell.sid, null);
});

test('string numeric inputs are coerced', () => {
  const { config } = normalizeConfig(
    { spells: [{ slot: '4', threshold: '20', repeat: '3' }], jitter: { min: '60', max: '120' } },
    {},
    120,
  );
  assert.equal(config.spells[0].slot, 4);
  assert.equal(config.spells[0].threshold, 20);
  assert.equal(config.spells[0].repeat, 3);
  assert.deepEqual(config.jitter, { min: 60, max: 120 });
});

test('invalid firing mode falls back to previous then default', () => {
  const { config } = normalizeConfig({ firing: { mode: 'telepathy' } }, {}, 120);
  assert.equal(config.firing.mode, 'handleClick');
  const { config: c2 } = normalizeConfig(
    { firing: { mode: 'telepathy' } },
    { firing: { mode: 'keyboard' } },
    120,
  );
  assert.equal(c2.firing.mode, 'keyboard');
});

test('food defaults and overrides', () => {
  const { config } = normalizeConfig(
    { food: { slot: 8, cid: 3582, name: 'seasoned ham', warningWindowSec: 30, fallbackIntervalSec: 5 } },
    {},
    120,
  );
  assert.equal(config.food.slot, 8);
  assert.equal(config.food.cid, 3582);
  assert.equal(config.food.warningWindowSec, 30);
  assert.equal(config.food.fallbackIntervalSec, 5);
});

test('validation overrides', () => {
  const { config } = normalizeConfig(
    { validation: { enabled: false, windowMs: 1000, pollMs: 50 } },
    {},
    120,
  );
  assert.deepEqual(config.validation, { enabled: false, windowMs: 1000, pollMs: 50 });
});
