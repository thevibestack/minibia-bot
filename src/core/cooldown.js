'use strict';

/**
 * Cooldown gating (REQ-02).
 *
 * Before firing, the engine checks the client's `spellbook.cooldowns`
 * (per-spell bucket plus GLOBAL_COOLDOWN) and mirrors the client pre-fire gate.
 * Client data is authoritative: an active per-spell cooldown or an active
 * GLOBAL_COOLDOWN defers the fire. When client cooldown data is absent
 * (null/undefined), config-specified cooldown pacing is used as a fallback and
 * each fallback deferral is reported through the gap-log callback.
 *
 * @typedef {Object} CooldownVerdict
 * @property {boolean} fire - whether the spell may fire now
 * @property {'client'|'fallback'} source - where the decision came from
 * @property {'ok'|'global-cooldown'|'cooldown'|'fallback-pacing'} reason - outcome reason
 * @property {number} waitMs - remaining wait before the spell can fire
 */

/**
 * Evaluate whether a spell may fire right now.
 *
 * @param {object} opts
 * @param {{active: boolean, seconds?: number}|null|undefined} [opts.cooldown] -
 *   client per-spell cooldown state; null/undefined means client data absent
 * @param {{active: boolean, seconds?: number}|null|undefined} [opts.globalCooldown] -
 *   client GLOBAL_COOLDOWN state
 * @param {number} [opts.cooldownMs=0] - config fallback cooldown (ms)
 * @param {number|null} [opts.lastFiredAt=null] - epoch ms of the last successful
 *   fire; null/0 means never fired (fallback paces nothing on first cast)
 * @param {number} [opts.now=Date.now()] - current epoch ms (injectable clock)
 * @param {(message: string) => void} [opts.onGapLog] - gap log sink; called when
 *   client cooldown data is absent and fallback pacing defers the fire
 * @returns {CooldownVerdict} the cooldown verdict
 */
function canFire({
  cooldown = null,
  globalCooldown = null,
  cooldownMs = 0,
  lastFiredAt = null,
  now = Date.now(),
  onGapLog = null,
}) {
  // GLOBAL_COOLDOWN is authoritative: never fire during it.
  if (globalCooldown && globalCooldown.active) {
    return {
      fire: false,
      source: 'client',
      reason: 'global-cooldown',
      waitMs: Math.max(0, (globalCooldown.seconds ?? 0) * 1000),
    };
  }

  // Per-spell client cooldown.
  if (cooldown && cooldown.active) {
    return {
      fire: false,
      source: 'client',
      reason: 'cooldown',
      waitMs: Math.max(0, (cooldown.seconds ?? 0) * 1000),
    };
  }

  // Client cooldown data absent -> config fallback pacing (gap logged on defer).
  if (cooldown == null) {
    // Never fired: nothing to pace, allow the first cast.
    if (!lastFiredAt) {
      return { fire: true, source: 'fallback', reason: 'ok', waitMs: 0 };
    }
    const elapsed = now - lastFiredAt;
    const remaining = cooldownMs - elapsed;
    if (remaining > 0) {
      if (typeof onGapLog === 'function') {
        onGapLog(`cooldown data absent for spell; fallback pacing ${remaining}ms remaining (REQ-02)`);
      }
      return { fire: false, source: 'fallback', reason: 'fallback-pacing', waitMs: remaining };
    }
    return { fire: true, source: 'fallback', reason: 'ok', waitMs: 0 };
  }

  return { fire: true, source: 'client', reason: 'ok', waitMs: 0 };
}

module.exports = { canFire };
