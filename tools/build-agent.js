'use strict';

/**
 * Agent bundle builder (task 2.4, design D2) — the desktop-bot counterpart
 * of tools/build-userscript.js.
 *
 * Assembles `minibia-desktop-agent.js`: the in-page agent bundle injected via
 * Page.addScriptToEvaluateOnNewDocument (REQ-04). It reuses the userscript
 * builder's registry mechanism (wrapModule from build-userscript.js) — the
 * module list differs (8 core + tree + queue + 5 agent-bound adapters +
 * bootstrap; hud/ui/persist deliberately NOT bundled, design D2) and the
 * bootstrap is wrapped with an extended rewrite that also maps `../core/x`
 * and `../adapters/x` relative requires (src/agent/ lives one level deeper
 * than the registry dirs).
 *
 * Single source of truth: the committed bundle is GENERATED from `src/**` by
 * this tool. `node tools/build-agent.js` regenerates it; `--check` fails when
 * the committed file drifted from the build (asserted by
 * test/tools/build-agent.test.js, so `npm test` guards it).
 *
 * Bundle shape (identical registry pattern to the userscript):
 *   __mbModules['core/jitter'] = (function () {...})();
 *   ...
 *   __mbModules['agent/bootstrap'] = (function () {...})();
 *   (function () { window.__mbAgent = __mbRequire('agent/bootstrap').createAgent(...); })();
 */

const fs = require('node:fs');
const path = require('node:path');
const { wrapModule } = require('./build-userscript');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'minibia-desktop-agent.js');

/**
 * Registry name -> source path. Order matters for the registry (deps first).
 * The 8 pre-existing core modules + the 5 agent-bound adapters are the design
 * D2 set; core/tree + core/queue are the NEW engine modules this slice adds
 * (REQ-10/11/12); core/items + the 5 slice-4 modules (REQ-13..17) extend the
 * registry; core/premium + core/kills + the 7 slice-5 modules (REQ-18..22,24,
 * 25) extend it further; agent/bootstrap is the wiring (REQ-04).
 */
const AGENT_MODULES = [
  ['core/jitter', 'src/core/jitter.js'],
  ['core/config', 'src/core/config.js'],
  ['core/feasibility', 'src/core/feasibility.js'],
  ['core/cooldown', 'src/core/cooldown.js'],
  ['core/rotation', 'src/core/rotation.js'],
  ['core/sated', 'src/core/sated.js'],
  ['core/validation', 'src/core/validation.js'],
  ['core/dedupe', 'src/core/dedupe.js'],
  ['core/tree', 'src/core/tree.js'],
  ['core/queue', 'src/core/queue.js'],
  ['core/items', 'src/core/items.js'],
  ['core/premium', 'src/core/premium.js'],
  ['core/kills', 'src/core/kills.js'],
  ['adapters/gameClient', 'src/adapters/gameClient.js'],
  ['adapters/firing', 'src/adapters/firing.js'],
  ['adapters/eat', 'src/adapters/eat.js'],
  ['adapters/chat', 'src/adapters/chat.js'],
  ['adapters/catalog', 'src/adapters/catalog.js'],
  ['agent/modules/heal-items', 'src/agent/modules/heal-items.js'],
  ['agent/modules/heal-magic', 'src/agent/modules/heal-magic.js'],
  ['agent/modules/runes', 'src/agent/modules/runes.js'],
  ['agent/modules/training', 'src/agent/modules/training.js'],
  ['agent/modules/eat', 'src/agent/modules/eat.js'],
  ['agent/modules/trade', 'src/agent/modules/trade.js'],
  ['agent/modules/loot', 'src/agent/modules/loot.js'],
  ['agent/modules/spawns', 'src/agent/modules/spawns.js'],
  ['agent/modules/huntStats', 'src/agent/modules/huntStats.js'],
  ['agent/modules/echo', 'src/agent/modules/echo.js'],
  ['agent/modules/learning', 'src/agent/modules/learning.js'],
  ['agent/modules/routes', 'src/agent/modules/routes.js'],
  ['agent/bootstrap', 'src/agent/bootstrap.js'],
];

const HEADER = `/* =========================================================================
 * minibia-desktop-agent.js — GENERATED in-page agent bundle (REQ-04/10/11/12).
 * Do NOT edit by hand: regenerate with ` + '`node tools/build-agent.js`' + `.
 *
 * Registry: __mbModules / __mbRequire (same pattern as the userscript build).
 * Boot: the epilogue calls createAgent from src/agent/bootstrap.js and
 * exposes window.__mbAgent. The app injects this file with
 * Page.addScriptToEvaluateOnNewDocument so it survives reloads (REQ-04).
 * ========================================================================= */

`;

/**
 * Wrap src/agent/* sources: the standard wrapModule rewrite covers './x'
 * requires; src/agent files require '../core/x' and '../adapters/x', and
 * src/agent/modules/* files require '../../core/x' and '../../adapters/x',
 * which wrapModule leaves untouched — post-process the wrapped output so
 * every require resolves to a registry key.
 */
function wrapAgentModule(regName, source) {
  return wrapModule(regName, source)
    .replace(/require\('\.\.\/core\//g, "require('core/")
    .replace(/require\('\.\.\/adapters\//g, "require('adapters/")
    .replace(/require\('\.\.\/\.\.\/core\//g, "require('core/")
    .replace(/require\('\.\.\/\.\.\/adapters\//g, "require('adapters/")
    .replace(/require\('\.\/modules\//g, "require('agent/modules/");
}

/** Bundle every agent module into the registry + the boot epilogue. @returns {string} */
function bundleAgent() {
  const parts = [
    '/* =====================================================================',
    ' * GENERATED BUNDLE — src modules (core + adapters + agent bootstrap).',
    ' * Regenerate with `node tools/build-agent.js`.',
    ' * ===================================================================== */',
    'const __mbModules = Object.create(null);',
    'function __mbRequire(name) {',
    "  if (!__mbModules[name]) throw new Error('mb module not found: ' + name);",
    '  return __mbModules[name];',
    '}',
  ];
  for (const [regName, file] of AGENT_MODULES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (regName.startsWith('agent/')) {
      // agent/* files (bootstrap + modules) use ../core, ../adapters and
      // ../../core / ../../adapters relative requires — rewrite them all.
      parts.push(wrapAgentModule(regName, source));
    } else {
      parts.push(wrapModule(regName, source));
    }
  }
  parts.push(`/* =========================================================================
 * AGENT AUTO-BOOT — the bootstrap module is bundled above; this epilogue
 * boots it on the real page and exposes window.__mbAgent (REQ-04). The
 * surface re-establishes after every navigation because the whole file is
 * injected via Page.addScriptToEvaluateOnNewDocument.
 * ========================================================================= */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.document === 'undefined') return;
  if (window.__mbAgent) return; // guard: never double-boot in one document
  try {
    var AGENT = __mbRequire('agent/bootstrap');
    if (typeof AGENT.createAgent !== 'function') return;
    var handle = AGENT.createAgent({ win: window, document: window.document });
    window.__mbAgent = handle.surface;      // REQ-04 RPC surface
    window.__mbAgentHandle = handle;        // full handle (tests + app control)
  } catch (err) {
    if (window.console && typeof window.console.error === 'function') {
      window.console.error('__mbAgent boot failed:', err && err.message ? err.message : err);
    }
  }
})();`);
  return parts.join('\n\n');
}

/** Assemble the full agent bundle source. @returns {string} */
function buildAgent() {
  return HEADER + bundleAgent() + '\n';
}

/** Write the agent bundle to disk. @returns {string} output path */
function run() {
  fs.writeFileSync(OUTPUT, buildAgent(), 'utf8');
  return OUTPUT;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const built = buildAgent();
    const committed = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : null;
    if (committed === built) {
      process.stdout.write('agent bundle up to date: ' + OUTPUT + '\n');
    } else {
      process.stderr.write('DRIFT: ' + OUTPUT + ' differs from the build. Run `node tools/build-agent.js` and commit the result.\n');
      process.exit(1);
    }
  } else {
    process.stdout.write('wrote ' + run() + '\n');
  }
}

module.exports = { buildAgent, run, AGENT_MODULES, wrapAgentModule };
