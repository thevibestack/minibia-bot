'use strict';

/**
 * In-page agent bootstrap for the CDP-injected desktop app (REQ-04/10/11/12,
 * design D2/D3/D4).
 *
 * The engine SHAPE proven end to end:
 *
 *   gameClient + hotbarManager ready
 *        -> tree ticks in-page at jittered cadence, reads stats into ctx
 *        -> the tree executes AT MOST ONE action per tick (REQ-10)
 *        -> every action dispatches through the ONE global Action Queue
 *           (REQ-12, no bypass: game handlers are invoked ONLY inside
 *           queue-dispatched closures)
 *
 * Tree priority (REQ-11): heal items (REQ-13) > heal magic (REQ-14) >
 * legacy survival slot-heal (slices 2/3 sample leaf, retained for config
 * backward compatibility) > runes (REQ-15) > combat (rotation leaf, design
 * D4) > training (REQ-16) > eat (REQ-17) > loot (slice-5 stub).
 *
 * Slice-4 modules live in src/agent/modules/*.js — pure decision factories
 * (node-testable) wired here as tree nodes; each action enqueues a closure
 * that runs the module's game-handler call (REQ-12 no-bypass).
 *
 * Exposes window.__mbAgent with the REQ-04 surface:
 *   { readStats, readCooldown, fireSlot, eatFood, getChat,
 *     getRuneState, getWalkState, getPlayerInfo, applyConfig }
 *
 * In-page tick cadence: self-scheduling jittered setTimeout (50-400ms via
 * core/jitter), the SAME pattern the userscript uses (no Worker — the
 * desktop bot owns a dedicated visible window, REQ-04).
 */

const { createTree } = require('../core/tree');
const { createQueue } = require('../core/queue');
const JITTER_MOD = require('../core/jitter');
const ROTATION_MOD = require('../core/rotation');
const FEAS_MOD = require('../core/feasibility');
const CD_MOD = require('../core/cooldown');
const GC_MOD = require('../adapters/gameClient');
const FIRING_MOD = require('../adapters/firing');
const CHAT_MOD = require('../adapters/chat');
const PREMIUM_MOD = require('../core/premium');
const KILLS_MOD = require('../core/kills');
const LOG_MOD = require('../core/log'); // D8 (slice 1a): readable activity log ring
// Slice-4 modules (REQ-13..17) — pure decision modules, tree-wired below.
const HEAL_ITEMS_MOD = require('./modules/heal-items');
const HEAL_MAGIC_MOD = require('./modules/heal-magic');
const RUNES_MOD = require('./modules/runes');
const TRAINING_MOD = require('./modules/training');
const EAT_MODULE_MOD = require('./modules/eat');
// Slice-5 modules (REQ-18..22,24,25) — ported automations + carry-overs.
const TRADE_MOD = require('./modules/trade');
const LOOT_MOD = require('./modules/loot');
const SPAWNS_MOD = require('./modules/spawns');
const HUNT_STATS_MOD = require('./modules/huntStats');
const ECHO_MOD = require('./modules/echo');
const LEARNING_MOD = require('./modules/learning');
// Slice-6 module (REQ-23): native autowalk state read + walk-to (routes v1).
const ROUTES_MOD = require('./modules/routes');

/** Minimal slice-2 config shape (per-character store lands in slice 3). */
const DEFAULT_CONFIG = {
  queue: { minIntervalMs: 150 },
  jitter: { min: 50, max: 400 },
  survival: { on: true, threshold: 50, slot: null }, // legacy generic slot-heal leaf (slices 2/3 shape)
  rotation: { spells: [] },                          // combat leaf rules (userscript shape)
  // Slice-4 modules — ALL OFF by default (spec: "Optional, user-activated").
  // Shapes match app/store/characters.ts defaultConfig (slice 3) + additive
  // settings: runes.healThreshold, eat.slot, eat.cids (design extensions).
  healItems: { on: false, threshold: 50, slotCids: [] },
  healMagic: { on: false, threshold: 150, slot: null, sid: null, word: null, reserve: 0 },
  runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null },
  training: { on: false, slot: null, sid: null, reserve: 0, word: null },
  eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
  // Slice-5 modules — ALL OFF by default (opt-in). Shapes match
  // app/store/characters.ts defaultConfig + additive: healMagic/training word
  // (echo validation REQ-24), learning.knownWords (REQ-25 registration).
  trade: { on: false, message: '', intervalMs: 180000 },
  loot: { on: false, defaultDest: null, perMonster: {} },
  spawns: { on: false },
  huntStats: { on: false },
  learning: { knownWords: [] },       // REQ-25: observation always runs while armed
  routes: { on: false },               // REQ-23 (slice 6): native autowalk read + walk-to; recording = FUTURE
  armed: false,                                      // interconnection gate (REQ-02, slice 3)
};

/**
 * Deep-ish merge of known keys over the defaults (unknown keys dropped).
 * `armed` is the REQ-02 gate flag: ONLY an explicit true arms the engine —
 * anything else leaves the agent disarmed ("not connected").
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: true, threshold: 50, slot: null },
    rotation: { spells: [] },
    healItems: { on: false, threshold: 50, slotCids: [] },
    healMagic: { on: false, threshold: 150, slot: null, sid: null, word: null, reserve: 0 },
    runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null },
    training: { on: false, slot: null, sid: null, reserve: 0, word: null },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    trade: { on: false, message: '', intervalMs: 180000 },
    loot: { on: false, defaultDest: null, perMonster: {} },
    spawns: { on: false },
    huntStats: { on: false },
    learning: { knownWords: [] },
    routes: { on: false },
    armed: false,
  };
  if (Number.isFinite(src.queue && src.queue.minIntervalMs) && src.queue.minIntervalMs >= 0) {
    cfg.queue.minIntervalMs = src.queue.minIntervalMs;
  }
  const j = JITTER_MOD.clampJitter(
    (src.jitter && src.jitter.min) || DEFAULT_CONFIG.jitter.min,
    (src.jitter && src.jitter.max) || DEFAULT_CONFIG.jitter.max,
  );
  cfg.jitter = { min: j.min, max: j.max };
  if (src.survival && typeof src.survival === 'object') {
    if (typeof src.survival.on === 'boolean') cfg.survival.on = src.survival.on;
    if (Number.isFinite(src.survival.threshold)) cfg.survival.threshold = src.survival.threshold;
    if (Number.isInteger(src.survival.slot)) cfg.survival.slot = src.survival.slot;
  }
  if (src.rotation && Array.isArray(src.rotation.spells)) {
    cfg.rotation.spells = src.rotation.spells.filter((s) => s && typeof s === 'object');
  }
  // --- Slice-4 module normalization (unknown keys dropped, invalid values default) ---
  const hi = src.healItems && typeof src.healItems === 'object' ? src.healItems : {};
  if (typeof hi.on === 'boolean') cfg.healItems.on = hi.on;
  if (Number.isFinite(hi.threshold)) cfg.healItems.threshold = hi.threshold;
  if (Array.isArray(hi.slotCids)) cfg.healItems.slotCids = hi.slotCids.map(Number).filter(Number.isInteger).filter((n) => n >= 0);
  const hm = src.healMagic && typeof src.healMagic === 'object' ? src.healMagic : {};
  if (typeof hm.on === 'boolean') cfg.healMagic.on = hm.on;
  if (Number.isFinite(hm.threshold)) cfg.healMagic.threshold = hm.threshold;
  if (Number.isInteger(hm.slot)) cfg.healMagic.slot = hm.slot;
  if (Number.isInteger(hm.sid)) cfg.healMagic.sid = hm.sid;
  if (Number.isFinite(hm.reserve) && hm.reserve >= 0) cfg.healMagic.reserve = hm.reserve; // D2 (REQ-31)
  const rn = src.runes && typeof src.runes === 'object' ? src.runes : {};
  if (typeof rn.on === 'boolean') cfg.runes.on = rn.on;
  if (Number.isInteger(rn.attackSlot)) cfg.runes.attackSlot = rn.attackSlot;
  if (Number.isInteger(rn.healSlot)) cfg.runes.healSlot = rn.healSlot;
  if (Number.isFinite(rn.healThreshold)) cfg.runes.healThreshold = rn.healThreshold;
  const tr = src.training && typeof src.training === 'object' ? src.training : {};
  if (typeof tr.on === 'boolean') cfg.training.on = tr.on;
  if (Number.isInteger(tr.slot)) cfg.training.slot = tr.slot;
  if (Number.isInteger(tr.sid)) cfg.training.sid = tr.sid;
  if (Number.isFinite(tr.reserve) && tr.reserve >= 0) cfg.training.reserve = tr.reserve;
  const ea = src.eat && typeof src.eat === 'object' ? src.eat : {};
  if (typeof ea.on === 'boolean') cfg.eat.on = ea.on;
  if (Number.isFinite(ea.everyCasts) && ea.everyCasts >= 0) cfg.eat.everyCasts = Math.floor(ea.everyCasts);
  if (Number.isFinite(ea.warningWindowSec) && ea.warningWindowSec > 0) cfg.eat.warningWindowSec = ea.warningWindowSec;
  if (Number.isFinite(ea.fallbackIntervalSec) && ea.fallbackIntervalSec > 0) cfg.eat.fallbackIntervalSec = ea.fallbackIntervalSec;
  if (Number.isInteger(ea.slot)) cfg.eat.slot = ea.slot;
  if (Array.isArray(ea.cids)) cfg.eat.cids = ea.cids.map(Number).filter(Number.isInteger).filter((n) => n >= 0);
  // --- Slice-5 module normalization (REQ-18..22,24,25) ---
  const hm5 = src.healMagic && typeof src.healMagic === 'object' ? src.healMagic : {};
  if (typeof hm5.word === 'string') cfg.healMagic.word = hm5.word; // echo validation (REQ-24)
  const tr5 = src.training && typeof src.training === 'object' ? src.training : {};
  if (typeof tr5.word === 'string') cfg.training.word = tr5.word;   // echo validation (REQ-24)
  const td = src.trade && typeof src.trade === 'object' ? src.trade : {};
  if (typeof td.on === 'boolean') cfg.trade.on = td.on;
  if (typeof td.message === 'string') cfg.trade.message = td.message;
  if (Number.isFinite(td.intervalMs) && td.intervalMs > 0) cfg.trade.intervalMs = td.intervalMs;
  const lt = src.loot && typeof src.loot === 'object' ? src.loot : {};
  if (typeof lt.on === 'boolean') cfg.loot.on = lt.on;
  if (typeof lt.defaultDest === 'string') cfg.loot.defaultDest = lt.defaultDest;
  if (lt.perMonster && typeof lt.perMonster === 'object' && !Array.isArray(lt.perMonster)) {
    cfg.loot.perMonster = {};
    for (const key of Object.keys(lt.perMonster)) {
      if (typeof lt.perMonster[key] === 'string') cfg.loot.perMonster[key] = lt.perMonster[key];
    }
  }
  const sp = src.spawns && typeof src.spawns === 'object' ? src.spawns : {};
  if (typeof sp.on === 'boolean') cfg.spawns.on = sp.on;
  const hs = src.huntStats && typeof src.huntStats === 'object' ? src.huntStats : {};
  if (typeof hs.on === 'boolean') cfg.huntStats.on = hs.on;
  const le = src.learning && typeof src.learning === 'object' ? src.learning : {};
  if (Array.isArray(le.knownWords)) {
    cfg.learning.knownWords = le.knownWords
      .filter((w) => typeof w === 'string' && w.trim())
      .map((w) => w.trim());
  }
  const rt = src.routes && typeof src.routes === 'object' ? src.routes : {};
  if (typeof rt.on === 'boolean') cfg.routes.on = rt.on;
  cfg.armed = src.armed === true; // REQ-02: only an explicit true arms
  return cfg;
}

/**
 * Create the in-page agent.
 *
 * @param {object} [opts]
 * @param {Window} [opts.win=window] - page window
 * @param {Document} [opts.document] - page document
 * @param {object} [opts.config] - initial config (defaults used when absent)
 * @param {number} [opts.pollIntervalMs=500] - readiness poll cadence
 * @param {boolean} [opts.autoStart=true] - arm the ticker once wired
 * @param {() => number} [opts.now] - injectable clock (tests)
 * @param {() => number} [opts.rng] - injectable RNG (tests)
 * @param {Function} [opts.setTimeout] [opts.clearTimeout] [opts.setInterval] [opts.clearInterval]
 * @param {object} [opts.log={error, warn, info}] - log sinks
 * @returns {object} agent handle (see module doc)
 */
function createAgent(opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const doc = opts.document || (win && win.document) || null;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 500;
  const autoStart = opts.autoStart !== false;
  const nowFn = typeof opts.now === 'function' ? opts.now : (typeof Date !== 'undefined' ? Date.now : () => 0);
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const setTimeoutFn = typeof opts.setTimeout === 'function' ? opts.setTimeout : (win && win.setTimeout ? win.setTimeout.bind(win) : null);
  const clearTimeoutFn = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (win && win.clearTimeout ? win.clearTimeout.bind(win) : null);
  const setIntervalFn = typeof opts.setInterval === 'function' ? opts.setInterval : (win && win.setInterval ? win.setInterval.bind(win) : null);
  const clearIntervalFn = typeof opts.clearInterval === 'function' ? opts.clearInterval : (win && win.clearInterval ? win.clearInterval.bind(win) : null);
  const baseLog = opts.log || {
    error: (m) => { state.errors.push(String(m)); try { if (win && win.console) win.console.error('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    warn: (m) => { state.warnings.push(String(m)); try { if (win && win.console) win.console.warn('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    info: (m) => { try { if (win && win.console) win.console.info('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
  };

  // D8 (slice 1a): session-scoped readable activity log. Every sink call and
  // every queue-dispatched fire closure pushes an entry; the panel renders
  // them as formatted rows (REQ-26 — never raw JSON). Session-scoped like
  // state.timers: survives config rebuilds, resets on agent restart.
  const logRing = LOG_MOD.createLogRing({ cap: 200, now: nowFn });

  /** Best-effort readable-log push — logging never breaks the agent. */
  function logEvent(module, action, result) {
    try {
      logRing.push({ ts: nowFn(), module: module, action: action, result: result });
    } catch (e) { /* best-effort */ }
  }

  // Mirror every sink into the ring (module 'agent', level as action) so
  // agent-level alerts/errors surface in the panel log too. Injected sinks
  // keep their exact call signature.
  const log = {
    error: (m) => { logEvent('agent', 'error', m); if (typeof baseLog.error === 'function') baseLog.error(m); },
    warn: (m) => { logEvent('agent', 'warn', m); if (typeof baseLog.warn === 'function') baseLog.warn(m); },
    info: (m) => { logEvent('agent', 'info', m); if (typeof baseLog.info === 'function') baseLog.info(m); },
  };

  const state = {
    ready: false,
    running: false,
    destroyed: false,
    armed: false, // REQ-02 gate: false until the panel confirms + pushes armed:true
    gameClient: null,
    config: null,
    tree: null,
    queue: null,
    engine: null,
    modules: null, // slice-4 module handles (built in rebuild)
    ctx: {},
    ticker: null,
    pollTimer: null,
    pollCount: 0,
    lastPath: [],
    lastDispatch: [],
    warnings: [],
    errors: [],
    // Session-scoped state (survives config rebuilds within a session,
    // reset on agent restart): the trade cadence anchor (REQ-18 "toggle
    // resets on logout") + the kill observer baseline.
    timers: { tradeLastSentAt: 0 },
    // D8 (slice 1a): readable activity log ring (cap 200) — fed by the log
    // sinks above and the fire closures below; carried in getState() so the
    // panel renders formatted rows (REQ-26, never raw JSON).
    logBuffer: logRing,
  };

  // Shared active-creature diff observer (core/kills): feeds huntStats
  // kills/loot (REQ-21) and loot routing (REQ-19). Baseline resets on every
  // rebuild (new session/config).
  state.killObserver = KILLS_MOD.createKillObserver({
    readActiveCreatures: readActiveCreatures,
    now: nowFn,
  });

  /* ------------------------------ tree + queue ----------------------------- */

  /** Combat rules (userscript spell shape) whose ACTIONS enqueue through the
   *  Action Queue — the rotation engine executes them inline, so enqueueing
   *  inside the action is the ONLY way to keep REQ-12's no-bypass promise. */
  function readSpellCost(spell) {
    let cost = null;
    try {
      const sb = state.gameClient && state.gameClient.player && state.gameClient.player.spellbook;
      if (sb && spell.sid !== null && spell.sid !== undefined) {
        const entry = (typeof sb.getSpell === 'function' ? sb.getSpell(spell.sid) : null)
          || (sb.spells && sb.spells[spell.sid]) || null;
        if (entry && entry.cost !== undefined) cost = Number(entry.cost);
      }
      // Slice-4 (probed, obs 10320): spellbook is EMPTY — spells resolve via
      // interface.getSpell(sid). Adds the probed location as a fallback.
      if ((cost === null || !Number.isFinite(cost)) && state.gameClient && state.gameClient.interface) {
        const intf = state.gameClient.interface;
        if (typeof intf.getSpell === 'function') {
          const entry = intf.getSpell(spell.sid);
          if (entry && entry.cost !== undefined) cost = Number(entry.cost);
        }
      }
    } catch (e) { cost = null; }
    if ((cost === null || !Number.isFinite(cost)) && Number.isFinite(Number(spell.cost))) cost = Number(spell.cost);
    return cost !== null && Number.isFinite(cost) ? cost : null;
  }

  /** Live-probed hotbar manager accessor (obs 10320 location). */
  function readHotbar() {
    const gc = state.gameClient;
    return gc && ((gc.interface && gc.interface.hotbarManager) || gc.hotbarManager) || null;
  }

  /** Live-probed vocation gate hotbarManager.__canPlayerCastSpell(sid)
   *  (obs 10320). Returns true/false when the gate exists; null when the
   *  feature is absent (callers skip the gate, never block). */
  function canCastSpell(sid) {
    try {
      const hb = readHotbar();
      if (hb && typeof hb.__canPlayerCastSpell === 'function') {
        return hb.__canPlayerCastSpell(sid) === true;
      }
    } catch (e) { /* gate read failure => unknown */ }
    return null;
  }

  /** Live-probed native rune windows: hotbarManager.__runeAttackUntil /
   *  __runeHealUntil (epoch-ms "active until"). Returns null when the fields
   *  are ABSENT (feature not present => the rune module degrades, design D7 —
   *  no invented fallback loop). */
  function readRuneTimers() {
    try {
      const hb = readHotbar();
      if (!hb) return null;
      const attackUntil = hb.__runeAttackUntil;
      const healUntil = hb.__runeHealUntil;
      if (attackUntil === undefined && healUntil === undefined) return null;
      return { attackUntil: attackUntil === undefined ? null : attackUntil, healUntil: healUntil === undefined ? null : healUntil };
    } catch (e) { return null; }
  }

  /** Post-rune-fire wait in ms: __getRuneEffectiveCooldown() when present,
   *  plus player attackSlowness when exposed (REQ-15 "respect global cooldown
   *  and player.attackSlowness"). Feature-detected; 0 when absent. */
  function readRuneAfterFireWait() {
    let wait = 0;
    try {
      const hb = readHotbar();
      if (hb && typeof hb.__getRuneEffectiveCooldown === 'function') {
        const v = hb.__getRuneEffectiveCooldown();
        if (Number.isFinite(Number(v))) wait = Math.max(wait, Number(v));
      }
    } catch (e) { /* best-effort */ }
    try {
      const p = state.gameClient && state.gameClient.player;
      const sl = (p && p.state && p.state.attackSlowness) !== undefined
        ? (p.state.attackSlowness) : (p && p.attackSlowness);
      if (Number.isFinite(Number(sl))) wait = Math.max(wait, Number(sl));
    } catch (e) { /* best-effort */ }
    return wait;
  }

  /* ------------------- slice-5 feature-detect readers (REQ-18..22) ------------------- */

  /** Premium gate (REQ-22, core/premium): feature-detect over the probed
   *  candidate locations; unknown state never blocks (no hard dependency). */
  function readPremium() {
    return PREMIUM_MOD.readPremiumState(state.gameClient, nowFn);
  }

  /** Live active-creature list (kill feed, REQ-21/19): world.activeCreatures
   *  probed (obs 10320); null when the array is absent (kill source degrade). */
  function readActiveCreatures() {
    try {
      const gc = state.gameClient;
      const world = gc && gc.world;
      const list = (world && world.activeCreatures) || (gc && gc.activeCreatures) || (world && world.creatures);
      return Array.isArray(list) ? list : null;
    } catch (e) { return null; }
  }

  /** XP/gold counters (REQ-21): player.state/player candidates, feature-detected. */
  function readHuntCounters() {
    try {
      const p = state.gameClient && state.gameClient.player;
      if (!p) return { xp: null, gold: null };
      const rawXp = (p.state && p.state.xp) || p.xp || (p.state && p.state.experience);
      const rawGold = (p.state && p.state.gold) || p.gold || (p.state && p.state.money);
      const xp = Number.isFinite(Number(rawXp)) ? Number(rawXp) : null;
      const gold = Number.isFinite(Number(rawGold)) ? Number(rawGold) : null;
      return { xp, gold };
    } catch (e) { return { xp: null, gold: null }; }
  }

  /** Trade-channel send surface (REQ-18, design D6): channelManager resolved
   *  by id 2 (Trade — live-probed channels, obs 10320) with the send method
   *  feature-detected. Returns {send, label} or null (degrade). */
  function readTradeChannel() {
    try {
      const gc = state.gameClient;
      const manager = (gc && ((gc.interface && gc.interface.channelManager) || gc.channelManager)) || null;
      if (!manager) return null;
      let channel = null;
      if (typeof manager.getChannelById === 'function') channel = manager.getChannelById(2);
      if (!channel && typeof manager.getChannel === 'function') {
        try { channel = manager.getChannel(2); } catch (e) { channel = null; }
      }
      if (!channel && manager.channels && manager.channels[2]) channel = manager.channels[2];
      if (!channel && typeof manager.getChannel === 'function') {
        try { channel = manager.getChannel('Trade'); } catch (e) { channel = null; }
      }
      if (!channel || typeof channel !== 'object') return null;
      const send = channel.send || channel.sendMessage || channel.sendChat
        || channel.message || channel.sendChannelMessage;
      if (typeof send !== 'function') return null;
      return { send: send.bind(channel), label: 'Trade(2)' };
    } catch (e) { return null; }
  }

  /** Loot-command surface (REQ-19): feature-detected game function
   *  (monster, destination) => void; null = unavailable (degrade). */
  function readLootCommand() {
    try {
      const gc = state.gameClient;
      const cands = [gc && gc.lootCommands, gc && gc.autoLoot, gc && gc.lootManager,
        gc && gc.interface && gc.interface.lootManager, gc && gc.loot];
      for (const c of cands) {
        if (!c) continue;
        for (const name of ['routeLoot', 'sendLoot', 'setDestination', 'route', 'assign', 'command']) {
          if (typeof c[name] === 'function') return c[name].bind(c);
        }
        if (typeof c === 'function') return c;
      }
      return null;
    } catch (e) { return null; }
  }

  /** Spawn-map data reader (REQ-20): feature-detect the game's spawn-data
   *  structure (open probe 5.3); returns raw locations or null ("no spawn
   *  data"). Pure normalization lives in the spawns module. */
  function readSpawnData(monster) {
    try {
      const gc = state.gameClient;
      const world = gc && gc.world;
      const cands = [gc && gc.spawns, world && world.spawns, gc && gc.spawnMap,
        gc && gc.monsterSpawns, gc && gc.interface && gc.interface.spawnManager,
        world && world.spawnData, gc && gc.spawnLocations];
      for (const c of cands) {
        if (!c) continue;
        if (typeof c.query === 'function') {
          const r = c.query(monster);
          if (r !== null && r !== undefined) return r;
        } else if (typeof c.get === 'function') {
          const r = c.get(monster);
          if (r !== null && r !== undefined) return r;
        } else if (typeof c === 'object' && c[monster] !== undefined) {
          return c[monster];
        }
      }
      return null;
    } catch (e) { return null; }
  }

  /** Native pathfinder reader (REQ-23, live-probed location obs 10320:
   *  world.pathfinder holds the autowalk state + walk-to methods). Returns
   *  null when absent ("no pathfinder data" degrade). */
  function readPathfinder() {
    try {
      const gc = state.gameClient;
      const world = gc && gc.world;
      const pf = (world && world.pathfinder) || (gc && gc.pathfinder) || null;
      return pf && typeof pf === 'object' ? pf : null;
    } catch (e) { return null; }
  }

  /** Configured words for the learning observer (REQ-25): rotation spell
   *  words + healMagic/training words + previously registered words. */
  function configuredWords() {
    const words = new Set();
    const spells = (state.config && state.config.rotation && state.config.rotation.spells) || [];
    for (const s of spells) {
      if (s && typeof s.word === 'string' && s.word.trim()) words.add(s.word.trim());
    }
    const hm = state.config && state.config.healMagic;
    if (hm && typeof hm.word === 'string' && hm.word.trim()) words.add(hm.word.trim());
    const tr = state.config && state.config.training;
    if (tr && typeof tr.word === 'string' && tr.word.trim()) words.add(tr.word.trim());
    const le = state.config && state.config.learning;
    if (le && Array.isArray(le.knownWords)) {
      for (const w of le.knownWords) if (typeof w === 'string' && w.trim()) words.add(w.trim());
    }
    return words;
  }

  function buildCombatRules(cfg) {
    const spells = (cfg.rotation.spells || []).filter((s) => Number.isInteger(s.slot) && s.slot >= 1 && s.slot <= 12);
    return spells.map((spell, index) => ({
      id: 'cast-slot-' + spell.slot,
      order: Number.isFinite(spell.order) ? spell.order : spell.slot,
      condition: function (ctx) {
        if (ctx.mana === null || ctx.mana === undefined) return false;
        if (Number.isFinite(spell.threshold) && spell.threshold > 0 && ctx.mana < spell.threshold) return false;
        const cost = readSpellCost(spell);
        if (cost !== null) {
          const feas = FEAS_MOD.canCast({
            mana: ctx.mana,
            cost,
            reserve: spell.reserve || 0,
            maxMana: ctx.maxMana,
            key: 'slot-' + spell.slot,
            warned: new Set(),
            onWarn: function () {},
          });
          if (!feas.fire) return false;
        }
        const cd = GC_MOD.readCooldown(spell.sid, { gameClient: state.gameClient });
        if (!CD_MOD.canFire({
          cooldown: cd.cooldown,
          globalCooldown: cd.globalCooldown,
          cooldownMs: spell.cooldownMs || 0,
          lastFiredAt: ctx.lastFiredAt ? ctx.lastFiredAt[spell.slot] : null,
          now: Date.now(),
          onGapLog: function () {},
        }).fire) return false;
        return !state.queue.hasPending((e) => e.kind === 'combat-cast-slot-' + spell.slot);
      },
      action: function (ctx) {
        // NO-BYPASS (REQ-12): the real __handleClick call happens ONLY inside
        // the queue-dispatched closure, never inline.
        state.queue.enqueue(() => {
          FIRING_MOD.fireSlot(spell.slot, {
            mode: 'handleClick',
            gameClient: state.gameClient,
            document: doc,
            log,
          });
        }, { kind: 'combat-cast-slot-' + spell.slot });
        ctx.lastFiredAt = ctx.lastFiredAt || {};
        ctx.lastFiredAt[spell.slot] = nowFn();
        return true;
      },
      kind: 'cast',
      repeat: Math.max(1, Number(spell.repeat) || 1),
    }));
  }

  /** Rebuild tree + queue + modules from the current config (applyConfig path). */
  function rebuild(cfg) {
    state.config = cfg;
    state.armed = cfg.armed === true; // REQ-02: arm/keep-disarmed on every config push
    state.ctx = { mana: null, maxMana: null, health: null, lastFiredAt: {}, castsSinceFood: 0, lastEatAt: 0 };
    if (state.killObserver) state.killObserver.reset(); // new session/config -> fresh kill baseline
    state.queue = createQueue({
      minInterval: cfg.queue.minIntervalMs,
      jitter: cfg.jitter,
      now: nowFn,
      rng,
      dispatch: function (fn) { fn(); }, // the ONLY game-handler invocation point
    });
    state.engine = ROTATION_MOD.createEngine({ rules: buildCombatRules(cfg), ctx: state.ctx });

    /* -------- slice-4 modules (REQ-13..17): pure decision + queue-dispatch -------- */
    const healItems = HEAL_ITEMS_MOD.createHealItems({
      config: cfg.healItems,
      findSlot: function () { return HEAL_ITEMS_MOD.defaultFindSlot(state.gameClient, cfg.healItems.slotCids); },
      gameClient: function () { return state.gameClient; },
      log,
    });
    const healMagic = HEAL_MAGIC_MOD.createHealMagic({
      config: cfg.healMagic,
      getSpellCost: function (sid) { return readSpellCost({ sid: sid }); },
      canCastSpell: canCastSpell,
      readCooldown: function (sid) { return GC_MOD.readCooldown(sid, { gameClient: state.gameClient }); },
      now: nowFn,
      log,
    });
    const runes = RUNES_MOD.createRunes({
      config: cfg.runes,
      readRuneTimers: readRuneTimers,
      readGlobalCooldown: function () { return GC_MOD.readCooldown(null, { gameClient: state.gameClient }).globalCooldown; },
      readAfterFireWait: readRuneAfterFireWait,
      now: nowFn,
      log,
    });
    const training = TRAINING_MOD.createTraining({
      config: cfg.training,
      getSpellCost: function (sid) { return readSpellCost({ sid: sid }); },
      canCastSpell: canCastSpell,
      readCooldown: function (sid) { return GC_MOD.readCooldown(sid, { gameClient: state.gameClient }); },
      now: nowFn,
      log,
    });
    const eat = EAT_MODULE_MOD.createEatModule({
      config: cfg.eat,
      gameClient: function () { return state.gameClient; },
      document: doc,
      now: nowFn,
      log,
    });

    /* -------- slice-5 modules (REQ-18..22,24,25): ported automations -------- */

    // REQ-18: auto trade broadcast — cadence anchor lives in state.timers
    // (session-scoped, survives config rebuilds; agent restart = new session,
    // mirroring the game's "toggle resets to OFF on logout").
    const trade = TRADE_MOD.createTradeModule({
      config: cfg.trade,
      timers: state.timers,
      readChannel: readTradeChannel,
      readPremium: readPremium,
      now: nowFn,
      log,
    });
    // REQ-19: auto-loot list — per-monster destinations + default; the kill
    // feed comes from the shared observer (observeKills in tickOnce).
    const loot = LOOT_MOD.createLootModule({
      config: cfg.loot,
      readLootCommand: readLootCommand,
      readPremium: readPremium,
      now: nowFn,
      log,
    });
    // REQ-20: spawn maps — read-only provider; the panel queries it via the
    // getSpawns surface RPC; state flows through the snapshot.
    const spawns = SPAWNS_MOD.createSpawnsModule({
      config: cfg.spawns,
      readSpawnData: readSpawnData,
      readPremium: readPremium,
      log,
    });
    // REQ-21: hunt session stats — accumulator fed per tick (tickOnce). The
    // panel toggle is the session start/stop control (ON = start, OFF =
    // freeze). The module INSTANCE survives rebuilds (applyConfig
    // transitions), so unrelated config pushes never reset a running session.
    if (!state.huntStatsModule) {
      state.huntStatsModule = HUNT_STATS_MOD.createHuntStats({
        config: cfg.huntStats,
        readCounters: readHuntCounters,
        killObserver: state.killObserver,
        readPremium: readPremium,
        now: nowFn,
        log,
      });
    } else {
      state.huntStatsModule.applyConfig(cfg.huntStats);
    }
    const huntStats = state.huntStatsModule;
    // REQ-24: echo validation — carried-over validator, started from the
    // heal-magic/training queue closures when a word is configured.
    const echo = ECHO_MOD.createEchoModule({
      playerName: function () { return (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null; },
      gameClient: state.gameClient,
      document: doc,
      now: nowFn,
      log,
    });
    // REQ-25: unknown-word observation + registration offer (panel renders
    // offers from the module state; confirm/decline via server + RPC).
    const learning = LEARNING_MOD.createLearningModule({
      config: cfg.learning,
      playerName: function () { return (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null; },
      configuredWords: configuredWords,
      gameClient: state.gameClient,
      document: doc,
      now: nowFn,
      log,
    });
    // REQ-23 (slice 6): routes v1 — native autowalk state read + walk-to
    // via the game's own pathfinder primitive (never synthetic per-step
    // input). Not a tree node: the read is passive (eager getState) and
    // walk-to is an app-driven RPC (queue-dispatched).
    const routes = ROUTES_MOD.createRoutesModule({
      config: cfg.routes,
      readPathfinder: readPathfinder,
      now: nowFn,
      log,
    });
    state.modules = {
      healItems: healItems, healMagic: healMagic, runes: runes, training: training, eat: eat,
      trade: trade, loot: loot, spawns: spawns, huntStats: huntStats, echo: echo, learning: learning,
      routes: routes,
    };

    /* -------- tree nodes: survival > combat > training > eat > loot (REQ-11) -------- */

    // REQ-13: heal with items — survival priority, queue-aware (no re-enqueue
    // while a heal-item action is pending).
    const healItemsNode = {
      type: 'sequence',
      id: 'heal-items',
      children: [
        {
          type: 'condition',
          id: 'heal-items-feasible',
          predicate: function (ctx) {
            if (!cfg.healItems.on) return false;
            const d = healItems.decide(ctx);
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'heal-item'; });
          },
        },
        {
          type: 'action',
          id: 'heal-items-use',
          run: function (ctx) {
            const d = healItems.decide(ctx);
            if (!d.fire) return false;
            // NO-BYPASS (REQ-12): the real __useItemOnSelf/mouse.use call
            // happens ONLY inside the queue-dispatched closure.
            state.queue.enqueue(function () { healItems.fire(d.item); }, { kind: 'heal-item' });
            logEvent('healItems', 'use-item', d.item && d.item.cid !== undefined ? d.item.cid : d.reason || 'heal');
            return true;
          },
        },
      ],
    };

    // REQ-14: heal with magic — hp threshold + mana feasibility +
    // GLOBAL_COOLDOWN defer (core/cooldown), queue-aware.
    const healMagicNode = {
      type: 'sequence',
      id: 'heal-magic',
      children: [
        {
          type: 'condition',
          id: 'heal-magic-feasible',
          predicate: function (ctx) {
            if (!cfg.healMagic.on) return false;
            const d = healMagic.decide(ctx);
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'heal-magic'; });
          },
        },
        {
          type: 'action',
          id: 'heal-magic-cast',
          run: function (ctx) {
            const d = healMagic.decide(ctx);
            if (!d.fire) return false;
            state.queue.enqueue(function () {
              healMagic.fire(d, { gameClient: state.gameClient, document: doc });
              // REQ-24 echo validation: words-path fires only (word configured);
              // direct casts without a word skip validation entirely.
              if (cfg.healMagic && typeof cfg.healMagic.word === 'string' && cfg.healMagic.word.trim()) {
                echo.startForFire('heal-magic', cfg.healMagic.word);
              }
              logEvent('healMagic', 'cast', d.reason || 'heal');
            }, { kind: 'heal-magic' });
            return true;
          },
        },
      ],
    };

    const survival = {
      type: 'sequence',
      id: 'survival',
      children: [
        {
          type: 'condition',
          id: 'low-hp',
          predicate: function (ctx) {
            return Boolean(cfg.survival.on)
              && Number.isInteger(cfg.survival.slot)
              && ctx.health !== null
              && ctx.health <= cfg.survival.threshold
              && !state.queue.hasPending(function (e) { return e.kind === 'survival-heal'; });
          },
        },
        {
          type: 'action',
          id: 'heal',
          run: function (ctx) {
            // NO-BYPASS (REQ-12): the action enqueues a closure; the real
            // __handleClick call happens ONLY inside the queue-dispatched
            // closure, never inline during the tree tick.
            state.queue.enqueue(function () {
              FIRING_MOD.fireSlot(cfg.survival.slot, {
                mode: 'handleClick',
                gameClient: state.gameClient,
                document: doc,
                log,
              });
              logEvent('survival', 'fire-slot', cfg.survival.slot);
            }, { kind: 'survival-heal' });
            return true;
          },
        },
      ],
    };

    // REQ-15: runes — defer while a native window is active; fire on expiry.
    // A single action node: the decision is made inside run() so a deferred
    // rune falls through to combat in the same tick.
    const runesNode = {
      type: 'action',
      id: 'runes',
      run: function (ctx) {
        if (!cfg.runes.on) return false;
        const d = runes.decide(ctx);
        if (!d.fire) return false;
        if (state.queue.hasPending(function (e) { return e.kind === d.kind; })) return false;
        state.queue.enqueue(function () {
          runes.fire(d, { gameClient: state.gameClient, document: doc });
          logEvent('runes', d.kind || 'runes', d.reason || null);
        }, { kind: d.kind });
        return true;
      },
    };

    const combat = {
      type: 'action',
      id: 'combat',
      run: function (ctx) {
        const result = state.engine.tick(); // at most one rule per tick (rotation semantics)
        return Boolean(result.fired);
      },
    };

    // REQ-16: training — cast-to-train cadence via the queue; a training cast
    // advances the every-N-casts food cadence (ctx.castsSinceFood).
    const trainingNode = {
      type: 'sequence',
      id: 'training',
      children: [
        {
          type: 'condition',
          id: 'training-feasible',
          predicate: function (ctx) {
            if (!cfg.training.on) return false;
            const d = training.decide(ctx);
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'training-cast'; });
          },
        },
        {
          type: 'action',
          id: 'training-cast',
          run: function (ctx) {
            const d = training.decide(ctx);
            if (!d.fire) return false;
            state.queue.enqueue(function () {
              training.fire(d, { gameClient: state.gameClient, document: doc });
              // REQ-24 echo validation: only when a training word is configured.
              if (cfg.training && typeof cfg.training.word === 'string' && cfg.training.word.trim()) {
                echo.startForFire('training', cfg.training.word);
              }
              logEvent('training', 'cast', d.reason || null);
            }, { kind: 'training-cast' });
            ctx.castsSinceFood = (ctx.castsSinceFood || 0) + 1; // every-N-casts counts training casts
            return true;
          },
        },
      ],
    };

    // REQ-17: eat — proven SATED/timer/everyCasts/fallback-interval decision;
    // the queue-dispatched closure runs the proven eater attempt.
    const eatNode = {
      type: 'sequence',
      id: 'eat',
      children: [
        {
          type: 'condition',
          id: 'eat-feasible',
          predicate: function (ctx) {
            if (!cfg.eat.on) return false;
            const d = eat.decide(ctx);
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'eat'; });
          },
        },
        {
          type: 'action',
          id: 'eat-use',
          run: function (ctx) {
            const d = eat.decide(ctx);
            if (!d.fire) return false;
            state.queue.enqueue(function () { eat.fire(ctx, d); logEvent('eat', 'eat', d.reason || null); }, { kind: 'eat' });
            return true;
          },
        },
      ],
    };

    // REQ-19: auto-loot — route kills with loot to the configured destination
    // via the game's own loot-command surface (feature-detected; degrade =
    // record/no-op with honest panel state). Queue-aware, one route per tick.
    const lootNode = {
      type: 'sequence',
      id: 'loot',
      children: [
        {
          type: 'condition',
          id: 'loot-feasible',
          predicate: function () {
            if (!cfg.loot.on) return false;
            const d = loot.decide();
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'loot-route'; });
          },
        },
        {
          type: 'action',
          id: 'loot-collect',
          run: function () {
            const d = loot.decide();
            if (!d.fire) return false;
            // NO-BYPASS (REQ-12): the game loot command runs ONLY inside the
            // queue-dispatched closure.
            state.queue.enqueue(function () { loot.fire(d); logEvent('loot', 'route', d.reason || null); }, { kind: 'loot-route' });
            return true;
          },
        },
      ],
    };

    // REQ-18: auto trade broadcast — 3-min cadence (default, mirror the game)
    // to the Trade channel via the game's own channel mechanism. Lowest
    // priority: a chat broadcast never pre-empts survival/combat (REQ-11).
    const tradeNode = {
      type: 'sequence',
      id: 'trade',
      children: [
        {
          type: 'condition',
          id: 'trade-due',
          predicate: function () {
            if (!cfg.trade.on) return false;
            const d = trade.decide();
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'trade-broadcast'; });
          },
        },
        {
          type: 'action',
          id: 'trade-send',
          run: function () {
            const d = trade.decide();
            if (!d.fire) return false;
            // NO-BYPASS (REQ-12): the channel send runs ONLY inside the
            // queue-dispatched closure.
            state.queue.enqueue(function () { trade.fire(d); logEvent('trade', 'broadcast', d.reason || null); }, { kind: 'trade-broadcast' });
            return true;
          },
        },
      ],
    };

    state.tree = createTree({
      root: {
        type: 'selector',
        id: 'priority-root',
        // heal (items + magic + legacy slot-heal) > runes > combat > training
        // > eat > loot > trade (REQ-11: survival/heal always beats
        // combat/loot/training; trade broadcast is the lowest priority).
        children: [healItemsNode, healMagicNode, survival, runesNode, combat, trainingNode, eatNode, lootNode, tradeNode],
      },
    });
  }

  /* ------------------------------ readiness ------------------------------- */

  function poll() {
    if (state.ready || state.destroyed) return state.ready;
    const gameClient = opts.gameClient !== undefined ? opts.gameClient : (win && win.gameClient);
    const hotbar = gameClient && ((gameClient.interface && gameClient.interface.hotbarManager) || gameClient.hotbarManager);
    if (!gameClient || !hotbar || typeof hotbar.__handleClick !== 'function') {
      state.pollCount += 1;
      if (state.pollCount * pollIntervalMs > 120000) {
        state.pollCount = 0;
        log.warn('bootstrap: gameClient/hotbarManager not found yet — still waiting');
      }
      return false;
    }
    state.gameClient = gameClient;
    state.ready = true;
    log.info('ready — player ' + ((gameClient.player && gameClient.player.name) || '?'));
    if (autoStart) start();
    return true;
  }

  /* ------------------------------ engine loop ----------------------------- */

  function createTicker() {
    let pending = null;
    function arm() {
      if (!state.running || pending !== null) return;
      const j = state.config.jitter;
      pending = setTimeoutFn(function () {
        pending = null;
        tickOnce();
        if (state.running) arm(); // self-scheduling jittered cadence (REQ-04)
      }, JITTER_MOD.randomDelay(j.min, j.max, rng));
    }
    return {
      start: function () {
        if (state.running) return;
        state.running = true;
        arm();
      },
      stop: function () {
        state.running = false;
        if (pending !== null) { clearTimeoutFn(pending); pending = null; }
      },
    };
  }

  /** One tree tick + queue drain. At most one action enqueued per tick
   *  (the tree halts after the first executed action; actions are
   *  queue-aware and enqueue themselves — REQ-12 no-bypass). No tick while
   *  disarmed: the REQ-02 gate refuses ANY module action pre-Connect. */
  function tickOnce() {
    if (!state.ready || !state.running || state.destroyed) return null;
    if (!state.armed) return null; // interconnection gate (REQ-02)
    try {
      const stats = GC_MOD.readStats({ gameClient: state.gameClient, document: doc });
      const ctx = state.ctx;
      if (stats.mana !== null) ctx.mana = stats.mana;
      if (stats.maxMana !== null) ctx.maxMana = stats.maxMana;
      ctx.health = stats.health;
      // Pre-tree READ-ONLY feeds (REQ-06: reads only — no actions here):
      //  - huntStats: per-tick accumulation (REQ-21)
      //  - loot: kill observations from the shared observer (REQ-19)
      //  - learning: Default-channel unknown-word observation (REQ-25)
      const killScan = state.killObserver ? state.killObserver.scan() : { kills: [], available: false };
      const m = state.modules;
      if (m.huntStats) m.huntStats.accumulate(killScan);
      if (m.loot) m.loot.observeKills(killScan.kills);
      if (m.learning) m.learning.observeChat();
      const result = state.tree.tick(ctx);
      state.lastPath = result.path;
      state.lastDispatch = state.queue.drain(); // eligible entries fire here, in the queue
      return result;
    } catch (err) {
      state.errors.push('tick failed: ' + (err && err.message ? err.message : String(err)));
      log.error('tick failed: ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  /* ------------------------------ __mbAgent surface ------------------------ */

  function readPlayerInfo() {
    const p = state.gameClient && state.gameClient.player;
    if (!p) return null;
    let label = null;
    try {
      // Live-probed location (obs 10320): hotbarManager.__VOCATION_NAMES.
      const hb = state.gameClient.interface && state.gameClient.interface.hotbarManager
        || state.gameClient.hotbarManager || null;
      const table = hb && hb.__VOCATION_NAMES || (win && win.__VOCATION_NAMES) || null;
      if (table && p.vocation !== undefined && table[p.vocation]) label = table[p.vocation];
    } catch (e) { label = null; }
    return { name: p.name !== undefined ? p.name : null, vocationId: p.vocation !== undefined ? p.vocation : null, vocationLabel: label };
  }

  function applyConfig(raw) {
    const cfg = normalizeConfig(raw || {});
    rebuild(cfg);
    log.info('applyConfig — queue minInterval ' + cfg.queue.minIntervalMs + 'ms, survival '
      + (cfg.survival.on ? 'on (hp<=' + cfg.survival.threshold + ')' : 'off'));
    return { ok: true, config: cfg };
  }

  function makeSurface() {
    return {
      readStats: function () { return GC_MOD.readStats({ gameClient: state.gameClient, document: doc }); },
      readCooldown: function (sid) { return GC_MOD.readCooldown(sid, { gameClient: state.gameClient }); },
      fireSlot: function (slot, mode) {
        // REQ-02 gate: app-driven RPC fires are refused before Connect.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        // REQ-12 no-bypass: even app-driven RPC fires go through the queue.
        state.queue.enqueue(function () {
          FIRING_MOD.fireSlot(slot, {
            mode: mode || 'handleClick',
            gameClient: state.gameClient,
            document: doc,
            log,
          });
          logEvent('rpc', 'fire-slot', slot);
        }, { kind: 'rpc-fire-slot-' + slot });
        return true;
      },
      eatFood: function () {
        // REQ-02 gate: app-driven RPC eats are refused before Connect.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.eat;
        if (!m || !m.isEnabled()) return { result: 'off' };
        // REQ-12 no-bypass: the real eat attempt runs inside the queue.
        state.queue.enqueue(function () {
          m.fire(state.ctx, { fire: true, reason: 'rpc', force: true });
          logEvent('eat', 'rpc-eat', 'queued');
        }, { kind: 'eat-rpc' });
        return { result: 'queued' };
      },
      getChat: function () { return CHAT_MOD.getRecentMessages({ gameClient: state.gameClient, document: doc }); },
      getRuneState: function () {
        const m = state.modules && state.modules.runes;
        return m ? m.getState() : null; // REQ-15 real module state (slice 4)
      },
      getSpawns: function (monster) {
        // REQ-20 read-only RPC: the panel queries spawn locations for a
        // monster through the app; result lands in the module state.
        const m = state.modules && state.modules.spawns;
        if (!m || !state.ready) return { available: false, reason: 'not ready', monster: String(monster || '') };
        return m.query(monster);
      },
      respondOffer: function (action, word) {
        // REQ-25: user decision on a learning offer. 'decline' silences the
        // word for the session (RPC, no rebuild); 'confirm' is handled by the
        // server via a config push (knownWords). Refused pre-Connect (REQ-02).
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.learning;
        if (!m) return { ok: false, reason: 'not ready' };
        if (action === 'decline') {
          m.decline(word);
          return { ok: true, action: 'decline', word: String(word || '') };
        }
        if (action === 'confirm') {
          m.markKnown(word);
          return { ok: true, action: 'confirm', word: String(word || '') };
        }
        return { ok: false, reason: 'unknown action' };
      },
      getWalkState: function () {
        // REQ-23: real routes-v1 module state (slice 6) — autowalk read
        // (+ destination) or the honest "no pathfinder data" degrade.
        const m = state.modules && state.modules.routes;
        return m ? m.getState() : null;
      },
      walkTo: function (x, y) {
        // REQ-23 (slice 6): walk-to via the NATIVE autowalk primitive only
        // (world.pathfinder.pathTo — live-probed, obs 10320); never
        // synthetic per-step input. REQ-02 gate + REQ-12 no-bypass: the
        // native call happens ONLY inside a queue-dispatched closure.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.routes;
        if (!m) return { ok: false, reason: 'not ready' };
        const d = m.decideWalkTo(x, y);
        if (!d.fire) return { ok: false, reason: d.reason };
        state.queue.enqueue(function () { m.fireWalk(d); logEvent('routes', 'walk-to', String(d.x) + ',' + String(d.y)); }, { kind: 'walk-to' });
        return {
          ok: true,
          method: d.method && d.method.name ? d.method.name : 'native-autowalk',
          x: d.x,
          y: d.y,
          queued: true,
        };
      },
      getPlayerInfo: readPlayerInfo,
      getSpellCatalog: function () {
        // REQ-28 (slice 1b, design D5): client spell catalog RPC — enumerates
        // interface.getSpell(sid) until 30 consecutive unknown sids and
        // returns the RAW list + player context (level, vocation label). The
        // PANEL/server filters it by what the current character can cast;
        // the page never filters here so one RPC serves every vocation.
        // Returns null while the game client is not ready (degrade).
        if (!state.gameClient) return null;
        return GC_MOD.enumerateSpellCatalog(state.gameClient, { maxUnknown: 30, limit: 400 });
      },
      applyConfig: applyConfig,
    };
  }

  /* ------------------------------ lifecycle ------------------------------- */

  function start() {
    if (!state.ready) { log.warn('start: agent not ready — game client not found yet'); return false; }
    state.ticker.start();
    return true;
  }

  function stop() {
    if (state.ticker) state.ticker.stop();
    return true;
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    if (state.pollTimer !== null) clearIntervalFn(state.pollTimer);
    if (state.ticker) state.ticker.stop();
  }

  function getState() {
    const modules = state.modules || {};
    return {
      ready: state.ready,
      running: state.running,
      armed: state.armed,
      playerName: (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null,
      health: state.ctx.health,
      mana: state.ctx.mana,
      queue: state.queue ? state.queue.stats() : null,
      lastPath: state.lastPath,
      castsSinceFood: state.ctx.castsSinceFood || 0,
      modules: {
        runes: modules.runes ? modules.runes.getState() : null,
        eat: modules.eat ? modules.eat.getState() : null,
        trade: modules.trade ? modules.trade.getState() : null,
        loot: modules.loot ? modules.loot.getState() : null,
        spawns: modules.spawns ? modules.spawns.getState() : null,
        huntStats: modules.huntStats ? modules.huntStats.getState() : null,
        echo: modules.echo ? modules.echo.getState() : null,
        learning: modules.learning ? modules.learning.getState() : null,
        routes: modules.routes ? modules.routes.getState() : null,
      },
      warnings: state.warnings.slice(),
      errors: state.errors.slice(),
      logBuffer: state.logBuffer.read(), // D8 (slice 1a): readable log rows for the panel
    };
  }

  /* ------------------------------ wiring ---------------------------------- */

  rebuild(normalizeConfig(opts.config));
  state.ticker = createTicker();
  state.pollTimer = setIntervalFn(poll, pollIntervalMs);

  return {
    poll,
    isReady: function () { return state.ready; },
    start,
    stop,
    destroy,
    tickOnce,
    getState,
    applyConfig,
    getQueue: function () { return state.queue; },
    surface: makeSurface(),
  };
}

module.exports = { createAgent, normalizeConfig, DEFAULT_CONFIG };
