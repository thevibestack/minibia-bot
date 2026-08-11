'use strict';

/**
 * PR A — panel server tests (REQ-41): POST /api/runecheck-resume RPCs the
 * in-page resumeRuneCheck (unpauses the queue gate + clears the rune-check
 * state). 409 while no character is connected; 400 on a non-object body
 * (invalid JSON is rejected by the body reader); ok on success. Real HTTP
 * on an ephemeral 127.0.0.1 port + real store on a temp dir.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-panel-runecheck-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Server with stub identity/applyConfig/resumeRuneCheck + REAL store. */
async function makeServer(t, overrides = {}) {
  const base = makeBaseDir(t);
  const calls = { applyConfig: [], resumeRuneCheck: 0 };
  const srv = await panelServer.createPanelServer({
    staticDir: STATIC_DIR,
    identity: overrides.identity || (async () => FLAMAMEX),
    applyConfig: async (config) => { calls.applyConfig.push(config); return true; },
    resumeRuneCheck: async () => { calls.resumeRuneCheck += 1; return { ok: true }; },
    store: {
      loadCharacter: (o) => store.loadCharacter(Object.assign({ baseDir: base }, o)),
      saveCharacter: (o) => store.saveCharacter(Object.assign({ baseDir: base }, o)),
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

test('REQ-41: POST /api/runecheck-resume RPCs resumeRuneCheck and returns ok', async (t) => {
  const { srv, calls } = await makeServer(t);
  await connect(srv);

  const res = await fetch(srv.url + '/api/runecheck-resume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: 'Flamamex' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(calls.resumeRuneCheck, 1, 'in-page resumeRuneCheck RPC reached');
});

test('REQ-41: /api/runecheck-resume refused while no character is connected (409)', async (t) => {
  const { srv, calls } = await makeServer(t);

  const res = await fetch(srv.url + '/api/runecheck-resume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.reason, 'not connected');
  assert.equal(calls.resumeRuneCheck, 0, 'no RPC pre-connect');
});

test('REQ-41: /api/runecheck-resume refuses a non-object body (400)', async (t) => {
  const { srv, calls } = await makeServer(t);
  await connect(srv);

  const res = await fetch(srv.url + '/api/runecheck-resume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify('nope'),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.reason, 'invalid body');
  assert.equal(calls.resumeRuneCheck, 0, 'no RPC for a malformed body');
});
