'use strict';

/**
 * Panel server tests (tasks 3.3/3.4, REQ-05/08/09): real HTTP on an
 * ephemeral 127.0.0.1 port, real per-character store against a temp dir.
 * Also proves the runMain wiring: panel:true starts the server after
 * attach+inject and the identity/connect flows reach the page agent
 * through the CDP session (REQ-02/04/05).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const main = require('../../app/main.ts');
const panelServer = require('../../app/panel/server.ts');
const store = require('../../app/store/characters.ts');
const { makeMockWebSocket } = require('../../test-support/mock-websocket.js');

const STATIC_DIR = path.join(__dirname, '..', '..', 'app', 'panel');
const MINIBIA_TARGET = {
  type: 'page',
  title: 'Minibia',
  url: 'https://minibia.com/play',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
};

const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

function makeBaseDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-panel-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Server with stub identity/applyConfig/snapshot + REAL store on temp dir. */
async function makeServer(t, overrides = {}) {
  const base = makeBaseDir(t);
  const calls = { applyConfig: [], saveCount: 0 };
  const srv = await panelServer.createPanelServer({
    staticDir: STATIC_DIR,
    identity: overrides.identity || (async () => FLAMAMEX),
    applyConfig: async (config) => { calls.applyConfig.push(config); return true; },
    snapshot: overrides.snapshot || (async () => ({ stats: { health: 42, mana: 80 }, ok: true })),
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => { calls.saveCount += 1; return store.saveCharacter(Object.assign({ baseDir: base }, o)); },
    },
  });
  t.after(async () => { await srv.close(); });
  return { srv, calls, base };
}

test('REQ-05: server binds 127.0.0.1 only', async (t) => {
  const { srv } = await makeServer(t);
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:/, 'url is 127.0.0.1');
});

test('REQ-08: static shell served — index.html, state.js, app.js, style.css', async (t) => {
  const { srv } = await makeServer(t);
  const html = await (await fetch(srv.url + '/')).text();
  assert.match(html, /Minibia Bot — Control Panel/);
  assert.match(html, /state\.js/);
  assert.match(html, /app\.js/);
  for (const name of ['state.js', 'app.js', 'style.css']) {
    const res = await fetch(srv.url + '/' + name);
    assert.equal(res.status, 200, name + ' served');
    assert.ok((await res.text()).length > 0);
  }
});

test('REQ-05/08: traversal and unknown paths return 404', async (t) => {
  const { srv } = await makeServer(t);
  const res = await fetch(srv.url + '/../package.json');
  assert.equal(res.status, 404, 'no path joins outside the whitelist');
  const res2 = await fetch(srv.url + '/nope.js');
  assert.equal(res2.status, 404);
});

test('REQ-02: /api/identity returns null while the page cannot be read', async (t) => {
  const { srv } = await makeServer(t, { identity: async () => null });
  const res = await (await fetch(srv.url + '/api/identity')).json();
  assert.deepEqual(res, { identity: null });
});

test('REQ-02: /api/identity returns the confirmed player shape', async (t) => {
  const { srv } = await makeServer(t);
  const res = await (await fetch(srv.url + '/api/identity')).json();
  assert.deepEqual(res.identity, FLAMAMEX);
});

test('REQ-02: /api/connect is refused (409) when the identity is unreadable', async (t) => {
  const { srv, calls } = await makeServer(t, { identity: async () => null });
  const res = await fetch(srv.url + '/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'not connected');
  assert.deepEqual(calls.applyConfig, [], 'nothing armed');
});

test('REQ-02/09: /api/connect arms with the pre-filled per-character config', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  // Saved config for Flamamex pre-fills the armed push (REQ-09).
  const saved = store.defaultConfig('Flamamex');
  saved.modules.trade = { on: true, message: 'WTS blank runes', intervalMs: 180000 };
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: saved });

  const res = await fetch(srv.url + '/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.identity, FLAMAMEX);
  assert.equal(body.config.character, 'Flamamex');
  assert.equal(body.config.modules.trade.on, true, 'saved config pre-fills');

  assert.equal(calls.applyConfig.length, 1, 'one armed push');
  assert.equal(calls.applyConfig[0].armed, true, 'push carries armed:true (REQ-02 gate)');
  assert.equal(calls.applyConfig[0].connected, true);
  assert.equal(calls.applyConfig[0].modules.trade.on, true);

  const reloaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.equal(reloaded.config.connected, true, 'connected persisted');
  assert.equal(calls.saveCount >= 1, true);
});

test('REQ-09: /api/connect with a mismatched character name is refused', async (t) => {
  const { srv, calls } = await makeServer(t);
  const res = await fetch(srv.url + '/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'SomeoneElse' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, 'character mismatch');
  assert.deepEqual(calls.applyConfig, []);
});

test('REQ-09: /api/config persists and pushes the armed config', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  const cfg = store.defaultConfig('Flamamex');
  cfg.modules.healItems = { on: true, threshold: 35, slotCids: [3174] };
  const res = await fetch(srv.url + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', config: cfg }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(calls.applyConfig[0].armed, true);
  assert.equal(calls.applyConfig[0].modules.healItems.threshold, 35);
  const reloaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.equal(reloaded.config.modules.healItems.on, true, 'persisted');
});

test('REQ-02: /api/disconnect pushes armed:false and marks the character offline', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  const cfg = store.defaultConfig('Flamamex');
  cfg.connected = true;
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });

  const res = await fetch(srv.url + '/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  assert.equal(res.status, 200);
  const last = calls.applyConfig[calls.applyConfig.length - 1];
  assert.deepEqual(last, { armed: false }, 'disarm push');
  assert.equal(store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config.connected, false);
});

test('REQ-04: /api/snapshot returns the live payload', async (t) => {
  const { srv } = await makeServer(t);
  const res = await (await fetch(srv.url + '/api/snapshot')).json();
  assert.deepEqual(res, { stats: { health: 42, mana: 80 }, ok: true });
});

test('POST with an invalid JSON body -> 400', async (t) => {
  const { srv } = await makeServer(t);
  const res = await fetch(srv.url + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

/* ---------------------- runMain wiring (app/main.ts) ---------------------- */

function makeCdpEnv({ list = () => [] } = {}) {
  const urls = [];
  const env = { chromePort: null, urls, states: [] };
  env.fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/json/version')) {
      const port = Number(url.match(/:(\d+)\/json\/version/)[1]);
      if (env.chromePort === port) return { ok: true, status: 200 };
      throw new Error('ECONNREFUSED ' + url);
    }
    if (url.includes('/json/list')) {
      const port = Number(url.match(/:(\d+)\/json\/list/)[1]);
      return { ok: true, status: 200, json: async () => (typeof list === 'function' ? list(port) : list) };
    }
    throw new Error('unexpected url ' + url);
  };
  env.spawnImpl = (execPath, args, opts) => {
    const arg = args.find((a) => a.startsWith('--remote-debugging-port='));
    if (arg) env.chromePort = Number(arg.split('=')[1]);
    return { pid: 4242, kill() {} };
  };
  env.ws = makeMockWebSocket({ autoAnswerFor: ['Page.enable', 'Runtime.enable'] });
  return env;
}

test('REQ-02/04/05: runMain({panel:true}) starts the panel and the identity/connect flows reach the page agent', async (t) => {
  const env = makeCdpEnv({ list: [MINIBIA_TARGET] });
  const base = makeBaseDir(t);
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    userDataDir: '/tmp/mb-profile',
    // No injectionSource/probeExpression here: the wiring test exercises the
    // panel flows, and manual-answer WS mode would hang on waitForSurface
    // probes (injection + surface re-establish is covered by main.test.js).
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
    onState: (s) => env.states.push(s),
    panel: true,
    panelStaticDir: STATIC_DIR,
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => store.saveCharacter(Object.assign({ baseDir: base }, o)),
    },
  });
  t.after(async () => { await handle.stop(); });

  const ready = env.states.find((s) => s.phase === 'panel-ready');
  assert.ok(ready, 'panel-ready phase emitted');
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:/, 'panel url local-only');
  assert.ok(handle.panel, 'panel handle returned');
  assert.equal(handle.panel.url, ready.url);

  const ws = env.ws.instances[0];
  const answered = {}; // evaluate frame ids already answered

  // /api/identity -> Runtime.evaluate frame -> answer with the player shape.
  const identityPromise = fetch(ready.url + '/api/identity').then((r) => r.json());
  await new Promise((r) => setTimeout(r, 20));
  const sent = ws.sent.map((raw) => JSON.parse(raw));
  const frame = sent.find((m) => m.method === 'Runtime.evaluate');
  assert.ok(frame, 'identity read sent as Runtime.evaluate');
  ws.answer(frame.id, { result: { type: 'object', value: FLAMAMEX } });
  const identityBody = await identityPromise;
  assert.deepEqual(identityBody.identity, FLAMAMEX, 'identity flows page -> CDP -> panel');

  // /api/connect -> server re-reads identity (evaluate frame), then pushes
  // applyConfig (evaluate frame). Answer frames until the push appears.
  const connectPromise = fetch(ready.url + '/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  }).then((r) => r.json());

  let pushFrame = null;
  const deadline = Date.now() + 5000;
  while (!pushFrame && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    const frames = ws.sent.map((raw) => JSON.parse(raw))
      .filter((m) => m.method === 'Runtime.evaluate')
      .filter((m) => !(m.id in answered));
    for (const frame of frames) {
      if (frame.params.expression.indexOf('applyConfig') !== -1) {
        pushFrame = frame;
      } else {
        answered[frame.id] = true;
        ws.answer(frame.id, { result: { type: 'object', value: FLAMAMEX } });
      }
    }
  }
  assert.ok(pushFrame, 'applyConfig push sent as Runtime.evaluate');
  assert.match(pushFrame.params.expression, /applyConfig/);
  assert.match(pushFrame.params.expression, /"armed":true/, 'armed gate flag in the push (REQ-02)');
  ws.answer(pushFrame.id, { result: { type: 'object', value: { ok: true } } });
  const connectBody = await connectPromise;
  assert.equal(connectBody.ok, true);
  assert.equal(connectBody.config.character, 'Flamamex');
  assert.equal(connectBody.config.connected, true);

  assert.ok(store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config.connected, 'armed state persisted');
});

test('REQ-05: runMain without panel:true starts no HTTP server', async (t) => {
  const env = makeCdpEnv({ list: [MINIBIA_TARGET] });
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
  });
  t.after(async () => { await handle.stop(); });
  assert.equal(handle.panel, null, 'no panel by default (existing lifecycle unchanged)');
});
