'use strict';

/**
 * Slice B — panel server hotkey tests (REQ-46, D-B3): GET /api/hotkeys reads
 * the keyboard surface (feature-detected) + the per-character configured
 * F-keys; POST /api/hotkeys {slot,key} RPCs setHotbarKeybind (writes
 * keyboard.__hotbarKeybinds) and persists training.hotkeys.runeKey/fallbackKey;
 * the connect flow restores the saved assignments. 409 while no character is
 * connected; 400 on invalid slot/key; honest {ok:false} when the RPC refuses
 * (display-only degrade — nothing persists). Real HTTP on an ephemeral
 * 127.0.0.1 port + real store on a temp dir.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const panelServer = require('../../app/panel/server.ts');
const store = require('../../app/store/characters.ts');

const STATIC_DIR = path.join(__dirname, '..', '..', 'app', 'panel');
const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

function makeBaseDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-panel-hotkeys-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Seed a config with the rune slot 2 + fallback slot 3. */
function seededConfig(name) {
  const cfg = store.defaultConfig(name);
  cfg.modules.training.slot = 2;
  cfg.modules.runes.fallbackSlot = 3;
  return cfg;
}

/** Server with stub identity/applyConfig/hotkey RPCs + REAL store. */
async function makeServer(t, overrides = {}) {
  const base = makeBaseDir(t);
  const calls = { applyConfig: [], hotkeys: { get: 0, set: [] } };
  const srv = await panelServer.createPanelServer({
    staticDir: STATIC_DIR,
    identity: overrides.identity || (async () => FLAMAMEX),
    applyConfig: async (config) => { calls.applyConfig.push(config); return true; },
    getHotbarKeybinds: async () => {
      calls.hotkeys.get += 1;
      return overrides.hotkeyRead === 'unavailable'
        ? { available: false }
        : { available: true, keybinds: { 2: 115 } };
    },
    setHotbarKeybind: async (opts) => {
      calls.hotkeys.set.push(opts);
      if (overrides.hotkeyWrite === 'unavailable') return { ok: false, reason: 'keyboard surface unavailable' };
      return { ok: true };
    },
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => store.saveCharacter(Object.assign({ baseDir: base }, o)),
    },
  });
  t.after(async () => { await srv.close(); });
  return { srv, calls, base };
}

async function connect(srv, name = 'Flamamex') {
  const res = await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: name }),
  });
  assert.equal(res.status, 200, 'connect ok');
}

test('REQ-46: GET /api/hotkeys returns the keyboard surface + configured F-keys', async (t) => {
  const { srv, base } = await makeServer(t);
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: seededConfig('Flamamex') });
  await connect(srv);

  const res = await fetch(srv.url + '/api/hotkeys');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.available, true);
  assert.deepEqual(body.keybinds, { 2: 115 });
  assert.deepEqual(body.configured, { runeKey: 'F4', fallbackKey: 'F5' }, 'store defaults');
});

test('REQ-46: GET /api/hotkeys refused while no character is connected (409)', async (t) => {
  const { srv } = await makeServer(t);
  const res = await fetch(srv.url + '/api/hotkeys');
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.reason, 'not connected');
});

test('REQ-46: POST /api/hotkeys RPCs setHotbarKeybind, persists and returns ok', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: seededConfig('Flamamex') });
  await connect(srv);
  const afterRestore = calls.hotkeys.set.length; // the connect restore already wrote F4/F5 defaults

  // Rune slot (2) -> runeKey; fallback slot (3) -> fallbackKey.
  const runeRes = await fetch(srv.url + '/api/hotkeys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', slot: 2, key: 'F4' }),
  });
  assert.equal(runeRes.status, 200);
  assert.equal((await runeRes.json()).ok, true);

  const fallbackRes = await fetch(srv.url + '/api/hotkeys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', slot: 3, key: 'F5' }),
  });
  assert.equal(fallbackRes.status, 200);
  assert.equal((await fallbackRes.json()).ok, true);

  assert.deepEqual(calls.hotkeys.set.slice(afterRestore), [
    { slot: 2, keyCode: 115 }, // F4 = 112 + 3
    { slot: 3, keyCode: 116 }, // F5 = 112 + 4
  ], 'setHotbarKeybind RPC reached with keyCodes');
  const saved = store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config;
  assert.deepEqual(saved.modules.training.hotkeys, { runeKey: 'F4', fallbackKey: 'F5' }, 'keys persisted per character');
});

test('REQ-46: POST /api/hotkeys refuses invalid slot/key (400) and disconnected (409)', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: seededConfig('Flamamex') });

  const disconnected = await fetch(srv.url + '/api/hotkeys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: 2, key: 'F4' }),
  });
  assert.equal(disconnected.status, 409);

  await connect(srv);
  const afterRestore = calls.hotkeys.set.length;
  const bad = await fetch(srv.url + '/api/hotkeys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', slot: 0, key: 'F4' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).reason, /invalid hotkey/);
  const badKey = await fetch(srv.url + '/api/hotkeys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', slot: 2, key: 'F13' }),
  });
  assert.equal(badKey.status, 400);
  assert.equal(calls.hotkeys.set.length, afterRestore, 'no RPC for invalid input');
});

test('REQ-46: POST /api/hotkeys degrades when the keyboard surface refuses — nothing persists', async (t) => {
  const { srv, base } = await makeServer(t, { hotkeyWrite: 'unavailable' });
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: seededConfig('Flamamex') });
  await connect(srv);

  const res = await fetch(srv.url + '/api/hotkeys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', slot: 2, key: 'F4' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false, 'honest refusal when the surface is absent');
  assert.equal(body.reason, 'keyboard surface unavailable');
  const saved = store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config;
  assert.deepEqual(saved.modules.training.hotkeys, { runeKey: 'F4', fallbackKey: 'F5' }, 'store defaults kept (no persist)');
});

test('REQ-46: connect restores the saved hotkey assignments to the game surface', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  const cfg = seededConfig('Flamamex');
  cfg.modules.training.hotkeys = { runeKey: 'F6', fallbackKey: 'F7' };
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });

  await connect(srv);
  assert.deepEqual(calls.hotkeys.set, [
    { slot: 2, keyCode: 117 }, // F6 = 112 + 5
    { slot: 3, keyCode: 118 }, // F7 = 112 + 6
  ], 'saved F-keys restored to the rune + fallback slots on connect');
});

test('REQ-46: connect restore is a no-op when the keyboard surface is absent', async (t) => {
  const { srv, calls, base } = await makeServer(t, { hotkeyWrite: 'unavailable' });
  const cfg = seededConfig('Flamamex');
  cfg.modules.training.hotkeys = { runeKey: 'F4', fallbackKey: 'F5' };
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });

  await connect(srv);
  assert.deepEqual(calls.hotkeys.set, [
    { slot: 2, keyCode: 115 },
    { slot: 3, keyCode: 116 },
  ], 'restore attempted; the RPC refused silently (degrade)');
});
