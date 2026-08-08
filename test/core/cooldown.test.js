'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canFire } = require('../../src/core/cooldown');

test('REQ-02: no cooldown active -> firing proceeds', () => {
  const v = canFire({ cooldown: { active: false }, globalCooldown: { active: false } });
  assert.equal(v.fire, true);
  assert.equal(v.source, 'client');
  assert.equal(v.reason, 'ok');
});

test('REQ-02: GLOBAL_COOLDOWN active -> deferred to next tick, never fires', () => {
  const v = canFire({
    cooldown: { active: false },
    globalCooldown: { active: true, seconds: 0.4 },
  });
  assert.equal(v.fire, false);
  assert.equal(v.source, 'client');
  assert.equal(v.reason, 'global-cooldown');
  assert.equal(v.waitMs, 400);
});

test('REQ-02: global cooldown wins over a free per-spell slot', () => {
  const v = canFire({
    cooldown: { active: false },
    globalCooldown: { active: true, seconds: 1 },
  });
  assert.equal(v.fire, false);
  assert.equal(v.reason, 'global-cooldown');
});

test('REQ-02: per-spell cooldown active -> deferred with wait', () => {
  const v = canFire({
    cooldown: { active: true, seconds: 2.5 },
    globalCooldown: { active: false },
  });
  assert.equal(v.fire, false);
  assert.equal(v.reason, 'cooldown');
  assert.equal(v.waitMs, 2500);
});

test('REQ-02: spellbook.cooldowns unavailable -> config fallback pacing used, gap logged', () => {
  const gaps = [];
  const now = 1_000_000;
  const v = canFire({
    cooldown: null, // client data absent
    globalCooldown: null,
    cooldownMs: 5000,
    lastFiredAt: now - 1000, // fired 1s ago -> 4s left
    now,
    onGapLog: (m) => gaps.push(m),
  });
  assert.equal(v.fire, false);
  assert.equal(v.source, 'fallback');
  assert.equal(v.reason, 'fallback-pacing');
  assert.equal(v.waitMs, 4000);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /cooldown data absent/);
});

test('REQ-02: fallback pacing elapses -> fires with no gap log', () => {
  const gaps = [];
  const now = 1_000_000;
  const v = canFire({
    cooldown: null,
    cooldownMs: 5000,
    lastFiredAt: now - 6000, // 6s ago, beyond the 5s fallback
    now,
    onGapLog: (m) => gaps.push(m),
  });
  assert.equal(v.fire, true);
  assert.equal(v.source, 'fallback');
  assert.equal(v.reason, 'ok');
  assert.equal(gaps.length, 0, 'no gap log when fallback does not gate');
});

test('REQ-02: never fired before -> fallback allows the first cast', () => {
  const v = canFire({ cooldown: null, cooldownMs: 5000, lastFiredAt: 0, now: 500 });
  assert.equal(v.fire, true);
});

test('REQ-02: explicit client inactive state is authoritative over fallback', () => {
  const v = canFire({
    cooldown: { active: false },
    globalCooldown: { active: false },
    cooldownMs: 5000,
    lastFiredAt: 0,
    now: 10,
  });
  assert.equal(v.fire, true);
  assert.equal(v.source, 'client');
});
