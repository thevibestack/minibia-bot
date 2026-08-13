'use strict';

/**
 * Rune module unit tests (task 4.3, REQ-15): native-window defer (no
 * double-fire), fire-on-expiry, the "no native rune data" degrade (design D7
 * — NO invented fallback loop), global-cooldown respect and the heal
 * threshold extension.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRunes, toMs } = require('../../../src/agent/modules/runes');

function moduleWith(overrides = {}, opts = {}) {
  const config = Object.assign({ on: true, attackSlot: 4, healSlot: null, healThreshold: null, reserve: 0 }, overrides);
  let nowMs = 100000;
  return createRunes(Object.assign({
    config,
    readRuneTimers: () => ({ attackUntil: null, healUntil: null }),
    readGlobalCooldown: () => ({ active: false }),
    readAfterFireWait: () => 0,
    getSpellCost: () => null,
    now: () => nowMs,
  }, opts));
}

test('REQ-15: window expired + cooldown clear -> attack rune fires on the rune slot', () => {
  const m = moduleWith();
  const d = m.decide({ health: 100 });
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'attack-window-expired');
  assert.equal(d.slot, 4);
  assert.equal(d.kind, 'rune-attack');
});

test('REQ-15: native rune window ACTIVE -> defers, never double-fires', () => {
  const m = moduleWith({}, {
    readRuneTimers: () => ({ attackUntil: 100500, healUntil: null }), // active until t+500
  });
  const d = m.decide({ health: 100 });
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'native-window-active');
});

test('REQ-15: heal window active defers even when the attack window is expired', () => {
  const m = moduleWith({ healSlot: 3, healThreshold: 40 }, {
    readRuneTimers: () => ({ attackUntil: null, healUntil: 100500 }),
  });
  assert.equal(m.decide({ health: 20 }).reason, 'native-window-active');
});

test('REQ-15: no double-fire after a fire — post-fire wait respected', () => {
  const m = moduleWith({}, { readAfterFireWait: () => 3000, now: () => 200000 });
  m.fire({ slot: 4, kind: 'rune-attack' }, { gameClient: null, document: null });
  // immediately after firing, t - lastFireAt < 3000 -> deferred
  assert.equal(m.decide({ health: 100 }).fire, false);
  assert.equal(m.decide({ health: 100 }).reason, 'after-fire-wait');
});

test('REQ-15: global cooldown active -> rune defers', () => {
  const m = moduleWith({}, { readGlobalCooldown: () => ({ active: true, seconds: 0.5 }) });
  assert.equal(m.decide({ health: 100 }).fire, false);
  assert.equal(m.decide({ health: 100 }).reason, 'global-cooldown');
});

test('REQ-15: absent native timers -> recorded degrade, NEVER fires (no fallback loop)', () => {
  const m = moduleWith({}, { readRuneTimers: () => null });
  assert.equal(m.decide({ health: 100 }).fire, false);
  assert.equal(m.decide({ health: 100 }).reason, 'no-native-rune-data');
  const st = m.getState();
  assert.equal(st.available, false);
  assert.equal(st.reason, 'no native rune data');
});

test('REQ-15: module OFF -> no fire; state reports off', () => {
  const m = moduleWith({ on: false });
  assert.equal(m.decide({ health: 100 }).fire, false);
  assert.equal(m.decide({ health: 100 }).reason, 'off');
  assert.equal(m.getState().on, false);
  assert.equal(m.getState().reason, 'off');
});

test('REQ-15: no rune slot configured -> no fire', () => {
  const m = moduleWith({ attackSlot: null, healSlot: null });
  assert.equal(m.decide({ health: 100 }).reason, 'no-slot');
});

test('REQ-15: rune heal fires only while health <= healThreshold (design extension)', () => {
  const m = moduleWith({ attackSlot: 4, healSlot: 3, healThreshold: 40 });
  assert.equal(m.decide({ health: 30 }).fire, true);
  assert.equal(m.decide({ health: 30 }).kind, 'rune-heal');
  assert.equal(m.decide({ health: 30 }).slot, 3);
  // healthy -> the attack rune cycles instead
  const d = m.decide({ health: 80 });
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'rune-attack');
});

test('REQ-15: healSlot without a threshold never fires the heal rune', () => {
  const m = moduleWith({ attackSlot: null, healSlot: 3, healThreshold: null });
  const d = m.decide({ health: 5 });
  assert.equal(d.fire, false, 'heal threshold absent => heal rune disabled (documented)');
  assert.equal(d.reason, 'no-candidate');
});

test('REQ-15: unknown health with a heal threshold -> attack rune only', () => {
  const m = moduleWith({ attackSlot: 4, healSlot: 3, healThreshold: 40 });
  const d = m.decide({ health: null });
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'rune-attack', 'cannot prove low hp => heal rune skipped');
});

test('REQ-15: fire calls __handleClick on the rune slot and records lastFireAt', () => {
  const clicks = [];
  const m = moduleWith({}, { now: () => 777000 });
  const ok = m.fire({ slot: 4, kind: 'rune-attack' }, {
    gameClient: { interface: { hotbarManager: { __handleClick: (index) => clicks.push(index + 1) } } },
    document: null,
  });
  assert.equal(ok, true);
  assert.deepEqual(clicks, [4]);
  assert.equal(m.getState().lastFireAt, 777000);
});

test('toMs: coerces numbers, Dates and numeric strings; null stays null', () => {
  assert.equal(toMs(123), 123);
  assert.equal(toMs('456'), 456);
  assert.equal(toMs(new Date(789)), 789);
  assert.equal(toMs(null), null);
  assert.equal(toMs(undefined), null);
  assert.equal(toMs('nope'), null);
});

/* ------------------------- PR 4 (REQ-31, D2): per-module reserve ------------------------- */

test('REQ-31 (D2): rune cast honors the per-module reserve — cost 200 + reserve 30 -> wait for mana >= 230', () => {
  const m = moduleWith({ reserve: 30 }, { getSpellCost: () => 200 });
  const d = m.decide({ health: 100, mana: 210, maxMana: 300 });
  assert.equal(d.fire, false, '210 < 200 + 30 -> rune defers (REQ-31 scenario)');
  assert.equal(d.reason, 'rune-reserve');
  assert.equal(m.getState().reason, 'rune-reserve', 'state surfaces the reserve gate');
  const d2 = m.decide({ health: 100, mana: 230, maxMana: 300 });
  assert.equal(d2.fire, true, '230 >= 200 + 30 -> fires');
  assert.equal(d2.kind, 'rune-attack');
});

test('REQ-31 (D2): rune reserve gate degrades — cost or mana unknown never blocks', () => {
  // Cost unresolvable (getSpellCost null) -> the gate is skipped.
  const noCost = moduleWith({ reserve: 30 });
  assert.equal(noCost.decide({ health: 100, mana: 1 }).fire, true, 'unknown cost -> skip the gate');
  // Mana unknown -> skipped too.
  const costKnown = moduleWith({ reserve: 30 }, { getSpellCost: () => 200 });
  assert.equal(costKnown.decide({ health: 100 }).fire, true, 'unknown mana -> skip the gate');
  // reserve 0 -> no gate at all (default behavior untouched).
  const noReserve = moduleWith({}, { getSpellCost: () => 200 });
  assert.equal(noReserve.decide({ health: 100, mana: 1, maxMana: 300 }).fire, true, 'reserve 0 -> plain fire');
});

test('REQ-31 (D2): the heal rune honors the reserve before firing', () => {
  const m = moduleWith({ attackSlot: null, healSlot: 3, healThreshold: 40, reserve: 30 }, { getSpellCost: () => 200 });
  assert.equal(m.decide({ health: 20, mana: 210, maxMana: 300 }).fire, false, 'heal rune due but below cost+reserve');
  assert.equal(m.decide({ health: 20, mana: 230, maxMana: 300 }).fire, true);
});
