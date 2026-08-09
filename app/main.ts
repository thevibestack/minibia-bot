'use strict';

/**
 * CDP bridge — app lifecycle (task 1.7, REQ-01/03/04/05).
 *
 * Entry/lifecycle for the desktop app:
 *   1. PRIMARY (REQ-01): launch a DEDICATED Chrome instance — validated
 *      port, allowlist flags, non-default --user-data-dir (REQ-03). When
 *      the preferred port is in use, the NEXT free port is picked and
 *      retried (REQ-03 GIVEN port in use).
 *   2. SECONDARY: scan ports 9222-9224 (configurable) via /json/list and
 *      attach to the first minibia.com `type:"page"` target (REQ-01).
 *      When launch fails or nothing is found, onState reports an
 *      ACTIONABLE picker error.
 *   3. ATTACH: page-level CDP session (bridge.ts), inject the agent
 *      bundle via Page.addScriptToEvaluateOnNewDocument (REQ-04 —
 *      reload-surviving), confirm the surface re-establishes.
 *   4. CLEANUP: the spawned child is killed when the app exits
 *      (kill-on-quit, REQ-03) and on stop().
 *
 * Local-only (REQ-05): every endpoint the app touches is built from a
 * validated port against 127.0.0.1; attach rejects non-local ws URLs
 * (bridge.ts isLocalDebuggerUrl). The control-panel server binds later
 * (slice 3) — same 127.0.0.1 rule.
 *
 * The actual agent bundle (tools/build-agent.js) and the panel UI arrive
 * in slices 2-3; main.ts already accepts injectionSource + probeExpression
 * so the wiring is unchanged when they land.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const launch = require('./cdp/launch.ts');
const targets = require('./cdp/targets.ts');
const bridge = require('./cdp/bridge.ts');
const panelServer = require('./panel/server.ts');

const VERSION_PATH = '/json/version';
const ENDPOINT_TIMEOUT_MS = 15000;
const FREE_PORT_PROBE_MS = 400;
const FREE_PORT_TRIES = 20;

/** Page-side snapshot read (REQ-04 sparse RPC, one evaluate per poll). */
const SNAPSHOT_EXPRESSION = [
  '(() => {',
  '  try {',
  '    var a = window.__mbAgent;',
  '    if (!a || typeof a.readStats !== "function") return null;',
  '    return {',
  '      stats: a.readStats(),',
  '      player: typeof a.getPlayerInfo === "function" ? a.getPlayerInfo() : null,',
  '      agent: window.__mbAgentHandle ? window.__mbAgentHandle.getState() : null,',
  '    };',
  '  } catch (e) { return null; }',
  '})()',
].join('\n');

/** @typedef {import('./cdp/bridge.ts')} CdpSession */

/**
 * 127.0.0.1 endpoint URL for the browser info probe (validated port only).
 * @param {number|string} port
 * @returns {string}
 */
function buildVersionUrl(port) {
  const validated = launch.validateDebugPort(port);
  if (validated === null) {
    throw new RangeError('endpoint port must be an integer in 1024..65535, got ' + JSON.stringify(port));
  }
  return 'http://127.0.0.1:' + validated + VERSION_PATH;
}

/**
 * Default app-owned profile dir (non-default --user-data-dir, REQ-03/05).
 * @returns {string}
 */
function defaultUserDataDir() {
  const base = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(base, 'minibia-desktop-bot', 'chrome-profile');
}

/**
 * Pick the first free port starting at `startPort` by probing /json/version
 * on 127.0.0.1. An answering endpoint means the port is in use (REQ-03:
 * next free port picked and retried). Returns null when no candidate is
 * free within maxTries.
 * @param {number} startPort
 * @param {{fetchImpl?: Function, tries?: number}} [opts]
 * @returns {Promise<number|null>}
 */
async function findFreePort(startPort, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const tries = opts.tries !== undefined ? opts.tries : FREE_PORT_TRIES;
  if (!fetchImpl) return null;
  for (let i = 0; i < tries; i += 1) {
    const port = startPort + i;
    if (launch.validateDebugPort(port) === null) return null; // walked out of range
    const url = buildVersionUrl(port);
    try {
      await fetchImpl(url);
      // Answered -> a debug endpoint already listens there; keep walking.
    } catch (e) {
      return port; // refused -> free
    }
  }
  return null;
}

/**
 * Wait until the launched Chrome answers /json/version on the chosen port.
 * @param {number} port
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<void>}
 */
async function waitForEndpoint(port, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : ENDPOINT_TIMEOUT_MS;
  if (!fetchImpl) throw new Error('no fetch implementation available');
  const url = buildVersionUrl(port);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await fetchImpl(url);
      return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Chrome did not open the debug endpoint on port ' + port + ' within ' + timeoutMs + 'ms' + (lastError ? ' (' + lastError.message + ')' : ''));
}

/**
 * Run the app lifecycle.
 *
 * @param {object} opts
 * @param {string} [opts.execPath] chrome executable (fixed known locations)
 * @param {number} [opts.port] preferred debug port (default 9222)
 * @param {string} [opts.userDataDir] app-owned profile dir (default defaultUserDataDir())
 * @param {number[]} [opts.scanPorts] secondary scan set (default DEFAULT_SCAN_PORTS)
 * @param {boolean} [opts.launch] primary launch path (default true)
 * @param {string} [opts.injectionSource] agent bundle (slice 2); empty = no injection
 * @param {string} [opts.probeExpression] surface re-establish probe
 * @param {Function} [opts.fetchImpl] injectable fetch (tests)
 * @param {Function} [opts.WebSocketCtor] injectable WebSocket (tests)
 * @param {Function} [opts.spawnImpl] injectable child_process.spawn (tests)
 * @param {Function} [opts.onState] state/event callback (picker/panel)
 * @param {boolean} [opts.panel] start the control-panel server (slice 3)
 * @param {string} [opts.panelStaticDir] panel assets dir (default app/panel)
 * @param {object} [opts.store] per-character store {loadCharacter, saveCharacter}
 * @returns {Promise<{child: object|null, session: object|null, port: number|null, stop(): Promise<void>, identity(): Promise<object|null>, panel: object|null}>}
 */
async function runMain(opts) {
  const launchEnabled = opts.launch !== false;
  const preferredPort = opts.port !== undefined ? opts.port : 9222;
  const userDataDir = opts.userDataDir || defaultUserDataDir();
  const scanPorts = opts.scanPorts || targets.DEFAULT_SCAN_PORTS;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};
  const injectionSource = typeof opts.injectionSource === 'string' ? opts.injectionSource : '';
  const probeExpression = typeof opts.probeExpression === 'string' ? opts.probeExpression : '';
  const enablePanel = opts.panel === true;
  const panelStaticDir = opts.panelStaticDir || path.join(__dirname, 'panel');
  const store = opts.store || null;

  let child = null;
  let session = null;
  let killOnExit = null;
  let stopped = false;
  let chosenPort = null;
  let panel = null;

  function emit(state) { onState(Object.assign({ port: chosenPort }, state)); }

  async function attachAndInject(webSocketDebuggerUrl) {
    session = await bridge.attachTarget({ url: webSocketDebuggerUrl, WebSocketCtor: opts.WebSocketCtor });
    emit({ phase: 'attached' });
    // Chrome 136+ requirement: Page/Runtime must be enabled BEFORE
    // addScriptToEvaluateOnNewDocument, or the script never runs on new
    // documents (verified live on Chrome 151).
    await bridge.enablePageDomains(session);
    if (injectionSource) {
      await bridge.injectOnNewDocument(session, injectionSource);
      emit({ phase: 'injected' });
      if (probeExpression) {
        await bridge.waitForSurface(session, probeExpression);
      }
    }
    return session;
  }

  /** Start the control-panel server (slice 3, REQ-05/08): 127.0.0.1 only,
   *  serves the panel shell and the gate/config/snapshot API. */
  async function startPanel() {
    if (!enablePanel || !session || !store) return null;
    const applyConfig = (config) => bridge.evaluate(
      session,
      'window.__mbAgent && window.__mbAgent.applyConfig(' + JSON.stringify(config) + ')',
    );
    panel = await panelServer.createPanelServer({
      staticDir: panelStaticDir,
      identity: () => bridge.getPlayerIdentity(session),
      applyConfig,
      // REQ-25: offer decisions reach the in-page learning module via RPC
      // (decline = session-silent; confirm goes through the config push path).
      respondOffer: (action, word) => bridge.evaluate(
        session,
        'window.__mbAgent && window.__mbAgent.respondOffer(' + JSON.stringify(action) + ',' + JSON.stringify(word) + ')',
      ),
      snapshot: () => bridge.evaluate(session, SNAPSHOT_EXPRESSION),
      store,
    });
    emit({ phase: 'panel-ready', url: panel.url });
    return panel;
  }

  /* ---- PRIMARY: launch own dedicated instance (REQ-01/03) ---- */
  if (launchEnabled) {
    emit({ phase: 'launching' });
    try {
      const startPort = launch.validateDebugPort(preferredPort) !== null ? preferredPort : 9222;
      chosenPort = await findFreePort(startPort, { fetchImpl });
      if (chosenPort === null) throw new Error('no free debug port found starting at ' + startPort);
      const execPath = opts.execPath || launch.resolveChromePath(null);
      if (!execPath) throw new Error('no Chrome executable found at known locations');
      const spawned = launch.spawnChrome({ execPath, port: chosenPort, userDataDir, spawnImpl: opts.spawnImpl });
      child = spawned;
      killOnExit = launch.registerKillOnExit(spawned.proc, { term: () => spawned.kill() });
      await waitForEndpoint(chosenPort, { fetchImpl, timeoutMs: opts.waitForEndpointMs });
      emit({ phase: 'endpoint-ready' });

      // Find OUR game window in the launched instance.
      const listUrl = targets.buildScanUrl(chosenPort);
      const listRes = await fetchImpl(listUrl);
      const body = typeof listRes.json === 'function' ? await listRes.json() : listRes;
      const found = targets.filterTargets(body);
      if (found.length === 0) throw new Error('launched Chrome shows no minibia.com page target');
      await attachAndInject(found[0].webSocketDebuggerUrl);
      await startPanel();
      return { child, session, port: chosenPort, stop, identity, panel };
    } catch (err) {
      emit({ phase: 'launch-failed', error: (err && err.message) || String(err) });
      // Fall through to the secondary scan (REQ-01 actionable picker).
    }
  }

  /* ---- SECONDARY: scan 9222-9224 and attach (REQ-01) ---- */
  emit({ phase: 'scanning' });
  const { targets: found, errors } = await targets.scanPorts(scanPorts, { fetchImpl });
  if (found.length > 0) {
    emit({ phase: 'targets-found', targets: found });
    try {
      await attachAndInject(found[0].webSocketDebuggerUrl);
      await startPanel();
      return { child, session, port: null, stop, identity, panel }; // ws url carries the port in scan mode
    } catch (err) {
      emit({ phase: 'attach-failed', error: (err && err.message) || String(err) });
    }
  }
  const picker = targets.describePickerResult({ targets: found, errors, ports: scanPorts });
  emit({ phase: 'no-target', message: picker.message });
  return { child: null, session: null, port: null, stop, identity, panel };

  /* ---- cleanup (REQ-03 kill-on-quit + explicit stop) ---- */
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (killOnExit) killOnExit.unregister();
    if (panel) { try { await panel.close(); } catch (e) { /* best-effort */ } }
    if (session) { try { session.close(); } catch (e) { /* best-effort */ } }
    if (child) await launch.killChrome(child.proc, { isAlive: (p) => { try { process.kill(p.pid, 0); return true; } catch (e) { return false; } } });
  }

  /** Interconnection contract (REQ-02 prep): reads name + vocation in page. */
  async function identity() {
    if (!session) return null;
    return bridge.getPlayerIdentity(session);
  }
}

module.exports = {
  buildVersionUrl,
  defaultUserDataDir,
  findFreePort,
  waitForEndpoint,
  runMain,
};
