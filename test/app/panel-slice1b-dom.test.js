'use strict';

/**
 * Slice-1b panel jsdom tests (REQ-27/28, design D5/D6): the full cross-load
 * flow in a real DOM — Connect loads the castable spell catalog + profile
 * list, the "load config" button posts /api/load-profile and renders the
 * visible rejection list, and the picker Pick button pushes a validated
 * spell (mana rejection surfaces in the status bar).
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

/** Server-filtered catalog for a level-20 druid (what /api/spell-catalog
 *  returns): only castable spells, with costs. */
const CATALOG = [
  { sid: 0, name: 'Light', words: 'utevo lux', mana: 20, level: 0, vocations: ['sorcerer', 'druid'] },
  { sid: 3, name: 'Intense Healing', words: 'exura gran', mana: 170, level: 8, vocations: ['druid'] },
];

/**
 * jsdom shell with a route-based fetch stub that RECORDS every request
 * (method + parsed body) so tests can assert what the UI actually posted.
 * Routes: '/api/identity' -> payload, '/api/snapshot' -> payload, etc.
 */
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

/** Drive the gate to armed through the real effect path (dispatch, not
 *  clicks) and wait for the post-connect data fetches to settle. */
async function connectAndSettle(dom, waitMs = 60) {
  dom.window.__mbPanel.dispatch({ type: 'PROBE_START' });
  dom.window.__mbPanel.dispatch({ type: 'PROBE_RESULT', identity: FLAMAMEX });
  dom.window.__mbPanel.dispatch({ type: 'CONNECT' });
  await new Promise((r) => setTimeout(r, waitMs));
}

const CATALOG_CFG = { character: 'Flamamex', modules: { healMagic: { on: false }, training: { on: false } } };

test('2.5: Connect loads the castable catalog + profiles; the armed form offers the cross-load and the filtered picker', async () => {
  const { dom, requests } = makePanel({
    '/api/identity': () => ({ identity: FLAMAMEX }),
    '/api/snapshot': () => ({ stats: { health: 42, mana: 200, maxMana: 300 } }),
    '/api/character-config': () => ({ ok: true, config: CATALOG_CFG, warning: null }),
    '/api/connect': () => ({ ok: true, identity: FLAMAMEX, config: CATALOG_CFG }),
    '/api/spell-catalog': () => ({ ok: true, catalog: CATALOG, total: 2, playerLevel: 20, vocationLabel: 'druid' }),
    '/api/profiles': () => ({ ok: true, profiles: ['Flamamex', 'Gobernador'], current: 'Flamamex' }),
  });
  try {
    await connectAndSettle(dom);
    const state = dom.window.__mbPanel.getState();
    assert.equal(state.gate, 'armed');
    assert.equal(state.catalog.spells.length, 2, 'catalog fetched after Connect');
    assert.deepEqual(state.profiles, ['Flamamex', 'Gobernador']);

    const doc = dom.window.document;
    assert.ok(doc.getElementById('profile-select'), 'cross-load select rendered');
    assert.ok(doc.getElementById('profile-load-btn'), 'load button rendered');
    assert.match(doc.getElementById('config-form').textContent, /Gobernador/, 'profile offered');
    const pickerRows = doc.querySelectorAll('.picker-row');
    assert.equal(pickerRows.length, 2, 'only castable spells in the picker');
    assert.match(pickerRows[0].textContent, /Light/);
    assert.ok(!doc.getElementById('config-form').textContent.includes('Flame Strike'),
      'sorcerer-only spell never rendered');
    assert.ok(requests.some((r) => r.url === '/api/spell-catalog'), 'catalog RPC proxied');
    assert.ok(requests.some((r) => r.url === '/api/profiles'), 'profiles fetched');
  } finally {
    await teardown(dom);
  }
});

test('2.5: loading another profile posts /api/load-profile and renders the visible rejection list', async () => {
  const { dom, requests } = makePanel({
    '/api/identity': () => ({ identity: FLAMAMEX }),
    '/api/snapshot': () => ({ stats: { health: 42, mana: 200, maxMana: 300 } }),
    '/api/character-config': () => ({ ok: true, config: CATALOG_CFG, warning: null }),
    '/api/connect': () => ({ ok: true, identity: FLAMAMEX, config: CATALOG_CFG }),
    '/api/spell-catalog': () => ({ ok: true, catalog: CATALOG, total: 2, playerLevel: 20, vocationLabel: 'druid' }),
    '/api/profiles': () => ({ ok: true, profiles: ['Flamamex', 'Gobernador'], current: 'Flamamex' }),
    '/api/load-profile': () => ({
      ok: true,
      from: 'Gobernador',
      rejected: [{ key: 'healMagic.sid', reason: 'vocation mismatch — requires sorcerer' }],
      config: { character: 'Flamamex', modules: { healMagic: { on: true, sid: null }, training: { on: false } } },
    }),
  });
  try {
    await connectAndSettle(dom);
    click(dom, '#profile-load-btn');
    await new Promise((r) => setTimeout(r, 40));

    const req = requests.find((r) => r.url === '/api/load-profile');
    assert.ok(req, 'cross-load posted');
    assert.equal(req.method, 'POST');
    assert.equal(req.body.from, 'Gobernador');
    assert.equal(req.body.character, 'Flamamex');

    const doc = dom.window.document;
    const form = doc.getElementById('config-form');
    assert.match(form.textContent, /incompatible entries rejected/, 'result banner visible');
    assert.match(form.textContent, /healMagic\.sid/, 'rejected key visible');
    assert.match(form.textContent, /vocation mismatch — requires sorcerer/, 'rejection reason visible');
    assert.equal(dom.window.__mbPanel.getState().config.modules.healMagic.sid, null,
      'accepted config (sanitized) replaced the panel state');
  } finally {
    await teardown(dom);
  }
});

test('2.7: the Pick button posts the validated spell in /api/config', async () => {
  const { dom, requests } = makePanel({
    '/api/identity': () => ({ identity: FLAMAMEX }),
    '/api/snapshot': () => ({ stats: { health: 42, mana: 200, maxMana: 300 } }),
    '/api/character-config': () => ({ ok: true, config: CATALOG_CFG, warning: null }),
    '/api/connect': () => ({ ok: true, identity: FLAMAMEX, config: CATALOG_CFG }),
    '/api/spell-catalog': () => ({ ok: true, catalog: CATALOG, total: 2, playerLevel: 20, vocationLabel: 'druid' }),
    '/api/profiles': () => ({ ok: true, profiles: ['Flamamex'], current: 'Flamamex' }),
    '/api/config': () => ({ ok: true }),
  });
  try {
    await connectAndSettle(dom);
    click(dom, '.picker-pick[data-pick-spell="0"]'); // Light, costs 20 <= 200 mana
    await new Promise((r) => setTimeout(r, 40));

    const cfgReq = requests.find((r) => r.url === '/api/config');
    assert.ok(cfgReq, 'config push posted');
    assert.equal(cfgReq.body.config.modules.healMagic.sid, 0, 'picked sid carried to the server');
    assert.equal(dom.window.__mbPanel.getState().refusal, null, 'valid pick not refused');
    assert.match(dom.window.document.getElementById('config-form').textContent, /current/,
      'current pick marked');
  } finally {
    await teardown(dom);
  }
});

test('2.7: picking a spell beyond current mana shows the refusal in the status bar', async () => {
  const { dom, requests } = makePanel({
    '/api/identity': () => ({ identity: FLAMAMEX }),
    '/api/snapshot': () => ({ stats: { health: 42, mana: 80, maxMana: 300 } }), // 80 < 170
    '/api/character-config': () => ({ ok: true, config: CATALOG_CFG, warning: null }),
    '/api/connect': () => ({ ok: true, identity: FLAMAMEX, config: CATALOG_CFG }),
    '/api/spell-catalog': () => ({ ok: true, catalog: CATALOG, total: 2, playerLevel: 20, vocationLabel: 'druid' }),
    '/api/profiles': () => ({ ok: true, profiles: ['Flamamex'], current: 'Flamamex' }),
  });
  try {
    await connectAndSettle(dom);
    click(dom, '.picker-pick[data-pick-spell="3"]'); // Intense Healing costs 170
    await new Promise((r) => setTimeout(r, 40));

    const state = dom.window.__mbPanel.getState();
    assert.match(state.refusal.reason, /not enough mana — costs 170, you have 80/);
    assert.match(dom.window.document.getElementById('status-bar').textContent,
      /refused: not enough mana/, 'rejection visible in the status bar');
    assert.notEqual(state.config.modules.healMagic.sid, 3, 'no config write on refusal');
    assert.ok(!requests.some((r) => r.url === '/api/config'), 'no push for a refused pick');
  } finally {
    await teardown(dom);
  }
});
