'use strict';

/**
 * Echo validation state machine (REQ-09).
 *
 * After a words-path fire, `start(fireId)` begins polling for an echo entry
 * matching `isMatch` within `windowMs`. Outcomes:
 *
 *   - `pass`      — an echo matching the configured word/regex was observed.
 *   - `miss`      — the window expired without an echo; counted, NEVER refired.
 *   - `disabled`  — validation is off; no polling occurs at all.
 *
 * Validation is non-blocking: all timing flows through injectable
 * `schedule`/`clear`/`now`, so the engine tick never waits on it and tests
 * drive the machine deterministically without real timers. Candidates are
 * matched from the baseline snapshot taken at start, so pre-existing channel
 * history never validates a fresh fire.
 *
 * @typedef {Object} Validator
 * @property {(fireId: string|number) => string} start - begin validating an echo
 * @property {() => void} dispose - stop polling without emitting a result
 * @property {() => {state: string, fireId: string|number|null, startedAt: number, deadline: number}} getState
 */

/**
 * Create an echo validation state machine.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs=2500] - echo wait window (ms)
 * @param {number} [opts.pollMs=100] - polling interval (ms)
 * @param {(candidate: object) => boolean} [opts.isMatch] - true when a candidate
 *   entry is the expected echo (name + word/regex check)
 * @param {() => Array<object>} [opts.getCandidates] - returns the current
 *   channel entries (full history; baseline handled internally)
 * @param {boolean} [opts.enabled=true] - validation enabled flag
 * @param {() => number} [opts.now=Date.now] - injectable clock (epoch ms)
 * @param {(fn: () => void, ms: number) => object} [opts.schedule=setTimeout] - injectable timer
 * @param {(handle: object) => void} [opts.clear=clearTimeout] - injectable timer cancel
 * @param {({fireId, result, state}) => void} [opts.onResult] - result sink for pass/miss/disabled
 * @returns {Validator}
 */
function createValidator({
  windowMs = 2500,
  pollMs = 100,
  isMatch = () => false,
  getCandidates = () => [],
  enabled = true,
  now = Date.now,
  schedule = setTimeout,
  clear = clearTimeout,
  onResult = () => {},
} = {}) {
  let state = 'idle'; // idle | passing | pass | miss | disabled
  let timer = null;
  let fireId = null;
  let baselineCount = 0;
  let startedAt = 0;
  let deadline = 0;

  function stop() {
    if (timer !== null) {
      clear(timer);
      timer = null;
    }
  }

  function settle(nextState, result) {
    stop();
    state = nextState;
    onResult({ fireId, result, state: nextState });
  }

  function poll() {
    if (state !== 'passing') return;
    const candidates = getCandidates();
    for (let i = baselineCount; i < candidates.length; i++) {
      if (isMatch(candidates[i])) {
        settle('pass', 'pass');
        return;
      }
    }
    if (now() >= deadline) {
      settle('miss', 'miss');
      return;
    }
    timer = schedule(poll, pollMs);
  }

  return {
    /**
     * Begin validating the echo for a fired action.
     * @param {string|number} id - identifier of the fired action
     * @returns {string} initial state ('passing' or 'disabled')
     */
    start(id) {
      stop();
      fireId = id;
      if (!enabled) {
        state = 'disabled';
        onResult({ fireId: id, result: 'disabled', state: 'disabled' });
        return state;
      }
      startedAt = now();
      deadline = startedAt + windowMs;
      baselineCount = getCandidates().length;
      state = 'passing';
      timer = schedule(poll, pollMs);
      return state;
    },

    /** Cancel any pending polling; no result is emitted. */
    dispose() {
      stop();
      state = 'idle';
    },

    /** @returns {{state: string, fireId: string|number|null, startedAt: number, deadline: number}} */
    getState() {
      return { state, fireId, startedAt, deadline };
    },
  };
}

module.exports = { createValidator };
