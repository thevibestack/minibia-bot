'use strict';

/**
 * Mana feasibility gate (REQ-01).
 *
 * A spell fires only when `mana >= cost` AND `(mana - cost) >= reserve` when
 * reserve is ON (reserve > 0); otherwise the plain `mana >= cost` rule applies.
 * Equality passes in both checks. A spell with `cost > maxMana` is NEVER
 * feasible; a single warning is emitted per spell key (no per-tick spam).
 *
 * @typedef {Object} Verdict
 * @property {boolean} fire - whether the spell may fire this tick
 * @property {boolean} never - true when cost > maxMana (permanently infeasible)
 * @property {'ok'|'insufficient'|'reserve'|'never'} reason - outcome reason
 */

/**
 * Evaluate whether a spell can be cast given the current mana state.
 *
 * @param {object} opts
 * @param {number} opts.mana - current mana
 * @param {number} opts.cost - spell mana cost
 * @param {number} [opts.reserve=0] - mana kept after casting; 0 disables the reserve check
 * @param {number} [opts.maxMana=Infinity] - player max mana
 * @param {string} [opts.key] - unique spell identity for warning dedupe (e.g. "slot-4")
 * @param {Set<string>} [opts.warned] - persistent set of keys already warned (survives ticks)
 * @param {(message: string) => void} [opts.onWarn] - single-warning sink (REQ-01)
 * @returns {Verdict} evaluation verdict
 */
function canCast({ mana, cost, reserve = 0, maxMana = Infinity, key = null, warned = null, onWarn = null }) {
  if (cost > maxMana) {
    if (key !== null && warned && !warned.has(key) && typeof onWarn === 'function') {
      warned.add(key);
      onWarn(`spell ${key}: cost ${cost} exceeds maxMana ${maxMana}; never feasible (REQ-01)`);
    }
    return { fire: false, never: true, reason: 'never' };
  }

  if (mana < cost) {
    return { fire: false, never: false, reason: 'insufficient' };
  }

  if (reserve > 0 && mana - cost < reserve) {
    return { fire: false, never: false, reason: 'reserve' };
  }

  return { fire: true, never: false, reason: 'ok' };
}

module.exports = { canCast };
