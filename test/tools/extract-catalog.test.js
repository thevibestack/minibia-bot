'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCatalog,
  normalizeTrade,
  normalizeTrades,
  validateCatalog,
  defaultCaptureSprite,
  consoleSnippet,
  usageText,
} = require('../../tools/extract-catalog');

/** Sample definitions in the confirmed game shape (properties.*). */
function sampleDefs() {
  return {
    '3582': { properties: { name: 'seasoned ham', article: 'some', type: 'food', weight: 8, runeSpellName: null } },
    '24': { properties: { name: 'magic light wand', article: 'a', type: 'weapon', weight: 21, runeSpellName: 'adora' } },
    '3005': { properties: { name: 'rune of magic missile', article: 'a', type: 'rune', weight: 3, runeSpellName: 'adori' } },
  };
}

test('REQ-10: buildCatalog maps defs (properties.name/article/type/weight/runeSpellName) to entries', () => {
  const { entries, stats } = buildCatalog({
    itemDefinitionsByCid: sampleDefs(),
    npcTrades: [],
    captureSprite: () => null,
  });
  assert.equal(entries.length, 3);
  assert.equal(stats.total, 3);
  const ham = entries.find((e) => String(e.cid) === '3582');
  assert.deepEqual(ham, {
    cid: 3582,
    name: 'seasoned ham',
    article: 'some',
    type: 'food',
    weight: 8,
    runeSpellName: null,
    imageDataURL: null,
    npcTrades: [],
  });
  assert.equal(entries.find((e) => String(e.cid) === '24').runeSpellName, 'adora');
  assert.equal(typeof entries[0].cid, 'number', 'numeric cid keys coerced to numbers');
});

test('REQ-10: successful sprite capture is recorded on the entry', () => {
  const capture = () => 'data:image/png;base64,AAA';
  const { entries, stats } = buildCatalog({ itemDefinitionsByCid: sampleDefs(), captureSprite: capture });
  assert.equal(stats.captured, 3);
  assert.equal(entries[0].imageDataURL, 'data:image/png;base64,AAA');
});

test('REQ-10: sprite capture throwing keeps the entry with null image and logs the failure', () => {
  const warnings = [];
  const { entries, stats } = buildCatalog({
    itemDefinitionsByCid: sampleDefs(),
    captureSprite: () => { throw new Error('canvas tainted'); },
    log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(entries.length, 3, 'entries kept');
  assert.ok(entries.every((e) => e.imageDataURL === null), 'null-image fallback (REQ-10)');
  assert.equal(stats.failed, 3);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /sprite capture failed for cid \d+; keeping null image \(REQ-10\)/);
});

test('REQ-10: capture returning a non-data-url value is treated as a failure', () => {
  const { entries, stats } = buildCatalog({
    itemDefinitionsByCid: sampleDefs(),
    captureSprite: () => 'not-an-image',
  });
  assert.equal(stats.failed, 3);
  assert.equal(entries[0].imageDataURL, null);
});

test('REQ-10: npcTrades are grouped onto their item entries', () => {
  const trades = [
    { itemCid: 3582, npcName: 'Rashid', price: 85, buy: false, sell: true },
    { cid: '3582', npc: 'Arito', cost: 90, isBuy: true, sell: false },
    { itemId: 24, trader: 'Gorn', price: 100 },
  ];
  const { entries, stats } = buildCatalog({
    itemDefinitionsByCid: sampleDefs(),
    npcTrades: trades,
    captureSprite: () => null,
  });
  assert.equal(stats.trades, 3);
  const ham = entries.find((e) => String(e.cid) === '3582');
  assert.equal(ham.npcTrades.length, 2);
  assert.deepEqual(ham.npcTrades[0], { npc: 'Rashid', price: 85, buy: false, sell: true });
  assert.deepEqual(ham.npcTrades[1], { npc: 'Arito', price: 90, buy: true, sell: false });
  assert.equal(entries.find((e) => String(e.cid) === '24').npcTrades[0].npc, 'Gorn');
});

test('REQ-10: trade rows without a usable cid/npc are skipped', () => {
  const { stats, entries } = buildCatalog({
    itemDefinitionsByCid: sampleDefs(),
    npcTrades: [{ price: 5 }, null, 'garbage'],
    captureSprite: () => null,
  });
  assert.equal(stats.trades, 0);
  assert.ok(entries.every((e) => e.npcTrades.length === 0));
});

test('REQ-10: OBJECT-shaped npcTrades (observed live shape) are normalized onto entries', () => {
  // gameClient.npcTrades is an object keyed by trade index (~279 numeric-ish keys).
  const trades = {
    '0': { itemCid: 3582, npcName: 'Rashid', price: 85, buy: false, sell: true },
    '1': { cid: '3582', npc: 'Arito', cost: 90, isBuy: true, sell: false },
    '2': { itemId: 24, trader: 'Gorn', price: 100 },
    '3': null, // junk values must not crash the grouping
  };
  const { entries, stats } = buildCatalog({
    itemDefinitionsByCid: sampleDefs(),
    npcTrades: trades,
    captureSprite: () => null,
  });
  assert.equal(stats.trades, 3, 'object values feed the same grouping as an array');
  const ham = entries.find((e) => String(e.cid) === '3582');
  assert.equal(ham.npcTrades.length, 2);
  assert.deepEqual(ham.npcTrades[0], { npc: 'Rashid', price: 85, buy: false, sell: true });
  assert.deepEqual(ham.npcTrades[1], { npc: 'Arito', price: 90, buy: true, sell: false });
  assert.equal(entries.find((e) => String(e.cid) === '24').npcTrades[0].npc, 'Gorn');
});

test('REQ-10: normalizeTrades handles array, object and junk sources', () => {
  const row = { itemCid: 1, npcName: 'Arito' };
  assert.deepEqual(normalizeTrades([row, null]), [row, null], 'array passes through as-is (junk filtered later by normalizeTrade)');
  assert.deepEqual(normalizeTrades({ a: row, b: null, c: 'x' }), [row], 'object values extracted, junk dropped');
  assert.deepEqual(normalizeTrades(null), []);
  assert.deepEqual(normalizeTrades('nope'), []);
  assert.deepEqual(normalizeTrades(42), []);
});

test('REQ-10: definitions without a name are skipped; only named entries count', () => {
  const { entries, stats } = buildCatalog({
    itemDefinitionsByCid: {
      '1': { properties: { name: 'rope', type: 'item' } },
      '2': { properties: { type: 'item' } }, // no name -> skipped
      '3': null, // invalid def -> skipped
    },
    captureSprite: () => null,
  });
  assert.equal(stats.total, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cid, 1);
});

test('REQ-10: extraction is idempotent — two runs produce identical JSON', () => {
  const opts = { itemDefinitionsByCid: sampleDefs(), npcTrades: [{ itemCid: 3582, npcName: 'Rashid', price: 85 }], captureSprite: () => 'data:image/png;base64,AAA' };
  const first = buildCatalog(opts);
  const second = buildCatalog(opts);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(second.entries.length, first.entries.length, 'no duplicate entries on re-run');
});

test('REQ-11: validateCatalog accepts a well-formed catalog', () => {
  const { entries } = buildCatalog({ itemDefinitionsByCid: sampleDefs(), npcTrades: [{ itemCid: 3582, npcName: 'Rashid', price: 85 }], captureSprite: () => null });
  const check = validateCatalog(entries);
  assert.equal(check.ok, true);
  assert.deepEqual(check.errors, []);
});

test('REQ-11: validateCatalog reports missing cid/name, bad image and bad trades', () => {
  const check = validateCatalog([
    { cid: 1, name: 'ok', imageDataURL: null, npcTrades: [] },
    { name: 'no-cid', imageDataURL: 'data:image/png;base64,x', npcTrades: [] },
    { cid: 3, imageDataURL: 'http://evil/x.png', npcTrades: [] },
    { cid: 4, name: 'bad-trades', npcTrades: [{ price: 5 }] },
    null,
  ]);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /missing cid/.test(e)));
  assert.ok(check.errors.some((e) => /missing name/.test(e)));
  assert.ok(check.errors.some((e) => /must be null or a data:image/.test(e)));
  assert.ok(check.errors.some((e) => /trade 0 must be \{npc/.test(e)));
  assert.ok(check.errors.some((e) => /not an object/.test(e)));
});

test('REQ-11: validateCatalog rejects non-array payloads', () => {
  assert.equal(validateCatalog(null).ok, false);
  assert.equal(validateCatalog({ cid: 1 }).ok, false);
});

test('console snippet: embeds the pure functions and drives the page flow', () => {
  const snippet = consoleSnippet();
  assert.match(snippet, /function buildCatalog/);
  assert.match(snippet, /function normalizeTrade/);
  assert.match(snippet, /function normalizeTrades/);
  assert.match(snippet, /function defaultCaptureSprite/);
  assert.match(snippet, /function validateCatalog/);
  assert.match(snippet, /itemDefinitionsByCid/);
  assert.match(snippet, /npcTrades: gc\.npcTrades/, 'raw npcTrades passed (buildCatalog normalizes both shapes)');
  assert.match(snippet, /toDataURL/);
  assert.match(snippet, /new Blob/);
  assert.match(snippet, /download = 'catalog\.json'/);
  assert.match(snippet, /setItem\('mb-catalog', JSON\.stringify\(result\.entries\)\)/, 'seed into localStorage (REQ-10)');
  assert.match(snippet, /the download still works \(REQ-10\)/, 'quota failure is non-fatal');
  assert.match(snippet, /null image \(REQ-10\)/);
  assert.doesNotMatch(snippet, /require\(/, 'snippet is self-contained');
  assert.doesNotMatch(snippet, /[`]/, 'no backticks (safe for console pasting)');
});

test('node shim: usage text covers install -> run-once steps and idempotency', () => {
  const usage = usageText();
  assert.match(usage, /Install minibia-rotation-bot\.user\.js/);
  assert.match(usage, /paste the snippet/);
  assert.match(usage, /downloads\s+catalog\.json/);
  assert.match(usage, /seeds the catalog into/);
  assert.match(usage, /reads the seeded localStorage catalog first/);
  assert.match(usage, /idempotent/);
  assert.match(usage, /keybind-only mode/);
});

test('normalizeTrade tolerates common field spellings and rejects junk', () => {
  assert.deepEqual(normalizeTrade({ itemCid: 7, npcName: 'Arito', price: 50, buy: true, sell: false }), {
    cid: 7, npc: 'Arito', price: 50, buy: true, sell: false,
  });
  assert.deepEqual(normalizeTrade({ id: '9', trader: 'Gorn', cost: '60' }), {
    cid: '9', npc: 'Gorn', price: 60, buy: null, sell: null,
  });
  assert.equal(normalizeTrade(null), null);
  assert.equal(normalizeTrade({ price: 5 }), null, 'no cid/npc -> skipped');
});
