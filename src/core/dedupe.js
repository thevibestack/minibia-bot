'use strict';

/**
 * Unknown-cast observation tracker (REQ-15).
 *
 * Monitors the Default channel for the player's own messages that match no
 * configured word. When the SAME unknown word is observed >= 2 times within 5
 * minutes, the tracker reports an 'offer' exactly once. A declined word
 * becomes session-silent (no offer reappears). Words already configured are
 * ignored entirely.
 *
 * Observation outcomes:
 *   - 'ignored'  — empty input or the word is already configured
 *   - 'silenced' — the word was declined earlier this session
 *   - 'new'      — first observation within the current window
 *   - 'offer'    — >= 2 observations within the window; registration offered (once)
 *   - 'pending'  — already offered, not declined, waiting for user decision
 */

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create an unknown-word dedupe tracker.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs=300000] - observation window (ms)
 * @param {Set<string>} [opts.known] - words already configured in the rotation
 * @returns {{
 *   observe: (word: string, now?: number) => 'ignored'|'new'|'offer'|'pending'|'silenced',
 *   decline: (word: string) => void,
 *   markKnown: (word: string) => void,
 *   isSilenced: (word: string) => boolean,
 * }}
 */
function createDedupe({ windowMs = DEFAULT_WINDOW_MS, known = new Set() } = {}) {
  /** @type {Map<string, {count: number, firstAt: number, offeredAt: number|null}>} */
  const observations = new Map();
  const silenced = new Set();

  /**
   * Record an observation of an unknown word.
   *
   * @param {string} word - the unconfigured word observed in chat
   * @param {number} [now=Date.now()] - observation time (epoch ms)
   * @returns {'ignored'|'new'|'offer'|'pending'|'silenced'} outcome
   */
  function observe(word, now = Date.now()) {
    if (typeof word !== 'string' || word.length === 0) return 'ignored';
    if (known.has(word)) return 'ignored';
    if (silenced.has(word)) return 'silenced';

    let entry = observations.get(word);
    if (!entry || now - entry.firstAt > windowMs) {
      // Fresh window: first observation or previous window expired.
      entry = { count: 0, firstAt: now, offeredAt: null };
      observations.set(word, entry);
    }
    entry.count += 1;

    if (entry.count >= 2) {
      if (entry.offeredAt === null) {
        entry.offeredAt = now;
        return 'offer';
      }
      return 'pending';
    }
    return 'new';
  }

  /** Mark a word declined; it becomes session-silent. */
  function decline(word) {
    silenced.add(word);
    observations.delete(word);
  }

  /** Mark a word configured; the tracker stops observing it. */
  function markKnown(word) {
    known.add(word);
    observations.delete(word);
  }

  /** @returns {boolean} true when the word is session-silent */
  function isSilenced(word) {
    return silenced.has(word);
  }

  return { observe, decline, markKnown, isSilenced };
}

module.exports = { createDedupe, DEFAULT_WINDOW_MS };
