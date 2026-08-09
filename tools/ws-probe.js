'use strict';

/**
 * LIVE probe harness — game WebSocket handle location (task 2.6, REQ-12).
 * NOT part of `npm test` (needs a real Chrome with a logged-in minibia.com
 * session on a debug port).
 *
 * Usage: node tools/ws-probe.js --port <debug-port>
 *
 * Purpose: the Action Queue's default minimum interval (150ms) is sized to
 * protect the game server from burst packets. The client is believed to send
 * hotbar clicks over a WebSocket; this probe LOCATES the socket handle(s) a
 * live session uses so the throttle can be dimensioned against the server's
 * actual tolerance (e.g. the client's own rate limit).
 *
 * Non-blocking by design: if the probe cannot run (no game target — e.g.
 * Cloudflare posture on this machine) the degrade path is already active —
 * the queue throttles at dispatch regardless of the WS details (REQ-12), so
 * NO implementation change depends on this probe's result.
 *
 * Exits 0 with findings, or 1 when no game target is reachable.
 */

const { buildScanUrl, filterTargets } = require('../app/cdp/targets.ts');
const bridge = require('../app/cdp/bridge.ts');

// Locate candidate game-bound socket handles on the page. The expression is
// read-only: it only enumerates references, it never sends or mutates.
const WS_PROBE_EXPRESSION = `(function () {
  var out = { found: [], detail: [] };
  function add(name, handle) {
    try {
      out.found.push(name);
      out.detail.push({ name: name, readyState: handle.readyState, url: String(handle.url || '') });
    } catch (e) { out.detail.push({ name: name, error: String(e) }); }
  }
  try {
    var gc = window.gameClient;
    if (!gc) { out.detail.push({ note: 'window.gameClient is not defined yet' }); return out; }
    var keys = ['ws', 'socket', 'connection', 'network', 'net', 'transport', '_ws', 'websocket'];
    for (var i = 0; i < keys.length; i++) {
      var h = gc[keys[i]];
      if (h && typeof h.send === 'function') add('gameClient.' + keys[i], h);
    }
    try {
      if (gc.interface) {
        for (var k in gc.interface) {
          if (gc.interface[k] && typeof gc.interface[k].send === 'function') add('gameClient.interface.' + k, gc.interface[k]);
        }
      }
    } catch (e) { out.detail.push({ note: 'interface scan failed: ' + e }); }
  } catch (e) { out.detail.push({ note: 'probe failed: ' + String(e) }); }
  try {
    // Fallback: live WebSocket instances observed from the page.
    var seen = window.__wsSeen || [];
    for (var j = 0; j < seen.length; j++) add('window.__wsSeen[' + j + ']', seen[j]);
  } catch (e) { out.detail.push({ note: 'ws-seen scan failed: ' + String(e) }); }
  return out;
})()`;

// Instrument BEFORE any game socket opens: hook WebSocket so future
// connections are recorded on window.__wsSeen. Injected on the live page via
// Runtime.evaluate before a reload (best-effort).
const WS_HOOK_SOURCE = `(function () {
  if (window.__wsSeen || !window.WebSocket) return;
  window.__wsSeen = [];
  var NativeWS = window.WebSocket;
  function HookedWS(url, protocols) {
    var inst = new NativeWS(url, protocols);
    window.__wsSeen.push(inst);
    return inst;
  }
  HookedWS.prototype = NativeWS.prototype;
  HookedWS.CONNECTING = NativeWS.CONNECTING;
  HookedWS.OPEN = NativeWS.OPEN;
  HookedWS.CLOSING = NativeWS.CLOSING;
  HookedWS.CLOSED = NativeWS.CLOSED;
  window.WebSocket = HookedWS;
})();`;

function readArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function run() {
  const portRaw = readArg('--port');
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('usage: node tools/ws-probe.js --port <1024-65535>');
    process.exit(2);
  }

  let list = null;
  try {
    list = await (await fetch(buildScanUrl(port))).json();
  } catch (e) {
    console.error('PROBE SKIPPED: no debug endpoint on 127.0.0.1:' + port + ' (' + (e && e.message ? e.message : e)
      + '). Degrade path active: the Action Queue throttles at dispatch regardless (REQ-12) — run this probe from a live session (launch or attach first) to locate the game WebSocket handle.');
    process.exit(1);
  }
  const found = filterTargets(list);
  if (found.length === 0) {
    console.error('PROBE SKIPPED: no minibia.com page target on 127.0.0.1:' + port
      + ' (list: ' + JSON.stringify(list).slice(0, 200)
      + '). Degrade path active: the Action Queue throttles at dispatch regardless (REQ-12) — throttle sizing can be revisited when a live session is reachable.');
    process.exit(1);
  }

  const target = found[0];
  const session = await bridge.attachTarget({ url: target.webSocketDebuggerUrl });
  try {
    await bridge.enablePageDomains(session);
    // Best-effort hook for the NEXT reload, then read the CURRENT handles.
    await bridge.evaluate(session, WS_HOOK_SOURCE).catch(() => {});
    const result = await bridge.evaluate(session, WS_PROBE_EXPRESSION);
    console.log('PROBE target: ' + target.url);
    console.log('PROBE result: ' + JSON.stringify(result, null, 2));
    const names = result && result.found ? result.found : [];
    if (names.length === 0) {
      console.log('PROBE: no send-capable socket handle found on gameClient — try after a reload'
        + ' (hook installed) or report the live client shape.');
    } else {
      console.log('PROBE: ' + names.length + ' handle(s) located — use their url/readyState to'
        + ' dimension the queue minInterval against the game server\'s rate tolerance.');
    }
  } finally {
    session.close();
  }
  console.log('PROBE OK');
  process.exit(0);
}

run().catch((e) => {
  console.error('PROBE ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
