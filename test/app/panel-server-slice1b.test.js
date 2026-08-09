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
