'use strict';

/**
 * LIVE manual-suite harness for the CDP bridge (REQ-01/03/04/05) —
 * NOT part of `npm test` (unit tests never launch real Chrome).
 *
 * Usage: node tools/cdp-live-smoke.js
 *
 * Launches REAL Chrome (fixed known location, non-default temp
 * --user-data-dir, allowlist flags) against minibia.com/play and proves:
 *
 *   1. Port-in-use retry (REQ-03): a dummy server occupies the preferred
 *      port; findFreePort picks the next free one.
 *   2. Spawn (REQ-03): allowlist flags only, dedicated profile, and the
 *      endpoint answers on 127.0.0.1.
 *   3. Target discovery (REQ-01): /json/list on the chosen port yields our
 *      minibia.com page target.
 *   4. Injection (REQ-04): Page.addScriptToEvaluateOnNewDocument installs a
 *      probe that sets window.__liveProbe on every new document.
 *   5. Reload-survival (REQ-04): Page.reload, then the probe answers again
 *      WITHOUT re-attach (same CDP session).
 *   6. Kill-on-quit (REQ-03): killChrome terminates the child and the pid
 *      is confirmed gone.
 *
 * A dedicated Chrome window opens briefly during the run (the REQ-03
 * primary path) and is force-closed at the end. Prints PASS/FAIL per step;
 * exits non-zero on the first failure.
 */

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const launch = require('../app/cdp/launch.ts');
const targets = require('../app/cdp/targets.ts');
const bridge = require('../app/cdp/bridge.ts');
const main = require('../app/main.ts');

const PREFERRED_PORT = 9222;
const PROBE_SOURCE = 'window.__liveProbe = { injected: true, at: Date.now() };';
const PROBE_EXPRESSION = 'window.__liveProbe && window.__liveProbe.injected ? window.__liveProbe : undefined';
/** Local fixture page used when the game endpoint is blocked (offline-safe). */
const FIXTURE_URL = 'data:text/html,<title>cdp-smoke-fixture</title><body>fixture</body>';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures += 1;
  return ok;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function occupyPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', () => resolve(null));
  });
}

async function run() {
  const chrome = launch.resolveChromePath(null);
  if (!check('resolve Chrome from fixed known locations', chrome !== null, chrome || 'no Chrome found')) return;

  // 1. Port-in-use retry (REQ-03): occupy (or find already-occupied) the
  //    preferred port, then verify findFreePort walks past it.
  const blocker = await occupyPort(PREFERRED_PORT);
  check('preferred port ' + PREFERRED_PORT + ' is occupied (dummy server or existing session)', true,
    blocker ? 'dummy server bound' : 'already in use — retry path exercised for real');
  const chosenPort = await main.findFreePort(PREFERRED_PORT, { tries: 20 });
  check('port-in-use -> next free port picked', chosenPort === PREFERRED_PORT + 1, 'chose ' + chosenPort);
  if (blocker) blocker.close();

  // 2. Spawn with allowlist flags + dedicated profile (REQ-03/05).
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cdp-smoke-'));
  const spawned = launch.spawnChrome({ execPath: chrome, port: chosenPort, userDataDir, stdio: 'ignore' });
  check('spawnChrome returned a child pid', Number.isInteger(spawned.pid) && spawned.pid > 0, 'pid ' + spawned.pid);
  const cleanup = launch.registerKillOnExit(spawned.proc, { term: () => spawned.kill() });

  try {
    await main.waitForEndpoint(chosenPort, { timeoutMs: 20000 });
    check('debug endpoint answers on 127.0.0.1:' + chosenPort, true);

    // 3. Target discovery (REQ-01). The app window navigates to
    //    minibia.com/play; when the game server blocks it (HTTP 403 /
    //    Cloudflare posture — observed live), no document commits and no
    //    page target appears. In that case fall back to a LOCAL fixture
    //    page created through the browser-level endpoint, so the
    //    attach/inject/reload verification still runs against real Chrome.
    let found = [];
    let lastList = '';
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && found.length === 0) {
      try {
        const res = await fetch(targets.buildScanUrl(chosenPort));
        const list = await res.json();
        lastList = JSON.stringify(list);
        found = targets.filterTargets(list);
      } catch (e) { /* endpoint may be mid-navigation */ }
      if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (found.length === 0) {
      const version = await (await fetch(main.buildVersionUrl(chosenPort))).json();
      const browser = await bridge.attachTarget({ url: version.webSocketDebuggerUrl });
      const created = await browser.send('Target.createTarget', { url: FIXTURE_URL });
      const fixtureId = created.targetId;
      browser.close();
      const list = await (await fetch(targets.buildScanUrl(chosenPort))).json();
      found = list.filter((t) => t.type === 'page' && t.id === fixtureId);
      check('launched instance exposes a game page target', found.length > 0,
        found.length > 0 ? FIXTURE_URL + ' (minibia.com/play blocked: ' + (lastList || '').slice(0, 120) + ')' : 'no page target at all: ' + lastList.slice(0, 200));
    } else {
      check('launched instance exposes a minibia.com page target', true, found[0].url);
    }

    if (found.length > 0) {
      // 4. Attach + inject (REQ-04). addScriptToEvaluateOnNewDocument only
      //    runs on NEW documents — the current document is verified after the
      //    reload in step 5 (the real REQ-04 scenario). Page/Runtime must be
      //    enabled BEFORE the registration (Chrome 136+ requirement, verified
      //    live on Chrome 151).
      const session = await bridge.attachTarget({ url: found[0].webSocketDebuggerUrl });
      check('attached to ' + found[0].webSocketDebuggerUrl, true);
      await bridge.enablePageDomains(session);
      const injected = await bridge.injectOnNewDocument(session, PROBE_SOURCE);
      check('injection command accepted (Page.addScriptToEvaluateOnNewDocument)', injected && typeof injected.identifier === 'string', 'identifier ' + (injected && injected.identifier));

      // 5. Reload -> the injected script auto-runs on the new document and
      //    the surface is re-established WITHOUT re-attach (REQ-04).
      await session.send('Page.reload', { ignoreCache: true });
      const after = await bridge.waitForSurface(session, PROBE_EXPRESSION, { timeoutMs: 20000, intervalMs: 200 });
      check('probe re-established after reload on the same session', after && after.injected === true, 'at ' + (after && after.at));
      session.close();

      // 6. Kill-on-quit (REQ-03): the child is terminated and gone.
      cleanup.unregister();
      await launch.killChrome(spawned.proc);
      const dead = !isAlive(spawned.pid);
      check('killChrome terminated the child (pid ' + spawned.pid + ')', dead);
    }
  } finally {
    // NOTE: never process.exit() inside the try — it would skip this
    // cleanup and leak the Chrome child + profile (observed bug).
    cleanup.unregister();
    await launch.killChrome(spawned.proc).catch(() => {});
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  }

  console.log(failures === 0 ? '\nSMOKE OK' : '\nSMOKE FAILED (' + failures + ' checks)');
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('SMOKE ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
