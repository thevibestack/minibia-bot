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
  const uses = [];
  const gameClient = {
    player: {
      name: 'Flamamex',
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 100 },
      spellbook: {
        cooldowns: { GLOBAL_COOLDOWN: { active: false }, 24: { active: false } },
        spells: { 24: { cost: 20 }, 31: { cost: 15, words: 'exevo pan' } },
      },
      conditions: { has: (k) => (k === 'SATED' ? false : false) },
    },
    interface: {
      hotbarManager: {
        __handleClick: (index) => {
          const slot = index + 1; // real client: __handleClick is 0-based
          casts.push(slot);
          // Optional mana depletion so a repeat spell eventually becomes
          // infeasible and the every-Casts eat rule gets a tick.
          if (overrides.depleteMana) {
            gameClient.player.state.mana = Math.max(0, gameClient.player.state.mana - 20);
          }
        },
      },
      channelManager: {
        getChannel: () => ({ __contents: overrides.chatContents ?? [] }),
      },
    },
    mouse: { use: (args) => uses.push(args) },
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
    food: overrides.food ?? { slot: null, cid: null, name: '', warningWindowSec: 60, fallbackIntervalSec: 10 },
  };
  dom.window.gameClient = gameClient;
  dom.window.localStorage.setItem('mb-config', JSON.stringify(config));
  if (overrides.seedCatalog) {
    dom.window.localStorage.setItem('mb-catalog', JSON.stringify(overrides.seedCatalog));
  }
  dom.window.__mbBootConfig = { pollIntervalMs: 5, readyTimeoutMs: 2000 };
  dom.window.eval(BUNDLE);
  return { dom, casts, uses, config };
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

test('REQ-10/11: seeded mb-catalog localStorage -> full catalog mode (no keybind-only warning)', async () => {
  const { dom } = makePage({
    seedCatalog: [{ cid: 3582, name: 'seasoned ham', imageDataURL: null, npcTrades: [] }],
  });
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    assert.equal(bot.getState().catalogMode, 'full', 'localStorage seed wins over the fetch fallback');
    const warnings = Array.from(bot.getState().warnings);
    assert.ok(
      warnings.every((w) => !/keybind-only mode \(REQ-11\)/.test(w)),
      'no keybind-only warning when the seed is valid',
    );
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

test('food.everyCasts: forced eat fires after N confirmed casts, then the counter resets', async () => {
  const { dom, casts, uses } = makePage({
    spells: [
      { slot: 4, word: '', validationWord: '', threshold: 30, reserve: 0, repeat: 999, order: 1, cooldownMs: 0, sid: 24 },
    ],
    food: { slot: 1, cid: 3582, name: 'seasoned ham', warningWindowSec: 60, fallbackIntervalSec: 10, everyCasts: 3 },
    depleteMana: true,
  });
  try {
    const bot = dom.window.__minibiaBot;
    assert.equal(await waitFor(() => bot.isReady()), true);
    bot.start();

    // Mana 100 -> 20 (cost 20): exactly 4 casts land, counter reaches 4 >= 3.
    assert.equal(await waitFor(() => casts.length === 4, { timeout: 6000 }), true, 'N casts land');

    // With the cast rule infeasible, the eat rule fires once: forced attempt.
    assert.equal(
      await waitFor(() => dom.window.document.querySelector('[data-hud-eats]').textContent === '1', { timeout: 6000 }),
      true,
      'forced eat executed after N casts',
    );
    // Values live in the jsdom realm — normalize before comparing.
    assert.deepEqual(
      uses.map((u) => ({ which: u.which, index: u.index })),
      [{ which: 3, index: 1 }],
      'eat attempted via mouse.use on the food slot',
    );

    // Counter reset: the HUD shows the full cadence again (REQ-14) and the
    // eat rule does not refire while the counter is below N.
    assert.equal(
      await waitFor(() => dom.window.document.querySelector('[data-hud-every-casts]').textContent === 'every 3 (rem 3)'),
      true,
      'HUD surfaces the cadence with the reset counter',
    );
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(uses.length, 1, 'no refire while the counter is below N');
    assert.equal(casts.length, 4, 'no extra casts after mana depletes');
  } finally {
    teardown(dom);
  }
});

test('wizard: configure through the wizard, Start playing saves the config and runs the bot', async () => {
  const { dom, casts } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    const d = dom.window.document;
    assert.equal(await waitFor(() => bot.isReady()), true);

    // Seeded config pre-fills the wizard (slot 4 / adori) — walk 1 -> 5.
    for (let i = 0; i < 4; i++) d.querySelector('[data-ui-wizard-next]').click();
    assert.match(d.querySelector('[data-ui-step-indicator]').textContent, /Step 5 of 5/);
    d.querySelector('[data-ui-start]').click(); // Start playing

    assert.equal(
      await waitFor(() => casts.length >= 1, { timeout: 6000 }),
      true,
      'engine starts after Start playing',
    );
    const persisted = JSON.parse(dom.window.localStorage.getItem('mb-config'));
    assert.equal(persisted.spells[0].slot, 4, 'wizard values persisted');
    assert.equal(d.querySelector('[data-ui-run]').style.display, '', 'run view shown after start');
    assert.equal(d.querySelector('[data-ui-wizard]').style.display, 'none', 'wizard hidden after start');
  } finally {
    teardown(dom);
  }
});

test('panel: minimize while running keeps the mini bar live; expand restores', async () => {
  const { dom, casts } = makePage();
  try {
    const bot = dom.window.__minibiaBot;
    const d = dom.window.document;
    assert.equal(await waitFor(() => bot.isReady()), true);
    bot.start();
    assert.equal(await waitFor(() => casts.length === 5, { timeout: 6000 }), true);

    d.querySelector('[data-ui-minimize]').click();
    assert.equal(d.querySelector('[data-ui-body]').style.display, 'none');
    assert.equal(d.querySelector('[data-ui-mini]').style.display, 'flex');

    // The mini bar rides the HUD cadence: casts counter stays live.
    assert.equal(
      await waitFor(() => d.querySelector('[data-ui-mini-casts]').textContent === '5 casts', { timeout: 4000 }),
      true,
      'mini bar shows the live casts counter while running',
    );
    assert.equal(
      await waitFor(() => d.querySelector('[data-ui-mini-mana]').textContent === '100/120', { timeout: 4000 }),
      true,
      'mini bar shows live mana',
    );

    d.querySelector('[data-ui-mini-expand]').click();
    assert.equal(d.querySelector('[data-ui-body]').style.display, '');
    assert.equal(d.querySelector('[data-ui-mini]').style.display, 'none');
  } finally {
    teardown(dom);
  }
});

/** Start the bot through the wizard so the run view (offer surface) is shown. */
async function startViaWizard(dom, bot, casts) {
  const d = dom.window.document;
  assert.equal(await waitFor(() => bot.isReady()), true);
  for (let i = 0; i < 4; i++) d.querySelector('[data-ui-wizard-next]').click();
  d.querySelector('[data-ui-start]').click(); // Start playing
  assert.equal(await waitFor(() => casts.length >= 1, { timeout: 6000 }), true, 'engine running');
}

test('REQ-15: same unknown word twice within 5 minutes surfaces the registration offer', async () => {
  const chatContents = [];
  const { dom, casts } = makePage({ chatContents });
  try {
    const bot = dom.window.__minibiaBot;
    const d = dom.window.document;
    await startViaWizard(dom, bot, casts);

    const now = Date.now();
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 10 });
    assert.equal(
      await waitFor(() => d.querySelector('[data-hud-words]').textContent === '1', { timeout: 4000 }),
      true,
      'first sighting counted (REQ-15)',
    );
    assert.equal(d.querySelector('[data-ui-offer]').style.display, 'none', 'no offer after one sighting');

    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 20 });
    assert.equal(
      await waitFor(() => d.querySelector('[data-ui-offer]').style.display === '', { timeout: 4000 }),
      true,
      'second sighting within the window offers registration',
    );
    const text = d.querySelector('[data-ui-offer-text]').textContent;
    assert.match(text, /exevo pan/, 'offer names the unknown word');
    assert.match(text, /spell id 31/, 'sid inferred from the spellbook when available');
    assert.equal(d.querySelector('[data-hud-words]').textContent, '2', 'both sightings counted');
  } finally {
    teardown(dom);
  }
});

test('REQ-15: a word observed only once never offers, even after the window passes', async () => {
  const chatContents = [];
  const { dom, casts } = makePage({ chatContents });
  try {
    const bot = dom.window.__minibiaBot;
    const d = dom.window.document;
    await startViaWizard(dom, bot, casts);

    const now = Date.now();
    chatContents.push({ name: 'Flamamex', message: 'utori', __time: now + 10 });
    assert.equal(
      await waitFor(() => d.querySelector('[data-hud-words]').textContent === '1', { timeout: 4000 }),
      true,
      'single sighting counted',
    );
    await new Promise((r) => setTimeout(r, 800)); // several ticks elapse
    assert.equal(d.querySelector('[data-ui-offer]').style.display, 'none', 'single sighting never offers');
    assert.equal(
      d.querySelector('[data-hud-words]').textContent,
      '1',
      'the same entry is not double-counted across ticks',
    );
  } finally {
    teardown(dom);
  }
});

test('REQ-15: an already-configured word is ignored', async () => {
  const chatContents = [];
  const { dom, casts } = makePage({ chatContents }); // seeded config word: adori
  try {
    const bot = dom.window.__minibiaBot;
    const d = dom.window.document;
    await startViaWizard(dom, bot, casts);

    chatContents.push({ name: 'Flamamex', message: 'adori', __time: Date.now() + 10 });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(d.querySelector('[data-hud-words]').textContent, '0', 'configured word not counted');
    assert.equal(d.querySelector('[data-ui-offer]').style.display, 'none', 'no offer for a configured word');
  } finally {
    teardown(dom);
  }
});

test('REQ-15: Ignore makes the word session-silent; no offer reappears', async () => {
  const chatContents = [];
  const { dom, casts } = makePage({ chatContents });
  try {
    const bot = dom.window.__minibiaBot;
    const d = dom.window.document;
    await startViaWizard(dom, bot, casts);

    const now = Date.now();
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 10 });
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 20 });
    assert.equal(
      await waitFor(() => d.querySelector('[data-ui-offer]').style.display === '', { timeout: 4000 }),
      true,
      'offer appears before the decision',
    );
    d.querySelector('[data-ui-offer-ignore]').click();
    assert.equal(d.querySelector('[data-ui-offer]').style.display, 'none', 'banner hidden after Ignore');

    // Observed twice again later: the declined word must NOT offer again.
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 30 });
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 40 });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(
      d.querySelector('[data-ui-offer]').style.display,
      'none',
      'declined word stays silent this session (REQ-15)',
    );
  } finally {
    teardown(dom);
  }
});

test('REQ-15: Register writes the word into the config only on user confirmation', async () => {
  const chatContents = [];
  const { dom, casts } = makePage({ chatContents });
  try {
    const bot = dom.window.__minibiaBot;
    const d = dom.window.document;
    await startViaWizard(dom, bot, casts);

    const now = Date.now();
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 10 });
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 20 });
    assert.equal(
      await waitFor(() => d.querySelector('[data-ui-offer]').style.display === '', { timeout: 4000 }),
      true,
      'offer appears',
    );

    // Before confirming, the persisted config is untouched (REQ-15: no writes
    // without user confirmation).
    let persisted = JSON.parse(dom.window.localStorage.getItem('mb-config'));
    assert.equal(persisted.spells.some((s) => s.word === 'exevo pan'), false, 'no write before confirmation');

    const slotSel = d.querySelector('[data-ui-offer-slot]');
    assert.equal(slotSel.value, '1', 'first unused slot preselected (slot 4 is taken)');
    slotSel.value = '7';
    d.querySelector('[data-ui-offer-register]').click();

    assert.equal(
      await waitFor(() => {
        try {
          const cfg = JSON.parse(dom.window.localStorage.getItem('mb-config'));
          return cfg.spells.some((s) => s.word === 'exevo pan' && s.slot === 7);
        } catch {
          return false;
        }
      }, { timeout: 4000 }),
      true,
      'user-confirmed registration persisted (REQ-15)',
    );
    persisted = JSON.parse(dom.window.localStorage.getItem('mb-config'));
    const reg = persisted.spells.find((s) => s.word === 'exevo pan');
    assert.equal(reg.sid, 31, 'sid preserved when inferable');
    assert.equal(reg.threshold, 0, 'no mana threshold for a freshly registered word');

    // Now configured: further sightings are ignored, no offer reappears.
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 30 });
    chatContents.push({ name: 'Flamamex', message: 'exevo pan', __time: now + 40 });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(d.querySelector('[data-ui-offer]').style.display, 'none', 'no re-offer for a registered word');
  } finally {
    teardown(dom);
  }
});
