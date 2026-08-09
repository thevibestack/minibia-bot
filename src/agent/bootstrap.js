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
// Slice-4 modules (REQ-13..17) — pure decision modules, tree-wired below.
const HEAL_ITEMS_MOD = require('./modules/heal-items');
const HEAL_MAGIC_MOD = require('./modules/heal-magic');
const RUNES_MOD = require('./modules/runes');
const TRAINING_MOD = require('./modules/training');
const EAT_MODULE_MOD = require('./modules/eat');

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
  healMagic: { on: false, threshold: 150, slot: null, sid: null },
  runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null },
  training: { on: false, slot: null, sid: null, reserve: 0 },
  eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
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
    healMagic: { on: false, threshold: 150, slot: null, sid: null },
    runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null },
    training: { on: false, slot: null, sid: null, reserve: 0 },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
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
  const log = opts.log || {
    error: (m) => { state.errors.push(String(m)); try { if (win && win.console) win.console.error('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    warn: (m) => { state.warnings.push(String(m)); try { if (win && win.console) win.console.warn('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    info: (m) => { try { if (win && win.console) win.console.info('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
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
    state.modules = { healItems: healItems, healMagic: healMagic, runes: runes, training: training, eat: eat };

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
            state.queue.enqueue(function () { eat.fire(ctx, d); }, { kind: 'eat' });
            return true;
          },
        },
      ],
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
        // heal (items + magic + legacy slot-heal) > runes > combat > training
        // > eat > loot (REQ-11: survival/heal always beats combat/loot/training).
        children: [healItemsNode, healMagicNode, survival, runesNode, combat, trainingNode, eatNode, loot],
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
        }, { kind: 'eat-rpc' });
        return { result: 'queued' };
      },
      getChat: function () { return CHAT_MOD.getRecentMessages({ gameClient: state.gameClient, document: doc }); },
      getRuneState: function () {
        const m = state.modules && state.modules.runes;
        return m ? m.getState() : null; // REQ-15 real module state (slice 4)
      },
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
      },
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
