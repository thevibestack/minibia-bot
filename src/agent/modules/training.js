'use strict';

/**
 * Magic training module (REQ-16, design "Training" row).
 *
 * Optional, user-activated. Repeats casts of the configured training spell at
 * the safe cadence imposed by the Action Queue + jitter (REQ-12/16 — one cast
 * per queue slot, never faster). Gates (in evaluation order):
 *   1. Vocation gate: live-probed `hotbarManager.__canPlayerCastSpell(sid)`
 *      (obs 10320). Feature-absent (null) => gate skipped, never blocks.
 *   2. Mana feasibility: cost resolved from the client (spellbook first, then
 *      the live-probed `interface.getSpell(sid)` — obs 10320: spellbook is
 *      empty). Unknown cost => pause ('no-cost', safe). Below cost+reserve =>
 *      pause until mana recovers (REQ-16).
 *   3. Cooldowns: per-spell + GLOBAL_COOLDOWN via core/cooldown.
 * Echo validation is deliberately NOT applied to training casts (REQ-16: echo
 * "MAY be disabled for training" — disabled here; the __handleClick path
 * produces no echo anyway).
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 * Training casts advance the every-N-casts food cadence (ctx.castsSinceFood)
 * so the eat module counts them like combat casts.
 */

const FEAS_MOD = require('../../core/feasibility');
const CD_MOD = require('../../core/cooldown');
const FIRING_MOD = require('../../adapters/firing');

/**
 * Create the training decision module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized training config
 *   { on: boolean, slot: number|null, sid: number|null, reserve: number }
 * @param {(sid: number|null) => number|null} [opts.getSpellCost] - cost
 *   resolver; null = unknown (pause)
 * @param {(sid: number|null) => boolean|null} [opts.canCastSpell] - live
 *   vocation gate; null = feature absent (skipped)
 * @param {(sid: number|null) => {cooldown: object|null, globalCooldown: object|null}}
 *   [opts.readCooldown] - client cooldown reader
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, slot?: number},
 *   fire: (decision: object, deps: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createTraining(opts = {}) {
  const { config, getSpellCost = null, canCastSpell = null, readCooldown = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const warned = new Set();

  const state = { lastFiredAt: 0, lastReason: null };

  /**
   * Pure decision (REQ-16): cast while the vocation gate passes and mana
   * feasibility holds; pause below cost+reserve.
   * @param {object} ctx - tick context { mana, maxMana }
   * @returns {{fire: boolean, reason: string, slot?: number}}
   */
  function decide(ctx = {}) {
    state.lastReason = null;
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const slot = Number(config.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return { fire: false, reason: 'no-slot' };

    // Vocation gate (live-probed hotbarManager.__canPlayerCastSpell).
    if (typeof canCastSpell === 'function') {
      try {
        if (canCastSpell(config.sid) === false) return { fire: false, reason: 'vocation-gate' };
      } catch (e) { /* gate read failure => skip the gate, never block */ }
    }

    // Mana feasibility: pause below cost+reserve (REQ-16).
    const cost = typeof getSpellCost === 'function' ? getSpellCost(config.sid) : null;
    if (cost === null) return { fire: false, reason: 'no-cost' };
    const feas = FEAS_MOD.canCast({
      mana: ctx.mana,
      cost,
      reserve: Number(config.reserve) || 0,
      maxMana: ctx.maxMana,
      key: 'training-' + slot,
      warned,
      onWarn: warn,
    });
    if (!feas.fire) {
      return { fire: false, reason: feas.reason === 'reserve' ? 'reserve' : 'insufficient' };
    }

    if (typeof readCooldown === 'function') {
      const cd = readCooldown(config.sid) || {};
      const verdict = CD_MOD.canFire({
        cooldown: cd.cooldown,
        globalCooldown: cd.globalCooldown,
        cooldownMs: 0,
        lastFiredAt: null,
        now: now(),
        onGapLog: null,
      });
      if (!verdict.fire) {
        return { fire: false, reason: verdict.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown' };
      }
    }

    state.lastReason = 'train';
    return { fire: true, reason: 'train', slot };
  }

  /**
   * Execute the training cast (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{slot: number}} decision - decided slot
   * @param {object} deps - { gameClient, document } for the firing adapter
   * @returns {boolean} true when __handleClick executed
   */
  function fire(decision, deps = {}) {
    const slot = Number(decision.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return false;
    state.lastFiredAt = now();
    return FIRING_MOD.fireSlot(slot, {
      mode: 'handleClick',
      gameClient: deps.gameClient,
      document: deps.document,
      log,
    });
  }

  /** @returns {object} module state (surface/getState visibility) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      lastFiredAt: state.lastFiredAt,
      lastReason: state.lastReason,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, getState, isEnabled };
}

module.exports = { createTraining };
