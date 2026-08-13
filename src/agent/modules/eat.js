'use strict';

/**
 * Eat module (REQ-17, design "Eat" row).
 *
 * Optional, user-activated. Food management adapted from the PROVEN userscript
 * logic (readFoodState / resolveFoodItem / every-N-casts rule in
 * tools/build-userscript.js) to the desktop agent context:
 *
 *  - SATED detection: `player.conditions.has('SATED')` primary, then the
 *    `#skill-window div[skill="food"] .skill` timer (core/sated) as fallback.
 *  - Decision (PR 3 unified shape, design "comida unificada" — REQ-01..06):
 *      1. magicBusy (food machine mid-cycle) => structural no-double-eat:
 *         NEVER falls through to normal food (REQ-05).
 *      2. magic-first: configured magic (enabled + valid slot/sid + LIVE
 *         hotbar still resolves the F-slot, derived never typed) AND hungry
 *         (SATED flag/timer read != false) OR the safety net elapsed =>
 *         request magic food (kind 'eat-magic'). Sated => wait.
 *      3. normal: everyCasts is an OR trigger (force cadence, 0=off, never a
 *         gate) / SATED false => eat / safety net => eat / SATED true =>
 *         sated / else the configurable fallback interval (default 10s).
 *     Safety net = now() - lastEatAt >= safetyNetMinutes*60_000, the
 *     universal floor that fires regardless of SATED (REQ-04).
 *     Magic failure => noteMagicUnavailable() arms a retry window
 *     (safetyNetMinutes); the NORMAL path serves until it passes
 *     (REQ-03 timeout => fallback).
 *  - Attempt: the proven adapters/eat eater — contextmenu -> "Use" on the
 *    food slot element, with `mouse.use` fallback; 3 consecutive failures
 *    pause eating + surface a panel-facing alert through the module state and
 *    the agent log (REQ-17).
 *  - Food source: `config.slot` (userscript-style backpack index) or
 *    `config.cids` (cid search over the probe-order container sources,
 *    core/items). Both absent => 'no-food-source', no action.
 *  - The magic FOOD CONFIRMATION MACHINE stays in training.js (REQ-02 —
 *    never rewritten). eat.js requests + observes through the injected
 *    facade getters (foodCycle/foodMagicPending) and the noteMeal /
 *    noteMagicUnavailable callbacks the bootstrap food node drives.
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 */

const SATED_MOD = require('../../core/sated');
const EAT_MOD = require('../../adapters/eat');
const { readContainers, findSlotByCid } = require('../../core/items');

/**
 * Create the eat module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized eat config
 *   { on: boolean, everyCasts: number, warningWindowSec: number,
 *     fallbackIntervalSec: number, safetyNetMinutes: number,
 *     slot: number|null, cids: Array<number>,
 *     magic: { enabled: boolean, slot: number|null, sid: number|null } }
 * @param {() => object|null} [opts.gameClient] - live gameClient accessor
 *   (the eater's mouse.use fallback is lazy through this getter)
 * @param {Document|null} [opts.document] - page DOM (timer + contextmenu)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @param {(slot: number) => number|null} [opts.readHotbarSlotSid] - live
 *   hotbar reader: magic is available ONLY when the configured F-slot still
 *   maps the configured sid (derived, never typed)
 * @param {() => string} [opts.foodCycle] - training machine cycle getter
 *   ('idle' when the machine is not mid-cycle)
 * @param {() => boolean} [opts.foodMagicPending] - training machine
 *   pending-cast getter (true while a magic food cast is in flight)
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, kind?: string, force?: boolean},
 *   fire: (ctx: object, decision: object) => boolean,
 *   noteMeal: (ctx?: object) => void,
 *   noteMagicUnavailable: () => void,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createEatModule(opts = {}) {
  const {
    config, gameClient = null, document: doc = null, now = Date.now, log = {},
    readHotbarSlotSid = null, foodCycle = null, foodMagicPending = null,
  } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  /** Live gameClient (lazy accessor or plain object). */
  function gcNow() {
    return typeof gameClient === 'function' ? gameClient() : gameClient;
  }

  /** Safety-net window in ms (default 20 min, design unified shape). */
  function safetyNetMs() {
    return (Number(config && config.safetyNetMinutes) || 20) * 60 * 1000;
  }

  /**
   * Derived magic availability (REQ-01/03): enabled + valid F-slot(1-12) +
   * valid sid + the LIVE hotbar still resolves the configured slot to the
   * configured sid. An unresolvable F-slot disables magic safely (mirrors
   * hotbarSlotForSpell degrade) — the module never types a stale slot.
   * @returns {{available: boolean, sid: number|null}}
   */
  function magicConfig() {
    const mg = config && config.magic && typeof config.magic === 'object' ? config.magic : {};
    const slot = Number(mg.slot);
    const sid = Number(mg.sid);
    if (mg.enabled !== true || !Number.isInteger(slot) || slot < 1 || slot > 12 || !Number.isInteger(sid)) {
      return { available: false, sid: null };
    }
    let liveSid = null;
    if (typeof readHotbarSlotSid === 'function') {
      try { liveSid = Number(readHotbarSlotSid(slot)); } catch (e) { liveSid = null; }
    }
    if (liveSid !== sid) return { available: false, sid: null };
    return { available: true, sid };
  }

  /**
   * Proven userscript readFoodState (adapted): SATED flag primary,
   * #skill-window food timer fallback, {eat:null} when both unavailable.
   * @returns {{eat: boolean|null, source: string, sated: boolean|null, timerSec: number|null}}
   */
  function readFoodState() {
    let sated = null;
    try {
      const conditions = gcNow() && gcNow().player && gcNow().player.conditions;
      if (conditions && typeof conditions.has === 'function') {
        sated = conditions.has('SATED') === true;
      }
    } catch (e) { sated = null; }
    let timerEl = null;
    try { timerEl = doc && doc.querySelector('#skill-window div[skill="food"] .skill'); } catch (e) { timerEl = null; }
    let timerSec = null;
    if (timerEl) timerSec = SATED_MOD.parseFoodTimer(timerEl.textContent); // null = expired/unparseable
    if (sated === true) return { eat: false, source: 'sated', sated, timerSec };
    if (sated === false) return { eat: true, source: 'flag', sated, timerSec };
    if (timerEl) {
      return {
        eat: timerSec === null || timerSec <= (config.warningWindowSec || 60),
        source: timerSec === null ? 'expired' : 'timer',
        sated: null,
        timerSec,
      };
    }
    return { eat: null, source: 'none', sated: null, timerSec: null }; // fallback interval
  }

  /**
   * Proven userscript resolveFoodItem (adapted): food slot element by
   * config.slot index, plus the cid-search path over the probe-order
   * container sources. @returns {{element: object|null, index: number|null, cid: number|null}}
   */
  function resolveFoodItem() {
    const gc = gcNow();
    const cids = (config.cids || []).map(Number).filter(Number.isFinite);
    if (cids.length > 0) {
      const hit = findSlotByCid(readContainers(gc), cids);
      if (hit) return { element: hit.element, index: hit.index, cid: cids[0] };
    }
    const slotIndex = Number(config.slot);
    if (Number.isInteger(slotIndex) && slotIndex >= 1) {
      let element = null;
      try {
        const containers = readContainers(gc);
        for (let c = 0; c < containers.length; c++) {
          const slots = containers[c] && containers[c].slots;
          if (slots && Array.isArray(slots)) {
            const slot = slots[slotIndex - 1];
            if (slot) {
              element = slot.element || (slot.canvas && slot.canvas.canvas) || null;
              if (element) break;
            }
          }
        }
      } catch (e) { element = null; }
      if (!element) {
        try {
          const root = doc && doc.querySelector('#container-prototype');
          if (root) {
            const nodes = root.querySelectorAll('.slot, [data-slot], [class*="slot"]');
            element = nodes[slotIndex - 1] || nodes[slotIndex] || null;
          }
        } catch (e) { element = null; }
      }
      return { element, index: slotIndex, cid: null };
    }
    return { element: null, index: null, cid: null };
  }

  // The proven eater does the attempt + failure accounting + pause.
  // gameClient is LAZY (getter object) so the mouse.use fallback sees the
  // live client even though the eater is constructed before readiness.
  const eaterGameClient = {
    get mouse() { const gc = gcNow(); return gc ? gc.mouse : undefined; },
  };
  const state = {
    paused: false, alert: null, lastEatAt: 0,
    foodCreated: 0, source: null, magicRetryAfter: null,
  };
  const eater = EAT_MOD.createEater({
    gameClient: eaterGameClient,
    document: doc,
    isSated: () => readFoodState().sated,
    maxFailures: 3,
    setPaused: (p) => { state.paused = p; },
    hudAlert: (m) => { state.alert = m; warn(m); },
    log,
  });

  /**
   * Pure decision (REQ-17 + PR 3 unified flow, REQ-01..06).
   * @param {object} ctx - tick context { castsSinceFood, lastEatAt }
   * @returns {{fire: boolean, reason: string, kind?: 'eat'|'eat-magic', force?: boolean}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    if (eater.isPaused()) return { fire: false, reason: 'paused' };
    // magicBusy: while the food confirmation machine owns a cycle (cast in
    // flight OR created food pending consumption) NOTHING else may eat —
    // structurally one meal per cycle (REQ-05 no-double-eat). The magic
    // machine steps itself via the bootstrap food node; this branch NEVER
    // falls through to the normal path.
    const cycle = typeof foodCycle === 'function' ? foodCycle() : 'idle';
    const pending = typeof foodMagicPending === 'function' ? foodMagicPending() : false;
    if (cycle !== 'idle' || pending) return { fire: false, reason: 'magic-cycle-active' };

    const fs = readFoodState();
    const lastEatAt = Number(ctx.lastEatAt) || state.lastEatAt || 0;
    const safetyDue = now() - lastEatAt >= safetyNetMs();
    const magic = magicConfig();
    const magicBlocked = state.magicRetryAfter !== null && now() < state.magicRetryAfter;

    if (magic.available && !magicBlocked) {
      // Magic-first (REQ-01): unknown hunger counts as hungry (the cast ->
      // confirm -> consume cycle IS the meal); the safety net is the
      // universal floor regardless of SATED (REQ-04).
      if (fs.eat !== false || safetyDue) {
        return {
          fire: true, kind: 'eat-magic',
          reason: fs.eat === true ? fs.source : safetyDue ? 'safety-net' : 'hunger',
          force: false,
        };
      }
      return { fire: false, reason: 'sated' };
    }

    // Normal path (REQ-03 fallback): everyCasts is an OR trigger — forced
    // cadence at N (0 = off), but never a GATE: hunger/safety net/fallback
    // all still apply below N (REQ-06).
    const everyCasts = Number(config.everyCasts) || 0;
    if (everyCasts > 0 && (ctx.castsSinceFood || 0) >= everyCasts) {
      return { fire: true, kind: 'eat', reason: 'every-casts', force: true };
    }
    if (fs.eat === true) return { fire: true, kind: 'eat', reason: fs.source, force: false };
    if (safetyDue) return { fire: true, kind: 'eat', reason: 'safety-net', force: false };
    if (fs.eat === false) return { fire: false, reason: 'sated' };
    // SATED + timer both unavailable => fallback interval (default 10s).
    const elapsed = now() - lastEatAt;
    if (elapsed >= (config.fallbackIntervalSec || 10) * 1000) {
      return { fire: true, kind: 'eat', reason: 'fallback-interval', force: false };
    }
    return { fire: false, reason: 'fallback-wait' };
  }

  /**
   * Execute the eat attempt (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {object} ctx - tick context (mutated: castsSinceFood / lastEatAt)
   * @param {{force?: boolean, kind?: string}} decision - decided attempt
   * @returns {boolean} true when the attempt executed
   */
  function fire(ctx = {}, decision = {}) {
    const item = resolveFoodItem();
    const res = eater.eatFood(item, { force: decision.force === true });
    if (decision.force === true) ctx.castsSinceFood = 0; // forced cadence resets after the attempt (userscript semantics)
    if (res.result === 'ate') {
      state.lastEatAt = now(); // stale-field fix (PR 3): module state mirrors the ctx anchor
      ctx.lastEatAt = state.lastEatAt;
      state.source = 'normal';
    }
    return res.result === 'ate';
  }

  /**
   * A magic-created meal was confirmed consumed (the machine's
   * 'created-food-consumed' final step): count it, anchor the meal clock and
   * remember the source (PR 3, Comida card state).
   * @param {object} [ctx] - tick context (lastEatAt anchored when passed)
   */
  function noteMeal(ctx = {}) {
    state.foodCreated += 1;
    state.lastEatAt = now();
    if (ctx && typeof ctx === 'object') ctx.lastEatAt = state.lastEatAt;
    state.source = 'magic';
  }

  /**
   * The magic machine blocked (creation timeout / consume failure): the
   * NORMAL path serves until the next safety-net window, then magic re-arms
   * (REQ-03 timeout => fallback).
   */
  function noteMagicUnavailable() {
    state.magicRetryAfter = now() + safetyNetMs();
  }

  /** @returns {object} module state (pause/alert + PR 3 unified fields) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      paused: eater.isPaused(),
      failures: eater.getFailures(),
      alert: state.alert,
      lastEatAt: state.lastEatAt,
      foodCreated: state.foodCreated, // cumulative session total (Comida card)
      nextMealAt: state.lastEatAt > 0 ? state.lastEatAt + safetyNetMs() : null,
      safetyNetMinutes: Number(config && config.safetyNetMinutes) || 20,
      magicSid: magicConfig().sid,
      source: state.source,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, noteMeal, noteMagicUnavailable, getState, isEnabled };
}

module.exports = { createEatModule };
