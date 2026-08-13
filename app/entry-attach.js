'use strict';

/**
 * DEV-ONLY attach entry — run the desktop agent against an ALREADY-OPEN
 * Chrome window / PWA instead of launching a dedicated Chrome instance.
 *
 * Why this file exists:
 *   app/entry-compiled.js always takes the PRIMARY path (launches its own
 *   Chrome with a dedicated profile). To attach to the user's existing
 *   window you must skip the launch and take the SECONDARY path: scan
 *   debug ports 9222..9224 (targets.DEFAULT_SCAN_PORTS) via /json/list and
 *   attach to the first minibia.com page target (app/main.ts runMain with
 *   launch:false).
 *
 * Requirement: the target Chrome window MUST have been started with the
 * remote debugging port open, e.g.:
 *
 *   open -a "Google Chrome" --args --remote-debugging-port=9222
 *
 * Then open minibia.com/play in that window (your normal profile stays,
 * no dedicated user-data-dir). Run this entry with Bun:
 *
 *   bun app/entry-attach.js
 *
 * It prints the control-panel URL (http://127.0.0.1:<port>) and keeps the
 * process alive while attached. Same injection/panel behavior as the
 * compiled entry, but never spawns Chrome.
 *
 * NOT part of the compiled binary (app/entry-compiled.js) — dev harness
 * only. Do not ship it in dist/.
 */

const fs = require('node:fs');
const path = require('node:path');
const main = require('./main.ts');
const characters = require('./store/characters.ts');

function resolveAgentBundle() {
  const candidates = [
    path.join(__dirname, '..', 'minibia-desktop-agent.js'),
    path.join(process.cwd(), 'minibia-desktop-agent.js'),
    path.join(__dirname, 'minibia-desktop-agent.js'),
  ];
  for (const candidate of candidates) {
    try {
      const source = fs.readFileSync(candidate, 'utf8');
      if (source && source.length > 0) return source;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[minibia-desktop-bot] agent bundle candidate unreadable: ' + candidate
        + ' — ' + (e && e.message ? e.message : e));
    }
  }
  throw new Error('minibia-desktop-agent.js bundle not found (build input missing)');
}

const baseDir = characters.storeBaseDir();
const store = {
  loadCharacter: ({ name }) => characters.loadCharacter({ baseDir, name }),
  saveCharacter: ({ name, config }) => characters.saveCharacter({ baseDir, name, config }),
  listCharacters: () => characters.listCharacters(baseDir),
};

const PROBE_EXPRESSION = 'window.__mbAgent && typeof window.__mbAgent.readStats === "function" ? true : false';

main.runMain({
  launch: false, // SECONDARY path only: scan 9222..9224 and attach
  panel: true,
  store,
  injectionSource: resolveAgentBundle(),
  probeExpression: PROBE_EXPRESSION,
  onState: (s) => {
    if (s.phase === 'panel-ready') {
      // eslint-disable-next-line no-console
      console.log('[minibia-desktop-bot] control panel: ' + s.url);
    }
  },
}).then((handle) => {
  if (!handle.session && !handle.panel) {
    // eslint-disable-next-line no-console
    console.error('[minibia-desktop-bot] no game target found on ports 9222-9224. '
      + 'Start Chrome with --remote-debugging-port=9222 and open minibia.com/play, then retry.');
    process.exit(1);
  }
  if (!handle.session && handle.panel) {
    // eslint-disable-next-line no-console
    console.warn('[minibia-desktop-bot] no game linked yet — open the panel and click Link first PWA.');
  }
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[minibia-desktop-bot] attach failed:', (err && err.message) || err);
  process.exit(1);
});
