'use strict';

/**
 * Compiled-binary entry (REQ-07, task 6.3) — the `bun build --compile`
 * target used by tools/build-app.js.
 *
 * Two jobs:
 *  1. ASSETS (REQ-07): imports catalog.json + npcTrades.json so Bun embeds
 *     them into the single binary, and exposes them on
 *     globalThis.__MB_BUNDLED_ASSETS — app/catalog.ts resolves offline
 *     lookups from there (fs remains the dev/tests fallback; Bun also
 *     embeds the project tree's files as a virtual FS, so the panel's
 *     static serving and the fs asset path keep working in the binary).
 *  2. BOOT: calls runMain (the app lifecycle: dedicated Chrome launch /
 *     target scan, attach+inject, control panel on 127.0.0.1) and prints
 *     the panel URL when the server is ready.
 *
 * Bun-only by design (requires ./main.ts); Node cannot execute this file —
 * the build tool (tools/build-app.js) is what invokes Bun.
 */

const main = require('./main.ts');
const catalog = require('./assets/catalog.json');
const npcTrades = require('./assets/npcTrades.json');

if (typeof globalThis !== 'undefined') {
  globalThis.__MB_BUNDLED_ASSETS = {
    'catalog.json': catalog,
    'npcTrades.json': npcTrades,
  };
}

main.runMain({
  onState: (s) => {
    if (s.phase === 'panel-ready') {
      // eslint-disable-next-line no-console
      console.log('[minibia-desktop-bot] control panel: ' + s.url);
    }
  },
}).then((handle) => {
  if (!handle.session) {
    // eslint-disable-next-line no-console
    console.error('[minibia-desktop-bot] no game target found — launch and scan both failed. '
      + 'Make sure minibia.com/play is reachable and no Cloudflare challenge is blocking the window.');
    process.exit(1);
  }
  // Keep running: the Chrome child + panel server hold the event loop.
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[minibia-desktop-bot] startup failed: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
