'use strict';

/**
 * Per-character JSON store (task 3.1, REQ-09, design D9).
 *
 * App-local persistence keyed by character name. One JSON file per character
 * under `<appData>/characters/<name>.json` holding the design config shape:
 *   { character, connected, queue, jitter, modules{10}, routes[], session }
 *
 * - Writes are atomic-ish: the new content is written to a temp file and
 *   renamed over the target, so a crash never leaves a half-written config.
 * - A missing file means "first run" -> defaults, no warning.
 * - A corrupt file (unparseable / wrong shape) -> defaults + a warning the
 *   app surfaces; the file is NOT destroyed, the next save overwrites it.
 * - Character names come from the page; file names are sanitized so no name
 *   can escape the characters dir (path safety).
 *
 * Pure Node module: no globals, injectable base dir (node-testable with a
 * temp dir; no Bun required — sync fs works in Bun too, slice 6 packaging).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHARACTERS_SUBDIR = 'characters';
const FILE_SUFFIX = '.json';

/**
 * Default per-character config (design "Config (per character)").
 * All 10 modules default OFF — every module is opt-in (spec: "Optional,
 * user-activated"). Slice 4/5/6 land the module settings forms; the SHAPE
 * is the contract now (REQ-09 pre-fill + panel toggles).
 * @param {string} characterName
 * @returns {object}
 */
function defaultConfig(characterName) {
  return {
    character: String(characterName),
    connected: false,
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    modules: {
      healItems: { on: false, threshold: 50, slotCids: [] },
      manaItems: { on: false, threshold: 50, slotCids: [] },
      // reserve (D2, slice 1b): per-module mana reserve — the cast must not
      // fire below cost + reserve (REQ-31 lands with the TRAINER slice).
      healMagic: { on: false, threshold: 150, slot: null, word: null, sid: null, reserve: 0 },
      // Slice-1b forward-compat (D2/D3/D4, tasks PR2/PR4): strict rune CAP
      // with a configurable fallback spell, per-module reserves, and
      // eat-with-magic defaults — the TRAINER slice wires the behavior.
      runes: { on: false, attackSlot: null, healSlot: null, reserve: 0,
        capMode: 'strict', capFullThreshold: 1.0, fallbackSid: null, fallbackSlot: null, fallbackManaPct: 0.5 },
      training: { on: false, slot: null, word: null, sid: null, reserve: 0,
        // Slice B (REQ-46, D-B3): per-character hotkey assignments (F-keys)
        // persisted so a reload restores the Rune/Fallback hotbar keybinds.
        hotkeys: { runeKey: 'F4', fallbackKey: 'F5' },
        // Slice B (REQ-44, D-B4): the rune-making stop flags — either ON ends
        // at the runes module off only (heal/eat continue); persisted so the
        // panel restores the stop state + banner after a reload.
        stopRuneMaking: false, stopBotting: false },
      // REQ-08 (PR 2): UNIFIED eat shape (design A+C) — the legacy
      // training.eatWithMagic key is gone from defaults; migrateFoodLegacy
      // carries old saved files over. everyCasts:0 = cadence off (0=off);
      // magic-first applies iff magic.enabled && valid slot(1-12) && valid sid.
      eat: { on: false, slot: null, cids: [], everyCasts: 0,
        warningWindowSec: 60, fallbackIntervalSec: 10, safetyNetMinutes: 20,
        magic: { enabled: false, slot: null, sid: null } },
      trade: { on: false, message: '', intervalMs: 180000 },
      loot: { on: false, defaultDest: null, perMonster: {} },
      spawns: { on: false },
      huntStats: { on: false },
      routes: { on: false },
      // REQ-25 (slice 5): registration offers persist confirmed words here.
      // `on` follows the all-modules-OFF store convention; the agent treats
      // observation as always-active while armed (REQ-25 MUST observe) and
      // only reads knownWords.
      learning: { on: false, knownWords: [] },
      // Slice-1b forward-compat (D9): anti-bot watcher + confirm-once chat
      // replies — shape only, the OTHERS slice wires the behavior.
      antibot: { on: false, replies: [] },
      // Slice-7 forward-compat (D10, REQ-35/36): skeleton module shapes —
      // attack targeting/pickers config and the cavebot pause flag. The
      // ROUTE LIST itself lives at the config TOP LEVEL (`routes: []`,
      // REQ-36 "save = config.routes").
      attack: { on: false, targeting: 'lowest-hp', sid: null, runeSlot: null, reserve: 0 },
      cavebot: { on: false, paused: false, route: [], monsters: [], targeting: 'nearest' },
    },
    routes: [],
    session: { startedAt: null },
  };
}

/** Top-level config keys that hold plain values (not merged, just copied). */
const SCOPED_KEYS = ['queue', 'jitter'];

/**
 * Deep-ish merge of a SAVED config over the defaults: every known module is
 * re-merged against its default shape (forward-compat: new settings added in
 * later slices get their defaults), unknown keys are dropped.
 * @param {object} saved
 * @param {object} defaults
 * @returns {object}
 */
function mergeConfig(saved, defaults) {
  const out = JSON.parse(JSON.stringify(defaults));
  if (!saved || typeof saved !== 'object') return out;
  if (typeof saved.character === 'string' && saved.character) out.character = saved.character;
  if (typeof saved.connected === 'boolean') out.connected = saved.connected;
  for (const key of SCOPED_KEYS) {
    if (saved[key] && typeof saved[key] === 'object') {
      out[key] = Object.assign({}, out[key], saved[key]);
    }
  }
  if (saved.modules && typeof saved.modules === 'object') {
    for (const id of Object.keys(out.modules)) {
      if (saved.modules[id] && typeof saved.modules[id] === 'object') {
        out.modules[id] = Object.assign({}, out.modules[id], saved.modules[id]);
      }
    }
  }
  if (Array.isArray(saved.routes)) out.routes = saved.routes;
  if (saved.session && typeof saved.session === 'object') {
    out.session = Object.assign({}, out.session, saved.session);
  }
  return out;
}

/**
 * App-local data base dir (design D9: ~/Library/Application Support on mac,
 * %APPDATA% on Windows). Overridable via MINIBIA_DESKTOP_DATA (tests/dev).
 * @returns {string}
 */
function storeBaseDir() {
  const base = process.env.MINIBIA_DESKTOP_DATA
    || process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(base, 'minibia-desktop-bot');
}

/**
 * Sanitize a character name into a safe file name: path separators and
 * traversal sequences are replaced, so no name can escape the characters
 * dir. Empty/whitespace-only names fall back to 'unnamed'.
 * @param {unknown} name
 * @returns {string}
 */
function safeCharacterFileName(name) {
  const cleaned = String(name === null || name === undefined ? '' : name)
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim();
  return cleaned === '' ? 'unnamed' : cleaned;
}

/**
 * Directory holding the per-character files.
 * @param {string} baseDir
 * @returns {string}
 */
function charactersDir(baseDir) {
  return path.join(baseDir, CHARACTERS_SUBDIR);
}

/**
 * File path for a character (sanitized). Never resolves outside charactersDir
 * (path safety: the sanitizer replaces '/', '\', '..' characters).
 * @param {string} baseDir
 * @param {string} characterName
 * @returns {string}
 */
function characterFilePath(baseDir, characterName) {
  return path.join(charactersDir(baseDir), safeCharacterFileName(characterName) + FILE_SUFFIX);
}

/**
 * REQ-08 (PR 2): migrate a legacy food config to the unified shape.
 *
 * The pre-unification builds kept food magic under
 * `training.eatWithMagic.{enabled,slot,sid,everyRunes}`; the unified shape
 * moves it to `eat.magic.{enabled,slot,sid}` (the everyRunes cadence is
 * DROPPED — design decision #1), while `eat.slot`/`eat.cids` stay where
 * they are.
 *
 * Idempotency (design ambiguity #4): migrate ONLY when `eat.magic` is
 * ABSENT (a file already carrying the unified shape is never touched) AND
 * `training.eatWithMagic` is present; the legacy key is deleted as part of
 * the migration, so a re-run finds nothing. A partial legacy entry copies
 * the fields it carries; missing fields keep the unified defaults (no
 * enabled:true => magic off).
 * @param {object} config - config to migrate in place (returns the same
 *   object for chaining).
 * @returns {object}
 */
function migrateFoodLegacy(config) {
  const modules = config && config.modules;
  if (!modules || typeof modules !== 'object') return config;
  const eat = modules.eat;
  const training = modules.training;
  if (!eat || typeof eat !== 'object' || !training || typeof training !== 'object') return config;
  if (eat.magic !== undefined) return config; // unified shape already present
  const legacy = training.eatWithMagic;
  if (!legacy || typeof legacy !== 'object') return config; // nothing to migrate
  eat.magic = {
    enabled: legacy.enabled === true,
    slot: legacy.slot !== undefined ? legacy.slot : null,
    sid: legacy.sid !== undefined ? legacy.sid : null,
  };
  delete training.eatWithMagic;
  return config;
}

/**
 * Load a character's config. Missing file -> defaults (no warning). Corrupt
 * content -> defaults + warning (REQ-09: "warns and runs with defaults, no
 * crash"). Shape drift (saved config missing newer keys) -> defaults merged.
 * REQ-08 (PR 2): legacy food configs are migrated to the unified eat.magic
 * shape BEFORE the defaults merge — the merged default now carries
 * `eat.magic`, so the "magic absent" guard must see the SAVED file state.
 * @param {{baseDir: string, name: string}} opts
 * @returns {{config: object, warning: string|null}}
 */
function loadCharacter(opts) {
  const file = characterFilePath(opts.baseDir, opts.name);
  const defaults = defaultConfig(opts.name);
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { config: defaults, warning: null };
    return { config: defaults, warning: 'unable to read ' + file + ': ' + err.message };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { config: defaults, warning: 'corrupt config for ' + opts.name + ' (' + file + ') — starting fresh: ' + err.message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: defaults, warning: 'corrupt config for ' + opts.name + ' (' + file + ') — not a config object; starting fresh' };
  }
  migrateFoodLegacy(parsed);
  const config = mergeConfig(parsed, defaults);
  config.character = String(opts.name);
  return { config, warning: null };
}

/**
 * Save a character's config. Atomic-ish: write a temp file in the same dir,
 * then rename over the target (rename is atomic on the same filesystem).
 * @param {{baseDir: string, name: string, config: object}} opts
 * @returns {{path: string}}
 */
function saveCharacter(opts) {
  const dir = charactersDir(opts.baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = characterFilePath(opts.baseDir, opts.name);
  const tmp = path.join(dir, '.' + safeCharacterFileName(opts.name) + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp');
  const payload = JSON.stringify(opts.config, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
  return { path: file };
}

/**
 * Names of every character with a saved config (file name -> character name;
 * temp files ignored).
 * @param {string} baseDir
 * @returns {string[]}
 */
function listCharacters(baseDir) {
  const dir = charactersDir(baseDir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith(FILE_SUFFIX) && !f.startsWith('.'))
    .map((f) => f.slice(0, -FILE_SUFFIX.length))
    .sort();
}

module.exports = {
  defaultConfig,
  mergeConfig,
  migrateFoodLegacy,
  storeBaseDir,
  safeCharacterFileName,
  charactersDir,
  characterFilePath,
  loadCharacter,
  saveCharacter,
  listCharacters,
};
