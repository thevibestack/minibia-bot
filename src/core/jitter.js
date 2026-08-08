'use strict';

/**
 * Jitter delay helpers (REQ-13).
 *
 * Firing delays are randomized per action within the configured range. Config
 * values are clamped to [50, 400] and inverted bounds are swapped. A range that
 * lies entirely outside the valid domain falls back to the default [50, 400].
 */

const JITTER_MIN = 50;
const JITTER_MAX = 400;
const DEFAULT_RANGE = { min: JITTER_MIN, max: JITTER_MAX };

/**
 * Normalize a jitter range: swap inverted bounds, clamp into [50, 400].
 *
 * @param {number} min - requested minimum delay (ms)
 * @param {number} max - requested maximum delay (ms)
 * @returns {{min: number, max: number, swapped: boolean, clamped: boolean}}
 *   Normalized bounds plus correction flags:
 *   - `swapped` is true when inverted bounds were exchanged.
 *   - `clamped` is true when values were corrected (out-of-domain, clamped,
 *     or a degenerate single-point range widened to stay non-constant).
 */
function clampJitter(min, max) {
  let swapped = false;
  let clamped = false;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ...DEFAULT_RANGE, swapped: false, clamped: true };
  }

  if (min > max) {
    [min, max] = [max, min];
    swapped = true;
  }

  // Entirely outside the valid domain -> default range.
  if (max < JITTER_MIN || min > JITTER_MAX) {
    return { ...DEFAULT_RANGE, swapped, clamped: true };
  }

  if (min < JITTER_MIN) {
    min = JITTER_MIN;
    clamped = true;
  }
  if (max > JITTER_MAX) {
    max = JITTER_MAX;
    clamped = true;
  }

  // A single-point range would produce constant delays; widen it by 1ms.
  if (min === max) {
    if (max < JITTER_MAX) {
      max += 1;
    } else {
      min -= 1;
    }
    clamped = true;
  }

  return { min, max, swapped, clamped };
}

/**
 * Pick a random integer delay within [min, max] (inclusive on both ends).
 *
 * @param {number} [min=50] - minimum delay (ms)
 * @param {number} [max=400] - maximum delay (ms)
 * @param {() => number} [rng=Math.random] - injectable RNG returning [0, 1)
 * @returns {number} delay in milliseconds
 */
function randomDelay(min = JITTER_MIN, max = JITTER_MAX, rng = Math.random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  const spread = Math.max(1, hi - lo + 1);
  return lo + Math.floor(rng() * spread);
}

module.exports = { clampJitter, randomDelay, JITTER_MIN, JITTER_MAX };
