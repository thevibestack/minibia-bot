'use strict';

/**
 * Slice-1a log wiring tests (task 1.2, design D8): the readable activity log
 * ring is fed by fire closures and log sinks, and the snapshot carries it
 * (getState().logBuffer) so the panel can render formatted rows — never raw
 * JSON (REQ-26). Runs against the REAL committed agent bundle, same pattern
 * as the slice-4/5/6 wiring tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', '..', 'minibia-desktop-agent.js'), 'utf8');

async function waitFor(fn, { timeout = 5000, step = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

function makePage() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const casts = [];
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 100 },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false }, 61: { active: false } }, spells: {} },
      conditions: null,
    },
    interface: {
      getSpell: (sid) => ({ 61: { cost: 20 } }[sid] || null),
      hotbarManager: {
        __handleClick: (index) => casts.push({ slot: index + 1, at: Date.now() }),
        __useItemOnSelf: () => {},
        __canPlayerCastSpell: () => true,
        __runeAttackUntil: null,
        __runeHealUntil: null,
      },
    },
    backpack: { slots: [] },
    mouse: { use: () => {} },
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  return { dom, casts, gameClient };
}

function teardown(dom) {
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch { /* best-effort */ }
  dom.window.close();
}

test('1.2: the snapshot carries the log ring; boot + sinks feed agent entries', async () => {
  const { dom } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);

    const logBuffer = handle.getState().logBuffer;
    assert.ok(Array.isArray(logBuffer), 'getState() exposes the readable log (snapshot-carried)');
    assert.ok(logBuffer.length >= 1, 'boot events already logged');
    assert.ok(
      logBuffer.some((e) => e.module === 'agent' && e.action === 'info' && /ready/.test(String(e.result))),
      'the ready sink call fed the ring (module agent, action info)',
    );
    for (const e of logBuffer) {
      assert.equal(typeof e.ts, 'number');
      assert.equal(typeof e.module, 'string');
      assert.equal(typeof e.action, 'string');
      assert.ok('result' in e, 'entry shape {ts, module, action, result}');
    }
  } finally {
    teardown(dom);
  }
});

test('1.2: a queue-dispatched fire closure logs a readable entry — healMagic cast', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig({
      queue: { minIntervalMs: 150 },
      jitter: { min: 50, max: 400 },
      survival: { on: false, threshold: 50, slot: null },
      rotation: { spells: [] },
      healMagic: { on: true, threshold: 150, slot: 2, sid: 61 },
      armed: true,
    });
    gameClient.player.state.health = 30;

    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 6000 }), true,
      'low hp + healMagic on -> hotbar cast fires');
    assert.equal(await waitFor(() => {
      const rows = handle.getState().logBuffer;
      return rows.some((e) => e.module === 'healMagic' && e.action === 'cast');
    }), true, 'the fire closure fed the ring with module healMagic / action cast');
    const entry = handle.getState().logBuffer.filter((e) => e.module === 'healMagic')[0];
    assert.equal(typeof entry.ts, 'number');
    assert.ok(String(entry.result).length > 0, 'result carries the readable decision text');
  } finally {
    teardown(dom);
  }
});

test('1.2: config rebuilds keep the log ring (session-scoped), entries stay readable', async () => {
  const { dom, casts, gameClient } = makePage();
  try {
    const handle = dom.window.__mbAgentHandle;
    assert.equal(await waitFor(() => handle.isReady()), true);
    dom.window.__mbAgent.applyConfig({
      queue: { minIntervalMs: 150 },
      jitter: { min: 50, max: 400 },
      survival: { on: false, threshold: 50, slot: null },
      rotation: { spells: [] },
      healMagic: { on: true, threshold: 150, slot: 2, sid: 61 },
      armed: true,
    });
    gameClient.player.state.health = 30;
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 6000 }), true);
    const before = handle.getState().logBuffer.length;
    assert.ok(before >= 2, 'boot + fire entries present');

    // A config push (e.g. a toggle) rebuilds tree/modules — the ring survives.
    dom.window.__mbAgent.applyConfig({
      queue: { minIntervalMs: 150 },
      jitter: { min: 50, max: 400 },
      survival: { on: false, threshold: 50, slot: null },
      rotation: { spells: [] },
      healMagic: { on: true, threshold: 150, slot: 2, sid: 61 },
      armed: true,
    });
    const after = handle.getState().logBuffer;
    assert.ok(after.length >= before, 'ring survives rebuilds (session-scoped, D8)');
    assert.ok(after.every((e) => typeof e.module === 'string' && typeof e.action === 'string'),
      'rows stay normalized and readable');
  } finally {
    teardown(dom);
  }
});
