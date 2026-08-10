'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { readStats, readCooldown, readCap, enumerateSpellCatalog, filterCatalogByVocation, spellValidationError } = require('../../src/adapters/gameClient');

function makeDoc(bodyHtml) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`);
  return dom.window.document;
}

test('REQ-01: readStats reads player.state first', () => {
  const ctx = {
    gameClient: { player: { state: { mana: 80, maxMana: 120, health: 45, maxHealth: 100 } } },
    document: makeDoc('<div id="mana-bar"><div>0/0</div></div>'),
  };
  const s = readStats(ctx);
  assert.deepEqual(s, { mana: 80, maxMana: 120, health: 45, maxHealth: 100, source: 'state' });
});

test('REQ-01: readStats coerces string state values', () => {
  const ctx = {
    gameClient: { player: { state: { mana: '80', maxMana: '120', health: '45', maxHealth: '100' } } },
  };
  const s = readStats(ctx);
  assert.deepEqual(s, { mana: 80, maxMana: 120, health: 45, maxHealth: 100, source: 'state' });
});

test('REQ-01: readStats falls back to #mana-bar/#health-bar text (cur/max)', () => {
  const ctx = {
    document: makeDoc(
      '<div id="mana-bar"><div>80 / 120</div></div><div id="health-bar"><div>45/100</div></div>',
    ),
  };
  const s = readStats(ctx);
  assert.deepEqual(s, { mana: 80, maxMana: 120, health: 45, maxHealth: 100, source: 'dom' });
});

test('REQ-14: DOM fallback is re-queried per read (no cached elements)', () => {
  const doc = makeDoc('<div id="mana-bar"><div>80/120</div></div>');
  const ctx = { document: doc };
  assert.equal(readStats(ctx).mana, 80);
  doc.querySelector('#mana-bar').lastElementChild.textContent = '10/120';
  assert.equal(readStats(ctx).mana, 10);
  doc.querySelector('#mana-bar').lastElementChild.remove();
  const s = readStats(ctx);
  assert.equal(s.mana, null);
  assert.equal(s.source, 'none', 'no bar renders a parsable value after the child vanished');
});

test('readStats: no state and no readable bars -> all null, source none', () => {
  const s = readStats({});
  assert.deepEqual(s, { mana: null, maxMana: null, health: null, maxHealth: null, source: 'none' });
});

test('readStats: unparseable bar text -> null values', () => {
  const ctx = { document: makeDoc('<div id="mana-bar"><div>full</div></div>') };
  assert.equal(readStats(ctx).mana, null);
});

test('REQ-02: readCooldown reads per-spell and GLOBAL_COOLDOWN buckets', () => {
  const ctx = {
    gameClient: {
      player: {
        spellbook: {
          cooldowns: { GLOBAL_COOLDOWN: { active: true, seconds: 0.4 }, 24: { active: true, seconds: 2 } },
        },
      },
    },
  };
  const c = readCooldown(24, ctx);
  assert.equal(c.source, 'client');
  assert.deepEqual(c.cooldown, { active: true, seconds: 2 });
  assert.deepEqual(c.globalCooldown, { active: true, seconds: 0.4 });
});

test('REQ-02: cooldowns map exists without the sid -> client says not on cooldown', () => {
  const ctx = {
    gameClient: { player: { spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false } } } } },
  };
  const c = readCooldown(24, ctx);
  assert.equal(c.source, 'client');
  assert.deepEqual(c.cooldown, { active: false, seconds: 0 });
  assert.deepEqual(c.globalCooldown, { active: false, seconds: 0 });
});

test('REQ-02: cooldown entries tolerate bare seconds (number and string)', () => {
  const ctx = {
    gameClient: { player: { spellbook: { cooldowns: { GLOBAL_COOLDOWN: 0.4, 24: '1.5' } } } },
  };
  const c = readCooldown(24, ctx);
  assert.deepEqual(c.cooldown, { active: true, seconds: 1.5 });
  assert.deepEqual(c.globalCooldown, { active: true, seconds: 0.4 });
});

test('REQ-02: spellbook/cooldowns absent -> nulls so core falls back to config pacing', () => {
  const c = readCooldown(24, {});
  assert.equal(c.source, 'absent');
  assert.equal(c.cooldown, null);
  assert.equal(c.globalCooldown, null);
});

/* ------------------- spell catalog (slice 1b, REQ-28, design D5) ------------------- */

/** Mock page interface: spells 0..4 real, then N unknown sids. */
function makeInterface({ unknown = 30 } = {}) {
  const table = {
    0: { name: 'Light', words: 'utevo lux', mana: 20, level: 0, vocations: ['sorcerer', 'druid'] },
    1: { name: 'Heal Friend', words: 'exura sio', mana: 160, level: 2, vocations: ['sorcerer', 'druid'] },
    2: { name: 'Great Light', words: 'utevo gran lux', mana: 50, level: 4, vocations: ['sorcerer', 'druid'] },
    3: { name: 'Intense Healing', words: 'exura gran', mana: 170, level: 8, vocations: ['druid'] },
    4: { name: 'Flame Strike', words: 'exori flam', mana: 20, level: 5, vocations: ['sorcerer'] },
  };
  return { getSpell: (sid) => (sid in table ? table[sid] : null) };
}

test('REQ-28: enumerateSpellCatalog scans interface.getSpell until 30 unknown sids (~65)', () => {
  const gc = {
    interface: makeInterface(),
    player: { level: 20, vocation: 4 },
    hotbarManager: { __VOCATION_NAMES: { 4: 'druid' } },
  };
  const out = enumerateSpellCatalog(gc, { maxUnknown: 30, limit: 400 });
  assert.ok(out, 'catalog enumerated');
  assert.equal(out.spells.length, 5, 'stops after the unknown streak, no invented entries');
  assert.deepEqual(out.spells[0], { sid: 0, name: 'Light', words: 'utevo lux', mana: 20, level: 0, vocations: ['sorcerer', 'druid'] });
  assert.deepEqual(out.spells[3].vocations, ['druid'], 'vocations stay string arrays (probe obs 10457)');
  assert.equal(out.playerLevel, 20, 'player level read for the level filter');
  assert.equal(out.vocationLabel, 'druid', 'vocation label via hotbarManager.__VOCATION_NAMES');
});

test('REQ-28: enumerateSpellCatalog normalizes malformed rows and tolerates throwing getSpell', () => {
  const intf = {
    getSpell: (sid) => {
      if (sid === 0) return { name: 'Odd', mana: '20', vocations: 'druid' }; // string mana, wrong vocations
      if (sid === 1) throw new Error('boom');                                // throwing sid = unknown
      return null;
    },
  };
  const out = enumerateSpellCatalog({ interface: intf, player: {} });
  assert.equal(out.spells.length, 1);
  assert.equal(out.spells[0].mana, 20, 'string mana coerced');
  assert.deepEqual(out.spells[0].vocations, [], 'non-array vocations dropped');
  assert.equal(out.playerLevel, null);
  assert.equal(out.vocationLabel, null);
});

test('REQ-28: enumerateSpellCatalog returns null when the interface is not ready', () => {
  assert.equal(enumerateSpellCatalog(null), null);
  assert.equal(enumerateSpellCatalog({}), null);
  assert.equal(enumerateSpellCatalog({ interface: {} }), null);
});

test('REQ-28: filterCatalogByVocation keeps only spells the vocation label + level can cast', () => {
  const spells = [
    { sid: 0, name: 'Light', mana: 20, level: 0, vocations: ['sorcerer', 'druid'] },
    { sid: 3, name: 'Intense Healing', mana: 170, level: 8, vocations: ['druid'] },
    { sid: 4, name: 'Flame Strike', mana: 20, level: 5, vocations: ['sorcerer'] },
    { sid: 9, name: 'Open-ended', mana: 30, level: 1, vocations: [] }, // empty = unrestricted
    { sid: 12, name: 'No vocations key', mana: 10, level: 1 },          // absent = unrestricted
  ];
  const filtered = filterCatalogByVocation(spells, { vocationLabel: 'druid', playerLevel: 8 });
  assert.deepEqual(filtered.map((s) => s.sid), [0, 3, 9, 12],
    'sorcerer-only spell filtered; level 8 qualifies level-8 spell');
  const lowLevel = filterCatalogByVocation(spells, { vocationLabel: 'druid', playerLevel: 1 });
  assert.deepEqual(lowLevel.map((s) => s.sid), [0, 9, 12], 'level filter drops the level-8 spell');
  assert.deepEqual(filterCatalogByVocation(null, { vocationLabel: 'druid' }), [], 'non-array degrades');
  assert.deepEqual(filterCatalogByVocation(spells, {}), spells, 'no filter -> all pass');
});

test('REQ-28: spellValidationError explains why a sid cannot apply (vocation/level/mana)', () => {
  const spell = { sid: 3, name: 'Intense Healing', mana: 170, level: 8, vocations: ['druid'] };
  assert.equal(spellValidationError(spell, { vocationLabel: 'druid', playerLevel: 8, mana: 200 }), null,
    'fully compatible -> null');
  assert.match(spellValidationError(spell, { vocationLabel: 'sorcerer' }).reason, /vocation mismatch/);
  assert.match(spellValidationError(spell, { vocationLabel: 'druid', playerLevel: 4 }).reason, /level too high/);
  assert.match(spellValidationError(spell, { vocationLabel: 'druid', playerLevel: 8, mana: 80 }).reason,
    /not enough mana — costs 170, you have 80/);
  assert.deepEqual(spellValidationError(null, {}), { reason: 'unknown spell' });
  assert.equal(spellValidationError(spell, { vocationLabel: 'druid', playerLevel: 8, mana: null }), null,
    'mana null = not checked (cross-load path)');
});

test('REQ-30 (D3): readCap reads the probed __state.capacity + maxCapacity locations', () => {
  const ctx = { gameClient: { player: { state: { __state: { capacity: 209 }, maxCapacity: 400 } } } };
  const cap = readCap(ctx);
  assert.equal(cap.capacity, 209);
  assert.equal(cap.maxCapacity, 400);
  assert.equal(cap.ratio, 209 / 400, 'ratio = capacity / maxCapacity (0.5225 -> not full)');
  assert.equal(cap.source, 'state');
});

test('REQ-30 (D3): readCap feature-detects the alternate field locations', () => {
  const ctx = { gameClient: { player: { state: { capacity: 300 }, maxCapacity: 300 } } };
  assert.equal(readCap(ctx).ratio, 1, 'state.capacity + state.maxCapacity fallback');
  const playerMax = { gameClient: { player: { state: { __state: { capacity: 250 } }, maxCapacity: 500 } } };
  assert.equal(readCap(playerMax).ratio, 0.5, 'player.maxCapacity fallback');
  assert.equal(readCap(playerMax).maxCapacity, 500);
});

test('REQ-30 (D3): readCap coerces string values', () => {
  const ctx = { gameClient: { player: { state: { __state: { capacity: '209' }, maxCapacity: '400' } } } };
  const cap = readCap(ctx);
  assert.equal(cap.capacity, 209);
  assert.equal(cap.ratio, 209 / 400);
});

test('REQ-30 (D3): readCap degrades — no player state -> ratio null, source none', () => {
  assert.deepEqual(readCap({}), { capacity: null, maxCapacity: null, ratio: null, source: 'none' });
  assert.deepEqual(readCap({ gameClient: {} }), { capacity: null, maxCapacity: null, ratio: null, source: 'none' });
});

test('REQ-30 (D3): readCap ratio-guards — partial data or maxCapacity <= 0 -> ratio null', () => {
  const partial = readCap({ gameClient: { player: { state: { __state: { capacity: 209 } } } } });
  assert.equal(partial.capacity, 209);
  assert.equal(partial.maxCapacity, null);
  assert.equal(partial.ratio, null, 'one side unknown -> no ratio (degrade, never invent)');
  assert.equal(partial.source, 'partial');
  const zeroMax = readCap({ gameClient: { player: { state: { __state: { capacity: 10 }, maxCapacity: 0 } } } });
  assert.equal(zeroMax.ratio, null, 'maxCapacity 0 cannot divide -> ratio null');
  assert.equal(zeroMax.source, 'partial');
});
