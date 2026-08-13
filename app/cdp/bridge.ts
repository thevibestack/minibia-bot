'use strict';

/**
 * CDP bridge — attach / inject / RPC (task 1.6, REQ-04).
 *
 * Zero-dependency page-level CDP session over the WebSocket
 * `webSocketDebuggerUrl` (Bun/Node 22+ built-in WebSocket; injectable for
 * tests and the compiled app):
 *
 * - attachTarget(url)          open the page-level session
 * - injectOnNewDocument(src)   Page.addScriptToEvaluateOnNewDocument —
 *                              MAIN world, re-runs on every navigation
 *                              (reload-surviving injection, REQ-04)
 * - evaluate(expression)       Runtime.evaluate (sparse RPCs; the engine
 *                              runs IN PAGE — no per-tick RPCs, REQ-04)
 * - waitForSurface(probe)      poll until the in-page surface answers again
 *                              after a reload — re-establish WITHOUT
 *                              re-attach (the new document auto-runs the
 *                              injected script)
 * - getPlayerIdentity()        interconnection data contract: reads the
 *                              player name + vocation in page and returns
 *                              {name, vocationId, vocationLabel}
 *                              (identity.ts, REQ-02 prep)
 *
 * The agent bundle itself is built by tools/build-agent.js (slice 2);
 * main.ts passes the bundle source in as `injectionSource`.
 */

const { normalizeIdentity, PLAYER_IDENTITY_EXPRESSION } = require('./identity.ts');
const { validateDebugPort } = require('./launch.ts');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_POLL_MS = 100;

/**
 * REQ-05 local-only boundary: the attach URL must be a ws:// endpoint on
 * 127.0.0.1 (or localhost) with a valid port. Rejects anything else —
 * the app never attaches to remote debugger endpoints.
 * @param {unknown} url
 * @returns {boolean}
 */
function isLocalDebuggerUrl(url) {
  if (typeof url !== 'string' || url.indexOf('ws://') !== 0) return false;
  const rest = url.slice('ws://'.length);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  let host = '';
  let port = '';
  if (authority.indexOf('[') === 0) {
    const end = authority.indexOf(']');
    if (end === -1 || authority[end + 1] !== ':') return false;
    host = authority.slice(0, end + 1);
    port = authority.slice(end + 2);
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon === -1) return false;
    host = authority.slice(0, colon);
    port = authority.slice(colon + 1);
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return false;
  return validateDebugPort(port) !== null;
}

/**
 * Create a CDP session over one WebSocket.
 * @param {{url: string, WebSocketCtor?: Function, timeoutMs?: number}} opts
 * @returns {Promise<object>} session handle
 */
function attachTarget(opts) {
  const url = opts.url;
  const WebSocketCtor = opts.WebSocketCtor || (typeof WebSocket === 'function' ? WebSocket : null);
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (!WebSocketCtor) return Promise.reject(new Error('no WebSocket implementation available'));
  if (!isLocalDebuggerUrl(url)) {
    return Promise.reject(new Error('invalid webSocketDebuggerUrl (must be local loopback ws://127.0.0.1:<port>/... or ws://[::1]:<port>/...): ' + JSON.stringify(url)));
  }
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocketCtor(url);
    } catch (e) {
      reject(new Error('CDP attach failed: ' + ((e && e.message) || e)));
      return;
    }
    const session = createSession(ws);
    const timer = setTimeout(() => {
      reject(new Error('CDP attach timed out after ' + timeoutMs + 'ms: ' + url));
      try { ws.close(); } catch (e) { /* best-effort */ }
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(session);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP attach failed (WebSocket error): ' + url));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      session._onClosed();
    };
  });
}

/**
 * Wrap an open WebSocket into a JSON-RPC session.
 * @param {object} ws
 * @returns {object} {send, onEvent, close, _onClosed, _handleMessage}
 */
function createSession(ws) {
  let nextId = 1;
  const pending = new Map();
  const eventHandlers = new Set();
  let closed = false;

  function dispatch(raw) {
    let msg = null;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error('CDP ' + waiter.method + ' failed: ' + (msg.error.message || JSON.stringify(msg.error))));
      else waiter.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      for (const handler of eventHandlers) {
        try { handler(msg); } catch (e) { /* handler errors must not kill the session */ }
      }
    }
  }

  ws.onmessage = (event) => dispatch(typeof event.data === 'string' ? event.data : String(event.data));

  return {
    /**
     * Send a CDP command. Resolves with `result`, rejects on response
     * error, close, or timeout.
     * @param {string} method
     * @param {object} [params]
     * @param {{timeoutMs?: number}} [cmdOpts]
     */
    send(method, params, cmdOpts) {
      if (closed) return Promise.reject(new Error('CDP session closed — reconnect before sending ' + method));
      const id = nextId;
      nextId += 1;
      const timeoutMs = (cmdOpts && cmdOpts.timeoutMs !== undefined) ? cmdOpts.timeoutMs : DEFAULT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('CDP ' + method + ' timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        pending.set(id, {
          method,
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try {
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error('CDP ' + method + ' send failed: ' + ((e && e.message) || e)));
        }
      });
    },
    /** Subscribe to CDP events (non-command messages). @param {Function} handler */
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    close() {
      closed = true;
      for (const waiter of pending.values()) waiter.reject(new Error('CDP session closed'));
      pending.clear();
      try { ws.close(); } catch (e) { /* best-effort */ }
    },
    _onClosed() {
      closed = true;
      for (const waiter of pending.values()) waiter.reject(new Error('CDP session closed'));
      pending.clear();
    },
    _handleMessage(raw) { dispatch(raw); },
    _isClosed() { return closed; },
  };
}

/**
 * Enable the Page + Runtime domains on a fresh session. REQUIRED before
 * Page.addScriptToEvaluateOnNewDocument: Chrome 136+ (verified on 151)
 * silently accepts the registration without Page.enable but the script
 * never runs on new documents. Call right after attach, before injection.
 * @param {object} session
 * @returns {Promise<void>}
 */
async function enablePageDomains(session) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
}

/**
 * Inject a script that re-runs on every new document (main world).
 * Resolves with the script identifier (REQ-04). Call enablePageDomains
 * first (Chrome 136+ requirement).
 * @param {object} session
 * @param {string} source
 * @returns {Promise<{identifier: string}>}
 */
function injectOnNewDocument(session, source) {
  if (typeof source !== 'string' || source.length === 0) {
    return Promise.reject(new Error('injection source must be a non-empty string'));
  }
  return session.send('Page.addScriptToEvaluateOnNewDocument', { source });
}

/**
 * Evaluate an expression in the page. Returns the serialized result value;
 * rejects with an actionable message on page exceptions (REQ-04 sparse RPC).
 * @param {object} session
 * @param {string} expression
 * @param {{awaitPromise?: boolean}} [opts]
 * @returns {Promise<unknown>}
 */
async function evaluate(session, expression, opts = {}) {
  const res = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise === true,
  });
  if (res && res.exceptionDetails) {
    const text = res.exceptionDetails.exception && res.exceptionDetails.exception.description
      ? res.exceptionDetails.exception.description
      : (res.exceptionDetails.text || 'page exception');
    throw new Error('page evaluation failed: ' + text);
  }
  return res && res.result ? res.result.value : undefined;
}

/**
 * Poll an in-page probe expression until it answers truthy — the surface
 * is re-established on the new document WITHOUT re-attaching (the injected
 * script auto-runs on navigation; REQ-04).
 * @param {object} session
 * @param {string} probeExpression
 * @param {{timeoutMs?: number, intervalMs?: number, evaluateImpl?: Function}} [opts]
 * @returns {Promise<unknown>} the truthy probe value
 */
async function waitForSurface(session, probeExpression, opts = {}) {
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs !== undefined ? opts.intervalMs : DEFAULT_POLL_MS;
  const evalImpl = opts.evaluateImpl || evaluate;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evalImpl(session, probeExpression);
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('page surface not re-established within ' + timeoutMs + 'ms' + (lastError ? ' (last error: ' + lastError.message + ')' : ''));
}

/**
 * Reload the target and wait until the injected surface re-establishes on
 * the new document (REQ-04 "surface re-established without re-attach").
 * @param {object} session
 * @param {string} probeExpression
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @returns {Promise<unknown>}
 */
async function reloadAndWaitForSurface(session, probeExpression, opts = {}) {
  await session.send('Page.reload', { ignoreCache: true });
  return waitForSurface(session, probeExpression, opts);
}

/**
 * Interconnection data contract (REQ-02 prep): read the player name +
 * vocation in page and normalize to {name, vocationId, vocationLabel}.
 * Returns null while the game client is not ready (CF challenge page).
 * @param {object} session
 * @param {{evaluateImpl?: Function}} [opts]
 * @returns {Promise<{name: string, vocationId: number|null, vocationLabel: string}|null>}
 */
async function getPlayerIdentity(session, opts = {}) {
  const evalImpl = opts.evaluateImpl || evaluate;
  const raw = await evalImpl(session, PLAYER_IDENTITY_EXPRESSION);
  return normalizeIdentity(raw);
}

module.exports = {
  attachTarget,
  createSession,
  enablePageDomains,
  injectOnNewDocument,
  evaluate,
  waitForSurface,
  reloadAndWaitForSurface,
  getPlayerIdentity,
};
