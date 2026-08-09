'use strict';

/**
 * Echo validation module (REQ-24, design "Echo" row, task 5.6).
 *
 * Carries the PROVEN userscript validation mechanism into the agent:
 * src/core/validation.js (echo state machine, 2500ms window / 100ms poll) +
 * src/adapters/chat.js (Default-channel-first reads) — unchanged semantics:
 *
 *   - After a WORDS-PATH fire (a slot whose config carries a `word` — the
 *     game echoes the player's own typed word in the Default channel), the
 *     agent polls for a new {name === player.name, message matching word}
 *     entry within 2500ms (poll 100ms).
 *   - pass -> counter increments (log).
 *   - miss -> logged + the counter increments; NEVER refires (the validator
 *     has no fire path by construction).
 *   - skip -> when the firing path produces no echo (no `word` configured —
 *     direct cast), validation is skipped entirely (REQ-24).
 *
 * Non-blocking: all timing flows through the validator's injectable
 * schedule/clear/now; the engine tick never waits on it.
 *
 * Wire: bootstrap calls `startForFire(fireId, word)` from the heal-magic and
 * training queue closures when their config carries a word.
 */

const VALID_MOD = require('../../core/validation');
const CHAT_MOD = require('../../adapters/chat');

/**
 * Create the echo validation module.
 *
 * @param {object} opts
 * @param {() => string|null} [opts.playerName] - current player name accessor
 * @param {object|null} [opts.gameClient] - page gameClient (chat reads)
 * @param {Document|null} [opts.document] - page DOM (chat DOM fallback)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {(fn: () => void, ms: number) => object} [opts.schedule=setTimeout]
 * @param {(handle: object) => void} [opts.clear=clearTimeout]
 * @param {{error?: Function, warn?: Function, info?: Function}} [opts.log]
 * @returns {{
 *   startForFire: (fireId: string, word: string) => string,
 *   getState: () => object,
 * }}
 */
function createEchoModule(opts = {}) {
  const {
    playerName = () => null,
    gameClient = null,
    document: doc = null,
    now = Date.now,
    schedule = (typeof setTimeout === 'function' ? setTimeout : null),
    clear = (typeof clearTimeout === 'function' ? clearTimeout : null),
    log = {},
  } = opts;
  const info = typeof log.info === 'function' ? log.info : () => {};
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  const state = { passes: 0, misses: 0, active: false, lastResult: null, lastWord: null };

  /** Proven userscript matcher (build-userscript.js buildValidator):
   *  own message + exact word match, or /regex/ form. */
  function matchesWord(entry, word) {
    if (!entry || entry.name !== playerName()) return false;
    const trimmed = String(word || '').trim();
    if (!trimmed) return false;
    const m = trimmed.match(/^\/(.+)\/([a-z]*)$/);
    if (m) {
      try { return new RegExp(m[1], m[2]).test(entry.message); } catch (e) { return false; }
    }
    return entry.message === trimmed;
  }

  const validator = VALID_MOD.createValidator({
    windowMs: 2500, // REQ-24: echo window
    pollMs: 100,    // REQ-24: poll cadence
    enabled: true,
    now: now,       // injectable clock (non-blocking, deterministic tests)
    schedule: schedule,
    clear: clear,
    getCandidates: function () {
      return CHAT_MOD.getRecentMessages({ gameClient: gameClient, document: doc }); // channel-first (REQ-24)
    },
    isMatch: function (entry) { return matchesWord(entry, state.lastWord); },
    onResult: function (r) {
      state.active = false;
      state.lastResult = r.result;
      if (r.result === 'pass') {
        state.passes += 1;
        info('echo ok: ' + r.fireId);
      } else if (r.result === 'miss') {
        state.misses += 1; // REQ-24: miss MUST log + increment; NO refire
        warn('echo miss: ' + r.fireId + ' (REQ-24, no refire)');
      }
    },
  });

  /**
   * Start validating the echo for a words-path fire. Skips entirely when the
   * word is empty (no echo path — direct cast, REQ-24).
   * @param {string} fireId - fired action identifier (log/counter label)
   * @param {string} word - configured word (or /regex/)
   * @returns {string} validator state ('passing' | 'disabled')
   */
  function startForFire(fireId, word) {
    const trimmed = String(word || '').trim();
    if (!trimmed) {
      validator.dispose();
      return 'disabled'; // no echo path — skip (REQ-24)
    }
    state.lastWord = trimmed;
    state.active = true;
    return validator.start(fireId);
  }

  /** @returns {object} module state (snapshot -> panel live state) */
  function getState() {
    const v = validator.getState();
    return {
      active: state.active,
      passes: state.passes,
      misses: state.misses,
      lastResult: state.lastResult,
      lastWord: state.lastWord,
      validatorState: v.state,
      deadline: v.deadline,
    };
  }

  return { startForFire, getState };
}

module.exports = { createEchoModule };
