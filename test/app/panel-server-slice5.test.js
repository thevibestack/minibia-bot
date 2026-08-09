'use strict';

/**
 * Slice-5 panel server tests (REQ-18/25): /api/offer (confirm persists the
 * word via the REQ-09 store with user confirmation; decline RPCs the agent
 * WITHOUT any config write), trade toggle session-scoping (never persisted,
 * reset on disconnect, live on the mid-session push). Real HTTP on an
 * ephemeral 127.0.0.1 port + real store on a temp dir.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-panel5-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Server with stub identity/applyConfig/respondOffer + REAL store. */
async function makeServer(t, overrides = {}) {
  const base = makeBaseDir(t);
  const calls = { applyConfig: [], respondOffer: [], saveCount: 0 };
  const srv = await panelServer.createPanelServer({
    staticDir: STATIC_DIR,
    identity: overrides.identity || (async () => FLAMAMEX),
    applyConfig: async (config) => { calls.applyConfig.push(config); return true; },
    respondOffer: async (action, word) => { calls.respondOffer.push({ action, word }); return { ok: true }; },
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => { calls.saveCount += 1; return store.saveCharacter(Object.assign({ baseDir: base }, o)); },
    },
  });
  t.after(async () => { await srv.close(); });
  return { srv, calls, base };
}

test('REQ-25: /api/offer decline RPCs the agent (session-silent) and writes NO config', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  // Establish an armed character first (connect flow).
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  const before = calls.saveCount;
  const res = await fetch(srv.url + '/api/offer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'decline', word: 'exura', character: 'Flamamex' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, action: 'decline', word: 'exura' });
  assert.deepEqual(calls.respondOffer, [{ action: 'decline', word: 'exura' }], 'agent RPC reached');
  assert.equal(calls.saveCount, before, 'decline persists NOTHING (REQ-25 no config write)');
  const reloaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config;
  assert.deepEqual(reloaded.modules.learning.knownWords, [], 'no word written without confirmation');
});

test('REQ-25: /api/offer confirm appends the word to learning.knownWords, persists, and pushes armed', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  const res = await fetch(srv.url + '/api/offer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'confirm', word: 'exura', character: 'Flamamex' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.config.modules.learning.knownWords, ['exura'], 'push config carries the word');

  const push = calls.applyConfig[calls.applyConfig.length - 1];
  assert.equal(push.armed, true, 'confirm push arms (REQ-25 confirmation gate)');
  assert.deepEqual(push.modules.learning.knownWords, ['exura']);

  const reloaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config;
  assert.deepEqual(reloaded.modules.learning.knownWords, ['exura'], 'persisted via the REQ-09 store');

  // Confirming the same word twice does not duplicate.
  const res2 = await fetch(srv.url + '/api/offer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'confirm', word: 'exura', character: 'Flamamex' }),
  });
  assert.equal(res2.status, 200);
  assert.deepEqual(store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config.modules.learning.knownWords,
    ['exura'], 'no duplicate entries');
});

test('REQ-25: /api/offer refused when no character is connected', async (t) => {
  const { srv } = await makeServer(t);
  const res = await fetch(srv.url + '/api/offer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'confirm', word: 'exura' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, 'not connected');
});

test('REQ-25: /api/offer with an unknown action or empty word -> 400', async (t) => {
  const { srv } = await makeServer(t);
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  const bad = await fetch(srv.url + '/api/offer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'maybe', word: 'exura' }),
  });
  assert.equal(bad.status, 400);
  const empty = await fetch(srv.url + '/api/offer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'confirm', word: '  ' }),
  });
  assert.equal(empty.status, 400);
});

test('REQ-18: /api/config pushes the LIVE trade toggle but never persists it', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  const cfg = store.defaultConfig('Flamamex');
  cfg.modules.trade = { on: true, message: 'buying blank runes', intervalMs: 180000 };
  const res = await fetch(srv.url + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', config: cfg }),
  });
  assert.equal(res.status, 200);
  const push = calls.applyConfig[calls.applyConfig.length - 1];
  assert.equal(push.modules.trade.on, true, 'the live session push carries the on-state');
  const reloaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config;
  assert.equal(reloaded.modules.trade.on, false, 'the on-state is NEVER persisted (REQ-18)');
});

test('REQ-18: /api/disconnect resets the trade toggle to OFF in the saved config', async (t) => {
  const { srv, base } = await makeServer(t);
  // Simulate a session where trade was enabled: the SAVED file carries the
  // off-state per REQ-18, but a pre-slice-5 file could carry on:true — the
  // disconnect must clear it regardless (game mirror: reset on logout).
  const cfg = store.defaultConfig('Flamamex');
  cfg.connected = true;
  cfg.modules.trade.on = true; // stale file
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });

  const res = await fetch(srv.url + '/api/disconnect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  assert.equal(res.status, 200);
  const reloaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config;
  assert.equal(reloaded.connected, false);
  assert.equal(reloaded.modules.trade.on, false, 'trade toggle reset to OFF on session end (REQ-18)');
});

test('REQ-18: /api/connect starts a NEW session with the trade toggle OFF', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  const cfg = store.defaultConfig('Flamamex');
  cfg.modules.trade.on = true; // stale on-state in the file (pre-slice-5 data)
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });

  const res = await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.config.modules.trade.on, false, 'new-session pre-fill is OFF (REQ-18)');
  assert.equal(calls.applyConfig[0].modules.trade.on, false, 'new-session push is OFF');
  assert.equal(store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config.modules.trade.on, false);
});
