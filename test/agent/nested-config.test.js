'use strict';

/**
 * REQ-08 fix slice — NESTED per-module config shape (unit tests).
 *
 * The REAL app push path (panel buildPushConfig -> POST /api/config ->
 * server applyConfigFn) delivers the per-character STORE shape with a
 * NESTED `modules.<id>` object (app/store/characters.ts). normalizeConfig
 * historically read FLAT top-level keys only (src.healItems, src.routes,
 * ...), so in the real app every module toggle stayed OFF — masked because
 * agent wiring tests feed flat shapes while server tests assert the nested
 * outgoing payload. These tests prove:
 *
 *   1. the nested store shape reaches EVERY module's `on` flag + settings;
 *   2. merge semantics: nested `modules.<id>` wins for the fields it
 *      carries, flat keys stay the fallback (modules absent / module
 *      without a nested entry) — both shapes keep working;
 *   3. invalid nested values fall back to the defaults (same validation as
 *      the flat shape);
 *   4. the top-level `routes` ARRAY stays cavebot route data (REQ-36), it
 *      never becomes the routes module config;
 *   5. `armed` remains a top-level-only gate flag (REQ-02).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeConfig } = require('../../src/agent/bootstrap.js');

/** Canonical NESTED per-character store shape (mirror of the panel save:
 *  `modules.<id>` per module + `routes[]` route list at the top level). */
function nestedStoreConfig(overrides = {}) {
  return Object.assign({
    character: 'Flamamex',
    connected: true,
    queue: { minIntervalMs: 200 },
    jitter: { min: 60, max: 350 },
    modules: {
      healItems: { on: true, threshold: 40, slotCids: [1, 2] },
      manaItems: { on: true, threshold: 60, slotCids: [3, 4] },
      healMagic: { on: true, threshold: 120, slot: 2, word: 'exura', sid: 61, reserve: 10 },
      runes: { on: true, attackSlot: 3, healSlot: 4, healThreshold: 80, reserve: 30,
        capMode: 'strict', capFullThreshold: 0.9, fallbackSid: null, fallbackSlot: 5, fallbackManaPct: 0.6 },
      training: { on: true, slot: 6, sid: 42, reserve: 20, word: 'utevo vis',
        eatWithMagic: { enabled: true, slot: 8, sid: 55 } },
      // PR 2 (REQ-08): the unified eat shape — magic + safetyNetMinutes ride
      // the nested entry; normalizeConfig carries the KNOWN eat fields and
      // tolerates (drops) the new keys until the agent lands the unified
      // decision (PR 3, T7).
      eat: { on: true, everyCasts: 5, warningWindowSec: 45, fallbackIntervalSec: 8, slot: 2, cids: [9, 10],
        safetyNetMinutes: 20, magic: { enabled: true, slot: 8, sid: 55 } },
      trade: { on: true, message: 'buying runes', intervalMs: 90000 },
      loot: { on: true, defaultDest: 'Loot bag', perMonster: { Rotworm: 'Loot bag' } },
      spawns: { on: true },
      huntStats: { on: true },
      learning: { on: false, knownWords: ['exura', 'utevo vis'] },
      antibot: { on: true, replies: [{ pattern: 'are you bot?', reply: 'no' }] },
      routes: { on: true },
      attack: { on: true, targeting: 'nearest', sid: 12, runeSlot: 5 },
      cavebot: { on: true, paused: false },
    },
    routes: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    armed: true,
  }, overrides);
}

test('REQ-08 fix: the NESTED store shape reaches EVERY module — on flags + key settings', () => {
  const cfg = normalizeConfig(nestedStoreConfig());
  // Top-level scoped keys stay top-level in BOTH shapes (store SCOPED_KEYS).
  assert.equal(cfg.queue.minIntervalMs, 200);
  assert.deepEqual(cfg.jitter, { min: 60, max: 350 });
  // Legacy modules (no store default entry) keep their defaults when absent.
  assert.deepEqual(cfg.survival, { on: true, threshold: 50, slot: null });
  assert.deepEqual(cfg.rotation, { spells: [] });
  // Every module normalizeConfig handles — nested shape lands in full.
  assert.deepEqual(cfg.healItems, { on: true, threshold: 40, slotCids: [1, 2] });
  assert.deepEqual(cfg.manaItems, { on: true, threshold: 60, slotCids: [3, 4] });
  assert.deepEqual(cfg.healMagic,
    { on: true, threshold: 120, slot: 2, sid: 61, word: 'exura', reserve: 10 });
  assert.deepEqual(cfg.runes, {
    on: true, attackSlot: 3, healSlot: 4, healThreshold: 80, reserve: 30,
    capMode: 'strict', capFullThreshold: 0.9, fallbackSid: null, fallbackSlot: 5, fallbackManaPct: 0.6,
  });
  assert.deepEqual(cfg.training, {
    on: true, slot: 6, sid: 42, reserve: 20, word: 'utevo vis',
    eatWithMagic: { enabled: true, slot: 8, sid: 55, everyRunes: 1 },
  });
  assert.deepEqual(cfg.eat, {
    on: true, everyCasts: 5, warningWindowSec: 45, fallbackIntervalSec: 8, slot: 2, cids: [9, 10],
  });
  assert.deepEqual(cfg.trade, { on: true, message: 'buying runes', intervalMs: 90000 });
  assert.deepEqual(cfg.loot, { on: true, defaultDest: 'Loot bag', perMonster: { Rotworm: 'Loot bag' } });
  assert.equal(cfg.spawns.on, true);
  assert.equal(cfg.huntStats.on, true);
  assert.deepEqual(cfg.learning.knownWords, ['exura', 'utevo vis']);
  assert.deepEqual(cfg.antibot, { on: true, replies: [{ pattern: 'are you bot?', reply: 'no' }], domRuneCheck: false });
  assert.equal(cfg.routes.on, true);
  assert.deepEqual(cfg.attack, { on: true, targeting: 'nearest', sid: 12, runeSlot: 5, reserve: 0 });
  assert.deepEqual(cfg.cavebot, { on: true, paused: false, route: [{ x: 1, y: 2 }, { x: 3, y: 4 }], monsters: [], targeting: 'nearest' });
  assert.equal(cfg.armed, true);
});

test('REQ-08 fix: the FLAT shape still normalizes identically (v1/v2 agent test convention)', () => {
  // The same settings as nestedStoreConfig() but flat top-level keys — the
  // established agent/test shape + DEFAULT_CONFIG. Both must produce the
  // same cfg (flat remains a full fallback, never degraded).
  const flat = {
    queue: { minIntervalMs: 200 },
    jitter: { min: 60, max: 350 },
    survival: { on: true, threshold: 40, slot: 3 },
    rotation: { spells: [{ slot: 1, word: 'exori' }] },
    healItems: { on: true, threshold: 40, slotCids: [1, 2] },
    manaItems: { on: true, threshold: 60, slotCids: [3, 4] },
    healMagic: { on: true, threshold: 120, slot: 2, word: 'exura', sid: 61, reserve: 10 },
    runes: { on: true, attackSlot: 3, healSlot: 4, healThreshold: 80, reserve: 30,
      capMode: 'strict', capFullThreshold: 0.9, fallbackSid: null, fallbackSlot: 5, fallbackManaPct: 0.6 },
    training: { on: true, slot: 6, sid: 42, reserve: 20, word: 'utevo vis',
      eatWithMagic: { enabled: true, slot: 8, sid: 55 } },
    eat: { on: true, everyCasts: 5, warningWindowSec: 45, fallbackIntervalSec: 8, slot: 2, cids: [9, 10] },
    trade: { on: true, message: 'buying runes', intervalMs: 90000 },
    loot: { on: true, defaultDest: 'Loot bag', perMonster: { Rotworm: 'Loot bag' } },
    spawns: { on: true },
    huntStats: { on: true },
    learning: { knownWords: ['exura', 'utevo vis'] },
    antibot: { on: true, replies: [{ pattern: 'are you bot?', reply: 'no' }] },
    routes: { on: true },
    attack: { on: true, targeting: 'nearest', sid: 12, runeSlot: 5 },
    cavebot: { on: true, paused: false, route: [{ x: 1, y: 2 }] },
    armed: true,
  };
  const cfg = normalizeConfig(flat);
  assert.deepEqual(cfg.survival, { on: true, threshold: 40, slot: 3 }, 'survival flat intact');
  assert.deepEqual(cfg.rotation, { spells: [{ slot: 1, word: 'exori' }] }, 'rotation flat intact');
  assert.deepEqual(cfg.healItems, { on: true, threshold: 40, slotCids: [1, 2] });
  assert.deepEqual(cfg.manaItems, { on: true, threshold: 60, slotCids: [3, 4] });
  assert.deepEqual(cfg.healMagic,
    { on: true, threshold: 120, slot: 2, sid: 61, word: 'exura', reserve: 10 });
  assert.equal(cfg.runes.capMode, 'strict');
  assert.equal(cfg.runes.fallbackSlot, 5);
  assert.deepEqual(cfg.training.eatWithMagic, { enabled: true, slot: 8, sid: 55, everyRunes: 1 });
  assert.deepEqual(cfg.eat.cids, [9, 10]);
  assert.equal(cfg.trade.intervalMs, 90000);
  assert.deepEqual(cfg.loot.perMonster, { Rotworm: 'Loot bag' });
  assert.deepEqual(cfg.learning.knownWords, ['exura', 'utevo vis']);
  assert.equal(cfg.routes.on, true);
  assert.deepEqual(cfg.attack, { on: true, targeting: 'nearest', sid: 12, runeSlot: 5, reserve: 0 });
  assert.deepEqual(cfg.cavebot, { on: true, paused: false, route: [{ x: 1, y: 2 }], monsters: [], targeting: 'nearest' });
  assert.equal(cfg.armed, true);
});

test('REQ-08 fix: merge semantics — nested modules.<id> WINS per-field, flat stays the fallback', () => {
  // Nested carries on+threshold; flat carries slot+sid+word (fields the
  // nested entry does not carry) + a conflicting `on` that must LOSE.
  const cfg = normalizeConfig({
    modules: { healMagic: { on: true, threshold: 90 } },
    healMagic: { on: false, slot: 3, sid: 61, word: 'exura' },
    armed: true,
  });
  assert.equal(cfg.healMagic.on, true, 'nested on wins (even vs flat true->false conflict)');
  assert.equal(cfg.healMagic.threshold, 90, 'nested field wins');
  assert.equal(cfg.healMagic.slot, 3, 'flat fallback for fields the nested entry does not carry');
  assert.equal(cfg.healMagic.sid, 61);
  assert.equal(cfg.healMagic.word, 'exura');
  assert.equal(cfg.healMagic.reserve, 0, 'untouched fields keep defaults');
});

test('REQ-08 fix: nested false beats flat true (the store always carries a real on)', () => {
  const cfg = normalizeConfig({
    modules: { runes: { on: false, attackSlot: 3 } },
    runes: { on: true, healSlot: 4 },
  });
  assert.equal(cfg.runes.on, false, 'nested on:false is a real toggle, not a gap');
  assert.equal(cfg.runes.attackSlot, 3);
  assert.equal(cfg.runes.healSlot, 4, 'flat fallback still supplies other fields');
});

test('REQ-08 fix: modules ABSENT -> flat only; module WITHOUT a nested entry -> flat only', () => {
  const flatOnly = normalizeConfig({
    runes: { on: true, attackSlot: 2 },
    routes: { on: true },
    armed: true,
  });
  assert.deepEqual(flatOnly.runes, { on: true, attackSlot: 2, healSlot: null, healThreshold: null,
    reserve: 0, capMode: 'strict', capFullThreshold: 1.0, fallbackSid: null, fallbackSlot: null,
    fallbackManaPct: 0.5 });
  assert.equal(flatOnly.routes.on, true);

  const mixed = normalizeConfig({
    modules: { routes: { on: true } }, // routes HAS a nested entry
    runes: { on: true, attackSlot: 2 }, // runes does NOT -> flat
  });
  assert.equal(mixed.routes.on, true, 'nested entry used when present');
  assert.equal(mixed.runes.on, true, 'flat used when the module has no nested entry');
  assert.equal(mixed.runes.attackSlot, 2);
});

test('REQ-08 fix: invalid nested values fall back to the defaults (same validation as flat)', () => {
  const cfg = normalizeConfig({
    modules: {
      runes: { on: 'yes', attackSlot: 'x' },          // invalid on + slot
      healMagic: { on: true, threshold: 'low' },       // invalid threshold
      antibot: { on: true, replies: [{ pattern: '', reply: '' }] }, // malformed entry dropped
      learning: { knownWords: ['exura', '  ', 7] },     // junk words dropped
    },
    armed: true,
  });
  assert.equal(cfg.runes.on, false, 'non-boolean on -> default false');
  assert.equal(cfg.runes.attackSlot, null, 'non-integer slot -> default null');
  assert.equal(cfg.healMagic.on, true);
  assert.equal(cfg.healMagic.threshold, 150, 'non-finite threshold -> default 150');
  assert.deepEqual(cfg.antibot.replies, [], 'malformed replies dropped');
  assert.deepEqual(cfg.learning.knownWords, ['exura']);
});

test('REQ-08 fix: a non-object modules entry (or nested module) is ignored, flat still works', () => {
  const cfg = normalizeConfig({
    modules: 'junk',
    healItems: { on: true, threshold: 30 },
    armed: true,
  });
  assert.equal(cfg.healItems.on, true, 'flat healItems intact when modules is not an object');

  const cfg2 = normalizeConfig({
    modules: { healItems: true, runes: null }, // non-object nested entries
    runes: { on: true },
    armed: true,
  });
  assert.equal(cfg2.healItems.on, false, 'non-object nested entry ignored -> defaults');
  assert.equal(cfg2.runes.on, true, 'null nested entry ignored -> flat used');
});

test('REQ-08 fix: the top-level routes ARRAY stays cavebot route data, never the routes module config', () => {
  const cfg = normalizeConfig({
    modules: { routes: { on: true } },
    routes: [{ x: 1, y: 2 }, { x: 3, y: 4 }], // REQ-36: the SAVED ROUTE LIST
    armed: true,
  });
  assert.equal(cfg.routes.on, true, 'routes module config comes from the nested entry');
  assert.deepEqual(cfg.cavebot.route, [{ x: 1, y: 2 }, { x: 3, y: 4 }], 'route list lands in cavebot.route');

  // No nested entry: a flat routes OBJECT still configures the module; an
  // array flat value never does (pre-fix behavior preserved).
  const flatObj = normalizeConfig({ routes: { on: true }, armed: true });
  assert.equal(flatObj.routes.on, true);
  const arrOnly = normalizeConfig({ routes: [{ x: 9, y: 9 }], armed: true });
  assert.equal(arrOnly.routes.on, false, 'a bare array is route data, not the module toggle');
  assert.deepEqual(arrOnly.cavebot.route, [{ x: 9, y: 9 }]);
});

test('REQ-08 fix: armed stays a TOP-LEVEL gate — nested armed never arms (REQ-02)', () => {
  assert.equal(normalizeConfig({ modules: { runes: { on: true }, armed: true } }).armed, false,
    'nested armed is not the gate');
  assert.equal(normalizeConfig({ modules: { runes: { on: true } }, armed: true }).armed, true);
  assert.equal(normalizeConfig({ modules: { runes: { on: true } }, armed: false }).armed, false);
  assert.equal(normalizeConfig({ modules: { runes: { on: true } } }).armed, false);
});

test('REQ-08 (PR 2): the unified eat.magic + safetyNetMinutes shape is tolerated — known eat fields land, new keys never crash', () => {
  // The store now ships the unified eat shape (PR 2); the agent normalizes
  // only the fields it understands TODAY and silently drops the new keys
  // (the unified decision lands in PR 3 / T7). Tolerance is the contract.
  const cfg = normalizeConfig({
    modules: {
      eat: { on: true, slot: 2, cids: [9], everyCasts: 0,
        safetyNetMinutes: 20, magic: { enabled: true, slot: 8, sid: 55 } },
    },
    armed: true,
  });
  assert.equal(cfg.eat.on, true, 'known toggle lands');
  assert.equal(cfg.eat.slot, 2, 'known slot lands');
  assert.deepEqual(cfg.eat.cids, [9], 'known cids land');
  assert.equal(cfg.eat.magic, undefined, 'magic is not carried by the agent yet (PR 3)');
  assert.equal(cfg.eat.safetyNetMinutes, undefined, 'safetyNetMinutes not carried by the agent yet (PR 3)');
});
