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
// PR5 (REQ-33/34, D9): anti-bot watcher + confirm-once chat replies — shares
// the Default-channel poll surface with echo/learning (REQ-24 MODIFIED).
const ANTIBOT_MOD = require('./modules/antibot');
// Slice-6 module (REQ-23): native autowalk state read + walk-to (routes v1).
const ROUTES_MOD = require('./modules/routes');
// PR6 (REQ-35/36, D10): state-only skeleton modules — attack targeting +
// pickers config and cavebot route record/save/pause/start; NO tree nodes.
const ATTACK_MOD = require('./modules/attack');
const CAVEBOT_MOD = require('./modules/cavebot');

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
  runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null, reserve: 0,
    capMode: 'strict', capFullThreshold: 1.0, fallbackSlot: null, fallbackManaPct: 0.5 },
  training: { on: false, slot: null, sid: null, reserve: 0, word: null,
    eatWithMagic: { enabled: false, slot: null, sid: null } },
  eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
  // Slice-5 modules — ALL OFF by default (opt-in). Shapes match
  // app/store/characters.ts defaultConfig + additive: healMagic/training word
  // (echo validation REQ-24), learning.knownWords (REQ-25 registration).
  trade: { on: false, message: '', intervalMs: 180000 },
  loot: { on: false, defaultDest: null, perMonster: {} },
  spawns: { on: false },
  huntStats: { on: false },
  learning: { knownWords: [] },       // REQ-25: observation always runs while armed
  antibot: { on: false, replies: [] }, // PR5 (D9): anti-bot watcher + confirm-once replies (REQ-33/34)
  routes: { on: false },               // REQ-23 (slice 6): native autowalk read + walk-to; recording = FUTURE
  // PR6 (REQ-35/36, D10): state-only skeleton modules — ALL OFF by default
  // (opt-in). attack: targeting choice (lowest-hp/nearest) + offensive
  // spell/rune pickers; cavebot: pause flag + the saved route list (the
  // route lands here from the TOP-LEVEL `routes` array of the per-character
  // config — REQ-36 "save = config.routes").
  attack: { on: false, targeting: 'lowest-hp', sid: null, runeSlot: null },
  cavebot: { on: false, paused: false, route: [] },
  armed: false,                                      // interconnection gate (REQ-02, slice 3)
};

/**
 * Per-module config source (REQ-08 fix slice): the REAL app push path
 * delivers the per-character STORE shape — a NESTED `modules.<id>` object
 * (app/panel/server.ts pushes the store config unchanged; the panel's
 * buildPushConfig writes live toggles into the same nested shape). The
 * agent historically read FLAT top-level keys only, so in the real app
 * every module toggle stayed OFF. This helper merges the nested entry
 * OVER the flat one: the nested store shape WINS for the fields it
 * carries, while the flat keys (the established agent/test shape +
 * DEFAULT_CONFIG) stay the fallback when `modules` is absent or a module
 * has no nested entry. Arrays never merge — the top-level `routes` list
 * is the cavebot route DATA (REQ-36), not the routes module config.
 * @param {object} src raw config
 * @param {string} id module id
 * @returns {object} merged module source (empty when absent)
 */
function moduleSource(src, id) {
  const nested = src.modules && typeof src.modules === 'object' && !Array.isArray(src.modules)
    && src.modules[id] && typeof src.modules[id] === 'object' && !Array.isArray(src.modules[id])
    ? src.modules[id] : null;
  const flat = src[id] && typeof src[id] === 'object' && !Array.isArray(src[id]) ? src[id] : null;
  return Object.assign({}, flat || {}, nested || {});
}

/**
 * Deep-ish merge of known keys over the defaults (unknown keys dropped).
 * Module configs are read through moduleSource() (see above): the NESTED
 * per-module store shape wins per-field, flat top-level keys stay the
 * fallback — both shapes keep working (REQ-08). `queue`/`jitter` are
 * top-level in BOTH shapes (store SCOPED_KEYS; the panel never writes them
 * nested). `armed` is the REQ-02 gate flag: ONLY an explicit true arms the
 * engine — anything else leaves the agent disarmed ("not connected").
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
    runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null, reserve: 0,
      capMode: 'strict', capFullThreshold: 1.0, fallbackSlot: null, fallbackManaPct: 0.5 },
    training: { on: false, slot: null, sid: null, reserve: 0, word: null,
      eatWithMagic: { enabled: false, slot: null, sid: null } },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    trade: { on: false, message: '', intervalMs: 180000 },
    loot: { on: false, defaultDest: null, perMonster: {} },
    spawns: { on: false },
    huntStats: { on: false },
    learning: { knownWords: [] },
    antibot: { on: false, replies: [] },
    routes: { on: false },
    attack: { on: false, targeting: 'lowest-hp', sid: null, runeSlot: null },
    cavebot: { on: false, paused: false, route: [] },
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
  const sv = moduleSource(src, 'survival');
  if (typeof sv.on === 'boolean') cfg.survival.on = sv.on;
  if (Number.isFinite(sv.threshold)) cfg.survival.threshold = sv.threshold;
  if (Number.isInteger(sv.slot)) cfg.survival.slot = sv.slot;
  const ro = moduleSource(src, 'rotation');
  if (Array.isArray(ro.spells)) {
    cfg.rotation.spells = ro.spells.filter((s) => s && typeof s === 'object');
  }
  // --- Slice-4 module normalization (unknown keys dropped, invalid values default) ---
  const hi = moduleSource(src, 'healItems');
  if (typeof hi.on === 'boolean') cfg.healItems.on = hi.on;
  if (Number.isFinite(hi.threshold)) cfg.healItems.threshold = hi.threshold;
  if (Array.isArray(hi.slotCids)) cfg.healItems.slotCids = hi.slotCids.map(Number).filter(Number.isInteger).filter((n) => n >= 0);
  const hm = moduleSource(src, 'healMagic');
  if (typeof hm.on === 'boolean') cfg.healMagic.on = hm.on;
  if (Number.isFinite(hm.threshold)) cfg.healMagic.threshold = hm.threshold;
  if (Number.isInteger(hm.slot)) cfg.healMagic.slot = hm.slot;
  if (Number.isInteger(hm.sid)) cfg.healMagic.sid = hm.sid;
  if (Number.isFinite(hm.reserve) && hm.reserve >= 0) cfg.healMagic.reserve = hm.reserve; // D2 (REQ-31)
  const rn = moduleSource(src, 'runes');
  if (typeof rn.on === 'boolean') cfg.runes.on = rn.on;
  if (Number.isInteger(rn.attackSlot)) cfg.runes.attackSlot = rn.attackSlot;
  if (Number.isInteger(rn.healSlot)) cfg.runes.healSlot = rn.healSlot;
  if (Number.isFinite(rn.healThreshold)) cfg.runes.healThreshold = rn.healThreshold;
  if (Number.isFinite(rn.reserve) && rn.reserve >= 0) cfg.runes.reserve = rn.reserve; // D2 (REQ-31)
  // Strict rune CAP + fallback (D3, REQ-30 — PR4): the trainer absorbs these
  // runes-module settings; invalid values fall back to the defaults.
  if (rn.capMode === 'strict' || rn.capMode === 'off') cfg.runes.capMode = rn.capMode;
  if (Number.isFinite(rn.capFullThreshold) && rn.capFullThreshold > 0 && rn.capFullThreshold <= 1) {
    cfg.runes.capFullThreshold = rn.capFullThreshold;
  }
  if (Number.isInteger(rn.fallbackSlot)) cfg.runes.fallbackSlot = rn.fallbackSlot;
  // NOTE: fallbackSid was DROPPED (post-chain maintenance, obs 10502): the
  // fallback fires SLOT-driven (fallbackSlot) like every other module; an
  // sid never resolved a slot, so carrying one implied behavior that did not
  // exist. Unknown keys are dropped by normalization anyway.
  if (Number.isFinite(rn.fallbackManaPct) && rn.fallbackManaPct >= 0 && rn.fallbackManaPct <= 1) {
    cfg.runes.fallbackManaPct = rn.fallbackManaPct;
  }
  const tr = moduleSource(src, 'training');
  if (typeof tr.on === 'boolean') cfg.training.on = tr.on;
  if (Number.isInteger(tr.slot)) cfg.training.slot = tr.slot;
  if (Number.isInteger(tr.sid)) cfg.training.sid = tr.sid;
  if (Number.isFinite(tr.reserve) && tr.reserve >= 0) cfg.training.reserve = tr.reserve;
  const ew = tr.eatWithMagic && typeof tr.eatWithMagic === 'object' ? tr.eatWithMagic : {};
  if (typeof ew.enabled === 'boolean') cfg.training.eatWithMagic.enabled = ew.enabled; // D4 (REQ-32)
  if (Number.isInteger(ew.slot)) cfg.training.eatWithMagic.slot = ew.slot;
  if (Number.isInteger(ew.sid)) cfg.training.eatWithMagic.sid = ew.sid;
  const ea = moduleSource(src, 'eat');
  if (typeof ea.on === 'boolean') cfg.eat.on = ea.on;
  if (Number.isFinite(ea.everyCasts) && ea.everyCasts >= 0) cfg.eat.everyCasts = Math.floor(ea.everyCasts);
  if (Number.isFinite(ea.warningWindowSec) && ea.warningWindowSec > 0) cfg.eat.warningWindowSec = ea.warningWindowSec;
  if (Number.isFinite(ea.fallbackIntervalSec) && ea.fallbackIntervalSec > 0) cfg.eat.fallbackIntervalSec = ea.fallbackIntervalSec;
  if (Number.isInteger(ea.slot)) cfg.eat.slot = ea.slot;
  if (Array.isArray(ea.cids)) cfg.eat.cids = ea.cids.map(Number).filter(Number.isInteger).filter((n) => n >= 0);
  // --- Slice-5 module normalization (REQ-18..22,24,25) ---
  if (typeof hm.word === 'string') cfg.healMagic.word = hm.word; // echo validation (REQ-24)
  if (typeof tr.word === 'string') cfg.training.word = tr.word;   // echo validation (REQ-24)
  const td = moduleSource(src, 'trade');
  if (typeof td.on === 'boolean') cfg.trade.on = td.on;
  if (typeof td.message === 'string') cfg.trade.message = td.message;
  if (Number.isFinite(td.intervalMs) && td.intervalMs > 0) cfg.trade.intervalMs = td.intervalMs;
  const lt = moduleSource(src, 'loot');
  if (typeof lt.on === 'boolean') cfg.loot.on = lt.on;
  if (typeof lt.defaultDest === 'string') cfg.loot.defaultDest = lt.defaultDest;
  if (lt.perMonster && typeof lt.perMonster === 'object' && !Array.isArray(lt.perMonster)) {
    cfg.loot.perMonster = {};
    for (const key of Object.keys(lt.perMonster)) {
      if (typeof lt.perMonster[key] === 'string') cfg.loot.perMonster[key] = lt.perMonster[key];
    }
  }
  const sp = moduleSource(src, 'spawns');
  if (typeof sp.on === 'boolean') cfg.spawns.on = sp.on;
  const hs = moduleSource(src, 'huntStats');
  if (typeof hs.on === 'boolean') cfg.huntStats.on = hs.on;
  const le = moduleSource(src, 'learning');
  if (Array.isArray(le.knownWords)) {
    cfg.learning.knownWords = le.knownWords
      .filter((w) => typeof w === 'string' && w.trim())
      .map((w) => w.trim());
  }
  // PR5 (REQ-33/34, D9): anti-bot watcher — {pattern, reply} entries with
  // non-empty trimmed parts; malformed entries are dropped (never crash).
  const ab = moduleSource(src, 'antibot');
  if (typeof ab.on === 'boolean') cfg.antibot.on = ab.on;
  if (Array.isArray(ab.replies)) {
    cfg.antibot.replies = ab.replies
      .filter((r) => r && typeof r === 'object'
        && typeof r.pattern === 'string' && r.pattern.trim()
        && typeof r.reply === 'string' && r.reply.trim())
      .map((r) => ({ pattern: r.pattern.trim(), reply: r.reply.trim() }));
  }
  const rt = moduleSource(src, 'routes');
  if (typeof rt.on === 'boolean') cfg.routes.on = rt.on;
  // PR6 (REQ-35/36, D10): skeleton module configs — attack targeting +
  // pickers; cavebot pause + saved route. The SAVED ROUTE LIST travels on
  // the per-character config at the TOP LEVEL (`routes: [...]` — the store
  // shape, REQ-36 "save = config.routes"); the flat agent/test shape may
  // also carry it as `cavebot.route`. Both normalize into cfg.cavebot.route
  // (sanitized: finite {x,y} waypoints only, junk dropped).
  const at = moduleSource(src, 'attack');
  if (typeof at.on === 'boolean') cfg.attack.on = at.on;
  cfg.attack.targeting = ATTACK_MOD.normalizeTargeting(at.targeting);
  cfg.attack.sid = ATTACK_MOD.normalizeSid(at.sid);
  cfg.attack.runeSlot = ATTACK_MOD.normalizeSlot(at.runeSlot);
  const cv = moduleSource(src, 'cavebot');
  if (typeof cv.on === 'boolean') cfg.cavebot.on = cv.on;
  if (typeof cv.paused === 'boolean') cfg.cavebot.paused = cv.paused;
  if (Array.isArray(cv.route)) cfg.cavebot.route = CAVEBOT_MOD.sanitizeRouteList(cv.route);
  if (Array.isArray(src.routes)) cfg.cavebot.route = CAVEBOT_MOD.sanitizeRouteList(src.routes);
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
    } catch (e) {
      warn('readSpellCost: spell cost lookup failed: ' + (e && e.message ? e.message : e));
      cost = null;
    }
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
    } catch (e) {
      warn('canCastSpell: vocation gate read failed — gate skipped: ' + (e && e.message ? e.message : e));
    }
    return null;
  }

  /** Live rune-CAP read (design D3, REQ-30): adapters/gameClient.readCap over
   *  the probed `player.state.__state.capacity`/`maxCapacity` locations —
   *  feature-detected, ratio-guarded (see readCap). */
  function readCap() {
    return GC_MOD.readCap({ gameClient: state.gameClient });
  }

  /** Rune spell cost for a hotbar slot (D2, REQ-31 runes reserve): resolves
   *  slot -> spell sid -> client cost (spellbook first, interface fallback).
   *  Returns null when any link is absent (gate skipped, never blocks). */
  function readRuneCost(slot) {
    try {
      const hb = readHotbar();
      if (!hb || !Array.isArray(hb.slots)) return null;
      const entry = hb.slots[Number(slot) - 1];
      const sid = entry && entry.spell;
      if (sid === null || sid === undefined) return null;
      return readSpellCost({ sid: sid });
    } catch (e) {
      warn('readRuneCost: slot cost resolution failed: ' + (e && e.message ? e.message : e));
      return null;
    }
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
    } catch (e) {
      warn('readRuneTimers: native rune timer read failed: ' + (e && e.message ? e.message : e));
      return null;
    }
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
    } catch (e) {
      warn('readRuneAfterFireWait: rune cooldown read failed: ' + (e && e.message ? e.message : e));
    }
    try {
      const p = state.gameClient && state.gameClient.player;
      const sl = (p && p.state && p.state.attackSlowness) !== undefined
        ? (p.state.attackSlowness) : (p && p.attackSlowness);
      if (Number.isFinite(Number(sl))) wait = Math.max(wait, Number(sl));
    } catch (e) {
      warn('readRuneAfterFireWait: attackSlowness read failed: ' + (e && e.message ? e.message : e));
    }
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

  /** Default-channel send surface (PR5, REQ-34, design D9 open probe): the
   *  channelManager resolved for the Default channel (id 1/0 candidates, the
   *  'Default' name, or the channels map) with the send method feature-
   *  detected. Returns {send, label} or null — the anti-bot module degrades
   *  to ALERT-ONLY when null; a send path is never invented. */
  function readDefaultChannelSend() {
    try {
      const gc = state.gameClient;
      const manager = (gc && ((gc.interface && gc.interface.channelManager) || gc.channelManager)) || null;
      if (!manager) return null;
      const candidates = [];
      if (typeof manager.getChannelById === 'function') {
        for (const id of [1, 0]) {
          try {
            const c = manager.getChannelById(id);
            if (c) candidates.push(c);
          } catch (e) { /* try the next candidate */ }
        }
      }
      if (typeof manager.getChannel === 'function') {
        try {
          const c = manager.getChannel('Default');
          if (c) candidates.push(c);
        } catch (e) { /* try the next candidate */ }
      }
      if (manager.channels && typeof manager.channels === 'object') {
        const c = manager.channels.Default || manager.channels['Default']
          || manager.channels[1] || manager.channels[0];
        if (c) candidates.push(c);
      }
      for (const channel of candidates) {
        if (!channel || typeof channel !== 'object') continue;
        const send = channel.send || channel.sendMessage || channel.sendChat
          || channel.message || channel.sendChannelMessage;
        if (typeof send === 'function') return { send: send.bind(channel), label: 'Default' };
      }
      return null;
    } catch (e) { return null; }
  }

  /** Anti-bot player context (PR5, REQ-33, D9): position (`__position`),
   *  teleport flag (`__teleported`), health and damage tint (`__damageTint`)
   *  over the live-probed candidate locations — feature-detected; absent
   *  fields report null and the watcher never invents events. */
  function readAntibotContext() {
    try {
      const p = state.gameClient && state.gameClient.player;
      if (!p) return { position: null, teleported: null, health: null, damageTint: null };
      const st = p.state && typeof p.state === 'object' ? p.state : {};
      const rawPos = st.__position || p.__position;
      let position = null;
      if (rawPos && typeof rawPos === 'object') {
        const x = Number(rawPos.x);
        const y = Number(rawPos.y);
        const z = Number(rawPos.z);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          position = { x, y, z: Number.isFinite(z) ? z : 0 };
        }
      }
      const teleported = (st.__teleported === true || p.__teleported === true) ? true : null;
      const rawHp = st.health !== undefined ? st.health : p.health;
      const health = Number.isFinite(Number(rawHp)) ? Number(rawHp) : null;
      const damageTint = (st.__damageTint === true || p.__damageTint === true) ? true : null;
      return { position, teleported, health, damageTint };
    } catch (e) { return { position: null, teleported: null, health: null, damageTint: null }; }
  }

  /** Player position reader (PR6, REQ-36): player.state.__position /
   *  p.__position over the live-probed locations (same surface the anti-bot
   *  context reads) — feature-detected; null when absent (the cavebot start
   *  degrades with 'no-position', never an invented location). */
  function readPosition() {
    try {
      const p = state.gameClient && state.gameClient.player;
      if (!p) return null;
      const st = p.state && typeof p.state === 'object' ? p.state : {};
      const rawPos = st.__position || p.__position;
      if (!rawPos || typeof rawPos !== 'object') return null;
      const x = Number(rawPos.x);
      const y = Number(rawPos.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    } catch (e) { return null; }
  }

  /** Ground-object list reader (PR6, REQ-36 open probe): feature-detected
   *  candidates over the live game surfaces; null when absent ("no object
   *  surface" — the walk-to-object action stays a no-op state, never an
   *  invented source). */
  function readObjects() {
    try {
      const gc = state.gameClient;
      const world = gc && gc.world;
      const cands = [world && world.objects, gc && gc.objects,
        world && world.groundObjects, gc && gc.groundObjects,
        gc && gc.interface && gc.interface.objects];
      for (const c of cands) {
        if (Array.isArray(c)) return c;
      }
      return null;
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
      getSpellCost: readRuneCost, // D2 (REQ-31): runes.reserve via canCast
      now: nowFn,
      log,
    });
    const training = TRAINING_MOD.createTraining({
      config: cfg.training,
      // D3 (REQ-30): the trainer absorbs the strict-CAP settings — the cap
      // fields live in the runes config shape (characters.ts defaults).
      capConfig: cfg.runes,
      readCap: readCap,
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
    // REQ-33/34 (PR5, D9): anti-bot watcher — reads the SAME Default-channel
    // surface as echo/learning (REQ-24 MODIFIED) + the player context; the
    // auto-reply send is feature-detected (degrade = alert-only). The
    // confirm-once session state lives in state.timers (survives rebuilds,
    // resets on agent restart — REQ-34 "per session").
    const antibot = ANTIBOT_MOD.createAntibotModule({
      config: cfg.antibot,
      playerName: function () { return (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null; },
      gameClient: state.gameClient,
      document: doc,
      readContext: readAntibotContext,
      readSend: readDefaultChannelSend,
      timers: state.timers,
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
    // REQ-35/36 (PR6, D10): state-only skeleton modules — attack targeting
    // + pickers config and the cavebot route recorder. NOT tree nodes: no
    // combat loop, no continuous auto-walking (getState discloses the
    // skeleton; the app-driven RPCs below drive record/start). The cavebot
    // recording buffer lives in state.timers (survives rebuilds).
    const attack = ATTACK_MOD.createAttackModule({ config: cfg.attack });
    const cavebot = CAVEBOT_MOD.createCavebotModule({
      config: cfg.cavebot,
      readPosition: readPosition,
      readObjects: readObjects,
      timers: state.timers,
      now: nowFn,
      recordIntervalMs: 100, // snapshot-loop cadence; the module throttles + dedupes
      log,
    });
    state.modules = {
      healItems: healItems, healMagic: healMagic, runes: runes, training: training, eat: eat,
      trade: trade, loot: loot, spawns: spawns, huntStats: huntStats, echo: echo, learning: learning,
      antibot: antibot, routes: routes, attack: attack, cavebot: cavebot,
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
            // happens ONLY inside the queue-dispatched closure. Priority
            // 'urgent' (D1, REQ-29): the heal jumps in-flight work.
            state.queue.enqueue(function () { healItems.fire(d.item); }, { kind: 'heal-item', priority: 'urgent' });
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
            // D1 (REQ-29): the heal carries priority 'urgent' from the module
            // decision — head-inserted before ANY normal entry, so it
            // preempts rune/training/attack work already in flight (the
            // queue defers that work to a later drain). Throttle + jitter
            // still apply at drain (REQ-12 — no bypass, ever).
            state.queue.enqueue(function () {
              healMagic.fire(d, { gameClient: state.gameClient, document: doc });
              // REQ-24 echo validation: words-path fires only (word configured);
              // direct casts without a word skip validation entirely.
              if (cfg.healMagic && typeof cfg.healMagic.word === 'string' && cfg.healMagic.word.trim()) {
                echo.startForFire('heal-magic', cfg.healMagic.word);
              }
              logEvent('healMagic', 'cast', d.reason || 'heal');
            }, { kind: 'heal-magic', priority: d.priority || 'normal' });
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
            // closure, never inline during the tree tick. Priority 'urgent'
            // (D1, REQ-29): the legacy survival heal also preempts in-flight
            // rune/training/attack work.
            state.queue.enqueue(function () {
              FIRING_MOD.fireSlot(cfg.survival.slot, {
                mode: 'handleClick',
                gameClient: state.gameClient,
                document: doc,
                log,
              });
              logEvent('survival', 'fire-slot', cfg.survival.slot);
            }, { kind: 'survival-heal', priority: 'urgent' });
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

    // REQ-16/30/32: training — cast-to-train cadence via the queue; a
    // training cast advances the every-N-casts food cadence (ctx.castsSinceFood).
    // The TRAINER decision may carry kind 'fallback' (REQ-30 cap-full) or
    // 'eat-magic' (REQ-32, D4) — each gets its own queue kind so re-arm
    // guards and the activity log stay distinct (normal eat is untouched).
    const trainingKind = (d) => (d.kind === 'eat-magic' ? 'eat-magic'
      : d.kind === 'fallback' ? 'training-fallback' : 'training-cast');
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
            return !state.queue.hasPending(function (e) { return e.kind === trainingKind(d); });
          },
        },
        {
          type: 'action',
          id: 'training-cast',
          run: function (ctx) {
            const d = training.decide(ctx);
            if (!d.fire) return false;
            const kind = trainingKind(d);
            state.queue.enqueue(function () {
              training.fire(d, { gameClient: state.gameClient, document: doc });
              // REQ-24 echo validation: only when a training word is configured
              // AND the action is a real training cast (fallback/eat-magic are
              // direct slot fires — no echo path).
              if (d.kind === 'training'
                && cfg.training && typeof cfg.training.word === 'string' && cfg.training.word.trim()) {
                echo.startForFire('training', cfg.training.word);
              }
              logEvent('training', kind, d.reason || null);
            }, { kind: kind });
            // The every-N-casts food cadence counts REAL training casts only.
            if (d.kind === 'training') ctx.castsSinceFood = (ctx.castsSinceFood || 0) + 1;
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

    // REQ-34 (PR5, D9): anti-bot auto-replies — the Default-channel send runs
    // ONLY inside a queue-dispatched closure (REQ-12 no-bypass). The watcher
    // (tickOnce observe) feeds the decision; when the send surface is absent
    // the module degrades to ALERT-ONLY (never an invented send path). Lowest
    // priority: a chat reply never pre-empts survival/combat (REQ-11).
    const antibotNode = {
      type: 'sequence',
      id: 'antibot',
      children: [
        {
          type: 'condition',
          id: 'antibot-feasible',
          predicate: function () {
            if (!cfg.antibot.on) return false;
            const d = antibot.decide();
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'antibot-reply'; });
          },
        },
        {
          type: 'action',
          id: 'antibot-send',
          run: function () {
            const d = antibot.decide();
            if (!d.fire) return false;
            // NO-BYPASS (REQ-12): the real channel send happens ONLY inside
            // the queue-dispatched closure.
            state.queue.enqueue(function () {
              const ok = antibot.fire(d);
              logEvent('antibot', 'reply', ok ? d.pattern : 'send-failed');
            }, { kind: 'antibot-reply' });
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
        // > eat > loot > trade > antibot (REQ-11: survival/heal always beats
        // combat/loot/training; trade broadcast and anti-bot replies are the
        // lowest-priority chat actions).
        children: [healItemsNode, healMagicNode, survival, runesNode, combat, trainingNode, eatNode, lootNode, tradeNode, antibotNode],
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
      // REQ-33/34 (PR5): anti-bot watcher — the SAME Default-channel poll as
      // echo/learning (REQ-24 MODIFIED) + the player context; alerts ride the
      // snapshot, confirmed patterns queue auto-replies for the tree node.
      if (m.antibot) m.antibot.observe();
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

  /* ------------------ PR6 cavebot recording loop (REQ-36) ------------------ */

  /** Passive route-recording sampler: while the cavebot module records, read
   *  the player position on a cadence and let the module throttle/dedupe the
   *  snapshots (REQ-36 "throttled position snapshots"). NOT a tree action and
   *  NOT a game call — a pure read loop. Session-scoped: the timer survives
   *  config rebuilds (the module state lives in state.timers) and is
   *  disarmed on stop/destroy (agent restart = new session). */
  let recordTimer = null;

  function armRecordLoop() {
    if (recordTimer !== null || !setIntervalFn) return;
    recordTimer = setIntervalFn(function () {
      const m = state.modules && state.modules.cavebot;
      if (!m || !m.isRecording()) { disarmRecordLoop(); return; }
      m.record(readPosition());
    }, 750);
  }

  function disarmRecordLoop() {
    if (recordTimer !== null) {
      clearIntervalFn(recordTimer);
      recordTimer = null;
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
      confirmAntibot: function (pattern) {
        // REQ-34 (PR5): user confirmation on a pending anti-bot pattern — the
        // module moves it to session-confirmed (state.timers), enabling
        // auto-replies for later occurrences. Refused pre-Connect (REQ-02).
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.antibot;
        if (!m) return { ok: false, reason: 'not ready' };
        return m.confirm(pattern);
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
      startRouteRecording: function () {
        // REQ-36 (PR6): begin cavebot route recording — the passive position
        // sampler loop arms here (REQ-12 untouched: this loop never touches
        // game handlers). REQ-02 gate like every RPC.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.cavebot;
        if (!m) return { ok: false, reason: 'not ready' };
        const res = m.startRecording();
        if (res.ok) armRecordLoop();
        return res;
      },
      stopRouteRecording: function () {
        // REQ-36 (PR6): stop recording and return the recorded waypoints
        // (plain {x,y} — the panel saves them into config.routes).
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.cavebot;
        if (!m) return { ok: false, reason: 'not ready' };
        const res = m.stopRecording();
        if (res.ok) disarmRecordLoop();
        return res;
      },
      cavebotStart: function () {
        // REQ-36 (PR6): start from the NEAREST recorded waypoint (euclidean
        // min) via the game's NATIVE autowalk primitive only (REQ-23 surface,
        // never synthetic per-step input). REQ-02 gate + REQ-12 no-bypass:
        // the native call happens ONLY inside a queue-dispatched closure.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.cavebot;
        if (!m) return { ok: false, reason: 'not ready' };
        const d = m.decideStart();
        if (!d.fire) return { ok: false, reason: d.reason };
        const pf = readPathfinder();
        const method = pf ? ROUTES_MOD.resolveWalkToMethod(pf) : null;
        if (!pf || !method) return { ok: false, reason: 'no walk-to method' };
        state.queue.enqueue(function () {
          try {
            method.call(pf, d.x, d.y);
            logEvent('cavebot', 'start', 'waypoint ' + d.index + ' (' + d.x + ',' + d.y + ')');
          } catch (e) {
            log.warn('cavebot: start walk failed: ' + (e && e.message ? e.message : e));
          }
        }, { kind: 'cavebot-start' });
        return {
          ok: true,
          waypoint: d.index,
          x: d.x,
          y: d.y,
          distance: d.distance,
          method: method.name || 'native-autowalk',
          queued: true,
        };
      },
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
    disarmRecordLoop(); // PR6 (REQ-36): the route sampler is session-scoped
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
        // REQ-30 (D3): the trainer's cap state (capFull) rides the snapshot
        // so the panel raises the ALERT + beep on the rising edge.
        training: modules.training ? modules.training.getState() : null,
        eat: modules.eat ? modules.eat.getState() : null,
        trade: modules.trade ? modules.trade.getState() : null,
        loot: modules.loot ? modules.loot.getState() : null,
        spawns: modules.spawns ? modules.spawns.getState() : null,
        huntStats: modules.huntStats ? modules.huntStats.getState() : null,
        echo: modules.echo ? modules.echo.getState() : null,
        learning: modules.learning ? modules.learning.getState() : null,
        antibot: modules.antibot ? modules.antibot.getState() : null, // PR5 (REQ-33/34): alerts + pending confirm
        routes: modules.routes ? modules.routes.getState() : null,
        // PR6 (REQ-35/36): state-only skeleton flags — attack targeting +
        // pickers; cavebot recording/saved-route/pause/start + object walk.
        attack: modules.attack ? modules.attack.getState() : null,
        cavebot: modules.cavebot ? modules.cavebot.getState() : null,
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
