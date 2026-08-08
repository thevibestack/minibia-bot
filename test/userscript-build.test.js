'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildUserscript, MODULES } = require('../tools/build-userscript');

const ROOT = path.join(__dirname, '..');
const COMMITTED = fs.readFileSync(path.join(ROOT, 'minibia-rotation-bot.user.js'), 'utf8');
const BUILT = buildUserscript();

test('4.3: committed userscript equals the current build (drift guard)', () => {
  assert.equal(
    BUILT,
    COMMITTED,
    'minibia-rotation-bot.user.js drifted from src/ — run `node tools/build-userscript.js` and commit the result',
  );
});

test('4.3: build is deterministic', () => {
  assert.equal(buildUserscript(), BUILT);
});

test('4.3: Tampermonkey metadata block is present and correct', () => {
  assert.match(BUILT, /@name\s+Minibia Rotation Bot/);
  assert.match(BUILT, /@match\s+https:\/\/minibia\.com\//);
  assert.match(BUILT, /@grant\s+none/);
  assert.match(BUILT, /@run-at\s+document-idle/);
  assert.match(BUILT, /@version\s+0\.1\.0/);
  assert.match(BUILT, /==UserScript==/);
});

test('5.3: usage header covers install, one-time extraction, configure, start and reset semantics', () => {
  assert.match(BUILT, /USAGE \(task 5\.3\)/);
  assert.match(BUILT, /INSTALL/);
  assert.match(BUILT, /RUN THE CATALOG EXTRACTION ONCE/);
  assert.match(BUILT, /CONFIGURE/);
  assert.match(BUILT, /START/);
  assert.match(BUILT, /clears every mb-\* key/);
  assert.match(BUILT, /Reset is destructive/);
});

test('4.3: every src module is embedded in the registry in dependency order', () => {
  for (const [regName] of MODULES) {
    assert.ok(
      BUILT.includes(`__mbModules['${regName}'] = (function () {`),
      `missing bundled module ${regName}`,
    );
  }
  assert.ok(
    BUILT.indexOf("__mbModules['core/jitter']") < BUILT.indexOf("__mbModules['core/config']"),
    'dependencies must precede dependents',
  );
  assert.ok(
    BUILT.indexOf("__mbModules['core/config']") < BUILT.indexOf("__mbModules['adapters/ui']"),
    'core must precede adapters',
  );
});

test('4.3: bundle is self-contained (no node/core module requires, no fetch of module files)', () => {
  assert.doesNotMatch(BUILT, /require\(\s*['"](node:|fs|path|node:test)/);
  assert.match(BUILT, /__mbRequire\('core\/config'\)/);
  assert.doesNotMatch(BUILT, /require\(\s*'\.\//, 'relative requires rewritten to registry keys');
});

test('4.3: bootstrap wiring markers are present', () => {
  assert.match(BUILT, /createPersist/);
  assert.match(BUILT, /await PERSIST_MOD\.createPersist/);
  assert.match(BUILT, /window\.__minibiaBot/);
  assert.match(BUILT, /visibilitychange/);
  assert.match(BUILT, /degrading to page timer \(REQ-04\)/);
  assert.match(BUILT, /__handleClick/);
});
