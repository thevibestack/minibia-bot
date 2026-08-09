'use strict';

/**
 * CDP bridge — Chrome launch (task 1.4, REQ-03/05).
 *
 * Spawns a DEDICATED Chrome instance for the bot:
 *   --remote-debugging-port=<validated port>
 *   --user-data-dir=<app-owned dir>            (non-default profile: Chrome 136+
 *                                              ignores debug flags on the default
 *                                              profile — explore finding 3.3)
 *   --app=https://minibia.com/play
 *   --remote-allow-origins=*
 *
 * Safety (design threat matrix — "Subprocess/process integration"):
 *   (a) ports are validated to integer 1024..65535 before they reach any
 *       spawn argument or scan URL;
 *   (b) ONLY the fixed approved flags (with validated values) may reach the
 *       spawned process — unknown flag strings are rejected before spawn;
 *   (c) the child is terminated when the app exits (kill-on-quit, REQ-03).
 *
 * Chrome paths come from fixed known locations only — never from user
 * strings. This module is erasable-syntax TypeScript (CJS): it runs natively
 * under `node --test` (Node 23.6+ type stripping) and under Bun for the
 * compiled app (design D1).
 */

const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');

/** Debug port range: privileged ports (<1024) and >65535 are rejected. */
const DEBUG_PORT_MIN = 1024;
const DEBUG_PORT_MAX = 65535;

/**
 * Validate a debug port. Accepts integers or numeric strings in
 * 1024..65535; anything else (non-numeric, fractional, out of range,
 * objects, whitespace-padded) is rejected -> null.
 * @param {unknown} value
 * @returns {number|null}
 */
function validateDebugPort(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= DEBUG_PORT_MIN && value <= DEBUG_PORT_MAX ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= DEBUG_PORT_MIN && n <= DEBUG_PORT_MAX ? n : null;
}

/**
 * The ONLY flags allowed to reach the spawned Chrome. Values are fixed by
 * the app (app URL, origin wildcard) or validated by buildChromeArgs
 * (port, user-data-dir). No other flag form is ever accepted.
 * @readonly
 */
const ALLOWED_DEBUG_FLAGS = Object.freeze([
  '--app=https://minibia.com/play',
  '--remote-allow-origins=*',
]);

/**
 * Prefixes of parameterized flags. The VALUE after '=' must still pass its
 * own validation (port via validateDebugPort, dir non-empty path).
 * @readonly
 */
const ALLOWED_FLAG_PREFIXES = Object.freeze([
  '--remote-debugging-port=',
  '--user-data-dir=',
]);

/**
 * Reject any flag that is not in the allowlist. Parameterized flags are
 * accepted only when their value is valid. Throws TypeError naming the
 * offending flag (defense in depth: also enforced inside spawnChrome).
 * @param {string[]} args
 */
function assertFlagsAllowed(args) {
  for (const arg of args) {
    if (ALLOWED_DEBUG_FLAGS.includes(arg)) continue;
    if (arg.startsWith('--remote-debugging-port=')) {
      const port = arg.slice('--remote-debugging-port='.length);
      if (validateDebugPort(port) !== null) continue;
    }
    if (arg.startsWith('--user-data-dir=')) {
      const dir = arg.slice('--user-data-dir='.length);
      if (dir.length > 0 && !dir.includes('\0')) continue;
    }
    throw new TypeError('unapproved Chrome flag: ' + JSON.stringify(arg));
  }
}

/**
 * Build the exact spawn argument list from a validated port and an
 * app-owned user-data dir. Throws RangeError/TypeError on invalid input so
 * bad values never reach child_process.spawn.
 * @param {{port: number|string, userDataDir: string}} opts
 * @returns {string[]}
 */
function buildChromeArgs({ port, userDataDir }) {
  const validated = validateDebugPort(port);
  if (validated === null) {
    throw new RangeError('debug port must be an integer in ' + DEBUG_PORT_MIN + '..' + DEBUG_PORT_MAX + ', got ' + JSON.stringify(port));
  }
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw new TypeError('userDataDir must be a non-empty string, got ' + JSON.stringify(userDataDir));
  }
  return [
    '--remote-debugging-port=' + validated,
    '--user-data-dir=' + userDataDir,
    '--app=https://minibia.com/play',
    '--remote-allow-origins=*',
  ];
}

/**
 * Fixed known Chrome/Chromium locations (macOS + Windows). Never derived
 * from user input (threat matrix: "Chrome path from fixed known locations").
 * @readonly
 */
const CHROME_CANDIDATE_PATHS = Object.freeze([
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
]);

/**
 * Resolve a Chrome executable. `explicit` is honored ONLY for tests/dev
 * overrides; production resolves from the fixed candidate list.
 * @param {string|null} [explicit]
 * @returns {string|null} first existing executable, or null
 */
function resolveChromePath(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0 && fs.existsSync(explicit)) return explicit;
  for (const candidate of CHROME_CANDIDATE_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Spawn the dedicated Chrome instance.
 *
 * @param {object} opts
 * @param {string} [opts.execPath] chrome executable (resolveChromePath when absent)
 * @param {number|string} opts.port validated debug port
 * @param {string} opts.userDataDir app-owned non-default profile dir
 * @param {string[]} [opts.args] extra args — every one MUST pass the allowlist
 * @param {Function} [opts.spawnImpl] injectable child_process.spawn (tests)
 * @param {string} [opts.stdio]
 * @returns {{proc: import('node:child_process').ChildProcess, pid: number, kill(): void}}
 */
function spawnChrome(opts) {
  const execPath = opts.execPath || resolveChromePath(null);
  if (!execPath) throw new Error('no Chrome executable found at known locations; install Chrome/Chromium or pass execPath');
  const args = buildChromeArgs({ port: opts.port, userDataDir: opts.userDataDir });
  if (Array.isArray(opts.args) && opts.args.length > 0) args.push(...opts.args);
  assertFlagsAllowed(args); // defense in depth: never spawn with unapproved flags

  const spawnImpl = opts.spawnImpl || childProcess.spawn;
  const proc = spawnImpl(execPath, args, { stdio: opts.stdio || 'ignore' });
  const kill = () => {
    try { proc.kill('SIGTERM'); } catch (e) { /* already gone */ }
  };
  return { proc, pid: proc.pid, kill };
}

/**
 * Terminate a child process: SIGTERM first, escalate to SIGKILL after
 * graceMs when it ignores SIGTERM. Resolves once the pid is gone.
 * @param {import('node:child_process').ChildProcess} proc
 * @param {{termSignal?: string, killSignal?: string, graceMs?: number, isAlive?: Function}} [opts]
 * @returns {Promise<void>}
 */
function killChrome(proc, opts = {}) {
  const graceMs = opts.graceMs !== undefined ? opts.graceMs : 2000;
  const isAlive = opts.isAlive || ((p) => {
    try { process.kill(p.pid, 0); return true; } catch (e) { return false; }
  });
  return new Promise((resolve) => {
    try { proc.kill(opts.termSignal || 'SIGTERM'); } catch (e) { resolve(); return; }
    const deadline = Date.now() + graceMs;
    const poll = () => {
      if (!isAlive(proc)) { resolve(); return; }
      if (Date.now() >= deadline) {
        try { proc.kill(opts.killSignal || 'SIGKILL'); } catch (e) { /* gone */ }
        resolve();
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

/**
 * Kill-on-quit (REQ-03): terminate the child when THIS process exits or
 * receives SIGINT/SIGTERM. Returns an unregister handle (tests).
 * @param {import('node:child_process').ChildProcess} proc
 * @param {{term?: Function, graceMs?: number}} [opts]
 * @returns {{unregister(): void}}
 */
function registerKillOnExit(proc, opts = {}) {
  const term = opts.term || (() => {
    try { proc.kill('SIGTERM'); } catch (e) { /* already gone */ }
  });
  const onExit = () => term();
  const onSignal = (sig) => {
    const code = sig === 'SIGINT' ? 130 : 143;
    term(); // SIGTERM now — cooperating children die immediately
    // Escalate AFTER the grace window, then leave. process.exit() before
    // the timer would terminate the app and a SIGTERM-ignoring child would
    // survive (threat row c — kill-on-quit). The 'exit' handler re-sends
    // SIGTERM at exit, which is harmless.
    const graceMs = opts.graceMs !== undefined ? opts.graceMs : 2000;
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
      process.exit(code);
    }, graceMs);
  };
  process.once('exit', onExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    unregister() {
      process.removeListener('exit', onExit);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    },
  };
}

module.exports = {
  DEBUG_PORT_MIN,
  DEBUG_PORT_MAX,
  validateDebugPort,
  ALLOWED_DEBUG_FLAGS,
  ALLOWED_FLAG_PREFIXES,
  assertFlagsAllowed,
  buildChromeArgs,
  CHROME_CANDIDATE_PATHS,
  resolveChromePath,
  spawnChrome,
  killChrome,
  registerKillOnExit,
};
