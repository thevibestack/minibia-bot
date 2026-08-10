'use strict';

/**
 * Game client read adapter (REQ-01/02/14, design D3).
 *
 * All reads are state-first with DOM fallback and are RE-QUERIED on every call
 * (the game rebuilds DOM wholesale — never hold element references). Game
 * access is fully injectable through the `ctx` object so the module stays
 * thin and testable with jsdom:
 *
 *   ctx = { gameClient: <page gameClient>, document: <DOM document> }
 *
 * readStats()      -> { mana, maxMana, health, maxHealth, source }
 * readCooldown(sid)-> { cooldown, globalCooldown, source }
 */

/**
 * Coerce a value to a finite number, or null when missing/invalid.
 * @param {*} value
 * @returns {number|null}
 */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a bar element's last child text ("cur/max") into {cur, max}.
 * @param {Element|null} bar
 * @returns {{cur: number, max: number}|null}
 */
function parseBar(bar) {
  const text = bar?.lastElementChild?.textContent;
  if (!text) return null;
  const match = String(text).trim().match(/^(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return { cur: Number(match[1]), max: Number(match[2]) };
}

/**
 * Read current player stats: `player.state` primary, `#mana-bar`/`#health-bar`
 * DOM fallback, re-queried per read (REQ-01/14).
 *
 * @param {object} [ctx] - injected context
 * @param {object} [ctx.gameClient] - page gameClient (player.state read here)
 * @param {Document} [ctx.document] - DOM document for the bar fallback
 * @returns {{mana: number|null, maxMana: number|null, health: number|null,
 *   maxHealth: number|null, source: 'state'|'dom'|'none'}}
 */
function readStats(ctx = {}) {
  const state = ctx.gameClient?.player?.state;

  // Primary: player.state.
  if (state && (num(state.mana) !== null || num(state.health) !== null)) {
    return {
      mana: num(state.mana),
      maxMana: num(state.maxMana),
      health: num(state.health),
      maxHealth: num(state.maxHealth),
      source: 'state',
    };
  }

  // Fallback: bars, re-queried every read.
  const doc = ctx.document ?? (typeof document !== 'undefined' ? document : null);
  const mana = parseBar(doc?.querySelector?.('#mana-bar'));
  const health = parseBar(doc?.querySelector?.('#health-bar'));

  if (!mana && !health) {
    return { mana: null, maxMana: null, health: null, maxHealth: null, source: 'none' };
  }

  return {
    mana: mana?.cur ?? null,
    maxMana: mana?.max ?? null,
    health: health?.cur ?? null,
    maxHealth: health?.max ?? null,
    source: 'dom',
  };
}

/**
 * Read the player's rune CAP state (design D3, REQ-30): the rune-making
 * capacity vs its maximum. Feature-detects over the probed locations (open
 * probe: `player.state.__state.capacity` reads 209 while `maxCapacity` reads
 * 400 — the fields may sit at DIFFERENT locations), so each field is read
 * from both candidate locations and the first finite value wins:
 *   capacity:    state.__state.capacity | state.capacity
 *   maxCapacity: state.__state.maxCapacity | state.maxCapacity | player.maxCapacity
 *
 * ratio = capacity / maxCapacity, ratio-guarded (maxCapacity must be finite
 * and > 0). Absent or uncomputable data returns ratio null with an honest
 * source ('none' when nothing was read, 'partial' when only one side is
 * known) — callers degrade, never invent a ratio.
 *
 * @param {object} [ctx] - injected context
 * @param {object} [ctx.gameClient] - page gameClient (player.state read here)
 * @returns {{capacity: number|null, maxCapacity: number|null, ratio: number|null,
 *   source: 'state'|'partial'|'none'}}
 */
function readCap(ctx = {}) {
  const player = ctx.gameClient && ctx.gameClient.player;
  const state = player && player.state;
  if (!state || typeof state !== 'object') {
    return { capacity: null, maxCapacity: null, ratio: null, source: 'none' };
  }
  const sub = state.__state;
  const capacity = num(sub && sub.capacity) ?? num(state.capacity);
  const maxCapacity = num(sub && sub.maxCapacity)
    ?? num(state.maxCapacity)
    ?? num(player.maxCapacity);
  if (capacity === null && maxCapacity === null) {
    return { capacity: null, maxCapacity: null, ratio: null, source: 'none' };
  }
  if (capacity === null || maxCapacity === null || maxCapacity <= 0) {
    return { capacity, maxCapacity, ratio: null, source: 'partial' };
  }
  return { capacity, maxCapacity, ratio: capacity / maxCapacity, source: 'state' };
}

/**
 * Normalize a single cooldown bucket entry into {active, seconds}.
 * Supports {active, seconds}, a bare seconds number, and a seconds string.
 * @param {*} entry
 * @returns {{active: boolean, seconds: number}|null}
 */
function normalizeCooldown(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'number' || typeof entry === 'string') {
    const seconds = num(entry);
    if (seconds === null) return null;
    return { active: seconds > 0, seconds };
  }
  if (typeof entry === 'object') {
    const seconds = num(entry.seconds);
    if (seconds === null) {
      // Object without seconds: honor an explicit active flag.
      if (typeof entry.active === 'boolean') return { active: entry.active, seconds: 0 };
      return null;
    }
    return { active: entry.active === undefined ? seconds > 0 : Boolean(entry.active), seconds };
  }
  return null;
}

/**
 * Read client cooldown state for a spell (REQ-02).
 *
 * Primary source: `gameClient.player.spellbook.cooldowns` (per-spell bucket keyed
 * by sid plus GLOBAL_COOLDOWN), mirroring the client pre-fire gate. When the
 * spellbook/cooldowns data is entirely absent the adapter returns nulls so the
 * core (cooldown.canFire) applies config fallback pacing with a gap log. When
 * the map EXISTS but has no entry for the sid, that is client-authoritative
 * "not on cooldown" ({active:false}) — never confused with "data absent".
 *
 * @param {number|string} spellSid - spell id keying the per-spell bucket
 * @param {object} [ctx] - injected context
 * @param {object} [ctx.gameClient] - page gameClient
 * @returns {{cooldown: {active: boolean, seconds: number}|null,
 *   globalCooldown: {active: boolean, seconds: number}|null,
 *   source: 'client'|'absent'}}
 */
function readCooldown(spellSid, ctx = {}) {
  const cooldowns = ctx.gameClient?.player?.spellbook?.cooldowns;
  if (cooldowns === null || cooldowns === undefined) {
    return { cooldown: null, globalCooldown: null, source: 'absent' };
  }

  const globalEntry = cooldowns.GLOBAL_COOLDOWN ?? cooldowns.globalCooldown;
  const spellEntry = cooldowns[spellSid];

  return {
    cooldown: normalizeCooldown(spellEntry) ?? { active: false, seconds: 0 },
    globalCooldown: normalizeCooldown(globalEntry) ?? { active: false, seconds: 0 },
    source: 'client',
  };
}

/**
 * Enumerate the client spell catalog (design D5, REQ-28): calls
 * `interface.getSpell(sid)` from sid 0 upward until `maxUnknown` consecutive
 * unknown sids (live probe: ~65 spells). Returns the RAW list plus the
 * player's level + vocation label so the PANEL can filter by what the
 * current character can actually cast. Returns null when the interface is
 * not ready (feature-detect — the picker degrades with an honest reason).
 *
 * Each spell normalizes the live-probed shape (obs 10457):
 *   {name, words, mana, level, vocations[]}  — vocations is an ARRAY OF
 *   STRINGS ("sorcerer"/"druid"/"paladin"/"knight"), never numeric.
 *
 * @param {object|null} gameClient - page gameClient (interface.getSpell)
 * @param {object} [opts]
 * @param {number} [opts.maxUnknown=30] - consecutive unknown sids that end the scan
 * @param {number} [opts.limit=400] - hard cap on the sid range scanned
 * @returns {{spells: Array<object>, playerLevel: number|null,
 *   vocationLabel: string|null}|null}
 */
function enumerateSpellCatalog(gameClient, opts = {}) {
  const maxUnknown = Number.isInteger(opts.maxUnknown) ? opts.maxUnknown : 30;
  const limit = Number.isInteger(opts.limit) ? opts.limit : 400;
  const intf = gameClient && gameClient.interface;
  if (!intf || typeof intf.getSpell !== 'function') return null;

  const spells = [];
  let unknownStreak = 0;
  for (let sid = 0; sid < limit && unknownStreak < maxUnknown; sid += 1) {
    let entry = null;
    try { entry = intf.getSpell(sid); } catch (e) { entry = null; }
    if (!entry || typeof entry !== 'object'
      || (entry.name === undefined && entry.words === undefined)) {
      unknownStreak += 1;
      continue;
    }
    unknownStreak = 0;
    spells.push({
      sid: sid,
      name: typeof entry.name === 'string' && entry.name ? entry.name : 'spell ' + sid,
      words: typeof entry.words === 'string' ? entry.words : '',
      mana: num(entry.mana),
      level: num(entry.level),
      vocations: Array.isArray(entry.vocations)
        ? entry.vocations.filter((v) => typeof v === 'string') : [],
    });
  }

  const player = (gameClient && gameClient.player) || {};
  const level = num(player.level);
  let label = null;
  try {
    // Live-probed location (obs 10457): hotbarManager.__VOCATION_NAMES maps
    // the numeric vocation id to its string label ("druid", "sorcerer", ...).
    const hb = (gameClient.interface && gameClient.interface.hotbarManager)
      || gameClient.hotbarManager || null;
    const table = hb && hb.__VOCATION_NAMES || null;
    if (table && player.vocation !== undefined && table[player.vocation]) {
      label = table[player.vocation];
    }
  } catch (e) { label = null; }

  return { spells, playerLevel: level, vocationLabel: label };
}

/**
 * Pure filter (design D5, REQ-28): keep only spells the given vocation label
 * + player level can cast — `vocations[]` includes the label (an EMPTY
 * vocations array means "no restriction") AND `level <= playerLevel`.
 * @param {Array<object>} spells - raw catalog rows ({sid, name, words, mana, level, vocations})
 * @param {object} [opts]
 * @param {string} [opts.vocationLabel] - current player's vocation label
 * @param {number|null} [opts.playerLevel] - current player level
 * @returns {Array<object>}
 */
function filterCatalogByVocation(spells, opts = {}) {
  const label = typeof opts.vocationLabel === 'string' ? opts.vocationLabel : '';
  const playerLevel = opts.playerLevel;
  return (Array.isArray(spells) ? spells : []).filter((s) => {
    if (!s || typeof s !== 'object') return false;
    const vocations = Array.isArray(s.vocations) ? s.vocations : [];
    if (label && vocations.length > 0 && vocations.indexOf(label) === -1) return false;
    if (playerLevel !== null && playerLevel !== undefined
      && Number.isFinite(Number(s.level)) && Number(s.level) > playerLevel) return false;
    return true;
  });
}

/**
 * Pure per-sid rejection (design D5/D6, REQ-27/28): WHY a spell cannot be
 * applied to the current character — or null when it can. Used by the panel
 * server for the cross-load rejection list (load-profile) and the mana
 * re-check on config save. `mana` is optional: the cross-load path validates
 * vocation/level only; the save path adds the live-mana check.
 * @param {object|null} spell - catalog row for the sid
 * @param {object} [ctx]
 * @param {string} [ctx.vocationLabel]
 * @param {number|null} [ctx.playerLevel]
 * @param {number|null} [ctx.mana] - current mana (save-path re-check only)
 * @returns {{reason: string}|null}
 */
function spellValidationError(spell, ctx = {}) {
  if (!spell || typeof spell !== 'object') return { reason: 'unknown spell' };
  const label = typeof ctx.vocationLabel === 'string' ? ctx.vocationLabel : '';
  const vocations = Array.isArray(spell.vocations) ? spell.vocations : [];
  if (label && vocations.length > 0 && vocations.indexOf(label) === -1) {
    return { reason: 'vocation mismatch — requires ' + vocations.join('/') };
  }
  if (ctx.playerLevel !== null && ctx.playerLevel !== undefined
    && Number.isFinite(Number(spell.level)) && Number(spell.level) > ctx.playerLevel) {
    return { reason: 'level too high — requires level ' + spell.level };
  }
  if (ctx.mana !== null && ctx.mana !== undefined
    && Number.isFinite(Number(spell.mana)) && Number(spell.mana) > ctx.mana) {
    return { reason: 'not enough mana — costs ' + spell.mana + ', you have ' + Math.floor(ctx.mana) };
  }
  return null;
}

module.exports = {
  readStats,
  readCooldown,
  readCap,
  enumerateSpellCatalog,
  filterCatalogByVocation,
  spellValidationError,
};
