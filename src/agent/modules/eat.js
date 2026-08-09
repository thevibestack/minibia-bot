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
 *  - Decision (mirrors the userscript eat rule):
 *      1. everyCasts > 0 => forced cadence: eat when N confirmed casts have
 *         landed since the last forced eat; SATED/timer pre-checks BYPASSED
 *         (force mode), the counter resets after the attempt.
 *      2. else: eat when SATED is false ('flag'), when the timer is expired
 *         or <= warningWindowSec, or (SATED + timer both unavailable) when the
 *         configurable fallback interval (default 10s) has elapsed.
 *  - Attempt: the proven adapters/eat eater — contextmenu -> "Use" on the
 *    food slot element, with `mouse.use` fallback; 3 consecutive failures
 *    pause eating + surface a panel-facing alert through the module state and
 *    the agent log (REQ-17).
 *  - Food source: `config.slot` (userscript-style backpack index) or
 *    `config.cids` (cid search over the probe-order container sources,
 *    core/items). Both absent => 'no-food-source', no action.
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
 *     fallbackIntervalSec: number, slot: number|null, cids: Array<number> }
 * @param {() => object|null} [opts.gameClient] - live gameClient accessor
 *   (the eater's mouse.use fallback is lazy through this getter)
 * @param {Document|null} [opts.document] - page DOM (timer + contextmenu)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, force?: boolean},
 *   fire: (ctx: object, decision: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createEatModule(opts = {}) {
  const { config, gameClient = null, document: doc = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  /** Live gameClient (lazy accessor or plain object). */
  function gcNow() {
    return typeof gameClient === 'function' ? gameClient() : gameClient;
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
  const state = { paused: false, alert: null, lastEatAt: 0 };
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
   * Pure decision (REQ-17).
   * @param {object} ctx - tick context { castsSinceFood, lastEatAt }
   * @returns {{fire: boolean, reason: string, force?: boolean}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    if (eater.isPaused()) return { fire: false, reason: 'paused' };
    const everyCasts = Number(config.everyCasts) || 0;
    if (everyCasts > 0) {
      // Forced cadence: SATED/timer pre-checks bypassed (REQ-17 scenario 3).
      if ((ctx.castsSinceFood || 0) >= everyCasts) return { fire: true, reason: 'every-casts', force: true };
      return { fire: false, reason: 'waiting-casts' };
    }
    const fs = readFoodState();
    if (fs.eat === true) return { fire: true, reason: fs.source, force: false };
    if (fs.eat === false) return { fire: false, reason: 'sated' };
    // SATED + timer both unavailable => fallback interval (default 10s).
    const elapsed = now() - (ctx.lastEatAt || 0);
    if (elapsed >= (config.fallbackIntervalSec || 10) * 1000) {
      return { fire: true, reason: 'fallback-interval', force: false };
    }
    return { fire: false, reason: 'fallback-wait' };
  }

  /**
   * Execute the eat attempt (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {object} ctx - tick context (mutated: castsSinceFood / lastEatAt)
   * @param {{force?: boolean}} decision - decided attempt (force = cadence mode)
   * @returns {boolean} true when the attempt executed
   */
  function fire(ctx = {}, decision = {}) {
    const item = resolveFoodItem();
    const res = eater.eatFood(item, { force: decision.force === true });
    if (decision.force === true) ctx.castsSinceFood = 0; // forced cadence resets after the attempt (userscript semantics)
    if (res.result === 'ate') ctx.lastEatAt = now();
    return res.result === 'ate';
  }

  /** @returns {object} module state (pause/alert surfacing, REQ-17) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      paused: eater.isPaused(),
      failures: eater.getFailures(),
      alert: state.alert,
      lastEatAt: state.lastEatAt,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, getState, isEnabled };
}

module.exports = { createEatModule };
