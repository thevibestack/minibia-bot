'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', 'minibia-rotation-bot.user.js'), 'utf8');

/** Poll until fn() is truthy (real timers; jsdom windows run node timers). */
async function waitFor(fn, { timeout = 5000, step = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** Fresh jsdom page with a mocked gameClient and a seeded config. */
function makePage(overrides = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const casts = [];
  const gameClient = {
    player: {
      name: 'Flamamex',
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 100 },
      spellbook: {
        cooldowns: { GLOBAL_COOLDOWN: { active: false }, 24: { active: false } },
        spells: { 24: { cost: 20 } },
      },
      conditions: { has: (k) => (k === 'SATED' ? false : false) },
    },
    interface: {
      hotbarManager: { __handleClick: (slot) => casts.push(slot) },
      channelManager: {
        getChannel: () => ({ __contents: overrides.chatContents ?? [] }),
      },
    },
    npcTrades: [],
    itemDefinitionsByCid: {},
  };
  const config = {
    jitter: { min: 50, max: 400 },
    firing: { mode: 'handleClick' },
    validation: { enabled: overrides.validationEnabled ?? false, windowMs: 2500, pollMs: 50 },
    spells: overrides.spells ?? [
      { slot: 4, word: 'adori', validationWord: 'adori', threshold: 20, reserve: 0, repeat: 5, order: 1, cooldownMs: 0, sid: 24 },
    ],
    food: { slot: null, cid: null, name: '', warningWindowSec: 60, fallbackIntervalSec: 10 },
  };
  dom.window.gameClient = gameClient;
  dom.window.localStorage.setItem('mb-config', JSON.stringify(config));
  dom.window.__mbBootConfig = { pollIntervalMs: 5, readyTimeoutMs: 2000 };
  dom.window.eval(BUNDLE);
  return { dom, casts, config };
}

/** Tear down a page: destroy the bot (stops its timers) and close the window. */
function teardown(dom) {
  try {
    if (dom.window.__minibiaBot && typeof dom.window.__minibiaBot.destroy === 'function') {
      dom.window.__minibiaBot.destroy();
    }
  } catch {
    /* teardown is best-effort */
  }
  dom.window.close();
}

test('4.3: boot polls for gameClient+hotbarManager, awaits persist, mounts the panel', async () => {
  const { dom } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    assert.ok(bot, 'bot handle exposed as window.__minibiaBot');
    assert.equal(await waitFor(() => bot.isReady()), true, 'wires within poll timeout');

    const state = bot.getState();
    assert.equal(state.playerName, 'Flamamex');
    assert.equal(state.persistBackend, 'localStorage', '@grant none -> localStorage fallback (REQ-12)');
    assert.equal(state.catalogMode, 'keybind-only', 'jsdom has no fetch -> keybind-only mode (REQ-11)');
    assert.ok(
      state.warnings.some((w) => /keybind-only mode \(REQ-11\)/.test(w)),
      'keybind-only warning logged',
    );
    assert.ok(dom.window.document.querySelector('[data-ui-panel]'), 'panel mounted');
    assert.ok(dom.window.document.querySelector('[data-hud-status]'), 'HUD contract elements present');
    assert.equal(dom.window.document.querySelector('[data-ui-food-cid]').value, '', 'config restored into panel');
  } finally {
    teardown(dom);
  }
});

test('4.3: Start fires the spell via hotbarManager.__handleClick and counts casts', async () => {
  const { dom, casts } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    bot.start();
    assert.equal(bot.getState().running, true);

    assert.equal(
      await waitFor(() => casts.length >= 1, { timeout: 4000 }),
      true,
      'jittered ticker drives the engine within 4s',
    );
    assert.equal(casts[0], 4, 'fired via __handleClick(4) (REQ-07)');

    // repeat=5: exactly one action per tick, then the rule completes.
    assert.equal(await waitFor(() => casts.length === 5, { timeout: 4000 }), true);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(casts.length, 5, 'repeat exhausted: rule dormant, no extra casts');

    assert.ok(
      await waitFor(() => dom.window.document.querySelector('[data-hud-casts]').textContent === '5'),
      'HUD casts counter shows 5 (REQ-14)',
    );
    // Warnings live in the jsdom realm — normalize with Array.from before comparing.
    const unexpected = Array.from(bot.getState().warnings).filter((w) => !/keybind-only mode \(REQ-11\)/.test(w));
    assert.deepEqual(unexpected, [], 'no unexpected warnings on the happy path (catalog keybind-only warning expected)');
  } finally {
    teardown(dom);
  }
});

test('4.3: Pause stops the ticker (cast count stable) and freezes counters', async () => {
  const { dom, casts } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    bot.start();
    assert.equal(await waitFor(() => casts.length === 5, { timeout: 4000 }), true);

    bot.pause();
    assert.equal(bot.getState().running, false);
    const frozen = casts.length;
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(casts.length, frozen, 'no ticks while paused (REQ-04)');

    // Counters stay at their last rendered value while paused (REQ-14).
    assert.equal(dom.window.document.querySelector('[data-hud-casts]').textContent, String(frozen));
    assert.equal(
      await waitFor(() => dom.window.document.querySelector('[data-hud-status]').textContent === 'paused'),
      true,
    );
  } finally {
    teardown(dom);
  }
});

test('4.3: Reset zeroes counters and clears every mb-* key (REQ-12/14)', async () => {
  const { dom, casts } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    bot.start();
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true);

    dom.window.document.querySelector('[data-ui-reset]').click();

    assert.equal(await waitFor(() => dom.window.localStorage.getItem('mb-config') === null), true);
    assert.equal(dom.window.localStorage.length, 0, 'all mb-* keys cleared (REQ-12)');
    assert.equal(await waitFor(() => dom.window.document.querySelector('[data-hud-casts]').textContent === '0'), true);
    assert.equal(bot.getState().running, false);
  } finally {
    teardown(dom);
  }
});

test('REQ-04: hidden tab degrades gracefully with a warning when Web Workers are unavailable', async () => {
  const { dom, casts } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    bot.start();
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true);

    const before = casts.length;
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => true });
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));

    assert.equal(
      await waitFor(() => bot.getState().warnings.some((w) => /degrading to page timer \(REQ-04\)/.test(w))),
      true,
      'graceful degrade warning logged (REQ-04)',
    );
    assert.equal(bot.getState().tickerWorker, false);

    // Degraded path keeps the cadence running (page timer, throttled).
    assert.equal(
      await waitFor(() => casts.length > before, { timeout: 4000 }),
      true,
      'cadence continues after degrade (REQ-04)',
    );
  } finally {
    teardown(dom);
  }
});

test('REQ-12: threshold > maxMana rejected inline with the previous value kept', async () => {
  const { dom } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    const d = dom.window.document;

    d.querySelector('[data-ui-spell-threshold]').value = '999';
    d.querySelector('[data-ui-save]').click();

    assert.equal(
      await waitFor(() => /exceeds maxMana 120/.test(d.querySelector('[data-ui-errors]').textContent)),
      true,
      'inline error rendered (REQ-12)',
    );
    const persisted = JSON.parse(dom.window.localStorage.getItem('mb-config'));
    assert.equal(persisted.spells[0].threshold, 20, 'previous value kept (REQ-12)');
  } finally {
    teardown(dom);
  }
});

test('REQ-09: echo miss increments the validation-misses counter (no refire)', async () => {
  const { dom, casts } = makePage({ validationEnabled: true });
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    bot.start();

    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true);
    assert.equal(
      await waitFor(() => dom.window.document.querySelector('[data-hud-misses]').textContent === '1', { timeout: 6000 }),
      true,
      'miss counted after the echo window expires (REQ-09)',
    );
    assert.equal(casts.length, 5, 'miss does NOT refire the action (REQ-09)');
  } finally {
    teardown(dom);
  }
});

test('4.3: without a gameClient the bot stays unready and warns after the timeout', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  try {
    dom.window.__mbBootConfig = { pollIntervalMs: 5, readyTimeoutMs: 100 };
    dom.window.eval(BUNDLE);
    const bot = dom.window.__minibiaBot;
    assert.ok(bot);
    assert.equal(bot.isReady(), false);
    assert.equal(await waitFor(() => bot.getState().warnings.some((w) => /not found yet/.test(w))), true);
  } finally {
    teardown(dom);
  }
});

test('4.3: start before ready warns instead of crashing', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  try {
    dom.window.__mbBootConfig = { pollIntervalMs: 5, readyTimeoutMs: 100 };
    dom.window.eval(BUNDLE);
    const bot = dom.window.__minibiaBot;
    assert.equal(bot.start(), false);
    assert.equal(
      await waitFor(() => bot.getState().warnings.some((w) => /start: bot not ready/.test(w))),
      true,
    );
  } finally {
    teardown(dom);
  }
});

test('4.3: destroy removes the panel and stops the engine', async () => {
  const { dom, casts } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    bot.start();
    assert.equal(await waitFor(() => casts.length >= 1, { timeout: 4000 }), true);

    bot.destroy();
    assert.equal(dom.window.document.querySelector('[data-ui-panel]'), null, 'panel removed');
    const len = casts.length;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(casts.length, len, 'ticker stopped after destroy');
  } finally {
    teardown(dom);
  }
});
