'use strict';

/**
 * PR 6 — panel server tests for the cavebot skeleton endpoint (REQ-36): POST
 * /api/cavebot — armed-gated (409 not connected), command-validated (400
 * unknown command), and RPC passthrough for record-start / record-stop /
 * start (the record-stop result carries the waypoints the panel saves into
 * config.routes). Real HTTP on an ephemeral 127.0.0.1 port + real store on
 * a temp dir.
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

function makeBaseDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-panel7-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Server with stub identity/applyConfig/cavebotRpc + REAL store. */
async function makeServer(t, overrides = {}) {
  const base = makeBaseDir(t);
  const calls = { cavebotRpc: [], applyConfig: [], saveCount: 0 };
  const srv = await panelServer.createPanelServer({
    staticDir: STATIC_DIR,
    identity: overrides.identity || (async () => FLAMAMEX),
    applyConfig: async (config) => { calls.applyConfig.push(config); return true; },
    cavebotRpc: overrides.cavebotRpc || (async (command) => {
      calls.cavebotRpc.push(command);
      if (command === 'record-stop') return { ok: true, points: [{ x: 1, y: 2 }] };
      return { ok: true };
    }),
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => { calls.saveCount += 1; return store.saveCharacter(Object.assign({ baseDir: base }, o)); },
    },
  });
  t.after(async () => { await srv.close(); });
  return { srv, calls, base };
}

async function post(srv, pathname, body) {
  const res = await fetch(srv.url + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('REQ-36: POST /api/cavebot refused with 409 while nothing is connected', async (t) => {
  const { srv, calls } = await makeServer(t, { identity: async () => null });
  const res = await post(srv, '/api/cavebot', { character: null, command: 'record-start' });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'not connected');
  assert.equal(calls.cavebotRpc.length, 0, 'no RPC without a connected character');
});

test('REQ-36: POST /api/cavebot rejects unknown commands with 400', async (t) => {
  const { srv, calls } = await makeServer(t);
  const res = await post(srv, '/api/cavebot', { character: 'Flamamex', command: 'teleport' });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'unknown command');
  assert.equal(calls.cavebotRpc.length, 0);
});

test('REQ-36: POST /api/cavebot dispatches record-start/record-stop/start to the RPC', async (t) => {
  const { srv, calls } = await makeServer(t);
  for (const command of ['record-start', 'record-stop', 'start']) {
    const res = await post(srv, '/api/cavebot', { character: 'Flamamex', command });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.command, command);
  }
  assert.deepEqual(calls.cavebotRpc, ['record-start', 'record-stop', 'start']);
});

test('REQ-36: record-stop returns the recorded waypoints for the panel save', async (t) => {
  const { srv } = await makeServer(t, {
    cavebotRpc: async (command) => (command === 'record-stop'
      ? { ok: true, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }
      : { ok: true }),
  });
  const res = await post(srv, '/api/cavebot', { character: 'Flamamex', command: 'record-stop' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.result.points, [{ x: 10, y: 20 }, { x: 30, y: 40 }]);
});

test('REQ-36: store defaults carry the skeleton module shapes (attack + cavebot)', (t) => {
  const base = makeBaseDir(t);
  const cfg = store.defaultConfig('Flamamex');
  assert.deepEqual(cfg.modules.attack, { on: false, targeting: 'lowest-hp', sid: null, runeSlot: null });
  assert.deepEqual(cfg.modules.cavebot, { on: false, paused: false });
  // The saved route list travels at the TOP level (REQ-36 config.routes).
  assert.deepEqual(cfg.routes, []);
  // Forward-compat: a SAVED config without the new modules merges the defaults in.
  const saved = { character: 'Flamamex', modules: { healItems: { on: true, threshold: 50, slotCids: [] } } };
  const merged = store.mergeConfig(saved, store.defaultConfig('Flamamex'));
  assert.equal(merged.modules.attack.on, false, 'attack default present after merge');
  assert.equal(merged.modules.cavebot.on, false, 'cavebot default present after merge');
  assert.equal(merged.modules.healItems.on, true, 'saved module preserved');
  // A saved route list survives the merge (the panel save target).
  const withRoute = store.mergeConfig(
    { routes: [{ x: 1, y: 2 }] },
    store.defaultConfig('Flamamex'),
  );
  assert.deepEqual(withRoute.routes, [{ x: 1, y: 2 }]);
});
