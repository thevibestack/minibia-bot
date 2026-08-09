'use strict';

/**
 * Slice-1b panel server tests (REQ-27/28, design D5/D6): GET
 * /api/spell-catalog (proxy of the in-page getSpellCatalog RPC, filtered to
 * the CURRENT character's vocation + level), GET /api/profiles (cross-load
 * offer list), POST /api/load-profile (cross-load with per-sid rejection)
 * and the /api/config mana re-check (REQ-28). Real HTTP on an ephemeral
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
const GOBERNADOR = { name: 'Gobernador', vocationId: 3, vocationLabel: 'sorcerer' };

/** Live-probed catalog shape (obs 10457): vocations are string arrays. */
const RAW_CATALOG = [
  { sid: 0, name: 'Light', words: 'utevo lux', mana: 20, level: 0, vocations: ['sorcerer', 'druid'] },
  { sid: 3, name: 'Intense Healing', words: 'exura gran', mana: 170, level: 8, vocations: ['druid'] },
  { sid: 4, name: 'Flame Strike', words: 'exori flam', mana: 20, level: 5, vocations: ['sorcerer'] },
  { sid: 9, name: 'Ultimate Light', words: 'utevo vis lux', mana: 100, level: 30, vocations: ['sorcerer', 'druid'] },
];

/** Catalog RPC result for the current page player (druid, level 20). */
function rawCatalogWith(overrides) {
  return Object.assign({ spells: RAW_CATALOG, playerLevel: 20, vocationLabel: 'druid' }, overrides);
}

function makeBaseDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-panel1b-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Server with stub identity/applyConfig/snapshot + REAL store + mocked
 *  catalog RPC. `spellCatalog: null` disables the mock (degrade path). */
async function makeServer(t, overrides = {}) {
  const base = makeBaseDir(t);
  const calls = { applyConfig: [], spellCatalog: [], saveCount: 0 };
  const srv = await panelServer.createPanelServer({
    staticDir: STATIC_DIR,
    identity: overrides.identity || (async () => FLAMAMEX),
    applyConfig: async (config) => { calls.applyConfig.push(config); return true; },
    snapshot: overrides.snapshot || (async () => ({ stats: { health: 42, mana: 80 } })),
    spellCatalog: overrides.spellCatalog === null ? null : async () => {
      calls.spellCatalog.push(1);
      return (typeof overrides.spellCatalog === 'function' ? overrides.spellCatalog() : rawCatalogWith());
    },
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => { calls.saveCount += 1; return store.saveCharacter(Object.assign({ baseDir: base }, o)); },
      listCharacters: () => store.listCharacters(base),
    },
  });
  t.after(async () => { await srv.close(); });
  return { srv, calls, base };
}

function saveProfile(base, name, cfgOverrides = {}) {
  const cfg = store.defaultConfig(name);
  cfg.character = name;
  store.saveCharacter({ baseDir: base, name, config: Object.assign(cfg, cfgOverrides) });
}

/* ------------------------ /api/spell-catalog (2.2, D5) ------------------------ */

test('REQ-28: GET /api/spell-catalog proxies the RPC and filters by the current vocation + level', async (t) => {
  const { srv, calls } = await makeServer(t);
  const res = await fetch(srv.url + '/api/spell-catalog');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // Flamamex is a level-20 druid: sorcerer-only Flame Strike and the
  // level-30 Ultimate Light must NOT appear.
  assert.deepEqual(body.catalog.map((s) => s.sid), [0, 3]);
  assert.equal(body.total, 2);
  assert.equal(body.playerLevel, 20);
  assert.equal(body.vocationLabel, 'druid');
  assert.equal(calls.spellCatalog.length, 1, 'in-page RPC reached once');
});

test('REQ-28: GET /api/spell-catalog prefers the confirmed identity label over the page label', async (t) => {
  // Identity says druid even if the page probe had no label yet.
  const { srv } = await makeServer(t, {
    spellCatalog: () => rawCatalogWith({ vocationLabel: null }),
  });
  const body = await (await fetch(srv.url + '/api/spell-catalog')).json();
  assert.deepEqual(body.catalog.map((s) => s.sid), [0, 3], 'identity label applied');
});

test('REQ-28: GET /api/spell-catalog degrades honestly when the RPC is unavailable', async (t) => {
  const { srv, calls } = await makeServer(t, { spellCatalog: null });
  const body = await (await fetch(srv.url + '/api/spell-catalog')).json();
  assert.equal(body.ok, false);
  assert.match(body.reason, /unavailable/);
  assert.deepEqual(body.catalog, []);
  assert.equal(calls.spellCatalog.length, 0);
});

/* --------------------------- /api/profiles (2.3) --------------------------- */

test('REQ-27: GET /api/profiles lists every character with a saved config', async (t) => {
  const { srv, base } = await makeServer(t);
  saveProfile(base, 'Gobernador');
  saveProfile(base, 'Rooker');
  const body = await (await fetch(srv.url + '/api/profiles')).json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.profiles, ['Gobernador', 'Rooker']);
  assert.equal(body.current, 'Flamamex', 'current identity name carried for the UI');
});

test('REQ-27: GET /api/profiles returns an empty list when nothing is saved', async (t) => {
  const { srv } = await makeServer(t);
  const body = await (await fetch(srv.url + '/api/profiles')).json();
  assert.deepEqual(body.profiles, []);
  assert.equal(body.current, 'Flamamex');
});

/* ---------------------- /api/load-profile (2.4, D6) ---------------------- */

test('REQ-27: POST /api/load-profile cross-loads with per-sid rejection — incompatible spells blanked, rest applies', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  // Gobernador is a SORCERER: his config carries Flame Strike (sid 4,
  // sorcerer-only) as the heal spell and Intense Healing (sid 3, druid) as
  // training — the former MUST be rejected on Flamamex (druid).
  const gob = store.defaultConfig('Gobernador');
  gob.modules.healMagic = { on: true, threshold: 120, slot: 2, sid: 4, word: 'exori flam' };
  gob.modules.training = { on: true, slot: 3, sid: 3, reserve: 30 };
  gob.modules.trade = { on: true, message: 'WTS runes', intervalMs: 180000 };
  store.saveCharacter({ baseDir: base, name: 'Gobernador', config: gob });

  const res = await fetch(srv.url + '/api/load-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', from: 'Gobernador' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.from, 'Gobernador');
  assert.deepEqual(body.rejected, [
    { key: 'healMagic.sid', reason: 'vocation mismatch — requires sorcerer' },
  ]);
  assert.equal(body.config.character, 'Flamamex', 'accepted config renames to the current character');
  assert.equal(body.config.modules.healMagic.sid, null, 'rejected sid blanked');
  assert.equal(body.config.modules.training.sid, 3, 'compatible sid kept (the rest applies)');
  assert.equal(body.config.modules.training.reserve, 30);
  assert.equal(body.config.modules.trade.on, false, 'REQ-18 session-scoped trade OFF on load');
  assert.equal(calls.applyConfig.length, 1, 'one armed push');
  assert.equal(calls.applyConfig[0].armed, true);
  assert.equal(calls.applyConfig[0].modules.healMagic.sid, null, 'push carries the sanitized config');

  const reloaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.equal(reloaded.config.modules.healMagic.sid, null, 'sanitized config persisted');
  assert.equal(reloaded.config.modules.training.sid, 3, 'accepted part persisted');
});

test('REQ-27: load-profile rejects unknown and invalid sids', async (t) => {
  const { srv, base } = await makeServer(t);
  const gob = store.defaultConfig('Gobernador');
  gob.modules.healMagic = { on: true, threshold: 120, slot: 2, sid: 999 };
  gob.modules.training = { on: true, slot: 3, sid: 'abc' };
  store.saveCharacter({ baseDir: base, name: 'Gobernador', config: gob });

  const body = await (await fetch(srv.url + '/api/load-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', from: 'Gobernador' }),
  })).json();
  assert.deepEqual(body.rejected, [
    { key: 'healMagic.sid', reason: 'unknown spell (sid 999)' },
    { key: 'training.sid', reason: 'invalid spell id' },
  ]);
  assert.equal(body.config.modules.healMagic.sid, null);
  assert.equal(body.config.modules.training.sid, null);
});

test('REQ-27: load-profile refused while no character is connected', async (t) => {
  const { srv } = await makeServer(t);
  const res = await fetch(srv.url + '/api/load-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Gobernador' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, 'not connected');
});

test('REQ-27: load-profile requires the from profile name', async (t) => {
  const { srv } = await makeServer(t);
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  const res = await fetch(srv.url + '/api/load-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', from: '' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'from required');
});

test('REQ-27: load-profile refuses when the target is not the confirmed character', async (t) => {
  const { srv, base } = await makeServer(t);
  saveProfile(base, 'Gobernador');
  const res = await fetch(srv.url + '/api/load-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'SomeoneElse', from: 'Gobernador' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, 'character mismatch');
});

test('REQ-27: load-profile degrades when the spell catalog RPC is unavailable', async (t) => {
  const { srv, base } = await makeServer(t, { spellCatalog: null });
  saveProfile(base, 'Gobernador');
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  const res = await fetch(srv.url + '/api/load-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', from: 'Gobernador' }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).reason, 'spell catalog unavailable');
});
