'use strict';

/**
 * Offline catalog tests (task 3.6, REQ-07): the bundled app assets load and
 * resolve lookups with NO network, and corrupt/missing assets degrade to
 * null instead of crashing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const catalog = require('../../app/catalog.ts');

const ASSETS_DIR = path.join(__dirname, '..', '..', 'app', 'assets');

test('REQ-07: bundled catalog.json loads offline with the full entry count', () => {
  const cat = catalog.createCatalog();
  assert.ok(cat, 'assets present');
  assert.equal(cat.entries.length, 12356, 'catalog.json = 12,356 entries (REQ-07)');
  assert.ok(fs.existsSync(path.join(ASSETS_DIR, 'catalog.json')));
});

test('REQ-07: lookups resolve by cid, by name, and by rune word (no network)', () => {
  const cat = catalog.createCatalog();
  const entry = cat.index.byCid.get(3174);
  assert.equal(entry.name, 'light magic missile rune');
  assert.equal(entry.runeSpellName, 'adori', 'rune spell word (REQ-15 groundwork)');
  assert.equal(catalog.runeWordForCid(cat, 3174), 'adori');

  const ham = catalog.findByName(cat.index, 'seasoned ham');
  assert.ok(ham && ham[0].cid === 3582, 'by-name lookup case-insensitive');
  const mixed = catalog.findByName(cat.index, 'SEASONED HAM');
  assert.ok(mixed && mixed[0].cid === 3582, 'case-insensitive name lookup');

  const runes = cat.index.byRuneWord.get('adori');
  assert.ok(runes && runes.length >= 1, 'rune-word index');
});

test('REQ-07: every entry has the shape the panel/agent needs', () => {
  const cat = catalog.createCatalog();
  for (const e of cat.entries.slice(0, 500)) {
    assert.equal(typeof e.cid, 'number');
    assert.equal(typeof e.name, 'string');
    assert.ok(Array.isArray(e.npcTrades), 'npcTrades array per entry');
  }
});

test('REQ-07: npcTrades.json asset loads as normalized flat rows (W-1 live shape)', () => {
  const trades = catalog.loadNpcTrades();
  assert.ok(Array.isArray(trades), 'npcTrades.json normalizes to a flat array');
  assert.equal(trades.length, 1096,
    'W-1 live extraction: 279 item cids -> 1,096 trade rows {cid, npc, price, region}');
  const beatrice = trades.find((t) => t.npc === 'Beatrice' && t.cid === 1736);
  assert.ok(beatrice, 'a row for Beatrice trading cid 1736 exists');
  assert.equal(beatrice.price, 10);
  assert.equal(beatrice.region, 'main');
});

test('REQ-07: normalizeNpcTrades accepts array, object and junk sources', () => {
  assert.equal(catalog.normalizeNpcTrades(null), null);
  assert.equal(catalog.normalizeNpcTrades('nope'), null);
  assert.equal(catalog.normalizeNpcTrades(42), null);
  // Object shape (live client, W-1): {cid: [{name, price, region}]}
  const fromObject = catalog.normalizeNpcTrades({
    '1736': [{ name: 'Beatrice', price: 10, region: 'main' }, null, 'junk'],
    '24': [{ name: 'Gorn', price: 5 }],
  });
  assert.equal(fromObject.length, 2, 'junk entries dropped');
  const beatriceRow = fromObject.find((t) => t.npc === 'Beatrice');
  assert.deepEqual(beatriceRow, { cid: 1736, npc: 'Beatrice', price: 10, region: 'main', buy: null, sell: null });
  const gornRow = fromObject.find((t) => t.npc === 'Gorn');
  assert.equal(gornRow.cid, 24);
  assert.equal(gornRow.region, null, 'missing region stays null');
  // Array shape (historical derived contract) passes through untouched.
  const arrayRow = [{ npc: 'Arito', price: 90, buy: true, sell: false }];
  assert.deepEqual(catalog.normalizeNpcTrades(arrayRow), arrayRow);
});

test('REQ-07: corrupt or missing assets degrade to null (no crash)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(catalog.loadCatalog({ dir }), null, 'missing catalog -> null');
  assert.equal(catalog.loadNpcTrades({ dir }), null, 'missing npcTrades -> null');

  fs.writeFileSync(path.join(dir, 'catalog.json'), '{broken', 'utf8');
  fs.writeFileSync(path.join(dir, 'npcTrades.json'), 'not json', 'utf8');
  assert.equal(catalog.loadCatalog({ dir }), null, 'corrupt catalog -> null');
  assert.equal(catalog.loadNpcTrades({ dir }), null, 'corrupt npcTrades -> null');
  assert.equal(catalog.createCatalog({ dir }), null, 'createCatalog degrades as a whole');
});

test('REQ-07: loadCatalog filters malformed entries; buildIndex tolerates duplicates', () => {
  const entries = [
    { cid: 1, name: 'ok', runeSpellName: 'adori' },
    { cid: 1, name: 'dupe' },
    { name: 'no-cid' },
    null,
    'junk',
  ];
  const loaded = catalog.loadCatalog({ dir: ASSETS_DIR });
  assert.ok(loaded.length >= 12355, 'real asset unaffected');
  const index = catalog.buildIndex(entries.filter((e) => e && typeof e === 'object'));
  assert.equal(index.byCid.get(1).name, 'ok', 'first entry wins on duplicate cid');
  assert.equal(index.byRuneWord.get('adori').length, 1);
});

test('REQ-07 (slice 6): readEmbeddedAsset resolves the compiled-binary embedded copies first', () => {
  const prev = globalThis.__MB_BUNDLED_ASSETS;
  try {
    // Simulate app/entry-compiled.js: parsed JSON exposed on the global.
    globalThis.__MB_BUNDLED_ASSETS = {
      'catalog.json': [{ cid: 777, name: 'embedded-only' }],
      'npcTrades.json': [{ npc: 'embedded' }],
    };
    const embedded = catalog.readEmbeddedAsset('catalog.json');
    assert.deepEqual(embedded, [{ cid: 777, name: 'embedded-only' }]);
    assert.equal(catalog.loadCatalog().length, 1, 'embedded copy wins over fs (offline binary, REQ-07)');
    assert.deepEqual(catalog.loadNpcTrades(), [{ npc: 'embedded' }]);
    assert.equal(catalog.readEmbeddedAsset('missing.json'), null, 'unknown asset -> null');
  } finally {
    if (prev === undefined) delete globalThis.__MB_BUNDLED_ASSETS;
    else globalThis.__MB_BUNDLED_ASSETS = prev;
  }
});

test('REQ-07 (slice 6): readEmbeddedAsset falls back to fs when no bundle is exposed', () => {
  const prev = globalThis.__MB_BUNDLED_ASSETS;
  try {
    delete globalThis.__MB_BUNDLED_ASSETS;
    assert.equal(catalog.readEmbeddedAsset('catalog.json'), null);
    const loaded = catalog.loadCatalog();
    assert.ok(Array.isArray(loaded) && loaded.length >= 12355, 'fs fallback intact (dev/tests)');
  } finally {
    if (prev !== undefined) globalThis.__MB_BUNDLED_ASSETS = prev;
  }
});
