'use strict';

/**
 * Control panel HTTP server (tasks 3.3/3.4, REQ-05/08/09, design D8).
 *
 * Serves the static panel shell (index.html, state.js, app.js, style.css)
 * and the panel API on 127.0.0.1 ONLY (REQ-05). The game window is never
 * touched by this server — the panel is a separate localhost window
 * (REQ-08).
 *
 * API:
 *   GET  /api/identity   -> {identity}   (name+vocation or null; REQ-02)
 *   POST /api/connect    -> arms: store-loads the character config,
 *                           pushes applyConfig({...config, armed:true}) to
 *                           the in-page agent, persists; returns it for the
 *                           panel pre-fill (REQ-09). 409 when the identity
 *                           is not readable or the name does not match.
 *   POST /api/disconnect -> pushes applyConfig({armed:false}) and marks the
 *                           character disconnected (gate reset).
 *   POST /api/config     -> persists + pushes the given config (armed);
 *                           spell sids re-checked against the live catalog
 *                           + mana (REQ-28, slice 1b) -> 409 on rejection.
 *   GET  /api/snapshot   -> live snapshot payload (readStats + identity).
 *   GET  /api/spell-catalog -> client spell catalog filtered to what the
 *                           CURRENT character can cast (REQ-28, D5).
 *   GET  /api/profiles   -> names of every character with a saved config
 *                           (REQ-27 cross-load offer).
 *   POST /api/load-profile -> cross-load another character's config with
 *                           per-sid vocation/level rejection (REQ-27, D6).
 *   POST /api/runecheck-resume -> RPCs the in-page resumeRuneCheck (REQ-41:
 *                           manual unpause of the rune-check queue gate).
 *
 * Static file serving is an exact-name whitelist (never a user path join),
 * so no traversal is possible. Body parsing is length-capped.
 *
 * Pure Node (node:http) — runs on Bun too (slice 6 packaging). Injectable
 * deps: identityFn/applyConfigFn/snapshotFn/store make it fully testable
 * against a real ephemeral port.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Slice 1b (REQ-28, design D5): pure spell-catalog helpers (enumeration is
// in-page; filtering + per-sid rejection are shared here).
const GC = require('../../src/adapters/gameClient');

const STATIC_FILES = ['index.html', 'state.js', 'app.js', 'style.css'];
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB config payload cap

// Slice B (REQ-46, D-B3): F-key -> keyCode map for the hotkey RPC
// (F1=112 .. F12=123 — the same KEYCODES the firing keyboard mode reads).
const KEYCODES: Record<string, number> = {};
for (let i = 1; i <= 12; i += 1) KEYCODES['F' + i] = 111 + i;
const HOTKEY_KEYS = Object.keys(KEYCODES);

function contentTypeFor(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/javascript; charset=utf-8';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('invalid JSON body: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Validate + sanitize the spell-bearing config keys against the client
 * catalog (design D5/D6, REQ-27/28): every integer sid in healMagic.sid /
 * training.sid must resolve to a spell the CURRENT character can cast
 * (vocation + level). Current mana is a runtime concern: a valid
 * configuration must arm even while the character is at 0 mana. Returns
 * {rejected: [{key, reason}], config} — each rejected sid is blanked (null)
 * in the returned config so "the rest applies" (REQ-27 cross-load).
 * @param {object} config
 * @param {Array<object>} catalog - raw client catalog rows ({sid, vocations, level, mana})
 * @param {{vocationLabel: string, playerLevel: number|null}} ctx
 * @returns {{rejected: Array<{key: string, reason: string}>, config: object}}
 */
function validateAndSanitize(config, catalog, ctx) {
  const bySid = Object.create(null);
  for (const spell of (Array.isArray(catalog) ? catalog : [])) {
    if (spell && typeof spell === 'object' && Number.isInteger(Number(spell.sid))) {
      bySid[Number(spell.sid)] = spell;
    }
  }
  const rejected = [];
  const sidError = (key, sid) => {
    const n = Number(sid);
    if (!Number.isInteger(n)) return { key, reason: 'invalid spell id' };
    const spell = bySid[n];
    if (!spell) return { key, reason: 'unknown spell (sid ' + n + ')' };
    const err = GC.spellValidationError(spell, ctx);
    return err ? { key, reason: err.reason } : null;
  };
  const out = JSON.parse(JSON.stringify(config));
  for (const mkey of ['healMagic', 'training']) {
    const m = out.modules && out.modules[mkey];
    if (m && m.sid !== null && m.sid !== undefined) {
      const err = sidError(mkey + '.sid', m.sid);
      if (err) { rejected.push(err); m.sid = null; }
    }
  }
  // REQ-08 (PR 2): food magic sid — read BOTH the unified eat.magic.sid and
  // the legacy training.eatWithMagic.sid during the migration window (one
  // release of tolerance: old saved files keep validating while the new
  // shape arms). Each rejected sid is blanked in place, the rest applies.
  const foodSources = [
    { host: () => out.modules && out.modules.eat && out.modules.eat.magic, key: 'eat.magic.sid' },
    { host: () => out.modules && out.modules.training && out.modules.training.eatWithMagic, key: 'training.eatWithMagic.sid' },
  ];
  for (const src of foodSources) {
    const food = src.host();
    if (food && food.sid !== null && food.sid !== undefined) {
      const err = sidError(src.key, food.sid);
      if (err) { rejected.push(err); food.sid = null; }
    }
  }
  return { rejected, config: out };
}

/** Panel and API must agree that food magic is an actual food-creation spell.
 * MiniTibia supplies metadata, not a type enum, so this is deliberately a
 * positive allow-list of its exposed wording rather than "any exevo". */
function isFoodCreationSpell(spell) {
  const text = [spell && spell.name, spell && spell.words, spell && spell.description]
    .filter(Boolean).join(' ').toLowerCase();
  return /\bexevo\s+pan\b/.test(text)
    || /\bfood\b/.test(text)
    || /\b(create|creates|conjure|conjures)\b.*\b(food|bread|pan)\b/.test(text);
}

/** Validate SID -> F-slot integrity at the trust boundary. A stale slot could
 * fire a different live spell after the player rearranges MiniTibia, so the
 * save is rejected until the panel refresh/reconciliation has run. */
function validateTrainerHotbarIntegrity(config, catalog, hotbar) {
  const modules = config && config.modules || {};
  const training = modules.training || {};
  const runes = modules.runes || {};
  const spells = Object.create(null);
  for (const spell of (Array.isArray(catalog) ? catalog : [])) spells[Number(spell && spell.sid)] = spell;
  const wanted = [];
  const hasSid = (value) => value !== null && value !== undefined && value !== '' && Number.isInteger(Number(value));
  if (hasSid(training.sid)) wanted.push({ key: 'training', sid: Number(training.sid), slot: training.slot });
  if (hasSid(runes.fallbackSid)) wanted.push({ key: 'fallback', sid: Number(runes.fallbackSid), slot: runes.fallbackSlot });
  // REQ-08 (PR 2): dual-read during the migration window — the unified
  // modules.eat.magic shape is authoritative when enabled; the legacy
  // training.eatWithMagic shape is still honored for configs saved by older
  // builds (one release of tolerance). The rejected key names the source.
  const newFood = modules.eat && modules.eat.magic && typeof modules.eat.magic === 'object' ? modules.eat.magic : {};
  const legacyFood = training.eatWithMagic && typeof training.eatWithMagic === 'object' ? training.eatWithMagic : {};
  const food = newFood.enabled === true
    ? Object.assign({ key: 'eat.magic' }, newFood)
    : legacyFood.enabled === true
      ? Object.assign({ key: 'training.eatWithMagic' }, legacyFood)
      : null;
  if (food) {
    if (!hasSid(food.sid) || !isFoodCreationSpell(spells[Number(food.sid)])) {
      return { key: food.key + '.sid', reason: 'food spell must be a live food-creation spell (for example, exevo pan)' };
    }
    wanted.push({ key: 'food', sid: Number(food.sid), slot: food.slot });
  }
  if (wanted.length === 0) return null;
  if (!hotbar || !Array.isArray(hotbar.slots) || hotbar.available === false) {
    return { key: 'hotbar', reason: 'live hotbar unavailable — refresh game data before saving Trainer' };
  }
  for (const mapping of wanted) {
    const live = hotbar.slots.find((entry) => Number(entry && entry.sid) === mapping.sid);
    const liveSlot = Number(live && live.slot);
    if (!Number.isInteger(liveSlot) || liveSlot < 1 || liveSlot > 12) {
      return { key: mapping.key + '.slot', reason: 'selected ' + mapping.key + ' spell is not in live F1–F12 — refresh game data and save again' };
    }
    if (Number(mapping.slot) !== liveSlot) {
      return { key: mapping.key + '.slot', reason: 'stale hotbar mapping — selected ' + mapping.key + ' spell is now F' + liveSlot + '; refresh game data and save again' };
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.staticDir - panel assets dir (index.html etc.)
 * @param {() => Promise<{name: string, vocationId: number|null, vocationLabel: string}|null>} opts.identity
 * @param {(config: object) => Promise<unknown>} opts.applyConfig - push to the in-page agent
 * @param {(action: 'confirm'|'decline', word: string) => Promise<unknown>} [opts.respondOffer] -
 *   REQ-25 agent RPC for offer decisions (decline = session-silent)
 * @param {(pattern: string) => Promise<unknown>} [opts.confirmAntibot] -
 *   REQ-34 in-page confirmAntibot RPC (session-confirmed -> auto-replies)
 * @param {() => Promise<unknown>} [opts.resumeRuneCheck] -
 *   REQ-41 in-page resumeRuneCheck RPC (unpauses the rune-check queue gate)
 * @param {() => Promise<{available: boolean, keybinds?: object}|null>} [opts.getHotbarKeybinds] -
 *   REQ-46 in-page hotbar-keybind read (feature-detected; {available:false} degrade)
 * @param {({slot: number, keyCode: number}) => Promise<{ok: boolean, reason?: string}|null>} [opts.setHotbarKeybind] -
 *   REQ-46 in-page hotbar-keybind write (keyboard.__hotbarKeybinds)
 * @param {() => Promise<unknown>} [opts.snapshot] - live state payload
 * @param {(x: number, y: number) => Promise<unknown>} [opts.walkTo] -
 *   REQ-23 in-page walkTo RPC (native autowalk, queue-dispatched)
 * @param {(command: 'record-start'|'record-stop'|'start') => Promise<unknown>} [opts.cavebotRpc] -
 *   REQ-36 in-page cavebot skeleton RPC dispatcher (record sampler + start)
 * @param {() => Promise<{spells: Array<object>, playerLevel: number|null,
 *   vocationLabel: string|null}|null>} [opts.spellCatalog] -
 *   REQ-28 in-page getSpellCatalog RPC (raw list + player context)
 * @param {() => Promise<{containers: Array<object>}|null>} [opts.inventory] -
 * @param {() => Promise<{available: boolean, slots: Array<object>}|null>} [opts.hotbar] -
 *   read-only live container catalog for item selectors
 * @param {() => Promise<{creatures: Array<object>}|null>} [opts.creatures] -
 *   current in-game creature catalog for Cavebot selectors
 * @param {object} opts.store - {loadCharacter, saveCharacter} (app/store/characters.ts);
 *   {listCharacters} optional — names for /api/profiles (REQ-27)
 * @param {string} [opts.host='127.0.0.1'] - REQ-05: local only
 * @param {number} [opts.port=0] - ephemeral by default
 * @returns {{url: string, port: number, close(): Promise<void>}}
 */
function createPanelServer(opts) {
  const staticDir = opts.staticDir;
  const identityFn = opts.identity;
  const applyConfigFn = opts.applyConfig;
  const respondOfferFn = typeof opts.respondOffer === 'function' ? opts.respondOffer : async () => null;
  const confirmAntibotFn = typeof opts.confirmAntibot === 'function' ? opts.confirmAntibot : async () => null;
  const resumeRuneCheckFn = typeof opts.resumeRuneCheck === 'function' ? opts.resumeRuneCheck : async () => ({ ok: true });
  const getHotbarKeybindsFn = typeof opts.getHotbarKeybinds === 'function' ? opts.getHotbarKeybinds : async () => ({ available: false });
  const setHotbarKeybindFn = typeof opts.setHotbarKeybind === 'function'
    ? opts.setHotbarKeybind : async () => ({ ok: false, reason: 'keyboard surface unavailable' });
  const snapshotFn = typeof opts.snapshot === 'function' ? opts.snapshot : async () => null;
  const walkToFn = typeof opts.walkTo === 'function' ? opts.walkTo : async () => ({ ok: true });
  const cavebotRpcFn = typeof opts.cavebotRpc === 'function'
    ? opts.cavebotRpc : async () => ({ ok: false, reason: 'unavailable' });
  const spellCatalogFn = typeof opts.spellCatalog === 'function' ? opts.spellCatalog : async () => null;
  const inventoryFn = typeof opts.inventory === 'function' ? opts.inventory : async () => null;
  const hotbarFn = typeof opts.hotbar === 'function' ? opts.hotbar : async () => null;
  const creaturesFn = typeof opts.creatures === 'function' ? opts.creatures : async () => null;
  const attachFirstFn = typeof opts.attachFirst === 'function' ? opts.attachFirst : null;
  const store = opts.store;
  const host = opts.host || '127.0.0.1';

  let lastCharacter = null; // last armed character (disconnect needs it)

  /** REQ-46 (D-B3): restore the saved F-key assignments to the game after a
   *  connect — the RPC feature-detects, so an absent keyboard surface is a
   *  silent no-op (the panel already degrades to display-only). */
  async function restoreHotkeyAssignments(config) {
    const training = config && config.modules && config.modules.training || {};
    const runes = config && config.modules && config.modules.runes || {};
    const hotkeys = training.hotkeys && typeof training.hotkeys === 'object' ? training.hotkeys : {};
    const slot = Number(training.slot);
    if (hotkeys.runeKey && HOTKEY_KEYS.indexOf(hotkeys.runeKey) !== -1
      && Number.isInteger(slot) && slot >= 1 && slot <= 12) {
      await setHotbarKeybindFn({ slot, keyCode: KEYCODES[hotkeys.runeKey] });
    }
    const fallbackSlot = Number(runes.fallbackSlot);
    if (hotkeys.fallbackKey && HOTKEY_KEYS.indexOf(hotkeys.fallbackKey) !== -1
      && Number.isInteger(fallbackSlot) && fallbackSlot >= 1 && fallbackSlot <= 12) {
      await setHotbarKeybindFn({ slot: fallbackSlot, keyCode: KEYCODES[hotkeys.fallbackKey] });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'POST' && url === '/api/attach-first') {
        // Desktop panel can boot without an attached session. This explicit
        // button scans the local debug ports and links the FIRST minibia.com
        // PWA/window exposed through CDP. A normal browser/PWA without
        // --remote-debugging-port is not attachable, so the response stays
        // actionable instead of pretending injection happened.
        if (!attachFirstFn) {
          sendJson(res, 503, { ok: false, reason: 'attach unavailable' });
          return;
        }
        const result = await attachFirstFn();
        if (!result || result.ok !== true) {
          sendJson(res, 404, {
            ok: false,
            reason: result && (result.reason || result.message) || 'no debug-capable minibia.com PWA found',
            errors: result && result.errors || [],
          });
          return;
        }
        const identity = await identityFn();
        sendJson(res, 200, { ok: true, identity });
        return;
      }
      if (req.method === 'GET' && url === '/api/identity') {
        const identity = await identityFn();
        sendJson(res, 200, { identity });
        return;
      }
      if (req.method === 'GET' && url === '/api/snapshot') {
        const payload = await snapshotFn();
        sendJson(res, 200, payload === null || payload === undefined ? { } : payload);
        return;
      }
      if (req.method === 'GET' && url === '/api/inventory') {
        const raw = await inventoryFn();
        if (!raw || !Array.isArray(raw.containers)) {
          sendJson(res, 200, { ok: false, reason: 'inventory unavailable', containers: [] });
          return;
        }
        sendJson(res, 200, { ok: true, containers: raw.containers });
        return;
      }
      if (req.method === 'GET' && url === '/api/hotbar') {
        const raw = await hotbarFn();
        if (!raw || !Array.isArray(raw.slots)) {
          sendJson(res, 200, { ok: false, available: false, reason: 'hotbar unavailable', slots: [] });
          return;
        }
        sendJson(res, 200, { ok: raw.available !== false, available: raw.available !== false, slots: raw.slots });
        return;
      }
      if (req.method === 'GET' && url === '/api/creatures') {
        const raw = await creaturesFn();
        if (!raw || !Array.isArray(raw.creatures)) {
          sendJson(res, 200, { ok: false, reason: 'creature catalog unavailable', creatures: [] });
          return;
        }
        sendJson(res, 200, { ok: true, creatures: raw.creatures });
        return;
      }
      if (req.method === 'GET' && url === '/api/spell-catalog') {
        // REQ-28 (slice 1b, design D5): proxy the in-page getSpellCatalog RPC
        // and filter the RAW list to what the CURRENT character can cast
        // (vocation label + player level) — the picker never sees another
        // vocation's spells. Catalog unavailable -> honest degrade.
        const raw = await spellCatalogFn();
        if (!raw || !Array.isArray(raw.spells)) {
          sendJson(res, 200, { ok: false, reason: 'spell catalog unavailable', catalog: [], total: 0 });
          return;
        }
        const identity = await identityFn();
        const label = (identity && identity.vocationLabel) || raw.vocationLabel || '';
        const catalog = GC.filterCatalogByVocation(raw.spells, {
          vocationLabel: label,
          playerLevel: raw.playerLevel,
        });
        sendJson(res, 200, {
          ok: true,
          catalog,
          total: catalog.length,
          playerLevel: raw.playerLevel,
          vocationLabel: label,
        });
        return;
      }
      if (req.method === 'GET' && url === '/api/profiles') {
        // REQ-27 (slice 1b): names of every character with a saved config —
        // the panel offers the cross-load ("load Gobernador's config").
        // Minimal store handles ({loadCharacter, saveCharacter}) without
        // listCharacters simply yield an empty list (no crash).
        const identity = await identityFn();
        let names = [];
        if (typeof store.listCharacters === 'function') {
          try { names = store.listCharacters(); } catch (e) { names = []; }
        }
        sendJson(res, 200, { ok: true, profiles: names, current: (identity && identity.name) || null });
        return;
      }
      if (req.method === 'GET' && url === '/api/character-config') {
        // REQ-09 per-character pre-fill (slice 6 polish): read-only load of
        // the saved config for the CONFIRMED character — the panel shows the
        // saved toggles before Connect. No push, no persist, no side effect;
        // gated on the identity match like /api/connect.
        let name = '';
        try {
          name = new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '';
        } catch (e) { name = ''; }
        const identity = await identityFn();
        if (!identity || !identity.name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        if (name !== identity.name) {
          sendJson(res, 409, { ok: false, reason: 'character mismatch' });
          return;
        }
        const loaded = store.loadCharacter({ name });
        sendJson(res, 200, { ok: true, config: loaded.config, warning: loaded.warning });
        return;
      }
      if (req.method === 'POST' && url === '/api/walk-to') {
        // REQ-23 (slice 6): walk-to via the NATIVE autowalk primitive — the
        // server RPCs the in-page agent (queue-dispatched pathTo). 409 while
        // no character is connected; 400 on non-numeric coordinates.
        const body = await readBody(req);
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (!name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        const x = body.x;
        const y = body.y;
        if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
          sendJson(res, 400, { ok: false, reason: 'invalid coordinates' });
          return;
        }
        const result = await walkToFn(x, y);
        sendJson(res, 200, { ok: true, x, y, result });
        return;
      }
      if (req.method === 'POST' && url === '/api/cavebot') {
        // REQ-36 (PR6): cavebot skeleton controls (record-start / record-stop
        // / start) — the server RPCs the in-page cavebot surface. 409 while
        // no character is connected; 400 on an unknown command. The
        // record-stop result carries the waypoints the panel saves into
        // config.routes.
        const body = await readBody(req);
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (!name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        const command = typeof body.command === 'string' ? body.command : '';
        if (['record-start', 'record-stop', 'start'].indexOf(command) === -1) {
          sendJson(res, 400, { ok: false, reason: 'unknown command' });
          return;
        }
        const result = await cavebotRpcFn(command);
        sendJson(res, 200, { ok: true, command, result });
        return;
      }
      if (req.method === 'POST' && url === '/api/connect') {
        const body = await readBody(req);
        const identity = await identityFn();
        if (!identity || !identity.name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        const name = typeof body.character === 'string' && body.character ? body.character : identity.name;
        if (name !== identity.name) {
          sendJson(res, 409, { ok: false, reason: 'character mismatch' });
          return;
        }
        const { config } = store.loadCharacter({ name });
        config.character = name;
        config.connected = true;
        // REQ-18: the trade toggle is SESSION-scoped — a NEW session starts
        // with the toggle OFF (mirror the game: "Toggle resets to OFF on
        // logout"; the user re-enables it each session via the panel toggle,
        // which flows through /api/config with a live on-state that is never
        // persisted). The connect push AND the pre-fill carry on:false.
        if (config.modules && config.modules.trade) config.modules.trade.on = false;
        await applyConfigFn(Object.assign({}, config, { armed: true }));
        await restoreHotkeyAssignments(config); // REQ-46 (D-B3): restore saved F-keys
        store.saveCharacter({ name, config });
        lastCharacter = name;
        sendJson(res, 200, { ok: true, identity, config });
        return;
      }
      if (req.method === 'POST' && url === '/api/config') {
        const body = await readBody(req);
        const config = body.config;
        if (!config || typeof config !== 'object') {
          sendJson(res, 400, { ok: false, reason: 'config required' });
          return;
        }
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (!name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        // REQ-28 (slice 1b): spell-save re-check — every spell sid in the
        // config must still be castable by the current character (vocation +
        // level, D5). A rejection refuses the WHOLE save with
        // the first reason (no persist, no push) — the picker validated
        // client-side at pick time; this guards drops since then. Catalog
        // unavailable -> save proceeds (client-side validation already ran).
        const raw = await spellCatalogFn();
        if (raw && Array.isArray(raw.spells)) {
          const identity = await identityFn();
          const { rejected } = validateAndSanitize(config, raw.spells, {
            vocationLabel: (identity && identity.vocationLabel) || raw.vocationLabel || '',
            playerLevel: raw.playerLevel,
          });
          if (rejected.length > 0) {
            sendJson(res, 409, { ok: false, reason: rejected[0].reason, rejected });
            return;
          }
          const trainerHotbarError = validateTrainerHotbarIntegrity(config, raw.spells, await hotbarFn());
          if (trainerHotbarError) {
            sendJson(res, 409, { ok: false, reason: trainerHotbarError.reason, rejected: [trainerHotbarError] });
            return;
          }
        }
        config.character = name;
        config.connected = true;
        // Deep-clone the push payload: the REQ-18 session-scoped strip below
        // must never leak into the LIVE push (applies whatever the
        // applyConfigFn implementation does with the object).
        const pushCfg = JSON.parse(JSON.stringify(Object.assign({}, config, { armed: true })));
        await applyConfigFn(pushCfg);
        // REQ-18: session-scoped trade toggle — see /api/connect note.
        if (config.modules && config.modules.trade) config.modules.trade.on = false;
        store.saveCharacter({ name, config });
        lastCharacter = name;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url === '/api/load-profile') {
        // REQ-27 (slice 1b, design D6): cross-load another character's
        // config. Every spell sid is validated against the CURRENT
        // character's vocation (+ level) via the live catalog; incompatible
        // entries are REJECTED with a visible reason and blanked, the rest
        // applies (merge + persist + push). Mana is never checked during
        // saving: the agent waits at runtime until a configured spell is
        // affordable.
        const body = await readBody(req);
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (!name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        const from = typeof body.from === 'string' ? body.from.trim() : '';
        if (!from) {
          sendJson(res, 400, { ok: false, reason: 'from required' });
          return;
        }
        const identity = await identityFn();
        if (!identity || !identity.name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        if (name !== identity.name) {
          sendJson(res, 409, { ok: false, reason: 'character mismatch' });
          return;
        }
        const raw = await spellCatalogFn();
        if (!raw || !Array.isArray(raw.spells)) {
          // No catalog = no validation = no cross-load (the rejection list
          // would be a lie). Honest degrade.
          sendJson(res, 503, { ok: false, reason: 'spell catalog unavailable' });
          return;
        }
        const src = store.loadCharacter({ name: from });
        const { rejected, config } = validateAndSanitize(src.config, raw.spells, {
          vocationLabel: identity.vocationLabel || raw.vocationLabel || '',
          playerLevel: raw.playerLevel,
        });
        config.character = name;
        config.connected = true;
        // REQ-18 session-scoped trade toggle: a cross-load starts like a new
        // session (OFF until the user re-enables it in this session).
        if (config.modules && config.modules.trade) config.modules.trade.on = false;
        await applyConfigFn(Object.assign({}, config, { armed: true }));
        store.saveCharacter({ name, config });
        lastCharacter = name;
        sendJson(res, 200, { ok: true, from, rejected, config });
        return;
      }
      if (req.method === 'POST' && url === '/api/disconnect') {
        const body = await readBody(req);
        await applyConfigFn({ armed: false });
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (name) {
          const { config } = store.loadCharacter({ name });
          config.connected = false;
          // REQ-18: the trade toggle resets to OFF on session end (mirror the
          // game's "Toggle resets to OFF on logout").
          if (config.modules && config.modules.trade) config.modules.trade.on = false;
          store.saveCharacter({ name, config });
        }
        lastCharacter = null;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url === '/api/offer') {
        const body = await readBody(req);
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (!name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        const word = String(body.word || '').trim();
        if (!word) {
          sendJson(res, 400, { ok: false, reason: 'word required' });
          return;
        }
        if (body.action === 'decline') {
          // REQ-25: declined = session-silent for the word (agent RPC; no
          // config write — the offer must NOT persist without confirmation).
          await respondOfferFn('decline', word);
          sendJson(res, 200, { ok: true, action: 'decline', word });
          return;
        }
        if (body.action === 'confirm') {
          // REQ-25: registration writes config ONLY with user confirmation:
          // append the word to the character's learning.knownWords, persist
          // via the REQ-09 store, and push the updated config to the agent.
          const { config } = store.loadCharacter({ name });
          config.character = name;
          if (!config.modules.learning || typeof config.modules.learning !== 'object') {
            config.modules.learning = { on: false, knownWords: [] };
          }
          const known = config.modules.learning.knownWords || [];
          if (known.indexOf(word) === -1) known.push(word);
          config.modules.learning.knownWords = known;
          config.connected = true;
          await applyConfigFn(Object.assign({}, config, { armed: true }));
          store.saveCharacter({ name, config });
          lastCharacter = name;
          sendJson(res, 200, { ok: true, action: 'confirm', word, config });
          return;
        }
        sendJson(res, 400, { ok: false, reason: 'action must be confirm or decline' });
        return;
      }
      if (req.method === 'POST' && url === '/api/antibot-confirm') {
        // REQ-34 (PR5): user confirmed a pending anti-bot pattern. The
        // confirmation PERSISTS per character (config.modules.antibot
        // .confirmed — additive shape; the agent itself keeps the
        // session-scoped set in state.timers, REQ-34 "per session") and the
        // in-page confirmAntibot RPC enables auto-replies for the session.
        const body = await readBody(req);
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (!name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
        if (!pattern) {
          sendJson(res, 400, { ok: false, reason: 'pattern required' });
          return;
        }
        const { config } = store.loadCharacter({ name });
        config.character = name;
        if (!config.modules.antibot || typeof config.modules.antibot !== 'object') {
          config.modules.antibot = { on: false, replies: [] };
        }
        const confirmed = config.modules.antibot.confirmed || [];
        if (confirmed.indexOf(pattern) === -1) confirmed.push(pattern);
        // Bounded cap (post-chain maintenance, obs 10502 — verify SUGGESTION
        // 3): keep at most the LAST 200 confirmed patterns per character,
        // dropping the oldest on overflow. The agent's session-scoped set is
        // already bounded; this keeps the persisted per-character log bounded
        // too (an append-only log with no cap would grow forever).
        const CONFIRMED_CAP = 200;
        if (confirmed.length > CONFIRMED_CAP) confirmed.splice(0, confirmed.length - CONFIRMED_CAP);
        config.modules.antibot.confirmed = confirmed;
        config.connected = true;
        await confirmAntibotFn(pattern); // in-page session confirmation (REQ-34)
        store.saveCharacter({ name, config });
        lastCharacter = name;
        sendJson(res, 200, { ok: true, pattern, confirmed });
        return;
      }
      if (req.method === 'POST' && url === '/api/runecheck-resume') {
        // REQ-41 (PR A, D-A5): the panel's Resume button — RPCs the in-page
        // agent resumeRuneCheck (unpauses the queue gate + clears the
        // rune-check state). 409 while no character is connected; 400 on a
        // non-object body (invalid JSON is rejected by the body reader).
        const body = await readBody(req);
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (!name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, reason: 'invalid body' });
          return;
        }
        const result = await resumeRuneCheckFn();
        sendJson(res, 200, { ok: true, result: result || null });
        return;
      }
      if (req.method === 'GET' && url === '/api/hotkeys') {
        // REQ-46 (D-B3): hotkey read — the panel learns whether the game
        // keyboard surface is exposed ({available}) + the current slot:keyCode
        // keybinds + the per-character configured F-keys. Connected-gated:
        // the config belongs to the last armed character.
        if (!lastCharacter) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        const kb = await getHotbarKeybindsFn();
        const { config } = store.loadCharacter({ name: lastCharacter });
        const training = config.modules && config.modules.training || {};
        const hotkeys = training.hotkeys && typeof training.hotkeys === 'object' ? training.hotkeys : {};
        sendJson(res, 200, {
          ok: true,
          available: Boolean(kb && kb.available === true),
          keybinds: kb && kb.available === true && kb.keybinds ? kb.keybinds : null,
          configured: { runeKey: hotkeys.runeKey || 'F4', fallbackKey: hotkeys.fallbackKey || 'F5' },
        });
        return;
      }
      if (req.method === 'POST' && url === '/api/hotkeys') {
        // REQ-46 (D-B3): assign a hotbar slot to an F-key — the server RPCs
        // setHotbarKeybind (writes keyboard.__hotbarKeybinds[slot]) and
        // persists the key per character (training.hotkeys.runeKey/fallbackKey
        // — runeKey for the rune-making slot, fallbackKey for the fallback
        // slot, design D-B3). When the keyboard surface is absent the RPC
        // refuses and NOTHING persists (honest display-only degrade).
        const body = await readBody(req);
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (!name) {
          sendJson(res, 409, { ok: false, reason: 'not connected' });
          return;
        }
        const slot = Number(body.slot);
        const key = String(body.key || '');
        if (!Number.isInteger(slot) || slot < 1 || slot > 12 || HOTKEY_KEYS.indexOf(key) === -1) {
          sendJson(res, 400, { ok: false, reason: 'invalid hotkey — slot 1-12 and key F1-F12' });
          return;
        }
        const rpcResult = await setHotbarKeybindFn({ slot, keyCode: KEYCODES[key] });
        if (!rpcResult || rpcResult.ok !== true) {
          sendJson(res, 200, { ok: false, reason: (rpcResult && rpcResult.reason) || 'keyboard surface unavailable' });
          return;
        }
        const { config } = store.loadCharacter({ name });
        config.character = name;
        if (!config.modules.training || typeof config.modules.training !== 'object') config.modules.training = {};
        if (!config.modules.training.hotkeys || typeof config.modules.training.hotkeys !== 'object') {
          config.modules.training.hotkeys = {};
        }
        const isFallback = config.modules.runes && Number(config.modules.runes.fallbackSlot) === slot;
        config.modules.training.hotkeys[isFallback ? 'fallbackKey' : 'runeKey'] = key;
        store.saveCharacter({ name, config });
        lastCharacter = name;
        sendJson(res, 200, { ok: true, slot, key });
        return;
      }

      // Static shell (exact-name whitelist — no path joins). '/' -> index.html.
      const requested = url === '/' ? 'index.html' : url.slice(1);
      if (req.method === 'GET' && STATIC_FILES.indexOf(requested) !== -1) {
        const file = path.join(staticDir, requested);
        try {
          const content = fs.readFileSync(file);
          res.writeHead(200, { 'Content-Type': contentTypeFor(requested), 'Cache-Control': 'no-store' });
          res.end(content);
        } catch (err) {
          sendJson(res, 404, { error: 'asset not found: ' + requested });
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (msg.startsWith('invalid JSON body') || msg.startsWith('body too large')) {
        sendJson(res, 400, { error: msg });
      } else {
        sendJson(res, 500, { error: msg });
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        url: 'http://' + host + ':' + port,
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

module.exports = { createPanelServer, STATIC_FILES };
