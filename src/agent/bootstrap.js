'use strict';

/**
 * In-page agent bootstrap for the CDP-injected desktop app (REQ-04/10/11/12,
 * design D2/D3/D4).
 *
 * SLICE 2 SKELETON — this slice proves the engine SHAPE end to end:
 *
 *   gameClient + hotbarManager ready
 *        -> tree (Selector[survival, combat, loot]) ticks in-page at jittered
 *           cadence, reads stats into the shared ctx
 *        -> the tree executes AT MOST ONE action per tick (REQ-10)
 *        -> every action dispatches through the ONE global Action Queue
 *           (REQ-12, no bypass: game handlers are invoked ONLY inside
 *           queue-dispatched closures)
 *
 * The survival branch is a SAMPLE leaf (config.survival: hp <= threshold ->
 * fireSlot on the configured hotbar slot). The combat branch wraps the
 * EXISTING rotation engine (src/core/rotation.js) unchanged as the COMBAT
 * node (design D4): its rule actions enqueue through the same queue. The
 * loot branch is a stub that always fails (loot module lands in slice 5).
 * Real module wiring (heal-items, eat, runes, trade, ...) lands with the
 * module slices (4/5/6) — this slice only proves the wiring contract.
 *
 * Exposes window.__mbAgent with the REQ-04 surface:
 *   { readStats, readCooldown, fireSlot, eatFood, getChat,
 *     getRuneState, getWalkState, getPlayerInfo, applyConfig }
 * Modules that land later return null / "unavailable" until wired.
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

/** Minimal slice-2 config shape (per-character store lands in slice 3). */
const DEFAULT_CONFIG = {
  queue: { minIntervalMs: 150 },
  jitter: { min: 50, max: 400 },
  survival: { on: true, threshold: 50, slot: null }, // sample leaf — slice 4 real module
  rotation: { spells: [] },                          // combat leaf rules (userscript shape)
};

/** Deep-ish merge of known keys over the defaults (unknown keys dropped). */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: true, threshold: 50, slot: null },
    rotation: { spells: [] },
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
  const log = opts.log || {
    error: (m) => { state.errors.push(String(m)); try { if (win && win.console) win.console.error('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    warn: (m) => { state.warnings.push(String(m)); try { if (win && win.console) win.console.warn('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    info: (m) => { try { if (win && win.console) win.console.info('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
  };

  const state = {
    ready: false,
    running: false,
    destroyed: false,
    gameClient: null,
    config: null,
    tree: null,
    queue: null,
    engine: null,
    ctx: {},
    ticker: null,
    pollTimer: null,
    pollCount: 0,
    lastPath: [],
    lastDispatch: [],
    warnings: [],
    errors: [],
  };

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
    } catch (e) { cost = null; }
    if ((cost === null || !Number.isFinite(cost)) && Number.isFinite(Number(spell.cost))) cost = Number(spell.cost);
    return cost !== null && Number.isFinite(cost) ? cost : null;
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

  /** Rebuild tree + queue from the current config (applyConfig path). */
  function rebuild(cfg) {
    state.config = cfg;
    state.ctx = { mana: null, maxMana: null, health: null, lastFiredAt: {} };
    state.queue = createQueue({
      minInterval: cfg.queue.minIntervalMs,
      jitter: cfg.jitter,
      now: nowFn,
      rng,
      dispatch: function (fn) { fn(); }, // the ONLY game-handler invocation point
    });
    state.engine = ROTATION_MOD.createEngine({ rules: buildCombatRules(cfg), ctx: state.ctx });
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
            }, { kind: 'survival-heal' });
            return true;
          },
        },
      ],
    };
    const combat = {
      type: 'action',
      id: 'combat',
      run: function (ctx) {
        const result = state.engine.tick(); // at most one rule per tick (rotation semantics)
        return Boolean(result.fired);
      },
    };
    const loot = {
      type: 'sequence',
      id: 'loot',
      children: [
        { type: 'condition', id: 'loot-feasible', predicate: function () { return false; } }, // slice 5
        { type: 'action', id: 'loot-collect', run: function () { return false; } },
      ],
    };
    state.tree = createTree({
      root: {
        type: 'selector',
        id: 'priority-root',
        children: [survival, combat, loot], // survival > combat > loot (REQ-11)
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
   *  queue-aware and enqueue themselves — REQ-12 no-bypass). */
  function tickOnce() {
    if (!state.ready || !state.running || state.destroyed) return null;
    try {
      const stats = GC_MOD.readStats({ gameClient: state.gameClient, document: doc });
      const ctx = state.ctx;
      if (stats.mana !== null) ctx.mana = stats.mana;
      if (stats.maxMana !== null) ctx.maxMana = stats.maxMana;
      ctx.health = stats.health;
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
      const table = win && win.__VOCATION_NAMES;
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
        // REQ-12 no-bypass: even app-driven RPC fires go through the queue.
        state.queue.enqueue(function () {
          FIRING_MOD.fireSlot(slot, {
            mode: mode || 'handleClick',
            gameClient: state.gameClient,
            document: doc,
            log,
          });
        }, { kind: 'rpc-fire-slot-' + slot });
        return true;
      },
      eatFood: function () { return { result: 'unavailable', reason: 'eat module lands in slice 4' }; },
      getChat: function () { return CHAT_MOD.getRecentMessages({ gameClient: state.gameClient, document: doc }); },
      getRuneState: function () { return null; }, // slice 4
      getWalkState: function () { return null; }, // slice 6
      getPlayerInfo: readPlayerInfo,
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
    return {
      ready: state.ready,
      running: state.running,
      playerName: (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null,
      health: state.ctx.health,
      mana: state.ctx.mana,
      queue: state.queue ? state.queue.stats() : null,
      lastPath: state.lastPath,
      warnings: state.warnings.slice(),
      errors: state.errors.slice(),
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
