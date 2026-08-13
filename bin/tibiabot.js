#!/usr/bin/env bun
'use strict';

/**
 * `tibiabot` — run the MiniTibia desktop bot from any directory.
 *
 * Thin launcher over the compiled-binary entry (app/entry-compiled.js):
 * attach-first scan for a debug-capable minibia.com PWA, dedicated Chrome
 * launch fallback, then the control panel on 127.0.0.1. The entry resolves
 * the agent bundle and store paths from its own location, so this bin works
 * regardless of the current working directory.
 *
 * Install the global command once:
 *   bun link          # in the repo root -> `tibiabot` on PATH
 */

const path = require('node:path');
const entry = path.join(__dirname, '..', 'app', 'entry-compiled.js');

try {
  require(entry);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[tibiabot] failed to start: ' + (err && err.message ? err.message : err));
  process.exit(1);
}
