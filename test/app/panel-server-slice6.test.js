'use strict';

/**
 * Slice-6 panel server tests (REQ-23, REQ-09 polish): GET
 * /api/character-config (read-only per-character pre-fill for the CONFIRMED
 * character — identity-match gated, no side effects) and POST /api/walk-to
 * (armed-gated, coordinate-validated, RPCs the in-page walkTo which issues
 * the NATIVE autowalk). Real HTTP on an ephemeral 127.0.0.1 port + real
 * store on a temp dir.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-panel6-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Server with stub identity/applyConfig/respondOffer/walkTo + REAL store. */
async function makeServer(t, overrides = {}) {
  const base = makeBaseDir(t);
  const calls = { applyConfig: [], respondOffer: [], walkTo: [], saveCount: 0 };
  const srv = await panelServer.createPanelServer({
    staticDir: STATIC_DIR,
    identity: overrides.identity || (async () => FLAMAMEX),
    applyConfig: async (config) => { calls.applyConfig.push(config); return true; },
    respondOffer: async (action, word) => { calls.respondOffer.push({ action, word }); return { ok: true }; },
    walkTo: overrides.walkTo || (async (x, y) => { calls.walkTo.push({ x, y }); return { ok: true, method: 'pathTo' }; }),
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => { calls.saveCount += 1; return store.saveCharacter(Object.assign({ baseDir: base }, o)); },
    },
  });
  t.after(async () => { await srv.close(); });
  return { srv, calls, base };
}

test('REQ-09 (slice 6): GET /api/character-config returns the SAVED config for the confirmed character', async (t) => {
  const { srv, base, calls } = await makeServer(t);
  // A saved config with a non-default toggle exists on disk.
  const cfg = store.defaultConfig('Flamamex');
  cfg.modules.routes = { on: true };
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });

  const res = await fetch(srv.url + '/api/character-config?name=Flamamex');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.warning, null);
  assert.equal(body.config.modules.routes.on, true, 'saved settings returned for the pre-fill');
  assert.equal(body.config.character, 'Flamamex');
  assert.equal(calls.saveCount, 0, 'read-only: never persists');
});

test('REQ-09 (slice 6): GET /api/character-config is identity-match gated', async (t) => {
  const { srv } = await makeServer(t);
  const mismatch = await fetch(srv.url + '/api/character-config?name=Otherchar');
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).reason, 'character mismatch');
});

test('REQ-09 (slice 6): GET /api/character-config refused when no identity is readable', async (t) => {
  const { srv } = await makeServer(t, { identity: async () => null });
  const res = await fetch(srv.url + '/api/character-config?name=Flamamex');
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, 'not connected');
});

test('REQ-23: POST /api/walk-to RPCs the in-page walkTo with the coordinates', async (t) => {
  const { srv, calls } = await makeServer(t);
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  const res = await fetch(srv.url + '/api/walk-to', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', x: 150, y: 200 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.x, 150);
  assert.equal(body.y, 200);
  assert.deepEqual(calls.walkTo, [{ x: 150, y: 200 }], 'in-page walkTo RPC reached (REQ-23 native autowalk)');
});

test('REQ-23: POST /api/walk-to refused while no character is connected', async (t) => {
  const { srv, calls } = await makeServer(t);
  const res = await fetch(srv.url + '/api/walk-to', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: 150, y: 200 }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, 'not connected');
  assert.equal(calls.walkTo.length, 0);
});

test('REQ-23: POST /api/walk-to rejects missing or non-numeric coordinates', async (t) => {
  const { srv, calls } = await makeServer(t);
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  for (const bad of [{ x: 150 }, { x: 'a', y: 5 }, { x: null, y: 5 }, { x: 1, y: '' }]) {
    const res = await fetch(srv.url + '/api/walk-to', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ character: 'Flamamex' }, bad)),
    });
    assert.equal(res.status, 400, 'rejects ' + JSON.stringify(bad));
    assert.equal((await res.json()).reason, 'invalid coordinates');
  }
  assert.equal(calls.walkTo.length, 0);
});

test('REQ-23: POST /api/walk-to surfaces the in-page degrade (no pathfinder data)', async (t) => {
  const { srv } = await makeServer(t, {
    walkTo: async () => ({ ok: false, reason: 'no pathfinder data' }),
  });
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  const res = await fetch(srv.url + '/api/walk-to', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', x: 5, y: 8 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.result, { ok: false, reason: 'no pathfinder data' },
    'agent refusal passes through to the panel (honest state)');
});
