'use strict';

/**
 * Rune module (REQ-15, design D7 "Runes" row).
 *
 * Optional, user-activated. Drives rune attack/heal INSIDE the game's own
 * native windows using the LIVE-PROBED timer fields
 * `hotbarManager.__runeAttackUntil` / `hotbarManager.__runeHealUntil`
 * (epoch-ms "window active until" timestamps; obs 10320).
 *
 * Semantics:
 *  - Native window ACTIVE (now < until) => the module DEFERS and never
 *    double-fires alongside the game's own rune automation.
 *  - Window EXPIRED (or never armed) + cooldown clear => a rune action is
 *    enqueued via `__handleClick(runeSlot)` (adapters/firing) to re-arm the
 *    native window.
 *  - FEATURE-DETECT: when the native rune timers are absent (fields
 *    undefined), the module records "no native rune data" and NEVER fires —
 *    the design's degrade path (D7), NOT an invented fallback loop.
 *  - Respects the global cooldown (spellbook GLOBAL_COOLDOWN) and, when
 *    exposed, `__getRuneEffectiveCooldown` and `player.attackSlowness` as a
 *    post-fire wait (feature-detected; absent => 0).
 *
 * Rune heal additionally requires `healThreshold` (design-extension setting):
 * the heal rune fires only while health <= healThreshold; when only
 * `attackSlot` is configured, the attack rune cycles on expiry.
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 */

const FIRING_MOD = require('../../adapters/firing');
const FEAS_MOD = require('../../core/feasibility'); // D2 (REQ-31): reserve gate

/** Coerce a timer value to epoch ms (number | Date | numeric string). */
function toMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && typeof value.getTime === 'function') return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Create the rune decision module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized runes config
 *   { on: boolean, attackSlot: number|null, healSlot: number|null,
 *     healThreshold: number|null, reserve: number }
 * @param {() => {attackUntil: number|null, healUntil: number|null}|null}
 *   [opts.readRuneTimers] - native rune window reader; null = feature absent
 * @param {() => {active: boolean, seconds?: number}|null} [opts.readGlobalCooldown]
 * @param {() => number} [opts.readAfterFireWait] - post-fire wait ms
 *   (effective rune cooldown / attackSlowness); feature-detected, default 0
 * @param {(slot: number) => number|null} [opts.getSpellCost] - rune spell
 *   cost resolver for the fired slot (D2, REQ-31: reserve gate); null/absent
 *   cost = gate skipped, never blocks
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, slot?: number, kind?: string},
 *   fire: (decision: object, deps: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createRunes(opts = {}) {
  const { config, readRuneTimers = null, readGlobalCooldown = null, readAfterFireWait = null, getSpellCost = null, now = Date.now, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const warned = new Set();

  const state = { lastFireAt: 0, available: true, reason: 'ok' };

  /**
   * Per-module mana reserve gate (D2, REQ-31): a rune cast must not fire
   * below `cost + config.reserve`. Only enforced when reserve > 0 AND the
   * rune spell cost resolves from the client AND mana is known — any unknown
   * side skips the gate (feature-detect, never blocks on absent data).
   * @param {object} ctx - tick context { mana, maxMana }
   * @param {number} slot - the slot the rune would fire on
   * @returns {string|null} 'rune-reserve' | 'rune-insufficient' when the cast
   *   is blocked, null when it may proceed (or the gate cannot prove
   *   infeasibility)
   */
  function manaFeasible(ctx, slot) {
    const reserve = Number(config.reserve) || 0;
    if (reserve <= 0) return null;
    if (ctx.mana === null || ctx.mana === undefined || !Number.isFinite(Number(ctx.mana))) return null;
    let cost = null;
    if (typeof getSpellCost === 'function') {
      try { cost = getSpellCost(slot); } catch (e) { cost = null; }
    }
    if (cost === null || !Number.isFinite(cost)) return null; // cost unknown -> skip
    const feas = FEAS_MOD.canCast({
      mana: Number(ctx.mana),
      cost,
      reserve,
      maxMana: ctx.maxMana,
      key: 'runes-slot-' + slot,
      warned,
      onWarn: warn,
    });
    return feas.fire ? null : (feas.reason === 'reserve' ? 'rune-reserve' : 'rune-insufficient');
  }

  /**
   * Pure decision (REQ-15).
   * @param {object} ctx - tick context { health }
   * @returns {{fire: boolean, reason: string, slot?: number, kind?: string}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const attackSlot = Number(config.attackSlot) || null;
    const healSlot = Number(config.healSlot) || null;
    if (!attackSlot && !healSlot) return { fire: false, reason: 'no-slot' };

    const timers = typeof readRuneTimers === 'function' ? readRuneTimers() : null;
    if (timers === null) {
      // Design D7 degrade: no native rune data => never fire, no fallback loop.
      state.available = false;
      state.reason = 'no native rune data';
      return { fire: false, reason: 'no-native-rune-data' };
    }
    state.available = true;
    state.reason = 'ok';

    const t = now();
    const healUntil = toMs(timers.healUntil);
    const attackUntil = toMs(timers.attackUntil);
    const healActive = healUntil !== null && t < healUntil;
    const attackActive = attackUntil !== null && t < attackUntil;

    // Coexistence: never fire while a native window is active (REQ-15).
    if (healActive || attackActive) return { fire: false, reason: 'native-window-active' };

    // Post-fire wait (effective rune cooldown / attackSlowness).
    if (typeof readAfterFireWait === 'function') {
      const wait = readAfterFireWait();
      if (Number.isFinite(wait) && wait > 0 && t - state.lastFireAt < wait) {
        return { fire: false, reason: 'after-fire-wait' };
      }
    }

    // Global cooldown (REQ-15: respect global cooldown).
    if (typeof readGlobalCooldown === 'function') {
      const g = readGlobalCooldown();
      if (g && g.active) return { fire: false, reason: 'global-cooldown' };
    }

    // Rune heal: only while health <= healThreshold (design extension setting).
    const healThreshold = Number(config.healThreshold);
    const wantHeal = Boolean(healSlot)
      && Number.isFinite(healThreshold)
      && ctx.health !== null
      && ctx.health !== undefined
      && ctx.health <= healThreshold;
    if (wantHeal) {
      const block = manaFeasible(ctx, healSlot);
      if (block !== null) {
        state.reason = block;
        return { fire: false, reason: block };
      }
      return { fire: true, reason: 'heal-window-expired', slot: healSlot, kind: 'rune-heal' };
    }

    if (attackSlot) {
      const block = manaFeasible(ctx, attackSlot);
      if (block !== null) {
        state.reason = block;
        return { fire: false, reason: block };
      }
      return { fire: true, reason: 'attack-window-expired', slot: attackSlot, kind: 'rune-attack' };
    }

    return { fire: false, reason: 'no-candidate' };
  }

  /**
   * Execute the rune slot click (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{slot: number, kind: string}} decision - decided rune action
   * @param {object} deps - { gameClient, document } for the firing adapter
   * @returns {boolean} true when __handleClick executed
   */
  function fire(decision, deps = {}) {
    const slot = Number(decision.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return false;
    state.lastFireAt = now();
    const ok = FIRING_MOD.fireSlot(slot, {
      mode: 'handleClick',
      gameClient: deps.gameClient,
      document: deps.document,
      log,
    });
    if (!ok) error('runes: __handleClick failed for rune slot ' + slot);
    return ok;
  }

  /** @returns {object} module state (surface getRuneState, REQ-04/15) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      available: config && config.on === true ? state.available : false,
      reason: config && config.on === true ? state.reason : 'off',
      lastFireAt: state.lastFireAt,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, getState, isEnabled };
}

module.exports = { createRunes, toMs };
