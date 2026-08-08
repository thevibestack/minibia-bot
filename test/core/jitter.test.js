'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { clampJitter, randomDelay, JITTER_MIN, JITTER_MAX } = require('../../src/core/jitter');

test('REQ-13: default range stays untouched', () => {
  const r = clampJitter(50, 400);
  assert.deepEqual({ min: r.min, max: r.max }, { min: 50, max: 400 });
  assert.equal(r.swapped, false);
  assert.equal(r.clamped, false);
});

test('REQ-13: out-of-domain range 0-10 is clamped to the default [50, 400]', () => {
  const r = clampJitter(0, 10);
  assert.deepEqual({ min: r.min, max: r.max }, { min: 50, max: 400 });
  assert.equal(r.swapped, false);
  assert.equal(r.clamped, true);
});

test('REQ-13: range entirely above the domain falls back to default', () => {
  const r = clampJitter(500, 600);
  assert.deepEqual({ min: r.min, max: r.max }, { min: 50, max: 400 });
  assert.equal(r.clamped, true);
});

test('REQ-13: inverted bounds 400-50 are swapped', () => {
  const r = clampJitter(400, 50);
  assert.deepEqual({ min: r.min, max: r.max }, { min: 50, max: 400 });
  assert.equal(r.swapped, true);
  assert.equal(r.clamped, false);
});

test('REQ-13: partial out-of-range bounds are clamped individually', () => {
  const r = clampJitter(30, 500);
  assert.deepEqual({ min: r.min, max: r.max }, { min: 50, max: 400 });
  assert.equal(r.clamped, true);
});

test('REQ-13: in-domain custom range is preserved', () => {
  const r = clampJitter(120, 250);
  assert.deepEqual({ min: r.min, max: r.max }, { min: 120, max: 250 });
  assert.equal(r.swapped, false);
  assert.equal(r.clamped, false);
});

test('REQ-13: degenerate single-point range is widened to stay non-constant', () => {
  const r = clampJitter(150, 150);
  assert.ok(r.max > r.min);
  assert.equal(r.clamped, true);
});

test('REQ-13: non-numeric bounds fall back to the default range', () => {
  const r = clampJitter(Number.NaN, 'oops');
  assert.deepEqual({ min: r.min, max: r.max }, { min: 50, max: 400 });
  assert.equal(r.clamped, true);
});

test('REQ-13: 100 delays with default range are all within [50, 400] and not constant', () => {
  const delays = [];
  for (let i = 0; i < 100; i++) {
    delays.push(randomDelay(JITTER_MIN, JITTER_MAX));
  }
  for (const d of delays) {
    assert.ok(d >= 50 && d <= 400, `delay ${d} outside [50, 400]`);
  }
  assert.ok(new Set(delays).size > 1, 'all 100 delays were identical');
});

test('REQ-13: randomDelay honors injectable RNG and inclusive bounds', () => {
  const rng = () => 0.999; // should produce the max value
  assert.equal(randomDelay(50, 400, rng), 400);
  assert.equal(randomDelay(50, 400, () => 0), 50);
});
