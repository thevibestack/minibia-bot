'use strict';

/**
 * Tests for app/cdp/bridge.ts (task 1.6, REQ-04) using a MockWebSocket —
 * NO real Chrome is launched in unit tests. The live Chrome path is the
 * manual-suite harness `tools/cdp-live-smoke.js` (not part of npm test).
 *
 * Covers: attach handshake, JSON-RPC send/reject/timeout, event dispatch,
 * addScriptToEvaluateOnNewDocument injection, Runtime.evaluate values and
 * exception rejection, reload -> surface re-establishment (REQ-04), and
 * the getPlayerIdentity contract (REQ-02 prep).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const bridge = require(path.join(__dirname, '..', '..', 'app', 'cdp', 'bridge.ts'));
const { MockWebSocket, makeMockWebSocket } = require('../../test-support/mock-websocket.js');

const WS_URL = 'ws://127.0.0.1:9222/devtools/page/ABC';

/** Attach a session over a fresh MockWebSocket (already opened). */
async function attachMock() {
  const { ctor, instances } = makeMockWebSocket();
  const session = await bridge.attachTarget({ url: WS_URL, WebSocketCtor: ctor });
  return { ws: instances[0], session };
}

test('REQ-04: attachTarget opens the session and resolves', async () => {
  const { ws, session } = await attachMock();
  assert.strictEqual(ws.url, WS_URL);
  assert.strictEqual(typeof session.send, 'function');
  ws.close();
});


test('REQ-04/05: attachTarget accepts IPv6 loopback debugger URLs', async () => {
  const ipv6Url = 'ws://[::1]:9222/devtools/page/IPV6';
  const { ctor, instances } = makeMockWebSocket();
  const session = await bridge.attachTarget({ url: ipv6Url, WebSocketCtor: ctor });
  assert.strictEqual(instances[0].url, ipv6Url);
  assert.strictEqual(typeof session.send, 'function');
  instances[0].close();
});

test('REQ-04/05: attachTarget rejects non-local and malformed debugger URLs', async () => {
  await assert.rejects(() => bridge.attachTarget({ url: 'ws://evil.example:9222/devtools/page/X', WebSocketCtor: MockWebSocket }), /invalid webSocketDebuggerUrl/);
  await assert.rejects(() => bridge.attachTarget({ url: 'ws://127.0.0.2:9222/devtools/page/X', WebSocketCtor: MockWebSocket }), /invalid webSocketDebuggerUrl/);
  await assert.rejects(() => bridge.attachTarget({ url: 'ws://10.0.0.5:9222/devtools/page/X', WebSocketCtor: MockWebSocket }), /invalid webSocketDebuggerUrl/);
  await assert.rejects(() => bridge.attachTarget({ url: 'ws://127.0.0.1:80/devtools/page/X', WebSocketCtor: MockWebSocket }), /invalid webSocketDebuggerUrl/);
  await assert.rejects(() => bridge.attachTarget({ url: 'http://127.0.0.1:9222/json/list', WebSocketCtor: MockWebSocket }), /invalid webSocketDebuggerUrl/);

  // "no WebSocket" branch: Node 26 has a global WebSocket, so unset it
  // temporarily to exercise the fallback failure path.
  const savedWs = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  try {
    await assert.rejects(() => bridge.attachTarget({ url: 'ws://127.0.0.1:9222/devtools/page/X', WebSocketCtor: undefined }), /no WebSocket/);
  } finally {
    globalThis.WebSocket = savedWs;
  }
});

test('REQ-04: send frames JSON-RPC and resolves the matching response', async () => {
  const { ws, session } = await attachMock();
  const p = session.send('Page.enable');
  const frame = JSON.parse(ws.sent[0]);
  assert.strictEqual(frame.method, 'Page.enable');
  assert.deepStrictEqual(frame.params, {});
  ws.answer(frame.id, { ok: 1 });
  assert.deepStrictEqual(await p, { ok: 1 });
  ws.close();
});

test('REQ-04: send rejects on CDP error responses and on session close', async () => {
  const { ws, session } = await attachMock();
  const p1 = session.send('Page.enable');
  ws.answer(JSON.parse(ws.sent[0]).id, null, { message: 'Method not found' });
  await assert.rejects(() => p1, /Method not found/);

  const p2 = session.send('Page.enable');
  ws.close();
  await assert.rejects(() => p2, /closed/);
  await assert.rejects(() => session.send('Page.enable'), /closed/);
});

test('REQ-04: onEvent dispatches non-command messages (execution contexts)', async () => {
  const { ws, session } = await attachMock();
  const events = [];
  session.onEvent((msg) => events.push(msg));
  ws.emitEvent('Runtime.executionContextCreated', { context: { id: 1 } });
  ws.emitEvent('Page.loadEventFired', {});
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].method, 'Runtime.executionContextCreated');
  ws.close();
});

test('REQ-04: injectOnNewDocument sends Page.addScriptToEvaluateOnNewDocument', async () => {
  const { ws, session } = await attachMock();
  const p = bridge.injectOnNewDocument(session, 'window.__mbAgent = {};');
  const frame = JSON.parse(ws.sent[0]);
  assert.strictEqual(frame.method, 'Page.addScriptToEvaluateOnNewDocument');
  assert.strictEqual(frame.params.source, 'window.__mbAgent = {};');
  ws.answer(frame.id, { identifier: 'id-1' });
  assert.deepStrictEqual(await p, { identifier: 'id-1' });
  ws.close();
});

test('REQ-04: injectOnNewDocument rejects empty source before sending', async () => {
  const { ws, session } = await attachMock();
  await assert.rejects(() => bridge.injectOnNewDocument(session, ''), /non-empty/);
  await assert.rejects(() => bridge.injectOnNewDocument(session, null), /non-empty/);
  assert.strictEqual(ws.sent.length, 0, 'nothing must be sent for invalid source');
  ws.close();
});

test('REQ-04: evaluate returns the serialized value and rejects on exceptions', async () => {
  const { ws, session } = await attachMock();
  const p1 = bridge.evaluate(session, '1 + 1');
  ws.answer(JSON.parse(ws.sent[0]).id, { result: { type: 'number', value: 2 } });
  assert.strictEqual(await p1, 2);

  const p2 = bridge.evaluate(session, 'throw new Error("boom")');
  ws.answer(JSON.parse(ws.sent[1]).id, {
    exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } },
  });
  await assert.rejects(() => p2, /page evaluation failed: Error: boom/);
  ws.close();
});

test('REQ-04: waitForSurface polls until the probe answers truthy', async () => {
  const { ws, session } = await attachMock();
  let probeEvals = 0;
  const evaluateImpl = async (sess, expr) => {
    probeEvals += 1;
    if (probeEvals < 3) return undefined;
    return 'surface-ok';
  };
  const value = await bridge.waitForSurface(session, 'window.__mbAgent ? "surface-ok" : undefined', { intervalMs: 5, evaluateImpl });
  assert.strictEqual(value, 'surface-ok');
  assert.strictEqual(probeEvals, 3, 'polled until the surface answered');
  ws.close();
});

test('REQ-04: waitForSurface rejects with an actionable message on timeout', async () => {
  const { session } = await attachMock();
  await assert.rejects(
    () => bridge.waitForSurface(session, 'window.__mbAgent', { timeoutMs: 50, intervalMs: 10, evaluateImpl: async () => undefined }),
    /surface not re-established within 50ms/,
  );
});

test('REQ-04: reloadAndWaitForSurface reloads then re-establishes on the new document', async () => {
  const { ws, session } = await attachMock();
  let reloads = 0;
  const sendImpl = async (method) => {
    if (method === 'Page.reload') { reloads += 1; return {}; }
    return undefined;
  };
  const session2 = { send: sendImpl };
  let evals = 0;
  const evaluateImpl = async () => {
    evals += 1;
    return evals >= 2 ? 're-established' : undefined;
  };
  const value = await bridge.reloadAndWaitForSurface(session2, 'window.__mbAgent', { intervalMs: 5, evaluateImpl });
  assert.strictEqual(reloads, 1, 'Page.reload issued once');
  assert.strictEqual(value, 're-established');
  assert.ok(evals >= 2, 'polled the new document until the surface answered');
  ws.close();
});

test('REQ-02: getPlayerIdentity returns the contract shape from a page read', async () => {
  const { ws, session } = await attachMock();
  const p = bridge.getPlayerIdentity(session);
  const frame = JSON.parse(ws.sent[0]);
  assert.strictEqual(frame.method, 'Runtime.evaluate');
  assert.strictEqual(frame.params.returnByValue, true);
  ws.answer(frame.id, { result: { type: 'object', value: { name: 'Flamamex', vocationId: 4 } } });
  assert.deepStrictEqual(await p, { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' });
  ws.close();
});

test('REQ-02: getPlayerIdentity returns null while the client is not ready', async () => {
  const { ws, session } = await attachMock();
  const p = bridge.getPlayerIdentity(session);
  ws.answer(JSON.parse(ws.sent[0]).id, { result: { type: 'object', value: { name: null, vocationId: null } } });
  assert.strictEqual(await p, null);
  ws.close();
});
