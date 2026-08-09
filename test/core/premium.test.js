'use strict';

/**
 * Premium-gating detection tests (REQ-22, task 5.5): the gated automations
 * (trade/loot/spawns/huntStats) must report "Premium required" ONLY when the
 * account explicitly lacks Premium; unknown state never blocks (REQ-22 "MUST
 * NOT hard-depend on any gated feature").
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPremiumState, isPremiumBlocked } = require('../../src/core/premium');

test('REQ-22: explicit boolean premium flag -> active=true', () => {
  const st = readPremiumState({ player: { premium: true } }, () => 1000);
  assert.equal(st.gated, true);
  assert.equal(st.active, true);
  assert.equal(st.source, 'player.premium');
  assert.equal(isPremiumBlocked(st), false);
});

test('REQ-22: explicit non-premium flag -> blocked ("Premium required")', () => {
  const st = readPremiumState({ player: { premium: false } }, () => 1000);
  assert.equal(st.active, false);
  assert.equal(isPremiumBlocked(st), true, 'only an explicit false blocks');
});

test('REQ-22: player.state.premium and account.premium candidates are probed', () => {
  assert.equal(readPremiumState({ player: { state: { premium: true } } }).source, 'player.state.premium');
  assert.equal(readPremiumState({ account: { premium: false } }).active, false);
  assert.equal(readPremiumState({ premium: true }).source, 'gameClient.premium');
  assert.equal(readPremiumState({ interface: { premium: true } }).source, 'interface.premium');
});

test('REQ-22: premiumUntil in the future -> active; expired -> blocked', () => {
  const now = 10_000_000;
  const future = readPremiumState({ player: { premiumUntil: now + 500_000 } }, () => now);
  assert.equal(future.active, true);
  const expired = readPremiumState({ player: { premiumUntil: now - 1 } }, () => now);
  assert.equal(expired.active, false);
  assert.equal(isPremiumBlocked(expired), true);
});

test('REQ-22: Date and numeric-string premiumUntil coerce', () => {
  const now = 10_000_000;
  assert.equal(readPremiumState({ player: { premiumUntil: new Date(now + 1000) } }, () => now).active, true);
  assert.equal(readPremiumState({ player: { premiumUntil: String(now + 1000) } }, () => now).active, true);
});

test('REQ-22: string status fields are read best-effort', () => {
  assert.equal(readPremiumState({ player: { premiumStatus: 'Premium active' } }).active, true);
  assert.equal(readPremiumState({ account: { subscription: 'inactive' } }).active, false);
});

test('REQ-22: NO premium field on the client -> active null, NEVER blocked', () => {
  const st = readPremiumState({ player: { name: 'Flamamex' } }, () => 1000);
  assert.equal(st.active, null);
  assert.equal(st.source, null);
  assert.equal(isPremiumBlocked(st), false, 'unknown premium state must not hard-block (REQ-22)');
});

test('REQ-22: missing/unshaped gameClient -> unknown, never blocked', () => {
  assert.equal(isPremiumBlocked(readPremiumState(null)), false);
  assert.equal(isPremiumBlocked(readPremiumState(42)), false);
  assert.equal(isPremiumBlocked({ gated: true, active: null }), false);
  assert.equal(isPremiumBlocked(undefined), false);
});
