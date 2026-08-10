'use strict';

/**
 * PR 4 — TRAINER tab jsdom tests (REQ-30/31/32, D3/D4): typing the settings
 * form + Save posts /api/config with the percent->ratio conversions and
 * eat-with-magic; the cap-full snapshot state raises the panel ALERT and
 * rings the Web Audio beep on the RISING edge only.
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
    runes: { on: false, capMode: 'strict', capFullThreshold: 1.0, fallbackSlot: null, fallbackManaPct: 0.5 },
    training: { on: false, reserve: 0, eatWithMagic: { enabled: false, slot: null, sid: null } },
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
};

test('REQ-30/31/32 (PR4, jsdom): typing the TRAINER form + Save posts /api/config with converted ratios', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);

    // Type the form: strict cap at 100%, fallback slot 3 at 50% mana,
    // reserve 30, eat-with-magic on with the magic-food slot 5.
    type(dom, 'trainer-cap-threshold', '100');
    type(dom, 'trainer-fallback-slot', '3');
    type(dom, 'trainer-fallback-pct', '50');
    type(dom, 'trainer-reserve', '30');
    const ew = dom.window.document.getElementById('trainer-eat-magic');
    ew.checked = true;
    ew.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    type(dom, 'trainer-eat-magic-slot', '5');

    // A snapshot re-render must not wipe the typed values.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(dom.window.document.getElementById('trainer-cap-threshold').value, '100', 'cap % survives re-render');
    assert.equal(dom.window.document.getElementById('trainer-fallback-slot').value, '3', 'fallback slot survives re-render');
    assert.equal(dom.window.document.getElementById('trainer-reserve').value, '30', 'reserve survives re-render');
    assert.equal(dom.window.document.getElementById('trainer-eat-magic-slot').value, '5', 'eat slot survives re-render');

    click(dom, '#trainer-save-btn');
    await new Promise((r) => setTimeout(r, 40));

    const cfgReqs = requests.filter((r) => r.url === '/api/config');
    assert.ok(cfgReqs.length >= 1, 'config push posted');
    const cfg = cfgReqs[cfgReqs.length - 1].body.config;
    assert.equal(cfg.modules.runes.capMode, 'strict');
    assert.equal(cfg.modules.runes.capFullThreshold, 1, '100% converted to ratio 1.0');
    assert.equal(cfg.modules.runes.fallbackSlot, 3);
    assert.equal(cfg.modules.runes.fallbackManaPct, 0.5, '50% converted to ratio 0.5');
    assert.equal(cfg.modules.training.reserve, 30);
    assert.equal(cfg.modules.training.eatWithMagic.enabled, true);
    assert.equal(cfg.modules.training.eatWithMagic.slot, 5);
    assert.equal(dom.window.__mbPanel.getState().refusal, null, 'valid save not refused');
  } finally {
    await teardown(dom);
  }
});

test('REQ-30 (PR4, jsdom): capFull snapshot state raises the panel ALERT + beep on the rising edge', async () => {
  let capFull = false;
  const snapshotRoute = () => ({
    stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 },
    agent: { modules: { training: { on: true, capFull, cap: { capacity: 400, maxCapacity: 400, ratio: 1 } } } },
  });
  const routes = Object.assign({}, ROUTES, { '/api/snapshot': snapshotRoute });
  const { dom } = makePanel(routes);
  try {
    const beeps = stubAudio(dom);
    await connect(dom);
    await new Promise((r) => setTimeout(r, 40)); // first poll: capFull false
    assert.equal(dom.window.__mbPanel.getState().alerts.length, 0, 'no alert while the cap is not full');
    assert.equal(beeps(), 0, 'no beep while the cap is not full');

    capFull = true; // next snapshot poll sees the rising edge
    await new Promise((r) => setTimeout(r, 600));
    const alerts = dom.window.__mbPanel.getState().alerts;
    assert.ok(alerts.some((a) => a.kind === 'cap-full'), 'panel ALERT raised on the cap-full rising edge');
    assert.equal(beeps(), 1, 'the Web Audio beep stub rang exactly once (rising edge)');

    // Steady state: cap stays full -> NO repeated alert/beep.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(dom.window.__mbPanel.getState().alerts.filter((a) => a.kind === 'cap-full').length, 1, 'no repeated alerts');
    assert.equal(beeps(), 1, 'no repeated beeps');
  } finally {
    await teardown(dom);
  }
});

test('REQ-30 (PR4, jsdom): the TRAINER settings form is NOT rendered before Connect', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await new Promise((r) => setTimeout(r, 250)); // identity confirms without Connect
    assert.equal(dom.window.__mbPanel.getState().gate, 'confirmed');
    assert.ok(!dom.window.document.getElementById('trainer-save-btn'), 'no trainer form pre-Connect');
    assert.ok(!requests.some((r) => r.url === '/api/config'), 'no config push pre-Connect');
  } finally {
    await teardown(dom);
  }
});

test('REQ-41 (PR A, jsdom): the rune-check banner renders and Resume posts /api/runecheck-resume', async () => {
  const routes = Object.assign({}, ROUTES, {
    '/api/snapshot': () => ({
      stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 },
      agent: { runeCheck: { active: true, at: 1, kind: 'chat', lastSeenAt: 1 } },
    }),
    '/api/runecheck-resume': () => ({ ok: true }),
  });
  const { dom, requests } = makePanel(routes);
  try {
    await connect(dom);
    await new Promise((r) => setTimeout(r, 600)); // a snapshot poll lands the banner
    const btn = dom.window.document.getElementById('runecheck-resume-btn');
    assert.ok(btn, 'resume button rendered from the snapshot banner');
    assert.match(btn.parentElement.textContent, /Rune check detected/, 'localized banner text');

    click(dom, '#runecheck-resume-btn');
    await new Promise((r) => setTimeout(r, 40));
    const resumeReqs = requests.filter((r) => r.url === '/api/runecheck-resume');
    assert.ok(resumeReqs.length >= 1, '/api/runecheck-resume posted');
    assert.equal(resumeReqs[resumeReqs.length - 1].method, 'POST');
    assert.equal(resumeReqs[resumeReqs.length - 1].body.character, 'Flamamex');
  } finally {
    await teardown(dom);
  }
});

test('REQ-42 (B, jsdom): the TRAINER form renders as a 2-column grid with the kept ids', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    await connect(dom);
    const doc = dom.window.document;
    assert.ok(doc.querySelector('.trainer-grid'), 'grid container rendered');
    assert.equal(doc.querySelectorAll('.trainer-col').length, 2, 'two columns');
    for (const id of ['trainer-cap-mode', 'trainer-cap-threshold', 'trainer-fallback-slot',
      'trainer-fallback-pct', 'trainer-reserve', 'trainer-eat-magic', 'trainer-eat-magic-slot',
      'trainer-save-btn', 'trainer-rune-select', 'trainer-rune-key', 'trainer-rune-assign',
      'trainer-fallback-key', 'trainer-fallback-assign', 'trainer-sound-alert',
      'trainer-auto-fallback', 'trainer-stop-runes', 'trainer-stop-botting']) {
      assert.ok(doc.getElementById(id), id + ' rendered');
    }
    assert.ok(doc.querySelector('.bar.mana-bar'), 'mana bar rendered');
    assert.ok(doc.querySelector('.bar.cap-bar'), 'CAP bar rendered');
  } finally {
    await teardown(dom);
  }
});

test('REQ-43 (B, jsdom): the bars render values, percent and fill width from the snapshot', async () => {
  const routes = Object.assign({}, ROUTES, {
    '/api/snapshot': () => ({
      stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 },
      agent: { modules: { training: { on: true, cap: { capacity: 400, maxCapacity: 500, ratio: 0.8 } } } },
    }),
  });
  const { dom } = makePanel(routes);
  try {
    await connect(dom);
    await new Promise((r) => setTimeout(r, 600)); // a snapshot poll lands the stats + cap
    const doc = dom.window.document;
    const manaBar = doc.querySelector('.bar.mana-bar');
    assert.ok(manaBar, 'mana bar rendered');
    assert.match(manaBar.textContent, /80%/, 'mana percent shown');
    assert.match(manaBar.textContent, /400 \/ 500/, 'mana cur/max shown');
    assert.match(manaBar.querySelector('.bar-fill').getAttribute('style'), /width:80%/, 'mana fill width');
    const capBar = doc.querySelector('.bar.cap-bar');
    assert.ok(capBar, 'cap bar rendered');
    assert.match(capBar.textContent, /80%/, 'cap percent shown');
    assert.match(capBar.textContent, /400 \/ 500/, 'cap cur/max shown');
    assert.match(capBar.querySelector('.bar-fill').getAttribute('style'), /width:80%/, 'cap fill width');
  } finally {
    await teardown(dom);
  }
});

test('REQ-42 (B, jsdom): the inline rune select lists only rune spells from the catalog', async () => {
  const routes = Object.assign({}, ROUTES, {
    '/api/spell-catalog': () => ({
      ok: true,
      catalog: [
        { sid: 1, name: 'Blank Rune', words: 'adori vita', mana: 100, level: 1, vocations: [] },
        { sid: 2, name: 'Sudden Death Rune', words: 'adori tera', mana: 120, level: 2, vocations: [] },
        { sid: 3, name: 'Light Heal', words: 'exura', mana: 20, level: 1, vocations: [] },
      ],
      total: 3, playerLevel: 20, vocationLabel: 'druid',
    }),
  });
  const { dom } = makePanel(routes);
  try {
    await connect(dom);
    await new Promise((r) => setTimeout(r, 100)); // the connect fetches the catalog
    const select = dom.window.document.getElementById('trainer-rune-select');
    assert.ok(select, 'rune select rendered');
    const options = Array.from(select.options).map((o) => o.value);
    assert.deepEqual(options, ['1', '2'], 'only rune spells listed (Light Heal excluded)');
    assert.ok(!dom.window.document.querySelector('.trainer-note'), 'no fallback note when runes matched');
  } finally {
    await teardown(dom);
  }
});

test('REQ-44 (B, jsdom): the Auto Fallback Magic and Sound Alert toggles wire their actions', async () => {
  const { dom } = makePanel(ROUTES);
  try {
    await connect(dom);
    const af = dom.window.document.getElementById('trainer-auto-fallback');
    af.checked = true;
    af.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(dom.window.__mbPanel.getState().trainerForm.autoFallback, 'true', 'auto fallback stored in the form');
    const sa = dom.window.document.getElementById('trainer-sound-alert');
    sa.checked = false;
    sa.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(dom.window.__mbPanel.getState().soundEnabled, false, 'sound alert maps to SET_SOUND');
  } finally {
    await teardown(dom);
  }
});

test('REQ-45 (B, jsdom): Stop Botting opens the confirm overlay; Yes pushes a runes-off config with heal on', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    // Heal stays ON before the stop — the assertion proves heal/eat continue.
    const heal = dom.window.document.querySelector('input[data-module="healItems"]');
    heal.checked = true;
    heal.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    // Fill the required trainer fields (PR4 save contract), eat-magic OFF.
    type(dom, 'trainer-cap-threshold', '100');
    type(dom, 'trainer-fallback-pct', '50');
    type(dom, 'trainer-reserve', '30');
    const ew = dom.window.document.getElementById('trainer-eat-magic');
    ew.checked = false;
    ew.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    const beforeStop = requests.filter((r) => r.url === '/api/config').length;

    const sb = dom.window.document.getElementById('trainer-stop-botting');
    sb.checked = true;
    sb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    click(dom, '#trainer-save-btn');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(dom.window.document.getElementById('confirm-stop-yes'), 'confirm overlay rendered');
    assert.equal(requests.filter((r) => r.url === '/api/config').length, beforeStop, 'no push while the confirm is pending');

    click(dom, '#confirm-stop-yes');
    await new Promise((r) => setTimeout(r, 40));
    const cfgReqs = requests.filter((r) => r.url === '/api/config');
    assert.ok(cfgReqs.length >= beforeStop + 1, 'config push posted after Yes');
    const lastCfg = cfgReqs[cfgReqs.length - 1].body.config;
    assert.equal(lastCfg.modules.runes.on, false, 'runes off in the push');
    assert.equal(lastCfg.modules.healItems.on, true, 'healing continues');
    assert.ok(dom.window.document.querySelector('.alert-stop-botting'), 'persistent stop-botting banner rendered');
  } finally {
    await teardown(dom);
  }
});

test('REQ-45 (B, jsdom): No on the confirm overlay posts nothing and closes it', async () => {
  const { dom, requests } = makePanel(ROUTES);
  try {
    await connect(dom);
    type(dom, 'trainer-cap-threshold', '100');
    type(dom, 'trainer-fallback-pct', '50');
    type(dom, 'trainer-reserve', '30');
    const ew = dom.window.document.getElementById('trainer-eat-magic');
    ew.checked = false;
    ew.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const sb = dom.window.document.getElementById('trainer-stop-botting');
    sb.checked = true;
    sb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    click(dom, '#trainer-save-btn');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(dom.window.document.getElementById('confirm-stop-yes'), 'overlay opened');

    click(dom, '#confirm-stop-no');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!dom.window.document.getElementById('confirm-stop-yes'), 'overlay closed after No');
    assert.ok(!requests.some((r) => r.url === '/api/config'), 'no config push after No');
  } finally {
    await teardown(dom);
  }
});
