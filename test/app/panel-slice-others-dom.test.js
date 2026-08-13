'use strict';

/**
 * PR 5 — OTHERS tab jsdom tests (REQ-33/34, D9): typing the settings form
 * + Save posts /api/config with the parsed anti-bot replies and loot
 * destination; NEW anti-bot alerts in the snapshot raise the panel ALERT and
 * ring the Web Audio beep exactly once per alert id; the pending confirm
 * prompt renders and its Confirm button posts /api/antibot-confirm.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PANEL_DIR = path.join(__dirname, '..', '..', 'app', 'panel');
const INDEX_HTML = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8');
const STATE_JS = fs.readFileSync(path.join(PANEL_DIR, 'state.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(PANEL_DIR, 'app.js'), 'utf8');

const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

const BASE_CFG = {
  character: 'Flamamex',
  modules: {
    healItems: { on: false },
    healMagic: { on: false },
    runes: { on: false },
    training: { on: false },
    eat: { on: false, slot: null, everyCasts: 0 },
    loot: { on: true, defaultDest: 'Dust bag', perMonster: {} },
    antibot: { on: false, replies: [{ pattern: 'hi', reply: 'hello' }] },
  },
};

/** jsdom shell with a route-based fetch stub that RECORDS every request. */
function makePanel(routes) {
  const requests = [];
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://127.0.0.1:9222/',
    runScripts: 'dangerously',
  });
  dom.window.fetch = async (url, opts) => {
    const entry = {
      url: String(url).split('?')[0],
      method: opts && opts.method ? opts.method : 'GET',
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    };
    requests.push(entry);
    const handler = routes[entry.url];
    if (typeof handler !== 'function') return { status: 404, json: async () => ({ ok: false }) };
    const payload = handler(entry);
    return { status: 200, json: async () => payload };
  };
  dom.window.eval(STATE_JS);
  dom.window.localStorage.setItem('tutorialSeen', '1'); // skip the tour overlay
  dom.window.eval(APP_JS);
  return { dom, requests };
}

async function teardown(dom) {
  await new Promise((r) => setTimeout(r, 30));
  try {
    if (dom.window.__mbPanel && typeof dom.window.__mbPanel.stop === 'function') dom.window.__mbPanel.stop();
  } catch { /* best-effort */ }
  dom.window.close();
}

function click(dom, selector) {
  const el = dom.window.document.querySelector(selector);
  assert.ok(el, 'element ' + selector + ' rendered');
  el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

function type(dom, id, value) {
  const el = dom.window.document.getElementById(id);
  assert.ok(el, 'input ' + id + ' rendered');
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

/** Stub the Web Audio beep (feature-detect surface) and count creations. */
function stubAudio(dom) {
  let beeps = 0;
  dom.window.AudioContext = class {
    constructor() { beeps += 1; }
    createOscillator() {
      return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {}, onended: null };
    }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    get currentTime() { return 0; }
    get destination() { return {}; }
    close() { return Promise.resolve(); }
  };
  return () => beeps;
}

/** Connect through the real effect path. */
async function connect(dom) {
  dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
  dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: FLAMAMEX });
  dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(dom.window.__mbPanel.getState().gate, 'armed');
}

const ROUTES = {
  '/api/identity': () => ({ identity: FLAMAMEX }),
  '/api/snapshot': () => ({ stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 } }),
  '/api/character-config': () => ({ ok: true, config: BASE_CFG, warning: null }),
  '/api/connect': () => ({ ok: true, identity: FLAMAMEX, config: BASE_CFG }),
  '/api/spell-catalog': () => ({ ok: true, catalog: [], total: 0, playerLevel: 20, vocationLabel: 'druid' }),
  '/api/profiles': () => ({ ok: true, profiles: ['Flamamex'], current: 'Flamamex' }),
  '/api/config': () => ({ ok: true }),
  '/api/antibot-confirm': () => ({ ok: true, pattern: 'verify your account', confirmed: ['verify your account'] }),
};

test('Hidden-module scope (PR5, jsdom): the OTHERS form is food-only and preserves the hidden loot/antibot config', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);

    type(dom, 'others-food-slot', '2');
    type(dom, 'others-every-casts', '5');

    // A snapshot re-render must not wipe the typed values.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(dom.window.document.getElementById('others-food-slot').value, '2', 'food slot survives re-render');
    assert.equal(dom.window.document.getElementById('others-every-casts').value, '5', 'cadence survives re-render');
    assert.equal(dom.window.document.getElementById('others-loot-dest'), null, 'no loot destination field');
    assert.equal(dom.window.document.getElementById('others-replies'), null, 'no anti-bot replies field');

    click(dom, '#others-save-btn');
    await new Promise((r) => setTimeout(r, 40));

    const cfgReqs = requests.filter((r) => r.url === '/api/config');
    assert.ok(cfgReqs.length >= 1, 'config push posted');
    const cfg = cfgReqs[cfgReqs.length - 1].body.config;
    assert.equal(cfg.modules.eat.slot, 2);
    assert.equal(cfg.modules.eat.everyCasts, 5);
    assert.equal(cfg.modules.loot.defaultDest, 'Dust bag', 'hidden loot config preserved on a food-only save');
    assert.deepEqual(cfg.modules.antibot.replies, [{ pattern: 'hi', reply: 'hello' }],
      'hidden anti-bot config preserved');
    assert.equal(dom.window.__mbPanel.getState().refusal, null, 'valid save not refused');
  } finally {
    await teardown(dom);
  }
});

test('REQ-01 (PR4, jsdom): the unified food form saves eat.magic + safetyNetMinutes — no training.eatWithMagic anywhere', async () => {
  const LIVE_SPELLS = [
    { sid: 12, name: 'Food', words: 'exevo pan', mana: 0, level: 1, vocations: [] },
    { sid: 2, name: 'Healing', words: 'exura', mana: 25, level: 1, vocations: [] },
  ];
  const routes = Object.assign({}, ROUTES, {
    '/api/spell-catalog': () => ({ ok: true, catalog: LIVE_SPELLS, total: 2, playerLevel: 20, vocationLabel: 'druid' }),
    '/api/hotbar': () => ({ ok: true, available: true, slots: [{ slot: 8, sid: 12 }] }),
  });
  const { dom, requests } = makePanel(routes);
  try {
    await connect(dom);

    type(dom, 'others-food-slot', '2');
    type(dom, 'others-every-casts', '5');
    const magicToggle = dom.window.document.getElementById('others-food-magic-enabled');
    assert.ok(magicToggle, 'magic toggle rendered');
    magicToggle.checked = true;
    magicToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const magicSelect = dom.window.document.getElementById('others-food-magic-select');
    assert.ok(magicSelect, 'food spell select rendered once enabled');
    assert.deepEqual(Array.from(magicSelect.options).map((o) => o.value), ['', '12'], 'select lists only live food spells');
    magicSelect.value = '12';
    magicSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    type(dom, 'others-food-safety-net', '30');

    // A snapshot re-render must not wipe the typed values.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(dom.window.document.getElementById('others-food-slot').value, '2');
    assert.equal(dom.window.document.getElementById('others-every-casts').value, '5');
    assert.equal(dom.window.document.getElementById('others-food-safety-net').value, '30');

    click(dom, '#others-save-btn');
    await new Promise((r) => setTimeout(r, 40));

    const cfgReqs = requests.filter((r) => r.url === '/api/config');
    assert.ok(cfgReqs.length >= 1, 'config push posted');
    const cfg = cfgReqs[cfgReqs.length - 1].body.config;
    assert.equal(cfg.modules.eat.slot, 2);
    assert.equal(cfg.modules.eat.everyCasts, 5);
    assert.equal(cfg.modules.eat.safetyNetMinutes, 30);
    assert.deepEqual(cfg.modules.eat.magic, { enabled: true, slot: 8, sid: 12 },
      'unified eat.magic written with the live F-slot');
    assert.equal(cfg.modules.training.eatWithMagic, undefined, 'no legacy eatWithMagic in the posted config (REQ-01)');
    assert.equal(dom.window.__mbPanel.getState().refusal, null);
  } finally {
    await teardown(dom);
  }
});

test('REQ-33 (PR5, jsdom): NEW anti-bot alerts raise the panel ALERT + beep exactly once per id', async () => {
  let alertList = [];
  const snapshotRoute = () => ({
    stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 },
    agent: { modules: { antibot: { on: true, pendingConfirm: null, alerts: alertList } } },
  });
  const routes = Object.assign({}, ROUTES, { '/api/snapshot': snapshotRoute });
  const { dom } = makePanel(routes);
  try {
    const beeps = stubAudio(dom);
    await connect(dom);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(dom.window.__mbPanel.getState().alerts.length, 0, 'no alert with an empty window');
    assert.equal(beeps(), 0, 'no beep with an empty window');

    alertList = [{ id: 1, kind: 'speak', message: 'GM-Test speaks: "stop botting"', at: 1 }];
    await new Promise((r) => setTimeout(r, 600));
    let alerts = dom.window.__mbPanel.getState().alerts;
    assert.ok(alerts.some((a) => a.kind === 'antibot-speak'), 'panel ALERT raised for the new anti-bot alert');
    assert.equal(beeps(), 1, 'the Web Audio beep stub rang exactly once');

    // A second NEW alert id rings once more; a repeated id stays silent.
    alertList = [
      { id: 1, kind: 'speak', message: 'GM-Test speaks: "stop botting"', at: 1 },
      { id: 2, kind: 'moved', message: 'player moved to (100, 200)', at: 2 },
    ];
    await new Promise((r) => setTimeout(r, 600));
    alerts = dom.window.__mbPanel.getState().alerts;
    assert.ok(alerts.some((a) => a.kind === 'antibot-moved'), 'second alert raised');
    assert.equal(beeps(), 2, 'one beep per NEW alert id (no repeats)');

    await new Promise((r) => setTimeout(r, 600));
    assert.equal(beeps(), 2, 'steady state -> no repeated beeps');
  } finally {
    await teardown(dom);
  }
});

test('REQ-34 (PR5, jsdom): the pending confirm prompt renders and Confirm posts /api/antibot-confirm', async () => {
  const pending = {
    pattern: 'verify your account',
    reply: 'ok then',
    at: 1,
  };
  const snapshotRoute = () => ({
    stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 },
    agent: { modules: { antibot: { on: true, pendingConfirm: pending, alerts: [] } } },
  });
  const routes = Object.assign({}, ROUTES, { '/api/snapshot': snapshotRoute });
  const { dom, requests } = makePanel(routes);
  try {
    await connect(dom);
    await new Promise((r) => setTimeout(r, 600));
    const prompt = dom.window.document.querySelector('.antibot-confirm-prompt');
    assert.ok(prompt, 'confirm prompt rendered from the snapshot pending state');
    assert.ok(prompt.textContent.includes('verify your account'), 'pattern shown');

    click(dom, '.antibot-confirm-btn');
    await new Promise((r) => setTimeout(r, 40));

    const confirmReqs = requests.filter((r) => r.url === '/api/antibot-confirm');
    assert.ok(confirmReqs.length >= 1, '/api/antibot-confirm posted');
    assert.equal(confirmReqs[confirmReqs.length - 1].body.pattern, 'verify your account');
    assert.equal(confirmReqs[confirmReqs.length - 1].body.character, 'Flamamex');
  } finally {
    await teardown(dom);
  }
});
