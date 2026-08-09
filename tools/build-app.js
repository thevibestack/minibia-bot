'use strict';

/**
 * Desktop app packaging (task 6.3, REQ-07, design D1/D9): `bun build
 * --compile` into SINGLE binaries for bun-darwin-arm64 (macOS) and
 * bun-windows-x64 (Windows), embedding the bundled assets (catalog.json,
 * npcTrades.json — REQ-07) and the panel static shell.
 *
 * Embedding mechanics (verified live on Bun 1.3.14):
 *  - JSON `require`s from the entry are inlined into the binary;
 *  - Bun embeds the project tree of the entry as a read-only virtual FS, so
 *    fs.readFileSync of app/panel/* and app/assets/* resolves from the
 *    binary (offline) — the per-character store writes to the REAL user
 *    data dir, never the embedded FS;
 *  - cross-compiling bun-windows-x64 from macOS produces a real PE32+
 *    Windows executable (verified live; smoke run is N/A on Mac).
 *
 * Bun REQUIRED to package and DETECTED, never silently skipped: when Bun
 * is missing the tool FAILS with a clear install instruction (the design
 * forbids falling back to a packaging-less run). The non-Bun parts —
 * target matrix, asset list, output naming, plan, bun detection — are
 * pure and node-testable (test/tools/build-app.test.js); `--dry-run`
 * prints the exact plan WITHOUT invoking Bun.
 *
 * Usage:
 *   node tools/build-app.js            # build both targets into dist/
 *   node tools/build-app.js --dry-run  # print the plan, run nothing
 *   node tools/build-app.js --check    # assert both artifacts exist
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

/** Compiled-binary entry (app/entry-compiled.js — boots runMain + assets). */
const ENTRY = 'app/entry-compiled.js';

/** Bundled assets (REQ-07): committed build inputs under app/assets/. */
const ASSETS = ['app/assets/catalog.json', 'app/assets/npcTrades.json'];

/**
 * Build targets (REQ-07): macOS arm64 + Windows x64 binaries.
 * Naming: no extension on darwin (executable bit), .exe on windows.
 */
const TARGETS = [
  { id: 'darwin-arm64', target: 'bun-darwin-arm64', outfile: 'minibia-desktop-darwin-arm64' },
  { id: 'windows-x64', target: 'bun-windows-x64', outfile: 'minibia-desktop-windows-x64.exe' },
];

/** Output file name for a target (pure — node-testable). */
function outfileName(target) {
  return target.outfile;
}

/** Absolute output path for a target. */
function outputPath(target, distDir = DIST_DIR) {
  return path.join(distDir, outfileName(target));
}

/** Absolute paths of every bundled asset (existence assertable). */
function assetPaths(root = ROOT) {
  return ASSETS.map((a) => path.join(root, a));
}

/**
 * Exact `bun build --compile` plan for every target (pure — node-testable).
 * @param {object} [opts]
 * @param {string} [opts.distDir=DIST_DIR]
 * @param {string} [opts.entry=ENTRY]
 * @param {string} [opts.bun='bun']
 * @returns {Array<{id: string, target: string, outfile: string, command: string[]}>}
 */
function planBuilds(opts = {}) {
  const distDir = opts.distDir || DIST_DIR;
  const entry = opts.entry || ENTRY;
  const bun = opts.bun || 'bun';
  return TARGETS.map((t) => ({
    id: t.id,
    target: t.target,
    outfile: outputPath(t, distDir),
    command: [bun, 'build', '--compile', '--target=' + t.target, '--outfile', outputPath(t, distDir), entry],
  }));
}

/**
 * Detect the Bun executable: explicit env (BUN/BUN_PATH), then PATH, then
 * the default ~/.bun/bin location. Pure — injectable env/home (tests).
 * @param {object} [env=process.env]
 * @param {string} [home=os.homedir()]
 * @returns {string|null}
 */
function detectBun(env = process.env, home = os.homedir()) {
  const explicit = env.BUN || env.BUN_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const pathEntries = String(env.PATH || '').split(path.delimiter);
  for (const dir of pathEntries) {
    if (!dir) continue;
    for (const name of ['bun', 'bun.exe']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const name of ['bun', 'bun.exe']) {
    const candidate = path.join(home, '.bun', 'bin', name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Clear failure message when Bun is absent (feature-detect, never skip). */
function missingBunMessage() {
  return 'Bun is REQUIRED to package the desktop app (REQ-07: `bun build --compile`). '
    + 'Bun was not found on this machine. Install it with:\n'
    + '  curl -fsSL https://bun.sh/install | bash\n'
    + 'or:  brew install oven-sh/bun/bun\n'
    + 'then re-run `node tools/build-app.js`.';
}

/**
 * Assert every target artifact exists, is non-empty, and (darwin) carries
 * the executable bit. Pure — node-testable.
 * @param {string} [distDir=DIST_DIR]
 * @returns {{ok: boolean, missing: string[]}}
 */
function assertOutputs(distDir = DIST_DIR) {
  const missing = [];
  for (const t of TARGETS) {
    const p = outputPath(t, distDir);
    let st = null;
    try { st = fs.statSync(p); } catch (e) { st = null; }
    if (!st || !st.isFile() || st.size === 0) {
      missing.push(t.id + ' -> ' + p);
      continue;
    }
    if (t.id === 'darwin-arm64' && (st.mode & 0o111) === 0) {
      missing.push(t.id + ' (missing executable bit) -> ' + p);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Run the packaging.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - print the plan, invoke nothing
 * @param {object} [opts.env=process.env] - injectable env (bun detection)
 * @param {string} [opts.home=os.homedir()] - injectable home (bun detection)
 * @returns {{ok: boolean, message?: string, dryRun?: boolean, bun?: string,
 *            plan?: Array<object>, results?: Array<object>, assertion?: object}}
 */
function run(opts = {}) {
  const dryRun = opts.dryRun === true;
  const bun = detectBun(opts.env || process.env, opts.home);
  if (!bun) return { ok: false, message: missingBunMessage() };
  if (dryRun) return { ok: true, dryRun: true, bun, plan: planBuilds({ bun }) };
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const results = [];
  let allOk = true;
  for (const item of planBuilds({ bun })) {
    const spawned = spawnSync(item.command[0], item.command.slice(1), { cwd: ROOT, encoding: 'utf8' });
    const ok = spawned.status === 0;
    results.push({
      id: item.id,
      ok,
      status: spawned.status,
      outfile: item.outfile,
      stderr: ok ? null : String(spawned.stderr || spawned.error || '').slice(0, 2000),
    });
    if (!ok) { allOk = false; break; }
  }
  const assertion = assertOutputs();
  return { ok: allOk && assertion.ok, results, assertion, bun };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--dry-run')) {
    const result = run({ dryRun: true });
    if (!result.ok) {
      process.stderr.write(result.message + '\n');
      process.exit(1);
    }
    process.stdout.write('Bun: ' + result.bun + '\n');
    for (const item of result.plan) {
      process.stdout.write(item.id + ' -> ' + item.outfile + '\n  $ ' + item.command.join(' ') + '\n');
    }
    process.exit(0);
  }
  if (args.includes('--check')) {
    const assertion = assertOutputs();
    if (assertion.ok) {
      process.stdout.write('build-app artifacts present: ' + TARGETS.map((t) => outfileName(t)).join(', ') + '\n');
      process.exit(0);
    }
    process.stderr.write('MISSING build-app artifacts:\n  ' + assertion.missing.join('\n  ') + '\n');
    process.exit(1);
  }
  const result = run();
  if (!result.ok) {
    if (result.message) process.stderr.write(result.message + '\n');
    if (result.results) {
      for (const r of result.results) {
        process.stderr.write((r.ok ? 'ok  ' : 'FAIL') + '  ' + r.id + (r.stderr ? '\n  ' + r.stderr : '') + '\n');
      }
    }
    process.stderr.write('assertOutputs: ' + (result.assertion ? result.assertion.missing.join('; ') : 'n/a') + '\n');
    process.exit(1);
  }
  for (const r of result.results) {
    process.stdout.write('built ' + r.id + ' -> ' + r.outfile + '\n');
  }
  process.stdout.write('build-app OK: both target artifacts asserted (REQ-07)\n');
  process.exit(0);
}

module.exports = {
  ROOT,
  DIST_DIR,
  ENTRY,
  ASSETS,
  TARGETS,
  outfileName,
  outputPath,
  assetPaths,
  planBuilds,
  detectBun,
  missingBunMessage,
  assertOutputs,
  run,
};
