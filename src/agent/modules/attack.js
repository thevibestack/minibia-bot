'use strict';

/**
 * Attack skeleton (REQ-35, design D10, task 6.1).
 *
 * ATTACK is a STATE-ONLY SKELETON in this slice:
 *  - Targeting choice (lowest HP / nearest; native ACTIONS) and offensive
 *    spell/rune pickers are CONFIG — the panel renders them, the config
 *    shape carries them (forward-compat with the full combat slice).
 *  - `skeleton: true` + disclosure "skeleton — limited": the module performs
 *    NO full combat loop (no tree node, no queue dispatch, no game calls —
 *    D10: "no tree loop"). The combat behavior slice lands later and wires
 *    the targeting decision into the tree.
 *
 * Pure node-testable: all normalization is local and exported for reuse by
 * the future combat slice.
 */

/** Targeting choices (REQ-35: "lowest HP / nearest"; native ACTIONS). */
const TARGETING_OPTIONS = ['lowest-hp', 'nearest'];

/** Default targeting when the config value is absent/invalid. */
const DEFAULT_TARGETING = 'lowest-hp';

/**
 * Normalize the targeting choice: only the known options pass through,
 * anything else (including undefined/null) falls back to the default —
 * a bad config never crashes the module.
 * @param {unknown} value
 * @returns {string} 'lowest-hp' | 'nearest'
 */
function normalizeTargeting(value) {
  return TARGETING_OPTIONS.indexOf(value) !== -1 ? value : DEFAULT_TARGETING;
}

/**
 * Normalize an offensive spell sid: non-negative integer only; anything
 * else (absent, string junk, negative) becomes null (no spell configured).
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeSid(value) {
  // Empty strings would Number() to 0 — a missing input must NOT become
  // "spell 0" (routes.js normalizeCoords guards the same trap).
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Normalize an offensive rune hotbar slot: integer 1-12 only; anything else
 * becomes null (no rune slot configured).
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeSlot(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/**
 * Create the attack skeleton module.
 *
 * @param {object} opts
 * @param {object} [opts.config] - normalized attack config
 *   { on: boolean, targeting: string, sid: number|null, runeSlot: number|null }
 * @returns {{
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createAttackModule(opts = {}) {
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};

  /**
   * Honest module state (snapshot -> panel live state, REQ-35).
   * `skeleton: true` + disclosure disclose the limited functionality;
   * `combatLoop: false` states plainly that no full combat loop runs.
   * @returns {object}
   */
  function getState() {
    return {
      skeleton: true,
      disclosure: 'skeleton — limited',
      on: config.on === true,
      targeting: normalizeTargeting(config.targeting),
      spell: { sid: normalizeSid(config.sid) },
      rune: { slot: normalizeSlot(config.runeSlot) },
      combatLoop: false, // REQ-35: no full combat loop in the skeleton
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return config.on === true;
  }

  return { getState, isEnabled };
}

module.exports = {
  createAttackModule,
  normalizeTargeting,
  normalizeSid,
  normalizeSlot,
  TARGETING_OPTIONS,
  DEFAULT_TARGETING,
};
