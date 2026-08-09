'use strict';

const { randomDelay } = require('./jitter');

/**
 * Global single-dispatch action queue (REQ-12, design "Action Queue").
 *
 * Every server-bound action (hotbar click, eat, movement) MUST pass through
 * ONE queue instance that enforces a minimum global interval between ANY two
 * dispatched actions (default ~150ms, configurable). Properties:
 *
 *  - FIFO, single dispatch: entries dispatch in enqueue order, one at a time,
 *    never concurrently (throttle=0 still serializes).
 *  - Global minimum interval: an entry's fire time is computed AT DRAIN TIME
 *    relative to the last actual dispatch — `lastDispatchAt + minInterval +
 *    jitterMs` — so two actions enqueued 10ms apart fire no earlier than
 *    ~150ms (plus jitter) apart regardless of when they were enqueued. The
 *    FIRST dispatch is anchored to the first entry's ENQUEUE time (a fixed
 *    reference, never the drain time — drain-time anchoring would drift and
 *    defer the entry forever).
 *  - Additive per-action jitter: each entry draws its own jitter delay from
 *    the configured range (50–400ms default) at ENQUEUE time (seeded rng =>
 *    deterministic schedules). The jitter is ADDED on top of the throttle
 *    gap, never subtracted: fire time is never earlier than the interval.
 *  - Defer, never drop, never reorder: entries whose fire time has not
 *    arrived stay pending and drain in a later call.
 *  - No bypass: the queue is the ONLY dispatch path; the wiring guarantees
 *    game-handler invocations happen exclusively inside dispatched closures.
 *
 * Injectable `now` (fake clock) + `rng` (seeded) make the queue fully
 * deterministic and unit-testable in node without real timers.
 *
 * createQueue(opts) -> {
 *   enqueue(action, { kind, jitterMs }) -> entry,
 *   drain() -> Array<entry>,              // dispatched eligible prefix
 *   hasPending(predicate) -> boolean,
 *   pendingCount() -> number,
 *   stats() -> { enqueued, dispatched, failed, pending, lastDispatchAt, minInterval }
 * }
 */

const DEFAULT_MIN_INTERVAL = 150;
const DEFAULT_JITTER = { min: 50, max: 400 };

/** Coerce a finite number >= 0, else the fallback. */
function finiteMin(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.minInterval=150] - minimum ms between ANY two actions
 * @param {{min: number, max: number}} [opts.jitter={min:50,max:400}] - additive
 *   per-action jitter range; 0,0 disables jitter
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {() => number} [opts.rng=Math.random] - injectable RNG for jitter draws
 * @param {(action: Function) => void} [opts.dispatch] - dispatch sink; the ONLY
 *   place game-handler calls may happen
 * @returns {object} queue handle (see module doc)
 */
function createQueue(opts = {}) {
  const minInterval = finiteMin(opts.minInterval, DEFAULT_MIN_INTERVAL);
  const jit = {
    min: Number.isFinite(opts.jitter && opts.jitter.min) ? opts.jitter.min : DEFAULT_JITTER.min,
    max: Number.isFinite(opts.jitter && opts.jitter.max) ? opts.jitter.max : DEFAULT_JITTER.max,
  };
  const nowFn = typeof opts.now === 'function' ? opts.now : (typeof Date !== 'undefined' ? Date.now : () => 0);
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const dispatchFn = typeof opts.dispatch === 'function' ? opts.dispatch : () => {};

  let lastDispatchAt = null; // timestamp of the last actually dispatched action
  let pending = [];          // FIFO of { action, kind, jitterMs, fireAt }
  const counters = { enqueued: 0, dispatched: 0, failed: 0 };

  /** Draw this entry's jitter delay (enqueue time — deterministic w/ seed). */
  function drawJitter(override) {
    if (Number.isFinite(override)) return Math.max(0, override);
    return randomDelay(jit.min, jit.max, rng);
  }

  /**
   * Enqueue an action. The entry's jitter is drawn NOW; its fire time is
   * computed at drain time against the actual last dispatch so the global
   * interval holds no matter when enqueue happened. The first entry's fire
   * base is its OWN enqueue time (a fixed reference — never the drain time,
   * which would drift and defer it forever).
   *
   * @param {Function} action - () => void; invoked ONLY through dispatch
   * @param {{kind?: string, jitterMs?: number}} [entryOpts]
   * @returns {{action: Function, kind: string, jitterMs: number}} the entry
   */
  function enqueue(action, entryOpts = {}) {
    if (typeof action !== 'function') {
      throw new TypeError('queue.enqueue requires a function action');
    }
    const entry = {
      action,
      kind: typeof entryOpts.kind === 'string' ? entryOpts.kind : 'action',
      jitterMs: drawJitter(entryOpts.jitterMs),
      enqueuedAt: nowFn(), // fixed reference for the first-dispatch slot
      fireAt: null,        // computed at drain time
    };
    pending.push(entry);
    counters.enqueued += 1;
    return entry;
  }

  /**
   * Dispatch the eligible FIFO prefix. Fire time is recomputed per entry
   * against the running last-dispatch slot, so spacing is ALWAYS
   * >= minInterval + jitter even when entries were enqueued long ago.
   *
   * @returns {Array} the entries actually dispatched this call
   */
  function drain() {
    const now = nowFn();
    const dispatched = [];
    let slot = lastDispatchAt === null ? null : lastDispatchAt + minInterval;
    let i = 0;
    for (; i < pending.length; i++) {
      const entry = pending[i];
      const base = slot === null ? entry.enqueuedAt : slot;
      entry.fireAt = base + entry.jitterMs;
      if (entry.fireAt > now) break; // FIFO: the rest are later — defer all
      try {
        dispatchFn(entry.action);
      } catch (err) {
        counters.failed += 1;
      }
      lastDispatchAt = entry.fireAt;
      slot = entry.fireAt + minInterval;
      counters.dispatched += 1;
      dispatched.push(entry);
    }
    if (i > 0) pending = pending.slice(i);
    return dispatched;
  }

  /** True when a pending entry matches the predicate (re-arm guards). */
  function hasPending(predicate) {
    return pending.some(predicate);
  }

  /** @returns {number} entries still waiting for their fire time */
  function pendingCount() {
    return pending.length;
  }

  /** @returns {object} counters + pacing state */
  function stats() {
    return {
      enqueued: counters.enqueued,
      dispatched: counters.dispatched,
      failed: counters.failed,
      pending: pending.length,
      lastDispatchAt,
      minInterval,
    };
  }

  return { enqueue, drain, hasPending, pendingCount, stats };
}

module.exports = { createQueue, DEFAULT_MIN_INTERVAL, DEFAULT_JITTER };
