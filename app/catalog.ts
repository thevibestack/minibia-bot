'use strict';

/**
 * Offline catalog lookup (task 3.6, REQ-07): reads the bundled app assets
 * (app/assets/catalog.json + app/assets/npcTrades.json) and indexes them
 * for offline lookups — the desktop binary must resolve catalog entries
 * with no network.
 *
 * Assets:
 *  - catalog.json  — the live-extracted item catalog (12,356 entries),
 *                    copied from tools/extract-catalog.js output. Each
 *                    entry: {cid, name, article, type, weight,
 *                    runeSpellName, imageDataURL, npcTrades[]}.
 *  - npcTrades.json — flat trade rows {npc, price, buy, sell} DERIVED from
 *                    the catalog entries' npcTrades arrays. The current
 *                    local extraction was captured without the npcTrades
 *                    page input, so it holds 0 rows; re-running
 *                    tools/extract-catalog.js WITH the trades input and
 *                    re-deriving repopulates it (see tools/extract-catalog.js
 *                    usage note).
 *
 * Pure Node module (no globals): loadCatalog/loadNpcTrades/assetPath are
 * testable against the real assets or a temp dir.
 */

const fs = require('node:fs');
const path = require('node:path');

const CATALOG_FILENAME = 'catalog.json';
const NPC_TRADES_FILENAME = 'npcTrades.json';

/** Bundled asset dir (app/assets). @returns {string} */
function assetsDir() {
  return path.join(__dirname, 'assets');
}

function assetPath(dir, name) {
  return path.join(dir || assetsDir(), name);
}

/**
 * Load + parse a JSON asset. Returns null on any failure (missing file,
 * corrupt JSON, wrong shape) — REQ-07 offline degrade, mirroring the
 * catalog adapter's corrupt semantics.
 * @param {string} file
 * @returns {unknown|null}
 */
function readJsonAsset(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Embedded-asset bridge (REQ-07, slice 6): the compiled-binary entry
 * (app/entry-compiled.js) imports the JSON assets and exposes them as
 * parsed values on globalThis.__MB_BUNDLED_ASSETS, so offline lookups in
 * the binary resolve from the embedded copy (Bun also embeds the project
 * tree as a virtual FS — the fs path below covers both dev and the binary).
 * @param {string} name - asset file name ('catalog.json' | 'npcTrades.json')
 * @returns {unknown|null}
 */
function readEmbeddedAsset(name) {
  try {
    const bundle = typeof globalThis !== 'undefined' ? globalThis.__MB_BUNDLED_ASSETS : null;
    if (bundle && Object.prototype.hasOwnProperty.call(bundle, name)) return bundle[name];
  } catch (e) { /* fall through to fs */ }
  return null;
}

/**
 * Load the item catalog asset.
 * @param {{dir?: string}} [opts]
 * @returns {Array<{cid: number, name: string, runeSpellName: string|null, npcTrades: object[]}>|null}
 */
function loadCatalog(opts = {}) {
  const embedded = readEmbeddedAsset(CATALOG_FILENAME);
  const entries = embedded !== null ? embedded : readJsonAsset(assetPath(opts.dir, CATALOG_FILENAME));
  if (!Array.isArray(entries)) return null;
  return entries.filter((e) => e && typeof e === 'object' && Number.isInteger(e.cid) && typeof e.name === 'string');
}

/**
 * Load the flat npcTrades asset (design: 279 rows when extracted with the
 * trades input; [] until then — never null for a valid JSON array).
 * @param {{dir?: string}} [opts]
 * @returns {Array<{npc: string, price: number, buy: boolean, sell: boolean}>|null}
 */
function loadNpcTrades(opts = {}) {
  const embedded = readEmbeddedAsset(NPC_TRADES_FILENAME);
  const rows = embedded !== null ? embedded : readJsonAsset(assetPath(opts.dir, NPC_TRADES_FILENAME));
  if (!Array.isArray(rows)) return null;
  return rows;
}

/**
 * Build lookup indexes over the catalog entries (offline, O(1) lookups).
 * @param {Array<object>} entries
 * @returns {{byCid: Map<number, object>, byName: Map<string, object[]>,
 *            byRuneWord: Map<string, object[]>}}
 */
function buildIndex(entries) {
  const byCid = new Map();
  const byName = new Map();
  const byRuneWord = new Map();
  for (const e of entries) {
    if (!byCid.has(e.cid)) byCid.set(e.cid, e);
    const nameKey = String(e.name).toLowerCase();
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(e);
    if (typeof e.runeSpellName === 'string' && e.runeSpellName) {
      const wordKey = e.runeSpellName.toLowerCase();
      if (!byRuneWord.has(wordKey)) byRuneWord.set(wordKey, []);
      byRuneWord.get(wordKey).push(e);
    }
  }
  return { byCid, byName, byRuneWord };
}

/**
 * Convenience handle: load + index in one step.
 * @param {{dir?: string}} [opts]
 * @returns {{entries: Array<object>, index: object, trades: Array<object>|null}|null}
 */
function createCatalog(opts = {}) {
  const entries = loadCatalog(opts);
  if (entries === null) return null;
  return {
    entries,
    index: buildIndex(entries),
    trades: loadNpcTrades(opts),
  };
}

/**
 * Case-insensitive name lookup over the built index (the index keys are
 * lowercased; this normalizes the query).
 * @param {{byName: Map<string, object[]>}} index
 * @param {string} name
 * @returns {object[]|undefined}
 */
function findByName(index, name) {
  return index.byName.get(String(name).toLowerCase());
}

/**
 * Resolve the rune spell word for an item cid (REQ-15 rune module + panel).
 * @param {{index: object}} catalog
 * @param {number} cid
 * @returns {string|null}
 */
function runeWordForCid(catalog, cid) {
  const entry = catalog.index.byCid.get(cid);
  return entry && typeof entry.runeSpellName === 'string' ? entry.runeSpellName : null;
}

module.exports = {
  assetsDir,
  assetPath,
  readJsonAsset,
  readEmbeddedAsset,
  loadCatalog,
  loadNpcTrades,
  buildIndex,
  createCatalog,
  findByName,
  runeWordForCid,
};
