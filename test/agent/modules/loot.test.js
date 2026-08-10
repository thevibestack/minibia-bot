'use strict';

/**
 * Auto-loot list tests (REQ-19, task 5.2): per-monster destinations + default
 * destination (mirror the game's Loot List), kill feed via the shared
 * observer, feature-detected loot command, degrade when the game surface is
 * absent, premium gate (REQ-22), toggle honored.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLootModule } = require('../../../src/agent/modules/loot');

function makeModule(overrides = {}) {
  const now = { t: 0 };
  const commands = [];
  const mod = createLootModule({
    config: Object.assign({ on: true, defaultDest: null, perMonster: {} }, overrides.config),
    readLootCommand: overrides.readLootCommand !== undefined
      ? overrides.readLootCommand
      : () => (monster, dest) => commands.push({ monster, dest }),
    readPremium: overrides.readPremium || (() => ({ gated: true, active: true, source: 'test' })),
    now: () => now.t,
    log: {},
  });
  return { mod, now, commands };
}

test('REQ-19: per-monster destination wins; default applies to everything without its own', () => {
  const { mod } = makeModule({
    config: { on: true, defaultDest: 'Loot bag', perMonster: { Rat: 'Dust bag' } },
  });
  assert.deepEqual(mod.route('Rat'), { dest: 'Dust bag', source: 'per-monster' });
  assert.deepEqual(mod.route('Wolf'), { dest: 'Loot bag', source: 'default' }, 'default destination');
  assert.deepEqual(mod.route(''), { dest: null, source: 'none' });
});

test('REQ-19: no destination configured at all -> no route, no fire', () => {
  const { mod } = makeModule({ config: { on: true, defaultDest: null, perMonster: {} } });
  assert.deepEqual(mod.route('Rat'), { dest: null, source: 'none' });
  mod.observeKills([{ name: 'Rat', loot: true }]);
  const d = mod.decide();
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'no-destination');
});

test('REQ-33 (PR5): auto-loot no-ops with only whitespace destinations (trim guard)', () => {
  const { mod, commands } = makeModule({
    config: { on: true, defaultDest: '   ', perMonster: { Rat: '  ' } },
  });
  mod.observeKills([{ name: 'Rat', loot: true }]);
  const d = mod.decide();
  assert.equal(d.fire, false, 'whitespace-only destinations never fire (REQ-33 gate)');
  assert.equal(d.reason, 'no-destination');
  assert.equal(commands.length, 0);
  assert.equal(mod.getState().pendingCount, 1, 'the pending item is NOT dropped');
});

test('REQ-33 (PR5): per-monster list WITHOUT a default routes only listed monsters', () => {
  const { mod, commands } = makeModule({
    config: { on: true, defaultDest: null, perMonster: { Rat: 'Dust bag' } },
  });
  mod.observeKills([{ name: 'Rat', loot: true }, { name: 'Wolf', loot: true }]);
  assert.equal(mod.decide().fire, true, 'listed monster routes via its own destination');
  assert.equal(mod.decide().route.dest, 'Dust bag');
  assert.equal(mod.fire(mod.decide()), true);
  assert.deepEqual(commands, [{ monster: 'Rat', dest: 'Dust bag' }]);
  assert.equal(mod.getState().pendingCount, 1, 'unlisted Wolf stays pending — no default to route it');
  assert.equal(mod.decide().fire, false, 'no default destination -> no-op for unlisted monsters');
});

test('REQ-19: a kill with loot routes to the destination via the game command', () => {
  const { mod, commands } = makeModule({
    config: { on: true, defaultDest: 'Loot bag', perMonster: { Rat: 'Dust bag' } },
  });
  mod.observeKills([{ name: 'Rat', loot: true }]);
  const d = mod.decide();
  assert.equal(d.fire, true);
  assert.equal(d.route.dest, 'Dust bag');
  assert.equal(mod.fire(d), true);
  assert.deepEqual(commands, [{ monster: 'Rat', dest: 'Dust bag' }]);
  assert.equal(mod.getState().pendingCount, 0, 'pending drains on success');
  assert.equal(mod.getState().lastRouted.monster, 'Rat');
});

test('REQ-19: kills WITHOUT loot info are never routed (loot null/false)', () => {
  const { mod, commands } = makeModule({ config: { on: true, defaultDest: 'Loot bag', perMonster: {} } });
  mod.observeKills([{ name: 'Rat', loot: null }, { name: 'Wolf', loot: false }]);
  assert.equal(mod.decide().fire, false, 'no routable loot -> no fire');
  assert.equal(mod.decide().reason, 'no-pending');
  assert.equal(commands.length, 0);
});

test('REQ-19: toggle OFF -> kills are still observed but never routed', () => {
  const { mod, commands } = makeModule({ config: { on: false, defaultDest: 'Loot bag', perMonster: {} } });
  mod.observeKills([{ name: 'Rat', loot: true }]);
  assert.equal(mod.decide().fire, false);
  assert.equal(mod.decide().reason, 'off');
  assert.equal(commands.length, 0);
});

test('REQ-19: degrade — no native loot command -> record/no-op + honest panel state', () => {
  const { mod, commands } = makeModule({
    readLootCommand: () => null,
    config: { on: true, defaultDest: 'Loot bag', perMonster: {} },
  });
  mod.observeKills([{ name: 'Rat', loot: true }]);
  const d = mod.decide();
  assert.equal(d.fire, true, 'decision works without the surface');
  assert.equal(mod.fire(d), false, 'fire no-ops');
  assert.equal(commands.length, 0);
  const st = mod.getState();
  assert.equal(st.available, false, 'degrade recorded');
  assert.equal(st.reason, 'no native loot command');
  assert.equal(st.pendingCount, 1, 'the pending item is NOT silently dropped');
  // After the degrade is recorded, decide stops re-attempting (no churn).
  assert.equal(mod.decide().fire, false);
  assert.equal(mod.decide().reason, 'no-native-loot-command');
});

test('REQ-19: the pending queue is bounded (spammy feed cannot grow unboundedly)', () => {
  const { mod } = makeModule({ config: { on: true, defaultDest: 'bag', perMonster: {} } });
  const kills = [];
  for (let i = 0; i < 100; i += 1) kills.push({ name: 'Rat' + i, loot: true });
  mod.observeKills(kills);
  assert.ok(mod.getState().pendingCount <= 50, 'bounded by PENDING_CAP');
});

test('REQ-22: explicit non-premium account -> "Premium required", never routes; unknown never blocks', () => {
  const premiumFalse = { gated: true, active: false, source: 'player.premium' };
  const { mod: blocked, commands: c1 } = makeModule({
    readPremium: () => premiumFalse,
    config: { on: true, defaultDest: 'bag', perMonster: {} },
  });
  blocked.observeKills([{ name: 'Rat', loot: true }]);
  assert.equal(blocked.decide().fire, false);
  assert.equal(blocked.decide().reason, 'premium-required');
  assert.equal(blocked.getState().premium.blocked, true);
  assert.equal(c1.length, 0);

  const unknown = { gated: true, active: null, source: null };
  const { mod: open, commands: c2 } = makeModule({
    readPremium: () => unknown,
    config: { on: true, defaultDest: 'bag', perMonster: {} },
  });
  open.observeKills([{ name: 'Rat', loot: true }]);
  assert.equal(open.decide().fire, true, 'unknown premium never blocks (REQ-22)');
  open.fire(open.decide());
  assert.equal(c2.length, 1);
});

test('REQ-19: isEnabled reflects the toggle', () => {
  assert.equal(makeModule().mod.isEnabled(), true);
  assert.equal(makeModule({ config: { on: false } }).mod.isEnabled(), false);
});
