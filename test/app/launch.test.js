'use strict';

/**
 * RED safety tests for the CDP bridge launch module (tasks 1.1-1.3).
 *
 * Threat-matrix row "Subprocess/process integration" (design threat matrix):
 *   (a) port validation — only numeric ports in 1024..65535 reach a spawn
 *       argument or a scan URL; every URL is 127.0.0.1 only (REQ-05).
 *   (b) flag allowlist — only the approved fixed flags (with validated
 *       values) may reach the spawned Chrome; any unknown flag string is
 *       rejected before spawn (no injection vector).
 *   (c) kill-on-quit — when the app exits, the child Chrome it spawned is
 *       terminated (REQ-03 "GIVEN app shutdown").
 *
 * Written RED-first: this file failed before `app/cdp/launch.ts` existed
 * (module not found); it must be green with the implementation.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const LAUNCH_PATH = path.join(__dirname, '..', '..', 'app', 'cdp', 'launch.ts');
const launch = require(LAUNCH_PATH);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True while the given pid is a live process (SIGTERM-free probe). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/** A fake Chrome: a long-running node process (never spawns real Chrome in unit tests). */
function spawnFakeChrome(opts = {}) {
  const src = opts.ignoreSigterm
    ? 'process.on("SIGTERM", function () {}); setInterval(function () {}, 1000);'
    : 'setInterval(function () {}, 1000);';
  return spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
}

/* =========================================================================
 * Task 1.1 (RED row a): port validation
 * ========================================================================= */

test('RED 1.1: validateDebugPort accepts only integer ports in 1024..65535', () => {
  const ok = [1024, 9222, 65535, '9222', '65535', '1024'];
  for (const value of ok) {
    assert.strictEqual(launch.validateDebugPort(value), Number(value), `expected ${JSON.stringify(value)} to validate`);
  }
});

test('RED 1.1: validateDebugPort rejects non-numeric and out-of-range ports', () => {
  const bad = [
    null, undefined, NaN, Infinity, -Infinity,
    'abc', '', ' 9222', '9222 ', '9222.5', '-9222', '0x9222', '1e3',
    9222.5, 1023, 1024.5, 0, -1, 80, 65536, 99999,
    {}, [], true, false, ['9222'],
  ];
  for (const value of bad) {
    assert.strictEqual(launch.validateDebugPort(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('RED 1.1: buildChromeArgs refuses an invalid port (never reaches spawn)', () => {
  assert.throws(() => launch.buildChromeArgs({ port: 'abc', userDataDir: '/tmp/mb' }), RangeError);
  assert.throws(() => launch.buildChromeArgs({ port: 80, userDataDir: '/tmp/mb' }), RangeError);
  assert.throws(() => launch.buildChromeArgs({ port: 65536, userDataDir: '/tmp/mb' }), RangeError);
});

/* =========================================================================
 * Task 1.2 (RED row b): flag allowlist
 * ========================================================================= */

test('RED 1.2: buildChromeArgs emits exactly the approved flags', () => {
  const args = launch.buildChromeArgs({ port: 9222, userDataDir: '/tmp/mb-profile' });
  assert.deepStrictEqual(args, [
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/mb-profile',
    '--app=https://minibia.com/play',
    '--remote-allow-origins=*',
  ]);
  // Every emitted flag is allowed by the allowlist (self-consistency).
  assert.doesNotThrow(() => launch.assertFlagsAllowed(args));
});

test('RED 1.2: assertFlagsAllowed rejects every unknown flag string', () => {
  const badArgs = [
    '--headless',
    '--disable-web-security',
    '--load-extension=/tmp/evil',
    '--no-sandbox',
    '--remote-debugging-pipe',
    '--remote-debugging-port=',           // empty value
    '--remote-debugging-port=abc',        // non-numeric value
    '--remote-debugging-port=80',         // out-of-range value
    '--remote-debugging-port=9222 --headless', // smuggled second flag (port value must be numeric)
    '--user-data-dir=',                   // empty value
    '--app=',                             // empty URL
    '--app=https://evil.example/play',    // non-approved URL
    '--remote-allow-origins=https://evil.example', // non-approved origin value
    '--remote-allow-origins=',
    'https://minibia.com/play',           // positional URL — not an approved flag form
    '-app=https://minibia.com/play',      // wrong dashes
    '--APP=https://minibia.com/play',     // wrong case
  ];
  // NOTE: a space-containing --user-data-dir value is NOT a smuggling vector:
  // child_process.spawn passes argv verbatim (no shell), and the app-owned
  // profile dir (e.g. "~/Library/Application Support/minibia-desktop-bot")
  // legitimately contains a space. Port values are strictly numeric, so the
  // '--remote-debugging-port=9222 --headless' case above IS rejected.
  for (const arg of badArgs) {
    assert.throws(() => launch.assertFlagsAllowed([arg]), TypeError, `expected ${JSON.stringify(arg)} to be rejected`);
  }
});

test('RED 1.2: assertFlagsAllowed rejects an unknown flag inside a mixed list', () => {
  const mixed = launch.buildChromeArgs({ port: 9222, userDataDir: '/tmp/mb' }).concat(['--headless']);
  assert.throws(() => launch.assertFlagsAllowed(mixed), TypeError);
});

test('RED 1.2: spawnChrome rejects unapproved flags before any process is spawned', async () => {
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; return { pid: 1, kill() {} }; };
  assert.throws(() => launch.spawnChrome({
    execPath: process.execPath,
    port: 9222,
    userDataDir: '/tmp/mb',
    args: ['--headless'],
    spawnImpl,
  }), TypeError);
  assert.strictEqual(spawned, 0, 'spawn must never run with unapproved flags');
});

/* =========================================================================
 * Task 1.3 (RED row c): kill-on-quit
 * ========================================================================= */

/**
 * Shared scaffold for the kill-on-quit wrapper scenarios. Spawns a wrapper
 * subprocess that behaves like the app (spawns a fake Chrome, registers
 * kill-on-quit, then exits itself or is signalled), and guarantees in a
 * finally block that the wrapper AND its fake child are SIGKILLed — a
 * leaked child handle would keep the test worker alive and hang the whole
 * runner (observed flake).
 */
async function runKillOnQuitScenario(wrapperSrc, { exitVia }) {
  const child = spawn(process.execPath, ['-e', wrapperSrc], { stdio: ['ignore', 'pipe', 'inherit'] });
  let pid = null;
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  const killAll = () => {
    try { if (pid !== null) process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
  };
  try {
    // Wait until the wrapper reports the grandchild pid (bounded).
    for (let i = 0; i < 60 && pid === null; i += 1) {
      const m = out.match(/CHILD_PID=(\d+)/);
      if (m) pid = Number(m[1]);
      else await sleep(25);
    }
    assert.ok(pid !== null && isAlive(pid), 'wrapper must report a live child pid');

    if (exitVia === 'signal') child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    if (exitVia === 'signal') {
      assert.strictEqual(code, 143, 'app exits with 128+SIGTERM(15)');
    } else {
      assert.strictEqual(code, 0, 'wrapper should exit cleanly');
    }

    for (let i = 0; i < 60 && isAlive(pid); i += 1) await sleep(50);
    assert.ok(!isAlive(pid), 'child must be dead after the app exited (kill-on-quit)');
  } finally {
    killAll();
  }
}

test('RED 1.3: killChrome escalates SIGTERM to SIGKILL when the child ignores SIGTERM', async () => {
  const fake = spawnFakeChrome({ ignoreSigterm: true });
  assert.ok(isAlive(fake.pid), 'fake chrome should be alive before the kill');
  try {
    await launch.killChrome(fake, { graceMs: 250 });
    assert.ok(!isAlive(fake.pid), 'child must be dead after killChrome escalates');
  } finally {
    try { fake.kill('SIGKILL'); } catch (e) { /* best-effort */ }
  }
});

test('RED 1.3: registerKillOnExit terminates the child when the app exits (process exit path)', { timeout: 15000 }, async () => {
  const wrapper = [
    "const { spawn } = require('node:child_process');",
    `const { registerKillOnExit } = require(${JSON.stringify(LAUNCH_PATH)});`,
    "const fake = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000);'], { stdio: 'ignore' });",
    "process.stdout.write('CHILD_PID=' + fake.pid + '\\n');",
    'registerKillOnExit(fake);',
    'setTimeout(function () { process.exit(0); }, 300);', // app quits
  ].join('\n');
  await runKillOnQuitScenario(wrapper, { exitVia: 'exit' });
});

test('RED 1.3: registerKillOnExit terminates the child on SIGTERM to the app', { timeout: 15000 }, async () => {
  const wrapper = [
    "const { spawn } = require('node:child_process');",
    `const { registerKillOnExit } = require(${JSON.stringify(LAUNCH_PATH)});`,
    "const fake = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000);'], { stdio: 'ignore' });",
    "process.stdout.write('CHILD_PID=' + fake.pid + '\\n');",
    'registerKillOnExit(fake, { graceMs: 400 });',
    'setInterval(function () {}, 1000);', // stay alive until signalled
  ].join('\n');
  await runKillOnQuitScenario(wrapper, { exitVia: 'signal' });
});

test('RED 1.3: registerKillOnExit SIGKILL-escalates when the child ignores SIGTERM', { timeout: 15000 }, async () => {
  const wrapper = [
    "const { spawn } = require('node:child_process');",
    `const { registerKillOnExit } = require(${JSON.stringify(LAUNCH_PATH)});`,
    "const fake = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", function () {}); setInterval(function () {}, 1000);'], { stdio: 'ignore' });",
    "process.stdout.write('CHILD_PID=' + fake.pid + '\\n');",
    'registerKillOnExit(fake, { graceMs: 400 });',
    'setInterval(function () {}, 1000);', // stay alive until signalled
  ].join('\n');
  await runKillOnQuitScenario(wrapper, { exitVia: 'signal' });
});
