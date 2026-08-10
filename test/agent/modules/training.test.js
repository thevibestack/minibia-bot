'use strict';

/**
 * Training module unit tests (task 4.4, REQ-16): repeat-cast while the
 * vocation gate passes, pause below cost+reserve, feature-absent gate
 * degrade, and the queue-cadence contract (one cast per queue slot — proven
 * in the jsdom wiring tests).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTraining } = require('../../../src/agent/modules/training');

function moduleWith(overrides = {}, opts = {}) {
  const config = Object.assign({ on: true, slot: 7, sid: 50, reserve: 0, eatWithMagic: { enabled: false, slot: null, sid: null } }, overrides);
  return createTraining(Object.assign({
    config,
    capConfig: { capMode: 'off', capFullThreshold: 1.0, fallbackSlot: null, fallbackManaPct: 0.5 },
    readCap: () => null,
    getSpellCost: () => 25,
    canCastSpell: () => true,
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: false } }),
    now: () => 1000,
  }, opts));
}

const ctx = { mana: 200, maxMana: 220 };

test('REQ-16: gate passes + mana feasible -> training cast fires', () => {
  const m = moduleWith();
  const d = m.decide(ctx);
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'train');
  assert.equal(d.slot, 7);
});

test('REQ-16: repeat-cast — same state keeps the decision fire on every tick', () => {
  const m = moduleWith();
  assert.equal(m.decide(ctx).fire, true);
  assert.equal(m.decide(ctx).fire, true, 'cadence is enforced by the queue, not by the module');
});

test('REQ-16: below cost -> pause (insufficient)', () => {
  const m = moduleWith({}, { getSpellCost: () => 250 });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'insufficient');
});

test('REQ-16: below cost+reserve -> pause until mana recovers', () => {
  const m = moduleWith({ reserve: 100 }, { getSpellCost: () => 50 });
  assert.equal(m.decide({ ...ctx, mana: 140 }).fire, false, '200 - 50 < reserve 100... ' +
    'mana 140 - 50 = 90 < 100 -> reserve pause');
  assert.equal(m.decide({ ...ctx, mana: 140 }).reason, 'reserve');
  assert.equal(m.decide({ ...ctx, mana: 150 }).fire, true, '150 - 50 = 100 >= 100 -> fires');
});

test('REQ-16: unknown spell cost -> pause (no-cost, cannot prove feasibility)', () => {
  const m = moduleWith({}, { getSpellCost: () => null });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'no-cost');
});

test('REQ-16: __canPlayerCastSpell is the vocation gate — false pauses', () => {
  const m = moduleWith({}, { canCastSpell: () => false });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'vocation-gate');
});

test('REQ-16: vocation gate feature-absent (null) -> mana gate alone, cast proceeds', () => {
  const m = moduleWith({}, { canCastSpell: () => null });
  assert.equal(m.decide(ctx).fire, true, 'absent gate never blocks (mana feasibility still gates)');
});

test('REQ-16: GLOBAL_COOLDOWN active -> defer', () => {
  const m = moduleWith({}, {
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: true } }),
  });
  assert.equal(m.decide(ctx).reason, 'global-cooldown');
});

test('REQ-16: module OFF -> no cast', () => {
  const m = moduleWith({ on: false });
  assert.equal(m.decide(ctx).fire, false);
  assert.equal(m.decide(ctx).reason, 'off');
  assert.equal(m.isEnabled(), false);
});

test('REQ-16: no hotbar slot -> no cast', () => {
  const m = moduleWith({ slot: null });
  assert.equal(m.decide(ctx).reason, 'no-slot');
});

test('REQ-16: fire calls __handleClick via the proven firing path', () => {
  const clicks = [];
  const m = moduleWith({});
  const ok = m.fire({ slot: 7 }, {
    gameClient: { interface: { hotbarManager: { __handleClick: (slot) => clicks.push(slot) } } },
    document: null,
  });
  assert.equal(ok, true);
  assert.deepEqual(clicks, [7]);
});

/* ------------------------- PR 4 (REQ-30/31/32, D2/D3/D4) ------------------------- */

/** Strict-cap module: capMode strict, threshold 1.0, fallback slot 3 at 50% mana. */
function capModule(overrides = {}, opts = {}) {
  return moduleWith({}, Object.assign({
    capConfig: Object.assign({
      capMode: 'strict',
      capFullThreshold: 1.0,
      fallbackSlot: 3,
      fallbackManaPct: 0.5,
    }, overrides.capConfig || {}),
    readCap: overrides.readCap || (() => ({ capacity: 400, maxCapacity: 400, ratio: 1, source: 'state' })),
  }, opts));
}

test('REQ-30 (D3): strict cap FULL (ratio >= threshold) stops rune-making — idle + state.capFull', () => {
  const m = capModule();
  const d = m.decide({ mana: 200, maxMana: 500 }); // 40% < fallback 50% -> idle
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'cap-full-idle');
  assert.equal(m.getState().capFull, true, 'capFull flows to the snapshot (panel alert path)');
  assert.equal(m.getState().cap.ratio, 1);
});

test('REQ-30 (D3): cap NOT full -> the training cast proceeds normally', () => {
  const m = capModule({ readCap: () => ({ capacity: 209, maxCapacity: 400, ratio: 209 / 400, source: 'state' }) });
  const d = m.decide(ctx);
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'train');
  assert.equal(d.kind, 'training');
  assert.equal(m.getState().capFull, false);
});

test('REQ-30 (D3): cap data ABSENT (ratio null) -> degrade, no cap enforcement', () => {
  const m = capModule({ readCap: () => ({ capacity: null, maxCapacity: null, ratio: null, source: 'none' }) });
  const d = m.decide(ctx);
  assert.equal(d.fire, true, 'unknown cap never blocks rune-making (feature-detect degrade)');
  assert.equal(m.getState().capFull, false);
  assert.equal(m.getState().cap.source, 'none');
});

test('REQ-30 (D3): capMode OFF -> no cap enforcement even at ratio 1.0', () => {
  const m = capModule({ capConfig: { capMode: 'off' } });
  const d = m.decide(ctx);
  assert.equal(d.fire, true);
  assert.equal(m.getState().capFull, false);
});

test('REQ-30 (D3): cap full + mana >= fallback% -> the fallback spell casts (slot)', () => {
  const m = capModule();
  const d = m.decide({ mana: 300, maxMana: 500 });
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'fallback');
  assert.equal(d.slot, 3);
  assert.equal(d.reason, 'cap-full-fallback');
  assert.equal(m.getState().capFull, true);
});

test('REQ-30 (D3): cap full + mana < fallback% -> trainer idles until mana recovers', () => {
  const m = capModule();
  const d = m.decide({ mana: 200, maxMana: 500 }); // 40% < 50%
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'cap-full-idle');
  // mana recovers above the 50% mark -> fallback fires
  const d2 = m.decide({ mana: 260, maxMana: 500 }); // 52% >= 50%
  assert.equal(d2.fire, true);
  assert.equal(d2.kind, 'fallback');
});

test('REQ-30 (D3): cap full with NO fallback slot -> idle regardless of mana', () => {
  const m = capModule({ capConfig: { fallbackSlot: null } });
  const d = m.decide({ mana: 400, maxMana: 500 });
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'cap-full-idle');
});

test('REQ-30 (D3): cap-full fallback respects the global cooldown (no bypass)', () => {
  const m = capModule({}, {
    readCooldown: () => ({ cooldown: { active: false }, globalCooldown: { active: true } }),
  });
  const d = m.decide({ mana: 400, maxMana: 500 });
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'global-cooldown');
});

test('REQ-30 (D3): the fallback checks NO per-spell cooldown — slot-driven, global only (fallbackSid dropped)', () => {
  // Post-chain maintenance (obs 10502): fallbackSid never resolved a slot and
  // was dropped. The fallback passes a NULL sid to the cooldown reader — the
  // adapter's null-sid contract returns NO per-spell cooldown (v1 precedent:
  // null sid -> cd null), so an ACTIVE per-spell cooldown for any REAL sid
  // must not block it; GLOBAL_COOLDOWN still gates. The queue's min-interval
  // throttle + jitter keep the pacing (proven in queue.test.js +
  // bootstrap.test.js e2e).
  const m = capModule({}, {
    // Models the real adapter: per-spell cooldown data exists ONLY for a
    // concrete sid; a null sid yields none (never invented for the fallback).
    readCooldown: (sid) => ({
      cooldown: sid === null || sid === undefined ? null : { active: true },
      globalCooldown: { active: false },
    }),
  });
  const d = m.decide({ mana: 400, maxMana: 500 });
  assert.equal(d.fire, true, 'the null-sid fallback verdict never consults a per-spell cooldown');
  assert.equal(d.kind, 'fallback');
  assert.equal(d.slot, 3);
  assert.equal(d.reason, 'cap-full-fallback');

  // Same adapter, GLOBAL_COOLDOWN active: the fallback defers (no bypass).
  const m2 = capModule({}, {
    readCooldown: (sid) => ({
      cooldown: sid === null || sid === undefined ? null : { active: true },
      globalCooldown: { active: true },
    }),
  });
  assert.equal(m2.decide({ mana: 400, maxMana: 500 }).fire, false, 'global cooldown still gates the fallback');
});

test('REQ-31 (D2): per-module reserve — cost 200 + reserve 30 -> waits for mana >= 230', () => {
  // The spec acceptance scenario verbatim: mana=210 must NOT cast; 230 must.
  const m = moduleWith({ reserve: 30 }, { getSpellCost: () => 200 });
  assert.equal(m.decide({ mana: 210, maxMana: 300 }).fire, false, '210 < 230 -> reserve pause');
  assert.equal(m.decide({ mana: 210, maxMana: 300 }).reason, 'reserve');
  assert.equal(m.decide({ mana: 230, maxMana: 300 }).fire, true, '230 >= 200 + 30 -> fires');
});

test('REQ-32 (D4): mana low + eat-with-magic -> an eat-magic decision (magic-food slot) enqueues instead of casting', () => {
  const m = moduleWith(
    { reserve: 30, eatWithMagic: { enabled: true, slot: 5, sid: 12 } },
    { getSpellCost: () => 200 },
  );
  const d = m.decide({ mana: 210, maxMana: 300 });
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'eat-magic');
  assert.equal(d.slot, 5);
  assert.equal(d.reason, 'eat-magic');
});

test('REQ-32 (D4): eat-with-magic OFF -> mana low means the trainer waits', () => {
  const m = moduleWith({ reserve: 30, eatWithMagic: { enabled: false, slot: 5, sid: 12 } }, { getSpellCost: () => 200 });
  const d = m.decide({ mana: 210, maxMana: 300 });
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'reserve');
});

test('REQ-32 (D4): eat-magic requires a valid slot — configured without one, the trainer waits', () => {
  const m = moduleWith({ reserve: 30, eatWithMagic: { enabled: true, slot: null, sid: 12 } }, { getSpellCost: () => 200 });
  const d = m.decide({ mana: 210, maxMana: 300 });
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'reserve');
});

test('REQ-32 (D4): eat-magic fires the magic-food slot via the proven firing path', () => {
  const clicks = [];
  const m = moduleWith(
    { reserve: 30, eatWithMagic: { enabled: true, slot: 5, sid: 12 } },
    { getSpellCost: () => 200 },
  );
  const ok = m.fire({ kind: 'eat-magic', slot: 5 }, {
    gameClient: { interface: { hotbarManager: { __handleClick: (slot) => clicks.push(slot) } } },
    document: null,
  });
  assert.equal(ok, true);
  assert.deepEqual(clicks, [5]);
});

test('REQ-30 (D3): the capFull state resets when the cap no longer reads full', () => {
  let cap = { capacity: 400, maxCapacity: 400, ratio: 1, source: 'state' };
  const m = capModule({ readCap: () => cap });
  assert.equal(m.decide({ mana: 200, maxMana: 500 }).reason, 'cap-full-idle');
  assert.equal(m.getState().capFull, true);
  cap = { capacity: 200, maxCapacity: 400, ratio: 0.5, source: 'state' };
  const d = m.decide({ mana: 300, maxMana: 500 });
  assert.equal(d.fire, true, 'cap recovered -> training proceeds');
  assert.equal(m.getState().capFull, false, 'stale capFull never persists');
});
