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

test('REQ-17: everyCasts forced cadence eats when N casts landed (SATED pre-check skipped)', () => {
  const m = moduleWith({ everyCasts: 5 }, { gameClient: gcWith(() => true) });
  assert.equal(m.decide({ castsSinceFood: 4 }).fire, false);
  assert.equal(m.decide({ castsSinceFood: 4 }).reason, 'waiting-casts');
  const d = m.decide({ castsSinceFood: 5 });
  assert.equal(d.fire, true, 'sated but everyCasts bypasses the pre-check');
  assert.equal(d.force, true);
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
