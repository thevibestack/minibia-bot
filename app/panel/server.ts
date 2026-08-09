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
 *   POST /api/config     -> persists + pushes the given config (armed).
 *   GET  /api/snapshot   -> live snapshot payload (readStats + identity).
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
 * @param {object} opts
 * @param {string} opts.staticDir - panel assets dir (index.html etc.)
 * @param {() => Promise<{name: string, vocationId: number|null, vocationLabel: string}|null>} opts.identity
 * @param {(config: object) => Promise<unknown>} opts.applyConfig - push to the in-page agent
 * @param {() => Promise<unknown>} [opts.snapshot] - live state payload
 * @param {object} opts.store - {loadCharacter, saveCharacter} (app/store/characters.ts)
 * @param {string} [opts.host='127.0.0.1'] - REQ-05: local only
 * @param {number} [opts.port=0] - ephemeral by default
 * @returns {{url: string, port: number, close(): Promise<void>}}
 */
function createPanelServer(opts) {
  const staticDir = opts.staticDir;
  const identityFn = opts.identity;
  const applyConfigFn = opts.applyConfig;
  const snapshotFn = typeof opts.snapshot === 'function' ? opts.snapshot : async () => null;
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
        config.character = name;
        config.connected = true;
        await applyConfigFn(Object.assign({}, config, { armed: true }));
        store.saveCharacter({ name, config });
        lastCharacter = name;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url === '/api/disconnect') {
        const body = await readBody(req);
        await applyConfigFn({ armed: false });
        const name = typeof body.character === 'string' && body.character ? body.character : lastCharacter;
        if (name) {
          const { config } = store.loadCharacter({ name });
          config.connected = false;
          store.saveCharacter({ name, config });
        }
        lastCharacter = null;
        sendJson(res, 200, { ok: true });
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
