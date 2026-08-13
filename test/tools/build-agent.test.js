'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildAgent, AGENT_MODULES, wrapAgentModule } = require('../../tools/build-agent');

const ROOT = path.join(__dirname, '..', '..');
const COMMITTED = fs.readFileSync(path.join(ROOT, 'minibia-desktop-agent.js'), 'utf8');
const BUILT = buildAgent();

test('2.4: committed agent bundle equals the current build (drift guard)', () => {
  assert.equal(
    BUILT,
    COMMITTED,
    'minibia-desktop-agent.js drifted from src/ — run `node tools/build-agent.js` and commit the result',
  );
});

test('2.4: build is deterministic', () => {
  assert.equal(buildAgent(), BUILT);
});

test('2.4: every agent module is embedded in the registry in dependency order', () => {
  for (const [regName] of AGENT_MODULES) {
    assert.ok(
      BUILT.includes(`__mbModules['${regName}'] = (function () {`),
      `missing bundled module ${regName}`,
    );
  }
  assert.ok(
    BUILT.indexOf("__mbModules['core/jitter']") < BUILT.indexOf("__mbModules['core/tree']"),
    'jitter must precede tree (queue requires it)',
  );
  assert.ok(
    BUILT.indexOf("__mbModules['core/tree']") < BUILT.indexOf("__mbModules['agent/bootstrap']"),
    'core must precede the bootstrap wiring',
  );
  assert.ok(
    BUILT.indexOf("__mbModules['adapters/gameClient']") < BUILT.indexOf("__mbModules['agent/bootstrap']"),
    'adapters must precede the bootstrap wiring',
  );
});

test('live contract: manifest includes canonical contracts and mana-items before their consumers', () => {
  const names = AGENT_MODULES.map(([name]) => name);
  for (const required of ['core/live-contract', 'core/runtime-status', 'agent/modules/mana-items']) {
    assert.notEqual(names.indexOf(required), -1, required + ' must be declared in AGENT_MODULES');
    assert.match(BUILT, new RegExp("__mbModules\\['" + required.replace('/', '\\/') + "'\\]"),
      required + ' must be present in the read-only generated output');
  }
  assert.ok(names.indexOf('core/live-contract') < names.indexOf('adapters/gameClient'),
    'live-contract must load before the game client adapter');
  assert.ok(names.indexOf('agent/modules/mana-items') < names.indexOf('agent/bootstrap'),
    'mana-items must load before bootstrap requires it');
});

test('2.4: hud/ui/persist are NOT bundled (design D2 — clean page, no overlay)', () => {
  assert.doesNotMatch(BUILT, /__mbModules\['adapters\/hud'\]/);
  assert.doesNotMatch(BUILT, /__mbModules\['adapters\/ui'\]/);
  assert.doesNotMatch(BUILT, /__mbModules\['adapters\/persist'\]/);
  assert.doesNotMatch(BUILT, /createUi/);
  assert.doesNotMatch(BUILT, /createHud/);
  assert.doesNotMatch(BUILT, /createPersist/);
});

test('2.4: bundle is self-contained (no node/core module requires, no relative requires)', () => {
  assert.doesNotMatch(BUILT, /require\(\s*['"](node:|fs|path|node:test)/);
  assert.match(BUILT, /__mbRequire\('agent\/bootstrap'\)/);
  assert.doesNotMatch(BUILT, /require\(\s*'\.\.\//, 'parent-relative requires rewritten to registry keys');
  assert.doesNotMatch(BUILT, /require\(\s*'\.\//, 'relative requires rewritten to registry keys');
});

test('2.4: REQ-04 surface boot epilogue is present', () => {
  assert.match(BUILT, /window\.__mbAgent = handle\.surface/);
  assert.match(BUILT, /window\.__mbAgentHandle = handle/);
  assert.match(BUILT, /__mbAgent boot failed/);
  assert.match(BUILT, /Page\.addScriptToEvaluateOnNewDocument/);
});

test('2.4: wrapAgentModule maps ../core and ../adapters requires to registry keys', () => {
  const src = [
    "const t = require('../core/tree');",
    "const g = require('../adapters/gameClient');",
    "const l = require('./local');",
  ].join('\n');
  const out = wrapAgentModule('agent/bootstrap', src);
  assert.match(out, /require\('core\/tree'\)/);
  assert.match(out, /require\('adapters\/gameClient'\)/);
  assert.match(out, /require\('agent\/local'\)/);
  assert.doesNotMatch(out, /\.\.\//);
});
