'use strict';

/**
 * Tests for app/main.ts lifecycle (task 1.7, REQ-01/03/04/05) with
 * injected fakes — no real Chrome, no real processes.
 *
 * - primary launch path spawns with the VALIDATED port + allowlist flags
 *   while attachFirst can prefer an existing debug-capable game window;
 *   (REQ-03) and attaches to our game window;
 * - port-in-use -> next free port picked and retried (REQ-03);
 * - launch failure falls back to the secondary scan (REQ-01);
 * - every endpoint URL the app builds/fetches is 127.0.0.1 only (REQ-05);
 * - no target anywhere -> actionable picker error, safe stop (REQ-01);
 * - injection + surface probe are wired (REQ-04); stop() terminates the
 *   child (REQ-03).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const main = require(path.join(__dirname, '..', '..', 'app', 'main.ts'));
const { makeMockWebSocket } = require('../../test-support/mock-websocket.js');

const MINIBIA_TARGET = {
  type: 'page',
  title: 'Minibia',
  url: 'https://minibia.com/play',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
};

/**
 * Fake CDP environment modelling the real timeline:
 *  - /json/version answers only AFTER a spawn set env.chromePort (or for
 *    `occupied` ports that already run a debugger) — so findFreePort sees
 *    the pre-spawn world and waitForEndpoint sees the post-spawn world;
 *  - /json/list returns `list(port)` (or a static array) for any port;
 *  - spawnImpl records the call, sets chromePort from the args, and
 *    returns a kill-recording fake child.
 */
function makeCdpEnv({ occupied = [], list = () => [] } = {}) {
  const urls = [];
  const kills = [];
  const calls = [];
  const env = { chromePort: null, urls, kills, calls };

  env.fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/json/version')) {
      const port = Number(url.match(/:(\d+)\/json\/version/)[1]);
      if (env.chromePort === port || occupied.includes(port)) return { ok: true, status: 200 };
      throw new Error('ECONNREFUSED ' + url);
    }
    if (url.includes('/json/list')) {
      const port = Number(url.match(/:(\d+)\/json\/list/)[1]);
      return { ok: true, status: 200, json: async () => (typeof list === 'function' ? list(port) : list) };
    }
    throw new Error('unexpected url ' + url);
  };

  env.spawnImpl = (execPath, args, opts) => {
    calls.push({ execPath, args, opts });
    const arg = args.find((a) => a.startsWith('--remote-debugging-port='));
    if (arg) env.chromePort = Number(arg.split('=')[1]);
    return {
      pid: 4242,
      kill(sig) { kills.push(sig); },
    };
  };

  env.ws = makeMockWebSocket({ autoAnswer: true });
  return env;
}

/** A spawn that never opens an endpoint (simulates a broken launch). */
function brokenSpawn() {
  return () => ({ pid: 1, kill() {} });
}

test('REQ-03/05: primary launch spawns with the validated port and allowlist flags', async () => {
  const env = makeCdpEnv({ list: [MINIBIA_TARGET] });
  const states = [];
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    userDataDir: '/tmp/mb-profile',
    launch: true,
    injectionSource: 'window.__mbAgent = {};',
    probeExpression: 'window.__mbAgent',
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
    onState: (s) => states.push(s),
  });

  assert.strictEqual(env.calls.length, 1);
  assert.strictEqual(env.calls[0].execPath, '/fake/chrome');
  assert.ok(env.calls[0].args.includes('--remote-debugging-port=9222'));
  assert.ok(env.calls[0].args.includes('--user-data-dir=/tmp/mb-profile'));
  assert.ok(env.calls[0].args.includes('--app=https://minibia.com/play'));
  assert.strictEqual(env.calls[0].args.length, 4, 'only allowlist flags reach spawn');

  assert.strictEqual(handle.port, 9222);
  assert.ok(handle.session, 'session attached');
  assert.strictEqual(env.ws.instances.length, 1);
  assert.strictEqual(env.ws.instances[0].url, 'ws://127.0.0.1:9222/devtools/page/ABC');

  const phases = states.map((s) => s.phase);
  assert.ok(phases.includes('launching'));
  assert.ok(phases.includes('endpoint-ready'));
  assert.ok(phases.includes('attached'));
  assert.ok(phases.includes('injected'));

  // REQ-04: the bundle was injected via addScriptToEvaluateOnNewDocument.
  const sent = env.ws.instances[0].sent.map((raw) => JSON.parse(raw));
  const inject = sent.find((m) => m.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.ok(inject, 'injection command sent');
  assert.strictEqual(inject.params.source, 'window.__mbAgent = {};');

  await handle.stop();
  assert.strictEqual(env.kills.length, 1, 'stop() terminates the child (SIGTERM)');
});


test('REQ-01/03: attachFirst uses an existing debug-capable minibia target before launching', async () => {
  const env = makeCdpEnv({ list: [MINIBIA_TARGET] });
  const states = [];
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    attachFirst: true,
    launch: true,
    scanPorts: [9222, 9223, 9224],
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
    onState: (s) => states.push(s),
  });

  assert.strictEqual(env.calls.length, 0, 'existing debug target prevents opening another Chrome');
  assert.ok(handle.session, 'attached to existing target');
  assert.strictEqual(handle.child, null);
  assert.strictEqual(handle.port, null);
  assert.deepStrictEqual(states.map((s) => s.phase).slice(0, 3), ['scanning', 'targets-found', 'attached']);
  assert.ok(!states.map((s) => s.phase).includes('launching'), 'launch path was skipped');
  await handle.stop();
});

test('REQ-01/03: attachFirst falls back to launching when no existing debug target is found', async () => {
  const env = makeCdpEnv({ list: (port) => (port === 9222 ? [MINIBIA_TARGET] : []) });
  const states = [];
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    attachFirst: true,
    launch: true,
    scanPorts: [9333],
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
    onState: (s) => states.push(s),
  });

  assert.strictEqual(env.calls.length, 1, 'no existing target -> owned Chrome launched');
  assert.ok(handle.session, 'attached after launch fallback');
  assert.strictEqual(handle.port, 9222);
  const phases = states.map((s) => s.phase);
  assert.deepStrictEqual(phases.slice(0, 2), ['scanning', 'launching']);
  assert.ok(phases.includes('endpoint-ready'));
  await handle.stop();
});

test('REQ-03: port in use -> next free port picked and retried', async () => {
  const env = makeCdpEnv({ occupied: [9222], list: [MINIBIA_TARGET] });
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    launch: true,
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
  });
  assert.strictEqual(handle.port, 9223, 'the next free port was chosen');
  const debugArg = env.calls[0].args.find((a) => a.startsWith('--remote-debugging-port='));
  assert.strictEqual(debugArg, '--remote-debugging-port=9223');
  await handle.stop();
});

test('REQ-05: every endpoint URL the app fetches is 127.0.0.1 only', async () => {
  const env = makeCdpEnv({ list: [MINIBIA_TARGET] });
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
  });
  assert.ok(env.urls.length >= 3, 'free-port probe + version + list were fetched');
  for (const url of env.urls) {
    assert.ok(url.startsWith('http://127.0.0.1:'), 'local-only endpoint: ' + url);
  }
  await handle.stop();
});

test('REQ-01/03: broken launch falls back to the secondary scan with an actionable error', async () => {
  const env = makeCdpEnv({ list: [] }); // no targets anywhere
  const states = [];
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    launch: true,
    scanPorts: [9222, 9223, 9224],
    spawnImpl: brokenSpawn(), // never opens the endpoint
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
    waitForEndpointMs: 300,
    onState: (s) => states.push(s),
  });
  const phases = states.map((s) => s.phase);
  assert.ok(phases.includes('launch-failed'));
  assert.ok(phases.includes('scanning'));
  assert.strictEqual(handle.session, null, 'no target found anywhere');
  const noTarget = states.find((s) => s.phase === 'no-target');
  assert.ok(noTarget, 'actionable no-target state emitted');
  assert.match(noTarget.message, /No minibia\.com window found/);
  assert.match(noTarget.message, /--remote-debugging-port/);
  await handle.stop(); // safe no-op: no child, no session
});

test('REQ-01: scan-only mode attaches to a detected minibia target', async () => {
  const env = makeCdpEnv({ list: [MINIBIA_TARGET] });
  const handle = await main.runMain({
    launch: false,
    scanPorts: [9222, 9223, 9224],
    injectionSource: '',
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
  });
  assert.strictEqual(env.calls.length, 0, 'no Chrome spawned in scan-only mode');
  assert.ok(handle.session, 'attached to the scanned target');
  assert.strictEqual(handle.port, null, 'scan mode reports no owned port');
  assert.strictEqual(handle.child, null);
  await handle.stop();
});

test('REQ-01: scan-only with nothing found reports the actionable picker error', async () => {
  const env = makeCdpEnv({ list: [] });
  const states = [];
  const handle = await main.runMain({
    launch: false,
    scanPorts: [9222, 9223, 9224],
    fetchImpl: env.fetchImpl,
    onState: (s) => states.push(s),
  });
  const noTarget = states.find((s) => s.phase === 'no-target');
  assert.ok(noTarget);
  assert.match(noTarget.message, /No minibia\.com window found/);
  assert.ok(noTarget.message.includes('Launch'), 'primary path named in the error');
  await handle.stop();
});

test('REQ-02: identity() returns the contract shape from the attached page', async () => {
  const env = makeCdpEnv({ list: [MINIBIA_TARGET] });
  env.ws = makeMockWebSocket({ autoAnswerFor: ['Page.enable', 'Runtime.enable'] }); // manual answers for the identity evaluate frame
  const handle = await main.runMain({
    execPath: '/fake/chrome',
    port: 9222,
    spawnImpl: env.spawnImpl,
    fetchImpl: env.fetchImpl,
    WebSocketCtor: env.ws.ctor,
  });
  const p = handle.identity();
  const sent = env.ws.instances[0].sent.map((raw) => JSON.parse(raw));
  const frame = sent.find((m) => m.method === 'Runtime.evaluate'); // identity expression frame
  assert.ok(frame, 'identity read sent as Runtime.evaluate');
  env.ws.instances[0].answer(frame.id, { result: { type: 'object', value: { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' } } });
  assert.deepStrictEqual(await p, { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' });
  await handle.stop();
});

test('REQ-02: identity() is null when nothing is attached', async () => {
  const env = makeCdpEnv({ list: [] });
  const handle = await main.runMain({ launch: false, scanPorts: [9222], fetchImpl: env.fetchImpl });
  assert.strictEqual(handle.session, null);
  assert.strictEqual(await handle.identity(), null);
});

test('REQ-05: buildVersionUrl refuses invalid ports', () => {
  assert.strictEqual(main.buildVersionUrl(9222), 'http://127.0.0.1:9222/json/version');
  assert.throws(() => main.buildVersionUrl('abc'), RangeError);
  assert.throws(() => main.buildVersionUrl(80), RangeError);
});

test('REQ-03: findFreePort walks to the first free port', async () => {
  const free = await main.findFreePort(9222, {
    fetchImpl: async (url) => {
      if (url.includes(':9222') || url.includes(':9223')) throw new Error('refused');
      return { ok: true, status: 200 };
    },
  });
  assert.strictEqual(free, 9222);

  const walked = await main.findFreePort(9222, {
    fetchImpl: async (url) => {
      if (url.includes(':9222')) return { ok: true, status: 200 }; // in use
      if (url.includes(':9223')) throw new Error('refused');
      return { ok: true, status: 200 };
    },
  });
  assert.strictEqual(walked, 9223, 'next free port picked when 9222 is in use');
});
