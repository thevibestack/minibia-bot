'use strict';

/**
 * Heal-with-magic module (REQ-14, design "Heal magic" row).
 *
 * Optional, user-activated. Decision: when health is at or below the
 * configured threshold, cast the configured heal spell on the hotbar slot via
 * the game's own spell path. Gates (in evaluation order):
 *   1. Vocation gate: live-probed `hotbarManager.__canPlayerCastSpell(sid)`
 *      (obs 10320 — checks the vocation). Feature-absent (null) => gate
 *      skipped, never blocks.
 *   2. Mana feasibility (core/feasibility, REQ-01 semantics): the spell cost
 *      is resolved from the client — spellbook first, then the live-probed
 *      `interface.getSpell(sid)` (probed: spellbook is empty for Druid
 *      Flamamex, obs 10320). Unknown cost => no fire ('no-cost', safe).
 *   3. Cooldowns: per-spell + GLOBAL_COOLDOWN via core/cooldown (REQ-14:
 *      GLOBAL_COOLDOWN defers to a later tick).
 * Echo validation (REQ-24) applies to words-path fires; the direct
 * __handleClick path produces no echo, so per REQ-24 validation is skipped for
 * this slice (design degrade "echo skip on direct cast" — echo carry-over
 * lands with slice 5.6).
 *
 * The fire() function runs ONLY inside a queue-dispatched closure (REQ-12
 * no-bypass) and calls `hotbarManager.__handleClick(slot)` via the proven
 * adapters/firing path.
 */

const FEAS_MOD = require('../../core/feasibility');
const CD_MOD = require('../../core/cooldown');
const FIRING_MOD = require('../../adapters/firing');

/**
 * Create the heal-magic decision module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized healMagic config
 *   { on: boolean, threshold: number, slot: number|null, sid: number|null }
 * @param {(sid: number|null) => number|null} [opts.getSpellCost] - cost
 *   resolver (client spellbook / interface.getSpell); null = unknown
 * @param {(sid: number|null) => boolean|null} [opts.canCastSpell] - live
 *   vocation gate; null = feature absent (skipped)
 * @param {(sid: number|null) => {cooldown: object|null, globalCooldown: object|null}}
 *   [opts.readCooldown] - client cooldown reader (adapters/gameClient)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, slot?: number},
 *   fire: () => boolean,
 *   isEnabled: () => boolean,
 * }}
 */
function createHealMagic(opts = {}) {
  const { config, getSpellCost = null, canCastSpell = null, readCooldown = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const warned = new Set();

  /**
   * Pure decision (REQ-14).
   * @param {object} ctx - tick context { health, mana, maxMana }
   * @returns {{fire: boolean, reason: string, slot?: number}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const threshold = Number(config.threshold);
    if (!Number.isFinite(threshold)) return { fire: false, reason: 'no-threshold' };
    if (ctx.health === null || ctx.health === undefined) return { fire: false, reason: 'no-health' };
    if (ctx.health > threshold) return { fire: false, reason: 'healthy' };
    const slot = Number(config.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return { fire: false, reason: 'no-slot' };

    // Vocation gate (live-probed hotbarManager.__canPlayerCastSpell).
    if (typeof canCastSpell === 'function') {
      try {
        if (canCastSpell(config.sid) === false) return { fire: false, reason: 'vocation-gate' };
      } catch (e) { /* gate read failure => skip the gate, never block */ }
    }

    // Mana feasibility (REQ-14: "gated by mana feasibility (REQ-01 semantics)").
    const cost = typeof getSpellCost === 'function' ? getSpellCost(config.sid) : null;
    if (cost === null) return { fire: false, reason: 'no-cost' };
    const feas = FEAS_MOD.canCast({
      mana: ctx.mana,
      cost,
      reserve: 0,
      maxMana: ctx.maxMana,
      key: 'heal-magic-' + slot,
      warned,
      onWarn: warn,
    });
    if (!feas.fire) return { fire: false, reason: feas.reason === 'never' ? 'never' : 'insufficient' };

    // Cooldowns: GLOBAL_COOLDOWN defers to a later tick (REQ-14).
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

    return { fire: true, reason: 'low-hp', slot };
  }

  /**
   * Execute the cast (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{slot: number}} decision - the decided slot
   * @param {object} deps - { gameClient, document } for the firing adapter
   * @returns {boolean} true when __handleClick executed
   */
  function fire(decision, deps = {}) {
    const slot = Number(decision.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return false;
    return FIRING_MOD.fireSlot(slot, {
      mode: 'handleClick',
      gameClient: deps.gameClient,
      document: deps.document,
      log,
    });
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, isEnabled };
}

module.exports = { createHealMagic };
