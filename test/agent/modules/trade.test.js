'use strict';

/**
 * Auto trade broadcast tests (REQ-18, task 5.1): 3-minute cadence (fake
 * clock), session-scoped cadence anchor, feature-detected channel send,
 * degrade when the game channel surface is absent, premium gate (REQ-22),
 * toggle honored.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTradeModule } = require('../../../src/agent/modules/trade');

function baseConfig(overrides = {}) {
  return Object.assign({ on: true, message: 'buying blank runes', intervalMs: 180000 }, overrides);
}

function makeModule(overrides = {}) {
  const now = { t: 0 };
  const sent = [];
  const channel = overrides.channel || { send: (msg) => sent.push(msg) };
  const timers = overrides.timers !== undefined ? overrides.timers : { tradeLastSentAt: 0 };
  const mod = createTradeModule({
    config: baseConfig(overrides.config),
    timers,
    readChannel: overrides.readChannel !== undefined ? overrides.readChannel : () => channel,
    readPremium: overrides.readPremium || (() => ({ gated: true, active: true, source: 'test' })),
    now: () => now.t,
    log: {},
  });
  return { mod, now, sent, timers };
}

test('REQ-18: due only after the interval; sends once per 3 minutes (fake clock)', () => {
  const { mod, now, sent, timers } = makeModule();
  now.t = 0;
  assert.equal(mod.decide().fire, false, 'not due at session start (anchor 0)');
  now.t = 60_000;
  assert.equal(mod.decide().fire, false, 'not due at 1 min');
  now.t = 180_000;
  const d = mod.decide();
  assert.equal(d.fire, true, 'due at 3 min');
  assert.equal(d.message, 'buying blank runes');
  assert.equal(mod.fire(d), true, 'send executes via the game channel');
  assert.deepEqual(sent, ['buying blank runes']);
  assert.equal(timers.tradeLastSentAt, 180_000, 'cadence anchor advanced');
  now.t = 300_000;
  assert.equal(mod.decide().fire, false, 'not due again within the interval');
  now.t = 360_000;
  assert.equal(mod.decide().fire, true, 'due again after another 3 minutes');
});

test('REQ-18: default interval is 3 minutes (mirror the game)', () => {
  const { mod, now } = makeModule({ config: { on: true, message: 'hi' } }); // no intervalMs
  now.t = 179_999;
  assert.equal(mod.decide().fire, false);
  now.t = 180_000;
  assert.equal(mod.decide().fire, true);
});

test('REQ-18: empty message -> never sends (no spam)', () => {
  const { mod, now, sent } = makeModule({ config: { on: true, message: '   ', intervalMs: 1000 } });
  now.t = 60_000;
  assert.equal(mod.decide().fire, false);
  assert.equal(mod.decide().reason, 'no-message');
  assert.equal(sent.length, 0);
});

test('REQ-18: toggle OFF -> zero broadcasts (no spam when not toggled)', () => {
  const { mod, now, sent } = makeModule({ config: { on: false, message: 'hi', intervalMs: 1 } });
  now.t = 100_000;
  assert.equal(mod.decide().fire, false);
  assert.equal(mod.decide().reason, 'off');
  assert.equal(sent.length, 0);
  assert.equal(mod.getState().reason, 'off');
});

test('REQ-18: channel send goes through the game channel mechanism; the module NEVER fabricates one', () => {
  const { mod, now, sent } = makeModule();
  now.t = 180_000;
  assert.equal(mod.fire(mod.decide()), true);
  assert.equal(sent.length, 1, 'send reached the game channel');
});

test('REQ-18: degrade — no native channel surface -> record + no-op, NEVER sends', () => {
  const { mod, now, sent } = makeModule({ readChannel: () => null });
  now.t = 180_000;
  const d = mod.decide();
  assert.equal(d.fire, true, 'decision is independent of the surface');
  assert.equal(mod.fire(d), false, 'fire no-ops');
  assert.equal(sent.length, 0);
  const st = mod.getState();
  assert.equal(st.available, false, 'degrade recorded in module state');
  assert.equal(st.reason, 'no native trade channel');
});

test('REQ-18: channel without a send function -> same degrade', () => {
  const { mod, now, sent } = makeModule({ channel: {} });
  now.t = 180_000;
  assert.equal(mod.fire(mod.decide()), false);
  assert.equal(sent.length, 0);
  assert.equal(mod.getState().reason, 'no native trade channel');
});

test('REQ-22: explicit non-premium account -> "Premium required", never sends; unknown never blocks', () => {
  const premiumFalse = { gated: true, active: false, source: 'player.premium' };
  const { mod: blocked, now: n1, sent: s1 } = makeModule({ readPremium: () => premiumFalse });
  n1.t = 180_000;
  assert.equal(blocked.decide().fire, false);
  assert.equal(blocked.decide().reason, 'premium-required');
  assert.equal(s1.length, 0, 'blocked module never sends');
  assert.equal(blocked.getState().premium.blocked, true, 'panel-facing premium state');

  const unknown = { gated: true, active: null, source: null };
  const { mod: open, now: n2, sent: s2 } = makeModule({ readPremium: () => unknown });
  n2.t = 180_000;
  assert.equal(open.decide().fire, true, 'unknown premium never blocks (REQ-22)');
  open.fire(open.decide());
  assert.equal(s2.length, 1);
  assert.equal(open.getState().premium.blocked, false);
});

test('REQ-18: the cadence anchor survives module decision re-evaluation (session-scoped timers)', () => {
  const timers = { tradeLastSentAt: 0 };
  const { mod, now } = makeModule({ timers });
  now.t = 180_000;
  assert.equal(mod.fire(mod.decide()), true);
  assert.equal(timers.tradeLastSentAt, 180_000);
  // A config rebuild creates a NEW module but keeps the SAME timers object
  // (bootstrap wiring) — the cadence is not reset mid-session.
  const mod2 = createTradeModule({
    config: baseConfig(),
    timers,
    readChannel: () => ({ send: () => {} }),
    readPremium: () => ({ gated: true, active: true }),
    now: () => now.t,
    log: {},
  });
  now.t = 240_000;
  assert.equal(mod2.decide().fire, false, 'rebuild does not reset the 3-minute clock');
  now.t = 360_000;
  assert.equal(mod2.decide().fire, true, 'due after the original anchor');
});

test('REQ-18: isEnabled reflects the config toggle', () => {
  assert.equal(makeModule().mod.isEnabled(), true);
  assert.equal(makeModule({ config: { on: false } }).mod.isEnabled(), false);
});
