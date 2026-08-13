'use strict';

/**
 * Assisted combat module.
 *
 * This module deliberately NEVER acquires a target: it fires only when the
 * player has selected one in MiniBia. Cavebot owns automatic target selection
 * and can reuse this module once it has selected a configured monster.
 */

const FIRING_MOD = require('../../adapters/firing');
const FEAS_MOD = require('../../core/feasibility');
const CD_MOD = require('../../core/cooldown');

const TARGETING_OPTIONS = ['lowest-hp', 'nearest'];
const DEFAULT_TARGETING = 'lowest-hp';

function normalizeTargeting(value) {
  return TARGETING_OPTIONS.indexOf(value) !== -1 ? value : DEFAULT_TARGETING;
}

function normalizeSid(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normalizeSlot(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/**
 * @param {object} opts
 * @param {object} opts.config {on,sid,runeSlot,reserve}
 * @param {() => object|null} [opts.readTarget]
 * @param {(sid:number) => number|null} [opts.resolveSpellSlot]
 * @param {(sid:number) => number|null} [opts.getSpellCost]
 * @param {(sid:number|null) => boolean|null} [opts.canCastSpell]
 * @param {(sid:number|null) => object|null} [opts.readCooldown]
 * @returns {{decide:Function,fire:Function,getState:Function,isEnabled:Function}}
 */
function createAttackModule(opts = {}) {
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const readTarget = typeof opts.readTarget === 'function' ? opts.readTarget : () => null;
  const resolveSpellSlot = typeof opts.resolveSpellSlot === 'function' ? opts.resolveSpellSlot : () => null;
  const getSpellCost = typeof opts.getSpellCost === 'function' ? opts.getSpellCost : () => null;
  const canCastSpell = typeof opts.canCastSpell === 'function' ? opts.canCastSpell : () => null;
  const readCooldown = typeof opts.readCooldown === 'function' ? opts.readCooldown : () => null;
  const warned = new Set();
  const state = { lastReason: 'off', lastTarget: null, lastFiredAt: 0 };

  function cooldownVerdict(sid) {
    const cd = readCooldown(sid) || {};
    return CD_MOD.canFire({ cooldown: cd.cooldown, globalCooldown: cd.globalCooldown, cooldownMs: 0, lastFiredAt: null, now: Date.now() });
  }

  function decide(ctx = {}) {
    if (config.on !== true) return { fire: false, reason: 'off' };
    const target = readTarget();
    if (!target || typeof target !== 'object') return { fire: false, reason: 'no-manual-target' };
    const sid = normalizeSid(config.sid);
    const runeSlot = normalizeSlot(config.runeSlot);
    let slot = null;
    let kind = null;
    if (sid !== null) {
      if (canCastSpell(sid) === false) return { fire: false, reason: 'vocation-gate' };
      slot = normalizeSlot(resolveSpellSlot(sid));
      if (slot === null) return { fire: false, reason: 'spell-not-on-hotbar' };
      const cost = getSpellCost(sid);
      if (!Number.isFinite(Number(cost))) return { fire: false, reason: 'no-cost' };
      const feasibility = FEAS_MOD.canCast({ mana: ctx.mana, maxMana: ctx.maxMana, cost: Number(cost), reserve: Number(config.reserve) || 0, key: 'attack-' + sid, warned });
      if (!feasibility.fire) return { fire: false, reason: feasibility.reason === 'reserve' ? 'reserve' : 'insufficient-mana' };
      kind = 'spell';
    } else if (runeSlot !== null) {
      slot = runeSlot;
      kind = 'rune';
    } else {
      return { fire: false, reason: 'no-action-configured' };
    }
    const cd = cooldownVerdict(sid);
    if (!cd.fire) return { fire: false, reason: cd.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown' };
    state.lastTarget = String(target.name || target.id || 'target');
    state.lastReason = 'attack-' + kind;
    return { fire: true, reason: state.lastReason, kind, slot, target: state.lastTarget };
  }

  function fire(decision, deps = {}) {
    const slot = normalizeSlot(decision && decision.slot);
    if (slot === null) return false;
    const fired = FIRING_MOD.fireSlot(slot, { mode: 'handleClick', gameClient: deps.gameClient, document: deps.document, log: deps.log || {} });
    if (fired) state.lastFiredAt = Date.now();
    return fired;
  }

  function getState() {
    return {
      on: config.on === true,
      mode: 'assist',
      targeting: normalizeTargeting(config.targeting),
      spell: { sid: normalizeSid(config.sid), slot: normalizeSid(config.sid) === null ? null : normalizeSlot(resolveSpellSlot(normalizeSid(config.sid))) },
      rune: { slot: normalizeSlot(config.runeSlot) },
      reserve: Number.isFinite(Number(config.reserve)) ? Number(config.reserve) : 0,
      lastReason: state.lastReason,
      lastTarget: state.lastTarget,
      lastFiredAt: state.lastFiredAt,
    };
  }

  return { decide, fire, getState, isEnabled: () => config.on === true };
}

module.exports = { createAttackModule, normalizeTargeting, normalizeSid, normalizeSlot, TARGETING_OPTIONS, DEFAULT_TARGETING };
