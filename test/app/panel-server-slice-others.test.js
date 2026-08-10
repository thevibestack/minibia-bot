'use strict';

/**
 * PR 5 — panel server tests (REQ-34): POST /api/antibot-confirm persists the
 * confirmed pattern PER CHARACTER (additive `modules.antibot.confirmed`
 * shape) and RPCs the in-page confirmAntibot (session confirmation). Real
 * HTTP on an ephemeral 127.0.0.1 port + real store on a temp dir.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-panel-others-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Server with stub identity/applyConfig/confirmAntibot + REAL store. */
async function makeServer(t, overrides = {}) {
  const base = makeBaseDir(t);
  const calls = { applyConfig: [], confirmAntibot: [], saveCount: 0 };
  const srv = await panelServer.createPanelServer({
    staticDir: STATIC_DIR,
    identity: overrides.identity || (async () => FLAMAMEX),
    applyConfig: async (config) => { calls.applyConfig.push(config); return true; },
    confirmAntibot: async (pattern) => { calls.confirmAntibot.push(pattern); return { ok: true }; },
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => { calls.saveCount += 1; return store.saveCharacter(Object.assign({ baseDir: base }, o)); },
    },
  });
  t.after(async () => { await srv.close(); });
  return { srv, calls, base };
}

async function connect(srv, name = 'Flamamex') {
  await fetch(srv.url + '/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: name }),
  });
}

test('REQ-34: POST /api/antibot-confirm persists the pattern per character and RPCs the agent', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  await connect(srv);

  const res = await fetch(srv.url + '/api/antibot-confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', pattern: 'verify your account' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.confirmed, ['verify your account']);
  assert.deepEqual(calls.confirmAntibot, ['verify your account'], 'in-page confirmAntibot RPC reached');

  // Persisted per character: a fresh load shows the confirmed pattern.
  const loaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.deepEqual(loaded.config.modules.antibot.confirmed, ['verify your account']);
  assert.equal(loaded.config.character, 'Flamamex');
});

test('REQ-34: /api/antibot-confirm keeps confirming idempotently (no duplicates)', async (t) => {
  const { srv, calls } = await makeServer(t);
  await connect(srv);
  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(srv.url + '/api/antibot-confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character: 'Flamamex', pattern: 'verify your account' }),
    });
    assert.equal(res.status, 200);
  }
  const body = await (await fetch(srv.url + '/api/antibot-confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', pattern: 'verify your account' }),
  })).json();
  assert.deepEqual(body.confirmed, ['verify your account'], 'pattern confirmed exactly once');
  assert.equal(calls.confirmAntibot.length, 3, 'every confirm still RPCs the session agent');
});

test('REQ-34: /api/antibot-confirm refuses an empty pattern (400)', async (t) => {
  const { srv, calls } = await makeServer(t);
  await connect(srv);
  for (const bad of [{ pattern: '' }, { pattern: '   ' }, {}]) {
    const res = await fetch(srv.url + '/api/antibot-confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ character: 'Flamamex' }, bad)),
    });
    assert.equal(res.status, 400, 'rejects ' + JSON.stringify(bad));
    assert.equal((await res.json()).reason, 'pattern required');
  }
  assert.equal(calls.confirmAntibot.length, 0, 'no RPC, no persist for empty patterns');
});

test('REQ-34: /api/antibot-confirm refused while no character is connected (409)', async (t) => {
  const { srv, calls } = await makeServer(t);
  const res = await fetch(srv.url + '/api/antibot-confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pattern: 'verify your account' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, 'not connected');
  assert.equal(calls.confirmAntibot.length, 0);
});

test('REQ-34: per-character isolation — confirming for one character never leaks to another', async (t) => {
  const { srv, base } = await makeServer(t);
  await connect(srv, 'Flamamex');
  await fetch(srv.url + '/api/antibot-confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', pattern: 'verify your account' }),
  });
  // Another character's config file stays untouched (default shape, no confirmed).
  store.saveCharacter({ baseDir: base, name: 'Gobernador', config: store.defaultConfig('Gobernador') });
  const other = store.loadCharacter({ baseDir: base, name: 'Gobernador' });
  assert.equal(other.config.modules.antibot.confirmed, undefined,
    'confirmed list only exists on the character that confirmed (additive shape)');
  assert.deepEqual(other.config.modules.antibot.replies, [], 'default replies untouched');
});

test('REQ-34: the persisted confirmed log is capped at 200 — oldest dropped, newest kept', async (t) => {
  const { srv, calls, base } = await makeServer(t);
  await connect(srv);

  // 201 distinct confirmations overflow the 200 cap.
  let last;
  for (let i = 1; i <= 201; i += 1) {
    const res = await fetch(srv.url + '/api/antibot-confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character: 'Flamamex', pattern: 'pattern-' + i }),
    });
    assert.equal(res.status, 200, 'overflow confirmations still answer 200');
    last = await res.json();
  }

  // The response carries the bounded array: exactly 200, oldest dropped,
  // newest kept.
  assert.equal(last.ok, true);
  assert.equal(last.confirmed.length, 200, 'capped at the last 200 patterns');
  assert.equal(last.confirmed[0], 'pattern-2', 'oldest (pattern-1) dropped');
  assert.equal(last.confirmed[199], 'pattern-201', 'newest kept');
  assert.equal(calls.confirmAntibot.length, 201, 'every confirm still RPCs the session agent');

  // The persisted store matches the bounded in-memory array.
  const loaded = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.equal(loaded.config.modules.antibot.confirmed.length, 200);
  assert.equal(loaded.config.modules.antibot.confirmed[0], 'pattern-2');
  assert.equal(loaded.config.modules.antibot.confirmed[199], 'pattern-201');

  // Confirming an existing pattern after the cap keeps the array bounded.
  const again = await (await fetch(srv.url + '/api/antibot-confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex', pattern: 'pattern-201' }),
  })).json();
  assert.equal(again.confirmed.length, 200, 'idempotent confirm inside the cap stays bounded');
});
