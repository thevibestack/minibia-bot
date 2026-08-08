'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { readStats, readCooldown } = require('../../src/adapters/gameClient');

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
