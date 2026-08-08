'use strict';

/**
 * Food timer parsing (REQ-05).
 *
 * Satiety detection reads the food skill timer text ("MM:SS") from the skill
 * window and converts it to whole seconds. `null` input, unparseable text, and
 * a zero timer ("0:00") all mean "expired" and map to `null`, which triggers
 * the eat path.
 */

/**
 * Parse a "MM:SS" food timer into seconds.
 *
 * @param {string|null|undefined} text - timer text from the food skill window
 * @returns {number|null} remaining seconds, or null when the timer is expired
 *   (null input, invalid text, or 0:00).
 */
function parseFoodTimer(text) {
  if (text === null || text === undefined) return null;
  const match = String(text).trim().match(/^(\d+):([0-5]\d)$/);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds > 0 ? seconds : null;
}

module.exports = { parseFoodTimer };
