'use strict';

/**
 * Catalog extraction tool (REQ-10, design D5).
 *
 * `catalog.json` (>=12,000 items + 279 NPC trades + item sprites) can only be
 * built INSIDE the live game page: `gameClient.itemDefinitionsByCid` and
 * `gameClient.npcTrades` are runtime objects, and sprites come from item
 * slot canvases (`slots[i].canvas.canvas.toDataURL()`, 32x32 PNG). A plain
 * node process cannot reach any of that, so this tool is a PAGE-CONTEXT
 * RUNNER:
 *
 *   1. Run `node tools/extract-catalog.js` (this shim) — it prints the usage
 *      instructions and a SELF-CONTAINED console snippet.
 *   2. On minibia.com/play (logged in), paste the snippet into the browser
 *      console (F12). It walks `itemDefinitionsByCid` + `npcTrades`,
 *      captures a representative sprite per item when cheaply possible
 *      (per-item try/catch: failures are logged and the entry keeps a null
 *      image — REQ-10), validates the result and downloads `catalog.json`
 *      via Blob.
 *
 * The mapping logic (cid -> entry) lives in the pure exported function
 * `buildCatalog` so it is unit-testable; the snippet embeds the very same
 * function source (`Function.prototype.toString`), so tests cover exactly
 * the code that runs in the page. Extraction is idempotent: each run builds
 * a fresh catalog object and overwrites cleanly — no duplicate entries.
 */

/**
 * Normalize one raw NPC trade row into {cid, npc, price, buy, sell}.
 * Tolerates common field spellings since the game's shape is not frozen.
 * @param {*} trade - raw trade row
 * @returns {{cid: number|string, npc: string, price: number|null, buy: *, sell: *}|null}
 */
function normalizeTrade(trade) {
  if (!trade || typeof trade !== 'object') return null;
  const cid = trade.itemCid !== undefined ? trade.itemCid
    : trade.cid !== undefined ? trade.cid
    : trade.itemId !== undefined ? trade.itemId
    : trade.id;
  const npc = trade.npcName !== undefined ? trade.npcName
    : trade.npc !== undefined ? trade.npc
    : trade.trader;
  if (cid === null || cid === undefined || typeof npc !== 'string') return null;
  const price = trade.price !== undefined ? trade.price
    : trade.cost !== undefined ? trade.cost
    : null;
  const buy = trade.buy !== undefined ? trade.buy
    : trade.isBuy !== undefined ? trade.isBuy
    : trade.buyPrice !== undefined ? true
    : null;
  const sell = trade.sell !== undefined ? trade.sell
    : trade.isSell !== undefined ? trade.isSell
    : trade.sellPrice !== undefined ? true
    : null;
  return {
    cid,
    npc,
    price: price === null || price === undefined ? null : Number(price),
    buy,
    sell,
  };
}

/**
 * Page-side sprite strategy: captures a representative 32x32 PNG for an item
 * ONLY when its canvas is cheaply reachable — pre-captured hotbar slot
 * canvases keyed by item reference, then container/backpack-style windows
 * that expose slot canvases. Anything else returns null (REQ-10 keeps the
 * entry with a null image and logs the failure). Every step is guarded so a
 * missing API can never abort the extraction.
 *
 * @param {number|string} cid - item id
 * @returns {string|null} data URL ("data:image/png;base64,...") or null
 */
function defaultCaptureSprite(cid) {
  try {
    if (typeof window === 'undefined' || !window.gameClient) return null;
    const gc = window.gameClient;
    let cache = defaultCaptureSprite.__cache;
    if (!cache) {
      cache = defaultCaptureSprite.__cache = {};
      // Hotbar slots: proven 32x32 canvases (F14); key by any item ref present.
      try {
        const hotbar = (gc.interface && gc.interface.hotbarManager) || gc.hotbarManager || null;
        const slots = hotbar && hotbar.slots;
        if (slots && Array.isArray(slots)) {
          for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (!slot) continue;
            const item = slot.item || null;
            const ref = item ? (item.cid !== undefined ? item.cid : item.id) : slot.cid !== undefined ? slot.cid : slot.itemId;
            if (ref === null || ref === undefined) continue;
            const canvas = slot.canvas && slot.canvas.canvas;
            if (canvas && typeof canvas.toDataURL === 'function') {
              cache[ref] = canvas.toDataURL('image/png');
            }
          }
        }
      } catch (e) { /* hotbar capture is best-effort */ }
      // Container/backpack-style windows exposing slot canvases.
      try {
        const windows = [gc.containerPrototype, gc.backpack, gc.itemWindow, gc.interface && gc.interface.containerPrototype];
        for (let w = 0; w < windows.length; w++) {
          const win = windows[w];
          const slots = win && win.slots;
          if (!slots || !Array.isArray(slots)) continue;
          for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (!slot) continue;
            const item = slot.item || null;
            const ref = item ? (item.cid !== undefined ? item.cid : item.id) : slot.cid !== undefined ? slot.cid : slot.itemId;
            if (ref === null || ref === undefined) continue;
            if (cache[ref]) continue;
            const canvas = slot.canvas && slot.canvas.canvas;
            if (canvas && typeof canvas.toDataURL === 'function') {
              cache[ref] = canvas.toDataURL('image/png');
            }
          }
        }
      } catch (e) { /* window capture is best-effort */ }
    }
    return cache[cid] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Pure mapping: item definitions + NPC trades + sprites -> catalog entries
 * (REQ-10). Each entry: {cid, name, article, type, weight, runeSpellName,
 * imageDataURL, npcTrades:[{npc, price, buy, sell}]}.
 *
 * Sprite capture is wrapped per item: a thrown/failed capture keeps the entry
 * with a null image and is logged (REQ-10 "null-image + log on sprite
 * failure"). Idempotent: the output object is built fresh from the inputs.
 *
 * @param {object} [opts]
 * @param {object|Array} [opts.itemDefinitionsByCid={}] - 12,536 defs; a def is
 *   {properties: {name, article, type, weight, runeSpellName}} or a plain map
 * @param {Array<object>} [opts.npcTrades=[]] - 279 raw trade rows
 * @param {(cid: string) => string|null} [opts.captureSprite] - sprite strategy;
 *   must not throw
 * @param {{warn?: Function, log?: Function}} [opts.log] - log sinks
 * @returns {{entries: Array<object>, stats: {total: number, captured: number,
 *   failed: number, trades: number}}}
 */
function buildCatalog(opts = {}) {
  const defs = opts.itemDefinitionsByCid || {};
  const trades = Array.isArray(opts.npcTrades) ? opts.npcTrades : [];
  const capture = typeof opts.captureSprite === 'function' ? opts.captureSprite : null;
  const log = opts.log || {};
  const warn = typeof log.warn === 'function' ? log.warn.bind(log)
    : typeof log.log === 'function' ? log.log.bind(log)
    : function () {};

  const entries = [];
  const stats = { total: 0, captured: 0, failed: 0, trades: 0 };

  /** Normalize the item id key (numeric strings become numbers). */
  function normCid(key) {
    return /^\d+$/.test(String(key)) ? Number(key) : key;
  }

  /** Find an entry by cid (string/number tolerant). */
  function findEntry(cidValue) {
    for (let i = 0; i < entries.length; i++) {
      if (String(entries[i].cid) === String(cidValue)) return entries[i];
    }
    return null;
  }

  const keys = Array.isArray(defs) ? defs.map(function (_, i) { return i; }) : Object.keys(defs);
  for (let i = 0; i < keys.length; i++) {
    const cid = normCid(keys[i]);
    const def = defs[keys[i]];
    if (!def || typeof def !== 'object') continue;
    const props = (def.properties && typeof def.properties === 'object') ? def.properties : def;
    const name = typeof props.name === 'string' ? props.name : null;
    if (!name) continue; // an entry requires a name

    let imageDataURL = null;
    if (capture) {
      try {
        imageDataURL = capture(cid);
        if (typeof imageDataURL !== 'string' || imageDataURL.indexOf('data:image/') !== 0) {
          imageDataURL = null;
        }
      } catch (e) {
        imageDataURL = null;
      }
      if (imageDataURL) {
        stats.captured += 1;
      } else {
        stats.failed += 1;
        warn('sprite capture failed for cid ' + cid + '; keeping null image (REQ-10)');
      }
    }

    entries.push({
      cid,
      name,
      article: typeof props.article === 'string' ? props.article : null,
      type: typeof props.type === 'string' ? props.type : null,
      weight: props.weight !== undefined && props.weight !== null ? Number(props.weight) : null,
      runeSpellName: typeof props.runeSpellName === 'string' ? props.runeSpellName : null,
      imageDataURL,
      npcTrades: [],
    });
  }
  stats.total = entries.length;

  // Group the 279 NPC trades onto their item entries.
  for (let t = 0; t < trades.length; t++) {
    const tr = normalizeTrade(trades[t]);
    if (!tr) continue;
    const entry = findEntry(tr.cid);
    if (!entry) continue;
    entry.npcTrades.push({ npc: tr.npc, price: tr.price, buy: tr.buy, sell: tr.sell });
    stats.trades += 1;
  }

  return { entries, stats };
}

/**
 * Validate a catalog payload against the schema the bot expects (REQ-11).
 * @param {Array<object>} entries - catalog entries
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateCatalog(entries) {
  const errors = [];
  if (!Array.isArray(entries)) {
    return { ok: false, errors: ['catalog must be an array of entries'] };
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== 'object') {
      errors.push('entry ' + i + ': not an object');
      continue;
    }
    if (e.cid === null || e.cid === undefined) errors.push('entry ' + i + ': missing cid');
    if (typeof e.name !== 'string' || e.name.length === 0) errors.push('entry ' + i + ': missing name');
    if (e.imageDataURL !== null && e.imageDataURL !== undefined
      && (typeof e.imageDataURL !== 'string' || e.imageDataURL.indexOf('data:image/') !== 0)) {
      errors.push('entry ' + i + ': imageDataURL must be null or a data:image URL');
    }
    if (e.npcTrades !== undefined && e.npcTrades !== null && !Array.isArray(e.npcTrades)) {
      errors.push('entry ' + i + ': npcTrades must be an array');
    } else if (Array.isArray(e.npcTrades)) {
      for (let j = 0; j < e.npcTrades.length; j++) {
        const tr = e.npcTrades[j];
        if (!tr || typeof tr !== 'object' || typeof tr.npc !== 'string') {
          errors.push('entry ' + i + ': trade ' + j + ' must be {npc, price, buy, sell}');
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The self-contained console snippet. Embeds the pure functions via
 * `Function.prototype.toString`, so the page runs exactly the tested code.
 * @returns {string}
 */
function consoleSnippet() {
  return "(() => {\n"
    + "'use strict';\n"
    + "// Minibia catalog extraction (REQ-10) — self-contained page-context runner.\n"
    + "const normalizeTrade = " + normalizeTrade.toString() + ";\n"
    + "const defaultCaptureSprite = " + defaultCaptureSprite.toString() + ";\n"
    + "const buildCatalog = " + buildCatalog.toString() + ";\n"
    + "const validateCatalog = " + validateCatalog.toString() + ";\n"
    + "const gc = window.gameClient;\n"
    + "if (!gc || typeof gc.itemDefinitionsByCid !== 'object' || gc.itemDefinitionsByCid === null) {\n"
    + "  console.error('extract-catalog: window.gameClient.itemDefinitionsByCid not found — run this on the minibia.com/play page with a logged-in session (REQ-10).');\n"
    + "  return;\n"
    + "}\n"
    + "const result = buildCatalog({\n"
    + "  itemDefinitionsByCid: gc.itemDefinitionsByCid,\n"
    + "  npcTrades: Array.isArray(gc.npcTrades) ? gc.npcTrades : [],\n"
    + "  captureSprite: defaultCaptureSprite,\n"
    + "  log: console,\n"
    + "});\n"
    + "const check = validateCatalog(result.entries);\n"
    + "if (!check.ok) {\n"
    + "  console.warn('extract-catalog: validation found ' + check.errors.length + ' problems (bot would run keybind-only, REQ-11):');\n"
    + "  console.warn(check.errors.slice(0, 10).join('\\n'));\n"
    + "}\n"
    + "const json = JSON.stringify(result.entries, null, 2);\n"
    + "const blob = new Blob([json], { type: 'application/json' });\n"
    + "const url = URL.createObjectURL(blob);\n"
    + "const a = document.createElement('a');\n"
    + "a.href = url;\n"
    + "a.download = 'catalog.json';\n"
    + "document.body.appendChild(a);\n"
    + "a.click();\n"
    + "a.remove();\n"
    + "setTimeout(function () { URL.revokeObjectURL(url); }, 10000);\n"
    + "console.log('extract-catalog: catalog.json downloaded — '\n"
    + "  + result.stats.total + ' entries, ' + result.stats.captured + ' with images, '\n"
    + "  + result.stats.failed + ' sprite failures, ' + result.stats.trades + ' trades (REQ-10)');\n"
    + "})();\n";
}

/**
 * Human-readable usage text for the node shim (install -> run once).
 * @returns {string}
 */
function usageText() {
  return [
    'Minibia Rotation Bot — catalog extraction (REQ-10)',
    '',
    'The catalog can only be built inside the live game page, so this tool prints',
    'a self-contained console snippet for you to run once:',
    '',
    '  1. Install minibia-rotation-bot.user.js in Tampermonkey.',
    '  2. Open https://minibia.com/play and log in.',
    '  3. Open the browser console (F12) and paste the snippet printed below.',
    '  4. It walks itemDefinitionsByCid + npcTrades, captures sprites when cheaply',
    '     possible (failures are logged, entry keeps a null image) and downloads',
    '     catalog.json via Blob.',
    '  5. Save catalog.json where the bot can fetch it same-origin (the bot reads',
    '     "catalog.json" relative to the page; until it is reachable the bot runs',
    '     in keybind-only mode with a warning — REQ-11).',
    '',
    'Re-running the snippet is safe: each run overwrites cleanly (idempotent).',
    '',
    'To print ONLY the snippet (easier to copy):  node tools/extract-catalog.js --snippet',
    '',
  ].join('\n');
}

/** CLI entry: print usage + snippet, or just the snippet with --snippet. */
function run() {
  const onlySnippet = process.argv.includes('--snippet');
  process.stdout.write(onlySnippet ? consoleSnippet() : usageText() + '\n--- console snippet (paste into the game page console) ---\n\n' + consoleSnippet());
}

if (require.main === module) {
  run();
}

module.exports = {
  buildCatalog,
  normalizeTrade,
  validateCatalog,
  defaultCaptureSprite,
  consoleSnippet,
  usageText,
  run,
};
