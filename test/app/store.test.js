'use strict';

/**
 * Store tests (task 3.1, REQ-09): per-character JSON round-trip,
 * corruption -> defaults + warning, per-character isolation, defaults
 * pre-fill, atomic-ish writes (no temp leftovers), path safety.
 * Pure node:test against a temp dir — no Bun, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../app/store/characters.ts');

/** Fresh temp base dir per test. */
function makeBaseDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-store-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('REQ-09: missing file -> defaults (first run), no warning', (t) => {
  const base = makeBaseDir(t);
  const { config, warning } = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.equal(warning, null);
  assert.equal(config.character, 'Flamamex');
  assert.equal(config.connected, false);
  assert.equal(config.queue.minIntervalMs, 150);
  assert.deepEqual(config.jitter, { min: 50, max: 400 });
  assert.deepEqual(config.session, { startedAt: null });
  assert.deepEqual(config.routes, []);
  // All modules present and OFF (opt-in per spec); learning (REQ-25, slice 5)
  // follows the same shape — its `on` is inert (observation always runs while
  // armed), the persisted part is knownWords. antibot (D9, slice 1b) is
  // shape-only forward-compat until the OTHERS slice wires it.
  const ids = Object.keys(config.modules);
  assert.deepEqual(ids, [
    'healItems', 'manaItems', 'healMagic', 'runes', 'training', 'eat',
    'trade', 'loot', 'spawns', 'huntStats', 'routes', 'learning', 'antibot',
    'attack', 'cavebot', // PR6 (REQ-35/36): skeleton module shapes
  ]);
  for (const id of ids) assert.equal(config.modules[id].on, false, id + ' defaults off');
  // Slice-1b forward-compat defaults (D2/D3/D4/D9): reserves, strict CAP,
  // fallback spell, eat-with-magic, anti-bot replies — shapes land now,
  // behavior lands with the TRAINER/OTHERS slices.
  assert.deepEqual(config.modules.manaItems, { on: false, threshold: 50, slotCids: [] }, 'mana potion defaults');
  assert.equal(config.modules.healMagic.reserve, 0, 'heal magic reserve default');
  assert.equal(config.modules.runes.capMode, 'strict', 'strict CAP default');
  assert.equal(config.modules.runes.capFullThreshold, 1.0);
  assert.equal(config.modules.runes.fallbackSlot, null);
  assert.equal(config.modules.runes.fallbackManaPct, 0.5);
  assert.equal(config.modules.runes.reserve, 0, 'runes reserve default');
  // REQ-08 (PR 2): the legacy eat-with-magic shape is GONE from defaults —
  // the unified eat.magic replaces it (design: eat gains slot/cids/magic/
  // safetyNetMinutes; everyRunes cadence dropped).
  assert.equal(config.modules.training.eatWithMagic, undefined, 'legacy eatWithMagic key removed from defaults');
  assert.deepEqual(config.modules.eat, {
    on: false, slot: null, cids: [], everyCasts: 0,
    warningWindowSec: 60, fallbackIntervalSec: 10,
    safetyNetMinutes: 20, magic: { enabled: false, slot: null, sid: null },
  }, 'unified eat defaults (design: safetyNetMinutes 20, magic off)');
  assert.deepEqual(config.modules.training.hotkeys, { runeKey: 'F4', fallbackKey: 'F5' }, 'hotkey defaults (REQ-46)');
  assert.equal(config.modules.training.stopRuneMaking, false, 'stop rune-making default off');
  assert.equal(config.modules.training.stopBotting, false, 'stop botting default off');
  assert.deepEqual(config.modules.antibot, { on: false, replies: [] });
});

test('REQ-09: save -> load round-trip preserves the full config', (t) => {
  const base = makeBaseDir(t);
  const cfg = store.defaultConfig('Flamamex');
  cfg.connected = true;
  cfg.modules.trade = { on: true, message: 'buying blank runes', intervalMs: 180000 };
  cfg.modules.healItems = { on: true, threshold: 42, slotCids: [3174, 3582] };
  cfg.routes = [{ name: 'demo', waypoints: [] }];

  const saved = store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });
  assert.ok(fs.existsSync(saved.path));
  assert.ok(path.basename(saved.path).startsWith('Flamamex.json'), 'target file name: ' + saved.path);

  const { config, warning } = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.equal(warning, null);
  assert.deepEqual(config, cfg, 'round-trip identity');
});

test('REQ-09: atomic-ish write leaves no temp files behind', (t) => {
  const base = makeBaseDir(t);
  const cfg = store.defaultConfig('Flamamex');
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });
  const dir = store.charactersDir(base);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'temp files cleaned up by rename');
});

test('REQ-09: corrupt JSON -> defaults + warning, no crash', (t) => {
  const base = makeBaseDir(t);
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: store.defaultConfig('Flamamex') });
  fs.writeFileSync(store.characterFilePath(base, 'Flamamex'), '{not json', 'utf8');

  const { config, warning } = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.match(warning, /corrupt config for Flamamex/);
  assert.equal(config.character, 'Flamamex');
  assert.equal(config.modules.trade.on, false, 'fresh defaults after corruption');
  assert.ok(fs.existsSync(store.characterFilePath(base, 'Flamamex')), 'corrupt file preserved for inspection');
});

test('REQ-09: non-object JSON -> defaults + warning', (t) => {
  const base = makeBaseDir(t);
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: store.defaultConfig('Flamamex') });
  fs.writeFileSync(store.characterFilePath(base, 'Flamamex'), '"just a string"', 'utf8');
  const { config, warning } = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.match(warning, /not a config object/);
  assert.equal(config.character, 'Flamamex');
});

test('REQ-09: per-character isolation — one character never sees another\'s config', (t) => {
  const base = makeBaseDir(t);
  const flamamex = store.defaultConfig('Flamamex');
  flamamex.modules.healItems = { on: true, threshold: 30, slotCids: [] };
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: flamamex });

  const other = store.loadCharacter({ baseDir: base, name: 'Rooker' });
  assert.equal(other.config.modules.healItems.on, false, 'different character starts from defaults (REQ-09 per-character isolation)');
  assert.equal(other.warning, null);

  assert.deepEqual(store.listCharacters(base), ['Flamamex'], 'only saved characters listed');
});

test('REQ-09: saved config pre-fills for the confirmed character (shape drift tolerated)', (t) => {
  const base = makeBaseDir(t);
  // Simulate a config saved by an older build: missing newer module keys.
  const old = { character: 'Flamamex', modules: { trade: { on: true, message: 'WTS runes' } }, queue: { minIntervalMs: 200 } };
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: old });

  const { config } = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.equal(config.modules.trade.on, true, 'saved setting survives');
  assert.equal(config.modules.trade.intervalMs, 180000, 'missing newer keys get defaults');
  assert.equal(config.queue.minIntervalMs, 200, 'saved queue override survives');
  assert.equal(config.modules.healItems.on, false, 'missing modules get defaults');
  assert.equal(config.modules.spawns.on, false);
});

test('path safety: hostile character names cannot escape the characters dir', (t) => {
  const base = makeBaseDir(t);
  for (const hostile of ['../evil', '..\\evil', 'a/b', 'a:b', ''] ) {
    const file = store.characterFilePath(base, hostile);
    const dir = store.charactersDir(base);
    assert.ok(path.resolve(file).startsWith(path.resolve(dir) + path.sep), 'inside characters dir: ' + file);
  }
  assert.equal(store.safeCharacterFileName('../evil'), '.._evil');
  assert.equal(store.safeCharacterFileName(''), 'unnamed');

  store.saveCharacter({ baseDir: base, name: '../evil', config: store.defaultConfig('x') });
  const files = fs.readdirSync(store.charactersDir(base));
  assert.deepEqual(files, ['.._evil.json'], 'sanitized file name used');
});

test('storeBaseDir follows the design D9 conventions', () => {
  const dir = store.storeBaseDir();
  assert.ok(dir.endsWith('minibia-desktop-bot'), 'app subdir: ' + dir);
});

/* ----------------- REQ-08 legacy food migration (PR 2) ----------------- */

/** Simulate a config saved by a PRE-unification build: the legacy
 *  training.eatWithMagic shape + the old eat shape (no magic, no
 *  safetyNetMinutes). */
function legacyFoodConfig(name = 'Flamamex') {
  const cfg = store.defaultConfig(name);
  cfg.modules.training.eatWithMagic = { enabled: true, slot: 3, sid: 55, everyRunes: 1 };
  delete cfg.modules.eat.magic;
  delete cfg.modules.eat.safetyNetMinutes;
  return cfg;
}

test('REQ-08: full legacy config migrates training.eatWithMagic -> eat.magic on load (everyRunes dropped)', (t) => {
  const base = makeBaseDir(t);
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: legacyFoodConfig() });

  const { config } = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.deepEqual(config.modules.eat.magic, { enabled: true, slot: 3, sid: 55 },
    'legacy enabled/slot/sid land in the unified magic shape');
  assert.equal(config.modules.training.eatWithMagic, undefined, 'legacy key deleted');
  assert.equal(config.modules.eat.everyCasts, 0, 'everyRunes cadence NOT carried over (dropped)');
  assert.equal(config.modules.eat.safetyNetMinutes, 20, 'new default supplied after migration');
});

test('REQ-08: no legacy food config -> unified defaults, saved eat.slot/cids kept', (t) => {
  const base = makeBaseDir(t);
  const cfg = store.defaultConfig('Flamamex');
  cfg.modules.eat.slot = 5;
  cfg.modules.eat.cids = [9];
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });

  const { config } = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.deepEqual(config.modules.eat.magic, { enabled: false, slot: null, sid: null }, 'magic defaults');
  assert.equal(config.modules.eat.safetyNetMinutes, 20);
  assert.equal(config.modules.eat.slot, 5, 'saved eat.slot kept');
  assert.deepEqual(config.modules.eat.cids, [9], 'saved eat.cids kept');
  assert.equal(config.modules.training.eatWithMagic, undefined);
});

test('REQ-08: partial legacy config — present fields copied, missing fields default', (t) => {
  const base = makeBaseDir(t);
  // sid missing: copied fields land, sid defaults to null.
  const cfg = store.defaultConfig('Flamamex');
  cfg.modules.training.eatWithMagic = { enabled: true, slot: 8 };
  delete cfg.modules.eat.magic;
  delete cfg.modules.eat.safetyNetMinutes;
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg });
  assert.deepEqual(store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config.modules.eat.magic,
    { enabled: true, slot: 8, sid: null }, 'copied fields kept, missing sid defaults to null');

  // enabled flag missing: magic stays OFF (strict true-gate).
  const cfg2 = store.defaultConfig('Flamamex');
  cfg2.modules.training.eatWithMagic = { slot: 4, sid: 12 };
  delete cfg2.modules.eat.magic;
  delete cfg2.modules.eat.safetyNetMinutes;
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: cfg2 });
  assert.deepEqual(store.loadCharacter({ baseDir: base, name: 'Flamamex' }).config.modules.eat.magic,
    { enabled: false, slot: 4, sid: 12 }, 'magic disabled without an explicit enabled:true');
});

test('REQ-08: migration is idempotent — a double-run finds nothing to migrate', (t) => {
  const base = makeBaseDir(t);
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: legacyFoodConfig() });

  // Run 1: migrates + deletes the legacy key.
  const first = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.deepEqual(first.config.modules.eat.magic, { enabled: true, slot: 3, sid: 55 });
  assert.equal(first.config.modules.training.eatWithMagic, undefined);

  // The app persists the migrated config; run 2 sees no legacy key.
  store.saveCharacter({ baseDir: base, name: 'Flamamex', config: first.config });
  const second = store.loadCharacter({ baseDir: base, name: 'Flamamex' });
  assert.deepEqual(second.config.modules.eat.magic, { enabled: true, slot: 3, sid: 55 }, 'migrated values preserved');
  assert.equal(second.config.modules.training.eatWithMagic, undefined, 'no legacy key left to find on the re-run');

  // Function-level double-run on the same config object is a no-op too.
  const direct = legacyFoodConfig();
  store.migrateFoodLegacy(direct);
  const snapshot = JSON.parse(JSON.stringify(direct));
  store.migrateFoodLegacy(direct);
  assert.deepEqual(direct, snapshot, 'second migrateFoodLegacy call changes nothing');
});

test('REQ-08: mixed config — eat.magic present wins, legacy key left alone (design guard)', () => {
  const cfg = store.defaultConfig('Flamamex');
  cfg.modules.eat.magic = { enabled: true, slot: 2, sid: 99 };
  cfg.modules.training.eatWithMagic = { enabled: true, slot: 3, sid: 55, everyRunes: 1 };
  store.migrateFoodLegacy(cfg);
  assert.deepEqual(cfg.modules.eat.magic, { enabled: true, slot: 2, sid: 99 }, 'unified shape untouched when already present');
  assert.deepEqual(cfg.modules.training.eatWithMagic, { enabled: true, slot: 3, sid: 55, everyRunes: 1 },
    'legacy key NOT deleted when eat.magic exists (migrate only when magic absent)');
});
