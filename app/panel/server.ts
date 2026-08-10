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
 * (vocation + level; mana when ctx.mana is provided). Returns
 * {rejected: [{key, reason}], config} — each rejected sid is blanked (null)
 * in the returned config so "the rest applies" (REQ-27 cross-load).
 * @param {object} config
 * @param {Array<object>} catalog - raw client catalog rows ({sid, vocations, level, mana})
 * @param {{vocationLabel: string, playerLevel: number|null, mana: number|null}} ctx
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
  return { rejected, config: out };
}

/** Read current mana from a snapshot payload (app stats shape + legacy
 *  flat shape). Null when not readable (the mana re-check is skipped then). */
function readMana(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload.stats && typeof payload.stats === 'object' && payload.stats.mana !== undefined)
    ? payload.stats.mana
    : payload.mana;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
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
 * @param {() => Promise<unknown>} [opts.snapshot] - live state payload
 * @param {(x: number, y: number) => Promise<unknown>} [opts.walkTo] -
 *   REQ-23 in-page walkTo RPC (native autowalk, queue-dispatched)
 * @param {(command: 'record-start'|'record-stop'|'start') => Promise<unknown>} [opts.cavebotRpc] -
 *   REQ-36 in-page cavebot skeleton RPC dispatcher (record sampler + start)
 * @param {() => Promise<{spells: Array<object>, playerLevel: number|null,
 *   vocationLabel: string|null}|null>} [opts.spellCatalog] -
 *   REQ-28 in-page getSpellCatalog RPC (raw list + player context)
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
  const snapshotFn = typeof opts.snapshot === 'function' ? opts.snapshot : async () => null;
  const walkToFn = typeof opts.walkTo === 'function' ? opts.walkTo : async () => ({ ok: true });
  const cavebotRpcFn = typeof opts.cavebotRpc === 'function'
    ? opts.cavebotRpc : async () => ({ ok: false, reason: 'unavailable' });
  const spellCatalogFn = typeof opts.spellCatalog === 'function' ? opts.spellCatalog : async () => null;
  const store = opts.store;
  const host = opts.host || '127.0.0.1';

  let lastCharacter = null; // last armed character (disconnect needs it)

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    try {
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
        // level + CURRENT mana, D5). A rejection refuses the WHOLE save with
        // the first reason (no persist, no push) — the picker validated
        // client-side at pick time; this guards drops since then. Catalog
        // unavailable -> save proceeds (client-side validation already ran).
        const raw = await spellCatalogFn();
        if (raw && Array.isArray(raw.spells)) {
          const identity = await identityFn();
          const { rejected } = validateAndSanitize(config, raw.spells, {
            vocationLabel: (identity && identity.vocationLabel) || raw.vocationLabel || '',
            playerLevel: raw.playerLevel,
            mana: readMana(await snapshotFn()),
          });
          if (rejected.length > 0) {
            sendJson(res, 409, { ok: false, reason: rejected[0].reason, rejected });
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
        // applies (merge + persist + push). Mana is NOT checked here — the
        // save path (/api/config) re-checks it (REQ-28).
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
          mana: null,
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
