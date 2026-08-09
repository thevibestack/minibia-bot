'use strict';

/**
 * Hunt session stats tests (REQ-21, task 5.4): per-hour XP/gold/kills/loot
 * aggregation, baseline anchoring, freeze on stop, feature-detected counter
 * sources (honest "no data" per metric), premium gate (REQ-22), toggle =
 * session start/stop.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHuntStats } = require('../../../src/agent/modules/huntStats');
const { createKillObserver } = require('../../../src/core/kills');

function makeModule(overrides = {}) {
  const now = { t: 0 };
  const counters = overrides.counters !== undefined
    ? overrides.counters
    : () => ({ xp: 1000, gold: 500 });
  const killObserver = overrides.killObserver !== undefined
    ? overrides.killObserver
    : createKillObserver({ readActiveCreatures: () => [], now: () => now.t });
  const mod = createHuntStats({
    config: Object.assign({ on: true }, overrides.config),
    readCounters: counters,
    killObserver,
    readPremium: overrides.readPremium || (() => ({ gated: true, active: true, source: 'test' })),
    now: () => now.t,
    log: {},
  });
  mod.startSession();
  return { mod, now, killObserver };
}

test('REQ-21: first sample anchors the baseline; deltas + per-hour rates accumulate', () => {
  const { mod, now } = makeModule({ counters: () => ({ xp: 1000, gold: 500 }) });
  now.t = 0;
  mod.accumulate({ kills: [], available: true }); // baseline sample
  now.t = 3_600_000; // 1 hour later
  mod.accumulate({ kills: [{ name: 'Rat', loot: true }], available: true });
  const st = mod.getState();
  assert.equal(st.running, true);
  assert.equal(st.totals.xp, 0, 'fixed counters -> zero xp delta over the hour');
  assert.equal(st.perHour.xp, 0);
  assert.equal(st.totals.gold, 0);
  assert.equal(st.totals.kills, 1, 'one kill diff');
  assert.equal(st.perHour.kills, 1, 'one kill per hour');
  assert.equal(st.totals.loot, 1);
  assert.equal(st.perHour.loot, 1);
});

test('REQ-21: per-hour rates divide by elapsed hours (half-hour -> 2x rate)', () => {
  const now = { t: 0 };
  const counters = (() => {
    let xp = 0;
    return () => { xp += 50; return { xp, gold: 0 }; }; // 50 xp per accumulate
  })();
  const mod = createHuntStats({
    config: { on: true },
    readCounters: counters,
    killObserver: createKillObserver({ readActiveCreatures: () => [], now: () => now.t }),
    readPremium: () => ({ gated: true, active: true }),
    now: () => now.t,
    log: {},
  });
  mod.startSession();
  now.t = 0;
  mod.accumulate({ kills: [], available: true }); // baseline (xp=50)
  now.t = 1_800_000; // half an hour
  // Scan results are DELTAS from the shared kill observer (core/kills): the
  // observer diff reports each disappearing creature once.
  mod.accumulate({ kills: [{ id: 1, name: 'Rat', loot: true }], available: true }); // xp=100, kills=1
  mod.accumulate({ kills: [{ id: 2, name: 'Wolf', loot: false }], available: true }); // xp=150, kills=2
  const st = mod.getState();
  assert.equal(st.totals.xp, 100, 'xp delta over the half-hour');
  assert.equal(st.perHour.xp, 200, '100 xp / 0.5h = 200/h');
  assert.equal(st.totals.kills, 2);
  assert.equal(st.perHour.kills, 4, '2 kills / 0.5h = 4/h');
  assert.equal(st.totals.loot, 1, 'only the Rat carried loot:true');
  assert.equal(st.perHour.loot, 2, '1 loot / 0.5h = 2/h');
});

test('REQ-21: stop freezes the snapshot at the stop point (REQ-21 GIVEN)', () => {
  const { mod, now } = makeModule();
  now.t = 0;
  mod.accumulate({ kills: [], available: true });
  now.t = 1_800_000;
  mod.accumulate({ kills: [{ id: 1, name: 'Rat', loot: true }], available: true });
  mod.stopSession();
  const frozen = mod.getState();
  assert.equal(frozen.running, false);
  assert.equal(frozen.frozen, true);
  now.t = 7_200_000; // hours later
  mod.accumulate({ kills: [], available: true });
  const after = mod.getState();
  assert.deepEqual(after.totals, frozen.totals, 'stats freeze at the stop point');
  assert.deepEqual(after.perHour, frozen.perHour);
});

test('REQ-21: module OFF (toggle) never starts a session; start/stop control via the panel toggle', () => {
  const mod = createHuntStats({
    config: { on: false },
    readCounters: () => ({ xp: 1, gold: 1 }),
    killObserver: createKillObserver({ readActiveCreatures: () => [], now: () => 0 }),
    readPremium: () => ({ gated: true, active: true }),
    now: () => 0,
    log: {},
  });
  mod.accumulate({ kills: [], available: true });
  assert.equal(mod.getState().running, false, 'no session without start');
  mod.startSession();
  assert.equal(mod.getState().running, true);
  mod.stopSession();
  assert.equal(mod.getState().frozen, true);
});

test('REQ-21: missing XP/gold counters -> per-metric "no data", never invented', () => {
  const { mod, now } = makeModule({ counters: () => ({ xp: null, gold: null }) });
  now.t = 0;
  mod.accumulate({ kills: [], available: true });
  now.t = 3_600_000;
  mod.accumulate({ kills: [{ id: 1, name: 'Rat' }], available: true });
  const st = mod.getState();
  assert.equal(st.totals.xp, null);
  assert.equal(st.perHour.xp, null);
  assert.equal(st.available.xp, false, 'xp source absent -> recorded');
  assert.equal(st.available.gold, false);
  assert.equal(st.available.kills, true, 'kill source present');
  // Loot v1 approximation: kills whose entry lacks loot info count 0 (the
  // source-level degrade covers an absent activeCreatures array).
  assert.equal(st.totals.loot, 0);
  assert.equal(st.available.loot, true);
});

test('REQ-21: absent kill source (no activeCreatures) -> kills/loot degrade, counters still track', () => {
  const { mod, now } = makeModule({ killObserver: createKillObserver({ readActiveCreatures: () => null }) });
  now.t = 0;
  mod.accumulate({ kills: [], available: false });
  now.t = 3_600_000;
  mod.accumulate({ kills: [], available: false });
  const st = mod.getState();
  assert.equal(st.available.kills, false, 'no kill source -> honest degrade');
  assert.equal(st.totals.kills, null);
  assert.equal(st.available.xp, true, 'counter source still tracked');
});

test('REQ-22: premium-blocked mid-session -> accumulate freezes at the block point', () => {
  const now = { t: 0 };
  const mod = createHuntStats({
    config: { on: true },
    readCounters: () => ({ xp: 900, gold: 90 }),
    killObserver: createKillObserver({ readActiveCreatures: () => [], now: () => now.t }),
    readPremium: () => ({ gated: true, active: false, source: 'player.premium' }),
    now: () => now.t,
    log: {},
  });
  mod.startSession();
  now.t = 0;
  mod.accumulate({ kills: [], available: true });
  mod.accumulate({ kills: [], available: true });
  const st = mod.getState();
  assert.equal(st.premium.blocked, true, 'panel-facing premium state');
  assert.equal(st.running, false, 'tracker stopped');
  assert.equal(st.frozen, true, 'stats froze at the premium-block point (REQ-22)');
  const totalsAtBlock = st.totals;
  now.t = 7_200_000;
  mod.accumulate({ kills: [], available: true });
  assert.deepEqual(mod.getState().totals, totalsAtBlock, 'frozen totals do not move');
});

test('REQ-21: isEnabled reflects the config toggle', () => {
  const mod = createHuntStats({
    config: { on: true },
    readCounters: () => ({ xp: null, gold: null }),
    killObserver: createKillObserver({ readActiveCreatures: () => [] }),
    readPremium: () => ({ gated: true, active: null }),
    now: () => 0,
    log: {},
  });
  assert.equal(mod.isEnabled(), true);
});
