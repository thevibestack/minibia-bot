'use strict';

/**
 * build-app tool tests (task 6.3, REQ-07): the NON-Bun parts are pure and
 * node-testable — target matrix, output naming, asset list, exact plan
 * commands, bun detection (injectable env/home), missing-Bun failure with
 * a clear instruction, artifact assertions, and dry-run (plan without
 * invoking Bun). The REAL packaging is a live acceptance step
 * (`node tools/build-app.js` — verified separately, not in npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildApp = require('../../tools/build-app');

const ROOT = path.join(__dirname, '..', '..');

test('6.3: REQ-07 target matrix — darwin-arm64 + windows-x64 with correct naming', () => {
  assert.equal(buildApp.TARGETS.length, 2);
  assert.deepEqual(buildApp.TARGETS.map((t) => t.target), ['bun-darwin-arm64', 'bun-windows-x64']);
  assert.equal(buildApp.outfileName(buildApp.TARGETS[0]), 'minibia-desktop-darwin-arm64');
  assert.equal(buildApp.outfileName(buildApp.TARGETS[1]), 'minibia-desktop-windows-x64.exe');
  assert.equal(path.extname(buildApp.outfileName(buildApp.TARGETS[1])), '.exe');
});

test('6.3: bundled assets exist on disk (REQ-07 committed build inputs)', () => {
  for (const p of buildApp.assetPaths(ROOT)) {
    assert.ok(fs.existsSync(p), 'missing bundled asset ' + p);
    assert.ok(fs.statSync(p).size > 0, 'empty asset ' + p);
  }
  assert.deepEqual(buildApp.ASSETS, ['app/assets/catalog.json', 'app/assets/npcTrades.json']);
});

test('6.3: planBuilds emits the exact bun build --compile commands', () => {
  const plan = buildApp.planBuilds({ distDir: '/out', entry: 'app/entry-compiled.js', bun: '/bin/bun' });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0].command, [
    '/bin/bun', 'build', '--compile', '--target=bun-darwin-arm64',
    '--outfile', path.join('/out', 'minibia-desktop-darwin-arm64'), 'app/entry-compiled.js',
  ]);
  assert.deepEqual(plan[1].command, [
    '/bin/bun', 'build', '--compile', '--target=bun-windows-x64',
    '--outfile', path.join('/out', 'minibia-desktop-windows-x64.exe'), 'app/entry-compiled.js',
  ]);
});

test('6.3: detectBun finds PATH, explicit env, and default ~/.bun/bin locations', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-buildapp-'));
  try {
    // A Bun executable on PATH is named `bun` — the detector scans for it.
    const fakeBun = path.join(tmp, 'bun');
    fs.writeFileSync(fakeBun, '#!/bin/sh\necho fake\n', { mode: 0o755 });
    // The default install location: ~/.bun/bin/bun.
    const homeBunDir = path.join(tmp, '.bun', 'bin');
    fs.mkdirSync(homeBunDir, { recursive: true });
    const homeBun = path.join(homeBunDir, 'bun');
    fs.writeFileSync(homeBun, '#!/bin/sh\necho fake\n', { mode: 0o755 });

    assert.equal(buildApp.detectBun({ PATH: tmp }, '/home/x'), fakeBun, 'PATH hit');
    assert.equal(buildApp.detectBun({ BUN: fakeBun, PATH: '' }, '/home/x'), fakeBun, 'explicit env wins');
    assert.equal(buildApp.detectBun({ PATH: '' }, tmp), homeBun, '~/.bun/bin default location hit');
    assert.equal(buildApp.detectBun({ PATH: '' }, '/nonexistent-home'), null, 'absent -> null');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('6.3: missing Bun FAILS with a clear install instruction (never silently skips)', () => {
  const result = buildApp.run({ env: { PATH: '' }, home: '/nonexistent-home' });
  assert.equal(result.ok, false);
  assert.match(result.message, /Bun is REQUIRED/);
  assert.match(result.message, /bun\.sh\/install|brew install/);
});

test('6.3: assertOutputs reports missing/empty artifacts with the exact names', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-buildapp-out-'));
  try {
    const a = buildApp.assertOutputs(tmp);
    assert.equal(a.ok, false);
    assert.equal(a.missing.length, 2);
    assert.ok(a.missing[0].includes('minibia-desktop-darwin-arm64'));
    assert.ok(a.missing[1].includes('minibia-desktop-windows-x64.exe'));

    // A non-executable darwin artifact is still a miss (REQ-07 binary).
    fs.writeFileSync(path.join(tmp, 'minibia-desktop-darwin-arm64'), 'x');
    fs.writeFileSync(path.join(tmp, 'minibia-desktop-windows-x64.exe'), 'x');
    const noExec = buildApp.assertOutputs(tmp);
    assert.equal(noExec.ok, false);
    assert.ok(noExec.missing[0].includes('executable bit'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('6.3: run({dryRun:true}) returns the plan WITHOUT invoking Bun', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-buildapp-dr-'));
  try {
    const fakeBun = path.join(tmp, 'bun');
    fs.writeFileSync(fakeBun, '#!/bin/sh\ntouch "SHOULD_NOT_RUN"\n', { mode: 0o755 });
    const result = buildApp.run({ dryRun: true, env: { PATH: tmp }, home: '/nonexistent-home' });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.length, 2);
    assert.equal(result.plan[0].command[0], fakeBun);
    assert.ok(!fs.existsSync(path.join(tmp, 'SHOULD_NOT_RUN')), 'dry-run never executes bun');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
