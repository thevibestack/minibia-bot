'use strict';

/**
 * Eat module unit tests (task 4.5, REQ-17): SATED flag primary, skill-window
 * timer fallback, every-N-casts forced cadence, the fallback interval when
 * both are unavailable, and the 3-consecutive-failures pause. The proven
 * eater (adapters/eat) does the attempt; the module adapts the userscript
 * readFoodState/resolveFoodItem patterns to the agent context.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEatModule } = require('../../../src/agent/modules/eat');

function moduleWith(overrides = {}, opts = {}) {
  const config = Object.assign({
    on: true, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [],
    safetyNetMinutes: 20, magic: { enabled: false, slot: null, sid: null },
  }, overrides);
  let nowMs = 500000;
  return createEatModule(Object.assign({
    config,
    gameClient: () => opts.gameClient || null,
    document: opts.document || null,
    now: () => (typeof opts.now === 'function' ? opts.now() : nowMs),
    log: { warn: () => {} },
  }, opts));
}

/** gameClient with a conditions Set; mouse.use records calls. */
function gcWith(conditionsHas, useCalls = null) {
  const gc = {
    player: { conditions: { has: (k) => conditionsHas(k) } },
    mouse: { use: (args) => { if (useCalls) useCalls.push(args); } },
  };
  return gc;
}

test('REQ-17: SATED true -> no eat', () => {
  const m = moduleWith({}, { gameClient: gcWith(() => true) });
  const d = m.decide({});
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'sated');
});

test('REQ-17: SATED false -> eat (flag source)', () => {
  const m = moduleWith({}, { gameClient: gcWith(() => false) });
  const d = m.decide({});
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'flag');
});

test('REQ-17: SATED unavailable -> skill-window timer fallback (<= warning window eats)', () => {
  const timer = { textContent: '0:45' }; // 45s <= 60s warning window
  const doc = { querySelector: () => timer };
  const m = moduleWith({}, { document: doc });
  assert.equal(m.decide({}).fire, true);
  assert.equal(m.decide({}).reason, 'timer');

  const timerHigh = { textContent: '2:00' }; // 120s > 60s
  const m2 = moduleWith({}, { document: { querySelector: () => timerHigh } });
  assert.equal(m2.decide({}).fire, false);
  assert.equal(m2.decide({}).reason, 'sated'); // timer present, above window => eat:false
});

test('REQ-17: expired timer (0:00) eats via the timer path', () => {
  const m = moduleWith({}, { document: { querySelector: () => ({ textContent: '0:00' }) } });
  const d = m.decide({});
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'expired');
});

test('REQ-17: SATED + timer both unavailable -> fallback interval (default 10s)', () => {
  let nowMs = 100000;
  const m = moduleWith({}, { now: () => nowMs });
  assert.equal(m.decide({ lastEatAt: 99000 }).fire, false, '1s since last eat -> fallback-wait');
  assert.equal(m.decide({ lastEatAt: 99000 }).reason, 'fallback-wait');
  nowMs = 111000;
  assert.equal(m.decide({ lastEatAt: 99000 }).fire, true, '12s >= 10s -> fallback-interval');
  assert.equal(m.decide({ lastEatAt: 99000 }).reason, 'fallback-interval');
});

test('REQ-06 (PR 3): everyCasts is an OR trigger, never a gate — hunger wins below N, force lands at N', () => {
  const hungry = moduleWith({ everyCasts: 5 }, { gameClient: gcWith(() => false) });
  assert.equal(hungry.decide({ castsSinceFood: 4 }).fire, true, 'hunger is not gated by the cast cadence');
  assert.equal(hungry.decide({ castsSinceFood: 4 }).reason, 'flag');
  const sated = moduleWith({ everyCasts: 5 }, { gameClient: gcWith(() => true) });
  assert.equal(sated.decide({ castsSinceFood: 4 }).fire, false, 'below N + sated -> no force');
  assert.equal(sated.decide({ castsSinceFood: 4 }).reason, 'sated');
  const d = sated.decide({ castsSinceFood: 5 });
  assert.equal(d.fire, true, 'sated but everyCasts bypasses the pre-check at N');
  assert.equal(d.force, true);
  assert.equal(d.kind, 'eat');
});

test('REQ-17: forced fire resets the cast counter after the attempt', () => {
  const m = moduleWith({ everyCasts: 5 });
  const ctx = { castsSinceFood: 5, lastEatAt: 0 };
  m.fire(ctx, { force: true });
  assert.equal(ctx.castsSinceFood, 0, 'forced cadence resets after the attempt (userscript semantics)');
});

test('REQ-17: a confirmed eat records lastEatAt on the context', () => {
  // No conditions data + an executed mouse.use attempt => trusted 'ate'
  // (proven eater semantics: satedNow === null trusts the executed attempt).
  const useCalls = [];
  const gc = { mouse: { use: (args) => useCalls.push(args) } };
  const m = moduleWith({}, { gameClient: gc });
  const ctx = { castsSinceFood: 0, lastEatAt: 0 };
  const ok = m.fire(ctx, { force: false });
  assert.equal(ok, true, 'attempt executed via mouse.use fallback');
  assert.ok(ctx.lastEatAt > 0, 'confirmed eat anchors the fallback interval');
});

test('REQ-17: module OFF -> zero actions', () => {
  const m = moduleWith({ on: false });
  assert.equal(m.decide({ castsSinceFood: 99 }).fire, false);
  assert.equal(m.decide({}).reason, 'off');
  assert.equal(m.isEnabled(), false);
});

test('REQ-17: 3 consecutive failed attempts pause eating and surface the alert', () => {
  // Failures: attempt executes but SATED stays false ('not-sated') — the
  // conditions flag never flips, so every attempt is a failure.
  const gc = gcWith(() => false);
  const m = moduleWith({}, { gameClient: gc });
  const ctx = { castsSinceFood: 0, lastEatAt: 0 };
  assert.equal(m.decide({}).fire, true, 'hungry');
  assert.equal(m.fire(ctx, { force: false }), false, 'attempt failed (not-sated)');
  assert.equal(m.fire(ctx, { force: false }), false);
  assert.equal(m.getState().paused, false, 'pause only at the 3rd consecutive failure');
  assert.equal(m.fire(ctx, { force: false }), false);
  const st = m.getState();
  assert.equal(st.paused, true, '3rd failure pauses eating (REQ-17)');
  assert.equal(st.failures, 3);
  assert.ok(st.alert, 'panel-facing alert recorded');
  assert.equal(m.decide({}).fire, false, 'paused module takes no action');
  assert.equal(m.decide({}).reason, 'paused');
});

test('REQ-17: resolveFoodItem finds food by cid in the probe-order containers', () => {
  const gc = {
    backpack: { slots: [{ index: 1, cid: 999 }, { index: 2, cid: 111 }] },
    mouse: { use: () => {} },
  };
  const m = moduleWith({ cids: [111] }, { gameClient: gc });
  const ctx = { castsSinceFood: 0, lastEatAt: 0 };
  assert.equal(m.fire(ctx, { force: false }), true, 'eat via mouse.use with the found slot');
});

test('REQ-17: resolveFoodItem falls back to the userscript slot-index path', () => {
  const element = { dispatchEvent: () => {}, click: () => {} };
  const gc = { containerPrototype: { slots: [{ element, index: 1 }, {}, {}] } };
  const m = moduleWith({ slot: 1 }, { gameClient: gc });
  // contextmenu path needs a "Use" entry in the document; without one the
  // eater falls back to mouse.use; no mouse here => 'no-food', not a throw.
  const ctx = { castsSinceFood: 0, lastEatAt: 0 };
  assert.doesNotThrow(() => m.fire(ctx, { force: false }));
});

test('REQ-17: no food source at all -> no throw, no failure accounting', () => {
  const m = moduleWith({}, { gameClient: null });
  const ctx = { castsSinceFood: 0, lastEatAt: 999000 }; // ate 1s ago -> inside the fallback window
  assert.equal(m.decide(ctx).fire, false, 'no SATED/timer data, interval not elapsed -> wait');
  assert.equal(m.decide(ctx).reason, 'fallback-wait');
  assert.equal(m.fire(ctx, { force: false }), false);
  assert.equal(m.getState().failures, 0, 'no-food-source is not a failed attempt');
});

/* ---------------------- PR 3 — unified eat (REQ-01..06) ---------------------- */

test('REQ-01/02: magic-first — configured magic + live F-slot resolves + hungry -> eat-magic', () => {
  const m = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
  });
  const d = m.decide({});
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'eat-magic');
  assert.equal(d.reason, 'flag', 'hunger source carries through the magic path');
  assert.equal(m.getState().magicSid, 24, 'magicSid is derived from the resolved magic config');
});

test('REQ-01: magic-first — sated and inside the safety window -> wait (no cast)', () => {
  const m = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => true),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
  });
  const d = m.decide({ lastEatAt: 490000 }); // ate 10s ago (< 20 min)
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'sated');
});

test('REQ-04: safety net overrides SATED on the magic path -> eat-magic', () => {
  const m = moduleWith({ safetyNetMinutes: 20, magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => true), // SATED true
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
    now: () => 500000 + 21 * 60 * 1000, // 21 min since the (zero) last meal anchor
  });
  const d = m.decide({ lastEatAt: 0 });
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'eat-magic');
  assert.equal(d.reason, 'safety-net');
});

test('REQ-04: safety net overrides SATED on the NORMAL path -> eat', () => {
  const m = moduleWith({ safetyNetMinutes: 20 }, {
    gameClient: gcWith(() => true),
    now: () => 500000 + 21 * 60 * 1000,
  });
  const d = m.decide({ lastEatAt: 0, castsSinceFood: 0 });
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'eat');
  assert.equal(d.reason, 'safety-net');
  assert.equal(d.force, false);
});

test('REQ-04: safety net NOT elapsed -> sated wins (normal path)', () => {
  const m = moduleWith({ safetyNetMinutes: 20 }, { gameClient: gcWith(() => true) });
  assert.equal(m.decide({ lastEatAt: 490000 }).fire, false);
  assert.equal(m.decide({ lastEatAt: 490000 }).reason, 'sated');
});

test('REQ-03: magic configured but the pan is NOT on the live hotbar -> normal food path (unresolvable F-slot disables magic safely)', () => {
  const m = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: () => null, // sid not mapped anywhere
  });
  const d = m.decide({});
  assert.equal(d.fire, true, 'hungry still eats — via the normal slot path');
  assert.equal(d.kind, 'eat');
  assert.equal(m.getState().magicSid, null, 'no magicSid when the live hotbar cannot resolve the slot');
});

test('REQ-03: magic configured but SID moved to another F-slot -> normal path (never fires a stale slot)', () => {
  const m = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 99 : 24), // F4 now maps sid 99
  });
  const d = m.decide({});
  assert.equal(d.kind, 'eat', 'normal fallback, not magic');
});

test('REQ-03: magic disabled -> normal path', () => {
  const m = moduleWith({ magic: { enabled: false, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
  });
  assert.equal(m.decide({}).kind, 'eat');
});

test('REQ-05: magicBusy — machine mid-cycle NEVER falls through to normal food (structural no-double-eat)', () => {
  // created-food-ready: hungry + safety due, but the magic machine owns the meal.
  const busy = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
    foodCycle: () => 'created-food-ready',
  });
  const d = busy.decide({ lastEatAt: 0 });
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'magic-cycle-active');
  // foodMagicPending: a magic cast is in flight — same guard.
  const pending = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
    foodMagicPending: () => true,
  });
  assert.equal(pending.decide({ lastEatAt: 0 }).reason, 'magic-cycle-active');
  // Normal-path hunger with magicBusy ALSO blocked (never an eat kind).
  const noMagic = moduleWith({}, {
    gameClient: gcWith(() => false),
    foodCycle: () => 'created-food-ready',
  });
  assert.equal(noMagic.decide({ lastEatAt: 0 }).reason, 'magic-cycle-active');
});

test('REQ-03: magic failure timeout -> noteMagicUnavailable serves the normal path until the retry window passes', () => {
  const m = moduleWith({ safetyNetMinutes: 20, magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
  });
  m.noteMagicUnavailable(); // machine blocked (food-not-created-timeout) -> retry in 20 min
  let d = m.decide({ lastEatAt: 0 });
  assert.equal(d.kind, 'eat', 'hungry + magic retry window -> normal food fallback (REQ-03 timeout)');
  assert.equal(d.reason, 'flag');
  // Still normal while the retry window is open, even once the safety net elapses.
  assert.equal(m.decide({ lastEatAt: 0 }).kind, 'eat');
  // After the retry window passes the magic path re-arms.
  let clock = 500000;
  const late = moduleWith({ safetyNetMinutes: 1, magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
    now: () => clock,
  });
  late.noteMagicUnavailable(); // retryAfter = now + 60s
  assert.equal(late.decide({ lastEatAt: 0 }).kind, 'eat', 'still on the normal path inside the retry window');
  clock = 500000 + 130 * 1000; // past retryAfter
  assert.equal(late.decide({ lastEatAt: 0 }).kind, 'eat-magic', 'magic re-arms after the retry window');
});

test('REQ-04: readFoodState unavailable (null) never crashes — magic path treats unknown hunger as hungry', () => {
  const m = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: null, // no conditions, no timer -> { eat: null }
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
  });
  const d = m.decide({});
  assert.equal(d.fire, true);
  assert.equal(d.kind, 'eat-magic');
  assert.equal(d.reason, 'hunger');
});

test('REQ-04: readFoodState unavailable + NO magic -> fallback cadence only (no crash)', () => {
  const m = moduleWith({}, { gameClient: null });
  assert.equal(m.decide({ lastEatAt: 499000 }).fire, false); // ate 1s ago -> inside the 10s window
  assert.equal(m.decide({ lastEatAt: 499000 }).reason, 'fallback-wait');
});

test('PR 3: getState surfaces the honest unified fields', () => {
  const m = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
  });
  const st = m.getState();
  assert.equal(st.on, true);
  assert.equal(st.paused, false);
  assert.equal(st.failures, 0);
  assert.equal(st.alert, null);
  assert.equal(st.lastEatAt, 0);
  assert.equal(st.foodCreated, 0, 'cumulative session total starts at 0');
  assert.equal(st.nextMealAt, null, 'no meal yet -> no next-meal anchor');
  assert.equal(st.safetyNetMinutes, 20);
  assert.equal(st.magicSid, 24);
  assert.equal(st.source, null, 'no meal yet -> source null');
});

test('PR 3: a confirmed normal meal records lastEatAt on the module state + source normal', () => {
  const useCalls = [];
  const gc = { mouse: { use: (args) => useCalls.push(args) } };
  const m = moduleWith({}, { gameClient: gc });
  const ctx = { castsSinceFood: 0, lastEatAt: 0 };
  assert.equal(m.fire(ctx, { force: false }), true, 'attempt executed via mouse.use fallback');
  assert.equal(m.getState().lastEatAt, ctx.lastEatAt, 'module state mirrors the ctx anchor (stale-field fix)');
  assert.ok(m.getState().lastEatAt > 0);
  assert.equal(m.getState().source, 'normal');
  assert.equal(m.getState().nextMealAt, m.getState().lastEatAt + 20 * 60 * 1000,
    'nextMealAt = lastEatAt + safetyNetMinutes');
});

test('PR 3: noteMeal on created-food-consumed counts the food and anchors the meal', () => {
  const m = moduleWith({ magic: { enabled: true, slot: 4, sid: 24 } }, {
    gameClient: gcWith(() => false),
    readHotbarSlotSid: (slot) => (slot === 4 ? 24 : null),
  });
  const ctx = { castsSinceFood: 0, lastEatAt: 0 };
  m.noteMeal(ctx);
  const st = m.getState();
  assert.equal(st.foodCreated, 1, 'magic-created food consumed -> cumulative session total');
  assert.equal(st.source, 'magic');
  assert.ok(st.lastEatAt > 0, 'meal anchored');
  assert.equal(st.nextMealAt, st.lastEatAt + 20 * 60 * 1000);
  m.noteMeal(ctx);
  assert.equal(m.getState().foodCreated, 2, 'cumulative across meals, never resets per meal');
});
